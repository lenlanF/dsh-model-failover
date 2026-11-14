/**
 * dsh-model-failover — session-scoped automatic model failover with a
 * Settings-page rule editor covering every connected provider/model.
 *
 * Runtime contract (DSH 0.2.2-rc.3, verified in app.asar sources):
 * - agent/request-error is a waterfall; always call next() first.
 * - The loop freezes decision.selection per step (agent-loop/src/agent.ts:451),
 *   so a switch applies from the NEXT step via agent.model.select() + a new turn.
 * - Settings forms require a real Schemastery Config with .volatile() fields
 *   (dsh-settings/lib/index.js:417-420, :538-540) and settings.configure().
 */
import {
  DEFAULT_PRIORITY, DEFAULT_TRIGGERS, normalizeRules, qualifies,
  nextSelection, failoverSummary, canSwitch, appendSwitchLog,
} from './rules.js';
import { createStateStore, recordIntent, clearIntent, noteIncoming, requestDrive } from './state.js';

import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
let z;
try { z = (await import('@deepseek-ai/schemastery')).default; }
catch {
  const roots = [
    process.env.DSH_PROFILE_DIR,
    ...(process.env.USERPROFILE ? [join(process.env.USERPROFILE, '.dsh/profiles/desktop')] : []),
    join(homedir(), '.dsh/profiles/desktop'),
  ].filter(Boolean);
  let loaded = false;
  for (const root of roots) {
    const esm = join(root, 'node_modules/@deepseek-ai/schemastery/lib/index.mjs');
    if (!existsSync(esm)) continue;
    try { z = (await import(pathToFileURL(esm).href)).default; loaded = true; break; }
    catch { /* try next root */ }
  }
  if (!loaded) throw new Error('dsh-model-failover: @deepseek-ai/schemastery is not resolvable');
}

export const name = 'dsh-model-failover';
export const inject = ['agents', 'settings', 'webServer'];

const ModelEntry = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string().default(''),
});

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  priority: z.array(ModelEntry).default(DEFAULT_PRIORITY.map((s) => ({ ...s }))).volatile(),
  triggers: z.array(z.string()).default([...DEFAULT_TRIGGERS]).volatile(),
  maxSwitchesPerSession: z.number().min(0).default(3).volatile(),
  cooldownMs: z.number().min(0).default(0).volatile(),
  switchLogLimit: z.number().min(1).default(20).volatile(),
  switchLog: z.array(z.object({
    at: z.number(),
    code: z.string(),
    from: z.string(),
    to: z.string(),
    reason: z.string(),
  })).default([]).volatile(),
});

const renderThrown = (value) => value instanceof Error ? value.message : String(value);
const json = (res, status, value) => {
  res.statusCode = status;
  res.setHeader?.('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

/** Live-edit the profile patch through the Settings service. */
async function saveConfig(ctx, change) {
  const settings = ctx.get?.('settings');
  if (settings === undefined) throw new Error('settings service unavailable');
  const describe = settings.describe();
  const id = ctx.fiber?.entry?.options?.id;
  const row = describe.find((r) => r.ns === id)
    ?? describe.find((r) => String(r.ns).includes('dsh-model-failover'));
  if (row === undefined) throw new Error('no configurable dsh-model-failover entry');
  const ops = Object.entries(change).map(([field, value]) => ({ op: 'set', path: [field], value }));
  await settings.mutate(row.ns, ops, undefined);
  return { ns: row.ns, fields: Object.keys(change) };
}

export function apply(ctx, config = {}, internals = {}) {
  let rules = normalizeRules(config);
  const states = createStateStore();
  let switchLog = rules.switchLog;
  let historyWrites = Promise.resolve();
  const log = (level, text) => {
    try { ctx.logger?.[level]?.(text); } catch { /* logger optional */ }
  };
  const now = internals.now ?? (() => Date.now());
  const makeMessage = internals.createUserMessage;
  const refresh = (next) => {
    if (!next || typeof next !== 'object') return;
    rules = normalizeRules(next);
    if (Array.isArray(next.switchLog)) switchLog = rules.switchLog;
  };

  /** Hidden seam: defer to downstream listeners before observing give-up. */
  async function onRequestError(payload, next) {
    const downstream = await next();
    if (downstream?.kind === 'retry') return downstream;
    const state = states.stateFor(payload.agent);
    if (state.stopping || payload.signal?.aborted) return downstream;
    if (!qualifies(payload.failure, rules)) return downstream;
    if (recordIntent(state, payload, payload.failure)) {
      log('info', `dsh-model-failover: recorded intent for agent "${payload.agent.id}" turn ${payload.turn} step ${payload.step} code ${payload.failure.code}`);
    }
    return downstream;
  }

  async function createRetryMessage() {
    const make = makeMessage ?? (await import('@deepseek-ai/dsh-llm')).createUserMessage;
    return make({ content: [], source: { kind: 'retry' } });
  }

  /** Serialized per-agent driver: switch, record, continue. */
  async function drive(state) {
    const { agent, intent } = state;
    if (state.stopping || intent === undefined || intent.stale) return;
    if (ctx.agents?.get && ctx.agents.get(agent.id) !== agent) { clearIntent(state); return; }
    if (agent.status === 'running') return;
    if (!canSwitch(state, rules, now())) {
      log('warn', `dsh-model-failover: switch budget exhausted or cooldown active for agent "${agent.id}"`);
      clearIntent(state);
      return;
    }
    const current = typeof agent.model?.current === 'function' ? agent.model.current() : undefined;
    const target = nextSelection(current, rules);
    if (target === undefined) {
      log('warn', `dsh-model-failover: priority list exhausted for agent "${agent.id}"; no further switch`);
      clearIntent(state);
      return;
    }
    if (intent.queuedMessageId !== undefined) return;
    try {
      if (typeof ctx.llm?.resolveCallConfig === 'function') {
        await ctx.llm.resolveCallConfig({ provider: target.provider, model: target.model });
      }
      agent.model.select({ provider: target.provider, model: target.model,
        ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}) });
      const summary = failoverSummary(current, target, intent.failure.code ?? 'UNKNOWN');
      const message = await createRetryMessage();
      state.intent = { ...intent, queuedMessageId: message.id, phase: 'queued' };
      agent.followup(message);
      state.switches += 1;
      state.lastSwitchAt = now();
      switchLog = appendSwitchLog(switchLog, {
        at: state.lastSwitchAt, code: intent.failure.code, from: current, to: target, reason: 'auto',
      }, rules.switchLogLimit);
      // Persist history when the Settings service is available; failure is not fatal.
      if (ctx.get?.('settings') !== undefined) {
        const snapshot = switchLog;
        historyWrites = historyWrites.then(() => saveConfig(ctx, { switchLog: snapshot })).catch((error) =>
          log('warn', `dsh-model-failover: switch history write failed: ${renderThrown(error)}`));
      }
      log('info', `dsh-model-failover: ${summary}`);
    } catch (error) {
      clearIntent(state);
      log('warn', `dsh-model-failover: could not continue agent "${agent.id}": ${renderThrown(error)}`);
    }
  }

  /** Manual restore to the first model of the configured chain. */
  function manualRestore(agent) {
    const first = rules.priority[0];
    if (first === undefined || agent === undefined) return undefined;
    agent.model.select({ provider: first.provider, model: first.model,
      ...(first.reasoningEffort ? { reasoningEffort: first.reasoningEffort } : {}) });
    const state = states.stateFor(agent);
    state.switches = 0;
    log('info', `dsh-model-failover: manual restore to ${first.provider}/${first.model}`);
    return { ...first };
  }

  const disposers = [];
  const on = (event, fn) => {
    const result = ctx.on(event, fn);
    if (typeof result === 'function') disposers.push(result);
  };
  on('agent/request-error', onRequestError);
  on('agent/error', ({ agent }) => {
    const state = states.stateFor(agent);
    if (state.intent !== undefined) requestDrive(state, drive);
  });
  on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return;
    const state = states.stateFor(agent);
    if (state.intent !== undefined) requestDrive(state, drive);
  });
  on('agent/inbox/inserted', ({ agent, message }) => {
    const state = states.get(agent);
    if (state && noteIncoming(state, message)) {
      log('info', `dsh-model-failover: competing input won for agent "${agent.id}"`);
    }
  });
  on('agent/disposed', ({ agent }) => states.delete(agent));
  on('agent/pre-step', async ({ agent, messages }, next) => {
    const retry = messages.find((message) => message.source?.kind === 'retry' && message.content?.length === 0);
    const state = states.get(agent);
    const reserved = state?.intent?.queuedMessageId;
    if (retry !== undefined && (reserved === undefined || retry.id !== reserved)) return { kind: 'reject' };
    const decision = await next();
    if (reserved !== undefined && (retry !== undefined || decision?.kind === 'enter')) clearIntent(state);
    return decision;
  });

  // Settings presentation: this plugin owns a hand-built page.
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['settings'], (sctx) => {
        ctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber));
      });
    } catch (error) { log('warn', `dsh-model-failover: settings registration deferred: ${renderThrown(error)}`); }
  } else if (ctx.get?.('settings')?.configure) {
    try { ctx.get('settings').configure({ auto: false }, ctx.fiber); } catch { /* optional */ }
  }

  // Loopback-only endpoints for the settings page.
  const webServer = ctx.get?.('webServer') ?? ctx.webServer;
  if (webServer?.register) {
    const route = (path, handler) => {
      const d = webServer.register({ kind: 'exact', path, handler });
      if (typeof d === 'function') disposers.push(d);
    };
    const loopback = (req) => {
      const addr = req.socket?.remoteAddress ?? '';
      return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    };
    route('/plugins/dsh-model-failover/config', async (req, res) => {
      if (!loopback(req)) return json(res, 403, { error: 'loopback only' });
      if (req.method === 'GET') return json(res, 200, { ok: true, rules: { ...rules, switchLog }, switchLog });
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      try {
        const body = await readBody(req);
        if (!body || typeof body !== 'object') return json(res, 400, { error: 'invalid body' });
        const allowed = ['enabled', 'priority', 'triggers', 'maxSwitchesPerSession', 'cooldownMs', 'switchLogLimit', 'switchLog'];
        const change = Object.fromEntries(allowed.filter((k) => k in body).map((k) => [k, body[k]]));
        if (Object.keys(change).length === 0) return json(res, 400, { error: 'no known fields' });
        if ('priority' in change && (!Array.isArray(change.priority) || change.priority.length === 0)) {
          return json(res, 400, { error: 'priority must be a non-empty array' });
        }
        refresh(change);
        const saved = await saveConfig(ctx, change);
        return json(res, 200, { ok: true, saved, rules });
      } catch (error) { return json(res, 500, { error: renderThrown(error) }); }
    });
    route('/plugins/dsh-model-failover/restore', async (req, res) => {
      if (!loopback(req) || req.method !== 'POST') return json(res, 405, { error: 'loopback POST only' });
      try {
        const agents = ctx.agents?.list?.() ?? [];
        const target = agents[0];
        if (target === undefined) return json(res, 200, { ok: false, reason: 'no active agent' });
        const selection = manualRestore(target);
        return json(res, 200, { ok: true, selection });
      } catch (error) { return json(res, 500, { error: renderThrown(error) }); }
    });
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => async () => {
      for (const state of states.values()) state.stopping = true;
      for (const dispose of disposers) { try { dispose(); } catch { /* best effort */ } }
      states.clear();
    }, 'dsh-model-failover lifecycle');
  }

  const handle = { rules, states, drive, onRequestError, refresh, manualRestore, restore: manualRestore,
    get switchLog() { return switchLog; }, historyWrites: () => historyWrites,
    getRules: () => ({ ...rules, switchLog }) };
  // Keep the observable rules snapshot in sync with the accumulated history.
  Object.defineProperty(handle, 'rules', {
    get: () => ({ ...rules, switchLog }),
    enumerable: true,
  });
  return handle;
}

export { DEFAULT_PRIORITY, DEFAULT_TRIGGERS, normalizeRules, qualifies, nextSelection, failoverSummary, canSwitch, appendSwitchLog };
export default { name, inject, Config, apply };

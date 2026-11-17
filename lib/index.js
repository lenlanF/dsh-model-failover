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
  normalizeMode, chainForMode, nextSelectionForMode, pinnedSelection, allowsSelection,
  normalizeExhausted, isExhausted, markExhausted, nextUsableSelection, firstUsableSelection,
  routeKey, DEFAULT_COOLDOWN_MS,
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
  // The catalog carries no billing data, so "free" is a user assertion only.
  free: z.boolean().default(false),
});

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  priority: z.array(ModelEntry).default(DEFAULT_PRIORITY.map((s) => ({ ...s }))).volatile(),
  triggers: z.array(z.string()).default([...DEFAULT_TRIGGERS]).volatile(),
  maxSwitchesPerSession: z.number().min(0).default(3).volatile(),
  cooldownMs: z.number().min(0).default(0).volatile(),
  // Per-session runtime mode: 'off' | 'pinned' | 'free'.
  mode: z.string().default('off').volatile(),
  // How long a route that reported quota exhaustion is skipped.
  exhaustionCooldownMs: z.number().min(0).default(DEFAULT_COOLDOWN_MS).volatile(),
  // Persisted routeKey -> last exhaustion timestamp.
  exhaustedRoutes: z.dict(z.number()).default({}).volatile(),
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
      try { const data = Buffer.concat(chunks).toString('utf8').trim(); resolve(data ? JSON.parse(data) : {}); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

/** Locate this plugin's own configurable row in the Settings service. */
function findSettingsRow(ctx) {
  const settings = ctx.get?.('settings');
  if (settings === undefined || typeof settings.describe !== 'function') return undefined;
  let describe;
  try { describe = settings.describe(); } catch { return undefined; }
  if (!Array.isArray(describe)) return undefined;
  const id = ctx.fiber?.entry?.options?.id;
  return describe.find((r) => r.ns === id)
    ?? describe.find((r) => String(r.ns).includes('dsh-model-failover'));
}

/**
 * Read the config already persisted in the profile patch.
 * apply() receives whatever the loader passes at startup, which omits an
 * id-targeted override; without this read the plugin would fall back to its
 * built-in defaults and ignore the chain the user saved.
 */
function readPersistedConfig(ctx) {
  const row = findSettingsRow(ctx);
  const value = row?.value;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

/** Live-edit the profile patch through the Settings service. */
async function saveConfig(ctx, change) {
  const settings = ctx.get?.('settings');
  if (settings === undefined) throw new Error('settings service unavailable');
  const row = findSettingsRow(ctx);
  if (row === undefined) throw new Error('no configurable dsh-model-failover entry');
  const ops = Object.entries(change).map(([field, value]) => ({ op: 'set', path: [field], value }));
  await settings.mutate(row.ns, ops, undefined);
  return { ns: row.ns, fields: Object.keys(change) };
}

export function apply(ctx, config = {}, internals = {}) {
  // An id-targeted override in cordis.patch.yml never reaches this argument, so
  // the saved chain has to be read from the Settings service. It cannot be read
  // here: describe() only reports entries whose fiber is already active, and this
  // plugin is still starting. A direct config read is used when available, and
  // adoptPersistedConfig() retries once the entry goes live.
  const direct = typeof ctx.fiber?.entry?.options?.config === 'object' && ctx.fiber.entry.options.config !== null
    ? ctx.fiber.entry.options.config : undefined;
  const eager = direct ?? readPersistedConfig(ctx);
  const initial = eager ? { ...eager, ...config, priority: config?.priority?.length ? config.priority : eager.priority } : config;
  let rules = normalizeRules(initial);
  const states = createStateStore();
  let switchLog = rules.switchLog;
  // Runtime mode is per-profile config today; it is read on every decision so a
  // settings save takes effect without a restart.
  let mode = normalizeMode(initial.mode);
  let exhausted = false;
  const cooldownMs = () => Number.isFinite(rules?.exhaustionCooldownMs) ? rules.exhaustionCooldownMs : DEFAULT_COOLDOWN_MS;
  // Routes that reported quota exhaustion recently; skipped until the cooldown lapses.
  let exhaustedRoutes = normalizeExhausted(initial.exhaustedRoutes, Date.now(), cooldownMs());
  let historyWrites = Promise.resolve();
  const log = (level, text) => {
    try { ctx.logger?.[level]?.(text); } catch { /* logger optional */ }
  };
  const now = internals.now ?? (() => Date.now());
  const makeMessage = internals.createUserMessage;
  const refresh = (next) => {
    if (!next || typeof next !== 'object') return;
    rules = normalizeRules({ ...rules, ...next });
    if (Array.isArray(next.switchLog)) switchLog = rules.switchLog;
    if (next.mode !== undefined) {
      const nextMode = normalizeMode(next.mode);
      if (nextMode !== mode) exhausted = false;
      mode = nextMode;
    }
    if (next.exhaustedRoutes !== undefined) {
      exhaustedRoutes = normalizeExhausted(next.exhaustedRoutes, Date.now(), cooldownMs());
    }
  };

  /** Whether a failure reports a spent quota rather than a transport problem. */
  function isQuotaFailure(failure) {
    const code = typeof failure?.code === 'string' ? failure.code : '';
    if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA') return true;
    const message = typeof failure?.message === 'string' ? failure.message : '';
    return /quota|credit|balance|额度|积分/i.test(message);
  }

  /** The route an agent is currently on, tolerating a missing model facade. */
  function currentModelOf(agent) {
    try {
      const value = typeof agent?.model?.current === 'function' ? agent.model.current() : undefined;
      return value && value.provider && value.model ? value : undefined;
    } catch { return undefined; }
  }

  /** Persist the exhaustion table so a restart does not forget spent routes. */
  async function persistExhausted() {
    if (ctx.get?.('settings') === undefined) return;
    const snapshot = { ...exhaustedRoutes };
    historyWrites = historyWrites
      .then(() => saveConfig(ctx, { exhaustedRoutes: snapshot }))
      .catch((error) => log('warn', `dsh-model-failover: exhaustion write failed: ${renderThrown(error)}`));
    await historyWrites.catch(() => undefined);
  }

  /**
   * Re-read the saved chain once this entry is live.
   * describe() reports only active entries, so a read during apply() misses this
   * plugin's own row. Retrying on the first event that proves the entry is live
   * closes that window without a timer.
   */
  let adopted = false;
  function adoptPersistedConfig() {
    if (adopted) return;
    adopted = true;
    const persisted = readPersistedConfig(ctx);
    if (!persisted) return;
    // Restore persisted mode and exhausted-route state, not merely chain names.
    const hydrated = { ...persisted, ...(direct ?? {}), ...config };
    if (!Array.isArray(config.priority) || config.priority.length === 0) {
      hydrated.priority = Array.isArray(direct?.priority) && direct.priority.length
        ? direct.priority : persisted.priority;
    }
    refresh(hydrated);
    log('info', `dsh-model-failover: adopted saved config (${rules.priority.length} tiers)`);
  }

  /** Hidden seam: defer to downstream listeners before observing give-up. */
  async function onRequestError(payload, next) {
    const downstream = await next();
    if (downstream?.kind === 'retry') return downstream;
    const state = states.stateFor(payload.agent);
    if (state.stopping || payload.signal?.aborted) return downstream;
    if (!qualifies(payload.failure, rules)) return downstream;
    // Remember which route reported exhaustion so the chain can skip it.
    if (isQuotaFailure(payload.failure)) {
      const failedRoute = payload.provider
        ? { provider: payload.provider, model: payload.model ?? currentModelOf(payload.agent)?.model }
        : currentModelOf(payload.agent);
      if (failedRoute?.provider && failedRoute?.model) {
        exhaustedRoutes = markExhausted(exhaustedRoutes, failedRoute, now());
        log('info', `dsh-model-failover: marked ${failedRoute.provider}/${failedRoute.model} exhausted for ${Math.round(cooldownMs() / 60000)}min`);
        void persistExhausted();
      }
    }
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
    // Skip routes still inside their exhaustion cooldown so a spent model is not
    // retried on every request.
    const target = nextUsableSelection(current, rules, {
      exhausted: exhaustedRoutes, now: now(), cooldownMs: cooldownMs(), mode,
    });
    if (target === undefined) {
      // In free mode an empty remainder is the requested stop condition: the
      // session must not silently continue on a metered model.
      if (mode === 'free') {
        exhausted = true;
        log('warn', `dsh-model-failover: free budget exhausted for agent "${agent.id}"; stopping instead of using a metered model`);
      } else {
        log('warn', `dsh-model-failover: priority list exhausted for agent "${agent.id}"; no further switch`);
      }
      clearIntent(state);
      return;
    }
    if (intent.queuedMessageId !== undefined) return;
    // A route that cannot be resolved or switched to is treated like a spent one:
    // mark it and fall through to the next tier instead of aborting the failover.
    let chosen = target;
    let attempts = 0;
    while (chosen !== undefined && attempts < rules.priority.length) {
      attempts += 1;
      try {
        if (typeof ctx.llm?.resolveCallConfig === 'function') {
          await ctx.llm.resolveCallConfig({ provider: chosen.provider, model: chosen.model });
        }
        break;
      } catch (error) {
        log('warn', `dsh-model-failover: route ${chosen.provider}/${chosen.model} unusable (${renderThrown(error)}); skipping`);
        exhaustedRoutes = markExhausted(exhaustedRoutes, chosen, now());
        void persistExhausted();
        chosen = nextUsableSelection(chosen, rules, {
          exhausted: exhaustedRoutes, now: now(), cooldownMs: cooldownMs(), mode,
        });
      }
    }
    if (chosen === undefined) {
      log('warn', `dsh-model-failover: no usable route left for agent "${agent.id}"`);
      clearIntent(state);
      return;
    }
    const usable = chosen;
    try {
      agent.model.select({ provider: usable.provider, model: usable.model,
        ...(usable.reasoningEffort ? { reasoningEffort: usable.reasoningEffort } : {}) });
      const summary = failoverSummary(current, usable, intent.failure.code ?? 'UNKNOWN');
      const message = await createRetryMessage();
      state.intent = { ...intent, queuedMessageId: message.id, phase: 'queued' };
      agent.followup(message);
      state.switches += 1;
      state.lastSwitchAt = now();
      switchLog = appendSwitchLog(switchLog, {
        at: state.lastSwitchAt, code: intent.failure.code, from: current, to: usable, reason: 'auto',
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
    const chain = chainForMode(rules, mode);
    const first = mode === 'free'
      ? firstUsableSelection(rules, { exhausted: exhaustedRoutes, now: now(), cooldownMs: cooldownMs(), mode })
      : (chain[0] ?? pinnedSelection(rules));
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

  /**
   * Enforce the active mode at the last point before a request runs.
   * agent.model.select() is a synchronous session append with no waterfall
   * (dsh-agent/lib/index.js:196-199), so a pre-step correction is the only
   * place that can keep a pinned or free-only session inside its chain.
   */
  function enforceMode(agent) {
    if (mode === 'off') return undefined;
    const current = typeof agent.model?.current === 'function' ? agent.model.current() : undefined;
    if (allowsSelection(current, rules, mode) && !isExhausted(exhaustedRoutes, current, now(), cooldownMs())) return undefined;
    const available = firstUsableSelection(rules, { exhausted: exhaustedRoutes, now: now(), cooldownMs: cooldownMs(), mode });
    const target = available ?? (mode === 'free' ? undefined : (chainForMode(rules, mode)[0] ?? pinnedSelection(rules)));
    if (target === undefined) return undefined;
    agent.model.select({ provider: target.provider, model: target.model,
      ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}) });
    log('info', `dsh-model-failover: corrected ${current ? `${current.provider}/${current.model}` : 'unknown'} to ${target.provider}/${target.model} under mode ${mode}`);
    return target;
  }
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
    // Free mode stops rather than degrade: refuse the step when no free tier
    // remains, so the session cannot silently continue on a metered model.
    if (mode === 'free' && !firstUsableSelection(rules, { exhausted: exhaustedRoutes, now: now(), cooldownMs: cooldownMs(), mode })) {
      exhausted = true;
      log('warn', `dsh-model-failover: free mode has no marked free tier; refusing step for agent "${agent.id}"`);
      return { kind: 'reject' };
    }
    enforceMode(agent);
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
        // The entry is live here, so describe() can finally report this plugin.
        adoptPersistedConfig();
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
      if (req.method === 'GET') return json(res, 200, { ok: true, rules: { ...rules, switchLog, mode, exhausted }, switchLog, mode, exhausted });
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      const origin = req.headers?.origin;
      if (origin && !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/iu.test(origin)) return json(res, 403, { error: 'cross-origin POST refused' });
      try {
        const body = await readBody(req);
        if (!body || typeof body !== 'object') return json(res, 400, { error: 'invalid body' });
        const allowed = ['enabled', 'priority', 'triggers', 'maxSwitchesPerSession', 'cooldownMs', 'switchLogLimit', 'switchLog', 'mode'];
        const change = Object.fromEntries(allowed.filter((k) => k in body).map((k) => [k, body[k]]));
        if (Object.keys(change).length === 0) return json(res, 400, { error: 'no known fields' });
        if ('priority' in change && !Array.isArray(change.priority)) {
          return json(res, 400, { error: 'priority must be an array' });
        }
        const saved = await saveConfig(ctx, change);
        // Do not mutate live rules unless settings persistence succeeds.
        refresh(change);
        return json(res, 200, { ok: true, saved, rules });
      } catch (error) { return json(res, 500, { error: renderThrown(error) }); }
    });
    route('/plugins/dsh-model-failover/restore', async (req, res) => {
      if (!loopback(req)) return json(res, 403, { error: 'loopback only' });
      const agents = ctx.agents?.list?.() ?? [];
      if (req.method === 'GET') return json(res, 200, { ok: true, agents: agents.map(a => a.id) });
      if (req.method !== 'POST') return json(res, 405, { error: 'loopback GET/POST only' });
      const origin = req.headers?.origin;
      if (origin && !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/iu.test(origin)) return json(res, 403, { error: 'cross-origin POST refused' });
      try {
        const body = await readBody(req);
        const targetId = typeof body.agentId === 'string' ? body.agentId : '';
        if (!targetId && agents.length > 1) return json(res, 409, { ok: false, reason: 'select the agent to restore', agents: agents.map(a => a.id) });
        const target = targetId ? agents.find(a => a.id === targetId) : agents[0];
        if (target === undefined) return json(res, 404, { ok: false, reason: 'specified active agent not found' });
        const selection = manualRestore(target);
        if (!selection) return json(res, 409, { ok: false, reason: 'no eligible model under the active mode' });
        return json(res, 200, { ok: true, selection, agentId: target.id });
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
    enforceMode,
    get switchLog() { return switchLog; }, historyWrites: () => historyWrites,
    get mode() { return mode; }, get exhausted() { return exhausted; },
    setMode(next) { const normalized = normalizeMode(next); if (normalized !== mode) exhausted = false; mode = normalized; return mode; },
    getRules: () => ({ ...rules, switchLog, mode, exhausted, exhaustedRoutes: { ...exhaustedRoutes } }) };
  // Keep the observable rules snapshot in sync with the accumulated history.
  Object.defineProperty(handle, 'rules', {
    get: () => ({ ...rules, switchLog }),
    enumerable: true,
  });
  return handle;
}

export { DEFAULT_PRIORITY, DEFAULT_TRIGGERS, normalizeRules, qualifies, nextSelection, failoverSummary, canSwitch, appendSwitchLog,
  normalizeMode, chainForMode, nextSelectionForMode, pinnedSelection, allowsSelection,
  normalizeExhausted, isExhausted, markExhausted, nextUsableSelection, firstUsableSelection,
  routeKey, DEFAULT_COOLDOWN_MS };
export default { name, inject, Config, apply };

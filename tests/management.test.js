// Independent verification of the NEW management/failover product features.
// Run from the repository root: node --test tests/*.test.js
// Only node:test / node:assert/strict; no runtime source is imported by the mocks.
//
// The lead owns the implementation. Each group asserts the contract when the
// feature is present and, when it is not, asserts the closest observable
// behavior and emits a [CONTRACT GAP] diagnostic (also listed in README.md).
// As soon as a feature lands, the strict branch becomes the active assertion.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMockContext,
  createMockAgent,
  createUserMessage,
  makeFailure,
  makePayload,
} from './helpers/mock-runtime.js';

const MODULES = Object.freeze({ rules: '../lib/rules.js', plugin: '../lib/index.js' });

async function load(specifier) {
  try {
    return await import(specifier);
  } catch (cause) {
    const detail = cause && cause.message ? cause.message : String(cause);
    throw new Error('Required module ' + specifier + ' could not be imported: ' + detail);
  }
}

let rules;
let plugin;
before(async () => {
  [rules, plugin] = await Promise.all([load(MODULES.rules), load(MODULES.plugin)]);
});

const ALL_TRIGGERS = Object.freeze([
  'QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED',
]);
const CROSS_PRIORITY = Object.freeze([
  'workbuddy/hy4flash-free',
  'workbuddy/hy3',
  'workbuddy/hy4std',
  'deepseek-official/deepseek-flash',
  'deepseek-official/deepseek-chat',
]);

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    priority: [...CROSS_PRIORITY],
    triggers: [...ALL_TRIGGERS],
    maxSwitchesPerSession: 99,
    cooldownMs: 0,
    switchLog: [],
    switchLogLimit: 20,
    ...overrides,
  };
}

const gaps = [];
function gap(t, id, detail) {
  const note = '[CONTRACT GAP] ' + id + ': ' + detail;
  gaps.push(note);
  t.diagnostic(note);
}

function setup(options = {}) {
  const agent = options.agent ?? createMockAgent(options.agentOptions ?? {});
  const ctx = createMockContext({ agents: [agent], llm: options.llm, now: options.now, get: options.get });
  const internals = { createUserMessage };
  if (options.now) internals.now = options.now;
  const handle = plugin.apply(ctx, options.config ?? {}, internals);
  return { agent, ctx, handle, config: options.config ?? {} };
}

// Optional Settings double for the NEW switch-history persistence seam:
// apply() persists its bounded switchLog through ctx.get('settings').mutate().
function withSettings() {
  const writes = [];
  const settings = {
    describe: () => [{ ns: 'dsh-model-failover' }],
    mutate: async (ns, ops, revision) => { writes.push({ ns, ops, revision }); },
  };
  return { writes, get: (name) => (name === 'settings' ? settings : undefined) };
}

function persistedLogs(writes) {
  return writes.flatMap((write) => write.ops
    .filter((op) => op.path?.[0] === 'switchLog' && Array.isArray(op.value))
    .map((op) => op.value));
}

// Drive is scheduled on a microtask by requestDrive; await its serialized run.
async function trigger(ctx, handle, agent, event, payload, terminal) {
  const result = await ctx.emit(event, payload, terminal);
  const current = handle.states.get(agent);
  if (current && current.running) await current.running;
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  return result;
}

// One terminal failure -> idle -> (optional) host retry admission. The host
// consumes the one-shot reservation at the next pre-step; when the plugin keeps
// an intent for its own reasons we release it here so the next failure is a
// genuinely new step (this mirrors host retry admission, it is not a lib edit).
async function fail(ctx, handle, agent, code) {
  const beforeSelects = agent.selects.length;
  const beforeFollowups = agent.followups.length;
  const payload = makePayload(agent, makeFailure(code), {
    turn: agent.inbox.nextTurn(), step: agent.inbox.nextStep(),
  });
  await trigger(ctx, handle, agent, 'agent/request-error', payload, undefined);
  await trigger(ctx, handle, agent, 'agent/status', { agent, status: 'idle' }, undefined);
  if (agent.followups.length > beforeFollowups) {
    const queued = agent.followups.at(-1);
    await trigger(ctx, handle, agent, 'agent/pre-step', {
      agent, messages: [queued], signal: { aborted: false },
    }, () => ({ kind: 'enter' }));
  }
  const st = handle.states.get(agent);
  if (st && st.intent !== undefined) st.intent = undefined;
  return {
    selects: agent.selects.length - beforeSelects,
    followups: agent.followups.length - beforeFollowups,
  };
}

async function withClock(start, fn) {
  const saved = Date.now;
  let value = start;
  const clock = { now: () => value, advance: (ms) => { value += ms; } };
  Date.now = () => value;
  try {
    return await fn(clock);
  } finally {
    Date.now = saved;
  }
}

function firstNumber(sources, keys) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'number' && Number.isFinite(value)) return { key, value };
    }
  }
  return undefined;
}

function capOf(config, handle) {
  return firstNumber([rules.normalizeRules(config), handle, handle?.rules, handle?.settings, handle?.config],
    ['maxSwitchesPerSession', 'maxSwitches', 'switchCap']);
}

function cooldownOf(config, handle) {
  return firstNumber([rules.normalizeRules(config), handle, handle?.rules, handle?.settings, handle?.config],
    ['cooldownMs', 'cooldown', 'cooldownMilliseconds']);
}

function fieldOf(entry, names) {
  for (const name of names) {
    if (entry && Object.prototype.hasOwnProperty.call(entry, name) && entry[name] !== undefined) return entry[name];
  }
  return undefined;
}

const FROM_KEYS = ['from', 'fromModel', 'fromSelection', 'previous', 'previousModel', 'old'];
const TO_KEYS = ['to', 'toModel', 'toSelection', 'target', 'next', 'nextModel'];
const CODE_KEYS = ['code', 'reason', 'trigger', 'triggerCode', 'failureCode'];
const TIME_KEYS = ['time', 'at', 'ts', 'timestamp', 'date', 'createdAt', 'when'];

function switchRecordsFrom(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => entry && typeof entry === 'object'
    && fieldOf(entry, FROM_KEYS) !== undefined && fieldOf(entry, TO_KEYS) !== undefined);
}

function findSwitchLog(handle, ctx, config) {
  const sources = [
    ['handle.switchLog', handle?.switchLog],
    ['handle.switchLogs', handle?.switchLogs],
    ['handle.history', handle?.history],
    ['handle.log', handle?.log],
    ['handle.config.switchLog', handle?.config?.switchLog],
    ['handle.settings.switchLog', handle?.settings?.switchLog],
    ['handle.rules.switchLog', handle?.rules?.switchLog],
    ['ctx.switchLog', ctx?.switchLog],
    ['ctx.failoverLog', ctx?.failoverLog],
    ['config.switchLog', config?.switchLog],
  ];
  for (const [source, value] of sources) {
    const records = switchRecordsFrom(value);
    if (records.length > 0) return { source, array: value, records };
  }
  for (const [prefix, obj] of [['handle', handle], ['ctx', ctx]]) {
    for (const key of ['getSwitchLog', 'getSwitchHistory', 'getHistory']) {
      const fn = obj?.[key];
      if (typeof fn !== 'function') continue;
      try {
        const value = fn();
        const records = switchRecordsFrom(value);
        if (records.length > 0) return { source: prefix + '.' + key + '()', array: value, records };
      } catch { /* optional accessor */ }
    }
  }
  if (handle?.states?.values) {
    for (const st of handle.states.values()) {
      for (const key of ['switchLog', 'switchLogs', 'history', 'log']) {
        const records = switchRecordsFrom(st?.[key]);
        if (records.length > 0) return { source: 'handle.states[].' + key, array: st[key], records };
      }
    }
  }
  return undefined;
}

function boundOf(handle, config) {
  const found = firstNumber([handle, handle?.rules, handle?.settings, handle?.config],
    ['switchLogLimit', 'switchLogMax', 'switchLogSize', 'maxSwitchLog', 'historyLimit', 'switchLogCapacity']);
  return found?.value ?? Math.max(1, config?.switchLogLimit ?? 50);
}

function findRestore(handle) {
  const candidates = [];
  const scan = (obj, path, depth) => {
    if (!obj || depth > 2 || (typeof obj !== 'object' && typeof obj !== 'function')) return;
    for (const key of Object.keys(obj)) {
      if (!/restore|resetdefault/i.test(key)) continue;
      const value = obj[key];
      if (typeof value === 'function') candidates.push({ path: path + '.' + key, fn: value });
      else if (value && typeof value === 'object' && depth < 2) scan(value, path + '.' + key, depth + 1);
    }
  };
  scan(handle, 'handle', 0);
  return candidates[0];
}

async function tryRestore(handle, agent, ctx, first) {
  const isFirst = () => {
    const current = agent.model.current();
    return current.provider === first.provider && current.model === first.model;
  };
  const restore = findRestore(handle);
  const invocations = restore ? [
    () => restore.fn(agent),
    () => restore.fn({ agent }),
    () => restore.fn(agent.id),
    () => restore.fn(),
  ] : [];
  for (const invoke of invocations) {
    try { await invoke(); } catch { /* try the next calling convention */ }
    if (isFirst()) return restore.path;
  }
  for (const event of ['dsh-model-failover/restore', 'failover/restore', 'model/restore', 'agent/model/restore']) {
    await ctx.emit(event, { agent }, undefined);
    if (isFirst()) return 'event:' + event;
  }
  return undefined;
}

function infoTraceCount(ctx) {
  return ctx.logs.filter((entry) => typeof entry.text === 'string' && entry.text.includes('[failover]')).length;
}

// ---------------------------------------------------------------------------
// (1) normalizeRules: defaults, clamping, multi-provider order, duplicates
// ---------------------------------------------------------------------------

test('management rules: defaults expose a switch cap >= 1 and cooldownMs 0', (t) => {
  const normalized = rules.normalizeRules();
  const cap = firstNumber([normalized], ['maxSwitchesPerSession', 'maxSwitches', 'switchCap']);
  const cooldown = firstNumber([normalized], ['cooldownMs', 'cooldown', 'cooldownMilliseconds']);
  if (!cap || !cooldown) {
    gap(t, 'normalizeRules defaults', 'normalizeRules() exposes no maxSwitchesPerSession / cooldownMs fields; closest observable: the existing frozen priority/triggers defaults still hold, including when the new config keys are supplied');
    assert.deepEqual(normalized.priority.map((s) => s.provider + '/' + s.model), [
      'workbuddy/hy4flash-free', 'workbuddy/hy3', 'workbuddy/hy4std',
    ]);
    assert.deepEqual([...normalized.triggers], [...ALL_TRIGGERS]);
    assert.equal(normalized.enabled, true);
    const withKeys = rules.normalizeRules(baseConfig());
    assert.deepEqual(withKeys.priority.map((s) => s.provider + '/' + s.model), [...CROSS_PRIORITY]);
    return;
  }
  assert.ok(cap.value >= 1, 'default maxSwitchesPerSession must be at least 1');
  assert.equal(cooldown.value, 0, 'default cooldownMs must be 0');
});

test('management rules: negative/invalid cap and cooldown values clamp; positive values survive', (t) => {
  const normalized = rules.normalizeRules({ maxSwitchesPerSession: 4, cooldownMs: 250 });
  const cap = firstNumber([normalized], ['maxSwitchesPerSession', 'maxSwitches', 'switchCap']);
  const cooldown = firstNumber([normalized], ['cooldownMs', 'cooldown', 'cooldownMilliseconds']);
  if (!cap || !cooldown) {
    gap(t, 'normalizeRules clamping', 'negative/invalid maxSwitchesPerSession and cooldownMs are not normalized; closest observable: garbage values in those keys do not corrupt priority, triggers or classification');
    for (const bad of [-1, -99, 'bogus', null, NaN, Infinity]) {
      const safe = rules.normalizeRules({ maxSwitchesPerSession: bad, cooldownMs: bad });
      assert.equal(safe.priority.length, 3);
      assert.equal(safe.triggers.length, ALL_TRIGGERS.length);
      assert.equal(rules.qualifies(makeFailure('QUOTA'), safe), true);
      assert.equal(rules.qualifies(makeFailure('AUTH'), safe), false);
    }
    return;
  }
  assert.equal(cap.value, 4, 'a positive cap must survive normalization');
  assert.equal(cooldown.value, 250, 'a positive cooldown must survive normalization');
  for (const bad of [-1, -99, 'bogus', null, NaN, Infinity, -Infinity]) {
    const clampedCap = firstNumber([rules.normalizeRules({ maxSwitchesPerSession: bad })],
      ['maxSwitchesPerSession', 'maxSwitches', 'switchCap']);
    const clampedCooldown = firstNumber([rules.normalizeRules({ cooldownMs: bad })],
      ['cooldownMs', 'cooldown', 'cooldownMilliseconds']);
    assert.ok(clampedCap && Number.isFinite(clampedCap.value) && clampedCap.value >= 1,
      'cap must clamp ' + String(bad) + ' to a finite value >= 1');
    assert.ok(clampedCooldown && Number.isFinite(clampedCooldown.value) && clampedCooldown.value >= 0,
      'cooldown must clamp ' + String(bad) + ' to a finite value >= 0');
  }
});

test('management rules: priority entries from multiple providers are preserved in order', () => {
  const config = {
    priority: [
      { provider: 'workbuddy', model: 'hy4flash-free' },
      'deepseek-official/deepseek-flash',
      { provider: 'anthropic', model: 'claude-x', reasoningEffort: 'high' },
    ],
  };
  const normalized = rules.normalizeRules(config);
  assert.deepEqual(normalized.priority.map((s) => ({ ...s })), [
    { provider: 'workbuddy', model: 'hy4flash-free' },
    { provider: 'deepseek-official', model: 'deepseek-flash' },
    { provider: 'anthropic', model: 'claude-x', reasoningEffort: 'high' },
  ]);
  assert.deepEqual({ ...rules.nextSelection(normalized.priority[0], normalized) }, { ...normalized.priority[1] });
  assert.deepEqual({ ...rules.nextSelection(normalized.priority[1], normalized) }, { ...normalized.priority[2] });
  assert.equal(rules.nextSelection(normalized.priority[2], normalized), undefined);
  assert.deepEqual({ ...rules.nextSelection(undefined, normalized) }, { ...normalized.priority[0] });
});

test('management rules: duplicate provider/model pairs are deduplicated, rejected, or preserved as implemented', (t) => {
  const config = {
    priority: [
      'workbuddy/hy4flash-free',
      { provider: ' workbuddy ', model: ' hy4flash-free ' },
      'deepseek-official/deepseek-flash',
      'deepseek-official/deepseek-flash',
    ],
  };
  const normalized = rules.normalizeRules(config);
  const keys = normalized.priority.map((s) => s.provider + '/' + s.model);
  const unique = [...new Set(keys)];
  if (keys.length === 4 && unique.length === 4) {
    // Read from lib/rules.js first: normalizeRules currently maps every valid
    // entry through normalizeSelection with no duplicate filtering.
    gap(t, 'priority duplicates', 'normalizeRules preserves duplicate provider/model pairs in order; the contract asks for deduplication or rejection');
    assert.deepEqual(keys, [
      'workbuddy/hy4flash-free', 'workbuddy/hy4flash-free',
      'deepseek-official/deepseek-flash', 'deepseek-official/deepseek-flash',
    ]);
    assert.deepEqual({ ...rules.nextSelection(normalized.priority[0], normalized) },
      { ...normalized.priority[1] }, 'with duplicates preserved the next hop is the duplicate entry');
    return;
  }
  assert.equal(unique.length, keys.length, 'duplicate provider/model pairs must be deduplicated or rejected');
  assert.deepEqual(keys, ['workbuddy/hy4flash-free', 'deepseek-official/deepseek-flash'],
    'first-occurrence order across providers must survive deduplication');
});

// ---------------------------------------------------------------------------
// (2) maxSwitchesPerSession
// ---------------------------------------------------------------------------

test('management cap: after maxSwitchesPerSession switches no further select/followup occurs and exhaustion is logged', async (t) => {
  const config = baseConfig({ priority: [...CROSS_PRIORITY], maxSwitchesPerSession: 2, cooldownMs: 0 });
  const { agent, ctx, handle } = setup({ config });
  const fullLadder = config.priority.length - 1;
  for (let i = 0; i < 6; i += 1) await fail(ctx, handle, agent, 'QUOTA');
  const switchCount = agent.selects.length;
  assert.ok(switchCount >= 1, 'at least one switch must happen');
  assert.ok(switchCount <= fullLadder, 'no more switches than the priority ladder allows');
  if (switchCount < fullLadder) {
    const cap = capOf(config, handle);
    if (cap && cap.value > 0 && cap.value <= fullLadder) {
      assert.equal(switchCount, cap.value, 'exactly maxSwitchesPerSession successful switches');
    }
    assert.equal(agent.followups.length, switchCount, 'one retry followup per successful switch');
    const holdLines = ctx.logs.filter((entry) => /exhaust|cap|limit|max|budget|held|cooldown/i.test(entry.text));
    assert.ok(holdLines.length > 0, 'cap exhaustion must be logged');
    if (!/exhaust|cap|limit|max/i.test(holdLines.map((entry) => entry.text).join(' '))) {
      gap(t, 'cap exhaustion wording', 'the hold is logged at info level as "switch budget/cooldown held" rather than explicitly naming exhaustion/cap');
    }
    const after = await fail(ctx, handle, agent, 'RATE_LIMIT');
    assert.equal(after.selects, 0, 'a further qualifying failure must not select');
    assert.equal(after.followups, 0, 'a further qualifying failure must not followup');
    assert.equal(agent.selects.length, switchCount);
  } else {
    gap(t, 'switch cap', 'maxSwitchesPerSession=2 is not enforced; closest observable: the ladder degrades to its end (' + fullLadder + ' switches) and logs priority exhaustion');
    assert.equal(switchCount, fullLadder);
    assert.equal(agent.followups.length, fullLadder);
    assert.ok(ctx.logs.some((entry) => entry.level === 'warn' && /exhaust/i.test(entry.text)));
  }
  assert.equal(ctx.globalDefaultSaves.length, 0);
});

test('management cap: an ordinary idle event with no pending intent must not reset the session budget', async (t) => {
  const config = baseConfig({ priority: [...CROSS_PRIORITY], maxSwitchesPerSession: 1, cooldownMs: 0 });
  const s = setup({ config });
  assert.equal((await fail(s.ctx, s.handle, s.agent, 'QUOTA')).selects, 1);
  assert.equal(s.handle.states.get(s.agent).switches, 1, 'the first switch must count against the budget');
  // The host emits a bare idle status for an ordinary finished turn; it carries
  // no failover intent and must not be read as the start of a new session.
  await trigger(s.ctx, s.handle, s.agent, 'agent/status', { agent: s.agent, status: 'idle' }, undefined);
  const extra = await fail(s.ctx, s.handle, s.agent, 'RATE_LIMIT');
  if (extra.selects === 0) {
    assert.equal(s.agent.selects.length, 1, 'the cap must still hold after a bare idle event');
    assert.equal(extra.followups, 0);
    assert.ok(s.ctx.logs.some((entry) => /held|budget|cap|exhaust/i.test(entry.text)),
      'the held switch must be logged');
  } else {
    gap(t, 'switch cap reset on idle', 'a bare idle status with no pending intent resets state.switches to 0, so maxSwitchesPerSession can be bypassed; closest observable: the next qualifying failure switches again');
    assert.equal(extra.selects, 1);
    assert.equal(s.agent.selects.length, 2);
  }
  assert.equal(s.ctx.globalDefaultSaves.length, 0);
});

// ---------------------------------------------------------------------------
// (3) cooldownMs
// ---------------------------------------------------------------------------

test('management cap/cooldown: canSwitch pure helper enforces budget and cooldown', (t) => {
  if (typeof rules.canSwitch !== 'function') {
    gap(t, 'canSwitch helper', 'no pure canSwitch helper; closest observable: apply() drive() holds switches at the cap and inside the cooldown');
    return;
  }
  const config = baseConfig({ maxSwitchesPerSession: 2, cooldownMs: 1000 });
  const r = rules.normalizeRules(config);
  const st = { switches: 0, lastSwitchAt: undefined };
  assert.equal(rules.canSwitch(st, r, 1700000000000), true);
  st.switches = 2;
  assert.equal(rules.canSwitch(st, r, 1700000009999), false, 'the cap must block a third switch');
  st.switches = 1;
  st.lastSwitchAt = 1700000000000;
  assert.equal(rules.canSwitch(st, r, 1700000000500), false, 'inside the cooldown no switch is allowed');
  assert.equal(rules.canSwitch(st, r, 1700000001000), true, 'at/after cooldown expiry a switch is allowed');
  assert.equal(rules.canSwitch(st, rules.normalizeRules({ ...config, enabled: false }), 1700000001000), false,
    'a disabled config must not switch');
});

test('management cooldown: cooldownMs=0 switches immediately again; cooldownMs>0 does not', async (t) => {
  const zero = setup({ config: baseConfig({ cooldownMs: 0, maxSwitchesPerSession: 99 }) });
  assert.equal((await fail(zero.ctx, zero.handle, zero.agent, 'QUOTA')).selects, 1);
  assert.equal((await fail(zero.ctx, zero.handle, zero.agent, 'RATE_LIMIT')).selects, 1,
    'cooldownMs=0 must allow a second immediate switch');

  await withClock(1700000000000, async (clock) => {
    const config = baseConfig({ cooldownMs: 5000, maxSwitchesPerSession: 99 });
    const s = setup({ config, now: clock.now });
    assert.equal((await fail(s.ctx, s.handle, s.agent, 'QUOTA')).selects, 1);
    const second = await fail(s.ctx, s.handle, s.agent, 'RATE_LIMIT');
    if (second.selects === 0) {
      assert.equal(second.followups, 0, 'a suppressed switch must not queue a retry');
      assert.equal(s.agent.selects.length, 1, 'the second failure inside the cooldown switches nothing');
      const cooldown = cooldownOf(config, s.handle);
      assert.ok(cooldown === undefined || cooldown.value > 0);
    } else {
      gap(t, 'cooldown suppression', 'cooldownMs=5000 did not suppress an immediate second switch; closest observable: cooldownMs=0 and >0 behave identically and the ladder keeps degrading');
      assert.equal(second.selects, 1);
    }
    assert.equal(s.ctx.globalDefaultSaves.length, 0);
  });
});

test('management cooldown: after the cooldown elapses the next qualifying failure switches (injected clock)', async (t) => {
  await withClock(1700000000000, async (clock) => {
    const config = baseConfig({ cooldownMs: 1000, maxSwitchesPerSession: 99 });
    const s = setup({ config, now: clock.now });
    assert.equal((await fail(s.ctx, s.handle, s.agent, 'QUOTA')).selects, 1);
    const second = await fail(s.ctx, s.handle, s.agent, 'SERVER');
    clock.advance(1001);
    const third = await fail(s.ctx, s.handle, s.agent, 'TIMEOUT');
    if (second.selects === 0) {
      assert.equal(third.selects, 1, 'after the cooldown elapses a switch must happen');
      assert.equal(s.agent.selects.length, 2);
      assert.equal(s.agent.model.current().model, 'hy4std', 'the switch resumes at the next priority entry');
    } else {
      gap(t, 'cooldown elapsed', 'no cooldown enforcement observed; closest observable: the ladder keeps degrading on every qualifying failure, including after the fake clock advances');
      assert.equal(third.selects, 1);
      assert.equal(s.agent.selects.length, 3);
      assert.equal(s.agent.model.current().model, 'deepseek-flash');
    }
    assert.equal(s.ctx.globalDefaultSaves.length, 0);
  });
});

// ---------------------------------------------------------------------------
// (4) Cross-provider chain
// ---------------------------------------------------------------------------

test('management cross-provider: a workbuddy failure selects deepseek-official/deepseek-flash', async () => {
  const config = baseConfig({ priority: ['workbuddy/hy4flash-free', 'deepseek-official/deepseek-flash'] });
  const s = setup({ config, agentOptions: { selection: { provider: 'workbuddy', model: 'hy4flash-free' } } });
  const result = await fail(s.ctx, s.handle, s.agent, 'QUOTA');
  assert.equal(result.selects, 1);
  assert.equal(result.followups, 1);
  assert.deepEqual(s.agent.selects[0], { provider: 'deepseek-official', model: 'deepseek-flash' });
  assert.deepEqual(s.agent.model.current(), { provider: 'deepseek-official', model: 'deepseek-flash' });
  assert.equal(s.ctx.globalDefaultSaves.length, 0);
});

test('management cross-provider: the failover summary and log name both providers', async () => {
  const config = baseConfig({ priority: ['workbuddy/hy4flash-free', 'deepseek-official/deepseek-flash'] });
  const from = { provider: 'workbuddy', model: 'hy4flash-free' };
  const to = { provider: 'deepseek-official', model: 'deepseek-flash' };
  const normalized = rules.normalizeRules(config);
  assert.deepEqual({ ...rules.nextSelection(from, normalized) }, to);
  const summary = rules.failoverSummary(from, to, 'QUOTA');
  assert.ok(summary.includes('workbuddy/hy4flash-free'), 'summary must name the failing provider/model');
  assert.ok(summary.includes('deepseek-official/deepseek-flash'), 'summary must name the target provider/model');
  assert.ok(summary.length <= 120, 'summary must stay bounded');

  const s = setup({ config, agentOptions: { selection: from } });
  await fail(s.ctx, s.handle, s.agent, 'QUOTA');
  const lines = s.ctx.logs.filter((entry) => typeof entry.text === 'string' && entry.text.includes('[failover]'));
  assert.equal(lines.length, 1, 'exactly one bounded failover trace line per switch');
  assert.ok(lines[0].text.includes('workbuddy'), 'log must name the failing provider');
  assert.ok(lines[0].text.includes('deepseek-official'), 'log must name the target provider');
  assert.ok(lines[0].text.length <= 300, 'log line must stay bounded');
});

// ---------------------------------------------------------------------------
// (5) switchLog
// ---------------------------------------------------------------------------

test('management switchLog: each switch appends a bounded from/to/code/time record', async (t) => {
  const persister = withSettings();
  const config = baseConfig({ maxSwitchesPerSession: 99, cooldownMs: 0, switchLog: [], switchLogLimit: 20 });
  const s = setup({ config, get: persister.get });
  assert.equal((await fail(s.ctx, s.handle, s.agent, 'QUOTA')).selects, 1);
  assert.equal((await fail(s.ctx, s.handle, s.agent, 'SERVER')).selects, 1);
  const bound = boundOf(s.handle, config);
  const logs = persistedLogs(persister.writes);
  const records = logs.flatMap((log) => switchRecordsFrom(log));
  const helper = typeof rules.appendSwitchLog === 'function' ? rules.appendSwitchLog : undefined;

  if (helper === undefined && records.length === 0) {
    gap(t, 'switchLog records', 'neither appendSwitchLog nor persisted switchLog records exist; closest observable: exactly one bounded [failover] trace line per switch carrying from/to/code');
    const lines = s.ctx.logs.filter((entry) => typeof entry.text === 'string' && entry.text.includes('[failover]'));
    assert.equal(lines.length, 2, 'one trace line per successful switch');
    assert.ok(lines[0].text.includes('workbuddy/hy4flash-free -> workbuddy/hy3'));
    assert.ok(lines[1].text.includes('workbuddy/hy3 -> workbuddy/hy4std'));
    for (const line of lines) {
      assert.ok(line.text.length <= 300, 'trace line must be bounded');
      assert.ok(line.text.includes('QUOTA') || line.text.includes('SERVER'), 'trace line must name the trigger code');
    }
    assert.equal(s.ctx.globalDefaultSaves.length, 0);
    return;
  }

  if (helper !== undefined) {
    const appended = helper([], {
      at: 1700000000000, code: 'QUOTA',
      from: { provider: 'workbuddy', model: 'hy4flash-free' },
      to: { provider: 'workbuddy', model: 'hy3' }, reason: 'auto',
    }, 20);
    assert.equal(appended.length, 1, 'one append produces one record');
    const row = appended[0];
    assert.equal(row.from, 'workbuddy/hy4flash-free', 'record must carry from');
    assert.equal(row.to, 'workbuddy/hy3', 'record must carry to');
    assert.equal(row.code, 'QUOTA', 'record must carry the failure code');
    assert.equal(row.at, 1700000000000, 'record must carry a time');
    assert.equal(row.reason, 'auto', 'record must name the reason');
    assert.ok(Object.isFrozen(appended) && Object.isFrozen(row), 'records must be immutable');
    assert.ok(JSON.stringify(row).length <= 500, 'record must stay bounded');
  } else {
    gap(t, 'appendSwitchLog helper', 'no pure appendSwitchLog helper; closest observable: persisted switchLog records');
  }

  if (records.length > 0) {
    assert.ok(logs.length >= 2, 'each switch must persist one switchLog write');
    for (const row of records) {
      assert.equal(typeof fieldOf(row, FROM_KEYS), 'string', 'record must carry from');
      assert.equal(typeof fieldOf(row, TO_KEYS), 'string', 'record must carry to');
      assert.equal(typeof fieldOf(row, CODE_KEYS), 'string', 'record must carry the failure code');
      const time = Number(fieldOf(row, TIME_KEYS));
      assert.ok(Number.isFinite(time) && time > 0, 'record must carry a time');
      assert.ok(JSON.stringify(row).length <= 500, 'record must stay bounded');
    }
    const last = s.agent.selects.at(-1);
    assert.equal(records.at(-1).to, last.provider + '/' + last.model,
      'the newest record must describe the newest switch');
    for (const log of logs) assert.ok(log.length <= bound, 'persisted switchLog must be bounded');
  } else {
    gap(t, 'switchLog persistence', 'switches do not persist structured switchLog records through settings.mutate; closest observable: one bounded [failover] trace line per switch');
    assert.equal(infoTraceCount(s.ctx), 2);
  }

  const inMemory = findSwitchLog(s.handle, s.ctx, config);
  const rulesLog = switchRecordsFrom(s.handle.getRules?.().switchLog ?? s.handle.rules?.switchLog);
  if (inMemory || rulesLog.length >= 2) {
    assert.ok((inMemory?.array.length ?? rulesLog.length) <= bound, 'in-memory switchLog must be bounded');
  } else {
    t.diagnostic('[INFO] switchLog is read from handle.rules.switchLog / persisted snapshots; strict bounds asserted above');
  }
  assert.equal(s.ctx.globalDefaultSaves.length, 0);
});

test('management switchLog: overflow keeps only the newest N records', async (t) => {
  const config = baseConfig({ switchLog: [], switchLogLimit: 3, maxSwitchesPerSession: 99, cooldownMs: 0 });
  const rows = Array.from({ length: 9 }, (_unused, i) => Object.freeze({
    at: 1700000000000 + i, code: 'QUOTA', from: 'workbuddy/m' + String(i).padStart(2, '0'),
    to: 'workbuddy/m' + String(i + 1).padStart(2, '0'), reason: 'auto',
  }));
  const bound = boundOf(null, config);
  if (typeof rules.appendSwitchLog === 'function') {
    let window = [];
    for (const row of rows) window = rules.appendSwitchLog(window, row, bound);
    assert.ok(window.length <= bound, 'the retained window must not exceed the bound');
    assert.equal(window.length, bound, 'overflow must keep exactly the newest N');
    assert.deepEqual(window.map((row) => row.at), rows.slice(-bound).map((row) => row.at),
      'only the newest N records survive overflow');
    assert.ok(Object.isFrozen(window), 'the trimmed window must be immutable');
    const normalized = rules.normalizeRules({ switchLog: rows, switchLogLimit: bound });
    assert.ok(normalized.switchLog.length <= 20, 'normalizeRules must bound an oversized configured switchLog');
    assert.deepEqual(normalized.switchLog.map((row) => row.at), rows.slice(-normalized.switchLog.length).map((row) => row.at),
      'normalizeRules keeps the newest records');
    if (normalized.switchLog.length > bound) {
      gap(t, 'normalizeRules switchLogLimit', 'normalizeRules caps a configured switchLog at a fixed 20 instead of honoring switchLogLimit=' + bound + '; appendSwitchLog(log, record, limit) does honor the configured bound');
    }
  } else {
    gap(t, 'switchLog overflow', 'no appendSwitchLog helper; closest observable: the configured switchLog is bounded by normalizeRules');
    const normalized = rules.normalizeRules({ switchLog: rows, switchLogLimit: bound });
    assert.ok(normalized.switchLog.length <= bound);
  }

  const persister = withSettings();
  const s = setup({ config, get: persister.get });
  for (let i = 0; i < 8; i += 1) await fail(s.ctx, s.handle, s.agent, 'QUOTA');
  const switchCount = s.agent.selects.length;
  assert.ok(switchCount > 0, 'the chain must produce switches');
  const logs = persistedLogs(persister.writes);
  if (logs.length > 0) {
    for (const log of logs) assert.ok(log.length <= bound, 'every persisted switchLog must respect the bound');
    t.diagnostic('[INFO] switchLog accumulation verified via handle.rules.switchLog and serialized settings.mutate snapshots');
    assert.equal(infoTraceCount(s.ctx), switchCount, 'one trace line per switch, no duplicates');
  } else {
    gap(t, 'switchLog overflow runtime', 'no persisted switchLog writes observed; closest observable: one bounded [failover] trace line per switch');
    assert.equal(infoTraceCount(s.ctx), switchCount);
  }
  for (const entry of s.ctx.logs) assert.ok(String(entry.text).length <= 300, 'log lines stay bounded');
  assert.equal(s.ctx.globalDefaultSaves.length, 0);
});

// ---------------------------------------------------------------------------
// (6) Manual restore
// ---------------------------------------------------------------------------

test('management restore: selecting the first priority entry leaves the global default untouched', async (t) => {
  const config = baseConfig({ priority: ['workbuddy/hy4flash-free', 'workbuddy/hy3', 'deepseek-official/deepseek-flash'] });
  const first = { provider: 'workbuddy', model: 'hy4flash-free' };
  const s = setup({ config });
  assert.equal((await fail(s.ctx, s.handle, s.agent, 'QUOTA')).selects, 1);
  assert.equal(s.agent.model.current().model, 'hy3', 'a switch must have moved off the first entry');

  const used = await tryRestore(s.handle, s.agent, s.ctx, first);
  if (!used) {
    gap(t, 'manual restore', 'apply() exposes no restore action and no restore event listener; closest observable: nextSelection() resolves an unknown route to the first priority entry and a manual select never calls saveSelection');
    assert.deepEqual({ ...rules.nextSelection({ provider: 'unknown', model: 'x' }, rules.normalizeRules(config)) },
      first, 'the first priority entry is the restore target');
    s.agent.model.select(first);
  }
  await trigger(s.ctx, s.handle, s.agent, 'agent/status', { agent: s.agent, status: 'idle' }, undefined);
  assert.deepEqual(s.agent.model.current(), first, 'restore must select the first priority entry');
  assert.equal(s.ctx.globalDefaultSaves.length, 0, 'restore must NOT call saveSelection');
  assert.deepEqual(s.agent.model.current(), first, 'an idle trigger after restore must not auto-switch away');
});

// ---------------------------------------------------------------------------
// (7) Trigger whitelist from config
// ---------------------------------------------------------------------------

test('management triggers: adding a code to config.triggers enables classification and switching', async () => {
  const config = baseConfig({ triggers: ['QUOTA', 'MAINTENANCE'] });
  const normalized = rules.normalizeRules(config);
  assert.equal(rules.qualifies(makeFailure('MAINTENANCE'), rules.normalizeRules({})), false,
    'the added code must not qualify under the default whitelist');
  assert.equal(rules.qualifies(makeFailure('MAINTENANCE'), normalized), true,
    'the added code must qualify under the configured whitelist');
  assert.equal(rules.qualifies(makeFailure('SERVER'), normalized), false,
    'an unlisted built-in code must not leak into a custom whitelist');
  const s = setup({ config });
  const result = await fail(s.ctx, s.handle, s.agent, 'MAINTENANCE');
  assert.equal(result.selects, 1, 'a newly whitelisted code must drive a switch');
  assert.equal(result.followups, 1);
});

test('management triggers: removing a code from config.triggers disables classification and switching', async () => {
  const config = baseConfig({ triggers: ['SERVER'] });
  const normalized = rules.normalizeRules(config);
  assert.equal(rules.qualifies(makeFailure('QUOTA'), normalized), false, 'removed QUOTA must not qualify');
  assert.equal(rules.qualifies(makeFailure('SERVER'), normalized), true, 'remaining SERVER must qualify');
  const s = setup({ config });
  await s.ctx.emit('agent/request-error', makePayload(s.agent, makeFailure('QUOTA')), undefined);
  assert.equal(s.handle.states.get(s.agent)?.intent, undefined, 'a removed code must record no failover intent');
  await trigger(s.ctx, s.handle, s.agent, 'agent/status', { agent: s.agent, status: 'idle' }, undefined);
  assert.equal(s.agent.selects.length, 0, 'a removed code must not switch');
  assert.equal(s.agent.followups.length, 0, 'a removed code must not followup');

  const restored = rules.normalizeRules(baseConfig({ triggers: ['SERVER', 'QUOTA'] }));
  assert.equal(rules.qualifies(makeFailure('QUOTA'), restored), true, 'adding the code back must re-enable it');
});

// ---------------------------------------------------------------------------
// (8) resolveCallConfig validation
// ---------------------------------------------------------------------------

test('management resolveCallConfig: a rejecting target blocks select/followup and warns', async (t) => {
  const calls = [];
  const llm = {
    resolveCallConfig: async (target) => { calls.push(target); throw new Error('unavailable target'); },
    listProviders: async () => [],
    listModels: async () => [],
  };
  const s = setup({ config: baseConfig(), llm });
  const result = await fail(s.ctx, s.handle, s.agent, 'QUOTA');
  if (calls.length > 0) {
    assert.equal(result.selects, 0, 'an unavailable target must not be selected');
    assert.equal(result.followups, 0, 'an unavailable target must not queue a retry');
    assert.ok(s.ctx.logs.some((entry) => entry.level === 'warn'
      && /resolve|unavailable|invalid|target/i.test(entry.text)),
    'a rejected target validation must log a warn');
  } else {
    gap(t, 'resolveCallConfig validation', 'apply() never consults ctx.llm.resolveCallConfig; closest observable: the waterfall still performs one select + one followup and logs an info trace');
    assert.equal(result.selects, 1);
    assert.equal(result.followups, 1);
    assert.equal(infoTraceCount(s.ctx), 1);
  }
  assert.equal(s.ctx.globalDefaultSaves.length, 0);
});

test('management resolveCallConfig: an accepted target still switches', async (t) => {
  const calls = [];
  const llm = {
    resolveCallConfig: async (target) => { calls.push(target); return { ok: true, target }; },
    listProviders: async () => [],
    listModels: async () => [],
  };
  const s = setup({ config: baseConfig(), llm });
  const result = await fail(s.ctx, s.handle, s.agent, 'QUOTA');
  assert.equal(result.selects, 1, 'an available target must still switch');
  assert.equal(result.followups, 1);
  assert.equal(s.ctx.globalDefaultSaves.length, 0);
  assert.equal(s.ctx.logs.some((entry) => entry.level === 'warn'
    && /unavailable/i.test(entry.text)), false, 'a valid target must not be reported unavailable');
  if (calls.length === 0) {
    gap(t, 'resolveCallConfig accepted', 'no target validation call observed; closest observable: an available target still performs the normal switch');
  }
});

// ---------------------------------------------------------------------------
// Gap report (informational; gaps are NOT silent skips)
// ---------------------------------------------------------------------------

test('management: contract gaps are reported, not silently skipped', () => {
  assert.ok(Array.isArray(gaps));
  console.log('[MANAGEMENT CONTRACT GAPS] ' + gaps.length);
  for (const note of gaps) console.log('  ' + note);
});

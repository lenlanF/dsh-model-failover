// Independent verification of the frozen dsh-model-failover contract.
// Run from the repository root: node --test tests/*.test.js
// Only node:test / node:assert/strict are used; no runtime source is imported by
// the mocks, no network and no external packages are required.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMockContext,
  createMockAgent,
  createUserMessage,
  makeFailure,
  makePayload,
  DEFAULT_PRIORITY as MOCK_PRIORITY,
} from './helpers/mock-runtime.js';

const MODULES = Object.freeze({
  rules: '../lib/rules.js',
  state: '../lib/state.js',
  plugin: '../lib/index.js',
});

async function load(specifier) {
  try {
    return await import(specifier);
  } catch (cause) {
    const detail = cause && cause.message ? cause.message : String(cause);
    throw new Error('Required module ' + specifier + ' could not be imported: ' + detail);
  }
}

let rules;
let state;
let plugin;

before(async () => {
  [rules, state, plugin] = await Promise.all([
    load(MODULES.rules),
    load(MODULES.state),
    load(MODULES.plugin),
  ]);
});

// The plugin ships no built-in chain: the chain is the user's. Tests therefore
// supply their own ladder explicitly instead of relying on a product default.
const TEST_CHAIN = Object.freeze([
  { provider: 'workbuddy', model: 'hy4flash-free' },
  { provider: 'workbuddy', model: 'hy3' },
  { provider: 'workbuddy', model: 'hy4std' },
]);

function setup(options = {}) {
  const agent = options.agent ?? createMockAgent(options.agentOptions ?? {});
  const ctx = createMockContext({ agents: [agent] });
  const internals = { createUserMessage };
  const config = { priority: TEST_CHAIN.map((item) => ({ ...item })), ...(options.config ?? {}) };
  const handle = plugin.apply(ctx, config, internals);
  return { agent, ctx, handle };
}

// Drive is scheduled on a microtask by requestDrive; await its serialized run.
async function trigger(ctx, handle, agent, event, payload, terminal) {
  const result = await ctx.emit(event, payload, terminal);
  const current = handle.states.get(agent);
  if (current && current.running) await current.running;
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  return result;
}

// A followup() queues a retry turn; the host admits it through agent/pre-step,
// which consumes the one-shot reservation. Simulate that admission so a later
// terminal failure can record a fresh intent and degrade one more level.
async function admitRetryTurn(ctx, handle, agent) {
  const followup = agent.followups.at(-1);
  assert.ok(followup, 'a retry followup must have been queued');
  const admitted = await ctx.emit('agent/pre-step', {
    agent, messages: [followup], signal: { aborted: false },
  }, () => ({ kind: 'enter' }));
  assert.deepEqual(admitted.value, { kind: 'enter' });
  assert.equal(handle.states.get(agent)?.intent, undefined, 'reservation consumed on enter');
  await trigger(ctx, handle, agent, 'agent/status', { agent, status: 'idle' });
}

function retryMessage(content = []) {
  return createUserMessage({ content, source: { kind: 'retry' } });
}

function userMessage(text = 'human input') {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
}

function freshState(agent) {
  const store = state.createStateStore();
  return { store, st: store.stateFor(agent ?? { id: 'pure-agent' }) };
}

// ---------------------------------------------------------------------------
// (1) Classification
// ---------------------------------------------------------------------------

test('classification: all declared trigger codes qualify', () => {
  for (const code of [
    'QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED',
  ]) {
    assert.equal(rules.qualifies(makeFailure(code)), true, code + ' must qualify');
  }
  assert.deepEqual([...rules.DEFAULT_TRIGGERS], [
    'QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED',
  ]);
});

test('classification: HTTP_5xx codes, 5xx statuses and quota wording qualify', () => {
  assert.equal(rules.qualifies(makeFailure('HTTP_500')), true);
  assert.equal(rules.qualifies(makeFailure('HTTP_503')), true);
  assert.equal(rules.qualifies(makeFailure('UNKNOWN', { status: 502 })), true);
  assert.equal(rules.qualifies(makeFailure('SERVER', { status: 500 })), true);
  assert.equal(rules.qualifies(makeFailure('UNKNOWN', { message: 'quota exceeded' })), true,
    'quota wording on a generic failure must qualify');
  assert.equal(rules.qualifies(makeFailure('UNKNOWN', { message: 'usage limit reached' })), true,
    'usage-limit wording on a generic failure must qualify');
});

test('classification: non-retryable codes never qualify', () => {
  for (const code of ['EMPTY_RESPONSE', 'INVALID_REQUEST', 'AUTH', 'CONTEXT_WINDOW_EXCEEDED']) {
    assert.equal(rules.qualifies(makeFailure(code)), false, code + ' must NOT qualify');
  }
  assert.equal(rules.qualifies(makeFailure('HTTP_429')), false);
  assert.equal(rules.qualifies(makeFailure('UNKNOWN', { status: 400 })), false);
  assert.equal(rules.qualifies(makeFailure('AUTH', { status: 502 })), false,
    'a non-qualifying code must stay non-qualifying even with a 5xx status');
  assert.equal(rules.qualifies(null), false);
  assert.equal(rules.qualifies(undefined), false);
  assert.equal(rules.qualifies(makeFailure('QUOTA'), rules.normalizeRules({ enabled: false })), false);
});

test('classification: the plugin ships no default chain of its own', () => {
  // The chain belongs to the user. A built-in ladder would silently substitute
  // models this plugin guessed at, and a guessed model can be missing or metered.
  assert.deepEqual(rules.DEFAULT_PRIORITY.map((s) => s.provider + '/' + s.model), []);
  assert.ok(Object.isFrozen(rules.DEFAULT_PRIORITY));
  assert.deepEqual(rules.normalizeRules({}).priority, [], 'no configured chain means no failover');
});

test('classification: normalizeRules validates custom rules and drops invalid entries', () => {
  const custom = rules.normalizeRules({
    priority: ['workbuddy/hy3', { provider: ' workbuddy ', model: ' hy4std ', reasoningEffort: 'high' }, 'broken', 42],
    triggers: ['QUOTA', 'QUOTA', 'bad-code', 7],
  });
  assert.deepEqual(custom.priority, [
    { provider: 'workbuddy', model: 'hy3' },
    { provider: 'workbuddy', model: 'hy4std', reasoningEffort: 'high' },
  ]);
  assert.deepEqual([...custom.triggers], ['QUOTA']);
  assert.equal(rules.qualifies(makeFailure('SERVER'), custom), false,
    'a custom trigger list must not inherit built-in trigger codes');
  assert.equal(rules.qualifies(makeFailure('QUOTA'), custom), true);
  assert.equal(rules.normalizeRules({ priority: [] }).priority.length, 0,
    'an explicitly empty chain must stay empty rather than fall back to defaults');
});

test('classification: nextSelection walks the ladder and stops at the end', () => {
  const r = rules.normalizeRules({ priority: TEST_CHAIN.map((item) => ({ ...item })) });
  assert.deepEqual({ ...rules.nextSelection({ provider: 'workbuddy', model: 'hy4flash-free' }, r) },
    { provider: 'workbuddy', model: 'hy3' });
  assert.deepEqual({ ...rules.nextSelection({ provider: 'workbuddy', model: 'hy3' }, r) },
    { provider: 'workbuddy', model: 'hy4std' });
  assert.equal(rules.nextSelection({ provider: 'workbuddy', model: 'hy4std' }, r), undefined);
  assert.deepEqual({ ...rules.nextSelection(undefined, r) }, { provider: 'workbuddy', model: 'hy4flash-free' });
  assert.deepEqual({ ...rules.nextSelection({ provider: 'other', model: 'x' }, r) },
    { provider: 'workbuddy', model: 'hy4flash-free' });
  assert.equal(rules.sameSelection({ provider: 'a', model: 'b' }, { provider: 'a', model: 'b', extra: 1 }), true);
  assert.equal(rules.sameSelection({ provider: 'a', model: 'b' }, { provider: 'a', model: 'c' }), false);
});

test('classification: failoverSummary is bounded, prefixed and names both routes', () => {
  const summary = rules.failoverSummary(
    { provider: 'workbuddy', model: 'hy4flash-free' },
    { provider: 'workbuddy', model: 'hy3' },
    'QUOTA',
  );
  assert.match(summary, /^\[failover\] QUOTA: workbuddy\/hy4flash-free -> workbuddy\/hy3/);
  assert.ok(summary.length <= 120, 'summary length ' + summary.length + ' exceeds 120');
  const long = rules.failoverSummary(undefined, { provider: 'p'.repeat(200), model: 'm'.repeat(200) }, 'X'.repeat(200));
  assert.ok(long.length <= 120);
});

// ---------------------------------------------------------------------------
// (3) Waterfall (plugin entry)
// ---------------------------------------------------------------------------

test('plugin entry exposes the frozen host surface', () => {
  assert.equal(plugin.name, 'dsh-model-failover');
  assert.ok(Array.isArray(plugin.inject) && plugin.inject.includes('agents'), 'agents service remains injected');
  for (const service of ['settings', 'webServer']) {
    assert.ok(plugin.inject.includes(service), service + ' must be declared before the host half reads it');
  }
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(typeof plugin.qualifies, 'function');
  assert.equal(typeof plugin.nextSelection, 'function');
  assert.equal(typeof plugin.default.apply, 'function');
});

test('waterfall: {kind:retry} from the chain is passed through unchanged with NO intent', async () => {
  const { agent, ctx, handle } = setup();
  const retryAction = { kind: 'retry' };
  let downstreamCalls = 0;
  ctx.on('agent/request-error', async (_payload, _next) => {
    downstreamCalls += 1;
    return retryAction;
  });
  const payload = makePayload(agent, makeFailure('QUOTA'));
  const result = await ctx.emit('agent/request-error', payload, undefined);
  assert.equal(result.value, retryAction, 'must return the very same object');
  assert.equal(downstreamCalls, 1);
  assert.equal(handle.states.get(agent), undefined, 'no intent may be recorded');
  assert.equal(agent.selects.length, 0);
  assert.equal(agent.followups.length, 0);
});

test('waterfall: next() is always called first, even for a non-qualifying failure', async () => {
  const { agent, ctx, handle } = setup();
  let downstreamCalls = 0;
  let terminalCalls = 0;
  ctx.on('agent/request-error', async (_payload, next) => {
    downstreamCalls += 1;
    return next();
  });
  const result = await ctx.emit('agent/request-error', makePayload(agent, makeFailure('AUTH')), () => {
    terminalCalls += 1;
    return undefined;
  });
  assert.equal(downstreamCalls, 1);
  assert.equal(terminalCalls, 1);
  assert.equal(result.value, undefined);
  assert.equal(handle.states.get(agent)?.intent, undefined, 'no intent for an AUTH failure');
  assert.equal(agent.selects.length, 0);
});

test('waterfall: undefined chain + qualifying failure records intent, never switches in the listener', async () => {
  const { agent, ctx, handle } = setup();
  const payload = makePayload(agent, makeFailure('SERVER'), { turn: 4, step: 2 });
  const result = await ctx.emit('agent/request-error', payload, undefined);
  assert.equal(result.value, undefined, 'the step must be allowed to terminate');
  const st = handle.states.get(agent);
  assert.ok(st, 'an intent must be recorded');
  assert.equal(st.intent.key, '4:2');
  assert.equal(st.intent.failure.code, 'SERVER');
  assert.equal(st.intent.queuedMessageId, undefined);
  assert.equal(agent.selects.length, 0, 'no select inside the waterfall listener');
  assert.equal(agent.followups.length, 0, 'no followup inside the waterfall listener');
  assert.equal(ctx.globalDefaultSaves.length, 0);
});

test('waterfall: a non-retry chain decision still records intent and is returned unchanged', async () => {
  const { agent, ctx, handle } = setup();
  const decision = { kind: 'abort', reason: 'budget' };
  ctx.on('agent/request-error', async () => decision);
  const result = await ctx.emit('agent/request-error', makePayload(agent, makeFailure('TIMEOUT')), undefined);
  assert.equal(result.value, decision);
  assert.ok(handle.states.get(agent).intent);
});

test('waterfall: aborted signal and disabled config record no intent', async () => {
  const first = setup();
  await first.ctx.emit('agent/request-error',
    makePayload(first.agent, makeFailure('QUOTA'), { signal: { aborted: true } }), undefined);
  assert.equal(first.handle.states.get(first.agent)?.intent, undefined,
    'an aborted signal must not reserve an intent');

  const second = setup({ config: { enabled: false } });
  await second.ctx.emit('agent/request-error', makePayload(second.agent, makeFailure('QUOTA')), undefined);
  assert.equal(second.handle.states.get(second.agent)?.intent, undefined);
  assert.equal(second.agent.selects.length, 0);
});

// ---------------------------------------------------------------------------
// (2) Ordered degradation and exhaustion
// ---------------------------------------------------------------------------

test('degradation: hy4flash-free -> hy3 -> hy4std across consecutive terminal failures', async () => {
  const { agent, ctx, handle } = setup();
  const failure = makeFailure('QUOTA');

  await ctx.emit('agent/request-error', makePayload(agent, failure, { turn: 1, step: 1 }), undefined);
  await trigger(ctx, handle, agent, 'agent/status', { agent, status: 'idle' });
  assert.deepEqual(agent.selects[0], { provider: 'workbuddy', model: 'hy3' });
  await admitRetryTurn(ctx, handle, agent);

  await ctx.emit('agent/request-error', makePayload(agent, failure, {
    turn: agent.inbox.nextTurn(), step: agent.inbox.nextStep(),
  }), undefined);
  await trigger(ctx, handle, agent, 'agent/error', { agent });
  assert.deepEqual(agent.selects[1], { provider: 'workbuddy', model: 'hy4std' });

  assert.equal(agent.selects.length, 2);
  assert.equal(agent.followups.length, 2);
  // The host appends its own durable model-switch notice at the next pre-step;
  // the plugin must not append a duplicate session event. Its trace is a log line.
  assert.equal(agent.notices.length, 0);
  assert.ok(ctx.logs.some((entry) => entry.level === 'info' && entry.text.includes('[failover] QUOTA: workbuddy/hy4flash-free -> workbuddy/hy3')),
    'a bounded [failover] log line records the switch');
  for (const message of agent.followups) {
    assert.deepEqual(message.content, [], 'empty retry content is deliberate');
    assert.equal(message.source.kind, 'retry');
  }
  assert.deepEqual(agent.model.current(), { provider: 'workbuddy', model: 'hy4std' });
  assert.equal(ctx.globalDefaultSaves.length, 0);
});

test('degradation: exhaustion logs and stops with no further select/followup', async () => {
  const { agent, ctx, handle } = setup();
  const failure = makeFailure('RATE_LIMIT');
  for (let i = 1; i <= 3; i += 1) {
    await ctx.emit('agent/request-error', makePayload(agent, failure, {
      turn: agent.inbox.nextTurn(), step: agent.inbox.nextStep(),
    }), undefined);
    await trigger(ctx, handle, agent, 'agent/status', { agent, status: 'idle' });
    if (handle.states.get(agent)?.intent?.queuedMessageId !== undefined) {
      await admitRetryTurn(ctx, handle, agent);
    }
  }
  assert.equal(agent.selects.length, 2);
  assert.equal(agent.followups.length, 2);
  assert.deepEqual(agent.model.current(), { provider: 'workbuddy', model: 'hy4std' });
  assert.ok(ctx.logs.some((entry) => entry.level === 'warn' && /exhausted/.test(entry.text)),
    'exhaustion must be logged');
  assert.equal(handle.states.get(agent).intent, undefined);
  assert.equal(ctx.globalDefaultSaves.length, 0);
});

test('degradation: the selected model stays until a manual change (no auto rollback)', async () => {
  const { agent, ctx, handle } = setup();
  await ctx.emit('agent/request-error', makePayload(agent, makeFailure('QUOTA')), undefined);
  await trigger(ctx, handle, agent, 'agent/status', { agent, status: 'idle' });
  assert.equal(agent.model.current().model, 'hy3');

  await trigger(ctx, handle, agent, 'agent/status', { agent, status: 'idle' });
  assert.equal(agent.model.current().model, 'hy3', 'idle alone must not roll back or re-switch');

  agent.model.select({ provider: 'workbuddy', model: 'hy4flash-free' });
  await trigger(ctx, handle, agent, 'agent/status', { agent, status: 'idle' });
  assert.equal(agent.model.current().model, 'hy4flash-free', 'manual selection must be respected');
  assert.equal(ctx.globalDefaultSaves.length, 0);
});

test('degradation: a running agent is not switched; a later idle trigger drives it', async () => {
  const { agent, ctx, handle } = setup();
  agent.status = 'running';
  await ctx.emit('agent/request-error', makePayload(agent, makeFailure('QUOTA')), undefined);
  await trigger(ctx, handle, agent, 'agent/status', { agent, status: 'idle' });
  assert.equal(agent.selects.length, 0);
  assert.ok(handle.states.get(agent).intent, 'intent survives a busy agent');

  agent.status = 'idle';
  await trigger(ctx, handle, agent, 'agent/status', { agent, status: 'idle' });
  assert.equal(agent.selects.length, 1);
  assert.equal(agent.followups.length, 1);
});

test('degradation: a custom priority config drives the same waterfall', async () => {
  const config = { priority: ['workbuddy/hy4std', { provider: 'workbuddy', model: 'custom-x' }] };
  const { agent, ctx, handle } = setup({ agentOptions: { selection: { provider: 'workbuddy', model: 'hy4std' } }, config });
  await ctx.emit('agent/request-error', makePayload(agent, makeFailure('QUOTA')), undefined);
  await trigger(ctx, handle, agent, 'agent/status', { agent, status: 'idle' });
  assert.deepEqual(agent.selects[0], { provider: 'workbuddy', model: 'custom-x' });
  assert.equal(ctx.globalDefaultSaves.length, 0);
});

// ---------------------------------------------------------------------------
// (4) Idempotence
// ---------------------------------------------------------------------------

test('idempotence: duplicate errors for the same (agent,turn,step) cause one select + one followup', async () => {
  const { agent, ctx, handle } = setup();
  const payload = makePayload(agent, makeFailure('QUOTA'), { turn: 7, step: 3 });
  await ctx.emit('agent/request-error', payload, undefined);
  await ctx.emit('agent/request-error', { ...payload }, undefined);
  await ctx.emit('agent/request-error', { ...payload }, undefined);
  const st = handle.states.get(agent);
  assert.equal(st.intent.key, '7:3');
  assert.equal(st.switches, 0);
  await trigger(ctx, handle, agent, 'agent/status', { agent, status: 'idle' });
  assert.equal(agent.selects.length, 1);
  assert.equal(agent.followups.length, 1);
});

test('idempotence: recordIntent refuses a duplicate key and clearIntent releases it', () => {
  const { st } = freshState();
  const payload = makePayload(createMockAgent({ id: 'pure-agent' }), makeFailure('QUOTA'), { turn: 2, step: 5 });
  assert.equal(state.recordIntent(st, payload, payload.failure), true);
  assert.equal(state.recordIntent(st, payload, payload.failure), false);
  assert.equal(st.intent.key, '2:5');
  assert.equal(state.recordIntent(st, { ...payload, signal: { aborted: true } }, payload.failure), false);
  state.clearIntent(st);
  assert.equal(st.intent, undefined);
  assert.equal(state.recordIntent(st, { ...payload, step: 6 }, payload.failure), true);
});

test('idempotence: duplicate idle triggers are coalesced onto one serialized drive', async () => {
  const { agent, ctx, handle } = setup();
  await ctx.emit('agent/request-error', makePayload(agent, makeFailure('QUOTA')), undefined);
  await trigger(ctx, handle, agent, 'agent/status', { agent, status: 'idle' });
  await trigger(ctx, handle, agent, 'agent/status', { agent, status: 'idle' });
  assert.equal(agent.selects.length, 1);
  assert.equal(agent.followups.length, 1);
});

test('idempotence: requestDrive ignores concurrent requests while a run is active', async () => {
  const { st } = freshState();
  let calls = 0;
  state.requestDrive(st, () => { calls += 1; });
  state.requestDrive(st, () => { calls += 1; });
  state.requestDrive(st, () => { calls += 1; });
  await st.running;
  assert.equal(calls, 1);
  assert.equal(st.running, undefined);
  state.requestDrive(st, () => { calls += 1; });
  await st.running;
  assert.equal(calls, 2);
});

// ---------------------------------------------------------------------------
// (5) Competing queued user input
// ---------------------------------------------------------------------------

test('competing input: agent/inbox/inserted with a user source cancels the intent', async () => {
  const { agent, ctx, handle } = setup();
  await ctx.emit('agent/request-error', makePayload(agent, makeFailure('QUOTA')), undefined);
  assert.ok(handle.states.get(agent).intent);
  const inserted = await ctx.emit('agent/inbox/inserted', { agent, message: userMessage('please stop') }, undefined);
  assert.equal(inserted.value, undefined);
  assert.equal(handle.states.get(agent).intent, undefined);
  assert.ok(ctx.logs.some((entry) => /competing input won/.test(entry.text)));
  await trigger(ctx, handle, agent, 'agent/status', { agent, status: 'idle' });
  assert.equal(agent.selects.length, 0);
  assert.equal(agent.followups.length, 0);
});

test('competing input: a retry-source message does not cancel; a user message does', () => {
  const { st } = freshState();
  const payload = makePayload(createMockAgent({ id: 'pure-agent' }), makeFailure('QUOTA'));
  state.recordIntent(st, payload, payload.failure);
  assert.equal(state.noteIncoming(st, retryMessage()), false);
  assert.ok(st.intent, 'our own retry turn must not cancel the intent');
  assert.equal(state.noteIncoming(st, { source: undefined }), true);
  assert.equal(st.intent, undefined);
  assert.equal(state.noteIncoming(st, userMessage()), false, 'no intent means nothing to cancel');
});

test('competing input: plugin ignores inbox insertions for an agent with no state', async () => {
  const { agent, ctx, handle } = setup();
  await ctx.emit('agent/inbox/inserted', { agent, message: userMessage() }, undefined);
  assert.equal(handle.states.size(), 0);
  assert.equal(agent.selects.length, 0);
});

// ---------------------------------------------------------------------------
// (6) Pre-step stale-message guard
// ---------------------------------------------------------------------------

test('pre-step: a stale retry message with no state is rejected without a reservation', async () => {
  const { agent, ctx, handle } = setup();
  const result = await ctx.emit('agent/pre-step', {
    agent, messages: [retryMessage()], signal: { aborted: false },
  }, () => ({ kind: 'enter' }));
  assert.deepEqual(result.value, { kind: 'reject' });
  assert.equal(result.calls.includes('terminal'), false, 'next() must not be called for a stale message');
  assert.equal(handle.states.get(agent), undefined, 'no reservation may be created');
  assert.equal(agent.selects.length, 0);
});

test('pre-step: an intent without a queuedMessageId is not a valid reservation', async () => {
  const { agent, ctx, handle } = setup();
  const payload = makePayload(agent, makeFailure('QUOTA'));
  const st = handle.states.stateFor(agent);
  assert.equal(state.recordIntent(st, payload, payload.failure), true);
  assert.equal(st.intent.queuedMessageId, undefined);
  const result = await ctx.emit('agent/pre-step', {
    agent, messages: [retryMessage()], signal: { aborted: false },
  }, () => ({ kind: 'enter' }));
  assert.deepEqual(result.value, { kind: 'reject' });
  assert.equal(result.calls.includes('terminal'), false);
  assert.equal(handle.states.get(agent).intent.queuedMessageId, undefined);
});

test('pre-step: a valid reservation delegates and is cleared on enter', async () => {
  const { agent, ctx, handle } = setup();
  const payload = makePayload(agent, makeFailure('QUOTA'));
  const st = handle.states.stateFor(agent);
  state.recordIntent(st, payload, payload.failure);
  const queued = retryMessage();
  st.intent = { ...st.intent, queuedMessageId: queued.id, phase: 'queued' };
  const result = await ctx.emit('agent/pre-step', {
    agent, messages: [queued], signal: { aborted: false },
  }, () => ({ kind: 'enter' }));
  assert.deepEqual(result.value, { kind: 'enter' });
  assert.equal(result.calls.includes('terminal'), true);
  assert.equal(st.intent, undefined, 'the one-shot reservation is consumed');
});

test('pre-step: non-retry messages and non-empty retry content pass through the chain', async () => {
  const { agent, ctx } = setup();
  const cases = [
    [userMessage()],
    [createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'retry' } })],
    [],
  ];
  for (const messages of cases) {
    const result = await ctx.emit('agent/pre-step', { agent, messages, signal: { aborted: false } },
      () => ({ kind: 'enter' }));
    assert.deepEqual(result.value, { kind: 'enter' });
    assert.equal(result.calls.includes('terminal'), true);
  }
});

// ---------------------------------------------------------------------------
// (7) Cleanup on agent/disposed and unload
// ---------------------------------------------------------------------------

test('cleanup: agent/disposed removes the per-agent state', async () => {
  const { agent, ctx, handle } = setup();
  await ctx.emit('agent/request-error', makePayload(agent, makeFailure('QUOTA')), undefined);
  assert.equal(handle.states.size(), 1);
  await ctx.emit('agent/disposed', { agent }, undefined);
  assert.equal(handle.states.get(agent), undefined);
  assert.equal(handle.states.size(), 0);
  assert.equal(agent.selects.length, 0);
  assert.equal(agent.followups.length, 0);
});

test('cleanup: effect unload clears state, removes listeners and prevents further switching', async () => {
  const { agent, ctx, handle } = setup();
  await ctx.emit('agent/request-error', makePayload(agent, makeFailure('QUOTA')), undefined);
  assert.ok(handle.states.get(agent).intent);
  assert.equal(ctx.effects.length, 1);
  assert.ok(ctx.listenerCount('agent/request-error') >= 1);

  await ctx.runCleanups();
  assert.equal(handle.states.size(), 0);
  assert.equal(ctx.listenerCount('agent/request-error'), 0);
  assert.equal(ctx.listenerCount('agent/pre-step'), 0);

  await trigger(ctx, handle, agent, 'agent/request-error', makePayload(agent, makeFailure('QUOTA')), undefined);
  await trigger(ctx, handle, agent, 'agent/status', { agent, status: 'idle' });
  assert.equal(handle.states.size(), 0);
  assert.equal(agent.selects.length, 0);
  assert.equal(agent.followups.length, 0);
});

test('cleanup: stateFor/get/delete/clear of the pure state store are consistent', () => {
  const store = state.createStateStore();
  const a = { id: 'a' };
  const b = { id: 'b' };
  assert.equal(store.get(a), undefined);
  assert.equal(store.stateFor(a), store.stateFor(a));
  store.stateFor(b);
  assert.equal(store.size(), 2);
  assert.equal([...store.values()].length, 2);
  store.delete(a);
  assert.equal(store.get(a), undefined);
  store.clear();
  assert.equal(store.size(), 0);
});

// ---------------------------------------------------------------------------
// (8) The global default model is never touched
// ---------------------------------------------------------------------------

test('global default: full degradation, retry passthrough and exhaustion never call saveSelection', async () => {
  const { agent, ctx, handle } = setup();
  const retryAction = { kind: 'retry' };
  ctx.on('agent/request-error', async () => retryAction);
  await ctx.emit('agent/request-error', makePayload(agent, makeFailure('QUOTA'), { turn: 90, step: 1 }), undefined);
  assert.equal(ctx.globalDefaultSaves.length, 0);

  const solo = setup();
  for (let i = 1; i <= 3; i += 1) {
    await solo.ctx.emit('agent/request-error', makePayload(solo.agent, makeFailure('QUOTA'),
      { turn: solo.agent.inbox.nextTurn(), step: solo.agent.inbox.nextStep() }), undefined);
    await trigger(solo.ctx, solo.handle, solo.agent, 'agent/status', { agent: solo.agent, status: 'idle' });
    if (solo.handle.states.get(solo.agent)?.intent?.queuedMessageId !== undefined) {
      await admitRetryTurn(solo.ctx, solo.handle, solo.agent);
    }
  }
  assert.equal(solo.ctx.globalDefaultSaves.length, 0);
  assert.equal(solo.agent.selects.length, 2);
  assert.equal(ctx.globalDefaultSaves.length, 0);
});

test('global default: cancellation and cleanup paths also leave it untouched', async () => {
  const { agent, ctx, handle } = setup();
  await ctx.emit('agent/request-error', makePayload(agent, makeFailure('QUOTA')), undefined);
  await ctx.emit('agent/inbox/inserted', { agent, message: userMessage() }, undefined);
  await ctx.runCleanups();
  assert.equal(ctx.globalDefaultSaves.length, 0);
  assert.equal(handle.states.size(), 0);
});

// Verification for the two per-session modes added on top of the frozen contract:
//   - 'pinned': only chain tiers may be used; the session is forced to the head.
//   - 'free':   only tiers explicitly marked free may be used; when none remain
//               the session stops instead of degrading onto a metered model.
// Run from the repository root: node --test tests/*.test.js

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMockContext,
  createMockAgent,
  createUserMessage,
  makeFailure,
  makePayload,
} from './helpers/mock-runtime.js';

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
  [rules, plugin] = await Promise.all([load('../lib/rules.js'), load('../lib/index.js')]);
});

const MIXED = Object.freeze([
  { provider: 'p', model: 'free-a', free: true },
  { provider: 'p', model: 'paid-b' },
  { provider: 'p', model: 'free-c', free: true },
]);

function setup(config = {}, agentOptions = {}) {
  const agent = createMockAgent(agentOptions);
  const ctx = createMockContext({ agents: [agent] });
  const handle = plugin.apply(ctx, config, { createUserMessage });
  return { agent, ctx, handle };
}

async function preStep(ctx, agent) {
  return ctx.emit('agent/pre-step', { agent, messages: [], signal: { aborted: false } }, () => ({ kind: 'enter' }));
}

// ---------------------------------------------------------------------------
// Free-tier marking
// ---------------------------------------------------------------------------

test('free tiers: only an explicit mark counts, and it survives normalization', () => {
  const normalized = rules.normalizeRules({ priority: MIXED });
  assert.deepEqual(normalized.priority.map((x) => x.model), ['free-a', 'paid-b', 'free-c']);
  assert.equal(normalized.priority[0].free, true);
  assert.equal(normalized.priority[1].free, undefined, 'an unmarked tier is not free');
  assert.equal(normalized.priority[2].free, true);
});

test('free tiers: the same route can appear marked and unmarked without collapsing', () => {
  const normalized = rules.normalizeRules({ priority: [
    { provider: 'p', model: 'm', free: true },
    { provider: 'p', model: 'm' },
  ] });
  assert.equal(normalized.priority.length, 2, 'free and paid entries are distinct tiers');
});

test('free tiers: chainForMode keeps only free tiers in free mode', () => {
  const normalized = rules.normalizeRules({ priority: MIXED });
  assert.deepEqual(rules.chainForMode(normalized, 'free').map((x) => x.model), ['free-a', 'free-c']);
  assert.equal(rules.chainForMode(normalized, 'off').length, 3);
  assert.equal(rules.chainForMode(normalized, 'pinned').length, 3);
});

test('free tiers: an unknown mode degrades to off rather than guessing', () => {
  assert.equal(rules.normalizeMode('free'), 'free');
  assert.equal(rules.normalizeMode('pinned'), 'pinned');
  assert.equal(rules.normalizeMode('off'), 'off');
  assert.equal(rules.normalizeMode('nonsense'), 'off');
  assert.equal(rules.normalizeMode(undefined), 'off');
});

// ---------------------------------------------------------------------------
// Free mode: degrade across free tiers only, then stop
// ---------------------------------------------------------------------------

test('free mode: failover skips metered tiers', () => {
  const normalized = rules.normalizeRules({ priority: MIXED });
  const next = rules.nextSelectionForMode({ provider: 'p', model: 'free-a' }, normalized, 'free');
  assert.deepEqual({ provider: next.provider, model: next.model }, { provider: 'p', model: 'free-c' },
    'free-a must skip paid-b and land on free-c');
});

test('free mode: the last free tier yields no target, which means stop', () => {
  const normalized = rules.normalizeRules({ priority: MIXED });
  assert.equal(rules.nextSelectionForMode({ provider: 'p', model: 'free-c' }, normalized, 'free'), undefined);
});

test('free mode: a chain with no marked tier yields no target at all', () => {
  const normalized = rules.normalizeRules({ priority: [{ provider: 'p', model: 'paid' }] });
  assert.equal(rules.chainForMode(normalized, 'free').length, 0);
  assert.equal(rules.nextSelectionForMode({ provider: 'p', model: 'paid' }, normalized, 'free'), undefined);
});

test('free mode: allowsSelection refuses metered and unknown routes', () => {
  const normalized = rules.normalizeRules({ priority: MIXED });
  assert.equal(rules.allowsSelection({ provider: 'p', model: 'free-a' }, normalized, 'free'), true);
  assert.equal(rules.allowsSelection({ provider: 'p', model: 'paid-b' }, normalized, 'free'), false);
  assert.equal(rules.allowsSelection({ provider: 'x', model: 'anything' }, normalized, 'free'), false);
  assert.equal(rules.allowsSelection(undefined, normalized, 'free'), false);
});

test('free mode: a pre-step with no marked free tier is rejected instead of running', async () => {
  const { agent, ctx } = setup({
    mode: 'free',
    priority: [{ provider: 'p', model: 'paid-only' }],
  }, { selection: { provider: 'p', model: 'paid-only' } });
  const result = await preStep(ctx, agent);
  assert.deepEqual(result.value, { kind: 'reject' });
});

test('free mode: a pre-step corrects a metered current model onto a free tier', async () => {
  const { agent, ctx } = setup({
    mode: 'free',
    priority: MIXED,
  }, { selection: { provider: 'p', model: 'paid-b' } });
  const result = await preStep(ctx, agent);
  assert.deepEqual(result.value, { kind: 'enter' });
  assert.deepEqual(agent.selects.at(-1), { provider: 'p', model: 'free-a' },
    'the metered route must be corrected to the first free tier');
});

// ---------------------------------------------------------------------------
// Pinned mode
// ---------------------------------------------------------------------------

test('pinned mode: the session is forced to the chain head', () => {
  const normalized = rules.normalizeRules({ priority: MIXED });
  assert.deepEqual(rules.pinnedSelection(normalized).model, 'free-a');
  // normalizeRules falls back to DEFAULT_PRIORITY for an empty chain, so an
  // empty normalized chain cannot occur; the raw guard still reports undefined.
  assert.equal(rules.pinnedSelection({ priority: [] }), undefined);
});

test('pinned mode: allowsSelection accepts chain tiers and refuses outsiders', () => {
  const normalized = rules.normalizeRules({ priority: MIXED });
  assert.equal(rules.allowsSelection({ provider: 'p', model: 'paid-b' }, normalized, 'pinned'), true);
  assert.equal(rules.allowsSelection({ provider: 'q', model: 'outside' }, normalized, 'pinned'), false);
});

test('pinned mode: a pre-step pulls an outside model back into the chain', async () => {
  const { agent, ctx } = setup({
    mode: 'pinned',
    priority: MIXED,
  }, { selection: { provider: 'q', model: 'outside' } });
  await preStep(ctx, agent);
  assert.deepEqual(agent.selects.at(-1), { provider: 'p', model: 'free-a' });
});

test('pinned mode: an in-chain model is left untouched', async () => {
  const { agent, ctx } = setup({
    mode: 'pinned',
    priority: MIXED,
  }, { selection: { provider: 'p', model: 'paid-b' } });
  await preStep(ctx, agent);
  assert.equal(agent.selects.length, 0, 'an allowed route must not be rewritten');
});

// ---------------------------------------------------------------------------
// Off mode is unchanged
// ---------------------------------------------------------------------------

test('off mode: pre-step never rewrites the selection', async () => {
  const { agent, ctx } = setup({ priority: MIXED }, { selection: { provider: 'q', model: 'outside' } });
  await preStep(ctx, agent);
  assert.equal(agent.selects.length, 0);
  assert.equal(rules.allowsSelection({ provider: 'q', model: 'outside' }, rules.normalizeRules({}), 'off'), true);
});

test('off mode: failover still walks the whole chain', () => {
  const normalized = rules.normalizeRules({ priority: MIXED });
  const next = rules.nextSelectionForMode({ provider: 'p', model: 'free-a' }, normalized, 'off');
  assert.deepEqual(next.model, 'paid-b', 'off mode must not skip metered tiers');
});

// ---------------------------------------------------------------------------
// Mode is observable and switchable at runtime
// ---------------------------------------------------------------------------

test('mode: the handle reports and updates the active mode', () => {
  const { handle } = setup({ mode: 'free', priority: MIXED });
  assert.equal(handle.mode, 'free');
  assert.equal(handle.setMode('pinned'), 'pinned');
  assert.equal(handle.mode, 'pinned');
  assert.equal(handle.getRules().mode, 'pinned');
});

test('mode: switching away from free clears the exhausted flag', () => {
  const { agent, ctx, handle } = setup({ mode: 'free', priority: [{ provider: 'p', model: 'paid' }] },
    { selection: { provider: 'p', model: 'paid' } });
  return preStep(ctx, agent).then(() => {
    assert.equal(handle.exhausted, true, 'a rejected free step marks exhaustion');
    handle.setMode('off');
    assert.equal(handle.exhausted, false, 'leaving free mode clears exhaustion');
  });
});

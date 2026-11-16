// Exhaustion memory and unusable-route handling.
//
// A quota failure says nothing about when the quota recovers, so the plugin
// remembers when a route last reported exhaustion and skips it until the
// cooldown lapses. A route that cannot even be resolved is skipped the same way
// instead of aborting the whole failover.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRules, nextUsableSelection, firstUsableSelection,
  normalizeExhausted, isExhausted, markExhausted, routeKey, DEFAULT_COOLDOWN_MS,
} from '../lib/rules.js';

const CHAIN = Object.freeze([
  { provider: 'p', model: 'a' },
  { provider: 'p', model: 'b' },
  { provider: 'p', model: 'c' },
]);

const rules = () => normalizeRules({ priority: CHAIN });
const HOUR = 60 * 60 * 1000;

test('the plugin supplies no chain, so no guessed model can be used', () => {
  // A hardcoded ladder once named a model the provider never declared
  // (hy4free), which made every switch fail context compaction. The chain is
  // now entirely the user's: with nothing configured there is nothing to switch to.
  const defaults = normalizeRules({}).priority;
  assert.deepEqual(defaults, []);
  assert.equal(nextUsableSelection({ provider: 'p', model: 'a' }, normalizeRules({}), { exhausted: {}, now: Date.now() }), undefined);
});

test('a spent route is skipped for the next usable tier', () => {
  const now = Date.now();
  const exhausted = markExhausted({}, { provider: 'p', model: 'b' }, now);
  const next = nextUsableSelection({ provider: 'p', model: 'a' }, rules(), { exhausted, now });
  assert.deepEqual(next, { provider: 'p', model: 'c' }, 'b is spent, so c is next');
});

test('an exhausted route is retried once its cooldown lapses', () => {
  const then = Date.now() - DEFAULT_COOLDOWN_MS - HOUR;
  const exhausted = markExhausted({}, { provider: 'p', model: 'b' }, then);
  const now = Date.now();
  assert.equal(isExhausted(exhausted, { provider: 'p', model: 'b' }, now), false);
  const next = nextUsableSelection({ provider: 'p', model: 'a' }, rules(), { exhausted, now });
  assert.deepEqual(next, { provider: 'p', model: 'b' }, 'an expired entry must not block');
});

test('the chain does not restart from its head while every route is spent', () => {
  const now = Date.now();
  let exhausted = {};
  for (const entry of CHAIN) exhausted = markExhausted(exhausted, entry, now);
  assert.equal(nextUsableSelection({ provider: 'p', model: 'c' }, rules(), { exhausted, now }), undefined,
    'nothing usable remains, so there is no target rather than a restart');
  assert.equal(firstUsableSelection(rules(), { exhausted, now }), undefined);
});

test('firstUsableSelection returns the head when nothing is spent', () => {
  assert.deepEqual(firstUsableSelection(rules(), { exhausted: {}, now: Date.now() }), { provider: 'p', model: 'a' });
});

test('a zero cooldown keeps a route spent until it is cleared', () => {
  const exhausted = markExhausted({}, { provider: 'p', model: 'a' }, Date.now());
  assert.equal(isExhausted(exhausted, { provider: 'p', model: 'a' }, Date.now(), 0), true);
});

test('normalization drops expired and malformed entries', () => {
  const now = Date.now();
  const table = normalizeExhausted({
    'p/a': now,
    'p/old': now - DEFAULT_COOLDOWN_MS - HOUR,
    'no-slash': now,
    'p/bad': 'not-a-number',
  }, now);
  assert.deepEqual(Object.keys(table), ['p/a']);
});

test('marking the same route twice keeps the latest timestamp', () => {
  const first = markExhausted({}, { provider: 'p', model: 'a' }, 1000);
  const second = markExhausted(first, { provider: 'p', model: 'a' }, 2000);
  assert.equal(second['p/a'], 2000);
  assert.equal(Object.keys(second).length, 1);
});

test('routeKey is stable and empty for a missing route', () => {
  assert.equal(routeKey({ provider: 'p', model: 'a' }), 'p/a');
  assert.equal(routeKey(undefined), '');
  assert.equal(routeKey(null), '');
});

test('free mode intersects exhaustion with the free tiers', () => {
  const free = normalizeRules({ priority: [
    { provider: 'p', model: 'a', free: true },
    { provider: 'p', model: 'b' },
    { provider: 'p', model: 'c', free: true },
  ] });
  const now = Date.now();
  const exhausted = markExhausted({}, { provider: 'p', model: 'a' }, now);
  const next = nextUsableSelection({ provider: 'p', model: 'a' }, free, { exhausted, now, mode: 'free' });
  assert.deepEqual(next, { provider: 'p', model: 'c', free: true },
    'a is spent, b is metered, so c is the only usable free tier');
});

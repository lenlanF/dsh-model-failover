// The saved chain must survive a restart.
//
// apply() receives whatever the loader passes, which omits an id-targeted
// override from cordis.patch.yml. The plugin therefore reads the persisted
// config itself; these tests pin that behaviour, because losing it silently
// reinstates defaults and ignores the chain the user saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';

const SAVED_CHAIN = Object.freeze([
  { provider: 'workbuddy', model: 'hy4flash-free' },
  { provider: 'workbuddy-global', model: 'hy4flash-free' },
  { provider: 'zcode-start-plan', model: 'GLM-5.3' },
]);

function contextWith(settingsValue) {
  const rows = settingsValue === undefined ? [] : [{ ns: 'dsh-model-failover', value: settingsValue }];
  return {
    on: () => () => {},
    effect: (fn) => { try { fn(); } catch { /* optional */ } },
    inject: () => {},
    fiber: { entry: { options: { id: 'dsh-model-failover' } } },
    get: (name) => (name === 'settings'
      ? { describe: () => rows, mutate: async () => {}, configure: () => {} }
      : undefined),
  };
}

test('the saved chain is adopted even when the loader passes no config', () => {
  const handle = apply(contextWith({ priority: SAVED_CHAIN, enabled: true }), {});
  assert.deepEqual(handle.rules.priority.map((x) => x.provider + '/' + x.model), [
    'workbuddy/hy4flash-free', 'workbuddy-global/hy4flash-free', 'zcode-start-plan/GLM-5.3',
  ], 'a restart must keep the chain the user saved');
});

test('a saved chain survives even when the loader passes an empty object', () => {
  const handle = apply(contextWith({ priority: SAVED_CHAIN }), { priority: [] });
  assert.equal(handle.rules.priority.length, 3, 'an empty loader argument must not erase the saved chain');
});

test('a loader-supplied chain still wins over the persisted one', () => {
  const explicit = [{ provider: 'p', model: 'explicit' }];
  const handle = apply(contextWith({ priority: SAVED_CHAIN }), { priority: explicit });
  assert.deepEqual(handle.rules.priority.map((x) => x.model), ['explicit'],
    'an explicitly passed chain is authoritative');
});

test('with nothing persisted and nothing passed there is no chain at all', () => {
  const handle = apply(contextWith(undefined), {});
  assert.deepEqual(handle.rules.priority, [], 'no chain must not mean a guessed chain');
});

test('a persisted chain with every entry invalid normalizes to empty, not to defaults', () => {
  const handle = apply(contextWith({ priority: ['broken', 42, { provider: '', model: '' }] }), {});
  assert.deepEqual(handle.rules.priority, []);
});

test('settings that cannot be read leave the passed config intact', () => {
  const ctx = {
    on: () => () => {},
    effect: (fn) => { try { fn(); } catch { /* optional */ } },
    inject: () => {},
    fiber: { entry: { options: { id: 'dsh-model-failover' } } },
    get: (name) => (name === 'settings' ? { describe: () => { throw new Error('unavailable'); } } : undefined),
  };
  const handle = apply(ctx, { priority: [{ provider: 'p', model: 'kept' }] });
  assert.deepEqual(handle.rules.priority.map((x) => x.model), ['kept']);
});

# dsh-model-failover contract tests

Independent, dependency-free verification of the frozen failover contract against
a mock Cordis/Agent runtime. No DSH runtime source is imported by the mocks, no
network access, and no profile under `<dsh-home>` is touched.

## Files

- `failover.test.js` — `node:test` + `node:assert/strict` only. Dynamically
  imports `../lib/rules.js`, `../lib/state.js` and `../lib/index.js`, so a
  missing module fails the individual test with a clear message instead of
  aborting suite startup. The original 34 tests are unchanged.
- `management.test.js` — the NEW product features, 19 additional tests in 8
  groups. Dynamically imports `../lib/rules.js` and `../lib/index.js`; uses
  the same mock context/agent doubles. Optional new mock surfaces (`ctx.llm`,
  `ctx.now`, `ctx.get`) are opt-in, so the original 34 tests see the same
  context as before.
- `helpers/mock-runtime.js` — waterfall emitters (`on`, `effect`, `logger`,
  `agents.get`), a mock agent (`model.current/select`, `session.append`,
  `followup`, `inbox.nextTurn/nextStep`, `status`, `whenIdle`, `id`) and the
  payload/message factories.
- This README.

`ctx.agentDefaultModel.saveSelection` is a spy that both records and throws;
every scenario group asserts it was never called (the global default must stay
untouched).

## Run

From the repository root (`<repository-root>`) in bash / MSYS2:

```bash
NODE='/d/Program/Program Files/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe'
[ -x "$NODE" ] || NODE=node
"$NODE" --test tests/*.test.js
```

Plain `node` (v24+) also works when the bundled binary is unavailable:

```bash
node --test tests/*.test.js
```

PowerShell:

```powershell
$node = 'D:ProgramProgram FilesDeepSeek Harnessesourcesuntimeprimary-runtimedependencies
odein
ode.exe'
if (-not (Test-Path $node)) { $node = 'node' }
& $node --test (Get-ChildItem tests\*.test.js | ForEach-Object FullName)
```

No `node_modules`, install step, environment variables or `NODE_OPTIONS` are
required: the repository's `package.json` declares `"type": "module"` (and Node
v24 auto-detects ESM even without it), the plugin's optional
`@deepseek-ai/schemastery` import is guarded by `try/catch`, and the message
factory is injected through `apply(ctx, config, internals)`. The plugin now
builds a real Schemastery `Config` (`lib/index.js`); a guarded fallback shell
is used only when the schema package is unavailable in the test environment.
On Node < 22 a `NODE_OPTIONS=--experimental-detect-module` preload may be
needed if the `package.json` is absent.

## What is covered

1. Classification — `QUOTA`, `ACCOUNT_QUOTA`, `RATE_LIMIT`, `SERVER`,
   `TIMEOUT`, `TRANSPORT`, `STREAM_CLOSED`, `HTTP_500` / `HTTP_5xx` and
   5xx statuses qualify; `EMPTY_RESPONSE`, `INVALID_REQUEST`, `AUTH`,
   `CONTEXT_WINDOW_EXCEEDED` and 4xx do not. Also rule normalization, the
   frozen default priority, `nextSelection` and the <=120-char failover log summary.
2. Ordered degradation — `workbuddy/hy4free` -> `workbuddy/hy3` ->
   `workbuddy/hy4std`; exhaustion stops with no further `select` /
   `followup`; the new model stays until a manual change.
3. Waterfall semantics — `next()` is always called first; `{kind:'retry'}`
   is passed through unchanged with no intent; an `undefined` chain result on a
   qualifying failure records an intent and never switches inside the listener.
4. Idempotence — duplicate errors for one `(agent, turn, step)`, and duplicate
   idle triggers, produce exactly one `select` + one `followup`.
5. Competing queued user input — `agent/inbox/inserted` with a non-retry source
   cancels the intent; a `retry`-source message does not.
6. Pre-step guard — a stale empty retry message with no valid reservation is
   rejected without calling `next()` and without creating state; a valid
   reservation delegates and is consumed on `enter`.
7. Cleanup — `agent/disposed` and the `effect` unload remove per-agent state
   and listeners, and no switch occurs afterwards.
8. Global default — `saveSelection` is never called on any path.

9. Management features (`management.test.js`) — `normalizeRules` cap/cooldown
   defaults and clamping, multi-provider priority order and duplicate handling,
   `canSwitch` budget/cooldown, per-session cap + exhaustion logging,
   `cooldownMs` suppression and elapsed-clock switch, cross-provider
   `workbuddy -> deepseek-official` selection with both providers in the summary
   and log, bounded `switchLog` records and overflow trimming, manual restore
   to the first priority entry, config trigger-whitelist add/remove, and
   `ctx.llm.resolveCallConfig` rejection handling.

The final line of the `node --test` output reports `pass` / `fail` counts.
Any failure is a real contract violation (or a missing `lib/` module); this
suite does not skip or stub out assertions.


## Contract gaps / pending lead implementation

These are asserted as **closest observable behavior** today (each emits a
`[CONTRACT GAP]` TAP diagnostic, never a silent skip). They are the cases that
still await a lead-side implementation decision; tighten the assertions once
the behavior lands:

1. `switchLog` accumulation — `apply()` leaves in-memory `rules.switchLog`
   empty after switches and each switch persists a fresh single-record window
   via `settings.mutate` instead of accumulating one bounded history across
   the session. `appendSwitchLog()` and `normalizeRules()` themselves do keep
   bounded `from/to/code/at` records.
2. `normalizeRules({ switchLog, switchLogLimit })` caps an oversized configured
   history at a fixed 20 instead of honoring `switchLogLimit` (3 in the test).
3. Switch-cap hold wording — the hold is logged at info level as
   `switch budget/cooldown held`, not explicitly as cap exhaustion.
4. Switch-cap reset on idle — a bare `agent/status: idle` with no pending intent
   resets `state.switches` to 0, so `maxSwitchesPerSession` can be bypassed
   between qualifying failures. If the intended semantics is "cap per session",
   this needs a lead-side fix; the test currently asserts the observed behavior.
5. A cap/cooldown hold is logged at `info` level; a `warn` may be preferable
   for diagnostics.
## Current verdict

`node --test tests/*.test.js` with plain Node v24.20.0: **53 tests, 53 pass,
0 fail** (exit 0) — the original 34 plus 19 new management tests. The bundled
Node v24.21.0 gives the same result.

During development the suite exposed three classification deviations in
`lib/rules.js` (generic quota wording never matched, `AUTH` + 5xx status
qualified, and a custom `triggers` list was overridden by built-in codes).
The lead fixed all three; the assertions stayed unchanged and now pass. The
configured trigger list is authoritative — the built-in bypass is not part of
the contract.

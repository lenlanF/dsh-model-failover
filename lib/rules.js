// Pure decision helpers: no Cordis or runtime imports, so tests can run in plain Node.

export const DEFAULT_PRIORITY = Object.freeze([
  Object.freeze({ provider: 'workbuddy', model: 'hy4free' }),
  Object.freeze({ provider: 'workbuddy', model: 'hy3' }),
  Object.freeze({ provider: 'workbuddy', model: 'hy4std' }),
]);

export const DEFAULT_TRIGGERS = Object.freeze([
  'QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED',
]);

const BUILTIN_QUALIFYING = new Set(DEFAULT_TRIGGERS);
const CUSTOM_CODE = /^HTTP_(?:[1-5][0-9][0-9])$/;
const DENY_CODES = new Set([
  'AUTH', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'EMPTY_RESPONSE',
  'MALFORMED_RESPONSE', 'IMAGE_OFFLOAD_REQUIRED', 'ABORTED', 'CANCELLED',
]);
const QUOTA_WORDING = /(?:\binsufficient[_ -]?(?:quota|balance|credits?)\b|\b(?:quota|usage[_ -]+limit)[_ -]*(?:exceeded|exhausted|reached|depleted)\b|\b(?:balance|credits?)[_ -]*(?:exhausted|depleted)\b|\bout of (?:credits?|budget)\b)/i;

/** Normalize a user rule entry into a complete selection. */
export function normalizeSelection(entry) {
  if (typeof entry === 'string') {
    const slash = entry.indexOf('/');
    if (slash <= 0 || slash === entry.length - 1) return undefined;
    const selection = { provider: entry.slice(0, slash).trim(), model: entry.slice(slash + 1).trim() };
    return selection.provider && selection.model ? selection : undefined;
  }
  if (entry === null || typeof entry !== 'object') return undefined;
  const provider = typeof entry.provider === 'string' ? entry.provider.trim() : '';
  const model = typeof entry.model === 'string' ? entry.model.trim() : '';
  if (!provider || !model) return undefined;
  const selection = { provider, model };
  const effort = entry.reasoningEffort ?? entry.reasoning_effort;
  if (typeof effort === 'string' && effort.trim()) selection.reasoningEffort = effort.trim();
  return selection;
}

/** Normalize config into a validated, detached rule set; invalid entries are dropped. */
export function normalizeRules(config = {}) {
  const raw = Array.isArray(config.priority) && config.priority.length > 0 ? config.priority : DEFAULT_PRIORITY;
  const seen = new Set();
  const priority = [];
  for (const entry of raw) {
    const selection = normalizeSelection(entry);
    if (!selection) continue;
    const key = `${selection.provider}/${selection.model}/${selection.reasoningEffort ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    priority.push(Object.freeze(selection));
  }
  const triggers = Array.isArray(config.triggers) && config.triggers.length > 0
    ? config.triggers.filter((code) => typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)).map((code) => code.trim())
    : [...DEFAULT_TRIGGERS];
  const maxSwitches = Number.isFinite(config.maxSwitchesPerSession) && config.maxSwitchesPerSession >= 0
    ? Math.floor(config.maxSwitchesPerSession) : 3;
  const cooldownMs = Number.isFinite(config.cooldownMs) && config.cooldownMs >= 0 ? config.cooldownMs : 0;
  return Object.freeze({
    priority: Object.freeze(priority.length > 0 ? priority : DEFAULT_PRIORITY.map((item) => ({ ...item }))),
    triggers: Object.freeze([...new Set(triggers)]),
    enabled: config.enabled !== false,
    maxSwitchesPerSession: maxSwitches,
    cooldownMs,
    switchLogLimit: Number.isFinite(config.switchLogLimit) && config.switchLogLimit >= 1
      ? Math.floor(config.switchLogLimit) : 20,
    switchLog: Object.freeze(Array.isArray(config.switchLog)
      ? config.switchLog.slice(-Math.max(1, Number.isFinite(config.switchLogLimit) && config.switchLogLimit >= 1
        ? Math.floor(config.switchLogLimit) : 20)).map((row) => Object.freeze({ ...row })) : []),
  });
}

/** Whether a per-session switch budget/cooldown permits another switch. */
export function canSwitch(state, rules, now = Date.now()) {
  if (!rules.enabled) return false;
  if (state.switches >= rules.maxSwitchesPerSession) return false;
  const last = state.lastSwitchAt;
  if (rules.cooldownMs > 0 && Number.isFinite(last) && now - last < rules.cooldownMs) return false;
  return true;
}

/** Append a bounded, immutable switch record for the settings page. */
export function appendSwitchLog(log, record, limit = 20) {
  const entry = Object.freeze({
    at: Number(record.at) || Date.now(),
    code: String(record.code ?? 'UNKNOWN'),
    from: record.from ? `${record.from.provider}/${record.from.model}` : 'unknown',
    to: `${record.to.provider}/${record.to.model}`,
    reason: String(record.reason ?? 'auto'),
  });
  return Object.freeze([...log, entry].slice(-Math.max(1, limit)));
}

/** Whether a normalized LlmFailure qualifies for a model switch. */
export function qualifies(failure, rules = normalizeRules()) {
  if (!rules.enabled || failure === null || typeof failure !== 'object') return false;
  const code = typeof failure.code === 'string' ? failure.code : '';
  const status = Number.isInteger(failure.status) ? failure.status : undefined;
  if (DENY_CODES.has(code)) return false;
  if (rules.triggers.includes(code)) return true;
  // HTTP_5xx and a numeric 5xx status describe an upstream failure only when
  // the machine code is generic; a terminal code above wins over the status.
  const generic = code === '' || code === 'UNKNOWN' || CUSTOM_CODE.test(code);
  if (generic && CUSTOM_CODE.test(code) && Number(code.slice(5)) >= 500) return true;
  if (generic && status !== undefined && status >= 500) return true;
  // WorkBuddy and other gateways sometimes report a generic code with quota wording.
  if (code === 'UNKNOWN' || code === '') {
    const message = typeof failure.message === 'string' ? failure.message : '';
    return QUOTA_WORDING.test(message);
  }
  return false;
}

export function sameSelection(a, b) {
  if (!a || !b) return false;
  return a.provider === b.provider && a.model === b.model
    && (a.reasoningEffort ?? undefined) === (b.reasoningEffort ?? undefined);
}

/** Resolve the next model after the route that just failed. */
export function nextSelection(current, rules = normalizeRules()) {
  const list = rules.priority;
  if (list.length === 0) return undefined;
  if (!current) return list[0];
  const index = list.findIndex((item) => sameSelection(item, current));
  if (index < 0) return list[0];
  return index + 1 < list.length ? list[index + 1] : undefined;
}

/** One-line, bounded failover trace for the logger. */
export function failoverSummary(from, to, code) {
  const max = 120;
  const text = `[failover] ${code}: ${from ? `${from.provider}/${from.model}` : 'unknown'} -> ${to.provider}/${to.model}; continuing`;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// Minimal Cordis/Agent runtime double; no runtime imports and no I/O.
// Every emitter is a waterfall: listeners are composed left-to-right and each
// listener receives (payload, next), exactly as the DSH 0.2.2-rc.3 host does.

export const DEFAULT_PRIORITY = Object.freeze([
  Object.freeze({ provider: 'workbuddy', model: 'hy4flash-free' }),
  Object.freeze({ provider: 'workbuddy', model: 'hy3' }),
  Object.freeze({ provider: 'workbuddy', model: 'hy4std' }),
]);

let messageSeq = 0;

export function createUserMessage({ content = [], source } = {}) {
  const id = `mock-message-${++messageSeq}`;
  return { id, content, source: source ?? { kind: 'user' }, createdAt: Date.now() };
}

export function createMockAgent(options = {}) {
  const id = options.id ?? 'agent-1';
  const selection = { ...(options.selection ?? DEFAULT_PRIORITY[0]) };
  const agent = {
    id,
    status: options.status ?? 'idle',
    model: {
      current: () => ({ ...selection }),
      select: (nextSelection) => {
        selection.provider = nextSelection.provider;
        selection.model = nextSelection.model;
        if (nextSelection.reasoningEffort !== undefined) selection.reasoningEffort = nextSelection.reasoningEffort;
        else delete selection.reasoningEffort;
        agent.log.push({ op: 'select', value: { ...selection } });
        agent.selects.push({ ...selection });
        return { ...selection };
      },
    },
    session: {
      append: (form, body) => {
        agent.log.push({ op: 'append', value: { form, body } });
        agent.notices.push({ form, ...body });
        return { id: `notice-${agent.notices.length}` };
      },
    },
    followup: (message) => {
      agent.log.push({ op: 'followup', value: message });
      agent.followups.push(message);
      return message.id;
    },
    inbox: {
      _turn: options.turn ?? 1,
      _step: options.step ?? 0,
      nextTurn: () => ++agent.inbox._turn,
      nextStep: () => ++agent.inbox._step,
    },
    whenIdle: () => {
      agent.log.push({ op: 'whenIdle' });
      return Promise.resolve();
    },
    selects: [],
    notices: [],
    followups: [],
    log: [],
  };
  agent.model.current = () => ({ ...selection });
  return agent;
}

export function createMockContext(options = {}) {
  const listeners = new Map();
  const agents = new Map();
  for (const agent of options.agents ?? []) agents.set(agent.id, agent);

  const ctx = {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return () => {
        const list = listeners.get(event);
        const index = list ? list.indexOf(fn) : -1;
        if (index >= 0) list.splice(index, 1);
      };
    },
    effect(callback, label) {
      const cleanup = callback();
      ctx.effects.push({ label, cleanup });
      return () => cleanup;
    },
    agents: {
      get: (id) => agents.get(id),
      set: (id, value) => agents.set(id, value),
      delete: (id) => agents.delete(id),
    },
    logger: {
      info: (text) => ctx.logs.push({ level: 'info', text }),
      warn: (text) => ctx.logs.push({ level: 'warn', text }),
    },
    agentDefaultModel: {
      saveSelection: (...args) => {
        ctx.globalDefaultSaves.push(args);
        throw new Error('saveSelection must never be called');
      },
    },
    logs: [],
    effects: [],
    globalDefaultSaves: [],
    listeners,

    listenerCount(event) {
      return listeners.get(event)?.length ?? 0;
    },

    async emit(event, payload, terminal) {
      const chain = [...(listeners.get(event) ?? [])];
      const calls = [];
      const run = async (index) => {
        const fn = chain[index];
        if (fn === undefined) {
          calls.push('terminal');
          return typeof terminal === 'function' ? await terminal() : terminal;
        }
        return fn(payload, async () => run(index + 1));
      };
      const value = await run(0);
      return { value, calls };
    },

    async runCleanups() {
      for (const { cleanup } of ctx.effects) await cleanup();
    },
  };
  // Optional surfaces for the NEW management features. Absent by default so the
  // original 34 tests keep seeing exactly the same mock context as before.
  if (options.llm !== undefined) ctx.llm = options.llm;
  if (options.now !== undefined) ctx.now = options.now;
  if (options.get !== undefined) ctx.get = options.get;
  return ctx;
}

export function makeFailure(code, overrides = {}) {
  return {
    code,
    message: overrides.message ?? `mock failure ${code}`,
    status: overrides.status,
    providerRetryAfterMs: overrides.providerRetryAfterMs,
    requestId: overrides.requestId ?? `req-${code}`,
  };
}

export function makePayload(agent, failure, overrides = {}) {
  return {
    agent,
    turn: overrides.turn ?? 1,
    step: overrides.step ?? 1,
    provider: overrides.provider ?? agent.model.current().provider,
    failure,
    retryPolicy: overrides.retryPolicy ?? { maxAttempts: 3 },
    signal: overrides.signal ?? { aborted: false },
  };
}

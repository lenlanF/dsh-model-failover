// Per-agent serialized failover state. Pure data structures, no Cordis imports.

export function createStateStore() {
  const states = new Map();

  function stateFor(agent) {
    let state = states.get(agent);
    if (state === undefined) {
      state = {
        agent,
        intent: undefined,
        running: undefined,
        stopping: false,
        switches: 0,
      };
      states.set(agent, state);
    }
    return state;
  }

  return {
    stateFor,
    get: (agent) => states.get(agent),
    delete: (agent) => states.delete(agent),
    values: () => states.values(),
    clear: () => states.clear(),
    size: () => states.size,
  };
}

/** Record one failover intent; duplicates of the same failed step are ignored. */
export function recordIntent(state, payload, failure) {
  if (state.stopping || state.intent !== undefined) return false;
  if (payload.signal?.aborted) return false;
  const key = `${payload.turn}:${payload.step}`;
  if (state.intent?.key === key) return false;
  state.intent = {
    key,
    turn: payload.turn,
    step: payload.step,
    provider: payload.provider,
    failure: Object.freeze({ code: failure.code, status: failure.status, message: failure.message }),
    queuedMessageId: undefined,
    stale: false,
  };
  return true;
}

export function clearIntent(state) {
  state.intent = undefined;
}

/** Competing human input wins: our automatic continuation must not overwrite it. */
export function noteIncoming(state, message) {
  if (state.intent === undefined) return false;
  const source = message?.source;
  if (source?.kind === 'retry') return false;
  clearIntent(state);
  return true;
}

/** Coalesce idle/error triggers onto one serialized driver per agent. */
export function requestDrive(state, drive) {
  if (state.stopping || state.running !== undefined) return;
  const run = Promise.resolve().then(() => drive(state)).finally(() => {
    if (state.running === run) state.running = undefined;
  });
  state.running = run;
}

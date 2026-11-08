/**
 * Session activity tracking for the routing-id pool.
 *
 * The pool may only take a routing id from a session that is genuinely
 * between turns: no open turn, no tool call waiting for a result, no pending
 * approval and no background job. session/event gives us all of that without
 * reading prompts or tool output.
 */

const IGNORED_EVENTS = new Set([
  'request/header',
  'request/context',
  'session/title',
  'session/end-seed',
  'session-log-deepseek/delivery-accepted',
  'llm/retry',
  'llm/retry-started',
]);

function sessionIdOf(session) {
  if (!session || typeof session !== 'object') return '';
  const id = session.id == null ? session.sessionId : session.id;
  return String(id == null ? '' : id);
}

function eventData(event) {
  return event && typeof event.data === 'object' && event.data ? event.data : {};
}

function addTo(set, value) {
  if (value == null || value === '') return false;
  const key = String(value);
  if (set.has(key)) return false;
  set.add(key);
  return true;
}

function removeFrom(set, value) {
  if (value == null || value === '') return false;
  return set.delete(String(value));
}

export class SessionActivity {
  constructor(options) {
    const opts = options || {};
    this.ctx = opts.ctx || null;
    this.logger = opts.logger || console;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.states = new Map();
    this.lastPruneAt = 0;
    this.disposeListener = null;
    if (this.ctx && typeof this.ctx.on === 'function') {
      try {
        this.disposeListener = this.ctx.on('session/event', (session, event) => this.observe(session, event), { global: true });
      } catch (error) {
        this.warn('session activity listener unavailable: ' + String(error && error.message ? error.message : error));
      }
    }
  }

  warn(line) {
    try {
      const logger = this.logger;
      if (logger && typeof logger.warn === 'function') logger.warn('[opencode-router] ' + line);
      else if (typeof console !== 'undefined' && console.warn) console.warn('[opencode-router] ' + line);
    } catch {
      // Logging must never break routing.
    }
  }

  stateFor(sessionId) {
    const key = String(sessionId == null ? '' : sessionId);
    if (key === '') return null;
    let state = this.states.get(key);
    if (!state) {
      state = {
        sessionId: key,
        lastActivityAt: 0,
        lastEventAt: 0,
        turns: new Set(),
        tools: new Set(),
        approvals: new Set(),
        jobs: new Set(),
      };
      this.states.set(key, state);
    }
    return state;
  }

  touch(sessionId, at) {
    const state = this.stateFor(sessionId);
    if (!state) return;
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.now();
    state.lastActivityAt = Math.max(state.lastActivityAt, stamp);
    state.lastEventAt = Math.max(state.lastEventAt, stamp);
  }

  observe(session, event) {
    const sessionId = sessionIdOf(session);
    if (sessionId === '' || !event || typeof event !== 'object') return;
    const type = String(event.type == null ? '' : event.type);
    if (type === '' || IGNORED_EVENTS.has(type)) return;
    const state = this.stateFor(sessionId);
    if (!state) return;
    const data = eventData(event);
    const stamp = this.now();
    state.lastEventAt = stamp;
    // Any meaningful event means the session is doing something; the pool
    // timer restarts from this point.
    state.lastActivityAt = stamp;
    switch (type) {
      case 'turn/start':
        addTo(state.turns, data.turn);
        break;
      case 'turn/end':
        removeFrom(state.turns, data.turn);
        break;
      case 'tool/call':
        addTo(state.tools, data.callId);
        break;
      case 'tool/result': {
        const callId = data.toolCallId == null
          ? (data.message && data.message.toolCallId)
          : data.toolCallId;
        removeFrom(state.tools, callId);
        break;
      }
      case 'approval/asked':
        addTo(state.approvals, data.id);
        break;
      case 'approval/decided':
        removeFrom(state.approvals, data.id);
        break;
      case 'approval/policy':
        break;
      case 'job/registered':
        addTo(state.jobs, data.jobId);
        break;
      case 'job/settled':
        removeFrom(state.jobs, data.jobId);
        break;
      case 'compaction/start':
        // A compaction can run between turns; the turn/start that follows
        // will clear it. Treat it as activity only.
        break;
      case 'compaction/end':
        break;
      default:
        break;
    }
  }

  isBusy(sessionId) {
    const state = this.states.get(String(sessionId == null ? '' : sessionId));
    if (!state) return false;
    return state.turns.size > 0
      || state.tools.size > 0
      || state.approvals.size > 0
      || state.jobs.size > 0;
  }

  lastActivityAt(sessionId) {
    const state = this.states.get(String(sessionId == null ? '' : sessionId));
    return state ? state.lastActivityAt : 0;
  }

  snapshot(sessionId) {
    const state = this.states.get(String(sessionId == null ? '' : sessionId));
    if (!state) {
      return { sessionId: String(sessionId == null ? '' : sessionId), lastActivityAt: 0, turns: 0, tools: 0, approvals: 0, jobs: 0 };
    }
    return {
      sessionId: state.sessionId,
      lastActivityAt: state.lastActivityAt,
      turns: state.turns.size,
      tools: state.tools.size,
      approvals: state.approvals.size,
      jobs: state.jobs.size,
    };
  }

  isIdleFor(sessionId, idleMs, now) {
    if (this.isBusy(sessionId)) return false;
    const last = this.lastActivityAt(sessionId);
    if (last <= 0) return false;
    return Number(now) - last >= Math.max(0, Number(idleMs) || 0);
  }

  prune(now, maxAgeMs = 7 * 86400000) {
    const stamp = Number(now) || this.now();
    if (stamp - this.lastPruneAt < 600000) return;
    this.lastPruneAt = stamp;
    for (const [sessionId, state] of this.states) {
      if (state.turns.size > 0 || state.tools.size > 0 || state.approvals.size > 0 || state.jobs.size > 0) continue;
      if (stamp - state.lastActivityAt > maxAgeMs) this.states.delete(sessionId);
    }
  }

  dispose() {
    try {
      if (typeof this.disposeListener === 'function') this.disposeListener();
    } catch {
      // Best effort.
    }
    this.disposeListener = null;
    this.states.clear();
  }
}

/**
 * Persistent route + performance state for opencode-router.
 *
 * The file contains only session ids, generated routing ids, fold numbers and
 * timing summaries. No prompts, messages or tool output are stored.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const STATE_VERSION = 1;
const HISTORY_LIMIT = 100;
// Rings kept for the settings page: recent request samples (cache-hit log) and
// pool exchanges. Both are small and contain no prompt text.
const REQUEST_LIMIT = 200;
const POOL_EVENT_LIMIT = 100;
const DEFAULT_WARM_HIT_PCT = 80;
const DEFAULT_COLD_HIT_PCT = 25;

function emptyState() {
  return {
    version: STATE_VERSION,
    updatedAt: 0,
    routes: {},
    metrics: {},
    history: [],
    requests: [],
    poolEvents: [],
  };
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nonNegativeIntegerOrNull(value) {
  const n = finiteOrNull(value);
  return n == null ? null : Math.max(0, Math.round(n));
}

function sanitizeRoute(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const value = typeof entry.value === 'string' ? entry.value.slice(0, 256) : '';
  if (value === '') return null;
  return {
    value,
    rotatedAt: finiteOrNull(entry.rotatedAt),
    foldSeq: finiteOrNull(entry.foldSeq),
    reason: typeof entry.reason === 'string' ? entry.reason.slice(0, 200) : 'unknown',
    basis: typeof entry.basis === 'string' ? entry.basis.slice(0, 64) : null,
    cacheHitPct: finiteOrNull(entry.cacheHitPct),
    step: nonNegativeIntegerOrNull(entry.step),
    avgTtftMs: finiteOrNull(entry.avgTtftMs),
    avgTps: finiteOrNull(entry.avgTps),
    // Pool metadata. The digest is a list of sha256 prefixes, never prompt
    // text, so the state file cannot leak conversation content.
    digest: Array.isArray(entry.digest)
      ? entry.digest.filter((chunk) => typeof chunk === 'string' && chunk.length > 0).slice(0, 1024)
      : [],
    digestChars: nonNegativeIntegerOrNull(entry.digestChars) || 0,
    digestUpdatedAt: finiteOrNull(entry.digestUpdatedAt),
    lastActiveAt: finiteOrNull(entry.lastActiveAt),
    generatedAt: finiteOrNull(entry.generatedAt),
    pooledAt: finiteOrNull(entry.pooledAt),
    sleepingAt: finiteOrNull(entry.sleepingAt),
    // Set when the size cap evicts an idle code. The periodic scan must not
    // immediately put it back, or a full pool would churn every tick.
    poolEvictedAt: finiteOrNull(entry.poolEvictedAt),
    adoptedFrom: typeof entry.adoptedFrom === 'string' ? entry.adoptedFrom.slice(0, 256) : null,
    // The first request sample recorded after this route was created, adopted,
    // revived, or handed a fresh replacement. The pool-effect metric must use
    // this exact sample; the 200-entry request ring may already have evicted it.
    firstRequestAt: finiteOrNull(entry.firstRequestAt),
    awaitingFirstRequest: entry.awaitingFirstRequest === true,
    samples: Array.isArray(entry.samples)
      ? entry.samples.map(sanitizeMetric).filter(Boolean).slice(-20)
      : [],
  };
}

function clampCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(50, Math.round(n));
}

function historyId(sessionId, at) {
  return String(sessionId) + '@' + String(at);
}

function historyAverage(samples, at, target) {
  const after = samples
    .filter((sample) => Number.isFinite(Number(sample.at)) && Number(sample.at) >= at)
    .sort((a, b) => Number(a.at) - Number(b.at))
    .slice(0, target);
  if (after.length === 0) {
    return { ttftMs: null, tps: null, count: 0, complete: false };
  }
  let ttftTotal = 0;
  let tpsTotal = 0;
  for (const sample of after) {
    ttftTotal += Number(sample.ttftMs);
    tpsTotal += Number(sample.tps);
  }
  return {
    ttftMs: Math.round((ttftTotal / after.length) * 10) / 10,
    tps: Math.round((tpsTotal / after.length) * 100) / 100,
    count: after.length,
    complete: after.length >= target,
  };
}

function sanitizeHistory(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const sessionId = String(entry.sessionId == null ? '' : entry.sessionId).slice(0, 256);
  const at = finiteOrNull(entry.at);
  if (sessionId === '' || at == null) return null;
  const afterTarget = Math.max(1, Math.min(50, clampCount(entry.afterTarget) || 5));
  const value = typeof entry.value === 'string' ? entry.value.slice(0, 256) : '';
  return {
    id: typeof entry.id === 'string' && entry.id !== '' ? entry.id.slice(0, 512) : historyId(sessionId, at),
    sessionId,
    at,
    value,
    reason: typeof entry.reason === 'string' ? entry.reason.slice(0, 200) : 'unknown',
    basis: typeof entry.basis === 'string' ? entry.basis.slice(0, 64) : null,
    foldSeq: finiteOrNull(entry.foldSeq),
    cacheHitPct: finiteOrNull(entry.cacheHitPct),
    step: nonNegativeIntegerOrNull(entry.step),
    beforeTtftMs: finiteOrNull(entry.beforeTtftMs),
    beforeTps: finiteOrNull(entry.beforeTps),
    beforeSamples: clampCount(entry.beforeSamples),
    afterTtftMs: finiteOrNull(entry.afterTtftMs),
    afterTps: finiteOrNull(entry.afterTps),
    afterSamples: clampCount(entry.afterSamples),
    afterTarget,
    afterComplete: entry.afterComplete === true,
    afterUpdatedAt: finiteOrNull(entry.afterUpdatedAt),
    backfilled: entry.backfilled === true,
    // Recorded from v0.6.0 on: what gate the switch actually used. Rows
    // written by older builds have no thresholds and are labelled as legacy.
    version: typeof entry.version === 'string' ? entry.version.slice(0, 32) : null,
    thresholds: entry.thresholds && typeof entry.thresholds === 'object'
      ? {
          step: nonNegativeIntegerOrNull(entry.thresholds.step),
          baseTtftThresholdMs: finiteOrNull(entry.thresholds.baseTtftThresholdMs),
          baseThroughputThresholdTps: finiteOrNull(entry.thresholds.baseThroughputThresholdTps),
          effectiveTtftThresholdMs: finiteOrNull(entry.thresholds.effectiveTtftThresholdMs),
          effectiveThroughputThresholdTps: finiteOrNull(entry.thresholds.effectiveThroughputThresholdTps),
        }
      : null,
    poolMatchPct: finiteOrNull(entry.poolMatchPct),
    poolTier: finiteOrNull(entry.poolTier),
    poolScore: finiteOrNull(entry.poolScore),
    poolSourceSessionId: typeof entry.poolSourceSessionId === 'string' ? entry.poolSourceSessionId.slice(0, 256) : null,
    poolRole: typeof entry.poolRole === 'string' ? entry.poolRole.slice(0, 32) : null,
    firstRequestAt: finiteOrNull(entry.firstRequestAt),
  };
}

function sanitizeMetric(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const ttftMs = finiteOrNull(entry.ttftMs);
  const tps = finiteOrNull(entry.tps);
  const outputTokens = finiteOrNull(entry.outputTokens);
  const inputTokens = finiteOrNull(entry.inputTokens);
  const cacheReadTokens = finiteOrNull(entry.cacheReadTokens);
  const hitPct = finiteOrNull(entry.hitPct);
  const at = finiteOrNull(entry.at);
  if (ttftMs == null || ttftMs < 0 || tps == null || tps <= 0) return null;
  return {
    ttftMs,
    tps,
    outputTokens: outputTokens == null ? 0 : outputTokens,
    inputTokens,
    cacheReadTokens,
    hitPct: hitPct == null ? null : Math.min(100, Math.max(0, hitPct)),
    at: at == null ? 0 : at,
  };
}

function sanitizeRequest(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const sessionId = String(entry.sessionId == null ? '' : entry.sessionId).slice(0, 256);
  if (sessionId === '') return null;
  const metric = sanitizeMetric(entry);
  if (!metric) return null;
  return { sessionId, ...metric };
}

function sanitizeFirstRequest(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return sanitizeMetric(entry);
}

function sanitizePoolEvent(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const at = finiteOrNull(entry.at);
  const sessionId = String(entry.sessionId == null ? '' : entry.sessionId).slice(0, 256);
  if (at == null || sessionId === '') return null;
  const role = entry.role === 'adopted' || entry.role === 'revived' ? entry.role : null;
  if (role == null) return null;
  const text = (value, limit = 256) => (typeof value === 'string' ? value.slice(0, limit) : null);
  return {
    at,
    role,
    sessionId,
    sourceSessionId: text(entry.sourceSessionId),
    code: text(entry.code),
    donorCode: text(entry.donorCode),
    matchPct: finiteOrNull(entry.matchPct),
    tier: finiteOrNull(entry.tier),
    score: finiteOrNull(entry.score),
    donorTtftMs: finiteOrNull(entry.donorTtftMs),
    donorTps: finiteOrNull(entry.donorTps),
    donorSamples: clampCount(entry.donorSamples),
    // Snapshot of the first request after an adoption. It survives the
    // 200-request ring so the cache log can still show that first hit later.
    firstRequest: sanitizeFirstRequest(entry.firstRequest),
  };
}

function sanitizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') return state;
  state.updatedAt = finiteOrNull(raw.updatedAt) || 0;
  if (raw.routes && typeof raw.routes === 'object') {
    for (const [sessionId, entry] of Object.entries(raw.routes)) {
      const route = sanitizeRoute(entry);
      if (route) state.routes[String(sessionId)] = route;
    }
  }
  if (raw.metrics && typeof raw.metrics === 'object') {
    for (const [sessionId, list] of Object.entries(raw.metrics)) {
      if (!Array.isArray(list)) continue;
      const samples = list.map(sanitizeMetric).filter(Boolean).slice(-100);
      if (samples.length > 0) state.metrics[String(sessionId)] = samples;
    }
  }
  if (Array.isArray(raw.history)) {
    state.history = raw.history
      .map(sanitizeHistory)
      .filter(Boolean)
      .sort((a, b) => a.at - b.at)
      .slice(-HISTORY_LIMIT);
  }
  if (Array.isArray(raw.requests)) {
    state.requests = raw.requests.map(sanitizeRequest).filter(Boolean).slice(-REQUEST_LIMIT);
  }
  if (Array.isArray(raw.poolEvents)) {
    state.poolEvents = raw.poolEvents.map(sanitizePoolEvent).filter(Boolean).slice(-POOL_EVENT_LIMIT);
  }
  return state;
}

export class RouterStore {
  constructor(options) {
    const opts = options || {};
    this.statePath = opts.statePath;
    this.logger = opts.logger || console;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.debounceMs = Number.isFinite(Number(opts.debounceMs)) ? Number(opts.debounceMs) : 150;
    this.sampleSize = Math.max(1, Math.min(50, clampCount(opts.sampleSize) || 5));
    this.state = this.load();
    this.seedHistoryFromRoutes();
    this.dirty = false;
    this.timer = null;
    this.chain = Promise.resolve();
    // State writes go through a small retry policy: a flush makes up to
    // writeAttempts immediate attempts (antivirus/indexers on Windows can make
    // a rename fail transiently), then failure leaves the state dirty and
    // schedules an exponential-backoff retry instead of waiting for the next
    // touch. tmp files are always unlinked so a failed write leaves no debris.
    this.fs = opts.fs || fsp;
    const attempts = Number(opts.writeAttempts);
    this.writeAttempts = Number.isFinite(attempts) && attempts >= 1
      ? Math.min(10, Math.round(attempts))
      : 3;
    this.retryDelayMs = Number.isFinite(Number(opts.retryDelayMs)) ? Math.max(0, Number(opts.retryDelayMs)) : 250;
    this.retryMaxDelayMs = Number.isFinite(Number(opts.retryMaxDelayMs))
      ? Math.max(this.retryDelayMs, Number(opts.retryMaxDelayMs))
      : 60000;
    this.retryTimer = null;
    this.writeFailures = 0;
    this.lastWriteError = null;
    this.disposed = false;
  }

  load() {
    try {
      const text = fs.readFileSync(this.statePath, 'utf8');
      return sanitizeState(JSON.parse(text));
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        this.warn('state file unreadable; starting empty: ' + String(error && error.message ? error.message : error));
        try {
          if (fs.existsSync(this.statePath)) {
            const backup = this.statePath + '.corrupt-' + Date.now();
            fs.copyFileSync(this.statePath, backup);
            this.warn('corrupt state backed up to ' + backup);
          }
        } catch {
          // Best effort only.
        }
      }
      return emptyState();
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

  routeFor(sessionId) {
    const key = String(sessionId == null ? '' : sessionId);
    if (key === '') return null;
    const route = this.state.routes[key];
    return route ? { ...route } : null;
  }

  /** All persisted routes keyed by session id, as deep copies. */
  routes() {
    return Object.entries(this.state.routes).map(([sessionId, route]) => ({
      sessionId,
      route: JSON.parse(JSON.stringify(route)),
    }));
  }

  setRoute(sessionId, record) {
    const key = String(sessionId == null ? '' : sessionId);
    if (key === '') return null;
    const clean = sanitizeRoute(record);
    if (!clean) return null;
    this.state.routes[key] = clean;
    this.touch();
    return clean;
  }

  /**
   * Record one silent routing switch. The before values come from the samples
   * that justified it; the after values are filled in as the first requests on
   * the new upstream finish, then frozen when the sample target is reached.
   */
  addRotation(entry) {
    const clean = sanitizeHistory(entry);
    if (!clean) return null;
    const existing = this.state.history.find((item) => item.id === clean.id);
    if (existing) return { ...existing };
    this.state.history.push(clean);
    this.trimHistory();
    this.refreshHistoryForSession(clean.sessionId);
    this.touch();
    return { ...this.state.history.find((item) => item.id === clean.id) };
  }

  /**
   * Existing route files predate the history array. Reconstruct one row per
   * still-known route so the settings page has something to show immediately;
   * after values use whatever samples remain from after that rotation.
   */
  seedHistoryFromRoutes() {
    let changed = false;
    for (const [sessionId, route] of Object.entries(this.state.routes)) {
      const at = Number(route && route.rotatedAt);
      if (!Number.isFinite(at)) continue;
      const id = historyId(sessionId, at);
      if (this.state.history.some((item) => item.id === id)) continue;
      const entry = sanitizeHistory({
        id,
        sessionId,
        at,
        value: route.value,
        reason: route.reason,
        basis: route.basis,
        foldSeq: route.foldSeq,
        cacheHitPct: route.cacheHitPct,
        step: route.step,
        beforeTtftMs: route.avgTtftMs,
        beforeTps: route.avgTps,
        beforeSamples: this.sampleSize,
        afterTarget: this.sampleSize,
        backfilled: true,
        firstRequestAt: route.firstRequestAt,
      });
      if (!entry) continue;
      this.state.history.push(entry);
      changed = true;
    }
    if (!changed) return;
    this.state.history.sort((a, b) => a.at - b.at);
    this.trimHistory();
    for (const entry of this.state.history) this.refreshHistoryForSession(entry.sessionId, false);
    this.touch();
  }

  trimHistory() {
    if (this.state.history.length > HISTORY_LIMIT) {
      this.state.history = this.state.history.slice(-HISTORY_LIMIT);
    }
  }

  refreshHistoryForSession(sessionId, notify = true) {
    const key = String(sessionId == null ? '' : sessionId);
    if (key === '') return;
    const samples = Array.isArray(this.state.metrics[key]) ? this.state.metrics[key] : [];
    let changed = false;
    for (const entry of this.state.history) {
      if (entry.sessionId !== key || entry.afterComplete) continue;
      const summary = historyAverage(samples, entry.at, entry.afterTarget);
      if (summary.count === 0) continue;
      if (entry.afterSamples !== summary.count
        || entry.afterTtftMs !== summary.ttftMs
        || entry.afterTps !== summary.tps
        || entry.afterComplete !== summary.complete) {
        entry.afterSamples = summary.count;
        entry.afterTtftMs = summary.ttftMs;
        entry.afterTps = summary.tps;
        entry.afterComplete = summary.complete;
        entry.afterUpdatedAt = this.now();
        changed = true;
      }
    }
    const route = this.state.routes[key];
    if (route && route.firstRequestAt != null && route.rotatedAt != null) {
      for (const entry of this.state.history) {
        if (entry.sessionId !== key || entry.afterComplete) continue;
        if (entry.firstRequestAt != null) continue;
        if (entry.reason !== 'pool-adopted' && entry.reason !== 'pool-initial') continue;
        if (Math.abs(Number(entry.at) - Number(route.rotatedAt)) >= 1000) continue;
        entry.firstRequestAt = route.firstRequestAt;
        changed = true;
      }
    }
    if (changed && notify) this.touch();
  }

  history(limit = HISTORY_LIMIT) {
    const requested = Number(limit);
    const count = Number.isFinite(requested)
      ? Math.max(1, Math.min(HISTORY_LIMIT, Math.round(requested)))
      : HISTORY_LIMIT;
    return this.state.history
      .slice()
      .sort((a, b) => b.at - a.at)
      .slice(0, count)
      .map((entry) => ({ ...entry }));
  }

  /** Recent request samples, newest first, for the cache-hit log. */
  recentRequests(limit = 100) {
    const requested = Number(limit);
    const count = Number.isFinite(requested)
      ? Math.max(1, Math.min(REQUEST_LIMIT, Math.round(requested)))
      : 100;
    return this.state.requests
      .slice()
      .sort((a, b) => Number(b.at) - Number(a.at))
      .slice(0, count)
      .map((entry) => ({ ...entry }));
  }

  /** Recent pool exchanges, newest first. */
  poolEvents(limit = 100) {
    const requested = Number(limit);
    const count = Number.isFinite(requested)
      ? Math.max(1, Math.min(POOL_EVENT_LIMIT, Math.round(requested)))
      : 100;
    return this.state.poolEvents
      .slice()
      .sort((a, b) => Number(b.at) - Number(a.at))
      .slice(0, count)
      .map((entry) => ({ ...entry }));
  }

  /** Record one adopted or revived code; the UI shows these as swap events. */
  addPoolEvent(entry) {
    const clean = sanitizePoolEvent(entry);
    if (!clean) return null;
    const duplicate = this.state.poolEvents.some((item) => (
      item.at === clean.at && item.sessionId === clean.sessionId && item.role === clean.role
    ));
    if (duplicate) return null;
    this.state.poolEvents.push(clean);
    if (this.state.poolEvents.length > POOL_EVENT_LIMIT) {
      this.state.poolEvents = this.state.poolEvents.slice(-POOL_EVENT_LIMIT);
    }
    this.touch();
    return { ...clean };
  }

  /**
   * Aggregate the recent request ring for the settings page. Hit-rate counts
   * use the configured cold threshold (default 25%) and the shared 80% warm
   * line, so the numbers match the routing prediction's vocabulary.
   */
  statistics(options = {}) {
    const opts = options || {};
    const warmThreshold = Number.isFinite(Number(opts.warmThresholdPct))
      ? Number(opts.warmThresholdPct)
      : DEFAULT_WARM_HIT_PCT;
    const coldThreshold = Number.isFinite(Number(opts.coldThresholdPct))
      ? Number(opts.coldThresholdPct)
      : DEFAULT_COLD_HIT_PCT;
    const requests = this.state.requests;
    let hitTotal = 0;
    let hitCount = 0;
    let warm = 0;
    let cold = 0;
    let ttftTotal = 0;
    let tpsTotal = 0;
    for (const entry of requests) {
      if (Number.isFinite(Number(entry.ttftMs))) ttftTotal += Number(entry.ttftMs);
      if (Number.isFinite(Number(entry.tps))) tpsTotal += Number(entry.tps);
      if (entry.hitPct == null) continue;
      const hit = Number(entry.hitPct);
      if (!Number.isFinite(hit)) continue;
      hitTotal += hit;
      hitCount += 1;
      if (hit >= warmThreshold) warm += 1;
      if (hit <= coldThreshold) cold += 1;
    }
    const swaps = this.state.poolEvents.filter((entry) => entry.role === 'adopted');
    const revivals = this.state.poolEvents.filter((entry) => entry.role === 'revived');
    const lastSwapAt = swaps.reduce((max, entry) => Math.max(max, Number(entry.at) || 0), 0);
    return {
      window: { requests: REQUEST_LIMIT, poolEvents: POOL_EVENT_LIMIT },
      requests: {
        total: requests.length,
        measured: hitCount,
        avgHitPct: hitCount > 0 ? Math.round((hitTotal / hitCount) * 10) / 10 : null,
        warm,
        cold,
        avgTtftMs: requests.length > 0 ? Math.round((ttftTotal / requests.length) * 10) / 10 : null,
        avgTps: requests.length > 0 ? Math.round((tpsTotal / requests.length) * 100) / 100 : null,
      },
      pool: {
        swaps: swaps.length,
        revivals: revivals.length,
        lastSwapAt: lastSwapAt > 0 ? lastSwapAt : null,
      },
    };
  }

  recordSample(sessionId, sample, maxSamples) {
    const key = String(sessionId == null ? '' : sessionId);
    const clean = sanitizeMetric(sample);
    if (key === '' || !clean) return;
    const limit = Math.max(1, Math.round(Number(maxSamples) || 20));
    const list = Array.isArray(this.state.metrics[key]) ? this.state.metrics[key] : [];
    list.push(clean);
    this.state.metrics[key] = list.slice(-limit);
    // The route's samples follow the routing id, not the DSH session. They
    // are what the pool scores after a code moves to another session, so keep
    // a small copy on the route itself.
    const route = this.state.routes[key];
    if (route) {
      const routeSamples = Array.isArray(route.samples) ? route.samples : [];
      routeSamples.push(clean);
      route.samples = routeSamples.slice(-limit);
      if (route.awaitingFirstRequest === true) {
        route.firstRequestAt = clean.at;
        route.awaitingFirstRequest = false;
        if (route.reason === 'pool-adopted' || route.poolRole === 'adopted') {
          const event = this.state.poolEvents.find((item) => (
            item.role === 'adopted'
            && item.sessionId === key
            && Math.abs(Number(item.at) - Number(route.rotatedAt)) < 1000
          ));
          if (event && !event.firstRequest) event.firstRequest = { ...clean };
        }
      }
    }
    // Global request ring for the settings page's cache-hit log. The session
    // copy above is trimmed to maxSamples; this one keeps a wider recent view.
    this.state.requests.push({ sessionId: key, ...clean });
    if (this.state.requests.length > REQUEST_LIMIT) {
      this.state.requests = this.state.requests.slice(-REQUEST_LIMIT);
    }
    this.refreshHistoryForSession(key, false);
    this.touch();
  }

  /** Samples attached to one routing id, independent of the session holding it. */
  routeSamples(route) {
    if (!route || !Array.isArray(route.samples)) return [];
    return route.samples.map((sample) => ({ ...sample }));
  }

  samplesFor(sessionId) {
    const key = String(sessionId == null ? '' : sessionId);
    const list = key === '' ? null : this.state.metrics[key];
    return Array.isArray(list) ? list.map((sample) => ({ ...sample })) : [];
  }

  /**
   * Drop the session-level measurement window. Used when a session's routing id
   * changes hands: samples measured on the old code must not steer the cache
   * prediction for the adopted code (the route keeps its own code-bound copy).
   */
  clearSamples(sessionId) {
    const key = String(sessionId == null ? '' : sessionId);
    if (key === '' || !this.state.metrics[key]) return;
    delete this.state.metrics[key];
    this.touch();
  }

  touch() {
    this.state.updatedAt = this.now();
    this.dirty = true;
    this.schedulePersist();
  }

  schedulePersist() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, this.debounceMs);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  retryDelay() {
    const exponent = Math.min(Math.max(this.writeFailures - 1, 0), 16);
    return Math.min(this.retryMaxDelayMs, this.retryDelayMs * 2 ** exponent);
  }

  scheduleRetry() {
    if (this.disposed) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.flush().catch(() => {});
    }, this.retryDelay());
    if (this.retryTimer && typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
  }

  async removeTmpFile(tmp) {
    try {
      await this.fs.unlink(tmp);
    } catch {
      // Best effort: ENOENT after a successful rename is expected.
    }
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return this.chain;
    this.dirty = false;
    const target = this.statePath;
    const dir = path.dirname(target);
    this.chain = this.chain
      .then(async () => {
        let lastError = null;
        for (let attempt = 0; attempt < this.writeAttempts; attempt += 1) {
          const tmp = target + '.tmp-' + process.pid + '-' + Date.now() + '-' + attempt;
          try {
            // Serialize inside the attempt so a retry persists the newest state.
            await this.fs.mkdir(dir, { recursive: true });
            await this.fs.writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8');
            await this.fs.rename(tmp, target);
            this.lastWriteError = null;
            this.writeFailures = 0;
            if (this.retryTimer) {
              clearTimeout(this.retryTimer);
              this.retryTimer = null;
            }
            return;
          } catch (error) {
            lastError = error;
            await this.removeTmpFile(tmp);
          }
        }
        throw lastError;
      })
      .catch((error) => {
        this.dirty = true;
        this.lastWriteError = error;
        this.writeFailures += 1;
        this.warn(
          'state write failed: ' + String(error && error.message ? error.message : error)
            + '; retrying in ' + this.retryDelay() + 'ms',
        );
        this.scheduleRetry();
      });
    return this.chain;
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  async dispose() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    await this.flush();
    if (this.dirty) {
      // The first flush failed and left the state dirty; retry once inline
      // before teardown instead of dropping the write.
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      await this.flush();
    }
    this.disposed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

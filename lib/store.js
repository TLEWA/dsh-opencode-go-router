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

function emptyState() {
  return { version: STATE_VERSION, updatedAt: 0, routes: {}, metrics: {}, history: [] };
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

  recordSample(sessionId, sample, maxSamples) {
    const key = String(sessionId == null ? '' : sessionId);
    const clean = sanitizeMetric(sample);
    if (key === '' || !clean) return;
    const limit = Math.max(1, Math.round(Number(maxSamples) || 20));
    const list = Array.isArray(this.state.metrics[key]) ? this.state.metrics[key] : [];
    list.push(clean);
    this.state.metrics[key] = list.slice(-limit);
    this.refreshHistoryForSession(key, false);
    this.touch();
  }

  samplesFor(sessionId) {
    const key = String(sessionId == null ? '' : sessionId);
    const list = key === '' ? null : this.state.metrics[key];
    return Array.isArray(list) ? list.map((sample) => ({ ...sample })) : [];
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

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return this.chain;
    this.dirty = false;
    const payload = JSON.stringify(this.state, null, 2);
    const target = this.statePath;
    const dir = path.dirname(target);
    this.chain = this.chain
      .then(async () => {
        await fsp.mkdir(dir, { recursive: true });
        const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
        await fsp.writeFile(tmp, payload, 'utf8');
        await fsp.rename(tmp, target);
      })
      .catch((error) => {
        this.dirty = true;
        this.warn('state write failed: ' + String(error && error.message ? error.message : error));
      });
    return this.chain;
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  async dispose() {
    try {
      await this.flush();
    } catch {
      // Best effort.
    }
  }
}

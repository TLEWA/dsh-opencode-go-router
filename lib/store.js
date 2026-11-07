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

function emptyState() {
  return { version: STATE_VERSION, updatedAt: 0, routes: {}, metrics: {} };
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
    cacheHitPct: finiteOrNull(entry.cacheHitPct),
    avgTtftMs: finiteOrNull(entry.avgTtftMs),
    avgTps: finiteOrNull(entry.avgTps),
  };
}

function sanitizeMetric(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const ttftMs = finiteOrNull(entry.ttftMs);
  const tps = finiteOrNull(entry.tps);
  const outputTokens = finiteOrNull(entry.outputTokens);
  const at = finiteOrNull(entry.at);
  if (ttftMs == null || ttftMs < 0 || tps == null || tps <= 0) return null;
  return {
    ttftMs,
    tps,
    outputTokens: outputTokens == null ? 0 : outputTokens,
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
  return state;
}

export class RouterStore {
  constructor(options) {
    const opts = options || {};
    this.statePath = opts.statePath;
    this.logger = opts.logger || console;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.debounceMs = Number.isFinite(Number(opts.debounceMs)) ? Number(opts.debounceMs) : 150;
    this.state = this.load();
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

  recordSample(sessionId, sample, maxSamples) {
    const key = String(sessionId == null ? '' : sessionId);
    const clean = sanitizeMetric(sample);
    if (key === '' || !clean) return;
    const limit = Math.max(1, Math.round(Number(maxSamples) || 20));
    const list = Array.isArray(this.state.metrics[key]) ? this.state.metrics[key] : [];
    list.push(clean);
    this.state.metrics[key] = list.slice(-limit);
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

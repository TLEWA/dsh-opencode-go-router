/**
 * Session monitor: follows the billion-context state file for one DSH session,
 * detects new fold rebuilds, and rotates the OpenCode routing id when the
 * latest rebuild lost the prefix cache and recent requests are slow.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  biliSessionKey,
  biliSessionsRoot,
  biliStatePathCandidates,
  decideRotation,
  extractFolds,
  maxFoldSeq,
  newRoutingId,
  round1,
  summarizeSamples,
} from './core.js';

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function scanForStateFile(root, key) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const dir of dirs) {
    let names;
    try {
      names = await fsp.readdir(path.join(root, dir));
    } catch {
      continue;
    }
    const hit = names.find((name) => name.endsWith(key + '.json'));
    if (hit) return path.join(root, dir, hit);
  }
  return null;
}

function errorText(error) {
  if (error && typeof error.message === 'string') return error.message;
  return String(error);
}

export class SessionMonitor {
  constructor(options) {
    const opts = options || {};
    this.sessionId = String(opts.sessionId);
    this.config = opts.config;
    this.store = opts.store;
    this.logger = opts.logger || console;
    this.onRotate = typeof opts.onRotate === 'function' ? opts.onRotate : null;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.filePath = null;
    this.lastStatKey = null;
    this.baselineReady = false;
    this.lastFoldSeq = null;
    this.latestFold = null;
    this.folds = [];
    this.ledgerSeen = false;
    this.lastRequestAt = 0;
    this.lastTickAt = 0;
    this.lastError = null;
    this.rotations = 0;
    this.ticking = null;
    this.timers = new Set();
    this.lastResolveAt = 0;
    this.resolveBackoffUntil = 0;
    /**
     * billion-context keys its state file by its own conversation identity,
     * which is stable for a DSH session and is NOT changed by rotating
     * x-opencode-session. The rotated header only selects the upstream backend;
     * it does not open a new billion-context conversation. Keep watching the
     * same DSH session state file across rotations so later folds remain visible.
     */
    this.watchedIdentity = this.sessionId;
  }

  debug(line) {
    if (!this.config.debug) return;
    try {
      if (this.logger && typeof this.logger.info === 'function') this.logger.info('[opencode-router] ' + line);
    } catch {
      // Ignore logging failures.
    }
  }

  warn(line) {
    try {
      if (this.logger && typeof this.logger.warn === 'function') this.logger.warn('[opencode-router] ' + line);
    } catch {
      // Ignore logging failures.
    }
  }

  touch() {
    this.lastRequestAt = this.now();
  }

  scheduleRefresh(delays) {
    const list = Array.isArray(delays) ? delays : [];
    for (const raw of list) {
      const delay = Math.max(0, Number(raw) || 0);
      const fire = () => {
        this.timers.delete(timer);
        this.tick().catch(() => {});
      };
      const timer = setTimeout(fire, delay);
      if (timer && typeof timer.unref === 'function') timer.unref();
      this.timers.add(timer);
    }
  }

  async resolveFile() {
    const identity = this.sessionId;
    if (this.filePath && await exists(this.filePath)) return this.filePath;
    if (this.filePath) {
      this.filePath = null;
      this.lastStatKey = null;
      this.baselineReady = false;
      this.lastFoldSeq = null;
    }
    const now = this.now();
    if (now < this.resolveBackoffUntil) return null;
    if (now - this.lastResolveAt < 1000) return null;
    this.lastResolveAt = now;

    for (const candidate of biliStatePathCandidates(identity, this.config)) {
      if (await exists(candidate)) {
        this.filePath = candidate;
        return candidate;
      }
    }
    const discovered = await scanForStateFile(biliSessionsRoot(this.config), biliSessionKey(identity));
    if (discovered) {
      this.filePath = discovered;
      return discovered;
    }
    this.resolveBackoffUntil = now + 2000;
    return null;
  }

  tick() {
    if (this.ticking) return this.ticking;
    this.ticking = this.tickOnce()
      .catch((error) => {
        this.lastError = errorText(error);
        this.warn('monitor tick failed: ' + this.lastError);
      })
      .finally(() => {
        this.ticking = null;
      });
    return this.ticking;
  }

  async tickOnce() {
    this.lastTickAt = this.now();
    const filePath = await this.resolveFile();
    if (!filePath) return;
    this.filePath = filePath;

    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch (error) {
      this.lastError = 'stat: ' + errorText(error);
      this.filePath = null;
      this.lastStatKey = null;
      this.baselineReady = false;
      this.lastFoldSeq = null;
      return;
    }
    const statKey = String(stat.mtimeMs) + ':' + String(stat.size);
    if (statKey === this.lastStatKey && this.baselineReady) return;
    this.lastStatKey = statKey;

    let json;
    try {
      json = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    } catch (error) {
      this.lastStatKey = null;
      this.lastError = 'parse: ' + errorText(error);
      this.warn('state file parse failed: ' + this.lastError);
      return;
    }

    const root = json && typeof json === 'object' && json.payload ? json.payload : json;
    this.ledgerSeen = Boolean(root && root.metadata && root.metadata.cacheLedger);
    const folds = extractFolds(json);
    const maxSeq = maxFoldSeq(folds);

    this.folds = folds;
    this.latestFold = folds.length > 0 ? folds[folds.length - 1] : null;
    this.lastError = null;

    if (!this.baselineReady) {
      this.baselineReady = true;
      this.lastFoldSeq = maxSeq;
      this.debug('baseline session=' + this.sessionId + ' lastFoldSeq=' + maxSeq + ' folds=' + folds.length);
      return;
    }

    if (maxSeq < this.lastFoldSeq) {
      this.warn('fold sequence went backwards for ' + this.sessionId + ' (' + this.lastFoldSeq + ' -> ' + maxSeq + '); rebaselining');
      this.lastFoldSeq = maxSeq;
      return;
    }
    if (maxSeq === this.lastFoldSeq) return;

    const firstNew = folds.find((fold) => fold.seq > this.lastFoldSeq);
    if (!firstNew) {
      this.lastFoldSeq = maxSeq;
      return;
    }
    const previous = folds.filter((fold) => fold.seq < firstNew.seq);
    const samples = this.store.samplesFor(this.sessionId);
    const decision = decideRotation({
      previousFolds: previous,
      samples,
      config: this.config,
    });

    if (decision.rotate) {
      this.rotate(firstNew, decision);
      // The state file does not change on rotation, so mark this fold as seen
      // and keep the same file/baseline. Otherwise later writes with the same
      // fold list would rotate again for the same rebuild.
      this.lastFoldSeq = maxSeq;
      return;
    }
    this.debug(
      'new fold #' + firstNew.seq + ' but no rotation: ' + decision.reason
      + ' cache=' + decision.cache.reason
      + ' perf=' + (decision.performance ? decision.performance.reason : 'n/a'),
    );
    this.lastFoldSeq = maxSeq;
  }

  rotate(fold, decision) {
    const existing = this.store.routeFor(this.sessionId);
    if (existing && this.config.minRotationGapMs > 0) {
      const rotatedAt = Number(existing.rotatedAt) || 0;
      if (this.now() - rotatedAt < this.config.minRotationGapMs) {
        this.debug('rotation skipped by cooldown for ' + this.sessionId);
        return;
      }
    }
    const value = newRoutingId(this.config.routingIdPrefix);
    const recentHit = decision.cache.recent.length > 0
      ? decision.cache.recent[decision.cache.recent.length - 1].hPct
      : null;
    const record = {
      value,
      rotatedAt: this.now(),
      foldSeq: fold.seq,
      reason: decision.reason,
      cacheHitPct: recentHit,
      avgTtftMs: decision.performance ? round1(decision.performance.avgTtftMs) : null,
      avgTps: decision.performance ? round1(decision.performance.avgTps) : null,
    };
    if (!this.config.dryRun) {
      this.store.setRoute(this.sessionId, record);
    }
    this.rotations += 1;
    const message = 'rotated x-opencode-session for ' + this.sessionId
      + ' at fold #' + fold.seq
      + ' (cache ' + (recentHit == null ? 'n/a' : recentHit + '%')
      + ', avg TTFT ' + (record.avgTtftMs == null ? 'n/a' : record.avgTtftMs + 'ms')
      + ', avg ' + (record.avgTps == null ? 'n/a' : record.avgTps + ' tok/s')
      + ')' + (this.config.dryRun ? ' [dry-run]' : '');
    this.warn(message);
    if (this.onRotate) {
      try {
        this.onRotate({ sessionId: this.sessionId, record, fold, decision, dryRun: this.config.dryRun });
      } catch {
        // A status listener must not break rotation.
      }
    }
  }

  status() {
    const perf = summarizeSamples(this.store.samplesFor(this.sessionId), this.config.sampleSize);
    return {
      sessionId: this.sessionId,
      stateFile: this.filePath,
      ledgerSeen: this.ledgerSeen,
      baselineReady: this.baselineReady,
      lastFoldSeq: this.lastFoldSeq,
      latestFold: this.latestFold,
      foldsSeen: this.folds.length,
      // Informational only: billion-context's state file is keyed by the DSH
      // session id, not by the rotated x-opencode-session value.
      watchingId: this.sessionId,
      route: this.store.routeFor(this.sessionId),
      samples: perf,
      rotations: this.rotations,
      lastRequestAt: this.lastRequestAt,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
    };
  }

  dispose() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.ticking = null;
  }
}

export class RouterMonitor {
  constructor(options) {
    const opts = options || {};
    this.config = opts.config;
    this.store = opts.store;
    this.logger = opts.logger || console;
    this.onRotate = typeof opts.onRotate === 'function' ? opts.onRotate : null;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.monitors = new Map();
    this.timer = null;
  }

  ensure(sessionId) {
    const key = String(sessionId == null ? '' : sessionId);
    if (key === '') return null;
    let monitor = this.monitors.get(key);
    if (!monitor) {
      monitor = new SessionMonitor({
        sessionId: key,
        config: this.config,
        store: this.store,
        logger: this.logger,
        onRotate: this.onRotate,
        now: this.now,
      });
      this.monitors.set(key, monitor);
    }
    return monitor;
  }

  noteRequestFinished(sessionId) {
    const monitor = this.ensure(sessionId);
    if (!monitor) return;
    monitor.touch();
    monitor.scheduleRefresh(this.config.requestCheckDelaysMs);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tickActive().catch(() => {});
    }, this.config.pollIntervalMs);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  async tickActive() {
    const now = this.now();
    for (const monitor of this.monitors.values()) {
      if (now - monitor.lastRequestAt <= this.config.sessionActiveMs) {
        await monitor.tick();
      }
    }
  }

  async tickAll() {
    for (const monitor of this.monitors.values()) await monitor.tick();
  }

  status() {
    return [...this.monitors.values()].map((monitor) => monitor.status());
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const monitor of this.monitors.values()) monitor.dispose();
    this.monitors.clear();
  }
}

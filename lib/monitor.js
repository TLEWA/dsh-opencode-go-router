/**
 * Session monitor: follows the billion-context fold ledger for one DSH session
 * (diagnostics only) and decides, before every outgoing request, whether that
 * request is expected to miss the upstream prefix cache. When it is expected
 * to miss and recent requests are slow, the routing id is rotated first, so
 * the new upstream builds the cache for this very request instead of the
 * switch adding one more cold prefill.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  VERSION,
  biliSessionKey,
  biliSessionsRoot,
  biliStatePathCandidates,
  consecutiveFailedSwitches,
  extractFolds,
  maxFoldSeq,
  newRoutingId,
  performanceCondition,
  predictCacheHit,
  rotationThresholds,
  round1,
  summarizeSamples,
  systemPromptFingerprint,
} from './core.js';

// billion-context is optional. Probe its sessions root at most once per 30s
// so a missing install costs one stat, not a candidate loop plus directory
// scan on every tick.
let biliProbe = { at: 0, root: '', detected: false };

function billionContextDetected(config, now) {
  const root = biliSessionsRoot(config);
  if (biliProbe.root === root && now - biliProbe.at < 30000) return biliProbe.detected;
  let detected = false;
  try {
    detected = fs.existsSync(root);
  } catch {
    detected = false;
  }
  biliProbe = { at: now, root, detected };
  return detected;
}

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
    this.pool = opts.pool || null;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.filePath = null;
    this.lastStatKey = null;
    this.baselineReady = false;
    this.lastFoldSeq = null;
    this.latestFold = null;
    this.folds = [];
    this.ledgerSeen = false;
    this.lastRequestAt = 0;
    // Last request lookup, completed request or tick. RouterMonitor prunes on
    // this value, so a freshly created monitor is never treated as ancient.
    this.lastActiveAt = this.now();
    this.lastTickAt = 0;
    this.lastError = null;
    this.rotations = 0;
    this.predictions = 0;
    this.lastPrediction = null;
    this.lastPool = null;
    this.lastDigest = null;
    this.lastSystemPromptFp = null;
    this.lastMessageCount = null;
    // The latest ordinary conversation request was an eligible OpenCode Go
    // DeepSeek-series request. A non-target request clears this until the
    // conversation switches back; default true is safe because the monitor is
    // created from a target stream/header and the header hook updates it.
    this.targetActive = true;
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
    const now = this.now();
    this.lastRequestAt = now;
    this.lastActiveAt = now;
  }

  /** Record a request-side lookup without claiming a finished request. */
  markActive(at) {
    const now = Number.isFinite(at) ? at : this.now();
    this.lastActiveAt = now;
  }

  setTargetActive(active) {
    const next = active === true;
    if (this.targetActive === next) return;
    this.targetActive = next;
    this.debug('target model ' + (next ? 'eligible' : 'not eligible') + ' for ' + this.sessionId);
  }

  /**
   * Consecutive silent switches whose completed after-window is still below
   * the base targets. In-flight windows do not count yet. The value widens
   * the thresholds for the next rotation decision.
   */
  failureStep() {
    try {
      return consecutiveFailedSwitches(this.store.history(), this.sessionId, this.config);
    } catch {
      return 0;
    }
  }

  /**
   * Persist one row for the settings page: the slow samples that justified the
   * switch and, later, the first samples on the new upstream.
   */
  recordRotationHistory(record, performance) {
    if (this.config.dryRun) return null;
    try {
      return this.store.addRotation({
        sessionId: this.sessionId,
        at: record.rotatedAt,
        value: record.value,
        reason: record.reason,
        basis: record.basis,
        foldSeq: record.foldSeq,
        cacheHitPct: record.cacheHitPct,
        step: record.step,
        beforeTtftMs: record.avgTtftMs,
        beforeTps: record.avgTps,
        beforeSamples: performance && Number.isFinite(performance.count) ? performance.count : this.config.sampleSize,
        afterTarget: this.config.sampleSize,
        // What gate this switch actually used. Older rows have no thresholds;
        // the settings page labels them as legacy instead of guessing.
        version: VERSION,
        thresholds: performance && performance.thresholds
          ? {
              step: performance.thresholds.step,
              baseTtftThresholdMs: performance.thresholds.baseTtftThresholdMs,
              baseThroughputThresholdTps: performance.thresholds.baseThroughputThresholdTps,
              effectiveTtftThresholdMs: performance.thresholds.effectiveTtftThresholdMs,
              effectiveThroughputThresholdTps: performance.thresholds.effectiveThroughputThresholdTps,
            }
          : null,
      });
    } catch (error) {
      this.warn('failed to record rotation history: ' + errorText(error));
      return null;
    }
  }

  rotationGapBlocked() {
    if (!(this.config.minRotationGapMs > 0)) return false;
    const existing = this.store.routeFor(this.sessionId);
    if (!existing) return false;
    const rotatedAt = Number(existing.rotatedAt) || 0;
    return this.now() - rotatedAt < this.config.minRotationGapMs;
  }

  /**
   * Called immediately before a target request is sent (after the request's
   * system prompt and message list are known). Predicts the cache hit of this
   * request and, when it is expected to miss while recent requests are slow,
   * rotates the routing id now so the switch applies to this very request.
   */
  prepareRequest(input) {
    const opts = input && typeof input === 'object' ? input : {};
    const now = this.now();
    this.lastDigest = opts.digest || null;

    // The pool runs first: a new or reviving session may take a warm routing
    // id from a sleeping session, and that decision must apply to this very
    // request. Adopted/revived requests skip the cold-cache rotation below.
    let poolResult = null;
    if (this.pool && this.config.poolEnabled) {
      try {
        poolResult = this.pool.prepareRoute({
          sessionId: this.sessionId,
          digest: opts.digest,
          now,
        });
      } catch (error) {
        this.warn('routing id pool failed: ' + errorText(error));
      }
    }
    this.lastPool = poolResult;

    const fingerprint = systemPromptFingerprint(opts.systemPrompt == null ? '' : opts.systemPrompt);
    const previousFp = this.lastSystemPromptFp;
    const systemChanged = previousFp != null && previousFp !== fingerprint;
    this.lastSystemPromptFp = fingerprint;
    if (systemChanged) {
      this.debug('system prompt changed for ' + this.sessionId + ' (' + previousFp + ' -> ' + fingerprint + ')');
    }

    const count = Number(opts.messageCount);
    const messageCount = Number.isFinite(count) && count >= 0 ? Math.round(count) : null;
    const previousCount = this.lastMessageCount;
    const historyShrank = previousCount != null && messageCount != null && messageCount < previousCount;
    this.lastMessageCount = messageCount;

    const idleMs = this.lastRequestAt > 0 ? Math.max(0, now - this.lastRequestAt) : 0;
    const samples = this.store.samplesFor(this.sessionId);
    const lastSample = samples.length > 0 ? samples[samples.length - 1] : null;
    const foldEvidence = Boolean(
      this.latestFold && lastSample && Number(this.latestFold.at) >= Number(lastSample.at || 0),
    );
    const prediction = predictCacheHit({
      samples,
      config: this.config,
      systemChanged,
      historyShrank,
      idleMs,
      foldEvidence,
    });
    const performance = performanceCondition(samples, this.config, this.failureStep());
    const step = performance.thresholds ? performance.thresholds.step : 0;
    const result = {
      at: now,
      basis: prediction.basis,
      expectedPct: prediction.expectedPct,
      cold: prediction.cold,
      idleMs: prediction.idleMs,
      systemChanged,
      historyShrank,
      samples: samples.length,
      lastHitPct: prediction.lastHitPct,
      performance: {
        bad: performance.bad,
        reason: performance.reason,
        count: performance.count,
        avgTtftMs: performance.avgTtftMs == null ? null : round1(performance.avgTtftMs),
        avgTps: performance.avgTps == null ? null : round1(performance.avgTps),
      },
      step,
      rotated: false,
      skipReason: null,
      pool: poolResult ? {
        action: poolResult.action,
        matchPct: poolResult.matchPct == null ? null : round1(poolResult.matchPct),
        tier: poolResult.tier == null ? null : poolResult.tier,
        score: poolResult.score == null ? null : round1(poolResult.score),
        sourceSessionId: poolResult.sourceSessionId || null,
      } : null,
    };
    this.predictions += 1;

    if (poolResult && poolResult.skipPrediction === true) result.skipReason = 'pool-' + poolResult.action;
    else if (!this.config.predictiveRotation) result.skipReason = 'predictive-rotation-off';
    else if (!prediction.cold) result.skipReason = 'cache-expected-warm';
    else if (this.targetActive !== true) result.skipReason = 'not-target';
    else if (this.rotationGapBlocked()) result.skipReason = 'cooldown';
    else if (!performance.bad) result.skipReason = 'performance-ok';
    else {
      const record = this.rotateNow(prediction, performance);
      if (record) {
        result.rotated = true;
        result.route = record.value;
      }
    }
    this.lastPrediction = result;
    if (!result.rotated && result.skipReason !== 'cache-expected-warm') {
      this.debug(
        'no rotation for ' + this.sessionId + ': ' + result.skipReason
        + ' (basis ' + result.basis
        + ', expected ' + (result.expectedPct == null ? 'n/a' : result.expectedPct + '%')
        + ', step ' + step + ')',
      );
    }
    return result;
  }

  rotateNow(prediction, performance) {
    const step = performance && performance.thresholds ? performance.thresholds.step : 0;
    const now = this.now();
    const digest = this.lastDigest || { chunks: [], chars: 0 };
    const record = {
      value: newRoutingId(this.config.routingIdPrefix),
      rotatedAt: now,
      foldSeq: maxFoldSeq(this.folds) || null,
      reason: 'predicted-cold',
      basis: prediction.basis,
      cacheHitPct: prediction.expectedPct,
      step,
      avgTtftMs: performance && performance.avgTtftMs != null ? round1(performance.avgTtftMs) : null,
      avgTps: performance && performance.avgTps != null ? round1(performance.avgTps) : null,
      // The new code starts its own pool digest/sample history with the
      // request that caused the rotation.
      digest: Array.isArray(digest.chunks) ? digest.chunks : [],
      digestChars: Number(digest.chars) || 0,
      digestUpdatedAt: now,
      lastActiveAt: now,
      generatedAt: now,
      pooledAt: null,
      sleepingAt: null,
      samples: [],
    };
    if (!this.config.dryRun) {
      this.store.setRoute(this.sessionId, record);
      this.recordRotationHistory(record, performance);
    }
    this.rotations += 1;
    this.warn(
      'rotated x-opencode-session for ' + this.sessionId
      + ' before a request predicted to miss the cache ('
      + prediction.basis
      + ', expected ' + (record.cacheHitPct == null ? 'n/a' : record.cacheHitPct + '%')
      + ', step ' + step
      + ', avg TTFT ' + (record.avgTtftMs == null ? 'n/a' : record.avgTtftMs + 'ms')
      + ', avg ' + (record.avgTps == null ? 'n/a' : record.avgTps + 'tok/s')
      + ')' + (this.config.dryRun ? ' [dry-run]' : ''),
    );
    if (this.onRotate) {
      try {
        this.onRotate({
          sessionId: this.sessionId,
          record,
          prediction,
          performance,
          dryRun: this.config.dryRun,
        });
      } catch {
        // A status listener must not break rotation.
      }
    }
    return record;
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
    // Without billion-context there is no fold ledger to follow. Skip the
    // candidate loop and directory scan; measurements still flow from the
    // plugin's own request sampling.
    if (!billionContextDetected(this.config, now)) return null;
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

  /**
   * Follow the fold ledger. Folds are diagnostic evidence for the prediction
   * (a rebuild explains a large cold request); rotation itself is decided per
   * request in prepareRequest().
   */
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
    if (firstNew) {
      this.debug(
        'new fold #' + firstNew.seq + ' for ' + this.sessionId
        + ' (hit ' + (firstNew.hPct == null ? 'n/a' : firstNew.hPct + '%') + ')',
      );
    }
    this.lastFoldSeq = maxSeq;
  }

  status() {
    const samples = this.store.samplesFor(this.sessionId);
    const perf = summarizeSamples(samples, this.config.sampleSize);
    const thresholds = rotationThresholds(this.config, this.failureStep());
    const lastSample = samples.length > 0 ? samples[samples.length - 1] : null;
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
      targetActive: this.targetActive,
      systemPromptFp: this.lastSystemPromptFp,
      messageCount: this.lastMessageCount,
      predictiveRotation: this.config.predictiveRotation,
      cacheHitThresholdPct: this.config.cacheHitThresholdPct,
      cacheTtlMs: this.config.cacheTtlMs,
      lastPrediction: this.lastPrediction,
      lastPool: this.lastPool,
      predictions: this.predictions,
      lastSample,
      stepping: {
        ...thresholds,
        consecutiveFailures: thresholds.step,
      },
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
    this.pool = opts.pool || null;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.monitors = new Map();
    this.timer = null;
  }

  ensure(sessionId) {
    const key = String(sessionId == null ? '' : sessionId);
    if (key === '') return null;
    const now = this.now();
    let monitor = this.monitors.get(key);
    if (!monitor) {
      monitor = new SessionMonitor({
        sessionId: key,
        config: this.config,
        store: this.store,
        logger: this.logger,
        onRotate: this.onRotate,
        pool: this.pool,
        now: this.now,
      });
      // A fresh process has no in-memory lastRequestAt; restore the idle
      // baseline from the persisted route/samples so an overnight gap still
      // expires the cache on the first request after a restart.
      const samples = this.store.samplesFor(key);
      const lastSample = samples.length > 0 ? samples[samples.length - 1] : null;
      const route = this.store.routeFor(key);
      const restoredAt = Math.max(
        Number(route && route.lastActiveAt) || 0,
        Number(lastSample && lastSample.at) || 0,
      );
      if (restoredAt > 0) monitor.lastRequestAt = restoredAt;
      this.monitors.set(key, monitor);
    }
    monitor.markActive(now);
    return monitor;
  }

  noteRequestModel(sessionId, target) {
    const key = String(sessionId == null ? '' : sessionId);
    if (key === '') return;
    if (target === true) {
      this.ensure(key).setTargetActive(true);
      return;
    }
    const monitor = this.monitors.get(key);
    if (monitor) monitor.setTargetActive(false);
  }

  prepareRequest(sessionId, input) {
    const monitor = this.ensure(sessionId);
    if (!monitor) return null;
    return monitor.prepareRequest(input);
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

  /** When this monitor last proved that its session still exists. */
  lastSeenAt(monitor) {
    return Math.max(
      Number(monitor.lastActiveAt) || 0,
      Number(monitor.lastRequestAt) || 0,
      Number(monitor.lastTickAt) || 0,
    );
  }

  drop(key, monitor) {
    try {
      monitor.dispose();
    } catch {
      // A failing monitor must never block eviction.
    }
    this.monitors.delete(key);
  }

  /**
   * Bound the monitor map. Sessions idle beyond monitorTtlMs are dropped, and
   * the oldest idle monitors are dropped until the map fits monitorLimit. A
   * session still inside the active window is never evicted: dropping its fold
   * baseline or prediction history would change live routing decisions, so the
   * cap only applies to idle entries.
   */
  prune(now = this.now()) {
    let removed = 0;
    for (const [key, monitor] of this.monitors) {
      if (now - this.lastSeenAt(monitor) > this.config.monitorTtlMs) {
        this.drop(key, monitor);
        removed += 1;
      }
    }
    const limit = Math.max(1, Math.round(Number(this.config.monitorLimit) || 1));
    if (this.monitors.size > limit) {
      const oldestFirst = [...this.monitors.entries()]
        .sort((a, b) => this.lastSeenAt(a[1]) - this.lastSeenAt(b[1]));
      for (const [key, monitor] of oldestFirst) {
        if (this.monitors.size <= limit) break;
        if (now - this.lastSeenAt(monitor) <= this.config.sessionActiveMs) break;
        this.drop(key, monitor);
        removed += 1;
      }
    }
    return removed;
  }

  async tickActive() {
    const now = this.now();
    this.prune(now);
    for (const monitor of this.monitors.values()) {
      if (now - monitor.lastRequestAt <= this.config.sessionActiveMs) {
        await monitor.tick();
      }
    }
    if (this.pool) {
      try {
        this.pool.tick(now);
      } catch (error) {
        this.logger.warn('[opencode-router] pool tick failed: ' + errorText(error));
      }
    }
  }

  async tickAll() {
    for (const monitor of this.monitors.values()) await monitor.tick();
    if (this.pool) this.pool.tick(this.now());
  }

  status() {
    // The status route must not advertise sessions whose monitor is gone, even
    // when the polling timer has not run yet (disabled plugin, idle host).
    this.prune(this.now());
    return [...this.monitors.values()].map((monitor) => monitor.status());
  }

  billionContextStatus() {
    return {
      detected: billionContextDetected(this.config, this.now()),
      root: biliSessionsRoot(this.config),
    };
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const monitor of this.monitors.values()) monitor.dispose();
    this.monitors.clear();
  }
}

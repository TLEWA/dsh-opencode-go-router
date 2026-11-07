/**
 * opencode-router - pure decision helpers.
 *
 * The plugin watches the billion-context fold ledger for the current DSH
 * session. A fold is a context-compression rebuild; its hPct is the cache-hit
 * percentage of the request sent immediately after that rebuild. When the
 * latest fold(s) lost the reusable prefix cache and recent calls are slow, we
 * defer a rotation of the OpenCode routing id (x-opencode-session) until a
 * request that is already going to be cold (a system-prompt rewrite or a long
 * idle gap), so the switch does not add another cold prefill.
 */

import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const NAME = 'opencode-router';
export const VERSION = '0.4.0';

/**
 * Only OpenCode Go's DeepSeek-series models are eligible. The check is a
 * case-insensitive prefix match so new DeepSeek model ids keep working; an
 * exact allow-list can still narrow it through config.models.
 */
export const TARGET_MODEL_PREFIX = 'deepseek';

/** Chunks that represent actual model output for TTFT purposes. */
export const CONTENT_CHUNK_TYPES = new Set([
  'text-delta',
  'reasoning-delta',
  'tool-call-delta',
  'block-end',
]);

export const DEFAULTS = Object.freeze({
  enabled: true,
  providers: Object.freeze(['opencode-go']),
  models: Object.freeze([]),
  cacheHitThresholdPct: 25,
  foldsWindow: 1,
  systemRewriteBypassCache: true,
  // 'defer' waits for a request that is already going to be cold (a system
  // prompt rewrite or an idle gap) before switching upstream. billion-context
  // records a fold only after the rebuild request has completed, so an
  // immediate switch always pays one extra cold prefill. 'immediate' restores
  // the old behaviour; 'off' never rotates because of a fold.
  foldRotationMode: 'defer',
  foldDeferIdleMs: 300000,
  foldDeferMaxMs: 0,
  foldDeferMaxRequests: 0,
  ttftThresholdMs: 12000,
  throughputThresholdTps: 60,
  // Consecutive failed replacements make the next trigger more tolerant:
  // each completed post-switch window that is still slower than the base
  // thresholds adds this much grace. A successful window resets the step.
  stepTtftGraceMs: 2000,
  stepThroughputGraceTps: 5,
  sampleSize: 5,
  requireFullSamples: true,
  routingIdPrefix: 'ses_',
  pollIntervalMs: 2000,
  requestCheckDelaysMs: Object.freeze([400, 1500]),
  biliSessionsDir: null,
  biliProtocol: 'openai',
  biliUpstreamHost: 'opencode.ai',
  statePath: null,
  // Local loopback endpoint consumed by the optional billion-context pre-fold
  // patch. It lets the proxy ask for a route rotation after deciding to
  // rebuild and before sending the rebuild request, so the unavoidable cold
  // prefill and the route switch share one request instead of two.
  preFoldHook: true,
  preFoldHookPath: null,
  dryRun: false,
  debug: false,
  overrideExistingHeader: true,
  maxSamples: 20,
  sessionActiveMs: 600000,
  minRotationGapMs: 0,
});

function numberInRange(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function stringList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const out = value
    .map((entry) => String(entry == null ? '' : entry).trim())
    .filter((entry) => entry.length > 0);
  return out.length > 0 ? out : [...fallback];
}

export function expandHome(value) {
  const raw = String(value == null ? '' : value).trim();
  if (raw === '') return '';
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return path.resolve(raw);
}

export function dshHome(env = process.env) {
  if (env && typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '') {
    return path.resolve(env.DSH_HOME);
  }
  return path.join(os.homedir(), '.dsh');
}

export function defaultStatePath() {
  return path.join(dshHome(), 'storages', 'opencode-router', 'state.json');
}

export function defaultPreFoldHookPath() {
  return path.join(dshHome(), 'storages', 'opencode-router', 'pre-fold-hook.json');
}

export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: source.enabled !== false,
    providers: stringList(source.providers, DEFAULTS.providers),
    models: stringList(source.models, DEFAULTS.models),
    cacheHitThresholdPct: numberInRange(source.cacheHitThresholdPct, DEFAULTS.cacheHitThresholdPct, 0, 100),
    foldsWindow: Math.round(numberInRange(source.foldsWindow, DEFAULTS.foldsWindow, 1, 20)),
    systemRewriteBypassCache: source.systemRewriteBypassCache !== false,
    foldRotationMode: ['immediate', 'defer', 'off'].includes(String(source.foldRotationMode || '').toLowerCase())
      ? String(source.foldRotationMode).toLowerCase()
      : DEFAULTS.foldRotationMode,
    foldDeferIdleMs: numberInRange(source.foldDeferIdleMs, DEFAULTS.foldDeferIdleMs, 0, 86400000),
    foldDeferMaxMs: numberInRange(source.foldDeferMaxMs, DEFAULTS.foldDeferMaxMs, 0, 86400000),
    foldDeferMaxRequests: Math.round(numberInRange(source.foldDeferMaxRequests, DEFAULTS.foldDeferMaxRequests, 0, 10000)),
    ttftThresholdMs: numberInRange(source.ttftThresholdMs, DEFAULTS.ttftThresholdMs, 1, 3600000),
    throughputThresholdTps: numberInRange(source.throughputThresholdTps, DEFAULTS.throughputThresholdTps, 0.01, 1000000),
    stepTtftGraceMs: numberInRange(source.stepTtftGraceMs, DEFAULTS.stepTtftGraceMs, 0, 3600000),
    stepThroughputGraceTps: numberInRange(source.stepThroughputGraceTps, DEFAULTS.stepThroughputGraceTps, 0, 1000000),
    sampleSize: Math.round(numberInRange(source.sampleSize, DEFAULTS.sampleSize, 1, 50)),
    requireFullSamples: source.requireFullSamples !== false,
    routingIdPrefix: String(source.routingIdPrefix == null ? DEFAULTS.routingIdPrefix : source.routingIdPrefix),
    pollIntervalMs: numberInRange(source.pollIntervalMs, DEFAULTS.pollIntervalMs, 250, 60000),
    requestCheckDelaysMs: Array.isArray(source.requestCheckDelaysMs)
      ? source.requestCheckDelaysMs
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n >= 0)
          .slice(0, 8)
      : [...DEFAULTS.requestCheckDelaysMs],
    biliSessionsDir: source.biliSessionsDir ? expandHome(source.biliSessionsDir) : null,
    biliProtocol: String(source.biliProtocol == null ? DEFAULTS.biliProtocol : source.biliProtocol),
    biliUpstreamHost: String(source.biliUpstreamHost == null ? DEFAULTS.biliUpstreamHost : source.biliUpstreamHost),
    statePath: source.statePath ? expandHome(source.statePath) : defaultStatePath(),
    preFoldHook: source.preFoldHook !== false,
    preFoldHookPath: source.preFoldHookPath ? expandHome(source.preFoldHookPath) : defaultPreFoldHookPath(),
    dryRun: source.dryRun === true,
    debug: source.debug === true,
    overrideExistingHeader: source.overrideExistingHeader !== false,
    maxSamples: Math.round(numberInRange(source.maxSamples, DEFAULTS.maxSamples, 1, 500)),
    sessionActiveMs: numberInRange(source.sessionActiveMs, DEFAULTS.sessionActiveMs, 1000, 86400000),
    minRotationGapMs: numberInRange(source.minRotationGapMs, DEFAULTS.minRotationGapMs, 0, 86400000),
  };
}

export function isDeepSeekModel(model) {
  return String(model == null ? '' : model).trim().toLowerCase().startsWith(TARGET_MODEL_PREFIX);
}

export function isTargetRequest(options, config) {
  if (!options || typeof options !== 'object' || !config.enabled) return false;
  const provider = String(options.provider == null ? '' : options.provider);
  if (!config.providers.includes(provider)) return false;
  const model = String(options.model == null ? '' : options.model).trim();
  if (!isDeepSeekModel(model)) return false;
  if (config.models.length > 0 && !config.models.includes(model)) return false;
  return true;
}

/**
 * Join the text blocks of a harness message, mirroring pi-ai's flattenText.
 * System messages are text-only, but tolerate the string form for tests and
 * future adapters.
 */
function flattenSystemMessage(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/**
 * Reproduce the initial system prompt that pi-ai assembles for a request:
 * options.system followed by leading role=system history messages, joined by
 * a blank line. Developer messages emitted mid-conversation are not part of
 * this initial prompt and are intentionally ignored.
 */
export function systemPromptText(options) {
  if (!options || typeof options !== 'object') return '';
  const parts = [options.system];
  const messages = Array.isArray(options.messages) ? options.messages : [];
  let index = 0;
  while (index < messages.length && messages[index] && messages[index].role === 'system') {
    parts.push(flattenSystemMessage(messages[index]));
    index += 1;
  }
  return parts.filter(Boolean).join('\n\n');
}

/** Match billion-context's system prompt fingerprint: sha256(JSON.stringify(text)).slice(0,16). */
export function systemPromptFingerprint(text) {
  return createHash('sha256').update(JSON.stringify(String(text == null ? '' : text))).digest('hex').slice(0, 16);
}

/**
 * A system-prompt rewrite guarantees a cold prefix, so the previous fold's
 * cache-hit evidence is not meaningful. Rotation still requires slow samples.
 */
export function decideSystemRewriteRotation(samples, config, consecutiveFailures = 0) {
  const performance = performanceCondition(samples || [], config, consecutiveFailures);
  if (!performance.bad) {
    return { rotate: false, reason: performance.reason, cache: null, performance };
  }
  return { rotate: true, reason: 'system-rewrite', cache: null, performance };
}

export function newRoutingId(prefix = 'ses_') {
  return String(prefix) + randomBytes(12).toString('hex');
}

export function biliSessionKey(sessionId) {
  return createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 24);
}

export function biliSessionsRoot(config, env = process.env) {
  if (config && config.biliSessionsDir) return config.biliSessionsDir;
  if (env && typeof env.BILI_SESSIONS_DIR === 'string' && env.BILI_SESSIONS_DIR.trim() !== '') {
    return path.resolve(env.BILI_SESSIONS_DIR);
  }
  const xdg = env && typeof env.XDG_DATA_HOME === 'string' ? env.XDG_DATA_HOME.trim() : '';
  return path.join(xdg !== '' ? path.resolve(xdg) : path.join(os.homedir(), '.local', 'share'), 'billion-context', 'sessions');
}

export function sanitizeHostLabel(host) {
  let value = String(host == null ? '' : host).trim();
  if (value === '') return '';
  try {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = new URL('https://' + value).hostname;
    else value = new URL(value).hostname;
  } catch {
    // Keep the raw value and sanitize below.
  }
  const cleaned = value.replace(/[^a-zA-Z0-9.-]/g, '-').slice(0, 48);
  return cleaned === '' ? 'unknown' : cleaned;
}

export function biliStatePathCandidates(sessionId, config) {
  const root = biliSessionsRoot(config);
  const key = biliSessionKey(sessionId);
  const proto = String(config.biliProtocol || 'openai');
  const host = sanitizeHostLabel(config.biliUpstreamHost || 'opencode.ai');
  const out = [path.join(root, proto, host + '_' + key + '.json')];
  // Older billion-context builds used the raw origin label or an unknown bucket.
  if (host !== 'unknown') out.push(path.join(root, proto, 'unknown_' + key + '.json'));
  out.push(path.join(root, proto + '_unknown', host + '_' + key + '.json'));
  return out;
}

export function normalizeFolds(rawFolds) {
  if (!Array.isArray(rawFolds)) return [];
  const bySeq = new Map();
  rawFolds.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const seqNum = Number(entry.seq);
    const seq = Number.isFinite(seqNum) && seqNum > 0 ? seqNum : index + 1;
    const hitNum = entry.hPct == null ? null : Number(entry.hPct);
    const atNum = Number(entry.at);
    bySeq.set(seq, {
      seq,
      at: Number.isFinite(atNum) ? atNum : 0,
      hPct: hitNum != null && Number.isFinite(hitNum) ? hitNum : null,
      bid: entry.bid == null ? null : String(entry.bid),
    });
  });
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function extractFolds(stateJson) {
  const root = stateJson && typeof stateJson === 'object' && stateJson.payload ? stateJson.payload : stateJson;
  const ledger = root && root.metadata ? root.metadata.cacheLedger : null;
  return normalizeFolds(ledger ? ledger.folds : []);
}

export function maxFoldSeq(folds) {
  let max = 0;
  for (const fold of folds) if (fold.seq > max) max = fold.seq;
  return max;
}

export function cacheCondition(folds, config) {
  const windowSize = Math.max(1, Math.round(Number(config.foldsWindow) || 1));
  const threshold = Number(config.cacheHitThresholdPct);
  const sorted = normalizeFolds(folds);
  if (sorted.length < windowSize) {
    return {
      bad: false,
      reason: 'not-enough-folds',
      thresholdPct: threshold,
      recent: sorted.slice(-windowSize),
    };
  }
  const recent = sorted.slice(-windowSize);
  const bad = recent.every((fold) => fold.hPct != null && Number.isFinite(fold.hPct) && fold.hPct <= threshold);
  return {
    bad,
    reason: bad ? 'low-cache-hit' : 'cache-hit-ok',
    thresholdPct: threshold,
    recent,
  };
}

function validSample(sample) {
  if (!sample || typeof sample !== 'object') return false;
  return Number.isFinite(Number(sample.ttftMs)) && Number(sample.ttftMs) >= 0
    && Number.isFinite(Number(sample.tps)) && Number(sample.tps) > 0;
}

export function summarizeSamples(samples, sampleSize) {
  const list = Array.isArray(samples) ? samples.filter(validSample) : [];
  const limit = Math.max(1, Math.round(Number(sampleSize) || DEFAULTS.sampleSize));
  const recent = list.slice(-limit);
  let ttftTotal = 0;
  let tpsTotal = 0;
  for (const sample of recent) {
    ttftTotal += Number(sample.ttftMs);
    tpsTotal += Number(sample.tps);
  }
  return {
    count: recent.length,
    avgTtftMs: recent.length > 0 ? ttftTotal / recent.length : null,
    avgTps: recent.length > 0 ? tpsTotal / recent.length : null,
    last: recent.length > 0 ? recent[recent.length - 1] : null,
  };
}

export function rotationThresholds(config, consecutiveFailures = 0) {
  const step = Math.max(0, Math.round(Number(consecutiveFailures) || 0));
  const ttftGraceMs = step * Number(config.stepTtftGraceMs || 0);
  const throughputGraceTps = step * Number(config.stepThroughputGraceTps || 0);
  return {
    step,
    baseTtftThresholdMs: config.ttftThresholdMs,
    baseThroughputThresholdTps: config.throughputThresholdTps,
    ttftGraceMs,
    throughputGraceTps,
    // Never let the stepped throughput threshold fall to zero or below. A
    // threshold of 0.01 tok/s effectively means "stop rotating for speed".
    effectiveTtftThresholdMs: config.ttftThresholdMs + ttftGraceMs,
    effectiveThroughputThresholdTps: Math.max(0.01, config.throughputThresholdTps - throughputGraceTps),
  };
}

export function performanceCondition(samples, config, consecutiveFailures = 0) {
  const summary = summarizeSamples(samples, config.sampleSize);
  const thresholds = rotationThresholds(config, consecutiveFailures);
  if (summary.count === 0) {
    return { bad: false, reason: 'no-samples', thresholds, ...summary };
  }
  if (config.requireFullSamples && summary.count < config.sampleSize) {
    return { bad: false, reason: 'not-enough-samples', thresholds, ...summary };
  }
  const ttftBad = summary.avgTtftMs >= thresholds.effectiveTtftThresholdMs;
  const tpsBad = summary.avgTps <= thresholds.effectiveThroughputThresholdTps;
  return {
    bad: ttftBad || tpsBad,
    reason: ttftBad ? 'ttft-high' : tpsBad ? 'throughput-low' : 'performance-ok',
    ttftBad,
    tpsBad,
    thresholds,
    ...summary,
  };
}

/** A completed post-switch window that is still below the base targets. */
export function historyEntryFailed(entry, config) {
  if (!entry || entry.afterComplete !== true) return false;
  const ttft = Number(entry.afterTtftMs);
  const tps = Number(entry.afterTps);
  if (!Number.isFinite(ttft) || !Number.isFinite(tps)) return false;
  return ttft >= config.ttftThresholdMs || tps <= config.throughputThresholdTps;
}

/**
 * Count consecutive silent switches whose completed after-window is still
 * below the base performance targets. In-flight windows are skipped: they
 * cannot prove a failure yet, so they must not erase earlier evidence.
 */
export function consecutiveFailedSwitches(history, sessionId, config) {
  const key = String(sessionId == null ? '' : sessionId);
  if (key === '') return 0;
  const rows = (Array.isArray(history) ? history : [])
    .filter((entry) => entry && String(entry.sessionId) === key)
    .slice()
    .sort((a, b) => Number(b.at) - Number(a.at));
  let count = 0;
  for (const entry of rows) {
    if (entry.afterComplete !== true) continue;
    if (!historyEntryFailed(entry, config)) break;
    count += 1;
  }
  return count;
}

export function decideRotation(options) {
  const config = options.config;
  const cache = cacheCondition(options.previousFolds || [], config);
  if (!cache.bad) {
    return { rotate: false, reason: cache.reason, cache, performance: null };
  }
  const performance = performanceCondition(options.samples || [], config, options.consecutiveFailures || 0);
  if (!performance.bad) {
    return { rotate: false, reason: performance.reason, cache, performance };
  }
  return { rotate: true, reason: 'cache-and-performance', cache, performance };
}

export function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

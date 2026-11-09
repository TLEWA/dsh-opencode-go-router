/**
 * opencode-router - pure decision helpers.
 *
 * Before every eligible request the plugin predicts how much of its prompt the
 * upstream prefix cache will serve. The prediction uses the measured cache-hit
 * rate of recent requests, the request's own shape (system prompt rewrite,
 * history compaction) and the idle gap since the previous request. When the
 * request is expected to miss the cache and recent requests are slow, the
 * routing id (x-opencode-session) is rotated before the request is sent, so
 * the new upstream builds the cache for that request instead of the switch
 * adding one more cold prefill.
 */

import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const NAME = 'opencode-router';
export const VERSION = '0.6.1';

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

/** A request whose cache hit reaches this level is treated as warm. */
export const CACHE_WARM_HIT_PCT = 80;

/**
 * A cold request that still sent at least this many prompt tokens prefilled
 * that prefix upstream, so the request after it is expected to hit the cache.
 */
export const DEFAULT_PREFILL_MIN_TOKENS = 4000;

export const DEFAULTS = Object.freeze({
  enabled: true,
  providers: Object.freeze(['opencode-go']),
  models: Object.freeze([]),
  // Predicted cache-hit gate: rotate only when this request is expected to
  // reuse at most this percentage of its prompt from the upstream cache.
  cacheHitThresholdPct: 25,
  // Predicted cache lifetime. A request after at least this much idle time is
  // treated as cold. Measured: 15-60 minute gaps still hit 79%, only gaps of
  // several hours are reliably cold.
  cacheTtlMs: 3600000,
  prefillMinTokens: DEFAULT_PREFILL_MIN_TOKENS,
  predictiveRotation: true,
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
  dryRun: false,
  debug: false,
  overrideExistingHeader: true,
  maxSamples: 20,
  sessionActiveMs: 600000,
  minRotationGapMs: 0,
  // Routing-id pool: an idle or archived session lends its warm
  // x-opencode-session to a new/reviving session whose prompt shares enough
  // prefix, so the new session does not pay a cold prefill.
  poolEnabled: true,
  poolIdleMs: 180000,
  poolMatchPct: 60,
  poolMinTps: 80,
  poolMaxTtftMs: 8000,
  poolSampleSize: 5,
  // Tier 2 is the speed tier, so a handoff there must actually buy speed: the
  // donor's average throughput has to clear this multiple of the throughput
  // the session already gets (its own measured average, or the median of the
  // recent request ring) over at least poolSpeedMinSamples bound samples.
  poolSpeedGainRatio: 1.1,
  poolSpeedMinSamples: 5,
  // Tier 1: inactive for less than this; tier 2: up to poolExpireMs.
  poolTier1Ms: 3600000,
  poolExpireMs: 86400000,
  poolMaxEntries: 50,
  poolDigestChunkChars: 512,
  poolDigestMaxChars: 262144,
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

export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: source.enabled !== false,
    providers: stringList(source.providers, DEFAULTS.providers),
    models: stringList(source.models, DEFAULTS.models),
    cacheHitThresholdPct: numberInRange(source.cacheHitThresholdPct, DEFAULTS.cacheHitThresholdPct, 0, 100),
    cacheTtlMs: numberInRange(source.cacheTtlMs, DEFAULTS.cacheTtlMs, 0, 604800000),
    prefillMinTokens: Math.round(numberInRange(source.prefillMinTokens, DEFAULTS.prefillMinTokens, 0, 2000000)),
    predictiveRotation: source.predictiveRotation !== false,
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
    dryRun: source.dryRun === true,
    debug: source.debug === true,
    overrideExistingHeader: source.overrideExistingHeader !== false,
    maxSamples: Math.round(numberInRange(source.maxSamples, DEFAULTS.maxSamples, 1, 500)),
    sessionActiveMs: numberInRange(source.sessionActiveMs, DEFAULTS.sessionActiveMs, 1000, 86400000),
    minRotationGapMs: numberInRange(source.minRotationGapMs, DEFAULTS.minRotationGapMs, 0, 86400000),
    poolEnabled: source.poolEnabled !== false,
    poolIdleMs: numberInRange(source.poolIdleMs, DEFAULTS.poolIdleMs, 1000, 86400000),
    poolMatchPct: numberInRange(source.poolMatchPct, DEFAULTS.poolMatchPct, 0, 100),
    poolMinTps: numberInRange(source.poolMinTps, DEFAULTS.poolMinTps, 0.01, 1000000),
    poolMaxTtftMs: numberInRange(source.poolMaxTtftMs, DEFAULTS.poolMaxTtftMs, 1, 3600000),
    poolSampleSize: Math.round(numberInRange(source.poolSampleSize, DEFAULTS.poolSampleSize, 1, 50)),
    poolSpeedGainRatio: numberInRange(source.poolSpeedGainRatio, DEFAULTS.poolSpeedGainRatio, 1, 10),
    poolSpeedMinSamples: Math.round(numberInRange(source.poolSpeedMinSamples, DEFAULTS.poolSpeedMinSamples, 1, 50)),
    poolTier1Ms: numberInRange(source.poolTier1Ms, DEFAULTS.poolTier1Ms, 0, 604800000),
    poolExpireMs: numberInRange(source.poolExpireMs, DEFAULTS.poolExpireMs, 0, 2592000000),
    poolMaxEntries: Math.round(numberInRange(source.poolMaxEntries, DEFAULTS.poolMaxEntries, 1, 500)),
    poolDigestChunkChars: Math.round(numberInRange(source.poolDigestChunkChars, DEFAULTS.poolDigestChunkChars, 64, 4096)),
    poolDigestMaxChars: Math.round(numberInRange(source.poolDigestMaxChars, DEFAULTS.poolDigestMaxChars, 4096, 2000000)),
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

export function newRoutingId(prefix = 'ses_') {
  return String(prefix) + randomBytes(12).toString('hex');
}

function digestHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function stableStringify(value) {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

function contentDigestText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push('text\n' + block.text);
      continue;
    }
    // Tool calls: keep the name and arguments, drop call ids (they are random
    // per conversation and would defeat cross-session prefix matching).
    if (block.name != null || block.toolName != null) {
      const name = String(block.name == null ? block.toolName : block.name);
      const args = block.arguments == null ? (block.input == null ? block.args : block.input) : block.arguments;
      parts.push('tool-call\n' + name + '\n' + stableStringify(args));
      continue;
    }
    // Tool results and other text-bearing blocks.
    const nested = block.content == null ? (block.result == null ? block.output : block.result) : block.content;
    if (nested != null) {
      const text = contentDigestText(nested);
      if (text !== '') parts.push('tool-result\n' + text);
    }
  }
  return parts.join('\n');
}

function messageDigestText(message) {
  if (!message || typeof message !== 'object') return '';
  const role = String(message.role == null ? '' : message.role);
  const body = contentDigestText(message.content);
  if (body === '') return role === '' ? '' : role;
  return role + '\n' + body;
}

/**
 * Flatten one request into a deterministic prefix representation for pool
 * matching. Order mirrors the upstream prompt: initial system prompt, tool
 * definitions, then conversation messages. Only hashes are persisted.
 */
export function promptDigestText(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const parts = [];
  const system = systemPromptText(opts);
  if (system !== '') parts.push('system\n' + system);
  let index = 0;
  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  while (index < messages.length && messages[index] && messages[index].role === 'system') index += 1;
  if (Array.isArray(opts.tools) && opts.tools.length > 0) {
    const tools = opts.tools.map((tool) => {
      if (!tool || typeof tool !== 'object') return '';
      const name = String(tool.name == null ? (tool.function && tool.function.name) || '' : tool.name);
      const schema = tool.parameters == null
        ? (tool.inputSchema == null ? (tool.function && tool.function.parameters) : tool.inputSchema)
        : tool.parameters;
      return name + '\n' + stableStringify(schema);
    }).filter(Boolean);
    if (tools.length > 0) parts.push('tools\n' + tools.join('\n'));
  }
  while (index < messages.length) {
    const text = messageDigestText(messages[index]);
    if (text !== '') parts.push(text);
    index += 1;
  }
  return parts.join('\n\n');
}

/** Chunked, hashed prompt prefix. Chunks make partial-prefix matching cheap. */
export function promptDigestChunks(options, config = DEFAULTS) {
  const maxChars = Math.max(1, Number(config.poolDigestMaxChars) || DEFAULTS.poolDigestMaxChars);
  const chunkChars = Math.max(16, Number(config.poolDigestChunkChars) || DEFAULTS.poolDigestChunkChars);
  let text = promptDigestText(options);
  if (text.length > maxChars) text = text.slice(0, maxChars);
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += chunkChars) {
    chunks.push(digestHash(text.slice(offset, offset + chunkChars)));
  }
  return { chunks, chars: text.length };
}

export function commonPrefixChunks(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  const limit = Math.min(a.length, b.length);
  let count = 0;
  while (count < limit && a[count] === b[count]) count += 1;
  return count;
}

/** How much of the new prompt prefix the old routing id already covered. */
export function digestMatchPct(oldDigest, newDigest) {
  const next = Array.isArray(newDigest) ? newDigest : [];
  if (next.length === 0) return 0;
  return (commonPrefixChunks(oldDigest, next) / next.length) * 100;
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

/** Prompt tokens the upstream billed for one request: fresh input plus cache reads. */
export function promptTokens(sample) {
  if (!sample || typeof sample !== 'object') return 0;
  const input = Number(sample.inputTokens);
  const cached = Number(sample.cacheReadTokens);
  const fresh = Number.isFinite(input) && input > 0 ? input : 0;
  const read = Number.isFinite(cached) && cached > 0 ? cached : 0;
  return fresh + read;
}

/** Cache-hit percentage of one measured request; null when usage carried no prompt tokens. */
export function sampleCacheHitPct(sample) {
  if (!sample || typeof sample !== 'object') return null;
  const explicit = Number(sample.hitPct);
  if (Number.isFinite(explicit)) return Math.min(100, Math.max(0, explicit));
  const total = promptTokens(sample);
  if (total <= 0) return null;
  const cached = Number(sample.cacheReadTokens);
  const read = Number.isFinite(cached) && cached > 0 ? cached : 0;
  return (read / total) * 100;
}

/** True when a cold request prefilled enough prompt to leave that prefix cached. */
export function isFullPrefill(sample, config = DEFAULTS) {
  const total = promptTokens(sample);
  if (total <= 0) return false;
  const minimum = Math.max(0, Number(config.prefillMinTokens));
  if (total < minimum) return false;
  const hit = sampleCacheHitPct(sample);
  return hit == null || hit < CACHE_WARM_HIT_PCT;
}

/**
 * Predict the cache hit of the request that is about to be sent.
 *
 * Only signals known before the request can be used, so the decision can be
 * applied to that very request:
 *   - a system prompt rewrite or a compacted history changes the prefix (cold);
 *   - a long idle gap outlives the upstream cache (cold);
 *   - a cold request that still prefilled a large prompt leaves that prefix
 *     cached, so the next request is warm (this is the fold-rebuild case);
 *   - otherwise the last measured hit carries over.
 */
export function predictCacheHit(options) {
  const opts = options || {};
  const config = opts.config || DEFAULTS;
  const threshold = Number(config.cacheHitThresholdPct);
  const samples = (Array.isArray(opts.samples) ? opts.samples : []).filter((s) => s && typeof s === 'object');
  const last = samples.length > 0 ? samples[samples.length - 1] : null;
  const lastHit = last ? sampleCacheHitPct(last) : null;
  const idleMs = Math.max(0, Number(opts.idleMs) || 0);
  const ttl = Number(config.cacheTtlMs);
  const base = {
    thresholdPct: threshold,
    idleMs: Math.round(idleMs),
    lastHitPct: lastHit == null ? null : round1(lastHit),
    samples: samples.length,
  };

  if (opts.systemChanged === true) {
    return { ...base, cold: true, expectedPct: 0, basis: 'system-rewrite' };
  }
  if (opts.historyShrank === true) {
    return { ...base, cold: true, expectedPct: 0, basis: 'history-compacted' };
  }
  if (last == null || lastHit == null) {
    return { ...base, cold: false, expectedPct: null, basis: last == null ? 'no-history' : 'no-cache-data' };
  }
  if (ttl > 0 && idleMs >= ttl) {
    return { ...base, cold: true, expectedPct: 0, basis: 'idle-expired' };
  }
  if (lastHit >= CACHE_WARM_HIT_PCT) {
    return { ...base, cold: false, expectedPct: round1(lastHit), basis: 'warm-history' };
  }
  if (isFullPrefill(last, config)) {
    return {
      ...base,
      cold: false,
      expectedPct: 100,
      basis: opts.foldEvidence === true ? 'fold-rebuild-prefilled' : 'prefilled',
    };
  }
  const cold = lastHit <= threshold;
  return {
    ...base,
    cold,
    expectedPct: round1(lastHit),
    basis: cold ? 'cache-miss-persists' : 'partial-cache',
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

export function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

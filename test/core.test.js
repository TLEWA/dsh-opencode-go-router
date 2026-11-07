import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  biliSessionKey,
  biliStatePathCandidates,
  CACHE_WARM_HIT_PCT,
  consecutiveFailedSwitches,
  DEFAULTS,
  DEFAULT_PREFILL_MIN_TOKENS,
  extractFolds,
  historyEntryFailed,
  isFullPrefill,
  isTargetRequest,
  maxFoldSeq,
  newRoutingId,
  normalizeConfig,
  normalizeFolds,
  performanceCondition,
  predictCacheHit,
  promptTokens,
  rotationThresholds,
  sampleCacheHitPct,
  summarizeSamples,
  systemPromptFingerprint,
  systemPromptText,
} from '../lib/core.js';

test('normalizeConfig applies defaults and clamps', () => {
  const config = normalizeConfig({
    cacheHitThresholdPct: 500,
    sampleSize: 0,
    requestCheckDelaysMs: [10, -1, 'x', 20],
  });
  assert.equal(config.enabled, true);
  assert.equal(normalizeConfig({}).cacheHitThresholdPct, 25);
  assert.equal(config.cacheHitThresholdPct, 100);
  assert.equal(config.sampleSize, 1);
  assert.equal(normalizeConfig({}).ttftThresholdMs, 12000);
  assert.equal(normalizeConfig({}).stepTtftGraceMs, 2000);
  assert.equal(normalizeConfig({}).stepThroughputGraceTps, 5);
  assert.equal(normalizeConfig({}).predictiveRotation, true);
  assert.equal(normalizeConfig({ predictiveRotation: false }).predictiveRotation, false);
  assert.equal(normalizeConfig({ predictiveRotation: 'nope' }).predictiveRotation, true);
  assert.equal(normalizeConfig({}).cacheTtlMs, 3600000);
  assert.equal(normalizeConfig({ cacheTtlMs: -5 }).cacheTtlMs, 0);
  assert.equal(normalizeConfig({ cacheTtlMs: 1e12 }).cacheTtlMs, 604800000);
  assert.equal(normalizeConfig({ prefillMinTokens: -5 }).prefillMinTokens, 0);
  assert.equal(normalizeConfig({ prefillMinTokens: 4000.6 }).prefillMinTokens, 4001);
  assert.equal(normalizeConfig({}).prefillMinTokens, DEFAULT_PREFILL_MIN_TOKENS);
  assert.deepEqual(config.requestCheckDelaysMs, [10, 20]);
  assert.equal(config.statePath.endsWith(path.join('storages', 'opencode-router', 'state.json')), true);
});

test('isTargetRequest only accepts OpenCode Go DeepSeek-series models', () => {
  const config = normalizeConfig({ providers: ['opencode-go'], models: [] });
  assert.equal(isTargetRequest({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, config), true);
  assert.equal(isTargetRequest({ provider: 'opencode-go', model: 'DeepSeek-V4.1' }, config), true);
  assert.equal(isTargetRequest({ provider: 'opencode-go', model: 'deepseek-chat' }, config), true);
  assert.equal(isTargetRequest({ provider: 'opencode-go', model: 'claude-haiku-5-5' }, config), false);
  assert.equal(isTargetRequest({ provider: 'opencode-go', model: 'kimi-k3' }, config), false);
  assert.equal(isTargetRequest({ provider: 'opencode-go', model: 'gpt-6-luna' }, config), false);
  assert.equal(isTargetRequest({ provider: 'opencode-go' }, config), false);
  assert.equal(isTargetRequest({ provider: 'other', model: 'deepseek-v4.1-flash' }, config), false);
  assert.equal(isTargetRequest({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, normalizeConfig({ enabled: false })), false);

  const exact = normalizeConfig({ providers: ['opencode-go'], models: ['deepseek-v4.1-flash'] });
  assert.equal(isTargetRequest({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, exact), true);
  assert.equal(isTargetRequest({ provider: 'opencode-go', model: 'deepseek-chat' }, exact), false);
  assert.equal(isTargetRequest({ provider: 'opencode-go', model: 'claude-haiku-5-5' }, exact), false);
});

test('systemPromptText mirrors pi-ai leading system messages and fingerprints them', () => {
  assert.equal(systemPromptText(null), '');
  assert.equal(systemPromptText({}), '');
  assert.equal(systemPromptText({ system: 'base' }), 'base');
  const options = {
    system: 'base',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'first' }, { type: 'text', text: '-' }, { type: 'text', text: 'second' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'system', content: [{ type: 'text', text: 'late system must be ignored' }] },
    ],
  };
  assert.equal(systemPromptText(options), 'base\n\nfirst-second');
  assert.equal(systemPromptText({ messages: [{ role: 'system', content: 'string form' }] }), 'string form');

  const a = systemPromptFingerprint('base');
  assert.equal(a, systemPromptFingerprint('base'));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, systemPromptFingerprint('base '));
});

test('bili session key and state path follow billion-context naming', () => {
  const sessionId = 'session-42fe5de7-03a3-4628-a004-214ee16de663';
  assert.equal(biliSessionKey(sessionId), '464de517e9950a59429e9a25');
  const root = path.join(os.tmpdir(), 'opencode-router-bili-path');
  const config = normalizeConfig({ biliSessionsDir: root });
  const candidates = biliStatePathCandidates(sessionId, config);
  assert.equal(candidates[0], path.join(root, 'openai', 'opencode.ai_464de517e9950a59429e9a25.json'));
});

test('normalizeFolds dedupes, sorts and preserves unknown hit values', () => {
  const folds = normalizeFolds([
    { seq: 2, hPct: 3.5, at: 20 },
    { seq: 1, hPct: 0 },
    { seq: 1, hPct: 80 },
    { seq: 3, hPct: null },
    { hPct: 4 },
  ]);
  assert.deepEqual(folds.map((fold) => fold.seq), [1, 2, 3, 5]);
  assert.equal(folds[0].hPct, 80);
  assert.equal(folds[2].hPct, null);
  assert.equal(folds[3].hPct, 4);
  assert.equal(folds[0].at, 0);
});

test('extractFolds accepts the outer payload and top-level shape', () => {
  const payload = { payload: { metadata: { cacheLedger: { folds: [{ seq: 1, hPct: 2, at: 5 }] } } } };
  const top = { metadata: { cacheLedger: { folds: [{ seq: 2, hPct: 3, at: 6 }] } } };
  assert.equal(extractFolds(payload).length, 1);
  assert.equal(extractFolds(top)[0].seq, 2);
  assert.equal(maxFoldSeq(extractFolds(top)), 2);
});

test('promptTokens and sampleCacheHitPct read the usage fields', () => {
  assert.equal(promptTokens({ inputTokens: 100, cacheReadTokens: 900 }), 1000);
  assert.equal(promptTokens({ inputTokens: 100 }), 100);
  assert.equal(promptTokens(null), 0);
  assert.equal(sampleCacheHitPct({ inputTokens: 100, cacheReadTokens: 900 }), 90);
  assert.equal(sampleCacheHitPct({ hitPct: 12.34, inputTokens: 0, cacheReadTokens: 0 }), 12.34);
  assert.equal(sampleCacheHitPct({ hitPct: 250 }), 100);
  assert.equal(sampleCacheHitPct({ inputTokens: 0, cacheReadTokens: 0 }), null);
  assert.equal(sampleCacheHitPct(null), null);
});

test('isFullPrefill only credits a large, cold prompt', () => {
  const config = normalizeConfig({});
  assert.equal(isFullPrefill({ inputTokens: 80000, cacheReadTokens: 0 }, config), true);
  assert.equal(isFullPrefill({ inputTokens: 100, cacheReadTokens: 0 }, config), false);
  assert.equal(isFullPrefill({ inputTokens: 1000, cacheReadTokens: 9000 }, config), false);
  assert.equal(isFullPrefill({ inputTokens: 4000, cacheReadTokens: 0 }, config), true);
  assert.equal(isFullPrefill({ inputTokens: 3999, cacheReadTokens: 0 }, config), false);
  assert.equal(isFullPrefill({ inputTokens: 80000, cacheReadTokens: 0 }, normalizeConfig({ prefillMinTokens: 0 })), true);
});

test('predictCacheHit prefers prefix changes over any measured hit', () => {
  const config = normalizeConfig({});
  const warm = [{ inputTokens: 1000, cacheReadTokens: 99000, hitPct: 99 }];
  const cold = predictCacheHit({ samples: warm, config, systemChanged: true });
  assert.equal(cold.cold, true);
  assert.equal(cold.expectedPct, 0);
  assert.equal(cold.basis, 'system-rewrite');
  assert.equal(predictCacheHit({ samples: warm, config, historyShrank: true }).basis, 'history-compacted');
  assert.equal(predictCacheHit({ samples: warm, config }).basis, 'warm-history');
  assert.equal(predictCacheHit({ samples: warm, config }).cold, false);
});

test('predictCacheHit does not rotate on missing data', () => {
  const config = normalizeConfig({});
  const none = predictCacheHit({ samples: [], config });
  assert.equal(none.cold, false);
  assert.equal(none.expectedPct, null);
  assert.equal(none.basis, 'no-history');
  const unknown = predictCacheHit({ samples: [{ ttftMs: 1, tps: 1 }], config });
  assert.equal(unknown.cold, false);
  assert.equal(unknown.expectedPct, null);
  assert.equal(unknown.basis, 'no-cache-data');
});

test('predictCacheHit treats a long idle gap as an expired cache', () => {
  const config = normalizeConfig({ cacheTtlMs: 3600000 });
  const warm = [{ inputTokens: 1000, cacheReadTokens: 99000, hitPct: 99 }];
  assert.equal(predictCacheHit({ samples: warm, config, idleMs: 3599999 }).cold, false);
  const expired = predictCacheHit({ samples: warm, config, idleMs: 3600000 });
  assert.equal(expired.cold, true);
  assert.equal(expired.expectedPct, 0);
  assert.equal(expired.basis, 'idle-expired');
  assert.equal(predictCacheHit({ samples: warm, config: normalizeConfig({ cacheTtlMs: 0 }), idleMs: 1e9 }).cold, false);
});

test('predictCacheHit keeps the fold rebuild prefix warm', () => {
  const config = normalizeConfig({});
  const rebuild = [{ inputTokens: 80000, cacheReadTokens: 0, hitPct: 0 }];
  const withFold = predictCacheHit({ samples: rebuild, config, foldEvidence: true });
  assert.equal(withFold.cold, false);
  assert.equal(withFold.expectedPct, 100);
  assert.equal(withFold.basis, 'fold-rebuild-prefilled');
  const noFold = predictCacheHit({ samples: rebuild, config });
  assert.equal(noFold.cold, false);
  assert.equal(noFold.basis, 'prefilled');
});

test('predictCacheHit rotates when the last measured hit stays low', () => {
  const config = normalizeConfig({ cacheHitThresholdPct: 25 });
  const low = [{ inputTokens: 1000, cacheReadTokens: 100, hitPct: 9.09 }];
  const decision = predictCacheHit({ samples: low, config });
  assert.equal(decision.cold, true);
  assert.equal(decision.basis, 'cache-miss-persists');
  assert.equal(decision.expectedPct, 9.1);
  const at25 = predictCacheHit({ samples: [{ inputTokens: 75, cacheReadTokens: 25 }], config });
  assert.equal(at25.cold, true);
  const partial = predictCacheHit({ samples: [{ inputTokens: 600, cacheReadTokens: 400 }], config });
  assert.equal(partial.cold, false);
  assert.equal(partial.basis, 'partial-cache');
});

test('predictCacheHit uses the warm threshold constant', () => {
  const config = normalizeConfig({});
  assert.equal(CACHE_WARM_HIT_PCT, 80);
  const at80 = predictCacheHit({ samples: [{ inputTokens: 20, cacheReadTokens: 80 }], config });
  assert.equal(at80.basis, 'warm-history');
  const at79 = predictCacheHit({ samples: [{ inputTokens: 21, cacheReadTokens: 79 }], config });
  assert.equal(at79.basis, 'partial-cache');
});

test('summarizeSamples averages the last N valid samples', () => {
  const summary = summarizeSamples([
    { ttftMs: 1000, tps: 100 },
    { ttftMs: 2000, tps: 50 },
    { ttftMs: -1, tps: 50 },
    { ttftMs: 3000, tps: 0 },
    { ttftMs: 4000, tps: 25 },
  ], 2);
  assert.equal(summary.count, 2);
  assert.equal(summary.avgTtftMs, 3000);
  assert.equal(summary.avgTps, 37.5);
});

test('performanceCondition requires five samples and uses the 12s default', () => {
  const config = normalizeConfig({ sampleSize: 5, ttftThresholdMs: 20000, throughputThresholdTps: 60 });
  const defaultConfig = normalizeConfig({ sampleSize: 5 });
  assert.equal(performanceCondition(Array.from({ length: 5 }, () => ({ ttftMs: 12000, tps: 100 })), defaultConfig).bad, true);
  assert.equal(performanceCondition(Array.from({ length: 5 }, () => ({ ttftMs: 11999, tps: 100 })), defaultConfig).bad, false);
  const slow = Array.from({ length: 5 }, () => ({ ttftMs: 25000, tps: 100 }));
  const slowResult = performanceCondition(slow, config);
  assert.equal(slowResult.bad, true);
  assert.equal(slowResult.reason, 'ttft-high');

  const slowTps = Array.from({ length: 5 }, () => ({ ttftMs: 1000, tps: 10 }));
  const tpsResult = performanceCondition(slowTps, config);
  assert.equal(tpsResult.bad, true);
  assert.equal(tpsResult.reason, 'throughput-low');

  const good = Array.from({ length: 5 }, () => ({ ttftMs: 1000, tps: 100 }));
  assert.equal(performanceCondition(good, config).bad, false);
  assert.equal(performanceCondition(good.slice(0, 4), config).bad, false);
  assert.equal(performanceCondition(good.slice(0, 4), normalizeConfig({ requireFullSamples: false })).bad, false);
});

test('consecutive failed switches widen thresholds by 2s and 5 tok/s each', () => {
  const config = normalizeConfig({});
  const zero = rotationThresholds(config, 0);
  assert.equal(zero.effectiveTtftThresholdMs, 12000);
  assert.equal(zero.effectiveThroughputThresholdTps, 60);
  const one = rotationThresholds(config, 1);
  assert.equal(one.step, 1);
  assert.equal(one.effectiveTtftThresholdMs, 14000);
  assert.equal(one.effectiveThroughputThresholdTps, 55);
  const two = rotationThresholds(config, 2);
  assert.equal(two.effectiveTtftThresholdMs, 16000);
  assert.equal(two.effectiveThroughputThresholdTps, 50);
  const floor = rotationThresholds(config, 100);
  assert.equal(floor.effectiveThroughputThresholdTps, 0.01);

  const disabled = normalizeConfig({ stepTtftGraceMs: 0, stepThroughputGraceTps: 0 });
  assert.equal(rotationThresholds(disabled, 3).effectiveTtftThresholdMs, 12000);
  assert.equal(rotationThresholds(disabled, 3).effectiveThroughputThresholdTps, 60);
});

test('performanceCondition applies the stepped thresholds', () => {
  const config = normalizeConfig({ sampleSize: 5 });
  const at13s = Array.from({ length: 5 }, () => ({ ttftMs: 13000, tps: 100 }));
  assert.equal(performanceCondition(at13s, config).bad, true);
  assert.equal(performanceCondition(at13s, config, 1).bad, false);
  assert.equal(performanceCondition(at13s, config, 2).bad, false);

  const at14s = Array.from({ length: 5 }, () => ({ ttftMs: 14000, tps: 100 }));
  assert.equal(performanceCondition(at14s, config, 1).bad, true);

  const at57tps = Array.from({ length: 5 }, () => ({ ttftMs: 1000, tps: 57 }));
  assert.equal(performanceCondition(at57tps, config).bad, true);
  assert.equal(performanceCondition(at57tps, config, 1).bad, false);
  const at55tps = Array.from({ length: 5 }, () => ({ ttftMs: 1000, tps: 55 }));
  assert.equal(performanceCondition(at55tps, config, 1).bad, true);
});

test('consecutiveFailedSwitches counts completed bad windows and stops at a good one', () => {
  const config = normalizeConfig({});
  const bad = (at) => ({
    sessionId: 's', at, afterComplete: true, afterTtftMs: 25000, afterTps: 10,
  });
  const good = (at) => ({
    sessionId: 's', at, afterComplete: true, afterTtftMs: 1000, afterTps: 100,
  });
  assert.equal(historyEntryFailed(bad(1), config), true);
  assert.equal(historyEntryFailed(good(2), config), false);
  assert.equal(historyEntryFailed({ sessionId: 's', at: 3, afterComplete: false }, config), false);

  assert.equal(consecutiveFailedSwitches([bad(1), bad(2)], 's', config), 2);
  assert.equal(consecutiveFailedSwitches([bad(1), bad(2), good(3)], 's', config), 0);
  assert.equal(consecutiveFailedSwitches([good(1), bad(2)], 's', config), 1);
  // An in-flight window is skipped, so earlier failures still count.
  assert.equal(consecutiveFailedSwitches([bad(1), bad(2), { sessionId: 's', at: 3, afterComplete: false }], 's', config), 2);
  assert.equal(consecutiveFailedSwitches([bad(1), { sessionId: 'other', at: 2, afterComplete: true, afterTtftMs: 25000, afterTps: 10 }], 's', config), 1);
});

test('newRoutingId has the requested shape', () => {
  const id = newRoutingId('ses_');
  assert.match(id, /^ses_[0-9a-f]{24}$/);
  assert.notEqual(id, newRoutingId('ses_'));
  assert.equal(DEFAULTS.cacheHitThresholdPct, 25);
});

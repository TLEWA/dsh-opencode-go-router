import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  biliSessionKey,
  biliStatePathCandidates,
  cacheCondition,
  consecutiveFailedSwitches,
  decideRotation,
  DEFAULTS,
  extractFolds,
  historyEntryFailed,
  isTargetRequest,
  maxFoldSeq,
  newRoutingId,
  normalizeConfig,
  normalizeFolds,
  performanceCondition,
  rotationThresholds,
  summarizeSamples,
  systemPromptFingerprint,
  systemPromptText,
} from '../lib/core.js';

test('normalizeConfig applies defaults and clamps', () => {
  const config = normalizeConfig({
    foldsWindow: 0,
    cacheHitThresholdPct: 500,
    sampleSize: 0,
    requestCheckDelaysMs: [10, -1, 'x', 20],
  });
  assert.equal(config.enabled, true);
  assert.equal(normalizeConfig({}).cacheHitThresholdPct, 25);
  assert.equal(config.foldsWindow, 1);
  assert.equal(config.cacheHitThresholdPct, 100);
  assert.equal(config.sampleSize, 1);
  assert.equal(normalizeConfig({}).ttftThresholdMs, 12000);
  assert.equal(normalizeConfig({}).stepTtftGraceMs, 2000);
  assert.equal(normalizeConfig({}).stepThroughputGraceTps, 5);
  assert.equal(normalizeConfig({}).systemRewriteBypassCache, true);
  assert.equal(normalizeConfig({ systemRewriteBypassCache: false }).systemRewriteBypassCache, false);
  assert.equal(normalizeConfig({}).foldRotationMode, 'defer');
  assert.equal(normalizeConfig({ foldRotationMode: 'IMMEDIATE' }).foldRotationMode, 'immediate');
  assert.equal(normalizeConfig({ foldRotationMode: 'off' }).foldRotationMode, 'off');
  assert.equal(normalizeConfig({ foldRotationMode: 'bogus' }).foldRotationMode, 'defer');
  assert.equal(normalizeConfig({ foldDeferIdleMs: -5 }).foldDeferIdleMs, 0);
  assert.equal(normalizeConfig({ foldDeferMaxRequests: 2.6 }).foldDeferMaxRequests, 3);
  assert.equal(normalizeConfig({}).preFoldHook, true);
  assert.equal(normalizeConfig({ preFoldHook: false }).preFoldHook, false);
  assert.equal(normalizeConfig({}).preFoldHookPath.endsWith(path.join('storages', 'opencode-router', 'pre-fold-hook.json')), true);
  assert.equal(normalizeConfig({ preFoldHookPath: '~/custom-hook.json' }).preFoldHookPath, path.join(os.homedir(), 'custom-hook.json'));
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

test('cacheCondition uses the latest folds window', () => {
  const config = normalizeConfig({ foldsWindow: 2, cacheHitThresholdPct: 5 });
  assert.equal(cacheCondition([{ seq: 1, hPct: 0 }, { seq: 2, hPct: 4 }], config).bad, true);
  assert.equal(cacheCondition([{ seq: 1, hPct: 0 }, { seq: 2, hPct: 6 }], config).bad, false);
  assert.equal(cacheCondition([{ seq: 1, hPct: 0 }], config).bad, false);
  assert.equal(cacheCondition([{ seq: 1, hPct: null }, { seq: 2, hPct: 0 }], config).bad, false);
});

test('cache threshold default is 25 percent and inclusive', () => {
  const config = normalizeConfig({});
  assert.equal(cacheCondition([{ seq: 1, hPct: 25 }], config).bad, true);
  assert.equal(cacheCondition([{ seq: 1, hPct: 25.1 }], config).bad, false);
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

test('decideRotation applies the stepped performance threshold', () => {
  const config = normalizeConfig({ sampleSize: 5, cacheHitThresholdPct: 5 });
  const badCache = [{ seq: 1, hPct: 0 }];
  const at13s = Array.from({ length: 5 }, () => ({ ttftMs: 13000, tps: 100 }));
  assert.equal(decideRotation({ previousFolds: badCache, samples: at13s, config }).rotate, true);
  assert.equal(decideRotation({ previousFolds: badCache, samples: at13s, config, consecutiveFailures: 1 }).rotate, false);
  const at14s = Array.from({ length: 5 }, () => ({ ttftMs: 14000, tps: 100 }));
  assert.equal(decideRotation({ previousFolds: badCache, samples: at14s, config, consecutiveFailures: 1 }).rotate, true);
});

test('decideRotation requires both cache and performance problems', () => {
  const config = normalizeConfig({ sampleSize: 5, cacheHitThresholdPct: 5 });
  const slow = Array.from({ length: 5 }, () => ({ ttftMs: 25000, tps: 10 }));
  const badCache = [{ seq: 1, hPct: 0 }];
  const goodCache = [{ seq: 1, hPct: 90 }];
  assert.equal(decideRotation({ previousFolds: badCache, samples: slow, config }).rotate, true);
  assert.equal(decideRotation({ previousFolds: goodCache, samples: slow, config }).rotate, false);
  assert.equal(decideRotation({
    previousFolds: badCache,
    samples: Array.from({ length: 5 }, () => ({ ttftMs: 1000, tps: 100 })),
    config,
  }).rotate, false);
});

test('newRoutingId has the requested shape', () => {
  const id = newRoutingId('ses_');
  assert.match(id, /^ses_[0-9a-f]{24}$/);
  assert.notEqual(id, newRoutingId('ses_'));
  assert.equal(DEFAULTS.cacheHitThresholdPct, 25);
});

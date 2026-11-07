import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { biliSessionKey, biliStatePathCandidates, normalizeConfig } from '../lib/core.js';
import { SessionMonitor } from '../lib/monitor.js';
import { RouterStore } from '../lib/store.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const sessionId = 'session-monitor-test';

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-router-monitor-'));
  const biliRoot = path.join(dir, 'bili');
  const config = normalizeConfig({
    biliSessionsDir: biliRoot,
    biliProtocol: 'openai',
    biliUpstreamHost: 'opencode.ai',
    statePath: path.join(dir, 'state.json'),
    pollIntervalMs: 1000,
    requestCheckDelaysMs: [],
    sampleSize: 5,
    requireFullSamples: true,
    cacheHitThresholdPct: 25,
    ttftThresholdMs: 20000,
    throughputThresholdTps: 60,
    debug: false,
    ...overrides,
  });
  const store = new RouterStore({ statePath: config.statePath, logger: quiet, debounceMs: 0 });
  let clock = 1000000;
  const monitor = new SessionMonitor({
    sessionId,
    config,
    store,
    logger: quiet,
    now: () => clock,
  });
  const stateFile = biliStatePathCandidates(sessionId, config)[0];
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  let pad = 0;
  const writeState = (folds) => {
    pad += 1;
    const payload = {
      payload: {
        metadata: {
          cacheLedger: {
            folds,
            pad: 'x'.repeat(pad),
          },
        },
      },
    };
    fs.writeFileSync(stateFile, JSON.stringify(payload), 'utf8');
  };
  t.after(async () => {
    monitor.dispose();
    await store.dispose();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return {
    config,
    store,
    monitor,
    stateFile,
    writeState,
    now: () => clock,
    advance: (ms) => { clock += ms; },
    tick: async () => { clock += 2000; await monitor.tick(); },
  };
}

/** Slow requests whose upstream cache is missing. */
function coldSlowSamples(store, count = 5, at = 0) {
  for (let i = 0; i < count; i += 1) {
    store.recordSample(sessionId, {
      ttftMs: 25000,
      tps: 10,
      outputTokens: 100,
      inputTokens: 1000,
      cacheReadTokens: 0,
      hitPct: 0,
      at: at + i,
    }, 20);
  }
}

/** Slow requests whose upstream cache is still warm. */
function warmSlowSamples(store, count = 5, at = 0) {
  for (let i = 0; i < count; i += 1) {
    store.recordSample(sessionId, {
      ttftMs: 25000,
      tps: 10,
      outputTokens: 100,
      inputTokens: 1000,
      cacheReadTokens: 99000,
      hitPct: 99,
      at: at + i,
    }, 20);
  }
}

/** Fast requests. */
function goodSamples(store, count = 5, at = 0) {
  for (let i = 0; i < count; i += 1) {
    store.recordSample(sessionId, {
      ttftMs: 1000,
      tps: 100,
      outputTokens: 100,
      inputTokens: 1000,
      cacheReadTokens: 99000,
      hitPct: 99,
      at: at + i,
    }, 20);
  }
}

test('fold ledger is followed as diagnostics only', async (t) => {
  const { store, monitor, writeState, tick } = setup(t);
  writeState([{ seq: 1, hPct: 0, at: 1 }]);
  await tick();
  assert.equal(monitor.status().baselineReady, true);
  assert.equal(monitor.status().lastFoldSeq, 1);
  assert.equal(monitor.status().latestFold.seq, 1);
  assert.equal(store.routeFor(sessionId), null);
  assert.equal(monitor.rotations, 0);

  writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 90, at: 2 }]);
  await tick();
  // A new fold never rotates by itself; only a pre-request prediction does.
  assert.equal(monitor.status().lastFoldSeq, 2);
  assert.equal(store.routeFor(sessionId), null);
  assert.equal(monitor.rotations, 0);
});

test('a request predicted cold on slow samples rotates before it is sent', async (t) => {
  const { store, monitor, writeState, tick } = setup(t);
  writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 90, at: 2 }]);
  await tick();
  coldSlowSamples(store);

  const result = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 3 });
  assert.equal(result.rotated, true);
  assert.equal(result.basis, 'cache-miss-persists');
  assert.equal(result.expectedPct, 0);
  assert.equal(result.cold, true);
  assert.equal(result.skipReason, null);

  const route = store.routeFor(sessionId);
  assert.ok(route);
  assert.match(route.value, /^ses_[0-9a-f]{24}$/);
  assert.equal(route.reason, 'predicted-cold');
  assert.equal(route.basis, 'cache-miss-persists');
  assert.equal(route.foldSeq, 2);
  assert.equal(route.cacheHitPct, 0);
  assert.equal(route.avgTtftMs, 25000);
  assert.equal(route.avgTps, 10);
  assert.equal(monitor.rotations, 1);
  assert.equal(monitor.status().predictions, 1);

  const history = store.history();
  assert.equal(history.length, 1);
  assert.equal(history[0].sessionId, sessionId);
  assert.equal(history[0].reason, 'predicted-cold');
  assert.equal(history[0].basis, 'cache-miss-persists');
  assert.equal(history[0].foldSeq, 2);
  assert.equal(history[0].beforeTtftMs, 25000);
  assert.equal(history[0].beforeTps, 10);
  assert.equal(history[0].beforeSamples, 5);
  assert.equal(history[0].afterSamples, 0);

  for (let i = 0; i < 5; i += 1) {
    store.recordSample(sessionId, {
      ttftMs: 2000 + i * 100,
      tps: 200 + i,
      outputTokens: 100,
      hitPct: 99,
      at: 2000000 + i,
    }, 20);
  }
  const after = store.history()[0];
  assert.equal(after.afterSamples, 5);
  assert.equal(after.afterTtftMs, 2200);
  assert.equal(after.afterTps, 202);
  assert.equal(after.afterComplete, true);
});

test('a warm cache keeps the current route even when requests are slow', async (t) => {
  const { store, monitor } = setup(t);
  warmSlowSamples(store);
  const result = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 3 });
  assert.equal(result.rotated, false);
  assert.equal(result.cold, false);
  assert.equal(result.basis, 'warm-history');
  assert.equal(result.skipReason, 'cache-expected-warm');
  assert.equal(store.routeFor(sessionId), null);
  assert.equal(monitor.rotations, 0);
});

test('no measured sample never rotates', async (t) => {
  const { store, monitor } = setup(t);
  const result = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 3 });
  assert.equal(result.rotated, false);
  assert.equal(result.basis, 'no-history');
  assert.equal(result.expectedPct, null);
  assert.equal(store.routeFor(sessionId), null);
});

test('a system prompt rewrite is predicted cold', async (t) => {
  const { store, monitor } = setup(t);
  warmSlowSamples(store);
  const first = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 3 });
  assert.equal(first.rotated, false);
  assert.equal(first.systemChanged, false);

  const second = monitor.prepareRequest({ systemPrompt: 'system B', messageCount: 4 });
  assert.equal(second.systemChanged, true);
  assert.equal(second.basis, 'system-rewrite');
  assert.equal(second.expectedPct, 0);
  assert.equal(second.rotated, true);
  const stored = store.routeFor(sessionId);
  assert.equal(stored.reason, 'predicted-cold');
  assert.equal(stored.basis, 'system-rewrite');
  assert.equal(monitor.rotations, 1);

  // A rewrite usually triggers a fold rebuild afterwards; that fold must not
  // add a second rotation for the same miss.
  const third = monitor.prepareRequest({ systemPrompt: 'system B', messageCount: 5 });
  assert.equal(third.systemChanged, false);
  assert.equal(third.rotated, false);
  assert.equal(monitor.rotations, 1);
});

test('a compacted message history is predicted cold', async (t) => {
  const { store, monitor } = setup(t);
  warmSlowSamples(store);
  monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 40 });
  const grown = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 42 });
  assert.equal(grown.historyShrank, false);
  assert.equal(grown.rotated, false);

  const compacted = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 12 });
  assert.equal(compacted.historyShrank, true);
  assert.equal(compacted.basis, 'history-compacted');
  assert.equal(compacted.rotated, true);
});

test('an idle gap beyond the cache TTL is predicted cold', async (t) => {
  const { store, monitor, advance } = setup(t, { cacheTtlMs: 60000 });
  warmSlowSamples(store);
  monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 3 });
  monitor.touch();

  advance(30000);
  const fresh = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 4 });
  assert.equal(fresh.basis, 'warm-history');
  assert.equal(fresh.rotated, false);

  advance(40000);
  const expired = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 5 });
  assert.equal(expired.basis, 'idle-expired');
  assert.equal(expired.idleMs, 70000);
  assert.equal(expired.rotated, true);
});

test('a fold rebuild prefill keeps the next request warm', async (t) => {
  const { store, monitor, writeState, tick } = setup(t);
  // The rebuild itself was cold but prefilled a large prompt.
  store.recordSample(sessionId, {
    ttftMs: 25000,
    tps: 10,
    outputTokens: 100,
    inputTokens: 90000,
    cacheReadTokens: 0,
    hitPct: 0,
    at: 10,
  }, 20);
  writeState([{ seq: 1, hPct: 0, at: 11 }]);
  await tick();

  const result = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 3 });
  assert.equal(result.cold, false);
  assert.equal(result.basis, 'fold-rebuild-prefilled');
  assert.equal(result.expectedPct, 100);
  assert.equal(result.rotated, false);
  assert.equal(store.routeFor(sessionId), null);
});

test('a cold prediction still needs slow samples', async (t) => {
  const { store, monitor } = setup(t);
  store.recordSample(sessionId, {
    ttftMs: 1000,
    tps: 100,
    outputTokens: 100,
    hitPct: 0,
    at: 1,
  }, 20);
  const result = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 3 });
  assert.equal(result.cold, true);
  assert.equal(result.rotated, false);
  assert.equal(result.skipReason, 'performance-ok');
  assert.equal(store.routeFor(sessionId), null);
});

test('fewer than five samples prevents rotation by default', async (t) => {
  const { store, monitor } = setup(t);
  coldSlowSamples(store, 4);
  const result = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 3 });
  assert.equal(result.cold, true);
  assert.equal(result.skipReason, 'performance-ok');
  assert.equal(monitor.rotations, 0);
});

test('predictive rotation can be disabled', async (t) => {
  const { store, monitor } = setup(t, { predictiveRotation: false });
  coldSlowSamples(store);
  const result = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 3 });
  assert.equal(result.rotated, false);
  assert.equal(result.skipReason, 'predictive-rotation-off');
  assert.equal(store.routeFor(sessionId), null);
});

test('a non-DeepSeek request state blocks rotation', async (t) => {
  const { store, monitor } = setup(t);
  coldSlowSamples(store);
  monitor.setTargetActive(false);
  const result = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 3 });
  assert.equal(result.rotated, false);
  assert.equal(result.skipReason, 'not-target');
  assert.equal(store.routeFor(sessionId), null);

  monitor.setTargetActive(true);
  const retried = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 3 });
  assert.equal(retried.rotated, true);
  assert.ok(store.routeFor(sessionId));
});

test('the minimum rotation gap blocks a second switch', async (t) => {
  const { store, monitor, advance } = setup(t, { minRotationGapMs: 10000 });
  coldSlowSamples(store);
  const first = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 3 });
  assert.equal(first.rotated, true);

  advance(5000);
  const blocked = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 4 });
  assert.equal(blocked.rotated, false);
  assert.equal(blocked.skipReason, 'cooldown');

  advance(6000);
  const allowed = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 5 });
  assert.equal(allowed.rotated, true);
  assert.equal(monitor.rotations, 2);
});

test('consecutive failed switches widen the next prediction threshold', async (t) => {
  const { store, monitor, advance, now } = setup(t, {
    ttftThresholdMs: 20000,
    throughputThresholdTps: 60,
    stepTtftGraceMs: 2000,
    stepThroughputGraceTps: 5,
  });
  coldSlowSamples(store);
  const first = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 3 });
  assert.equal(first.rotated, true);
  assert.equal(first.step, 0);
  assert.equal(store.routeFor(sessionId).step, 0);

  // The first post-switch window is still slower than the base 20s target.
  for (let i = 0; i < 5; i += 1) {
    store.recordSample(sessionId, {
      ttftMs: 21000,
      tps: 100,
      outputTokens: 100,
      hitPct: 0,
      at: now() + 100 + i,
    }, 20);
  }
  const status = monitor.status();
  assert.equal(status.stepping.consecutiveFailures, 1);
  assert.equal(status.stepping.effectiveTtftThresholdMs, 22000);
  assert.equal(status.stepping.effectiveThroughputThresholdTps, 55);

  advance(1000);
  const underStep = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 4 });
  assert.equal(underStep.rotated, false);
  assert.equal(underStep.skipReason, 'performance-ok');
  assert.equal(underStep.step, 1);

  for (let i = 0; i < 5; i += 1) {
    store.recordSample(sessionId, {
      ttftMs: 23000,
      tps: 100,
      outputTokens: 100,
      hitPct: 0,
      at: now() + 200 + i,
    }, 20);
  }
  advance(1000);
  const overStep = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 5 });
  assert.equal(overStep.rotated, true);
  assert.equal(store.routeFor(sessionId).step, 1);
});

test('fold sequence rollback rebaselines without rotating', async (t) => {
  const { store, monitor, writeState, tick } = setup(t);
  writeState([{ seq: 5, hPct: 0, at: 5 }]);
  await tick();
  coldSlowSamples(store);
  writeState([{ seq: 3, hPct: 0, at: 3 }]);
  await tick();
  assert.equal(monitor.status().lastFoldSeq, 3);
  assert.equal(store.routeFor(sessionId), null);
  assert.equal(monitor.rotations, 0);
});

test('missing state file is harmless', async (t) => {
  const { monitor } = setup(t);
  await monitor.tick();
  assert.equal(monitor.status().baselineReady, false);
  assert.equal(monitor.rotations, 0);
});

test('rotation does not create or follow a state file keyed by the route value', async (t) => {
  const { config, store, monitor } = setup(t);
  coldSlowSamples(store);
  const result = monitor.prepareRequest({ systemPrompt: 'system A', messageCount: 3 });
  assert.equal(result.rotated, true);
  const route = store.routeFor(sessionId);
  assert.ok(route);
  assert.equal(fs.existsSync(biliStatePathCandidates(route.value, config)[0]), false);
  assert.equal(monitor.status().watchingId, sessionId);
});

test('discovers a state file when the host label has changed', async (t) => {
  const { config, monitor, stateFile, writeState, tick } = setup(t);
  const key = biliSessionKey(sessionId);
  const alternate = path.join(path.dirname(stateFile), 'other_' + key + '.json');
  writeState([{ seq: 1, hPct: 0, at: 1 }]);
  fs.renameSync(stateFile, alternate);
  await tick();
  assert.equal(monitor.status().stateFile, alternate);
  assert.equal(monitor.status().baselineReady, true);
  assert.equal(monitor.status().lastFoldSeq, 1);
});

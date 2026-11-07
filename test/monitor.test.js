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
    cacheHitThresholdPct: 5,
    foldRotationMode: 'immediate',
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

function badSamples(store, count = 5) {
  for (let i = 0; i < count; i += 1) {
    store.recordSample(sessionId, {
      ttftMs: 25000,
      tps: 10,
      outputTokens: 100,
      at: i,
    }, 20);
  }
}

function goodSamples(store, count = 5) {
  for (let i = 0; i < count; i += 1) {
    store.recordSample(sessionId, {
      ttftMs: 1000,
      tps: 100,
      outputTokens: 100,
      at: i,
    }, 20);
  }
}

test('first fold is a baseline and never rotates', async (t) => {
  const { store, monitor, writeState, tick } = setup(t);
  writeState([{ seq: 1, hPct: 0, at: 1 }]);
  await tick();
  assert.equal(monitor.status().baselineReady, true);
  assert.equal(monitor.status().lastFoldSeq, 1);
  assert.equal(store.routeFor(sessionId), null);
  assert.equal(monitor.rotations, 0);
});

test('next fold rotates when the previous fold lost cache and samples are slow', async (t) => {
  const { store, monitor, stateFile, writeState, tick } = setup(t);
  writeState([{ seq: 1, hPct: 0, at: 1 }]);
  await tick();
  badSamples(store);
  writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 80, at: 2 }]);
  await tick();
  const route = store.routeFor(sessionId);
  assert.ok(route);
  assert.match(route.value, /^ses_[0-9a-f]{24}$/);
  assert.equal(route.foldSeq, 2);
  assert.equal(route.cacheHitPct, 0);
  assert.equal(route.avgTtftMs, 25000);
  assert.equal(route.avgTps, 10);
  assert.equal(monitor.rotations, 1);
  let history = store.history();
  assert.equal(history.length, 1);
  assert.equal(history[0].sessionId, sessionId);
  assert.equal(history[0].reason, 'cache-and-performance');
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
      at: 2000000 + i,
    }, 20);
  }
  history = store.history();
  assert.equal(history[0].afterSamples, 5);
  assert.equal(history[0].afterTtftMs, 2200);
  assert.equal(history[0].afterTps, 202);
  assert.equal(history[0].afterComplete, true);
  // Restore slow samples for the later fold so this test still exercises a
  // second rotation; the first history window is already frozen.
  badSamples(store);
  // billion-context keeps one state file per DSH session; the rotated header
  // does not open a new state file. The monitor must keep watching this file.
  assert.equal(monitor.status().baselineReady, true);
  assert.equal(monitor.status().lastFoldSeq, 2);
  assert.equal(monitor.status().watchingId, sessionId);
  assert.equal(monitor.status().stateFile, stateFile);

  await tick();
  assert.equal(monitor.rotations, 1);

  // Rewriting the same fold list must not rotate again for the same rebuild.
  writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 80, at: 2 }]);
  await tick();
  assert.equal(monitor.rotations, 1);

  // A later bad fold can rotate again without changing files.
  writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 80, at: 2 }, { seq: 3, hPct: 0, at: 3 }]);
  await tick();
  assert.equal(monitor.rotations, 1);
  writeState([
    { seq: 1, hPct: 0, at: 1 },
    { seq: 2, hPct: 80, at: 2 },
    { seq: 3, hPct: 0, at: 3 },
    { seq: 4, hPct: 50, at: 4 },
  ]);
  await tick();
  assert.equal(monitor.rotations, 2);
  assert.notEqual(store.routeFor(sessionId).value, route.value);
});

test('consecutive failed switches widen the next fold rotation threshold', async (t) => {
  const { store, monitor, writeState, tick, now } = setup(t, {
    ttftThresholdMs: 20000,
    throughputThresholdTps: 60,
    stepTtftGraceMs: 2000,
    stepThroughputGraceTps: 5,
    minRotationGapMs: 0,
  });
  writeState([{ seq: 1, hPct: 0, at: 1 }]);
  await tick();
  badSamples(store);
  writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 0, at: 2 }]);
  await tick();
  assert.equal(monitor.rotations, 1);
  assert.equal(store.routeFor(sessionId).step, 0);

  // The first post-switch window is still slower than the base 20s target.
  for (let i = 0; i < 5; i += 1) {
    store.recordSample(sessionId, {
      ttftMs: 21000,
      tps: 100,
      outputTokens: 100,
      at: now() + 100 + i,
    }, 20);
  }
  let status = monitor.status();
  assert.equal(status.stepping.consecutiveFailures, 1);
  assert.equal(status.stepping.effectiveTtftThresholdMs, 22000);
  assert.equal(status.stepping.effectiveThroughputThresholdTps, 55);

  // 21s is below the stepped 22s threshold, so this fold does not rotate.
  writeState([
    { seq: 1, hPct: 0, at: 1 },
    { seq: 2, hPct: 0, at: 2 },
    { seq: 3, hPct: 0, at: 3 },
  ]);
  await tick();
  assert.equal(monitor.rotations, 1);

  // A slower window does cross the stepped threshold; the record notes step 1.
  for (let i = 0; i < 5; i += 1) {
    store.recordSample(sessionId, {
      ttftMs: 23000,
      tps: 100,
      outputTokens: 100,
      at: now() + 100 + i,
    }, 20);
  }
  writeState([
    { seq: 1, hPct: 0, at: 1 },
    { seq: 2, hPct: 0, at: 2 },
    { seq: 3, hPct: 0, at: 3 },
    { seq: 4, hPct: 0, at: 4 },
  ]);
  await tick();
  assert.equal(monitor.rotations, 2);
  assert.equal(store.routeFor(sessionId).step, 1);

  // After a second failed post-switch window the next threshold is 24s/50.
  for (let i = 0; i < 5; i += 1) {
    store.recordSample(sessionId, {
      ttftMs: 23000,
      tps: 100,
      outputTokens: 100,
      at: now() + 100 + i,
    }, 20);
  }
  status = monitor.status();
  assert.equal(status.stepping.consecutiveFailures, 2);
  assert.equal(status.stepping.effectiveTtftThresholdMs, 24000);
  assert.equal(status.stepping.effectiveThroughputThresholdTps, 50);

  writeState([
    { seq: 1, hPct: 0, at: 1 },
    { seq: 2, hPct: 0, at: 2 },
    { seq: 3, hPct: 0, at: 3 },
    { seq: 4, hPct: 0, at: 4 },
    { seq: 5, hPct: 0, at: 5 },
  ]);
  await tick();
  assert.equal(monitor.rotations, 2);
});

test('system rewrite rotation also uses the failure step', async (t) => {
  const { store, monitor, now } = setup(t, {
    ttftThresholdMs: 20000,
    throughputThresholdTps: 60,
    stepTtftGraceMs: 2000,
    stepThroughputGraceTps: 5,
  });
  badSamples(store);
  monitor.observeSystemPrompt('system A');
  monitor.observeSystemPrompt('system B');
  const first = monitor.rotateForSystemRewrite();
  assert.ok(first);
  assert.equal(first.step, 0);

  for (let i = 0; i < 5; i += 1) {
    store.recordSample(sessionId, {
      ttftMs: 21000,
      tps: 100,
      outputTokens: 100,
      at: now() + 100 + i,
    }, 20);
  }
  assert.equal(monitor.status().stepping.consecutiveFailures, 1);

  monitor.observeSystemPrompt('system C');
  assert.equal(monitor.rotateForSystemRewrite(), null);

  for (let i = 0; i < 5; i += 1) {
    store.recordSample(sessionId, {
      ttftMs: 23000,
      tps: 100,
      outputTokens: 100,
      at: now() + 200 + i,
    }, 20);
  }
  monitor.observeSystemPrompt('system D');
  const second = monitor.rotateForSystemRewrite();
  assert.ok(second);
  assert.equal(second.step, 1);
  assert.equal(store.routeFor(sessionId).step, 1);
});

test('a non-DeepSeek target state blocks rotation until a DeepSeek request returns', async (t) => {
  const { store, monitor, writeState, tick } = setup(t);
  writeState([{ seq: 1, hPct: 0, at: 1 }]);
  await tick();
  badSamples(store);

  monitor.setTargetActive(false);
  writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 0, at: 2 }]);
  await tick();
  assert.equal(monitor.status().targetActive, false);
  assert.equal(store.routeFor(sessionId), null);
  assert.equal(monitor.rotations, 0);

  monitor.setTargetActive(true);
  writeState([
    { seq: 1, hPct: 0, at: 1 },
    { seq: 2, hPct: 0, at: 2 },
    { seq: 3, hPct: 0, at: 3 },
  ]);
  await tick();
  assert.equal(monitor.status().targetActive, true);
  assert.ok(store.routeFor(sessionId));
  assert.equal(monitor.rotations, 1);
});

test('rotation does not create or follow a state file keyed by the route value', async (t) => {
  const { config, store, monitor, writeState, tick } = setup(t);
  writeState([{ seq: 1, hPct: 0, at: 1 }]);
  await tick();
  badSamples(store);
  writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 80, at: 2 }]);
  await tick();
  const route = store.routeFor(sessionId);
  assert.ok(route);
  assert.equal(monitor.rotations, 1);
  assert.equal(fs.existsSync(biliStatePathCandidates(route.value, config)[0]), false);
  assert.equal(monitor.status().stateFile, biliStatePathCandidates(sessionId, config)[0]);
});

test('good cache hit prevents rotation', async (t) => {
  const { store, monitor, writeState, tick } = setup(t);
  writeState([{ seq: 1, hPct: 90, at: 1 }]);
  await tick();
  badSamples(store);
  writeState([{ seq: 1, hPct: 90, at: 1 }, { seq: 2, hPct: 90, at: 2 }]);
  await tick();
  assert.equal(store.routeFor(sessionId), null);
  assert.equal(monitor.rotations, 0);
});

test('good performance prevents rotation', async (t) => {
  const { store, monitor, writeState, tick } = setup(t);
  writeState([{ seq: 1, hPct: 0, at: 1 }]);
  await tick();
  goodSamples(store);
  writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 0, at: 2 }]);
  await tick();
  assert.equal(store.routeFor(sessionId), null);
  assert.equal(monitor.rotations, 0);
});

test('fewer than five samples prevents rotation by default', async (t) => {
  const { store, monitor, writeState, tick } = setup(t);
  writeState([{ seq: 1, hPct: 0, at: 1 }]);
  await tick();
  badSamples(store, 4);
  writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 0, at: 2 }]);
  await tick();
  assert.equal(store.routeFor(sessionId), null);
  assert.equal(monitor.rotations, 0);
});

test('fold sequence rollback rebaselines without rotating', async (t) => {
  const { store, monitor, writeState, tick } = setup(t);
  writeState([{ seq: 5, hPct: 0, at: 5 }]);
  await tick();
  badSamples(store);
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

test('system prompt rewrite rotates with slow samples despite a healthy fold cache', async (t) => {
  const { store, monitor, writeState, tick } = setup(t);
  writeState([{ seq: 1, hPct: 90, at: 1 }]);
  await tick();
  badSamples(store);

  const first = monitor.observeSystemPrompt('system A');
  assert.equal(first.changed, false);
  assert.equal(monitor.rotateForSystemRewrite(), null);
  assert.equal(store.routeFor(sessionId), null);

  const changed = monitor.observeSystemPrompt('system B');
  assert.equal(changed.changed, true);
  const route = monitor.rotateForSystemRewrite();
  assert.ok(route);
  const stored = store.routeFor(sessionId);
  assert.equal(stored.reason, 'system-rewrite');
  assert.equal(stored.foldSeq, null);
  assert.equal(stored.cacheHitPct, null);
  assert.equal(stored.avgTtftMs, 25000);
  assert.equal(stored.avgTps, 10);
  assert.equal(monitor.rotations, 1);
  assert.equal(monitor.status().systemRewriteRotations, 1);
  assert.ok(monitor.status().systemPromptFp);

  // The rewrite often causes a fold rebuild shortly afterwards. That fold
  // must not trigger a second rotation for the same cache miss.
  writeState([{ seq: 1, hPct: 90, at: 1 }, { seq: 2, hPct: 90, at: 2 }]);
  await tick();
  assert.equal(monitor.rotations, 1);
});

test('system prompt rewrite can rotate before any fold is seen', async (t) => {
  const { store, monitor } = setup(t);
  badSamples(store);

  const first = monitor.observeSystemPrompt('system A');
  assert.equal(first.changed, false);
  assert.equal(monitor.status().baselineReady, false);
  assert.equal(monitor.status().lastFoldSeq, null);

  const changed = monitor.observeSystemPrompt('system B');
  assert.equal(changed.changed, true);
  const route = monitor.rotateForSystemRewrite();
  assert.ok(route);
  assert.equal(route.reason, 'system-rewrite');
  assert.equal(route.foldSeq, null);
  assert.equal(store.routeFor(sessionId).reason, 'system-rewrite');
  assert.equal(monitor.rotations, 1);
  assert.equal(monitor.status().baselineReady, false);
});

test('system prompt rewrite does not rotate when samples are fast', async (t) => {
  const { store, monitor, writeState, tick } = setup(t);
  writeState([{ seq: 1, hPct: 90, at: 1 }]);
  await tick();
  goodSamples(store);
  monitor.observeSystemPrompt('system A');
  monitor.observeSystemPrompt('system B');
  assert.equal(monitor.rotateForSystemRewrite(), null);
  assert.equal(store.routeFor(sessionId), null);
  assert.equal(monitor.rotations, 0);
});

test('system rewrite bypass can be disabled or blocked by a non-DeepSeek request', async (t) => {
  const disabled = setup(t, { systemRewriteBypassCache: false });
  disabled.writeState([{ seq: 1, hPct: 90, at: 1 }]);
  await disabled.tick();
  badSamples(disabled.store);
  disabled.monitor.observeSystemPrompt('system A');
  disabled.monitor.observeSystemPrompt('system B');
  assert.equal(disabled.monitor.rotateForSystemRewrite(), null);
  assert.equal(disabled.store.routeFor(sessionId), null);

  const nonTarget = setup(t);
  nonTarget.writeState([{ seq: 1, hPct: 90, at: 1 }]);
  await nonTarget.tick();
  badSamples(nonTarget.store);
  nonTarget.monitor.setTargetActive(false);
  nonTarget.monitor.observeSystemPrompt('system A');
  nonTarget.monitor.observeSystemPrompt('system B');
  assert.equal(nonTarget.monitor.rotateForSystemRewrite(), null);
  assert.equal(nonTarget.store.routeFor(sessionId), null);
});


test('deferred fold rotation waits for a system prompt rewrite', async (t) => {
  const { store, monitor, writeState, tick } = setup(t, { foldRotationMode: 'defer' });
  writeState([{ seq: 1, hPct: 0, at: 1 }]);
  await tick();
  badSamples(store);
  writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 0, at: 2 }]);
  await tick();

  assert.equal(store.routeFor(sessionId), null);
  assert.equal(monitor.rotations, 0);
  let status = monitor.status();
  assert.equal(status.pendingRotation.foldSeq, 2);
  assert.equal(status.pendingRotation.requests, 0);
  assert.equal(status.deferredRotations, 1);

  monitor.observeSystemPrompt('system A');
  monitor.observeSystemPrompt('system B');
  const route = monitor.rotateForSystemRewrite();
  assert.ok(route);
  assert.equal(route.reason, 'fold-deferred');
  assert.equal(route.foldSeq, 2);
  assert.equal(store.routeFor(sessionId).reason, 'fold-deferred');
  assert.equal(monitor.rotations, 1);
  assert.equal(monitor.status().pendingRotation, null);
  assert.equal(monitor.status().systemRewriteRotations, 1);
  const history = store.history();
  assert.equal(history.length, 1);
  assert.equal(history[0].reason, 'fold-deferred');
  assert.equal(history[0].foldSeq, 2);
});

test('deferred fold rotation waits for an idle request', async (t) => {
  const { store, monitor, writeState, tick, advance } = setup(t, {
    foldRotationMode: 'defer',
    foldDeferIdleMs: 1000,
  });
  writeState([{ seq: 1, hPct: 0, at: 1 }]);
  await tick();
  badSamples(store);
  writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 0, at: 2 }]);
  await tick();
  assert.ok(monitor.status().pendingRotation);

  monitor.touch();
  advance(500);
  assert.equal(monitor.prepareRequest(), null);
  assert.equal(store.routeFor(sessionId), null);
  assert.equal(monitor.status().pendingRotation.requests, 1);

  advance(600);
  const route = monitor.prepareRequest();
  assert.ok(route);
  assert.equal(route.reason, 'fold-deferred');
  assert.equal(route.foldSeq, 2);
  assert.equal(monitor.status().pendingRotation, null);
  assert.equal(monitor.rotations, 1);
});

test('a good fold clears a pending deferred rotation', async (t) => {
  const { store, monitor, writeState, tick } = setup(t, { foldRotationMode: 'defer' });
  writeState([{ seq: 1, hPct: 0, at: 1 }]);
  await tick();
  badSamples(store);
  writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 0, at: 2 }]);
  await tick();
  assert.ok(monitor.status().pendingRotation);

  writeState([
    { seq: 1, hPct: 0, at: 1 },
    { seq: 2, hPct: 0, at: 2 },
    { seq: 3, hPct: 90, at: 3 },
  ]);
  await tick();
  assert.equal(monitor.status().pendingRotation.foldSeq, 3);

  writeState([
    { seq: 1, hPct: 0, at: 1 },
    { seq: 2, hPct: 0, at: 2 },
    { seq: 3, hPct: 90, at: 3 },
    { seq: 4, hPct: 90, at: 4 },
  ]);
  await tick();
  assert.equal(monitor.status().pendingRotation, null);
  assert.equal(store.routeFor(sessionId), null);
  assert.equal(monitor.rotations, 0);
});

test('fold rotation can be disabled without disabling system rewrite rotation', async (t) => {
  const { store, monitor, writeState, tick } = setup(t, { foldRotationMode: 'off' });
  writeState([{ seq: 1, hPct: 0, at: 1 }]);
  await tick();
  badSamples(store);
  writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 0, at: 2 }]);
  await tick();
  assert.equal(monitor.status().pendingRotation, null);
  assert.equal(store.routeFor(sessionId), null);
  assert.equal(monitor.rotations, 0);
});

test('maxDeferRequests forces a pending rotation before the next request', async (t) => {
  const { store, monitor, writeState, tick } = setup(t, {
    foldRotationMode: 'defer',
    foldDeferIdleMs: 0,
    foldDeferMaxRequests: 1,
  });
  writeState([{ seq: 1, hPct: 0, at: 1 }]);
  await tick();
  badSamples(store);
  writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 0, at: 2 }]);
  await tick();
  monitor.touch();
  assert.equal(monitor.prepareRequest(), null);
  const route = monitor.prepareRequest();
  assert.ok(route);
  assert.equal(route.reason, 'fold-deferred');
  assert.equal(store.routeFor(sessionId).reason, 'fold-deferred');
});

test('pre-fold hook consumes a pending rotation on the rebuild request', async (t) => {
  const { store, monitor, writeState, tick } = setup(t, { foldRotationMode: 'defer' });
  writeState([{ seq: 1, hPct: 0, at: 1 }]);
  await tick();
  badSamples(store);
  writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 0, at: 2 }]);
  await tick();
  assert.equal(monitor.status().pendingRotation.foldSeq, 2);

  const route = await monitor.preflight();
  assert.ok(route);
  assert.equal(route.reason, 'fold-preflight');
  assert.equal(route.foldSeq, 2);
  assert.equal(store.routeFor(sessionId).reason, 'fold-preflight');
  assert.equal(monitor.status().pendingRotation, null);
  assert.equal(monitor.status().preflightRotations, 1);
  assert.ok(monitor.status().lastPreflightAt);
  assert.equal(monitor.rotations, 1);
  const history = store.history();
  assert.equal(history[0].reason, 'fold-preflight');
});

test('pre-fold hook picks up a fold that has not been polled yet', async (t) => {
  const { store, monitor, writeState, tick } = setup(t, { foldRotationMode: 'defer' });
  writeState([{ seq: 1, hPct: 0, at: 1 }]);
  await tick();
  badSamples(store);
  // The rebuild has finished and billion-context wrote fold #2, but the
  // periodic poll has not run. The hook must tick first and still switch.
  writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 0, at: 2 }]);

  const route = await monitor.preflight();
  assert.ok(route);
  assert.equal(route.reason, 'fold-preflight');
  assert.equal(route.foldSeq, 2);
  assert.equal(store.routeFor(sessionId).reason, 'fold-preflight');
  assert.equal(monitor.status().preflightRotations, 1);
});

test('pre-fold hook does nothing without a pending rotation', async (t) => {
  const { store, monitor } = setup(t, { foldRotationMode: 'defer' });
  assert.equal(await monitor.preflight(), null);
  assert.equal(store.routeFor(sessionId), null);
  assert.equal(monitor.status().preflightRotations, 0);
});

test('pre-fold hook is inactive outside defer mode', async (t) => {
  for (const mode of ['immediate', 'off']) {
    const { store, monitor, writeState, tick } = setup(t, { foldRotationMode: mode });
    writeState([{ seq: 1, hPct: 0, at: 1 }]);
    await tick();
    badSamples(store);
    writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 0, at: 2 }]);
    await tick();
    const before = store.routeFor(sessionId);
    assert.equal(await monitor.preflight(), null);
    assert.deepEqual(store.routeFor(sessionId), before);
    assert.equal(monitor.status().preflightRotations, 0);
  }
});

test('pre-fold hook rechecks conditions and drops a stale pending switch', async (t) => {
  const { store, monitor, writeState, tick } = setup(t, { foldRotationMode: 'defer' });
  writeState([{ seq: 1, hPct: 0, at: 1 }]);
  await tick();
  badSamples(store);
  writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 0, at: 2 }]);
  await tick();
  assert.ok(monitor.status().pendingRotation);

  // Performance recovered before the rebuild. The hook must re-evaluate the
  // pending decision instead of rotating on stale evidence.
  goodSamples(store);
  assert.equal(await monitor.preflight(), null);
  assert.equal(store.routeFor(sessionId), null);
  assert.equal(monitor.status().pendingRotation, null);
});

test('pre-fold hook respects target eligibility and cooldown', async (t) => {
  const nonTarget = setup(t, { foldRotationMode: 'defer' });
  nonTarget.writeState([{ seq: 1, hPct: 0, at: 1 }]);
  await nonTarget.tick();
  badSamples(nonTarget.store);
  nonTarget.writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 0, at: 2 }]);
  await nonTarget.tick();
  nonTarget.monitor.setTargetActive(false);
  assert.equal(await nonTarget.monitor.preflight(), null);
  assert.equal(nonTarget.store.routeFor(sessionId), null);

  const cooled = setup(t, { foldRotationMode: 'defer', minRotationGapMs: 60000 });
  cooled.writeState([{ seq: 1, hPct: 0, at: 1 }]);
  await cooled.tick();
  badSamples(cooled.store);
  cooled.writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 0, at: 2 }]);
  await cooled.tick();
  assert.ok(cooled.monitor.status().pendingRotation);
  // A switch that happened just now must gate the pending one.
  cooled.store.setRoute(sessionId, {
    value: 'ses_existing',
    rotatedAt: cooled.now(),
    foldSeq: null,
    reason: 'test',
  });
  assert.equal(await cooled.monitor.preflight(), null);
  assert.equal(cooled.store.routeFor(sessionId).value, 'ses_existing');
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

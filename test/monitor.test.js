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
  return { config, store, monitor, stateFile, writeState, tick: async () => { clock += 2000; await monitor.tick(); } };
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

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

function setup(t) {
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
  t.after(() => {
    monitor.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
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
  const { store, monitor, writeState, tick } = setup(t);
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
  // The monitor immediately follows the new conversation: the old state file
  // is no longer the source of truth and the baseline is re-armed.
  assert.equal(monitor.status().baselineReady, false);
  assert.equal(monitor.status().lastFoldSeq, null);
  assert.equal(monitor.status().watchingId, route.value);

  await tick();
  assert.equal(monitor.rotations, 1);

  // The old file must be ignored after the rotation, not used to rotate again.
  writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 80, at: 2 }, { seq: 3, hPct: 90, at: 3 }]);
  await tick();
  assert.equal(monitor.rotations, 1);
  assert.equal(store.routeFor(sessionId).value, route.value);
});

test('after rotation the monitor follows the new conversation state file', async (t) => {
  const { config, store, monitor, writeState, tick } = setup(t);
  writeState([{ seq: 1, hPct: 0, at: 1 }]);
  await tick();
  badSamples(store);
  writeState([{ seq: 1, hPct: 0, at: 1 }, { seq: 2, hPct: 80, at: 2 }]);
  await tick();
  const first = store.routeFor(sessionId);
  assert.ok(first);
  assert.equal(monitor.rotations, 1);

  // billion-context names its state file after the upstream conversation id,
  // so a rotation means a brand new file keyed by the routing id.
  const nextFile = biliStatePathCandidates(first.value, config)[0];
  fs.mkdirSync(path.dirname(nextFile), { recursive: true });
  let pad = 0;
  const writeNext = (folds) => {
    pad += 1;
    fs.writeFileSync(nextFile, JSON.stringify({
      payload: { metadata: { cacheLedger: { folds, pad: 'y'.repeat(pad) } } },
    }), 'utf8');
  };

  writeNext([{ seq: 1, hPct: 0, at: 10 }]);
  await tick();
  assert.equal(monitor.status().stateFile, nextFile);
  assert.equal(monitor.status().baselineReady, true);
  assert.equal(monitor.status().lastFoldSeq, 1);

  // A later fold on the new conversation can rotate again.
  writeNext([{ seq: 1, hPct: 0, at: 10 }, { seq: 2, hPct: 60, at: 20 }]);
  await tick();
  assert.equal(monitor.rotations, 2);
  const second = store.routeFor(sessionId);
  assert.ok(second);
  assert.notEqual(second.value, first.value);
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

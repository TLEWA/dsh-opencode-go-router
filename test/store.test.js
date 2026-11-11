import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RouterStore } from '../lib/store.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function waitFor(predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error('timed out waiting for condition'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-router-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('RouterStore persists routes and samples', async (t) => {
  const dir = tempDir(t);
  const statePath = path.join(dir, 'state.json');
  const store = new RouterStore({ statePath, logger: quiet, debounceMs: 0 });
  const route = store.setRoute('session-1', {
    value: 'ses_abc',
    rotatedAt: null,
    foldSeq: null,
    reason: 'cache-and-performance',
    cacheHitPct: 0,
    step: 1,
    avgTtftMs: 25000,
    avgTps: 10,
  });
  assert.equal(route.value, 'ses_abc');
  assert.equal(route.rotatedAt, null);
  assert.equal(route.foldSeq, null);
  assert.equal(route.step, 1);

  store.recordSample('session-1', { ttftMs: 1200, tps: 42.5, outputTokens: 100, at: 10 });
  store.recordSample('session-1', { ttftMs: -1, tps: 42.5, outputTokens: 100, at: 11 });
  store.recordSample('session-1', { ttftMs: 1200, tps: 0, outputTokens: 100, at: 12 });
  assert.equal(store.samplesFor('session-1').length, 1);

  const copy = store.samplesFor('session-1');
  copy[0].tps = 999;
  assert.equal(store.samplesFor('session-1')[0].tps, 42.5);

  await store.flush();
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(persisted.routes['session-1'].value, 'ses_abc');
  assert.equal(persisted.routes['session-1'].step, 1);
  assert.equal(persisted.metrics['session-1'].length, 1);

  const reloaded = new RouterStore({ statePath, logger: quiet, debounceMs: 0 });
  assert.equal(reloaded.routeFor('session-1').value, 'ses_abc');
  assert.equal(reloaded.routeFor('session-1').step, 1);
  assert.equal(reloaded.samplesFor('session-1')[0].tps, 42.5);
});

test('RouterStore records rotation history and freezes the after window', async (t) => {
  const dir = tempDir(t);
  const statePath = path.join(dir, 'state.json');
  const store = new RouterStore({ statePath, logger: quiet, debounceMs: 0, sampleSize: 5 });
  store.addRotation({
    sessionId: 'session-1',
    at: 1000,
    value: 'ses_new',
    reason: 'cache-and-performance',
    foldSeq: 3,
    cacheHitPct: 0,
    step: 1,
    beforeTtftMs: 25000,
    beforeTps: 10,
    beforeSamples: 5,
    afterTarget: 5,
  });
  let rows = store.history();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'session-1@1000');
  assert.equal(rows[0].step, 1);
  assert.equal(rows[0].beforeTtftMs, 25000);
  assert.equal(rows[0].afterSamples, 0);
  assert.equal(rows[0].afterComplete, false);

  for (let i = 0; i < 5; i += 1) {
    store.recordSample('session-1', {
      ttftMs: 1000 + i * 100,
      tps: 100 + i,
      outputTokens: 100,
      at: 2000 + i,
    });
  }
  rows = store.history();
  assert.equal(rows[0].afterSamples, 5);
  assert.equal(rows[0].afterTtftMs, 1200);
  assert.equal(rows[0].afterTps, 102);
  assert.equal(rows[0].afterComplete, true);

  store.recordSample('session-1', { ttftMs: 9999, tps: 9999, outputTokens: 100, at: 3000 });
  assert.equal(store.history()[0].afterTtftMs, 1200);

  await store.flush();
  const reloaded = new RouterStore({ statePath, logger: quiet, debounceMs: 0, sampleSize: 5 });
  assert.equal(reloaded.history()[0].afterTtftMs, 1200);
  assert.equal(reloaded.history()[0].step, 1);
});

test('RouterStore seeds history from existing routes', async (t) => {
  const dir = tempDir(t);
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    updatedAt: 1,
    routes: {
      'session-old': {
        value: 'ses_old',
        rotatedAt: 1000,
        foldSeq: 7,
        reason: 'cache-and-performance',
        cacheHitPct: 0,
        avgTtftMs: 28000,
        avgTps: 80,
      },
    },
    metrics: {
      'session-old': [
        { ttftMs: 2500, tps: 200, outputTokens: 100, at: 2000 },
        { ttftMs: 3000, tps: 220, outputTokens: 100, at: 3000 },
      ],
    },
  }), 'utf8');
  const store = new RouterStore({ statePath, logger: quiet, debounceMs: 0, sampleSize: 5 });
  const rows = store.history();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 'ses_old');
  assert.equal(rows[0].backfilled, true);
  assert.equal(rows[0].beforeTtftMs, 28000);
  assert.equal(rows[0].afterSamples, 2);
  assert.equal(rows[0].afterTtftMs, 2750);
});

test('RouterStore trims samples and backs up corrupt state', async (t) => {
  const dir = tempDir(t);
  const statePath = path.join(dir, 'state.json');
  const store = new RouterStore({ statePath, logger: quiet, debounceMs: 0 });
  for (let i = 0; i < 5; i += 1) {
    store.recordSample('s', { ttftMs: 100 + i, tps: 50, outputTokens: 10, at: i }, 2);
  }
  assert.deepEqual(store.samplesFor('s').map((sample) => sample.ttftMs), [103, 104]);

  fs.writeFileSync(statePath, '{not json', 'utf8');
  const recovered = new RouterStore({ statePath, logger: quiet, debounceMs: 0 });
  assert.deepEqual(recovered.snapshot().routes, {});
  const backups = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
  assert.equal(backups.length, 1);
});

test('RouterStore keeps request and pool-event logs for the settings page', async (t) => {
  const dir = tempDir(t);
  const statePath = path.join(dir, 'state.json');
  const store = new RouterStore({ statePath, logger: quiet, debounceMs: 0 });
  store.recordSample('s1', { ttftMs: 1000, tps: 100, inputTokens: 100, cacheReadTokens: 900, hitPct: 90, at: 1000 });
  store.recordSample('s2', { ttftMs: 3000, tps: 50, inputTokens: 800, cacheReadTokens: 200, hitPct: 20, at: 2000 });
  const event = {
    at: 1500,
    role: 'adopted',
    sessionId: 's1',
    sourceSessionId: 's0',
    matchPct: 92.5,
    tier: 1,
    code: 'ses_a',
    donorCode: 'ses_b',
    donorTtftMs: 1200,
    donorTps: 110,
    donorSamples: 5,
  };
  store.addPoolEvent(event);
  // Same instant, session and role is one exchange, not two.
  store.addPoolEvent(event);
  store.addPoolEvent({ at: 1700, role: 'revived', sessionId: 's2', code: 'ses_c', matchPct: 100, tier: 2 });
  assert.equal(store.poolEvents().length, 2);
  assert.equal(store.recentRequests()[0].sessionId, 's2');
  const stats = store.statistics();
  assert.equal(stats.requests.total, 2);
  assert.equal(stats.requests.avgHitPct, 55);
  assert.equal(stats.requests.warm, 1);
  assert.equal(stats.requests.cold, 1);
  assert.equal(stats.requests.avgTtftMs, 2000);
  assert.equal(stats.requests.avgTps, 75);
  assert.equal(stats.pool.swaps, 1);
  assert.equal(stats.pool.revivals, 1);
  assert.equal(stats.pool.lastSwapAt, 1500);

  await store.flush();
  const reloaded = new RouterStore({ statePath, logger: quiet, debounceMs: 0 });
  assert.equal(reloaded.recentRequests().length, 2);
  assert.equal(reloaded.poolEvents().length, 2);
  assert.equal(reloaded.statistics().requests.avgHitPct, 55);
});

test('RouterStore statistics ignore an unknown hitPct instead of counting it as 0%', async (t) => {
  const dir = tempDir(t);
  const store = new RouterStore({ statePath: path.join(dir, 'state.json'), logger: quiet, debounceMs: 0 });
  store.recordSample('s1', { ttftMs: 1000, tps: 100, inputTokens: 100, cacheReadTokens: 900, hitPct: 90, at: 1000 });
  store.recordSample('s2', { ttftMs: 3000, tps: 50, inputTokens: 0, cacheReadTokens: 0, hitPct: null, at: 2000 });
  const stats = store.statistics();
  assert.equal(stats.requests.total, 2);
  assert.equal(stats.requests.measured, 1);
  assert.equal(stats.requests.avgHitPct, 90);
  assert.equal(stats.requests.cold, 0);
});

test('RouterStore snapshots the first request on the adoption event', async (t) => {
  const dir = tempDir(t);
  const statePath = path.join(dir, 'state.json');
  const store = new RouterStore({ statePath, logger: quiet, debounceMs: 0 });
  store.setRoute('s1', {
    value: 'ses_a',
    reason: 'pool-adopted',
    rotatedAt: 1500,
    firstRequestAt: null,
    awaitingFirstRequest: true,
    samples: [],
  });
  store.addPoolEvent({ at: 1500, role: 'adopted', sessionId: 's1', sourceSessionId: 's0', code: 'ses_a' });
  store.recordSample('s1', {
    ttftMs: 1000,
    tps: 100,
    inputTokens: 100,
    cacheReadTokens: 900,
    hitPct: 90,
    at: 1600,
  });
  let event = store.poolEvents().find((item) => item.role === 'adopted' && item.sessionId === 's1');
  assert.equal(event.firstRequest.at, 1600);
  assert.equal(event.firstRequest.hitPct, 90);
  assert.equal(event.firstRequest.cacheReadTokens, 900);

  // A later warm request must not overwrite the first-request snapshot.
  store.recordSample('s1', {
    ttftMs: 900,
    tps: 120,
    inputTokens: 100,
    cacheReadTokens: 950,
    hitPct: 99,
    at: 1700,
  });
  event = store.poolEvents().find((item) => item.role === 'adopted' && item.sessionId === 's1');
  assert.equal(event.firstRequest.at, 1600);
  assert.equal(event.firstRequest.hitPct, 90);

  await store.flush();
  const reloaded = new RouterStore({ statePath, logger: quiet, debounceMs: 0 });
  event = reloaded.poolEvents().find((item) => item.role === 'adopted' && item.sessionId === 's1');
  assert.equal(event.firstRequest.at, 1600);
  assert.equal(event.firstRequest.hitPct, 90);
});

test('RouterStore ignores non-finite and blank values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-router-store-'));
  try {
    const store = new RouterStore({ statePath: path.join(dir, 'state.json'), logger: quiet, debounceMs: 0 });
    assert.equal(store.setRoute('s', { value: '' }), null);
    assert.equal(store.routeFor(null), null);
    assert.equal(store.routeFor('missing'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function flakyFs(state, transient) {
  return {
    mkdir: (...args) => fsp.mkdir(...args),
    writeFile: (...args) => fsp.writeFile(...args),
    unlink: (...args) => fsp.unlink(...args),
    rename: async (from, to) => {
      state.renameCalls += 1;
      const transientLeft = transient && transient.left > 0;
      if (transientLeft) transient.left -= 1;
      if (state.failRename || transientLeft) throw new Error('simulated rename failure');
      await fsp.rename(from, to);
    },
  };
}

test('RouterStore retries a failed state write and clears its tmp file', async (t) => {
  const dir = tempDir(t);
  const statePath = path.join(dir, 'state.json');
  const fsState = { renameCalls: 0, failRename: false };
  const fsMock = flakyFs(fsState, { left: 2 });
  const store = new RouterStore({
    statePath,
    logger: quiet,
    debounceMs: 0,
    fs: fsMock,
    writeAttempts: 3,
  });
  store.setRoute('session-1', { value: 'ses_abc' });
  await store.flush();
  assert.equal(fsState.renameCalls, 3);
  assert.equal(store.lastWriteError, null);
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(saved.routes['session-1'].value, 'ses_abc');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')), []);
});

test('RouterStore backs off after a failed write and retries instead of waiting for the next touch', async (t) => {
  const dir = tempDir(t);
  const statePath = path.join(dir, 'state.json');
  const fsState = { renameCalls: 0, failRename: true };
  const store = new RouterStore({
    statePath,
    logger: quiet,
    debounceMs: 0,
    fs: flakyFs(fsState),
    writeAttempts: 2,
    retryDelayMs: 1,
    retryMaxDelayMs: 4,
  });
  store.setRoute('session-1', { value: 'ses_abc' });
  await store.flush();
  assert.equal(fsState.renameCalls, 2);
  assert.equal(store.dirty, true);
  assert.ok(store.lastWriteError instanceof Error);
  assert.ok(store.retryTimer, 'expected a backoff timer after the failed write');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')), []);

  fsState.failRename = false;
  await waitFor(() => store.lastWriteError === null && store.retryTimer === null);
  assert.equal(store.dirty, false);
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(saved.routes['session-1'].value, 'ses_abc');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')), []);
});

test('RouterStore dispose retries a failed flush once and still persists', async (t) => {
  const dir = tempDir(t);
  const statePath = path.join(dir, 'state.json');
  const fsState = { renameCalls: 0, failRename: false };
  const store = new RouterStore({
    statePath,
    logger: quiet,
    debounceMs: 0,
    fs: flakyFs(fsState, { left: 1 }),
    writeAttempts: 1,
    retryDelayMs: 1,
  });
  store.setRoute('session-1', { value: 'ses_abc' });
  await store.dispose();
  assert.equal(fsState.renameCalls, 2, 'the failed flush must be retried once inline');
  assert.equal(store.disposed, true);
  assert.equal(store.dirty, false);
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(saved.routes['session-1'].value, 'ses_abc');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')), []);
});

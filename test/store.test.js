import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RouterStore } from '../lib/store.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

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
    avgTtftMs: 25000,
    avgTps: 10,
  });
  assert.equal(route.value, 'ses_abc');
  assert.equal(route.rotatedAt, null);
  assert.equal(route.foldSeq, null);

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
  assert.equal(persisted.metrics['session-1'].length, 1);

  const reloaded = new RouterStore({ statePath, logger: quiet, debounceMs: 0 });
  assert.equal(reloaded.routeFor('session-1').value, 'ses_abc');
  assert.equal(reloaded.samplesFor('session-1')[0].tps, 42.5);
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

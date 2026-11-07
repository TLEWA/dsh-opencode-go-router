import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../lib/core.js';
import { startPreFoldServer, tokenMatches } from '../lib/prefold.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-router-prefold-'));
  const hookPath = path.join(dir, 'pre-fold-hook.json');
  const calls = [];
  let result = null;
  const monitor = {
    async preflight(sessionId, meta) {
      calls.push({ sessionId, meta });
      return result;
    },
  };
  const config = normalizeConfig({
    statePath: path.join(dir, 'state.json'),
    preFoldHook: true,
    preFoldHookPath: hookPath,
    ...overrides,
  });
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return {
    dir,
    hookPath,
    calls,
    monitor,
    config,
    setResult(value) { result = value; },
  };
}

function request(url, options = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: JSON.stringify(options.body === undefined ? { sessionId: 'session-1' } : options.body),
    signal: AbortSignal.timeout(3000),
  });
}

test('tokenMatches requires the exact bearer token', () => {
  assert.equal(tokenMatches('Bearer abc', 'abc'), true);
  assert.equal(tokenMatches('bearer abc', 'abc'), false);
  assert.equal(tokenMatches('Bearer abd', 'abc'), false);
  assert.equal(tokenMatches('Bearer abc ', 'abc'), true);
  assert.equal(tokenMatches('', 'abc'), false);
  assert.equal(tokenMatches('Bearer abc', ''), false);
});

test('pre-fold server publishes a descriptor and rotates through the monitor', async (t) => {
  const s = setup(t);
  s.setResult({
    value: 'ses_new',
    reason: 'fold-preflight',
    foldSeq: 7,
    rotatedAt: Date.now(),
  });
  const hook = await startPreFoldServer({ monitor: s.monitor, config: s.config, logger: quiet });
  t.after(() => hook.close());
  assert.ok(hook);
  assert.equal(hook.summary().listening, true);
  assert.equal(hook.summary().path, s.hookPath);

  const descriptor = JSON.parse(fs.readFileSync(s.hookPath, 'utf8'));
  assert.equal(descriptor.version, 1);
  assert.equal(descriptor.url, hook.url);
  assert.equal(descriptor.token, hook.token);
  assert.equal(descriptor.pid, process.pid);

  const response = await request(hook.url, {
    headers: { authorization: 'Bearer ' + hook.token },
    body: { sessionId: 'session-1', reason: 'fold-rebuild' },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.rotate, true);
  assert.equal(body.value, 'ses_new');
  assert.equal(body.reason, 'fold-preflight');
  assert.equal(body.foldSeq, 7);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].sessionId, 'session-1');
  assert.equal(s.calls[0].meta.reason, 'fold-rebuild');

  const summary = hook.summary();
  assert.equal(summary.requests, 1);
  assert.equal(summary.rotations, 1);
  assert.equal(summary.lastDecision.rotate, true);
  assert.equal(summary.lastDecision.value, 'ses_new');
  assert.equal(fs.existsSync(s.hookPath), true);

  await hook.close();
  assert.equal(fs.existsSync(s.hookPath), false);
  assert.equal(hook.summary().listening, false);
});

test('pre-fold server returns rotate false when there is no pending switch', async (t) => {
  const s = setup(t);
  const hook = await startPreFoldServer({ monitor: s.monitor, config: s.config, logger: quiet });
  t.after(() => hook.close());
  const response = await request(hook.url, { headers: { authorization: 'Bearer ' + hook.token } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.rotate, false);
  assert.equal(body.reason, 'no-pending-rotation');
  assert.equal(hook.summary().rotations, 0);
});

test('pre-fold server rejects unauthorized, wrong-method, wrong-path and invalid bodies', async (t) => {
  const s = setup(t);
  const hook = await startPreFoldServer({ monitor: s.monitor, config: s.config, logger: quiet });
  t.after(() => hook.close());

  let response = await request(hook.url);
  assert.equal(response.status, 401);

  response = await fetch(hook.url, { method: 'GET', signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');

  const wrongPath = new URL('/other', hook.url);
  response = await fetch(wrongPath, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + hook.token, 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 404);

  response = await request(hook.url, { headers: { authorization: 'Bearer ' + hook.token }, body: {} });
  assert.equal(response.status, 400);

  response = await request(hook.url, {
    headers: { authorization: 'Bearer ' + hook.token },
    body: { sessionId: '' },
  });
  assert.equal(response.status, 400);

  response = await fetch(hook.url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + hook.token, 'content-type': 'application/json' },
    body: 'not-json',
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 400);
  assert.equal(hook.summary().rotations, 0);
});

test('pre-fold server does not start when the config disables it', async (t) => {
  const s = setup(t, { preFoldHook: false });
  const hook = await startPreFoldServer({ monitor: s.monitor, config: s.config, logger: quiet });
  assert.equal(hook, null);
  assert.equal(fs.existsSync(s.hookPath), false);
});

test('pre-fold server reports disabled when the plugin is disabled', async (t) => {
  const s = setup(t, { enabled: false });
  const hook = await startPreFoldServer({ monitor: s.monitor, config: s.config, logger: quiet });
  t.after(() => hook.close());
  const response = await request(hook.url, { headers: { authorization: 'Bearer ' + hook.token } });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.rotate, false);
});

test('closing one hook does not remove a descriptor replaced by another instance', async (t) => {
  const s = setup(t);
  const first = await startPreFoldServer({ monitor: s.monitor, config: s.config, logger: quiet });
  const second = await startPreFoldServer({ monitor: s.monitor, config: s.config, logger: quiet });
  t.after(() => second.close());
  const descriptor = JSON.parse(fs.readFileSync(s.hookPath, 'utf8'));
  assert.equal(descriptor.token, second.token);
  await first.close();
  assert.equal(fs.existsSync(s.hookPath), true);
  assert.equal(JSON.parse(fs.readFileSync(s.hookPath, 'utf8')).token, second.token);
});

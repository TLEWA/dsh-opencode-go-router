import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../lib/core.js';
import { applyRoutingHeader, measureStream, mount, routingForRequest } from '../lib/impl.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeStore(value = 'ses_rotated') {
  return {
    routeFor(sessionId) {
      return sessionId === 's1' ? { value } : null;
    },
  };
}

test('routingForRequest only matches eligible provider sessions', () => {
  const config = normalizeConfig({});
  const store = fakeStore();
  assert.equal(routingForRequest({ provider: 'opencode-go', model: 'deepseek-v4.1-flash', sessionId: 's1' }, config, store).value, 'ses_rotated');
  assert.equal(routingForRequest({ provider: 'opencode-go', sessionId: 'other' }, config, store), null);
  assert.equal(routingForRequest({ provider: 'other', sessionId: 's1' }, config, store), null);
  assert.equal(routingForRequest({ provider: 'opencode-go', sessionId: 's1' }, normalizeConfig({ enabled: false }), store), null);
  assert.equal(routingForRequest({ provider: 'opencode-go' }, config, store), null);
});

test('applyRoutingHeader sets and preserves the header as configured', () => {
  const config = normalizeConfig({});
  const request = { provider: 'opencode-go', model: 'deepseek-v4.1-flash', sessionId: 's1' };
  const headers = new Headers();
  assert.equal(applyRoutingHeader(request, headers, config, fakeStore()), true);
  assert.equal(headers.get('x-opencode-session'), 'ses_rotated');

  const existing = new Headers({ 'x-opencode-session': 'ses_original' });
  const preserve = normalizeConfig({ overrideExistingHeader: false });
  assert.equal(applyRoutingHeader(request, existing, preserve, fakeStore()), false);
  assert.equal(existing.get('x-opencode-session'), 'ses_original');

  const otherProvider = new Headers();
  assert.equal(applyRoutingHeader({ provider: 'other', sessionId: 's1' }, otherProvider, config, fakeStore()), false);
  assert.equal(otherProvider.get('x-opencode-session'), null);
});

test('measureStream records TTFT, throughput and finish', async () => {
  const samples = [];
  const notes = [];
  const state = {
    startedAt: Date.now() - 1000,
    sessionId: 's1',
    config: { maxSamples: 20 },
    store: { recordSample(sessionId, sample) { samples.push({ sessionId, sample }); } },
    monitor: { noteRequestFinished(sessionId) { notes.push(sessionId); } },
    logger: quiet,
  };
  async function* source() {
    yield { type: 'block-start' };
    await delay(2);
    yield { type: 'reasoning-delta' };
    await delay(10);
    yield { type: 'usage', usage: { outputTokens: 100 } };
    yield { type: 'finish' };
  }
  const seen = [];
  for await (const chunk of measureStream(source(), state)) seen.push(chunk.type);
  assert.deepEqual(seen, ['block-start', 'reasoning-delta', 'usage', 'finish']);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].sessionId, 's1');
  assert.equal(samples[0].sample.outputTokens, 100);
  assert.ok(samples[0].sample.ttftMs >= 0);
  assert.ok(samples[0].sample.tps > 0);
  assert.deepEqual(notes, ['s1']);
});

test('measureStream ignores a stream without finish or usage', async () => {
  const samples = [];
  const state = {
    startedAt: Date.now(),
    sessionId: 's1',
    config: { maxSamples: 20 },
    store: { recordSample(sessionId, sample) { samples.push(sample); } },
    monitor: { noteRequestFinished() {} },
    logger: quiet,
  };
  async function* noFinish() {
    yield { type: 'text-delta' };
  }
  for await (const chunk of measureStream(noFinish(), state)) void chunk;
  assert.equal(samples.length, 0);

  async function* noOutput() {
    yield { type: 'text-delta' };
    yield { type: 'usage', usage: { outputTokens: 0 } };
    yield { type: 'finish' };
  }
  for await (const chunk of measureStream(noOutput(), state)) void chunk;
  assert.equal(samples.length, 0);
});

test('measureStream does not swallow source errors', async () => {
  const state = {
    startedAt: Date.now(),
    sessionId: 's1',
    config: { maxSamples: 20 },
    store: { recordSample() {} },
    monitor: { noteRequestFinished() {} },
    logger: quiet,
  };
  async function* broken() {
    yield { type: 'text-delta' };
    throw new Error('upstream failed');
  }
  await assert.rejects(async () => {
    for await (const chunk of measureStream(broken(), state)) void chunk;
  }, /upstream failed/);
});


test('mount wires request headers and stream hooks through a fake cordis context', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-router-mount-'));
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    updatedAt: Date.now(),
    routes: {
      s1: { value: 'ses_mounted', rotatedAt: Date.now(), foldSeq: 3, reason: 'test' },
    },
    metrics: {},
  }), 'utf8');

  const listeners = new Map();
  const disposers = [];
  const ctx = {
    logger: quiet,
    on(event, fn) { listeners.set(event, fn); },
    inject(_names, cb) { cb({}); },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    },
  };

  await mount(ctx, {
    enabled: true,
    statePath,
    pollIntervalMs: 60000,
    biliSessionsDir: path.join(dir, 'missing-sessions'),
  });

  const onHeaders = listeners.get('llm-pi-ai/request-headers');
  assert.equal(typeof onHeaders, 'function');
  const headers = new Headers({ 'x-opencode-session': 'ses_original' });
  const returned = onHeaders(
    { provider: 'opencode-go', model: 'deepseek-v4.1-flash', sessionId: 's1' },
    headers,
    () => headers,
  );
  assert.equal(returned, headers);
  assert.equal(headers.get('x-opencode-session'), 'ses_mounted');

  const onStream = listeners.get('llm/stream');
  assert.equal(typeof onStream, 'function');
  async function* source() {
    yield { type: 'text-delta' };
    yield { type: 'usage', usage: { outputTokens: 12 } };
    yield { type: 'finish' };
  }
  const chunks = [];
  for await (const chunk of onStream(
    { provider: 'opencode-go', model: 'deepseek-v4.1-flash', sessionId: 's1' },
    () => source(),
  )) chunks.push(chunk.type);
  assert.deepEqual(chunks, ['text-delta', 'usage', 'finish']);

  for (const disposer of disposers) disposer();
  await delay(20);
  fs.rmSync(dir, { recursive: true, force: true });
});

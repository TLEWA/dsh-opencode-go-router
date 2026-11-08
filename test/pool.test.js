import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig, promptDigestChunks } from '../lib/core.js';
import { SessionPool } from '../lib/pool.js';
import { RouterStore } from '../lib/store.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const BASE = 1700000000000;

function setup(t, overrides = {}) {
  const {
    getAgentStatus = () => 'idle',
    getArchivedSessionIds = () => [],
    ...configOverrides
  } = overrides;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-router-pool-'));
  const config = normalizeConfig({
    statePath: path.join(dir, 'state.json'),
    poolEnabled: true,
    poolIdleMs: 180000,
    poolMatchPct: 60,
    poolMinTps: 70,
    poolMaxTtftMs: 10000,
    poolSampleSize: 5,
    poolTier1Ms: 3600000,
    poolExpireMs: 86400000,
    poolMaxEntries: 10,
    debug: false,
    ...configOverrides,
  });
  const store = new RouterStore({ statePath: config.statePath, logger: quiet, debounceMs: 0 });
  const activity = {
    last: 0,
    busy: false,
    prune() {},
    lastActivityAt() { return this.last; },
    isBusy() { return this.busy; },
  };
  let clock = BASE;
  const pool = new SessionPool({
    store,
    config,
    logger: quiet,
    activity,
    now: () => clock,
    getAgentStatus,
    getArchivedSessionIds,
  });
  t.after(async () => {
    await store.dispose();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return {
    config,
    store,
    pool,
    activity,
    now: () => clock,
    advance(ms) { clock += ms; },
  };
}

function digestFor(text) {
  return promptDigestChunks({ system: 'You are a coding agent.', messages: [{ role: 'user', content: text }] });
}

function samples(count, ttftMs, tps) {
  return Array.from({ length: count }, (_, index) => ({
    ttftMs,
    tps,
    outputTokens: 100,
    at: BASE - 100000 + index,
  }));
}

function route(value, options = {}) {
  return {
    value,
    rotatedAt: options.rotatedAt == null ? BASE - 600000 : options.rotatedAt,
    lastActiveAt: options.lastActiveAt == null ? BASE - 600000 : options.lastActiveAt,
    digest: options.digest || [],
    digestChars: options.digestChars || 0,
    digestUpdatedAt: BASE - 600000,
    generatedAt: BASE - 600000,
    samples: options.samples || [],
    pooledAt: options.pooledAt == null ? null : options.pooledAt,
    sleepingAt: options.sleepingAt == null ? null : options.sleepingAt,
  };
}

test('prompt digests ignore call ids and match only the common prefix', () => {
  const one = promptDigestChunks({
    system: 'You are a coding agent.',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'tool-call', name: 'read', callId: 'call-a', arguments: { path: 'a.js' } }] },
    ],
  });
  const two = promptDigestChunks({
    system: 'You are a coding agent.',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'tool-call', name: 'read', callId: 'call-b', arguments: { path: 'a.js' } }] },
    ],
  });
  assert.deepEqual(one, two);
  assert.ok(one.chunks.every((chunk) => chunk.length === 16 && /^[0-9a-f]+$/.test(chunk)));

  const longer = promptDigestChunks({
    system: 'You are a coding agent.',
    messages: [{ role: 'user', content: 'hello world, this is a much longer follow-up question' }],
  });
  const match = (() => {
    let count = 0;
    while (count < one.chunks.length && count < longer.chunks.length && one.chunks[count] === longer.chunks[count]) count += 1;
    return (count / longer.chunks.length) * 100;
  })();
  assert.ok(match < 100);
  assert.ok(!JSON.stringify(one).includes('hello'));
});

test('a new session adopts a warm tier-1 code and hands back its fresh code', async (t) => {
  const ctx = setup(t);
  const digest = digestFor('same conversation');
  ctx.store.setRoute('old', route('ses_old', {
    digest: digest.chunks,
    digestChars: digest.chars,
    samples: samples(5, 2000, 100),
    pooledAt: BASE - 600000,
  }));
  const result = ctx.pool.prepareRoute({ sessionId: 'new', digest, now: BASE });
  assert.equal(result.action, 'adopted');
  assert.equal(result.matchPct, 100);
  assert.equal(result.tier, 1);
  assert.equal(result.sourceSessionId, 'old');
  assert.equal(result.skipPrediction, true);

  const adopted = ctx.store.routeFor('new');
  const donor = ctx.store.routeFor('old');
  assert.equal(adopted.value, 'ses_old');
  assert.equal(adopted.adoptedFrom, 'old');
  assert.equal(adopted.pooledAt, null);
  assert.equal(adopted.samples.length, 5);
  assert.notEqual(donor.value, 'ses_old');
  assert.equal(donor.sleepingAt, BASE);
  assert.equal(donor.pooledAt, null);
  assert.equal(donor.samples.length, 0);
  const history = ctx.store.history(10);
  assert.equal(history[0].reason, 'pool-adopted');
  assert.equal(history[1].reason, 'pool-donated');
});

test('tier 1 wins over a better tier-2 score, and tier 2 ranks by TTFT and throughput', async (t) => {
  const ctx = setup(t);
  const digest = digestFor('shared prefix');
  ctx.store.setRoute('tier1', route('ses_tier1', {
    digest: digest.chunks,
    digestChars: digest.chars,
    samples: samples(5, 3000, 80),
    lastActiveAt: BASE - 600000,
    pooledAt: BASE - 600000,
  }));
  ctx.store.setRoute('tier2', route('ses_tier2', {
    rotatedAt: BASE - 7200000,
    digest: digest.chunks,
    digestChars: digest.chars,
    samples: samples(5, 1000, 200),
    lastActiveAt: BASE - 7200000,
    pooledAt: BASE - 7200000,
  }));
  const first = ctx.pool.prepareRoute({ sessionId: 'new1', digest, now: BASE });
  assert.equal(first.action, 'adopted');
  assert.equal(first.sourceSessionId, 'tier1');
  assert.equal(first.tier, 1);

  ctx.store.setRoute('tier1', route('ses_tier1b', {
    digest: digest.chunks,
    digestChars: digest.chars,
    samples: samples(5, 3000, 80),
    lastActiveAt: BASE - 600000,
    pooledAt: null,
  }));
  const ctx2 = setup(t);
  ctx2.store.setRoute('slow', route('ses_slow', {
    rotatedAt: BASE - 7200000,
    digest: digest.chunks,
    digestChars: digest.chars,
    samples: samples(5, 5000, 90),
    lastActiveAt: BASE - 7200000,
    pooledAt: BASE - 7200000,
  }));
  ctx2.store.setRoute('fast', route('ses_fast', {
    rotatedAt: BASE - 7200000,
    digest: digest.chunks,
    digestChars: digest.chars,
    samples: samples(5, 1000, 72),
    lastActiveAt: BASE - 7200000,
    pooledAt: BASE - 7200000,
  }));
  const second = ctx2.pool.prepareRoute({ sessionId: 'new2', digest, now: BASE });
  assert.equal(second.action, 'adopted');
  assert.equal(second.sourceSessionId, 'fast');
  assert.equal(second.tier, 2);
});

test('a session reclaims its own pooled code but falls back to a fresh one when it no longer qualifies', async (t) => {
  const ctx = setup(t);
  const digest = digestFor('revive me');
  ctx.store.setRoute('s', route('ses_self', {
    digest: digest.chunks,
    digestChars: digest.chars,
    samples: samples(5, 2000, 100),
    pooledAt: BASE - 600000,
  }));
  const revived = ctx.pool.prepareRoute({ sessionId: 's', digest, now: BASE });
  assert.equal(revived.action, 'revived');
  assert.equal(revived.route.value, 'ses_self');
  assert.equal(ctx.store.routeFor('s').pooledAt, null);

  ctx.store.setRoute('slow', route('ses_slow', {
    digest: digest.chunks,
    digestChars: digest.chars,
    samples: samples(5, 2000, 50),
    pooledAt: BASE - 600000,
  }));
  ctx.store.recordSample('slow', { ttftMs: 2000, tps: 50, at: BASE - 1000 }, 20);
  assert.equal(ctx.store.samplesFor('slow').length, 1);
  const kept = ctx.pool.prepareRoute({ sessionId: 'slow', digest, now: BASE });
  assert.equal(kept.action, 'kept');
  assert.equal(kept.skipPrediction, false);
  assert.notEqual(ctx.store.routeFor('slow').value, 'ses_slow');
  assert.match(ctx.store.routeFor('slow').value, /^ses_[0-9a-f]{24}$/);
  assert.equal(ctx.store.routeFor('slow').pooledAt, null);
  assert.equal(ctx.store.routeFor('slow').samples.length, 0);
  assert.equal(ctx.store.samplesFor('slow').length, 0);
  assert.equal(ctx.store.routeFor('slow').reason, 'pool-fallback');
});

test('idle pooling requires a non-busy session and archive pools immediately', async (t) => {
  const ctx = setup(t);
  const samples5 = samples(5, 2000, 100);
  const digest = digestFor('idle');
  ctx.store.setRoute('idle', route('ses_idle', {
    samples: samples5,
    digest: digest.chunks,
    digestChars: digest.chars,
    lastActiveAt: BASE - 240000,
  }));
  // A pre-0.6 route has no prefix digest, so it cannot match anyone and must
  // stay active instead of being pooled and later replaced on revival.
  ctx.store.setRoute('legacy', route('ses_legacy', { samples: samples5, lastActiveAt: BASE - 240000 }));
  // Four samples are not enough to judge the code; pooling it would strand the
  // owner with a fresh code on revival, so the scan must leave it active.
  ctx.store.setRoute('thin', route('ses_thin', {
    samples: samples(4, 1000, 200),
    digest: digest.chunks,
    digestChars: digest.chars,
    lastActiveAt: BASE - 240000,
  }));
  ctx.activity.last = BASE - 240000;
  ctx.activity.busy = false;
  assert.equal(ctx.pool.tick(BASE), 1);
  assert.equal(ctx.store.routeFor('idle').pooledAt, BASE);
  assert.equal(ctx.store.routeFor('legacy').pooledAt, null);
  assert.equal(ctx.store.routeFor('thin').pooledAt, null);

  ctx.store.setRoute('busy', route('ses_busy', {
    samples: samples5,
    digest: digest.chunks,
    digestChars: digest.chars,
    lastActiveAt: BASE - 240000,
  }));
  ctx.activity.last = BASE - 240000;
  ctx.activity.busy = true;
  assert.equal(ctx.pool.tick(BASE), 0);
  assert.equal(ctx.store.routeFor('busy').pooledAt, null);

  const ctx2 = setup(t, {
    getArchivedSessionIds: () => ['gone'],
    getAgentStatus: () => 'running',
  });
  ctx2.store.setRoute('gone', route('ses_gone', {
    samples: samples5,
    digest: digest.chunks,
    digestChars: digest.chars,
    lastActiveAt: BASE - 1000,
  }));
  assert.equal(ctx2.pool.tick(BASE), 1);
  assert.equal(ctx2.store.routeFor('gone').pooledAt, BASE);
});

test('a code evicted by the size cap does not churn back on the next scan', async (t) => {
  const ctx = setup(t, { poolMaxEntries: 2 });
  const digest = digestFor('evicted');
  const idle = { samples: samples(5, 2000, 100), lastActiveAt: BASE - 240000 };
  ctx.store.setRoute('one', route('ses_one', { ...idle, digest: digest.chunks, digestChars: digest.chars }));
  ctx.store.setRoute('two', route('ses_two', { ...idle, digest: digest.chunks, digestChars: digest.chars }));
  ctx.store.setRoute('three', route('ses_three', { ...idle, digest: digest.chunks, digestChars: digest.chars }));
  ctx.activity.last = BASE - 240000;
  ctx.activity.busy = false;

  assert.equal(ctx.pool.tick(BASE), 3);
  assert.equal(ctx.store.routeFor('one').pooledAt, null);
  assert.equal(ctx.store.routeFor('one').poolEvictedAt, BASE);
  assert.equal(ctx.store.routeFor('two').pooledAt, BASE);
  assert.equal(ctx.store.routeFor('three').pooledAt, BASE);

  // The evicted session is still idle, but it must not be pooled again and
  // push another code out every scan.
  assert.equal(ctx.pool.tick(BASE + 2000), 0);
  assert.equal(ctx.store.routeFor('one').pooledAt, null);
  assert.equal(ctx.store.routeFor('one').poolEvictedAt, BASE);
  assert.equal(ctx.store.routeFor('two').pooledAt, BASE);
  assert.equal(ctx.store.routeFor('three').pooledAt, BASE);

  // A real request from that session re-activates it and clears the marker.
  const prepared = ctx.pool.prepareRoute({ sessionId: 'one', digest, now: BASE + 4000 });
  assert.equal(prepared.action, 'active');
  assert.equal(ctx.store.routeFor('one').poolEvictedAt, null);
  assert.equal(ctx.pool.poolSession('one', 'idle', BASE + 4000), true);
});

test('codes inactive beyond the expiration window leave the pool and cannot return', async (t) => {
  const ctx = setup(t);
  const digest = digestFor('too old');
  ctx.store.setRoute('old', route('ses_old', {
    digest: digest.chunks,
    digestChars: digest.chars,
    samples: samples(5, 1000, 100),
    rotatedAt: BASE - 25 * 3600000,
    lastActiveAt: BASE - 25 * 3600000,
    pooledAt: BASE - 25 * 3600000,
  }));
  assert.equal(ctx.pool.expire(BASE), 1);
  assert.equal(ctx.store.routeFor('old').pooledAt, null);
  assert.equal(ctx.pool.poolSession('old', 'idle', BASE), false);
  assert.equal(ctx.store.routeFor('old').pooledAt, null);

  const result = ctx.pool.prepareRoute({ sessionId: 'new', digest, now: BASE });
  assert.equal(result.action, 'kept');
  assert.notEqual(ctx.store.routeFor('new').value, 'ses_old');

  // The owner coming back with an expired code also goes through the pool and
  // must not resurrect the code that already left both tiers.
  ctx.store.setRoute('owner', route('ses_owner', {
    digest: digest.chunks,
    digestChars: digest.chars,
    samples: samples(5, 1000, 100),
    rotatedAt: BASE - 25 * 3600000,
    lastActiveAt: BASE - 25 * 3600000,
  }));
  ctx.store.recordSample('owner', { ttftMs: 1000, tps: 100, at: BASE - 25 * 3600000 }, 20);
  const revived = ctx.pool.prepareRoute({ sessionId: 'owner', digest, now: BASE });
  assert.equal(revived.action, 'kept');
  assert.match(ctx.store.routeFor('owner').value, /^ses_[0-9a-f]{24}$/);
  assert.notEqual(ctx.store.routeFor('owner').value, 'ses_owner');
  assert.equal(ctx.store.routeFor('owner').reason, 'pool-fallback');
  assert.equal(ctx.store.samplesFor('owner').length, 0);
});

test('a cache-cold rotation starts a fresh code with its own digest and samples', async (t) => {
  const ctx = setup(t);
  const digest = digestFor('rotate');
  ctx.store.setRoute('s', route('ses_old', { samples: samples(5, 2000, 100), digest: digest.chunks }));
  ctx.pool.poolSession('s', 'idle', BASE);
  assert.equal(ctx.store.routeFor('s').pooledAt, BASE);
  ctx.pool.unpoolSession('s', BASE);
  assert.equal(ctx.store.routeFor('s').pooledAt, null);
});

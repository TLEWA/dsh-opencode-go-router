import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionActivity } from '../lib/activity.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function fakeContext() {
  const handlers = [];
  return {
    on(event, handler, options) {
      if (event === 'session/event') handlers.push(handler);
      assert.equal(options && options.global, true);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    emit(sessionId, event) {
      for (const handler of handlers.slice()) handler({ id: sessionId }, event);
    },
    count() { return handlers.length; },
  };
}

function makeActivity() {
  let clock = 1000000;
  const ctx = fakeContext();
  const activity = new SessionActivity({ ctx, logger: quiet, now: () => clock });
  return {
    activity,
    ctx,
    advance(ms) { clock += ms; },
    now: () => clock,
  };
}

test('turn boundaries decide whether a session is idle', (t) => {
  const { activity, ctx, advance } = makeActivity();
  t.after(() => activity.dispose());
  ctx.emit('s1', { type: 'turn/start', data: { turn: 1 } });
  assert.equal(activity.isBusy('s1'), true);
  advance(10 * 60000);
  assert.equal(activity.isIdleFor('s1', 180000, 1000000 + 10 * 60000), false);

  ctx.emit('s1', { type: 'turn/end', data: { turn: 1 } });
  assert.equal(activity.isBusy('s1'), false);
  advance(180000);
  assert.equal(activity.isIdleFor('s1', 180000, 1000000 + 13 * 60000), true);
});

test('turns stay busy across tools, approvals and background jobs', (t) => {
  const { activity, ctx } = makeActivity();
  t.after(() => activity.dispose());

  ctx.emit('s2', { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('s2', { type: 'tool/call', data: { callId: 'call-1', name: 'bash' } });
  ctx.emit('s2', { type: 'turn/end', data: { turn: 1 } });
  assert.equal(activity.isBusy('s2'), true, 'an unresolved tool call keeps the session busy');
  ctx.emit('s2', { type: 'tool/result', data: { message: { toolCallId: 'call-1' } } });
  assert.equal(activity.isBusy('s2'), false);

  ctx.emit('s2', { type: 'approval/asked', data: { id: 'approval-1', toolName: 'bash' } });
  assert.equal(activity.isBusy('s2'), true);
  ctx.emit('s2', { type: 'approval/decided', data: { id: 'approval-1', outcome: 'allow' } });
  assert.equal(activity.isBusy('s2'), false);

  ctx.emit('s2', { type: 'job/registered', data: { jobId: 'job-1' } });
  ctx.emit('s2', { type: 'job/registered', data: { jobId: 'job-2' } });
  assert.equal(activity.isBusy('s2'), true);
  ctx.emit('s2', { type: 'job/settled', data: { jobId: 'job-1' } });
  assert.equal(activity.isBusy('s2'), true, 'another running job still blocks pooling');
  ctx.emit('s2', { type: 'job/settled', data: { jobId: 'job-2' } });
  assert.equal(activity.isBusy('s2'), false);
});

test('passive events do not reset the idle deadline', (t) => {
  const { activity, ctx, advance } = makeActivity();
  t.after(() => activity.dispose());

  ctx.emit('s3', { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('s3', { type: 'turn/end', data: { turn: 1 } });
  const before = activity.lastActivityAt('s3');
  advance(5 * 60000);
  ctx.emit('s3', { type: 'session/title', data: { title: 'a new title' } });
  ctx.emit('s3', { type: 'request/header', data: {} });
  ctx.emit('s3', { type: 'llm/retry', data: {} });
  assert.equal(activity.lastActivityAt('s3'), before);
  assert.equal(activity.isIdleFor('s3', 180000, 1000000 + 5 * 60000), true);
});

test('snapshot and prune only keep what matters', (t) => {
  const { activity, ctx } = makeActivity();
  t.after(() => activity.dispose());

  ctx.emit('s4', { type: 'turn/start', data: { turn: 7 } });
  ctx.emit('s4', { type: 'tool/call', data: { callId: 'c7' } });
  const snapshot = activity.snapshot('s4');
  assert.equal(snapshot.turns, 1);
  assert.equal(snapshot.tools, 1);

  ctx.emit('s4', { type: 'turn/end', data: { turn: 7 } });
  ctx.emit('s4', { type: 'tool/result', data: { toolCallId: 'c7' } });
  activity.prune(1000000 + 8 * 86400000, 7 * 86400000);
  assert.equal(activity.lastActivityAt('s4'), 0, 'old idle sessions are pruned');
});

test('dispose removes the global listener', () => {
  const ctx = fakeContext();
  const activity = new SessionActivity({ ctx, logger: quiet });
  assert.equal(ctx.count(), 1);
  activity.dispose();
  assert.equal(ctx.count(), 0);
});

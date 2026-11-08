import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('client bundle registers the settings panel under both bundle names', () => {
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let definition = null;
  const React = {
    createElement() {},
    useState() { return [null, () => {}]; },
    useEffect() {},
  };
  const context = {
    window: {
      __ModuleLoader__: {
        load(value) { definition = value; },
      },
    },
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  };
  vm.runInNewContext(source, context, { filename: 'lib/client.js' });
  assert.equal(definition.id, 'dsh-opencode-go-router');

  const module = definition.factory((name) => {
    assert.equal(name, 'react');
    return React;
  });
  assert.deepEqual(Array.from(module.inject), ['slots', 'locale']);
  assert.equal(typeof module.apply, 'function');

  const registrations = [];
  const locales = [];
  const ctx = {
    effect(fn) {
      const disposer = fn();
      assert.equal(typeof disposer, 'function');
    },
    locale: {
      register(namespace, dictionaries) {
        locales.push({ namespace, dictionaries });
        return () => {};
      },
    },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'plugins.bundle.config');
        for (const item of callback()) registrations.push(item);
      },
      register(options, component) {
        return { options, component };
      },
    },
  };
  module.apply(ctx);
  assert.equal(locales.length, 1);
  assert.equal(locales[0].namespace, 'opencode-router');
  assert.deepEqual(Object.keys(locales[0].dictionaries).sort(), ['en', 'zh']);
  assert.equal(registrations.length, 2);
  assert.deepEqual(registrations.map((item) => item.options.key), ['dsh-opencode-go-router', 'opencode-router']);
  assert.equal(registrations[0].component, registrations[1].component);
  assert.equal(typeof registrations[0].component, 'function');
});

test('the performance panel shows the configured throughput threshold', () => {
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let definition = null;
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(value) {
      if (this.calls === undefined) this.calls = 0;
      this.calls += 1;
      if (this.calls === 1) {
        return [{
          loading: false,
          error: '',
          data: {
            version: '0.2.0',
            config: {
              cacheHitThresholdPct: 25,
              ttftThresholdMs: 12000,
              throughputThresholdTps: 60,
              stepTtftGraceMs: 2000,
              stepThroughputGraceTps: 5,
            },
            sessions: [{
              sessionId: 'session-abcdef123456',
              lastRequestAt: 1700000001000,
              stepping: {
                step: 2,
                effectiveTtftThresholdMs: 16000,
                effectiveThroughputThresholdTps: 50,
              },
            }],
            history: [{
              id: 'h1',
              sessionId: 'session-abcdef123456',
              at: 1700000000000,
              reason: 'cache-and-performance',
              version: '0.6.0',
              thresholds: {
                step: 2,
                effectiveTtftThresholdMs: 14000,
                effectiveThroughputThresholdTps: 55,
              },
              foldSeq: 3,
              cacheHitPct: 0,
              step: 2,
              beforeTtftMs: 30000,
              beforeTps: 30,
              afterTtftMs: 5000,
              afterTps: 100,
              afterSamples: 5,
              afterTarget: 5,
              afterComplete: true,
            }, {
              id: 'h2',
              sessionId: 'session-old',
              at: 1690000000000,
              reason: 'system-rewrite',
              basis: 'system-rewrite',
              beforeTtftMs: 3216,
              beforeTps: 114.9,
              afterTtftMs: 3591.4,
              afterTps: 95.2,
              afterSamples: 5,
              afterTarget: 5,
              afterComplete: true,
            }],
            pool: { enabled: true, total: 1, tier1: 1, tier2: 0, eligible: 1, lastAdoption: null },
          },
        }, () => {}];
      }
      return [value, () => {}];
    },
    useEffect() {},
  };
  const context = {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  };
  vm.runInNewContext(source, context, { filename: 'lib/client.js' });
  const module = definition.factory(() => React);
  const registrations = [];
  const locales = [];
  module.apply({
    effect(fn) { fn(); },
    locale: { register(namespace, dictionaries) { locales.push(dictionaries); return () => {}; } },
    slots: {
      inject(name, callback) { for (const item of callback()) registrations.push(item); },
      register(options, component) { return { options, component }; },
    },
  });

  const tree = registrations[0].component({
    view: 'page',
    t: (key) => locales[0].zh[key] || key,
  });
  const texts = [];
  const walk = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return; }
    if (typeof node.type === 'function') { walk(node.type(node.props)); return; }
    walk(node.children);
  };
  walk(tree);
  assert.ok(texts.some((text) => text.includes('吞吐 ≤ 60 tok/s')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('TTFT 阈值放宽 2s')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('步进 2')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('最近活跃会话步进 2')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('触发阈值: TTFT ≥ 14.0s 或吞吐 ≤ 55 tok/s')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('旧版记录，未记录触发阈值')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('路由池：1 个（一级 1、二级 0），合格 1')), texts.join('\n'));
});

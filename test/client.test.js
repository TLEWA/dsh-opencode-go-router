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
              poolSampleSize: 5,
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
            }, {
              id: 'h3',
              sessionId: 'session-adopted-row',
              at: 1700000002000,
              reason: 'pool-adopted',
              basis: 'pool-match',
              poolRole: 'adopted',
              beforeTtftMs: 4321.5,
              beforeTps: 88.8,
              afterTtftMs: 1300,
              afterTps: 150,
              afterSamples: 5,
              afterTarget: 5,
              afterComplete: true,
            }],
            pool: {
              enabled: true,
              total: 1,
              tier1: 1,
              tier2: 0,
              eligible: 1,
              minTps: 80,
              maxTtftMs: 8000,
              lastAdoption: null,
              effect: {
                adopted: { count: 1, measured: 1, avgFirstHitPct: 61.3, avgMatchPct: 95.9 },
                baseline: { count: 1, measured: 1, avgFirstHitPct: 0 },
                deltaPct: 61.3,
                samples: [],
              },
              entries: [{
                sessionId: 'session-abcdef123456',
                code: 'ses_31dc46fc005c19836321a4a1',
                pooledAt: 1700000000000,
                lastActiveAt: 1700000000000,
                ageMs: 3565927,
                tier: 1,
                eligible: true,
                digestChunks: 512,
                digestChars: 262144,
                samples: 5,
                avgTtftMs: 7215.6,
                avgTps: 95.4,
                score: 23.2,
              }],
            },
            billionContext: { detected: false, root: 'C:\\missing\\billion-context\\sessions' },
            statistics: {
              requests: { total: 2, measured: 2, avgHitPct: 55, warm: 1, cold: 1, avgTtftMs: 2000, avgTps: 75 },
            },
            routes: {
              'session-abcdef123456': {
                sessionId: 'session-abcdef123456',
                reason: 'pool-adopted',
                poolRole: 'adopted',
                rotatedAt: 1700000000500,
                firstRequestAt: 1700000000600,
              },
            },
            poolEvents: [{
              at: 1700000000500,
              role: 'adopted',
              sessionId: 'session-abcdef123456',
              sourceSessionId: 'session-old',
              matchPct: 92.5,
              tier: 1,
              code: 'ses_aaaaaaaaaaaa',
              donorCode: 'ses_bbbbbbbbbbbb',
              donorTtftMs: 1200,
              donorTps: 110,
              donorSamples: 5,
            }, {
              at: 1700000000800,
              role: 'revived',
              sessionId: 'session-abcdef123456',
              sourceSessionId: 'session-abcdef123456',
              matchPct: null,
              tier: null,
              code: 'ses_aaaaaaaaaaaa',
            }, {
              at: 1700000001000,
              role: 'adopted',
              sessionId: 'session-no-marker',
              sourceSessionId: 'session-old',
              matchPct: 80,
              tier: 1,
              code: 'ses_cccccccccccc',
            }, {
              at: 1700000001200,
              role: 'adopted',
              sessionId: 'session-snapshot',
              sourceSessionId: 'session-old',
              matchPct: 88,
              tier: 1,
              code: 'ses_dddddddddddd',
              firstRequest: {
                at: 1700000001300,
                ttftMs: 800,
                tps: 150,
                outputTokens: 50,
                inputTokens: 100,
                cacheReadTokens: 850,
                hitPct: 85,
              },
            }],
            requests: [{
              sessionId: 'session-abcdef123456',
              at: 1700000000700,
              ttftMs: 1100,
              tps: 120,
              inputTokens: 100,
              cacheReadTokens: 950,
              hitPct: 99,
            }, {
              sessionId: 'session-other',
              at: 1700000000650,
              ttftMs: 1300,
              tps: 100,
              inputTokens: 100,
              cacheReadTokens: 500,
              hitPct: 50,
            }, {
              sessionId: 'session-abcdef123456',
              at: 1700000000400,
              ttftMs: 1500,
              tps: 90,
              inputTokens: 100,
              cacheReadTokens: 100,
              hitPct: 10,
            }, {
              sessionId: 'session-abcdef123456',
              at: 1700000000600,
              ttftMs: 1200,
              tps: 110,
              inputTokens: 100,
              cacheReadTokens: 900,
              hitPct: 90,
            }, {
              sessionId: 'session-abcdef123456',
              at: 1700000000900,
              ttftMs: 1000,
              tps: 130,
              inputTokens: 100,
              cacheReadTokens: 300,
              hitPct: 30,
            }, {
              sessionId: 'session-no-marker',
              at: 1700000001100,
              ttftMs: 900,
              tps: 140,
              inputTokens: 100,
              cacheReadTokens: 700,
              hitPct: 70,
            }],
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
  const walk = (node, out) => {
    const target = out || texts;
    if (node == null) return;
    if (Array.isArray(node)) { for (const item of node) walk(item, target); return; }
    if (typeof node === 'string' || typeof node === 'number') { target.push(String(node)); return; }
    if (typeof node.type === 'function') { walk(node.type(node.props), target); return; }
    walk(node.children, target);
  };
  walk(tree);

  const findRow = (node, reason) => {
    if (node == null) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findRow(item, reason);
        if (found) return found;
      }
      return null;
    }
    if (typeof node !== 'object') return null;
    if (node.props && node.props.entry && node.props.entry.reason === reason) return node;
    if (typeof node.type === 'function') return findRow(node.type(node.props), reason);
    return findRow(node.children, reason);
  };

  const adoptedRow = findRow(tree, 'pool-adopted');
  assert.ok(adoptedRow, 'the adopted history row should render');
  const adoptedTexts = [];
  walk(adoptedRow, adoptedTexts);
  const adoptedDump = adoptedTexts.join('\n');
  assert.ok(adoptedTexts.some((text) => text.includes('源会话表现')), adoptedDump);
  assert.ok(adoptedTexts.some((text) => text.includes('同一 code 漂移')), adoptedDump);
  assert.ok(adoptedTexts.some((text) => text.includes('不是本会话的基线')), adoptedDump);
  assert.ok(!adoptedTexts.some((text) => text.includes('切换前')), adoptedDump);
  assert.ok(texts.some((text) => text.includes('切换前')), 'normal rows keep the pre-switch label');
  assert.ok(texts.some((text) => text.includes('TTFT -35.8%')), 'the average change excludes pool adoption rows');
  assert.ok(texts.some((text) => text.includes('吞吐 ≤ 60 tok/s')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('TTFT 阈值放宽 2s')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('步进 2')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('最近活跃会话步进 2')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('触发阈值: TTFT ≥ 14.0s 或吞吐 ≤ 55 tok/s')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('旧版记录，未记录触发阈值')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('路由池：1 个（一级 1、二级 0），合格 1')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('两级池 session code')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('池效果（首请求命中）')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('借入 1 次 · 首请求平均命中 61.3% · 匹配 95.9%')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('全新 1 次 · 首请求平均命中 0.0%')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('差值 +61.3 pp')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('一级池 · 1')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('ses_31dc46fc005c19836321a4a1')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('7.2 s')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('95 tok/s')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('5/5')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('23.2')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('未检测到 billion-context')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('近 2 次请求：平均命中 55.0%，热 1，冷 1')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('池替换记录')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('缓存命中记录')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('只显示每次从池中复用 code 后的第一条请求；同一会话收回 code 不显示。首请求会随池事件保存，请求记录淘汰后仍可查看。')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('复用')), texts.join('\n'));
  assert.ok(texts.some((text) => text.includes('90.0%')), texts.join('\n'));
  // Later warm requests, requests before the swap, and requests from sessions
  // with no swap must not appear in the cache log.
  assert.ok(!texts.some((text) => text.includes('99.0%')), texts.join('\n'));
  assert.ok(!texts.some((text) => text.includes('50.0%')), texts.join('\n'));
  assert.ok(!texts.some((text) => text.includes('10.0%')), texts.join('\n'));
  // A session reclaiming its own code (revived) is not a pool replacement.
  assert.ok(!texts.some((text) => text.includes('30.0%')), texts.join('\n'));
  // An adoption without a persisted first-request marker cannot be attributed;
  // a later request must not stand in for the missing first request.
  assert.ok(!texts.some((text) => text.includes('70.0%')), texts.join('\n'));
  // A persisted first-request snapshot remains visible after its request has
  // left the 200-entry ring.
  assert.ok(texts.some((text) => text.includes('85.0%')), texts.join('\n'));
  // Without billion-context the fold chip is meaningless and must be hidden.
  assert.ok(!texts.some((text) => text.includes('折叠 #3')), texts.join('\n'));
});

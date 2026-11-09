/**
 * Settings-page performance panel for dsh-opencode-go-router.
 *
 * This is a hand-written client bundle: the DSH web client loads it through
 * window.__ModuleLoader__.load, and the only runtime dependency is React.
 * It renders inside the plugin detail page, so it is scoped to this bundle.
 */

window.__ModuleLoader__.load({
  id: 'dsh-opencode-go-router',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var h = React.createElement;
    var NS = 'opencode-router';
    var REFRESH_MS = 5000;

    var zh = {
      title: '静默切换性能记录',
      subtitle: '每次在预测会打不中缓存、或系统提示词改写前切换上游后，对比切换前后请求的速度；池复用与池借出也会记录。',
      empty: '还没有静默切换记录。',
      loading: '正在读取状态…',
      error: '读取状态失败：',
      retry: '重试',
      criteria: '触发条件：下一条请求的预测缓存命中 ≤ {cache}% 且 TTFT ≥ {ttft}s 或吞吐 ≤ {tps} tok/s；系统提示词改写总是预测为 0%。',
      summary: '共 {total} 条路由记录，{complete} 条已采满样本',
      avg: '已采满样本的平均变化：TTFT {ttft}，吞吐 {tps}',
      before: '切换前',
      after: '切换后',
      change: '变化',
      beforeAdopted: '源会话表现',
      changeAdopted: '同一 code 漂移',
      adoptedHint: '「源会话表现」是借入 code 在来源会话的历史，不是本会话的基线；「同一 code 漂移」只比较这个 code 迁移前后，复用收益请看上方「池效果」。',
      ttft: 'TTFT',
      tps: '吞吐',
      fold: '折叠',
      noFold: '无折叠',
      cache: '缓存命中',
      samples: '样本',
      reasonPredicted: '预测冷请求',
      reasonRewrite: '系统提示词改写',
      reasonLegacy: '缓存 + 性能',
      reasonPoolAdopted: '池复用',
      reasonPoolDonated: '池借出',
      backfilled: '补录',
      trigger: '触发阈值',
      triggerValue: 'TTFT ≥ {ttft}s 或吞吐 ≤ {tps} tok/s',
      triggerPool: '池交换，不适用性能阈值',
      triggerLegacy: '旧版记录，未记录触发阈值（当时可能使用临时测试配置）',
      triggerUnknown: '未记录触发阈值',
      poolSummary: '路由池：{total} 个（一级 {tier1}、二级 {tier2}），合格 {eligible}',
      poolDisabled: '路由池已关闭',
      poolLastAdoption: '最近复用：命中 {match}% · {time}',
      poolMatch: '命中',
      poolTier: '层级',
      poolLevel1: '一级池',
      poolLevel2: '二级池',
      poolListTitle: '两级池 session code',
      poolListHint: '一级池按前缀命中优先；二级池按评分 -(TTFT 秒 × 10) + 吞吐 排序。超过 24 小时不活跃的 code 会离开两级池。',
      poolEffectTitle: '池效果（首请求命中）',
      poolEffectHint: '借入池 code 的会话与全新 code 会话，比较各自 code 上的首条请求；首请求已被记录淘汰的事件不计入。',
      poolEffectAdopted: '借入 {count} 次 · 首请求平均命中 {hit} · 匹配 {match}',
      poolEffectBaseline: '全新 {count} 次 · 首请求平均命中 {hit}',
      poolEffectDelta: '差值 {delta}',
      poolEffectEmpty: '暂无足够样本：借入和全新会话都要有首请求记录。',
      poolListEmpty: '池中还没有 code。',
      poolTierEmpty: '本层暂无 code。',
      poolEligible: '合格',
      poolIneligible: '未达标',
      poolScore: '评分',
      poolIdle: '空闲',
      poolDigest: '摘要',
      poolPooledAt: '入池',
      poolCodeLabel: 'Session code',
      poolNoDigest: '摘要为空，无法参与交换',
      poolNeedSamples: '样本不足 {n}/{target}',
      poolLowTps: '吞吐未超过 {min} tok/s',
      poolHighTtft: 'TTFT 超过 {max}s',
      waiting: '等待样本',
      none: '—',
      updated: '更新于',
      version: '版本',
      incomplete: '采样中',
      complete: '已完成',
      step: '步进',
      stepRule: '连续替换仍未达标时，每次步进把 TTFT 阈值放宽 {ttft}s、吞吐阈值下调 {tps} tok/s；某次切换后的采样窗口达标后步进归零。',
      currentStep: '最近活跃会话步进',
      statsLine: '近 {total} 次请求：平均命中 {hit}%，热 {warm}，冷 {cold}；平均 TTFT {ttft} · {tps}',
      noBili: '未检测到 billion-context：折叠记录不可用，以下统计来自插件自身的请求采样。',
      poolLog: '池替换记录',
      poolLogEmpty: '还没有池替换记录。',
      cacheLog: '缓存命中记录',
      cacheLogHint: '只显示每次从池中复用 code 后的第一条请求；同一会话收回 code 不显示。首请求会随池事件保存，请求记录淘汰后仍可查看。',
      cacheLogEmpty: '还没有池复用后的请求采样。',
      roleAdopted: '复用',
      roleRevived: '收回',
      poolSource: '来自',
      codeLabel: '码',
      donorCode: '借出码',
      inputTokens: '输入',
      cacheRead: '缓存读',
    };

    var en = {
      title: 'Silent switch performance log',
      subtitle: 'Speed before and after each upstream switch made before a request predicted to miss the cache or carrying a rewritten system prompt; pool reuse and donation are recorded too.',
      empty: 'No silent switches recorded yet.',
      loading: 'Reading status…',
      error: 'Failed to read status: ',
      retry: 'Retry',
      criteria: 'Triggers: the next request is predicted to hit the cache ≤ {cache}% and TTFT ≥ {ttft}s or throughput ≤ {tps} tok/s; a system-prompt rewrite always predicts 0%.',
      summary: '{total} routing records, {complete} with a complete sample window',
      avg: 'Average change over complete windows: TTFT {ttft}, throughput {tps}',
      before: 'Before',
      after: 'After',
      change: 'Change',
      beforeAdopted: 'Source-session history',
      changeAdopted: 'Same-code drift',
      adoptedHint: 'Source-session history is the history of the borrowed code in its source session, not a baseline for this session; same-code drift only compares that code before and after the move. See Pool effect above for the reuse benefit.',
      ttft: 'TTFT',
      tps: 'Throughput',
      fold: 'Fold',
      noFold: 'No fold',
      cache: 'Cache hit',
      samples: 'Samples',
      reasonPredicted: 'Predicted cold',
      reasonRewrite: 'System rewrite',
      reasonLegacy: 'Cache + speed',
      reasonPoolAdopted: 'Pool reuse',
      reasonPoolDonated: 'Pool donation',
      backfilled: 'Reconstructed',
      trigger: 'Trigger threshold',
      triggerValue: 'TTFT ≥ {ttft}s or throughput ≤ {tps} tok/s',
      triggerPool: 'Pool swap; speed thresholds do not apply',
      triggerLegacy: 'Legacy record without thresholds (a temporary test config may have been active)',
      triggerUnknown: 'Threshold not recorded',
      poolSummary: 'Routing pool: {total} codes (tier 1 {tier1}, tier 2 {tier2}), {eligible} eligible',
      poolDisabled: 'Routing pool is disabled',
      poolLastAdoption: 'Last reuse: {match}% match · {time}',
      poolMatch: 'Match',
      poolTier: 'Tier',
      poolLevel1: 'Tier 1',
      poolLevel2: 'Tier 2',
      poolListTitle: 'Two-tier pool session codes',
      poolListHint: 'Tier 1 ranks by prefix match; tier 2 ranks by -(TTFT seconds × 10) + throughput. Codes idle for more than 24 hours leave both tiers.',
      poolEffectTitle: 'Pool effect (first-request hit)',
      poolEffectHint: 'Compares the first request on the borrowed code with the first request on a fresh code; events whose first request has left the log are skipped.',
      poolEffectAdopted: 'Borrowed {count} · avg first hit {hit} · match {match}',
      poolEffectBaseline: 'Fresh {count} · avg first hit {hit}',
      poolEffectDelta: 'Difference {delta}',
      poolEffectEmpty: 'Not enough samples yet: both borrowed and fresh sessions need a first-request record.',
      poolListEmpty: 'No codes in the pool yet.',
      poolTierEmpty: 'No codes in this tier.',
      poolEligible: 'Eligible',
      poolIneligible: 'Not eligible',
      poolScore: 'Score',
      poolIdle: 'Idle',
      poolDigest: 'Digest',
      poolPooledAt: 'Pooled',
      poolCodeLabel: 'Session code',
      poolNoDigest: 'Empty digest; cannot be swapped',
      poolNeedSamples: 'Samples {n}/{target}',
      poolLowTps: 'Throughput not above {min} tok/s',
      poolHighTtft: 'TTFT above {max}s',
      waiting: 'Waiting for samples',
      none: '—',
      updated: 'Updated',
      version: 'Version',
      incomplete: 'Sampling',
      complete: 'Complete',
      step: 'Step',
      stepRule: 'When consecutive switches still miss the targets, each step widens the TTFT threshold by {ttft}s and lowers the throughput threshold by {tps} tok/s; a good post-switch window resets the step.',
      currentStep: 'Most recent session step',
      statsLine: 'Last {total} requests: avg hit {hit}%, warm {warm}, cold {cold}; avg TTFT {ttft} · {tps}',
      noBili: 'billion-context not detected: fold records are unavailable; the statistics below come from this plugin’s own request sampling.',
      poolLog: 'Pool swap log',
      poolLogEmpty: 'No pool swaps recorded yet.',
      cacheLog: 'Cache-hit log',
      cacheLogHint: 'Only the first request after each pooled code reuse; a session reclaiming its own code is not shown. The first request is saved with the pool event, so it remains visible after leaving the request log.',
      cacheLogEmpty: 'No request sampled after a pool reuse yet.',
      roleAdopted: 'Reuse',
      roleRevived: 'Reclaim',
      poolSource: 'from',
      codeLabel: 'Code',
      donorCode: 'Handed code',
      inputTokens: 'in',
      cacheRead: 'cache read',
    };

    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, function (_, key) {
        return values && values[key] != null ? String(values[key]) : '';
      });
    }

    function formatTime(ms) {
      if (!Number.isFinite(Number(ms))) return '';
      try {
        return new Date(Number(ms)).toLocaleString(undefined, {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch {
        return String(ms);
      }
    }

    function shortSession(id) {
      var text = String(id == null ? '' : id);
      if (text.indexOf('session-') === 0) text = text.slice(8);
      return text.length > 12 ? text.slice(0, 8) + '…' : text;
    }

    function formatTtft(ms) {
      var value = Number(ms);
      if (!Number.isFinite(value) || value < 0) return '—';
      if (value < 1000) return Math.round(value) + ' ms';
      return (value / 1000).toFixed(1) + ' s';
    }

    function formatTps(tps) {
      var value = Number(tps);
      if (!Number.isFinite(value) || value <= 0) return '—';
      return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + ' tok/s';
    }

    function formatAge(ms) {
      var value = Number(ms);
      if (!Number.isFinite(value) || value < 0) return '—';
      var seconds = Math.floor(value / 1000);
      if (seconds < 60) return seconds + ' s';
      var minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + ' min';
      var hours = minutes / 60;
      return (hours >= 10 ? hours.toFixed(0) : hours.toFixed(1)) + ' h';
    }

    function thresholdText(entry, t) {
      if (entry.poolMatchPct != null || entry.reason === 'pool-adopted' || entry.reason === 'pool-donated') {
        return t('triggerPool');
      }
      var thresholds = entry.thresholds;
      if (thresholds
        && Number.isFinite(Number(thresholds.effectiveTtftThresholdMs))
        && Number.isFinite(Number(thresholds.effectiveThroughputThresholdTps))) {
        var text = t('trigger') + ': ' + fill(t('triggerValue'), {
          ttft: (Number(thresholds.effectiveTtftThresholdMs) / 1000).toFixed(1),
          tps: Number(thresholds.effectiveThroughputThresholdTps),
        });
        if (Number(thresholds.step) > 0) text += ' · ' + t('step') + ' ' + String(thresholds.step);
        return text;
      }
      return t('trigger') + ': ' + (entry.version ? t('triggerUnknown') : t('triggerLegacy'));
    }

    function formatPct(value) {
      var n = Number(value);
      if (!Number.isFinite(n)) return '—';
      return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
    }

    function formatHitPct(value) {
      var n = Number(value);
      return Number.isFinite(n) ? n.toFixed(1) + '%' : '—';
    }

    function formatPp(value) {
      var n = Number(value);
      if (!Number.isFinite(n)) return '—';
      return (n >= 0 ? '+' : '') + n.toFixed(1) + ' pp';
    }

    // The cache log answers one question: what did the first request on a
    // newly reused code hit? Use the persisted first-request marker rather
    // than the earliest request still in the ring: once the true first request
    // is evicted, a later warm request must not be promoted into its place.
    function firstRequestAfterPoolSwaps(requests, poolEvents, history, routes) {
      var events = Array.isArray(poolEvents) ? poolEvents : [];
      var list = Array.isArray(requests) ? requests : [];
      var entries = Array.isArray(history) ? history : [];
      var routeList = Array.isArray(routes)
        ? routes
        : (routes && typeof routes === 'object' ? Object.keys(routes).map(function (key) { return routes[key]; }) : []);
      var markers = {};
      function addMarker(sessionId, at, firstRequestAt) {
        var marker = Number(firstRequestAt);
        var eventAt = Number(at);
        if (String(sessionId || '') === '' || !Number.isFinite(marker) || !Number.isFinite(eventAt)) return;
        markers[String(sessionId) + '|' + String(eventAt)] = marker;
      }
      for (var h = 0; h < entries.length; h += 1) {
        var entry = entries[h] || {};
        if (entry.reason !== 'pool-adopted' && entry.poolRole !== 'adopted') continue;
        addMarker(entry.sessionId, entry.at, entry.firstRequestAt);
      }
      for (var r = 0; r < routeList.length; r += 1) {
        var route = routeList[r] || {};
        if (route.reason !== 'pool-adopted' && route.poolRole !== 'adopted') continue;
        addMarker(route.sessionId, route.rotatedAt, route.firstRequestAt);
      }
      function markerFor(event) {
        var eventAt = Number(event.at);
        if (!Number.isFinite(eventAt)) return null;
        var key = String(event.sessionId) + '|' + String(eventAt);
        if (Object.prototype.hasOwnProperty.call(markers, key)) return markers[key];
        var candidates = [];
        for (var i = 0; i < entries.length; i += 1) {
          var entry = entries[i] || {};
          if (String(entry.sessionId) !== String(event.sessionId)) continue;
          if (entry.reason !== 'pool-adopted' && entry.poolRole !== 'adopted') continue;
          if (Math.abs(Number(entry.at) - eventAt) < 1000) candidates.push(entry.firstRequestAt);
        }
        for (var j = 0; j < routeList.length; j += 1) {
          var route = routeList[j] || {};
          if (String(route.sessionId) !== String(event.sessionId)) continue;
          if (route.reason !== 'pool-adopted' && route.poolRole !== 'adopted') continue;
          if (Math.abs(Number(route.rotatedAt) - eventAt) < 1000) candidates.push(route.firstRequestAt);
        }
        for (var c = 0; c < candidates.length; c += 1) {
          var value = Number(candidates[c]);
          if (Number.isFinite(value)) return value;
        }
        return null;
      }
      var selected = [];
      var seen = {};
      for (var i = 0; i < events.length; i += 1) {
        var event = events[i] || {};
        if (event.role !== 'adopted') continue;
        var snapshot = event.firstRequest;
        if (snapshot && Number.isFinite(Number(snapshot.at))) {
          var snapKey = String(snapshot.at) + '|' + String(event.sessionId);
          if (!seen[snapKey]) {
            seen[snapKey] = true;
            selected.push({
              sessionId: event.sessionId,
              at: snapshot.at,
              ttftMs: snapshot.ttftMs,
              tps: snapshot.tps,
              outputTokens: snapshot.outputTokens,
              inputTokens: snapshot.inputTokens,
              cacheReadTokens: snapshot.cacheReadTokens,
              hitPct: snapshot.hitPct,
            });
          }
          continue;
        }
        var marker = markerFor(event);
        if (marker == null) continue;
        var first = null;
        for (var j = 0; j < list.length; j += 1) {
          var request = list[j] || {};
          if (String(request.sessionId) !== String(event.sessionId)) continue;
          var at = Number(request.at);
          if (!Number.isFinite(at) || at !== marker) continue;
          first = request;
          break;
        }
        if (!first) continue;
        var key = String(first.at) + '|' + String(first.sessionId);
        if (seen[key]) continue;
        seen[key] = true;
        selected.push(first);
      }
      selected.sort(function (a, b) { return Number(b.at) - Number(a.at); });
      return selected;
    }

    function changePct(before, after) {
      var b = Number(before);
      var a = Number(after);
      if (!Number.isFinite(b) || !Number.isFinite(a) || b === 0) return null;
      return ((a - b) / b) * 100;
    }

    function useStatus() {
      var [state, setState] = React.useState({ loading: true, error: '', data: null });
      var [reloadAt, setReloadAt] = React.useState(0);
      React.useEffect(function () {
        var alive = true;
        var timer = null;
        async function load() {
          try {
            var response = await fetch('/opencode-router/status', { cache: 'no-store' });
            if (!response.ok) throw new Error('HTTP ' + String(response.status));
            var data = await response.json();
            if (alive) setState({ loading: false, error: '', data: data });
          } catch (error) {
            if (alive) {
              setState(function (previous) {
                return {
                  loading: false,
                  error: String(error && error.message ? error.message : error),
                  data: previous.data,
                };
              });
            }
          }
          if (alive) timer = setTimeout(load, REFRESH_MS);
        }
        load();
        return function () {
          alive = false;
          if (timer) clearTimeout(timer);
        };
      }, [reloadAt]);
      return { state: state, retry: function () { setReloadAt(function (value) { return value + 1; }); } };
    }

    function Metric(props) {
      return h('div', { style: { minWidth: 0 } }, [
        h('div', { key: 'label', style: { fontSize: 11, opacity: 0.65, marginBottom: 3 } }, props.label),
        h('div', { key: 'value', style: { fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', color: props.color || 'inherit' } }, props.value),
      ]);
    }

    function ChangeMetric(props) {
      var pct = changePct(props.before, props.after);
      var improved = pct != null && (props.lowerIsBetter ? pct < 0 : pct > 0);
      return h(Metric, {
        label: props.label,
        value: pct == null ? '—' : formatPct(pct),
        color: pct == null ? 'inherit' : (improved ? '#1f9d55' : '#d64545'),
      });
    }

    function HistoryRow(props) {
      var entry = props.entry;
      var t = props.t;
      var beforeTtft = entry.beforeTtftMs;
      var beforeTps = entry.beforeTps;
      var afterTtft = entry.afterTtftMs;
      var afterTps = entry.afterTps;
      var hasAfter = Number.isFinite(Number(afterTtft)) || Number.isFinite(Number(afterTps));
      var basis = entry.basis || (entry.reason === 'system-rewrite' ? 'system-rewrite' : null);
      var poolAdopted = entry.reason === 'pool-adopted';
      var poolDonated = entry.reason === 'pool-donated';
      var reason = poolAdopted
        ? t('reasonPoolAdopted')
        : (poolDonated
          ? t('reasonPoolDonated')
          : (basis === 'system-rewrite'
            ? t('reasonRewrite')
            : (basis == null ? t('reasonLegacy') : t('reasonPredicted'))));
      var reasonColor = poolAdopted ? '#0f766e' : (poolDonated ? '#b45309' : (basis === 'system-rewrite' ? '#7c5cff' : '#0b7fab'));
      var progress = String(entry.afterSamples || 0) + '/' + String(entry.afterTarget || 5);
      var beforeTitle = poolAdopted ? t('beforeAdopted') : t('before');
      var changeTitle = poolAdopted ? t('changeAdopted') : t('change');
      var afterLabel = hasAfter ? t('after') : t('waiting');
      var metaParts = [];
      if (props.showFold !== false) {
        metaParts.push(entry.foldSeq == null ? t('noFold') : t('fold') + ' #' + String(entry.foldSeq));
      }
      metaParts.push(entry.cacheHitPct == null ? t('cache') + ' —' : t('cache') + ' ' + String(entry.cacheHitPct) + '%');
      metaParts.push(t('samples') + ' ' + progress);
      if (Number(entry.step) > 0) metaParts.push(t('step') + ' ' + String(entry.step));
      if (entry.poolMatchPct != null) metaParts.push(t('poolMatch') + ' ' + Number(entry.poolMatchPct).toFixed(1) + '%');
      if (entry.poolTier != null) metaParts.push(t('poolTier') + ' ' + String(entry.poolTier));
      return h('div', {
        key: entry.id,
        style: {
          border: '1px solid var(--dsh-border-subtle, rgba(127,127,127,0.22))',
          borderRadius: 10,
          padding: '10px 12px',
          background: 'var(--dsh-surface-secondary, rgba(127,127,127,0.045))',
        },
      }, [
        h('div', { key: 'head', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 8 } }, [
          h('span', { key: 'time', style: { fontSize: 13, fontWeight: 600 } }, formatTime(entry.at)),
          h('span', { key: 'session', style: { fontSize: 12, opacity: 0.65, fontFamily: 'monospace' } }, shortSession(entry.sessionId)),
          h('span', {
            key: 'reason',
            style: {
              fontSize: 11,
              lineHeight: '18px',
              padding: '0 7px',
              borderRadius: 999,
              color: reasonColor,
              border: '1px solid ' + reasonColor + '55',
              background: reasonColor + '14',
            },
          }, reason),
          entry.backfilled ? h('span', {
            key: 'backfilled',
            title: t('backfilled'),
            style: { fontSize: 10, opacity: 0.6, border: '1px dashed currentColor', borderRadius: 999, padding: '0 6px' },
          }, t('backfilled')) : null,
          h('span', { key: 'state', style: { marginLeft: 'auto', fontSize: 11, opacity: 0.65 } },
            entry.afterComplete ? t('complete') : t('incomplete')),
        ]),
        h('div', {
          key: 'metrics',
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 10,
            paddingTop: 8,
            borderTop: '1px dashed var(--dsh-border-subtle, rgba(127,127,127,0.22))',
          },
        }, [
          h('div', { key: 'before' }, [
            h('div', { key: 'title', style: { fontSize: 11, opacity: 0.6, marginBottom: 5 } }, beforeTitle),
            h('div', { key: 'values', style: { display: 'flex', gap: 12, flexWrap: 'wrap' } }, [
              h(Metric, { key: 'ttft', label: t('ttft'), value: formatTtft(beforeTtft) }),
              h(Metric, { key: 'tps', label: t('tps'), value: formatTps(beforeTps) }),
            ]),
          ]),
          h('div', { key: 'after' }, [
            h('div', { key: 'title', style: { fontSize: 11, opacity: 0.6, marginBottom: 5 } }, afterLabel),
            h('div', { key: 'values', style: { display: 'flex', gap: 12, flexWrap: 'wrap' } }, hasAfter ? [
              h(Metric, { key: 'ttft', label: t('ttft'), value: formatTtft(afterTtft) }),
              h(Metric, { key: 'tps', label: t('tps'), value: formatTps(afterTps) }),
            ] : [
              h('div', { key: 'waiting', style: { fontSize: 12, opacity: 0.55 } }, t('waiting') + ' ' + progress),
            ]),
          ]),
          h('div', { key: 'change' }, [
            h('div', { key: 'title', style: { fontSize: 11, opacity: 0.6, marginBottom: 5 } }, changeTitle),
            h('div', { key: 'values', style: { display: 'flex', gap: 12, flexWrap: 'wrap' } }, [
              h(ChangeMetric, { key: 'ttft', label: t('ttft'), before: beforeTtft, after: afterTtft, lowerIsBetter: true }),
              h(ChangeMetric, { key: 'tps', label: t('tps'), before: beforeTps, after: afterTps, lowerIsBetter: false }),
            ]),
          ]),
        ]),
        poolAdopted ? h('div', { key: 'adopted-hint', style: { marginTop: 6, fontSize: 11, opacity: 0.55 } }, t('adoptedHint')) : null,
        h('div', { key: 'meta', style: { marginTop: 8, fontSize: 11, opacity: 0.55 } }, metaParts.join(' · ')),
        h('div', { key: 'threshold', style: { marginTop: 3, fontSize: 11, opacity: 0.5 } }, thresholdText(entry, t)),
      ]);
    }

    function shortCode(value) {
      var text = String(value == null ? '' : value);
      return text.length > 14 ? text.slice(0, 10) + '…' : text;
    }

    function PoolEventRow(props) {
      var entry = props.entry || {};
      var t = props.t;
      var adopted = entry.role === 'adopted';
      var color = adopted ? '#0f766e' : '#b45309';
      var meta = [
        adopted && entry.sourceSessionId ? t('poolSource') + ' ' + shortSession(entry.sourceSessionId) : null,
        entry.matchPct == null ? null : t('poolMatch') + ' ' + Number(entry.matchPct).toFixed(1) + '%',
        entry.tier == null ? null : t('poolTier') + ' ' + String(entry.tier),
        entry.donorTtftMs == null ? null : t('ttft') + ' ' + formatTtft(entry.donorTtftMs),
        entry.donorTps == null ? null : t('tps') + ' ' + formatTps(entry.donorTps),
        entry.code ? t('codeLabel') + ' ' + shortCode(entry.code) : null,
        entry.donorCode ? t('donorCode') + ' ' + shortCode(entry.donorCode) : null,
      ].filter(Boolean);
      return h('div', {
        style: {
          border: '1px solid var(--dsh-border-subtle, rgba(127,127,127,0.18))',
          borderRadius: 8,
          padding: '7px 10px',
          background: 'var(--dsh-surface-secondary, rgba(127,127,127,0.04))',
        },
      }, [
        h('div', { key: 'head', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } }, [
          h('span', { key: 'time', style: { fontSize: 12, fontWeight: 600 } }, formatTime(entry.at)),
          h('span', {
            key: 'role',
            style: {
              fontSize: 11,
              color: color,
              border: '1px solid ' + color + '55',
              background: color + '14',
              borderRadius: 999,
              padding: '0 6px',
            },
          }, adopted ? t('roleAdopted') : t('roleRevived')),
          h('span', { key: 'session', style: { fontSize: 11, opacity: 0.65, fontFamily: 'monospace' } }, shortSession(entry.sessionId)),
        ]),
        meta.length > 0
          ? h('div', { key: 'meta', style: { marginTop: 4, fontSize: 11, opacity: 0.55 } }, meta.join(' · '))
          : null,
      ]);
    }

    function poolReason(entry, t, target, minTps, maxTtftMs) {
      if (entry.eligible === true) return '';
      if (!Number(entry.digestChunks)) return t('poolNoDigest');
      var samples = Number(entry.samples) || 0;
      if (samples < target) return fill(t('poolNeedSamples'), { n: samples, target: target });
      var tps = Number(entry.avgTps);
      if (!Number.isFinite(tps) || tps <= Number(minTps)) {
        return fill(t('poolLowTps'), { min: minTps });
      }
      var ttft = Number(entry.avgTtftMs);
      if (Number.isFinite(ttft) && ttft > Number(maxTtftMs)) {
        return fill(t('poolHighTtft'), { max: (Number(maxTtftMs) / 1000).toFixed(1) });
      }
      return t('poolIneligible');
    }

    function PoolCodeRow(props) {
      var entry = props.entry || {};
      var t = props.t;
      var target = Number(props.sampleTarget) || 5;
      var eligible = entry.eligible === true;
      var color = eligible ? '#1f9d55' : '#b7791f';
      var tierColor = Number(entry.tier) === 1 ? '#0b7fab' : '#7c5cff';
      var tier = Number(entry.tier) === 1 ? t('poolLevel1') : t('poolLevel2');
      var samples = Number(entry.samples) || 0;
      var score = Number(entry.score);
      var reason = poolReason(entry, t, target, props.minTps, props.maxTtftMs);
      var meta = [
        t('poolIdle') + ' ' + formatAge(entry.ageMs),
        Number.isFinite(score) ? t('poolScore') + ' ' + score.toFixed(1) : null,
        Number(entry.digestChunks)
          ? t('poolDigest') + ' ' + String(entry.digestChunks) + ' / ' + String(entry.digestChars || 0)
          : null,
        entry.pooledAt ? t('poolPooledAt') + ' ' + formatTime(entry.pooledAt) : null,
      ].filter(Boolean);
      return h('div', {
        style: {
          border: '1px solid var(--dsh-border-subtle, rgba(127,127,127,0.18))',
          borderRadius: 8,
          padding: '8px 10px',
          background: 'var(--dsh-surface-secondary, rgba(127,127,127,0.04))',
        },
      }, [
        h('div', { key: 'head', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } }, [
          h('span', {
            key: 'tier',
            style: {
              fontSize: 11,
              color: tierColor,
              border: '1px solid ' + tierColor + '55',
              background: tierColor + '14',
              borderRadius: 999,
              padding: '0 6px',
            },
          }, tier),
          h('span', { key: 'session', style: { fontSize: 11, opacity: 0.65, fontFamily: 'monospace' } }, shortSession(entry.sessionId)),
          h('span', {
            key: 'eligible',
            style: {
              fontSize: 11,
              color: color,
              border: '1px solid ' + color + '55',
              background: color + '14',
              borderRadius: 999,
              padding: '0 6px',
            },
          }, eligible ? t('poolEligible') : t('poolIneligible')),
        ]),
        h('div', { key: 'code', style: { marginTop: 5, fontSize: 12, opacity: 0.85 } }, [
          h('span', { key: 'label', style: { opacity: 0.55, marginRight: 6 } }, t('poolCodeLabel')),
          h('span', { key: 'value', style: { fontFamily: 'monospace', wordBreak: 'break-all', userSelect: 'text' } }, entry.code || '—'),
        ]),
        h('div', { key: 'metrics', style: { display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 7 } }, [
          h(Metric, { key: 'ttft', label: t('ttft'), value: formatTtft(entry.avgTtftMs) }),
          h(Metric, { key: 'tps', label: t('tps'), value: formatTps(entry.avgTps) }),
          h(Metric, { key: 'samples', label: t('samples'), value: String(samples) + '/' + String(target) }),
          Number.isFinite(score) ? h(Metric, { key: 'score', label: t('poolScore'), value: score.toFixed(1) }) : null,
        ]),
        h('div', { key: 'meta', style: { marginTop: 6, fontSize: 11, opacity: 0.55 } }, meta.join(' · ')),
        reason ? h('div', { key: 'reason', style: { marginTop: 3, fontSize: 11, color: '#b7791f' } }, reason) : null,
      ]);
    }

    function PoolSection(props) {
      var entries = Array.isArray(props.entries) ? props.entries : [];
      var t = props.t;
      function group(tier, rows) {
        var label = tier === 1 ? t('poolLevel1') : t('poolLevel2');
        return h('div', { key: 'tier' + tier, style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
          h('div', { key: 'title', style: { fontSize: 12, fontWeight: 650, marginTop: 2 } }, label + ' · ' + String(rows.length)),
          rows.length === 0
            ? h('div', { key: 'empty', style: { fontSize: 12, opacity: 0.55 } }, t('poolTierEmpty'))
            : h('div', { key: 'rows', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, rows.map(function (entry) {
              return h(PoolCodeRow, {
                key: String(entry.sessionId) + '|' + String(entry.code),
                entry: entry,
                t: t,
                sampleTarget: props.sampleTarget,
                minTps: props.minTps,
                maxTtftMs: props.maxTtftMs,
              });
            })),
        ]);
      }
      var tier1 = entries.filter(function (entry) { return Number(entry.tier) === 1; });
      var tier2 = entries.filter(function (entry) { return Number(entry.tier) !== 1; });
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
        h('div', { key: 'title', style: { fontSize: 12, fontWeight: 650, marginTop: 2 } }, t('poolListTitle')),
        h('div', { key: 'hint', style: { fontSize: 11, opacity: 0.55 } }, t('poolListHint')),
        entries.length === 0
          ? h('div', { key: 'empty', style: { fontSize: 12, opacity: 0.55 } }, t('poolListEmpty'))
          : h('div', {
            key: 'groups',
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              maxHeight: 280,
              overflowY: 'auto',
              paddingRight: 4,
            },
          }, [group(1, tier1), group(2, tier2)]),
      ]);
    }

    function PoolEffectSection(props) {
      var effect = props.effect;
      if (!effect || typeof effect !== 'object') return null;
      var t = props.t;
      var adopted = effect.adopted || {};
      var baseline = effect.baseline || {};
      var adoptedCount = Number(adopted.count) || 0;
      var baselineCount = Number(baseline.count) || 0;
      var hasSamples = adoptedCount > 0 || baselineCount > 0;
      var lines = [];
      if (adoptedCount > 0) {
        lines.push(h('div', { key: 'adopted', style: { fontSize: 12 } }, fill(t('poolEffectAdopted'), {
          count: adoptedCount,
          hit: formatHitPct(adopted.avgFirstHitPct),
          match: formatHitPct(adopted.avgMatchPct),
        })));
      }
      if (baselineCount > 0) {
        lines.push(h('div', { key: 'baseline', style: { fontSize: 12 } }, fill(t('poolEffectBaseline'), {
          count: baselineCount,
          hit: formatHitPct(baseline.avgFirstHitPct),
        })));
      }
      if (effect.deltaPct != null && Number.isFinite(Number(effect.deltaPct))) {
        lines.push(h('div', { key: 'delta', style: { fontSize: 12, fontWeight: 600, color: Number(effect.deltaPct) >= 0 ? '#1f9d55' : '#d64545' } },
          fill(t('poolEffectDelta'), { delta: formatPp(effect.deltaPct) })));
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } }, [
        h('div', { key: 'title', style: { fontSize: 12, fontWeight: 650, marginTop: 2 } }, t('poolEffectTitle')),
        h('div', { key: 'hint', style: { fontSize: 11, opacity: 0.55 } }, t('poolEffectHint')),
        hasSamples
          ? h('div', { key: 'lines', style: { display: 'flex', flexDirection: 'column', gap: 3 } }, lines)
          : h('div', { key: 'empty', style: { fontSize: 12, opacity: 0.55 } }, t('poolEffectEmpty')),
      ]);
    }

    function RequestRow(props) {
      var entry = props.entry || {};
      var t = props.t;
      var hit = Number(entry.hitPct);
      var hasHit = Number.isFinite(hit);
      var color = hasHit ? (hit >= 80 ? '#1f9d55' : (hit <= 25 ? '#d64545' : '#b7791f')) : 'inherit';
      var meta = [
        t('ttft') + ' ' + formatTtft(entry.ttftMs),
        t('tps') + ' ' + formatTps(entry.tps),
        entry.inputTokens == null ? null : t('inputTokens') + ' ' + String(entry.inputTokens),
        entry.cacheReadTokens == null ? null : t('cacheRead') + ' ' + String(entry.cacheReadTokens),
      ].filter(Boolean);
      return h('div', {
        style: {
          border: '1px solid var(--dsh-border-subtle, rgba(127,127,127,0.18))',
          borderRadius: 8,
          padding: '7px 10px',
          background: 'var(--dsh-surface-secondary, rgba(127,127,127,0.04))',
        },
      }, [
        h('div', { key: 'head', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } }, [
          h('span', { key: 'time', style: { fontSize: 12, fontWeight: 600 } }, formatTime(entry.at)),
          h('span', { key: 'hit', style: { fontSize: 12, fontWeight: 650, color: color } }, hasHit ? hit.toFixed(1) + '%' : '—'),
          h('span', { key: 'session', style: { fontSize: 11, opacity: 0.65, fontFamily: 'monospace' } }, shortSession(entry.sessionId)),
        ]),
        h('div', { key: 'meta', style: { marginTop: 4, fontSize: 11, opacity: 0.55 } }, meta.join(' · ')),
      ]);
    }

    function LogSection(props) {
      var rows = Array.isArray(props.rows) ? props.rows : [];
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
        h('div', { key: 'title', style: { fontSize: 12, fontWeight: 650, marginTop: 2 } }, props.title),
        props.hint ? h('div', { key: 'hint', style: { fontSize: 11, opacity: 0.55 } }, props.hint) : null,
        rows.length === 0
          ? h('div', { key: 'empty', style: { fontSize: 12, opacity: 0.55 } }, props.emptyText)
          : h('div', {
            key: 'rows',
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              maxHeight: 260,
              overflowY: 'auto',
              paddingRight: 4,
            },
          }, rows),
      ]);
    }

    function averageChange(entries, field, lowerIsBetter) {
      var values = entries
        .map(function (entry) {
          var pct = changePct(entry['before' + field], entry['after' + field]);
          return pct;
        })
        .filter(function (value) { return Number.isFinite(value); });
      if (values.length === 0) return null;
      var total = values.reduce(function (sum, value) { return sum + value; }, 0);
      return total / values.length;
    }

    function PerformancePanel(props) {
      var hook = useStatus();
      var state = hook.state;
      var t = typeof props.t === 'function' ? props.t : function (key) { return en[key] || key; };
      var data = state.data || {};
      var history = Array.isArray(data.history) ? data.history : [];
      var completed = history.filter(function (entry) {
        return entry.afterComplete === true && Number.isFinite(Number(entry.afterTtftMs));
      });
      // A pool adoption has no pre-switch baseline of its own: its "before"
      // values are the borrowed code's history in the source session. Counting
      // that drift would report a speed change this session never experienced.
      var comparable = completed.filter(function (entry) {
        return entry.reason !== 'pool-adopted';
      });
      var avgTtft = averageChange(comparable, 'TtftMs', true);
      var avgTps = averageChange(comparable, 'Tps', false);
      var config = data.config || {};
      var criteria = fill(t('criteria'), {
        cache: config.cacheHitThresholdPct == null ? '?' : config.cacheHitThresholdPct,
        ttft: config.ttftThresholdMs == null ? '?' : (Number(config.ttftThresholdMs) / 1000).toFixed(0),
        tps: config.throughputThresholdTps == null ? '?' : config.throughputThresholdTps,
      });
      var stepRule = fill(t('stepRule'), {
        ttft: config.stepTtftGraceMs == null ? '?' : (Number(config.stepTtftGraceMs) / 1000).toFixed(0),
        tps: config.stepThroughputGraceTps == null ? '?' : config.stepThroughputGraceTps,
      });
      // sessions is an array. Show the step of the most recently active
      // session; per-row step remains the authoritative record for each switch.
      var sessions = Array.isArray(data.sessions) ? data.sessions.slice() : [];
      sessions.sort(function (a, b) { return (Number(b.lastRequestAt) || 0) - (Number(a.lastRequestAt) || 0); });
      var stepping = sessions.length > 0 && sessions[0].stepping ? sessions[0].stepping : null;
      var currentStep = stepping && Number(stepping.step) > 0 ? Number(stepping.step) : 0;
      // billion-context is optional. When its sessions root is absent the fold
      // chips are meaningless, so hide them and say where the numbers come from.
      var bili = data.billionContext || {};
      var hasBili = bili.detected !== false;
      var stats = data.statistics || {};
      var statsRequests = stats.requests || {};
      var statsText = Number(statsRequests.total) > 0 ? fill(t('statsLine'), {
        total: statsRequests.total,
        hit: statsRequests.avgHitPct == null ? '—' : Number(statsRequests.avgHitPct).toFixed(1),
        warm: statsRequests.warm || 0,
        cold: statsRequests.cold || 0,
        ttft: formatTtft(statsRequests.avgTtftMs),
        tps: formatTps(statsRequests.avgTps),
      }) : '';
      var poolEvents = Array.isArray(data.poolEvents) ? data.poolEvents.slice(0, 20) : [];
      var requests = firstRequestAfterPoolSwaps(data.requests, data.poolEvents, data.history, data.routes).slice(0, 20);

      if (props.view && props.view !== 'page') return null;

      var body;
      if (state.loading && history.length === 0) {
        body = h('div', { style: { fontSize: 13, opacity: 0.65, padding: '12px 0' } }, t('loading'));
      } else if (state.error && history.length === 0) {
        body = h('div', { style: { padding: '10px 0' } }, [
          h('div', { key: 'error', role: 'alert', style: { color: '#d64545', fontSize: 13 } }, t('error') + state.error),
          h('button', {
            key: 'retry',
            type: 'button',
            onClick: hook.retry,
            style: { marginTop: 8, padding: '4px 10px', cursor: 'pointer' },
          }, t('retry')),
        ]);
      } else if (history.length === 0) {
        body = h('div', { style: { fontSize: 13, opacity: 0.65, padding: '12px 0' } }, t('empty'));
      } else {
        body = h('div', {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            maxHeight: 520,
            overflowY: 'auto',
            paddingRight: 4,
          },
        }, history.map(function (entry) {
          return h(HistoryRow, { key: entry.id, entry: entry, t: t, showFold: hasBili });
        }));
      }

      var summary = history.length > 0 ? fill(t('summary'), {
        total: history.length,
        complete: completed.length,
      }) : '';
      var avg = (avgTtft != null || avgTps != null) ? fill(t('avg'), {
        ttft: avgTtft == null ? '—' : formatPct(avgTtft),
        tps: avgTps == null ? '—' : formatPct(avgTps),
      }) : '';
      var currentStepText = '';
      if (currentStep > 0) {
        currentStepText = t('currentStep') + ' ' + String(currentStep)
          + ' · ' + t('ttft') + ' ≥ ' + (Number(stepping.effectiveTtftThresholdMs) / 1000).toFixed(1) + ' s'
          + ' / ' + t('tps') + ' ≤ ' + String(stepping.effectiveThroughputThresholdTps) + ' tok/s';
      }
      var pool = data.pool || {};
      var poolEntries = Array.isArray(pool.entries) ? pool.entries.slice() : [];
      poolEntries.sort(function (a, b) {
        var ta = Number(a.tier) === 1 ? 1 : 2;
        var tb = Number(b.tier) === 1 ? 1 : 2;
        if (ta !== tb) return ta - tb;
        var ea = a.eligible === true ? 1 : 0;
        var eb = b.eligible === true ? 1 : 0;
        if (ea !== eb) return eb - ea;
        if (ta === 2) return (Number(b.score) || 0) - (Number(a.score) || 0);
        return (Number(b.lastActiveAt) || 0) - (Number(a.lastActiveAt) || 0);
      });
      var poolText = pool.enabled === false
        ? t('poolDisabled')
        : (pool.total != null
          ? fill(t('poolSummary'), { total: pool.total, tier1: pool.tier1 || 0, tier2: pool.tier2 || 0, eligible: pool.eligible || 0 })
          : '');
      if (pool.lastAdoption && pool.lastAdoption.at) {
        poolText += (poolText ? ' · ' : '') + fill(t('poolLastAdoption'), {
          match: Number(pool.lastAdoption.matchPct || 0).toFixed(1),
          time: formatTime(pool.lastAdoption.at),
        });
      }

      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          fontSize: 13,
          lineHeight: 1.45,
        },
      }, [
        h('div', { key: 'head', style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' } }, [
          h('div', { key: 'title', style: { fontSize: 15, fontWeight: 650 } }, t('title')),
          h('div', { key: 'ver', style: { marginLeft: 'auto', fontSize: 11, opacity: 0.55 } },
            t('version') + ' ' + String(data.version || '?') + (data.updatedAt ? ' · ' + t('updated') + ' ' + formatTime(data.updatedAt) : '')),
        ]),
        h('div', { key: 'subtitle', style: { fontSize: 12, opacity: 0.65 } }, t('subtitle')),
        h('div', { key: 'criteria', style: { fontSize: 11, opacity: 0.6 } }, criteria),
        h('div', { key: 'step-rule', style: { fontSize: 11, opacity: 0.6 } }, stepRule),
        summary ? h('div', { key: 'summary', style: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12 } }, [
          h('span', { key: 'count' }, summary),
          avg ? h('span', { key: 'avg', style: { opacity: 0.75 } }, avg) : null,
          currentStepText ? h('span', { key: 'current-step', style: { opacity: 0.75, color: '#b7791f' } }, currentStepText) : null,
        ]) : null,
        poolText ? h('div', { key: 'pool', style: { fontSize: 11, opacity: 0.65 } }, poolText) : null,
        pool.enabled === false ? null : h(PoolEffectSection, {
          key: 'pool-effect',
          effect: pool.effect,
          t: t,
        }),
        pool.enabled === false ? null : h(PoolSection, {
          key: 'pool-codes',
          entries: poolEntries,
          t: t,
          sampleTarget: Number(config.poolSampleSize) || 5,
          minTps: pool.minTps,
          maxTtftMs: pool.maxTtftMs,
        }),
        !hasBili ? h('div', { key: 'no-bili', style: { fontSize: 11, color: '#b45309' } }, t('noBili')) : null,
        statsText ? h('div', { key: 'stats', style: { fontSize: 11, opacity: 0.65 } }, statsText) : null,
        state.error ? h('div', { key: 'stale', style: { color: '#d64545', fontSize: 11 } }, t('error') + state.error) : null,
        body,
        h(LogSection, {
          key: 'pool-log',
          title: t('poolLog'),
          emptyText: t('poolLogEmpty'),
          rows: poolEvents.map(function (entry) {
            return h(PoolEventRow, {
              key: String(entry.at) + entry.sessionId + entry.role,
              entry: entry,
              t: t,
            });
          }),
        }),
        h(LogSection, {
          key: 'cache-log',
          title: t('cacheLog'),
          hint: t('cacheLogHint'),
          emptyText: t('cacheLogEmpty'),
          rows: requests.map(function (entry) {
            return h(RequestRow, {
              key: String(entry.at) + entry.sessionId,
              entry: entry,
              t: t,
            });
          }),
        }),
      ]);
    }

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      });
      ctx.slots.inject('plugins.bundle.config', function* () {
        yield ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-opencode-go-router', locale: NS }, PerformancePanel);
        yield ctx.slots.register({ name: 'plugins.bundle.config', key: 'opencode-router', locale: NS }, PerformancePanel);
      });
    }

    var inject = ['slots', 'locale'];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});

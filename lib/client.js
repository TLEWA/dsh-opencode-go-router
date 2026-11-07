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
      subtitle: '每次因缓存丢失或系统提示词改写而切换上游后，对比切换前后请求的速度。',
      empty: '还没有静默切换记录。',
      loading: '正在读取状态…',
      error: '读取状态失败：',
      retry: '重试',
      criteria: '触发条件：缓存命中 ≤ {cache}% 且 TTFT ≥ {ttft}s 或吞吐 ≤ {tps} tok/s；系统提示词改写可以绕过缓存条件。',
      summary: '共 {total} 次切换，{complete} 次已采满样本',
      avg: '已采满样本的平均变化：TTFT {ttft}，吞吐 {tps}',
      before: '切换前',
      after: '切换后',
      change: '变化',
      ttft: 'TTFT',
      tps: '吞吐',
      fold: '折叠',
      noFold: '无折叠',
      cache: '缓存命中',
      samples: '样本',
      reasonFold: '折叠 + 性能',
      reasonRewrite: '系统提示词改写',
      reasonPreflight: '折叠重建衔接',
      backfilled: '补录',
      waiting: '等待样本',
      none: '—',
      updated: '更新于',
      version: '版本',
      incomplete: '采样中',
      complete: '已完成',
      step: '步进',
      stepRule: '连续替换仍未达标时，每次步进把 TTFT 阈值放宽 {ttft}s、吞吐阈值下调 {tps} tok/s；某次切换后的采样窗口达标后步进归零。',
      currentStep: '最近活跃会话步进',
    };

    var en = {
      title: 'Silent switch performance log',
      subtitle: 'Speed before and after each upstream switch caused by cache loss or a system-prompt rewrite.',
      empty: 'No silent switches recorded yet.',
      loading: 'Reading status…',
      error: 'Failed to read status: ',
      retry: 'Retry',
      criteria: 'Triggers: cache hit ≤ {cache}% and TTFT ≥ {ttft}s or throughput ≤ {tps} tok/s; a system-prompt rewrite bypasses the cache condition.',
      summary: '{total} switches, {complete} with a complete sample window',
      avg: 'Average change over complete windows: TTFT {ttft}, throughput {tps}',
      before: 'Before',
      after: 'After',
      change: 'Change',
      ttft: 'TTFT',
      tps: 'Throughput',
      fold: 'Fold',
      noFold: 'No fold',
      cache: 'Cache hit',
      samples: 'Samples',
      reasonFold: 'Fold + speed',
      reasonRewrite: 'System rewrite',
      reasonPreflight: 'Fold rebuild seam',
      backfilled: 'Reconstructed',
      waiting: 'Waiting for samples',
      none: '—',
      updated: 'Updated',
      version: 'Version',
      incomplete: 'Sampling',
      complete: 'Complete',
      step: 'Step',
      stepRule: 'When consecutive switches still miss the targets, each step widens the TTFT threshold by {ttft}s and lowers the throughput threshold by {tps} tok/s; a good post-switch window resets the step.',
      currentStep: 'Most recent session step',
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

    function formatPct(value) {
      var n = Number(value);
      if (!Number.isFinite(n)) return '—';
      return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
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
      var reason = entry.reason === 'system-rewrite'
        ? t('reasonRewrite')
        : entry.reason === 'fold-preflight'
          ? t('reasonPreflight')
          : t('reasonFold');
      var reasonColor = entry.reason === 'system-rewrite'
        ? '#7c5cff'
        : entry.reason === 'fold-preflight'
          ? '#0b8f62'
          : '#0b7fab';
      var progress = String(entry.afterSamples || 0) + '/' + String(entry.afterTarget || 5);
      var afterLabel = hasAfter ? t('after') : t('waiting');
      var metaParts = [
        entry.foldSeq == null ? t('noFold') : t('fold') + ' #' + String(entry.foldSeq),
        entry.cacheHitPct == null ? t('cache') + ' —' : t('cache') + ' ' + String(entry.cacheHitPct) + '%',
        t('samples') + ' ' + progress,
      ];
      if (Number(entry.step) > 0) metaParts.push(t('step') + ' ' + String(entry.step));
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
            h('div', { key: 'title', style: { fontSize: 11, opacity: 0.6, marginBottom: 5 } }, t('before')),
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
            h('div', { key: 'title', style: { fontSize: 11, opacity: 0.6, marginBottom: 5 } }, t('change')),
            h('div', { key: 'values', style: { display: 'flex', gap: 12, flexWrap: 'wrap' } }, [
              h(ChangeMetric, { key: 'ttft', label: t('ttft'), before: beforeTtft, after: afterTtft, lowerIsBetter: true }),
              h(ChangeMetric, { key: 'tps', label: t('tps'), before: beforeTps, after: afterTps, lowerIsBetter: false }),
            ]),
          ]),
        ]),
        h('div', { key: 'meta', style: { marginTop: 8, fontSize: 11, opacity: 0.55 } }, metaParts.join(' · ')),
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
      var avgTtft = averageChange(completed, 'TtftMs', true);
      var avgTps = averageChange(completed, 'Tps', false);
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
          return h(HistoryRow, { key: entry.id, entry: entry, t: t });
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
        state.error ? h('div', { key: 'stale', style: { color: '#d64545', fontSize: 11 } }, t('error') + state.error) : null,
        body,
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

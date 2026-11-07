/**
 * opencode-router - implementation.
 *
 * Two host hooks:
 *  - llm-pi-ai/request-headers: stamp the rotated x-opencode-session value.
 *  - llm/stream: measure TTFT/throughput without changing the stream.
 * Plus a small monitor over billion-context's fold ledger and a status route.
 */

import fs from 'node:fs';
import {
  CONTENT_CHUNK_TYPES,
  NAME,
  TARGET_MODEL_PREFIX,
  VERSION,
  biliSessionsRoot,
  isTargetRequest,
  normalizeConfig,
} from './core.js';
import { RouterMonitor } from './monitor.js';
import { RouterStore } from './store.js';

const STATUS_ROUTE = '/opencode-router/status';

function createLogger(ctx) {
  const write = (level, args) => {
    try {
      const logger = ctx && ctx.logger;
      const fn = logger && logger[level];
      if (typeof fn === 'function') {
        fn.apply(logger, args);
        return;
      }
    } catch {
      // Fall through to console.
    }
    try {
      const fn = console[level] || console.log;
      if (typeof fn === 'function') fn.apply(console, args);
    } catch {
      // Logging must never break the host.
    }
  };
  return {
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    debug: (...args) => write('debug', args),
  };
}

function errorText(error) {
  if (error && typeof error.message === 'string') return error.message;
  return String(error);
}

function sessionKeyOf(value) {
  if (value == null) return '';
  return String(value);
}

/**
 * Return the rotated routing id for a request, or null when no rotation applies.
 * Kept separate from the waterfall handler so it is easy to unit test.
 */
export function routingForRequest(request, config, store) {
  if (!config.enabled || !store) return null;
  if (!isTargetRequest(request, config)) return null;
  const sessionId = sessionKeyOf(request && request.sessionId);
  if (sessionId === '') return null;
  const route = store.routeFor(sessionId);
  if (!route || typeof route.value !== 'string' || route.value === '') return null;
  return route;
}

export function applyRoutingHeaderDetailed(request, headers, config, store) {
  if (!headers || typeof headers.set !== 'function' || typeof headers.get !== 'function') {
    return { applied: false, route: null, reason: 'no-headers' };
  }
  if (!config.enabled) return { applied: false, route: null, reason: 'disabled' };
  // The strategy is only for OpenCode Go DeepSeek-series conversations. Other
  // models must never receive the rotated header, even if a route exists.
  if (!isTargetRequest(request, config)) {
    return { applied: false, route: null, reason: 'not-target' };
  }
  const route = routingForRequest(request, config, store);
  if (!route) return { applied: false, route: null, reason: 'no-route' };
  if (!config.overrideExistingHeader) {
    const current = headers.get('x-opencode-session');
    if (current != null && String(current).trim() !== '') {
      return { applied: false, route, reason: 'existing-header' };
    }
  }
  headers.set('x-opencode-session', route.value);
  return { applied: true, route, reason: 'applied' };
}

export function applyRoutingHeader(request, headers, config, store) {
  return applyRoutingHeaderDetailed(request, headers, config, store).applied;
}

/**
 * Record one completed stream. Invalid/aborted samples are ignored; the monitor
 * still gets a post-request nudge so the fold file is checked promptly.
 */
function recordMeasurement(state, measurement) {
  const { store, monitor, config, sessionId } = state;
  try {
    if (measurement.outputTokens > 0
      && measurement.firstTokenAt != null
      && measurement.endedAt > measurement.firstTokenAt) {
      const tps = measurement.outputTokens / ((measurement.endedAt - measurement.firstTokenAt) / 1000);
      if (Number.isFinite(tps) && tps > 0) {
        store.recordSample(sessionId, {
          ttftMs: Math.max(0, measurement.firstTokenAt - measurement.startedAt),
          tps,
          outputTokens: measurement.outputTokens,
          at: measurement.startedAt,
        }, config.maxSamples);
      }
    }
  } catch (error) {
    try {
      state.logger.warn('[opencode-router] sample record failed: ' + errorText(error));
    } catch {
      // Ignore.
    }
  }
  try {
    monitor.noteRequestFinished(sessionId);
  } catch {
    // Monitoring is best effort.
  }
}

export async function* measureStream(source, state) {
  const startedAt = state.startedAt;
  let firstTokenAt = null;
  let outputTokens = 0;
  let sawFinish = false;
  try {
    for await (const chunk of source) {
      if (chunk && typeof chunk === 'object') {
        const type = chunk.type;
        if (firstTokenAt == null && CONTENT_CHUNK_TYPES.has(type)) firstTokenAt = Date.now();
        if (type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
          const value = Number(chunk.usage.outputTokens);
          if (Number.isFinite(value) && value > 0) outputTokens = value;
        }
        if (type === 'finish') sawFinish = true;
      }
      yield chunk;
    }
  } finally {
    if (sawFinish) {
      recordMeasurement(state, {
        startedAt,
        firstTokenAt,
        outputTokens,
        endedAt: Date.now(),
      });
    }
  }
}

function isMethod(req, expected) {
  const method = String((req && req.method) || 'GET').toUpperCase();
  return method === expected;
}

function sendJson(res, status, payload) {
  let body = 'null';
  try {
    body = JSON.stringify(payload);
  } catch {
    body = '{"error":"serialize failed"}';
  }
  try {
    const length = Buffer.byteLength(body, 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': length,
    });
    res.end(body);
  } catch {
    try {
      res.end();
    } catch {
      // Socket already gone.
    }
  }
}

function registerStatusRoute(ctx, getStatus, logger) {
  try {
    if (!ctx || typeof ctx.inject !== 'function') return;
    ctx.inject(['webServer'], (sctx) => {
      try {
        const webServer = (sctx && sctx.webServer) || ctx.webServer;
        if (!webServer || typeof webServer.register !== 'function') return;
        const effectCtx = sctx && typeof sctx.effect === 'function' ? sctx : ctx;
        const handler = (req, res) => {
          try {
            if (!isMethod(req, 'GET')) {
              sendJson(res, 405, { error: 'method not allowed', allow: 'GET' });
              return;
            }
            sendJson(res, 200, getStatus());
          } catch (error) {
            logger.warn('[opencode-router] status handler failed: ' + errorText(error));
            sendJson(res, 500, { error: 'status failed', reason: errorText(error) });
          }
        };
        if (typeof effectCtx.effect === 'function') {
          effectCtx.effect(
            () => webServer.register({ kind: 'exact', path: STATUS_ROUTE, handler }),
            'opencode-router: status route',
          );
        } else {
          webServer.register({ kind: 'exact', path: STATUS_ROUTE, handler });
        }
      } catch (error) {
        logger.warn('[opencode-router] status route registration failed: ' + errorText(error));
      }
    });
  } catch (error) {
    logger.warn('[opencode-router] webServer injection failed: ' + errorText(error));
  }
}

export async function mount(ctx, rawConfig) {
  const logger = createLogger(ctx);
  const config = normalizeConfig(rawConfig);
  const store = new RouterStore({ statePath: config.statePath, logger });
  const monitor = new RouterMonitor({ config, store, logger });
  let disposed = false;
  // Observable proof that the waterfall actually stamped a request. This is
  // deliberately small: counts and the most recent applied value, no prompts.
  const routingStats = {
    checks: 0,
    applications: 0,
    lastCheckedAt: null,
    lastCheckedSessionId: null,
    lastAppliedAt: null,
    lastAppliedSessionId: null,
    lastAppliedValue: null,
    lastReason: null,
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      monitor.dispose();
    } catch {
      // Ignore cleanup failures.
    }
    Promise.resolve()
      .then(() => store.dispose())
      .catch(() => {});
    try {
      if (globalThis.__opencodeRouter && globalThis.__opencodeRouter.monitor === monitor) {
        delete globalThis.__opencodeRouter;
      }
    } catch {
      // Ignore.
    }
  };

  const start = () => {
    if (config.enabled) monitor.start();
  };

  const status = () => {
    const snapshot = store.snapshot();
    return {
      name: NAME,
      version: VERSION,
      enabled: config.enabled,
      dryRun: config.dryRun,
      statePath: config.statePath,
      config: { ...config },
      eligibility: {
        providers: [...config.providers],
        modelPrefix: TARGET_MODEL_PREFIX,
      },
      updatedAt: snapshot.updatedAt,
      routes: snapshot.routes,
      routing: { ...routingStats },
      sessions: monitor.status(),
    };
  };

  const onHeaders = (request, headers, next) => {
    try {
      const target = isTargetRequest(request, config);
      // Track the model of the latest ordinary conversation request. A
      // non-DeepSeek request makes this session ineligible until a DeepSeek
      // request returns. Auxiliary requests declare a purpose and are ignored.
      if (request && request.purpose === undefined) {
        const trackedSessionId = sessionKeyOf(request.sessionId);
        if (trackedSessionId !== '') monitor.noteRequestModel(trackedSessionId, target);
      }
      const detail = applyRoutingHeaderDetailed(request, headers, config, store);
      routingStats.checks += 1;
      routingStats.lastCheckedAt = Date.now();
      routingStats.lastCheckedSessionId = sessionKeyOf(request && request.sessionId);
      routingStats.lastReason = detail.reason;
      if (detail.applied) {
        routingStats.applications += 1;
        routingStats.lastAppliedAt = routingStats.lastCheckedAt;
        routingStats.lastAppliedSessionId = routingStats.lastCheckedSessionId;
        routingStats.lastAppliedValue = detail.route && detail.route.value ? detail.route.value : null;
        if (config.debug) {
          logger.info('[opencode-router] routed request for session ' + routingStats.lastAppliedSessionId);
        }
      }
    } catch (error) {
      try {
        logger.warn('[opencode-router] header routing failed: ' + errorText(error));
      } catch {
        // Ignore.
      }
    }
    return next();
  };

  const onStream = (options, next) => {
    if (!config.enabled || !isTargetRequest(options, config)) return next();
    // Auxiliary producers (titles, summaries, ...) declare a purpose; only
    // ordinary conversation requests belong in the TTFT/throughput samples.
    if (options && options.purpose !== undefined) return next();
    const sessionId = sessionKeyOf(options && options.sessionId);
    if (sessionId === '') return next();
    const startedAt = Date.now();
    const source = next();
    return measureStream(source, {
      startedAt,
      sessionId,
      config,
      store,
      monitor,
      logger,
    });
  };

  try {
    ctx.on('llm-pi-ai/request-headers', onHeaders, { prepend: true });
  } catch (error) {
    logger.warn('[opencode-router] request-header hook unavailable: ' + errorText(error));
  }

  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['llm'], () => {
        try {
          ctx.on('llm/stream', onStream, { prepend: true });
        } catch (error) {
          logger.warn('[opencode-router] llm/stream hook unavailable: ' + errorText(error));
        }
      });
    } else {
      ctx.on('llm/stream', onStream, { prepend: true });
    }
  } catch (error) {
    logger.warn('[opencode-router] llm injection failed: ' + errorText(error));
  }

  registerStatusRoute(ctx, status, logger);

  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        start();
        return dispose;
      }, 'opencode-router: lifecycle');
    } else {
      start();
      ctx.on('dispose', dispose);
    }
  } catch (error) {
    logger.warn('[opencode-router] lifecycle registration failed: ' + errorText(error));
    start();
  }

  try {
    globalThis.__opencodeRouter = { config, store, monitor, status };
  } catch {
    // Ignore.
  }

  if (config.debug) {
    logger.info(
      '[opencode-router] mounted enabled=' + config.enabled
      + ' dryRun=' + config.dryRun
      + ' state=' + config.statePath
      + ' model=' + TARGET_MODEL_PREFIX + '*'
      + ' cache<=' + config.cacheHitThresholdPct + '%'
      + ' ttft>=' + config.ttftThresholdMs + 'ms'
      + ' tps<=' + config.throughputThresholdTps,
    );
  }

  try {
    const root = biliSessionsRoot(config);
    if (!fs.existsSync(root)) {
      logger.info('[opencode-router] billion-context sessions not found; monitor idle (' + root + ')');
    }
  } catch {
    // Informational only.
  }
}

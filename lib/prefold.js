/**
 * Local pre-fold hook for the optional billion-context patch.
 *
 * billion-context writes a fold record only after the rebuild request has
 * completed, so a plugin that reacts to the ledger is always one request late
 * and pays a second cold prefill after rotating. The patch calls this hook
 * after the proxy has decided to rebuild and after the rebuilt body exists,
 * but before that body is forwarded. Rotating here makes the rebuild request
 * itself the first request on the new route, so the unavoidable rebuild miss
 * and the route switch share one cold prefill.
 *
 * The endpoint is bound to 127.0.0.1, accepts only POST, and requires a random
 * bearer token written to a per-user descriptor file. The descriptor and the
 * listener are removed when the plugin is disposed.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { VERSION } from './core.js';

export const PRE_FOLD_HOOK_VERSION = 1;
export const PRE_FOLD_PATH = '/pre-fold';
const MAX_BODY_BYTES = 8192;

function errorText(error) {
  if (error && typeof error.message === 'string') return error.message;
  return String(error);
}

export function tokenMatches(header, token) {
  const raw = String(header == null ? '' : header);
  const prefix = 'Bearer ';
  if (!raw.startsWith(prefix)) return false;
  const supplied = Buffer.from(raw.slice(prefix.length).trim(), 'utf8');
  const expected = Buffer.from(String(token == null ? '' : token), 'utf8');
  if (expected.length === 0 || supplied.length !== expected.length) return false;
  try {
    return timingSafeEqual(supplied, expected);
  } catch {
    return false;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) {
        reject(new Error('empty body'));
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        reject(new Error('empty body'));
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  let body = 'null';
  try {
    body = JSON.stringify(payload);
  } catch {
    body = '{"error":"serialize failed"}';
  }
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body, 'utf8'),
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

export function createPreFoldHandler(options) {
  const opts = options || {};
  const monitor = opts.monitor;
  const config = opts.config;
  const logger = opts.logger || console;
  const token = opts.token;
  const stats = opts.stats || {
    requests: 0,
    rejected: 0,
    rotations: 0,
    lastRequestAt: null,
    lastError: null,
    lastDecision: null,
  };

  return async function preFoldHandler(req, res) {
    const method = String((req && req.method) || 'GET').toUpperCase();
    let pathname = '';
    try {
      pathname = new URL(String((req && req.url) || '/'), 'http://127.0.0.1').pathname;
    } catch {
      pathname = '';
    }
    if (pathname !== PRE_FOLD_PATH) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (method !== 'POST') {
      try {
        res.setHeader('allow', 'POST');
      } catch {
        // Ignore.
      }
      sendJson(res, 405, { error: 'method not allowed', allow: 'POST' });
      return;
    }
    if (!config || config.enabled !== true) {
      stats.rejected += 1;
      sendJson(res, 503, { error: 'disabled', rotate: false });
      return;
    }
    if (!tokenMatches(req && req.headers ? req.headers.authorization : '', token)) {
      stats.rejected += 1;
      sendJson(res, 401, { error: 'unauthorized', rotate: false });
      return;
    }

    stats.requests += 1;
    stats.lastRequestAt = Date.now();
    let payload;
    try {
      payload = await readJsonBody(req);
    } catch (error) {
      stats.lastError = errorText(error);
      stats.lastDecision = { rotate: false, reason: 'invalid-request' };
      sendJson(res, 400, { error: 'invalid request', reason: errorText(error), rotate: false });
      return;
    }
    const sessionId = payload && typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (sessionId === '' || sessionId.length > 256) {
      stats.lastError = 'invalid sessionId';
      stats.lastDecision = { rotate: false, reason: 'invalid-session' };
      sendJson(res, 400, { error: 'invalid sessionId', rotate: false });
      return;
    }
    if (!monitor || typeof monitor.preflight !== 'function') {
      stats.lastError = 'monitor unavailable';
      stats.lastDecision = { rotate: false, reason: 'no-monitor' };
      sendJson(res, 503, { error: 'monitor unavailable', rotate: false });
      return;
    }
    try {
      const record = await monitor.preflight(sessionId, {
        reason: typeof payload.reason === 'string' ? payload.reason.slice(0, 80) : 'fold-rebuild',
      });
      if (record && typeof record.value === 'string' && record.value !== '') {
        stats.rotations += 1;
        stats.lastError = null;
        stats.lastDecision = {
          rotate: true,
          sessionId,
          value: record.value,
          reason: record.reason,
          foldSeq: record.foldSeq,
        };
        try {
          logger.info('[opencode-router] pre-fold hook rotated ' + sessionId + ' at fold #' + record.foldSeq);
        } catch {
          // Logging must not break the response.
        }
        sendJson(res, 200, {
          ok: true,
          rotate: true,
          sessionId,
          value: record.value,
          reason: record.reason,
          foldSeq: record.foldSeq,
        });
        return;
      }
      stats.lastError = null;
      stats.lastDecision = { rotate: false, sessionId, reason: 'no-pending-rotation' };
      sendJson(res, 200, { ok: true, rotate: false, sessionId, reason: 'no-pending-rotation' });
    } catch (error) {
      stats.lastError = errorText(error);
      stats.lastDecision = { rotate: false, sessionId, reason: 'preflight-failed' };
      try {
        logger.warn('[opencode-router] pre-fold hook failed: ' + stats.lastError);
      } catch {
        // Ignore.
      }
      sendJson(res, 500, { error: 'preflight failed', rotate: false });
    }
  };
}

function writeDescriptor(filePath, descriptor) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = JSON.stringify(descriptor, null, 2) + '\n';
  const temp = filePath + '.tmp-' + String(process.pid) + '-' + Date.now();
  fs.writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(temp, filePath);
  } catch (error) {
    // Windows cannot always replace an existing destination with rename.
    try {
      fs.rmSync(filePath, { force: true });
      fs.renameSync(temp, filePath);
    } catch (inner) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // Ignore.
      }
      throw inner || error;
    }
  }
}

function removeDescriptor(filePath, token) {
  try {
    const current = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!current || current.token !== token) return;
    fs.rmSync(filePath, { force: true });
  } catch {
    // Missing/unreadable descriptor: nothing to clean up.
  }
}

/**
 * Start the loopback hook and publish its descriptor. Returns null when the
 * hook is disabled. Binding/listen errors are thrown so the caller can log and
 * continue without the seam.
 */
export async function startPreFoldServer(options) {
  const opts = options || {};
  const config = opts.config;
  const logger = opts.logger || console;
  if (!config || config.preFoldHook !== true) return null;
  const hookPath = config.preFoldHookPath || path.join(process.cwd(), 'pre-fold-hook.json');
  const token = randomBytes(32).toString('hex');
  const stats = {
    requests: 0,
    rejected: 0,
    rotations: 0,
    lastRequestAt: null,
    lastError: null,
    lastDecision: null,
  };
  const server = http.createServer(createPreFoldHandler({
    monitor: opts.monitor,
    config,
    logger,
    token,
    stats,
  }));
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10000;
  let closed = false;
  let descriptor = null;

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  const url = 'http://127.0.0.1:' + String(port) + PRE_FOLD_PATH;
  descriptor = {
    version: PRE_FOLD_HOOK_VERSION,
    plugin: 'opencode-router',
    pluginVersion: VERSION,
    pid: process.pid,
    url,
    token,
    createdAt: Date.now(),
  };
  try {
    writeDescriptor(hookPath, descriptor);
  } catch (error) {
    try {
      server.close();
    } catch {
      // Ignore.
    }
    throw error;
  }
  server.on('error', (error) => {
    stats.lastError = errorText(error);
    try {
      logger.warn('[opencode-router] pre-fold hook server error: ' + stats.lastError);
    } catch {
      // Ignore.
    }
  });
  if (typeof server.unref === 'function') server.unref();

  return {
    path: hookPath,
    url,
    port,
    token,
    stats,
    summary() {
      return {
        enabled: true,
        listening: closed !== true,
        path: hookPath,
        url,
        port,
        requests: stats.requests,
        rejected: stats.rejected,
        rotations: stats.rotations,
        lastRequestAt: stats.lastRequestAt,
        lastError: stats.lastError,
        lastDecision: stats.lastDecision ? { ...stats.lastDecision } : null,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      removeDescriptor(hookPath, token);
      await new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
    },
  };
}

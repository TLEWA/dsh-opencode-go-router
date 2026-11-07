/**
 * opencode-router - host plugin shell.
 *
 * DSH's plugin loader caches modules by package name, so this shell keeps almost
 * no state: every apply reloads impl.js with a unique query string. Editing the
 * implementation and touching the plugin config therefore takes effect without
 * a full DSH restart. All failures are isolated here; a broken router must never
 * stop the host from starting.
 */

export const name = 'opencode-router';

/** Optional services only: hooks and the status route attach when available. */
export const inject = [];

let reloadSeq = 0;

function logViaContext(ctx, text) {
  try {
    const logger = ctx && ctx.logger;
    if (logger && typeof logger.warn === 'function') {
      logger.warn(text);
      return;
    }
  } catch {
    // Fall through to console.
  }
  try {
    console.warn(text);
  } catch {
    // Ignore.
  }
}

function describeError(error) {
  if (error && typeof error.stack === 'string') return error.stack;
  return String(error);
}

export async function apply(ctx, rawConfig) {
  try {
    const href = new URL('./impl.js', import.meta.url).href
      + '?v=' + Date.now() + '-' + (++reloadSeq);
    const impl = await import(href);
    if (!impl || typeof impl.mount !== 'function') {
      logViaContext(ctx, '[opencode-router] impl.js did not export mount; plugin skipped');
      return;
    }
    await impl.mount(ctx, rawConfig);
  } catch (error) {
    logViaContext(ctx, '[opencode-router] apply failed (plugin skipped, DSH unaffected): ' + describeError(error));
  }
}

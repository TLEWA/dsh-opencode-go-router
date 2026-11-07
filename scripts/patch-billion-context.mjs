#!/usr/bin/env node
/**
 * Patch billion-context's proxy with an optional pre-fold callback.
 *
 * billion-context records a fold only after the rebuild request has completed.
 * Its proxy, however, knows before forwarding the rebuilt request that a fold
 * is happening. This script inserts a small hook at that point: it reads the
 * descriptor published by dsh-opencode-go-router, asks the plugin for a new
 * x-opencode-session value, and writes it onto the outgoing request. The
 * rebuild itself then becomes the first request on the new route, so the
 * unavoidable cold rebuild and the route switch share one cache miss.
 *
 * The patch is idempotent, keeps a .opencode-router.bak copy, and can be
 * reverted. It is intentionally separate from the plugin: npm does not patch
 * other packages on install.
 *
 * Usage:
 *   node scripts/patch-billion-context.mjs --check
 *   node scripts/patch-billion-context.mjs --apply
 *   node scripts/patch-billion-context.mjs --revert
 *
 * Options:
 *   --file <path>       Explicit dist/index.js path.
 *   --profile <name>    DSH profile to search (default: all profiles).
 *   --help              Show this help.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '/* dsh-opencode-go-router pre-fold hook v2 */';
const LEGACY_MARKER = '/* dsh-opencode-go-router pre-fold hook v1 */';
const ORIGINAL = 'outbound=rebuilt;';
const PATCHED = 'outbound=rebuilt;await __biliPreFoldRotation(req,session,log2);';
const INITIAL_ANCHOR = 'prepared=await runPrepare();memProbe(opts.debug,log2,session.id,"prepared",typeof prepared.body==="string"?Buffer.byteLength(prepared.body):prepared.body.byteLength);await yieldToEventLoop();';
const INITIAL_PATCHED = 'prepared=await runPrepare();memProbe(opts.debug,log2,session.id,"prepared",typeof prepared.body==="string"?Buffer.byteLength(prepared.body):prepared.body.byteLength);if(session.stats.pendingFoldUsage===true)await __biliPreFoldRotation(req,session,log2);await yieldToEventLoop();';
const BAK_SUFFIX = '.opencode-router.bak';

function dshHome() {
  const env = process.env.DSH_HOME;
  if (env && env.trim() !== '') return path.resolve(env);
  return path.join(os.homedir(), '.dsh');
}

function candidateFiles(profile) {
  const out = [];
  const envFile = process.env.BILLION_CONTEXT_FILE;
  if (envFile && envFile.trim() !== '') out.push(path.resolve(envFile));
  const profilesRoot = path.join(dshHome(), 'profiles');
  let profiles = [];
  if (profile) {
    profiles = [profile];
  } else {
    try {
      profiles = fs.readdirSync(profilesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      profiles = [];
    }
  }
  for (const name of profiles) {
    out.push(path.join(profilesRoot, name, 'node_modules', 'billion-context', 'dist', 'index.js'));
  }
  out.push(path.join(dshHome(), 'node_modules', 'billion-context', 'dist', 'index.js'));
  return [...new Set(out)];
}

export function findBundle(options = {}) {
  if (options.file) {
    const file = path.resolve(options.file);
    return fs.existsSync(file) ? file : null;
  }
  for (const file of candidateFiles(options.profile)) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function helperSource() {
  return `${MARKER}
async function __biliPreFoldRotation(req, session, log) {
  try {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const candidates = [];
    if (process.env.OPENCODE_ROUTER_HOOK_FILE) candidates.push(process.env.OPENCODE_ROUTER_HOOK_FILE);
    if (process.env.DSH_HOME) candidates.push(path.join(process.env.DSH_HOME, 'storages', 'opencode-router', 'pre-fold-hook.json'));
    candidates.push(path.join(os.homedir(), '.dsh', 'storages', 'opencode-router', 'pre-fold-hook.json'));
    let descriptor = null;
    for (const file of candidates) {
      try {
        descriptor = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (descriptor && descriptor.url && descriptor.token) break;
        descriptor = null;
      } catch {
        descriptor = null;
      }
    }
    if (!descriptor) return;
    let url;
    try {
      url = new URL(descriptor.url);
    } catch {
      return;
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host)) return;
    const sessionId = session && (session.id || session.sessionId);
    if (!sessionId) return;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + descriptor.token,
      },
      body: JSON.stringify({ sessionId: String(sessionId), reason: 'fold-rebuild' }),
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return;
    const data = await response.json();
    if (!data || data.rotate !== true || typeof data.value !== 'string' || data.value === '') return;
    for (const key of Object.keys(req.headers || {})) {
      if (key.toLowerCase() === 'x-opencode-session') delete req.headers[key];
    }
    req.headers['x-opencode-session'] = data.value;
    try {
      if (typeof log === 'function') log('debug', '[' + sessionId + '] [pre-fold] rotated x-opencode-session to ' + data.value);
    } catch {}
  } catch (error) {
    try {
      if (typeof log === 'function') log('debug', '[pre-fold] hook failed: ' + String(error));
    } catch {}
  }
}
`;
}

export function patchSource(source) {
  const text = String(source);
  const hasV2 = text.indexOf(MARKER) >= 0;
  const hasV1 = text.indexOf(LEGACY_MARKER) >= 0;
  const hasHelper = text.indexOf('async function __biliPreFoldRotation') >= 0;
  const hasPreflight = text.indexOf(PATCHED) >= 0;
  const hasInitial = text.indexOf(INITIAL_PATCHED) >= 0;

  if (hasV2 || hasV1) {
    if (!hasHelper) {
      throw new Error('marker found but the pre-fold helper is missing; reinstall billion-context or restore the backup');
    }
    let out = text;
    let changed = false;
    if (!hasPreflight) {
      if (out.indexOf(ORIGINAL) < 0) {
        throw new Error('marker found but the pre-fold call is missing; reinstall billion-context or restore the backup');
      }
      out = out.replace(ORIGINAL, PATCHED);
      changed = true;
    }
    if (!hasInitial) {
      if (out.indexOf(INITIAL_ANCHOR) < 0) {
        throw new Error('marker found but the initial prepare anchor is missing; this billion-context version is unsupported');
      }
      out = out.replace(INITIAL_ANCHOR, INITIAL_PATCHED);
      changed = true;
    }
    if (hasV1) {
      out = out.replace(LEGACY_MARKER, MARKER);
      changed = true;
    }
    if (!changed) return { source: text, alreadyPatched: true };
    return { source: out, alreadyPatched: false };
  }

  if (text.indexOf('__biliPreFoldRotation') >= 0) {
    throw new Error('an unexpected __biliPreFoldRotation symbol already exists');
  }
  const preflightCalls = text.split(ORIGINAL).length - 1;
  const initialCalls = text.split(INITIAL_ANCHOR).length - 1;
  if (preflightCalls !== 1 || initialCalls !== 1) {
    throw new Error(
      'expected exactly one rebuild anchor and one initial prepare anchor, found '
      + preflightCalls + ' and ' + initialCalls + '; this billion-context version is unsupported',
    );
  }
  const patched = text.replace(ORIGINAL, PATCHED).replace(INITIAL_ANCHOR, INITIAL_PATCHED);
  return {
    source: patched + (patched.endsWith('\n') ? '' : '\n') + helperSource(),
    alreadyPatched: false,
  };
}

export function backupPathFor(file) {
  return file + BAK_SUFFIX;
}

export function applyPatch(file) {
  const source = fs.readFileSync(file, 'utf8');
  const result = patchSource(source);
  if (result.alreadyPatched) return { changed: false, backup: backupPathFor(file) };
  const backup = backupPathFor(file);
  // Keep the first pristine copy across upgrades (v1 -> v2). The current file
  // may already contain an older patch, so never overwrite an existing backup
  // with it.
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, result.source, 'utf8');
  return { changed: true, backup };
}

export function revertPatch(file) {
  const backup = backupPathFor(file);
  if (!fs.existsSync(backup)) {
    throw new Error('backup not found: ' + backup);
  }
  fs.copyFileSync(backup, file);
  return { changed: true, backup };
}

function usage() {
  return [
    'Patch billion-context with the opencode-router pre-fold hook.',
    '',
    'Usage:',
    '  node scripts/patch-billion-context.mjs --check',
    '  node scripts/patch-billion-context.mjs --apply',
    '  node scripts/patch-billion-context.mjs --revert',
    '',
    'Options:',
    '  --file <path>       Explicit billion-context/dist/index.js path.',
    '  --profile <name>    DSH profile to search (default: all profiles).',
    '  --help              Show this help.',
  ].join('\n');
}

export function parseArgs(argv) {
  const args = { action: null, file: null, profile: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check' || arg === '--apply' || arg === '--revert') {
      if (args.action) throw new Error('only one of --check, --apply or --revert is allowed');
      args.action = arg.slice(2);
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--file') {
      const value = argv[i + 1];
      if (!value) throw new Error('--file requires a path');
      args.file = value;
      i += 1;
    } else if (arg.startsWith('--file=')) {
      args.file = arg.slice('--file='.length);
    } else if (arg === '--profile') {
      const value = argv[i + 1];
      if (!value) throw new Error('--profile requires a name');
      args.profile = value;
      i += 1;
    } else if (arg.startsWith('--profile=')) {
      args.profile = arg.slice('--profile='.length);
    } else {
      throw new Error('unknown argument: ' + arg);
    }
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(String(error && error.message ? error.message : error));
    console.error(usage());
    return 2;
  }
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.action) {
    console.error(usage());
    return 2;
  }
  let file;
  try {
    file = findBundle({ file: args.file, profile: args.profile });
  } catch (error) {
    console.error(String(error && error.message ? error.message : error));
    return 2;
  }
  if (!file) {
    console.error('billion-context dist/index.js not found.');
    console.error('Looked in:');
    for (const candidate of candidateFiles(args.profile)) console.error('  ' + candidate);
    console.error('Use --file <path> if it is installed elsewhere.');
    return 3;
  }
  try {
    const source = fs.readFileSync(file, 'utf8');
    if (args.action === 'check') {
      const patched = source.includes(MARKER) && source.includes(PATCHED) && source.includes(INITIAL_PATCHED);
      const legacy = source.includes(LEGACY_MARKER);
      console.log((patched ? 'patched: ' : legacy ? 'outdated v1 patch: ' : 'not patched: ') + file);
      if (!source.includes(MARKER) && !legacy) {
        const preflightCalls = source.split(ORIGINAL).length - 1;
        const initialCalls = source.split(INITIAL_ANCHOR).length - 1;
        if (preflightCalls !== 1 || initialCalls !== 1) {
          console.error('unsupported billion-context version: expected exactly one rebuild anchor and one initial prepare anchor');
          return 4;
        }
      }
      return patched ? 0 : 1;
    }
    if (args.action === 'apply') {
      const result = applyPatch(file);
      console.log((result.changed ? 'patched: ' : 'already patched: ') + file);
      if (result.changed) console.log('backup: ' + result.backup);
      console.log('restart or reload the billion-context proxy for the change to take effect.');
      return 0;
    }
    const result = revertPatch(file);
    console.log('reverted: ' + file);
    console.log('backup kept: ' + result.backup);
    console.log('restart or reload the billion-context proxy for the change to take effect.');
    return 0;
  } catch (error) {
    console.error(String(error && error.message ? error.message : error));
    return 4;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = main();
}

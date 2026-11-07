import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyPatch,
  backupPathFor,
  findBundle,
  parseArgs,
  patchSource,
  revertPatch,
} from '../scripts/patch-billion-context.mjs';

function tempFile(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-router-patch-'));
  const file = path.join(dir, 'index.js');
  fs.writeFileSync(file, source, 'utf8');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return file;
}

const source = [
  'async function handleRequest() {',
  '  prepared=await runPrepare();memProbe(opts.debug,log2,session.id,"prepared",typeof prepared.body==="string"?Buffer.byteLength(prepared.body):prepared.body.byteLength);await yieldToEventLoop();',
  '}',
  'async function preflightCompressIfNeeded() {',
  '  let outbound = prepared;',
  '  if (result.compressedRanges > 0) {',
  '    const rebuilt = await runPrepare();',
  '    session.stats.requests -= 1;',
  '    outbound=rebuilt;',
  '    const rebuiltMsgs = [];',
  '  }',
  '  return outbound;',
  '}',
  '',
].join('\n');

test('parseArgs accepts one action and optional paths', () => {
  assert.deepEqual(parseArgs(['--check']), { action: 'check', file: null, profile: null, help: false });
  assert.deepEqual(parseArgs(['--apply', '--file', 'C:/tmp/index.js']), { action: 'apply', file: 'C:/tmp/index.js', profile: null, help: false });
  assert.equal(parseArgs(['--revert', '--profile=desktop']).profile, 'desktop');
  assert.equal(parseArgs(['--file=x.js', '--check']).file, 'x.js');
  assert.throws(() => parseArgs(['--check', '--apply']), /only one/);
  assert.throws(() => parseArgs(['--file']), /requires a path/);
  assert.throws(() => parseArgs(['--wat']), /unknown argument/);
});

test('patchSource inserts the hook call and helper exactly once', () => {
  const result = patchSource(source);
  assert.equal(result.alreadyPatched, false);
  assert.equal((result.source.split('outbound=rebuilt;\n').length - 1), 0);
  assert.equal((result.source.split('outbound=rebuilt;await __biliPreFoldRotation(req,session,log2);').length - 1), 1);
  assert.equal((result.source.split('if(session.stats.pendingFoldUsage===true)await __biliPreFoldRotation(req,session,log2);').length - 1), 1);
  assert.equal((result.source.split('async function __biliPreFoldRotation').length - 1), 1);
  assert.match(result.source, /dsh-opencode-go-router pre-fold hook v2/);
  assert.match(result.source, /127\.0\.0\.1/);
  assert.match(result.source, /x-opencode-session/);

  const again = patchSource(result.source);
  assert.equal(again.alreadyPatched, true);
  assert.equal(again.source, result.source);
});

test('patchSource refuses unknown bundle shapes', () => {
  assert.throws(() => patchSource('const x = 1;'), /expected exactly one/);
  assert.throws(() => patchSource(source + source), /expected exactly one/);
  assert.throws(
    () => patchSource(source + '\n/* dsh-opencode-go-router pre-fold hook v2 */\n'),
    /marker found but the pre-fold helper is missing/,
  );
});

test('patchSource upgrades a v1 patch without duplicating the helper', () => {
  const v2 = patchSource(source).source;
  const v1 = v2
    .replace('/* dsh-opencode-go-router pre-fold hook v2 */', '/* dsh-opencode-go-router pre-fold hook v1 */')
    .replace('if(session.stats.pendingFoldUsage===true)await __biliPreFoldRotation(req,session,log2);', '');
  assert.match(v1, /pre-fold hook v1/);
  assert.doesNotMatch(v1, /pendingFoldUsage===true/);

  const upgraded = patchSource(v1);
  assert.equal(upgraded.alreadyPatched, false);
  assert.match(upgraded.source, /pre-fold hook v2/);
  assert.equal((upgraded.source.split('if(session.stats.pendingFoldUsage===true)await __biliPreFoldRotation(req,session,log2);').length - 1), 1);
  assert.equal((upgraded.source.split('async function __biliPreFoldRotation').length - 1), 1);
  assert.equal(patchSource(upgraded.source).alreadyPatched, true);
});

test('applyPatch writes a backup and revertPatch restores it', (t) => {
  const file = tempFile(t, source);
  const result = applyPatch(file);
  assert.equal(result.changed, true);
  assert.equal(result.backup, backupPathFor(file));
  assert.equal(fs.readFileSync(result.backup, 'utf8'), source);
  assert.match(fs.readFileSync(file, 'utf8'), /__biliPreFoldRotation/);

  const again = applyPatch(file);
  assert.equal(again.changed, false);
  assert.equal(fs.readFileSync(result.backup, 'utf8'), source);

  const reverted = revertPatch(file);
  assert.equal(reverted.changed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), source);
});

test('revertPatch requires a backup', (t) => {
  const file = tempFile(t, source);
  assert.throws(() => revertPatch(file), /backup not found/);
});

test('findBundle honours an explicit file and rejects a missing one', (t) => {
  const file = tempFile(t, source);
  assert.equal(findBundle({ file }), path.resolve(file));
  assert.equal(findBundle({ file: path.join(path.dirname(file), 'missing.js') }), null);
});

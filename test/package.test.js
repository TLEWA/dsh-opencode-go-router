import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
const patch = fs.readFileSync(new URL(pkg.dsh.bundle.patch, root), 'utf8');
const client = fs.readFileSync(new URL('lib/client.js', root), 'utf8');

test('the bundle patch inserts the package under its published name', () => {
  const names = [...patch.matchAll(/^\s*name:\s*'([^']+)'\s*$/gm)].map((match) => match[1]);
  assert.deepEqual(names, [pkg.name]);
  assert.match(patch, new RegExp('^\\s*- id: opencode-router$', 'm'));
});

test('the client bundle identifies itself by the package name', () => {
  assert.equal(pkg.dsh.client.platform, 'web');
  const match = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/);
  assert.equal(match?.[1], pkg.name);
  assert.equal(pkg.exports['./client'], './lib/client.js');
});

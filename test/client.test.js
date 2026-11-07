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

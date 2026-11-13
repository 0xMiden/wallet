import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { loadConfigFromFile } from 'vite';

test('does not emit an alternate async initializer that bypasses reset readiness', async () => {
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'development' }, resolve('vite.background.config.ts'));
  const plugin = loaded?.config.plugins.flat().find(value => value && typeof value === 'object' && value.name === 'sw-patches');
  const hook = plugin?.generateBundle;
  const run = typeof hook === 'function' ? hook : hook?.handler;
  assert.equal(typeof run, 'function');
  const bundle = { 'background.js': { type: 'chunk', code: 'await init_unsafe();\nasync function processRequest(req) {}' } };
  assert.throws(() => run.call({ error(message) { throw new Error(message); } }, {}, bundle, false),
    /async module initializers/i);
});

const built = process.env.WALLET_SW_BUILD_DIR ?? resolve('dist/chrome_unpacked');
for (const path of [resolve('public/sw.js'), resolve(built, 'background.js')]) {
  test(`${path.endsWith('background.js') ? 'built background' : 'public wrapper'} listeners wait for reset readiness`, async () => {
    const handlers = {};
    const writes = [];
    const opened = [];
    const stop = new Error('listener registration boundary');
    let release;
    const ready = new Promise(resolve => { release = resolve; });
    const event = name => ({ addListener: handler => { handlers[name] = handler; } });
    const context = {
      Promise, Date,
      console: { debug() {}, warn() {}, error() {} },
      chrome: {
        runtime: { onInstalled: event('installed'), onConnect: event('connect'),
          onMessage: event('message'), getURL: path => `chrome-extension://fixture/${path}` },
        storage: { local: { set: async value => { writes.push(value); } } },
        tabs: { create: async value => { opened.push(value); } }
      }
    };
    context.self = {
      __midenPlatformStartupReady: ready,
      __midenEnsurePlatformStartup: async () => undefined,
      clients: { openWindow: async url => { opened.push({ url }); } },
      addEventListener(name, handler) {
        handlers[name] = handler;
        // Exercise the byte-exact emitted listener prefix, not unrelated SDK initialization.
        throw stop;
      }
    };
    const module = new vm.SourceTextModule(readFileSync(path, 'utf8'), { context: vm.createContext(context) });
    await module.link(() => { throw new Error('Unexpected external import'); });
    await assert.rejects(module.evaluate(), error => error === stop);
    assert.equal(typeof handlers.installed, 'function');
    assert.equal(typeof handlers.connect, 'function');
    handlers.installed({ reason: 'install' });
    let disconnected;
    handlers.connect({ name: 'Popup Connection', onDisconnect: { addListener: fn => { disconnected = fn; } } });
    assert.equal(typeof disconnected, 'function');
    disconnected();
    await Promise.resolve();
    assert.equal(writes.length, 0, 'storage work crossed the pending-reset barrier');
    assert.equal(opened.length, 0);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes.length, 2);
    assert.equal(opened.length, 1);
  });
}

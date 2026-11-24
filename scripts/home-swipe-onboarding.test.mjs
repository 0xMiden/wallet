import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./home-swipe-bench.mjs', import.meta.url), 'utf8');
const reachHomeSource = source.slice(
  source.indexOf('async function reachHome('),
  source.indexOf('async function dispatchPointer(')
);

test('mock home imports a public fixture instead of requiring a mainnet creation invitation', async () => {
  let imported = false;
  let ready = false;
  let initialised = false;
  let bypassAttempted = false;
  let clock = 0;
  const page = {
    setDefaultTimeout() {},
    async addInitScript(script) {
      const context = {};
      vm.runInNewContext(`(${script.toString()})()`, context);
      imported =
        typeof context.__TEST_IMPORT_SEED__ === 'string' && context.__TEST_IMPORT_SEED__.split(' ').length === 12;
      initialised = true;
    },
    async goto(url) {
      const bypass = new URL(url).searchParams.get('__test_skip_onboarding') === '1';
      bypassAttempted = bypass;
      ready = bypass && imported;
    }
  };
  const reachHome = vm.runInNewContext(`(${reachHomeSource})`, {
    Date: { now: () => (clock += 20_000) },
    URL,
    PAGE_URL: 'http://127.0.0.1:1234/',
    PASSCODE: '123456',
    console: { log() {} },
    sleep: async () => {},
    snapshot: async () => ({
      status: ready ? 2 : 0,
      track: ready,
      welcome: !bypassAttempted,
      hash: ready ? '#/' : '#mainnet-access'
    })
  });
  await reachHome(page);
  assert.equal(ready, true);
  assert.equal(initialised, true);
});

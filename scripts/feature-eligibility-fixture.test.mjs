import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { createEligibilityFixture } from './feature-eligibility-fixture.mjs';

const fixtures = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()));
});
const document = (network = 'testnet', version = 13) => ({
  network,
  version,
  features: { earn: true },
  swap: { etaUrl: 'https://quotes.test' }
});
async function start(options = {}) {
  const fixture = await createEligibilityFixture({
    networks: ['testnet'],
    fetchImpl: async () => new Response(JSON.stringify(document())),
    ...options
  });
  fixtures.push(fixture);
  await fixture.listen(0);
  return fixture;
}

test('freezes one upstream policy and serves identical versions in config and decision routes', async () => {
  let calls = 0;
  const fixture = await start({
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify(document()));
    }
  });
  const config = await (await fetch(`${fixture.url}/testnet.json`)).json();
  const decision = await (await fetch(`${fixture.url}/v1/eligibility?network=testnet`)).json();
  assert.equal(calls, 1);
  assert.deepEqual(config.geo.wallet, {});
  assert.deepEqual(decision, { network: 'testnet', version: 13, allowed: { wallet: true, earn: true, swap: true } });
  assert.equal((await fetch(`${fixture.url}/v1/eligibility?network=devnet`)).status, 400);
});

test('generates localnet explicitly without requesting a nonexistent published document', async () => {
  const fixture = await start({
    networks: ['localnet'],
    fetchImpl: () => {
      throw new Error('unexpected fetch');
    }
  });
  const config = await (await fetch(`${fixture.url}/localnet.json`)).json();
  assert.equal(config.network, 'localnet');
  assert.deepEqual(config.geo.wallet, {});
  assert.deepEqual(await (await fetch(`${fixture.url}/v1/eligibility?network=localnet`)).json(), {
    network: 'localnet',
    version: 1,
    allowed: { wallet: true, earn: false, swap: false }
  });
});

test('lazy source starts before the upstream and follows intentional policy version updates', async () => {
  let current;
  const fixture = await start({
    source: 'http://127.0.0.1:8550',
    lazySource: true,
    fetchImpl: async () => {
      if (!current) throw new Error('not listening');
      return new Response(JSON.stringify(current));
    }
  });
  assert.equal((await fetch(`${fixture.url}/healthz`)).status, 200);
  assert.equal((await fetch(`${fixture.url}/v1/eligibility?network=testnet`)).status, 503);
  current = document('testnet', 14);
  assert.equal((await (await fetch(`${fixture.url}/v1/eligibility?network=testnet`)).json()).version, 14);
  current = document('testnet', 15);
  assert.equal((await (await fetch(`${fixture.url}/v1/eligibility?network=testnet`)).json()).version, 15);
});

test('config overrides update both realms and strict decisions together', async () => {
  const fixture = await start();
  const updated = document('testnet', 14);
  updated.features.earn = false;
  const response = await fetch(`${fixture.url}/_fixture/config`, { method: 'POST', body: JSON.stringify(updated) });
  assert.equal(response.status, 200);
  assert.equal((await (await fetch(`${fixture.url}/testnet.json`)).json()).version, 14);
  assert.deepEqual(await (await fetch(`${fixture.url}/v1/eligibility?network=testnet`)).json(), {
    network: 'testnet',
    version: 14,
    allowed: { wallet: true, earn: false, swap: true }
  });
});

test('explicit restricted and failed modes fail closed, and loading waits for a state change', async () => {
  const fixture = await start();
  const set = state => fetch(`${fixture.url}/_fixture/response`, { method: 'POST', body: JSON.stringify({ state }) });
  await set('restricted');
  assert.deepEqual((await (await fetch(`${fixture.url}/v1/eligibility?network=testnet`)).json()).allowed, {
    wallet: false,
    earn: false,
    swap: false
  });
  await set('unavailable');
  assert.equal((await fetch(`${fixture.url}/v1/eligibility?network=testnet`)).status, 503);
  await set('loading');
  const pending = fetch(`${fixture.url}/v1/eligibility?network=testnet`);
  await set('allowed');
  assert.equal((await pending).status, 200);
  assert.equal((await set('invalid')).status, 400);
});

test('rejects IP parameters and malformed or foreign config overrides', async () => {
  const fixture = await start();
  assert.equal((await fetch(`${fixture.url}/v1/eligibility?network=testnet&ip=example`)).status, 400);
  assert.equal((await fetch(`${fixture.url}/v1/eligibility?network=testnet&network=testnet`)).status, 400);
  assert.equal(
    (await fetch(`${fixture.url}/_fixture/config`, { method: 'POST', body: JSON.stringify(document('devnet')) }))
      .status,
    400
  );
});

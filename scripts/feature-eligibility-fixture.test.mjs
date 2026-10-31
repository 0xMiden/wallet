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
const oneClick = {
  serviceUrl: 'https://one-click.example/api',
  midenAssets: [{ assetId: 'miden:usdc', faucetId: `0x${'ab'.repeat(15)}`, decimals: 6 }]
};
const nearIntentsDocument = (network = 'testnet', version = 13, serviceUrl = oneClick.serviceUrl) => ({
  network,
  version,
  features: { earn: false, nearIntents: true },
  swap: { oneClick: { ...oneClick, serviceUrl } },
  geo: { wallet: {} }
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

test('exposes only the most recent eligibility Origin and can clear the observation', async () => {
  const fixture = await start();
  const observationUrl = `${fixture.url}/_fixture/origin`;
  assert.deepEqual(await (await fetch(observationUrl)).json(), { observed: false, origin: null });

  await fetch(`${fixture.url}/v1/eligibility?network=testnet`, { headers: { Origin: 'chrome-extension://test-id' } });
  assert.deepEqual(await (await fetch(observationUrl)).json(), {
    observed: true,
    origin: 'chrome-extension://test-id'
  });

  const reset = await fetch(observationUrl, { method: 'POST' });
  assert.equal(reset.status, 200);
  assert.deepEqual(await (await fetch(observationUrl)).json(), { observed: false, origin: null });
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
  const updated = nearIntentsDocument('testnet', 14);
  const response = await fetch(`${fixture.url}/_fixture/config`, { method: 'POST', body: JSON.stringify(updated) });
  assert.equal(response.status, 200);
  assert.deepEqual(await (await fetch(`${fixture.url}/testnet.json`)).json(), { ...updated, geo: { wallet: {} } });
  assert.deepEqual(await (await fetch(`${fixture.url}/v1/eligibility?network=testnet`)).json(), {
    network: 'testnet',
    version: 14,
    allowed: { wallet: true, earn: false, swap: true }
  });
});

test('oneClick-only swap capability is eligible only with nearIntents and a valid Miden mapping', async () => {
  const oneClickDocument = {
    network: 'testnet',
    version: 13,
    features: { earn: false, nearIntents: true },
    swap: {
      oneClick: {
        serviceUrl: 'https://oneclick.example',
        midenAssets: [{ assetId: 'miden:usdc', faucetId: `0x${'11'.repeat(15)}`, decimals: 6 }]
      }
    }
  };
  const fixture = await start({ fetchImpl: async () => new Response(JSON.stringify(oneClickDocument)) });
  const eligible = await fetch(`${fixture.url}/v1/eligibility?network=testnet`);
  assert.deepEqual((await eligible.json()).allowed, { wallet: true, earn: false, swap: true });

  const nearIntentsOff = { ...oneClickDocument, version: 14, features: { earn: false, nearIntents: false } };
  await fetch(`${fixture.url}/_fixture/config`, { method: 'POST', body: JSON.stringify(nearIntentsOff) });
  const disabled = await fetch(`${fixture.url}/v1/eligibility?network=testnet`);
  assert.deepEqual((await disabled.json()).allowed, { wallet: true, earn: false, swap: false });

  const missingMapping = {
    ...oneClickDocument,
    version: 15,
    swap: { oneClick: { serviceUrl: 'https://oneclick.example', midenAssets: [] } }
  };
  await fetch(`${fixture.url}/_fixture/config`, { method: 'POST', body: JSON.stringify(missingMapping) });
  const unusable = await fetch(`${fixture.url}/v1/eligibility?network=testnet`);
  assert.deepEqual((await unusable.json()).allowed, { wallet: true, earn: false, swap: false });
});

test('HTTP eligibility follows OneClick-only Near Intents policy and validates mappings and service URLs', async () => {
  const networks = ['mainnet', 'testnet', 'devnet', 'localnet'];
  const fixture = await start({
    networks,
    fetchImpl: async url => {
      const network = new URL(url).pathname.split('/').at(-1).replace('.json', '');
      return new Response(JSON.stringify(nearIntentsDocument(network)));
    }
  });
  const update = async (network, config) => {
    const response = await fetch(`${fixture.url}/_fixture/config`, { method: 'POST', body: JSON.stringify(config) });
    assert.equal(response.status, 200);
    return (await fetch(`${fixture.url}/v1/eligibility?network=${network}`)).json();
  };
  for (const network of ['mainnet', 'testnet', 'devnet']) {
    assert.deepEqual(await (await fetch(`${fixture.url}/v1/eligibility?network=${network}`)).json(), {
      network,
      version: 13,
      allowed: { wallet: true, earn: false, swap: true }
    });
  }
  assert.deepEqual(await (await fetch(`${fixture.url}/v1/eligibility?network=localnet`)).json(), {
    network: 'localnet',
    version: 1,
    allowed: { wallet: true, earn: false, swap: false }
  });

  for (const network of ['mainnet', 'testnet', 'devnet']) {
    for (const [version, serviceUrl] of [[14, 'http://localhost:8551'], [15, 'http://127.0.0.1:8551'], [16, 'http://[::1]:8551']]) {
      const result = await update(network, nearIntentsDocument(network, version, serviceUrl));
      assert.equal(result.version, version);
      assert.equal(result.allowed.swap, false, `${network} must reject HTTP OneClick service URLs`);
    }
  }

  for (const [version, serviceUrl] of [[2, 'http://localhost:8551'], [3, 'http://127.0.0.1:8551'], [4, 'http://[::1]:8551']]) {
    const result = await update('localnet', nearIntentsDocument('localnet', version, serviceUrl));
    assert.equal(result.allowed.swap, true, `${serviceUrl} is a permitted localnet loopback`);
  }
  for (const [version, serviceUrl] of [[5, 'http://one-click.example'], [6, 'http://192.168.1.4:8551']]) {
    const result = await update('localnet', nearIntentsDocument('localnet', version, serviceUrl));
    assert.equal(result.allowed.swap, false, `${serviceUrl} is not an allowed localnet loopback`);
  }

  for (const config of [
    { ...nearIntentsDocument('testnet', 16), features: { earn: false } },
    { ...nearIntentsDocument('testnet', 17), features: { nearIntents: false } },
    { ...nearIntentsDocument('testnet', 18), swap: { oneClick: { ...oneClick, midenAssets: [] } } },
    { ...nearIntentsDocument('testnet', 19), swap: { oneClick: { ...oneClick, midenAssets: [{ ...oneClick.midenAssets[0], assetId: '' }] } } },
    { ...nearIntentsDocument('testnet', 20), swap: { oneClick: { ...oneClick, midenAssets: [...oneClick.midenAssets, { ...oneClick.midenAssets[0], faucetId: `0x${'cd'.repeat(15)}` }] } } },
    { ...nearIntentsDocument('testnet', 21), swap: { oneClick: { ...oneClick, midenAssets: [...oneClick.midenAssets, { ...oneClick.midenAssets[0], assetId: 'miden:other' }] } } }
  ]) {
    const result = await update('testnet', config);
    assert.equal(result.allowed.swap, false);
  }
});

test('explicit restricted and failed modes fail closed', async () => {
  const fixture = await start();
  const configured = await fetch(`${fixture.url}/_fixture/config`, {
    method: 'POST',
    body: JSON.stringify(nearIntentsDocument('testnet', 14))
  });
  assert.equal(configured.status, 200);
  assert.equal((await (await fetch(`${fixture.url}/v1/eligibility?network=testnet`)).json()).allowed.swap, true);
  const set = state => fetch(`${fixture.url}/_fixture/response`, { method: 'POST', body: JSON.stringify({ state }) });
  await set('restricted');
  assert.deepEqual((await (await fetch(`${fixture.url}/v1/eligibility?network=testnet`)).json()).allowed, {
    wallet: false,
    earn: false,
    swap: false
  });
  await set('unavailable');
  assert.equal((await fetch(`${fixture.url}/v1/eligibility?network=testnet`)).status, 503);
  assert.equal((await set('invalid')).status, 400);
});

test('loading waits for a state change before allowing wallet access', { timeout: 10_000 }, async () => {
  let onRequestWaiting;
  const enteredWaiting = new Promise(resolve => {
    onRequestWaiting = resolve;
  });
  const fixture = await start({ onRequestWaiting });
  const configured = await fetch(`${fixture.url}/_fixture/config`, {
    method: 'POST',
    body: JSON.stringify(nearIntentsDocument('testnet', 14))
  });
  assert.equal(configured.status, 200);
  const set = state => fetch(`${fixture.url}/_fixture/response`, { method: 'POST', body: JSON.stringify({ state }) });
  await set('loading');
  let settled = false;
  const pending = fetch(`${fixture.url}/v1/eligibility?network=testnet`, {
    signal: AbortSignal.timeout(5_000)
  }).finally(() => {
    settled = true;
  });
  const first = await Promise.race([
    enteredWaiting.then(() => 'waiting'),
    pending.then(
      () => 'responded',
      () => 'rejected'
    )
  ]);
  assert.equal(first, 'waiting', 'loading request must enter waiting before responding');
  assert.equal(settled, false, 'loading response must remain pending before allowing');
  await set('allowed');
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    network: 'testnet',
    version: 14,
    allowed: { wallet: true, earn: false, swap: true }
  });
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

test('explicit prelaunch testnet keeps general onboarding after the published launch without changing eligibility', async () => {
  const published = {
    ...document(),
    mainnetCountdown: { enabled: true, launchAt: '2026-10-26T13:00:00Z' },
    geo: { wallet: {}, earn: { US: true } }
  };
  const fixture = await start({
    prelaunchTestnet: true,
    fetchImpl: async () => new Response(JSON.stringify(published))
  });
  const config = await (await fetch(`${fixture.url}/testnet.json`)).json();
  assert.deepEqual(config, { ...published, mainnetCountdown: { ...published.mainnetCountdown, enabled: false } });
  assert.equal(published.mainnetCountdown.enabled, true);
  assert.deepEqual(await (await fetch(`${fixture.url}/v1/eligibility?network=testnet`)).json(), {
    network: 'testnet',
    version: 13,
    allowed: { wallet: true, earn: true, swap: true }
  });
  const updated = { ...published, version: 14, features: { earn: false } };
  await fetch(`${fixture.url}/_fixture/config`, { method: 'POST', body: JSON.stringify(updated) });
  assert.deepEqual(await (await fetch(`${fixture.url}/testnet.json`)).json(), {
    ...updated, mainnetCountdown: { ...published.mainnetCountdown, enabled: false }
  });
  assert.deepEqual(await (await fetch(`${fixture.url}/v1/eligibility?network=testnet`)).json(), {
    network: 'testnet', version: 14, allowed: { wallet: true, earn: false, swap: true }
  });
  await fetch(`${fixture.url}/_fixture/response`, { method: 'POST', body: JSON.stringify({ state: 'restricted' }) });
  assert.deepEqual((await (await fetch(`${fixture.url}/v1/eligibility?network=testnet`)).json()).allowed, {
    wallet: false,
    earn: false,
    swap: false
  });
  assert.equal((await fetch(`${fixture.url}/mainnet.json`)).status, 404);
  assert.equal((await fetch(`${fixture.url}/v1/eligibility?network=mainnet`)).status, 400);
});

test('ordinary fixtures retain the real launch state and explicit config updates', async () => {
  const published = { ...document(), mainnetCountdown: { enabled: true, launchAt: '2026-10-26T13:00:00Z' } };
  const fixture = await start({ fetchImpl: async () => new Response(JSON.stringify(published)) });
  assert.equal((await (await fetch(`${fixture.url}/testnet.json`)).json()).mainnetCountdown.enabled, true);
  const updated = { ...published, version: 14, mainnetCountdown: { enabled: false } };
  await fetch(`${fixture.url}/_fixture/config`, { method: 'POST', body: JSON.stringify(updated) });
  assert.deepEqual(await (await fetch(`${fixture.url}/testnet.json`)).json(), { ...updated, geo: { wallet: {} } });
});

test('prelaunch mode refuses Mainnet and mixed-network fixtures', async () => {
  for (const networks of [['mainnet'], ['testnet', 'mainnet'], ['devnet']]) {
    await assert.rejects(
      createEligibilityFixture({
        networks,
        prelaunchTestnet: true,
        fetchImpl: async () => new Response(JSON.stringify(document(networks[0])))
      })
    );
  }
});

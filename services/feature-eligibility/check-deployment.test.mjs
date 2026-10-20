import assert from 'node:assert/strict';
import test from 'node:test';

import { checkDeployment } from './check-deployment.mjs';

const endpoint = 'https://eligibility.example/v1/eligibility';
const options = {
  endpoint,
  networks: ['testnet', 'devnet'],
  origins: ['https://wallet.example'],
  revision: 'release-sha'
};
const json = (body, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'Access-Control-Allow-Origin': 'https://wallet.example',
      Vary: 'Origin'
    }
  });
const result = network => ({ network, version: 20, allowed: { earn: false, swap: true } });
const fixture =
  (overrides = {}) =>
  async (url, init) => {
    const target = new URL(url);
    assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.ok(init.signal instanceof AbortSignal);
    if (target.origin === 'https://raw.githubusercontent.com') {
      const network = target.pathname.endsWith('/testnet.json') ? 'testnet' : 'devnet';
      assert.equal(target.href, `https://raw.githubusercontent.com/0xMiden/wallet-config/main/${network}.json`);
      return overrides.config?.(network) ?? json({ network, version: 20 });
    }
    if (target.pathname === '/healthz') return overrides.health?.() ?? json({ ready: true, revision: 'release-sha' });
    assert.equal(target.origin, 'https://eligibility.example');
    assert.equal(target.pathname, '/v1/eligibility');
    assert.deepEqual([...target.searchParams.keys()], ['network']);
    assert.equal(init.headers.Origin, 'https://wallet.example');
    const network = target.searchParams.get('network');
    return overrides.eligibility?.(network) ?? json(result(network));
  };

test('permits release builds only after both published network policies answer with matching decisions', async () => {
  assert.deepEqual(await checkDeployment({ ...options, fetchImpl: fixture() }), {
    endpoint,
    networks: ['testnet', 'devnet']
  });
});

test('manual builds may use the healthy deployed revision without redeploying their branch', async () => {
  assert.deepEqual(
    await checkDeployment({ ...options, networks: ['devnet'], revision: undefined, fetchImpl: fixture() }),
    {
      endpoint,
      networks: ['devnet']
    }
  );
});

for (const value of [
  '',
  'http://eligibility.example/v1/eligibility',
  'https://user:password@eligibility.example/v1/eligibility',
  'https://eligibility.example/other',
  `${endpoint}?ip=203.0.113.7`,
  `${endpoint}#fragment`
]) {
  test(`rejects an unsafe or ambiguous public endpoint: ${value}`, async () => {
    await assert.rejects(
      checkDeployment({ ...options, endpoint: value, fetchImpl: async () => assert.fail('invalid URL fetched') })
    );
  });
}

for (const invalid of [{ networks: [] }, { networks: ['mainnet'] }, { origins: [] }, { origins: ['*'] }]) {
  test(`refuses an unusable deployment probe input: ${JSON.stringify(invalid)}`, async () => {
    await assert.rejects(
      checkDeployment({ ...options, ...invalid, fetchImpl: async () => assert.fail('invalid probe fetched') })
    );
  });
}

for (const [label, health] of [
  ['missing readiness', () => json({ ready: false, revision: 'release-sha' })],
  ['failed health status', () => json({ ready: true, revision: 'release-sha' }, 503)],
  ['another deployed revision', () => json({ ready: true, revision: 'older-release' })]
]) {
  test(`stops before eligibility lookups for ${label}`, async () => {
    await assert.rejects(
      checkDeployment({ ...options, fetchImpl: fixture({ health, eligibility: () => assert.fail('health failed') }) })
    );
  });
}

for (const [label, eligibility] of [
  ['failed API status', network => json(result(network), 503)],
  ['wrong network', () => json(result('other'))],
  ['stale policy version', network => json({ ...result(network), version: 19 })],
  ['non-boolean decision', network => json({ ...result(network), allowed: { earn: 'yes', swap: true } })],
  ['missing decision', network => json({ ...result(network), allowed: { earn: true } })],
  ['raw location disclosure', network => json({ ...result(network), country: 'US' })],
  [
    'nested location disclosure',
    network => json({ ...result(network), allowed: { earn: true, swap: true, country: 'US' } })
  ],
  [
    'cacheable decisions',
    network =>
      Response.json(result(network), {
        headers: {
          'Access-Control-Allow-Origin': 'https://wallet.example',
          Vary: 'Origin'
        }
      })
  ],
  ['missing browser CORS', network => Response.json(result(network), { headers: { 'Cache-Control': 'no-store' } })],
  [
    'wrong browser CORS',
    network =>
      Response.json(result(network), {
        headers: {
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': 'https://other.example',
          Vary: 'Origin'
        }
      })
  ],
  [
    'CORS without per-origin variation',
    network =>
      Response.json(result(network), {
        headers: {
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': 'https://wallet.example'
        }
      })
  ]
]) {
  test(`blocks wallet publication for ${label}`, async () => {
    await assert.rejects(checkDeployment({ ...options, fetchImpl: fixture({ eligibility }) }));
  });
}

for (const config of [
  network => json({ network, version: 20 }, 503),
  network => json({ network, version: '20' }),
  () => json({ network: 'other', version: 20 })
]) {
  test('requires a current valid published policy before accepting service decisions', async () => {
    await assert.rejects(checkDeployment({ ...options, fetchImpl: fixture({ config }) }));
  });
}

import assert from 'node:assert/strict';
import test from 'node:test';

import { checkDeployment } from './check-deployment.mjs';
import { waitUntilReady } from './run-staging-topology-workerd.mjs';

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
const result = network => ({ network, version: 20, allowed: { wallet: true, earn: false, swap: true } });
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

const recordedProbe = ({ health } = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const target = new URL(url);
    calls.push(target.href);
    if (target.pathname === '/healthz') return health?.() ?? json({ ready: true, revision: 'release-sha' });
    if (target.pathname.endsWith('.json')) {
      const network = target.pathname.split('/').pop().slice(0, -5);
      return json({ network, version: 20 });
    }
    const response = json(result(target.searchParams.get('network')));
    response.headers.set('Access-Control-Allow-Origin', init.headers.Origin ?? 'https://wallet.example');
    return response;
  };
  return { calls, fetchImpl };
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

test('accepts a restricted wallet decision as a valid service response', async () => {
  assert.deepEqual(
    await checkDeployment({
      ...options,
      fetchImpl: fixture({
        eligibility: network => json({ ...result(network), allowed: { wallet: false, earn: false, swap: false } })
      })
    }),
    { endpoint, networks: ['testnet', 'devnet'] }
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
    const { calls, fetchImpl } = recordedProbe();
    await assert.rejects(checkDeployment({ ...options, endpoint: value, fetchImpl }), {
      message:
        value === ''
          ? 'Set a public HTTPS feature eligibility URL ending /v1/eligibility'
          : 'Feature eligibility URL must use HTTPS with no credentials, query or fragment and end /v1/eligibility'
    });
    assert.deepEqual(calls, []);
  });
}

for (const invalid of [{ networks: [] }, { networks: ['mainnet'] }, { origins: [] }, { origins: ['*'] }]) {
  test(`refuses an unusable deployment probe input: ${JSON.stringify(invalid)}`, async () => {
    const { calls, fetchImpl } = recordedProbe();
    await assert.rejects(checkDeployment({ ...options, ...invalid, fetchImpl }), {
      message:
        'networks' in invalid
          ? 'Choose testnet, devnet or both for the deployment check'
          : 'Configure exact wallet origins before checking the service'
    });
    assert.deepEqual(calls, []);
  });
}

for (const [label, health, message] of [
  [
    'missing readiness',
    () => json({ ready: false, revision: 'release-sha' }),
    'Deployed service is not ready at the requested release revision'
  ],
  [
    'failed health status',
    () => json({ ready: true, revision: 'release-sha' }, 503),
    'Deployment health did not return a successful JSON response'
  ],
  [
    'another deployed revision',
    () => json({ ready: true, revision: 'older-release' }),
    'Deployed service is not ready at the requested release revision'
  ]
]) {
  test(`stops before eligibility lookups for ${label}`, async () => {
    const { calls, fetchImpl } = recordedProbe({ health });
    await assert.rejects(checkDeployment({ ...options, fetchImpl }), { message });
    assert.deepEqual(calls, ['https://eligibility.example/healthz']);
  });
}

for (const [label, eligibility] of [
  ['failed API status', network => json(result(network), 503)],
  ['wrong network', () => json(result('other'))],
  ['stale policy version', network => json({ ...result(network), version: 19 })],
  [
    'non-boolean wallet decision',
    network => json({ ...result(network), allowed: { wallet: 'yes', earn: true, swap: true } })
  ],
  ['missing wallet decision', network => json({ ...result(network), allowed: { earn: true, swap: true } })],
  [
    'non-boolean earn decision',
    network => json({ ...result(network), allowed: { ...result(network).allowed, earn: 'yes' } })
  ],
  ['missing earn decision', network => json({ ...result(network), allowed: { wallet: true, swap: true } })],
  [
    'non-boolean swap decision',
    network => json({ ...result(network), allowed: { ...result(network).allowed, swap: 'yes' } })
  ],
  ['missing swap decision', network => json({ ...result(network), allowed: { wallet: true, earn: false } })],
  ['raw location disclosure', network => json({ ...result(network), country: 'US' })],
  [
    'nested location disclosure',
    network => json({ ...result(network), allowed: { ...result(network).allowed, country: 'US' } })
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

test('a connected readiness peer that never responds still hits the deadline', async () => {
  let signal;
  const fetchImpl = (_url, init) => {
    signal = init?.signal;
    return new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const outcome = await Promise.race([
    waitUntilReady({ exitCode: null, signalCode: null }, 'http://127.0.0.1:9/', { deadlineMs: 200, fetchImpl }),
    new Promise(resolve => setTimeout(() => resolve('still-pending'), 1000))
  ]);

  assert.equal(outcome instanceof Error, true);
  assert.equal(outcome.message, 'workerd did not become ready within 45 seconds');
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, true);
});

test('a ready response clears its readiness abort timer', async () => {
  let signal;
  await waitUntilReady({ exitCode: null, signalCode: null }, 'http://127.0.0.1:9/', {
    deadlineMs: 200,
    fetchImpl: (_url, init) => {
      signal = init?.signal;
      return Promise.resolve(new Response(null, { status: 403 }));
    }
  });
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(signal.aborted, false);
});

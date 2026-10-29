import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createService } from './worker.mjs';
import { resolveDeploymentSource } from '../../scripts/feature-eligibility-deploy-source.mjs';

class MemoryStorage {
  values = new Map();
  queue = Promise.resolve();
  writes = 0;

  async get(key) {
    return structuredClone(this.values.get(key));
  }

  async put(key, value) {
    this.writes += 1;
    this.values.set(key, structuredClone(value));
  }

  async delete(keys) {
    this.writes += 1;
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }

  async list({ prefix = '', startAfter = '', limit = 128 } = {}) {
    return new Map(
      [...this.values]
        .filter(([key]) => key.startsWith(prefix) && key > startAfter)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit)
    );
  }

  async setAlarm(value) {
    this.writes += 1;
    this.alarm = value;
  }

  async getAlarm() {
    return this.alarm ?? null;
  }

  transaction(callback) {
    const result = this.queue.then(() => callback(this));
    this.queue = result.catch(() => {});
    return result;
  }
}

const policy = (overrides = {}) => ({
  network: 'testnet',
  version: 13,
  features: { earn: true },
  swap: { etaUrl: 'https://solver.example' },
  geo: { wallet: {}, earn: { 'block NY state': 'yes', 'block UK': 'yes' } },
  ...overrides
});

const oneClick = {
  serviceUrl: 'https://one-click.example/api',
  midenAssets: [{ assetId: 'miden:usdc', faucetId: `0x${'ab'.repeat(15)}`, decimals: 6 }]
};

const walletRules = {
  'block CU': 'yes',
  'block IR': 'yes',
  'block KP': 'yes',
  'block RU': 'yes',
  'block BY': 'yes',
  'block UA-43': 'yes',
  'block UA-40': 'yes',
  'block UA-14': 'yes',
  'block UA-09': 'yes',
  'block UA-65': 'yes',
  'block UA-23': 'yes'
};

function harness(options = {}) {
  const storage = new MemoryStorage();
  const calls = [];
  const globalTargets = [];
  const callerStates = new Map();
  const rateEvents = [];
  const callerRate = new Map();
  const coloRate = new Map();
  let clock = Date.UTC(2026, 9, 20, 12);
  let currentPolicy = options.policy ?? policy();
  const env = {
    ALLOWED_ORIGINS: '["https://wallet.example","null"]',
    MAXMIND_ACCOUNT_ID: 'example-account',
    MAXMIND_LICENSE_KEY: 'example-license',
    CALLER_HASH_SECRET: 'example-private-hash-secret-at-least-32-characters',
    MAXMIND_DAILY_QUERY_LIMIT: '100',
    CALLER_REQUESTS_PER_MINUTE: '60',
    ...options.env
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://raw.githubusercontent.com/0xMiden/wallet-config/main/')) {
      return options.policyResponse ? options.policyResponse(init, url) : Response.json(currentPolicy);
    }
    if (options.lookupResponse) return options.lookupResponse(init);
    return Response.json(options.place ?? { country: { iso_code: 'US' }, subdivisions: [{ iso_code: 'CA' }] });
  };
  const service = createService({ fetchImpl, now: () => clock, timeoutMs: options.timeoutMs ?? 30 });
  let guard = new service.EligibilityGuard({ storage }, env);
  env.ELIGIBILITY_GUARD = {
    idFromName: name => name,
    get: name => {
      globalTargets.push(name);
      return {
        fetch: request =>
          options.globalFetch ? options.globalFetch(request, value => guard.fetch(value)) : guard.fetch(request)
      };
    }
  };
  env.CALLER_GUARD = {
    idFromName: name => name,
    get: name => {
      rateEvents.push({ binding: 'durable_object', key: name });
      let entry = callerStates.get(name);
      if (!entry) {
        entry = { storage: new MemoryStorage() };
        callerStates.set(name, entry);
      }
      entry.guard ??= new service.CallerEligibilityGuard({ storage: entry.storage }, env);
      return { fetch: request => entry.guard.fetch(request) };
    }
  };
  env.CALLER_RATE_LIMIT = {
    limit: async ({ key }) => {
      rateEvents.push({ binding: 'caller', key });
      const entry = callerRate.get(key) ?? { count: 0, window: clock };
      if (clock - entry.window >= 60_000) { entry.count = 0; entry.window = clock; }
      const success = entry.count < Number(env.CALLER_REQUESTS_PER_MINUTE);
      if (success) entry.count += 1;
      callerRate.set(key, entry);
      return { success };
    }
  };
  env.COLO_RATE_LIMIT = {
    limit: async ({ key }) => {
      rateEvents.push({ binding: 'colo', key });
      const entry = coloRate.get(key) ?? { count: 0, window: clock };
      if (clock - entry.window >= 10_000) { entry.count = 0; entry.window = clock; }
      const success = entry.count < (options.coloLimit ?? 5000);
      if (success) entry.count += 1;
      coloRate.set(key, entry);
      return { success };
    }
  };
  const request = async ({
    path = '/v1/eligibility',
    query = 'network=testnet',
    method = 'GET',
    headers = {},
    cf = { colo: 'ZRH' }
  } = {}) => {
    const incoming = new Request(`https://eligibility.example${path}?${query}`, {
      method,
      headers: { 'CF-Connecting-IP': '203.0.113.7', Origin: 'https://wallet.example', ...headers }
    });
    Object.defineProperty(incoming, 'cf', { value: cf });
    return service.fetch(incoming, env);
  };
  return {
    request,
    calls,
    env,
    globalTargets,
    rateEvents,
    callerStates,
    storage,
    guard,
    restart: () => {
      guard = new service.EligibilityGuard({ storage }, env);
      for (const entry of callerStates.values()) delete entry.guard;
    },
    advance: ms => (clock += ms),
    setPolicy: value => (currentPolicy = value),
    paidCalls: () => calls.filter(call => call.url.startsWith('https://geoip.maxmind.com/'))
  };
}

test('returns only decisions and accepted policy version, using the edge caller rather than forwarded IP input', async () => {
  const h = harness();
  const response = await h.request({ headers: { 'X-Forwarded-For': '198.51.100.8', 'X-Real-IP': '198.51.100.9' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    network: 'testnet',
    version: 13,
    allowed: { wallet: true, earn: true, swap: true }
  });
  assert.equal(h.paidCalls()[0].url, 'https://geoip.maxmind.com/geoip/v2.1/city/203.0.113.7');
  assert.equal(h.paidCalls()[0].init.headers.Authorization, `Basic ${btoa('example-account:example-license')}`);
  assert.equal(h.paidCalls()[0].init.redirect, 'manual');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://wallet.example');
  assert.equal(response.headers.get('Vary'), 'Origin');
  assert.ok(!JSON.stringify([...h.storage.values]).includes('203.0.113.7'));
  assert.ok(!JSON.stringify([...h.storage.values]).includes('country'));
  for (const entry of h.callerStates.values()) {
    assert.ok(!JSON.stringify([...entry.storage.values]).includes('203.0.113.7'));
    assert.ok(!JSON.stringify([...entry.storage.values]).includes('country'));
  }
});

test('applies caller and colo rate bindings before routing to the caller object', async () => {
  const h = harness();
  const response = await h.request();
  assert.equal(response.status, 200);
  assert.deepEqual(h.rateEvents.map(event => event.binding), ['caller', 'colo', 'durable_object']);
  assert.match(h.rateEvents[0].key, /^[a-f0-9]{64}$/);
  assert.equal(h.rateEvents[1].key, 'colo:ZRH');
  assert.equal(h.rateEvents[2].key, 'cache:ZRH');
});

test('rate refusals never contact a durable object', async () => {
  const caller = harness();
  caller.env.CALLER_RATE_LIMIT.limit = async () => ({ success: false });
  let response = await caller.request();
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'rate_limited' });
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal(caller.callerStates.size, 0);

  const colo = harness();
  colo.env.COLO_RATE_LIMIT.limit = async () => ({ success: false });
  response = await colo.request();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '10');
  assert.equal(colo.callerStates.size, 0);
});

test('validation and origin failures have distinct private bodies', async () => {
  const h = harness();
  const badRequest = await h.request({ query: 'network=invalid' });
  assert.equal(badRequest.status, 400);
  assert.deepEqual(await badRequest.json(), { error: 'bad_request' });
  const forbidden = await h.request({ headers: { Origin: 'https://other.example' } });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: 'forbidden' });
  assert.equal(h.callerStates.size, 0);
});

test('overloaded caller objects fail closed without retrying', async () => {
  const h = harness();
  let attempts = 0;
  h.env.CALLER_GUARD.get = () => ({ fetch: () => { attempts += 1; throw Object.assign(new Error('overloaded'), { overloaded: true }); } });
  const response = await h.request();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'overloaded' });
  assert.equal(response.headers.get('Retry-After'), '30');
  assert.equal(attempts, 1);
});

test('an overloaded budget object returns the overload class without a paid lookup', async () => {
  const h = harness();
  let attempts = 0;
  h.storage.transaction = async () => {
    attempts += 1;
    throw Object.assign(new Error('overloaded'), { overloaded: true });
  };
  const response = await h.request();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'overloaded' });
  assert.equal(response.headers.get('Retry-After'), '30');
  assert.equal(attempts, 1);
  assert.deepEqual(h.globalTargets, ['global-v1']);
  assert.equal(h.rateEvents.filter(event => event.binding === 'durable_object').length, 1);
  assert.equal(h.paidCalls().length, 0);
  assert.equal(h.storage.values.get('budget'), undefined);
  assert.equal([...h.storage.values.keys()].some(key => key.startsWith('lease:')), false);
});

test('a generic budget storage failure stays eligibility_unavailable', async () => {
  const h = harness();
  h.storage.transaction = async () => { throw new Error('budget down'); };
  const response = await h.request();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'eligibility_unavailable' });
  assert.equal(response.headers.get('Retry-After'), null);
  assert.equal(h.paidCalls().length, 0);
  assert.equal(h.globalTargets.length, 1);
});

test('an inexact internal overload response stays generic and private', async () => {
  const h = harness({
    globalFetch: async () => Response.json(
      { error: 'overloaded', detail: 'secret' },
      { status: 503, headers: { 'Retry-After': '30' } }
    )
  });
  const response = await h.request();
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.deepEqual(body, { error: 'eligibility_unavailable' });
  assert.equal(response.headers.get('Retry-After'), null);
  assert.doesNotMatch(JSON.stringify(body), /secret/);
  assert.equal(h.paidCalls().length, 0);
});

test('an external overload-shaped response stays generic and private', async () => {
  for (const source of ['policyResponse', 'lookupResponse']) {
    const h = harness({
      [source]: async () => Response.json(
        { error: 'overloaded', detail: `secret-${source}` },
        { status: 503, headers: { 'Retry-After': '30' } }
      )
    });
    const response = await h.request();
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.deepEqual(body, { error: 'eligibility_unavailable' });
    assert.equal(response.headers.get('Retry-After'), null);
    assert.doesNotMatch(JSON.stringify(body), /secret/);
    assert.equal(h.paidCalls().length, source === 'policyResponse' ? 0 : 1);
    assert.equal(h.globalTargets.length, source === 'policyResponse' ? 0 : 1);
  }
});

test('one retryable caller object error gets a fresh stub and one bounded retry', async () => {
  const h = harness({ timeoutMs: 100 });
  let stubs = 0;
  const originalGet = h.env.CALLER_GUARD.get;
  h.env.CALLER_GUARD.get = name => {
    stubs += 1;
    if (stubs === 1) return { fetch: () => { throw Object.assign(new Error('reset'), { retryable: true }); } };
    return originalGet(name);
  };
  assert.equal((await h.request()).status, 200);
  assert.equal(stubs, 2);
  assert.equal(h.paidCalls().length, 1);
});

test('a warm decision makes no durable writes', async () => {
  const h = harness();
  assert.equal((await h.request()).status, 200);
  const entry = [...h.callerStates.values()][0];
  const callerWrites = entry.storage.writes;
  const budgetWrites = h.storage.writes;
  assert.equal((await h.request()).status, 200);
  assert.equal(entry.storage.writes, callerWrites);
  assert.equal(h.storage.writes, budgetWrites);
});

test('two colo caches share only the global lease budget under a bounded mock burst', async () => {
  const h = harness({ timeoutMs: 1000 });
  const requests = Array.from({ length: 16 }, (_, index) => ({
    cf: { colo: index % 2 ? 'ZRH' : 'FRA' },
    headers: { 'CF-Connecting-IP': `203.0.113.${index + 1}` }
  }));
  const cold = await Promise.all(requests.map(options => h.request(options)));
  assert.ok(cold.every(response => response.status === 200));
  assert.deepEqual([...h.callerStates.keys()].sort(), ['cache:FRA', 'cache:ZRH']);
  assert.equal(h.paidCalls().length, 16);
  assert.equal(h.storage.values.get('budget').count, 16);
  const before = [...h.callerStates.values()].map(entry => entry.storage.writes);
  const warm = await Promise.all(requests.map(options => h.request(options)));
  assert.ok(warm.every(response => response.status === 200));
  assert.equal(h.paidCalls().length, 16);
  assert.deepEqual([...h.callerStates.values()].map(entry => entry.storage.writes), before);
});

test('enables swap for explicitly enabled Near Intents with a usable 1Click mapping', async () => {
  const h = harness({
    policy: policy({ features: { earn: false, nearIntents: true }, swap: { oneClick } })
  });
  const response = await h.request();
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).allowed, { wallet: true, earn: false, swap: true });
  assert.equal(h.paidCalls().length, 0);
});

for (const [name, features, swap] of [
  ['missing switch', { earn: false }, { oneClick }],
  ['disabled switch', { earn: false, nearIntents: false }, { oneClick }],
  ['missing 1Click config', { earn: false, nearIntents: true }, {}],
  ['missing asset mappings', { earn: false, nearIntents: true }, { oneClick: { ...oneClick, midenAssets: [] } }],
  [
    'invalid service URL',
    { earn: false, nearIntents: true },
    { oneClick: { ...oneClick, serviceUrl: 'http://one-click.example' } }
  ],
  [
    'invalid asset mapping',
    { earn: false, nearIntents: true },
    { oneClick: { ...oneClick, midenAssets: [{ assetId: 'miden:usdc', faucetId: 'bad', decimals: 6 }] } }
  ],
  [
    'invalid additional mapping',
    { earn: false, nearIntents: true },
    {
      oneClick: {
        ...oneClick,
        midenAssets: [...oneClick.midenAssets, { assetId: 'miden:bad', faucetId: 'bad', decimals: 6 }]
      }
    }
  ],
  [
    'duplicate asset mappings',
    { earn: false, nearIntents: true },
    {
      oneClick: {
        ...oneClick,
        midenAssets: [...oneClick.midenAssets, { ...oneClick.midenAssets[0], faucetId: `0x${'cd'.repeat(15)}` }]
      }
    }
  ],
  [
    'duplicate faucet mappings',
    { earn: false, nearIntents: true },
    {
      oneClick: {
        ...oneClick,
        midenAssets: [...oneClick.midenAssets, { ...oneClick.midenAssets[0], assetId: 'miden:other' }]
      }
    }
  ]
]) {
  test(`does not enable Near Intents for ${name}`, async () => {
    const response = await harness({ policy: policy({ features, swap }) }).request();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).allowed.swap, false);
  });
}

test('rejects a nonboolean Near Intents switch', async () => {
  const response = await harness({
    policy: policy({ features: { earn: false, nearIntents: 'true' }, swap: { oneClick } })
  }).request();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'eligibility_unavailable' });
});

test('applies swap geo restrictions to OneClick-enabled Near Intents', async () => {
  const h = harness({
    policy: policy({
      features: { earn: false, nearIntents: true },
      swap: { oneClick },
      geo: { wallet: {}, swap: { 'block US-CA': 'yes' } }
    }),
    place: { country: { iso_code: 'US' }, subdivisions: [{ iso_code: 'CA' }] }
  });
  const response = await h.request();
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).allowed, { wallet: true, earn: false, swap: false });
  assert.equal(h.paidCalls().length, 1);
});

for (const [name, place, allowed] of [
  [
    'New York',
    { country: { iso_code: 'US' }, subdivisions: [{ iso_code: 'NY' }] },
    { wallet: true, earn: false, swap: true }
  ],
  ['United Kingdom', { country: { iso_code: 'GB' } }, { wallet: true, earn: false, swap: true }],
  ['US without state', { country: { iso_code: 'US' } }, { wallet: true, earn: false, swap: true }],
  ['Germany', { country: { iso_code: 'DE' } }, { wallet: true, earn: true, swap: true }]
]) {
  test(`applies Earn rules for ${name} without gating unrelated Swap operations`, async () => {
    const response = await harness({ place }).request();
    assert.deepEqual((await response.json()).allowed, allowed);
  });
}

test('evaluates independent Swap and ISO subdivision rules with one paid query', async () => {
  const h = harness({
    policy: policy({ geo: { wallet: {}, earn: { 'block US-NY': 'yes' }, swap: { 'block US-CA': 'yes' } } })
  });
  assert.deepEqual((await (await h.request()).json()).allowed, { wallet: true, earn: true, swap: false });
  assert.equal(h.paidCalls().length, 1);
});

for (const [name, country, region] of [
  ['Cuba', 'CU'],
  ['Iran', 'IR'],
  ['North Korea', 'KP'],
  ['Russia', 'RU'],
  ['Belarus', 'BY'],
  ['Crimea', 'UA', '43'],
  ['Sevastopol', 'UA', '40'],
  ['Donetsk oblast', 'UA', '14'],
  ['Luhansk oblast', 'UA', '09'],
  ['Kherson oblast', 'UA', '65'],
  ['Zaporizhzhia oblast', 'UA', '23']
]) {
  test(`wallet policy denies all access in ${name}, overriding independent feature permissions`, async () => {
    const h = harness({
      policy: policy({ geo: { wallet: walletRules } }),
      place: { country: { iso_code: country }, ...(region ? { subdivisions: [{ iso_code: region }] } : {}) }
    });
    const response = await h.request();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      network: 'testnet',
      version: 13,
      allowed: { wallet: false, earn: false, swap: false }
    });
    assert.equal(h.paidCalls().length, 1);
  });
}

for (const [name, place, wallet] of [
  ['Kyiv city', { country: { iso_code: 'UA' }, subdivisions: [{ iso_code: '30' }] }, true],
  ['missing Ukrainian subdivision', { country: { iso_code: 'UA' } }, false],
  ['invalid Ukrainian subdivision', { country: { iso_code: 'UA' }, subdivisions: [{ iso_code: 'unknown' }] }, false],
  ['Germany', { country: { iso_code: 'DE' } }, true]
]) {
  test(`wallet restrictions still require a lookup for ${name} while both products are disabled`, async () => {
    const h = harness({
      policy: policy({ features: { earn: false }, swap: {}, geo: { wallet: walletRules } }),
      place
    });
    const response = await h.request();
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).allowed, { wallet, earn: false, swap: false });
    assert.equal(h.paidCalls().length, 1);
  });
}

test('an exhausted lookup budget cannot open the wallet merely because products are disabled', async () => {
  const h = harness({
    policy: policy({ features: { earn: false }, swap: {}, geo: { wallet: walletRules } }),
    env: { MAXMIND_DAILY_QUERY_LIMIT: '0' }
  });
  const response = await h.request();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'eligibility_unavailable' });
  assert.equal(h.paidCalls().length, 0);
});

for (const [name, document] of [
  ['explicit empty wallet policy', policy({ geo: { wallet: {} } })],
  [
    'disabled-only rules',
    policy({ geo: { wallet: { 'block CU': 'no' }, earn: { 'block NY state': 'no', 'block UK': 'no' } } })
  ],
  ['globally disabled Earn', policy({ features: { earn: false } })]
]) {
  test(`${name} needs no MaxMind credential or paid lookup`, async () => {
    const h = harness({ policy: document, env: { MAXMIND_ACCOUNT_ID: '', MAXMIND_LICENSE_KEY: '' } });
    const response = await h.request();
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).allowed, { wallet: true, earn: document.features.earn, swap: true });
    assert.equal(h.paidCalls().length, 0);
  });
}

for (const [name, request] of [
  ['arbitrary IP query', { query: 'network=testnet&ip=198.51.100.4' }],
  ['unsupported network', { query: 'network=localhost' }],
  ['prototype network name', { query: 'network=constructor' }],
  ['prototype pollution network name', { query: 'network=__proto__' }],
  ['duplicate network', { query: 'network=testnet&network=mainnet' }],
  ['missing edge metadata', { cf: null }],
  ['Worker subrequest', { headers: { 'CF-Worker': 'another.example' } }],
  ['missing caller address', { headers: { 'CF-Connecting-IP': '' } }],
  ['address path injection', { headers: { 'CF-Connecting-IP': '203.0.113.7/another' } }],
  ['malformed IPv4', { headers: { 'CF-Connecting-IP': '999.0.0.1' } }],
  ['noncanonical IPv4', { headers: { 'CF-Connecting-IP': '001.0.0.1' } }],
  ['malformed IPv6', { headers: { 'CF-Connecting-IP': '2001:::7' } }],
  ['unknown route', { path: '/v1/lookup' }],
  ['unapproved browser origin', { headers: { Origin: 'https://other.example' } }],
  ['non-GET method', { method: 'POST' }]
]) {
  test(`rejects ${name} before contacting upstream services`, async () => {
    const h = harness();
    const response = await h.request(request);
    assert.ok(response.status >= 400);
    assert.equal(h.calls.length, 0);
  });
}

test('accepts a trusted IPv6 edge address and null native origin', async () => {
  const h = harness();
  assert.equal((await h.request({ headers: { 'CF-Connecting-IP': '2001:db8::7', Origin: 'null' } })).status, 200);
  assert.equal(h.paidCalls()[0].url, 'https://geoip.maxmind.com/geoip/v2.1/city/2001%3Adb8%3A%3A7');
});

test('handles CORS preflight without performing any lookup', async () => {
  const h = harness();
  const response = await h.request({ method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET' } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET');
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal(h.calls.length, 0);
});

test('unknown prototype-like feature names cannot create eligibility rules', async () => {
  const h = harness({
    policy: policy({ geo: JSON.parse('{"wallet":{},"__proto__":{"block UK":"yes"},"constructor":{"block US":"yes"}}') })
  });
  const response = await h.request();
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).allowed, { wallet: true, earn: true, swap: true });
  assert.equal(h.paidCalls().length, 0);
});

test('disabled products skip paid lookups only when the explicit wallet policy has no enabled rules', async () => {
  const h = harness({
    policy: policy({
      features: { earn: false },
      swap: {},
      geo: { wallet: {}, earn: { 'block UK': 'yes' }, swap: { 'block US': 'yes' } }
    })
  });
  const response = await h.request();
  assert.deepEqual((await response.json()).allowed, { wallet: true, earn: false, swap: false });
  assert.equal(h.paidCalls().length, 0);
});

test('health readiness verifies configuration and release revision without paid queries', async () => {
  const h = harness({ env: { DEPLOYMENT_REVISION: 'a'.repeat(40) } });
  const response = await h.request({ path: '/healthz', query: '' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ready: true, revision: 'a'.repeat(40) });
  assert.equal(h.calls.length, 0);
  assert.equal((await harness({ env: { MAXMIND_DAILY_QUERY_LIMIT: '0' } }).request({ path: '/healthz' })).status, 503);
});

for (const [name, options] of [
  ['policy HTTP failure', { policyResponse: () => new Response('private error', { status: 502 }) }],
  ['wrong network', { policy: policy({ network: 'mainnet' }) }],
  ['missing version', { policy: policy({ version: undefined }) }],
  ['absent geo policy', { policy: policy({ geo: undefined }) }],
  ['missing wallet policy', { policy: policy({ geo: { earn: { 'block UK': 'yes' } } }) }],
  ['invalid wallet policy', { policy: policy({ geo: { wallet: [] } }) }],
  ['unknown global rule', { policy: policy({ geo: { wallet: { 'unknown location': 'yes' } } }) }],
  ['invalid rule', { policy: policy({ geo: { wallet: {}, earn: { 'block NY state': true } } }) }],
  ['invalid feature shape', { policy: policy({ features: 'true' }) }],
  ['invalid feature switch', { policy: policy({ features: { earn: 'true' } }) }],
  ['invalid Swap URL', { policy: policy({ swap: { etaUrl: 'http://solver.example' } }) }],
  ['invalid geo shape', { policy: policy({ geo: [] }) }],
  ['invalid feature rules', { policy: policy({ geo: { wallet: {}, earn: [] } }) }],
  ['unknown enabled phrase', { policy: policy({ geo: { wallet: {}, earn: { 'unknown location': 'yes' } } }) }],
  ['missing MaxMind credential', { env: { MAXMIND_LICENSE_KEY: '' } }],
  ['missing daily budget', { env: { MAXMIND_DAILY_QUERY_LIMIT: undefined } }],
  ['invalid daily budget', { env: { MAXMIND_DAILY_QUERY_LIMIT: '-1' } }],
  ['missing caller hash secret', { env: { CALLER_HASH_SECRET: '' } }],
  ['lookup HTTP failure', { lookupResponse: () => new Response('private error', { status: 401 }) }],
  [
    'lookup redirect',
    { lookupResponse: () => new Response(null, { status: 302, headers: { Location: 'https://other.example' } }) }
  ],
  ['malformed lookup body', { place: { country: { iso_code: 'not-a-country' }, private: 'private detail' } }],
  ['oversized lookup body', { lookupResponse: () => new Response('x'.repeat(70_000)) }]
]) {
  test(`fails closed with no private detail on ${name}`, async () => {
    const h = harness(options);
    const response = await h.request();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'eligibility_unavailable' });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://wallet.example');
    assert.ok(h.paidCalls().length <= 1);
  });
}

test('applies the deadline while reading a stalled upstream body', async () => {
  const h = harness({
    timeoutMs: 5,
    lookupResponse: () => new Response(new ReadableStream({ start() {} }))
  });
  assert.equal((await h.request()).status, 503);
  assert.equal(h.paidCalls().length, 1);
});

test('applies the deadline before upstream response headers arrive', async () => {
  const h = harness({ timeoutMs: 5, policyResponse: () => new Promise(() => {}) });
  assert.equal((await h.request()).status, 503);
  assert.equal(h.paidCalls().length, 0);
});

test('a policy fetch failure after expiry cannot fall back to an old cached allow decision', async () => {
  let unavailable = false;
  const h = harness({
    policyResponse: () => (unavailable ? new Response('', { status: 502 }) : Response.json(policy()))
  });
  assert.equal((await h.request()).status, 200);
  h.advance(60_001);
  unavailable = true;
  assert.equal((await h.request()).status, 503);
  assert.equal(h.paidCalls().length, 1);
});

test('failed paid lookups still consume budget and are never automatically retried', async () => {
  const h = harness({
    env: { MAXMIND_DAILY_QUERY_LIMIT: '1' },
    lookupResponse: () => new Response('', { status: 502 })
  });
  assert.equal((await h.request()).status, 503);
  assert.equal((await h.request({ headers: { 'CF-Connecting-IP': '203.0.113.8' } })).status, 503);
  assert.equal(h.paidCalls().length, 1);
});

test('deduplicates concurrent lookups and caches only decisions until expiry', async () => {
  const h = harness();
  const responses = await Promise.all([h.request(), h.request(), h.request()]);
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(h.paidCalls().length, 1);
  h.advance(300_001);
  assert.equal((await h.request()).status, 200);
  assert.equal(h.paidCalls().length, 2);
});

test('a new authoritative policy version invalidates a cached decision', async () => {
  const h = harness();
  await h.request();
  h.advance(60_001);
  h.setPolicy(policy({ version: 14, geo: { wallet: {}, earn: { 'block US': 'yes' } } }));
  const response = await h.request();
  assert.deepEqual(await response.json(), {
    network: 'testnet',
    version: 14,
    allowed: { wallet: true, earn: false, swap: true }
  });
  assert.equal(h.paidCalls().length, 2);
});

test('a changed global policy invalidates a cached wallet allow before its five-minute decision expiry', async () => {
  const h = harness();
  await h.request();
  h.advance(60_001);
  h.setPolicy(policy({ version: 14, geo: { wallet: { 'block US': 'yes' } } }));
  const response = await h.request();
  assert.deepEqual(await response.json(), {
    network: 'testnet',
    version: 14,
    allowed: { wallet: false, earn: false, swap: false }
  });
  assert.equal(h.paidCalls().length, 2);
});

test('old two-decision cache entries cannot authorize wallet access even with a matching policy identity', async () => {
  const h = harness();
  await h.request();
  const callerStorage = [...h.callerStates.values()][0].storage;
  const callerKey = [...callerStorage.values.keys()].find(key => key.startsWith('caller:'));
  const caller = callerStorage.values.get(callerKey);
  caller.cache.testnet.allowed = { earn: true, swap: true };
  callerStorage.values.set(callerKey, caller);
  const response = await h.request();
  assert.deepEqual((await response.json()).allowed, { wallet: true, earn: true, swap: true });
  assert.equal(h.paidCalls().length, 2);
});

test('enforces the shared persisted paid-query budget across callers and object restarts', async () => {
  const h = harness({ env: { MAXMIND_DAILY_QUERY_LIMIT: '1' } });
  const responses = await Promise.all([
    h.request(),
    h.request({ headers: { 'CF-Connecting-IP': '203.0.113.8' } }),
    h.request({ headers: { 'CF-Connecting-IP': '203.0.113.9' } })
  ]);
  assert.equal(responses.filter(response => response.status === 200).length, 1);
  assert.equal(h.paidCalls().length, 1);
  h.restart();
  assert.equal((await h.request({ headers: { 'CF-Connecting-IP': '203.0.113.10' } })).status, 503);
  assert.equal(h.paidCalls().length, 1);
  h.advance(24 * 60 * 60 * 1000);
  assert.equal((await h.request()).status, 200);
  assert.equal(h.paidCalls().length, 2);
});

test('zero query budget never contacts MaxMind', async () => {
  const h = harness({ env: { MAXMIND_DAILY_QUERY_LIMIT: '0' } });
  assert.equal((await h.request()).status, 503);
  assert.equal(h.paidCalls().length, 0);
});

test('global-v1 grants bounded idempotent leases alongside the old single reserve API', async () => {
  const h = harness({ env: { MAXMIND_DAILY_QUERY_LIMIT: '6' } });
  const payload = { day: '2026-10-20', deadline: Date.UTC(2026, 9, 20, 12) + 30, leaseId: '00000000-0000-4000-8000-000000000001', count: 4 };
  const lease = () => h.guard.fetch(new Request('https://eligibility.internal/lease', { method: 'POST', body: JSON.stringify(payload) }));
  assert.deepEqual(await (await lease()).json(), { reserved: true, count: 4 });
  h.env.MAXMIND_DAILY_QUERY_LIMIT = '2';
  assert.deepEqual(await (await lease()).json(), { reserved: true, count: 4 });
  assert.equal(h.storage.values.get('budget').count, 4);
  h.env.MAXMIND_DAILY_QUERY_LIMIT = '6';
  const reserve = await h.guard.fetch(new Request('https://eligibility.internal/reserve', { method: 'POST', body: JSON.stringify({ day: payload.day, deadline: payload.deadline }) }));
  assert.deepEqual(await reserve.json(), { reserved: true });
  assert.equal(h.storage.values.get('budget').count, 5);
  payload.leaseId = '00000000-0000-4000-8000-000000000002';
  assert.deepEqual(await (await lease()).json(), { reserved: true, count: 1 });
  assert.equal(h.storage.values.get('budget').count, 6);
});

test('enforces the per-caller edge limit even when decisions are cached', async () => {
  const h = harness({ env: { CALLER_REQUESTS_PER_MINUTE: '2' } });
  assert.equal((await h.request()).status, 200);
  assert.equal((await h.request()).status, 200);
  const response = await h.request();
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'rate_limited' });
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal(h.paidCalls().length, 1);
  h.restart();
  assert.equal((await h.request()).status, 429);
  h.advance(60_001);
  assert.equal((await h.request()).status, 200);
});

test('cleanup drops expired caller records while preserving the paid-query counter', async () => {
  const h = harness();
  await h.request();
  h.advance(300_001);
  const entry = [...h.callerStates.values()][0];
  entry.storage.alarm = null;
  await entry.guard.alarm();
  assert.equal([...entry.storage.values.keys()].filter(key => key.startsWith('caller:')).length, 0);
  assert.equal(await entry.storage.getAlarm(), null);
  assert.equal(h.storage.values.get('budget').count, 4);
});

test('cleanup traverses multiple bounded pages without deleting active callers', async () => {
  const h = harness();
  await h.request();
  const entry = [...h.callerStates.values()][0];
  entry.storage.values.clear();
  for (let i = 0; i < 130; i += 1) entry.storage.values.set(`caller:${String(i).padStart(3, '0')}`, { expires: 0 });
  entry.storage.values.set('caller:zzz', { expires: Number.MAX_SAFE_INTEGER });
  await entry.guard.alarm();
  assert.equal(entry.storage.values.get('cleanup-cursor'), 'caller:127');
  await entry.guard.alarm();
  assert.deepEqual([...entry.storage.values.keys()], ['caller:zzz']);
});

test('manual main deployment selects only the workflow SHA and rejects untrusted refs', async () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(
    resolveDeploymentSource({
      eventName: 'workflow_dispatch',
      ref: 'refs/heads/main',
      source: 'main',
      sha
    }),
    { mode: 'main', ref: sha, message: `Wallet eligibility main ${sha}` }
  );

  for (const input of [
    { eventName: 'workflow_dispatch', ref: 'refs/heads/feature', sha },
    { eventName: 'push', ref: 'refs/heads/main', sha },
    { eventName: 'workflow_call', ref: 'refs/tags/v1.2.3', sha },
    { eventName: 'workflow_dispatch', ref: 'refs/heads/main', sha, releaseTag: 'v1.2.3' }
  ]) {
    assert.throws(() => resolveDeploymentSource({ ...input, source: 'main' }));
  }
});

test('published release tag selection accepts output-safe tags and rejects unsafe output', async () => {
  assert.deepEqual(
    resolveDeploymentSource({
      eventName: 'workflow_call',
      ref: 'refs/tags/v1.2.3',
      releaseTag: 'v1.2.3'
    }),
    { mode: 'published-release', ref: 'refs/tags/v1.2.3', message: 'Wallet release v1.2.3' }
  );
  for (const releaseTag of [
    '',
    'v1.2.3\rDEPLOYMENT_SOURCE=main',
    'v1.2.3\nDEPLOYMENT_SOURCE=main',
    'x'.repeat(256),
    undefined,
    123
  ]) {
    assert.throws(() => resolveDeploymentSource({ eventName: 'workflow_dispatch', releaseTag }));
  }
  for (const releaseTag of ['v1[unsafe]', 'release with spaces', 'x'.repeat(255)]) {
    assert.deepEqual(resolveDeploymentSource({ eventName: 'workflow_dispatch', releaseTag }), {
      mode: 'published-release',
      ref: `refs/tags/${releaseTag}`,
      message: `Wallet release ${releaseTag}`
    });
  }

  const workflow = readFileSync(
    new URL('../../.github/workflows/deploy-feature-eligibility.yml', import.meta.url),
    'utf8'
  );
  assert.match(workflow, /node scripts\/feature-eligibility-deploy-source\.mjs/);
  assert.match(workflow, /ref: \$\{\{ steps\.source\.outputs\.ref \}\}/);
  assert.match(workflow, /if: steps\.source\.outputs\.mode == 'published-release'/);
  assert.match(workflow, /getReleaseByTag/);
  assert.match(workflow, /release\.draft \|\| !release\.published_at/);
  assert.match(workflow, /\$GITHUB_EVENT_NAME" == release && "\$revision" != "\$GITHUB_SHA/);
});

test('reusable deployment inputs omit source while manual deployment retains its choice and release caller', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/deploy-feature-eligibility.yml', import.meta.url),
    'utf8'
  );
  const callInputs = workflow.match(/  workflow_call:\n([\s\S]*?)\n  workflow_dispatch:/)?.[1];
  const dispatchInputs = workflow.match(/  workflow_dispatch:\n([\s\S]*?)\npermissions:/)?.[1];
  assert.ok(callInputs);
  assert.doesNotMatch(callInputs, /deployment_source:/);
  assert.match(callInputs, /release_tag:\n        type: string\n        required: true/);
  assert.ok(dispatchInputs);
  assert.match(
    dispatchInputs,
    /deployment_source:\n[\s\S]*?type: choice\n[\s\S]*?options:\n          - published-release\n          - main/
  );
  assert.match(dispatchInputs, /release_tag:\n[\s\S]*?required: false/);
  const releaseWallet = readFileSync(new URL('../../.github/workflows/release-wallet.yml', import.meta.url), 'utf8');
  const eligibilityCaller = releaseWallet.match(/  eligibility:\n([\s\S]*?)\n\n  chrome:/)?.[1];
  assert.match(eligibilityCaller, /release_tag: \$\{\{ github\.event\.release\.tag_name \}\}/);
  assert.doesNotMatch(eligibilityCaller, /deployment_source:/);
});

test('deployment resolver step maps each workflow input and context value exactly', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/deploy-feature-eligibility.yml', import.meta.url),
    'utf8'
  );
  const sourceStep = workflow.match(
    /      - name: Resolve deployment source\n([\s\S]*?)\n      - name: Require a published release/
  );
  assert.ok(sourceStep);
  for (const mapping of [
    /DEPLOYMENT_SOURCE: \$\{\{ inputs\.deployment_source \|\| 'published-release' \}\}/,
    /RELEASE_TAG: \$\{\{ inputs\.release_tag \}\}/,
    /DEPLOY_EVENT_NAME: \$\{\{ github\.event_name \}\}/,
    /DEPLOY_WORKFLOW_REF: \$\{\{ github\.ref \}\}/,
    /DEPLOY_WORKFLOW_SHA: \$\{\{ github\.sha \}\}/
  ])
    assert.match(sourceStep[1], mapping);
});

test('deployment resolver CLI writes exact outputs and rejects untrusted manual inputs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eligibility-deploy-source-'));
  const outputPath = join(directory, 'github-output');
  const scriptPath = new URL('../../scripts/feature-eligibility-deploy-source.mjs', import.meta.url);
  const run = values => {
    writeFileSync(outputPath, '');
    const result = spawnSync(process.execPath, [scriptPath.pathname], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        DEPLOY_EVENT_NAME: values.eventName ?? '',
        DEPLOY_WORKFLOW_REF: values.ref ?? '',
        DEPLOYMENT_SOURCE: values.source ?? '',
        RELEASE_TAG: values.releaseTag ?? '',
        DEPLOY_WORKFLOW_SHA: values.sha ?? ''
      }
    });
    return { ...result, output: readFileSync(outputPath, 'utf8') };
  };
  try {
    const sha = 'a'.repeat(40);
    const main = run({ eventName: 'workflow_dispatch', ref: 'refs/heads/main', source: 'main', sha });
    assert.equal(main.status, 0, main.stderr);
    assert.equal(main.output, `mode=main\nref=${sha}\nmessage=Wallet eligibility main ${sha}\n`);

    const release = run({ eventName: 'workflow_call', ref: 'refs/tags/v1.2.3', releaseTag: 'v1.2.3' });
    assert.equal(release.status, 0, release.stderr);
    assert.equal(release.output, 'mode=published-release\nref=refs/tags/v1.2.3\nmessage=Wallet release v1.2.3\n');

    for (const values of [
      { eventName: 'push', ref: 'refs/heads/main', source: 'main', sha },
      { eventName: 'workflow_dispatch', ref: 'refs/heads/feature', source: 'main', sha },
      { eventName: 'workflow_dispatch', ref: 'refs/heads/main', source: 'main', sha, releaseTag: 'v1.2.3' },
      { eventName: 'workflow_dispatch', ref: 'refs/heads/main', source: 'main' },
      { eventName: 'workflow_dispatch', ref: 'refs/heads/main', source: 'main', sha: 'bad' }
    ]) {
      const rejected = run(values);
      assert.notEqual(rejected.status, 0);
      assert.equal(rejected.output, '');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('warm cache and per-caller rejection do not enter the global reservation object', async () => {
  const h = harness({ env: { CALLER_REQUESTS_PER_MINUTE: '2' } });
  assert.equal((await h.request()).status, 200);
  assert.equal((await h.request()).status, 200);
  assert.equal((await h.request()).status, 429);
  assert.deepEqual(h.globalTargets, ['global-v1']);
  assert.equal(h.callerStates.size, 1);
});

test('a queued storage transaction does not block another warm cache hit in the same colo', async () => {
  const h = harness();
  await h.request();
  await h.request({ headers: { 'CF-Connecting-IP': '203.0.113.8' } });
  assert.equal(h.callerStates.size, 1);
  const first = [...h.callerStates.values()][0];
  let release;
  const originalQueue = first.storage.queue;
  first.storage.queue = new Promise(resolve => {
    release = resolve;
  });
  try {
    const held = h.request();
    const healthy = await h.request({ headers: { 'CF-Connecting-IP': '203.0.113.8' } });
    assert.equal(healthy.status, 200);
    release();
    assert.equal((await held).status, 200);
  } finally {
    release();
    first.storage.queue = originalQueue;
  }
  assert.equal(h.globalTargets.length, 1);
});

test('all caller objects share the existing nearly exhausted persisted global budget', async () => {
  const h = harness({ env: { MAXMIND_DAILY_QUERY_LIMIT: '10000' } });
  h.storage.values.set('budget', { day: '2026-10-20', count: 9999 });
  const responses = await Promise.all(
    ['203.0.113.7', '203.0.113.8', '203.0.113.9'].map(ip => h.request({ headers: { 'CF-Connecting-IP': ip } }))
  );
  assert.equal(responses.filter(r => r.status === 200).length, 1);
  assert.equal(h.paidCalls().length, 1);
  assert.equal(h.storage.values.get('budget').count, 10000);
  h.restart();
  assert.equal((await h.request({ headers: { 'CF-Connecting-IP': '203.0.113.10' } })).status, 503);
  assert.equal(h.paidCalls().length, 1);
  assert.equal(h.callerStates.size, 1);
});

test('queued reservation expiry fails closed without starting a late paid lookup or retry', async () => {
  let h;
  h = harness({
    timeoutMs: 10,
    globalFetch: async (request, proceed) => {
      await new Promise(resolve => setTimeout(resolve, 40));
      h.advance(21);
      return proceed(request);
    }
  });
  const response = await h.request();
  assert.equal(response.status, 503);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(h.paidCalls().length, 0);
  assert.equal(h.globalTargets.length, 1);
  assert.equal(h.storage.values.get('budget'), undefined);
});

test('readiness and requests fail closed when the caller namespace binding is unavailable', async () => {
  const h = harness();
  delete h.env.CALLER_GUARD;
  assert.equal((await h.request({ path: '/healthz', query: '' })).status, 503);
  assert.equal((await h.request()).status, 503);
  assert.equal(h.globalTargets.length, 0);
  assert.equal(h.paidCalls().length, 0);
});

test('caller migration appends a class without recreating the original budget namespace', () => {
  const config = JSON.parse(readFileSync(new URL('./wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(
    config.durable_objects.bindings.find(b => b.name === 'ELIGIBILITY_GUARD'),
    { name: 'ELIGIBILITY_GUARD', class_name: 'EligibilityGuard' }
  );
  assert.deepEqual(config.migrations[0], { tag: 'v1', new_sqlite_classes: ['EligibilityGuard'] });
  assert.ok(
    config.durable_objects.bindings.some(b => b.name === 'CALLER_GUARD' && b.class_name === 'CallerEligibilityGuard')
  );
  assert.deepEqual(config.migrations.slice(1), [{ tag: 'v2', new_sqlite_classes: ['CallerEligibilityGuard'] }]);
  assert.deepEqual(config.ratelimits, [
    { name: 'CALLER_RATE_LIMIT', namespace_id: '189401', simple: { limit: 60, period: 60 } },
    { name: 'COLO_RATE_LIMIT', namespace_id: '189402', simple: { limit: 5000, period: 10 } }
  ]);
});


test('caller rate state is shared across networks and survives caller object recreation', async () => {
  const h = harness({ env: { CALLER_REQUESTS_PER_MINUTE: '2' }, policyResponse: (_init, url) => Response.json(policy({ network: new URL(url).pathname.split('/').at(-1).replace('.json', '') })) });
  assert.equal((await h.request()).status, 200);
  assert.equal((await h.request({ query: 'network=mainnet' })).status, 200);
  h.restart();
  assert.equal((await h.request({ query: 'network=devnet' })).status, 429);
  assert.equal(h.callerStates.size, 1);
  assert.equal(h.paidCalls().length, 2);
});

test('caller cleanup expires local records without deleting the global paid-query budget', async () => {
  const h = harness();
  await h.request();
  const entry = [...h.callerStates.values()][0];
  assert.equal(entry.storage.values.size, 1);
  h.advance(300_001);
  await entry.guard.alarm();
  assert.equal(entry.storage.values.size, 0);
  assert.equal(h.storage.values.get('budget').count, 4);
});

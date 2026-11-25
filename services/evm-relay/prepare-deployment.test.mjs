import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REQUIRED_SETTINGS,
  checkGasMode,
  configChainIds,
  loadWorkerChecks,
  readWranglerConfig,
  renderRelease,
  rpcSecrets,
  validateRelease
} from './prepare-deployment.mjs';

const SERVICE = fileURLToPath(new URL('.', import.meta.url));
// A dummy key: 32 bytes of 0x11. Its address is the one viem derives.
const KEY = `0x${'11'.repeat(32)}`;
const KEY_ADDRESS = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';
const RPC_URL = 'https://rpc.example/v2/secret-api-key';
const SECRET_FRAGMENT = 'secret-api-key';

const chain = (extra = {}) => ({
  calibur: {
    address: `0x${'aa'.repeat(20)}`,
    runtimeHash: `0x${'bb'.repeat(32)}`,
    domainName: 'Calibur',
    domainVersion: '1.0.0'
  },
  kinds: {
    'agglayer-deposit': {
      bridgeAddress: `0x${'cc'.repeat(20)}`,
      midenNetworkId: 1,
      forceUpdateGlobalExitRoot: true
    }
  },
  tokens: { [`0x${'00'.repeat(20)}`]: { minAmount: '1000', fee: '0' } },
  ...extra
});
const relayConfig = (chains = { 8453: chain() }) => JSON.stringify({ chains });

const env = (overrides = {}) => ({
  CLOUDFLARE_API_TOKEN: 'token',
  CLOUDFLARE_ACCOUNT_ID: 'account',
  EVM_RELAY_RELAYER_PRIVATE_KEY: KEY,
  EVM_RELAY_RPC_URLS: JSON.stringify({ 8453: RPC_URL }),
  EVM_RELAY_ALLOWED_ORIGINS: JSON.stringify(['https://wallet.example', 'capacitor://localhost']),
  EVM_RELAY_GAS_MODE: 'sponsor',
  EVM_RELAY_CONFIG: relayConfig(),
  EVM_RELAY_URL: 'https://evm-relay.example',
  DEPLOYMENT_REVISION: 'a'.repeat(40),
  ...overrides
});

let worker;
before(async () => {
  worker = await loadWorkerChecks();
});

/** Assert that the release check fails with the message and that the message holds no secret. */
const refuses = (values, message) => {
  assert.throws(
    () => validateRelease(env(values), worker),
    error => {
      assert.match(error.message, message);
      assert.ok(!error.message.includes(SECRET_FRAGMENT), error.message);
      assert.ok(!error.message.includes(KEY.slice(2, 20)), error.message);
      return true;
    }
  );
};

test('passes good values and returns the variables, the secrets and the relayer address', () => {
  const release = validateRelease(env(), worker);
  assert.deepEqual(release.vars, {
    ALLOWED_ORIGINS: env().EVM_RELAY_ALLOWED_ORIGINS,
    DEPLOYMENT_REVISION: 'a'.repeat(40),
    GAS_MODE: 'sponsor',
    RELAY_CONFIG: env().EVM_RELAY_CONFIG
  });
  assert.deepEqual(release.secrets, { RELAYER_PRIVATE_KEY: KEY, RPC_URL_8453: RPC_URL });
  assert.equal(release.executor, KEY_ADDRESS);
  assert.deepEqual(release.chainIds, ['8453']);
});

test('names every missing setting', () => {
  for (const key of REQUIRED_SETTINGS) refuses({ [key]: '' }, new RegExp(`Missing production setting: ${key}$`));
});

test('refuses a gas mode other than sponsor or deduct', () => {
  assert.equal(checkGasMode('deduct'), 'deduct');
  refuses({ EVM_RELAY_GAS_MODE: 'free' }, /EVM_RELAY_GAS_MODE must be sponsor or deduct/);
  refuses({ EVM_RELAY_GAS_MODE: 'Sponsor' }, /EVM_RELAY_GAS_MODE/);
});

test('refuses a relayer key that is not 0x and 64 hex characters, and names no value', () => {
  refuses({ EVM_RELAY_RELAYER_PRIVATE_KEY: KEY.slice(2) }, /EVM_RELAY_RELAYER_PRIVATE_KEY must be 0x and 64 hex/);
  refuses({ EVM_RELAY_RELAYER_PRIVATE_KEY: `${KEY}00` }, /EVM_RELAY_RELAYER_PRIVATE_KEY must be 0x and 64 hex/);
  refuses({ EVM_RELAY_RELAYER_PRIVATE_KEY: `0x${'zz'.repeat(32)}` }, /EVM_RELAY_RELAYER_PRIVATE_KEY/);
});

test('refuses a relayer key that is not a valid secp256k1 scalar', () => {
  refuses({ EVM_RELAY_RELAYER_PRIVATE_KEY: `0x${'00'.repeat(32)}` }, /not a valid secp256k1 private key/);
  refuses({ EVM_RELAY_RELAYER_PRIVATE_KEY: `0x${'ff'.repeat(32)}` }, /not a valid secp256k1 private key/);
});

test('refuses origins that are not a nonempty JSON array of exact strings', () => {
  refuses({ EVM_RELAY_ALLOWED_ORIGINS: '' }, /Missing production setting: EVM_RELAY_ALLOWED_ORIGINS/);
  for (const bad of ['not json', '"https://wallet.example"', '[]', '["*"]', '["https://*.example"]', '[1]', '[""]']) {
    refuses({ EVM_RELAY_ALLOWED_ORIGINS: bad }, /EVM_RELAY_ALLOWED_ORIGINS must be a nonempty JSON array/);
  }
});

test('refuses a Worker URL that is not https or has a trailing slash', () => {
  for (const bad of [
    'http://evm-relay.example',
    'https://evm-relay.example/',
    'https://user:pw@evm-relay.example',
    'https://evm-relay.example?x=1',
    'not a url'
  ]) {
    refuses({ EVM_RELAY_URL: bad }, /EVM_RELAY_URL must be an https URL/);
  }
});

test('refuses a revision that is not a full commit SHA', () => {
  refuses({ DEPLOYMENT_REVISION: 'abc123' }, /DEPLOYMENT_REVISION must be a full commit SHA/);
});

test('refuses a relay config that is not JSON or names no chain', () => {
  assert.deepEqual(configChainIds(relayConfig({ 1: chain(), 8453: chain() })), ['1', '8453']);
  refuses({ EVM_RELAY_CONFIG: '{' }, /EVM_RELAY_CONFIG must be JSON/);
  refuses({ EVM_RELAY_CONFIG: '[]' }, /EVM_RELAY_CONFIG must be an object with chains/);
  refuses({ EVM_RELAY_CONFIG: '{"chains":[]}' }, /EVM_RELAY_CONFIG must be an object with chains/);
  refuses({ EVM_RELAY_CONFIG: relayConfig({}) }, /EVM_RELAY_CONFIG must name at least one chain/);
});

test("runs the Worker's own parse and reports its path", () => {
  refuses(
    { EVM_RELAY_CONFIG: relayConfig({ 8453: chain({ extra: true }) }) },
    /Worker refuses the release config: RELAY_CONFIG\.chains\.8453\.extra is not a known field/
  );
  refuses(
    { EVM_RELAY_CONFIG: relayConfig({ 8453: chain({ calibur: { address: '0x1' } }) }) },
    /Worker refuses the release config: RELAY_CONFIG\.chains\.8453\.calibur/
  );
  // Deduct mode needs a fee recipient and a fee on every token.
  refuses({ EVM_RELAY_GAS_MODE: 'deduct' }, /Worker refuses the release config: .*feeRecipient is required/);
  const deduct = chain({
    feeRecipient: `0x${'dd'.repeat(20)}`,
    tokens: { [`0x${'00'.repeat(20)}`]: { minAmount: '1000', fee: '10' } }
  });
  const release = validateRelease(
    env({ EVM_RELAY_GAS_MODE: 'deduct', EVM_RELAY_CONFIG: relayConfig({ 8453: deduct }) }),
    worker
  );
  assert.equal(release.vars.GAS_MODE, 'deduct');
});

test('turns the RPC URL object into one RPC_URL secret per configured chain', () => {
  assert.deepEqual(
    rpcSecrets(JSON.stringify({ 1: 'https://one.example', 8453: 'https://base.example/key' }), ['8453', '1']),
    { RPC_URL_8453: 'https://base.example/key', RPC_URL_1: 'https://one.example' }
  );
  const two = validateRelease(
    env({
      EVM_RELAY_CONFIG: relayConfig({ 1: chain(), 8453: chain() }),
      EVM_RELAY_RPC_URLS: JSON.stringify({ 1: 'https://one.example', 8453: RPC_URL })
    }),
    worker
  );
  assert.deepEqual(Object.keys(two.secrets).sort(), ['RELAYER_PRIVATE_KEY', 'RPC_URL_1', 'RPC_URL_8453']);
});

test('refuses a configured chain with no RPC URL', () => {
  refuses(
    { EVM_RELAY_CONFIG: relayConfig({ 1: chain(), 8453: chain() }) },
    /EVM_RELAY_RPC_URLS has no URL for chain 1$/
  );
});

test('refuses an RPC URL for a chain that the config does not name', () => {
  refuses(
    { EVM_RELAY_RPC_URLS: JSON.stringify({ 8453: RPC_URL, 10: RPC_URL }) },
    /EVM_RELAY_RPC_URLS has a URL for chain 10, which EVM_RELAY_CONFIG does not name/
  );
  refuses({ EVM_RELAY_RPC_URLS: JSON.stringify({ 8453: RPC_URL, [RPC_URL]: RPC_URL }) }, /not a decimal chain id$/);
});

test('refuses an RPC URL that is not https, and names no URL', () => {
  for (const bad of [
    `http://rpc.example/${SECRET_FRAGMENT}`,
    `wss://rpc.example/${SECRET_FRAGMENT}`,
    SECRET_FRAGMENT,
    42,
    null
  ]) {
    refuses({ EVM_RELAY_RPC_URLS: JSON.stringify({ 8453: bad }) }, /must give an https URL for chain 8453$/);
  }
});

test('refuses RPC URLs that are not a JSON object, and does not quote the input', () => {
  for (const bad of [`{"8453": ${RPC_URL}}`, `["${RPC_URL}"]`, `"${RPC_URL}"`]) {
    refuses({ EVM_RELAY_RPC_URLS: bad }, /EVM_RELAY_RPC_URLS must be a JSON object of chain id to URL$/);
  }
});

test('renders the committed config with an absolute entry and the release variables', () => {
  const committed = readWranglerConfig(join(SERVICE, 'wrangler.jsonc'));
  const { vars } = validateRelease(env(), worker);
  const rendered = renderRelease(committed, vars);
  assert.equal(rendered.main, join(SERVICE, 'src/worker.ts'));
  assert.deepEqual(rendered.vars, vars);
  assert.deepEqual(rendered.ratelimits, committed.ratelimits);
  assert.deepEqual(rendered.durable_objects, committed.durable_objects);
  assert.deepEqual(rendered.migrations, committed.migrations);
  assert.equal(rendered.name, committed.name);
  // The committed object keeps its placeholders.
  assert.equal(committed.vars.RELAY_CONFIG, '{"chains":{}}');
  assert.ok(!JSON.stringify(rendered).includes(KEY.slice(2)));
  assert.ok(!JSON.stringify(rendered).includes(SECRET_FRAGMENT));
});

test('refuses a config whose rate limits, Sender binding or migration are missing or wrong', () => {
  const committed = readWranglerConfig(join(SERVICE, 'wrangler.jsonc'));
  const vars = {};
  const sameNamespace = committed.ratelimits.map(binding => ({ ...binding, namespace_id: '1' }));
  for (const config of [
    { ...committed, ratelimits: [] },
    { ...committed, ratelimits: committed.ratelimits.slice(1) },
    { ...committed, ratelimits: sameNamespace },
    {
      ...committed,
      ratelimits: committed.ratelimits.map(binding => ({ ...binding, simple: { limit: 1000, period: 60 } }))
    }
  ]) {
    assert.throws(() => renderRelease(config, vars), /rate limit bindings/);
  }
  for (const config of [
    { ...committed, durable_objects: { bindings: [] } },
    { ...committed, durable_objects: { bindings: [{ name: 'RELAY_SENDER', class_name: 'Other' }] } },
    {
      ...committed,
      durable_objects: { bindings: [{ name: 'RELAY_SENDER', class_name: 'RelaySenderObject', script_name: 'x' }] }
    },
    { ...committed, migrations: [] },
    { ...committed, migrations: [{ tag: 'v1', new_classes: ['RelaySenderObject'] }] }
  ]) {
    assert.throws(() => renderRelease(config, vars), /RELAY_SENDER/);
  }
});

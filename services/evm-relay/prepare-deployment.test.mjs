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

const CALIBUR = {
  address: `0x${'aa'.repeat(20)}`,
  runtimeHash: `0x${'bb'.repeat(32)}`,
  domainName: 'Calibur',
  domainVersion: '1.0.0'
};
const FEE_RECIPIENT = `0x${'dd'.repeat(20)}`;
const chain = (extra = {}) => ({ allowedTargets: [`0x${'cc'.repeat(20)}`], ...extra });
/** RELAY_CONFIG: one Calibur pin, the chains entries and the top fields of `top`. */
const relayConfig = (chains = { 8453: chain() }, top = {}) => JSON.stringify({ calibur: CALIBUR, chains, ...top });

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

test('reads the chains entries of the relay config, and refuses a config that is not a JSON object', () => {
  assert.deepEqual(configChainIds(relayConfig({ 1: chain(), 8453: chain() })), ['1', '8453']);
  assert.deepEqual(configChainIds(JSON.stringify({ calibur: CALIBUR })), []);
  refuses({ EVM_RELAY_CONFIG: '{' }, /EVM_RELAY_CONFIG must be JSON/);
  refuses({ EVM_RELAY_CONFIG: '[]' }, /EVM_RELAY_CONFIG must be a JSON object/);
  refuses({ EVM_RELAY_CONFIG: '{"chains":[]}' }, /Worker refuses the release config: RELAY_CONFIG\.calibur is missing/);
});

test('passes a sponsor config with one Calibur pin and no chains entry: the RPC URLs name the chains', () => {
  const release = validateRelease(env({ EVM_RELAY_CONFIG: JSON.stringify({ calibur: CALIBUR }) }), worker);
  assert.deepEqual(release.chainIds, ['8453']);
  assert.deepEqual(release.secrets, { RELAYER_PRIVATE_KEY: KEY, RPC_URL_8453: RPC_URL });
});

test("runs the Worker's own parse and reports its path", () => {
  refuses(
    { EVM_RELAY_CONFIG: relayConfig({ 8453: chain({ extra: true }) }) },
    /Worker refuses the release config: RELAY_CONFIG\.chains\.8453\.extra is not a known field/
  );
  refuses(
    { EVM_RELAY_CONFIG: relayConfig({}, { calibur: { address: '0x1' } }) },
    /Worker refuses the release config: RELAY_CONFIG\.calibur/
  );
  // The old per-chain Calibur pin and the old token policy field are gone: the Worker refuses them.
  refuses(
    { EVM_RELAY_CONFIG: relayConfig({ 8453: chain({ calibur: CALIBUR }) }) },
    /Worker refuses the release config: RELAY_CONFIG\.chains\.8453\.calibur is not a known field/
  );
  refuses(
    { EVM_RELAY_CONFIG: relayConfig({ 8453: chain({ tokens: {} }) }) },
    /Worker refuses the release config: RELAY_CONFIG\.chains\.8453\.tokens is not a known field/
  );
  refuses(
    { EVM_RELAY_CONFIG: relayConfig({ 8453: chain({ allowedTargets: [] }) }) },
    /Worker refuses the release config: RELAY_CONFIG\.chains\.8453\.allowedTargets must be a non-empty array/
  );
  // Deduct mode needs the price symbol of the native coin on each served chain. The Worker knows the symbol of a chain
  // of its default table (8453 and 1 are in it). 999 is not in the table. A config without feeRecipient is valid: the
  // fee then goes to the relayer.
  const noRecipient = validateRelease(env({ EVM_RELAY_GAS_MODE: 'deduct' }), worker);
  assert.equal(noRecipient.vars.GAS_MODE, 'deduct');
  const deduct = chain({ nativePrice: 'ETHUSDT', feeTokens: { [`0x${'ee'.repeat(20)}`]: 'usd' } });
  const deductConfig = relayConfig({ 8453: deduct }, { feeRecipient: FEE_RECIPIENT });
  refuses(
    {
      EVM_RELAY_GAS_MODE: 'deduct',
      EVM_RELAY_CONFIG: deductConfig,
      EVM_RELAY_RPC_URLS: JSON.stringify({ 999: 'https://one.example', 8453: RPC_URL })
    },
    /Worker refuses the release config: RELAY_CONFIG\.chains\.999\.nativePrice is required when GAS_MODE is deduct/
  );
  const release = validateRelease(env({ EVM_RELAY_GAS_MODE: 'deduct', EVM_RELAY_CONFIG: deductConfig }), worker);
  assert.equal(release.vars.GAS_MODE, 'deduct');
  // A chain of the default table needs no nativePrice: an entry without one, and no entry at all.
  const defaults = relayConfig({ 8453: chain() }, { feeRecipient: FEE_RECIPIENT });
  const defaultRelease = validateRelease(
    env({
      EVM_RELAY_GAS_MODE: 'deduct',
      EVM_RELAY_CONFIG: defaults,
      EVM_RELAY_RPC_URLS: JSON.stringify({ 1: 'https://one.example', 8453: RPC_URL })
    }),
    worker
  );
  assert.equal(defaultRelease.vars.GAS_MODE, 'deduct');
  // A chain whose native coin is a USD stablecoin (Arc) takes "usd", and feeTokens is optional.
  const arc = relayConfig({ 8453: chain({ nativePrice: 'usd' }) }, { feeRecipient: FEE_RECIPIENT });
  const arcRelease = validateRelease(env({ EVM_RELAY_GAS_MODE: 'deduct', EVM_RELAY_CONFIG: arc }), worker);
  assert.equal(arcRelease.vars.GAS_MODE, 'deduct');
});

test('refuses the old fixed fee table and a bad price symbol of a deduct config', () => {
  const zero = `0x${'00'.repeat(20)}`;
  const cases = [
    [{ fees: { [zero]: '10' } }, /RELAY_CONFIG\.chains\.8453\.fees is not a known field/],
    [{ nativePrice: 'eth' }, /RELAY_CONFIG\.chains\.8453\.nativePrice must be "usd" or a market symbol/],
    [{ feeTokens: { [zero]: 'usd' } }, /RELAY_CONFIG\.chains\.8453\.feeTokens\.0x0{40} must not be the zero address/],
    [{ feeTokens: { [`0x${'ee'.repeat(20)}`]: 'USD' } }, /feeTokens\.0x(ee){20} must be "usd" or a market symbol/]
  ];
  for (const [extra, message] of cases) {
    const entry = chain({ nativePrice: 'ETHUSDT', ...extra });
    const config = relayConfig({ 8453: entry }, { feeRecipient: FEE_RECIPIENT });
    refuses({ EVM_RELAY_GAS_MODE: 'deduct', EVM_RELAY_CONFIG: config }, message);
  }
});

test('turns the RPC URL object into one RPC_URL secret per served chain', () => {
  assert.deepEqual(rpcSecrets(JSON.stringify({ 1: 'https://one.example', 8453: 'https://base.example/key' })), {
    secrets: { RPC_URL_8453: 'https://base.example/key', RPC_URL_1: 'https://one.example' },
    chainIds: ['1', '8453']
  });
  const two = validateRelease(
    env({
      EVM_RELAY_CONFIG: relayConfig({ 8453: chain() }),
      EVM_RELAY_RPC_URLS: JSON.stringify({ 1: 'https://one.example', 8453: RPC_URL })
    }),
    worker
  );
  assert.deepEqual(Object.keys(two.secrets).sort(), ['RELAYER_PRIVATE_KEY', 'RPC_URL_1', 'RPC_URL_8453']);
  assert.deepEqual(two.chainIds, ['1', '8453']);
});

test('refuses RPC URLs that name no chain', () => {
  refuses({ EVM_RELAY_RPC_URLS: '{}' }, /EVM_RELAY_RPC_URLS must name at least one chain$/);
});

test('refuses a chains entry for a chain with no RPC URL', () => {
  refuses(
    { EVM_RELAY_CONFIG: relayConfig({ 1: chain(), 8453: chain() }) },
    /EVM_RELAY_CONFIG has an entry for chain 1, which EVM_RELAY_RPC_URLS does not name$/
  );
});

test('refuses an RPC URL key that is not a decimal chain id', () => {
  refuses({ EVM_RELAY_RPC_URLS: JSON.stringify({ 8453: RPC_URL, [RPC_URL]: RPC_URL }) }, /not a decimal chain id$/);
  refuses({ EVM_RELAY_RPC_URLS: JSON.stringify({ '08453': RPC_URL }) }, /not a decimal chain id$/);
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
  // The committed object keeps its defaults: the one Calibur pin, with the hash of the Uniswap Calibur runtime code.
  assert.deepEqual(JSON.parse(committed.vars.RELAY_CONFIG), {
    calibur: {
      address: '0x000000009b1d0af20d8c6d0a44e162d11f9b8f00',
      runtimeHash: '0x7fa1bd2edb51499cb83a324acd9d0f35b31774cf8894e26fc13ac0474f4f57a4',
      domainName: 'Calibur',
      domainVersion: '1.0.0'
    }
  });
  assert.doesNotThrow(() =>
    worker.parseConfig({
      GAS_MODE: committed.vars.GAS_MODE,
      ALLOWED_ORIGINS: '[]',
      RELAY_CONFIG: committed.vars.RELAY_CONFIG
    })
  );
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

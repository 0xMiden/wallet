import { parseBridgeConfig, SUPPORTED_EARN_PROTOCOLS, SUPPORTED_EVM_CHAIN_IDS } from './schema';

// The spec's testnet document, as the config repo publishes it.
const doc = (overrides: Record<string, unknown> = {}) => ({
  network: 'testnet',
  version: 1,
  evm: { chainId: 11155111 },
  agglayer: {
    l1Bridge: '0x1348947e282138d8f377b467f7d9c2eb0f335d1f',
    midenBridge: '0x3b66e20b5088f25133b69216484652',
    indexerUrl: 'https://miden-testnet-bridge.dev.eu-north-3.gateway.fm/api'
  },
  epoch: {
    allocatorUrl: 'https://testnet-dev.epochprotocol.xyz',
    positionsUrl: 'https://positions-testnet-dev.epochprotocol.xyz',
    midenUsdcFaucet: '0x537c15a622074e91188aa894456c52',
    evmUsdc: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
    earnProtocol: 'dummy-lending'
  },
  features: { earn: true, fastBridge: true, bridgeIn: true, bridgeOut: true },
  ...overrides
});

type Section = 'evm' | 'agglayer' | 'epoch' | 'features';
const withSection = (name: Section, fields: Record<string, unknown>) => {
  const base = doc();
  return { ...base, [name]: { ...base[name], ...fields } };
};

const ALL_OFF = { earn: false, fastBridge: false, bridgeIn: false, bridgeOut: false };

it('parses the published testnet document, lowercasing addresses', () => {
  expect(parseBridgeConfig(doc(), 'testnet')).toStrictEqual({
    network: 'testnet',
    version: 1,
    evm: { chainId: 11155111 },
    agglayer: {
      l1Bridge: '0x1348947e282138d8f377b467f7d9c2eb0f335d1f',
      midenBridge: '0x3b66e20b5088f25133b69216484652',
      indexerUrl: 'https://miden-testnet-bridge.dev.eu-north-3.gateway.fm/api'
    },
    epoch: {
      allocatorUrl: 'https://testnet-dev.epochprotocol.xyz',
      positionsUrl: 'https://positions-testnet-dev.epochprotocol.xyz',
      midenUsdcFaucet: '0x537c15a622074e91188aa894456c52',
      evmUsdc: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
      earnProtocol: 'dummy-lending'
    },
    features: { earn: true, fastBridge: true, bridgeIn: true, bridgeOut: true }
  });
});

it('lowercases Miden account ids written in upper case', () => {
  const parsed = parseBridgeConfig(
    withSection('agglayer', { midenBridge: '0x3B66E20B5088F25133B69216484652' }),
    'testnet'
  );
  expect(parsed?.agglayer.midenBridge).toBe('0x3b66e20b5088f25133b69216484652');
});

it.each([
  ['https://allocator.example/', 'https://allocator.example'],
  ['https://allocator.example//', 'https://allocator.example'],
  ['https://bridge.example/api/', 'https://bridge.example/api'],
  ['https://Allocator.Example:8443/v1', 'https://allocator.example:8443/v1']
])('normalizes the base URL %s to %s in every URL field', (input, expected) => {
  const epoch = parseBridgeConfig(withSection('epoch', { allocatorUrl: input, positionsUrl: input }), 'testnet');
  const agglayer = parseBridgeConfig(withSection('agglayer', { indexerUrl: input }), 'testnet');
  expect(epoch?.epoch.allocatorUrl).toBe(expected);
  expect(epoch?.epoch.positionsUrl).toBe(expected);
  expect(agglayer?.agglayer.indexerUrl).toBe(expected);
});

it('ignores fields it does not know, at every level', () => {
  const base = doc();
  const extended = {
    ...base,
    schema: 2,
    evm: { ...base.evm, rpcUrl: 'https://rpc.example' },
    agglayer: { ...base.agglayer, gerMap: 'never read' },
    epoch: { ...base.epoch, solver: 1 },
    features: { ...base.features, swap: true }
  };
  expect(parseBridgeConfig(extended, 'testnet')).toStrictEqual(parseBridgeConfig(doc(), 'testnet'));
});

it('reads absent sections as empty and absent switches as off', () => {
  expect(parseBridgeConfig({ network: 'devnet', version: 3 }, 'devnet')).toStrictEqual({
    network: 'devnet',
    version: 3,
    evm: {},
    agglayer: {},
    epoch: {},
    features: ALL_OFF
  });
});

it('leaves an absent field out of its section', () => {
  const partial = {
    network: 'testnet',
    version: 2,
    agglayer: { l1Bridge: '0x1348947e282138d8f377b467f7d9c2eb0f335d1f' },
    epoch: { allocatorUrl: 'https://allocator.example' },
    features: { earn: true }
  };
  expect(parseBridgeConfig(partial, 'testnet')).toStrictEqual({
    network: 'testnet',
    version: 2,
    evm: {},
    agglayer: { l1Bridge: '0x1348947e282138d8f377b467f7d9c2eb0f335d1f' },
    epoch: { allocatorUrl: 'https://allocator.example' },
    features: { ...ALL_OFF, earn: true }
  });
});

it('drops an unsupported chain id and keeps the rest of the document', () => {
  const parsed = parseBridgeConfig(withSection('evm', { chainId: 1 }), 'testnet');
  expect(parsed?.evm).toStrictEqual({});
  expect(parsed?.epoch.evmUsdc).toBe('0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69');
});

it('drops an unsupported Earn protocol and keeps the rest of the document', () => {
  const parsed = parseBridgeConfig(withSection('epoch', { earnProtocol: 'aave-v3' }), 'testnet');
  expect(parsed?.epoch).not.toHaveProperty('earnProtocol');
  expect(parsed?.epoch.allocatorUrl).toBe('https://testnet-dev.epochprotocol.xyz');
});

it('supports Sepolia and dummy lending only', () => {
  expect(SUPPORTED_EVM_CHAIN_IDS).toEqual([11155111]);
  expect(SUPPORTED_EARN_PROTOCOLS).toEqual(['dummy-lending']);
});

it.each([
  ['a string', 'testnet'],
  ['null', null],
  ['an array', [doc()]],
  ['another network', doc({ network: 'devnet' })],
  ['no network', doc({ network: undefined })],
  ['version 0', doc({ version: 0 })],
  ['a negative version', doc({ version: -1 })],
  ['a fractional version', doc({ version: 1.5 })],
  ['a version written as text', doc({ version: '1' })],
  ['a version past the safe integers', doc({ version: 2 ** 53 })],
  ['no version', doc({ version: undefined })],
  ['an evm section that is not an object', doc({ evm: 11155111 })],
  ['a null agglayer section', doc({ agglayer: null })],
  ['an epoch section that is an array', doc({ epoch: [] })],
  ['a features section that is not an object', doc({ features: true })],
  ['a chain id written as text', withSection('evm', { chainId: '11155111' })],
  ['chain id 0', withSection('evm', { chainId: 0 })],
  ['a fractional chain id', withSection('evm', { chainId: 1.5 })],
  ['a null field', withSection('agglayer', { l1Bridge: null })],
  ['a 19-byte L1 bridge', withSection('agglayer', { l1Bridge: '0x1348947e282138d8f377b467f7d9c2eb0f335d' })],
  ['an L1 bridge without 0x', withSection('agglayer', { l1Bridge: '1348947e282138d8f377b467f7d9c2eb0f335d1f' })],
  ['an EVM USDC that is not hex', withSection('epoch', { evmUsdc: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefdZZ' })],
  ['a 16-byte Miden bridge', withSection('agglayer', { midenBridge: '0x3b66e20b5088f25133b6921648465200' })],
  ['a bech32 Miden USDC faucet', withSection('epoch', { midenUsdcFaucet: 'mtst1qpg3usdcfaucet' })],
  ['a numeric account id', withSection('epoch', { midenUsdcFaucet: 12 })],
  ['an http URL', withSection('epoch', { allocatorUrl: 'http://testnet-dev.epochprotocol.xyz' })],
  ['local http without the E2E allowance', withSection('epoch', { allocatorUrl: 'http://127.0.0.1:8548' })],
  ['an ftp URL', withSection('agglayer', { indexerUrl: 'ftp://bridge.example/api' })],
  ['a URL that does not parse', withSection('epoch', { positionsUrl: 'positions.example' })],
  ['a URL with a user name', withSection('epoch', { allocatorUrl: 'https://user@allocator.example' })],
  ['a URL with a password', withSection('epoch', { allocatorUrl: 'https://:secret@allocator.example' })],
  ['a URL with a query', withSection('epoch', { allocatorUrl: 'https://allocator.example/?key=1' })],
  ['a URL with a fragment', withSection('epoch', { allocatorUrl: 'https://allocator.example/#top' })],
  ['a numeric URL', withSection('agglayer', { indexerUrl: 443 })],
  ['a numeric Earn protocol', withSection('epoch', { earnProtocol: 1 })],
  ['a switch written as text', withSection('features', { earn: 'true' })],
  ['a numeric switch', withSection('features', { bridgeIn: 1 })],
  ['a null switch', withSection('features', { bridgeOut: null })]
])('rejects a document with %s', (_label, body) => {
  expect(parseBridgeConfig(body, 'testnet')).toBeNull();
});

describe('the E2E local http allowance', () => {
  it.each(['http://127.0.0.1:8548', 'http://localhost:8549/'])('accepts %s when allowed', input => {
    const parsed = parseBridgeConfig(withSection('epoch', { allocatorUrl: input }), 'testnet', {
      allowLocalHttp: true
    });
    expect(parsed?.epoch.allocatorUrl).toBe(input.replace(/\/$/, ''));
  });

  it.each(['http://allocator.example', 'http://10.0.2.2:8548'])('still rejects %s', input => {
    const body = withSection('epoch', { allocatorUrl: input });
    expect(parseBridgeConfig(body, 'testnet', { allowLocalHttp: true })).toBeNull();
  });
});

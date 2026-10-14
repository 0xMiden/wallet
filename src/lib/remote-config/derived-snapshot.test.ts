import type { BridgeToken, DerivedBridgeConfig, DerivedChainConfig, Probe } from './derive';
import { bridgeConfigDerivedKey, failedDerivation, parseStoredDerived } from './derived-snapshot';
import type { BridgeConfig } from './schema';
import type { EarnMarket } from './values';

const NATIVE_ETH: BridgeToken = {
  midenFaucetId: '0x0b372f2735e33e91216d995bf29b91',
  originToken: '0x0000000000000000000000000000000000000000',
  originNetwork: 0,
  scale: 10
};
const SKIPPED: Probe<never> = { state: 'skipped' };
const MARKET: EarnMarket = {
  marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
  protocolHash: '0x7a2ccf6fa10307c054284131a341a8d8cbd10ec7d3cc469fbf369c40fd86d0f9',
  underlying: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
  chainId: 11155111
};
const sepolia = (): DerivedChainConfig => ({
  agglayer: {
    rollupId: { state: 'ok', value: 86 },
    tokens: { state: 'ok', value: [NATIVE_ETH] },
    evmNetworkId: { state: 'ok', value: 0 },
    l1BridgeCode: { state: 'ok', value: true }
  },
  epoch: { evmUsdc: SKIPPED }
});
const whole = (): DerivedBridgeConfig => ({
  network: 'testnet',
  version: 4,
  derivedAt: 1_800_000_000_000,
  chains: {
    11155111: sepolia(),
    84532: {
      agglayer: { rollupId: SKIPPED, tokens: SKIPPED, evmNetworkId: SKIPPED, l1BridgeCode: SKIPPED },
      epoch: { evmUsdc: { state: 'ok', value: { symbol: 'USDC', decimals: 6 } } }
    }
  },
  agglayer: { indexer: { state: 'absent' } },
  epoch: {
    allocator: { state: 'error', message: 'HTTP 502' },
    market: { state: 'ok', value: MARKET },
    midenUsdcFaucet: { state: 'ok', value: { symbol: 'USDC', decimals: 6 } }
  },
  swap: {
    pairs: {
      state: 'ok',
      value: {
        tokens: [
          { faucetId: '0xe33498f1176661512b5ac4ded86ec7', ticker: 'IETH', decimals: 8, binanceAsset: 'ETH' },
          { faucetId: '0x094698fc4bc531d136db0866f38902', ticker: 'IUSDT', decimals: 8 }
        ],
        pairs: [{ faucetIds: ['0xe33498f1176661512b5ac4ded86ec7', '0x094698fc4bc531d136db0866f38902'] }]
      }
    }
  }
});

// What storage hands back: a copy, never the object written.
const stored = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const provider = (section: 'agglayer' | 'epoch', probe: string, value: unknown) => {
  const base = whole();
  return { ...base, [section]: { ...base[section], [probe]: value } };
};
const chain = (section: 'agglayer' | 'epoch', probe: string, value: unknown) => {
  const base = whole();
  const reads = sepolia();
  return {
    ...base,
    chains: { ...base.chains, 11155111: { ...reads, [section]: { ...reads[section], [probe]: value } } }
  };
};
const ok = (value: unknown) => ({ state: 'ok', value });
const token = (fields: Record<string, unknown>) => ok([{ ...NATIVE_ETH, ...fields }]);

it('reads back a whole snapshot, every probe state and every chain included', () => {
  expect(parseStoredDerived(stored(whole()), 'testnet', 4)).toStrictEqual(whole());
});

it('reads an empty registry as part of a whole snapshot', () => {
  const empty = chain('agglayer', 'tokens', ok([]));
  expect(parseStoredDerived(stored(empty), 'testnet', 4)).toStrictEqual(empty);
});

it('reads a document with no chains as a whole snapshot with none', () => {
  const none = { ...whole(), chains: {} };
  expect(parseStoredDerived(stored(none), 'testnet', 4)).toStrictEqual(none);
});

// An earlier build kept chain probes at the top level, with no chains or market: such a snapshot is re-derived.
it.each([
  ['no chains', { ...whole(), chains: undefined }],
  ['no market', provider('epoch', 'market', undefined)],
  [
    'the earlier top-level shape',
    {
      ...whole(),
      chains: undefined,
      agglayer: { ...sepolia().agglayer, indexer: { state: 'absent' } },
      epoch: { ...provider('epoch', 'market', undefined).epoch, evmUsdc: SKIPPED }
    }
  ]
])('rejects a matching-version snapshot with %s', (_label, value) => {
  expect(parseStoredDerived(stored(value), 'testnet', 4)).toBeNull();
});

it.each([
  ['nothing', null],
  ['a string', 'snapshot'],
  ['another network', { ...whole(), network: 'devnet' }],
  ['another document version', { ...whole(), version: 3 }],
  ['a derivedAt that is not a number', { ...whole(), derivedAt: '2026-10-03' }],
  ['an infinite derivedAt', { ...whole(), derivedAt: Infinity }],
  ['no agglayer section', { ...whole(), agglayer: undefined }],
  ['an epoch section that is an array', { ...whole(), epoch: [] }],
  ['chains that are a list', { ...whole(), chains: [sepolia()] }],
  ['a chain keyed by name', { ...whole(), chains: { sepolia: sepolia() } }],
  ['a chain that is not an object', { ...whole(), chains: { 11155111: 'sepolia' } }],
  ['a chain with no agglayer reads', { ...whole(), chains: { 11155111: { epoch: sepolia().epoch } } }]
])('rejects %s', (_label, value) => {
  expect(parseStoredDerived(value, 'testnet', 4)).toBeNull();
});

// Each carries a value its probe would accept, so only the unknown state can reject it.
it.each([
  ['agglayer', 'rollupId', { state: 'pending', value: 86 }],
  ['agglayer', 'tokens', { state: 'pending', value: [] }],
  ['agglayer', 'evmNetworkId', { state: 'pending', value: 0 }],
  ['agglayer', 'l1BridgeCode', { state: 'pending', value: true }],
  ['epoch', 'evmUsdc', { state: 'pending', value: { symbol: 'USDC', decimals: 18 } }]
] as const)('rejects a snapshot whose chain %s.%s probe is in an unknown state', (section, probe, value) => {
  expect(parseStoredDerived(chain(section, probe, value), 'testnet', 4)).toBeNull();
});

it.each([
  ['agglayer', 'indexer', { state: 'pending', value: true }],
  ['epoch', 'allocator', { state: 'pending', value: true }],
  ['epoch', 'midenUsdcFaucet', { state: 'pending', value: { symbol: 'USDC', decimals: 6 } }],
  ['epoch', 'market', { state: 'pending' }]
] as const)('rejects a snapshot whose %s.%s probe is in an unknown state', (section, probe, value) => {
  expect(parseStoredDerived(provider(section, probe, value), 'testnet', 4)).toBeNull();
});

it.each([
  ['a probe that is not an object', 'agglayer', 'rollupId', 'ok'],
  ['a negative rollup id', 'agglayer', 'rollupId', ok(-1)],
  ['a fractional network id', 'agglayer', 'evmNetworkId', ok(0.5)],
  ['a rollup id written as text', 'agglayer', 'rollupId', ok('86')],
  ['a registry that is not a list', 'agglayer', 'tokens', ok({})],
  ['a registry with one entry that is not an object', 'agglayer', 'tokens', ok([NATIVE_ETH, null])],
  ['an upper-case faucet id', 'agglayer', 'tokens', token({ midenFaucetId: '0x0B372F2735E33E91216D995BF29B91' })],
  [
    'a checksummed origin token',
    'agglayer',
    'tokens',
    token({ originToken: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69' })
  ],
  ['an origin network written as text', 'agglayer', 'tokens', token({ originNetwork: '0' })],
  ['a negative scale', 'agglayer', 'tokens', token({ scale: -1 })],
  ['code reported as false', 'agglayer', 'l1BridgeCode', ok(false)],
  ['a symbol that is not text', 'epoch', 'evmUsdc', ok({ symbol: 6, decimals: 18 })]
] as const)('rejects a chain with %s', (_label, section, probe, value) => {
  expect(parseStoredDerived(chain(section, probe, value), 'testnet', 4)).toBeNull();
});

it.each([
  ['an error with no message', 'epoch', 'allocator', { state: 'error' }],
  ['metadata that is not an object', 'epoch', 'midenUsdcFaucet', ok(null)],
  ['fractional decimals', 'epoch', 'midenUsdcFaucet', ok({ symbol: 'USDC', decimals: 6.5 })],
  ['a market with no uid', 'epoch', 'market', ok({ ...MARKET, marketUid: undefined })]
] as const)('rejects %s', (_label, section, probe, value) => {
  expect(parseStoredDerived(provider(section, probe, value), 'testnet', 4)).toBeNull();
});

it('reads a derivation that threw as every check failed, on every configured chain', () => {
  const route = { depositEnabled: true, withdrawalEnabled: true };
  const config: BridgeConfig = {
    network: 'testnet',
    version: 4,
    'bridge-providers': { epoch: {}, agglayer: {}, usdcx: {} },
    supportedEvmChains: {
      sepolia: { chainId: 11155111, bridges: {} },
      'base-sepolia': {
        chainId: 84532,
        bridges: { usdcx: { ...route, domain: 6, tokens: {} } }
      }
    },
    features: { earn: false }
  };
  const error = { state: 'error', message: 'wasm init failed' };
  const reads = {
    agglayer: { rollupId: error, tokens: error, evmNetworkId: error, l1BridgeCode: error },
    epoch: { evmUsdc: error }
  };
  expect(failedDerivation(config, 'wasm init failed', 7)).toStrictEqual({
    network: 'testnet',
    version: 4,
    derivedAt: 7,
    chains: { 11155111: reads, 84532: reads },
    agglayer: { indexer: error },
    epoch: { allocator: error, market: error, midenUsdcFaucet: error },
    swap: { pairs: error }
  });
});

it('reads a copy with no swap pairs, as a build before them stored it, as missing', () => {
  const { swap: _swap, ...before } = whole();
  expect(parseStoredDerived(before, 'testnet', 4)).toBeNull();
});

it.each([
  ['pairs that are not a probe', { pairs: 'ok' }],
  ['pairs in an unknown state', { pairs: { state: 'pending' } }],
  ['a registry that does not parse', { pairs: { state: 'ok', value: { tokens: [{ ticker: 'IETH' }], pairs: [] } } }]
])('rejects a snapshot whose swap section holds %s', (_label, swap) => {
  expect(parseStoredDerived({ ...whole(), swap }, 'testnet', 4)).toBeNull();
});

it('keys the snapshot by network', () => {
  expect(bridgeConfigDerivedKey('devnet')).toBe('bridge_config_derived_v1:devnet');
});

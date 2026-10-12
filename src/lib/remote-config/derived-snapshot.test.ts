import type { DerivedBridgeConfig } from './derive';
import { bridgeConfigDerivedKey, failedDerivation, parseStoredDerived } from './derived-snapshot';
import type { BridgeConfig } from './schema';

const whole = (): DerivedBridgeConfig => ({
  network: 'testnet',
  version: 4,
  derivedAt: 1_800_000_000_000,
  agglayer: {
    rollupId: { state: 'ok', value: 86 },
    tokens: {
      state: 'ok',
      value: [
        {
          midenFaucetId: '0x0b372f2735e33e91216d995bf29b91',
          originToken: '0x0000000000000000000000000000000000000000',
          originNetwork: 0,
          scale: 10
        }
      ]
    },
    evmNetworkId: { state: 'ok', value: 0 },
    l1BridgeCode: { state: 'ok', value: true },
    indexer: { state: 'absent' }
  },
  epoch: {
    allocator: { state: 'error', message: 'HTTP 502' },
    midenUsdcFaucet: { state: 'ok', value: { symbol: 'USDC', decimals: 6 } },
    evmUsdc: { state: 'skipped' }
  }
});

// What storage hands back: a copy, never the object written.
const stored = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const patched = (section: 'agglayer' | 'epoch', probe: string, value: unknown) => {
  const base = whole();
  return { ...base, [section]: { ...base[section], [probe]: value } };
};
const ok = (value: unknown) => ({ state: 'ok', value });
const NATIVE_ETH = {
  midenFaucetId: '0x0b372f2735e33e91216d995bf29b91',
  originToken: '0x0000000000000000000000000000000000000000',
  originNetwork: 0,
  scale: 10
};
const token = (fields: Record<string, unknown>) => ok([{ ...NATIVE_ETH, ...fields }]);

it('reads back a whole snapshot, every probe state included', () => {
  expect(parseStoredDerived(stored(whole()), 'testnet', 4)).toStrictEqual(whole());
});

it('reads an empty registry as part of a whole snapshot', () => {
  const empty = patched('agglayer', 'tokens', ok([]));
  expect(parseStoredDerived(stored(empty), 'testnet', 4)).toStrictEqual(empty);
});

it.each([
  ['nothing', null],
  ['a string', 'snapshot'],
  ['another network', { ...whole(), network: 'devnet' }],
  ['another document version', { ...whole(), version: 3 }],
  ['a derivedAt that is not a number', { ...whole(), derivedAt: '2026-10-03' }],
  ['an infinite derivedAt', { ...whole(), derivedAt: Infinity }],
  ['no agglayer section', { ...whole(), agglayer: undefined }],
  ['an epoch section that is an array', { ...whole(), epoch: [] }]
])('rejects %s', (_label, value) => {
  expect(parseStoredDerived(value, 'testnet', 4)).toBeNull();
});

// Each carries a value its probe would accept, so only the unknown state can reject it.
const UNKNOWN_STATES = [
  ['agglayer', 'rollupId', { state: 'pending', value: 86 }],
  ['agglayer', 'tokens', { state: 'pending', value: [] }],
  ['agglayer', 'evmNetworkId', { state: 'pending', value: 0 }],
  ['agglayer', 'l1BridgeCode', { state: 'pending', value: true }],
  ['agglayer', 'indexer', { state: 'pending', value: true }],
  ['epoch', 'allocator', { state: 'pending', value: true }],
  ['epoch', 'midenUsdcFaucet', { state: 'pending', value: { symbol: 'USDC', decimals: 6 } }],
  ['epoch', 'evmUsdc', { state: 'pending', value: { symbol: 'USDC', decimals: 18 } }]
] as const;

it.each(UNKNOWN_STATES)('rejects a snapshot whose %s.%s probe is in an unknown state', (section, probe, value) => {
  expect(parseStoredDerived(patched(section, probe, value), 'testnet', 4)).toBeNull();
});

it.each([
  ['a probe that is not an object', 'agglayer', 'rollupId', 'ok'],
  ['an error with no message', 'epoch', 'allocator', { state: 'error' }],
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
  ['metadata that is not an object', 'epoch', 'midenUsdcFaucet', ok(null)],
  ['a symbol that is not text', 'epoch', 'evmUsdc', ok({ symbol: 6, decimals: 18 })],
  ['fractional decimals', 'epoch', 'midenUsdcFaucet', ok({ symbol: 'USDC', decimals: 6.5 })]
] as const)('rejects %s', (_label, section, probe, value) => {
  expect(parseStoredDerived(patched(section, probe, value), 'testnet', 4)).toBeNull();
});

it('reads a derivation that threw as every check failed', () => {
  const config: BridgeConfig = {
    network: 'testnet',
    version: 4,
    evm: {},
    agglayer: {},
    epoch: {},
    features: { earn: false, fastBridge: false, bridgeIn: false, bridgeOut: false }
  };
  const error = { state: 'error', message: 'wasm init failed' };
  expect(failedDerivation(config, 'wasm init failed', 7)).toStrictEqual({
    network: 'testnet',
    version: 4,
    derivedAt: 7,
    agglayer: { rollupId: error, tokens: error, evmNetworkId: error, l1BridgeCode: error, indexer: error },
    epoch: { allocator: error, midenUsdcFaucet: error, evmUsdc: error }
  });
});

it('keys the snapshot by network', () => {
  expect(bridgeConfigDerivedKey('devnet')).toBe('bridge_config_derived_v1:devnet');
});

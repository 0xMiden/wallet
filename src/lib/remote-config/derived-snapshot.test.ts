import type { EarnVaultInfo } from 'lib/epoch/pools-read';

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
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// A vault the positions fallback gives: no optional field.
const DUMMY_VAULT: EarnVaultInfo = {
  marketUid: MARKET.marketUid,
  lenderKey: 'DUMMY_LENDING',
  lenderFamily: 'DUMMY_LENDING',
  lenderName: 'Dummy Lending',
  marketName: 'Dummy Lending',
  logoUri: '',
  chainId: '11155111',
  underlying: { address: MARKET.underlying, symbol: 'USDC', decimals: 18 },
  depositApr: 2,
  aprTotal: 2,
  canOpen: true,
  listing: {
    id: 'dummy-lending-sepolia-usdc',
    marketUid: MARKET.marketUid.toLowerCase(),
    name: 'Dummy Lending USDC',
    protocol: 'dummy-lending',
    depositsEnabled: true
  }
};
// A `/pools` vault with every optional field, of a lender the wallet has no family for.
const EULER_VAULT: EarnVaultInfo = {
  marketUid: `EULER_V2:8453:${BASE_USDC.toLowerCase()}`,
  lenderKey: 'EULER_V2',
  lenderName: 'Euler V2',
  marketName: 'EVK Vault eUSDC-49',
  logoUri: 'https://icons.example/euler_v2.webp',
  chainId: '8453',
  underlying: { address: BASE_USDC, symbol: 'USDC', decimals: 6 },
  depositApr: 6.34826539,
  aprTotal: 6.5,
  totalDepositsUsd: 604586.8095256061,
  totalLiquidityUsd: 138395.8522450287,
  utilization: 0.7710901890935693,
  risk: { score: 4, label: 'medium' },
  canOpen: false,
  about: 'Withdrawals are instant, up to the liquidity available in the market.',
  listing: {
    id: 'euler-v2-base-usdc',
    marketUid: `euler_v2:8453:${BASE_USDC.toLowerCase()}`,
    name: 'Euler USDC',
    protocol: '1delta',
    about: 'An Euler vault.',
    risk: 'medium',
    depositsEnabled: false
  }
};
const sepolia = (): DerivedChainConfig => ({
  agglayer: {
    rollupId: { state: 'ok', value: 86 },
    tokens: { state: 'ok', value: [NATIVE_ETH] },
    evmNetworkId: { state: 'ok', value: 0 },
    l1BridgeCode: { state: 'ok', value: true },
    depositTokens: {
      state: 'ok',
      value: [
        {
          symbol: 'USDC',
          contractAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
          decimals: 18,
          midenFaucetId: '0x36bb3163d7ef0ad102f35bf507c61e',
          scale: 10
        }
      ]
    }
  },
  epoch: { tokens: { USDC: SKIPPED } }
});
const whole = (): DerivedBridgeConfig => ({
  network: 'testnet',
  version: 4,
  derivedAt: 1_800_000_000_000,
  chains: {
    11155111: sepolia(),
    84532: {
      agglayer: {
        rollupId: SKIPPED,
        tokens: SKIPPED,
        evmNetworkId: SKIPPED,
        l1BridgeCode: SKIPPED,
        depositTokens: SKIPPED
      },
      epoch: { tokens: { USDC: { state: 'ok', value: { symbol: 'USDC', decimals: 6 } } } }
    }
  },
  agglayer: { indexer: { state: 'absent' } },
  epoch: {
    allocator: { state: 'error', message: 'HTTP 502' },
    market: { state: 'ok', value: MARKET },
    midenUsdcFaucet: { state: 'ok', value: { symbol: 'USDC', decimals: 6 } },
    vaults: { state: 'ok', value: [DUMMY_VAULT, EULER_VAULT] }
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
  ['a chain with no agglayer reads', { ...whole(), chains: { 11155111: { epoch: sepolia().epoch } } }],
  // An earlier build read only the route's USDC, with no token map: such a chain is derived again.
  [
    'a chain with the earlier single USDC read',
    { ...whole(), chains: { 11155111: { ...sepolia(), epoch: { evmUsdc: ok({ symbol: 'USDC', decimals: 18 }) } } } }
  ]
])('rejects %s', (_label, value) => {
  expect(parseStoredDerived(value, 'testnet', 4)).toBeNull();
});

// Each carries a value its probe would accept, so only the unknown state can reject it.
it.each([
  ['agglayer', 'rollupId', { state: 'pending', value: 86 }],
  ['agglayer', 'tokens', { state: 'pending', value: [] }],
  ['agglayer', 'evmNetworkId', { state: 'pending', value: 0 }],
  ['agglayer', 'l1BridgeCode', { state: 'pending', value: true }],
  ['agglayer', 'depositTokens', { state: 'pending', value: [] }],
  ['epoch', 'tokens', { USDC: { state: 'pending', value: { symbol: 'USDC', decimals: 18 } } }]
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
  [
    'a deposit token at a checksummed address',
    'agglayer',
    'depositTokens',
    ok([
      {
        symbol: 'USDC',
        contractAddress: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
        decimals: 18,
        midenFaucetId: '0x36bb3163d7ef0ad102f35bf507c61e',
        scale: 10
      }
    ])
  ],
  [
    'a deposit token with no symbol',
    'agglayer',
    'depositTokens',
    ok([
      {
        symbol: '',
        contractAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
        decimals: 18,
        midenFaucetId: '0x36bb3163d7ef0ad102f35bf507c61e',
        scale: 10
      }
    ])
  ],
  [
    'a deposit token whose scale is not a count',
    'agglayer',
    'depositTokens',
    ok([
      {
        symbol: 'USDC',
        contractAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
        decimals: 18,
        midenFaucetId: '0x36bb3163d7ef0ad102f35bf507c61e',
        scale: -1
      }
    ])
  ],
  ['a symbol that is not text', 'epoch', 'tokens', { USDC: ok({ symbol: 6, decimals: 18 }) }],
  ['a token map that is a list', 'epoch', 'tokens', [ok({ symbol: 'USDC', decimals: 18 })]]
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
      sepolia: {
        chainId: 11155111,
        bridges: {
          epoch: {
            ...route,
            tokens: { USDC: { contractAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69', outputs: [] } }
          }
        }
      },
      'base-sepolia': {
        chainId: 84532,
        bridges: { usdcx: { ...route, domain: 6, tokens: {} } }
      }
    },
    features: { earn: false, nearIntents: false }
  };
  const error = { state: 'error', message: 'wasm init failed' };
  const agglayer = { rollupId: error, tokens: error, evmNetworkId: error, l1BridgeCode: error, depositTokens: error };
  expect(failedDerivation(config, 'wasm init failed', 7)).toStrictEqual({
    network: 'testnet',
    version: 4,
    derivedAt: 7,
    // Each token of a chain's Epoch route fails; a chain with no route has none.
    chains: { 11155111: { agglayer, epoch: { tokens: { USDC: error } } }, 84532: { agglayer, epoch: { tokens: {} } } },
    agglayer: { indexer: error },
    epoch: { allocator: error, market: error, midenUsdcFaucet: error, vaults: error },
    swap: { pairs: error }
  });
});

describe('the Earn vault catalogue', () => {
  const withVaults = (vaults: unknown) => provider('epoch', 'vaults', vaults);
  const vault = (fields: Record<string, unknown>) => ok([DUMMY_VAULT, { ...EULER_VAULT, ...fields }]);
  const listing = (fields: Record<string, unknown>) => vault({ listing: { ...EULER_VAULT.listing, ...fields } });
  const MALFORMED = { state: 'error', message: 'The stored Earn vault catalogue is malformed' };

  it('reads a copy with no catalogue, as a build before it stored it, as missing', () => {
    expect(parseStoredDerived(stored(withVaults(undefined)), 'testnet', 4)).toBeNull();
  });

  it.each([
    ['skipped', SKIPPED],
    ['failed', { state: 'error', message: 'Failed to fetch' }],
    ['empty', ok([])]
  ])('reads back a catalogue read that was %s', (_label, vaults) => {
    const value = withVaults(vaults);
    expect(parseStoredDerived(stored(value), 'testnet', 4)).toStrictEqual(value);
  });

  it("reads back a listing's logo, and a listing with none as having none", () => {
    const value = withVaults(listing({ logo: 'icons/euler-v2.png' }));
    const parsed = parseStoredDerived(stored(value), 'testnet', 4);
    expect(parsed).toStrictEqual(value);
    const vaults = parsed?.epoch.vaults;
    expect(vaults?.state === 'ok' && vaults.value.map(item => item.listing.logo)).toEqual([
      undefined,
      'icons/euler-v2.png'
    ]);
    expect(vaults?.state === 'ok' && vaults.value[0]?.listing).not.toHaveProperty('logo');
  });

  // One vault that does not read back fails the whole catalogue, never a partial list, and keeps the rest of the copy.
  it.each([
    ['a probe that is not an object', 'ok'],
    ['an unknown state', { state: 'pending', value: [] }],
    ['a catalogue that is not a list', ok({})],
    ['a vault that is not an object', ok([DUMMY_VAULT, null])],
    ['a uid naming another token', vault({ marketUid: `EULER_V2:8453:${MARKET.underlying.toLowerCase()}` })],
    ['a uid in another case than its lender key', vault({ marketUid: EULER_VAULT.listing.marketUid })],
    ['a uid the listing does not name', vault({ listing: DUMMY_VAULT.listing })],
    ['a chain id that is not a number', vault({ chainId: 'base' })],
    [
      'an underlying in lower case',
      vault({ underlying: { ...EULER_VAULT.underlying, address: BASE_USDC.toLowerCase() } })
    ],
    ['decimals past a byte', vault({ underlying: { ...EULER_VAULT.underlying, decimals: 256 } })],
    ['an APR written as text', vault({ depositApr: '6.3' })],
    ['an APR that JSON wrote as null', vault({ aprTotal: Number.NaN })],
    ['a total that JSON wrote as null', vault({ totalDepositsUsd: Number.POSITIVE_INFINITY })],
    ['a risk with no label', vault({ risk: { score: 4 } })],
    ['an about that is not text', vault({ about: 7 })],
    ['a deposit switch that is not a boolean', vault({ canOpen: 'yes' })],
    ['a lender family its lender key does not give', vault({ lenderFamily: 'AAVE_V3' })],
    ['a lender family missing from a known lender', ok([{ ...DUMMY_VAULT, lenderFamily: undefined }])],
    ['no listing', vault({ listing: undefined })],
    ['a listing with an unknown protocol', listing({ protocol: 'aave' })],
    ['a listing with an unknown risk', listing({ risk: 'none' })],
    ['a listing name past 64 characters', listing({ name: 'x'.repeat(65) })],
    ['a listing with an empty about', listing({ about: '' })],
    ['a listing id in upper case', listing({ id: 'Euler' })],
    ['a listing with no deposit switch', listing({ depositsEnabled: undefined })],
    ['a listing logo that is a URL', listing({ logo: 'https://icons.example/euler.svg' })],
    ['a listing logo outside icons/', listing({ logo: 'euler.svg' })],
    ['a listing logo of another type', listing({ logo: 'icons/euler.webp' })],
    ['a listing logo that is not text', listing({ logo: 7 })],
    ['a listing logo that JSON wrote as null', listing({ logo: null })]
  ])('reads a catalogue with %s as a failed read', (_label, vaults) => {
    const parsed = parseStoredDerived(stored(withVaults(vaults)), 'testnet', 4);
    expect(parsed).toStrictEqual({ ...whole(), epoch: { ...whole().epoch, vaults: MALFORMED } });
  });
});

it('reads a copy with no swap pairs, as a build before them stored it, as missing', () => {
  const { swap: _swap, ...before } = whole();
  expect(parseStoredDerived(before, 'testnet', 4)).toBeNull();
});

it.each([
  ['pairs that are not a probe', { pairs: 'ok' }],
  ['pairs in an unknown state', { pairs: { state: 'pending' } }],
  ['a registry that does not parse', { pairs: { state: 'ok', value: { tokens: [{ ticker: 'IETH' }], pairs: [] } } }],
  [
    'a registry that loses a token when parsed again',
    {
      pairs: {
        state: 'ok',
        value: {
          tokens: [
            { faucetId: '0xe33498f1176661512b5ac4ded86ec7', ticker: 'IETH', decimals: 8 },
            { ticker: 'IUSDT', decimals: 8 }
          ],
          pairs: []
        }
      }
    }
  ],
  [
    'a registry that loses a pair when parsed again',
    {
      pairs: {
        state: 'ok',
        value: {
          tokens: [{ faucetId: '0xe33498f1176661512b5ac4ded86ec7', ticker: 'IETH', decimals: 8 }],
          pairs: [{ faucetIds: ['0xe33498f1176661512b5ac4ded86ec7'] }]
        }
      }
    }
  ]
])('rejects a snapshot whose swap section holds %s', (_label, swap) => {
  expect(parseStoredDerived({ ...whole(), swap }, 'testnet', 4)).toBeNull();
});

it('keys the snapshot by network', () => {
  expect(bridgeConfigDerivedKey('devnet')).toBe('bridge_config_derived_v2:devnet');
});

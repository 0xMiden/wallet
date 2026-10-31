import { getAddress, keccak256, toBytes } from 'viem';

import type { EarnVaultInfo } from 'lib/epoch/pools-read';
import {
  AAVE_V3_LISTING,
  AAVE_V3_USDC,
  BASE_CHAIN_ID,
  BASE_EARN_VAULTS,
  BASE_USDC,
  COMPOUND_V3_LISTING,
  COMPOUND_V3_USDC,
  EULER_V2_USDC,
  listingFor,
  MORPHO_UNIBTC_USDC,
  poolsPage
} from 'lib/epoch/testing/pools-fixtures';
import { TEST_SWAP_PAIRS_RESPONSE } from 'lib/miden/swap/testing/registry';
import type { JsonFetch, JsonResponse } from 'lib/remote-json';
import { getChain } from 'lib/walletconnect/config';

import {
  type BridgeToken,
  type DerivedBridgeConfig,
  type DerivedChainConfig,
  type DeriveDeps,
  EPOCH_NATIVE_TOKEN,
  type EvmReads
} from './derive';
import { parseStoredDerived } from './derived-snapshot';
import type { BridgeConfig } from './schema';
import { parseSwapPairs } from './swap-pairs';
import type { EarnMarket } from './values';
let { deriveBridgeConfig, readMidenFaucetMetadata, NotDeployedError, NotAFaucetError } =
  jest.requireActual<typeof import('./derive')>('./derive');

const mockGetAccountDetails = jest.fn();
const mockFromAccountStorage = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  AccountId: { fromHex: (id: string) => ({ id }) },
  BasicFungibleFaucetComponent: { fromAccountStorage: (storage: unknown) => mockFromAccountStorage(storage) },
  Endpoint: jest.fn((url: string) => ({ url })),
  RpcClient: jest.fn(() => ({ getAccountDetails: mockGetAccountDetails }))
}));
jest.mock('lib/miden-chain/constants', () => ({ ensureSdkWasmReady: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveRpcUrl: () => 'https://rpc.effective.example' }));
const mockPublicClient = { getCode: jest.fn(), readContract: jest.fn() };
jest.mock('viem', () => ({
  ...jest.requireActual<typeof import('viem')>('viem'),
  createPublicClient: jest.fn(() => mockPublicClient),
  http: jest.fn()
}));

const NOW = 1_800_000_000_000;
const RPC = 'https://rpc.testnet.miden.io';
// The testnet document's one Earn vault: the dummy lender's market of the Sepolia USDC.
const DUMMY_VAULT = listingFor(
  { marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69' },
  'dummy-lending-sepolia-usdc',
  'Dummy Lending USDC',
  { protocol: 'dummy-lending' }
);
const TESTNET: BridgeConfig = {
  network: 'testnet',
  version: 1,
  'bridge-providers': {
    epoch: {
      allocatorUrl: 'https://testnet-dev.epochprotocol.xyz',
      positionsUrl: 'https://positions-testnet-dev.epochprotocol.xyz',
      outputs: { 'usdc-testnet-output': { faucetId: '0x537c15a622074e91188aa894456c52' } }
    },
    agglayer: { indexerUrl: 'https://miden-testnet-bridge.dev.eu-north-3.gateway.fm/api' },
    usdcx: {}
  },
  supportedEvmChains: {
    sepolia: {
      chainId: 11155111,
      bridges: {
        epoch: {
          depositEnabled: true,
          withdrawalEnabled: true,
          tokens: {
            USDC: { contractAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69', outputs: ['usdc-testnet-output'] }
          }
        },
        agglayer: {
          depositEnabled: true,
          withdrawalEnabled: true,
          contractAddress: '0x1348947e282138d8f377b467f7d9c2eb0f335d1f',
          midenBridgeId: '0x3b66e20b5088f25133b69216484652'
        }
      }
    }
  },
  features: { earn: true, nearIntents: false },
  earn: { vaults: [DUMMY_VAULT] }
};
const ETH: BridgeToken = {
  midenFaucetId: '0x0b372f2735e33e91216d995bf29b91',
  originToken: '0x0000000000000000000000000000000000000000',
  originNetwork: 0,
  scale: 10
};

const SEPOLIA_POOLS_URL =
  'https://positions-testnet-dev.epochprotocol.xyz/pools?chainId=11155111&underlyings=0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69&count=200&start=0&sortBy=depositRate&sortDir=DESC';
const SEPOLIA_CATALOG_URL =
  'https://positions-testnet-dev.epochprotocol.xyz/positions?account=0x0000000000000000000000000000000000000000&chains=11155111';
// The zero account's catalog as the positions service answered it on 2026-10-15: it holds no position.
const EPOCH_CATALOG = {
  success: true,
  data: {
    items: [
      {
        lender: 'DUMMY_LENDING',
        chainId: '11155111',
        aprData: { apr: 2, depositApr: 2, borrowApr: 0 },
        balanceData: { deposits: 0, debt: 0, nav: 0, deposits24h: 0, nav24h: 0 },
        data: [{ positions: [] }],
        lenderInfo: { lenderKey: 'DUMMY_LENDING', name: 'Dummy Lending', logoUri: '' }
      }
    ],
    summary: {
      balanceData: { deposits: 0, debt: 0, nav: 0, deposits24h: 0, nav24h: 0 },
      aprData: { apr: 0, depositApr: 0, borrowApr: 0 },
      activeLenders: 0,
      activeChains: 0
    }
  }
};

// The allocator /health captured on 2026-10-03: status and allocator addresses, and none of the arbiter, Compact
// or integer fields epoch-intents-sdk 2.0.1 requires.
const ALLOCATOR_HEALTH = {
  status: 'healthy',
  allocatorAddresses: {
    '11155111': '0xa46827635A7d329608085401a3b2Bf14a8a2bDF9',
    '999999999': '0x444E8C0fC85BB47aBD3E97d00E2E2B0719034769'
  },
  signingAddress: '0x2F5eA866716A04e91a55099620F2e1B423eC7011',
  timestamp: '2026-10-03T13:09:55.545Z',
  supportedChains: []
};
const ALLOCATOR_ADDRESS = '0xa46827635A7d329608085401a3b2Bf14a8a2bDF9';
const ARBITER_ADDRESS = '0x2F5eA866716A04e91a55099620F2e1B423eC7011';
const COMPACT_ADDRESS = '0x00000000000000171ede64904551eeDF3C6C9788';
const MIDEN_CHAIN = '999999999';
const serviceAddresses = (address: string): Record<string, string> => ({
  '11155111': address,
  [MIDEN_CHAIN]: address
});
// The service configuration `resolveServiceConfiguration` admits. The numbers are the ones the SDK compiled in
// before 2.0 and that the E2E allocator fake still serves.
const SDK_ALLOCATOR_HEALTH = {
  status: 'healthy',
  allocatorAddresses: serviceAddresses(ALLOCATOR_ADDRESS),
  arbiterAddresses: serviceAddresses(ARBITER_ADDRESS),
  compactAddresses: serviceAddresses(COMPACT_ADDRESS),
  compactLockResetPeriod: 4,
  compactLockScope: 0,
  compactExpirySeconds: 600,
  compactExpiryBufferSeconds: 60,
  midenRecallBufferBlocks: 1000,
  midenVirtualChainId: 999999999,
  midenTestnetVirtualChainId: 999999999,
  midenMainnetVirtualChainId: 123456789,
  signingAddress: ARBITER_ADDRESS,
  timestamp: '2026-10-03T13:09:55.545Z',
  supportedChains: []
};
const ALLOCATOR_HEALTH_URL = 'https://testnet-dev.epochprotocol.xyz/health';
// The indexer and the positions catalogue as they answered on 2026-10-03. The allocator body is the SDK 2.0.1
// service configuration, not the status-and-addresses answer from that day.
const HEALTH: Record<string, unknown> = {
  [ALLOCATOR_HEALTH_URL]: SDK_ALLOCATOR_HEALTH,
  [SEPOLIA_CATALOG_URL]: EPOCH_CATALOG,
  'https://miden-testnet-bridge.dev.eu-north-3.gateway.fm/api/healthz': { status: 'SERVING' }
};

const answer = (body: unknown, ok = true): JsonResponse => ({ ok, status: ok ? 200 : 503, json: async () => body });
const notServed: JsonResponse = { ok: false, status: 404, json: async () => null };
const isPoolsUrl = (url: string): boolean => url.startsWith('https://positions-testnet-dev.epochprotocol.xyz/pools?');
const healthFetch = (bodies: Record<string, unknown> = HEALTH) =>
  jest.fn<ReturnType<JsonFetch>, Parameters<JsonFetch>>(async url =>
    url in bodies ? answer(bodies[url]) : isPoolsUrl(url) ? notServed : answer(null, false)
  );

// Sepolia as it answered on 2026-10-03: both contracts have code, networkID() = 0, USDC/18.
function sepoliaReads(overrides: Partial<EvmReads> = {}): EvmReads {
  return {
    hasCode: jest.fn(async () => true),
    networkId: jest.fn(async () => 0),
    erc20: jest.fn(async () => ({ symbol: 'USDC', decimals: 18 })),
    ...overrides
  };
}

// Each faucet the swap fixtures list reads at the decimals the solver gives it; any other is the Epoch USDC faucet.
const FIXTURE_FAUCETS = new Map(
  TEST_SWAP_PAIRS_RESPONSE.tokens.map(token => [token.faucetId, { symbol: token.ticker, decimals: token.decimals }])
);
const readFixtureFaucet = async (faucetId: string) => FIXTURE_FAUCETS.get(faucetId) ?? { symbol: 'USDC', decimals: 6 };

function deps(overrides: Partial<DeriveDeps> = {}): Partial<DeriveDeps> {
  const reads = sepoliaReads();
  return {
    now: () => NOW,
    midenRpcUrl: () => RPC,
    readBridgeRegistry: jest.fn(async () => ({ rollupId: 86, tokens: [ETH] })),
    readMidenFaucet: jest.fn(readFixtureFaucet),
    evm: () => reads,
    fetch: healthFetch(),
    tokenFaucetsBySymbol: jest.fn(async () => new Map<string, string>()),
    midenAccountHex: jest.fn(async (accountId: string) => accountId.toLowerCase()),
    ...overrides
  };
}

const SEPOLIA = 11155111;
// The testnet vault as the positions fallback serves it, with the token of the route's USDC read (USDC/18).
const DUMMY_VAULT_INFO: EarnVaultInfo = {
  marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
  lenderKey: 'DUMMY_LENDING',
  lenderFamily: 'DUMMY_LENDING',
  lenderName: 'Dummy Lending',
  marketName: 'Dummy Lending',
  logoUri: '',
  chainId: '11155111',
  underlying: { address: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69', symbol: 'USDC', decimals: 18 },
  depositApr: 2,
  aprTotal: 2,
  canOpen: true,
  listing: DUMMY_VAULT
};
const HEALTHY_SEPOLIA: DerivedChainConfig = {
  agglayer: {
    rollupId: { state: 'ok', value: 86 },
    tokens: { state: 'ok', value: [ETH] },
    evmNetworkId: { state: 'ok', value: 0 },
    l1BridgeCode: { state: 'ok', value: true },
    // TESTNET lists no deposit token.
    depositTokens: { state: 'skipped' }
  },
  // The route's USDC names the testnet output, so it settles into that faucet, read at its own scale.
  epoch: {
    tokens: {
      USDC: {
        state: 'ok',
        value: {
          symbol: 'USDC',
          decimals: 18,
          midenFaucetId: '0x537c15a622074e91188aa894456c52',
          midenSymbol: 'USDC',
          midenDecimals: 6
        }
      }
    }
  }
};
const HEALTHY: DerivedBridgeConfig = {
  network: 'testnet',
  version: 1,
  derivedAt: NOW,
  chains: { [SEPOLIA]: HEALTHY_SEPOLIA },
  agglayer: { indexer: { state: 'ok', value: true } },
  epoch: {
    market: {
      state: 'ok',
      value: {
        marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
        protocolHash: '0x7a2ccf6fa10307c054284131a341a8d8cbd10ec7d3cc469fbf369c40fd86d0f9',
        underlying: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
        chainId: 11155111
      }
    },
    allocator: { state: 'ok', value: true },
    midenUsdcFaucet: { state: 'ok', value: { symbol: 'USDC', decimals: 6 } },
    vaults: { state: 'ok', value: [DUMMY_VAULT_INFO] }
  },
  // TESTNET names no solver.
  swap: { pairs: { state: 'skipped' } }
};

const SKIPPED = { state: 'skipped' };

beforeEach(async () => {
  jest.resetModules();
  ({ deriveBridgeConfig, readMidenFaucetMetadata, NotDeployedError, NotAFaucetError } = await import('./derive'));
  jest.clearAllMocks();
  mockGetAccountDetails.mockReset();
  mockFromAccountStorage.mockReset();
  mockPublicClient.getCode.mockReset();
  mockPublicClient.readContract.mockReset();
});

describe('deriveBridgeConfig', () => {
  it('derives every value from the testnet services', async () => {
    await expect(deriveBridgeConfig(TESTNET, deps())).resolves.toEqual(HEALTHY);
  });

  it('reads the Miden accounts over the given RPC and each health route under its root', async () => {
    const fetch = healthFetch();
    const io = deps({ fetch });
    await deriveBridgeConfig(TESTNET, io);
    expect(io.readBridgeRegistry).toHaveBeenCalledWith('0x3b66e20b5088f25133b69216484652', RPC);
    expect(io.readMidenFaucet).toHaveBeenCalledWith('0x537c15a622074e91188aa894456c52', RPC);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://testnet-dev.epochprotocol.xyz/health',
      'https://miden-testnet-bridge.dev.eu-north-3.gateway.fm/api/healthz',
      // The catalogue waits for the route's USDC read, which gives the token of its positions fallback.
      SEPOLIA_POOLS_URL,
      // The testnet host has no `/pools` route, so the catalogue falls back to the zero account's positions.
      SEPOLIA_CATALOG_URL
    ]);
  });

  it('skips every probe whose root the document leaves out', async () => {
    const io = deps();
    const bare: BridgeConfig = {
      ...TESTNET,
      supportedEvmChains: {},
      'bridge-providers': { epoch: {}, agglayer: {}, usdcx: {} }
    };
    await expect(deriveBridgeConfig(bare, io)).resolves.toEqual({
      ...HEALTHY,
      chains: {},
      agglayer: { indexer: SKIPPED },
      epoch: { market: SKIPPED, allocator: SKIPPED, midenUsdcFaucet: SKIPPED, vaults: SKIPPED }
    });
    expect(io.readBridgeRegistry).not.toHaveBeenCalled();
    expect(io.fetch).not.toHaveBeenCalled();
  });

  it('skips the EVM probes for a chain the wallet has no RPC for', async () => {
    const reads = (await deriveBridgeConfig(TESTNET, deps({ evm: () => null }))).chains[SEPOLIA];
    expect([reads?.agglayer.l1BridgeCode, reads?.agglayer.evmNetworkId, reads?.epoch.tokens.USDC]).toEqual([
      SKIPPED,
      SKIPPED,
      SKIPPED
    ]);
  });

  it('reports contracts without code and missing accounts as absent', async () => {
    const reads = sepoliaReads({ hasCode: jest.fn(async () => false) });
    const derived = await deriveBridgeConfig(
      TESTNET,
      deps({
        evm: () => reads,
        readBridgeRegistry: jest.fn(async () => Promise.reject(new NotDeployedError('no bridge'))),
        readMidenFaucet: jest.fn(async () => Promise.reject(new NotDeployedError('no faucet')))
      })
    );
    expect(derived.chains[SEPOLIA]?.agglayer).toMatchObject({
      rollupId: { state: 'absent' },
      tokens: { state: 'absent' },
      l1BridgeCode: { state: 'absent' },
      evmNetworkId: { state: 'absent' }
    });
    expect(derived.chains[SEPOLIA]?.epoch.tokens.USDC).toEqual({ state: 'absent' });
    expect(derived.epoch).toMatchObject({ midenUsdcFaucet: { state: 'absent' } });
    expect(reads.networkId).not.toHaveBeenCalled();
    expect(reads.erc20).not.toHaveBeenCalled();
  });

  it('reports an empty registry as absent while the bridge itself exists', async () => {
    const derived = await deriveBridgeConfig(
      TESTNET,
      deps({ readBridgeRegistry: jest.fn(async () => ({ rollupId: 86, tokens: [] })) })
    );
    expect(derived.chains[SEPOLIA]?.agglayer.rollupId).toEqual({ state: 'ok', value: 86 });
    expect(derived.chains[SEPOLIA]?.agglayer.tokens).toEqual({ state: 'absent' });
  });

  it('keeps every other probe when some fail', async () => {
    const reads = sepoliaReads({ networkId: jest.fn(async () => Promise.reject(new Error('execution reverted'))) });
    const derived = await deriveBridgeConfig(
      TESTNET,
      deps({
        evm: () => reads,
        readBridgeRegistry: jest.fn(async () => Promise.reject(new Error('RPC "agglayer bridge registry" timed out'))),
        fetch: healthFetch({ ...HEALTH, 'https://testnet-dev.epochprotocol.xyz/health': undefined })
      })
    );
    expect(derived).toEqual({
      ...HEALTHY,
      chains: {
        [SEPOLIA]: {
          ...HEALTHY_SEPOLIA,
          agglayer: {
            ...HEALTHY_SEPOLIA.agglayer,
            rollupId: { state: 'error', message: 'RPC "agglayer bridge registry" timed out' },
            tokens: { state: 'error', message: 'RPC "agglayer bridge registry" timed out' },
            evmNetworkId: { state: 'error', message: 'execution reverted' }
          }
        }
      },
      epoch: {
        ...HEALTHY.epoch,
        allocator: {
          state: 'error',
          message: 'https://testnet-dev.epochprotocol.xyz/health answered an unexpected body'
        }
      }
    });
  });

  it('accepts a health answer only in its own service shape', async () => {
    const swapped = healthFetch({
      'https://testnet-dev.epochprotocol.xyz/health': { ok: true },
      'https://miden-testnet-bridge.dev.eu-north-3.gateway.fm/api/healthz': { status: 'NOT_SERVING' }
    });
    const derived = await deriveBridgeConfig(TESTNET, deps({ fetch: swapped }));
    expect([derived.epoch.allocator.state, derived.agglayer.indexer.state]).toEqual(['error', 'error']);
    // A complete SDK body whose status is not exactly 'healthy' is still not admitted.
    const degradedAllocator = { ...SDK_ALLOCATOR_HEALTH, status: 'degraded' };
    const degraded = await deriveBridgeConfig(
      TESTNET,
      deps({ fetch: healthFetch({ ...HEALTH, 'https://testnet-dev.epochprotocol.xyz/health': degradedAllocator }) })
    );
    expect(degraded.epoch.allocator.state).toBe('error');
    const down = await deriveBridgeConfig(TESTNET, deps({ fetch: healthFetch({}) }));
    expect(down.epoch.allocator).toEqual({ state: 'error', message: 'Remote JSON request failed with HTTP 503' });
  });

  const deriveAllocator = (body: unknown, config: BridgeConfig = TESTNET) =>
    deriveBridgeConfig(config, deps({ fetch: healthFetch({ ...HEALTH, [ALLOCATOR_HEALTH_URL]: body }) }));

  it.each([
    ['status only', { status: 'healthy' }],
    ['legacy allocator configuration', ALLOCATOR_HEALTH],
    ['compactExpirySeconds of 0', { ...SDK_ALLOCATOR_HEALTH, compactExpirySeconds: 0 }],
    [
      'compactExpirySeconds past the safe integer bound',
      { ...SDK_ALLOCATOR_HEALTH, compactExpirySeconds: Number.MAX_SAFE_INTEGER + 1 }
    ],
    ['compactExpiryBufferSeconds of 0', { ...SDK_ALLOCATOR_HEALTH, compactExpiryBufferSeconds: 0 }],
    ['compactLockResetPeriod of -1', { ...SDK_ALLOCATOR_HEALTH, compactLockResetPeriod: -1 }],
    ['compactLockResetPeriod of 8', { ...SDK_ALLOCATOR_HEALTH, compactLockResetPeriod: 8 }],
    ['compactLockScope of 2', { ...SDK_ALLOCATOR_HEALTH, compactLockScope: 2 }],
    ['midenRecallBufferBlocks of -1', { ...SDK_ALLOCATOR_HEALTH, midenRecallBufferBlocks: -1 }],
    ['midenVirtualChainId of 0', { ...SDK_ALLOCATOR_HEALTH, midenVirtualChainId: 0 }],
    ['midenTestnetVirtualChainId of 0', { ...SDK_ALLOCATOR_HEALTH, midenTestnetVirtualChainId: 0 }],
    ['midenMainnetVirtualChainId of 0', { ...SDK_ALLOCATOR_HEALTH, midenMainnetVirtualChainId: 0 }],
    ['a fractional compactExpirySeconds', { ...SDK_ALLOCATOR_HEALTH, compactExpirySeconds: 1.5 }],
    ['a string compactLockResetPeriod', { ...SDK_ALLOCATOR_HEALTH, compactLockResetPeriod: '4' }],
    ['a missing compactExpiryBufferSeconds', { ...SDK_ALLOCATOR_HEALTH, compactExpiryBufferSeconds: undefined }],
    [
      'a configured-chain address of 0xa110c',
      {
        ...SDK_ALLOCATOR_HEALTH,
        allocatorAddresses: { ...SDK_ALLOCATOR_HEALTH.allocatorAddresses, '11155111': '0xa110c' }
      }
    ],
    [
      'a Miden-chain Compact address of 0xa110c',
      {
        ...SDK_ALLOCATOR_HEALTH,
        compactAddresses: { ...SDK_ALLOCATOR_HEALTH.compactAddresses, [MIDEN_CHAIN]: '0xa110c' }
      }
    ],
    [
      'no arbiter address for Sepolia',
      { ...SDK_ALLOCATOR_HEALTH, arbiterAddresses: { [MIDEN_CHAIN]: ARBITER_ADDRESS } }
    ]
  ])('rejects a healthy allocator with %s instead of SDK 2 configuration', async (_name, body) => {
    expect((await deriveAllocator(body)).epoch.allocator.state).toBe('error');
  });

  it.each([
    ['compactLockResetPeriod is 0', { compactLockResetPeriod: 0 }],
    ['compactLockResetPeriod is 7', { compactLockResetPeriod: 7 }],
    ['compactLockScope is 1', { compactLockScope: 1 }],
    ['compactExpirySeconds is 1', { compactExpirySeconds: 1 }],
    ['compactExpirySeconds is the safe integer bound', { compactExpirySeconds: Number.MAX_SAFE_INTEGER }],
    ['compactExpiryBufferSeconds is the safe integer bound', { compactExpiryBufferSeconds: Number.MAX_SAFE_INTEGER }],
    ['midenRecallBufferBlocks is 0', { midenRecallBufferBlocks: 0 }],
    [
      'midenRecallBufferBlocks is past the safe integer bound',
      { midenRecallBufferBlocks: Number.MAX_SAFE_INTEGER + 1 }
    ],
    [
      'the virtual chain ids are 1',
      { midenVirtualChainId: 1, midenTestnetVirtualChainId: 1, midenMainnetVirtualChainId: 1 }
    ]
  ])('admits an allocator whose %s', async (_name, fields) => {
    expect((await deriveAllocator({ ...SDK_ALLOCATOR_HEALTH, ...fields })).epoch.allocator).toEqual({
      state: 'ok',
      value: true
    });
  });

  it('admits lowercase addresses that getAddress accepts', async () => {
    const lowercase = '0xa46827635a7d329608085401a3b2bf14a8a2bdf9';
    const derived = await deriveAllocator({
      ...SDK_ALLOCATOR_HEALTH,
      allocatorAddresses: serviceAddresses(lowercase),
      arbiterAddresses: serviceAddresses('0x2f5ea866716a04e91a55099620f2e1b423ec7011'),
      compactAddresses: serviceAddresses('0x00000000000000171ede64904551eedf3c6c9788')
    });
    expect(derived.epoch.allocator).toEqual({ state: 'ok', value: true });
  });

  it('ignores an invalid address on a chain that does not name Epoch USDC', async () => {
    const config: BridgeConfig = {
      ...TESTNET,
      supportedEvmChains: { ...TESTNET.supportedEvmChains, extra: { chainId: 84532, bridges: {} } }
    };
    const derived = await deriveAllocator(
      {
        ...SDK_ALLOCATOR_HEALTH,
        allocatorAddresses: { ...SDK_ALLOCATOR_HEALTH.allocatorAddresses, '84532': '0xa110c' }
      },
      config
    );
    expect(derived.epoch.allocator).toEqual({ state: 'ok', value: true });
  });

  it('rejects an Epoch USDC chain the health body does not configure', async () => {
    const config: BridgeConfig = {
      ...TESTNET,
      supportedEvmChains: {
        ...TESTNET.supportedEvmChains,
        base: {
          chainId: BASE_CHAIN_ID,
          bridges: {
            epoch: {
              depositEnabled: true,
              withdrawalEnabled: true,
              tokens: { USDC: { contractAddress: BASE_USDC, outputs: ['usdc-testnet-output'] } }
            }
          }
        }
      }
    };
    expect((await deriveAllocator(SDK_ALLOCATOR_HEALTH, config)).epoch.allocator.state).toBe('error');
    const configured = {
      ...SDK_ALLOCATOR_HEALTH,
      allocatorAddresses: { ...SDK_ALLOCATOR_HEALTH.allocatorAddresses, [BASE_CHAIN_ID]: ALLOCATOR_ADDRESS },
      arbiterAddresses: { ...SDK_ALLOCATOR_HEALTH.arbiterAddresses, [BASE_CHAIN_ID]: ARBITER_ADDRESS },
      compactAddresses: { ...SDK_ALLOCATOR_HEALTH.compactAddresses, [BASE_CHAIN_ID]: COMPACT_ADDRESS }
    };
    expect((await deriveAllocator(configured, config)).epoch.allocator).toEqual({ state: 'ok', value: true });
  });

  it('requires the Miden destination chain even when the document names no Epoch route', async () => {
    const sepoliaOnly = {
      ...SDK_ALLOCATOR_HEALTH,
      allocatorAddresses: { '11155111': ALLOCATOR_ADDRESS },
      arbiterAddresses: { '11155111': ARBITER_ADDRESS },
      compactAddresses: { '11155111': COMPACT_ADDRESS }
    };
    expect((await deriveAllocator(sepoliaOnly)).epoch.allocator.state).toBe('error');
    const midenOnly = {
      ...SDK_ALLOCATOR_HEALTH,
      allocatorAddresses: { [MIDEN_CHAIN]: ALLOCATOR_ADDRESS },
      arbiterAddresses: { [MIDEN_CHAIN]: ARBITER_ADDRESS },
      compactAddresses: { [MIDEN_CHAIN]: COMPACT_ADDRESS }
    };
    const noRoute: BridgeConfig = { ...TESTNET, supportedEvmChains: {} };
    expect((await deriveAllocator(midenOnly, noRoute)).epoch.allocator).toEqual({ state: 'ok', value: true });
    expect((await deriveAllocator(midenOnly)).epoch.allocator.state).toBe('error');
  });

  it('starts every probe before any of them answers', async () => {
    let releaseRegistry: (value: { rollupId: number; tokens: BridgeToken[] }) => void = () => undefined;
    const io = deps({
      readBridgeRegistry: jest.fn(
        () => new Promise<{ rollupId: number; tokens: BridgeToken[] }>(resolve => (releaseRegistry = resolve))
      )
    });
    const pending = deriveBridgeConfig(TESTNET, io);
    await new Promise(resolve => setTimeout(resolve, 0));
    // The two health routes, `/pools` and, after the testnet host refuses `/pools`, the positions fallback.
    expect(io.fetch).toHaveBeenCalledTimes(4);
    expect(io.readMidenFaucet).toHaveBeenCalledTimes(1);
    releaseRegistry({ rollupId: 86, tokens: [ETH] });
    await expect(pending).resolves.toEqual(HEALTHY);
  });
});

describe('the Epoch token faucets', () => {
  const WETH = '0x7b79995e5f793a07bc00c21412e50ecae098e7f9';
  const USDT = '0x7169d38820dfd117c3fa1f22a697dba58d90ba06';
  // Sepolia's Epoch route with a WETH that names its Miden symbol and a USDT that relies on its key.
  const withTokens: BridgeConfig = {
    ...TESTNET,
    supportedEvmChains: {
      sepolia: {
        chainId: SEPOLIA,
        bridges: {
          epoch: {
            depositEnabled: true,
            withdrawalEnabled: true,
            tokens: {
              USDC: { contractAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69', outputs: ['usdc-testnet-output'] },
              WETH: { contractAddress: WETH, midenSymbol: 'ETH', outputs: [] },
              USDT: { contractAddress: USDT, outputs: [] }
            }
          }
        }
      }
    }
  };
  const faucetsOf = async (config: BridgeConfig, overrides: Partial<DeriveDeps>) => {
    const derived = await deriveBridgeConfig(config, deps(overrides));
    return Object.fromEntries(
      Object.entries(derived.chains[SEPOLIA]?.epoch.tokens ?? {}).map(([symbol, read]) => [
        symbol,
        read.state === 'ok' ? read.value.midenFaucetId : read.state
      ])
    );
  };

  it("takes each token's faucet from the token-list by its Miden symbol, else its key, as hex", async () => {
    const tokenFaucetsBySymbol = jest.fn(
      async () =>
        new Map([
          ['ETH', 'mtst1eth'],
          ['USDT', 'mtst1usdt'],
          ['WETH', 'mtst1wrong']
        ])
    );
    // A bech32 id becomes a stand-in hex; a hex id is already hex, as in the real conversion.
    const midenAccountHex = jest.fn(async (accountId: string) =>
      accountId.startsWith('0x') ? accountId : `0x${accountId.slice(5).padEnd(30, '0')}`
    );
    await expect(faucetsOf(withTokens, { tokenFaucetsBySymbol, midenAccountHex })).resolves.toEqual({
      // The document's output wins over the token-list.
      USDC: '0x537c15a622074e91188aa894456c52',
      WETH: '0xeth000000000000000000000000000',
      USDT: '0xusdt00000000000000000000000000'
    });
    // One list read per derivation, whatever the number of tokens.
    expect(tokenFaucetsBySymbol).toHaveBeenCalledTimes(1);
    expect(tokenFaucetsBySymbol).toHaveBeenCalledWith('testnet');
  });

  it('leaves a token the token-list does not name, or cannot be read for, without a faucet and keeps its read', async () => {
    await expect(
      faucetsOf(withTokens, { tokenFaucetsBySymbol: jest.fn(async () => new Map([['ETH', 'mtst1eth']])) })
    ).resolves.toEqual({ USDC: '0x537c15a622074e91188aa894456c52', WETH: 'mtst1eth', USDT: undefined });
    await expect(
      faucetsOf(withTokens, { tokenFaucetsBySymbol: jest.fn(async () => Promise.reject(new Error('no list'))) })
    ).resolves.toEqual({ USDC: '0x537c15a622074e91188aa894456c52', WETH: undefined, USDT: undefined });
    await expect(
      faucetsOf(withTokens, {
        tokenFaucetsBySymbol: jest.fn(async () => new Map([['ETH', 'not an id']])),
        midenAccountHex: jest.fn(async () => Promise.reject(new Error('not an account id')))
      })
    ).resolves.toEqual({ USDC: undefined, WETH: undefined, USDT: undefined });
  });

  it('reads the native coin at the zero address with no contract read, at its key and 18 decimals', async () => {
    const reads = sepoliaReads({ hasCode: jest.fn(async () => false) });
    const withNative: BridgeConfig = {
      ...TESTNET,
      supportedEvmChains: {
        sepolia: {
          chainId: SEPOLIA,
          bridges: {
            epoch: {
              depositEnabled: true,
              withdrawalEnabled: true,
              tokens: { ETH: { contractAddress: EPOCH_NATIVE_TOKEN, outputs: [] } }
            }
          }
        }
      }
    };
    const readMidenFaucet = jest.fn(async (faucetId: string) =>
      faucetId === '0xeth' ? { symbol: 'ETH', decimals: 8 } : readFixtureFaucet(faucetId)
    );
    const derived = await deriveBridgeConfig(
      withNative,
      deps({
        evm: () => reads,
        readMidenFaucet,
        tokenFaucetsBySymbol: jest.fn(async () => new Map([['ETH', '0xeth']]))
      })
    );
    expect(derived.chains[SEPOLIA]?.epoch.tokens.ETH).toEqual({
      state: 'ok',
      value: { symbol: 'ETH', decimals: 18, midenFaucetId: '0xeth', midenSymbol: 'ETH', midenDecimals: 8 }
    });
    expect(reads.hasCode).not.toHaveBeenCalledWith(EPOCH_NATIVE_TOKEN);
    expect(reads.erc20).not.toHaveBeenCalled();
  });

  it("keeps a token's faucet without its scale when the faucet's metadata cannot be read", async () => {
    const readMidenFaucet = jest.fn(async (faucetId: string) => {
      if (faucetId === '0xeth000000000000000000000000000') throw new Error('not a faucet');
      return readFixtureFaucet(faucetId);
    });
    const midenAccountHex = jest.fn(async (accountId: string) =>
      accountId.startsWith('0x') ? accountId : `0x${accountId.slice(5).padEnd(30, '0')}`
    );
    const derived = await deriveBridgeConfig(
      withTokens,
      deps({
        readMidenFaucet,
        midenAccountHex,
        tokenFaucetsBySymbol: jest.fn(async () => new Map([['ETH', 'mtst1eth']]))
      })
    );
    expect(derived.chains[SEPOLIA]?.epoch.tokens.WETH).toEqual({
      state: 'ok',
      value: { symbol: 'USDC', decimals: 18, midenFaucetId: '0xeth000000000000000000000000000' }
    });
  });
});

describe('the swap pairs', () => {
  const PAIRS_URL = 'https://quotes.example/v2/pairs';
  const withSolver: BridgeConfig = { ...TESTNET, swap: { etaUrl: 'https://quotes.example' } };
  const derivePairs = async (bodies: Record<string, unknown>) =>
    (await deriveBridgeConfig(withSolver, deps({ fetch: healthFetch({ ...HEALTH, ...bodies }) }))).swap?.pairs;

  it("reads the solver's tokens and pairs under the document's swap.etaUrl", async () => {
    const fetch = healthFetch({ ...HEALTH, [PAIRS_URL]: TEST_SWAP_PAIRS_RESPONSE });
    const derived = await deriveBridgeConfig(withSolver, deps({ fetch }));
    expect(fetch.mock.calls.map(([url]) => url)).toContain(PAIRS_URL);
    expect(derived.swap?.pairs).toEqual({ state: 'ok', value: parseSwapPairs(TEST_SWAP_PAIRS_RESPONSE) });
    expect(derived).toEqual({ ...HEALTHY, swap: derived.swap });
  });

  it('reads a solver that is not ready (503), or that answers another body, as a failed read', async () => {
    expect(await derivePairs({})).toMatchObject({ state: 'error' });
    expect(await derivePairs({ [PAIRS_URL]: { tokens: 'none' } })).toEqual({
      state: 'error',
      message: `${PAIRS_URL} answered an unexpected body`
    });
  });

  const IETH = TEST_SWAP_PAIRS_RESPONSE.tokens[1]!;
  const SOLVER = parseSwapPairs(TEST_SWAP_PAIRS_RESPONSE)!;
  // The fixtures without IETH, and without IMIDEN-IETH and IETH-IUSDT with it.
  const WITHOUT_IETH = {
    tokens: SOLVER.tokens.filter(token => token.faucetId !== IETH.faucetId),
    pairs: SOLVER.pairs.filter(pair => !pair.faucetIds.includes(IETH.faucetId))
  };
  const derivePairsReading = async (
    readMidenFaucet: DeriveDeps['readMidenFaucet'],
    body: unknown = TEST_SWAP_PAIRS_RESPONSE
  ) => {
    const io = deps({
      fetch: healthFetch({ ...HEALTH, [PAIRS_URL]: body }),
      readMidenFaucet: jest.fn(readMidenFaucet)
    });
    return (await deriveBridgeConfig(withSolver, io)).swap?.pairs;
  };

  it("leaves out a token the solver scales differently from its faucet, with that token's pairs", async () => {
    const misScaled = {
      ...TEST_SWAP_PAIRS_RESPONSE,
      tokens: TEST_SWAP_PAIRS_RESPONSE.tokens.map(token =>
        token.faucetId === IETH.faucetId ? { ...token, decimals: 6 } : token
      )
    };
    expect(await derivePairsReading(readFixtureFaucet, misScaled)).toEqual({ state: 'ok', value: WITHOUT_IETH });
  });

  it.each([
    ['does not exist', () => new NotDeployedError(`${IETH.faucetId} does not exist`)],
    ['is not a public fungible faucet', () => new NotAFaucetError(`${IETH.faucetId} has no public state`)]
  ])("leaves out a token whose faucet %s, with that token's pairs", async (_label, failure) => {
    const pairs = await derivePairsReading(async faucetId =>
      faucetId === IETH.faucetId ? Promise.reject(failure()) : readFixtureFaucet(faucetId)
    );
    expect(pairs).toEqual({ state: 'ok', value: WITHOUT_IETH });
  });

  it('fails the whole read when a faucet read fails, so no token is kept at an unchecked scale', async () => {
    const pairs = await derivePairsReading(async faucetId =>
      faucetId === IETH.faucetId
        ? Promise.reject(new Error('RPC "bridge config faucet" timed out'))
        : readFixtureFaucet(faucetId)
    );
    expect(pairs).toEqual({ state: 'error', message: 'RPC "bridge config faucet" timed out' });
  });

  it('reads the Earn USDC faucet once when the solver lists it too', async () => {
    const earnFaucet = '0x537c15a622074e91188aa894456c52';
    const body = {
      tokens: [...TEST_SWAP_PAIRS_RESPONSE.tokens, { faucetId: earnFaucet, ticker: 'USDC', decimals: 6 }],
      pairs: [...TEST_SWAP_PAIRS_RESPONSE.pairs, { faucetIds: [earnFaucet, IETH.faucetId] }]
    };
    const io = deps({ fetch: healthFetch({ ...HEALTH, [PAIRS_URL]: body }) });
    const derived = await deriveBridgeConfig(withSolver, io);
    expect(derived.epoch.midenUsdcFaucet).toEqual({ state: 'ok', value: { symbol: 'USDC', decimals: 6 } });
    expect(derived.swap?.pairs).toMatchObject({
      state: 'ok',
      value: { tokens: expect.arrayContaining([{ faucetId: earnFaucet, ticker: 'USDC', decimals: 6 }]) }
    });
    expect(jest.mocked(io.readMidenFaucet!).mock.calls.filter(([faucetId]) => faucetId === earnFaucet)).toHaveLength(1);
  });

  it('reads at most four listed faucets at a time', async () => {
    const extra = ['0x0000000000000000000000000000ab', '0x0000000000000000000000000000cd'];
    const body = {
      tokens: [
        ...TEST_SWAP_PAIRS_RESPONSE.tokens,
        ...extra.map((faucetId, index) => ({ faucetId, ticker: `IEXTRA${'AB'[index]}`, decimals: 8 }))
      ],
      pairs: TEST_SWAP_PAIRS_RESPONSE.pairs
    };
    const listed = new Set(body.tokens.map(token => token.faucetId));
    let inFlight = 0;
    let most = 0;
    const read = jest.fn(async (faucetId: string) => {
      if (!listed.has(faucetId)) return readFixtureFaucet(faucetId);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise(resolve => setTimeout(resolve, 0));
      inFlight -= 1;
      return FIXTURE_FAUCETS.get(faucetId) ?? { symbol: 'X', decimals: 8 };
    });
    const pairs = await derivePairsReading(read, body);
    expect(pairs).toMatchObject({ state: 'ok' });
    expect(read.mock.calls.filter(([faucetId]) => listed.has(faucetId))).toHaveLength(6);
    expect(most).toBe(4);
  });

  // Distinct valid ids and tickers, each at the decimals the default faucet read gives an unknown faucet.
  const listingOf = (count: number) => ({
    tokens: Array.from({ length: count }, (_, index) => ({
      faucetId: `0x${index.toString(16).padStart(30, '0')}`,
      ticker: `TOK${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`,
      decimals: 6
    })),
    pairs: []
  });

  it.each([
    { count: 64, probe: { state: 'ok' }, reads: 64 },
    {
      count: 65,
      probe: { state: 'error', message: `${PAIRS_URL} lists 65 tokens, more than the 64 the wallet verifies` },
      reads: 0
    }
  ])(
    'verifies a listing of up to 64 tokens and reads no faucet of a longer one ($count)',
    async ({ count, probe, reads }) => {
      const body = listingOf(count);
      const io = deps({ fetch: healthFetch({ ...HEALTH, [PAIRS_URL]: body }) });
      const pairs = (await deriveBridgeConfig(withSolver, io)).swap?.pairs;
      expect(pairs).toMatchObject(probe);
      const listed = new Set(body.tokens.map(token => token.faucetId));
      const listedReads = jest.mocked(io.readMidenFaucet!).mock.calls.filter(([faucetId]) => listed.has(faucetId));
      expect(listedReads).toHaveLength(reads);
    }
  );

  it('fails the read once the on-chain verification passes its 30 s deadline', async () => {
    jest.useFakeTimers();
    try {
      const run = deriveBridgeConfig(
        withSolver,
        deps({
          fetch: healthFetch({ ...HEALTH, [PAIRS_URL]: TEST_SWAP_PAIRS_RESPONSE }),
          readMidenFaucet: jest.fn(faucetId =>
            faucetId === IETH.faucetId ? new Promise<never>(() => undefined) : readFixtureFaucet(faucetId)
          )
        })
      );
      let settled = false;
      void run.then(() => (settled = true));
      await jest.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect((await run).swap?.pairs).toEqual({
        state: 'error',
        message: 'RPC "swap pairs faucet verification" timed out after 30000ms'
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('starts no further batch of faucet reads once the 30 s deadline has failed the probe', async () => {
    jest.useFakeTimers();
    try {
      const body = listingOf(12);
      const listed = new Set(body.tokens.map(token => token.faucetId));
      let release: () => void = () => undefined;
      const gate = new Promise<void>(resolve => (release = resolve));
      const io = deps({
        fetch: healthFetch({ ...HEALTH, [PAIRS_URL]: body }),
        readMidenFaucet: jest.fn(async faucetId => {
          if (listed.has(faucetId)) await gate;
          return readFixtureFaucet(faucetId);
        })
      });
      const run = deriveBridgeConfig(withSolver, io);
      await jest.advanceTimersByTimeAsync(30_000);
      expect((await run).swap?.pairs).toMatchObject({ state: 'error' });
      release();
      await jest.advanceTimersByTimeAsync(0);
      const listedReads = jest.mocked(io.readMidenFaucet!).mock.calls.filter(([faucetId]) => listed.has(faucetId));
      expect(listedReads).toHaveLength(4);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the Earn market', () => {
  const SEPOLIA_USDC = '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69';
  const SEPOLIA_MARKET: EarnMarket = {
    marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
    protocolHash: keccak256(toBytes('dummy-lending')),
    underlying: SEPOLIA_USDC,
    chainId: 11155111
  };
  const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const CIRCLE_SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
  const withUsdcxChain: BridgeConfig = {
    ...TESTNET,
    supportedEvmChains: {
      ...TESTNET.supportedEvmChains,
      'base-sepolia': {
        chainId: 84532,
        bridges: {
          usdcx: {
            depositEnabled: true,
            withdrawalEnabled: true,
            domain: 6,
            tokens: { USDC: { contractAddress: '0x036cbd53842c5426634e7929541ec2318f3dcf7e' } }
          }
        }
      }
    }
  };
  // A catalog item in the shape the service sends, by default the zero account's: no position.
  const item = (chainId: number, positions: unknown[] = [], lenderKey = 'DUMMY_LENDING') => ({
    lender: lenderKey,
    chainId: String(chainId),
    aprData: { apr: 2, depositApr: 2, borrowApr: 0 },
    data: [{ positions }],
    lenderInfo: { lenderKey, name: 'Dummy Lending', logoUri: '' }
  });
  const usdcPosition = (underlying: string, marketUid: string) => ({
    marketUid,
    deposits: '0',
    underlyingInfo: { asset: { symbol: 'USDC', address: underlying } }
  });
  // Answers the positions route whichever chains it asks for, and the health routes as they answered.
  const servingPositions = (items: unknown[]) =>
    jest.fn<ReturnType<JsonFetch>, Parameters<JsonFetch>>(async url => {
      if (url.startsWith('https://positions-testnet-dev.epochprotocol.xyz/positions?')) {
        return answer({ success: true, data: { items } });
      }
      if (isPoolsUrl(url)) return notServed;
      return url in HEALTH ? answer(HEALTH[url]) : answer(null, false);
    });

  it('reads the catalog the service sends for the zero account as the Sepolia USDC market', async () => {
    const fetch = healthFetch({ [SEPOLIA_CATALOG_URL]: EPOCH_CATALOG });
    expect((await deriveBridgeConfig(TESTNET, deps({ fetch }))).epoch.market).toEqual({
      state: 'ok',
      value: {
        marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
        protocolHash: keccak256(toBytes('dummy-lending')),
        underlying: getAddress('0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69'),
        chainId: 11155111
      }
    });
  });

  it('takes the market only on a chain with an Epoch route, whatever the service lists first', async () => {
    const fetch = servingPositions([
      item(84532, [usdcPosition(BASE_USDC, `DUMMY_LENDING:84532:${BASE_USDC.toLowerCase()}`)]),
      item(11155111)
    ]);
    const derived = await deriveBridgeConfig(withUsdcxChain, deps({ fetch }));
    expect(derived.epoch.market).toEqual(HEALTHY.epoch.market);
    expect(fetch).toHaveBeenCalledWith(SEPOLIA_CATALOG_URL, expect.any(Object));
  });

  it.each([
    ['a lender the document does not list', [item(11155111, [], 'EULER_V2')]],
    ['the protocol name in place of its lender key', [item(11155111, [], 'dummy-lending')]],
    ['a lender only on a chain no Epoch route names', [item(84532)]],
    ['no item', []]
  ])('reads a catalog with %s as no market', async (_label, items) => {
    const fetch = servingPositions(items);
    expect((await deriveBridgeConfig(withUsdcxChain, deps({ fetch }))).epoch.market).toEqual({ state: 'absent' });
  });

  it('takes the first listed vault from the positions fallback, and hashes its listed protocol', async () => {
    const aave = listingFor(
      { marketUid: 'AAVE_V3:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69' },
      'aave-v3-sepolia-usdc',
      'Aave V3 USDC'
    );
    const fetch = servingPositions([item(11155111), item(11155111, [], 'AAVE_V3')]);
    const listed: BridgeConfig = { ...TESTNET, earn: { vaults: [aave, DUMMY_VAULT] } };
    expect((await deriveBridgeConfig(listed, deps({ fetch }))).epoch.market).toEqual({
      state: 'ok',
      value: {
        ...SEPOLIA_MARKET,
        marketUid: 'AAVE_V3:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
        protocolHash: keccak256(toBytes('1delta'))
      }
    });
  });

  it('skips the market, with no request, while the document lists no vault on an Epoch route', async () => {
    const fetch = servingPositions([item(11155111)]);
    const { earn: _earn, ...unlisted } = TESTNET;
    expect((await deriveBridgeConfig(unlisted, deps({ fetch }))).epoch.market).toEqual({ state: 'skipped' });
    expect(fetch).not.toHaveBeenCalledWith(SEPOLIA_CATALOG_URL, expect.anything());
  });

  it("builds the uid from the lender and the route, whatever form a listed position's uid has", async () => {
    const listedUid = `DUMMY_LENDING:11155111:${SEPOLIA_USDC}`;
    const fetch = servingPositions([item(11155111, [usdcPosition(SEPOLIA_USDC, listedUid)])]);
    expect((await deriveBridgeConfig(TESTNET, deps({ fetch }))).epoch.market).toEqual({
      state: 'ok',
      value: SEPOLIA_MARKET
    });
  });

  it.each([
    ['another underlying', CIRCLE_SEPOLIA_USDC, `DUMMY_LENDING:11155111:${SEPOLIA_USDC}`],
    ['a uid naming another token', SEPOLIA_USDC, `DUMMY_LENDING:11155111:${CIRCLE_SEPOLIA_USDC.toLowerCase()}`],
    ['a uid naming another chain', SEPOLIA_USDC, 'DUMMY_LENDING:84532:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69'],
    ['a uid naming no token', SEPOLIA_USDC, 'DUMMY_LENDING:11155111:usdc']
  ])('never takes the uid of a listed Sepolia USDC position with %s', async (_label, underlying, marketUid) => {
    const fetch = servingPositions([item(11155111, [usdcPosition(underlying, marketUid)])]);
    expect((await deriveBridgeConfig(TESTNET, deps({ fetch }))).epoch.market).toEqual({
      state: 'ok',
      value: SEPOLIA_MARKET
    });
  });
});

describe('the Earn market from /pools', () => {
  const BASE_POOLS_PREFIX = 'https://positions-testnet-dev.epochprotocol.xyz/pools?';
  const onBase: BridgeConfig = {
    ...TESTNET,
    supportedEvmChains: {
      base: {
        chainId: BASE_CHAIN_ID,
        bridges: {
          epoch: {
            depositEnabled: true,
            withdrawalEnabled: true,
            tokens: {
              USDC: { contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', outputs: ['usdc-testnet-output'] }
            }
          }
        }
      }
    },
    earn: { vaults: [...BASE_EARN_VAULTS] }
  };
  // Answers `/pools` with `pools` and every other route as the health map does; the positions fallback is not in it.
  const servingPools = (pools: () => JsonResponse) =>
    jest.fn<ReturnType<JsonFetch>, Parameters<JsonFetch>>(async url => {
      if (url.startsWith(BASE_POOLS_PREFIX)) return pools();
      return url in HEALTH ? answer(HEALTH[url]) : answer(null, false);
    });

  it('takes the first listed vault that takes a deposit, whatever its rate', async () => {
    const fetch = servingPools(() =>
      answer(poolsPage([MORPHO_UNIBTC_USDC, EULER_V2_USDC, COMPOUND_V3_USDC, AAVE_V3_USDC]))
    );
    expect((await deriveBridgeConfig(onBase, deps({ fetch }))).epoch.market).toEqual({
      state: 'ok',
      value: {
        marketUid: `AAVE_V3:8453:${BASE_USDC.toLowerCase()}`,
        protocolHash: keccak256(toBytes('1delta')),
        underlying: BASE_USDC,
        chainId: BASE_CHAIN_ID
      }
    });
    const [url] = fetch.mock.calls.map(([requested]) => requested).filter(u => u.startsWith(BASE_POOLS_PREFIX));
    expect(Object.fromEntries(new URL(url ?? '').searchParams)).toMatchObject({
      chainId: '8453',
      underlyings: BASE_USDC,
      count: '200',
      start: '0'
    });
    expect(fetch.mock.calls.some(([requested]) => requested.includes('/positions?'))).toBe(false);
  });

  it('passes over a vault the catalogue does not open', async () => {
    const frozen = { ...AAVE_V3_USDC, flags: { ...AAVE_V3_USDC.flags, isFrozen: true } };
    const fetch = servingPools(() => answer(poolsPage([frozen, MORPHO_UNIBTC_USDC, COMPOUND_V3_USDC])));
    expect((await deriveBridgeConfig(onBase, deps({ fetch }))).epoch.market).toMatchObject({
      state: 'ok',
      value: {
        marketUid: `COMPOUND_V3_USDC:8453:${BASE_USDC.toLowerCase()}`,
        protocolHash: keccak256(toBytes('1delta'))
      }
    });
  });

  it('passes over a vault whose deposits the document stops', async () => {
    const stopped: BridgeConfig = {
      ...onBase,
      earn: { vaults: [{ ...AAVE_V3_LISTING, depositsEnabled: false }, ...BASE_EARN_VAULTS.slice(1)] }
    };
    const fetch = servingPools(() => answer(poolsPage([AAVE_V3_USDC, COMPOUND_V3_USDC])));
    expect((await deriveBridgeConfig(stopped, deps({ fetch }))).epoch.market).toMatchObject({
      state: 'ok',
      value: { marketUid: `COMPOUND_V3_USDC:8453:${BASE_USDC.toLowerCase()}` }
    });
  });

  it('takes the first listed vault the catalogue serves when none takes a deposit', async () => {
    const closed = (pool: typeof AAVE_V3_USDC) => ({ ...pool, flags: { ...pool.flags, depositsEnabled: false } });
    const fetch = servingPools(() => answer(poolsPage([closed(COMPOUND_V3_USDC), closed(AAVE_V3_USDC)])));
    expect((await deriveBridgeConfig(onBase, deps({ fetch }))).epoch.market).toMatchObject({
      state: 'ok',
      value: { marketUid: `AAVE_V3:8453:${BASE_USDC.toLowerCase()}` }
    });
  });

  it('reads a catalogue that serves no listed vault as no market', async () => {
    const fetch = servingPools(() => answer(poolsPage([EULER_V2_USDC])));
    expect((await deriveBridgeConfig(onBase, deps({ fetch }))).epoch.market).toEqual({ state: 'absent' });
  });

  it('reads a failed /pools request as an error, with no fallback', async () => {
    const fetch = servingPools(() => {
      throw new TypeError('Failed to fetch');
    });
    expect((await deriveBridgeConfig(onBase, deps({ fetch }))).epoch.market).toEqual({
      state: 'error',
      message: 'Failed to fetch'
    });
    expect(fetch.mock.calls.some(([requested]) => requested.includes('/positions?'))).toBe(false);
  });

  it('skips the market when no chain has an Epoch USDC route', async () => {
    const noRoute: BridgeConfig = { ...TESTNET, supportedEvmChains: { base: { chainId: BASE_CHAIN_ID, bridges: {} } } };
    const fetch = servingPools(() => answer(poolsPage([AAVE_V3_USDC])));
    const { epoch } = await deriveBridgeConfig(noRoute, deps({ fetch }));
    expect([epoch.market, epoch.vaults]).toEqual([{ state: 'skipped' }, { state: 'skipped' }]);
    expect(fetch.mock.calls.some(([requested]) => requested.startsWith(BASE_POOLS_PREFIX))).toBe(false);
  });

  it('keeps the listed vaults the catalogue serves, in the list order, from the request that gives the market', async () => {
    const fetch = servingPools(() =>
      answer(poolsPage([MORPHO_UNIBTC_USDC, EULER_V2_USDC, COMPOUND_V3_USDC, AAVE_V3_USDC]))
    );
    const { epoch } = await deriveBridgeConfig(onBase, deps({ fetch }));
    // The collateral-only Morpho market is listed but not served, and Euler is served but not listed.
    expect(epoch.vaults.state === 'ok' && epoch.vaults.value.map(vault => vault.listing.id)).toEqual([
      'aave-v3-base-usdc',
      'compound-v3-base-usdc',
      'morpho-unibtc-base-usdc'
    ]);
    expect(epoch.vaults).toMatchObject({
      state: 'ok',
      value: [
        {
          marketUid: `AAVE_V3:8453:${BASE_USDC.toLowerCase()}`,
          lenderFamily: 'AAVE_V3',
          marketName: 'Aave V3 USDC',
          underlying: { address: BASE_USDC, symbol: 'USDC', decimals: 6 },
          risk: { score: 2, label: 'low' },
          canOpen: true,
          listing: AAVE_V3_LISTING
        },
        {},
        {}
      ]
    });
    expect(epoch.market).toMatchObject({
      state: 'ok',
      value: { marketUid: `AAVE_V3:8453:${BASE_USDC.toLowerCase()}` }
    });
    expect(fetch.mock.calls.filter(([requested]) => requested.startsWith(BASE_POOLS_PREFIX))).toHaveLength(1);
  });

  it('keeps a catalogue that serves no listed vault as an empty one', async () => {
    const fetch = servingPools(() => answer(poolsPage([EULER_V2_USDC])));
    expect((await deriveBridgeConfig(onBase, deps({ fetch }))).epoch.vaults).toEqual({ state: 'ok', value: [] });
  });

  it('fails the catalogue with the market when a /pools request fails', async () => {
    const fetch = servingPools(() => {
      throw new TypeError('Failed to fetch');
    });
    const { epoch } = await deriveBridgeConfig(onBase, deps({ fetch }));
    expect([epoch.vaults, epoch.market]).toEqual([
      { state: 'error', message: 'Failed to fetch' },
      { state: 'error', message: 'Failed to fetch' }
    ]);
  });
});

describe('the Earn vault catalogue over several routes', () => {
  const BASE_POOLS_PREFIX = 'https://positions-testnet-dev.epochprotocol.xyz/pools?chainId=8453&';
  // Base serves `/pools`; the Sepolia route has none, so its catalogue is the zero account's positions.
  const twoRoutes: BridgeConfig = {
    ...TESTNET,
    supportedEvmChains: {
      ...TESTNET.supportedEvmChains,
      base: {
        chainId: BASE_CHAIN_ID,
        bridges: {
          epoch: {
            depositEnabled: true,
            withdrawalEnabled: true,
            tokens: {
              USDC: { contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', outputs: ['usdc-testnet-output'] }
            }
          }
        }
      }
    },
    earn: { vaults: [{ ...COMPOUND_V3_LISTING, depositsEnabled: false }, DUMMY_VAULT, AAVE_V3_LISTING] }
  };
  const serving = (catalog: () => JsonResponse = () => answer(EPOCH_CATALOG)) =>
    jest.fn<ReturnType<JsonFetch>, Parameters<JsonFetch>>(async url => {
      if (url.startsWith(BASE_POOLS_PREFIX)) return answer(poolsPage([AAVE_V3_USDC, COMPOUND_V3_USDC]));
      if (url === SEPOLIA_CATALOG_URL) return catalog();
      if (isPoolsUrl(url)) return notServed;
      return url in HEALTH ? answer(HEALTH[url]) : answer(null, false);
    });

  it("merges every route's vaults in the list order, and takes the market from them", async () => {
    const fetch = serving();
    const { epoch } = await deriveBridgeConfig(twoRoutes, deps({ fetch }));
    expect(epoch.vaults.state === 'ok' && epoch.vaults.value.map(vault => vault.listing.id)).toEqual([
      'compound-v3-base-usdc',
      'dummy-lending-sepolia-usdc',
      'aave-v3-base-usdc'
    ]);
    // The document stops deposits into the first vault, so the market is the next one.
    expect(epoch.market).toEqual(HEALTHY.epoch.market);
    expect(fetch.mock.calls.filter(([url]) => url.startsWith(BASE_POOLS_PREFIX))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => url === SEPOLIA_CATALOG_URL)).toHaveLength(1);
  });

  // A copy that did not read back would be derived again in every realm that opens it.
  it('derives a catalogue that reads back whole from storage', async () => {
    const derived = await deriveBridgeConfig(twoRoutes, deps({ fetch: serving() }));
    expect(derived.epoch.vaults.state === 'ok' && derived.epoch.vaults.value).toHaveLength(3);
    const stored = JSON.parse(JSON.stringify(derived));
    expect(parseStoredDerived(stored, 'testnet', 1)).toStrictEqual(stored);
  });

  it('fails the whole catalogue, and the market, when one route read fails', async () => {
    const { epoch } = await deriveBridgeConfig(twoRoutes, deps({ fetch: serving(() => answer(null, false)) }));
    expect([epoch.vaults, epoch.market]).toEqual([
      { state: 'error', message: 'Remote JSON request failed with HTTP 503' },
      { state: 'error', message: 'Remote JSON request failed with HTTP 503' }
    ]);
  });

  it.each([
    ['fails', { evm: () => sepoliaReads({ erc20: jest.fn(async () => Promise.reject(new Error('offline'))) }) }],
    ['has no RPC', { evm: () => null }]
  ])("gives the positions fallback USDC/6 when the route's USDC read %s", async (_label, evm) => {
    const { epoch } = await deriveBridgeConfig(TESTNET, deps(evm));
    expect(epoch.vaults).toEqual({
      state: 'ok',
      value: [{ ...DUMMY_VAULT_INFO, underlying: { ...DUMMY_VAULT_INFO.underlying, decimals: 6 } }]
    });
  });
});

describe('deriveBridgeConfig default I/O', () => {
  const faucetOnly: BridgeConfig = {
    ...TESTNET,
    supportedEvmChains: {
      sepolia: { chainId: 11155111, bridges: { epoch: TESTNET.supportedEvmChains.sepolia?.bridges.epoch } }
    },
    'bridge-providers': {
      epoch: { outputs: { 'usdc-testnet-output': { faucetId: '0x537c15a622074e91188aa894456c52' } } },
      agglayer: {},
      usdcx: {}
    }
  };

  it('exports verified faucet metadata reads for feature-specific asset catalogs', async () => {
    const storage = { slots: 'verified faucet storage' };
    mockGetAccountDetails.mockResolvedValue({ account: () => ({ storage: () => storage }) });
    mockFromAccountStorage.mockReturnValue({ symbol: () => ({ toString: () => 'USDC' }), decimals: () => 6 });
    await expect(readMidenFaucetMetadata('0x537c15a622074e91188aa894456c52', RPC)).resolves.toEqual({
      symbol: 'USDC',
      decimals: 6
    });
    expect(jest.requireMock('@miden-sdk/miden-sdk/lazy').Endpoint).toHaveBeenCalledWith(RPC);
    expect(mockFromAccountStorage).toHaveBeenCalledWith(storage);
    await expect(readMidenFaucetMetadata('not-a-faucet', RPC)).rejects.toThrow('Invalid Miden faucet metadata request');
  });

  it('reads the Miden USDC faucet over the effective RPC', async () => {
    const storage = { slots: 'faucet storage' };
    mockGetAccountDetails.mockResolvedValue({ account: () => ({ storage: () => storage }) });
    mockFromAccountStorage.mockReturnValue({ symbol: () => ({ toString: () => 'USDC' }), decimals: () => 6 });
    const derived = await deriveBridgeConfig(faucetOnly);
    expect(derived.epoch.midenUsdcFaucet).toEqual({ state: 'ok', value: { symbol: 'USDC', decimals: 6 } });
    expect(jest.requireMock('@miden-sdk/miden-sdk/lazy').Endpoint).toHaveBeenCalledWith(
      'https://rpc.effective.example'
    );
    expect(mockGetAccountDetails).toHaveBeenCalledWith({ id: '0x537c15a622074e91188aa894456c52' });
    expect(mockFromAccountStorage).toHaveBeenCalledWith(storage);
    expect(derived.derivedAt).toEqual(expect.any(Number));
  });

  it('tells a missing faucet from a failed read', async () => {
    mockGetAccountDetails.mockRejectedValue(
      new Error(
        'failed to get account details: grpc request failed for get_account: invalid request parameters: ' +
          `code: 'Client specified an invalid argument', ` +
          'message: "account 0x537c15a622074e91188aa894456c52 not found at block 693233"'
      )
    );
    expect((await deriveBridgeConfig(faucetOnly)).epoch.midenUsdcFaucet).toEqual({ state: 'absent' });
    mockGetAccountDetails.mockResolvedValue({ account: () => undefined });
    expect((await deriveBridgeConfig(faucetOnly)).epoch.midenUsdcFaucet).toEqual({
      state: 'error',
      message: '0x537c15a622074e91188aa894456c52 has no public state'
    });
  });

  it('reads a listed faucet that is private, or whose storage is not a fungible faucet, as no faucet', async () => {
    const [imiden, ieth] = TEST_SWAP_PAIRS_RESPONSE.tokens;
    const pairsUrl = 'https://quotes.example/v2/pairs';
    const solverOnly: BridgeConfig = {
      ...TESTNET,
      supportedEvmChains: {},
      'bridge-providers': { epoch: {}, agglayer: {}, usdcx: {} },
      swap: { etaUrl: 'https://quotes.example' }
    };
    mockGetAccountDetails.mockImplementation(async ({ id }: { id: string }) => ({
      account: () => (id === imiden!.faucetId ? undefined : { storage: () => id })
    }));
    const refusing = (trap: Error) => (storage: string) => {
      if (storage === ieth!.faucetId) throw trap;
      return { symbol: () => ({ toString: () => 'X' }), decimals: () => 8 };
    };
    mockFromAccountStorage.mockImplementation(refusing(new Error('storage slot not found')));
    const solver = parseSwapPairs(TEST_SWAP_PAIRS_RESPONSE)!;
    const kept = new Set([imiden!.faucetId, ieth!.faucetId]);
    const pairs = async () =>
      (await deriveBridgeConfig(solverOnly, { fetch: healthFetch({ [pairsUrl]: TEST_SWAP_PAIRS_RESPONSE }) })).swap
        ?.pairs;
    expect(await pairs()).toEqual({
      state: 'ok',
      value: {
        tokens: solver.tokens.filter(token => !kept.has(token.faucetId)),
        pairs: solver.pairs.filter(pair => pair.faucetIds.every(faucetId => !kept.has(faucetId)))
      }
    });
    // A trap is not a refusal: it fails the read rather than costing one listing.
    mockFromAccountStorage.mockImplementation(refusing(new WebAssembly.RuntimeError('unreachable')));
    expect(await pairs()).toEqual({ state: 'error', message: 'unreachable' });
  });

  it('reads Sepolia over the wallet RPC for the chain', async () => {
    mockPublicClient.getCode.mockResolvedValue('0x6080604052');
    mockPublicClient.readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
      functionName === 'networkID' ? 0 : functionName === 'symbol' ? 'USDC' : 18
    );
    const evmOnly: BridgeConfig = {
      ...TESTNET,
      'bridge-providers': { epoch: {}, agglayer: {}, usdcx: {} }
    };
    const derived = await deriveBridgeConfig(evmOnly);
    expect(jest.requireMock('viem').http).toHaveBeenCalledWith(getChain(11155111)?.rpcUrl, {
      timeout: 10_000,
      retryCount: 1
    });
    expect(jest.requireMock('viem').createPublicClient).toHaveBeenCalledTimes(1);
    expect(derived.chains[SEPOLIA]?.agglayer).toMatchObject({
      l1BridgeCode: { state: 'ok', value: true },
      evmNetworkId: { state: 'ok', value: 0 }
    });
    expect(derived.chains[SEPOLIA]?.epoch.tokens.USDC).toEqual({
      state: 'ok',
      value: { symbol: 'USDC', decimals: 18 }
    });
  });

  it('reads empty code as no contract', async () => {
    const evmOnly: BridgeConfig = {
      ...TESTNET,
      'bridge-providers': { epoch: {}, agglayer: {}, usdcx: {} }
    };
    mockPublicClient.getCode.mockResolvedValueOnce(undefined).mockResolvedValueOnce('0x');
    const derived = await deriveBridgeConfig(evmOnly);
    const reads = derived.chains[SEPOLIA];
    expect([reads?.agglayer.l1BridgeCode, reads?.epoch.tokens.USDC]).toEqual([
      { state: 'absent' },
      { state: 'absent' }
    ]);
    expect(mockPublicClient.readContract).not.toHaveBeenCalled();
  });

  it('skips the EVM probes for a chain without a wallet RPC', async () => {
    const derived = await deriveBridgeConfig({
      ...TESTNET,
      supportedEvmChains: { future: { chainId: 999999999, bridges: TESTNET.supportedEvmChains.sepolia!.bridges } },
      'bridge-providers': { epoch: {}, agglayer: {}, usdcx: {} }
    });
    expect(derived.chains[999999999]?.agglayer.l1BridgeCode).toEqual(SKIPPED);
    expect(jest.requireMock('viem').createPublicClient).not.toHaveBeenCalled();
  });

  it('fetches the health routes with the global fetch', async () => {
    const original = globalThis.fetch;
    const fetchSpy = jest.fn(async () => answer(SDK_ALLOCATOR_HEALTH));
    Object.defineProperty(globalThis, 'fetch', { value: fetchSpy, configurable: true, writable: true });
    try {
      const allocatorOnly: BridgeConfig = {
        ...TESTNET,
        supportedEvmChains: {},
        'bridge-providers': {
          epoch: { allocatorUrl: TESTNET['bridge-providers'].epoch.allocatorUrl },
          agglayer: {},
          usdcx: {}
        }
      };
      expect((await deriveBridgeConfig(allocatorOnly)).epoch.allocator).toEqual({ state: 'ok', value: true });
      expect(fetchSpy).toHaveBeenCalledWith('https://testnet-dev.epochprotocol.xyz/health', expect.any(Object));
    } finally {
      Object.defineProperty(globalThis, 'fetch', { value: original, configurable: true, writable: true });
    }
  });
});

describe('deriveBridgeConfig deposit tokens', () => {
  const USDC_ADDRESS = '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';
  const TRNSK_ADDRESS = '0x0c86a754a29714c4fe9c6f1359fa7099ed174c0b';
  const USDC: BridgeToken = {
    midenFaucetId: '0x36bb3163d7ef0ad102f35bf507c61e',
    originToken: USDC_ADDRESS,
    originNetwork: 0,
    scale: 10
  };
  const TRNSK: BridgeToken = {
    midenFaucetId: '0x699b06a0fb524c110826e9cf7d8bc0',
    originToken: TRNSK_ADDRESS,
    originNetwork: 0,
    scale: 10
  };
  // The same token registered from another network: never offered from Sepolia.
  const USDC_ELSEWHERE: BridgeToken = { ...USDC, midenFaucetId: '0xaef9b3cd67458ad14510d371c65a58', originNetwork: 3 };
  const registry = (tokens: BridgeToken[]) => jest.fn(async () => ({ rollupId: 86, tokens }));
  const erc20 = jest.fn(async (address: string) =>
    address === TRNSK_ADDRESS ? { symbol: 'TRNSK', decimals: 18 } : { symbol: 'USDC', decimals: 6 }
  );
  const listing = (tokens?: Record<string, { contractAddress: `0x${string}` }>): BridgeConfig => {
    const sepolia = TESTNET.supportedEvmChains.sepolia;
    const agglayer = sepolia?.bridges.agglayer;
    if (!sepolia || !agglayer) throw new Error('fixture names no Sepolia AggLayer route');
    return {
      ...TESTNET,
      supportedEvmChains: {
        sepolia: {
          ...sepolia,
          bridges: { ...sepolia.bridges, agglayer: { ...agglayer, ...(tokens ? { tokens } : {}) } }
        }
      }
    };
  };
  const BOTH = { USDC: { contractAddress: USDC_ADDRESS }, TRNSK: { contractAddress: TRNSK_ADDRESS } } as const;
  const depositTokens = async (config: BridgeConfig, overrides: Partial<DeriveDeps> = {}) =>
    (await deriveBridgeConfig(config, deps({ evm: () => sepoliaReads({ erc20 }), ...overrides }))).chains[SEPOLIA]
      ?.agglayer.depositTokens;

  it('offers the listed tokens the registry holds on this network, at their contract decimals', async () => {
    const listed = listing({ ...BOTH, WBTC: { contractAddress: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599' } });
    await expect(
      depositTokens(listed, { readBridgeRegistry: registry([ETH, USDC, TRNSK, USDC_ELSEWHERE]) })
    ).resolves.toEqual({
      state: 'ok',
      value: [
        { symbol: 'USDC', contractAddress: USDC_ADDRESS, decimals: 6, midenFaucetId: USDC.midenFaucetId, scale: 10 },
        { symbol: 'TRNSK', contractAddress: TRNSK_ADDRESS, decimals: 18, midenFaucetId: TRNSK.midenFaucetId, scale: 10 }
      ]
    });
  });

  it('skips the probe while the document lists no token', async () => {
    await expect(depositTokens(listing(), { readBridgeRegistry: registry([ETH, USDC]) })).resolves.toEqual(SKIPPED);
  });

  it('reports nothing to offer as absent', async () => {
    await expect(depositTokens(listing(BOTH), { readBridgeRegistry: registry([ETH]) })).resolves.toEqual({
      state: 'absent'
    });
    const reads = sepoliaReads({ erc20, networkId: jest.fn(async () => 7) });
    await expect(
      depositTokens(listing(BOTH), { evm: () => reads, readBridgeRegistry: registry([ETH, USDC]) })
    ).resolves.toEqual({ state: 'absent' });
  });

  it('fails the probe when a contract read fails, so no token is offered at an unchecked scale', async () => {
    const reads = sepoliaReads({ erc20: jest.fn(async () => Promise.reject(new Error('execution reverted'))) });
    await expect(
      depositTokens(listing(BOTH), { evm: () => reads, readBridgeRegistry: registry([ETH, USDC, TRNSK]) })
    ).resolves.toEqual({ state: 'error', message: expect.stringContaining('execution reverted') });
  });

  it('reports the registry read as its own', async () => {
    await expect(
      depositTokens(listing(BOTH), {
        readBridgeRegistry: jest.fn(async () => Promise.reject(new NotDeployedError('no bridge')))
      })
    ).resolves.toEqual({ state: 'absent' });
    await expect(
      depositTokens(listing(BOTH), {
        readBridgeRegistry: jest.fn(async () => Promise.reject(new Error('RPC "agglayer bridge registry" timed out')))
      })
    ).resolves.toEqual({ state: 'error', message: 'RPC "agglayer bridge registry" timed out' });
  });
});

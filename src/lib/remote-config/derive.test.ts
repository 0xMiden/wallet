import { Endpoint } from '@miden-sdk/miden-sdk/lazy';
import { createPublicClient, http } from 'viem';

import { TEST_SWAP_PAIRS_RESPONSE } from 'lib/miden/swap/testing/registry';
import type { JsonFetch, JsonResponse } from 'lib/remote-json';
import { getChain } from 'lib/walletconnect/config';

import {
  type BridgeToken,
  type DerivedBridgeConfig,
  type DerivedChainConfig,
  type DeriveDeps,
  deriveBridgeConfig,
  type EvmReads,
  NotDeployedError
} from './derive';
import type { BridgeConfig } from './schema';
import { parseSwapPairs } from './swap-pairs';

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
  features: { earn: true }
};
const ETH: BridgeToken = {
  midenFaucetId: '0x0b372f2735e33e91216d995bf29b91',
  originToken: '0x0000000000000000000000000000000000000000',
  originNetwork: 0,
  scale: 10
};

// The three health routes as they answered on 2026-10-03.
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
const HEALTH: Record<string, unknown> = {
  'https://testnet-dev.epochprotocol.xyz/health': ALLOCATOR_HEALTH,
  'https://positions-testnet-dev.epochprotocol.xyz/positions?account=0x0000000000000000000000000000000000000000&chains=11155111':
    {
      success: true,
      data: {
        items: [
          {
            chainId: '11155111',
            lenderInfo: { lenderKey: 'dummy-lending' },
            data: [
              {
                positions: [
                  {
                    marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
                    underlyingInfo: { asset: { symbol: 'USDC', address: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69' } }
                  }
                ]
              }
            ]
          }
        ]
      }
    },
  'https://miden-testnet-bridge.dev.eu-north-3.gateway.fm/api/healthz': { status: 'SERVING' }
};

const answer = (body: unknown, ok = true): JsonResponse => ({ ok, status: ok ? 200 : 503, json: async () => body });
const healthFetch = (bodies: Record<string, unknown> = HEALTH) =>
  jest.fn<ReturnType<JsonFetch>, Parameters<JsonFetch>>(async url =>
    url in bodies ? answer(bodies[url]) : answer(null, false)
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

function deps(overrides: Partial<DeriveDeps> = {}): Partial<DeriveDeps> {
  const reads = sepoliaReads();
  return {
    now: () => NOW,
    midenRpcUrl: () => RPC,
    readBridgeRegistry: jest.fn(async () => ({ rollupId: 86, tokens: [ETH] })),
    readMidenFaucet: jest.fn(async () => ({ symbol: 'USDC', decimals: 6 })),
    evm: () => reads,
    fetch: healthFetch(),
    ...overrides
  };
}

const SEPOLIA = 11155111;
const HEALTHY_SEPOLIA: DerivedChainConfig = {
  agglayer: {
    rollupId: { state: 'ok', value: 86 },
    tokens: { state: 'ok', value: [ETH] },
    evmNetworkId: { state: 'ok', value: 0 },
    l1BridgeCode: { state: 'ok', value: true }
  },
  epoch: { evmUsdc: { state: 'ok', value: { symbol: 'USDC', decimals: 18 } } }
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
    midenUsdcFaucet: { state: 'ok', value: { symbol: 'USDC', decimals: 6 } }
  },
  // TESTNET names no solver.
  swap: { pairs: { state: 'skipped' } }
};

const SKIPPED = { state: 'skipped' };

beforeEach(() => {
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
      'https://positions-testnet-dev.epochprotocol.xyz/positions?account=0x0000000000000000000000000000000000000000&chains=11155111',
      'https://testnet-dev.epochprotocol.xyz/health',
      'https://miden-testnet-bridge.dev.eu-north-3.gateway.fm/api/healthz'
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
      epoch: { market: SKIPPED, allocator: SKIPPED, midenUsdcFaucet: SKIPPED }
    });
    expect(io.readBridgeRegistry).not.toHaveBeenCalled();
    expect(io.fetch).not.toHaveBeenCalled();
  });

  it('skips the EVM probes for a chain the wallet has no RPC for', async () => {
    const reads = (await deriveBridgeConfig(TESTNET, deps({ evm: () => null }))).chains[SEPOLIA];
    expect([reads?.agglayer.l1BridgeCode, reads?.agglayer.evmNetworkId, reads?.epoch.evmUsdc]).toEqual([
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
    expect(derived.chains[SEPOLIA]?.epoch.evmUsdc).toEqual({ state: 'absent' });
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
    // The allocator's own fields without status 'healthy' do not make it healthy.
    const degradedAllocator = { ...ALLOCATOR_HEALTH, status: 'degraded' };
    const degraded = await deriveBridgeConfig(
      TESTNET,
      deps({ fetch: healthFetch({ ...HEALTH, 'https://testnet-dev.epochprotocol.xyz/health': degradedAllocator }) })
    );
    expect(degraded.epoch.allocator.state).toBe('error');
    const down = await deriveBridgeConfig(TESTNET, deps({ fetch: healthFetch({}) }));
    expect(down.epoch.allocator).toEqual({ state: 'error', message: 'Remote JSON request failed with HTTP 503' });
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
    expect(io.fetch).toHaveBeenCalledTimes(3);
    expect(io.readMidenFaucet).toHaveBeenCalledTimes(1);
    releaseRegistry({ rollupId: 86, tokens: [ETH] });
    await expect(pending).resolves.toEqual(HEALTHY);
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
});

describe('the Earn market', () => {
  const SEPOLIA_USDC = '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69';
  const SEPOLIA_UID = 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';
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
  const item = (chainId: number, underlying: string, marketUid: string) => ({
    chainId: String(chainId),
    lenderInfo: { lenderKey: 'dummy-lending' },
    data: [{ positions: [{ marketUid, underlyingInfo: { asset: { symbol: 'USDC', address: underlying } } }] }]
  });
  // Answers the positions route whichever chains it asks for, and the health routes as they answered.
  const servingPositions = (items: unknown[]) =>
    jest.fn<ReturnType<JsonFetch>, Parameters<JsonFetch>>(async url => {
      if (url.startsWith('https://positions-testnet-dev.epochprotocol.xyz/positions?')) {
        return answer({ success: true, data: { items } });
      }
      return url in HEALTH ? answer(HEALTH[url]) : answer(null, false);
    });

  it('takes the market only on a chain with an Epoch route, whatever the service lists first', async () => {
    const fetch = servingPositions([
      item(84532, BASE_USDC, `DUMMY_LENDING:84532:${BASE_USDC.toLowerCase()}`),
      item(11155111, SEPOLIA_USDC, SEPOLIA_UID)
    ]);
    const derived = await deriveBridgeConfig(withUsdcxChain, deps({ fetch }));
    expect(derived.epoch.market).toEqual(HEALTHY.epoch.market);
    expect(fetch).toHaveBeenCalledWith(
      'https://positions-testnet-dev.epochprotocol.xyz/positions?account=0x0000000000000000000000000000000000000000&chains=11155111',
      expect.any(Object)
    );
  });

  it.each([
    ['another underlying', CIRCLE_SEPOLIA_USDC, `DUMMY_LENDING:11155111:${CIRCLE_SEPOLIA_USDC.toLowerCase()}`],
    ['a uid naming another token', SEPOLIA_USDC, `DUMMY_LENDING:11155111:${CIRCLE_SEPOLIA_USDC.toLowerCase()}`],
    ['a uid naming another chain', SEPOLIA_USDC, 'DUMMY_LENDING:84532:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69'],
    ['a uid naming no token', SEPOLIA_USDC, 'DUMMY_LENDING:11155111:usdc']
  ])('reads a Sepolia USDC position with %s as no market', async (_label, underlying, marketUid) => {
    const fetch = servingPositions([item(11155111, underlying, marketUid)]);
    expect((await deriveBridgeConfig(TESTNET, deps({ fetch }))).epoch.market).toEqual({ state: 'absent' });
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

  it('reads the Miden USDC faucet over the effective RPC', async () => {
    const storage = { slots: 'faucet storage' };
    mockGetAccountDetails.mockResolvedValue({ account: () => ({ storage: () => storage }) });
    mockFromAccountStorage.mockReturnValue({ symbol: () => ({ toString: () => 'USDC' }), decimals: () => 6 });
    const derived = await deriveBridgeConfig(faucetOnly);
    expect(derived.epoch.midenUsdcFaucet).toEqual({ state: 'ok', value: { symbol: 'USDC', decimals: 6 } });
    expect(Endpoint).toHaveBeenCalledWith('https://rpc.effective.example');
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
    expect(http).toHaveBeenCalledWith(getChain(11155111)?.rpcUrl, { timeout: 10_000, retryCount: 1 });
    expect(createPublicClient).toHaveBeenCalledTimes(1);
    expect(derived.chains[SEPOLIA]?.agglayer).toMatchObject({
      l1BridgeCode: { state: 'ok', value: true },
      evmNetworkId: { state: 'ok', value: 0 }
    });
    expect(derived.chains[SEPOLIA]?.epoch.evmUsdc).toEqual({ state: 'ok', value: { symbol: 'USDC', decimals: 18 } });
  });

  it('reads empty code as no contract', async () => {
    const evmOnly: BridgeConfig = {
      ...TESTNET,
      'bridge-providers': { epoch: {}, agglayer: {}, usdcx: {} }
    };
    mockPublicClient.getCode.mockResolvedValueOnce(undefined).mockResolvedValueOnce('0x');
    const derived = await deriveBridgeConfig(evmOnly);
    const reads = derived.chains[SEPOLIA];
    expect([reads?.agglayer.l1BridgeCode, reads?.epoch.evmUsdc]).toEqual([{ state: 'absent' }, { state: 'absent' }]);
    expect(mockPublicClient.readContract).not.toHaveBeenCalled();
  });

  it('skips the EVM probes for a chain without a wallet RPC', async () => {
    const derived = await deriveBridgeConfig({
      ...TESTNET,
      supportedEvmChains: { future: { chainId: 999999999, bridges: TESTNET.supportedEvmChains.sepolia!.bridges } },
      'bridge-providers': { epoch: {}, agglayer: {}, usdcx: {} }
    });
    expect(derived.chains[999999999]?.agglayer.l1BridgeCode).toEqual(SKIPPED);
    expect(createPublicClient).not.toHaveBeenCalled();
  });

  it('fetches the health routes with the global fetch', async () => {
    const original = globalThis.fetch;
    const fetchSpy = jest.fn(async () => answer({ status: 'healthy' }));
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

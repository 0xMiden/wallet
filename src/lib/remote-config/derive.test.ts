import { Endpoint } from '@miden-sdk/miden-sdk/lazy';
import { createPublicClient, http } from 'viem';

import type { JsonFetch, JsonResponse } from 'lib/remote-json';
import { getChain } from 'lib/walletconnect/config';

import {
  type BridgeToken,
  type DerivedBridgeConfig,
  type DeriveDeps,
  deriveBridgeConfig,
  type EvmReads,
  NotDeployedError
} from './derive';
import type { BridgeConfig } from './schema';

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

const HEALTHY: DerivedBridgeConfig = {
  network: 'testnet',
  version: 1,
  derivedAt: NOW,
  agglayer: {
    rollupId: { state: 'ok', value: 86 },
    tokens: { state: 'ok', value: [ETH] },
    evmNetworkId: { state: 'ok', value: 0 },
    l1BridgeCode: { state: 'ok', value: true },
    indexer: { state: 'ok', value: true }
  },
  epoch: {
    allocator: { state: 'ok', value: true },
    midenUsdcFaucet: { state: 'ok', value: { symbol: 'USDC', decimals: 6 } },
    evmUsdc: { state: 'ok', value: { symbol: 'USDC', decimals: 18 } }
  }
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
      'https://miden-testnet-bridge.dev.eu-north-3.gateway.fm/api/healthz',
      'https://testnet-dev.epochprotocol.xyz/health'
    ]);
  });

  it('skips every probe whose root the document leaves out', async () => {
    const io = deps();
    const bare: BridgeConfig = { ...TESTNET, evm: {}, agglayer: {}, epoch: {} };
    await expect(deriveBridgeConfig(bare, io)).resolves.toEqual({
      ...HEALTHY,
      agglayer: { rollupId: SKIPPED, tokens: SKIPPED, evmNetworkId: SKIPPED, l1BridgeCode: SKIPPED, indexer: SKIPPED },
      epoch: { allocator: SKIPPED, midenUsdcFaucet: SKIPPED, evmUsdc: SKIPPED }
    });
    expect(io.readBridgeRegistry).not.toHaveBeenCalled();
    expect(io.fetch).not.toHaveBeenCalled();
  });

  it('skips the EVM probes for a chain the wallet has no RPC for', async () => {
    const derived = await deriveBridgeConfig(TESTNET, deps({ evm: () => null }));
    expect([derived.agglayer.l1BridgeCode, derived.agglayer.evmNetworkId, derived.epoch.evmUsdc]).toEqual([
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
    expect(derived.agglayer).toMatchObject({
      rollupId: { state: 'absent' },
      tokens: { state: 'absent' },
      l1BridgeCode: { state: 'absent' },
      evmNetworkId: { state: 'absent' }
    });
    expect(derived.epoch).toMatchObject({ midenUsdcFaucet: { state: 'absent' }, evmUsdc: { state: 'absent' } });
    expect(reads.networkId).not.toHaveBeenCalled();
    expect(reads.erc20).not.toHaveBeenCalled();
  });

  it('reports an empty registry as absent while the bridge itself exists', async () => {
    const derived = await deriveBridgeConfig(
      TESTNET,
      deps({ readBridgeRegistry: jest.fn(async () => ({ rollupId: 86, tokens: [] })) })
    );
    expect(derived.agglayer.rollupId).toEqual({ state: 'ok', value: 86 });
    expect(derived.agglayer.tokens).toEqual({ state: 'absent' });
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
      agglayer: {
        ...HEALTHY.agglayer,
        rollupId: { state: 'error', message: 'RPC "agglayer bridge registry" timed out' },
        tokens: { state: 'error', message: 'RPC "agglayer bridge registry" timed out' },
        evmNetworkId: { state: 'error', message: 'execution reverted' }
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
    expect(io.fetch).toHaveBeenCalledTimes(2);
    expect(io.readMidenFaucet).toHaveBeenCalledTimes(1);
    releaseRegistry({ rollupId: 86, tokens: [ETH] });
    await expect(pending).resolves.toEqual(HEALTHY);
  });
});

describe('deriveBridgeConfig default I/O', () => {
  const faucetOnly: BridgeConfig = {
    ...TESTNET,
    evm: {},
    agglayer: {},
    epoch: { midenUsdcFaucet: '0x537c15a622074e91188aa894456c52' }
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
      agglayer: { l1Bridge: TESTNET.agglayer.l1Bridge },
      epoch: { evmUsdc: TESTNET.epoch.evmUsdc }
    };
    const derived = await deriveBridgeConfig(evmOnly);
    expect(http).toHaveBeenCalledWith(getChain(11155111)?.rpcUrl, { timeout: 10_000, retryCount: 1 });
    expect(createPublicClient).toHaveBeenCalledTimes(1);
    expect(derived.agglayer.l1BridgeCode).toEqual({ state: 'ok', value: true });
    expect(derived.agglayer.evmNetworkId).toEqual({ state: 'ok', value: 0 });
    expect(derived.epoch.evmUsdc).toEqual({ state: 'ok', value: { symbol: 'USDC', decimals: 18 } });
  });

  it('reads empty code as no contract', async () => {
    const evmOnly: BridgeConfig = {
      ...TESTNET,
      agglayer: { l1Bridge: TESTNET.agglayer.l1Bridge },
      epoch: { evmUsdc: TESTNET.epoch.evmUsdc }
    };
    mockPublicClient.getCode.mockResolvedValueOnce(undefined).mockResolvedValueOnce('0x');
    const derived = await deriveBridgeConfig(evmOnly);
    expect([derived.agglayer.l1BridgeCode, derived.epoch.evmUsdc]).toEqual([{ state: 'absent' }, { state: 'absent' }]);
    expect(mockPublicClient.readContract).not.toHaveBeenCalled();
  });

  it('skips the EVM probes for a chain without a wallet RPC', async () => {
    const derived = await deriveBridgeConfig({
      ...TESTNET,
      evm: { chainId: 1 },
      agglayer: { l1Bridge: TESTNET.agglayer.l1Bridge },
      epoch: {}
    });
    expect(derived.agglayer.l1BridgeCode).toEqual(SKIPPED);
    expect(createPublicClient).not.toHaveBeenCalled();
  });

  it('fetches the health routes with the global fetch', async () => {
    const original = globalThis.fetch;
    const fetchSpy = jest.fn(async () => answer({ status: 'healthy' }));
    Object.defineProperty(globalThis, 'fetch', { value: fetchSpy, configurable: true, writable: true });
    try {
      const allocatorOnly: BridgeConfig = {
        ...TESTNET,
        evm: {},
        agglayer: {},
        epoch: { allocatorUrl: TESTNET.epoch.allocatorUrl }
      };
      expect((await deriveBridgeConfig(allocatorOnly)).epoch.allocator).toEqual({ state: 'ok', value: true });
      expect(fetchSpy).toHaveBeenCalledWith('https://testnet-dev.epochprotocol.xyz/health', expect.any(Object));
    } finally {
      Object.defineProperty(globalThis, 'fetch', { value: original, configurable: true, writable: true });
    }
  });
});

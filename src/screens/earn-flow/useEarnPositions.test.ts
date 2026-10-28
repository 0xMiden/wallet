import React from 'react';

import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig, useSWRConfig } from 'swr';

import { PageActiveContext } from 'app/layouts/page-active';
import type { EarnPositionsResult, EarnVaultInfo } from 'lib/epoch';
import { fetchEarnPositions, getEarnDepositEvmAddresses, positionsBudgetDelayMs } from 'lib/epoch';
import { fetchFromStorage } from 'lib/miden/front/storage';
import { clearStorage } from 'lib/miden/reset';
import { getStorageProvider } from 'lib/platform/storage-adapter';
import type { Probe } from 'lib/remote-config/derive';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import type { BridgeConfig, EarnVaultConfig } from 'lib/remote-config/schema';
import { bridgeConfigBaseUrl } from 'lib/remote-config/source';
import { annotateUiProducer } from 'lib/telemetry/ui-producer-diagnostics';

import { EARN_POSITIONS_STORAGE_PREFIX, earnItemLoadState, useEarnPositions } from './useEarnPositions';

const mockAccount: { publicKey: string; evmAddress?: string } = {
  publicKey: 'miden-account',
  evmAddress: '0xABCDEF'
};
const mockUseRetryableSWR = jest.fn();
const mockEarnDepositRows: Array<{
  type: string;
  accountId: string;
  initiatedAt: number;
  restoredFromBackup?: boolean;
  extraInputs: { protocol?: string; evmRecipient?: string; marketUid?: string };
}> = [];

jest.mock('lib/miden/repo', () => ({
  transactions: {
    filter: () => ({ toArray: async () => mockEarnDepositRows })
  }
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => mockAccount
}));

// The desktop store: localStorage, which a wallet reset wipes in this realm.
jest.mock('lib/platform', () => ({
  ...jest.requireActual<typeof import('lib/platform')>('lib/platform'),
  isMobile: () => false,
  isDesktop: () => true,
  isExtension: () => false
}));

// A wallet reset rediscovers the native asset over RPC.
jest.mock('lib/miden-chain/native-asset', () => ({
  resetNativeAssetCache: jest.fn(async () => {}),
  primeNativeAssetId: jest.fn()
}));

jest.mock('lib/epoch', () => {
  const positions = jest.requireActual<typeof import('lib/epoch/positions')>('lib/epoch/positions');
  const pools = jest.requireActual<typeof import('lib/epoch/pools-read')>('lib/epoch/pools-read');
  return {
    carryForward: positions.carryForward,
    positionsBudgetDelayMs: jest.fn(() => 0),
    EARN_LENDER_FAMILY_NAMES: pools.EARN_LENDER_FAMILY_NAMES,
    earnLenderFamily: pools.earnLenderFamily,
    earnVaultTakesDeposits: pools.earnVaultTakesDeposits,
    fetchEarnPositions: jest.fn(),
    getEarnDepositEvmAddresses: jest.fn()
  };
});

jest.mock('lib/swr', () => ({
  useRetryableSWR: (...args: unknown[]) => mockUseRetryableSWR(...args)
}));

// The realm's getters find both values, so only a hook that names what its own snapshot lacks reports an error.
jest.mock('lib/remote-config/values', () => {
  const actual = jest.requireActual<typeof import('lib/remote-config/values')>('lib/remote-config/values');
  return {
    ...actual,
    getEpochPositionsUrl: () => 'https://positions.test',
    getEarnMarket: () => ({
      marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
      protocolHash: '0x7a2ccf6fa10307c054284131a341a8d8cbd10ec7d3cc469fbf369c40fd86d0f9',
      underlying: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
      chainId: 11155111
    })
  };
});

const POSITIONS_URL = 'https://positions.test';
const MARKET_UID = 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';
// The document's entry for the market of the fixtures below.
const LISTING: EarnVaultConfig = {
  id: 'dummy-lending-sepolia-usdc',
  marketUid: 'dummy_lending:11155111:0xasset',
  name: 'Dummy Lending USDC',
  protocol: 'dummy-lending',
  depositsEnabled: true
};

// The catalogue's vault of the same market as the position.
const vault: EarnVaultInfo = {
  marketUid: 'DUMMY_LENDING:11155111:0xasset',
  lenderKey: 'DUMMY_LENDING',
  lenderFamily: 'DUMMY_LENDING',
  lenderName: 'Dummy Lending',
  marketName: 'Dummy Lending',
  logoUri: '',
  chainId: '11155111',
  underlying: { address: '0xasset', symbol: 'USDC', decimals: 6 },
  depositApr: 5,
  aprTotal: 5,
  canOpen: true,
  listing: LISTING
};

const SEPOLIA_ROUTE: BridgeConfig['supportedEvmChains'] = {
  sepolia: {
    chainId: 11155111,
    bridges: {
      epoch: {
        depositEnabled: true,
        withdrawalEnabled: true,
        tokens: { USDC: { contractAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69', outputs: [] } }
      }
    }
  }
};
const READY_CONFIG: BridgeConfig = {
  network: 'testnet',
  version: 1,
  'bridge-providers': { epoch: { positionsUrl: POSITIONS_URL }, agglayer: {}, usdcx: {} },
  supportedEvmChains: SEPOLIA_ROUTE,
  features: { earn: true, nearIntents: false },
  earn: { vaults: [LISTING] }
};
const READY: BridgeConfigSnapshot = {
  network: 'testnet',
  status: 'ready',
  config: READY_CONFIG,
  derived: {
    network: 'testnet',
    version: 1,
    derivedAt: 0,
    chains: {},
    agglayer: { indexer: { state: 'skipped' } },
    epoch: {
      allocator: { state: 'skipped' },
      midenUsdcFaucet: { state: 'skipped' },
      market: {
        state: 'ok',
        value: {
          marketUid: MARKET_UID,
          protocolHash: '0x7a2ccf6fa10307c054284131a341a8d8cbd10ec7d3cc469fbf369c40fd86d0f9',
          underlying: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
          chainId: 11155111
        }
      },
      vaults: { state: 'ok', value: [vault] }
    }
  },
  lastFetch: null
};
const LOADING: BridgeConfigSnapshot = {
  network: 'testnet',
  status: 'loading',
  config: null,
  derived: null,
  lastFetch: null
};
/** READY, with the derivation's vault catalogue answered as `vaults`. */
function withCatalog(vaults: Probe<EarnVaultInfo[]>): BridgeConfigSnapshot {
  if (!READY.derived) throw new Error('READY carries a derivation');
  return { ...READY, derived: { ...READY.derived, epoch: { ...READY.derived.epoch, vaults } } };
}
/** READY, with the Earn market read answered as `market`. */
function withMarketRead(market: NonNullable<BridgeConfigSnapshot['derived']>['epoch']['market']): BridgeConfigSnapshot {
  if (!READY.derived) throw new Error('READY carries a derivation');
  return { ...READY, derived: { ...READY.derived, epoch: { ...READY.derived.epoch, market } } };
}
let mockConfigSnapshot = READY;
const mockConfigListeners = new Set<() => void>();
const publishConfig = (next: BridgeConfigSnapshot) => {
  mockConfigSnapshot = next;
  mockConfigListeners.forEach(listener => listener());
};
jest.mock('lib/remote-config/use-feature-availability', () => {
  const { useSyncExternalStore } = jest.requireActual<typeof import('react')>('react');
  const subscribe = (listener: () => void) => {
    mockConfigListeners.add(listener);
    return () => {
      mockConfigListeners.delete(listener);
    };
  };
  return { useBridgeConfigSnapshot: () => useSyncExternalStore(subscribe, () => mockConfigSnapshot) };
});

const position = {
  owner: '0xabcdef',
  marketUid: 'DUMMY_LENDING:11155111:0xasset',
  lenderKey: 'DUMMY_LENDING',
  lenderName: 'Dummy Lending',
  chainId: '11155111',
  deposits: '10',
  withdrawable: '9.5',
  depositsUSD: 10,
  depositApr: 5,
  symbol: 'USDC',
  underlyingAddress: '0xasset',
  decimals: 6,
  priceUsd: 1
};

// No type: the hook no longer reads a result's `vaults`, and the empty list here only keeps it assignable while
// `fetchEarnPositions` still returns the field.
const liveResult = {
  positions: [position],
  vaults: [],
  totalDepositsUSD: 10,
  owners: ['0xabcdef'],
  errors: [{ owner: '0xother', error: 'owner unavailable' }]
};

// The SWR key of the fixtures' account on READY, and the storage key of its stored copy.
const KEY = ['earn-positions', 'miden-account', '0xABCDEF', 'testnet', POSITIONS_URL, '11155111'];
const STORAGE_KEY = EARN_POSITIONS_STORAGE_PREFIX + JSON.stringify(KEY);
const readStored = () => fetchFromStorage<{ at: number; result: EarnPositionsResult }>(STORAGE_KEY);

describe('useEarnPositions', () => {
  beforeEach(() => {
    mockEarnDepositRows.length = 0;
    jest.clearAllMocks();
    localStorage.clear();
    mockAccount.publicKey = 'miden-account';
    mockAccount.evmAddress = '0xABCDEF';
    mockConfigSnapshot = READY;
  });

  it.each([
    [
      'all failed with carried positions',
      ['owner-a'],
      [{ owner: 'owner-a', error: 'failed', stage: 'request' }],
      [position],
      'complete_failure',
      'request'
    ],
    [
      'one empty owner succeeded',
      ['owner-a', 'owner-b'],
      [{ owner: 'owner-a', error: 'failed', stage: 'response_decode' }],
      [],
      'partial_failure',
      'response_decode'
    ],
    [
      'legacy error has no owned stage',
      ['owner-a'],
      [{ owner: 'owner-a', error: 'failed' }],
      [],
      'complete_failure',
      'unrecorded'
    ],
    [
      'first displayed error owns its stage',
      ['owner-a', 'owner-b'],
      [
        { owner: 'owner-a', error: 'first', stage: 'position_decode' },
        { owner: 'owner-b', error: 'second', stage: 'request' }
      ],
      [],
      'complete_failure',
      'position_decode'
    ]
  ])('reports the matching closed load evidence when %s', (_name, owners, errors, positions, outcome, stage) => {
    mockUseRetryableSWR.mockReturnValue({ data: { ...liveResult, owners, errors, positions }, isLoading: false });
    const { result } = renderHook(() => useEarnPositions());
    expect(Reflect.get(result.current, 'errorDiagnostics')).toEqual({
      kind: 'earn_positions_load',
      earnPositionsLoadStage: stage,
      earnPositionsLoadOutcome: outcome
    });
  });

  it('reports the local configuration fallback without inventing a request', () => {
    mockConfigSnapshot = { ...READY, config: null };
    mockUseRetryableSWR.mockReturnValue({});
    const { result } = renderHook(() => useEarnPositions());
    expect(Reflect.get(result.current, 'errorDiagnostics')).toEqual({
      kind: 'earn_positions_load',
      earnPositionsLoadStage: 'configuration',
      earnPositionsLoadOutcome: 'complete_failure'
    });
    expect(fetchEarnPositions).not.toHaveBeenCalled();
  });

  it('uses only the selected rejection root and clears evidence after success', () => {
    const root = new Error('private-owner 0x1234 amount 1234.56');
    annotateUiProducer(root, 'earnPositionsLoadError', 'notice', {
      kind: 'earn_positions_load',
      earnPositionsLoadStage: 'owner_lookup',
      earnPositionsLoadOutcome: 'complete_failure'
    });
    mockUseRetryableSWR.mockReturnValue({ error: root });
    const { result, rerender } = renderHook(() => useEarnPositions());
    expect(Reflect.get(result.current, 'errorDiagnostics')).toEqual({
      kind: 'earn_positions_load',
      earnPositionsLoadStage: 'owner_lookup',
      earnPositionsLoadOutcome: 'complete_failure'
    });
    mockUseRetryableSWR.mockReturnValue({ data: { ...liveResult, errors: [] } });
    rerender();
    expect(Reflect.get(result.current, 'errorDiagnostics')).toBeUndefined();
  });

  it('reports complete failure for a rejected refresh with retained partial data', () => {
    const partial = {
      ...liveResult,
      owners: ['owner-a', 'owner-b'],
      errors: [{ owner: 'owner-a', error: 'first owner failed', stage: 'request' }]
    };
    mockUseRetryableSWR.mockReturnValue({ data: partial });
    const { result, rerender } = renderHook(() => useEarnPositions());
    expect(result.current.errorDiagnostics).toEqual({
      kind: 'earn_positions_load',
      earnPositionsLoadStage: 'request',
      earnPositionsLoadOutcome: 'partial_failure'
    });

    const root = new Error('private-owner 0x1234 amount 1234.56');
    annotateUiProducer(root, 'earnPositionsLoadError', 'notice', {
      kind: 'earn_positions_load',
      earnPositionsLoadStage: 'owner_lookup',
      earnPositionsLoadOutcome: 'complete_failure'
    });
    mockUseRetryableSWR.mockReturnValue({ data: partial, error: root });
    rerender();
    expect(result.current.error).toBe('first owner failed');
    expect(result.current.errorDiagnostics).toEqual({
      kind: 'earn_positions_load',
      earnPositionsLoadStage: 'request',
      earnPositionsLoadOutcome: 'complete_failure'
    });
  });

  it.each(['private primitive rejection', new Error('custom unobserved rejection')])(
    'does not invent a stage for an unobserved hook rejection',
    error => {
      mockUseRetryableSWR.mockReturnValue({ error });
      const { result } = renderHook(() => useEarnPositions());
      expect(Reflect.get(result.current, 'errorDiagnostics')).toEqual({
        kind: 'earn_positions_load',
        earnPositionsLoadStage: 'unrecorded',
        earnPositionsLoadOutcome: 'complete_failure'
      });
    }
  );

  it('maps live positions and vaults into display data', () => {
    mockUseRetryableSWR.mockReturnValue({ data: liveResult, isLoading: false });

    const { result } = renderHook(() => useEarnPositions());

    expect(result.current.positions).toHaveLength(1);
    expect(result.current.positions[0]).toMatchObject({
      owner: '0xabcdef',
      protocol: 'Dummy Lending',
      asset: 'USDC',
      network: 'Sepolia',
      amount: '$10.00'
    });
    expect(result.current.vaults[0]).toMatchObject({
      id: 'dummy-lending-sepolia-usdc',
      name: 'Dummy Lending USDC',
      protocol: 'Dummy Lending',
      fundingAsset: 'USDCx',
      apy: '5.00%',
      canOpen: true,
      info: vault
    });
    // The position links to the vault of its own market.
    expect(result.current.positions[0]?.vaultId).toBe(result.current.vaults[0]?.id);
    expect(result.current.summary).toMatchObject({
      totalDepositedUsd: 10,
      blendedApyPercent: 5
    });
    expect(result.current.error).toBe('owner unavailable');
    expect(result.current.isLoading).toBe(false);
  });

  it('takes the newest local deposit protocol for this account, owner, and market', async () => {
    const marketUid = 'AAVE_V3:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const unlisted = { ...position, owner: '0xabcDEF', marketUid, lenderKey: 'AAVE_V3', lenderName: 'Aave V3' };
    const row = (
      initiatedAt: number,
      protocol: string,
      owner: string,
      market: string,
      accountId = 'miden-account',
      restoredFromBackup = false
    ) => ({
      type: 'earn-deposit',
      accountId,
      initiatedAt,
      restoredFromBackup,
      extraInputs: { protocol, evmRecipient: owner, marketUid: market }
    });
    mockEarnDepositRows.push(
      row(10, 'dummy-lending', '0xabcdef', marketUid),
      row(30, 'aave', '0xAbCdEf', marketUid.toLowerCase()),
      row(20, '1delta', ' 0xABCDEF ', marketUid),
      row(40, 'dummy-lending', '0xabcdef', 'OTHER:8453:0x1'),
      row(50, '1delta', '0xabcdef', marketUid, 'other-account'),
      row(60, 'dummy-lending', '0xother', marketUid),
      row(70, '1delta', '0xabcdef', marketUid, 'miden-account', true)
    );
    mockUseRetryableSWR.mockReturnValue({
      data: { ...liveResult, positions: [unlisted], vaults: [] },
      isLoading: false
    });

    const { result } = renderHook(() => useEarnPositions());

    await waitFor(() => expect(result.current.positions[0]?.epochProtocol).toBe('1delta'));
    expect(result.current.positions[0]?.protocol).toBe('Aave V3');
  });

  it('keeps the document protocol ahead of a newer local deposit', async () => {
    mockEarnDepositRows.push({
      type: 'earn-deposit',
      accountId: 'miden-account',
      initiatedAt: 50,
      extraInputs: { protocol: '1delta', evmRecipient: '0xabcdef', marketUid: position.marketUid }
    });
    mockUseRetryableSWR.mockReturnValue({
      data: { ...liveResult, positions: [{ ...position, epochProtocol: 'dummy-lending' }] },
      isLoading: false
    });

    const { result } = renderHook(() => useEarnPositions());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.positions[0]).toMatchObject({ epochProtocol: 'dummy-lending' });
  });

  it('shows the vaults the current document lists, in its order and under its entry, and no other', () => {
    const other: EarnVaultInfo = {
      ...vault,
      marketUid: 'AAVE_V3:11155111:0xasset',
      lenderKey: 'AAVE_V3',
      lenderFamily: 'AAVE_V3',
      listing: { ...LISTING, id: 'aave-v3-sepolia-usdc', marketUid: 'aave_v3:11155111:0xasset', name: 'Aave' }
    };
    const unlisted: EarnVaultInfo = { ...vault, marketUid: 'EULER_V2:11155111:0xasset', lenderKey: 'EULER_V2' };
    const renamed = { ...LISTING, name: 'Dummy Lending (renamed)' };
    mockConfigSnapshot = {
      ...withCatalog({ state: 'ok', value: [vault, unlisted, other] }),
      config: { ...READY_CONFIG, earn: { vaults: [other.listing, renamed] } }
    };
    mockUseRetryableSWR.mockReturnValue({ data: liveResult, isLoading: false });

    const { result } = renderHook(() => useEarnPositions());

    expect(result.current.vaults.map(item => [item.id, item.name])).toEqual([
      ['aave-v3-sepolia-usdc', 'Aave'],
      ['dummy-lending-sepolia-usdc', 'Dummy Lending (renamed)']
    ]);
  });

  it("shows the derivation's vaults before any positions read lands", () => {
    mockUseRetryableSWR.mockReturnValue({ data: undefined, isLoading: true });

    const { result } = renderHook(() => useEarnPositions());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.vaults.map(item => item.id)).toEqual(['dummy-lending-sepolia-usdc']);
  });

  it.each<[string, BridgeConfigSnapshot]>([
    ['failed', withCatalog({ state: 'error', message: 'Epoch pools page 2 failed' })],
    ['not derived yet', { ...READY, derived: null }]
  ])('shows no vault and no load failure when the catalogue is %s', (_case, snapshot) => {
    mockConfigSnapshot = snapshot;
    mockUseRetryableSWR.mockReturnValue({ data: { ...liveResult, errors: [] }, isLoading: false });

    const { result } = renderHook(() => useEarnPositions());

    expect(result.current.vaults).toEqual([]);
    expect(result.current.positions).toHaveLength(1);
    expect(result.current.loadError).toBeUndefined();
    expect(result.current.error).toBeUndefined();
  });

  it('reports the vaults pending while the document lists vaults and no derivation settled their catalogue', () => {
    mockConfigSnapshot = { ...READY, derived: null };
    // The positions read lands first.
    mockUseRetryableSWR.mockReturnValue({ data: { ...liveResult, errors: [] }, isLoading: false });

    const { result } = renderHook(() => useEarnPositions());

    expect(result.current.isLoading).toBe(false);
    expect(result.current.vaults).toEqual([]);
    expect(result.current.vaultsPending).toBe(true);

    act(() => publishConfig(READY));
    expect(result.current.vaultsPending).toBe(false);
    expect(result.current.vaults.map(item => item.id)).toEqual(['dummy-lending-sepolia-usdc']);
  });

  it.each<[string, BridgeConfigSnapshot]>([
    ['read', READY],
    ['failed', withCatalog({ state: 'error', message: 'Epoch pools page 2 failed' })],
    ['skipped', withCatalog({ state: 'skipped' })],
    ['absent', withCatalog({ state: 'absent' })],
    ['loading with no document, which lists no vault', LOADING]
  ])('reports no pending vaults when the catalogue is %s', (_case, snapshot) => {
    mockConfigSnapshot = snapshot;
    mockUseRetryableSWR.mockReturnValue({ data: undefined, isLoading: true });

    const { result } = renderHook(() => useEarnPositions());

    expect(result.current.vaultsPending).toBe(false);
  });

  it("draws a listed vault's document logo on the vault and on a position in its market", () => {
    const listing = { ...LISTING, logo: 'icons/dummy-lending.svg' };
    mockConfigSnapshot = { ...READY, config: { ...READY_CONFIG, earn: { vaults: [listing] } } };
    mockUseRetryableSWR.mockReturnValue({ data: liveResult, isLoading: false });

    const { result } = renderHook(() => useEarnPositions());

    const expected = `${bridgeConfigBaseUrl('testnet')}/icons/dummy-lending.svg`;
    expect(result.current.vaults[0]?.logoUrl).toBe(expected);
    expect(result.current.positions[0]?.logoUrl).toBe(expected);
  });

  it('gives no logo URL to a vault whose listing names none, or to a position in an unlisted market', () => {
    mockUseRetryableSWR.mockReturnValue({
      data: { ...liveResult, positions: [position, { ...position, marketUid: 'AAVE_V3:11155111:0xasset' }] },
      isLoading: false
    });

    const { result } = renderHook(() => useEarnPositions());

    expect(result.current.vaults[0]).not.toHaveProperty('logoUrl');
    expect(result.current.positions.map(item => item.logoUrl)).toEqual([undefined, undefined]);
  });

  it('reports a per-owner positions error as error only, never as a request failure', () => {
    mockUseRetryableSWR.mockReturnValue({ data: liveResult, isLoading: false });

    const { result } = renderHook(() => useEarnPositions());

    expect(result.current.vaults).toHaveLength(1);
    expect(result.current.error).toBe('owner unavailable');
    // Present and unset: the hook exposes loadError, and an owner's failure is not a request failure.
    expect(result.current).toHaveProperty('loadError', undefined);
  });

  it('reports no failed load when every owner failed', () => {
    const twoOwners = { ...liveResult, owners: ['0xabcdef', '0xother'] };
    const bothFailed = [...liveResult.errors, { owner: '0xabcdef', error: 'positions request failed (429)' }];
    mockUseRetryableSWR.mockReturnValue({ data: { ...twoOwners, errors: bothFailed }, isLoading: false });
    const { result } = renderHook(() => useEarnPositions());

    // The catalogue does not come from the owners: the vaults are current, and the positions report the failure.
    expect(result.current.vaults).toHaveLength(1);
    expect(result.current.loadError).toBeUndefined();
    expect(result.current.error).toBe('owner unavailable');
  });

  it('reports a request failure as both loadError and error', () => {
    mockUseRetryableSWR.mockReturnValue({ data: undefined, isLoading: false, error: new Error('owner lookup failed') });

    const { result } = renderHook(() => useEarnPositions());

    expect(result.current.loadError).toBe('owner lookup failed');
    expect(result.current.error).toBe('owner lookup failed');
  });

  it('returns empty lists and a summary with no figures yet before the first response', () => {
    mockUseRetryableSWR.mockReturnValue({ data: undefined, isLoading: true });

    const { result } = renderHook(() => useEarnPositions());

    expect(result.current.positions).toEqual([]);
    // Not zeros: a zero is a value, and the summary would count up from it when the read lands.
    expect(result.current.summary).toEqual({
      totalRewardsUsd: null,
      blendedApyPercent: null,
      totalDepositedUsd: null,
      estimatedRewardsUsd: null
    });
    expect(result.current.error).toBeUndefined();
    expect(result.current.loadError).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
  });

  it('reports zeros once a completed read finds no positions', () => {
    mockUseRetryableSWR.mockReturnValue({
      data: { positions: [], totalDepositsUSD: 0, owners: [], errors: [] },
      isLoading: false
    });

    const { result } = renderHook(() => useEarnPositions());

    expect(result.current.summary).toEqual({
      totalRewardsUsd: 0,
      blendedApyPercent: 0,
      totalDepositedUsd: 0,
      estimatedRewardsUsd: 0
    });
  });

  it('loads every historical owner plus the lowercased wallet address once', async () => {
    let loadPositions: (() => Promise<EarnPositionsResult>) | undefined;
    let receivedKey: unknown;
    let receivedConfig: unknown;
    mockUseRetryableSWR.mockImplementation(
      (key: unknown, fetcher: () => Promise<EarnPositionsResult>, config: unknown) => {
        receivedKey = key;
        loadPositions = fetcher;
        receivedConfig = config;
        return { data: undefined, isLoading: true };
      }
    );
    jest.mocked(getEarnDepositEvmAddresses).mockResolvedValue(['0xabcdef', '0xhistorical']);
    jest.mocked(fetchEarnPositions).mockResolvedValue(liveResult);

    renderHook(() => useEarnPositions());

    // The first render's, before the fetcher records a read. The mocked tests share SWR's default cache, and so the
    // hook's record of it, so no later one may assume this key has none.
    expect(receivedConfig).toEqual({
      revalidateIfStale: true,
      refreshInterval: 0,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 3_000,
      shouldRetryOnError: false
    });
    if (!loadPositions) throw new Error('positions fetcher was not registered');
    await loadPositions();

    expect(receivedKey).toEqual(KEY);
    expect(getEarnDepositEvmAddresses).toHaveBeenCalledWith('miden-account');
    expect(fetchEarnPositions).toHaveBeenCalledWith({
      accountId: 'miden-account',
      owners: ['0xabcdef', '0xhistorical']
    });

    // A covered page holds a null key, not a paused one.
    renderHook(() => useEarnPositions(), {
      wrapper: ({ children }: { children: React.ReactNode }) =>
        React.createElement(PageActiveContext.Provider, { value: false }, children)
    });
    expect(receivedKey).toBeNull();
    // The read above stored its result, which this mount shows once its storage read lands.
    await act(() => new Promise(resolve => setTimeout(resolve, 0)));
  });

  it('uses only historical owners when the wallet has no derived EVM address', async () => {
    let loadPositions: (() => Promise<EarnPositionsResult>) | undefined;
    mockAccount.evmAddress = undefined;
    mockUseRetryableSWR.mockImplementation((_key: unknown, fetcher: () => Promise<EarnPositionsResult>) => {
      loadPositions = fetcher;
      return { data: undefined, isLoading: false };
    });
    jest.mocked(getEarnDepositEvmAddresses).mockResolvedValue(['0xhistorical']);
    jest.mocked(fetchEarnPositions).mockResolvedValue(liveResult);

    renderHook(() => useEarnPositions());

    if (!loadPositions) throw new Error('positions fetcher was not registered');
    await loadPositions();

    expect(fetchEarnPositions).toHaveBeenCalledWith({
      accountId: 'miden-account',
      owners: ['0xhistorical']
    });
  });

  describe('before the config names the positions host, with the real SWR', () => {
    const realSWR = jest.requireActual('lib/swr').useRetryableSWR;
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);

    it('reads nothing and shows no error, then reads at once when the config lands', async () => {
      mockUseRetryableSWR.mockImplementation(realSWR);
      jest.mocked(getEarnDepositEvmAddresses).mockResolvedValue([]);
      jest.mocked(fetchEarnPositions).mockImplementation(async () => {
        if (!mockConfigSnapshot.config) throw new Error('The bridge config has no usable epoch.positionsUrl.');
        return liveResult;
      });
      publishConfig(LOADING);
      const { result } = renderHook(() => useEarnPositions(), { wrapper });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      expect(getEarnDepositEvmAddresses).not.toHaveBeenCalled();
      expect(fetchEarnPositions).not.toHaveBeenCalled();
      expect(result.current.error).toBeUndefined();
      expect(result.current.isLoading).toBe(true);

      act(() => publishConfig(READY));
      await waitFor(() => expect(result.current.positions).toHaveLength(1));
      expect(fetchEarnPositions).toHaveBeenCalledTimes(1);
    });

    it.each<[string, BridgeConfig | null, string]>([
      ['names no config', null, 'The bridge config has no usable epoch.positionsUrl.'],
      [
        'names no positions host',
        { ...READY_CONFIG, 'bridge-providers': { ...READY_CONFIG['bridge-providers'], epoch: {} } },
        'The bridge config has no usable epoch.positionsUrl.'
      ],
      [
        'names the positions host but no Epoch route',
        { ...READY_CONFIG, supportedEvmChains: {} },
        'The bridge config has no usable Epoch route.'
      ],
      [
        'names an Epoch route but lists no Earn vault',
        { ...READY_CONFIG, features: { earn: false, nearIntents: false }, earn: undefined },
        'The bridge config has no usable Earn vault.'
      ]
    ])(
      'settles at once as a failed load, reading nothing, when a loaded snapshot %s',
      async (_case, config, message) => {
        mockUseRetryableSWR.mockImplementation(realSWR);
        publishConfig({ ...READY, config });
        const { result } = renderHook(() => useEarnPositions(), { wrapper });
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 0));
        });
        expect(result.current.loadError).toBe(message);
        expect(result.current.error).toBe(message);
        expect(result.current.isLoading).toBe(false);
        expect(getEarnDepositEvmAddresses).not.toHaveBeenCalled();
        expect(fetchEarnPositions).not.toHaveBeenCalled();
      }
    );

    // Only the document says what the network configures: a snapshot with no accepted document keeps the error and its
    // Retry, and no derived value (a market read skipped or failed, no derivation at all) decides it.
    it.each<[string, BridgeConfigSnapshot, boolean]>([
      ['no accepted document, a config outage', { ...READY, config: null, derived: null }, false],
      [
        'a document with no positions host',
        {
          ...READY,
          config: { ...READY_CONFIG, 'bridge-providers': { ...READY_CONFIG['bridge-providers'], epoch: {} } }
        },
        true
      ],
      ['a document with no Epoch route', { ...READY, config: { ...READY_CONFIG, supportedEvmChains: {} } }, true],
      [
        'a document that lists no Earn vault',
        { ...READY, config: { ...READY_CONFIG, features: { earn: false, nearIntents: false }, earn: undefined } },
        true
      ],
      ['a configured document with no derivation yet', { ...READY, derived: null }, false],
      ['a configured document whose market read was skipped', withMarketRead({ state: 'skipped' }), false],
      ['a market read that failed', withMarketRead({ state: 'error', message: 'positions 503' }), false],
      ['a configured document', READY, false],
      ['a snapshot still loading', LOADING, false]
    ])(
      'reports Earn as not on this network only when its document configures none: %s',
      async (_case, snapshot, expected) => {
        mockUseRetryableSWR.mockImplementation(realSWR);
        jest.mocked(getEarnDepositEvmAddresses).mockResolvedValue([]);
        jest.mocked(fetchEarnPositions).mockRejectedValue(new Error('positions 503'));
        publishConfig(snapshot);
        const { result } = renderHook(() => useEarnPositions(), { wrapper });
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 0));
        });
        expect(result.current.notOnNetwork).toBe(expected);
      }
    );

    it('reads again at once when the config moves the positions host', async () => {
      mockUseRetryableSWR.mockImplementation(realSWR);
      jest.mocked(getEarnDepositEvmAddresses).mockResolvedValue([]);
      jest.mocked(fetchEarnPositions).mockResolvedValue(liveResult);
      const { result } = renderHook(() => useEarnPositions(), { wrapper });
      await waitFor(() => expect(result.current.positions).toHaveLength(1));
      const moved = {
        ...READY_CONFIG,
        'bridge-providers': { ...READY_CONFIG['bridge-providers'], epoch: { positionsUrl: 'https://moved.test' } }
      };
      act(() => publishConfig({ ...READY, config: moved }));
      await waitFor(() => expect(fetchEarnPositions).toHaveBeenCalledTimes(2));
    });

    it('reads from the document alone, before any derivation lands', async () => {
      mockUseRetryableSWR.mockImplementation(realSWR);
      jest.mocked(getEarnDepositEvmAddresses).mockResolvedValue([]);
      jest.mocked(fetchEarnPositions).mockResolvedValue(liveResult);
      publishConfig({ ...READY, derived: null });
      const { result } = renderHook(() => useEarnPositions(), { wrapper });

      await waitFor(() => expect(result.current.positions).toHaveLength(1));
      expect(fetchEarnPositions).toHaveBeenCalledTimes(1);
      expect(result.current.notOnNetwork).toBe(false);
      // The vaults wait for the derivation's catalogue; the positions do not.
      expect(result.current.vaults).toEqual([]);

      act(() => publishConfig(READY));
      expect(result.current.vaults).toHaveLength(1);
      // The key names no derived value, so the derivation landing reads nothing again.
      expect(fetchEarnPositions).toHaveBeenCalledTimes(1);
    });
  });

  describe('across an account switch, with the real SWR', () => {
    const realSWR = jest.requireActual('lib/swr').useRetryableSWR;
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);

    afterEach(() => {
      mockAccount.publicKey = 'miden-account';
      mockAccount.evmAddress = '0xABCDEF';
    });

    it("never shows the previous account's positions while the next account's load is pending", async () => {
      mockUseRetryableSWR.mockImplementation(realSWR);
      jest.mocked(getEarnDepositEvmAddresses).mockResolvedValue([]);
      jest.mocked(fetchEarnPositions).mockResolvedValueOnce(liveResult);
      const { result, rerender } = renderHook(() => useEarnPositions(), { wrapper });
      await waitFor(() => expect(result.current.positions).toHaveLength(1));

      jest.mocked(fetchEarnPositions).mockReturnValueOnce(new Promise(() => undefined));
      mockAccount.publicKey = 'another-account';
      mockAccount.evmAddress = '0x123456';
      rerender();

      expect(result.current.positions).toEqual([]);
      expect(result.current.isLoading).toBe(true);
    });
  });

  describe('on and off screen, with the real SWR', () => {
    type Earn = ReturnType<typeof useEarnPositions>;
    const realSWR = jest.requireActual('lib/swr').useRetryableSWR;

    function Probe({ report }: { report: (earn: Earn) => void }) {
      report(useEarnPositions());
      return null;
    }
    const page = (onScreen: boolean, report: (earn: Earn) => void) =>
      React.createElement(PageActiveContext.Provider, { value: onScreen }, React.createElement(Probe, { report }));

    beforeEach(() => {
      mockUseRetryableSWR.mockImplementation(realSWR);
      jest.mocked(getEarnDepositEvmAddresses).mockResolvedValue([]);
    });

    it('reloads the remaining position on return after a receipt invalidated its cached balance', async () => {
      const initial = { ...liveResult, positions: [position], errors: [] };
      jest.mocked(fetchEarnPositions).mockResolvedValue(initial);
      const cache = new Map();
      let visible = true;
      const { result, rerender } = renderHook(() => ({ earn: useEarnPositions(), mutate: useSWRConfig().mutate }), {
        wrapper: ({ children }: { children: React.ReactNode }) =>
          React.createElement(
            SWRConfig,
            { value: { provider: () => cache } },
            React.createElement(PageActiveContext.Provider, { value: visible }, children)
          )
      });
      await waitFor(() => expect(result.current.earn.positions[0]?.withdrawable).toBe('9.5'));
      visible = false;
      rerender();
      jest
        .mocked(fetchEarnPositions)
        .mockResolvedValue({ ...initial, positions: [{ ...position, deposits: '7.75', withdrawable: '7.25' }] });
      await act(async () => {
        await result.current.mutate(
          key => Array.isArray(key) && key[0] === 'earn-positions' && key[1] === mockAccount.publicKey,
          undefined,
          { revalidate: true }
        );
      });
      visible = true;
      rerender();
      await waitFor(() => expect(result.current.earn.positions[0]?.withdrawable).toBe('7.25'));
      expect(result.current.earn.positions[0]?.stale).toBe(false);
    });

    it('retries on the page that is showing when a covered page of the same account mounted first', async () => {
      jest.mocked(getEarnDepositEvmAddresses).mockRejectedValueOnce(new Error('lookup down'));
      jest.mocked(fetchEarnPositions).mockResolvedValue(liveResult);
      // One cache for both, as the app's pages share one: the covered Earn pane under a slide earn page.
      const cache = new Map();
      let showing: Earn | undefined;
      await act(async () => {
        render(
          React.createElement(
            SWRConfig,
            { value: { provider: () => cache } },
            page(false, () => undefined),
            page(true, earn => (showing = earn))
          )
        );
      });
      await waitFor(() => expect(showing?.loadError).toBe('lookup down'));
      expect(getEarnDepositEvmAddresses).toHaveBeenCalledTimes(1);

      await act(async () => showing?.refetch());
      await waitFor(() => expect(getEarnDepositEvmAddresses).toHaveBeenCalledTimes(2));
    });

    // One hook whose page each test puts on or off screen, in a cache of its own.
    let onScreen = true;
    const renderOnPage = () => {
      const cache = new Map();
      return renderHook(() => useEarnPositions(), {
        wrapper: ({ children }: { children: React.ReactNode }) =>
          React.createElement(
            SWRConfig,
            { value: { provider: () => cache } },
            React.createElement(PageActiveContext.Provider, { value: onScreen }, children)
          )
      });
    };
    // Past the hook's own 3 s dedupe window, so a read again is SWR revalidating a key that comes back.
    const pastDedupe = () => act(() => new Promise(resolve => setTimeout(resolve, 3_100)));
    const settle = () => act(() => new Promise(resolve => setTimeout(resolve, 100)));
    beforeEach(() => {
      onScreen = true;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('never reads while its page is covered', async () => {
      onScreen = false;
      await act(async () => {
        renderOnPage();
      });

      expect(getEarnDepositEvmAddresses).not.toHaveBeenCalled();
      expect(fetchEarnPositions).not.toHaveBeenCalled();
    });

    it('reads again once when its page comes back into view, whatever the age of its last read', async () => {
      jest.mocked(fetchEarnPositions).mockResolvedValue(liveResult);
      const { result, rerender } = renderOnPage();
      await waitFor(() => expect(result.current.positions).toHaveLength(1));
      expect(fetchEarnPositions).toHaveBeenCalledTimes(1);

      onScreen = false;
      rerender();
      await pastDedupe();
      onScreen = true;
      rerender();
      await waitFor(() => expect(fetchEarnPositions).toHaveBeenCalledTimes(2));
      await settle();
      expect(fetchEarnPositions).toHaveBeenCalledTimes(2);
    }, 10_000);

    it('reads again once when another Earn page mounts past the dedupe window', async () => {
      jest.mocked(fetchEarnPositions).mockResolvedValue(liveResult);
      const cache = new Map();
      let first: Earn | undefined;
      const pages = (second: boolean) =>
        React.createElement(
          SWRConfig,
          { value: { provider: () => cache } },
          page(true, earn => (first = earn)),
          second ? page(true, () => undefined) : null
        );
      const { rerender } = render(pages(false));
      await waitFor(() => expect(first?.positions).toHaveLength(1));
      expect(fetchEarnPositions).toHaveBeenCalledTimes(1);

      await pastDedupe();
      rerender(pages(true));
      await waitFor(() => expect(fetchEarnPositions).toHaveBeenCalledTimes(2));
      await settle();
      expect(fetchEarnPositions).toHaveBeenCalledTimes(2);
    }, 10_000);

    it('reads nothing on a reconnect', async () => {
      jest.mocked(fetchEarnPositions).mockResolvedValue(liveResult);
      const { result } = renderOnPage();
      await waitFor(() => expect(result.current.positions).toHaveLength(1));
      expect(fetchEarnPositions).toHaveBeenCalledTimes(1);

      await pastDedupe();
      act(() => {
        window.dispatchEvent(new Event('online'));
      });
      await settle();
      expect(fetchEarnPositions).toHaveBeenCalledTimes(1);
    }, 10_000);

    it('reads again when its page comes back after a load that failed before any request', async () => {
      jest.mocked(getEarnDepositEvmAddresses).mockRejectedValueOnce(new Error('lookup down'));
      jest.mocked(fetchEarnPositions).mockResolvedValue(liveResult);
      const { result, rerender } = renderOnPage();
      await waitFor(() => expect(result.current.loadError).toBe('lookup down'));
      expect(getEarnDepositEvmAddresses).toHaveBeenCalledTimes(1);

      onScreen = false;
      rerender();
      await pastDedupe();
      onScreen = true;
      rerender();
      await waitFor(() => expect(getEarnDepositEvmAddresses).toHaveBeenCalledTimes(2));
    }, 10_000);

    it('keeps showing what it loaded while its page is covered', async () => {
      jest.mocked(fetchEarnPositions).mockResolvedValue(liveResult);
      const { result, rerender } = renderOnPage();
      await waitFor(() => expect(result.current.positions).toHaveLength(1));

      onScreen = false;
      rerender();

      expect(result.current.positions).toHaveLength(1);
      expect(result.current.vaults).toHaveLength(1);
      expect(result.current.isLoading).toBe(false);
    });

    it('keeps showing its error while its page is covered', async () => {
      jest.mocked(getEarnDepositEvmAddresses).mockRejectedValueOnce(new Error('lookup down'));
      const { result, rerender } = renderOnPage();
      await waitFor(() => expect(result.current.loadError).toBe('lookup down'));

      onScreen = false;
      rerender();

      expect(result.current.loadError).toBe('lookup down');
      expect(result.current.isLoading).toBe(false);
    });

    it("never shows the previous account's error once the account switches", async () => {
      jest
        .mocked(getEarnDepositEvmAddresses)
        .mockRejectedValueOnce(new Error('lookup down'))
        .mockReturnValueOnce(new Promise(() => undefined));
      const { result, rerender } = renderOnPage();
      await waitFor(() => expect(result.current.loadError).toBe('lookup down'));

      mockAccount.publicKey = 'another-account';
      mockAccount.evmAddress = '0x123456';
      rerender();

      expect(result.current.loadError).toBeUndefined();
      expect(result.current.isLoading).toBe(true);
    });

    it('reads as loading, not empty, when mounted on a covered page', () => {
      onScreen = false;
      const { result } = renderOnPage();

      expect(result.current.isLoading).toBe(true);
    });

    describe('on a fake clock', () => {
      // Every read starts with the owner lookup, so its calls count the reads.
      const reads = () => jest.mocked(getEarnDepositEvmAddresses).mock.calls.length;
      // Moves the clock, and SWR's timers and the hook's with it, settling every read that starts on the way.
      const advance = (ms: number) => act(() => jest.advanceTimersByTimeAsync(ms));

      beforeEach(() => {
        jest.useFakeTimers();
        jest.mocked(positionsBudgetDelayMs).mockImplementation(() => 0);
        jest.mocked(fetchEarnPositions).mockResolvedValue(liveResult);
      });

      afterEach(() => {
        cleanup();
        jest.useRealTimers();
      });

      it('polls 10 s after the last read began, not sooner', async () => {
        renderOnPage();
        await advance(0);
        expect(reads()).toBe(1);

        await advance(9_900);
        expect(reads()).toBe(1);
        await advance(200);
        expect(reads()).toBe(2);
      });

      it('keeps two-owner polling and a page return inside ten requests per minute', async () => {
        const starts: number[] = [];
        let budget!: typeof import('lib/epoch/positions');
        await jest.isolateModulesAsync(async () => {
          budget = await import('lib/epoch/positions');
        });
        jest.mocked(positionsBudgetDelayMs).mockImplementation(budget.positionsBudgetDelayMs);
        jest.mocked(getEarnDepositEvmAddresses).mockResolvedValue(['0x1111111111111111111111111111111111111111']);
        jest.mocked(fetchEarnPositions).mockImplementation(async args => {
          budget.notePositionsRequests(args?.owners?.length ?? 1);
          starts.push(...(args?.owners ?? []).map(() => Date.now()));
          return liveResult;
        });
        const beganAt = Date.now();
        const { rerender } = renderOnPage();
        await advance(5_000);
        onScreen = false;
        rerender();
        await advance(100);
        onScreen = true;
        rerender();
        await advance(100);
        expect(starts).toHaveLength(4);

        await advance(54_800);
        const inWindow = starts.filter(at => at >= beganAt && at < beganAt + 60_000).length;
        if (inWindow > 10) throw new Error(`positions budget exceeded: ${inWindow} owner requests in 60000ms`);
      });

      it('a Retry moves the next poll to 10 s after it', async () => {
        const { result } = renderOnPage();
        await advance(0);
        expect(result.current.error).toBe('owner unavailable');

        await advance(6_000);
        act(() => result.current.refetch());
        await advance(0);
        expect(reads()).toBe(2);

        await advance(9_900);
        expect(reads()).toBe(2);
        await advance(200);
        expect(reads()).toBe(3);
      });

      it('a failed read is retried 10 s after it began, and nothing sooner', async () => {
        // SWR's first error retry, were it on, would wait a random share of its interval; this pins it at 2x.
        jest.spyOn(Math, 'random').mockReturnValue(0.9);
        jest.mocked(getEarnDepositEvmAddresses).mockRejectedValueOnce(new Error('lookup down'));
        const { result } = renderOnPage();
        await advance(0);
        expect(result.current.loadError).toBe('lookup down');

        await advance(9_900);
        expect(reads()).toBe(1);
        await advance(200);
        expect(reads()).toBe(2);
      });

      it('no automatic read while the document is hidden', async () => {
        const visibility = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        renderOnPage();
        await advance(0);

        await advance(90_000);
        expect(reads()).toBe(1);

        visibility.mockReturnValue('visible');
        await advance(10_000);
        expect(reads()).toBe(2);
      });

      it('no automatic read while the device is offline', async () => {
        const online = jest.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        renderOnPage();
        await advance(0);

        await advance(90_000);
        expect(reads()).toBe(1);

        online.mockReturnValue(true);
        await advance(10_000);
        expect(reads()).toBe(2);
      });

      it('no automatic read while its page is covered', async () => {
        const { rerender } = renderOnPage();
        await advance(3_400);
        expect(reads()).toBe(1);

        onScreen = false;
        rerender();
        await advance(90_000);
        expect(reads()).toBe(1);
        // And no timer left waiting to start one.
        expect(jest.getTimerCount()).toBe(0);

        // Back on screen a read begins and re-arms every hook registered for the key; covered again, none is left.
        onScreen = true;
        rerender();
        await advance(0);
        expect(reads()).toBe(2);

        onScreen = false;
        rerender();
        await advance(3_100);
        expect(jest.getTimerCount()).toBe(0);
      });

      it('an unmounted page starts no read', async () => {
        const cache = new Map();
        let showing: Earn | undefined;
        const pages = (both: boolean) =>
          React.createElement(
            SWRConfig,
            { value: { provider: () => cache } },
            both ? page(true, () => undefined) : null,
            page(true, earn => (showing = earn))
          );
        const { rerender, unmount } = render(pages(true));
        await advance(3_400);
        expect(reads()).toBe(1);

        rerender(pages(false));
        await advance(3_400);
        act(() => showing?.refetch());
        await advance(0);
        expect(reads()).toBe(2);

        await advance(3_400);
        expect(reads()).toBe(2);
        await advance(6_700);
        expect(reads()).toBe(3);

        // The remaining page leaves too, after reads that re-armed every hook registered for the key: none is left.
        unmount();
        await advance(3_100);
        expect(jest.getTimerCount()).toBe(0);
      });

      it('an account switch re-arms from the new key', async () => {
        const { rerender } = renderOnPage();
        await advance(3_400);
        expect(reads()).toBe(1);

        mockAccount.publicKey = 'another-account';
        mockAccount.evmAddress = '0x123456';
        rerender();
        await advance(0);
        expect(reads()).toBe(2);
        expect(getEarnDepositEvmAddresses).toHaveBeenLastCalledWith('another-account');

        await advance(9_900);
        expect(reads()).toBe(2);
        await advance(200);
        expect(reads()).toBe(3);
      });
    });
  });

  describe('a retry after a failed load, with the real SWR', () => {
    const realSWR = jest.requireActual('lib/swr').useRetryableSWR;
    const renderInCache = () => {
      const cache = new Map();
      return renderHook(() => useEarnPositions(), {
        wrapper: ({ children }: { children: React.ReactNode }) =>
          React.createElement(SWRConfig, { value: { provider: () => cache } }, children)
      });
    };

    beforeEach(() => {
      mockUseRetryableSWR.mockImplementation(realSWR);
      jest.mocked(getEarnDepositEvmAddresses).mockResolvedValue([]);
    });

    it('keeps the error and reports no loading while the retry is out', async () => {
      jest
        .mocked(getEarnDepositEvmAddresses)
        .mockRejectedValueOnce(new Error('lookup down'))
        .mockReturnValue(new Promise(() => undefined));
      const { result } = renderInCache();
      await waitFor(() => expect(result.current.loadError).toBe('lookup down'));

      await act(async () => result.current.refetch());
      await waitFor(() => expect(getEarnDepositEvmAddresses).toHaveBeenCalledTimes(2));

      // SWR's own isLoading is true here (a read out, no data): the hook's is not, since an error is kept.
      expect(result.current.isLoading).toBe(false);
      expect(result.current.loadError).toBe('lookup down');
    });

    it('sends no second request when Retry is tapped again while its read is out', async () => {
      jest
        .mocked(getEarnDepositEvmAddresses)
        .mockRejectedValueOnce(new Error('lookup down'))
        .mockReturnValue(new Promise(() => undefined));
      const { result } = renderInCache();
      await waitFor(() => expect(result.current.loadError).toBe('lookup down'));

      await act(async () => result.current.refetch());
      await waitFor(() => expect(getEarnDepositEvmAddresses).toHaveBeenCalledTimes(2));
      await act(async () => result.current.refetch());
      await act(() => new Promise(resolve => setTimeout(resolve, 50)));

      expect(getEarnDepositEvmAddresses).toHaveBeenCalledTimes(2);
    });

    it('keeps what its sole owner last loaded when a Retry finds it failed, stale until a read loads it', async () => {
      jest
        .mocked(fetchEarnPositions)
        .mockResolvedValueOnce(liveResult)
        .mockResolvedValueOnce({
          ...liveResult,
          positions: [],
          totalDepositsUSD: 0,
          errors: [{ owner: '0xabcdef', error: 'positions request failed (429)' }]
        })
        .mockResolvedValueOnce({ ...liveResult, errors: [] });
      const { result } = renderInCache();
      await waitFor(() => expect(result.current.positions).toHaveLength(1));

      await act(async () => result.current.refetch());
      await waitFor(() => expect(result.current.error).toBe('positions request failed (429)'));

      expect(result.current.positions).toHaveLength(1);
      expect(result.current.loadError).toBeUndefined();
      expect(result.current.positions[0]?.stale).toBe(true);

      await act(async () => result.current.refetch());
      await waitFor(() => expect(result.current.error).toBeUndefined());
      expect(result.current.positions[0]?.stale).toBe(false);
    });

    it('marks what it keeps under a failed read stale until a read loads', async () => {
      jest.mocked(fetchEarnPositions).mockResolvedValue(liveResult);
      const { result } = renderInCache();
      await waitFor(() => expect(result.current.positions).toHaveLength(1));

      jest.mocked(getEarnDepositEvmAddresses).mockRejectedValueOnce(new Error('lookup down'));
      await act(async () => result.current.refetch());
      await waitFor(() => expect(result.current.loadError).toBe('lookup down'));

      expect(result.current.positions).toHaveLength(1);
      expect(result.current.positions[0]?.stale).toBe(true);

      await act(async () => result.current.refetch());
      await waitFor(() => expect(result.current.loadError).toBeUndefined());
      expect(result.current.positions[0]?.stale).toBe(false);
    });
  });

  describe('the stored copy of the last read, with the real SWR', () => {
    const realSWR = jest.requireActual('lib/swr').useRetryableSWR;
    // A fresh cache per mount: a new realm, as every extension popup open is.
    const renderCold = () => {
      const cache = new Map();
      return renderHook(() => useEarnPositions(), {
        wrapper: ({ children }: { children: React.ReactNode }) =>
          React.createElement(SWRConfig, { value: { provider: () => cache } }, children)
      });
    };
    const storedResult = { ...liveResult, errors: [] };
    const laterResult = { ...liveResult, positions: [{ ...position, withdrawable: '7.25' }], errors: [] };
    // A read the test settles.
    const pendingRead = () => {
      let settle: (result: EarnPositionsResult) => void = () => undefined;
      jest.mocked(fetchEarnPositions).mockReturnValueOnce(
        new Promise(resolve => {
          settle = resolve;
        })
      );
      return (result: EarnPositionsResult) => settle(result);
    };

    beforeEach(() => {
      mockUseRetryableSWR.mockImplementation(realSWR);
      jest.mocked(getEarnDepositEvmAddresses).mockResolvedValue([]);
    });

    it('paints the stored read at once on a cold mount, every position stale, and reads at once', async () => {
      await getStorageProvider().set({ [STORAGE_KEY]: { at: Date.now(), result: storedResult } });
      const settleRead = pendingRead();

      const { result } = renderCold();

      await waitFor(() => expect(result.current.positions).toHaveLength(1));
      expect(result.current.isLoading).toBe(false);
      expect(result.current.positions[0]).toMatchObject({ withdrawable: '9.5', stale: true });
      expect(result.current.summary.totalDepositedUsd).toBe(10);
      expect(result.current.error).toBeUndefined();
      // Its read began at mount, although the stored copy is less than 10 s old.
      expect(fetchEarnPositions).toHaveBeenCalledTimes(1);

      await act(async () => settleRead(laterResult));
      await waitFor(() => expect(result.current.positions[0]?.withdrawable).toBe('7.25'));
      expect(result.current.positions[0]?.stale).toBe(false);
    });

    it('replaces the stored copy on every successful read, without its errors', async () => {
      jest.mocked(fetchEarnPositions).mockResolvedValueOnce(liveResult);
      const { result } = renderCold();
      await waitFor(() => expect(result.current.positions).toHaveLength(1));
      await waitFor(async () => expect((await readStored())?.result.positions[0]?.withdrawable).toBe('9.5'));
      expect((await readStored())?.result.errors).toEqual([]);

      jest.mocked(fetchEarnPositions).mockResolvedValueOnce(laterResult);
      await act(async () => result.current.refetch());
      await waitFor(async () => expect((await readStored())?.result.positions[0]?.withdrawable).toBe('7.25'));
    });

    it('keeps the stored copy when a read fails, and shows it stale beside the failure', async () => {
      const stored = { at: 1, result: storedResult };
      await getStorageProvider().set({ [STORAGE_KEY]: stored });
      jest.mocked(getEarnDepositEvmAddresses).mockRejectedValueOnce(new Error('lookup down'));

      const { result } = renderCold();

      await waitFor(() => expect(result.current.loadError).toBe('lookup down'));
      await waitFor(() => expect(result.current.positions).toHaveLength(1));
      expect(result.current.positions[0]?.stale).toBe(true);
      expect(await readStored()).toEqual(stored);
    });

    it("carries a failed owner's positions from the stored copy on a cold mount", async () => {
      await getStorageProvider().set({ [STORAGE_KEY]: { at: 1, result: storedResult } });
      const settleRead = pendingRead();
      const { result } = renderCold();
      await waitFor(() => expect(result.current.positions).toHaveLength(1));

      await act(async () =>
        settleRead({ ...liveResult, positions: [], errors: [{ owner: '0xabcdef', error: 'positions 429' }] })
      );

      await waitFor(() => expect(result.current.error).toBe('positions 429'));
      expect(result.current.positions).toHaveLength(1);
      expect(result.current.positions[0]?.stale).toBe(true);
    });

    it("never shows another account's stored copy, and removes the copy of the key it leaves", async () => {
      jest.mocked(fetchEarnPositions).mockResolvedValueOnce(liveResult);
      const { result, rerender } = renderCold();
      await waitFor(async () => expect(await readStored()).not.toBeNull());

      jest.mocked(fetchEarnPositions).mockReturnValueOnce(new Promise(() => undefined));
      mockAccount.publicKey = 'another-account';
      mockAccount.evmAddress = '0x123456';
      rerender();

      expect(result.current.positions).toEqual([]);
      expect(result.current.isLoading).toBe(true);
      await waitFor(async () => expect(await readStored()).toBeNull());
    });

    it('is removed by a wallet reset, so the next mount shows nothing stored', async () => {
      await getStorageProvider().set({ [STORAGE_KEY]: { at: 1, result: storedResult } });

      await clearStorage(false);

      expect(await readStored()).toBeNull();
      jest.mocked(fetchEarnPositions).mockReturnValueOnce(new Promise(() => undefined));
      const { result } = renderCold();
      await act(() => new Promise(resolve => setTimeout(resolve, 50)));
      expect(result.current.positions).toEqual([]);
      expect(result.current.isLoading).toBe(true);
    });
  });
});

describe('earnItemLoadState', () => {
  it('has the item: neither failed nor pending, even while a refresh loads', () => {
    expect(earnItemLoadState({}, { isLoading: true })).toEqual({ loadFailed: false, pending: false });
  });

  it('is pending while the item is missing and the load has not settled', () => {
    expect(earnItemLoadState(undefined, { isLoading: true })).toEqual({ loadFailed: false, pending: true });
  });

  it('has failed when the item is missing and the load errored', () => {
    expect(earnItemLoadState(undefined, { isLoading: false, error: 'boom' })).toEqual({
      loadFailed: true,
      pending: false
    });
  });

  it('is neither when the item is missing after a clean load', () => {
    expect(earnItemLoadState(undefined, { isLoading: false })).toEqual({ loadFailed: false, pending: false });
  });

  it('is failed and not pending when the item is missing, still loading and errored', () => {
    expect(earnItemLoadState(undefined, { isLoading: true, error: 'boom' })).toEqual({
      loadFailed: true,
      pending: false
    });
  });
});

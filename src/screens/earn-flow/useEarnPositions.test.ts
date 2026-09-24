import React from 'react';

import { renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

import type { EarnPositionsResult } from 'lib/epoch';
import { fetchEarnPositions, getEarnDepositEvmAddresses } from 'lib/epoch';

import { earnItemLoadState, useEarnPositions } from './useEarnPositions';

const mockAccount: { publicKey: string; evmAddress?: string } = {
  publicKey: 'miden-account',
  evmAddress: '0xABCDEF'
};
const mockUseRetryableSWR = jest.fn();

jest.mock('lib/miden/front', () => ({
  useAccount: () => mockAccount
}));

jest.mock('lib/epoch', () => ({
  fetchEarnPositions: jest.fn(),
  getEarnDepositEvmAddresses: jest.fn()
}));

jest.mock('lib/swr', () => ({
  useRetryableSWR: (...args: unknown[]) => mockUseRetryableSWR(...args)
}));

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

const vault = {
  lenderKey: 'DUMMY_LENDING',
  lenderName: 'Dummy Lending',
  logoUri: '',
  chainId: '11155111',
  apr: 5,
  depositApr: 5
};

const liveResult: EarnPositionsResult = {
  positions: [position],
  vaults: [vault],
  totalDepositsUSD: 10,
  owners: ['0xabcdef'],
  errors: [{ owner: '0xother', error: 'owner unavailable' }]
};

describe('useEarnPositions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAccount.publicKey = 'miden-account';
    mockAccount.evmAddress = '0xABCDEF';
  });

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
      id: 'dummy-lending-11155111',
      protocol: 'Dummy Lending',
      apy: '5.00%'
    });
    expect(result.current.summary).toMatchObject({
      totalDeposited: '$10.00',
      blendedApy: '~5.0%'
    });
    expect(result.current.error).toBe('owner unavailable');
    expect(result.current.isLoading).toBe(false);
  });

  it('reports a per-owner positions error as error only, never as a request failure', () => {
    mockUseRetryableSWR.mockReturnValue({ data: liveResult, isLoading: false });

    const { result } = renderHook(() => useEarnPositions());

    expect(result.current.vaults).toHaveLength(1);
    expect(result.current.error).toBe('owner unavailable');
    // Present and unset: the hook exposes loadError, and an owner's failure is not a request failure.
    expect(result.current).toHaveProperty('loadError', undefined);
  });

  it('reports a request failure as both loadError and error', () => {
    mockUseRetryableSWR.mockReturnValue({ data: undefined, isLoading: false, error: new Error('owner lookup failed') });

    const { result } = renderHook(() => useEarnPositions());

    expect(result.current.loadError).toBe('owner lookup failed');
    expect(result.current.error).toBe('owner lookup failed');
  });

  it('returns stable empty display data before the first response', () => {
    mockUseRetryableSWR.mockReturnValue({ data: undefined, isLoading: true });

    const { result } = renderHook(() => useEarnPositions());

    expect(result.current.positions).toEqual([]);
    expect(result.current.vaults).toEqual([]);
    expect(result.current.summary).toMatchObject({
      totalRewards: '$0.00',
      blendedApy: '~0.0%',
      totalDeposited: '$0.00',
      estimatedRewards: '+$0.00'
    });
    expect(result.current.error).toBeUndefined();
    expect(result.current.loadError).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
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

    if (!loadPositions) throw new Error('positions fetcher was not registered');
    await loadPositions();

    expect(receivedKey).toEqual(['earn-positions', 'miden-account', '0xABCDEF']);
    expect(receivedConfig).toEqual({
      revalidateOnMount: true,
      refreshInterval: 10_000,
      dedupingInterval: 3_000
    });
    expect(getEarnDepositEvmAddresses).toHaveBeenCalledWith('miden-account');
    expect(fetchEarnPositions).toHaveBeenCalledWith({
      accountId: 'miden-account',
      owners: ['0xabcdef', '0xhistorical']
    });
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
      expect(result.current.vaults).toEqual([]);
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

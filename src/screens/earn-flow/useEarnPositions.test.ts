import React from 'react';

import { act, render, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { PageActiveContext } from 'app/layouts/page-active';
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
      totalDepositedUsd: 10,
      blendedApyPercent: 5
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

  it('reports a read with no vaults and only owner failures as a failed load', () => {
    mockUseRetryableSWR.mockReturnValue({
      data: { ...liveResult, positions: [], vaults: [], totalDepositsUSD: 0, owners: [] },
      isLoading: false
    });

    const { result } = renderHook(() => useEarnPositions());

    expect(result.current.loadError).toBe('owner unavailable');
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
    expect(result.current.vaults).toEqual([]);
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
      data: { positions: [], vaults: [], totalDepositsUSD: 0, owners: [], errors: [] },
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

    if (!loadPositions) throw new Error('positions fetcher was not registered');
    await loadPositions();

    expect(receivedKey).toEqual(['earn-positions', 'miden-account', '0xABCDEF']);
    expect(receivedConfig).toEqual({
      revalidateOnMount: true,
      revalidateIfStale: true,
      refreshInterval: 30_000,
      revalidateOnFocus: false,
      dedupingInterval: 3_000
    });
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

    it('retries on the page that is showing when a covered page of the same account mounted first', async () => {
      jest.mocked(fetchEarnPositions).mockRejectedValueOnce(new Error('positions down')).mockResolvedValue(liveResult);
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
      await waitFor(() => expect(showing?.loadError).toBe('positions down'));
      expect(fetchEarnPositions).toHaveBeenCalledTimes(1);

      await act(async () => showing?.refetch());
      await waitFor(() => expect(fetchEarnPositions).toHaveBeenCalledTimes(2));
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

    beforeEach(() => {
      onScreen = true;
    });

    it('never reads while its page is covered', async () => {
      onScreen = false;
      await act(async () => {
        renderOnPage();
      });

      expect(getEarnDepositEvmAddresses).not.toHaveBeenCalled();
      expect(fetchEarnPositions).not.toHaveBeenCalled();
    });

    it('reads again once when its page comes back past the dedupe window', async () => {
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
      await act(() => new Promise(resolve => setTimeout(resolve, 100)));
      expect(fetchEarnPositions).toHaveBeenCalledTimes(2);
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

    it('reads as loading, not empty, when mounted on a covered page', () => {
      onScreen = false;
      const { result } = renderOnPage();

      expect(result.current.isLoading).toBe(true);
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
        .mocked(fetchEarnPositions)
        .mockRejectedValueOnce(new Error('positions down'))
        .mockReturnValue(new Promise(() => undefined));
      const { result } = renderInCache();
      await waitFor(() => expect(result.current.loadError).toBe('positions down'));

      await act(async () => result.current.refetch());
      await waitFor(() => expect(fetchEarnPositions).toHaveBeenCalledTimes(2));

      // SWR's own isLoading is true here (a read out, no data): the hook's is not, since an error is kept.
      expect(result.current.isLoading).toBe(false);
      expect(result.current.loadError).toBe('positions down');
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

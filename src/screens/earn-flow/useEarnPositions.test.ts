import React from 'react';

import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
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

    expect(receivedKey).toEqual(['earn-positions', 'miden-account', '0xABCDEF']);
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
    const settle = () => act(() => new Promise(resolve => setTimeout(resolve, 100)));
    // Date.now only: SWR's dedupe and poll timers stay real.
    const thirtySecondsOn = () => {
      const realNow = Date.now;
      jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 30_000);
    };

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

    it('reads nothing when its page comes back within 30 s of its last read', async () => {
      jest.mocked(fetchEarnPositions).mockResolvedValue(liveResult);
      const { result, rerender } = renderOnPage();
      await waitFor(() => expect(result.current.positions).toHaveLength(1));
      expect(fetchEarnPositions).toHaveBeenCalledTimes(1);

      onScreen = false;
      rerender();
      await pastDedupe();
      onScreen = true;
      rerender();
      await settle();
      expect(fetchEarnPositions).toHaveBeenCalledTimes(1);
    }, 10_000);

    it('reads again once when its page comes back 30 s after its last read', async () => {
      jest.mocked(fetchEarnPositions).mockResolvedValue(liveResult);
      const { result, rerender } = renderOnPage();
      await waitFor(() => expect(result.current.positions).toHaveLength(1));
      expect(fetchEarnPositions).toHaveBeenCalledTimes(1);

      onScreen = false;
      rerender();
      await pastDedupe();
      thirtySecondsOn();
      onScreen = true;
      rerender();
      await waitFor(() => expect(fetchEarnPositions).toHaveBeenCalledTimes(2));
      await settle();
      expect(fetchEarnPositions).toHaveBeenCalledTimes(2);
    }, 10_000);

    it('reads nothing when another Earn page mounts within 30 s of the last read', async () => {
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
      await settle();
      expect(fetchEarnPositions).toHaveBeenCalledTimes(1);
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
        jest.mocked(fetchEarnPositions).mockResolvedValue(liveResult);
      });

      afterEach(() => {
        cleanup();
        jest.useRealTimers();
      });

      it('polls 30 s after the last read began, not sooner', async () => {
        renderOnPage();
        await advance(0);
        expect(reads()).toBe(1);

        await advance(29_900);
        expect(reads()).toBe(1);
        await advance(200);
        expect(reads()).toBe(2);
      });

      it('a Retry moves the next poll to 30 s after it', async () => {
        const { result } = renderOnPage();
        await advance(0);
        expect(result.current.error).toBe('owner unavailable');

        await advance(20_000);
        act(() => result.current.refetch());
        await advance(0);
        expect(reads()).toBe(2);

        await advance(29_900);
        expect(reads()).toBe(2);
        await advance(200);
        expect(reads()).toBe(3);
      });

      it('a failed read is retried 30 s after it began, and nothing sooner', async () => {
        // SWR's first error retry, were it on, would wait a random share of its interval; this pins it at 2x.
        jest.spyOn(Math, 'random').mockReturnValue(0.9);
        jest.mocked(getEarnDepositEvmAddresses).mockRejectedValueOnce(new Error('lookup down'));
        const { result } = renderOnPage();
        await advance(0);
        expect(result.current.loadError).toBe('lookup down');

        await advance(29_900);
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
        await advance(30_000);
        expect(reads()).toBe(2);
      });

      it('no automatic read while the device is offline', async () => {
        const online = jest.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        renderOnPage();
        await advance(0);

        await advance(90_000);
        expect(reads()).toBe(1);

        online.mockReturnValue(true);
        await advance(30_000);
        expect(reads()).toBe(2);
      });

      it('no automatic read while its page is covered', async () => {
        const { rerender } = renderOnPage();
        await advance(10_000);
        expect(reads()).toBe(1);

        onScreen = false;
        rerender();
        await advance(90_000);
        expect(reads()).toBe(1);
        // And no timer left waiting to start one.
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
        const { rerender } = render(pages(true));
        await advance(10_000);
        expect(reads()).toBe(1);

        rerender(pages(false));
        await advance(10_000);
        act(() => showing?.refetch());
        await advance(0);
        expect(reads()).toBe(2);

        await advance(10_000);
        expect(reads()).toBe(2);
        await advance(20_100);
        expect(reads()).toBe(3);
      });

      it('an account switch re-arms from the new key', async () => {
        const { rerender } = renderOnPage();
        await advance(10_000);
        expect(reads()).toBe(1);

        mockAccount.publicKey = 'another-account';
        mockAccount.evmAddress = '0x123456';
        rerender();
        await advance(0);
        expect(reads()).toBe(2);
        expect(getEarnDepositEvmAddresses).toHaveBeenLastCalledWith('another-account');

        await advance(29_900);
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

    it('sends no second request when Retry is tapped again while its read is out', async () => {
      jest
        .mocked(fetchEarnPositions)
        .mockRejectedValueOnce(new Error('positions down'))
        .mockReturnValue(new Promise(() => undefined));
      const { result } = renderInCache();
      await waitFor(() => expect(result.current.loadError).toBe('positions down'));

      await act(async () => result.current.refetch());
      await waitFor(() => expect(fetchEarnPositions).toHaveBeenCalledTimes(2));
      await act(async () => result.current.refetch());
      await act(() => new Promise(resolve => setTimeout(resolve, 50)));

      expect(fetchEarnPositions).toHaveBeenCalledTimes(2);
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

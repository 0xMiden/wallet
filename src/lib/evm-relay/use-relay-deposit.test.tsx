import React, { type ReactNode } from 'react';

import { act, render, renderHook } from '@testing-library/react';

import { PageActiveContext } from 'app/layouts/page-active';
import { WalletStatus } from 'lib/shared/types';

import type { RelayDepositStatus, RelayDepositTarget } from './deposit';
import { readRelayDepositIntent, relayDepositIntentKey } from './deposit-intent';
import { RelayDepositWatcher } from './RelayDepositWatcher';
import { useRelayDeposit, type RelayDepositState } from './use-relay-deposit';

const ACCOUNT = 'mtst1account';
const TOKEN = '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';
const INTENT: RelayDepositTarget = { provider: 'agglayer', chainId: 11155111, token: TOKEN };
const PENDING: RelayDepositStatus = { kind: 'relay-pending', rowId: 'row-1' };

const mockStorage = new Map<string, unknown>();
const mockPut = jest.fn(async (key: string, value: unknown) => {
  mockStorage.set(key, value);
});
jest.mock('lib/miden/front/storage', () => ({
  useStorage: (key: string, fallback: unknown) => [mockStorage.get(key) ?? fallback, jest.fn()],
  fetchFromStorage: async (key: string) => mockStorage.get(key) ?? null,
  putToStorage: (key: string, value: unknown) => mockPut(key, value)
}));

let mockRelayOn = true;
jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => ({}) }));
jest.mock('lib/remote-config/values', () => ({
  selectRelayChain: () => (mockRelayOn ? { chainId: 11155111 } : null)
}));

const mockTick = jest.fn(async (_account: string, _target: RelayDepositTarget): Promise<RelayDepositStatus> => PENDING);
const mockWallet = {
  status: WalletStatus.Ready,
  currentAccount: { publicKey: ACCOUNT },
  relayDepositTick: (account: string, target: RelayDepositTarget) => mockTick(account, target)
};
jest.mock('lib/store', () => ({
  useWalletStore: <T,>(select: (state: typeof mockWallet) => T) => select(mockWallet)
}));

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

function renderRelayDeposit(active = true) {
  const page = { active };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PageActiveContext.Provider value={page.active}>{children}</PageActiveContext.Provider>
  );
  const hook = renderHook<RelayDepositState, unknown>(() => useRelayDeposit(ACCOUNT), { wrapper });
  return { ...hook, page };
}

beforeEach(() => {
  jest.useFakeTimers({ now: 1_800_000_000_000 });
  mockStorage.clear();
  mockStorage.set(relayDepositIntentKey(ACCOUNT), INTENT);
  mockRelayOn = true;
  mockTick.mockReset().mockResolvedValue(PENDING);
  mockPut.mockClear();
  mockWallet.status = WalletStatus.Ready;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('readRelayDepositIntent', () => {
  it('reads a stored intent with its token in lower case', () => {
    expect(readRelayDepositIntent({ ...INTENT, token: TOKEN.toUpperCase().replace('0X', '0x') })).toEqual(INTENT);
  });

  it('refuses anything else', () => {
    expect(readRelayDepositIntent(null)).toBeNull();
    expect(readRelayDepositIntent({ ...INTENT, provider: 'epoch' })).toBeNull();
    expect(readRelayDepositIntent({ ...INTENT, chainId: 0 })).toBeNull();
    expect(readRelayDepositIntent({ ...INTENT, chainId: '1' })).toBeNull();
    expect(readRelayDepositIntent({ ...INTENT, token: '0x12' })).toBeNull();
  });
});

describe('useRelayDeposit', () => {
  it('ticks every 10 seconds for 2 minutes after mount, then every 30 seconds', async () => {
    const { result } = renderRelayDeposit();
    await advance(0);
    expect(mockTick).toHaveBeenCalledTimes(1);
    expect(mockTick).toHaveBeenCalledWith(ACCOUNT, INTENT);
    expect(result.current.status).toEqual(PENDING);
    expect(result.current.intent).toEqual(INTENT);

    await advance(119_000);
    expect(mockTick).toHaveBeenCalledTimes(12);
    await advance(1_000);
    expect(mockTick).toHaveBeenCalledTimes(13);
    await advance(29_000);
    expect(mockTick).toHaveBeenCalledTimes(13);
    await advance(1_000);
    expect(mockTick).toHaveBeenCalledTimes(14);
  });

  it('never runs two ticks at once', async () => {
    const slow = deferred<RelayDepositStatus>();
    mockTick.mockReturnValueOnce(slow.promise);
    const { result } = renderRelayDeposit();
    await advance(60_000);
    act(() => result.current.refresh());
    expect(mockTick).toHaveBeenCalledTimes(1);

    await act(async () => {
      slow.resolve(PENDING);
    });
    await advance(10_000);
    expect(mockTick).toHaveBeenCalledTimes(2);
  });

  it('pauses while the page is not on screen', async () => {
    const hidden = renderRelayDeposit(false);
    await advance(60_000);
    expect(mockTick).not.toHaveBeenCalled();

    hidden.page.active = true;
    hidden.rerender();
    await advance(0);
    expect(mockTick).toHaveBeenCalledTimes(1);

    hidden.page.active = false;
    hidden.rerender();
    await advance(120_000);
    expect(mockTick).toHaveBeenCalledTimes(1);
  });

  it('waits at least the retryAfter of the last status', async () => {
    mockTick.mockResolvedValueOnce({ kind: 'waiting', code: 'rate_limited', retryAfter: 60 });
    renderRelayDeposit();
    await advance(59_000);
    expect(mockTick).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(mockTick).toHaveBeenCalledTimes(2);
  });

  it('stops after a failed status until a refresh', async () => {
    mockTick.mockResolvedValueOnce({ kind: 'failed', code: 'bad_signature' });
    const { result } = renderRelayDeposit();
    await advance(300_000);
    expect(mockTick).toHaveBeenCalledTimes(1);
    expect(result.current.status).toEqual({ kind: 'failed', code: 'bad_signature' });

    act(() => result.current.refresh());
    await advance(0);
    expect(mockTick).toHaveBeenCalledTimes(2);
  });

  it('does not tick without an intent or while the relay is off', async () => {
    mockRelayOn = false;
    renderRelayDeposit();
    await advance(60_000);
    expect(mockTick).not.toHaveBeenCalled();

    mockRelayOn = true;
    mockStorage.clear();
    const { result } = renderRelayDeposit();
    await advance(60_000);
    expect(mockTick).not.toHaveBeenCalled();
    expect(result.current.intent).toBeNull();

    await act(() => result.current.setIntent({ ...INTENT, token: TOKEN.toUpperCase().replace('0X', '0x') }));
    expect(mockPut).toHaveBeenCalledWith(relayDepositIntentKey(ACCOUNT), INTENT);
    await expect(result.current.setIntent({ ...INTENT, chainId: -1 })).rejects.toThrow(TypeError);
  });
});

describe('RelayDepositWatcher', () => {
  it('ticks once when the wallet is ready and again when the document comes to the foreground', async () => {
    render(<RelayDepositWatcher />);
    await advance(0);
    expect(mockTick).toHaveBeenCalledTimes(1);
    expect(mockTick).toHaveBeenCalledWith(ACCOUNT, INTENT);

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(0);
    expect(mockTick).toHaveBeenCalledTimes(2);
  });

  it('does nothing while the wallet is locked or the account has no intent', async () => {
    mockWallet.status = WalletStatus.Locked;
    const locked = render(<RelayDepositWatcher />);
    await advance(0);
    locked.unmount();

    mockWallet.status = WalletStatus.Ready;
    mockStorage.clear();
    render(<RelayDepositWatcher />);
    await advance(0);
    expect(mockTick).not.toHaveBeenCalled();
  });
});

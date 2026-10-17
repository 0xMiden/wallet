import React from 'react';

import { act, render, screen, waitFor } from '@testing-library/react';

import MyBadges from 'app/pages/MyBadges';
import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { tagBalanceSnapshot } from 'lib/miden/balance-snapshot';
import { ITransactionStatus, type ITransaction } from 'lib/miden/db/types';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import {
  __resetSyncFuseStateForTests,
  isSyncFused,
  noteSyncSuccess,
  noteSyncWatchdogEviction
} from 'lib/miden/front/sync-fuse';
import { DEFAULT_TOKEN_METADATA } from 'lib/miden/metadata/defaults';
import * as Repo from 'lib/miden/repo';
import { withWasmClientLock, type WasmLockHold } from 'lib/miden/sdk/miden-client';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import { MAX_CONSECUTIVE_WATCHDOG_EVICTIONS } from 'lib/miden/sync-backoff';

import { BadgeIssuanceManager } from './BadgeIssuanceManager';
import { BADGE_STORAGE_KEY, type BadgeId } from './types';
import { useWalletBadges } from './useWalletBadges';

let mockStored: BadgeId[] = [];
let mockMainnet = true;
let mockOverride: object | null = null;
let mockApprovedPair = true;
let mockVaultRemoval: (value: unknown) => void = () => {};
let mockResetListener: () => void = () => {};
const mockListeners = new Set<() => void>();
const mockAccounts = [{ publicKey: 'account-a' }, { publicKey: 'account-b' }];
const mockWrite = jest.fn();
let mockBalances: Record<string, TokenBalanceData[]> = {};
const mockBalanceListeners = new Set<
  (state: { balances: typeof mockBalances }, previous: { balances: typeof mockBalances }) => void
>();
jest.mock('lib/store', () => ({
  useWalletStore: {
    getState: () => ({ balances: mockBalances }),
    subscribe: (
      callback: (state: { balances: typeof mockBalances }, previous: { balances: typeof mockBalances }) => void
    ) => {
      mockBalanceListeners.add(callback);
      return () => mockBalanceListeners.delete(callback);
    }
  }
}));
function landBalances(nonce: string, network = 'mainnet', account = 'account-b') {
  const previous = mockBalances;
  const rows: TokenBalanceData[] = [
    {
      tokenId: 'coin-b',
      tokenSlug: 'COIN',
      metadata: { ...DEFAULT_TOKEN_METADATA, scaleIsUnknown: false },
      balance: 100,
      fiatPrice: 0,
      change24h: 0
    }
  ];
  tagBalanceSnapshot(rows, { network, accountNonce: nonce });
  mockBalances = { [account]: rows };
  mockBalanceListeners.forEach(callback => callback({ balances: mockBalances }, { balances: previous }));
}
jest.mock('lib/miden/front/client', () => ({ useMidenContext: () => ({ accounts: mockAccounts }) }));
jest.mock('lib/miden/front', () => ({ useNetwork: () => ({ id: 'mainnet' }) }));
jest.mock('lib/miden/front/storage', () => ({
  useStorage: () => {
    const ReactModule = jest.requireActual('react');
    return [
      ReactModule.useSyncExternalStore(
        (cb: () => void) => {
          mockListeners.add(cb);
          return () => mockListeners.delete(cb);
        },
        () => mockStored
      )
    ];
  },
  fetchFromStorage: async () => mockStored,
  onStorageChanged: (_key: string, callback: (value: unknown) => void) => {
    mockVaultRemoval = callback;
    return jest.fn();
  },
  putToStorage: async (key: string, value: BadgeId[]) => {
    mockWrite(key, value);
    mockStored = value;
    mockListeners.forEach(listener => listener());
  },
  inStorageTurn: async (_key: string, operation: () => Promise<void>) => operation()
}));
jest.mock('lib/miden/back/miden-client-proxy', () => ({
  midenClientProxy: {
    getTransactionCommitState: jest.fn(async () => 'committed'),
    getPswapLineages: jest.fn(async () => [])
  }
}));
jest.mock('lib/miden/sdk/miden-client', () => ({
  withWasmClientLock: jest.fn(async (operation: (hold: object) => Promise<unknown>) => operation({})),
  assertWasmHoldCurrent: jest.fn()
}));
jest.mock('lib/miden/swap/tokens', () => ({ isSwapPair: () => mockApprovedPair }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: () => (mockMainnet ? 'mainnet' : 'testnet'),
  getActiveOverride: () => mockOverride
}));
jest.mock('lib/storage-cleared', () => ({
  onStorageCleared: (callback: () => void) => {
    mockResetListener = callback;
    return jest.fn();
  }
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('app/hooks/useBackWithFallback', () => ({ useBackWithFallback: () => jest.fn() }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

const hash = '0x' + '1'.repeat(64);
const NO_HOLD: WasmLockHold = Object.create(null);
const row = (patch: Partial<ITransaction> = {}): ITransaction => ({
  id: 'send',
  type: 'send',
  accountId: 'account-b',
  secondaryAccountId: 'recipient',
  amount: 10n,
  faucetId: 'coin-a',
  status: ITransactionStatus.Queued,
  initiatedAt: 1,
  transactionId: hash,
  badgeNetwork: 'mainnet',
  displayIcon: 'SEND',
  ...patch
});
const swapOrderRows = (): ITransaction[] => [
  row({
    id: 'order',
    type: 'swap',
    status: ITransactionStatus.Completed,
    extraInputs: { orderId: '7', requestedAmount: 100n, requestedFaucetId: 'coin-b' }
  }),
  row({
    id: 'claim',
    type: 'consume',
    status: ITransactionStatus.Completed,
    faucetId: 'coin-b',
    amount: 100n,
    transactionId: '0x' + '2'.repeat(64),
    submitEvidence: [
      { attemptId: 'claim', capturedAt: 1, source: 'stage', transactionId: '0x' + '2'.repeat(64), initialNonce: '4' }
    ],
    noteIds: ['swap-note'],
    extraInputs: { swapOrderTxId: 'order', swapSettleKind: 'settle' }
  })
];
function ProfileCounter() {
  const badges = useWalletBadges();
  return <output data-testid="wallet-count">{badges.length}</output>;
}

beforeEach(async () => {
  await Repo.transactions.clear();
  mockStored = [];
  mockBalances = {};
  mockMainnet = true;
  mockOverride = null;
  mockApprovedPair = true;
  jest.clearAllMocks();
  __resetSyncFuseStateForTests();
  jest.mocked(withWasmClientLock).mockImplementation(async operation => operation(NO_HOLD));
  jest.mocked(midenClientProxy.getTransactionCommitState).mockResolvedValue('committed');
  jest.mocked(midenClientProxy.getPswapLineages).mockResolvedValue([]);
});

it('reacts to a real IndexedDB status event and updates both the wallet count and badge card', async () => {
  await Repo.transactions.add(row());
  const view = render(
    <>
      <BadgeIssuanceManager />
      <ProfileCounter />
      <MyBadges />
    </>
  );
  expect(screen.getByTestId('wallet-count')).toHaveTextContent('0');
  expect(screen.getByTestId('badge-medallion-first-send')).toHaveAttribute('data-earned', 'false');
  await act(async () => {
    await Repo.transactions.update('send', { status: ITransactionStatus.Completed });
  });
  await waitFor(() => expect(screen.getByTestId('badge-medallion-first-send')).toHaveAttribute('data-earned', 'true'));
  expect(screen.getByTestId('wallet-count')).toHaveTextContent('1');
  expect(screen.getByText('badgeEarned')).toBeInTheDocument();
  expect(mockWrite).toHaveBeenCalledWith(BADGE_STORAGE_KEY, ['first-send']);
  await act(async () => {
    await Repo.transactions.update('send', { completedAt: 10 });
  });
  await waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1));
  view.unmount();
  render(
    <>
      <BadgeIssuanceManager />
      <ProfileCounter />
      <MyBadges />
    </>
  );
  expect(screen.getByTestId('wallet-count')).toHaveTextContent('1');
  expect(screen.getByTestId('badge-medallion-first-send')).toHaveAttribute('data-earned', 'true');
});

it.each(['testnet', 'override', 'legacy', 'failed', 'imported'])('does not issue for %s activity', async kind => {
  mockMainnet = kind !== 'testnet';
  mockOverride = kind === 'override' ? {} : null;
  await Repo.transactions.add(
    row({
      status: kind === 'failed' ? ITransactionStatus.Failed : ITransactionStatus.Completed,
      badgeNetwork: kind === 'legacy' ? undefined : 'mainnet',
      restoredFromBackup: kind === 'imported'
    })
  );
  const view = render(
    <>
      <BadgeIssuanceManager />
      <ProfileCounter />
    </>
  );
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 25));
  });
  expect(screen.getByTestId('wallet-count')).toHaveTextContent('0');
  expect(mockWrite).not.toHaveBeenCalled();
  view.unmount();
});

it('abandons an in-flight confirmation when wallet storage is reset', async () => {
  let finish: (state: 'committed') => void = () => {};
  jest.mocked(midenClientProxy.getTransactionCommitState).mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  await Repo.transactions.add(row({ status: ITransactionStatus.Completed }));
  const view = render(<BadgeIssuanceManager />);
  await waitFor(() => expect(midenClientProxy.getTransactionCommitState).toHaveBeenCalled());
  await act(async () => {
    mockResetListener();
    finish('committed');
  });
  expect(mockWrite).not.toHaveBeenCalled();
  view.unmount();
});

it('abandons extension work as soon as the vault-presence key is removed', async () => {
  let finish: (state: 'committed') => void = () => {};
  jest.mocked(midenClientProxy.getTransactionCommitState).mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  await Repo.transactions.add(row({ status: ITransactionStatus.Completed }));
  const view = render(<BadgeIssuanceManager />);
  await waitFor(() => expect(midenClientProxy.getTransactionCommitState).toHaveBeenCalled());
  await act(async () => {
    mockVaultRemoval(undefined);
    finish('committed');
  });
  expect(mockWrite).not.toHaveBeenCalled();
  view.unmount();
});

it('reports unavailable history and never converts a database error into a badge', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  Repo.db.close();
  const view = render(<BadgeIssuanceManager />);
  try {
    await waitFor(() =>
      expect(warn.mock.calls.map(call => call[0])).toEqual(
        expect.arrayContaining(['[badges] completion evidence unavailable; will retry'])
      )
    );
    expect(mockWrite).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    await Repo.db.open();
    warn.mockRestore();
  }
});

describe('the 15 s foreground retry', () => {
  // Dexie and fake-indexeddb run on the real microtask and setImmediate queues; the fake clock drives the retry.
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] }));
  afterEach(() => jest.useRealTimers());
  const advance = (ms: number) =>
    act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  // Small steps, each a real event-loop turn, so the IndexedDB work of every pass finishes.
  const settle = async (ms = 5_000) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 100) await advance(100);
  };

  it('writes a send whose verdict turns committed on the retry, and not before it', async () => {
    jest.mocked(midenClientProxy.getTransactionCommitState).mockResolvedValue('pending');
    await Repo.transactions.add(row({ status: ITransactionStatus.Completed }));
    const mountedAt = jest.now();
    const view = render(<BadgeIssuanceManager />);
    try {
      await settle();
      expect(midenClientProxy.getTransactionCommitState).toHaveBeenCalled();
      jest.mocked(midenClientProxy.getTransactionCommitState).mockResolvedValue('committed');
      await advance(15_000 - (jest.now() - mountedAt) - 1);
      expect(mockWrite).not.toHaveBeenCalled();
      await advance(1);
      await settle();
      expect(mockWrite).toHaveBeenCalledWith(BADGE_STORAGE_KEY, ['first-send']);
    } finally {
      view.unmount();
    }
  });

  it('clears the retry on unmount, so no verdict call follows', async () => {
    jest.mocked(midenClientProxy.getTransactionCommitState).mockResolvedValue('pending');
    await Repo.transactions.add(row({ status: ITransactionStatus.Completed }));
    const intervals = jest.spyOn(global, 'setInterval');
    const cleared = jest.spyOn(global, 'clearInterval');
    try {
      const view = render(<BadgeIssuanceManager />);
      await settle();
      const retry = intervals.mock.calls.findIndex(([, delay]) => delay === 15_000);
      expect(retry).toBeGreaterThanOrEqual(0);
      view.unmount();
      expect(cleared).toHaveBeenCalledWith(intervals.mock.results[retry]?.value);
      jest.mocked(midenClientProxy.getTransactionCommitState).mockClear();
      await advance(60_000);
      expect(midenClientProxy.getTransactionCommitState).not.toHaveBeenCalled();
    } finally {
      intervals.mockRestore();
      cleared.mockRestore();
    }
  });

  it('runs no retry pass while the document is hidden', async () => {
    jest.mocked(midenClientProxy.getTransactionCommitState).mockResolvedValue('pending');
    await Repo.transactions.add(row({ status: ITransactionStatus.Completed }));
    const hidden = jest.spyOn(document, 'hidden', 'get');
    const view = render(<BadgeIssuanceManager />);
    try {
      await settle();
      hidden.mockReturnValue(true);
      jest.mocked(midenClientProxy.getTransactionCommitState).mockClear();
      await advance(15_000);
      await settle();
      expect(midenClientProxy.getTransactionCommitState).not.toHaveBeenCalled();
      hidden.mockReturnValue(false);
      await advance(15_000);
      await settle();
      expect(midenClientProxy.getTransactionCommitState).toHaveBeenCalled();
    } finally {
      view.unmount();
      hidden.mockRestore();
    }
  });

  it.each(['badge-verdict', 'idle-sync'] as const)(
    'takes no verdict hold on the retry while %s is fused',
    async key => {
      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i += 1) noteSyncWatchdogEviction(key);
      await Repo.transactions.add(row({ status: ITransactionStatus.Completed }));
      const view = render(<BadgeIssuanceManager />);
      try {
        await advance(15_000);
        await settle();
        expect(withWasmClientLock).not.toHaveBeenCalled();
        expect(mockWrite).not.toHaveBeenCalled();
        noteSyncSuccess(key);
        await advance(15_000);
        await settle();
        expect(mockWrite).toHaveBeenCalledWith(BADGE_STORAGE_KEY, ['first-send']);
      } finally {
        view.unmount();
      }
    }
  );
});

describe('the badge verdict fuse', () => {
  const almostFused = () => {
    for (let i = 1; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i += 1) noteSyncWatchdogEviction('badge-verdict');
  };

  it('books an eviction of the commit-verdict hold against the badge key', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    almostFused();
    jest.mocked(midenClientProxy.getTransactionCommitState).mockRejectedValue(new WasmClientPoisonedError('watchdog'));
    await Repo.transactions.add(row({ status: ITransactionStatus.Completed }));
    const view = render(<BadgeIssuanceManager />);
    try {
      await waitFor(() => expect(isSyncFused('badge-verdict')).toBe(true));
    } finally {
      view.unmount();
      warn.mockRestore();
    }
  });

  it('books an eviction of the swap-verdict hold against the badge key', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    almostFused();
    jest.mocked(midenClientProxy.getPswapLineages).mockRejectedValue(new WasmClientPoisonedError('watchdog'));
    await Repo.transactions.bulkAdd(swapOrderRows());
    const view = render(<BadgeIssuanceManager />);
    try {
      await act(async () => landBalances('5'));
      await waitFor(() => expect(isSyncFused('badge-verdict')).toBe(true));
      expect(midenClientProxy.getTransactionCommitState).toHaveBeenCalled();
    } finally {
      view.unmount();
      warn.mockRestore();
    }
  });

  // The lock is held elsewhere until the returned release, so the verdict hold with this label queues behind it.
  const holdBack = (label: string) => {
    let release: () => void = () => {};
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    jest.mocked(withWasmClientLock).mockImplementation(async (operation, options) => {
      if (options?.label === label) await held;
      return operation(NO_HOLD);
    });
    return () => release();
  };
  const queued = (label: string) =>
    waitFor(() =>
      expect(withWasmClientLock).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ label }))
    );

  it('makes no commit-state call for a verdict that queued while idle-sync lit, and books no success', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    almostFused();
    const release = holdBack('badge-commit-verdict');
    await Repo.transactions.add(row({ status: ITransactionStatus.Completed }));
    const view = render(<BadgeIssuanceManager />);
    try {
      await queued('badge-commit-verdict');
      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i += 1) noteSyncWatchdogEviction('idle-sync');
      await act(async () => {
        release();
        await new Promise(resolve => setTimeout(resolve, 25));
      });
      expect(midenClientProxy.getTransactionCommitState).not.toHaveBeenCalled();
      expect(mockWrite).not.toHaveBeenCalled();
      noteSyncWatchdogEviction('badge-verdict');
      expect(isSyncFused('badge-verdict')).toBe(true);
    } finally {
      release();
      view.unmount();
      warn.mockRestore();
    }
  });

  it('makes no lineage call for a swap verdict that queued while the issuer stopped, and books no success', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Pass one caches both commit verdicts and fails at the swap verdict, so that is the next pass's only hold.
    jest.mocked(midenClientProxy.getPswapLineages).mockRejectedValue(new Error('offline'));
    await Repo.transactions.bulkAdd(swapOrderRows());
    landBalances('5');
    const view = render(<BadgeIssuanceManager />);
    let release = () => {};
    try {
      await waitFor(() =>
        expect(warn).toHaveBeenCalledWith('[badges] completion evidence unavailable; will retry', expect.any(Error))
      );
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 25));
      });
      almostFused();
      release = holdBack('badge-swap-verdict');
      jest.mocked(withWasmClientLock).mockClear();
      jest.mocked(midenClientProxy.getTransactionCommitState).mockClear();
      jest.mocked(midenClientProxy.getPswapLineages).mockClear();
      await act(async () => {
        await Repo.transactions.add(
          row({
            id: 'wake',
            type: 'consume',
            status: ITransactionStatus.Completed,
            transactionId: '0x' + '3'.repeat(64)
          })
        );
      });
      await queued('badge-swap-verdict');
      view.unmount();
      await act(async () => {
        release();
        await new Promise(resolve => setTimeout(resolve, 25));
      });
      expect(midenClientProxy.getPswapLineages).not.toHaveBeenCalled();
      expect(midenClientProxy.getTransactionCommitState).not.toHaveBeenCalled();
      noteSyncWatchdogEviction('badge-verdict');
      expect(isSyncFused('badge-verdict')).toBe(true);
    } finally {
      release();
      view.unmount();
      warn.mockRestore();
    }
  });

  it('withdraws the evidence once every hold of a pass answered', async () => {
    almostFused();
    await Repo.transactions.add(row({ status: ITransactionStatus.Completed }));
    const view = render(<BadgeIssuanceManager />);
    try {
      await waitFor(() => expect(mockWrite).toHaveBeenCalledWith(BADGE_STORAGE_KEY, ['first-send']));
      noteSyncWatchdogEviction('badge-verdict');
      expect(isSyncFused('badge-verdict')).toBe(false);
    } finally {
      view.unmount();
    }
  });
});

it('starts no pass on a balance landing while no candidate waits on a balance', async () => {
  jest.mocked(midenClientProxy.getTransactionCommitState).mockResolvedValue('pending');
  await Repo.transactions.add(row({ status: ITransactionStatus.Completed }));
  const reads = jest.spyOn(Repo.transactions, 'where');
  const view = render(<BadgeIssuanceManager />);
  try {
    await waitFor(() => expect(midenClientProxy.getTransactionCommitState).toHaveBeenCalled());
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 25));
    });
    reads.mockClear();
    await act(async () => landBalances('5'));
    await act(async () => landBalances('6'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 25));
    });
    expect(reads).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    reads.mockRestore();
  }
});

it.each([
  { state: 0, remaining: '0', approved: true, earned: false },
  { state: 1, remaining: '1', approved: true, earned: false },
  { state: 2, remaining: '0', approved: true, earned: false },
  { state: 1, remaining: '0', approved: false, earned: false },
  { state: 1, remaining: '0', approved: true, earned: true }
])('checks the actual swap pair and lineage adapter: %s', async ({ state, remaining, approved, earned }) => {
  mockApprovedPair = approved;
  jest.mocked(midenClientProxy.getPswapLineages).mockResolvedValue([
    {
      orderId: '7',
      currentTipNoteId: 'tip',
      currentDepth: 1,
      state,
      remainingOffered: remaining,
      remainingRequested: remaining
    }
  ]);
  await Repo.transactions.bulkAdd(swapOrderRows());
  const view = render(
    <>
      <BadgeIssuanceManager />
      <ProfileCounter />
    </>
  );
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 25));
  });
  expect(screen.getByTestId('wallet-count')).toHaveTextContent('0');
  await act(async () => landBalances('4'));
  await act(async () => landBalances('5', 'testnet'));
  await act(async () => landBalances('5', 'mainnet', 'foreign-account'));
  expect(mockWrite).not.toHaveBeenCalled();
  await act(async () => landBalances('5'));
  await waitFor(() => expect(midenClientProxy.getTransactionCommitState).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByTestId('wallet-count')).toHaveTextContent(earned ? '1' : '0'));
  expect(mockWrite).toHaveBeenCalledTimes(earned ? 1 : 0);
  view.unmount();
});

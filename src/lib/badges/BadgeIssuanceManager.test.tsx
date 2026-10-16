import React from 'react';

import { act, render, screen, waitFor } from '@testing-library/react';

import MyBadges from 'app/pages/MyBadges';
import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { tagBalanceSnapshot } from 'lib/miden/balance-snapshot';
import { ITransactionStatus, type ITransaction } from 'lib/miden/db/types';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import { DEFAULT_TOKEN_METADATA } from 'lib/miden/metadata/defaults';
import * as Repo from 'lib/miden/repo';

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
  withWasmClientLock: async (operation: (hold: object) => Promise<unknown>) => operation({}),
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

it('keeps a foreground retry while mounted and cleans it up on unmount', async () => {
  jest.useFakeTimers();
  mockMainnet = false;
  const view = render(<BadgeIssuanceManager />);
  try {
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    expect(mockWrite).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    jest.useRealTimers();
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
  await Repo.transactions.bulkAdd([
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
  ]);
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

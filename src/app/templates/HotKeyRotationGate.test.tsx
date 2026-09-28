import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import { MIDEN_METADATA } from 'lib/miden/metadata';
import { TRANSACTION_VAULT_SHORTFALL_ERROR } from 'lib/miden/transaction/constants';
import type { ConsumableNote } from 'lib/miden/types';
import { hapticLight } from 'lib/mobile/haptics';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import type { WalletAccount } from 'lib/shared/types';

import { HotKeyRotationGate } from './HotKeyRotationGate';

const mockInitiate = jest.fn();
const mockRequestSW = jest.fn();
const mockLoop = jest.fn();
const mockUseTransactionRow = jest.fn();
// The transactions table the gate reads, with its filters applied for real: the rotation
// and its funding claim are told apart by predicate (#805), so a stub that ignored them
// would answer every query with the same row.
type TableRow = Pick<ITransaction, 'id' | 'type' | 'accountId' | 'status' | 'initiatedAt'> & Partial<ITransaction>;
let mockTable: TableRow[] = [];
// Every live query the gate subscribed; `publishTable` re-runs them, as a Dexie write would.
const mockLiveQueries: Array<() => void> = [];
let mockBaseFee: number | null = 10000;
let mockBalances: TokenBalanceData[] = [];
let mockBalancesLoading = false;
let mockFaucetId: string | null = 'native-faucet';
let mockClaimable: { data?: ConsumableNote[]; isFallback: boolean } = { data: [], isFallback: false };
const mockEnqueue = jest.fn(async (..._args: unknown[]): Promise<string | null> => 'claim-tx');

let storeState: { currentAccount?: Partial<WalletAccount> };
// Simulates another surface actively holding the generate-transactions-loop
// Web Lock (i.e. a generation is genuinely in flight somewhere).
let loopLockHeld = false;
// Every Web Lock name the gate asked for, in order.
const lockRequests: string[] = [];

type LockCallback = (lock: { name: string } | null) => unknown;
type LockOptions = { ifAvailable?: boolean };
// One holder per lock name, the rest queued in order: two surfaces' lookups run one after the other.
const lockTails = new Map<string, Promise<unknown>>();
const heldLocks = new Set<string>();

beforeAll(() => {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (name: string, optsOrCb: LockOptions | LockCallback, maybeCb?: LockCallback) => {
        lockRequests.push(name);
        const callback = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
        const opts = typeof optsOrCb === 'function' ? undefined : optsOrCb;
        if (!callback) throw new Error('navigator.locks.request needs a callback');
        const busy = heldLocks.has(name) || (name === 'generate-transactions-loop' && loopLockHeld);
        if (opts?.ifAvailable && busy) return Promise.resolve(callback(null));
        const granted = (lockTails.get(name) ?? Promise.resolve()).then(async () => {
          heldLocks.add(name);
          try {
            return await callback({ name });
          } finally {
            heldLocks.delete(name);
          }
        });
        lockTails.set(
          name,
          granted.catch(() => undefined)
        );
        return granted;
      }
    }
  });
});

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${Object.values(params).join(',')}` : key)
  })
}));

jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => mockFaucetId }));
jest.mock('app/hooks/useVerificationBaseFee', () => ({ __esModule: true, default: () => mockBaseFee }));

jest.mock('lib/dexie-live-query', () => ({
  subscribeToLiveQuery: (query: () => unknown, observer: { next: (value: unknown) => void }) => {
    const run = () => {
      void Promise.resolve(query()).then(value => observer.next(value));
    };
    mockLiveQueries.push(run);
    run();
    return () => {
      mockLiveQueries.splice(mockLiveQueries.indexOf(run), 1);
    };
  }
}));

// The root manual mock of this module has no `formatBigInt`; the minimum line needs the real one.
jest.mock('lib/i18n/numbers', () => jest.requireActual('lib/i18n/numbers'));

jest.mock('lib/miden/activity', () => ({
  initiateReplaceHotKeyTransaction: (...args: unknown[]) => mockInitiate(...args),
  requestSWTransactionProcessing: () => mockRequestSW(),
  safeGenerateTransactionsLoop: (...args: unknown[]) => mockLoop(...args)
}));

jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({ signTransaction: jest.fn() }),
  useAllTokensBaseMetadata: () => ({}),
  useAllBalances: () => ({ data: mockBalances, isLoading: mockBalancesLoading })
}));

jest.mock('lib/miden/front/claimable-notes', () => ({
  useClaimableNotes: () => mockClaimable
}));

jest.mock('lib/miden/transaction/rotation-funding', () => ({
  ...jest.requireActual('lib/miden/transaction/rotation-funding'),
  enqueueRotationFundingClaim: (...args: unknown[]) => mockEnqueue(...args)
}));

jest.mock('lib/miden/front/guardian-sync', () => ({
  zustandProvider: { name: 'zustand-provider' }
}));

jest.mock('lib/miden/repo', () => ({
  transactions: {
    filter: (predicate: (row: TableRow) => boolean) => ({
      first: async () => mockTable.find(predicate),
      toArray: async () => mockTable.filter(predicate),
      modify: async (change: (row: TableRow) => void) => mockTable.filter(predicate).forEach(change)
    })
  }
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: jest.fn()
}));

// The factory owns the state: `lib/miden/metadata` reads the platform while it loads, before any
// `let` in this file is initialised.
jest.mock('lib/platform', () => {
  const state = { isExtension: false };
  return { state, isExtension: () => state.isExtension, isMobile: () => false };
});
const mockPlatform: { isExtension: boolean } = jest.requireMock('lib/platform').state;

// Auto-consume is OFF: the gate's claim must not read it (#805).
jest.mock('lib/settings/helpers', () => ({
  isDelegateProofEnabled: () => false,
  isAutoConsumeEnabled: () => false
}));

jest.mock('lib/store', () => ({
  useWalletStore: (selector: (s: unknown) => unknown) => selector(storeState)
}));

jest.mock('screens/generating-transaction/useTransactionRow', () => ({
  useTransactionRow: (txId: string) => mockUseTransactionRow(txId)
}));

jest.mock('components/ui/Spinner', () => ({
  Spinner: () => <div data-testid="spinner" />
}));

jest.mock('components/ui/CopyButton', () => ({
  CopyButton: ({ text, 'data-testid': testId }: { text: string; 'data-testid'?: string }) => (
    <button type="button" data-testid={testId} data-copy-text={text} />
  )
}));

jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary' },
  Button: ({
    children,
    onClick,
    'data-testid': testId
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    'data-testid'?: string;
  }) => (
    <button type="button" data-testid={testId} onClick={onClick}>
      {children}
    </button>
  )
}));

const flaggedAccount = { publicKey: 'account-1', requiresHotKeyRotation: true };

const rotationRow = (id: string, extra: Partial<TableRow> = {}): TableRow => ({
  id,
  type: 'replace-hot-key',
  accountId: 'account-1',
  status: ITransactionStatus.Queued,
  initiatedAt: 100,
  ...extra
});
const fundingRow = (id: string, extra: Partial<TableRow> = {}): TableRow => ({
  id,
  type: 'consume',
  accountId: 'account-1',
  status: ITransactionStatus.Queued,
  initiatedAt: 200,
  rotationFunding: true,
  noteIds: ['note-1'],
  ...extra
});
const shortfallRow = (): TableRow =>
  rotationRow('tx-shortfall', {
    status: ITransactionStatus.Failed,
    completedAt: 150,
    error: 'assertion failed with error code: 644413868907058392'
  });

const nativeNote = (id: string, extra: Partial<ConsumableNote> = {}): ConsumableNote => ({
  id,
  faucetId: 'native-faucet',
  amount: '20000000',
  senderAddress: 'sender',
  isBeingClaimed: false,
  type: 'unknown',
  standardPayment: true,
  ...extra
});
const nativeBalance = (balance: number): TokenBalanceData => ({
  tokenId: 'native-faucet',
  tokenSlug: 'MIDEN',
  metadata: MIDEN_METADATA,
  balance,
  fiatPrice: 0,
  change24h: 0
});

/** Re-run every live query and let the gate settle, as after a Dexie write. */
const publishTable = async () => {
  await act(async () => {
    mockLiveQueries.forEach(run => run());
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

/** Track the adopted shortfall: the row a funding test starts from. */
const trackShortfall = () => {
  mockTable = [shortfallRow()];
  mockUseTransactionRow.mockImplementation((txId: string) => ({
    row: mockTable.find(r => r.id === txId),
    loaded: true
  }));
};

describe('HotKeyRotationGate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storeState = { currentAccount: flaggedAccount };
    loopLockHeld = false;
    mockTable = [];
    mockLiveQueries.length = 0;
    mockBaseFee = 10000;
    mockBalances = [];
    mockBalancesLoading = false;
    mockFaucetId = 'native-faucet';
    lockRequests.length = 0;
    lockTails.clear();
    heldLocks.clear();
    mockClaimable = { data: [], isFallback: false };
    mockEnqueue.mockResolvedValue('claim-tx');
    mockPlatform.isExtension = false;
    mockInitiate.mockResolvedValue('tx-new');
    mockLoop.mockResolvedValue(undefined);
    mockUseTransactionRow.mockReturnValue({ row: undefined, loaded: true });
  });

  it('renders nothing when there is no account or no rotation flag', () => {
    storeState = { currentAccount: { publicKey: 'account-1' } };
    const { container, rerender } = render(<HotKeyRotationGate />);
    expect(container).toBeEmptyDOMElement();

    storeState = {};
    rerender(<HotKeyRotationGate />);
    expect(container).toBeEmptyDOMElement();
    expect(mockInitiate).not.toHaveBeenCalled();
  });

  it('shows the blocking overlay and initiates exactly one rotation for a flagged account', async () => {
    render(
      <React.StrictMode>
        <HotKeyRotationGate />
      </React.StrictMode>
    );

    expect(screen.getByText('hotKeyRotationOverlayTitle')).toBeInTheDocument();
    expect(screen.getByText('hotKeyRotationOverlayBody')).toBeInTheDocument();

    await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));
    expect(mockInitiate).toHaveBeenCalledWith('account-1', false, { name: 'zustand-provider' });
  });

  it('swallows mobile back from the overlay tier while it blocks', async () => {
    render(<HotKeyRotationGate />);

    expect(useMobileBackHandler).toHaveBeenCalledWith(expect.any(Function), [], { overlay: true });
    const [handler] = jest.mocked(useMobileBackHandler).mock.calls[0]!;
    expect(handler()).toBe(true);
    await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));
  });

  it('adopts an existing pending rotation row instead of initiating a new one', async () => {
    mockTable = [rotationRow('tx-existing')];

    render(<HotKeyRotationGate />);

    await waitFor(() => expect(mockUseTransactionRow).toHaveBeenCalledWith('tx-existing'));
    expect(mockInitiate).not.toHaveBeenCalled();
  });

  it('requeues orphaned in-progress rows before adopting when no generation loop is running', async () => {
    mockTable = [
      rotationRow('tx-orphan', { status: ITransactionStatus.GeneratingTransaction, processingStartedAt: 5 })
    ];

    render(<HotKeyRotationGate />);

    await waitFor(() => expect(mockUseTransactionRow).toHaveBeenCalledWith('tx-orphan'));
    expect(mockTable[0]).toMatchObject({ status: ITransactionStatus.Queued, processingStartedAt: undefined });
    expect(mockInitiate).not.toHaveBeenCalled();
  });

  it('does not requeue in-progress rows while another surface holds the loop lock', async () => {
    loopLockHeld = true;
    mockTable = [rotationRow('tx-live', { status: ITransactionStatus.GeneratingTransaction })];

    render(<HotKeyRotationGate />);

    await waitFor(() => expect(mockUseTransactionRow).toHaveBeenCalledWith('tx-live'));
    expect(mockTable[0]!.status).toBe(ITransactionStatus.GeneratingTransaction);
    expect(mockInitiate).not.toHaveBeenCalled();
  });

  it('shows the failure reason and retries with a fresh transaction', async () => {
    mockUseTransactionRow.mockReturnValue({
      row: { id: 'tx-new', status: ITransactionStatus.Failed, error: 'guardian unreachable' },
      loaded: true
    });

    mockTable = [rotationRow('tx-new', { status: ITransactionStatus.Failed, error: 'guardian unreachable' })];

    render(<HotKeyRotationGate />);
    await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));

    expect(screen.getByText('hotKeyRotationFailedTitle')).toBeInTheDocument();
    expect(screen.getByText('guardian unreachable')).toBeInTheDocument();

    // Failed rows are terminal: Retry enqueues a new transaction instead of adopting it.
    fireEvent.click(screen.getByText('hotKeyRotationRetry'));
    await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(2));
  });

  it('falls back to a generic failure message when the row has no error text', async () => {
    mockUseTransactionRow.mockReturnValue({
      row: { id: 'tx-new', status: ITransactionStatus.Failed },
      loaded: true
    });

    render(<HotKeyRotationGate />);

    await waitFor(() => expect(screen.getByText('hotKeyRotationFailedGeneric')).toBeInTheDocument());
  });

  it('disappears once the rotation flag clears', async () => {
    const { container, rerender } = render(<HotKeyRotationGate />);
    await waitFor(() => expect(mockInitiate).toHaveBeenCalled());

    storeState = { currentAccount: { publicKey: 'account-1', requiresHotKeyRotation: false } };
    rerender(<HotKeyRotationGate />);

    expect(container).toBeEmptyDOMElement();
  });

  describe('serialized with the funding claim (#805)', () => {
    it('defers the rotation on mount while the gate funding claim is live', async () => {
      mockTable = [shortfallRow(), fundingRow('claim-1', { status: ITransactionStatus.GeneratingTransaction })];

      render(<HotKeyRotationGate />);

      await waitFor(() => expect(mockUseTransactionRow).toHaveBeenCalled());
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      expect(mockInitiate).not.toHaveBeenCalled();
      expect(mockUseTransactionRow).not.toHaveBeenCalledWith('tx-shortfall');
      expect(screen.queryByTestId('hot-key-rotation-failed')).not.toBeInTheDocument();
    });

    it('defers a Retry while the funding claim is live', async () => {
      mockUseTransactionRow.mockReturnValue({
        row: { id: 'tx-new', status: ITransactionStatus.Failed, error: 'guardian unreachable' },
        loaded: true
      });
      render(<HotKeyRotationGate />);
      await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));

      mockTable = [fundingRow('claim-1')];
      fireEvent.click(screen.getByText('hotKeyRotationRetry'));
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
      });

      expect(mockInitiate).toHaveBeenCalledTimes(1);
    });

    it('adopts the prior shortfall on mount when no claim completed after it', async () => {
      mockTable = [
        fundingRow('claim-old', { status: ITransactionStatus.Completed, initiatedAt: 20, completedAt: 50 }),
        shortfallRow()
      ];

      render(<HotKeyRotationGate />);

      await waitFor(() => expect(mockUseTransactionRow).toHaveBeenCalledWith('tx-shortfall'));
      expect(mockInitiate).not.toHaveBeenCalled();
    });

    it('queues a fresh rotation on Retry instead of adopting the shortfall again', async () => {
      trackShortfall();
      render(<HotKeyRotationGate />);
      await waitFor(() => expect(mockUseTransactionRow).toHaveBeenCalledWith('tx-shortfall'));

      fireEvent.click(screen.getByTestId('hot-key-rotation-retry'));

      await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));
    });

    it('queues a fresh rotation on mount once a claim completed after the shortfall', async () => {
      mockTable = [shortfallRow(), fundingRow('claim-1', { status: ITransactionStatus.Completed, completedAt: 300 })];

      render(<HotKeyRotationGate />);

      await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));
      expect(mockUseTransactionRow).toHaveBeenCalledWith('tx-new');
    });

    it('does not adopt a rotation that failed for another reason, or only the older of two', async () => {
      mockTable = [
        shortfallRow(),
        rotationRow('tx-later', { status: ITransactionStatus.Failed, initiatedAt: 160, error: 'guardian unreachable' })
      ];

      render(<HotKeyRotationGate />);

      await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));
      expect(mockUseTransactionRow).not.toHaveBeenCalledWith('tx-shortfall');
    });

    it('requeues an orphaned funding claim on mount and wakes the worker to run it', async () => {
      mockPlatform.isExtension = true;
      mockTable = [
        shortfallRow(),
        fundingRow('claim-1', {
          status: ITransactionStatus.GeneratingTransaction,
          processingStartedAt: 5,
          requeueStreak: { arm: 'guardian-unreachable', count: 2 }
        })
      ];

      render(<HotKeyRotationGate />);

      // An orphan reset is not a requeue down a guardian arm, so the claim's backoff starts over (#1223).
      await waitFor(() =>
        expect(mockTable[1]).toMatchObject({
          status: ITransactionStatus.Queued,
          processingStartedAt: undefined,
          requeueStreak: undefined
        })
      );
      await waitFor(() => expect(mockRequestSW).toHaveBeenCalled());
      expect(mockInitiate).not.toHaveBeenCalled();
    });

    it('adopts the live rotation when Check again is tapped while it activates', async () => {
      mockBalances = [nativeBalance(0)];
      mockTable = [rotationRow('tx-live')];
      render(<HotKeyRotationGate />);
      await waitFor(() => expect(mockUseTransactionRow).toHaveBeenCalledWith('tx-live'));
      await waitFor(() =>
        expect(screen.getByTestId('hot-key-rotation-funding-status')).toHaveAttribute('data-state', 'activating')
      );

      fireEvent.click(screen.getByTestId('hot-key-rotation-retry'));
      await publishTable();

      expect(mockInitiate).not.toHaveBeenCalled();
      expect(mockUseTransactionRow).toHaveBeenLastCalledWith('tx-live');
    });

    it('queues one rotation when two surfaces see the same claim complete', async () => {
      trackShortfall();
      mockInitiate.mockImplementation(async () => {
        mockTable = [...mockTable, rotationRow('tx-new', { initiatedAt: 400 })];
        return 'tx-new';
      });
      render(<HotKeyRotationGate />);
      render(<HotKeyRotationGate />);
      await waitFor(() => expect(screen.getAllByTestId('hot-key-rotation-funding')).toHaveLength(2));

      mockTable = [shortfallRow(), fundingRow('claim-1')];
      await publishTable();
      mockTable = [shortfallRow(), fundingRow('claim-1', { status: ITransactionStatus.Completed, completedAt: 300 })];
      await publishTable();
      await publishTable();

      expect(mockInitiate).toHaveBeenCalledTimes(1);
    });
  });

  describe('the funding state (#805)', () => {
    it('shows the address and its copy action for a rotation that fell short of its fee', async () => {
      trackShortfall();
      mockBalances = [nativeBalance(0)];

      render(<HotKeyRotationGate />);

      const panel = await screen.findByTestId('hot-key-rotation-funding');
      expect(panel).toHaveAttribute('data-funding-reason', 'rotation-shortfall');
      expect(screen.getByTestId('hot-key-rotation-funding-address')).toHaveTextContent('account-1');
      expect(screen.getByTestId('hot-key-rotation-funding-copy')).toHaveAttribute('data-copy-text', 'account-1');
      expect(screen.getByText('hotKeyRotationFundingMinimum:0.6')).toBeInTheDocument();
      expect(screen.getByTestId('hot-key-rotation-funding-status')).toHaveAttribute('data-state', 'waiting');
      expect(screen.queryByTestId('hot-key-rotation-failed')).not.toBeInTheDocument();
    });

    it('shows the panel for a balance below one fee while the first rotation runs', async () => {
      mockBalances = [nativeBalance(0)];
      mockTable = [rotationRow('tx-new')];

      render(<HotKeyRotationGate />);

      const panel = await screen.findByTestId('hot-key-rotation-funding');
      expect(panel).toHaveAttribute('data-funding-reason', 'below-base-fee');
      await waitFor(() =>
        expect(screen.getByTestId('hot-key-rotation-funding-status')).toHaveAttribute('data-state', 'activating')
      );
      expect(screen.queryByText(/hotKeyRotationFundingMinimum/)).toBeInTheDocument();
    });

    it('leaves the minimum out while the fee is unknown', async () => {
      mockBaseFee = null;
      trackShortfall();

      render(<HotKeyRotationGate />);

      await screen.findByTestId('hot-key-rotation-funding');
      expect(screen.queryByText(/hotKeyRotationFundingMinimum/)).not.toBeInTheDocument();
    });

    it('claims only the native notes, as the gate claim, with auto-consume off', async () => {
      trackShortfall();
      mockClaimable = { data: [nativeNote('n1'), nativeNote('n2', { faucetId: 'other-faucet' })], isFallback: false };

      render(<HotKeyRotationGate />);

      await waitFor(() => expect(mockEnqueue).toHaveBeenCalledTimes(1));
      expect(mockEnqueue).toHaveBeenCalledWith('account-1', [nativeNote('n1')], {
        delegate: false,
        verificationBaseFee: 10000
      });
    });

    it('kicks the service worker after queueing the claim on the extension', async () => {
      mockPlatform.isExtension = true;
      trackShortfall();
      mockClaimable = { data: [nativeNote('n1')], isFallback: false };

      render(<HotKeyRotationGate />);

      await waitFor(() => expect(mockEnqueue).toHaveBeenCalledTimes(1));
      // After the claim, not only after the mount adopted the shortfall.
      await waitFor(() =>
        expect(Math.max(...mockRequestSW.mock.invocationCallOrder)).toBeGreaterThan(
          mockEnqueue.mock.invocationCallOrder[0] ?? Infinity
        )
      );
      expect(mockLoop).not.toHaveBeenCalled();
    });

    it('keeps the panel up and logs it when queueing the claim fails', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      trackShortfall();
      mockEnqueue.mockRejectedValue(new Error('native asset is not known yet'));
      mockClaimable = { data: [nativeNote('n1')], isFallback: false };

      render(<HotKeyRotationGate />);

      await waitFor(() =>
        expect(warn).toHaveBeenCalledWith('[HotKeyRotationGate] funding claim enqueue failed:', expect.any(Error))
      );
      expect(screen.getByTestId('hot-key-rotation-funding-status')).toHaveAttribute('data-state', 'waiting');
      warn.mockRestore();
    });

    it('claims nothing while a rotation row is live', async () => {
      mockBalances = [nativeBalance(0)];
      mockTable = [rotationRow('tx-new')];
      mockClaimable = { data: [nativeNote('n1')], isFallback: false };

      render(<HotKeyRotationGate />);

      await screen.findByTestId('hot-key-rotation-funding');
      await publishTable();
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('claims nothing from the cached list', async () => {
      trackShortfall();
      mockClaimable = { data: [nativeNote('n1')], isFallback: true };

      render(<HotKeyRotationGate />);

      await screen.findByTestId('hot-key-rotation-funding');
      await publishTable();
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('retries the rotation exactly once when its funding claim completes', async () => {
      trackShortfall();
      render(<HotKeyRotationGate />);
      await screen.findByTestId('hot-key-rotation-funding');
      expect(mockInitiate).not.toHaveBeenCalled();

      mockTable = [shortfallRow(), fundingRow('claim-1')];
      await publishTable();
      expect(screen.getByTestId('hot-key-rotation-funding-status')).toHaveAttribute('data-state', 'claiming');
      mockTable = [shortfallRow(), fundingRow('claim-1', { status: ITransactionStatus.Completed, completedAt: 300 })];
      await publishTable();
      await publishTable();

      expect(mockInitiate).toHaveBeenCalledTimes(1);
    });

    it('does not queue a second rotation when a claim completes while a rotation is live', async () => {
      mockTable = [rotationRow('tx-live'), fundingRow('claim-1', { status: ITransactionStatus.GeneratingTransaction })];
      render(<HotKeyRotationGate />);
      await waitFor(() => expect(mockUseTransactionRow).toHaveBeenCalledWith('tx-live'));

      mockTable = [rotationRow('tx-live'), fundingRow('claim-1', { status: ITransactionStatus.Completed })];
      await publishTable();

      expect(mockInitiate).not.toHaveBeenCalled();
    });

    it('claims nothing more while its own claim is live', async () => {
      mockTable = [shortfallRow(), fundingRow('claim-1', { noteIds: ['n1'] })];
      mockClaimable = { data: [nativeNote('n1')], isFallback: false };

      render(<HotKeyRotationGate />);

      await screen.findByTestId('hot-key-rotation-funding');
      await publishTable();
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('does not retry again when the note its completed claim consumed leaves the list late', async () => {
      trackShortfall();
      mockEnqueue.mockResolvedValue(null);
      mockClaimable = { data: [nativeNote('n1')], isFallback: false };
      const { rerender } = render(<HotKeyRotationGate />);
      await screen.findByTestId('hot-key-rotation-funding');
      mockTable = [shortfallRow(), fundingRow('claim-1', { noteIds: ['n1'] })];
      await publishTable();
      mockTable = [
        shortfallRow(),
        fundingRow('claim-1', { noteIds: ['n1'], status: ITransactionStatus.Completed, completedAt: 300 })
      ];
      await publishTable();
      await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));
      // That retry fell short too: the note paid for its claim and little more.
      mockTable = [
        ...mockTable,
        rotationRow('tx-new', {
          status: ITransactionStatus.Failed,
          initiatedAt: 400,
          error: 'assertion failed with error code: 644413868907058392'
        })
      ];
      await publishTable();

      mockClaimable = { data: [], isFallback: false };
      rerender(<HotKeyRotationGate />);
      await publishTable();

      expect(mockInitiate).toHaveBeenCalledTimes(1);
    });

    it('does not retry for a claim that had already completed when the gate mounted', async () => {
      mockTable = [shortfallRow(), fundingRow('claim-1', { status: ITransactionStatus.Completed, completedAt: 300 })];

      render(<HotKeyRotationGate />);
      await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));
      await publishTable();

      expect(mockInitiate).toHaveBeenCalledTimes(1);
    });

    it('retries once when a watched native note leaves the list with no claim carrying it', async () => {
      trackShortfall();
      mockEnqueue.mockResolvedValue(null);
      mockClaimable = { data: [nativeNote('n1'), nativeNote('n2')], isFallback: false };
      const { rerender } = render(<HotKeyRotationGate />);
      await screen.findByTestId('hot-key-rotation-funding');

      mockClaimable = { data: [], isFallback: false };
      rerender(<HotKeyRotationGate />);
      await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));
      mockClaimable = { data: [], isFallback: false };
      rerender(<HotKeyRotationGate />);
      await publishTable();

      expect(mockInitiate).toHaveBeenCalledTimes(1);
    });

    it('retries when a note whose claim failed leaves the list: another device claimed it', async () => {
      trackShortfall();
      mockEnqueue.mockResolvedValue(null);
      mockTable = [shortfallRow(), fundingRow('claim-1', { status: ITransactionStatus.Failed, noteIds: ['n1'] })];
      mockClaimable = { data: [nativeNote('n1')], isFallback: false };
      const { rerender } = render(<HotKeyRotationGate />);
      await screen.findByTestId('hot-key-rotation-funding');

      mockClaimable = { data: [], isFallback: false };
      rerender(<HotKeyRotationGate />);

      await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));
    });

    it('does not read a fall back to the cached list as notes leaving it', async () => {
      trackShortfall();
      mockEnqueue.mockResolvedValue(null);
      mockClaimable = { data: [nativeNote('n1')], isFallback: false };
      const { rerender } = render(<HotKeyRotationGate />);
      await screen.findByTestId('hot-key-rotation-funding');

      mockClaimable = { data: [], isFallback: true };
      rerender(<HotKeyRotationGate />);
      await publishTable();

      expect(mockInitiate).not.toHaveBeenCalled();
    });

    it('keeps watching its notes through a moment the native faucet id is unknown', async () => {
      trackShortfall();
      mockEnqueue.mockResolvedValue(null);
      mockClaimable = { data: [nativeNote('n1')], isFallback: false };
      const { rerender } = render(<HotKeyRotationGate />);
      await screen.findByTestId('hot-key-rotation-funding');

      mockFaucetId = null;
      rerender(<HotKeyRotationGate />);
      await publishTable();
      expect(mockInitiate).not.toHaveBeenCalled();

      // The id is back and the note is gone: it left the list while the id was unknown.
      mockFaucetId = 'native-faucet';
      mockClaimable = { data: [], isFallback: false };
      rerender(<HotKeyRotationGate />);
      await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));
    });

    it('does not read a change of native faucet id as its notes leaving the list', async () => {
      trackShortfall();
      mockEnqueue.mockResolvedValue(null);
      mockClaimable = { data: [nativeNote('n1')], isFallback: false };
      const { rerender } = render(<HotKeyRotationGate />);
      await screen.findByTestId('hot-key-rotation-funding');

      mockFaucetId = 'other-faucet';
      rerender(<HotKeyRotationGate />);
      await publishTable();

      expect(mockInitiate).not.toHaveBeenCalled();
    });

    it('keeps the tracked shortfall when a retry defers behind a live claim', async () => {
      trackShortfall();
      mockClaimable = { data: [nativeNote('n1'), nativeNote('n2')], isFallback: false };
      const { rerender } = render(<HotKeyRotationGate />);
      await screen.findByTestId('hot-key-rotation-funding');
      mockTable = [shortfallRow(), fundingRow('claim-2', { noteIds: ['n2'] })];
      await publishTable();

      mockClaimable = { data: [nativeNote('n2', { isBeingClaimed: true })], isFallback: false };
      rerender(<HotKeyRotationGate />);
      await publishTable();

      expect(mockInitiate).not.toHaveBeenCalled();
      expect(screen.getByTestId('hot-key-rotation-funding')).toHaveAttribute(
        'data-funding-reason',
        'rotation-shortfall'
      );
    });

    it('shows a failed claim with its reason, and Try again bypasses the backoff', async () => {
      trackShortfall();
      mockTable = [
        shortfallRow(),
        fundingRow('claim-1', { status: ITransactionStatus.Failed, error: 'guardian unreachable', noteIds: ['n1'] })
      ];
      mockClaimable = { data: [nativeNote('n1')], isFallback: false };

      render(<HotKeyRotationGate />);

      await waitFor(() =>
        expect(screen.getByTestId('hot-key-rotation-funding-status')).toHaveAttribute('data-state', 'claim-failed')
      );
      expect(screen.getByText('guardian unreachable')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('hot-key-rotation-funding-claim-retry'));
      await waitFor(() =>
        expect(mockEnqueue).toHaveBeenLastCalledWith('account-1', [nativeNote('n1')], {
          delegate: false,
          manualRetry: true,
          verificationBaseFee: 10000
        })
      );
    });

    it('gives Try again and Check again a light haptic', async () => {
      trackShortfall();
      mockTable = [shortfallRow(), fundingRow('claim-1', { status: ITransactionStatus.Failed, noteIds: ['n1'] })];
      mockClaimable = { data: [nativeNote('n1')], isFallback: false };
      render(<HotKeyRotationGate />);
      const tryAgain = await screen.findByTestId('hot-key-rotation-funding-claim-retry');

      fireEvent.click(tryAgain);
      expect(hapticLight).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByTestId('hot-key-rotation-retry'));
      expect(hapticLight).toHaveBeenCalledTimes(2);
      await publishTable();
    });

    it('never shows the panel on a chain that charges nothing', async () => {
      mockBaseFee = 0;
      trackShortfall();

      render(<HotKeyRotationGate />);

      await screen.findByTestId('hot-key-rotation-failed');
      expect(screen.queryByTestId('hot-key-rotation-funding')).not.toBeInTheDocument();
    });

    it('runs the rotation it deferred once the claim fails with the fee covered', async () => {
      mockBalances = [nativeBalance(1)];
      mockTable = [shortfallRow(), fundingRow('claim-1', { status: ITransactionStatus.GeneratingTransaction })];
      render(<HotKeyRotationGate />);
      await screen.findByTestId('hot-key-rotation-funding');
      expect(mockInitiate).not.toHaveBeenCalled();

      // The cold-start sweep fails the orphaned claim the gate deferred behind.
      mockTable = [shortfallRow(), fundingRow('claim-1', { status: ITransactionStatus.Failed })];
      await publishTable();

      await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));
      expect(mockUseTransactionRow).toHaveBeenLastCalledWith('tx-new');
      // It runs and lands before the flag clears: still the one rotation.
      mockTable = [...mockTable, rotationRow('tx-new', { initiatedAt: 400 })];
      await publishTable();
      mockTable = [
        shortfallRow(),
        fundingRow('claim-1', { status: ITransactionStatus.Failed }),
        rotationRow('tx-new', { status: ITransactionStatus.Completed, initiatedAt: 400 })
      ];
      await publishTable();
      expect(mockInitiate).toHaveBeenCalledTimes(1);
    });

    it('waits on a rotation another surface queued while it deferred', async () => {
      mockBalances = [nativeBalance(1)];
      mockTable = [shortfallRow(), fundingRow('claim-1', { status: ITransactionStatus.GeneratingTransaction })];
      render(<HotKeyRotationGate />);
      await screen.findByTestId('hot-key-rotation-funding');

      const claimed = () => fundingRow('claim-1', { status: ITransactionStatus.Completed, completedAt: 300 });
      mockTable = [shortfallRow(), claimed(), rotationRow('tx-other', { initiatedAt: 400 })];
      await publishTable();
      expect(mockInitiate).not.toHaveBeenCalled();

      mockTable = [
        shortfallRow(),
        claimed(),
        rotationRow('tx-other', { status: ITransactionStatus.Failed, initiatedAt: 400, error: 'guardian unreachable' })
      ];
      await publishTable();
      await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));
    });

    it('waits for its claim on a chain that charges nothing, then runs the rotation', async () => {
      mockBaseFee = 0;
      mockTable = [fundingRow('claim-1', { status: ITransactionStatus.GeneratingTransaction })];
      render(<HotKeyRotationGate />);
      await publishTable();
      await publishTable();
      // One try, the mount's: while the claim is live the lock would only defer another.
      expect(lockRequests.filter(name => name === 'hot-key-rotation:account-1')).toHaveLength(1);
      expect(mockInitiate).not.toHaveBeenCalled();

      mockTable = [fundingRow('claim-1', { status: ITransactionStatus.Failed })];
      await publishTable();

      await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));
    });

    it('tries again on the next rows read after a deferral that read newer rows', async () => {
      mockBalances = [nativeBalance(0)];
      mockTable = [fundingRow('claim-1', { status: ITransactionStatus.GeneratingTransaction })];
      const { rerender } = render(<HotKeyRotationGate />);
      await screen.findByTestId('hot-key-rotation-funding');
      mockTable = [fundingRow('claim-1', { status: ITransactionStatus.Failed })];
      await publishTable();

      // Another surface queues a claim this gate has not read yet, and the fee is now covered.
      mockTable = [...mockTable, fundingRow('claim-2', { initiatedAt: 300 })];
      mockBalances = [nativeBalance(1)];
      rerender(<HotKeyRotationGate />);
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      expect(lockRequests.filter(name => name === 'hot-key-rotation:account-1')).toHaveLength(2);
      expect(mockInitiate).not.toHaveBeenCalled();

      mockTable = [
        fundingRow('claim-1', { status: ITransactionStatus.Failed }),
        fundingRow('claim-2', { status: ITransactionStatus.Failed, initiatedAt: 300 })
      ];
      await publishTable();

      await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));
    });

    it('adopts the prior shortfall, not a fresh rotation, when its claim ends before balances load', async () => {
      mockBalancesLoading = true;
      trackShortfall();
      mockTable = [shortfallRow(), fundingRow('claim-1', { status: ITransactionStatus.GeneratingTransaction })];
      render(<HotKeyRotationGate />);
      await screen.findByTestId('hot-key-rotation-funding');

      mockTable = [shortfallRow(), fundingRow('claim-1', { status: ITransactionStatus.Failed })];
      await publishTable();

      await waitFor(() => expect(mockUseTransactionRow).toHaveBeenLastCalledWith('tx-shortfall'));
      expect(screen.getByTestId('hot-key-rotation-funding')).toHaveAttribute(
        'data-funding-reason',
        'rotation-shortfall'
      );
      expect(mockInitiate).not.toHaveBeenCalled();
    });

    it('shows the classified shortfall, not the raw kernel line, on a chain that charges nothing', async () => {
      mockBaseFee = 0;
      trackShortfall();

      render(<HotKeyRotationGate />);

      await screen.findByTestId('hot-key-rotation-failed');
      expect(screen.getByText(TRANSACTION_VAULT_SHORTFALL_ERROR)).toBeInTheDocument();
      expect(screen.queryByText(/assertion failed/)).not.toBeInTheDocument();
    });
  });
});

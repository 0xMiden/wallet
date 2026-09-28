import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
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

let storeState: { currentAccount?: Partial<WalletAccount> };
// Simulates another surface actively holding the generate-transactions-loop
// Web Lock (i.e. a generation is genuinely in flight somewhere).
let loopLockHeld = false;

type LockCallback = (lock: { name: string } | null) => unknown;

beforeAll(() => {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (name: string, optsOrCb: { ifAvailable?: boolean } | LockCallback, maybeCb?: LockCallback) => {
        const callback = (maybeCb ?? optsOrCb) as LockCallback;
        const opts = maybeCb ? (optsOrCb as { ifAvailable?: boolean }) : undefined;
        if (opts?.ifAvailable && loopLockHeld) return Promise.resolve(callback(null));
        return Promise.resolve(callback({ name }));
      }
    }
  });
});

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/miden/activity', () => ({
  initiateReplaceHotKeyTransaction: (...args: unknown[]) => mockInitiate(...args),
  requestSWTransactionProcessing: () => mockRequestSW(),
  safeGenerateTransactionsLoop: (...args: unknown[]) => mockLoop(...args)
}));

jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({ signTransaction: jest.fn() })
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

jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: jest.fn()
}));

jest.mock('lib/platform', () => ({
  isExtension: () => false,
  isMobile: () => false
}));

jest.mock('lib/settings/helpers', () => ({
  isDelegateProofEnabled: () => false
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

jest.mock('components/Button', () => ({
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
const shortfallRow = rotationRow('tx-shortfall', {
  status: ITransactionStatus.Failed,
  completedAt: 150,
  error: 'assertion failed with error code: 644413868907058392'
});

describe('HotKeyRotationGate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storeState = { currentAccount: flaggedAccount };
    loopLockHeld = false;
    mockTable = [];
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
      mockTable = [shortfallRow, fundingRow('claim-1', { status: ITransactionStatus.GeneratingTransaction })];

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
        shortfallRow
      ];

      render(<HotKeyRotationGate />);

      await waitFor(() => expect(mockUseTransactionRow).toHaveBeenCalledWith('tx-shortfall'));
      expect(mockInitiate).not.toHaveBeenCalled();
    });

    it('queues a fresh rotation on Retry instead of adopting the shortfall again', async () => {
      mockTable = [shortfallRow];
      mockUseTransactionRow.mockImplementation((txId: string) => ({
        row: txId === 'tx-shortfall' ? shortfallRow : undefined,
        loaded: true
      }));
      render(<HotKeyRotationGate />);
      await waitFor(() => expect(mockUseTransactionRow).toHaveBeenCalledWith('tx-shortfall'));

      fireEvent.click(screen.getByTestId('hot-key-rotation-retry'));

      await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));
    });

    it('queues a fresh rotation on mount once a claim completed after the shortfall', async () => {
      mockTable = [shortfallRow, fundingRow('claim-1', { status: ITransactionStatus.Completed, completedAt: 300 })];

      render(<HotKeyRotationGate />);

      await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));
      expect(mockUseTransactionRow).toHaveBeenCalledWith('tx-new');
    });

    it('does not adopt a rotation that failed for another reason, or only the older of two', async () => {
      mockTable = [
        shortfallRow,
        rotationRow('tx-later', { status: ITransactionStatus.Failed, initiatedAt: 160, error: 'guardian unreachable' })
      ];

      render(<HotKeyRotationGate />);

      await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));
      expect(mockUseTransactionRow).not.toHaveBeenCalledWith('tx-shortfall');
    });
  });
});

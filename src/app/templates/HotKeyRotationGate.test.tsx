import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ITransactionStatus } from 'lib/miden/db/types';
import type { WalletAccount } from 'lib/shared/types';

import { HotKeyRotationGate } from './HotKeyRotationGate';

const mockInitiate = jest.fn();
const mockRequestSW = jest.fn();
const mockLoop = jest.fn();
const mockRepoFirst = jest.fn();
const mockRepoModify = jest.fn();
const mockUseTransactionRow = jest.fn();

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
    filter: () => ({
      first: () => mockRepoFirst(),
      modify: (fn: (r: unknown) => void) => mockRepoModify(fn)
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

jest.mock('app/atoms/Spinner/Spinner', () => ({
  __esModule: true,
  default: () => <div data-testid="spinner" />
}));

jest.mock('components/Button', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  )
}));

const flaggedAccount = { publicKey: 'account-1', requiresHotKeyRotation: true };

describe('HotKeyRotationGate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storeState = { currentAccount: flaggedAccount };
    loopLockHeld = false;
    mockRepoFirst.mockResolvedValue(undefined);
    mockRepoModify.mockResolvedValue(0);
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

  it('adopts an existing pending rotation row instead of initiating a new one', async () => {
    mockRepoFirst.mockResolvedValue({ id: 'tx-existing', status: ITransactionStatus.Queued });

    render(<HotKeyRotationGate />);

    await waitFor(() => expect(mockUseTransactionRow).toHaveBeenCalledWith('tx-existing'));
    expect(mockInitiate).not.toHaveBeenCalled();
  });

  it('requeues orphaned in-progress rows before adopting when no generation loop is running', async () => {
    mockRepoFirst.mockResolvedValue({ id: 'tx-orphan', status: ITransactionStatus.GeneratingTransaction });

    render(<HotKeyRotationGate />);

    await waitFor(() => expect(mockUseTransactionRow).toHaveBeenCalledWith('tx-orphan'));
    expect(mockRepoModify).toHaveBeenCalledTimes(1);
    expect(mockInitiate).not.toHaveBeenCalled();
  });

  it('does not requeue in-progress rows while another surface holds the loop lock', async () => {
    loopLockHeld = true;
    mockRepoFirst.mockResolvedValue({ id: 'tx-live', status: ITransactionStatus.GeneratingTransaction });

    render(<HotKeyRotationGate />);

    await waitFor(() => expect(mockUseTransactionRow).toHaveBeenCalledWith('tx-live'));
    expect(mockRepoModify).not.toHaveBeenCalled();
    expect(mockInitiate).not.toHaveBeenCalled();
  });

  it('shows the failure reason and retries with a fresh transaction', async () => {
    mockUseTransactionRow.mockReturnValue({
      row: { id: 'tx-new', status: ITransactionStatus.Failed, error: 'guardian unreachable' },
      loaded: true
    });

    render(<HotKeyRotationGate />);
    await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));

    expect(screen.getByText('hotKeyRotationFailedTitle')).toBeInTheDocument();
    expect(screen.getByText('guardian unreachable')).toBeInTheDocument();

    // Retry must NOT adopt the failed row — a new transaction is enqueued.
    mockRepoFirst.mockClear();
    fireEvent.click(screen.getByText('hotKeyRotationRetry'));
    await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(2));
    expect(mockRepoFirst).not.toHaveBeenCalled();
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
});

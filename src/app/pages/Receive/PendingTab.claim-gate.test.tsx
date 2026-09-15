import React from 'react';

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import { useClaimNotes } from 'app/hooks/useClaimNotes';

import { NoteWithMetadata, PendingTab } from './PendingTab';

// A row's claim has to keep its note in flight after the row is gone. That spans the hook, which owns the gate, and the
// tab, which unmounts the row, so this renders both and stubs only their leaf collaborators.

const mockGetFailedTransactions = jest.fn();
const mockInitiateConsume = jest.fn();
jest.mock('lib/miden/activity', () => ({
  getFailedTransactions: (...args: unknown[]) => mockGetFailedTransactions(...args),
  queueConsumeNotes: async (accountId: string, notes: { id: string }[]) => {
    const committedId = await mockInitiateConsume(accountId, notes);
    return { committedId, coveringTxIdByNoteId: new Map(notes.map(n => [n.id, committedId])) };
  },
  requestSWTransactionProcessing: jest.fn(),
  startBackgroundTransactionProcessing: jest.fn(),
  verifyStuckTransactionsFromNode: jest.fn().mockResolvedValue(0)
}));

jest.mock('lib/miden/back/miden-client-proxy', () => ({
  midenClientProxy: { getInputNoteDetails: jest.fn().mockResolvedValue([]) }
}));

jest.mock('lib/miden/sdk/miden-client', () => ({
  withWasmClientLock: (fn: () => unknown) => fn(),
  assertWasmHoldCurrent: jest.fn()
}));

const mockSignTransaction = jest.fn();
jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: 'mtst1account' }),
  useMidenContext: () => ({ signTransaction: mockSignTransaction })
}));

jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: {} }));

const mockClaimable: { data: NoteWithMetadata[]; mutate: jest.Mock } = { data: [], mutate: jest.fn() };
jest.mock('lib/miden/front/claimable-notes', () => ({
  useClaimableNotes: () => mockClaimable
}));

jest.mock('lib/settings/helpers', () => ({ isDelegateProofEnabled: () => false }));

jest.mock('lib/platform', () => ({ isExtension: () => false, isMobile: () => false }));

jest.mock('lib/woozie', () => ({ navigate: jest.fn() }));

jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => 'native-faucet' }));

jest.mock('app/hooks/useVerificationBaseFee', () => ({ __esModule: true, default: () => 0 }));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

let mockBackHandler: (() => void) | null = null;
jest.mock('app/env', () => ({
  useAppEnv: () => ({
    registerBackHandler: (handler: () => void) => {
      mockBackHandler = handler;
      return () => {
        if (mockBackHandler === handler) mockBackHandler = null;
      };
    }
  })
}));

jest.mock('lib/store', () => ({
  getIntercom: jest.fn(),
  useWalletStore: (selector: (s: { tokenPrices: unknown }) => unknown) => selector({ tokenPrices: {} })
}));

jest.mock('lib/prices', () => ({ getTokenPrice: () => ({ price: 0 }) }));

jest.mock('lib/i18n/numbers', () => ({
  formatBigInt: (amount: bigint | string) => amount.toString(),
  formatUsd: (value: number) => `$${value}`
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

jest.mock('components/TokenLogo', () => ({ TokenLogo: () => <div /> }));

jest.mock('components/SyncWaveBackground', () => ({ SyncWaveBackground: () => <div /> }));

jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' },
  Button: ({ title, onClick, disabled, ...props }: { title?: string; onClick?: () => void; disabled?: boolean }) => (
    <button data-testid={(props as Record<string, string>)['data-testid']} onClick={onClick} disabled={disabled}>
      {title}
    </button>
  )
}));

const n1 = {
  id: 'n1',
  faucetId: 'faucet1',
  amount: '1000000',
  isBeingClaimed: false,
  type: 'unknown',
  senderAddress: 'mtst1sender',
  metadata: { symbol: 'TST', decimals: 6, name: 'Test Token' }
} as unknown as NoteWithMetadata;

/** The same wiring PendingNotes gives the tab. */
function Harness() {
  const claim = useClaimNotes();
  return (
    <PendingTab
      safeClaimableNotes={claim.safeClaimableNotes}
      claimingNoteIds={claim.claimingNoteIds}
      retriableNoteIds={claim.retriableNoteIds}
      invalidNoteIds={claim.invalidNoteIds}
      checkingNoteIds={claim.checkingNoteIds}
      onClaimNote={claim.handleClaimNote}
      onClaimAll={claim.handleClaimAll}
      onClaimGroup={claim.handleClaimGroup}
    />
  );
}

/** An enqueue parked until the test settles it. */
function parkEnqueue() {
  let resolve: (id: string) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  mockInitiateConsume.mockReturnValueOnce(
    new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    })
  );
  return { resolve: (id: string) => resolve(id), reject: (reason: unknown) => reject(reason) };
}

/** Opens the group, taps its row's Claim, and backs out to the summary while the enqueue is still parked. */
async function claimFromRowThenBackOut() {
  render(<Harness />);
  fireEvent.click(await screen.findByTestId('pending-asset-row'));
  fireEvent.click(await within(await screen.findByTestId('detail-note-row')).findByTestId('claim-button'));
  expect(mockInitiateConsume).toHaveBeenCalled();

  await act(async () => {
    mockBackHandler?.();
  });
  expect(screen.queryByTestId('detail-note-row')).not.toBeInTheDocument();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBackHandler = null;
  mockClaimable.data = [n1];
  mockClaimable.mutate.mockResolvedValue([n1]);
  mockGetFailedTransactions.mockResolvedValue([]);
});

describe('a row claim after its row is gone', () => {
  it('keeps the summary in its claiming state when the group view closes while the claim is still queueing', async () => {
    // The row used to mirror its claim into a set of its own and clear it on unmount while the enqueue kept going, so
    // backing out of the group mid-claim put an actionable Claim All back over a consume still being queued.
    const enqueue = parkEnqueue();
    await claimFromRowThenBackOut();

    await act(async () => {
      enqueue.resolve('tx-1');
    });

    expect(screen.queryByTestId('claim-all-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('claim-all-status')).toBeInTheDocument();
    expect(jest.requireMock('lib/woozie').navigate).not.toHaveBeenCalled();
  });

  it('flags the note and offers Claim All again when that enqueue fails', async () => {
    const enqueue = parkEnqueue();
    await claimFromRowThenBackOut();
    // Positive control: the claim reads as in flight until its enqueue settles.
    expect(screen.getByTestId('claim-all-status')).toBeInTheDocument();

    await act(async () => {
      enqueue.reject(new Error('queue failed'));
    });

    expect(await screen.findByTestId('claim-all-button')).toBeInTheDocument();
    expect(screen.getByText('notesUnresolved')).toBeInTheDocument();
  });
});

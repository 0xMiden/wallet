import React from 'react';

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import type { ReportClaim } from 'app/hooks/useReportNoteClaim';
import { initiateConsumeTransaction } from 'lib/miden/activity';

import { PendingTab, NoteWithMetadata } from './PendingTab';

// PendingTab renders the pending-notes summary + per-asset detail. We render the
// real component and only stub leaf collaborators (store, prices, haptics, SVG /
// button chrome) so the failed/unavailable-note treatment (#456) is exercised
// end to end. `t` is the identity function, so an assertion on a rendered key
// (e.g. 'noteUnavailable') proves that key was chosen.

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/env', () => ({
  useAppEnv: () => ({ registerBackHandler: () => () => {} })
}));

jest.mock('lib/store', () => ({
  useWalletStore: (selector: (s: { tokenPrices: unknown }) => unknown) => selector({ tokenPrices: {} })
}));

jest.mock('lib/prices', () => ({
  getTokenPrice: () => ({ price: 0 })
}));

jest.mock('lib/i18n/numbers', () => ({
  formatBigInt: (amount: bigint | string) => amount.toString(),
  formatUsd: (value: number) => `$${value}`
}));

jest.mock('lib/miden/activity', () => ({
  initiateConsumeTransaction: jest.fn().mockResolvedValue('tx-id'),
  requestSWTransactionProcessing: jest.fn()
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

jest.mock('lib/platform', () => ({
  isExtension: () => false
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

jest.mock('components/TokenLogo', () => ({
  TokenLogo: () => <div data-testid="token-logo" />
}));

jest.mock('components/SyncWaveBackground', () => ({
  SyncWaveBackground: ({ isSyncing }: { isSyncing?: boolean }) => (
    <div data-testid="sync-wave" data-syncing={String(!!isSyncing)} />
  )
}));

jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' },
  Button: ({ title, onClick, ...props }: { title?: string; onClick?: () => void }) => (
    <button data-testid={(props as Record<string, string>)['data-testid']} onClick={onClick}>
      {title}
    </button>
  )
}));

const makeNote = (id: string, over: Partial<NoteWithMetadata> = {}): NoteWithMetadata =>
  ({
    id,
    faucetId: 'faucet1',
    amount: '1000000',
    isBeingClaimed: false,
    type: 'unknown',
    senderAddress: `mtst1sender_${id}`,
    metadata: { symbol: 'TST', decimals: 6, name: 'Test Token' },
    ...over
  }) as unknown as NoteWithMetadata;

const baseProps = {
  safeClaimableNotes: [] as NoteWithMetadata[],
  account: { publicKey: 'mtst1account' } as never,
  isDelegatedProvingEnabled: false,
  unclaimedNotesCount: 1,
  claimingNoteIds: new Set<string>(),
  retriableNoteIds: new Set<string>(),
  invalidNoteIds: new Set<string>(),
  checkingNoteIds: new Set<string>(),
  onClaimingStateChange: jest.fn(),
  onClaimAll: jest.fn(),
  onClaimGroup: jest.fn()
};

const renderTab = (props: Partial<React.ComponentProps<typeof PendingTab>> = {}) =>
  render(<PendingTab {...baseProps} {...props} />);

/** Enter the per-asset detail view by tapping its summary row. */
const openDetail = () => fireEvent.click(screen.getByTestId('pending-asset-row'));

describe('PendingTab — AssetSummaryRow attention badge (#456)', () => {
  it('shows the "needs attention" badge (not the neutral count) when a group note is retriable', () => {
    renderTab({
      safeClaimableNotes: [makeNote('a'), makeNote('b')],
      retriableNoteIds: new Set(['a'])
    });

    expect(screen.getByText('notesUnresolved')).toBeInTheDocument();
    expect(screen.queryByText('incomingTransfersCount')).not.toBeInTheDocument();
  });

  it('shows the "needs attention" badge when a group note is terminally invalid', () => {
    renderTab({
      safeClaimableNotes: [makeNote('a'), makeNote('b')],
      invalidNoteIds: new Set(['b'])
    });

    expect(screen.getByText('notesUnresolved')).toBeInTheDocument();
    expect(screen.queryByText('incomingTransfersCount')).not.toBeInTheDocument();
  });

  it('shows the neutral incoming-count pill (no attention badge) when no note is failed/invalid', () => {
    renderTab({ safeClaimableNotes: [makeNote('a'), makeNote('b')] });

    expect(screen.getByText('incomingTransfersCount')).toBeInTheDocument();
    expect(screen.queryByText('notesUnresolved')).not.toBeInTheDocument();
  });
});

describe('PendingTab — DetailNoteRow treatment (#456)', () => {
  it('keeps the token symbol in the rendered amount contract', () => {
    renderTab({ safeClaimableNotes: [makeNote('a')] });
    openDetail();

    expect(screen.getByTestId('detail-note-amount')).toHaveTextContent('1000000TST');
  });

  it('renders Retry + the retry explanation for a retriable note', () => {
    renderTab({
      safeClaimableNotes: [makeNote('a')],
      retriableNoteIds: new Set(['a'])
    });
    openDetail();

    const row = screen.getByTestId('detail-note-row');
    expect(within(row).getByText('noteClaimFailedRetry')).toBeInTheDocument();
    expect(within(row).getByTestId('claim-button')).toHaveTextContent('retry');
  });

  it('renders the "no longer available" explanation and NO button for a terminally-invalid note', () => {
    renderTab({
      safeClaimableNotes: [makeNote('a')],
      invalidNoteIds: new Set(['a'])
    });
    openDetail();

    const row = screen.getByTestId('detail-note-row');
    expect(within(row).getByText('noteUnavailable')).toBeInTheDocument();
    expect(within(row).queryByTestId('claim-button')).not.toBeInTheDocument();
  });

  it('renders the Claim button (no error text) for a plain pending note', () => {
    renderTab({ safeClaimableNotes: [makeNote('a')] });
    openDetail();

    const row = screen.getByTestId('detail-note-row');
    expect(within(row).getByTestId('claim-button')).toHaveTextContent('claim');
    expect(within(row).queryByText('noteClaimFailedRetry')).not.toBeInTheDocument();
    expect(within(row).queryByText('noteUnavailable')).not.toBeInTheDocument();
  });

  it('renders a spinner and NO button for a note being consumed', () => {
    renderTab({
      safeClaimableNotes: [makeNote('a')],
      claimingNoteIds: new Set(['a'])
    });
    openDetail();

    const row = screen.getByTestId('detail-note-row');
    expect(within(row).queryByTestId('claim-button')).not.toBeInTheDocument();
    expect(within(row).getByTestId('sync-wave')).toHaveAttribute('data-syncing', 'true');
  });
});

describe('PendingTab — per-note claim reporting', () => {
  // The page that hosts this tab owns the note_handle flow; the tab's job is
  // only to route a per-note claim through the reporter it was given, so a
  // single-note claim is not invisible next to Claim All.
  beforeEach(() => {
    jest.mocked(initiateConsumeTransaction).mockReset().mockResolvedValue('tx-id');
  });

  /** A pass-through reporter plus a spy recording each attempt it wrapped. */
  const spyingReporter = () => {
    const reported = jest.fn();
    const reportClaim: ReportClaim = attempt => {
      reported();
      return attempt();
    };
    return { reported, reportClaim };
  };

  it('routes a per-note claim through the reporter', async () => {
    const { reported, reportClaim } = spyingReporter();
    renderTab({ safeClaimableNotes: [makeNote('a')], reportClaim });
    openDetail();

    fireEvent.click(within(screen.getByTestId('detail-note-row')).getByTestId('claim-button'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(reported).toHaveBeenCalledTimes(1);
    expect(initiateConsumeTransaction).toHaveBeenCalledTimes(1);
  });

  it('still queues the claim when no reporter is supplied', async () => {
    renderTab({ safeClaimableNotes: [makeNote('a')] });
    openDetail();

    fireEvent.click(within(screen.getByTestId('detail-note-row')).getByTestId('claim-button'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(initiateConsumeTransaction).toHaveBeenCalledTimes(1);
  });

  it('keeps the row error handling when a reported claim fails', async () => {
    const failing = jest.mocked(initiateConsumeTransaction);
    failing.mockRejectedValueOnce(new Error('queue failed'));
    const { reported, reportClaim } = spyingReporter();
    renderTab({ safeClaimableNotes: [makeNote('a')], reportClaim });
    openDetail();

    fireEvent.click(within(screen.getByTestId('detail-note-row')).getByTestId('claim-button'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(reported).toHaveBeenCalledTimes(1);
    // The row's own failure treatment (#456) is untouched: retriable, with Retry.
    const row = screen.getByTestId('detail-note-row');
    expect(within(row).getByText('noteClaimFailedRetry')).toBeInTheDocument();
    expect(within(row).getByTestId('claim-button')).toHaveTextContent('retry');
  });
});

import React from 'react';

import { fireEvent, render, screen, within } from '@testing-library/react';

import { PendingTab, NoteWithMetadata } from './PendingTab';

// PendingTab renders the pending-notes summary + per-asset detail. We render the
// real component and only stub leaf collaborators (store, prices, haptics, SVG /
// button chrome) so the failed/unavailable-note treatment (#456) is exercised
// end to end. `t` is the identity function, so an assertion on a rendered key
// (e.g. 'noteUnavailable') proves that key was chosen.

/** The chain's native (fee) faucet. `makeNote` defaults to a NON-native faucet. */
const NATIVE_FAUCET = 'native-faucet';

let mockBaseFee: number | null = 0;
jest.mock('app/hooks/useVerificationBaseFee', () => ({ __esModule: true, default: () => mockBaseFee }));

let mockNativeFaucetId: string | null = NATIVE_FAUCET;
jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => mockNativeFaucetId }));
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
  Button: ({ title, onClick, disabled, ...props }: { title?: string; onClick?: () => void; disabled?: boolean }) => (
    <button data-testid={(props as Record<string, string>)['data-testid']} onClick={onClick} disabled={disabled}>
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

describe('PendingTab — dust notes', () => {
  it('marks a NATIVE group the wallet will not auto-claim because it is worth less than the fee', () => {
    // Auto-consume skips these, so without a hint the note just sits there with no
    // explanation. Claiming stays available -- the user may still want it.
    mockBaseFee = 2000000;
    renderTab({
      safeClaimableNotes: [makeNote('dust', { amount: '1000000', faucetId: NATIVE_FAUCET })]
    });

    expect(screen.getByText('notWorthClaiming')).toBeInTheDocument();
  });

  it('does not mark a NATIVE group worth more than the fee', () => {
    mockBaseFee = 100;
    renderTab({
      safeClaimableNotes: [makeNote('rich', { amount: '1000000', faucetId: NATIVE_FAUCET })]
    });

    expect(screen.queryByText('notWorthClaiming')).not.toBeInTheDocument();
  });

  it('never marks a NON-NATIVE group, whatever its base-unit total', () => {
    // The fee is quoted in the native asset's base units. Comparing another asset's
    // base units against it compares two different currencies, so a perfectly
    // valuable token group was labelled unclaimable purely because its raw total
    // happened to be a small number -- and auto-consume never touches non-native
    // notes at all, so the label's premise does not even apply to them.
    mockBaseFee = 2000000;
    renderTab({ safeClaimableNotes: [makeNote('token-dust', { amount: '1' })] });

    expect(screen.queryByText('notWorthClaiming')).not.toBeInTheDocument();
  });

  it('marks nothing while the native faucet is still unknown', () => {
    // Discovery is async. Labelling before it lands would guess which asset is native.
    mockBaseFee = 2000000;
    mockNativeFaucetId = null;
    renderTab({
      safeClaimableNotes: [makeNote('dust', { amount: '1', faucetId: NATIVE_FAUCET })]
    });

    expect(screen.queryByText('notWorthClaiming')).not.toBeInTheDocument();
    mockNativeFaucetId = NATIVE_FAUCET;
  });
});

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

describe('PendingTab — fee disclosure on the claim buttons', () => {
  // Every claim button on these screens submits with NO review step in between, so
  // this is the only place the cost can be stated before the user commits.

  it('tells the detail screen the fee is charged once per claim when the group holds several notes', () => {
    // The amount is identical for every button here; what differs is how many times it
    // is charged. The group button consumes all of one faucet's notes in a single
    // transaction (one fee); tapping the rows one at a time is one transaction each.
    // Breaks if the `feeChargedPerClaim` line is dropped from the footer.
    mockBaseFee = 2000000;
    renderTab({ safeClaimableNotes: [makeNote('a'), makeNote('b')] });
    openDetail();

    expect(screen.getByText('feeChargedPerClaim')).toBeInTheDocument();
  });

  it('omits the per-claim line when the group holds a single note', () => {
    // "Claiming them together pays one" is meaningless with nothing to group.
    // Breaks if the `notes.length > 1` gate is removed.
    mockBaseFee = 2000000;
    renderTab({ safeClaimableNotes: [makeNote('only')] });
    openDetail();

    expect(screen.queryByText('feeChargedPerClaim')).not.toBeInTheDocument();
  });

  it('warns on Claim All that the fee is charged once per asset when several are pending', () => {
    // Claim All submits one transaction PER FAUCET, so the single-transaction bound
    // shown above it understates the total by a factor of the asset count.
    // Breaks if the `feeChargedPerAsset` line is dropped.
    mockBaseFee = 2000000;
    renderTab({
      safeClaimableNotes: [makeNote('a', { faucetId: 'faucet1' }), makeNote('b', { faucetId: 'faucet2' })]
    });

    expect(screen.getByText('feeChargedPerAsset')).toBeInTheDocument();
  });

  it('omits the per-asset line when only one asset is pending', () => {
    // One asset is one transaction, so the bound above the button is already exact.
    // Breaks if the `totals.assetsCount > 1` gate is removed.
    mockBaseFee = 2000000;
    renderTab({ safeClaimableNotes: [makeNote('a'), makeNote('b')] });

    expect(screen.queryByText('feeChargedPerAsset')).not.toBeInTheDocument();
  });

  it('states no fee at all while the base fee is unknown', () => {
    // House convention: render nothing rather than 0, "unknown" or a guess. This state
    // is reachable -- discovery latches a 60s retry cooldown -- and the buttons stay
    // enabled throughout. Breaks if any `maxNetworkFee &&` guard is removed.
    mockBaseFee = null;
    renderTab({ safeClaimableNotes: [makeNote('a'), makeNote('b', { faucetId: 'faucet2' })] });

    expect(screen.queryByText('networkFeeMax')).not.toBeInTheDocument();
    expect(screen.queryByText('feeChargedPerAsset')).not.toBeInTheDocument();
    mockBaseFee = 0;
  });
});

describe('PendingTab — the summary while a claim is in flight', () => {
  // Claiming no longer navigates away, so this screen has to say what is happening. Every note
  // being claimed drops out of `unclaimedNotesCount` (useClaimNotes filters `isBeingClaimed`),
  // so gating the CTA on that count alone left the user tapping "Claim All" and watching the
  // button vanish with nothing in its place.
  it('keeps a control and reports progress when every note is being claimed', () => {
    renderTab({
      safeClaimableNotes: [makeNote('n1', { isBeingClaimed: true })],
      unclaimedNotesCount: 0
    });

    // Its own id: the E2E helper treats a visible `claim-all-button` as permission to click, so
    // a disabled button under that id would make it click a control it cannot action.
    expect(screen.queryByTestId('claim-all-button')).not.toBeInTheDocument();
    const status = screen.getByTestId('claim-all-status');
    expect(status).toBeDisabled();
    expect(status).toHaveTextContent('claiming');
  });

  it('offers Claim All again once a note is claimable', () => {
    renderTab({ safeClaimableNotes: [makeNote('n1')], unclaimedNotesCount: 1 });

    const button = screen.getByTestId('claim-all-button');
    expect(button).not.toBeDisabled();
    expect(button).toHaveTextContent('claimAll');
    expect(screen.queryByTestId('claim-all-status')).not.toBeInTheDocument();
  });

  it('renders no claim control when there is nothing pending and nothing in flight', () => {
    renderTab({ safeClaimableNotes: [], unclaimedNotesCount: 0 });

    expect(screen.queryByTestId('claim-all-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('claim-all-status')).not.toBeInTheDocument();
  });
});

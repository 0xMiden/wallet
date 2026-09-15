import React from 'react';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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

// Claims arrive through the onClaimNote prop, but PendingTab still loads this module transitively (useNetworkFeeEstimate
// -> lib/shared/format -> lib/miden/front), and loading it for real runs platform checks this suite does not mock.
jest.mock('lib/miden/activity', () => ({}));

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
  // Mirrors the real Button (components/Button.tsx): `isLoading` renders a Loader INSTEAD of the
  // title. A mock that always renders `title` makes any assertion on the label a false positive --
  // which is how a labelless "Claiming…" pill once passed this suite.
  Button: ({
    title,
    onClick,
    disabled,
    isLoading,
    ...props
  }: {
    title?: string;
    onClick?: () => void;
    disabled?: boolean;
    isLoading?: boolean;
  }) => (
    <button data-testid={(props as Record<string, string>)['data-testid']} onClick={onClick} disabled={disabled}>
      {isLoading ? <span data-testid="btn-loader" /> : title}
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
  claimingNoteIds: new Set<string>(),
  retriableNoteIds: new Set<string>(),
  invalidNoteIds: new Set<string>(),
  checkingNoteIds: new Set<string>(),
  onClaimNote: jest.fn().mockResolvedValue('tx-id'),
  onClaimAll: jest.fn(),
  onClaimGroup: jest.fn()
};

const renderTab = (props: Partial<React.ComponentProps<typeof PendingTab>> = {}) =>
  render(<PendingTab {...baseProps} {...props} />);

/** Enter the per-asset detail view by tapping its summary row. */
const openDetail = () => fireEvent.click(screen.getByTestId('pending-asset-row'));

beforeEach(() => {
  // Module-level fixtures with no reset: a describe otherwise inherits whatever the previously-run
  // test left, which silently made a fee assertion unreachable in a later block.
  mockBaseFee = 0;
});

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

describe('PendingTab - the group view counts every in-flight signal', () => {
  it('disables the group claim when its only unclaimed note is held by a claim this page queued', () => {
    // The group view kept its own copy of the in-flight filter, so a note already being claimed still counted as
    // claimable there while the summary counted it as in flight.
    const { rerender } = renderTab({ safeClaimableNotes: [makeNote('n1')] });
    openDetail();
    // Positive control: with no in-flight signal the group claim is actionable.
    expect(screen.getByTestId('claim-group-button')).not.toBeDisabled();

    rerender(<PendingTab {...baseProps} safeClaimableNotes={[makeNote('n1')]} claimingNoteIds={new Set(['n1'])} />);

    expect(screen.getByTestId('claim-group-button')).toBeDisabled();
  });
});

describe('PendingTab - a row claim', () => {
  const mockNavigate = jest.requireMock('lib/woozie').navigate as jest.Mock;
  const claimRow = () => fireEvent.click(within(screen.getByTestId('detail-note-row')).getByTestId('claim-button'));

  beforeEach(() => {
    mockNavigate.mockClear();
  });

  it('claims through onClaimNote and opens the progress screen for the row it returns', async () => {
    const onClaimNote = jest.fn().mockResolvedValue('tx-1');
    renderTab({ safeClaimableNotes: [makeNote('n1')], onClaimNote });
    openDetail();

    claimRow();

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction-full/tx-1'));
    expect(onClaimNote).toHaveBeenCalledWith(expect.objectContaining({ id: 'n1' }));
  });

  it('does not navigate when the row unmounts before its claim settles', async () => {
    // Unmounting cancels only the row's navigation: the claim and the note's gate belong to the hook.
    let settle: (id: string) => void = () => {};
    const onClaimNote = jest.fn(
      () =>
        new Promise<string>(resolve => {
          settle = resolve;
        })
    );
    const { unmount } = renderTab({ safeClaimableNotes: [makeNote('n1')], onClaimNote });
    openDetail();
    claimRow();
    expect(onClaimNote).toHaveBeenCalled();

    unmount();
    await act(async () => {
      settle('tx-1');
    });

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does not navigate when nothing was queued', async () => {
    // A queue-time failure resolves to null: the hook has already flagged the note, so there is no row to show.
    const onClaimNote = jest.fn().mockResolvedValue(null);
    renderTab({ safeClaimableNotes: [makeNote('n1')], onClaimNote });
    openDetail();

    claimRow();
    await act(async () => {
      await onClaimNote.mock.results[0]?.value;
    });

    expect(onClaimNote).toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('PendingTab - the summary while a claim is in flight', () => {
  // Claiming no longer navigates away, so this screen has to say what is happening. Every note
  // being claimed drops out of `unclaimedNotesCount` (useClaimNotes filters `isBeingClaimed`),
  // so gating the CTA on that count alone left the user tapping "Claim All" and watching the
  // button vanish with nothing in its place.
  it('keeps a control and reports progress when every note is being claimed', () => {
    renderTab({
      safeClaimableNotes: [makeNote('n1', { isBeingClaimed: true })]
    });

    // Its own id: the E2E helper treats a visible `claim-all-button` as permission to click, so
    // a disabled button under that id would make it click a control it cannot action.
    expect(screen.queryByTestId('claim-all-button')).not.toBeInTheDocument();
    const status = screen.getByTestId('claim-all-status');
    expect(status).toBeDisabled();
    expect(status).toHaveTextContent('claiming');
  });

  it('announces the claiming state through a region that is already in the tree', () => {
    // A live region only announces changes to a region that EXISTED beforehand, so the
    // announcement cannot live on the control that appears -- it has to be a node that is always
    // mounted and whose text changes.
    const { rerender } = renderTab({ safeClaimableNotes: [makeNote('n1')] });
    const region = document.querySelector('[role="status"]');
    expect(region).toBeInTheDocument();
    expect(region).toHaveTextContent('');

    rerender(<PendingTab {...baseProps} safeClaimableNotes={[makeNote('n1', { isBeingClaimed: true })]} />);

    expect(document.querySelector('[role="status"]')).toHaveTextContent('claiming');
  });

  it('still offers Claim All when only SOME notes are in flight', () => {
    // Keying the actionable button on the in-flight count made one background auto-consume, which
    // Explore runs for native notes without any user action, disable Claim All for every other
    // claimable note, with the fee text still quoted above a button that could not be pressed.
    renderTab({
      safeClaimableNotes: [makeNote('n1', { isBeingClaimed: true }), makeNote('n2')]
    });

    // Present is not enough: the regression this pins made the control render DISABLED for every
    // other note whenever one was in flight, so it has to assert actionable, and that tapping it
    // actually reaches the handler.
    const button = screen.getByTestId('claim-all-button');
    expect(button).toBeInTheDocument();
    expect(button).not.toBeDisabled();
    expect(button).toHaveTextContent('claimAll');
    fireEvent.click(button);
    expect(baseProps.onClaimAll).toHaveBeenCalled();
    expect(screen.queryByTestId('claim-all-status')).not.toBeInTheDocument();
  });

  it('keeps the status control in the window before the poll reports the note as claiming', () => {
    // The gap all four review seats found. `isBeingClaimed` comes from a 3s/5s poll, so right after
    // the tap the note is in `claimingNoteIds` but NOT yet isBeingClaimed. Counting only the polled
    // flag left both counts at 0 -- the whole block unmounted -- and once the hook's `finally`
    // cleared the batch set, an ENABLED "Claim All" came back over a live consume.
    renderTab({
      safeClaimableNotes: [makeNote('n1', { isBeingClaimed: false })],
      claimingNoteIds: new Set(['n1'])
    });

    expect(screen.queryByTestId('claim-all-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('claim-all-status')).toHaveTextContent('claiming');
  });

  it('offers Claim All again once a note is claimable', () => {
    renderTab({ safeClaimableNotes: [makeNote('n1')] });

    const button = screen.getByTestId('claim-all-button');
    expect(button).not.toBeDisabled();
    expect(button).toHaveTextContent('claimAll');
    expect(screen.queryByTestId('claim-all-status')).not.toBeInTheDocument();
  });
});

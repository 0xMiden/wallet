import React from 'react';

import { act, fireEvent, render, screen, within } from '@testing-library/react';

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
  useWalletStore: (selector: (s: { tokenPrices: unknown; settings: undefined }) => unknown) =>
    selector({ tokenPrices: {}, settings: undefined })
}));

const mockSpamRun = jest.fn(async () => undefined);
const mockSpamUndo = jest.fn(async () => undefined);
jest.mock('lib/miden/front/note-spam', () => ({
  useNoteSpamState: () => ({
    state: { hiddenNoteIds: [], blockedFaucetIds: [], blockedSenders: [] },
    sets: { hidden: new Set(), faucets: new Set(), senders: new Set() },
    loaded: true,
    isBlockedFaucet: () => false,
    run: mockSpamRun,
    undo: mockSpamUndo,
    remove: jest.fn()
  })
}));

// Render the sheet inline so its buttons are reachable without vaul's portal/animation.
jest.mock('lib/ui/drawer', () => {
  const passthrough =
    (testId: string) =>
    ({ children }: { children?: React.ReactNode }) => <div data-testid={testId}>{children}</div>;
  return {
    Drawer: ({ open, children }: { open: boolean; children?: React.ReactNode }) =>
      open ? <div data-testid="drawer">{children}</div> : null,
    DrawerContent: passthrough('drawer-content'),
    DrawerHeader: passthrough('drawer-header'),
    DrawerFooter: passthrough('drawer-footer'),
    DrawerTitle: passthrough('drawer-title'),
    DrawerDescription: passthrough('drawer-description')
  };
});

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
  hapticLight: jest.fn(),
  hapticMedium: jest.fn()
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
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost', Danger: 'danger' },
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

// jsdom has no PointerEvent; without a constructor RTL drops `isPrimary` /
// `pointerType` / `clientX`, which the long-press hook reads. See useLongPress.test.
class PointerEventPolyfill extends MouseEvent {
  readonly isPrimary: boolean;
  readonly pointerType: string;
  constructor(type: string, init: MouseEventInit & { isPrimary?: boolean; pointerType?: string } = {}) {
    super(type, init);
    this.isPrimary = init.isPrimary ?? true;
    this.pointerType = init.pointerType ?? 'touch';
  }
}
beforeAll(() => {
  if (!('PointerEvent' in window)) {
    Object.defineProperty(window, 'PointerEvent', { value: PointerEventPolyfill, configurable: true });
  }
});

beforeEach(() => {
  mockSpamRun.mockClear();
  mockSpamUndo.mockClear();
});

describe('PendingTab — press-and-hold note menu + spam flow', () => {
  it('opens the note menu on press-and-hold, but not for a hold that starts on the Claim button', () => {
    jest.useFakeTimers();
    try {
      renderTab({ safeClaimableNotes: [makeNote('a')] });
      openDetail();
      const row = screen.getByTestId('detail-note-row');

      fireEvent.pointerDown(within(row).getByTestId('claim-button'), { clientX: 5, clientY: 5 });
      act(() => {
        jest.advanceTimersByTime(600);
      });
      expect(screen.queryByTestId('note-context-menu')).not.toBeInTheDocument();

      fireEvent.pointerDown(row, { clientX: 5, clientY: 5 });
      act(() => {
        jest.advanceTimersByTime(600);
      });
      expect(screen.getByTestId('note-context-menu')).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it('right-click opens the menu with claim / hide / copy / spam items', () => {
    renderTab({ safeClaimableNotes: [makeNote('a')] });
    openDetail();
    fireEvent.contextMenu(screen.getByTestId('detail-note-row'));

    const menu = screen.getByTestId('note-context-menu');
    expect(within(menu).getByTestId('note-menu-claim')).toHaveTextContent('noteMenuClaim');
    expect(within(menu).getByTestId('note-menu-hide')).toHaveTextContent('noteMenuHide');
    expect(within(menu).getByTestId('note-menu-copy')).toHaveTextContent('noteMenuCopySender');
    expect(within(menu).getByTestId('note-menu-spam')).toHaveTextContent('noteMenuMarkSpam');
  });

  it('omits "Claim note" for a note that is already being consumed', () => {
    renderTab({ safeClaimableNotes: [makeNote('a')], claimingNoteIds: new Set(['a']) });
    openDetail();
    fireEvent.contextMenu(screen.getByTestId('detail-note-row'));

    expect(screen.queryByTestId('note-menu-claim')).not.toBeInTheDocument();
    expect(screen.getByTestId('note-menu-hide')).toBeInTheDocument();
  });

  it('"Just hide this note" runs a hide-note action and shows an Undo banner that reverts it', () => {
    renderTab({ safeClaimableNotes: [makeNote('a')] });
    openDetail();
    fireEvent.contextMenu(screen.getByTestId('detail-note-row'));
    fireEvent.click(screen.getByTestId('note-menu-hide'));

    expect(mockSpamRun).toHaveBeenCalledWith({ kind: 'hide-note', noteId: 'a' });
    const banner = screen.getByTestId('spam-undo-banner');
    expect(banner).toHaveTextContent('spamBannerNoteHidden');

    fireEvent.click(within(banner).getByTestId('spam-undo-button'));
    expect(mockSpamUndo).toHaveBeenCalledWith({ kind: 'hide-note', noteId: 'a' });
  });

  it('"Mark as spam" opens the sheet with block-asset / block-sender-and-asset / cancel', () => {
    renderTab({ safeClaimableNotes: [makeNote('a')] });
    openDetail();
    fireEvent.contextMenu(screen.getByTestId('detail-note-row'));
    fireEvent.click(screen.getByTestId('note-menu-spam'));

    expect(screen.getByTestId('spam-block-asset')).toBeInTheDocument();
    expect(screen.getByTestId('spam-block-sender-and-asset')).toBeInTheDocument();
    expect(screen.getByTestId('spam-cancel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('spam-block-asset'));
    expect(mockSpamRun).toHaveBeenCalledWith({ kind: 'block-faucet', faucetId: 'faucet1' });
    expect(screen.getByTestId('spam-undo-banner')).toHaveTextContent('spamBannerAssetBlocked');
  });

  it('offers only "Block sender" for a note of the native MIDEN faucet', () => {
    renderTab({ safeClaimableNotes: [makeNote('a', { faucetId: 'native-faucet' })] });
    openDetail();
    fireEvent.contextMenu(screen.getByTestId('detail-note-row'));
    fireEvent.click(screen.getByTestId('note-menu-spam'));

    expect(screen.getByTestId('spam-block-sender')).toBeInTheDocument();
    expect(screen.queryByTestId('spam-block-asset')).not.toBeInTheDocument();
    expect(screen.queryByTestId('spam-block-sender-and-asset')).not.toBeInTheDocument();
  });

  it('renders the press-and-hold hint under the list and the visibility pill per note', () => {
    renderTab({ safeClaimableNotes: [makeNote('a', { type: 'private' as never })] });
    openDetail();
    expect(screen.getByText('pressAndHoldForOptions')).toBeInTheDocument();
    expect(within(screen.getByTestId('detail-note-row')).getByText('shielded')).toBeInTheDocument();
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
  });
});

describe('PendingTab — summary row dismiss (x) opens the asset-wide spam sheet', () => {
  it('shows an x on a non-native asset row that opens the sheet with "Block this asset" only', () => {
    renderTab({ safeClaimableNotes: [makeNote('a'), makeNote('b')] });

    fireEvent.click(screen.getByTestId('pending-asset-spam-button'));

    expect(screen.getByTestId('spam-block-asset')).toBeInTheDocument();
    expect(screen.queryByTestId('spam-block-sender-and-asset')).not.toBeInTheDocument();
    expect(screen.queryByTestId('spam-block-sender')).not.toBeInTheDocument();
    // Still on the summary: the x must not navigate into the detail view.
    expect(screen.queryByTestId('detail-note-row')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('spam-block-asset'));
    expect(mockSpamRun).toHaveBeenCalledWith({ kind: 'block-faucet', faucetId: 'faucet1' });
    expect(screen.getByTestId('spam-undo-banner')).toHaveTextContent('spamBannerAssetBlocked');
  });

  it('renders no x on the native MIDEN row, which can never be blocked', () => {
    renderTab({ safeClaimableNotes: [makeNote('a', { faucetId: NATIVE_FAUCET })] });

    expect(screen.getByTestId('pending-asset-row')).toBeInTheDocument();
    expect(screen.queryByTestId('pending-asset-spam-button')).not.toBeInTheDocument();
  });
});

describe('PendingTab — reports the list <-> detail transition', () => {
  it('fires onSelectedGroupChange with null on the list and the faucet id once a group is opened', () => {
    const onSelectedGroupChange = jest.fn();
    renderTab({ safeClaimableNotes: [makeNote('a')], onSelectedGroupChange });

    expect(onSelectedGroupChange).toHaveBeenLastCalledWith(null);
    openDetail();
    expect(onSelectedGroupChange).toHaveBeenLastCalledWith('faucet1');
  });
});

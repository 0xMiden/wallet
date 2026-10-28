import React from 'react';

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import type { SwapSettlementTransaction } from 'lib/miden/activity';
import { type ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { TEST_TOKEN_IETH } from 'lib/miden/swap/testing/registry';

import type { IHistoryEntry } from './IHistoryEntry';
import { SwapDetail } from './SwapDetail';
import { useTransactionActions } from './useTransactionActions';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'smthWentWrong') return 'Visible swap generic failure';
      const values = opts ? Object.values(opts) : [];
      return values.length > 0 ? `${key}_${values.join('_')}` : key;
    }
  })
}));

// The formatter keeps its DECIMALS argument visible. The parent's suite stubs it
// as `String(amount)`, which silently accepts a row rendered at the wrong scale -
// the whole reason this file exists.
jest.mock('lib/shared/format', () => ({
  formatAmount: jest.fn((amount: bigint | number | string, decimals?: number) => `${amount}@${decimals ?? 'default'}`)
}));

const mockGetExplorerTxUrl = jest.fn();
const mockGetExplorerAccountUrl = jest.fn();

jest.mock('lib/miden-chain/constants', () => ({
  getExplorerTxUrl: (...args: unknown[]) => mockGetExplorerTxUrl(...args),
  getExplorerAccountUrl: (...args: unknown[]) => mockGetExplorerAccountUrl(...args)
}));

jest.mock('lib/animation', () => ({
  installSheetKeyframes: () => {},
  sheetMotionVars: {},
  springs: { standard: {} },
  useMotion: () => ({})
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => <span data-testid="icon" />,
  IconName: { ArrowRight: 'ArrowRight' }
}));

jest.mock('components/Button', () => ({
  Button: ({
    title,
    onClick,
    disabled,
    variant,
    'data-testid': testId
  }: {
    title: string;
    onClick: () => void;
    disabled?: boolean;
    variant?: string;
    'data-testid'?: string;
  }) => (
    <button onClick={onClick} disabled={disabled} data-variant={variant} data-testid={testId}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Destructive: 'destructive' }
}));

jest.mock('../HashChip', () => ({
  __esModule: true,
  default: ({ hash, className, compactHitArea }: { hash: string; className?: string; compactHitArea?: boolean }) => (
    <span data-testid="hash-chip" className={className} data-compact-hit-area={String(Boolean(compactHitArea))}>
      {hash}
    </span>
  )
}));

jest.mock('components/ui/DetailCard', () => ({
  DetailRow: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div data-testid="detail-row" data-label={label}>
      {children}
    </div>
  )
}));

jest.mock('./DetailSection', () => ({
  DetailSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>
}));

jest.mock('./TransactionStatus', () => ({
  ExternalLinkValue: ({ displayValue, href }: { displayValue: React.ReactNode; href: string }) => (
    <a data-testid="external-link" href={href}>
      {displayValue}
    </a>
  ),
  StatusPill: ({ swapSettlement, paybackClaimStuck }: { swapSettlement?: string; paybackClaimStuck?: boolean }) => (
    <div
      data-testid="status-pill"
      data-swap-settlement={String(swapSettlement)}
      data-payback-stuck={String(Boolean(paybackClaimStuck))}
    />
  )
}));

jest.mock('./TransactionIcon', () => ({
  __esModule: true,
  default: () => <div data-testid="tx-icon" />
}));

jest.mock('./TransactionFailureCard', () => ({
  TransactionFailureCard: ({ isUnconfirmed, hintKey }: { isUnconfirmed?: boolean; hintKey?: string }) => (
    <div data-testid="failure-card" data-unconfirmed={String(Boolean(isUnconfirmed))} data-hint-key={hintKey} />
  )
}));

jest.mock('./transactionUtils', () => ({
  ...jest.requireActual('./transactionUtils'),
  formatDate: (timestamp: number | string) => `formatted:${timestamp}`
}));

// iETH's (i) is a testnet thing; pin the network rather than lean on the build default.
// The testnet document, whose swap tokens name the iETH faucet the labels and the (i) read.
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => jest.requireActual('lib/epoch/testing/bridge-config').TEST_BRIDGE_CONFIG_SNAPSHOT
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => 'testnet'
}));
jest.mock('app/providers/DappBrowserProvider', () => ({ useHideForegroundDappWhileOpen: jest.fn() }));

const REQUESTED_FAUCET = '0xfaucetrequested';
const OFFERED_FAUCET = '0xfaucetoffered';

const entry = {
  status: 2,
  amount: 500n,
  token: 'MID',
  timestamp: 1_700_000_000,
  txType: 'swap',
  // A swap row's own `faucetId` is the OFFERED side (SwapTransaction, db/types.ts).
  faucetId: OFFERED_FAUCET
} as unknown as IHistoryEntry;

const mockCancelOrder = jest.fn();

const consume = (over: Partial<SwapSettlementTransaction> = {}): SwapSettlementTransaction => ({
  id: 'local-row-1',
  transactionId: '0xchain1',
  noteIds: ['0xnote1'],
  amount: 685n,
  faucetId: REQUESTED_FAUCET,
  completedAt: 1_700_000_100,
  ...over
});

const renderDetail = (over: Partial<React.ComponentProps<typeof SwapDetail>> = {}) =>
  render(
    <SwapDetail
      entry={entry}
      requestedAmount={1000n}
      requestedDecimals={8}
      requestedScaleIsKnown
      requestedSymbol="ETH"
      requestedFaucetId={REQUESTED_FAUCET}
      filledAmount={400n}
      orderState="active"
      trackingLoading={false}
      settledTransactions={[]}
      reclaimedTransactions={[]}
      fromAccount={<span>me</span>}
      showActions={false}
      offerCancelOrder={false}
      isCancellingOrder={false}
      cancelOrderError={null}
      onCancelOrder={mockCancelOrder}
      {...over}
    />
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockGetExplorerTxUrl.mockImplementation((txId: string) => `https://explorer.test/tx/${txId}`);
  mockGetExplorerAccountUrl.mockImplementation((address: string) => `https://explorer.test/account/${address}`);
});

const rowByLabel = (label: string) =>
  Array.from(document.querySelectorAll('[data-testid="detail-row"]')).find(
    el => el.getAttribute('data-label') === label
  );

describe('SwapDetail faucet ids', () => {
  it('names both faucets, each under its own side of the order', () => {
    renderDetail();

    // Two faucets, two labels: a single "Faucet ID" row could not say which side
    // it described, which is the whole reason this screen takes two keys.
    const offered = rowByLabel('faucetIdOffered')!;
    const requested = rowByLabel('faucetIdRequested')!;
    expect(offered.querySelector('[data-testid="hash-chip"]')?.textContent).toBe(OFFERED_FAUCET);
    expect(requested.querySelector('[data-testid="hash-chip"]')?.textContent).toBe(REQUESTED_FAUCET);

    // A faucet is an account, so both link to the ACCOUNT explorer - the same
    // override-aware helper the From/To rows use - not the transaction one.
    expect(offered.querySelector('a[data-testid="external-link"]')).toHaveAttribute(
      'href',
      `https://explorer.test/account/${OFFERED_FAUCET}`
    );
    expect(requested.querySelector('a[data-testid="external-link"]')).toHaveAttribute(
      'href',
      `https://explorer.test/account/${REQUESTED_FAUCET}`
    );
  });

  it('renders no requested row for an order that never recorded a requested faucet', () => {
    renderDetail({ requestedFaucetId: undefined });

    expect(rowByLabel('faucetIdOffered')).toBeDefined();
    expect(rowByLabel('faucetIdRequested')).toBeUndefined();
  });
});

describe('SwapDetail token info', () => {
  it.each([
    ['requested', { requestedFaucetId: TEST_TOKEN_IETH.faucetId, requestedSymbol: 'Test iETH' }],
    ['offered', { entry: { ...entry, faucetId: TEST_TOKEN_IETH.faucetId, token: 'Test iETH' } }]
  ])('puts one (i) in the hero beside testnet iETH as the %s token (#477)', (_side, over) => {
    renderDetail(over);

    const buttons = within(screen.getByTestId('swap-order-hero')).getAllByTestId('swap-token-info-button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute('aria-label', 'tokenInfoLabel_Test iETH');
  });

  it('puts no (i) on a swap without iETH', () => {
    renderDetail();

    expect(screen.queryByTestId('swap-token-info-button')).not.toBeInTheDocument();
  });

  it.each([
    ['requested', { requestedFaucetId: TEST_TOKEN_IETH.faucetId, requestedSymbol: 'Test iETH' }, '1000@8Test iETH'],
    ['offered', { entry: { ...entry, faucetId: TEST_TOKEN_IETH.faucetId, token: 'Test iETH' } }, '500Test iETH']
  ])("keeps the %s side's amount, name and (i) in one unit the hero wraps between (#477)", (_side, over, unitText) => {
    renderDetail(over);

    const hero = screen.getByTestId('swap-order-hero');
    expect(hero).toHaveClass('flex-wrap');
    // Two units, one per side: a hero too wide for one line breaks between the sides.
    expect(hero.children).toHaveLength(2);
    const unit = within(hero).getByTestId('swap-token-info-button').parentElement;
    expect(unit?.parentElement).toBe(hero);
    expect(unit?.textContent).toBe(unitText);
  });
});

describe('SwapDetail amounts', () => {
  it('prints every amount at the scale of the token it belongs to', () => {
    renderDetail({ settledTransactions: [consume()] });

    // The requested side - total, fill and the per-row receipt - is denominated
    // in the requested token, so all three must carry ITS decimals. Falling back
    // to the wallet's default scale misstates funds by orders of magnitude, and
    // a formatter stub that drops the argument cannot see the difference.
    expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_400@8_1000@8_ ETH');
    expect(screen.getByText('swapReceivedAmount_685@8_ ETH')).toBeInTheDocument();
  });

  it('withholds a row amount it cannot attribute to the requested token', () => {
    // A consume's `amount` covers only its first input note's faucet, and an
    // expiry bundle carries the offered tip alongside the requested paybacks.
    renderDetail({
      settledTransactions: [
        consume({ id: 'other-side', faucetId: OFFERED_FAUCET }),
        // Half-written row: queued with a blank faucet, completed unstamped.
        consume({ id: 'unstamped', faucetId: '' }),
        consume({ id: 'no-amount', amount: undefined })
      ]
    });

    expect(screen.queryByText(/^swapReceivedAmount/)).not.toBeInTheDocument();
  });

  // Every quantity on this screen - the order's requested size, how much of it
  // filled, and each settlement note's payout - is scaled by the SAME requested
  // decimals, so an unresolved requested faucet makes them all wrong together.
  // The token is still named; only the numbers go.
  it('withholds every quantity when the requested token has no resolved scale', () => {
    renderDetail({ requestedScaleIsKnown: false, settledTransactions: [consume()] });

    expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_-_-_ ETH');
    expect(screen.queryByText(/^swapReceivedAmount/)).not.toBeInTheDocument();
  });

  it('says nothing rather than zero when a side is unknown', () => {
    renderDetail({ requestedAmount: undefined, filledAmount: undefined });

    expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_-_-_ ETH');
    expect(screen.queryByText(/^swapProgressPercent/)).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    expect(screen.queryByTestId('swap-amount-progress-fill')).not.toBeInTheDocument();
  });
});

describe('SwapDetail progress', () => {
  it.each([
    [0n, 0],
    [1n, 0.1],
    [500n, 50],
    [999n, 99.9],
    [1000n, 100],
    // Over-fill cannot happen on a real lineage, but the bar must not overflow.
    [1500n, 100]
  ])('reports %s of 1000 as %s%%', (filled, expected) => {
    renderDetail({ filledAmount: filled });

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(expected));
  });

  it('keeps a tiny fill visible instead of rounding it away to nothing', () => {
    // Truncating division reports anything under a tenth of a percent as a flat
    // 0, which would draw an empty bar and "0%" beside a receipt row confirming
    // funds arrived. A floor keeps the two from contradicting each other.
    renderDetail({ requestedAmount: 10_000_000n, filledAmount: 1n });

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText('swapProgressPercent_<0.1')).toBeInTheDocument();
  });
});

describe('SwapDetail status line', () => {
  const status = () => screen.getByTestId('swap-order-status');

  it.each([
    ['active', 1000n, 0n, 'orderStatusActive', 'bg-pending-tint'],
    ['active', 1000n, 400n, 'orderStatusPartiallyFilled', 'bg-pending-tint'],
    ['filled', 1000n, 1000n, 'orderStatusFilled', 'bg-positive-tint'],
    // A settle-tagged expiry bundle is how most partial fills end, so "Filled"
    // in green over a 40% fill is the single most misleading thing this line
    // could say.
    ['filled', 1000n, 400n, 'orderStatusPartiallyFilled', 'bg-pending-tint'],
    ['reclaimed', 1000n, 0n, 'orderStatusReclaimed', 'bg-fill-pressed'],
    ['reclaimed', 1000n, 400n, 'orderStatusPartiallyFilledReclaimed', 'bg-fill-pressed']
  ])('labels %s with %s filled as %s in %s', (orderState, requested, filled, label, tone) => {
    renderDetail({
      orderState: orderState as 'active' | 'filled' | 'reclaimed',
      requestedAmount: requested,
      filledAmount: filled
    });

    expect(status().textContent).toBe(label);
    // Tone asserted alongside the label: a reclaimed order rendered in the
    // positive colour reads as a success at a glance, whatever the words say.
    expect(status()).toHaveClass(tone);
  });

  it('reads Filled once the slippage target arrived, not Partially filled', () => {
    // 1000 requested at 100 bps: the target is ceil(1000 × 0.99) = 990.
    renderDetail({ orderState: 'filled', requestedAmount: 1000n, filledAmount: 990n, slippageBps: 100 });

    expect(status().textContent).toBe('orderStatusFilled');
    expect(status()).toHaveClass('bg-positive-tint');
  });

  it('distinguishes a lineage still loading from one that never answered', () => {
    renderDetail({ orderState: null, trackingLoading: true });
    expect(status().textContent).toBe('loading');
    expect(status()).toHaveClass('bg-fill-pressed', 'text-ink');
    // The order's state changes under the reader while the lineage resolves.
    expect(status()).toHaveAttribute('role', 'status');

    renderDetail({ orderState: null, trackingLoading: false });
    expect(screen.getAllByTestId('swap-order-status')[1]!.textContent).toBe('trackingUnavailable');
  });

  it('cannot be told a fill is partial against the amounts it is showing', () => {
    // `isPartialFill` used to be a prop, so a caller could assert a partial fill
    // on a receipt whose own progress line read "- of 1000". It is now derived
    // from the two amounts rendered right above it.
    renderDetail({ orderState: 'filled', requestedAmount: undefined, filledAmount: undefined });

    expect(status().textContent).toBe('orderStatusFilled');
  });
});

describe('SwapDetail note rows', () => {
  it('numbers the fills and times each one in seconds', () => {
    renderDetail({ settledTransactions: [consume(), consume({ id: 'row-2', noteIds: ['0xnote2'] })] });

    expect(screen.getByText('swapFillNote_1')).toBeInTheDocument();
    expect(screen.getByText('swapFillNote_2')).toBeInTheDocument();
    // Persisted stamps are unix SECONDS; reading them as ms dates a fill to 1970.
    const expected = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(1_700_000_100 * 1000));
    expect(screen.getAllByText(`swapConsumedAt_${expected}`)).toHaveLength(2);
  });

  it('omits the time for a row whose stamp was never written', () => {
    renderDetail({ settledTransactions: [consume({ completedAt: 0 }), consume({ id: 'r2', completedAt: undefined })] });

    expect(screen.queryByText(/^swapConsumedAt/)).not.toBeInTheDocument();
  });

  it('shows a pending row only while the order can still be matched', () => {
    const { unmount } = renderDetail({ orderState: 'active' });
    expect(screen.getByText('swapOpenFill')).toBeInTheDocument();
    // The open fill carries the compact pending badge, not bare orange text.
    const openFill = screen.getByText('swapOpenFill').closest('[role="status"]');
    const badge = openFill?.querySelector('.bg-pending-tint');
    expect(badge).toHaveTextContent('pending');
    expect(badge).toHaveClass('h-5', 'text-pending-tint-ink');
    unmount();

    renderDetail({ orderState: 'filled' });
    expect(screen.queryByText('swapOpenFill')).not.toBeInTheDocument();
  });

  it('shows fill and reclaim note ids in the muted ink that clears 4.5:1 on the chip fill', () => {
    renderDetail({
      settledTransactions: [consume()],
      reclaimedTransactions: [consume({ id: 'reclaim-1', noteIds: ['0xnote9'] })]
    });

    const chips = screen.getAllByTestId('hash-chip').filter(chip => /^0xnote[19]$/.test(chip.textContent ?? ''));
    expect(chips).toHaveLength(2);
    chips.forEach(chip => {
      expect(chip).toHaveClass('text-muted');
      expect(chip).not.toHaveClass('text-text-secondary-token');
    });
  });

  it('keeps each chip of a two-note fill or reclaim row to its own tap target', () => {
    renderDetail({
      settledTransactions: [consume({ noteIds: ['0xnote1', '0xnote2'] })],
      reclaimedTransactions: [consume({ id: 'reclaim-1', noteIds: ['0xnote9', '0xnote10'] })]
    });

    const isNote = (chip: HTMLElement) => /^0xnote(1|2|9|10)$/.test(chip.textContent ?? '');
    const noteChips = screen.getAllByTestId('hash-chip').filter(isNote);
    expect(noteChips).toHaveLength(4);
    noteChips.forEach(chip => expect(chip).toHaveAttribute('data-compact-hit-area', 'true'));

    // The faucet and transaction-hash chips sit alone in their rows.
    const rowChips = screen.getAllByTestId('hash-chip').filter(chip => !isNote(chip));
    expect(rowChips.length).toBeGreaterThan(0);
    rowChips.forEach(chip => expect(chip).toHaveAttribute('data-compact-hit-area', 'false'));
  });

  it('leaves a one-note fill or reclaim row its taller hit area, since it has no neighbour to protect', () => {
    renderDetail({
      settledTransactions: [consume()],
      reclaimedTransactions: [consume({ id: 'reclaim-1', noteIds: ['0xnote9'] })]
    });

    const isNote = (chip: HTMLElement) => /^0xnote[19]$/.test(chip.textContent ?? '');
    const noteChips = screen.getAllByTestId('hash-chip').filter(isNote);
    expect(noteChips).toHaveLength(2);
    noteChips.forEach(chip => expect(chip).toHaveAttribute('data-compact-hit-area', 'false'));
  });

  it('only denies that anything was bundled when the fill is actually known', () => {
    const { unmount } = renderDetail({ orderState: 'filled' });
    expect(screen.getByText('swapNoBundledNotes')).toBeInTheDocument();
    unmount();

    // With no lineage and no rows, "nothing has been bundled" is a confident
    // denial the receipt cannot support - and is plainly false for an order that
    // settled before the wallet was restored.
    renderDetail({ orderState: null, trackingLoading: false, filledAmount: undefined });
    expect(screen.queryByText('swapNoBundledNotes')).not.toBeInTheDocument();
  });
});

// Scoped to the consume row: the two faucet rows beside it are linked to the
// ACCOUNT explorer and would otherwise answer a bare `external-link` query.
describe('SwapDetail explorer links', () => {
  const consumeLink = () => rowByLabel('consumeTxId')!.querySelector('[data-testid="external-link"]');

  it('links a consume by its chain id', () => {
    renderDetail({ settledTransactions: [consume()] });

    expect(consumeLink()).toHaveAttribute('href', 'https://explorer.test/tx/0xchain1');
  });

  it('will not pass off a local row id as an on-chain identity', () => {
    // Before completion a consume has only its Dexie UUID. Linking that produced
    // a dead explorer link for a transaction the chain has never heard of.
    renderDetail({ settledTransactions: [consume({ transactionId: undefined })] });

    expect(consumeLink()).toBeNull();
    // Still shown, just not as something the explorer can be asked about.
    expect(rowByLabel('consumeTxId')).toHaveTextContent('local-row-1');
    expect(mockGetExplorerTxUrl).not.toHaveBeenCalled();
  });

  it('degrades to a plain hash on a build with no explorer', () => {
    mockGetExplorerTxUrl.mockReturnValue(undefined);
    renderDetail({ settledTransactions: [consume()] });

    expect(consumeLink()).toBeNull();
  });
});

describe('SwapDetail failure card', () => {
  it('explains an Unconfirmed swap with the hint its entry carries (#1081)', () => {
    renderDetail({
      entry: {
        ...entry,
        status: ITransactionStatus.Unconfirmed,
        errorMessage: 'boom',
        isUnconfirmed: true,
        notConfirmedHint: 'transactionUndeterminedHint'
      }
    });

    const card = screen.getByTestId('failure-card');
    expect(card).toHaveAttribute('data-unconfirmed', 'true');
    expect(card).toHaveAttribute('data-hint-key', 'transactionUndeterminedHint');
  });
});

describe('SwapDetail actions', () => {
  it('renders no dismiss control of its own - leaving the screen is the page back button', () => {
    // An order that reached the DEX has no cancel path, but there is also no
    // in-card way off the screen any more: the routed page's own back button
    // is the only exit, in every order state.
    renderDetail({ showActions: true, orderState: 'filled' });

    expect(screen.queryByText('close')).not.toBeInTheDocument();
    expect(screen.queryByText('swapOpenPendingNotes')).not.toBeInTheDocument();
  });

  it('offers the claim route only when given somewhere to go', () => {
    const onOpenPendingNotes = jest.fn();
    renderDetail({ showActions: true, onOpenPendingNotes });

    screen.getByText('swapOpenPendingNotes').click();
    expect(onOpenPendingNotes).toHaveBeenCalledTimes(1);
  });

  it('yields the action bar entirely when the parent owns it', () => {
    renderDetail({ showActions: false, onOpenPendingNotes: jest.fn() });

    expect(screen.queryByText('close')).not.toBeInTheDocument();
    expect(screen.queryByText('swapOpenPendingNotes')).not.toBeInTheDocument();
  });
});

describe('SwapDetail cancelling a live order', () => {
  it('offers Cancel swap while the order is open, and calls back on the tap', () => {
    renderDetail({ offerCancelOrder: true });

    const button = screen.getByTestId('swap-cancel-order-button');
    expect(button).toHaveTextContent('swapCancelOrder');
    // Destructive, not primary: the offer cannot be put back once it is taken.
    expect(button).toHaveAttribute('data-variant', 'destructive');

    fireEvent.click(button);
    expect(mockCancelOrder).toHaveBeenCalledTimes(1);
  });

  it('renders no cancel control when the order cannot be cancelled', () => {
    // The eligibility is decided once, in `deriveSwapReceipt`; this card never
    // draws a control the receipt did not offer.
    renderDetail({ offerCancelOrder: false });

    expect(screen.queryByTestId('swap-cancel-order-button')).not.toBeInTheDocument();
  });

  it('holds the button in its loading state while the cancel is in flight', () => {
    renderDetail({ offerCancelOrder: true, isCancellingOrder: true });

    expect(screen.getByTestId('swap-cancel-order-button')).toBeDisabled();
  });

  it('replaces the button with the reclaim notice once settlement has stamped the expiry', () => {
    // Nothing to tap: the wallet owes this account its tip back and is taking it.
    // A button there would restate a decision that has already been made.
    renderDetail({ entry: { ...entry, swapSettlement: 'reclaiming' }, offerCancelOrder: false });

    expect(screen.getByTestId('swap-cancel-order-pending')).toHaveTextContent('swapCancelOrderPending');
    expect(screen.queryByTestId('swap-cancel-order-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('status-pill')).toHaveAttribute('data-swap-settlement', 'reclaiming');
    expect(screen.getByTestId('swap-order-status')).toHaveTextContent('swapReclaiming');
    expect(screen.queryByText('swapMatchingDex')).not.toBeInTheDocument();
    expect(screen.queryByText('swapOpenFill')).not.toBeInTheDocument();
    expect(screen.queryByText('swapActivityTitle')).not.toBeInTheDocument();
  });

  it('reads an order settlement has not stamped as pending in every place', () => {
    // The list reads the same stamp, so the receipt never says Returning funds while the list says Pending.
    renderDetail({ entry: { ...entry, swapSettlement: 'pending' }, filledAmount: 0n });

    expect(screen.getByTestId('status-pill')).toHaveAttribute('data-swap-settlement', 'pending');
    expect(screen.getByTestId('swap-order-status')).toHaveTextContent('orderStatusActive');
    expect(screen.getByText('swapMatchingDex')).toBeInTheDocument();
    expect(screen.getByText('swapActivityTitle')).toBeInTheDocument();
    expect(screen.queryByTestId('swap-cancel-order-pending')).not.toBeInTheDocument();
  });

  it('renders a reclaimed zero-fill as zero percent, not an accepted fill', () => {
    renderDetail({
      orderState: 'reclaimed',
      filledAmount: 0n,
      reclaimedTransactions: [{ id: 'return', noteIds: ['original-output'], completedAt: 1_700_000_100 }]
    });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByTestId('swap-order-amount-filled')).toHaveTextContent('swapAmountProgress_0@');
    expect(screen.getByTestId('swap-reclaimed-notes')).toHaveTextContent('swapReturnedAt_');
    expect(screen.getByTestId('swap-reclaimed-notes')).not.toHaveTextContent('swapConsumedAt_');
    expect(screen.queryByText('swapMatchingDex')).not.toBeInTheDocument();
  });

  it('surfaces a failed cancel as a notice, keeping the button available to retry', () => {
    renderDetail({ offerCancelOrder: true, cancelOrderError: 'nope' });

    const notice = screen.getByTestId('swap-cancel-order-error');
    expect(notice).toHaveTextContent('nope');
    expect(notice).toHaveAttribute('data-tone', 'negative');
    expect(screen.getByTestId('swap-cancel-order-button')).toBeInTheDocument();
  });

  it('draws the error even when nothing else would open the action bar', () => {
    // The bar is rendered only when it has something in it, and a refusal the
    // user cannot see is the same as no refusal at all.
    renderDetail({ showActions: false, offerCancelOrder: false, cancelOrderError: 'nope' });

    expect(screen.getByTestId('swap-cancel-order-error')).toBeInTheDocument();
  });

  it('keeps the claim route and the cancel side by side when both apply', () => {
    // An order with no expiry is both claimable (nothing will auto-settle it)
    // and cancellable (the stamp is the only thing that can end its wait).
    renderDetail({ showActions: true, onOpenPendingNotes: jest.fn(), offerCancelOrder: true });

    expect(screen.getByText('swapOpenPendingNotes')).toBeInTheDocument();
    expect(screen.getByTestId('swap-cancel-order-button')).toBeInTheDocument();
  });
});

const mockReportUserVisibleError = jest.fn();
jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: (...args: unknown[]) => mockReportUserVisibleError(...args)
}));

const expectErrorAfterDwell = async (id: string, surface: string) => {
  await act(async () => {
    jest.advanceTimersByTime(999);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([[id, surface]]);
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([[id, surface]]);
};

const mockCancelSwapOrder = jest.fn();
const mockConfirmCancel = jest.fn();
jest.mock('lib/miden/swap/cancel-order', () => ({
  cancelSwapOrder: (...args: unknown[]) => mockCancelSwapOrder(...args)
}));
jest.mock('lib/ui/dialog', () => ({ useConfirm: () => mockConfirmCancel }));

const LiveSwapCancel = () => {
  const actions = useTransactionActions('synthetic-swap', entry, undefined);
  return (
    <SwapDetail
      entry={entry}
      requestedAmount={1000n}
      requestedDecimals={8}
      requestedScaleIsKnown
      requestedSymbol="ETH"
      requestedFaucetId={REQUESTED_FAUCET}
      filledAmount={400n}
      orderState="active"
      trackingLoading={false}
      settledTransactions={[]}
      reclaimedTransactions={[]}
      fromAccount={<span>me</span>}
      showActions
      offerCancelOrder
      isCancellingOrder={actions.isCancellingOrder}
      cancelOrderError={actions.cancelOrderError}
      cancelOrderErrorId={actions.cancelOrderErrorId}
      onCancelOrder={actions.onCancelOrder}
    />
  );
};

describe('user-visible live swap cancel errors', () => {
  const settle = () =>
    act(async () => {
      for (let tick = 0; tick < 25; tick++) {
        await Promise.resolve();
      }
    });
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    mockConfirmCancel.mockReset().mockResolvedValue(true);
    mockCancelSwapOrder.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports raw_history_swap_cancel_failed from the real live cancel producer and Notice', async () => {
    mockCancelSwapOrder.mockRejectedValueOnce(new Error('private cancel order amount 42'));
    render(<LiveSwapCancel />);
    fireEvent.click(screen.getByTestId('swap-cancel-order-button'));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('private cancel order amount 42');
    await expectErrorAfterDwell('raw_history_swap_cancel_failed', 'notice');
  });

  it('reports smthWentWrong from the real non-Error cancel refusal', async () => {
    mockCancelSwapOrder.mockRejectedValueOnce('private non-error');
    render(<LiveSwapCancel />);
    fireEvent.click(screen.getByTestId('swap-cancel-order-button'));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Visible swap generic failure');
    await expectErrorAfterDwell('smthWentWrong', 'notice');
  });

  it.each(['retry', 'unmount'])('clears a short swap cancel error on %s', async control => {
    mockCancelSwapOrder.mockRejectedValueOnce(new Error('short order failure'));
    const view = render(<LiveSwapCancel />);
    fireEvent.click(screen.getByTestId('swap-cancel-order-button'));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('short order failure');
    await act(async () => {
      jest.advanceTimersByTime(999);
    });
    if (control === 'retry') {
      fireEvent.click(screen.getByTestId('swap-cancel-order-button'));
      await settle();
    } else view.unmount();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });

  it('keeps declined confirmation and a successful cancel silent', async () => {
    mockConfirmCancel.mockResolvedValueOnce(false);
    render(<LiveSwapCancel />);
    fireEvent.click(screen.getByTestId('swap-cancel-order-button'));
    await settle();
    expect(mockCancelSwapOrder).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('swap-cancel-order-button'));
    await settle();
    expect(mockCancelSwapOrder).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });
});

const mockRequeueFailedTransaction = jest.fn();
const mockRequestSWTransactionProcessing = jest.fn();
const mockNavigate = jest.fn();
jest.mock('lib/miden/activity', () => ({
  ...jest.requireActual('lib/miden/activity'),
  requeueFailedTransaction: (...args: unknown[]) => mockRequeueFailedTransaction(...args),
  requestSWTransactionProcessing: () => mockRequestSWTransactionProcessing()
}));
jest.mock('lib/woozie', () => ({ ...jest.requireActual('lib/woozie'), navigate: (to: string) => mockNavigate(to) }));
const mockGetPaybackClaimState = jest.fn();
jest.mock('lib/miden/swap/payback-claim', () => ({
  ...jest.requireActual('lib/miden/swap/payback-claim'),
  getPaybackClaimState: (...args: unknown[]) => mockGetPaybackClaimState(...args)
}));
const swapRow = { id: 'synthetic-swap', type: 'swap', status: 2 } as unknown as ITransaction;

const stuckEntry = {
  ...entry,
  paybackClaimStuck: { failedClaimId: 'payback-claim-1', reason: 'network' }
} as unknown as IHistoryEntry;

const LiveStuckPayback = ({
  swapEntry = stuckEntry,
  noRow = false
}: {
  swapEntry?: IHistoryEntry;
  noRow?: boolean;
}) => {
  const actions = useTransactionActions('synthetic-swap', swapEntry, noRow ? undefined : swapRow);
  return (
    <SwapDetail
      entry={swapEntry}
      requestedAmount={1000n}
      requestedDecimals={8}
      requestedScaleIsKnown
      requestedSymbol="ETH"
      requestedFaucetId={REQUESTED_FAUCET}
      filledAmount={1000n}
      orderState="filled"
      trackingLoading={false}
      settledTransactions={[]}
      reclaimedTransactions={[]}
      fromAccount={<span>me</span>}
      showActions
      offerCancelOrder={false}
      isCancellingOrder={false}
      cancelOrderError={null}
      onCancelOrder={mockCancelOrder}
      isRetryingPayback={actions.isRetryingPayback}
      paybackRetryError={actions.paybackRetryError}
      paybackRetryErrorId={actions.paybackRetryErrorId}
      paybackRetryErrorDiagnostics={actions.paybackRetryErrorDiagnostics}
      onRetryPayback={actions.onRetryPayback}
    />
  );
};

describe('SwapDetail stuck payout claim (#1644)', () => {
  const settle = () =>
    act(async () => {
      for (let tick = 0; tick < 25; tick++) {
        await Promise.resolve();
      }
    });
  beforeEach(() => {
    mockRequeueFailedTransaction.mockReset().mockResolvedValue(undefined);
    mockGetPaybackClaimState
      .mockReset()
      .mockResolvedValue({ stuck: true, failedClaimId: 'payback-claim-1', reason: 'network' });
  });

  it('says the payout claim is stuck, with its reason, and offers Retry', () => {
    render(<LiveStuckPayback />);

    expect(screen.getByTestId('swap-payback-stuck')).toHaveTextContent('swapPaybackStuckNetwork');
    expect(screen.getByTestId('swap-retry-payback-button')).toHaveTextContent('swapRetryPayback');
    expect(screen.getByTestId('status-pill')).toHaveAttribute('data-payback-stuck', 'true');
  });

  it.each(['fee', 'guardian', 'other'])('names the %s reason', reason => {
    render(
      <LiveStuckPayback
        swapEntry={{ ...stuckEntry, paybackClaimStuck: { failedClaimId: 'payback-claim-1', reason } } as IHistoryEntry}
      />
    );
    const key = `swapPaybackStuck${reason.charAt(0).toUpperCase()}${reason.slice(1)}`;
    expect(screen.getByTestId('swap-payback-stuck')).toHaveTextContent(key);
  });

  it('retries the failed payout claim itself and opens its progress', async () => {
    render(<LiveStuckPayback />);
    fireEvent.click(screen.getByTestId('swap-retry-payback-button'));
    await settle();

    expect(mockRequeueFailedTransaction).toHaveBeenCalledWith('payback-claim-1', {});
    expect(mockRequestSWTransactionProcessing).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction/payback-claim-1');
  });

  it('does not requeue a claim that stopped being stuck (F-006)', async () => {
    mockGetPaybackClaimState.mockResolvedValueOnce({ stuck: false });
    render(<LiveStuckPayback />);
    fireEvent.click(screen.getByTestId('swap-retry-payback-button'));
    await settle();

    expect(mockGetPaybackClaimState).toHaveBeenCalledWith(swapRow);
    expect(mockRequeueFailedTransaction).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('retries the fresh stuck claim when it is a different row (F-010)', async () => {
    mockGetPaybackClaimState.mockResolvedValueOnce({
      stuck: true,
      failedClaimId: 'payback-claim-2',
      reason: 'network'
    });
    render(<LiveStuckPayback />);
    fireEvent.click(screen.getByTestId('swap-retry-payback-button'));
    await settle();

    expect(mockRequeueFailedTransaction).toHaveBeenCalledWith('payback-claim-2', {});
    expect(mockRequeueFailedTransaction).toHaveBeenCalledTimes(1);
    expect(mockRequestSWTransactionProcessing).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction/payback-claim-2');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retries the rendered claim when the receipt has no row (F-010)', async () => {
    render(<LiveStuckPayback noRow />);
    fireEvent.click(screen.getByTestId('swap-retry-payback-button'));
    await settle();

    expect(mockGetPaybackClaimState).not.toHaveBeenCalled();
    expect(mockRequeueFailedTransaction).toHaveBeenCalledTimes(1);
    expect(mockRequeueFailedTransaction).toHaveBeenCalledWith('payback-claim-1', {});
    expect(mockRequestSWTransactionProcessing).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction/payback-claim-1');
  });

  it('reports the payout retry reason on the visible notice', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    try {
      const { annotatePendingRetry } = jest.requireActual<typeof import('lib/telemetry/ui-producer-diagnostics')>(
        'lib/telemetry/ui-producer-diagnostics'
      );
      const failure = new Error('private payout retry failure');
      annotatePendingRetry(failure, 'guardian_hold');
      mockRequeueFailedTransaction.mockRejectedValueOnce(failure);
      render(<LiveStuckPayback />);
      fireEvent.click(screen.getByTestId('swap-retry-payback-button'));
      await settle();
      expect(screen.getByRole('alert')).toHaveTextContent('private payout retry failure');
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(mockReportUserVisibleError).toHaveBeenCalledWith('raw_history_retry_failed', 'notice', {
        kind: 'history_payback_retry',
        retryNoticeOrigin: 'history_payback',
        pendingRetryReason: 'guardian_hold'
      });
      expect(mockRequeueFailedTransaction).toHaveBeenCalledWith('payback-claim-1', {});
      expect(mockNavigate).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows a fee refusal of the retry', async () => {
    const { ClaimFeeRefusedError } = jest.requireActual<typeof import('lib/miden/transaction/claim-fee')>(
      'lib/miden/transaction/claim-fee'
    );
    mockRequeueFailedTransaction.mockRejectedValueOnce(new ClaimFeeRefusedError());
    render(<LiveStuckPayback />);
    fireEvent.click(screen.getByTestId('swap-retry-payback-button'));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('insufficientFeeAsset');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows nothing for a payout that is not stuck', () => {
    render(<LiveStuckPayback swapEntry={entry} />);

    expect(screen.queryByTestId('swap-payback-stuck')).not.toBeInTheDocument();
    expect(screen.queryByTestId('swap-retry-payback-button')).not.toBeInTheDocument();
  });
});

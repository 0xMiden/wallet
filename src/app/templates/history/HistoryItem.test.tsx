import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { isMobile } from 'lib/platform';

import HistoryItem from './HistoryItem';
import { isFaucetRequest } from './transactionUtils';

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes `t:<key>` back and we can assert which label branch rendered.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => `t:${key}` })
}));

// `useAppEnv` reads a module-scoped holder so individual tests can flip
// `compact` (drives the `isMobile() || compact` trim branch) without a provider.
let mockCompact = false;
jest.mock('app/env', () => ({
  useAppEnv: () => ({ compact: mockCompact })
}));

// `lib/platform.isMobile` is the other half of the address-trim branch — a
// steerable jest.fn so each test picks the mobile / desktop path.
jest.mock('lib/platform', () => ({
  isMobile: jest.fn(() => false)
}));

// `AddressShortView` pulls in the real address-truncation util; replace it with
// a marker that surfaces the `address` + `trim` props HistoryItem forwards so we
// can assert the trim decision directly.
jest.mock('app/atoms/AddressShortView', () => ({
  __esModule: true,
  default: ({ address, trim }: { address: string; trim?: boolean }) => (
    <span data-testid="addr" data-trim={String(trim)}>
      {address}
    </span>
  )
}));

// `components/Button` drags in framer-motion / haptics / icon barrels. Replace
// it with a plain <button> that forwards `onClick`, `data-testid` and children,
// and re-export the `ButtonVariant` enum the component references.
jest.mock('components/Button', () => ({
  __esModule: true,
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' },
  Button: ({
    children,
    onClick,
    className,
    variant,
    'data-testid': testId
  }: {
    children?: React.ReactNode;
    onClick?: (e: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
    className?: string;
    variant?: string;
    'data-testid'?: string;
  }) => (
    <button type="button" data-testid={testId} data-variant={variant} className={className} onClick={onClick}>
      {children}
    </button>
  )
}));

// `lib/woozie`'s real `Link` depends on the woozie location/history/analytics
// stack. Replace it with a plain anchor that exposes the `to` target so the
// non-explorer navigation branch is assertable.
jest.mock('lib/woozie', () => ({
  Link: ({ to, children }: { to: string; children?: React.ReactNode }) => (
    <span data-testid="woozie-link" data-to={to}>
      {children}
    </span>
  )
}));

// The icon renderer and the swap/faucet utils each import the Miden SDK &
// date-fns; stub them. `isFaucetRequest` is a steerable jest.fn driving the
// title / (unused here) icon faucet branch.
jest.mock('./TransactionIcon', () => ({
  __esModule: true,
  default: ({ entry, size }: { entry: { transactionIcon?: string }; size?: string }) => (
    <div data-testid="tx-icon" data-size={size} data-icon={entry.transactionIcon ?? 'none'} />
  )
}));
jest.mock('./transactionUtils', () => ({
  isFaucetRequest: jest.fn(() => false),
  isBridgeInEntry: jest.fn(() => false),
  isEarnWithdrawEntry: (entry: { txType?: string }) => entry.txType === 'earn-withdraw',
  earnWithdrawToneOf: (phase?: string) =>
    phase === 'received' ? 'confirmed' : phase === 'failed' ? 'failed' : 'pending',
  EARN_WITHDRAW_STATUS_LABEL_KEY: {
    redeeming: 'earnWithdrawStatusRedeeming',
    delivering: 'earnWithdrawStatusDelivering',
    received: 'received',
    failed: 'failed'
  },
  earnDepositSettlementOf: (entry: { earnDepositStatus?: string }) => entry.earnDepositStatus ?? 'pending',
  EARN_DEPOSIT_STATUS_LABEL_KEY: {
    pending: 'pending',
    confirmed: 'confirmed',
    failed: 'failed'
  }
}));

const mockIsMobile = isMobile as jest.MockedFunction<typeof isMobile>;
const mockIsFaucetRequest = isFaucetRequest as jest.MockedFunction<typeof isFaucetRequest>;

// Minimal shape — HistoryItem only reads the fields exercised below; the real
// IHistoryEntry type is erased at runtime, so a plain object cast is enough.
type Entry = Record<string, unknown>;

const makeEntry = (overrides: Entry = {}): any => ({
  key: 'k1',
  address: 'addr-1',
  timestamp: 0,
  message: 'Sent tokens',
  type: 1,
  txType: 'send',
  txId: 'tx-123',
  ...overrides
});

/** The HistoryContent root carries `py-4`; grab it to assert border classes. */
const contentRoot = (container: HTMLElement) => container.querySelector('div.py-4') as HTMLElement;

beforeEach(() => {
  mockCompact = false;
  mockIsMobile.mockReturnValue(false);
  mockIsFaucetRequest.mockReturnValue(false);
});

describe('HistoryItem', () => {
  it('renders the explorer-link (anchor) variant with receive styling, address, amount, token and cancel button', () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    const entry = makeEntry({
      transactionIcon: 'RECEIVE',
      message: 'Received 5 MIDEN',
      secondaryAddress: '0xsender',
      amount: 123n,
      token: 'MIDEN',
      cancel,
      explorerLink: 'https://explorer.example/tx/123'
    });

    const { container } = render(<HistoryItem entry={entry} fullHistory lastEntry={false} className="extra-class" />);

    // Outer wrapper carries the passed className.
    expect(container.firstChild).toHaveClass('w-full', 'text-black', 'extra-class');

    // Explorer-link branch: a real <a> with the external-link attributes.
    const anchor = container.querySelector('a[href]') as HTMLAnchorElement;
    expect(anchor).toHaveAttribute('href', 'https://explorer.example/tx/123');
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor).toHaveAttribute('rel', 'noreferrer');
    expect(anchor).toHaveAttribute('draggable', 'false');
    expect(screen.queryByTestId('woozie-link')).toBeNull();

    // Icon is forwarded with size="sm".
    const icon = screen.getByTestId('tx-icon');
    expect(icon).toHaveAttribute('data-size', 'sm');
    expect(icon).toHaveAttribute('data-icon', 'RECEIVE');

    // Title falls back to the message (not a faucet request).
    expect(screen.getByText('Received 5 MIDEN')).toBeInTheDocument();

    // isReceive (icon === RECEIVE) => "from" label + trim=false (desktop, not compact).
    expect(screen.getByText(/t:from/)).toBeInTheDocument();
    expect(screen.getByTestId('addr')).toHaveAttribute('data-trim', 'false');
    expect(screen.getByTestId('addr')).toHaveTextContent('0xsender');

    // Positive amount, receive-green class, token symbol.
    const amount = screen.getByText('+123');
    expect(amount).toHaveClass('text-receive-green');
    expect(screen.getByText('MIDEN')).toBeInTheDocument();

    // Cancel button present with selector testid + label.
    const cancelBtn = screen.getByTestId('Explore/CancelTransaction');
    expect(cancelBtn).toHaveTextContent('t:cancel');

    // fullHistory && !lastEntry => the thin card border; !lastEntry => border-b.
    expect(contentRoot(container)).toHaveClass('border-b', 'border-b-border-card', 'border-b-[0.27px]');
  });

  it('renders the woozie Link variant, treats message "Consuming" as receive, and omits optional blocks', () => {
    const entry = makeEntry({
      transactionIcon: undefined,
      message: 'Consuming',
      secondaryAddress: undefined,
      amount: undefined,
      token: undefined,
      cancel: undefined,
      explorerLink: undefined,
      txId: 'tx-999'
    });

    const { container } = render(<HistoryItem entry={entry} fullHistory={false} lastEntry />);

    // No explorer link => internal Link to the details route.
    expect(container.querySelector('a[href]')).toBeNull();
    expect(screen.getByTestId('woozie-link')).toHaveAttribute('data-to', '/history-details/tx-999');

    // Title = message; isReceive via message === 'Consuming'.
    expect(screen.getByText('Consuming')).toBeInTheDocument();

    // No secondaryAddress => no address row; no amount => no amount block; no cancel.
    expect(screen.queryByTestId('addr')).toBeNull();
    expect(screen.queryByText(/t:from/)).toBeNull();
    expect(screen.queryByText('+', { exact: false })).toBeNull();
    expect(screen.queryByTestId('Explore/CancelTransaction')).toBeNull();

    // lastEntry => no border-b; fullHistory false => no card border.
    const root = contentRoot(container);
    expect(root).not.toHaveClass('border-b');
    expect(root).not.toHaveClass('border-b-border-card');
  });

  it('renders send styling (negative amount, red) and trims the address on mobile', () => {
    mockIsMobile.mockReturnValue(true);
    const entry = makeEntry({
      transactionIcon: 'SEND',
      message: 'Sent 9 MIDEN',
      secondaryAddress: '0xrecipient',
      amount: 456n,
      token: 'MIDEN',
      explorerLink: undefined
    });

    const { container } = render(<HistoryItem entry={entry} fullHistory={false} lastEntry={false} />);

    // Not receive => "to" label, negative amount, red class.
    expect(screen.getByText(/t:to/)).toBeInTheDocument();
    const amount = screen.getByText('-456');
    expect(amount).toHaveClass('text-[#DC2626]');
    expect(amount).not.toHaveClass('text-receive-green');

    // isMobile() true => trim=true.
    expect(screen.getByTestId('addr')).toHaveAttribute('data-trim', 'true');

    // !lastEntry => border-b, but fullHistory false => no card border.
    const root = contentRoot(container);
    expect(root).toHaveClass('border-b');
    expect(root).not.toHaveClass('border-b-border-card');
  });

  it('shows the faucet-request title when isFaucetRequest is true', () => {
    mockIsFaucetRequest.mockReturnValue(true);
    const entry = makeEntry({
      transactionIcon: 'RECEIVE',
      message: 'this-message-should-be-ignored',
      explorerLink: 'https://explorer.example/tx/abc'
    });

    render(<HistoryItem entry={entry} />);

    expect(screen.getByText('t:faucetRequest')).toBeInTheDocument();
    expect(screen.queryByText('this-message-should-be-ignored')).toBeNull();
  });

  it('trims the address when compact even on desktop (compact branch)', () => {
    mockCompact = true; // isMobile() false, compact true => trim true
    const entry = makeEntry({
      transactionIcon: 'SEND',
      secondaryAddress: '0xrecipient'
    });

    render(<HistoryItem entry={entry} />);

    expect(mockIsMobile).toHaveBeenCalled();
    expect(screen.getByTestId('addr')).toHaveAttribute('data-trim', 'true');
  });

  it('cancels the transaction on click, stopping propagation and preventing default', () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    const parentClick = jest.fn();
    const entry = makeEntry({ cancel, explorerLink: 'https://explorer.example/tx/xyz' });

    render(
      <div onClick={parentClick}>
        <HistoryItem entry={entry} />
      </div>
    );

    const cancelBtn = screen.getByTestId('Explore/CancelTransaction');
    fireEvent.click(cancelBtn);

    expect(cancel).toHaveBeenCalledTimes(1);
    // stopPropagation => the wrapping onClick never sees the event.
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('renders the Smart Withdraw summary row with its phase chip and positive amount', () => {
    const entry = makeEntry({
      txType: 'earn-withdraw',
      earnWithdrawPhase: 'delivering',
      amount: 2n,
      token: 'USDC'
    });

    const { container } = render(<HistoryItem entry={entry} />);

    expect(screen.getByText('t:earnWithdrawRowTitle')).toBeInTheDocument();
    expect(screen.getByText('t:earnWithdrawRowVia')).toBeInTheDocument();
    expect(container.textContent).toContain('+2 USDC');
    expect(screen.getByText(/earnWithdrawStatusDelivering/)).toBeInTheDocument();
  });

  it('hides the amount on a failed Smart Withdraw and shows the failed chip', () => {
    const entry = makeEntry({
      txType: 'earn-withdraw',
      earnWithdrawPhase: 'failed',
      amount: 2n,
      token: 'USDC'
    });

    const { container } = render(<HistoryItem entry={entry} />);

    expect(container.textContent).not.toContain('+2 USDC');
    expect(screen.getByText(/t:failed/)).toBeInTheDocument();
  });

  it('applies no card border when fullHistory is true but it is the last entry', () => {
    const entry = makeEntry({ transactionIcon: 'RECEIVE' });

    const { container } = render(<HistoryItem entry={entry} fullHistory lastEntry />);

    const root = contentRoot(container);
    // lastEntry => no border-b; fullHistory && !lastEntry is false => no card border.
    expect(root).not.toHaveClass('border-b');
    expect(root).not.toHaveClass('border-b-border-card');
  });

  // A Smart Deposit's summary row surfaces the Sepolia lending leg while it is
  // still unsettled — the row itself is Completed the moment the Miden
  // collateral note lands, which would otherwise read as fully done.
  it('shows the lending-leg status dot on a pending Smart Deposit', () => {
    const entry = makeEntry({ txType: 'earn-deposit', earnDepositStatus: 'pending', message: 'Depositing' });

    render(<HistoryItem entry={entry} />);

    const chip = screen.getByTestId('earn-deposit-status');
    expect(chip).toHaveTextContent('t:pending');
    expect(chip.className).toContain('text-status-pending');
  });

  it('defaults an unstamped lending leg to pending', () => {
    render(<HistoryItem entry={makeEntry({ txType: 'earn-deposit', message: 'Depositing' })} />);
    expect(screen.getByTestId('earn-deposit-status')).toHaveTextContent('t:pending');
  });

  it('shows a failed lending leg', () => {
    const entry = makeEntry({ txType: 'earn-deposit', earnDepositStatus: 'failed', message: 'Depositing' });

    render(<HistoryItem entry={entry} />);

    const chip = screen.getByTestId('earn-deposit-status');
    expect(chip).toHaveTextContent('t:failed');
    expect(chip.className).toContain('text-status-negative');
  });

  it('renders no chip once the lending leg is confirmed', () => {
    const entry = makeEntry({ txType: 'earn-deposit', earnDepositStatus: 'confirmed', message: 'Depositing' });
    render(<HistoryItem entry={entry} />);
    expect(screen.queryByTestId('earn-deposit-status')).toBeNull();
  });

  it('renders no chip on a cancelled or Miden-failed deposit row', () => {
    const cancelled = makeEntry({ txType: 'earn-deposit', isCancelled: true, earnDepositStatus: 'pending' });
    const { unmount } = render(<HistoryItem entry={cancelled} />);
    expect(screen.queryByTestId('earn-deposit-status')).toBeNull();
    unmount();

    const failed = makeEntry({ txType: 'earn-deposit', transactionIcon: 'FAILED', earnDepositStatus: 'pending' });
    render(<HistoryItem entry={failed} />);
    expect(screen.queryByTestId('earn-deposit-status')).toBeNull();
  });

  it('never renders the chip on a non-deposit row', () => {
    render(<HistoryItem entry={makeEntry({ txType: 'send' })} />);
    expect(screen.queryByTestId('earn-deposit-status')).toBeNull();
  });
});

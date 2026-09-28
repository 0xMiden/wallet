import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import type { IEarnWithdrawExtraInputs, ITransaction } from 'lib/miden/db/types';
import { ITransactionStatus } from 'lib/miden/db/types';
import type { AssetMetadata } from 'lib/miden/metadata/types';
import { navigate } from 'lib/woozie';
import type { TransactionSuccessLayoutProps } from 'screens/generating-transaction/success/TransactionSuccessLayout';

import { EarnWithdrawStatus } from './EarnWithdrawStatus';

let mockRowState: { row?: ITransaction; loaded: boolean } = { row: undefined, loaded: false };
let mockSuccessProps: TransactionSuccessLayoutProps | undefined;
let mockAssetsMetadata: Record<string, AssetMetadata> = {};

// The delivered faucet resolves synchronously from the store; the native one needs no record.
jest.mock('lib/store', () => ({
  useWalletStore: <T,>(selector: (state: { assetsMetadata: Record<string, AssetMetadata> }) => T) =>
    selector({ assetsMetadata: mockAssetsMetadata })
}));

jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: () => 'native-faucet'
}));

// Real base-unit scaling: the shared `lib/i18n/numbers` manual mock has no `formatBigInt`.
jest.mock('lib/shared/format', () => ({
  formatAmount: (amount: bigint, decimals: number) =>
    jest.requireActual<typeof import('lib/i18n/numbers')>('lib/i18n/numbers').formatBigInt(amount, decimals)
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

jest.mock('screens/generating-transaction/useTransactionRow', () => ({
  useTransactionRow: () => mockRowState
}));

jest.mock('components/ui/Spinner', () => ({
  Spinner: () => <div data-testid="spinner" />
}));

jest.mock('components/PageHeader', () => ({
  PageHeader: ({ title, onClose }: { title: string; onClose?: () => void }) => (
    <header>
      {title}
      <button type="button" aria-label="close" onClick={onClose} />
    </header>
  )
}));

jest.mock('components/Button', () => ({
  Button: ({
    children,
    onClick,
    title,
    accent
  }: {
    children?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    title?: string;
    accent?: string;
  }) => (
    <button type="button" data-accent={accent} onClick={onClick}>
      {children ?? title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary', Secondary: 'Secondary' }
}));

jest.mock('screens/generating-transaction/components', () => ({
  TransactionHeroIcon: ({ state }: { state: string }) => <div data-testid="hero-state">{state}</div>
}));

jest.mock('screens/generating-transaction/TransactionSummaryBadge', () => ({
  // `fillForArrow` surfaced as an attribute: the real badge paints it into an SVG the stub does
  // not draw, and an earn screen handing it the default (the Send blue) is the bug below.
  TransactionSummaryBadge: ({
    lhs,
    rhs,
    fillForArrow
  }: {
    lhs?: React.ReactNode;
    rhs?: React.ReactNode;
    fillForArrow?: string;
  }) => (
    <div data-testid="summary-badge" data-arrow-fill={fillForArrow}>
      {lhs} → {rhs}
    </div>
  )
}));

jest.mock('screens/generating-transaction/success/TransactionSuccessLayout', () => ({
  TransactionSuccessLayout: (props: TransactionSuccessLayoutProps) => {
    mockSuccessProps = props;
    return (
      <div data-testid="success-layout">
        <span>{props.headerTitle}</span>
        <h2>{props.title}</h2>
        {props.children}
        <button type="button" onClick={props.primaryAction.onClick}>
          {props.primaryAction.label}
        </button>
        {props.secondaryAction && (
          <button type="button" onClick={props.secondaryAction.onClick}>
            {props.secondaryAction.label}
          </button>
        )}
        <button type="button" aria-label="success-close" onClick={props.onClose} />
      </div>
    );
  },
  ReceiptRows: ({ rows }: { rows: { label: React.ReactNode; value: React.ReactNode }[] }) => (
    <div data-testid="receipt-rows">
      {rows.map((row, index) => (
        <div key={index}>
          {row.label}: {row.value}
        </div>
      ))}
    </div>
  )
}));

const makeRow = (extraInputs: IEarnWithdrawExtraInputs, overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'withdraw-1',
  type: 'earn-withdraw',
  accountId: 'miden-account',
  amount: 0n,
  faucetId: 'miden-usdc',
  status: ITransactionStatus.Completed,
  initiatedAt: 1,
  completedAt: 1,
  displayMessage: 'Withdrawing from lending',
  displayIcon: 'DEFAULT',
  extraInputs,
  ...overrides
});

const makeInputs = (overrides: Partial<IEarnWithdrawExtraInputs> = {}): IEarnWithdrawExtraInputs => ({
  evmOwner: '0x1111111111111111111111111111111111111111',
  marketUid: 'DUMMY_LENDING:11155111:0xasset',
  destinationFaucetId: 'miden-usdc',
  sourceAmount: '42.2500',
  sourceSymbol: 'USDC',
  phase: 'redeeming',
  ...overrides
});

describe('EarnWithdrawStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRowState = { row: undefined, loaded: false };
    mockSuccessProps = undefined;
    mockAssetsMetadata = {};
  });

  it('shows a spinner until a transaction row is available', () => {
    const view = render(<EarnWithdrawStatus txId="withdraw-1" />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();

    mockRowState = { row: undefined, loaded: true };
    view.rerender(<EarnWithdrawStatus txId="withdraw-1" />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });

  it('shows the processing state before the intent is submitted', () => {
    mockRowState = { row: makeRow(makeInputs()), loaded: true };
    render(<EarnWithdrawStatus txId="withdraw-1" />);

    expect(screen.getByText('withdrawalProcessing')).toBeInTheDocument();
    expect(screen.getByText('withdrawalProcessingDescription')).toBeInTheDocument();
    expect(screen.getByTestId('hero-state')).toHaveTextContent('processing');
    expect(screen.getByTestId('summary-badge')).toHaveTextContent('42.25 USDC → Miden');
    // A withdraw is an earn row wherever it is drawn, so its arrow is the earn slate its icon
    // takes in Activity — not the badge's default, which is the Send flow's blue.
    expect(screen.getByTestId('summary-badge')).toHaveAttribute('data-arrow-fill', 'var(--tx-earn)');

    expect(screen.getByRole('button', { name: 'hide' })).toHaveAttribute('data-accent', 'earn');
    fireEvent.click(screen.getByRole('button', { name: 'hide' }));
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('shows a failed intent and its recorded error', () => {
    mockRowState = {
      row: makeRow(makeInputs({ phase: 'failed', error: 'solver rejected the intent' })),
      loaded: true
    };
    render(<EarnWithdrawStatus txId="withdraw-1" />);

    expect(screen.getByText('withdrawalFailed')).toBeInTheDocument();
    expect(screen.getByText('solver rejected the intent')).toBeInTheDocument();
    expect(screen.getByTestId('hero-state')).toHaveTextContent('failed');

    expect(screen.getByRole('button', { name: 'done' })).toHaveAttribute('data-accent', 'earn');
    fireEvent.click(screen.getByRole('button', { name: 'done' }));
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('falls back to the generic transaction error for an unstamped failure', () => {
    mockRowState = { row: makeRow(makeInputs({ phase: 'failed' })), loaded: true };
    render(<EarnWithdrawStatus txId="withdraw-1" />);

    expect(screen.getByText('transactionErrorDescription')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('shows a submitted redeeming intent in the success layout', () => {
    mockRowState = {
      row: makeRow(makeInputs({ withdrawIntentNonce: 'owner:1' })),
      loaded: true
    };
    render(<EarnWithdrawStatus txId="withdraw-1" />);

    expect(screen.getByTestId('success-layout')).toBeInTheDocument();
    expect(screen.getByText('withdrawalStarted')).toBeInTheDocument();
    // The status row is a StatusBadge now, so the word is its own element.
    expect(screen.getByTestId('earn-withdraw-status-badge')).toHaveTextContent('earnWithdrawStatusRedeeming');
    expect(mockSuccessProps?.footerDescription).toBe('withdrawalStartedDescription');
    // The receipt is the earn flow's own: its Done is earn (the layout colours its CTA from
    // `accent`), and the arrow is the earn slate like the processing state's.
    expect(mockSuccessProps?.accent).toBe('earn');
    expect(screen.getByTestId('summary-badge')).toHaveAttribute('data-arrow-fill', 'var(--tx-earn)');

    fireEvent.click(screen.getByRole('button', { name: 'done' }));
    fireEvent.click(screen.getByRole('button', { name: 'viewInActivities' }));
    fireEvent.click(screen.getByRole('button', { name: 'success-close' }));

    expect(navigate).toHaveBeenNthCalledWith(1, '/');
    expect(navigate).toHaveBeenNthCalledWith(2, '/history');
    expect(navigate).toHaveBeenNthCalledWith(3, '/');
  });

  it('keeps a saved but unaccepted withdrawal in processing until acceptance arrives', () => {
    mockRowState = {
      row: makeRow(makeInputs({ submissionState: 'prepared', withdrawIntentNonce: '22' })),
      loaded: true
    };
    const { rerender } = render(<EarnWithdrawStatus txId="withdraw-1" />);

    expect(screen.queryByTestId('success-layout')).toBeNull();
    expect(screen.getByText('withdrawalCheckingDescription')).toBeInTheDocument();
    expect(screen.getByTestId('hero-state')).toHaveTextContent('processing');

    mockRowState = {
      row: makeRow(makeInputs({ submissionState: 'accepted', withdrawIntentNonce: '22' })),
      loaded: true
    };
    rerender(<EarnWithdrawStatus txId="withdraw-1" />);
    expect(screen.getByTestId('success-layout')).toBeInTheDocument();
  });

  it('shows the delivering status after Epoch settlement', () => {
    mockRowState = { row: makeRow(makeInputs({ phase: 'delivering' })), loaded: true };
    render(<EarnWithdrawStatus txId="withdraw-1" />);

    // The status row is a StatusBadge now, so the word is its own element.
    expect(screen.getByTestId('earn-withdraw-status-badge')).toHaveTextContent('earnWithdrawStatusDelivering');
    // Nothing is credited yet, so the arrow still points at the network.
    expect(screen.getByTestId('summary-badge').textContent).toBe('42.25 USDC → Miden');
  });

  it('shows the received status after the Miden note is consumed', () => {
    mockRowState = { row: makeRow(makeInputs({ phase: 'received' })), loaded: true };
    render(<EarnWithdrawStatus txId="withdraw-1" />);

    // The status row is a StatusBadge now, so the word is its own element.
    expect(screen.getByTestId('earn-withdraw-status-badge')).toHaveTextContent('received');
  });

  // The withdrawn source stays on the left; the arrow points at what the wallet credited, as
  // Activity shows it, rounded down at the asset's precision. Both remainders sit above half, so
  // half-up, round-up and the typed value would each read differently.
  it('shows the credited amount beside the withdrawn source once received', () => {
    mockRowState = {
      row: makeRow(makeInputs({ phase: 'received', sourceAmount: '42.2599' }), {
        amount: 250_127_456n,
        faucetId: 'native-faucet'
      }),
      loaded: true
    };
    render(<EarnWithdrawStatus txId="withdraw-1" />);

    expect(screen.getByTestId('summary-badge').textContent).toBe('42.25 USDC → 250.12 MIDEN');
  });

  // A delivered faucet other than the native one resolves only from the store; without it the arrow stays on Miden.
  it('reads a delivered non-native faucet from the store once received', () => {
    mockAssetsMetadata = { 'miden-usdc': { symbol: 'USDC', name: 'USDC', decimals: 6 } };
    mockRowState = {
      row: makeRow(makeInputs({ phase: 'received' }), { amount: 250_127_456n, faucetId: 'miden-usdc' }),
      loaded: true
    };
    render(<EarnWithdrawStatus txId="withdraw-1" />);

    expect(screen.getByTestId('summary-badge').textContent).toBe('42.25 USDC → 250.12 USDC');
  });

  // The row's stored output symbol is the bridged source token, not what arrived, so it names nothing here.
  it('keeps the arrow on Miden while the delivered faucet scale is unknown', () => {
    mockRowState = {
      row: makeRow(makeInputs({ phase: 'received', outputSymbol: 'USDC' }), {
        amount: 250_123_456n,
        faucetId: 'unresolved-faucet'
      }),
      loaded: true
    };
    render(<EarnWithdrawStatus txId="withdraw-1" />);

    expect(screen.getByTestId('summary-badge').textContent).toBe('42.25 USDC → Miden');
  });
});

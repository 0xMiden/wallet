import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import type { IEarnWithdrawExtraInputs, ITransaction } from 'lib/miden/db/types';
import { ITransactionStatus } from 'lib/miden/db/types';
import { navigate } from 'lib/woozie';
import type { TransactionSuccessLayoutProps } from 'screens/generating-transaction/success/TransactionSuccessLayout';

import { EarnWithdrawStatus } from './EarnWithdrawStatus';

let mockRowState: { row?: ITransaction; loaded: boolean } = { row: undefined, loaded: false };
let mockSuccessProps: TransactionSuccessLayoutProps | undefined;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

jest.mock('screens/generating-transaction/useTransactionRow', () => ({
  useTransactionRow: () => mockRowState
}));

jest.mock('app/atoms/ActivitySpinner', () => ({
  ActivitySpinner: () => <div data-testid="spinner" />
}));

jest.mock('components/ScreenHeader', () => ({
  ScreenHeader: ({ title, onClose }: { title: string; onClose?: () => void }) => (
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
    title
  }: {
    children?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    title?: string;
  }) => (
    <button type="button" onClick={onClick}>
      {children ?? title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary', Secondary: 'Secondary' }
}));

jest.mock('screens/generating-transaction/components', () => ({
  TransactionHeroIcon: ({ state }: { state: string }) => <div data-testid="hero-state">{state}</div>
}));

jest.mock('screens/generating-transaction/TransactionSummaryBadge', () => ({
  TransactionSummaryBadge: ({ lhs, rhs }: { lhs?: React.ReactNode; rhs?: React.ReactNode }) => (
    <div data-testid="summary-badge">
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

const makeRow = (extraInputs: IEarnWithdrawExtraInputs): ITransaction => ({
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
  extraInputs
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
    expect(screen.getByText('status: earnWithdrawStatusRedeeming')).toBeInTheDocument();
    expect(mockSuccessProps?.footerDescription).toBe('withdrawalStartedDescription');

    fireEvent.click(screen.getByRole('button', { name: 'done' }));
    fireEvent.click(screen.getByRole('button', { name: 'viewInActivities' }));
    fireEvent.click(screen.getByRole('button', { name: 'success-close' }));

    expect(navigate).toHaveBeenNthCalledWith(1, '/');
    expect(navigate).toHaveBeenNthCalledWith(2, '/history');
    expect(navigate).toHaveBeenNthCalledWith(3, '/');
  });

  it('shows the delivering status after Epoch settlement', () => {
    mockRowState = { row: makeRow(makeInputs({ phase: 'delivering' })), loaded: true };
    render(<EarnWithdrawStatus txId="withdraw-1" />);

    expect(screen.getByText('status: earnWithdrawStatusDelivering')).toBeInTheDocument();
  });

  it('shows the received status after the Miden note is consumed', () => {
    mockRowState = { row: makeRow(makeInputs({ phase: 'received' })), loaded: true };
    render(<EarnWithdrawStatus txId="withdraw-1" />);

    expect(screen.getByText('status: received')).toBeInTheDocument();
  });
});

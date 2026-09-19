import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import type { IBridgedReceiveExtraInputs, ITransaction } from 'lib/miden/db/types';
import { ITransactionStatus } from 'lib/miden/db/types';

import { EvmBridgeDepositStatus } from './EvmBridgeDepositStatus';

/**
 * Mirrors `EarnWithdrawStatus.test.tsx` — this screen's own processing/failed body moved onto
 * the same `Hero` shape, so it gets the same coverage: processing vs. failed title, and the
 * recorded-error vs. generic-fallback message.
 */

let mockRowState: { row?: ITransaction; loaded: boolean } = { row: undefined, loaded: false };

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
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
  TransactionSuccessLayout: ({ title }: { title: string }) => <div data-testid="success-layout">{title}</div>,
  ReceiptRows: () => null
}));

const makeRow = (extraInputs: IBridgedReceiveExtraInputs): ITransaction => ({
  id: 'bridge-1',
  type: 'bridged-receive',
  accountId: 'miden-account',
  amount: 0n,
  faucetId: 'miden-usdc',
  status: ITransactionStatus.Completed,
  initiatedAt: 1,
  completedAt: 1,
  displayMessage: 'Bridging in',
  displayIcon: 'DEFAULT',
  extraInputs
});

const makeInputs = (overrides: Partial<IBridgedReceiveExtraInputs> = {}): IBridgedReceiveExtraInputs => ({
  provider: 'epoch',
  sourceAddress: '0x1111111111111111111111111111111111111111',
  sourceAmount: '12.5000',
  sourceSymbol: 'USDC',
  phase: 'submitting',
  ...overrides
});

describe('EvmBridgeDepositStatus', () => {
  const onDone = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockRowState = { row: undefined, loaded: false };
  });

  it('shows a spinner until a transaction row is available', () => {
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });

  it('shows the processing title and description before the deposit is submitted', () => {
    mockRowState = { row: makeRow(makeInputs()), loaded: true };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByText('bridgeDepositProcessing')).toBeInTheDocument();
    expect(screen.getByText('bridgeDepositProcessingDescription')).toBeInTheDocument();
    expect(screen.getByTestId('hero-state')).toHaveTextContent('processing');
    expect(screen.getByTestId('summary-badge')).toHaveTextContent('12.5000 USDC → Miden');

    fireEvent.click(screen.getByRole('button', { name: 'hide' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('shows the failed title and its recorded error', () => {
    mockRowState = {
      row: makeRow(makeInputs({ phase: 'failed', error: 'solver rejected the deposit' })),
      loaded: true
    };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByText('bridgeDepositFailed')).toBeInTheDocument();
    expect(screen.getByText('solver rejected the deposit')).toBeInTheDocument();
    expect(screen.getByTestId('hero-state')).toHaveTextContent('failed');

    fireEvent.click(screen.getByRole('button', { name: 'done' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('falls back to the generic transaction error for an unstamped failure', () => {
    mockRowState = { row: makeRow(makeInputs({ phase: 'failed' })), loaded: true };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByText('transactionErrorDescription')).toBeInTheDocument();
  });

  it('moves to the success layout once the deposit is submitted', () => {
    mockRowState = { row: makeRow(makeInputs({ phase: 'delivering' })), loaded: true };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByTestId('success-layout')).toHaveTextContent('bridgeDepositSubmitted');
  });
});

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

// `fillForArrow` surfaced as an attribute: the real badge paints it into an SVG the stub does
// not draw, and a bridge screen handing it the default (the Send blue) is the bug below.
jest.mock('screens/generating-transaction/TransactionSummaryBadge', () => ({
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

// Children rendered, so the submitted branch's own badge is reachable from this suite.
jest.mock('screens/generating-transaction/success/TransactionSuccessLayout', () => ({
  TransactionSuccessLayout: ({ title, children }: { title: string; children?: React.ReactNode }) => (
    <div data-testid="success-layout">
      {title}
      {children}
    </div>
  ),
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
    expect(screen.getByTestId('summary-badge')).toHaveTextContent('12.50 USDC → Miden');
    // A bridge row is the slate wherever it is drawn, so its arrow is too — not the badge's
    // default, which is the Send flow's blue.
    expect(screen.getByTestId('summary-badge')).toHaveAttribute('data-arrow-fill', '#777487');

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
    // The same slate as the processing body: one bridge, one colour, either side of submission.
    expect(screen.getByTestId('summary-badge')).toHaveAttribute('data-arrow-fill', '#777487');
  });

  it.each(['submitting', 'failed', 'delivering', 'received'] as const)(
    'rounds a long quoted amount in the %s state instead of showing every digit',
    phase => {
      mockRowState = {
        row: makeRow(makeInputs({ phase, sourceAmount: '151.500000000000000001', outputAmount: '150.00' })),
        loaded: true
      };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      const badge = screen.getByTestId('summary-badge');
      expect(badge).toHaveTextContent('151.50 USDC');
      expect(badge).not.toHaveTextContent('151.500000000000000001');
    }
  );

  it('expands the decimals of a tiny amount instead of showing zero', () => {
    mockRowState = { row: makeRow(makeInputs({ phase: 'delivering', sourceAmount: '0.000001234' })), loaded: true };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByTestId('summary-badge')).toHaveTextContent('0.0000012 USDC');
  });
});

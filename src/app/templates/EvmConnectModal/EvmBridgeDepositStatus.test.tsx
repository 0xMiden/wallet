import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import type { IBridgedReceiveExtraInputs, IBridgedReceivePhase, ITransaction } from 'lib/miden/db/types';
import { ITransactionStatus } from 'lib/miden/db/types';
import type { AssetMetadata } from 'lib/miden/metadata/types';

import { EvmBridgeDepositStatus } from './EvmBridgeDepositStatus';

/**
 * Mirrors `EarnWithdrawStatus.test.tsx` — this screen's own processing/failed body moved onto
 * the same `Hero` shape, so it gets the same coverage: processing vs. failed title, and the
 * recorded-error vs. generic-fallback message.
 */

let mockRowState: { row?: ITransaction; loaded: boolean } = { row: undefined, loaded: false };
let mockAssetsMetadata: Record<string, AssetMetadata> = {};

// The screen resolves the delivered faucet synchronously from the store, as the transaction badge does.
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

const makeRow = (extraInputs: IBridgedReceiveExtraInputs, overrides: Partial<ITransaction> = {}): ITransaction => ({
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
  extraInputs,
  ...overrides
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
    mockAssetsMetadata = { 'miden-usdc': { symbol: 'USDC', name: 'USDC', decimals: 6 } };
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
    expect(screen.getByTestId('summary-badge').textContent).toBe('12.5 USDC → Miden');
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

  const submittedPhases: IBridgedReceivePhase[] = ['submitting', 'failed', 'delivering', 'received'];

  // The deposit is what the wallet signed for, so it never reads less than left the account: 10.6512 reads 10.66,
  // where down and half-up both read 10.65.
  it.each(submittedPhases)('rounds a long Fast deposit up in the %s state instead of showing every digit', phase => {
    mockRowState = { row: makeRow(makeInputs({ phase, sourceAmount: '10.6512' })), loaded: true };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    const badge = screen.getByTestId('summary-badge');
    expect(badge.textContent).toMatch(/^10\.66 USDC → /);
    expect(badge).not.toHaveTextContent('10.6512');
  });

  it('expands the decimals of a tiny amount instead of showing zero', () => {
    mockRowState = { row: makeRow(makeInputs({ phase: 'delivering', sourceAmount: '0.000001234' })), loaded: true };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByTestId('summary-badge')).toHaveTextContent('0.0000013 USDC');
  });

  it('shows the credited amount once received, never the quote', () => {
    mockRowState = {
      row: makeRow(makeInputs({ phase: 'received', outputAmount: '150.2', outputSymbol: 'USDC' }), {
        amount: 150_123_456n
      }),
      loaded: true
    };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByTestId('summary-badge').textContent).toBe('12.5 USDC → 150.12 USDC');
  });

  // 12.345 reads 12.34 rounded down and 12.35 rounded up, so only the exact stored amount passes.
  it.each([
    ['12.00', '12'],
    ['12.345', '12.345']
  ])(
    'shows the stored "you receive" amount %s while in flight as %s, unpadded and unrounded',
    (outputAmount, shown) => {
      mockRowState = {
        row: makeRow(makeInputs({ phase: 'delivering', outputAmount, outputSymbol: 'USDC' })),
        loaded: true
      };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      expect(screen.getByTestId('summary-badge').textContent).toBe(`12.5 USDC → ${shown} USDC`);
    }
  );

  it('names the asset without a number once received when the delivered faucet has no known scale', () => {
    mockRowState = {
      row: makeRow(makeInputs({ phase: 'received', outputAmount: '150.2', outputSymbol: 'USDC' }), {
        amount: 150_123_456n,
        faucetId: 'unresolved-faucet'
      }),
      loaded: true
    };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByTestId('summary-badge').textContent).toBe('12.5 USDC → USDC');
  });

  it('keeps six decimals of a credited ETH amount', () => {
    mockAssetsMetadata = { 'miden-eth': { symbol: 'ETH', name: 'Ether', decimals: 18 } };
    mockRowState = {
      row: makeRow(
        makeInputs({
          provider: 'agglayer',
          sourceAmount: '0.015',
          sourceSymbol: 'ETH',
          outputAmount: '0.015',
          outputSymbol: 'ETH',
          phase: 'received'
        }),
        { amount: 15_123_456_789_000_000n, faucetId: 'miden-eth' }
      ),
      loaded: true
    };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByTestId('summary-badge').textContent).toBe('0.015 ETH → 0.015123 ETH');
  });

  it('shows a Slow amount as typed, without a trailing separator', () => {
    mockRowState = {
      row: makeRow(
        makeInputs({
          provider: 'agglayer',
          sourceAmount: '1.',
          sourceSymbol: 'ETH',
          outputAmount: '1.',
          outputSymbol: 'ETH',
          phase: 'delivering'
        })
      ),
      loaded: true
    };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByTestId('summary-badge').textContent).toBe('1 ETH → 1 ETH');
  });

  // Past ETH's six decimals: 0.0151235 reads 0.015123 rounded down and 0.015124 rounded up.
  it('shows the Slow route amounts as typed, not rounded at the asset precision', () => {
    mockRowState = {
      row: makeRow(
        makeInputs({
          provider: 'agglayer',
          sourceAmount: '0.0151235',
          sourceSymbol: 'ETH',
          outputAmount: '0.0151235',
          outputSymbol: 'ETH',
          phase: 'delivering'
        })
      ),
      loaded: true
    };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByTestId('summary-badge').textContent).toBe('0.0151235 ETH → 0.0151235 ETH');
  });
});

import React from 'react';

import { act, render, screen, fireEvent } from '@testing-library/react';

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
  TransactionSuccessLayout: ({
    title,
    footerDescription,
    children
  }: {
    title: string;
    footerDescription?: string;
    children?: React.ReactNode;
  }) => (
    <div data-testid="success-layout">
      {title}
      <p data-testid="success-footer">{footerDescription}</p>
      {children}
    </div>
  ),
  ReceiptRows: ({ rows }: { rows: { label: string; value: string }[] }) => (
    <dl data-testid="receipt-rows">
      {rows.map(row => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}));

jest.mock('app/layouts/page-active', () => ({
  usePageActive: () => true
}));

// The attestation poll is captured rather than run: the test drives `poll` and
// `onArrival` by hand, so no timers are involved.
type TrackerOptions = { active: boolean; intervalMs?: number; poll: () => Promise<boolean>; onArrival?: () => void };
let trackerOptions: TrackerOptions | undefined;
jest.mock('lib/agglayer/use-bridge-tracker', () => ({
  useBridgeTracker: (options: TrackerOptions) => {
    trackerOptions = options;
  }
}));

const fetchXReserveAttestations = jest.fn();
jest.mock('lib/usdcx/attestation', () => ({
  fetchXReserveAttestations: (...args: unknown[]) => fetchXReserveAttestations(...args),
  findAttestationForDomain: (list: { remoteDomain: number }[], domain: number) =>
    list.find(entry => entry.remoteDomain === domain)
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
    expect(screen.getByTestId('success-footer')).toHaveTextContent('bridgeDepositDeliveryDescription');
    expect(trackerOptions?.active).toBe(false);
  });

  describe('USDCx (Circle xReserve) route', () => {
    const DEPOSIT_HASH = `0x${'c'.repeat(64)}`;
    const usdcxInputs = (overrides: Partial<IBridgedReceiveExtraInputs> = {}) =>
      makeInputs({
        provider: 'usdcx',
        outputAmount: '12.5',
        outputSymbol: 'USDCx',
        phase: 'delivering',
        evmTxHash: DEPOSIT_HASH,
        ...overrides
      });

    beforeEach(() => {
      trackerOptions = undefined;
      fetchXReserveAttestations.mockResolvedValue([]);
    });

    it('labels the route USDCx', () => {
      mockRowState = { row: makeRow(usdcxInputs()), loaded: true };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      expect(screen.getByTestId('receipt-rows')).toHaveTextContent('usdcxRouteName · Sepolia → Miden');
    });

    it('polls Circle for the attestation of the deposit hash while delivering', async () => {
      mockRowState = { row: makeRow(usdcxInputs()), loaded: true };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      expect(trackerOptions?.active).toBe(true);
      expect(trackerOptions?.intervalMs).toBe(12_000);
      expect(screen.getByTestId('success-footer')).toHaveTextContent('usdcxAwaitingAttestation');

      await expect(trackerOptions?.poll()).resolves.toBe(false);
      expect(fetchXReserveAttestations).toHaveBeenCalledWith(DEPOSIT_HASH);
    });

    it('reports the attestation once Circle signs for the configured domain', async () => {
      const { USDCX_REMOTE_DOMAIN } = jest.requireActual('lib/usdcx/constant');
      fetchXReserveAttestations.mockResolvedValue([{ remoteDomain: USDCX_REMOTE_DOMAIN }]);
      mockRowState = { row: makeRow(usdcxInputs()), loaded: true };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      await expect(trackerOptions?.poll()).resolves.toBe(true);
      act(() => trackerOptions?.onArrival?.());

      expect(screen.getByTestId('success-footer')).toHaveTextContent('usdcxAttested');
      expect(trackerOptions?.active).toBe(false);
    });

    it('ignores an attestation for another domain', async () => {
      fetchXReserveAttestations.mockResolvedValue([{ remoteDomain: 10001 }]);
      mockRowState = { row: makeRow(usdcxInputs()), loaded: true };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      await expect(trackerOptions?.poll()).resolves.toBe(false);
    });

    it('does not poll before the Sepolia receipt', () => {
      mockRowState = { row: makeRow(usdcxInputs({ phase: 'submitting' })), loaded: true };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      expect(trackerOptions?.active).toBe(false);
    });

    it('does not poll a row with no valid deposit hash', () => {
      mockRowState = { row: makeRow(usdcxInputs({ evmTxHash: 'not-a-hash' })), loaded: true };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      expect(trackerOptions?.active).toBe(false);
    });
  });
});

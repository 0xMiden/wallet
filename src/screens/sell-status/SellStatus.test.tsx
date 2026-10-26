import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import type { ISellExtraInputs, ISellFailure, ISellPhase, ITransaction } from 'lib/miden/db/types';
import { ITransactionStatus } from 'lib/miden/db/types';

import { formatDeadline, sellDeadlineMs, sellFailureKey, sellFundsLocation, sellInputsOf } from './sell-status-helpers';
import { SellStatus } from './SellStatus';

let mockRowState: { row?: ITransaction; loaded: boolean } = { row: undefined, loaded: false };
const mockNavigate = jest.fn();
const mockOpenExternalUrl = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}(${Object.values(params).join(',')})` : key
  })
}));

jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => true
}));

jest.mock('lib/woozie', () => ({
  navigate: (to: string) => mockNavigate(to),
  Redirect: ({ to }: { to: string }) => <div data-testid="redirect">{to}</div>
}));

jest.mock('lib/mobile/external-browser', () => ({
  openExternalUrl: (options: { url: string; title: string }) => mockOpenExternalUrl(options)
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/shared/format', () => ({ formatAmount: (amount: bigint) => `fmt(${amount})` }));

jest.mock('screens/generating-transaction/useTransactionRow', () => ({
  useTransactionRow: () => mockRowState
}));

jest.mock('components/ui/Spinner', () => ({
  Spinner: () => <div data-testid="spinner" />
}));

jest.mock('components/ui/SubPageLayout', () => ({
  SubPageLayout: ({
    title,
    children,
    footer,
    onClose
  }: {
    title: string;
    children: React.ReactNode;
    footer: React.ReactNode;
    onClose: () => void;
  }) => (
    <div>
      <header>
        {title}
        <button type="button" aria-label="close" onClick={onClose} />
      </header>
      {children}
      <footer>{footer}</footer>
    </div>
  )
}));

jest.mock('components/Button', () => ({
  Button: ({
    children,
    onClick,
    'data-testid': testId
  }: {
    children?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    'data-testid'?: string;
  }) => (
    <button type="button" data-testid={testId} onClick={onClick}>
      {children}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary', Secondary: 'Secondary' }
}));

jest.mock('components/ui/CopyButton', () => ({
  CopyButton: ({ text }: { text: string }) => <button type="button" data-testid="copy" data-text={text} />
}));

jest.mock('components/ui/CopyChip', () => ({
  CopyChip: ({ text, children }: { text: string; children: React.ReactNode }) => (
    <button type="button" data-testid="copy-chip" data-text={text}>
      {children}
    </button>
  )
}));

jest.mock('screens/generating-transaction/components', () => ({
  TransactionHeroIcon: ({ state }: { state: string }) => <div data-testid="hero-state">{state}</div>,
  TransactionStepRow: ({
    step,
    state,
    label,
    meta
  }: {
    step: { id: string };
    state: string;
    label: string;
    meta?: string;
  }) => (
    <div data-testid="step" data-step={step.id} data-state={state} data-meta={meta ?? ''}>
      {label}
    </div>
  )
}));

jest.mock('screens/generating-transaction/TransactionSummaryBadge', () => ({
  TransactionSummaryBadge: ({ lhs, rhs }: { lhs?: React.ReactNode; rhs?: React.ReactNode }) => (
    <div data-testid="summary-badge">
      {lhs} → {rhs}
    </div>
  )
}));

const NOW = 1_700_000_000_000;
const DEPOSIT_ADDRESS = '0x57359A5071a83D3b5640BDcb7Ad17c70F40088A4';
const EVM_ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const RELAY_HASH = `0x${'ab'.repeat(32)}`;
const EXPIRES_AT = NOW / 1000 + 3000;

const inputs = (overrides: Partial<ISellExtraInputs> = {}): ISellExtraInputs => ({
  orderId: 'order-1',
  provider: 'transak',
  cryptoAmount: '100',
  tokenSymbol: 'TRNSK',
  tokenDecimals: 8,
  depositAddress: DEPOSIT_ADDRESS,
  depositSource: 'event',
  autoExpiresAt: EXPIRES_AT,
  faucetId: 'mtst1trnsk',
  tokenAmount: '10000000000',
  evmAddress: EVM_ADDRESS,
  bridgeTxId: 'bridge-1',
  phase: 'submitting',
  phaseTimestamps: { submitting: NOW - 10_000 },
  ...overrides
});

const sellRow = (extra: ISellExtraInputs): ITransaction => ({
  id: 'sell-1',
  type: 'sell',
  accountId: 'acct',
  status: ITransactionStatus.Completed,
  initiatedAt: NOW,
  displayIcon: 'SEND',
  extraInputs: extra
});

const setRow = (extra: ISellExtraInputs) => {
  mockRowState = { row: sellRow(extra), loaded: true };
};

const stepStates = () => screen.getAllByTestId('step').map(step => step.getAttribute('data-state'));

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  mockNavigate.mockReset();
  mockOpenExternalUrl.mockReset();
  mockRowState = { row: undefined, loaded: false };
});

afterEach(() => {
  jest.useRealTimers();
});

describe('SellStatus', () => {
  it('shows a spinner until the row is read', () => {
    render(<SellStatus txId="sell-1" />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });

  it('redirects home for an unknown id and for a row that is not a sell', () => {
    mockRowState = { row: undefined, loaded: true };
    const view = render(<SellStatus txId="missing" />);
    expect(screen.getByTestId('redirect')).toHaveTextContent('/');
    view.unmount();

    mockRowState = { row: { ...sellRow(inputs()), type: 'buy' }, loaded: true };
    render(<SellStatus txId="sell-1" />);
    expect(screen.getByTestId('redirect')).toBeInTheDocument();
  });

  const cases: { phase: ISellPhase; states: string[]; fraction: number; title: string; hero: string }[] = [
    {
      phase: 'submitting',
      states: ['active', 'pending', 'pending', 'pending', 'pending', 'pending'],
      fraction: 0.5 / 6,
      title: 'sellStatusProgressTitle',
      hero: 'processing'
    },
    {
      phase: 'bridging',
      states: ['complete', 'active', 'pending', 'pending', 'pending', 'pending'],
      fraction: 1.5 / 6,
      title: 'sellStatusProgressTitle',
      hero: 'processing'
    },
    {
      phase: 'on-ethereum',
      states: ['complete', 'complete', 'active', 'pending', 'pending', 'pending'],
      fraction: 2.5 / 6,
      title: 'sellStatusProgressTitle',
      hero: 'processing'
    },
    {
      phase: 'sent',
      states: ['complete', 'complete', 'complete', 'active', 'pending', 'pending'],
      fraction: 3.5 / 6,
      title: 'sellStatusProgressTitle',
      hero: 'processing'
    },
    {
      phase: 'received',
      states: ['complete', 'complete', 'complete', 'complete', 'active', 'pending'],
      fraction: 4.5 / 6,
      title: 'sellStatusProgressTitle',
      hero: 'processing'
    },
    {
      phase: 'completed',
      states: ['complete', 'complete', 'complete', 'complete', 'complete', 'complete'],
      fraction: 1,
      title: 'sellStatusCompletedTitle',
      hero: 'success'
    }
  ];

  it.each(cases)('shows the steps, progress and title for phase $phase', ({ phase, states, fraction, title, hero }) => {
    setRow(inputs({ phase }));
    render(<SellStatus txId="sell-1" />);

    expect(stepStates()).toEqual(states);
    expect(screen.getAllByTestId('step').map(step => step.textContent)).toEqual([
      'sellStepSubmitting',
      'sellStepBridging',
      'sellStepOnEthereum',
      'sellStepSent',
      'sellStepReceived',
      'sellStepCompleted'
    ]);
    expect(screen.getByTestId('sell-progress')).toHaveAttribute('data-progress', fraction.toFixed(4));
    expect(screen.getByTestId('sell-progress-fill')).toHaveAttribute('data-failed', 'false');
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByTestId('hero-state')).toHaveTextContent(hero);
    expect(screen.getByTestId('sell-status-done')).toHaveTextContent(phase === 'completed' ? 'done' : 'hide');
    expect(screen.getByTestId('sell-status-progress')).toHaveAttribute('data-phase', phase);
  });

  it('names the token that is really sold, never USDCx', () => {
    setRow(inputs());
    render(<SellStatus txId="sell-1" />);
    expect(screen.getByTestId('summary-badge')).toHaveTextContent('100 TRNSK → Transak');
    expect(screen.getByTestId('sell-status-amount')).toHaveTextContent('100 TRNSK');
    expect(document.body).not.toHaveTextContent('USDCx');
  });

  it('shows the time each step took, and counts the active step up', () => {
    setRow(inputs({ phase: 'bridging', phaseTimestamps: { submitting: NOW - 90_000, bridging: NOW - 30_000 } }));
    render(<SellStatus txId="sell-1" />);
    const metas = screen.getAllByTestId('step').map(step => step.getAttribute('data-meta'));
    expect(metas).toEqual(['buyStepDurationMin(1)', 'transactionStepDurationSec(30)', '', '', '', '']);
  });

  it('shows the details: deposit address, own address, deadline and order id', () => {
    setRow(inputs());
    render(<SellStatus txId="sell-1" />);
    expect(screen.getByTestId('sell-status-deposit-address')).toHaveTextContent(DEPOSIT_ADDRESS);
    expect(screen.getByTestId('sell-status-evm-address')).toHaveTextContent(EVM_ADDRESS);
    expect(screen.getByTestId('sell-status-deadline')).toHaveTextContent(formatDeadline(EXPIRES_AT * 1000));
    expect(screen.getByTestId('sell-status-deadline')).toHaveTextContent('sellDetailDeadlineHint');
    expect(screen.getByTestId('sell-status-order-id')).toBeInTheDocument();
    const copied = screen.getAllByTestId('copy').map(button => button.getAttribute('data-text'));
    expect(copied).toEqual([DEPOSIT_ADDRESS, EVM_ADDRESS]);
    // Not known yet.
    expect(screen.queryByTestId('sell-status-bridge-tx')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sell-status-relay-tx')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sell-status-transak-status')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sell-status-explorer')).not.toBeInTheDocument();
  });

  it('shows the bridge transaction, the relay transaction with its Etherscan link and the Transak status', () => {
    setRow(
      inputs({
        phase: 'received',
        bridgeTransactionId: '0xmidentx',
        relayTxHash: RELAY_HASH,
        transakStatus: 'PENDING_DELIVERY_FROM_TRANSAK'
      })
    );
    render(<SellStatus txId="sell-1" />);
    expect(screen.getByTestId('sell-status-bridge-tx')).toBeInTheDocument();
    expect(screen.getByTestId('sell-status-relay-tx')).toBeInTheDocument();
    expect(screen.getByTestId('sell-status-transak-status')).toHaveTextContent('PENDING_DELIVERY_FROM_TRANSAK');
    // The deadline does not matter after the relay.
    expect(screen.queryByTestId('sell-status-deadline')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sell-status-explorer'));
    expect(mockOpenExternalUrl).toHaveBeenCalledWith({
      url: `https://sepolia.etherscan.io/tx/${RELAY_HASH}`,
      title: 'Etherscan'
    });
  });

  const failures: {
    failure: ISellFailure;
    key: string;
    stamps: ISellExtraInputs['phaseTimestamps'];
    funds?: string;
  }[] = [
    { failure: 'bridge-failed', key: 'sellFailureBridge', stamps: { submitting: 1 }, funds: 'sellFundsOnMiden' },
    {
      // Its own text, which tells that the token stays at the EVM address. No second notice.
      failure: 'order-expired',
      key: 'sellFailureOrderExpired',
      stamps: { submitting: 1, bridging: 2 }
    },
    {
      failure: 'transak-expired',
      key: 'sellFailureExpired',
      stamps: { submitting: 1, bridging: 2, 'on-ethereum': 3 },
      funds: 'sellFundsOnEthereum'
    },
    {
      failure: 'order-cancelled',
      key: 'sellFailureCancelled',
      stamps: { submitting: 1 },
      funds: 'sellFundsOnEthereum'
    },
    {
      failure: 'transak-failed',
      key: 'sellFailureTransakFailed',
      stamps: { submitting: 1, bridging: 2, 'on-ethereum': 3, sent: 4 },
      funds: 'sellFundsAtTransak'
    },
    {
      failure: 'transak-refunded',
      key: 'sellFailureTransakRefunded',
      stamps: { submitting: 1, bridging: 2, 'on-ethereum': 3, sent: 4, received: 5 },
      funds: 'sellFundsAtTransak'
    },
    { failure: 'timeout', key: 'sellFailureTimeout', stamps: { submitting: 1 } },
    { failure: 'restored', key: 'sellFailureRestored', stamps: { submitting: 1 } }
  ];

  it.each(failures)('explains a sale that failed with $failure', ({ failure, key, stamps, funds }) => {
    setRow(inputs({ phase: 'failed', failure, phaseTimestamps: { ...stamps, failed: NOW } }));
    render(<SellStatus txId="sell-1" />);

    expect(screen.getByRole('alert')).toHaveTextContent(key);
    expect(screen.getByText('sellStatusFailedTitle')).toBeInTheDocument();
    expect(screen.getByTestId('hero-state')).toHaveTextContent('failed');
    expect(screen.getByTestId('sell-progress-fill')).toHaveAttribute('data-failed', 'true');
    expect(screen.getByTestId('sell-status-done')).toHaveTextContent('done');
    // The step where the sale stopped is the failed one.
    expect(stepStates().filter(state => state === 'failed')).toHaveLength(1);
    const notices = screen.queryAllByTestId('sell-status-funds');
    expect(notices).toHaveLength(funds === undefined ? 0 : 1);
    expect(notices.map(notice => notice.textContent ?? '').join('')).toContain(funds ?? '');
  });

  it('shows the detail text of a failure under its cause', () => {
    setRow(
      inputs({
        phase: 'failed',
        failure: 'bridge-failed',
        error: 'Transaction execution failed',
        phaseTimestamps: { submitting: 1, failed: 2 }
      })
    );
    render(<SellStatus txId="sell-1" />);
    expect(screen.getByTestId('sell-status-error-detail')).toHaveTextContent('Transaction execution failed');
  });

  it('asks for the tap on "Yes, I have paid" only when the wallet did not find the button', () => {
    setRow(inputs({ phase: 'sent', depositSource: 'page', paidClicked: false }));
    const view = render(<SellStatus txId="sell-1" />);
    expect(screen.getByTestId('sell-status-tap-paid')).toHaveTextContent('cashSellTapPaid');
    view.unmount();

    setRow(inputs({ phase: 'sent', depositSource: 'page', paidClicked: true }));
    render(<SellStatus txId="sell-1" />);
    expect(screen.queryByTestId('sell-status-tap-paid')).not.toBeInTheDocument();
  });

  it('goes home from Hide and from the close button', () => {
    setRow(inputs());
    render(<SellStatus txId="sell-1" />);
    fireEvent.click(screen.getByTestId('sell-status-done'));
    fireEvent.click(screen.getByLabelText('close'));
    expect(mockNavigate.mock.calls).toEqual([['/'], ['/']]);
  });
});

describe('sell status helpers', () => {
  it('reads only a valid sell row', () => {
    expect(sellInputsOf(sellRow(inputs()))).toBeDefined();
    expect(sellInputsOf(undefined)).toBeUndefined();
    expect(sellInputsOf({ ...sellRow(inputs()), type: 'buy' })).toBeUndefined();
    expect(sellInputsOf({ ...sellRow(inputs()), extraInputs: { orderId: 'x', phase: 'bogus' } })).toBeUndefined();
  });

  it('gives the deadline only before the relay', () => {
    expect(sellDeadlineMs({ phase: 'bridging', autoExpiresAt: 10 })).toBe(10_000);
    expect(sellDeadlineMs({ phase: 'sent', autoExpiresAt: 10 })).toBeUndefined();
    expect(sellDeadlineMs({ phase: 'failed', autoExpiresAt: 10 })).toBeUndefined();
    expect(sellDeadlineMs({ phase: 'submitting' })).toBeUndefined();
  });

  it('gives the general text for a failed row with no recorded cause', () => {
    expect(sellFailureKey(undefined)).toBe('sellStatusFailedDescription');
    expect(sellFundsLocation({ phaseTimestamps: {} })).toBe('unknown');
  });

  it('says that Transak has the token when a relay hash is on the row', () => {
    expect(sellFundsLocation({ failure: 'transak-failed', phaseTimestamps: {}, relayTxHash: RELAY_HASH })).toBe(
      'transak'
    );
  });
});

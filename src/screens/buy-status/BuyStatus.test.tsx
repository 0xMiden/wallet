import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import type { IBuyExtraInputs, IBuyPhase, ITransaction } from 'lib/miden/db/types';
import { ITransactionStatus } from 'lib/miden/db/types';

import { BuyStatus } from './BuyStatus';
import { buyProgressFraction, buyStepDurationsMs } from './buy-status-helpers';

let mockRowState: { row?: ITransaction; loaded: boolean } = { row: undefined, loaded: false };
let mockReducedMotion = false;
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
  useReducedMotion: () => mockReducedMotion
}));

jest.mock('lib/woozie', () => ({
  navigate: (to: string) => mockNavigate(to),
  Redirect: ({ to }: { to: string }) => <div data-testid="redirect">{to}</div>
}));

jest.mock('lib/mobile/external-browser', () => ({
  openExternalUrl: (options: { url: string; title: string }) => mockOpenExternalUrl(options)
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

// The real scaler needs the i18n number stack. The screen only has to pass the base units and the decimals.
jest.mock('lib/shared/format', () => ({
  formatAmount: (amount: bigint, decimals?: number) => `fmt(${amount},${decimals})`
}));

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

jest.mock('screens/generating-transaction/components', () => ({
  TransactionHeroIcon: ({ state }: { state: string }) => <div data-testid="hero-state">{state}</div>,
  TransactionStepRow: ({ step, state, label, meta }: { step: { id: string }; state: string; label: string; meta?: string }) => (
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

const inputs = (overrides: Partial<IBuyExtraInputs> = {}): IBuyExtraInputs => ({
  orderId: 'order-1',
  provider: 'transak',
  fiatAmount: '20',
  fiatCurrency: 'USD',
  tokenSymbol: 'USDC',
  phase: 'payment',
  phaseTimestamps: { payment: NOW - 10_000 },
  ...overrides
});

const buyRow = (extra: IBuyExtraInputs): ITransaction => ({
  id: 'buy-1',
  type: 'buy',
  accountId: 'acct',
  status: ITransactionStatus.Completed,
  initiatedAt: NOW,
  displayIcon: 'RECEIVE',
  extraInputs: extra
});

const setRow = (extra: IBuyExtraInputs) => {
  mockRowState = { row: buyRow(extra), loaded: true };
};

const stepStates = () => screen.getAllByTestId('step').map(step => step.getAttribute('data-state'));

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  mockNavigate.mockReset();
  mockOpenExternalUrl.mockReset();
  mockReducedMotion = false;
  mockRowState = { row: undefined, loaded: false };
});

afterEach(() => {
  jest.useRealTimers();
});

describe('BuyStatus', () => {
  it('shows a spinner until the row is read', () => {
    render(<BuyStatus txId="buy-1" />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });

  it('redirects home for an unknown id', () => {
    mockRowState = { row: undefined, loaded: true };
    render(<BuyStatus txId="missing" />);
    expect(screen.getByTestId('redirect')).toHaveTextContent('/');
  });

  it('redirects home for a row that is not a buy', () => {
    mockRowState = { row: { ...buyRow(inputs()), type: 'send' }, loaded: true };
    render(<BuyStatus txId="buy-1" />);
    expect(screen.getByTestId('redirect')).toBeInTheDocument();
  });

  const cases: { phase: IBuyPhase; states: string[]; fraction: number; title: string; hero: string }[] = [
    {
      phase: 'payment',
      states: ['active', 'pending', 'pending', 'pending', 'pending', 'pending'],
      fraction: 0.5 / 6,
      title: 'buyStatusProgressTitle',
      hero: 'processing'
    },
    {
      phase: 'funds-arriving',
      states: ['complete', 'active', 'pending', 'pending', 'pending', 'pending'],
      fraction: 1.5 / 6,
      title: 'buyStatusProgressTitle',
      hero: 'processing'
    },
    {
      phase: 'bridge-sent',
      states: ['complete', 'complete', 'active', 'pending', 'pending', 'pending'],
      fraction: 2.5 / 6,
      title: 'buyStatusProgressTitle',
      hero: 'processing'
    },
    {
      phase: 'bridging',
      states: ['complete', 'complete', 'complete', 'active', 'pending', 'pending'],
      fraction: 3.5 / 6,
      title: 'buyStatusProgressTitle',
      hero: 'processing'
    },
    {
      phase: 'consuming',
      states: ['complete', 'complete', 'complete', 'complete', 'active', 'pending'],
      fraction: 4.5 / 6,
      title: 'buyStatusProgressTitle',
      hero: 'processing'
    },
    {
      phase: 'completed',
      states: ['complete', 'complete', 'complete', 'complete', 'complete', 'complete'],
      fraction: 1,
      title: 'buyStatusCompletedTitle',
      hero: 'success'
    }
  ];

  it.each(cases)('shows the steps, progress and title for phase $phase', ({ phase, states, fraction, title, hero }) => {
    setRow(inputs({ phase }));
    render(<BuyStatus txId="buy-1" />);

    expect(stepStates()).toEqual(states);
    expect(screen.getByTestId('buy-progress')).toHaveAttribute('data-progress', fraction.toFixed(4));
    expect(screen.getByTestId('buy-progress-fill')).toHaveAttribute('data-failed', 'false');
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByTestId('hero-state')).toHaveTextContent(hero);
    expect(screen.getByTestId('buy-status-done')).toHaveTextContent(phase === 'completed' ? 'done' : 'hide');
  });

  it('pulses the active segment while in progress, and not under reduced motion or once complete', () => {
    setRow(inputs({ phase: 'bridging' }));
    const view = render(<BuyStatus txId="buy-1" />);
    expect(screen.getByTestId('buy-progress-pulse')).toBeInTheDocument();
    view.unmount();

    mockReducedMotion = true;
    const reduced = render(<BuyStatus txId="buy-1" />);
    expect(screen.queryByTestId('buy-progress-pulse')).not.toBeInTheDocument();
    reduced.unmount();

    mockReducedMotion = false;
    setRow(inputs({ phase: 'completed' }));
    render(<BuyStatus txId="buy-1" />);
    expect(screen.queryByTestId('buy-progress-pulse')).not.toBeInTheDocument();
  });

  it('shows the failed state at the step where the order stopped, with the row error', () => {
    setRow(
      inputs({
        phase: 'failed',
        phaseTimestamps: { payment: NOW - 30_000, 'funds-arriving': NOW - 20_000, failed: NOW - 5_000 },
        error: 'Order expired'
      })
    );
    render(<BuyStatus txId="buy-1" />);

    expect(stepStates()).toEqual(['complete', 'failed', 'pending', 'pending', 'pending', 'pending']);
    expect(screen.getByTestId('buy-progress-fill')).toHaveAttribute('data-failed', 'true');
    expect(screen.queryByTestId('buy-progress-pulse')).not.toBeInTheDocument();
    expect(screen.getByText('buyStatusFailedTitle')).toBeInTheDocument();
    expect(screen.getByTestId('hero-state')).toHaveTextContent('failed');
    expect(screen.getByRole('alert')).toHaveTextContent('Order expired');
    expect(screen.getByTestId('buy-status-done')).toHaveTextContent('done');
  });

  it('falls back to the generic failure text when the row has no error', () => {
    setRow(inputs({ phase: 'failed' }));
    render(<BuyStatus txId="buy-1" />);
    expect(screen.getByRole('alert')).toHaveTextContent('buyStatusFailedDescription');
  });

  it('shows the fiat side alone until the token amount is known, then the scaled amount', () => {
    setRow(inputs());
    const view = render(<BuyStatus txId="buy-1" />);
    expect(screen.getByTestId('summary-badge')).toHaveTextContent('buyStatusFiatAmount(20,USD) → USDC');
    view.unmount();

    setRow(inputs({ tokenAmount: '19800000', tokenDecimals: 6 }));
    render(<BuyStatus txId="buy-1" />);
    expect(screen.getByTestId('summary-badge')).toHaveTextContent('buyStatusFiatAmount(20,USD) → fmt(19800000,6) USDC');
  });

  it('times finished steps from their stamps and ticks the active step each second', () => {
    setRow(
      inputs({
        phase: 'funds-arriving',
        phaseTimestamps: { payment: NOW - 125_000, 'funds-arriving': NOW - 5_000 }
      })
    );
    render(<BuyStatus txId="buy-1" />);

    const meta = () => screen.getAllByTestId('step').map(step => step.getAttribute('data-meta'));
    expect(meta()).toEqual(['buyStepDurationMin(2)', 'transactionStepDurationSec(5)', '', '', '', '']);
    act(() => {
      jest.advanceTimersByTime(3_000);
    });
    expect(meta()[1]).toBe('transactionStepDurationSec(8)');
  });

  it('links the relay transaction on Sepolia Etherscan', () => {
    setRow(inputs({ phase: 'bridge-sent', relayTxHash: '0xabc' }));
    render(<BuyStatus txId="buy-1" />);

    fireEvent.click(screen.getByTestId('buy-status-explorer'));
    expect(mockOpenExternalUrl).toHaveBeenCalledWith({
      url: 'https://sepolia.etherscan.io/tx/0xabc',
      title: 'Etherscan'
    });
  });

  it('has no explorer link before the relay transaction is sent', () => {
    setRow(inputs({ phase: 'funds-arriving' }));
    render(<BuyStatus txId="buy-1" />);
    expect(screen.queryByTestId('buy-status-explorer')).not.toBeInTheDocument();
  });

  it('goes home from the footer button and the close button', () => {
    setRow(inputs());
    render(<BuyStatus txId="buy-1" />);
    fireEvent.click(screen.getByTestId('buy-status-done'));
    fireEvent.click(screen.getByLabelText('close'));
    expect(mockNavigate).toHaveBeenCalledTimes(2);
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});

describe('buy status helpers', () => {
  it('fills a completed order to the end and a failed one to the half segment where it stopped', () => {
    expect(buyProgressFraction(inputs({ phase: 'completed' }))).toBe(1);
    expect(
      buyProgressFraction(inputs({ phase: 'failed', phaseTimestamps: { payment: 1, 'funds-arriving': 2, bridging: 3 } }))
    ).toBeCloseTo(3.5 / 6);
  });

  it('ends a step at the next stamp that exists, and gives the completed step no duration', () => {
    const durations = buyStepDurationsMs(
      inputs({ phase: 'completed', phaseTimestamps: { payment: 0, 'bridge-sent': 4_000, completed: 9_000 } }),
      NOW
    );
    expect(durations).toEqual([4_000, undefined, 5_000, undefined, undefined, undefined]);
  });
});

import React from 'react';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { DepositProcessingView, type DepositProcessingViewProps } from './DepositProcessingView';
import { DepositSuccessView, type DepositSuccessViewProps } from './DepositSuccessView';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key)
  })
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));
jest.mock('screens/generating-transaction/components', () => ({
  TransactionHeroIcon: ({ state }: { state: string }) => <span data-testid={`hero-${state}`} />
}));

const processing = (overrides: Partial<DepositProcessingViewProps> = {}): DepositProcessingViewProps => ({
  sent: { value: { amount: 1_500_000n, decimals: 6 }, symbol: 'USDC', rounding: 'exact' },
  received: { value: { amount: '1.4955' }, symbol: 'USDCx', rounding: 'down' },
  activeStep: 1,
  slow: false,
  ...overrides
});

const success = (overrides: Partial<DepositSuccessViewProps> = {}): DepositSuccessViewProps => ({
  sent: { value: { amount: '1.5' }, symbol: 'ETH', rounding: 'exact' },
  received: { value: { amount: '1.5' }, symbol: 'ETH', rounding: 'down' },
  networkName: 'Base',
  routeName: 'Agglayer',
  bridgeFee: { kind: 'none' },
  feeSymbol: 'ETH',
  onDone: jest.fn(),
  onDepositAgain: jest.fn(),
  ...overrides
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe('DepositProcessingView', () => {
  it('shows the ring, the title, the badge and the three steps with the active one turning', () => {
    render(<DepositProcessingView {...processing()} />);

    expect(screen.getByTestId('deposit-processing-spinner')).toHaveClass('size-16', 'border-[7px]');
    expect(screen.getByRole('status')).toHaveTextContent('depositFlowBridgingToMiden');
    expect(screen.getByTestId('deposit-badge-sent')).toHaveTextContent('1.5 USDC');
    expect(screen.getByTestId('deposit-badge-received')).toHaveTextContent('1.49 USDCx');
    const states = [0, 1, 2].map(index => screen.getByTestId(`deposit-processing-step-${index}`).dataset.state);
    expect(states).toEqual(['done', 'now', 'wait']);
    expect(screen.getByTestId('deposit-processing-step-0')).toHaveTextContent('depositFlowStepDetected');
    expect(screen.getByTestId('deposit-processing-step-2')).toHaveTextContent('depositFlowStepArrived');
    expect(screen.getByTestId('deposit-processing-step-2')).toHaveClass('text-muted');
    expect(screen.getByTestId('deposit-processing-note')).toHaveTextContent('depositFlowProcessingNote');
  });

  it('says that Agglayer takes about 30 minutes', () => {
    render(<DepositProcessingView {...processing({ slow: true, activeStep: 0 })} />);

    expect(screen.getByTestId('deposit-processing-note')).toHaveTextContent('depositFlowProcessingSlowNote');
    expect(screen.getByTestId('deposit-processing-step-0').dataset.state).toBe('now');
  });

  it('shows the symbol alone for a side with no amount', () => {
    render(<DepositProcessingView {...processing({ received: { symbol: 'USDCx', rounding: 'down' } })} />);

    expect(screen.getByTestId('deposit-badge-received')).toHaveTextContent(/^USDCx$/);
  });

  it('shows and reports a failure in the place of the steps', () => {
    jest.useFakeTimers();
    render(
      <DepositProcessingView
        {...processing({ failure: { message: 'The relay reverted', errorId: 'raw_bridge_deposit_failed' } })}
      />
    );

    expect(screen.getByTestId('hero-failed')).toBeInTheDocument();
    expect(screen.getByText('bridgeDepositFailed')).toBeInTheDocument();
    expect(screen.getByTestId('deposit-processing-failed')).toHaveTextContent('The relay reverted');
    expect(screen.queryByTestId('deposit-processing-steps')).not.toBeInTheDocument();
    jest.advanceTimersByTime(1000);
    expect(reportUserVisibleError).toHaveBeenCalledWith('raw_bridge_deposit_failed', 'status_screen');
  });
});

describe('DepositSuccessView', () => {
  it('shows the check, the title, the badge and the details', () => {
    render(<DepositSuccessView {...success({ bridgeFee: { kind: 'amount', value: { amount: '0.0045' } } })} />);

    expect(screen.getByRole('heading', { name: 'depositFlowArrivedTitle' })).toBeInTheDocument();
    const facts = screen.getByTestId('deposit-success-facts');
    expect(facts).toHaveTextContent('from');
    expect(facts).toHaveTextContent('Base');
    expect(facts).toHaveTextContent('Agglayer');
    expect(screen.getByTestId('deposit-success-fee')).toHaveTextContent('0.0045 ETH');
    expect(screen.getByTestId('deposit-success-received')).toHaveTextContent('1.5 ETH');
  });

  it('names the received token alone when it has no amount', () => {
    render(<DepositSuccessView {...success({ received: { symbol: 'ETH', rounding: 'down' } })} />);

    expect(screen.getByTestId('deposit-success-received')).toHaveTextContent(/received\s*ETH$/);
  });

  it('runs Done and Deposit again', () => {
    const onDone = jest.fn();
    const onDepositAgain = jest.fn();
    render(<DepositSuccessView {...success({ onDone, onDepositAgain })} />);

    fireEvent.click(screen.getByTestId('deposit-success-done'));
    fireEvent.click(screen.getByTestId('deposit-success-again'));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDepositAgain).toHaveBeenCalledTimes(1);
  });
});

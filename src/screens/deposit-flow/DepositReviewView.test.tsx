import React from 'react';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { DepositReviewView, type DepositReviewViewProps } from './DepositReviewView';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key)
  }),
  Trans: ({ i18nKey, values }: { i18nKey: string; values?: Record<string, string> }) => (
    <>{`${i18nKey} ${JSON.stringify(values)}`}</>
  )
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSuccess: jest.fn() }));
jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ faucetId, size }: { faucetId: string | undefined; size?: string }) => (
    <span data-testid={`logo-${faucetId}-${size}`} />
  )
}));

function props(overrides: Partial<DepositReviewViewProps> = {}): DepositReviewViewProps {
  return {
    received: { amount: '70.04' },
    receivedUsd: 70.04,
    receivedToken: { symbol: 'USDCx', logoFaucetId: 'usdcx' },
    amount: { amount: 70250000n, decimals: 6 },
    sourceToken: { symbol: 'USDC', logoFaucetId: 'usdcx' },
    network: { id: 'ethereum', name: 'Ethereum' },
    bridgeFee: { kind: 'amount', value: { amount: '0.21' } },
    routeName: 'Epoch',
    arrivesIn: 'About 2 minutes',
    onConfirm: jest.fn(),
    ...overrides
  };
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('DepositReviewView', () => {
  it('leads with what arrives and says what is sent from where', () => {
    render(<DepositReviewView {...props()} />);
    expect(screen.getByTestId('logo-usdcx-2xl')).toBeInTheDocument();
    expect(screen.getByTestId('deposit-review-hero')).toHaveTextContent('depositFlowYouReceive');
    expect(screen.getByTestId('deposit-review-received')).toHaveTextContent('70.04 USDCx');
    expect(screen.getByTestId('deposit-review-hero')).toHaveTextContent('depositFlowUsdEstimate {"value":"$70.04"}');
    expect(screen.getByTestId('deposit-review-send')).toHaveTextContent(
      'depositFlowYouSendFrom {"amount":"70.25 USDC","network":"Ethereum"}'
    );
  });

  it('lists the fee, the gas, the route and the time', () => {
    render(<DepositReviewView {...props()} />);
    const facts = screen.getByTestId('deposit-review-facts');
    expect(screen.getByTestId('deposit-review-fee')).toHaveTextContent('0.21 USDC');
    expect(facts).toHaveTextContent('depositFlowPaidByBread');
    expect(facts).toHaveTextContent('Epoch');
    expect(facts).toHaveTextContent('About 2 minutes');
  });

  it('names who pays the gas when the route says so, and draws a notice under the facts', () => {
    render(
      <DepositReviewView {...props({ networkGas: 'Included in fee', notice: <p data-testid="extra-notice" /> })} />
    );
    expect(screen.getByTestId('deposit-review-facts')).toHaveTextContent('Included in fee');
    expect(screen.getByTestId('deposit-review-facts').nextElementSibling).toBe(screen.getByTestId('extra-notice'));
  });

  it('leaves out the USD line when there is no price', () => {
    render(<DepositReviewView {...props({ receivedUsd: undefined })} />);
    expect(screen.getByTestId('deposit-review-hero')).not.toHaveTextContent('depositFlowUsdEstimate');
  });

  it('warns only when the fee is more than 5% of the deposit', () => {
    const { rerender } = render(<DepositReviewView {...props({ feeShare: 0.05 })} />);
    expect(screen.queryByTestId('deposit-review-high-fee')).not.toBeInTheDocument();
    rerender(<DepositReviewView {...props({ feeShare: 0.083 })} />);
    expect(screen.getByTestId('deposit-review-high-fee')).toHaveTextContent('depositFlowHighFeeTitle {"percent":"8"}');
    expect(screen.getByTestId('deposit-review-high-fee')).toHaveTextContent('depositFlowHighFeeBody');
  });

  it('confirms through the slide and blocks it while disabled', () => {
    const onConfirm = jest.fn();
    const { rerender } = render(<DepositReviewView {...props({ onConfirm, confirmDisabled: true })} />);
    const knob = screen.getByTestId('deposit-review-slide-knob');
    expect(knob).toHaveAccessibleName('depositFlowSlideToShowAddress');
    fireEvent.keyDown(knob, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
    rerender(<DepositReviewView {...props({ onConfirm })} />);
    fireEvent.keyDown(screen.getByTestId('deposit-review-slide-knob'), { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

import React from 'react';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { DepositAmountView, type DepositAmountViewProps } from './DepositAmountView';

jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key)
  })
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ faucetId }: { faucetId: string | undefined }) => <span data-testid={`logo-${faucetId}`} />
}));
jest.mock('components/NetworkChip', () => ({
  NetworkLogo: ({ network }: { network?: string }) => <span data-testid={`network-${network}`} />
}));

const USDC = { symbol: 'USDC', logoFaucetId: 'usdcx-faucet' };
const USDCX = { symbol: 'USDCx', logoFaucetId: 'usdcx-faucet' };
const ETHEREUM = { id: 'ethereum', name: 'Ethereum' };

function props(overrides: Partial<DepositAmountViewProps> = {}): DepositAmountViewProps {
  return {
    amount: '',
    onAmountChange: jest.fn(),
    decimals: 6,
    sourceToken: USDC,
    receivedToken: USDCX,
    network: ETHEREUM,
    onSelectToken: jest.fn(),
    bridgeFee: { kind: 'rate', text: '0.3%' },
    routeName: 'Epoch',
    routeCount: 1,
    onChangeRoute: jest.fn(),
    arrivesIn: 'About 2 minutes',
    isValidAmount: false,
    onReview: jest.fn(),
    ...overrides
  };
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('DepositAmountView', () => {
  it('draws the empty receipt: the rate, the route, the arrival, the gas and a 0.00 total', () => {
    render(<DepositAmountView {...props()} />);
    expect(screen.getByText('depositFlowDepositAmount')).toBeInTheDocument();
    expect(screen.getByTestId('deposit-amount-input')).toHaveAttribute('placeholder', '0.00');
    expect(screen.getByTestId('deposit-receipt-fee')).toHaveTextContent('0.3%');
    expect(screen.getByTestId('deposit-receipt-route')).toHaveTextContent('Epoch');
    expect(screen.queryByTestId('deposit-route-change')).not.toBeInTheDocument();
    expect(screen.getByTestId('deposit-receipt-arrival')).toHaveTextContent('About 2 minutes');
    expect(screen.getByTestId('deposit-receipt-gas')).toHaveTextContent('depositFlowPaidByBread');
    expect(screen.getByTestId('deposit-receipt-total-amount')).toHaveTextContent('0.00 USDCx');
    expect(screen.getByTestId('deposit-amount-usd')).toHaveTextContent('');
    expect(screen.getByTestId('deposit-amount-review')).toBeDisabled();
    expect(screen.queryByTestId('deposit-cap-notice')).not.toBeInTheDocument();
  });

  it('shows a quoted fee with a minus sign, the total and both USD lines', () => {
    render(
      <DepositAmountView
        {...props({
          amount: '70.25',
          amountUsd: 70.25,
          bridgeFee: { kind: 'amount', value: { amount: 210000n, decimals: 6 } },
          received: { amount: '70.04' },
          receivedUsd: 70.04,
          isValidAmount: true
        })}
      />
    );
    expect(screen.getByTestId('deposit-amount-input')).toHaveValue('70.25');
    expect(screen.getByTestId('deposit-amount-usd')).toHaveTextContent('depositFlowUsdEstimate {"value":"$70.25"}');
    expect(screen.getByTestId('deposit-receipt-fee')).toHaveTextContent('− 0.21 USDC');
    expect(screen.getByTestId('deposit-receipt-total-amount')).toHaveTextContent('70.04 USDCx');
    expect(screen.getByTestId('deposit-receipt-total-amount')).not.toHaveClass('text-[20px]');
    expect(screen.getByTestId('deposit-receipt-total')).toHaveTextContent('depositFlowUsdEstimate {"value":"$70.04"}');
    expect(screen.getByTestId('deposit-amount-review')).toBeEnabled();
  });

  it('drops the total to 20px when it is longer than 8 characters', () => {
    render(<DepositAmountView {...props({ received: { amount: '123456.78' } })} />);
    expect(screen.getByTestId('deposit-receipt-total-amount')).toHaveClass('text-[20px]');
  });

  it('shows "None" for a route with no fee and leaves out the arrival row when there is none', () => {
    render(<DepositAmountView {...props({ bridgeFee: { kind: 'none' }, arrivesIn: undefined })} />);
    expect(screen.getByTestId('deposit-receipt-fee')).toHaveTextContent('none');
    expect(screen.queryByTestId('deposit-receipt-arrival')).not.toBeInTheDocument();
  });

  it('accepts decimals up to the token scale and refuses anything else', () => {
    const onAmountChange = jest.fn();
    render(<DepositAmountView {...props({ onAmountChange, decimals: 2 })} />);
    const input = screen.getByTestId('deposit-amount-input');
    fireEvent.change(input, { target: { value: '1,5' } });
    expect(onAmountChange).toHaveBeenLastCalledWith('1.5');
    fireEvent.change(input, { target: { value: '007' } });
    expect(onAmountChange).toHaveBeenLastCalledWith('7');
    onAmountChange.mockClear();
    fireEvent.change(input, { target: { value: '1.234' } });
    fireEvent.change(input, { target: { value: '12a' } });
    expect(onAmountChange).not.toHaveBeenCalled();
  });

  it('opens the token sheet and, with more than one route, the route sheet', () => {
    const onSelectToken = jest.fn();
    const onChangeRoute = jest.fn();
    render(<DepositAmountView {...props({ onSelectToken, onChangeRoute, routeCount: 2 })} />);
    const selector = screen.getByTestId('deposit-token-selector');
    expect(selector).toHaveAttribute(
      'aria-label',
      'depositFlowTokenOnNetworkChange {"token":"USDC","network":"Ethereum"}'
    );
    expect(screen.getByTestId('network-ethereum')).toBeInTheDocument();
    fireEvent.click(selector);
    expect(onSelectToken).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('deposit-route-change'));
    expect(onChangeRoute).toHaveBeenCalledTimes(1);
    expect(hapticLight).toHaveBeenCalledTimes(2);
  });

  it('reviews a valid amount', () => {
    const onReview = jest.fn();
    render(<DepositAmountView {...props({ amount: '5', isValidAmount: true, onReview })} />);
    fireEvent.click(screen.getByTestId('deposit-amount-review'));
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it('shows the cap notice with the cap and the caller notice', () => {
    render(<DepositAmountView {...props({ depositCapUsd: 1232, notice: <p data-testid="other-notice">other</p> })} />);
    expect(screen.getByTestId('deposit-cap-notice')).toHaveTextContent('depositFlowOverCapTitle');
    expect(screen.getByTestId('deposit-cap-notice')).toHaveTextContent('depositFlowOverCapBody {"cap":"$1,232"}');
    expect(screen.getByTestId('other-notice')).toBeInTheDocument();
  });

  it('takes the extension sizes', () => {
    render(<DepositAmountView {...props({ layout: 'extension' })} />);
    expect(screen.getByTestId('deposit-amount-input')).toHaveClass('text-[48px]');
    expect(screen.getByTestId('deposit-receipt')).toHaveClass('mt-3.5');
  });

  it('drops the minus sign of a fee that comes on top of the amount', () => {
    const fee = { kind: 'amount', value: { amount: '0.21' } } satisfies DepositAmountViewProps['bridgeFee'];
    const { rerender } = render(<DepositAmountView {...props({ bridgeFee: fee })} />);
    expect(screen.getByTestId('deposit-receipt-fee')).toHaveTextContent('− 0.21 USDC');
    rerender(<DepositAmountView {...props({ bridgeFee: fee, bridgeFeeDeducted: false })} />);
    expect(screen.getByTestId('deposit-receipt-fee')).toHaveTextContent(/^depositFlowBridgeFee0\.21 USDC$/);
  });

  it('reports the cap notices with the cap error ids', () => {
    jest.useFakeTimers();
    const { rerender } = render(<DepositAmountView {...props({ depositCapUsd: 1232 })} />);
    jest.advanceTimersByTime(1000);
    expect(reportUserVisibleError).toHaveBeenLastCalledWith('bridgeDepositBalanceCapExceeded', 'notice');

    rerender(<DepositAmountView {...props({ depositCapUnpriced: 'No price for USDC' })} />);
    expect(screen.queryByTestId('deposit-cap-notice')).not.toBeInTheDocument();
    expect(screen.getByTestId('deposit-cap-unpriced')).toHaveTextContent('No price for USDC');
    jest.advanceTimersByTime(1000);
    expect(reportUserVisibleError).toHaveBeenLastCalledWith('bridgeDepositBalanceCapUnpriced', 'notice');
    jest.useRealTimers();
  });
});

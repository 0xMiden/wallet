import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { SwapAmounts, SwapAmountsProps } from './SwapAmounts';

// --- i18n: echo the key back so we can assert against raw translation keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// --- Haptics: the swap-direction toggle fires hapticLight before onSwapDirection.
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// --- framer-motion: render `motion.button` as a plain <button> that forwards
//     onClick + DOM props and strips the framer-only `whileTap` prop (which
//     jsdom would otherwise warn about as an unknown DOM attribute).
jest.mock('framer-motion', () => ({
  motion: {
    button: React.forwardRef(({ children, whileTap, ...props }: any, ref: any) => (
      <button ref={ref} {...props}>
        {children}
      </button>
    ))
  }
}));

// --- Button: forward the props SwapAmounts sets so we can drive/assert the CTA.
jest.mock('components/Button', () => ({
  Button: ({
    title,
    onClick,
    disabled,
    variant,
    'data-testid': dataTestId
  }: {
    title?: string;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
    'data-testid'?: string;
  }) => (
    <button data-testid={dataTestId} data-variant={variant} onClick={onClick} disabled={disabled}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' }
}));

// --- SelectAmount: capture every prop SwapAmounts wires in. The two instances
//     are distinguished by their (echoed) label — 'youPay' / 'youReceive'. The
//     mapped UIToken is serialized to `data-token` so we can assert the
//     swapTokenToUIToken transformation, and two buttons surface the
//     onAmountChange / onSelectToken callbacks.
jest.mock('../send-flow/SelectAmount', () => ({
  SelectAmount: (props: any) => {
    const key = props.label as string;
    return (
      <div
        data-testid={`select-amount-${key}`}
        data-embedded={String(props.embedded)}
        data-amount={props.amount}
        data-valid={String(props.isValidAmount)}
        data-error={props.error}
        data-logo={props.logoSymbol}
        data-token={JSON.stringify(props.token)}
      >
        <button data-testid={`sa-change-${key}`} onClick={() => props.onAmountChange('changed')} />
        <button data-testid={`sa-select-${key}`} onClick={() => props.onSelectToken()} />
      </div>
    );
  }
}));

type SwapToken = SwapAmountsProps['offerToken'];

const offerToken: SwapToken = {
  symbol: 'IMIDEN',
  faucetId: 'faucet-offer',
  decimals: 8,
  logoSymbol: 'MIDEN'
};

const requestToken: SwapToken = {
  symbol: 'IETH',
  faucetId: 'faucet-req',
  decimals: 8,
  logoSymbol: 'ETH'
};

const renderComponent = (props: Partial<SwapAmountsProps> = {}) => {
  const defaults: SwapAmountsProps = {
    offerToken,
    offerBalance: 100,
    offerAmount: '10',
    onOfferAmountChange: jest.fn(),
    onSelectOfferToken: jest.fn(),
    requestToken,
    requestAmount: '5',
    onRequestAmountChange: jest.fn(),
    onSelectRequestToken: jest.fn(),
    onSwapDirection: jest.fn(),
    onConfirm: jest.fn(),
    canProceed: true,
    statusMessage: undefined,
    statusIsError: false
  };
  return render(<SwapAmounts {...defaults} {...props} />);
};

const parseToken = (el: HTMLElement) => JSON.parse(el.getAttribute('data-token') as string);

describe('SwapAmounts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('layout & token mapping', () => {
    it('renders both stacked SelectAmount fields (You Pay / You Receive), embedded', () => {
      renderComponent();

      const pay = screen.getByTestId('select-amount-youPay');
      const receive = screen.getByTestId('select-amount-youReceive');

      expect(pay).toBeInTheDocument();
      expect(receive).toBeInTheDocument();
      expect(pay).toHaveAttribute('data-embedded', 'true');
      expect(receive).toHaveAttribute('data-embedded', 'true');

      // Amounts are forwarded verbatim.
      expect(pay).toHaveAttribute('data-amount', '10');
      expect(receive).toHaveAttribute('data-amount', '5');

      // logoSymbol overrides come straight from the SwapToken.
      expect(pay).toHaveAttribute('data-logo', 'MIDEN');
      expect(receive).toHaveAttribute('data-logo', 'ETH');
    });

    it('maps the offer SwapToken to a UIToken carrying the offer balance', () => {
      renderComponent({ offerBalance: 42 });
      expect(parseToken(screen.getByTestId('select-amount-youPay'))).toEqual({
        id: 'faucet-offer',
        name: 'IMIDEN',
        decimals: 8,
        balance: 42,
        fiatPrice: 0
      });
    });

    it('maps the request SwapToken to a UIToken with the default zero balance', () => {
      renderComponent();
      expect(parseToken(screen.getByTestId('select-amount-youReceive'))).toEqual({
        id: 'faucet-req',
        name: 'IETH',
        decimals: 8,
        balance: 0,
        fiatPrice: 0
      });
    });
  });

  describe('offer amount validation', () => {
    it('is valid with no error when the amount is positive and within balance', () => {
      renderComponent({ offerAmount: '10', offerBalance: 100 });
      const pay = screen.getByTestId('select-amount-youPay');
      expect(pay).toHaveAttribute('data-valid', 'true');
      expect(pay).not.toHaveAttribute('data-error');
    });

    it('is invalid with a balance error when the amount exceeds the balance', () => {
      renderComponent({ offerAmount: '150', offerBalance: 100 });
      const pay = screen.getByTestId('select-amount-youPay');
      expect(pay).toHaveAttribute('data-valid', 'false');
      expect(pay).toHaveAttribute('data-error', 'amountMustBeLessThanBalance');
    });

    it('is invalid with no error when the amount is zero (fails the > 0 check first)', () => {
      renderComponent({ offerAmount: '0', offerBalance: 100 });
      const pay = screen.getByTestId('select-amount-youPay');
      expect(pay).toHaveAttribute('data-valid', 'false');
      expect(pay).not.toHaveAttribute('data-error');
    });

    it('treats an amount exactly equal to the balance as valid (not exceeding)', () => {
      renderComponent({ offerAmount: '100', offerBalance: 100 });
      const pay = screen.getByTestId('select-amount-youPay');
      expect(pay).toHaveAttribute('data-valid', 'true');
      expect(pay).not.toHaveAttribute('data-error');
    });
  });

  describe('request amount validation', () => {
    it('is valid when the request amount is positive', () => {
      renderComponent({ requestAmount: '3' });
      expect(screen.getByTestId('select-amount-youReceive')).toHaveAttribute('data-valid', 'true');
    });

    it('is invalid when the request amount is zero/empty', () => {
      renderComponent({ requestAmount: '0' });
      expect(screen.getByTestId('select-amount-youReceive')).toHaveAttribute('data-valid', 'false');
    });
  });

  describe('field callbacks', () => {
    it('wires the offer field onAmountChange / onSelectToken to the offer handlers', () => {
      const onOfferAmountChange = jest.fn();
      const onSelectOfferToken = jest.fn();
      renderComponent({ onOfferAmountChange, onSelectOfferToken });

      fireEvent.click(screen.getByTestId('sa-change-youPay'));
      expect(onOfferAmountChange).toHaveBeenCalledWith('changed');

      fireEvent.click(screen.getByTestId('sa-select-youPay'));
      expect(onSelectOfferToken).toHaveBeenCalledTimes(1);
    });

    it('wires the request field onAmountChange / onSelectToken to the request handlers', () => {
      const onRequestAmountChange = jest.fn();
      const onSelectRequestToken = jest.fn();
      renderComponent({ onRequestAmountChange, onSelectRequestToken });

      fireEvent.click(screen.getByTestId('sa-change-youReceive'));
      expect(onRequestAmountChange).toHaveBeenCalledWith('changed');

      fireEvent.click(screen.getByTestId('sa-select-youReceive'));
      expect(onSelectRequestToken).toHaveBeenCalledTimes(1);
    });
  });

  describe('swap-direction toggle', () => {
    it('fires haptic feedback then onSwapDirection when tapped', () => {
      const onSwapDirection = jest.fn();
      renderComponent({ onSwapDirection });

      fireEvent.click(screen.getByLabelText('swapDirection'));

      expect(hapticLight).toHaveBeenCalledTimes(1);
      expect(onSwapDirection).toHaveBeenCalledTimes(1);
    });
  });

  describe('confirm CTA', () => {
    it('renders the review button enabled and calls onConfirm when clicked', () => {
      const onConfirm = jest.fn();
      renderComponent({ onConfirm, canProceed: true });

      const cta = screen.getByTestId('swap-review-submit');
      expect(cta).toHaveTextContent('reviewSwap');
      expect(cta).toHaveAttribute('data-variant', 'primary');
      expect(cta).not.toBeDisabled();

      fireEvent.click(cta);
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('disables the review button when canProceed is false', () => {
      renderComponent({ canProceed: false });
      expect(screen.getByTestId('swap-review-submit')).toBeDisabled();
    });
  });

  describe('status message', () => {
    it('renders nothing when no status message is provided', () => {
      renderComponent({ statusMessage: undefined });
      expect(screen.queryByText('fetching price')).not.toBeInTheDocument();
    });

    it('renders a neutral status message when statusIsError is false', () => {
      renderComponent({ statusMessage: 'fetching price', statusIsError: false });
      const msg = screen.getByText('fetching price');
      expect(msg).toBeInTheDocument();
      expect(msg).toHaveClass('text-[#808080]');
      expect(msg).not.toHaveClass('text-status-negative');
    });

    it('renders an error-styled status message when statusIsError is true', () => {
      renderComponent({ statusMessage: 'pair unavailable', statusIsError: true });
      const msg = screen.getByText('pair unavailable');
      expect(msg).toBeInTheDocument();
      expect(msg).toHaveClass('text-status-negative');
      expect(msg).not.toHaveClass('text-[#808080]');
    });
  });
});

describe('SwapAmounts — navbar cushion (regression)', () => {
  it('tags the CTA footer so it snugs to the bottom when the navbar hides (keyboard up)', () => {
    renderComponent();
    const footer = screen.getByTestId('swap-review-submit').parentElement;
    expect(footer?.getAttribute('data-navbar-cushion')).toBe('true');
  });
});

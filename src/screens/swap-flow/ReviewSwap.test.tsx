import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { SwapEta } from 'lib/miden/swap/tokens';

import { ReviewSwap, ReviewSwapProps } from './ReviewSwap';

// react-i18next: echo the key back, and fold interpolation options into the
// returned string so we can assert that `swapSolverFeeNote`'s `{percent}` was
// computed from SOLVER_MARGIN (mirrors sibling atom/screen tests that mock
// `useTranslation` with `t: (key) => key`).
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const values = opts ? Object.values(opts) : [];
      return values.length > 0 ? `${key}_${values.join('_')}` : key;
    }
  })
}));

// Pin SOLVER_MARGIN so the disclosed fee percent is deterministic (0.05 -> 5%).
// The `SwapToken` type import in the source is erased at compile time, so the
// mock only needs to supply the runtime `SOLVER_MARGIN` value.
jest.mock('lib/miden/swap/tokens', () => ({
  SOLVER_MARGIN: 0.05
}));

// The real ReviewLayout transitively pulls in `components/Button` (framer-motion +
// Capacitor haptics) and the navbar hook. Stub those with light DOM so the test stays
// focused on ReviewSwap's own branches (matches how the sibling SelectRecipient test
// stubs `components/Button`); Hero/Pill/DetailCard/DetailRow are the canonical design-system
// primitives and render for real, same as ReviewTransaction's and TransactionSuccessLayout's
// suites.
jest.mock('lib/mobile/useHideNavbarWhileOpen', () => ({
  useHideNavbarWhileOpen: jest.fn()
}));

jest.mock('components/Button', () => {
  const R = require('react');
  return {
    __esModule: true,
    ButtonVariant: { Primary: 'primary', Secondary: 'secondary' },
    Button: ({ title, onClick, type, accent, 'data-testid': dataTestId }: any) =>
      R.createElement('button', { type, onClick, 'data-accent': accent, 'data-testid': dataTestId }, title)
  };
});

// Stub the token logo: a real Avatar/TokenLogo pulls in image-fallback and network-badge
// machinery unrelated to this screen's own branches.
jest.mock('components/TokenLogo', () => {
  const R = require('react');
  return {
    TokenLogo: ({ symbol, size }: any) =>
      R.createElement('div', { 'data-testid': 'token-logo', 'data-symbol': symbol, 'data-size': size })
  };
});

/** A `SwapEta` carrying just the oracle rate; fill signals default to "no data". */
const etaWithRate = (marketPrice: string): SwapEta => ({
  canFill: false,
  estimatedSeconds: null,
  offMarket: false,
  marketPrice,
  median24hSeconds: null
});

jest.mock('components/Toggle', () => ({
  Toggle: ({ value, onChangeValue, ...props }: any) =>
    React.createElement('button', {
      ...props,
      'data-value': String(value),
      onClick: () => onChangeValue?.(!value)
    })
}));

const OFFER_TOKEN = { symbol: 'IMIDEN', faucetId: 'f-offer', decimals: 8, logoSymbol: 'MIDEN' };
const REQUEST_TOKEN = { symbol: 'IETH', faucetId: 'f-request', decimals: 8, logoSymbol: 'ETH' };

const renderComponent = (overrides: Partial<ReviewSwapProps> = {}) => {
  const props: ReviewSwapProps = {
    offerToken: OFFER_TOKEN,
    offerAmount: '1.5',
    requestToken: REQUEST_TOKEN,
    requestAmount: '3',
    swapEta: undefined,
    expirySeconds: '120',
    autoConsume: true,
    onExpirySecondsChange: jest.fn(),
    onAutoConsumeChange: jest.fn(),
    submitError: null,
    onGoBack: jest.fn(),
    onSubmit: jest.fn(),
    ...overrides
  };
  const utils = render(<ReviewSwap {...props} />);
  return { props, ...utils };
};

describe('ReviewSwap', () => {
  describe('hero', () => {
    it('renders both You Send / You Receive amounts as Hero values, with the offer/request logos', () => {
      renderComponent();

      const logos = screen.getAllByTestId('token-logo');
      expect(logos).toHaveLength(2);
      expect(logos[0]).toHaveAttribute('data-symbol', 'MIDEN');
      expect(logos[1]).toHaveAttribute('data-symbol', 'ETH');

      // Captions come from the translated keys, as neutral Pills beside each Hero.
      expect(screen.getByText('youSend')).toBeInTheDocument();
      expect(screen.getByText('youReceive')).toBeInTheDocument();

      // Amount strings composed from amount + symbol, rendered as the Hero value.
      expect(screen.getByText('1.5 IMIDEN')).toBeInTheDocument();
      expect(screen.getByText('3 IETH')).toBeInTheDocument();
    });

    it('renders the swap-arrows glyph (an svg) between the two amounts', () => {
      const { container } = renderComponent();
      expect(container.querySelector('svg')).not.toBeNull();
    });

    it('owns its own dividers, so ReviewLayout adds neither the orange hero bar nor an outer row-list divide-y', () => {
      const { container } = renderComponent();
      // heroDivider={false}: the swap hero draws its own pair of horizontal rules around the
      // arrow glyph instead of the orange bar the layout can render under the hero.
      expect(container.querySelector('.bg-primary-500.h-2')).not.toBeInTheDocument();
      // dividers={false}: the rows' hairlines come from the DetailCard itself, so ReviewLayout's
      // outer children wrapper carries no divide-y.
      expect(container.querySelector('.divide-y.divide-rule-default')).not.toBeInTheDocument();
    });
  });

  describe('rate row', () => {
    const rateRow = () => screen.getByTestId('swap-rate-row');

    it('shows no rate value and no solver-fee note when there is no quote', () => {
      renderComponent({ swapEta: undefined });

      expect(rateRow()).toHaveTextContent('rate');
      expect(screen.queryByText(/swapSolverFeeNote/)).not.toBeInTheDocument();
    });

    it('shows no rate when the market price is zero (falsy)', () => {
      renderComponent({ swapEta: etaWithRate('0') });
      expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
      expect(screen.queryByText(/swapSolverFeeNote/)).not.toBeInTheDocument();
    });

    it('shows no rate when the market price is not a number', () => {
      renderComponent({ swapEta: etaWithRate('not-a-number') });
      expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
      expect(screen.queryByText(/swapSolverFeeNote/)).not.toBeInTheDocument();
    });

    it('shows no rate when the market price is non-finite', () => {
      renderComponent({ swapEta: etaWithRate('Infinity') });
      expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
      expect(screen.queryByText(/swapSolverFeeNote/)).not.toBeInTheDocument();
    });

    it('renders a whole-number rate and the solver-fee note when the market price is valid', () => {
      renderComponent({ swapEta: etaWithRate('2') });

      expect(rateRow()).toHaveTextContent('1 IMIDEN ≈ 2 IETH');
      // Percent is Math.round(0.05 * 100) = 5.
      expect(screen.getByText('swapSolverFeeNote_5%')).toBeInTheDocument();
    });

    it('renders a fractional rate rounded to 4 significant figures', () => {
      renderComponent({ swapEta: etaWithRate('0.333333333') });
      expect(rateRow()).toHaveTextContent('1 IMIDEN ≈ 0.3333 IETH');
      expect(screen.getByText('swapSolverFeeNote_5%')).toBeInTheDocument();
    });
  });

  describe('usually-fills-in row', () => {
    const fillsInRow = () => screen.getByTestId('swap-fills-in-row');

    it('falls back to the static estimate when both live signals are absent', () => {
      renderComponent({ swapEta: undefined });
      expect(fillsInRow()).toHaveTextContent('swapEtaFallback');
    });

    it('prefers the next-batch ETA in seconds when the order can fill', () => {
      renderComponent({ swapEta: { ...etaWithRate('2'), canFill: true, estimatedSeconds: 12 } });
      expect(fillsInRow()).toHaveTextContent('swapEtaSeconds_12');
    });

    it('renders minutes once the estimate reaches 90s', () => {
      renderComponent({ swapEta: { ...etaWithRate('2'), canFill: true, estimatedSeconds: 150 } });
      expect(fillsInRow()).toHaveTextContent('swapEtaMinutes_3');
    });

    it('falls back to the 24h median when the order cannot fill right now', () => {
      renderComponent({ swapEta: { ...etaWithRate('2'), estimatedSeconds: 12, median24hSeconds: 45 } });
      expect(fillsInRow()).toHaveTextContent('swapEtaSeconds_45');
    });
  });

  describe('settlement controls', () => {
    it('renders the expiry in seconds and auto-consume enabled by default', () => {
      renderComponent();
      const expiry = screen.getByTestId('swap-expiry-seconds');
      const toggle = screen.getByTestId('swap-auto-consume');
      expect(expiry).toHaveValue(120);
      expect(expiry).toHaveClass('[appearance:textfield]');
      expect(toggle).toHaveAttribute('data-value', 'true');
      expect(toggle).toHaveClass('!h-8', '!w-16');
      expect(screen.getByText('expires')).toBeInTheDocument();
      expect(screen.getByText('swapAutoConsume')).toBeInTheDocument();
    });

    it('forwards expiry edits and auto-consume toggles', () => {
      const { props } = renderComponent();
      fireEvent.change(screen.getByTestId('swap-expiry-seconds'), { target: { value: '300' } });
      fireEvent.click(screen.getByTestId('swap-auto-consume'));
      expect(props.onExpirySecondsChange).toHaveBeenCalledWith('300');
      expect(props.onAutoConsumeChange).toHaveBeenCalledWith(false);
    });
  });

  describe('submit error', () => {
    it('does not render an error paragraph when submitError is null', () => {
      renderComponent({ submitError: null });
      expect(screen.queryByText('boom')).not.toBeInTheDocument();
    });

    it('does not render an error paragraph when submitError is an empty string (falsy)', () => {
      const { container } = renderComponent({ submitError: '' });
      expect(container.querySelector('.text-status-negative')).toBeNull();
    });

    it('renders the error paragraph when submitError is set', () => {
      renderComponent({ submitError: 'boom' });
      const err = screen.getByText('boom');
      expect(err).toBeInTheDocument();
      expect(err).toHaveClass('text-status-negative');
    });
  });

  describe('actions', () => {
    it('wires the primary CTA (swap-submit) to onSubmit', () => {
      const { props } = renderComponent();
      fireEvent.click(screen.getByTestId('swap-submit'));
      expect(props.onSubmit).toHaveBeenCalledTimes(1);
      expect(props.onGoBack).not.toHaveBeenCalled();
    });

    it('wires the secondary CTA to onGoBack', () => {
      const { props } = renderComponent();
      fireEvent.click(screen.getByText('back'));
      expect(props.onGoBack).toHaveBeenCalledTimes(1);
      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it('gives the primary CTA the swap flow colour', () => {
      renderComponent();
      expect(screen.getByTestId('swap-submit')).toHaveAttribute('data-accent', 'swap');
    });

    it('labels the primary CTA "swap" and the secondary CTA "back"', () => {
      renderComponent();
      expect(screen.getByTestId('swap-submit')).toHaveTextContent('swap');
      expect(screen.getByText('back')).toBeInTheDocument();
    });
  });
});

import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { ReviewSwap, ReviewSwapProps } from './ReviewSwap';

// react-i18next: echo the key back, and fold interpolation options into the
// returned string so we can assert that `swapSolverFeeNote`'s `{percent}` was
// computed from SOLVER_MARGIN (mirrors sibling atom/screen tests that mock
// `useTranslation` with `t: (key) => key`).
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && 'percent' in opts ? `${key}_${opts.percent as string}` : key
  })
}));

// Pin SOLVER_MARGIN so the disclosed fee percent is deterministic (0.05 -> 5%).
// The `SwapToken` type import in the source is erased at compile time, so the
// mock only needs to supply the runtime `SOLVER_MARGIN` value.
jest.mock('lib/miden/swap/tokens', () => ({
  SOLVER_MARGIN: 0.05
}));

// The real review components transitively pull in `components/Button`
// (framer-motion + Capacitor haptics), `TokenLogo` and the navbar hook. Stub
// them with light DOM so the test stays focused on ReviewSwap's own branches
// (matches how the sibling SelectRecipient test stubs `components/Button`).
jest.mock('components/review', () => {
  const R = require('react');
  return {
    __esModule: true,
    ReviewAmount: ({ label, symbol, logoSymbol, amount }: any) =>
      R.createElement(
        'div',
        { 'data-testid': 'review-amount', 'data-symbol': symbol, 'data-logo': logoSymbol ?? '' },
        R.createElement('span', { 'data-testid': 'ra-label' }, label),
        R.createElement('span', { 'data-testid': 'ra-amount' }, `${amount} ${symbol}`)
      ),
    ReviewRow: ({ label, value }: any) =>
      R.createElement(
        'div',
        { 'data-testid': 'review-row', 'data-label': label },
        R.createElement('span', { 'data-testid': 'rr-value' }, value ?? '')
      ),
    ReviewLayout: ({ hero, heroDivider, dividers, primary, secondary, children }: any) =>
      R.createElement(
        'div',
        {
          'data-testid': 'review-layout',
          'data-herodivider': String(heroDivider),
          'data-dividers': String(dividers)
        },
        R.createElement('div', { 'data-testid': 'hero' }, hero),
        R.createElement('div', { 'data-testid': 'rows' }, children),
        R.createElement('button', { 'data-testid': primary['data-testid'], onClick: primary.onPress }, primary.label),
        secondary &&
          R.createElement('button', { 'data-testid': 'secondary', onClick: secondary.onPress }, secondary.label)
      )
  };
});

const OFFER_TOKEN = { symbol: 'IMIDEN', faucetId: 'f-offer', decimals: 8, logoSymbol: 'MIDEN' };
const REQUEST_TOKEN = { symbol: 'IETH', faucetId: 'f-request', decimals: 8, logoSymbol: 'ETH' };

const renderComponent = (overrides: Partial<ReviewSwapProps> = {}) => {
  const props: ReviewSwapProps = {
    offerToken: OFFER_TOKEN,
    offerAmount: '1.5',
    requestToken: REQUEST_TOKEN,
    requestAmount: '3',
    offerPrice: undefined,
    requestPrice: undefined,
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
    it('renders both You Send / You Receive amount blocks with symbol + logoSymbol', () => {
      renderComponent();

      const amounts = screen.getAllByTestId('review-amount');
      expect(amounts).toHaveLength(2);

      // Send block (first) reflects the offer token.
      expect(amounts[0]).toHaveAttribute('data-symbol', 'IMIDEN');
      expect(amounts[0]).toHaveAttribute('data-logo', 'MIDEN');
      // Receive block (second) reflects the request token.
      expect(amounts[1]).toHaveAttribute('data-symbol', 'IETH');
      expect(amounts[1]).toHaveAttribute('data-logo', 'ETH');

      // Labels come from the translated keys.
      expect(screen.getByText('youSend')).toBeInTheDocument();
      expect(screen.getByText('youReceive')).toBeInTheDocument();

      // Amount strings composed from amount + symbol.
      expect(screen.getByText('1.5 IMIDEN')).toBeInTheDocument();
      expect(screen.getByText('3 IETH')).toBeInTheDocument();
    });

    it('renders the swap-arrows glyph (an svg) between the two amounts', () => {
      const { container } = renderComponent();
      expect(container.querySelector('svg')).not.toBeNull();
    });

    it('passes heroDivider=false and dividers=false to the layout (swap owns its own dividers)', () => {
      renderComponent();
      const layout = screen.getByTestId('review-layout');
      expect(layout).toHaveAttribute('data-herodivider', 'false');
      expect(layout).toHaveAttribute('data-dividers', 'false');
    });
  });

  describe('rate row', () => {
    it('shows no rate value and no solver-fee note when both prices are missing', () => {
      renderComponent({ offerPrice: undefined, requestPrice: undefined });

      const row = screen.getByTestId('review-row');
      expect(row).toHaveAttribute('data-label', 'rate');
      expect(screen.getByTestId('rr-value')).toHaveTextContent('');
      expect(screen.queryByText(/swapSolverFeeNote/)).not.toBeInTheDocument();
    });

    it('shows no rate when only the offer price is present (request price missing)', () => {
      renderComponent({ offerPrice: 2, requestPrice: undefined });
      expect(screen.getByTestId('rr-value')).toHaveTextContent('');
      expect(screen.queryByText(/swapSolverFeeNote/)).not.toBeInTheDocument();
    });

    it('shows no rate when the offer price is zero (falsy)', () => {
      renderComponent({ offerPrice: 0, requestPrice: 1 });
      expect(screen.getByTestId('rr-value')).toHaveTextContent('');
      expect(screen.queryByText(/swapSolverFeeNote/)).not.toBeInTheDocument();
    });

    it('shows no rate when the computed ratio is non-finite (Infinity / Infinity = NaN)', () => {
      renderComponent({ offerPrice: Number.POSITIVE_INFINITY, requestPrice: Number.POSITIVE_INFINITY });
      expect(screen.getByTestId('rr-value')).toHaveTextContent('');
      expect(screen.queryByText(/swapSolverFeeNote/)).not.toBeInTheDocument();
    });

    it('shows no rate when the computed ratio is <= 0 (negative offer price)', () => {
      renderComponent({ offerPrice: -2, requestPrice: 1 });
      expect(screen.getByTestId('rr-value')).toHaveTextContent('');
      expect(screen.queryByText(/swapSolverFeeNote/)).not.toBeInTheDocument();
    });

    it('renders a whole-number rate and the solver-fee note when both prices are valid', () => {
      renderComponent({ offerPrice: 2, requestPrice: 1 });

      expect(screen.getByTestId('rr-value')).toHaveTextContent('1 IMIDEN ≈ 2 IETH');
      // Percent is Math.round(0.05 * 100) = 5.
      expect(screen.getByText('swapSolverFeeNote_5%')).toBeInTheDocument();
    });

    it('colours the solver-fee note with a theme token that flips in dark mode, not a hardcoded light hex', () => {
      renderComponent({ offerPrice: 2, requestPrice: 1 });

      // The note sits on the dark app background in dark mode, so its colour must
      // come from a token that flips. `text-heading-gray` (--color-text-secondary)
      // is #484848 in light (9.15:1 on white) and #ffffff in dark — both clear AA.
      const note = screen.getByText('swapSolverFeeNote_5%');
      expect(note.className).toContain('text-heading-gray');
      expect(note.className).not.toContain('text-[#6B6862]');
    });

    it('renders a fractional rate rounded to 4 significant figures', () => {
      renderComponent({ offerPrice: 1, requestPrice: 3 });
      // 1/3 -> toPrecision(4) = "0.3333" -> Number -> "0.3333".
      expect(screen.getByTestId('rr-value')).toHaveTextContent('1 IMIDEN ≈ 0.3333 IETH');
      expect(screen.getByText('swapSolverFeeNote_5%')).toBeInTheDocument();
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
      fireEvent.click(screen.getByTestId('secondary'));
      expect(props.onGoBack).toHaveBeenCalledTimes(1);
      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it('labels the primary CTA "swap" and the secondary CTA "back"', () => {
      renderComponent();
      expect(screen.getByTestId('swap-submit')).toHaveTextContent('swap');
      expect(screen.getByTestId('secondary')).toHaveTextContent('back');
    });
  });
});

import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

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

// The fee estimate needs a discovered base fee and a balance; pin it so the Max-network-fee
// row (and its hint) actually render here.
jest.mock('app/hooks/useNetworkFeeEstimate', () => ({
  useNetworkFeeEstimate: () => '0.02 MIDEN'
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

    it('shows no rate value and offers no solver-fee hint when there is no quote', () => {
      renderComponent({ swapEta: undefined });

      expect(rateRow()).toHaveTextContent('rate');
      expect(screen.queryByTestId('swap-rate-info')).not.toBeInTheDocument();
      expect(screen.queryByText(/swapSolverFeeNote/)).not.toBeInTheDocument();
    });

    it('shows no rate when the market price is zero (falsy)', () => {
      renderComponent({ swapEta: etaWithRate('0') });
      expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
      expect(screen.queryByTestId('swap-rate-info')).not.toBeInTheDocument();
    });

    it('shows no rate when the market price is not a number', () => {
      renderComponent({ swapEta: etaWithRate('not-a-number') });
      expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
      expect(screen.queryByTestId('swap-rate-info')).not.toBeInTheDocument();
    });

    it('shows no rate when the market price is non-finite', () => {
      renderComponent({ swapEta: etaWithRate('Infinity') });
      expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
      expect(screen.queryByTestId('swap-rate-info')).not.toBeInTheDocument();
    });

    it('renders a whole-number rate when the market price is valid', () => {
      renderComponent({ swapEta: etaWithRate('2') });

      expect(rateRow()).toHaveTextContent('1 IMIDEN ≈ 2 IETH');
    });

    it('renders a fractional rate rounded to 4 significant figures', () => {
      renderComponent({ swapEta: etaWithRate('0.333333333') });
      expect(rateRow()).toHaveTextContent('1 IMIDEN ≈ 0.3333 IETH');
    });

    it('lands a five-figure rate on its four significant figures', () => {
      renderComponent({ swapEta: etaWithRate('12345.678') });
      expect(rateRow()).toHaveTextContent('1 IMIDEN ≈ 12350 IETH');
    });

    describe('while the rate travels', () => {
      beforeEach(() => {
        Object.defineProperty(window, 'matchMedia', {
          configurable: true,
          writable: true,
          value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
        });
      });

      afterEach(() => {
        Reflect.deleteProperty(window, 'matchMedia');
      });

      /** Every text the rate figure shows while it travels from `from` to `to`. */
      const travel = async (from: string, to: string) => {
        const { rerender, props } = renderComponent({ swapEta: etaWithRate(from) });
        const node = rateRow().querySelector('.tabular-nums') as HTMLElement;
        const frames: string[] = [];
        const observer = new MutationObserver(() => frames.push(node.textContent ?? ''));
        observer.observe(node, { characterData: true, childList: true, subtree: true });

        rerender(<ReviewSwap {...props} swapEta={etaWithRate(to)} />);
        frames.push(node.textContent ?? '');
        await act(() => new Promise(resolve => setTimeout(resolve, 800)));
        observer.disconnect();
        frames.push(node.textContent ?? '');
        return frames;
      };

      it("keeps the destination's decimals on every frame of a plain rate", async () => {
        const frames = await travel('9.5', '12.4');

        const start = '1 IMIDEN ≈ 9.5 IETH';
        const end = '1 IMIDEN ≈ 12.4 IETH';
        expect(frames.some(frame => frame !== start && frame !== end)).toBe(true);
        expect(frames.filter(frame => !/^1 IMIDEN ≈ \d+\.\d IETH$/.test(frame))).toEqual([]);
        expect(frames[frames.length - 1]).toBe(end);
      });

      it("keeps the destination's mantissa digits on every frame of an exponential rate", async () => {
        const frames = await travel('2.5e-7', '3.1e-7');

        const start = '1 IMIDEN ≈ 2.5e-7 IETH';
        const end = '1 IMIDEN ≈ 3.1e-7 IETH';
        expect(frames.some(frame => frame !== start && frame !== end)).toBe(true);
        expect(frames.filter(frame => !/^1 IMIDEN ≈ \d\.\de-7 IETH$/.test(frame))).toEqual([]);
        expect(frames[frames.length - 1]).toBe(end);
      });
    });

    it('keeps the solver-fee sentence out of the layout until the (i) is tapped', () => {
      renderComponent({ swapEta: etaWithRate('2') });

      // Percent is Math.round(0.05 * 100) = 5.
      expect(screen.queryByText('swapSolverFeeNote_5%')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('swap-rate-info'));
      expect(screen.getByText('swapSolverFeeNote_5%')).toBeInTheDocument();
    });

    it('names the row the rate hint belongs to', () => {
      renderComponent({ swapEta: etaWithRate('2') });

      expect(screen.getByTestId('swap-rate-info')).toHaveAttribute('aria-label', 'moreInfoAbout_rate');
    });
  });

  describe('network fee row', () => {
    it('keeps the fee explanation behind its own (i)', () => {
      renderComponent();

      expect(screen.queryByText('networkFeeEstimateNote')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('swap-network-fee-info'));
      expect(screen.getByText('networkFeeEstimateNote')).toBeInTheDocument();
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
    const expiryInput = () => screen.getByTestId('swap-expiry-seconds');

    it('reopens the stored seconds in the coarsest unit that holds them', () => {
      renderComponent();

      // 120 stored seconds reads back as 2 Minutes, not 120 Seconds.
      expect(expiryInput()).toHaveValue(2);
      expect(screen.getByTestId('swap-expiry-unit-minutes')).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByText('expires')).toBeInTheDocument();
    });

    it('keeps seconds for a stored value no coarser unit divides', () => {
      renderComponent({ expirySeconds: '90' });

      expect(expiryInput()).toHaveValue(90);
      expect(screen.getByTestId('swap-expiry-unit-seconds')).toHaveAttribute('aria-checked', 'true');
    });

    it('renders auto-consume enabled by default', () => {
      renderComponent();
      const toggle = screen.getByTestId('swap-auto-consume');

      expect(expiryInput()).toHaveClass('[appearance:textfield]');
      expect(toggle).toHaveAttribute('data-value', 'true');
      expect(toggle).toHaveClass('!h-8', '!w-16');
      expect(screen.getByText('swapAutoConsume')).toBeInTheDocument();
    });

    it('forwards an edit as SECONDS, whatever unit is showing', () => {
      const { props } = renderComponent();

      fireEvent.change(expiryInput(), { target: { value: '5' } });

      expect(props.onExpirySecondsChange).toHaveBeenCalledWith('300');
    });

    it('re-expresses the same duration when the unit changes, and pushes the seconds up', () => {
      const { props } = renderComponent();

      fireEvent.click(screen.getByTestId('swap-expiry-unit-hours'));

      // 120s cannot be held in whole hours, so it clamps to this unit's floor.
      expect(expiryInput()).toHaveValue(1);
      expect(props.onExpirySecondsChange).toHaveBeenLastCalledWith('3600');
    });

    it('converts a round value across units without changing the duration', () => {
      const { props } = renderComponent({ expirySeconds: '7200' });

      expect(expiryInput()).toHaveValue(2);
      fireEvent.click(screen.getByTestId('swap-expiry-unit-minutes'));

      expect(expiryInput()).toHaveValue(120);
      expect(props.onExpirySecondsChange).toHaveBeenLastCalledWith('7200');
    });

    it('refuses a value under the unit floor, with the range named', () => {
      const { props } = renderComponent({ expirySeconds: '90' });

      fireEvent.change(expiryInput(), { target: { value: '5' } });

      expect(props.onExpirySecondsChange).not.toHaveBeenCalled();
      expect(expiryInput()).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('alert')).toHaveTextContent('swapExpiryRange_30_604800');
    });

    it('refuses a value over the unit ceiling', () => {
      const { props } = renderComponent();

      fireEvent.change(expiryInput(), { target: { value: '99999' } });

      expect(props.onExpirySecondsChange).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('swapExpiryRange_1_10080');
    });

    it('refuses an emptied field rather than submitting zero', () => {
      const { props } = renderComponent();

      fireEvent.change(expiryInput(), { target: { value: '' } });

      expect(props.onExpirySecondsChange).not.toHaveBeenCalled();
      expect(expiryInput()).toHaveAttribute('aria-invalid', 'true');
    });

    it('bounds the native input to the unit it is showing', () => {
      renderComponent();

      expect(expiryInput()).toHaveAttribute('min', '1');
      expect(expiryInput()).toHaveAttribute('max', '10080');
    });

    it('forwards auto-consume toggles', () => {
      const { props } = renderComponent();

      fireEvent.click(screen.getByTestId('swap-auto-consume'));

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

import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { SwapEta, SwapQuote } from 'lib/miden/swap/quote';
import { TEST_TOKEN_IETH } from 'lib/miden/swap/testing/registry';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { ReviewSwap, ReviewSwapProps } from './ReviewSwap';

// react-i18next: echo the key back, and fold interpolation options into the
// returned string so we can assert what `swapRateNote`'s slippage and fee were
// computed from (mirrors sibling atom/screen tests that mock
// `useTranslation` with `t: (key) => key`).
// The network banner now tops this screen, so the wallet names the chain on every surface that
// commits value. Its sheet and the effective-endpoint lookup are tested in their own suites;
// stubbing only those keeps the banner itself real here, so the assertion is not on a stub.
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => 'testnet'
}));
jest.mock('components/NetworkModeSheet', () => ({ NetworkModeSheet: () => null }));

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
  formatNetworkFeeEstimate: () => '0.02 MIDEN',
  useNetworkFeeEstimateDetails: () => undefined
}));

// The `SwapToken` type import in the source is erased at compile time; the labels read the
// registry's id normalizer only.
jest.mock('lib/miden/swap/tokens', () => ({
  tokenQuote: jest.requireActual('lib/miden/swap/tokens').tokenQuote,
  normalizedFaucetId: jest.requireActual('lib/miden/swap/tokens').normalizedFaucetId
}));

// The testnet document, whose swap tokens name the iETH faucet the labels read.
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => jest.requireActual('lib/epoch/testing/bridge-config').TEST_BRIDGE_CONFIG_SNAPSHOT
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
    Button: ({ title, onClick, type, accent, disabled, isLoading, 'data-testid': dataTestId }: any) =>
      R.createElement(
        'button',
        {
          type,
          onClick,
          disabled,
          'data-accent': accent,
          'data-loading': String(Boolean(isLoading)),
          'data-testid': dataTestId
        },
        title
      )
  };
});

// Stub the token logo: a real Avatar/TokenLogo pulls in image-fallback and network-badge
// machinery unrelated to this screen's own branches.
jest.mock('components/TokenLogo', () => {
  const R = require('react');
  return {
    TokenLogo: ({ faucetId, size }: { faucetId: string | undefined; size?: string }) =>
      R.createElement('div', { 'data-testid': 'token-logo', 'data-faucet-id': faucetId, 'data-size': size })
  };
});

/** A quote at a fill price, with the solver's usual pre-sign testnet verdict unless a test says otherwise. */
const quoteAtRate = (fillPrice: string, eta: Partial<SwapEta> = {}): SwapQuote => ({
  price: {
    offeredFaucet: 'f-offer',
    requestedFaucet: 'f-request',
    marketPrice: fillPrice,
    fillPrice,
    feePpm: 50,
    offeredDecimals: 8,
    requestedDecimals: 8,
    asOf: 0
  },
  // 1.5 IMIDEN for 3 IETH at 8 decimals: the amounts the fixture props show.
  offeredAmount: 150000000n,
  requestedAmount: 300000000n,
  builtAsk: true,
  slippageBps: 20,
  eta: {
    offeredFaucet: 'f-offer',
    requestedFaucet: 'f-request',
    offeredAmount: '150000000',
    requestedAmount: '300000000',
    priceBand: 'at_market',
    fillStatus: 'none',
    reason: 'liquidity',
    fillableOfferedAmount: '0',
    fillableRequestedAmount: '0',
    maxOfferedAmount: '0',
    expectedRequestedAmount: null,
    feePpm: 50,
    feeAmount: null,
    marketPrice: fillPrice,
    fillPrice,
    settlementsRunning: true,
    estimatedSeconds: null,
    median24hSeconds: null,
    ...eta
  },
  fetchedAt: 0
});

jest.mock('components/Toggle', () => ({
  Toggle: ({ value, onChangeValue, ...props }: any) =>
    React.createElement('button', {
      ...props,
      'data-value': String(value),
      onClick: () => onChangeValue?.(!value)
    })
}));

const OFFER_TOKEN = { symbol: 'IMIDEN', faucetId: 'f-offer', decimals: 8 };
const REQUEST_TOKEN = { symbol: 'IETH', faucetId: 'f-request', decimals: 8 };

const renderComponent = (overrides: Partial<ReviewSwapProps> = {}) => {
  const props: ReviewSwapProps = {
    offerToken: OFFER_TOKEN,
    offerAmount: '1.5',
    requestToken: REQUEST_TOKEN,
    requestAmount: '3',
    requestEdited: false,
    quote: undefined,
    expirySeconds: '120',
    slippageBps: 20,
    autoConsume: true,
    onExpirySecondsChange: jest.fn(),
    onSlippageBpsChange: jest.fn(),
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
      expect(logos[0]).toHaveAttribute('data-faucet-id', 'f-offer');
      expect(logos[1]).toHaveAttribute('data-faucet-id', 'f-request');

      // Captions come from the translated keys, as neutral Pills beside each Hero.
      expect(screen.getByText('youSend')).toBeInTheDocument();
      expect(screen.getByText('youReceive')).toBeInTheDocument();

      // Amount strings composed from amount + symbol, rendered as the Hero value.
      expect(screen.getByText('1.5 IMIDEN')).toBeInTheDocument();
      expect(screen.getByText('3 IETH')).toBeInTheDocument();
    });

    it('names the registry iETH "Test iETH" in the receive hero and the rate row, keeping the symbol for the logo (#477)', () => {
      renderComponent({
        requestToken: { ...REQUEST_TOKEN, faucetId: TEST_TOKEN_IETH.faucetId },
        quote: quoteAtRate('2')
      });

      expect(screen.getByText('3 Test iETH')).toBeInTheDocument();
      expect(screen.getByTestId('swap-rate-row')).toHaveTextContent('1 IMIDEN ≈ 2 Test iETH');
      expect(screen.getAllByTestId('token-logo')[1]).toHaveAttribute('data-faucet-id', TEST_TOKEN_IETH.faucetId);
    });

    it.each([
      ['receive', { requestToken: { ...REQUEST_TOKEN, faucetId: TEST_TOKEN_IETH.faucetId } }],
      ['send', { offerToken: { ...OFFER_TOKEN, faucetId: TEST_TOKEN_IETH.faucetId, symbol: 'IETH' } }]
    ])('puts one (i) on testnet iETH when it is the %s side (#477)', (_side, overrides) => {
      renderComponent(overrides);

      const buttons = screen.getAllByTestId('swap-token-info-button');
      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toHaveAttribute('aria-label', 'tokenInfoLabel_Test iETH');
    });

    it('puts no (i) on a pair without iETH', () => {
      renderComponent();

      expect(screen.queryByTestId('swap-token-info-button')).not.toBeInTheDocument();
    });

    it('renders the swap-arrows glyph (an svg) between the two amounts', () => {
      const { container } = renderComponent();
      expect(container.querySelector('svg')).not.toBeNull();
    });

    it('draws the swap-arrows glyph in the swap on-colour', () => {
      const { container } = renderComponent();
      const arrows = container.querySelector('.bg-accent-swap');
      expect(arrows).toHaveClass('text-accent-swap-on');
      expect(arrows).not.toHaveClass('text-pure-white');
    });

    it('owns its own dividers, so ReviewLayout adds neither the orange hero bar nor an outer row-list divide-y', () => {
      const { container } = renderComponent();
      // The swap hero draws its own pair of horizontal rules around the arrow glyph; the layout
      // adds no bar under it.
      expect(container.querySelector('.bg-primary-500.h-2')).not.toBeInTheDocument();
      // dividers={false}: the rows' hairlines come from the DetailCard itself, so ReviewLayout's
      // outer children wrapper carries no divide-y.
      expect(container.querySelector('.divide-y.divide-rule-default')).not.toBeInTheDocument();
    });
  });

  describe('rate row', () => {
    const rateRow = () => screen.getByTestId('swap-rate-row');

    it('shows no rate value and offers no solver-fee hint when there is no quote', () => {
      renderComponent({ quote: undefined });

      expect(rateRow()).toHaveTextContent('rate');
      expect(screen.queryByTestId('swap-rate-info')).not.toBeInTheDocument();
      expect(screen.queryByText(/swapSolverFeeNote/)).not.toBeInTheDocument();
    });

    it('shows no rate when the market price is zero (falsy)', () => {
      renderComponent({ quote: quoteAtRate('0') });
      expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
      expect(screen.queryByTestId('swap-rate-info')).not.toBeInTheDocument();
    });

    it('shows no rate when the market price is not a number', () => {
      renderComponent({ quote: quoteAtRate('not-a-number') });
      expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
      expect(screen.queryByTestId('swap-rate-info')).not.toBeInTheDocument();
    });

    it('shows no rate when the market price is non-finite', () => {
      renderComponent({ quote: quoteAtRate('Infinity') });
      expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
      expect(screen.queryByTestId('swap-rate-info')).not.toBeInTheDocument();
    });

    it('renders a whole-number rate when the market price is valid', () => {
      renderComponent({ quote: quoteAtRate('2') });

      expect(rateRow()).toHaveTextContent('1 IMIDEN ≈ 2 IETH');
    });

    it('renders a fractional rate rounded to 4 significant figures', () => {
      renderComponent({ quote: quoteAtRate('0.333333333') });
      expect(rateRow()).toHaveTextContent('1 IMIDEN ≈ 0.3333 IETH');
    });

    it('lands a five-figure rate on its four significant figures', () => {
      renderComponent({ quote: quoteAtRate('12345.678') });
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
        const { rerender, props } = renderComponent({ quote: quoteAtRate(from) });
        const node = rateRow().querySelector('.tabular-nums') as HTMLElement;
        const frames: string[] = [];
        const observer = new MutationObserver(() => frames.push(node.textContent ?? ''));
        observer.observe(node, { characterData: true, childList: true, subtree: true });

        rerender(<ReviewSwap {...props} quote={quoteAtRate(to)} />);
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

    it('keeps the slippage-and-fee sentence out of the layout until the (i) is tapped', () => {
      renderComponent({ quote: quoteAtRate('2') });

      // 20 bps of slippage and a 50 ppm fee.
      expect(screen.queryByText('swapRateNote_0.2%_0.005%')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('swap-rate-info'));
      expect(screen.getByText('swapRateNote_0.2%_0.005%')).toBeInTheDocument();
    });

    it('names the row the rate hint belongs to', () => {
      renderComponent({ quote: quoteAtRate('2') });

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
      renderComponent({ quote: undefined });
      expect(fillsInRow()).toHaveTextContent('swapEtaFallback');
    });

    it('prefers the next-batch ETA in seconds when the solver names one', () => {
      renderComponent({ quote: quoteAtRate('2', { fillStatus: 'full', reason: null, estimatedSeconds: 12 }) });
      expect(fillsInRow()).toHaveTextContent('swapEtaSeconds_12');
    });

    it('renders minutes once the estimate reaches 90s', () => {
      renderComponent({ quote: quoteAtRate('2', { fillStatus: 'full', reason: null, estimatedSeconds: 150 }) });
      expect(fillsInRow()).toHaveTextContent('swapEtaMinutes_3');
    });

    it('falls back to the 24h median when the order cannot fill right now', () => {
      renderComponent({ quote: quoteAtRate('2', { median24hSeconds: 45 }) });
      expect(fillsInRow()).toHaveTextContent('swapEtaSeconds_45');
    });
  });

  describe('fill row', () => {
    const verdictRow = () => screen.getByTestId('swap-verdict-row');

    it.each<SwapEta['fillStatus']>(['none', 'partial'])(
      'shows a warning above Swap for %s and still allows submission',
      fillStatus => {
        const onSubmit = jest.fn();
        renderComponent({ quote: quoteAtRate('2', { fillStatus }), onSubmit });
        const warning = screen.getByTestId('swap-fill-warning');
        const submit = screen.getByTestId('swap-submit');
        expect(warning).toHaveAttribute('role', 'status');
        expect(warning).toHaveTextContent(fillStatus === 'none' ? 'swapNoFillWarning' : 'swapPartialFillWarning');
        expect(warning.nextElementSibling).toContainElement(submit);
        expect(submit).toBeEnabled();
        fireEvent.click(submit);
        expect(onSubmit).toHaveBeenCalledTimes(1);
      }
    );

    it('shows the partial warning even when the price verdict is tolerated', () => {
      renderComponent({ quote: quoteAtRate('2', { fillStatus: 'partial', priceBand: 'tolerated' }) });
      expect(screen.getByTestId('swap-fill-warning')).toHaveTextContent('swapPartialFillWarning');
    });

    it('shows no fill warning for a full fill', () => {
      renderComponent({ quote: quoteAtRate('2', { fillStatus: 'full', reason: null }) });
      expect(screen.queryByTestId('swap-fill-warning')).not.toBeInTheDocument();
    });

    it('does not invite the user to continue when the price blocks submission', () => {
      renderComponent({ quote: quoteAtRate('2', { priceBand: 'off_market', reason: 'price' }) });
      expect(screen.queryByTestId('swap-fill-warning')).not.toBeInTheDocument();
    });

    it('renders no verdict without a quote', () => {
      renderComponent();
      expect(screen.queryByTestId('swap-verdict-row')).not.toBeInTheDocument();
      expect(screen.queryByTestId('swap-fill-warning')).not.toBeInTheDocument();
    });

    it('shows the testnet pre-sign answer as advisory, not as a refusal', () => {
      renderComponent({ quote: quoteAtRate('2') });
      expect(verdictRow()).toHaveTextContent('swapVerdictNoLiquidity');
      expect(verdictRow()).not.toHaveClass('text-negative-ink');
      expect(screen.getByTestId('swap-submit')).toBeEnabled();
    });

    it('marks a verdict the press refuses on', () => {
      renderComponent({ quote: quoteAtRate('2', { priceBand: 'off_market', reason: 'price' }) });
      expect(verdictRow()).toHaveTextContent('swapVerdictOffMarket');
      expect(verdictRow()).toHaveClass('text-negative-ink');
    });

    it('says what a full fill pays when it is more than the ask', () => {
      renderComponent({
        quote: quoteAtRate('2', { fillStatus: 'full', reason: null, expectedRequestedAmount: '301000000' })
      });
      expect(verdictRow()).toHaveTextContent('swapVerdictFull');
      expect(verdictRow()).toHaveTextContent('swapVerdictExpected_3.01_IETH');
    });

    it('names no expected amount when a full fill pays exactly the ask', () => {
      renderComponent({
        quote: quoteAtRate('2', { fillStatus: 'full', reason: null, expectedRequestedAmount: '300000000' })
      });
      expect(verdictRow()).not.toHaveTextContent('swapVerdictExpected');
    });
  });

  describe('slippage row', () => {
    const slippageInput = () => screen.getByTestId('swap-slippage-percent');

    it('opens on the flow slippage as a percent', () => {
      renderComponent({ slippageBps: 20 });
      expect(slippageInput()).toHaveValue('0.2');
      expect(screen.getByText('swapSlippage')).toBeInTheDocument();
    });

    it('pushes a valid percent up as basis points and keeps an invalid draft to itself', () => {
      const onSlippageBpsChange = jest.fn();
      renderComponent({ onSlippageBpsChange });

      fireEvent.change(slippageInput(), { target: { value: '0.5' } });
      expect(onSlippageBpsChange).toHaveBeenLastCalledWith(50);

      fireEvent.change(slippageInput(), { target: { value: '1.5' } });
      expect(onSlippageBpsChange).toHaveBeenCalledTimes(1);
      expect(slippageInput()).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText('swapSlippageRange_0.01_1')).toBeInTheDocument();
      expect(screen.getByTestId('swap-submit')).toBeDisabled();
    });

    it('keeps slippage editable to adjust pay while the receive target stays fixed', () => {
      renderComponent({ requestEdited: true });
      expect(slippageInput()).not.toBeDisabled();
      fireEvent.click(screen.getByTestId('swap-slippage-info'));
      expect(screen.getByText('swapReceiveSlippageNote')).toBeInTheDocument();
    });
  });

  describe('settlement controls', () => {
    const preset = (id: string) => screen.getByTestId(`swap-expiry-preset-${id}`);

    it('shows the stored seconds as their preset, under a label that says what happens', () => {
      renderComponent();

      expect(preset('2m')).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByText('swapExpiryLabel')).toBeInTheDocument();
      // The note names the offer, since only the unfilled part of that amount comes back.
      expect(screen.getByTestId('swap-expiry-note')).toHaveTextContent(/^swapExpiryNote_1\.5 IMIDEN$/);
    });

    it('snaps a stored value that is not a preset to the closest one, and pushes it up', () => {
      const { props } = renderComponent({ expirySeconds: '90' });

      expect(preset('2m')).toHaveAttribute('aria-checked', 'true');
      expect(props.onExpirySecondsChange).toHaveBeenCalledWith('120');
    });

    it('renders auto-consume enabled by default', () => {
      renderComponent();
      const toggle = screen.getByTestId('swap-auto-consume');

      expect(toggle).toHaveAttribute('data-value', 'true');
      expect(toggle).toHaveClass('!h-8', '!w-16');
      expect(screen.getByText('swapAutoConsume')).toBeInTheDocument();
    });

    it('holds the expiry still while a submission is in flight', () => {
      renderComponent({ submitting: true });

      for (const id of ['2m', '1h', '1d', '7d']) {
        expect(preset(id)).toBeDisabled();
      }
      // Every choice is disabled mid-submit, and the chosen one still shows (#1086).
      expect(preset('2m')).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByTestId('swap-submit')).toHaveAttribute('data-loading', 'true');
    });

    it('holds the rest of the intent still too: auto-consume and Back', () => {
      const onAutoConsumeChange = jest.fn();
      const onGoBack = jest.fn();
      const { unmount } = renderComponent({ submitting: true, onAutoConsumeChange, onGoBack });

      fireEvent.click(screen.getByTestId('swap-auto-consume'));
      fireEvent.click(screen.getByRole('button', { name: 'back' }));
      expect(onAutoConsumeChange).not.toHaveBeenCalled();
      expect(onGoBack).not.toHaveBeenCalled();
      unmount();

      renderComponent({ onAutoConsumeChange, onGoBack });
      fireEvent.click(screen.getByTestId('swap-auto-consume'));
      fireEvent.click(screen.getByRole('button', { name: 'back' }));
      expect(onAutoConsumeChange).toHaveBeenCalledTimes(1);
      expect(onGoBack).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['1h', '3600'],
      ['1d', '86400'],
      ['7d', '604800']
    ])('forwards the %s preset as seconds', (id, seconds) => {
      const { props } = renderComponent();

      fireEvent.click(preset(id));

      expect(props.onExpirySecondsChange).toHaveBeenLastCalledWith(seconds);
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

  // This screen commits value, so it names the network. The banner comes from the shared
  // ReviewLayout, not from this component: the network pill lives on Home, so without it this
  // screen would show no network at all.
  it('names the network it will commit on', () => {
    renderComponent();

    expect(screen.getByTestId('network-mode-banner')).toBeInTheDocument();
  });
});

jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));

describe('user-visible review reports', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(reportUserVisibleError).mockClear();
  });
  afterEach(() => jest.useRealTimers());
  it('reports the slippage range field after dwell', () => {
    renderComponent();
    fireEvent.change(screen.getByTestId('swap-slippage-percent'), { target: { value: '1.5' } });
    expect(screen.getByTestId('swap-slippage-percent')).toHaveAttribute('aria-invalid', 'true');
    act(() => jest.advanceTimersByTime(1000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['swapSlippageRange', 'field']]);
  });
  it('does not report valid slippage or an absent submit error', () => {
    renderComponent({ submitError: null });
    act(() => jest.advanceTimersByTime(1000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });
});

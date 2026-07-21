import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';
import BigNumber from 'bignumber.js';

import useCopyToClipboard from 'lib/ui/useCopyToClipboard';
import useTippy from 'lib/ui/useTippy';

import Money from './Money';

// `react-i18next` powers the copy/copied tooltip labels inside `FullAmountTippy`.
// Echo the key so we can assert on the exact label chosen.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// The repo ships an automatic manual mock at `__mocks__/lib/i18n/numbers.ts`
// (only formatNumber/formatFiat/formatPercentage). Because `Money` imports the
// number formatters via the *bare* `lib/i18n/numbers` specifier, Jest applies
// that mock automatically — which lacks `toLocalFormat`/`toLocalFixed`/
// `toShortened`. Unmock so `Money` exercises the real formatting/branch logic.
jest.unmock('lib/i18n/numbers');

// `lib/i18n/numbers` -> `toShortened` delegates the thousand/million/billion
// bucket labelling to the i18next singleton. It's never `init()`-ed in the unit
// environment, so make `t` deterministic (echo key) and leave `language`
// undefined so locale resolution falls through exactly as in production.
jest.mock('i18next', () => ({
  __esModule: true,
  default: {
    t: jest.fn((key: string, opts?: Record<string, unknown>) => `${key}|${opts ? JSON.stringify(opts) : ''}`),
    language: undefined
  }
}));

// Copy-to-clipboard is a native/browser side effect — stub it so we can drive
// `copied` state and assert `copy()` is invoked without touching the clipboard.
jest.mock('lib/ui/useCopyToClipboard', () => ({
  __esModule: true,
  default: jest.fn()
}));

// `useTippy` returns a ref and receives the tippy config object. We capture the
// config to exercise the onCreate/onTrigger/onUntrigger/onHidden callbacks.
jest.mock('lib/ui/useTippy', () => ({
  __esModule: true,
  default: jest.fn(() => jest.fn())
}));

const mockUseCopyToClipboard = useCopyToClipboard as unknown as jest.Mock;
const mockUseTippy = useTippy as unknown as jest.Mock;

// Grab the most recent tippy config passed to the (single) rendered instance.
const lastTippyProps = () => mockUseTippy.mock.calls[mockUseTippy.mock.calls.length - 1][0];

const makeInstance = () => ({
  enable: jest.fn(),
  disable: jest.fn(),
  show: jest.fn()
});

describe('Money', () => {
  const copy = jest.fn();
  const setCopied = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseCopyToClipboard.mockReturnValue({
      fieldRef: { current: null },
      copy,
      copied: false,
      setCopied
    });
  });

  describe('branch selection', () => {
    it('renders JustMoney for whole numbers (no decimal separator) and trims decimals for long integers', () => {
      // intLength (4) >= ENOUGH_INT_LENGTH -> cryptoDecimals reduced; decimalsLength 0 -> no decimal
      const { container } = render(<Money>1234</Money>);

      // JustMoney renders the whole grouped value with no fraction <span>.
      expect(container).toHaveTextContent('1,234');
      expect(container.querySelector('span')).toBeNull();
      // Hidden mirror input carries the full amount (toLocalFixed adds no grouping).
      expect(screen.getByDisplayValue('1234')).toBeInTheDocument();
    });

    it('renders JustMoney for a short whole number (intLength < ENOUGH_INT_LENGTH)', () => {
      const { container } = render(<Money>5</Money>);

      expect(container).toHaveTextContent('5');
      expect(container.querySelector('span')).toBeNull();
    });

    it('renders MoneyWithFormat (non-fiat) when decimals fit within cryptoDecimals', () => {
      const { container } = render(<Money>1.23</Money>);

      // Integer part as text, fraction inside a <span>.
      expect(container).toHaveTextContent('1.23');
      const fraction = container.querySelector('span');
      expect(fraction).not.toBeNull();
      expect(fraction).toHaveTextContent('23');
      // default smallFractionFont -> shrunk fraction
      expect(fraction!.style.fontSize).toBe('0.9em');
      // full (unrounded) amount preserved in the copy input
      expect(screen.getByDisplayValue('1.23')).toBeInTheDocument();
    });

    it('renders MoneyWithFormat with fiat rounding to 2 decimals', () => {
      const { container } = render(<Money fiat>1.239</Money>);

      // Displayed value: fiat -> 2 decimals, ROUND_DOWN -> "1.23"
      expect(container).toHaveTextContent('1.23');
      // isFiat copy input fixes the full amount to 2 dp with BigNumber's default
      // ROUND_HALF_UP -> "1.24"
      expect(screen.getByDisplayValue('1.24')).toBeInTheDocument();
    });

    it('renders MoneyWithoutFormat when there are more decimals than cryptoDecimals', () => {
      const { container } = render(<Money>1.23456789</Money>);

      // cryptoDecimals default 6 -> "1.234567", fraction in <span>
      const fraction = container.querySelector('span');
      expect(fraction).not.toBeNull();
      expect(fraction).toHaveTextContent('234567');
      expect(container).toHaveTextContent('1.234567');
      // showAmountTooltip -> the copy input holds the *fully fixed* amount
      expect(screen.getByDisplayValue('1.23456789')).toBeInTheDocument();
    });

    it('omits the shrink font on the fraction when smallFractionFont is false', () => {
      const { container } = render(<Money smallFractionFont={false}>1.23</Money>);

      const fraction = container.querySelector('span');
      expect(fraction).not.toBeNull();
      expect(fraction!.style.fontSize).toBe('');
    });

    it('omits the shrink font on MoneyWithoutFormat fraction when smallFractionFont is false', () => {
      const { container } = render(<Money smallFractionFont={false}>1.23456789</Money>);

      const fraction = container.querySelector('span');
      expect(fraction).not.toBeNull();
      expect(fraction!.style.fontSize).toBe('');
    });

    it('accepts a BigNumber as children', () => {
      const { container } = render(<Money>{new BigNumber('12.5')}</Money>);

      expect(container).toHaveTextContent('12.5');
    });

    it('uses toShortened and still routes long-decimal shortened values through MoneyWithFormat', () => {
      // abs < 1 -> toShortened returns a 1-sig-fig fixed string ("0.00001"),
      // which keeps a decimal separator; because `shortened` is set the
      // MoneyWithoutFormat guard (`!shortened`) is false -> MoneyWithFormat.
      const { container } = render(<Money shortened>0.00001234</Money>);

      expect(container).toHaveTextContent('0.00001');
      const fraction = container.querySelector('span');
      expect(fraction).not.toBeNull();
    });
  });

  describe('FullAmountTippy render variants (isSpan x enabled)', () => {
    it('renders a div + hidden input when enabled and not a span (default)', () => {
      const { container } = render(<Money>5</Money>);

      expect(container.firstChild).not.toBeNull();
      expect((container.firstChild as HTMLElement).tagName).toBe('DIV');
      expect(container.querySelector('input')).toBeInTheDocument();
      expect(container.querySelector('input')).toHaveClass('sr-only');
    });

    it('renders a bare div (no copy input) when tooltip is disabled', () => {
      const { container } = render(<Money tooltip={false}>5</Money>);

      const el = container.firstChild as HTMLElement;
      expect(el.tagName).toBe('DIV');
      expect(container.querySelector('input')).not.toBeInTheDocument();
      // tooltip=false drops the hover class but keeps the base classes
      expect(el).toHaveClass('font-heading');
      expect(el).not.toHaveClass('hover:bg-gray-100');
    });

    it('renders a span + hidden input when isSpan and enabled', () => {
      const { container } = render(<Money isSpan>5</Money>);

      const el = container.firstChild as HTMLElement;
      expect(el.tagName).toBe('SPAN');
      expect(container.querySelector('input')).toBeInTheDocument();
    });

    it('renders a bare span (no copy input) when isSpan and tooltip disabled', () => {
      const { container } = render(
        <Money isSpan tooltip={false}>
          5
        </Money>
      );

      const el = container.firstChild as HTMLElement;
      expect(el.tagName).toBe('SPAN');
      expect(container.querySelector('input')).not.toBeInTheDocument();
    });

    it('keeps the hover class when tooltip is enabled', () => {
      const { container } = render(<Money>5</Money>);

      expect(container.firstChild).toHaveClass('hover:bg-gray-100');
    });
  });

  describe('tippy content', () => {
    it('shows the copy-hash label when not copied and not an amount tooltip', () => {
      render(<Money>1.23</Money>);

      expect(lastTippyProps().content).toBe('copyHashToClipboard');
    });

    it('shows the full-amount string when showAmountTooltip is set (MoneyWithoutFormat)', () => {
      render(<Money>1.23456789</Money>);

      // showAmountTooltip -> content is the fully-fixed amount, not a label
      expect(lastTippyProps().content).toBe('1.23456789');
    });

    it('shows the copied label when the clipboard hook reports copied', () => {
      mockUseCopyToClipboard.mockReturnValue({
        fieldRef: { current: null },
        copy,
        copied: true,
        setCopied
      });

      render(<Money>1.23</Money>);

      expect(lastTippyProps().content).toBe('copiedHash');
    });
  });

  describe('tippy lifecycle callbacks', () => {
    it('onCreate stores + enables the instance; onTrigger/onUntrigger disable it when no amount tooltip', () => {
      render(<Money>1.23</Money>);
      const props = lastTippyProps();
      const instance = makeInstance();

      props.onCreate(instance);
      expect(instance.enable).toHaveBeenCalledTimes(1);

      props.onTrigger(instance);
      props.onUntrigger(instance);
      expect(instance.disable).toHaveBeenCalledTimes(2);

      props.onHidden();
      expect(setCopied).toHaveBeenCalledWith(false);
    });

    it('onTrigger/onUntrigger do NOT disable when showAmountTooltip is set', () => {
      render(<Money>1.23456789</Money>);
      const props = lastTippyProps();
      const instance = makeInstance();

      props.onTrigger(instance);
      props.onUntrigger(instance);
      expect(instance.disable).not.toHaveBeenCalled();
    });
  });

  describe('click handling', () => {
    it('enables + shows the tippy instance and copies on click (no amount tooltip)', () => {
      const { container } = render(<Money>1.23</Money>);
      const props = lastTippyProps();
      const instance = makeInstance();

      // establish the instance ref so handleClick can drive it
      props.onCreate(instance);

      fireEvent.click(container.firstChild as HTMLElement);

      // onCreate enable (1) + handleClick enable (1)
      expect(instance.enable).toHaveBeenCalledTimes(2);
      expect(instance.show).toHaveBeenCalledTimes(1);
      expect(copy).toHaveBeenCalledTimes(1);
    });

    it('still copies on click but does not force-show when showAmountTooltip is set', () => {
      const { container } = render(<Money>1.23456789</Money>);
      const props = lastTippyProps();
      const instance = makeInstance();

      props.onCreate(instance);

      fireEvent.click(container.firstChild as HTMLElement);

      // showAmountTooltip -> skip the enable/show branch
      expect(instance.show).not.toHaveBeenCalled();
      expect(instance.enable).toHaveBeenCalledTimes(1); // only from onCreate
      expect(copy).toHaveBeenCalledTimes(1);
    });

    it('copies on click without an established instance ref (optional-chaining no-op)', () => {
      const { container } = render(<Money>1.23</Money>);

      // no onCreate call -> tippyInstanceRef.current is undefined
      fireEvent.click(container.firstChild as HTMLElement);

      expect(copy).toHaveBeenCalledTimes(1);
    });
  });
});

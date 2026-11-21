import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { USD_QUOTE_MAX_AGE_MS } from 'lib/prices/amount';
import { quotedPrice } from 'lib/prices/binance';
import type { TokenPriceInfo } from 'lib/prices/binance';

import { AmountInput } from './AmountInput';
import { TokenAmountInput, TokenAmountInputProps } from './TokenAmountInput';

jest.mock('lib/prices/unquoted-default', () => ({ hasUnquotedDefaultPrice: () => true }));

jest.mock('lib/store', () => ({ useWalletStore: (selector: any) => selector({ tokenPrices: {} }) }));
jest.mock('lib/miden/swap/tokens', () => ({ tokenQuote: () => mockQuote }));
jest.mock('lib/mobile/haptics', () => ({
  hapticMedium: jest.fn(),
  hapticLight: jest.fn(),
  hapticSelection: jest.fn()
}));
jest.mock('lib/telemetry/use-user-visible-error', () => ({ useUserVisibleError: jest.fn() }));
jest.mock('app/icons/v2', () => ({ Icon: () => null, IconName: { InformationFill: 'info', Close: 'close' } }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: { unit?: string; value?: string }) =>
      `${key}${args?.unit ? ` ${args.unit}` : ''}${args?.value ? ` ${args.value}` : ''}`
  })
}));
jest.mock('lib/i18n/core', () => ({ getCurrentLocale: () => mockLocale }));
let mockLocale = 'en';
let mockQuote: TokenPriceInfo | undefined;
const fresh = (price = 3): TokenPriceInfo => ({ price, observedAt: Date.now(), change24h: 0, percentageChange24h: 0 });
const field = () => screen.getByTestId('amount') as HTMLInputElement;
const toggle = () => screen.getByTestId('amount-denomination-toggle');
const changed = jest.fn();
function Owner({ initial = '1', ...props }: Partial<TokenAmountInputProps> & { initial?: string }) {
  const [value, setValue] = React.useState(initial);
  return (
    <>
      <TokenAmountInput
        assetId="token"
        symbol="TOK"
        decimals={18}
        scaleIsKnown
        value={value}
        onValueChange={next => {
          changed(next);
          setValue(next);
        }}
        data-testid="amount"
        {...props}
      />
      <output data-testid="canonical">{value}</output>
    </>
  );
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-22T12:00:00Z'));
  mockQuote = fresh();
  mockLocale = 'en';
  changed.mockClear();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('TokenAmountInput', () => {
  it('normalizes token text and keeps the canonical token amount through denomination switches', () => {
    render(<Owner initial="" />);
    fireEvent.change(field(), { target: { value: '00012.34' } });
    expect(field()).toHaveValue('12.34');
    expect(screen.getByTestId('canonical')).toHaveTextContent('12.34');
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(field()).toHaveValue('12.34');
    expect(screen.getByTestId('canonical')).toHaveTextContent('12.34');
  });

  it('normalizes USD text while keeping its converted token amount through denomination switches', () => {
    render(<Owner initial="" />);
    fireEvent.click(toggle());
    fireEvent.change(field(), { target: { value: '0003.00' } });
    expect(field()).toHaveValue('3.00');
    expect(screen.getByTestId('canonical')).toHaveTextContent('1');
    fireEvent.click(toggle());
    expect(field()).toHaveValue('1');
    fireEvent.click(toggle());
    expect(field()).toHaveValue('3');
    expect(screen.getByTestId('canonical')).toHaveTextContent('1');
  });

  it('waits for an asset before presenting denomination choices', () => {
    render(<Owner symbol="" assetId="" scaleIsKnown={false} />);
    expect(screen.queryByTestId('amount-denomination-toggle')).not.toBeInTheDocument();
  });

  it('shows one current-unit button with an explicit switching action and preserves exact input', () => {
    render(<Owner initial="1.123456789123456789" />);
    expect(toggle()).toHaveAccessibleName('amountSwitchUnit USD');
    expect(toggle()).toHaveTextContent('TOK');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    fireEvent.click(toggle());
    expect(toggle()).toHaveTextContent('USD');
    expect(toggle()).toHaveAccessibleName('amountSwitchUnit TOK');
    fireEvent.click(toggle());
    expect(field()).toHaveValue('1.123456789123456789');
    expect(changed).not.toHaveBeenCalled();
  });

  it('keeps a receive-driven compact token estimate separate from exact editing and USD mode', () => {
    const exact = '1.123456789123456789';
    render(<Owner initial={exact} unfocusedDisplayValue="≈ 1.12" />);
    expect(screen.getByText('≈ 1.12')).toBeInTheDocument();
    expect(field()).toHaveValue(exact);
    fireEvent.focus(field());
    expect(screen.queryByText('≈ 1.12')).not.toBeInTheDocument();
    expect(field()).toHaveValue(exact);
    fireEvent.blur(field());
    expect(screen.getByText('≈ 1.12')).toBeInTheDocument();
    fireEvent.click(toggle());
    expect(screen.queryByText('≈ 1.12')).not.toBeInTheDocument();
    expect(field()).toHaveValue('3.370370367370370367');
    fireEvent.click(toggle());
    expect(field()).toHaveValue(exact);
    expect(screen.getByText('≈ 1.12')).toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();
  });

  it('updates provenance for equivalent USD edits and same-value MAX without changing tokens', () => {
    const view = render(<Owner initial="1" tokenIntentKey={0} />);
    fireEvent.click(toggle());
    fireEvent.change(field(), { target: { value: '3.0' } });
    expect(screen.getByText('≈ 1 TOK')).toBeInTheDocument();
    view.rerender(<Owner initial="1" tokenIntentKey={1} />);
    expect(screen.getByText('1 TOK')).toBeInTheDocument();
    expect(screen.queryByText('≈ 1 TOK')).not.toBeInTheDocument();
    expect(screen.getByTestId('canonical')).toHaveTextContent('1');
  });

  it('marks USD-derived token equivalents approximate without rounding the canonical amount', () => {
    render(<Owner initial="" decimals={6} />);
    fireEvent.click(toggle());
    fireEvent.change(field(), { target: { value: '1' } });
    expect(screen.getByText('≈ 0.333333 TOK')).toBeInTheDocument();
    expect(screen.getByTestId('canonical')).toHaveTextContent('0.333333');
    fireEvent.click(toggle());
    expect(field()).toHaveValue('0.333333');
    fireEvent.click(toggle());
    expect(screen.getByText('≈ 0.333333 TOK')).toBeInTheDocument();
  });

  it('does not mark an exact token selection approximate when viewing its USD equivalent', () => {
    const view = render(<Owner initial="1.123456789123456789" />);
    fireEvent.click(toggle());
    expect(screen.getByText('1.123456789123456789 TOK')).toBeInTheDocument();
    expect(screen.queryByText('≈ 1.123456789123456789 TOK')).not.toBeInTheDocument();
    fireEvent.change(field(), { target: { value: '1' } });
    expect(screen.getByText(/^≈ /)).toBeInTheDocument();
    view.rerender(<Owner initial="1.123456789123456789" value="2" tokenIntentKey={1} />);
    expect(screen.getByText('2 TOK')).toBeInTheDocument();
    expect(screen.queryByText('≈ 2 TOK')).not.toBeInTheDocument();
  });

  it.each([
    ['1.123456789123456789', 18],
    ['0.000000000000000000000000000000000001', 36],
    ['90071992547409931234567890.123456789123456789', 18]
  ])('switches %s repeatedly without changing exact transaction input', (initial, decimals) => {
    render(<Owner initial={initial} decimals={decimals} />);
    for (let count = 0; count < 5; count++) {
      fireEvent.click(toggle());
      expect(field()).toHaveAccessibleName('amountInputUnit USD');
      fireEvent.blur(field());
      fireEvent.click(toggle());
      expect(field()).toHaveValue(initial);
    }
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByTestId('canonical')).toHaveTextContent(initial);
  });

  it('floors an edited USD amount to base units and preserves the USD intent on price refresh', () => {
    const { rerender } = render(<Owner decimals={6} />);
    fireEvent.click(toggle());
    fireEvent.change(field(), { target: { value: '1' } });
    expect(changed).toHaveBeenLastCalledWith('0.333333');
    mockQuote = fresh(4);
    rerender(<Owner decimals={6} />);
    expect(field()).toHaveValue('1');
    expect(changed).toHaveBeenLastCalledWith('0.25');
    fireEvent.click(toggle());
    expect(field()).toHaveValue('0.25');
  });

  it('clears native precision input through the canonical parent callback', () => {
    render(<Owner initial="1.123456789123456789" />);
    fireEvent.click(screen.getByRole('button', { name: 'clear' }));
    expect(changed).toHaveBeenLastCalledWith('');
    expect(field()).toHaveValue('');
    expect(field()).toHaveFocus();
  });

  it('accepts all 36 decimals when a USD edit floors to the smallest token unit', () => {
    mockQuote = fresh(1);
    render(<Owner initial="" decimals={36} />);
    fireEvent.click(toggle());
    const unit = '0.000000000000000000000000000000000001';
    fireEvent.change(field(), { target: { value: unit } });
    expect(changed).toHaveBeenLastCalledWith(unit);
    fireEvent.click(toggle());
    expect(field()).toHaveValue(unit);
  });

  it('accepts comma decimal USD edits and distinguishes empty and zero', () => {
    mockLocale = 'de_DE';
    mockQuote = fresh(2);
    render(<Owner initial="" />);
    fireEvent.click(toggle());
    expect(field()).toHaveValue('');
    fireEvent.change(field(), { target: { value: '0,5' } });
    expect(changed).toHaveBeenLastCalledWith('0.25');
    fireEvent.change(field(), { target: { value: '0' } });
    expect(changed).toHaveBeenLastCalledWith('0');
    fireEvent.change(field(), { target: { value: '' } });
    expect(changed).toHaveBeenLastCalledWith('');
  });

  it('uses a MAX/external parent value as a new exact selection while USD is active', () => {
    const onValueChange = jest.fn();
    const props = {
      assetId: 'token',
      symbol: 'TOK',
      decimals: 18,
      scaleIsKnown: true,
      onValueChange,
      'data-testid': 'amount'
    };
    const { rerender } = render(<TokenAmountInput {...props} value="1" />);
    fireEvent.click(toggle());
    const max = '123456789.123456789123456789';
    rerender(<TokenAmountInput {...props} value={max} />);
    fireEvent.click(toggle());
    expect(field()).toHaveValue(max);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('keeps an external MAX exact while a quote refresh updates only its USD display', () => {
    const onValueChange = jest.fn();
    const props = {
      assetId: 'token',
      symbol: 'TOK',
      decimals: 36,
      scaleIsKnown: true,
      onValueChange,
      'data-testid': 'amount'
    };
    const { rerender } = render(<TokenAmountInput {...props} value="1" />);
    fireEvent.click(toggle());
    const max = '123456789.123456789123456789123456789123456789';
    rerender(<TokenAmountInput {...props} value={max} />);
    mockQuote = fresh(2);
    rerender(<TokenAmountInput {...props} value={max} />);
    expect(field()).toHaveValue('246913578.246913578246913578246913578246913578');
    expect(onValueChange).not.toHaveBeenCalled();
    fireEvent.click(toggle());
    expect(field()).toHaveValue(max);
  });

  it('restores exact MAX after a stale quote invalidates the active USD submission', () => {
    function MaxOwner() {
      const [value, setValue] = React.useState('1');
      return (
        <>
          <TokenAmountInput
            assetId="token"
            symbol="TOK"
            decimals={18}
            scaleIsKnown
            value={value}
            onValueChange={next => {
              changed(next);
              setValue(next);
            }}
            data-testid="amount"
          />
          <button onClick={() => setValue('12.123456789123456789')}>MAX</button>
          <output data-testid="canonical">{value}</output>
        </>
      );
    }
    const { rerender } = render(<MaxOwner />);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: 'MAX' }));
    act(() => jest.advanceTimersByTime(USD_QUOTE_MAX_AGE_MS + 15_000));
    expect(field()).toBeDisabled();
    expect(screen.getByTestId('canonical')).toBeEmptyDOMElement();
    expect(changed).toHaveBeenLastCalledWith('');
    mockQuote = fresh(2);
    rerender(<MaxOwner />);
    expect(field()).not.toBeDisabled();
    expect(field()).toHaveValue('24.246913578246913578');
    expect(changed).toHaveBeenLastCalledWith('12.123456789123456789');
    expect(screen.getByTestId('canonical')).toHaveTextContent('12.123456789123456789');
    fireEvent.click(toggle());
    expect(field()).toHaveValue('12.123456789123456789');
  });

  it('shows an external MAX in the token field when the quote has already expired in USD mode', () => {
    function MaxOwner() {
      const [value, setValue] = React.useState('1');
      return (
        <>
          <TokenAmountInput
            assetId="token"
            symbol="TOK"
            decimals={18}
            scaleIsKnown
            value={value}
            onValueChange={next => {
              changed(next);
              setValue(next);
            }}
            data-testid="amount"
          />
          <button onClick={() => setValue('12.5')}>MAX</button>
          <output data-testid="canonical">{value}</output>
        </>
      );
    }
    render(<MaxOwner />);
    fireEvent.click(toggle());
    act(() => jest.advanceTimersByTime(USD_QUOTE_MAX_AGE_MS + 15_000));
    expect(field()).toBeDisabled();
    expect(screen.getByTestId('canonical')).toBeEmptyDOMElement();

    fireEvent.click(screen.getByRole('button', { name: 'MAX' }));

    expect(field()).not.toBeDisabled();
    expect(field()).toHaveValue('12.5');
    expect(screen.getByTestId('canonical')).toHaveTextContent('12.5');
  });

  it('treats a same-value MAX signal as token intent and lets a later USD edit restore dollar intent', () => {
    const { rerender } = render(<Owner initial="" decimals={6} tokenIntentKey={0} />);
    fireEvent.click(toggle());
    fireEvent.change(field(), { target: { value: '1' } });
    expect(changed).toHaveBeenLastCalledWith('0.333333');
    rerender(<Owner initial="" decimals={6} tokenIntentKey={1} />);
    expect(field()).toHaveValue('0.999999');
    changed.mockClear();
    mockQuote = fresh(2);
    rerender(<Owner initial="" decimals={6} tokenIntentKey={1} />);
    expect(field()).toHaveValue('0.666666');
    expect(screen.getByTestId('canonical')).toHaveTextContent('0.333333');
    expect(changed).not.toHaveBeenCalled();
    fireEvent.change(field(), { target: { value: '1' } });
    expect(changed).toHaveBeenLastCalledWith('0.5');
    mockQuote = fresh(4);
    rerender(<Owner initial="" decimals={6} tokenIntentKey={1} />);
    expect(field()).toHaveValue('1');
    expect(changed).toHaveBeenLastCalledWith('0.25');
  });

  it('keeps an Earn full-balance flag across quote invalidation and clears it only on user edits', () => {
    function EarnOwner() {
      const [value, setValue] = React.useState('');
      const [fullBalanceSelected, setFullBalanceSelected] = React.useState(false);
      return (
        <>
          <TokenAmountInput
            assetId="token"
            symbol="TOK"
            decimals={18}
            scaleIsKnown
            value={value}
            tokenIntentKey={fullBalanceSelected}
            onUserEdit={() => setFullBalanceSelected(false)}
            onValueChange={next => {
              changed(next);
              setValue(next);
            }}
            data-testid="amount"
          />
          <button
            onClick={() => {
              setValue('12.123456789123456789');
              setFullBalanceSelected(true);
            }}
          >
            MAX
          </button>
          <output data-testid="canonical">{value}</output>
          <output data-testid="max-flag">{String(fullBalanceSelected)}</output>
        </>
      );
    }
    const { rerender } = render(<EarnOwner />);
    fireEvent.click(screen.getByRole('button', { name: 'MAX' }));
    fireEvent.click(toggle());
    expect(screen.getByTestId('max-flag')).toHaveTextContent('true');
    act(() => jest.advanceTimersByTime(USD_QUOTE_MAX_AGE_MS + 15_000));
    expect(field()).toBeDisabled();
    expect(screen.getByTestId('canonical')).toBeEmptyDOMElement();
    expect(screen.getByTestId('max-flag')).toHaveTextContent('true');
    mockQuote = fresh(2);
    rerender(<EarnOwner />);
    expect(field()).toHaveValue('24.246913578246913578');
    expect(screen.getByTestId('canonical')).toHaveTextContent('12.123456789123456789');
    expect(screen.getByTestId('max-flag')).toHaveTextContent('true');
    fireEvent.change(field(), { target: { value: '1' } });
    expect(screen.getByTestId('max-flag')).toHaveTextContent('false');
    expect(screen.getByTestId('canonical')).toHaveTextContent('0.5');
    mockQuote = fresh(4);
    rerender(<EarnOwner />);
    expect(field()).toHaveValue('1');
    expect(screen.getByTestId('canonical')).toHaveTextContent('0.25');
    expect(changed).toHaveBeenLastCalledWith('0.25');
  });

  it('preserves entered USD intent when the selected asset identity changes', () => {
    const { rerender } = render(<Owner />);
    fireEvent.click(toggle());
    rerender(<Owner assetId="other-network:other-token" symbol="OTHER" />);
    expect(field()).toHaveAccessibleName('amountInputUnit USD');
    expect(field()).toHaveValue('3');
    expect(changed).toHaveBeenLastCalledWith('1');
    fireEvent.click(toggle());
    expect(field()).toHaveAccessibleName('amountInputUnit OTHER');
    expect(field()).toHaveValue('1');
  });

  it('recomputes active dollars using the new asset rate and base-unit precision', () => {
    const { rerender } = render(<Owner />);
    fireEvent.click(toggle());
    fireEvent.change(field(), { target: { value: '1' } });
    mockQuote = fresh(7);
    rerender(<Owner assetId="new-token" symbol="NEW" decimals={2} />);
    expect(field()).toHaveAccessibleName('amountInputUnit USD');
    expect(field()).toHaveValue('1');
    expect(changed).toHaveBeenLastCalledWith('0.14');
    expect(screen.getByTestId('canonical')).toHaveTextContent('0.14');
    fireEvent.click(toggle());
    expect(field()).toHaveAccessibleName('amountInputUnit NEW');
    expect(field()).toHaveValue('0.14');
  });

  it('clears an unpriced replacement asset and never restores the prior asset on returning to tokens', () => {
    const { rerender } = render(<Owner initial="12" />);
    fireEvent.click(toggle());
    mockQuote = undefined;
    rerender(<Owner assetId="unpriced" symbol="NEW" decimals={6} />);
    expect(field()).toHaveValue('36');
    expect(field()).toBeDisabled();
    expect(changed).toHaveBeenLastCalledWith('');
    expect(screen.getByTestId('canonical')).toBeEmptyDOMElement();
    fireEvent.click(toggle());
    expect(field()).toHaveAccessibleName('amountInputUnit NEW');
    expect(field()).toHaveValue('');
    expect(changed.mock.calls.map(([value]) => value)).toEqual(['']);
  });

  it('resolves the original dollar intent when an unpriced replacement asset gets a quote', () => {
    const { rerender } = render(<Owner />);
    fireEvent.click(toggle());
    fireEvent.change(field(), { target: { value: '2.50' } });
    mockQuote = undefined;
    rerender(<Owner assetId="recovering" decimals={6} />);
    expect(field()).toHaveValue('2.50');
    expect(changed).toHaveBeenLastCalledWith('');
    mockQuote = fresh(4);
    rerender(<Owner assetId="recovering" decimals={6} />);
    expect(field()).not.toBeDisabled();
    expect(field()).toHaveValue('2.50');
    expect(changed).toHaveBeenLastCalledWith('0.625');
    expect(screen.getByTestId('canonical')).toHaveTextContent('0.625');
  });

  it('retains entered dollars through a simultaneous asset switch and parent reset', () => {
    const onValueChange = jest.fn();
    const props = {
      assetId: 'old',
      symbol: 'OLD',
      decimals: 18,
      scaleIsKnown: true,
      onValueChange,
      'data-testid': 'amount'
    };
    const { rerender } = render(<TokenAmountInput {...props} value="2" />);
    fireEvent.click(toggle());
    expect(field()).toHaveValue('6');
    mockQuote = fresh(4);
    rerender(<TokenAmountInput {...props} assetId="new" symbol="NEW" decimals={2} value="" />);
    expect(field()).toHaveValue('6');
    expect(onValueChange).toHaveBeenLastCalledWith('1.5');
    rerender(<TokenAmountInput {...props} assetId="new" symbol="NEW" decimals={2} value="1.5" />);
    expect(field()).toHaveValue('6');
    fireEvent.click(toggle());
    expect(field()).toHaveValue('1.5');
  });

  it.each(['missing', 'nominal', 'stale', 'unknown-scale'] as const)(
    'disables USD for %s while keeping token entry available',
    reason => {
      if (reason === 'nominal') mockQuote = quotedPrice({}, 'UNLISTED_TEST_TOKEN');
      if (reason === 'missing') mockQuote = undefined;
      if (reason === 'stale') mockQuote = { ...fresh(), observedAt: Date.now() - USD_QUOTE_MAX_AGE_MS - 1 };
      render(<Owner scaleIsKnown={reason !== 'unknown-scale'} />);
      expect(toggle()).toBeDisabled();
      expect(field()).not.toBeDisabled();
    }
  );

  it('keeps denomination controls reachable beside a validation error', () => {
    render(<Owner error="Insufficient balance" />);
    expect(screen.getByText('Insufficient balance')).toBeInTheDocument();
    fireEvent.click(toggle());
    expect(field()).toHaveAccessibleName('amountInputUnit USD');
    fireEvent.click(toggle());
    expect(field()).toHaveAccessibleName('amountInputUnit TOK');
  });

  it('accepts a quote refreshed after mount without temporarily marking it stale', () => {
    const { rerender } = render(<Owner decimals={6} />);
    fireEvent.click(toggle());
    fireEvent.change(field(), { target: { value: '1' } });
    jest.setSystemTime(Date.now() + 1000);
    mockQuote = fresh(4);
    rerender(<Owner decimals={6} />);
    expect(field()).not.toBeDisabled();
    expect(changed).toHaveBeenLastCalledWith('0.25');
  });

  it('expires an active quote, invalidates the parent amount and permits escape to token mode', () => {
    render(<Owner />);
    fireEvent.click(toggle());
    act(() => jest.advanceTimersByTime(USD_QUOTE_MAX_AGE_MS));
    expect(field()).not.toBeDisabled();
    act(() => jest.advanceTimersByTime(1));
    expect(field()).toBeDisabled();
    expect(changed).toHaveBeenLastCalledWith('');
    expect(toggle()).not.toBeDisabled();
    fireEvent.click(toggle());
    expect(field()).not.toBeDisabled();
  });

  it('does not convert a USD edit when the quote expired since the last clock update', () => {
    render(<Owner />);
    fireEvent.click(toggle());

    act(() => jest.setSystemTime(Date.now() + USD_QUOTE_MAX_AGE_MS + 1));
    expect(field()).not.toBeDisabled();
    fireEvent.change(field(), { target: { value: '6' } });

    expect(changed).not.toHaveBeenCalledWith('2');
    expect(changed).toHaveBeenLastCalledWith('');
    expect(screen.getByTestId('canonical')).toHaveTextContent('');
    expect(field()).toBeDisabled();
  });

  it('does not switch into USD mode when the quote expired since the last clock update', () => {
    render(<Owner initial="2" />);

    act(() => jest.setSystemTime(Date.now() + USD_QUOTE_MAX_AGE_MS + 1));
    fireEvent.click(toggle());

    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(field()).toHaveValue('2');
  });

  it('does not trust a supplied external quote unless external asset resolution was requested', () => {
    mockQuote = undefined;
    const { rerender } = render(<Owner quote={fresh(2)} />);
    expect(toggle()).toBeDisabled();
    rerender(<Owner quote={fresh(2)} externalAsset />);
    expect(toggle()).not.toBeDisabled();
    fireEvent.click(toggle());
    expect(field()).toHaveValue('2');
  });

  it('leaves the generic native SpendingLimits dollar-prefix input as plain USD entry', () => {
    const onValueChange = jest.fn();
    render(
      <AmountInput
        prefix="$"
        value="25"
        aria-label="Spending limit"
        onValueChange={onValueChange}
        data-testid="amount"
      />
    );
    expect(field()).toHaveValue('25');
    expect(field()).toHaveAccessibleName('Spending limit');
    expect(screen.queryByTestId('amount-denomination-toggle')).not.toBeInTheDocument();
    fireEvent.change(field(), { target: { value: '26' } });
    expect(onValueChange).toHaveBeenLastCalledWith('26', undefined, expect.objectContaining({ value: '26' }));
  });
});

import React, { HTMLAttributes } from 'react';

import BigNumber from 'bignumber.js';

import {
  AmountDisplayOptions,
  amountFormatterFor,
  formatAmountDisplay,
  USD_DISPLAY_OPTIONS
} from 'lib/i18n/amount-display';
import { cn } from 'lib/ui/util';

import { AnimatedNumber } from './AnimatedNumber';

type AmountValue =
  | { amount: bigint; decimals: number }
  | { amount: string | number | BigNumber | null | undefined; decimals?: never };

export type TokenAmountProps = AmountValue &
  Omit<AmountDisplayOptions, 'decimals'> &
  Omit<HTMLAttributes<HTMLSpanElement>, 'prefix' | 'children'> & {
    animated?: boolean;
    symbolClassName?: string;
    placeholder?: React.ReactNode;
    renderText?: (text: string) => string;
  };

/** One amount display policy. Text styles come from the parent or the supplied classes. */
export const TokenAmount: React.FC<TokenAmountProps> = ({
  amount,
  decimals,
  formatting = 'adaptive',
  rounding = 'nearest',
  symbol,
  minimumFractionDigits,
  trimTrailingZeros,
  grouping,
  separators,
  prefix,
  preserveSign,
  animated = false,
  symbolClassName,
  placeholder = '—',
  renderText = text => text,
  className,
  title,
  ...props
}) => {
  const options = {
    decimals,
    formatting,
    rounding,
    symbol,
    minimumFractionDigits,
    trimTrailingZeros,
    grouping,
    separators,
    prefix,
    preserveSign
  };
  if (amount == null) {
    return (
      <span {...props} className={className}>
        {placeholder}
      </span>
    );
  }
  const exact = formatAmountDisplay(amount, { ...options, formatting: 'exact' });
  const text = formatAmountDisplay(amount, options);
  const formatFrame = typeof amount === 'number' ? amountFormatterFor(amount, options) : undefined;
  const decorate = (value: string) => {
    const display = renderText(value);
    return symbol && !symbolClassName ? `${display} ${symbol}` : display;
  };
  const value =
    animated && typeof amount === 'number' ? (
      <AnimatedNumber
        value={amount}
        format={value => decorate(formatFrame?.(value) ?? text)}
        placeholder={placeholder}
      />
    ) : (
      decorate(text)
    );

  return (
    <span
      {...props}
      className={cn('min-w-0 [overflow-wrap:anywhere]', className)}
      title={title ?? (symbol ? `${exact} ${symbol}` : exact)}
    >
      {value}
      {symbol && symbolClassName && (
        <>
          {' '}
          <span className={symbolClassName}>{symbol}</span>
        </>
      )}
    </span>
  );
};

export type UsdAmountProps = AmountValue & Omit<TokenAmountProps, 'amount' | 'decimals' | 'symbol' | 'symbolClassName'>;

export const UsdAmount: React.FC<UsdAmountProps> = props => (
  <TokenAmount {...USD_DISPLAY_OPTIONS} {...props} />
);

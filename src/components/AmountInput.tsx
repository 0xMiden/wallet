import React, { useRef } from 'react';

import classNames from 'clsx';
import CurrencyInput, { CurrencyInputOnChangeValues } from 'react-currency-input-field';

import { Icon, IconName } from 'app/icons/v2';

/**
 * Scale the amount text down as the entered value grows, to avoid overflow
 * on narrow mobile screens. Tuned so a short value renders ~text-6xl and a
 * long one (16 chars max) settles at text-3xl.
 */
function amountTextSize(value?: string): string {
  const len = value?.length || 4;
  if (len >= 13) return 'text-3xl';
  if (len >= 10) return 'text-4xl';
  if (len >= 7) return 'text-5xl';
  return 'text-6xl';
}

export interface AmountInputProps {
  value?: string;
  onValueChange?: (value: string | undefined, name?: string, values?: CurrencyInputOnChangeValues) => void;
  placeholder?: string;
  /** Small heading above the amount (e.g. "Select Amount"), optionally a node with a network pill. */
  label?: React.ReactNode;
  /** Already-translated error text. Renders a red row with an info icon below the amount. */
  error?: string;
  /** Secondary lines under the amount, e.g. "Available 200 USDC" / "≈ $200 USD". */
  helper?: React.ReactNode;
  /** Token chip rendered under the orange divider (e.g. "Select a token" / "USDC ▾"). */
  tokenSelector?: React.ReactNode;
  autoFocus?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * Reusable left-aligned amount field: big scalable numeric input, an orange
 * underline divider, optional label / helper lines / token selector chip.
 * Purely presentational and free of send-flow imports so swap and other
 * screens can drop it in.
 */
export const AmountInput: React.FC<AmountInputProps> = ({
  value,
  onValueChange,
  placeholder = '0.00',
  label,
  error,
  helper,
  tokenSelector,
  autoFocus,
  disabled,
  className
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className={classNames('flex flex-col', className)}>
      {label != null &&
        (typeof label === 'string' ? (
          <span className="font-heading text-2xl font-bold text-[#808080] leading-none">{label}</span>
        ) : (
          label
        ))}

      <div className="flex cursor-text items-baseline mt-2" onClick={() => inputRef.current?.focus()}>
        <CurrencyInput
          ref={inputRef}
          className={classNames(
            'w-full bg-transparent p-0 outline-none font-heading font-bold leading-none text-left text-[64px]',
            amountTextSize(value),
            error ? 'text-red-500 placeholder-red-500' : value ? 'text-black' : 'text-grey-300 placeholder-grey-300'
          )}
          value={value}
          onValueChange={onValueChange}
          placeholder={placeholder}
          disableGroupSeparators
          decimalSeparator="."
          decimalsLimit={6}
          allowNegativeValue={false}
          maxLength={16}
          autoFocus={autoFocus}
          disabled={disabled}
        />
      </div>

      {error ? (
        <div className="flex items-center gap-2 pt-2">
          <Icon name={IconName.InformationFill} size="xs" className="text-red-500" />
          <span className="text-red-500 text-sm">{error}</span>
        </div>
      ) : helper ? (
        <div className="flex flex-col pt-2">{helper}</div>
      ) : null}

      {/* Orange underline divider */}
      <div className="mt-1 h-2 rounded-full bg-primary-500 w-55" />

      {tokenSelector != null && <div className="mt-4">{tokenSelector}</div>}
    </div>
  );
};

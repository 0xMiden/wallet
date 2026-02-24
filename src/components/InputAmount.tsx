import React, { HTMLAttributes, useMemo, useRef } from 'react';

import classNames from 'clsx';
import CurrencyInput, { CurrencyInputOnChangeValues } from 'react-currency-input-field';

import { Icon, IconName } from 'app/icons/v2';

export interface InputAmountProps extends HTMLAttributes<HTMLDivElement> {
  className?: string;
  value?: string;
  label?: string;
  error?: boolean;
  displayFiat?: boolean;
  fiatValue?: string;
  autoFocus?: boolean;
  displayToggleCurrency?: boolean;
  onValueChange?: (value: string | undefined, name?: string, values?: CurrencyInputOnChangeValues) => void;
  onToggleCurrency?: () => void;
}

export const InputAmount: React.FC<InputAmountProps> = ({
  className,
  value,
  label,
  error,
  displayFiat,
  fiatValue,
  autoFocus,
  displayToggleCurrency,
  onToggleCurrency,
  onValueChange,
  ...props
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  // Scale text size based on total display length (value + label)
  // to prevent overflow on narrower mobile screens
  const textSize = useMemo(() => {
    const valueLen = value?.length || 1;
    const labelLen = label?.length || 4;
    const totalLen = valueLen + labelLen + 1; // +1 for the space between

    if (totalLen >= 16) {
      return 'text-lg';
    }
    if (totalLen >= 12) {
      return 'text-2xl';
    }
    if (totalLen >= 8) {
      return 'text-4xl';
    }
    return 'text-5xl';
  }, [value, label]);

  const inputWidth = useMemo(() => (value?.length ? `${value?.length}ch` : '1ch'), [value]);

  const textColor = useMemo(() => (error ? 'text-red-500' : 'text-[#00000087]'), [error]);

  const currencyLabel = label || 'MIDEN';

  return (
    <div {...props} className={classNames('flex flex-col items-center gap-y-2', className)}>
      <div className="flex cursor-pointer items-end" onClick={() => inputRef.current?.focus()}>
        {displayFiat ? (
          <label className={classNames('text-left leading-none text-[#00000087]', textSize)}>$</label>
        ) : null}
        <CurrencyInput
          className={classNames(
            'p-0 placeholder-[#00000087] outline-none leading-snug font-medium',
            textSize,
            textColor
          )}
          value={displayFiat ? fiatValue || value : value}
          style={{ width: inputWidth }}
          onValueChange={onValueChange}
          placeholder="0"
          disableGroupSeparators
          decimalSeparator="."
          step={1}
          decimalsLimit={6}
          allowNegativeValue={false}
          maxLength={16}
          autoFocus={autoFocus}
        />
        {!displayFiat ? (
          <label className={classNames('ml-2 text-[#00000087] text-left leading-snug', textSize)}>
            {currencyLabel}
          </label>
        ) : null}
      </div>
      {displayToggleCurrency && (
        <button className="flex items-center gap-x-1 cursor-pointer" type="button" onClick={onToggleCurrency}>
          {!displayFiat ? (
            <p className="text-sm">${Number(fiatValue || value || 0).toFixed(2)}</p>
          ) : (
            <p className="text-sm">
              {fiatValue || value || 0} {currencyLabel}
            </p>
          )}
          <Icon name={IconName.ArrowUpDown} size="xs" fill="black" />
        </button>
      )}
    </div>
  );
};

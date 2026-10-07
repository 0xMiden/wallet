import React, { useRef } from 'react';

import classNames from 'clsx';
import CurrencyInput, { CurrencyInputOnChangeValues } from 'react-currency-input-field';

import { Icon, IconName } from 'app/icons/v2';
import { ACCENT_CLASSES, FlowAccent } from 'components/flow/accent';
import { ClearFieldButton } from 'components/ui/ClearFieldButton';
import { Skeleton } from 'components/ui/Skeleton';
import { clearFieldValue } from 'lib/ui/clear-field';

/**
 * Scale the amount text down as the entered value grows, to avoid overflow
 * on narrow mobile screens: a short value renders at 4rem and a long one
 * (16 chars max) settles at text-3xl. The only size an amount takes: a fixed
 * size beside it would win, since Tailwind emits an arbitrary size after text-3xl.
 */
export function amountTextSize(value?: string): string {
  const len = value?.length || 4;
  if (len >= 13) return 'text-3xl';
  if (len >= 10) return 'text-4xl';
  if (len >= 7) return 'text-5xl';
  return 'text-[4rem]';
}

/**
 * The entry's caption and its figure type at the value's length step. A review that restates the
 * amount it took over (the earn deposit's) sets them from here, so it cannot drift from this step.
 */
export const amountCaptionClassName = 'font-heading text-2xl font-bold text-gray leading-none';
export function amountFigureClassName(value?: string): string {
  return classNames('font-heading font-bold leading-none', amountTextSize(value));
}

/** The centred input overlays the invisible sizing copy in one grid cell and takes its width. */
const CENTERED_INPUT_LAYOUT = '[grid-area:1/1] w-0 min-w-full caret-accent-primary';
// `min-w-0`: an input's automatic flex minimum is its intrinsic width, which would push the clear button out.
const INLINE_INPUT_LAYOUT = 'w-full min-w-0';

/**
 * Accept a comma as the decimal separator (comma-decimal locales/keyboards — es,
 * de, fr, …) by normalizing it to a dot before the field parses the input (#433).
 * The field keeps the emitted value "."-normalized for the tx pipeline, so there
 * is no locale detection and no downstream change.
 *
 * When a dot is already present the commas are treated as thousands groupings
 * (e.g. a pasted `1,000.50`) and dropped, so the value stays `1000.50` rather than
 * collapsing to a broken multi-dot string. Otherwise the comma is the decimal point
 * and becomes a dot.
 *
 * This is aimed at *typed* input, which is the reported problem. Pasting a fully
 * formatted grouped number is not reliably parsed and is an accepted limitation
 * (this field disables grouped input anyway): a bare `1,000` is ambiguous and
 * resolves to `1.000`, and a European-format `1.000,50` (dot groups + comma
 * decimal) mis-parses because the comma decimal is dropped as if it were a group.
 */

export function normalizeDecimalInput(rawValue: string): string {
  if (rawValue.includes('.')) {
    return rawValue.replace(/,/g, '');
  }
  return rawValue.replace(/,/g, '.');
}

export interface AmountInputProps {
  value?: string;
  onValueChange?: (value: string | undefined, name?: string, values?: CurrencyInputOnChangeValues) => void;
  placeholder?: string;
  /** Small heading above the amount (e.g. "Select Amount"), optionally a node with a network pill. */
  label?: React.ReactNode;
  /** Already-translated error text. Renders a red row with an info icon below the amount. */
  error?: string;
  /** Marks the field invalid even when no error text is needed. */
  invalid?: boolean;
  /** Secondary lines under the amount, e.g. "Available 200 USDC" / "≈ $200 USD". */
  helper?: React.ReactNode;
  /** Token chip rendered under the accent divider (e.g. "Select a token" / "USDC ▾"). */
  tokenSelector?: React.ReactNode;
  /**
   * The flow this field belongs to, which colours the divider under the amount
   * (design-system.md, "Action colours"). Defaults to the brand orange.
   */
  accent?: FlowAccent;
  /** Whether to render the accent divider. Defaults to true. */
  showDivider?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Show a skeleton in place of the value while the amount is being computed. */
  loading?: boolean;
  /** A unit drawn before the number (e.g. "$"), outside the input so the value stays bare digits. */
  prefix?: React.ReactNode;
  /**
   * `center` sizes the input to its value and centres it with the prefix, which it draws smaller and
   * raised, like a price. Defaults to `left`, the send and swap layout.
   */
  align?: 'left' | 'center';
  'aria-label'?: string;
  className?: string;
  'data-testid'?: string;
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
  invalid = false,
  helper,
  tokenSelector,
  accent = 'brand',
  showDivider = true,
  autoFocus,
  disabled,
  loading,
  prefix,
  align = 'left',
  'aria-label': ariaLabel,
  className,
  'data-testid': dataTestId
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const centered = align === 'center';
  const showClear = Boolean(value) && !disabled && !loading;
  const amountClasses = classNames(amountFigureClassName(value), centered ? 'text-center' : 'text-left');
  const stateClasses =
    invalid || error ? 'text-red-500 placeholder-red-500' : value ? 'text-ink' : 'text-grey-300 placeholder-grey-300';
  const input = (layoutClassName: string) => (
    <CurrencyInput
      ref={inputRef}
      className={classNames(amountClasses, 'bg-transparent p-0 outline-none', layoutClassName, stateClasses)}
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      transformRawValue={normalizeDecimalInput}
      disableGroupSeparators
      // `disableGroupSeparators` only stops grouping in the *display*; the
      // library still derives a group separator from the ambient locale and
      // strips it from the raw input on every keystroke. On a `.`-group
      // locale (de-DE, pt-BR, …) that strips the dot our normalizer just
      // produced, undoing the fix. Passing "" doesn't help — the library
      // coalesces a falsy group separator back to the locale default — so
      // pin it to a space, which never collides with our "." decimal (#433).
      groupSeparator=" "
      decimalSeparator="."
      decimalsLimit={6}
      allowNegativeValue={false}
      maxLength={16}
      enterKeyHint="done"
      autoFocus={autoFocus}
      disabled={disabled}
      aria-invalid={invalid || !!error}
      aria-label={ariaLabel}
      data-testid={dataTestId}
    />
  );

  return (
    <div className={classNames('flex flex-col', className)}>
      {label != null && (typeof label === 'string' ? <span className={amountCaptionClassName}>{label}</span> : label)}

      <div
        // Centred, the row carries the amount's size so the prefix's 0.6em scales with it.
        className={classNames(
          'flex cursor-text mt-3',
          centered ? classNames('relative items-start justify-center', amountTextSize(value)) : 'items-baseline'
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {prefix != null && !loading && (
          <span
            aria-hidden="true"
            className={classNames(
              'font-heading font-bold leading-none text-muted',
              centered ? 'mr-0.5 mt-[0.1em] text-[0.6em]' : 'mr-1',
              !centered && amountTextSize(value)
            )}
          >
            {prefix}
          </span>
        )}
        {loading ? (
          <Skeleton className="h-14 w-40 rounded-xl" />
        ) : centered ? (
          // An invisible copy of the value sizes the grid cell, so the input is exactly as wide as
          // what it holds and the prefix + number centre as one.
          <span className="inline-grid">
            <span aria-hidden="true" className={classNames(amountClasses, 'invisible whitespace-pre [grid-area:1/1]')}>
              {value || placeholder}
            </span>
            {input(CENTERED_INPUT_LAYOUT)}
          </span>
        ) : (
          input(INLINE_INPUT_LAYOUT)
        )}
        {showClear && (
          <ClearFieldButton
            onClear={() => clearFieldValue(inputRef.current)}
            // Centred, the button floats at the row's end so the amount keeps its centre.
            className={centered ? 'absolute right-0 top-1/2 -translate-y-1/2' : '-mr-3 ml-1 self-center'}
          />
        )}
      </div>

      {error ? (
        <div className="flex items-center gap-2 pt-2">
          <Icon name={IconName.InformationFill} size="xs" fill="currentColor" className="shrink-0 text-red-500" />
          <span className="text-red-500 text-sm">{error}</span>
        </div>
      ) : helper ? (
        <div className={classNames('flex flex-col pt-2', centered && 'items-center text-center')}>{helper}</div>
      ) : null}

      {showDivider && (
        <div
          data-testid="amount-token-divider"
          className={classNames('mt-3 h-2 rounded-full w-55', ACCENT_CLASSES[accent].bg)}
        />
      )}

      {/* 8px under the helper or error line when there is no divider between them, so the line
          does not sit on the token pill. */}
      {tokenSelector != null && <div className={showDivider ? 'mt-4' : 'mt-2'}>{tokenSelector}</div>}
    </div>
  );
};

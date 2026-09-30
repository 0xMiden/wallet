import React, { forwardRef, useState } from 'react';

import { cn } from 'lib/ui/util';

export interface CodeInputProps {
  /** The digits typed so far. */
  value: string;
  /** Receives digits only, never more than `length`. */
  onChange: (value: string) => void;
  /** The accessible name of the field. No visible label comes with it. */
  label: string;
  /** The number of digits in a full code. */
  length?: number;
  /** The number of cells between two dashes. */
  groupSize?: number;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Layout only (margins). */
  className?: string;
  'data-testid'?: string;
}

const NON_DIGITS = /\D/g;

/** Splits the cell indexes into rows of `groupSize`: 8 cells in groups of 4 give two rows. */
const groupCells = (length: number, groupSize: number): number[][] => {
  const cells = Array.from({ length }, (_, index) => index);
  const groups: number[][] = [];
  for (let start = 0; start < length; start += groupSize) {
    groups.push(cells.slice(start, start + groupSize));
  }
  return groups;
};

/**
 * A short numeric code, one digit for each cell, with a dash between the groups.
 *
 * One native input lies on top of the cells and holds the value. Thus paste, the numeric keyboard and
 * the one-time-code autofill work as they do in a usual field. The input text is invisible. The cells
 * show the digits and are hidden from assistive technology, which reads the input.
 *
 * The cell that takes the subsequent digit shows the accent edge and a caret while the input has
 * focus. A full code has no such cell.
 */
export const CodeInput = forwardRef<HTMLInputElement, CodeInputProps>(function CodeInput(
  {
    value,
    onChange,
    label,
    length = 8,
    groupSize = 4,
    invalid,
    disabled,
    autoFocus,
    className,
    'data-testid': dataTestId
  },
  ref
) {
  const [focused, setFocused] = useState(false);
  const groups = groupCells(length, groupSize);

  return (
    <div className={cn('relative flex items-center justify-between', className)}>
      {groups.map((group, groupIndex) => (
        <React.Fragment key={group[0]}>
          {groupIndex > 0 && <span aria-hidden="true" className="h-0.5 w-2 shrink-0 rounded-full bg-ink opacity-40" />}
          <div aria-hidden="true" className="flex gap-1.5">
            {group.map(index => {
              const active = focused && index === value.length;
              return (
                <span
                  key={index}
                  data-slot="code-cell"
                  data-active={active || undefined}
                  className={cn(
                    'flex h-12 w-9 shrink-0 items-center justify-center rounded-xl text-entry-unit text-ink',
                    active ? 'bg-page ring-2 ring-inset ring-accent-primary' : 'bg-fill'
                  )}
                >
                  {value[index]}
                  {active && (
                    <span className="h-[22px] w-0.5 animate-pulse rounded-full bg-accent-primary motion-reduce:animate-none" />
                  )}
                </span>
              );
            })}
          </div>
        </React.Fragment>
      ))}
      {/* 16px text: iOS zooms the page when a smaller input takes focus. */}
      <input
        ref={ref}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={length}
        value={value}
        onChange={event => onChange(event.target.value.replace(NON_DIGITS, '').slice(0, length))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        aria-label={label}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        autoFocus={autoFocus}
        data-testid={dataTestId}
        className="absolute inset-0 h-full w-full cursor-text text-body opacity-0"
      />
    </div>
  );
});

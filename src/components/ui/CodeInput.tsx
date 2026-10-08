import React, { forwardRef, useState } from 'react';

import { cn } from 'lib/ui/util';

export interface CodeInputProps {
  /** The characters entered so far. */
  value: string;
  /** Receives permitted characters, up to `length`. */
  onChange: (value: string) => void;
  /** The accessible name of the field. No visible label comes with it. */
  label: string;
  /** The maximum number of characters. */
  length?: number;
  format?: 'numeric' | 'alphanumeric';
  /** The number of cells between two dashes. */
  groupSize?: number;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Layout only (margins). */
  className?: string;
  'data-testid'?: string;
}

const FORMATS = {
  numeric: { inputMode: 'numeric', pattern: '[0-9]*', excluded: /\D/g },
  alphanumeric: { inputMode: 'text', pattern: '[A-Za-z0-9]*', excluded: /[^A-Za-z0-9]/g }
} satisfies Record<string, { inputMode: 'numeric' | 'text'; pattern: string; excluded: RegExp }>;

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
 * Show a code in cells over one native input. Keep letter case when letters are permitted.
 * Paste and autofill use the native input. The cells are hidden from assistive technology.
 */
export const CodeInput = forwardRef<HTMLInputElement, CodeInputProps>(function CodeInput(
  {
    value,
    onChange,
    label,
    length = 8,
    format = 'numeric',
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
  const inputFormat = FORMATS[format];

  return (
    <div className={cn('relative flex items-center justify-between gap-1.5', className)}>
      {groups.map((group, groupIndex) => (
        <React.Fragment key={group[0]}>
          {groupIndex > 0 && <span aria-hidden="true" className="h-0.5 w-2 shrink-0 rounded-full bg-ink opacity-40" />}
          <div aria-hidden="true" className={cn('flex gap-1.5', length > 8 && 'min-w-0 flex-1')}>
            {group.map(index => {
              const active = focused && index === value.length;
              return (
                <span
                  key={index}
                  data-slot="code-cell"
                  data-active={active || undefined}
                  className={cn(
                    'flex h-12 items-center justify-center rounded-xl text-entry-unit text-ink',
                    length > 8 ? 'min-w-0 flex-1' : 'w-9 shrink-0',
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
        inputMode={inputFormat.inputMode}
        autoComplete="one-time-code"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        pattern={inputFormat.pattern}
        maxLength={length}
        value={value}
        onChange={event => onChange(event.target.value.replace(inputFormat.excluded, '').slice(0, length))}
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

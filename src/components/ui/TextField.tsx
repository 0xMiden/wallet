import React, { forwardRef, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes, useCallback, useId } from 'react';

import { cva } from 'class-variance-authority';

import { cn } from 'lib/ui/util';

/** The element a `TextField` ref resolves to — an `<input>` or a `<textarea>`, chosen by `multiline`. */
export type TextFieldElement = HTMLInputElement | HTMLTextAreaElement;

// The native attributes both tags share. `onChange`/`value`/`defaultValue` are redeclared below
// against the shared element type instead of the per-tag event types the two native interfaces
// disagree on, and `size` is dropped because `<input>`'s numeric `size` and `<textarea>`'s enum
// `size` variant name collide with nothing we want to expose here.
type SharedFieldAttrs = Omit<
  InputHTMLAttributes<HTMLInputElement> & TextareaHTMLAttributes<HTMLTextAreaElement>,
  'onChange' | 'value' | 'defaultValue' | 'size'
>;

export interface TextFieldProps extends SharedFieldAttrs {
  value?: string;
  defaultValue?: string;
  onChange?: (event: React.ChangeEvent<TextFieldElement>) => void;
  /** 13px bold `muted` label above the field, associated to it via `htmlFor`/`id`. */
  label?: ReactNode;
  /** Helper copy below the field. Hidden while `error` is set. */
  hint?: ReactNode;
  /** Error copy below the field: switches the field to a `negative` ring and renders as `role="alert"`. */
  error?: ReactNode;
  /** testid for the error message, independent of the field's own `data-testid`. */
  errorTestId?: string;
  /** 16px-radius auto-height box on `fill`, instead of the 52px pill. */
  multiline?: boolean;
  /** Pills (Paste, Scan, a unit, …) inside the field, on `page`. */
  trailing?: ReactNode;
  containerClassName?: string;
  'data-testid'?: string;
}

const fieldVariants = cva('flex w-full bg-fill text-ink transition-shadow duration-150', {
  variants: {
    multiline: {
      true: 'flex-col items-stretch gap-2 rounded-lg-token px-4 py-3',
      false: 'h-[52px] items-center rounded-full px-4'
    },
    invalid: {
      // The error ring always shows; the quiet ring only shows once the field has focus. Both are
      // inset: a field fills its column edge to edge, so an outer ring is clipped by any scrolling
      // or overflow-hidden parent (New contact's form cut the ring off at both sides).
      true: 'ring-2 ring-inset ring-status-negative',
      false: 'focus-within:ring-2 focus-within:ring-inset focus-within:ring-accent-primary'
    }
  },
  defaultVariants: { multiline: false, invalid: false }
});

/**
 * The wallet's one text field: a `muted` label above, a pill (single-line) or a 16px-radius box
 * (`multiline`) on `fill`, an optional trailing slot for pills sitting on `page` inside the field,
 * and a hint or an error line below — the error switching the field to a negative ring and
 * announcing itself via `role="alert"`. Replaces `Input` and `FormField`.
 */
export const TextField = forwardRef<TextFieldElement, TextFieldProps>(
  (
    {
      value,
      defaultValue,
      onChange,
      label,
      hint,
      error,
      errorTestId,
      multiline,
      trailing,
      containerClassName,
      className,
      id,
      rows,
      type,
      // Mirrors `FormField`, which has defaulted this since it was written. A vault secret must
      // not be offered to the browser password manager, and `off` is overridden by browsers on
      // password-TYPE inputs, so a password field needs `new-password` specifically. Callers here
      // toggle visibility by flipping `type` between 'password' and 'text', and that is exactly
      // why the condition reads the type rather than a "is this secret" flag: revealed, the field
      // is type=text, where plain `off` IS honoured. A caller that wants autofill still overrides.
      autoComplete = type === 'password' ? 'new-password' : 'off',
      'data-testid': dataTestId,
      ...rest
    },
    forwardedRef
  ) => {
    const autoId = useId();
    const fieldId = id ?? autoId;
    const hintId = `${fieldId}-hint`;
    const errorId = `${fieldId}-error`;
    const invalid = Boolean(error);
    const describedBy = error ? errorId : hint ? hintId : undefined;

    // A single callback ref forwarded to whichever tag renders, so the caller's ref (typed as the
    // union) can be handed straight to a concrete `<input>`/`<textarea>` ref prop without `as`.
    const setRef = useCallback(
      (node: TextFieldElement | null) => {
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef]
    );

    const fieldClassName = cn(
      // 16px minimum: anything smaller makes iOS zoom the page on focus.
      'w-full min-w-0 resize-none bg-transparent font-sans text-base text-ink outline-none',
      'placeholder:text-muted',
      className
    );

    const trailingSlot = trailing ? (
      <div className={cn('flex shrink-0 flex-wrap items-center gap-1.5', !multiline && 'ml-2')}>{trailing}</div>
    ) : null;

    return (
      <div className={cn('flex w-full flex-col gap-1.5', containerClassName)}>
        {label && (
          <label htmlFor={fieldId} className="font-sans text-[13px] leading-[17px] font-bold text-muted">
            {label}
          </label>
        )}

        <div className={fieldVariants({ multiline: Boolean(multiline), invalid })}>
          {multiline ? (
            <textarea
              ref={setRef}
              id={fieldId}
              rows={rows ?? 2}
              value={value}
              defaultValue={defaultValue}
              onChange={onChange}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              data-testid={dataTestId}
              className={fieldClassName}
              autoComplete={autoComplete}
              {...rest}
            />
          ) : (
            <input
              ref={setRef}
              id={fieldId}
              type={type}
              value={value}
              defaultValue={defaultValue}
              onChange={onChange}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              data-testid={dataTestId}
              className={fieldClassName}
              autoComplete={autoComplete}
              {...rest}
            />
          )}

          {trailingSlot}
        </div>

        {error ? (
          <p
            id={errorId}
            role="alert"
            data-testid={errorTestId}
            className="text-[13px] leading-[17px] text-negative-ink"
          >
            {error}
          </p>
        ) : hint ? (
          <p id={hintId} className="text-[13px] leading-[17px] text-muted">
            {hint}
          </p>
        ) : null}
      </div>
    );
  }
);

TextField.displayName = 'TextField';

export default TextField;

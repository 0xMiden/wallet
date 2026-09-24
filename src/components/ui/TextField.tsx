import React, {
  forwardRef,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState
} from 'react';

import { cva } from 'class-variance-authority';
import { useTranslation } from 'react-i18next';

// The svg module directly, never the `app/icons/v2` barrel: TextField is imported by almost
// every screen, and the barrel's module graph evaluates ahead of a suite's own module
// mock factories — Developer settings reads `MIDEN_NETWORK_NAME` out of one of them.
import { ReactComponent as EyeOffIcon } from 'app/icons/v2/eye-off.svg';
import { cn } from 'lib/ui/util';

/** The element a `TextField` ref resolves to — an `<input>` or a `<textarea>`, chosen by `multiline`. */
export type TextFieldElement = HTMLInputElement | HTMLTextAreaElement;

// The native attributes both tags share. `onChange`/`value`/`defaultValue` are redeclared below
// against the shared element type instead of the per-tag event types the two native interfaces
// disagree on, and `size` is dropped because `<input>`'s numeric `size` and `<textarea>`'s enum
// `size` variant name collide with nothing we want to expose here.
type SharedFieldAttrs = Omit<
  InputHTMLAttributes<HTMLInputElement> & TextareaHTMLAttributes<HTMLTextAreaElement>,
  'onChange' | 'onFocus' | 'onBlur' | 'value' | 'defaultValue' | 'size'
>;

export interface TextFieldProps extends SharedFieldAttrs {
  value?: string;
  defaultValue?: string;
  onChange?: (event: React.ChangeEvent<TextFieldElement>) => void;
  onFocus?: (event: React.FocusEvent<TextFieldElement>) => void;
  onBlur?: (event: React.FocusEvent<TextFieldElement>) => void;
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
  /** Single-line only: a short `muted` prefix inside the field before the text, such as a seed word's number. */
  leading?: ReactNode;
  /**
   * Key material: cover the value whenever the field is not focused, and give up focus after
   * `SECRET_REVEAL_MS` or as soon as the window loses it. A private key typed, pasted or revealed
   * is on screen only while someone is deliberately looking at it.
   */
  secret?: boolean;
  containerClassName?: string;
  'data-testid'?: string;
}

/** How long a revealed secret stays revealed before the field hands focus back. */
export const SECRET_REVEAL_MS = 30_000;

/**
 * The cover over a `secret` field's value while nobody is looking at it. Its own component so
 * that `TextField` — which almost every screen renders — does not pull `useTranslation` into
 * every one of their tests for a string only key material ever shows.
 *
 * Over the field, not instead of it: the value stays where it is, so a tap lands the caret where
 * it was aimed. Frosted rather than dimmed, because the job is to make characters unreadable,
 * which a `scrim` would not do.
 */
const SecretCover: React.FC<{ multiline: boolean; onReveal: () => void }> = ({ multiline, onReveal }) => {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      data-slot="secret-cover"
      onClick={onReveal}
      className={cn(
        'absolute inset-0 flex cursor-text flex-col items-center justify-center gap-1',
        'bg-page/60 backdrop-blur-sm',
        multiline ? 'rounded-lg-token' : 'rounded-full'
      )}
    >
      <EyeOffIcon aria-hidden="true" className="h-5 w-5 text-muted" />
      <span className="text-caption text-muted">{t('clickToRevealField')}</span>
    </button>
  );
};

const fieldVariants = cva('relative flex w-full bg-fill text-ink transition-shadow duration-150', {
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
      leading,
      secret,
      containerClassName,
      className,
      id,
      rows,
      onFocus,
      onBlur,
      autoComplete,
      spellCheck,
      autoCorrect,
      autoCapitalize,
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

    // The cover needs to know whether there is anything to hide. A controlled field says so
    // directly; an uncontrolled one (a `register`ed field) has no prop that tracks its live value,
    // so we mirror it ourselves, seeded from defaultValue and updated on every change.
    const fieldRef = useRef<TextFieldElement | null>(null);
    const [focused, setFocused] = useState(false);
    const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue ?? '');
    const hasValue = value !== undefined ? value !== '' : uncontrolledValue !== '';
    const covered = Boolean(secret) && hasValue && !focused;

    // A revealed secret gives itself back: after half a minute, or the moment the window goes
    // away (a screenshot, a task switch, another app on top). A mobile app switch can hide the
    // document without blurring the window, and the app-switcher snapshot is taken then.
    useEffect(() => {
      if (!secret || !focused) return undefined;
      const hide = () => fieldRef.current?.blur();
      const hideIfHidden = () => {
        if (document.visibilityState === 'hidden') hide();
      };
      const timer = setTimeout(hide, SECRET_REVEAL_MS);
      window.addEventListener('blur', hide);
      window.addEventListener('pagehide', hide);
      document.addEventListener('visibilitychange', hideIfHidden);
      return () => {
        clearTimeout(timer);
        window.removeEventListener('blur', hide);
        window.removeEventListener('pagehide', hide);
        document.removeEventListener('visibilitychange', hideIfHidden);
      };
    }, [secret, focused]);

    // Autofill, form memory, spellcheck and autocorrect would each hand key material to something
    // outside the field (a saved-form store, a dictionary, a spelling service).
    const textAssist = secret
      ? { autoComplete: 'off', spellCheck: false, autoCorrect: 'off', autoCapitalize: 'none' }
      : { autoComplete, spellCheck, autoCorrect, autoCapitalize };

    // A single callback ref forwarded to whichever tag renders, so the caller's ref (typed as the
    // union) can be handed straight to a concrete `<input>`/`<textarea>` ref prop without `as`.
    const setRef = useCallback(
      (node: TextFieldElement | null) => {
        fieldRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef]
    );

    const handleChange = useCallback(
      (event: React.ChangeEvent<TextFieldElement>) => {
        setUncontrolledValue(event.target.value);
        onChange?.(event);
      },
      [onChange]
    );

    const handleFocus = useCallback(
      (event: React.FocusEvent<TextFieldElement>) => {
        setFocused(true);
        onFocus?.(event);
      },
      [onFocus]
    );

    const handleBlur = useCallback(
      (event: React.FocusEvent<TextFieldElement>) => {
        setFocused(false);
        onBlur?.(event);
      },
      [onBlur]
    );

    const fieldClassName = cn(
      // 16px minimum: anything smaller makes iOS zoom the page on focus.
      'w-full min-w-0 resize-none bg-transparent text-body text-ink outline-none',
      'placeholder:text-muted',
      className
    );

    const trailingSlot = trailing ? (
      <div className={cn('flex shrink-0 flex-wrap items-center gap-1.5', !multiline && 'ml-2')}>{trailing}</div>
    ) : null;

    return (
      <div className={cn('flex w-full flex-col gap-1.5', containerClassName)}>
        {label && (
          <label htmlFor={fieldId} className="text-label text-muted">
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
              onChange={handleChange}
              onFocus={handleFocus}
              onBlur={handleBlur}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              {...textAssist}
              data-testid={dataTestId}
              className={fieldClassName}
              {...rest}
            />
          ) : (
            <>
              {leading && (
                <span aria-hidden="true" className="mr-2 shrink-0 text-body text-muted tabular-nums">
                  {leading}
                </span>
              )}
              <input
                ref={setRef}
                id={fieldId}
                value={value}
                defaultValue={defaultValue}
                onChange={handleChange}
                onFocus={handleFocus}
                onBlur={handleBlur}
                aria-invalid={invalid}
                aria-describedby={describedBy}
                {...textAssist}
                data-testid={dataTestId}
                className={fieldClassName}
                {...rest}
              />
            </>
          )}

          {trailingSlot}

          {covered && <SecretCover multiline={Boolean(multiline)} onReveal={() => fieldRef.current?.focus()} />}
        </div>

        {error ? (
          <p id={errorId} role="alert" data-testid={errorTestId} className="text-caption text-negative-ink">
            {error}
          </p>
        ) : hint ? (
          <p id={hintId} className="text-caption text-muted">
            {hint}
          </p>
        ) : null}
      </div>
    );
  }
);

TextField.displayName = 'TextField';

export default TextField;

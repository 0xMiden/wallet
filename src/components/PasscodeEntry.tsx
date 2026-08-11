import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Numpad } from 'components/Numpad';
import { cn } from 'lib/ui/util';

export const PASSCODE_LENGTH = 6;

export interface PasscodeEntryProps {
  /** Fired shortly after the sixth digit is entered. */
  onSubmit: (code: string) => void;
  /** Fired on every keypad press with the current value (e.g. to clear a stale error upstream). */
  onChange?: (code: string) => void;
  /** Non-null shows a red hint under the dots and clears the entered digits. */
  error?: string | null;
  /** Hint under the dots when there is no error; defaults to "Enter your 6-digit code". */
  subtitle?: string;
  disabled?: boolean;
  isSubmitting?: boolean;
  className?: string;
}

/**
 * Six-dot passcode entry over the numeric keypad, for flows where the vault
 * secret is the 6-digit passcode (mobile wallets) rather than a typed
 * password. Auto-submits once all six digits are entered.
 */
export const PasscodeEntry: React.FC<PasscodeEntryProps> = ({
  onSubmit,
  onChange,
  error,
  subtitle,
  disabled = false,
  isSubmitting = false,
  className
}) => {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  // Synchronous mirror of `code`, updated inside the tap handlers so that several
  // digits tapped within one React batch (fast typing) each append to the latest
  // value rather than a stale closure — otherwise all but the last are dropped (#468).
  const codeRef = useRef('');
  // Remembers the code we've already auto-submitted so that a parent re-render
  // before the digits are cleared (e.g. an attempt-counter bump on a failed
  // unlock, or a fresh inline onSubmit identity) cannot re-fire the same
  // passcode. Guarantees exactly one submit per distinct completed code.
  const submittedCodeRef = useRef<string | null>(null);

  useEffect(() => {
    if (error) {
      setCode('');
      codeRef.current = '';
    }
  }, [error]);

  useEffect(() => {
    if (code.length < PASSCODE_LENGTH) {
      submittedCodeRef.current = null;
      return undefined;
    }
    if (isSubmitting || disabled || submittedCodeRef.current === code) {
      return undefined;
    }
    const timer = setTimeout(() => {
      submittedCodeRef.current = code;
      onSubmit(code);
    }, 150);
    return () => clearTimeout(timer);
  }, [code, isSubmitting, disabled, onSubmit]);

  const handleDigit = useCallback(
    (digit: string) => {
      if (disabled || isSubmitting || codeRef.current.length >= PASSCODE_LENGTH) return;
      const next = codeRef.current + digit;
      codeRef.current = next;
      setCode(next);
      onChange?.(next);
    },
    [disabled, isSubmitting, onChange]
  );

  const handleDelete = useCallback(() => {
    if (disabled || isSubmitting) return;
    const next = codeRef.current.slice(0, -1);
    codeRef.current = next;
    setCode(next);
    onChange?.(next);
  }, [disabled, isSubmitting, onChange]);

  const hint = error ?? subtitle ?? t('enterYour6DigitCode');

  return (
    <div
      role="group"
      aria-label={subtitle ?? t('enterYour6DigitCode')}
      className={cn('flex flex-col items-center', className)}
      data-testid="passcode-entry"
    >
      <div className="flex items-center gap-3.5" aria-hidden="true">
        {Array.from({ length: PASSCODE_LENGTH }).map((_, index) => {
          const filled = index < code.length;
          return (
            <div
              key={index}
              className={cn('w-3.5 h-3.5 rounded-full border-2 border-[#C7C7CC]', filled && 'bg-[#C7C7CC]')}
            />
          );
        })}
      </div>
      <p
        role="status"
        aria-live="polite"
        className={cn('min-h-5 text-sm text-center mt-3', error ? 'text-red-500' : 'text-text-muted')}
      >
        {hint}
      </p>
      <Numpad className="mt-6" onDigit={handleDigit} onDelete={handleDelete} />
    </div>
  );
};

export default PasscodeEntry;

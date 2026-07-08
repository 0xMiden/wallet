import React, { useCallback, useEffect, useState } from 'react';

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

  useEffect(() => {
    if (error) setCode('');
  }, [error]);

  useEffect(() => {
    if (code.length === PASSCODE_LENGTH && !isSubmitting && !disabled) {
      const timer = setTimeout(() => onSubmit(code), 150);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [code, isSubmitting, disabled, onSubmit]);

  const handleDigit = useCallback(
    (digit: string) => {
      if (disabled || isSubmitting || code.length >= PASSCODE_LENGTH) return;
      const next = code + digit;
      setCode(next);
      onChange?.(next);
    },
    [disabled, isSubmitting, code, onChange]
  );

  const handleDelete = useCallback(() => {
    if (disabled || isSubmitting) return;
    const next = code.slice(0, -1);
    setCode(next);
    onChange?.(next);
  }, [disabled, isSubmitting, code, onChange]);

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

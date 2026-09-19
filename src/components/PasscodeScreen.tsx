import React from 'react';

import { Numpad } from 'components/Numpad';
import { PasscodeDots } from 'components/PasscodeDots';
import { cn } from 'lib/ui/util';

export interface PasscodeScreenProps {
  title: string;
  /** The line under the title: the instruction, or the error / lockout message when `isError`. */
  message: string;
  isError?: boolean;
  /** How many digits are entered. */
  filled: number;
  length: number;
  /** Bumped on each rejected code; see `PasscodeDots`. */
  errorKey?: number;
  onDigit: (digit: string) => void;
  onDelete: () => void;
  /** Biometric key in the keypad's bottom-left slot, where a biometric unlock is available. */
  onBiometric?: () => void;
  biometricLabel?: string;
  /** A text action centred under the keypad (unlock's "Forgot passcode?"). */
  action?: React.ReactNode;
  'data-testid'?: string;
}

/**
 * A full-screen passcode page, laid out for the thumb like the iOS lock screen: the title, the
 * message and the dots sit in the upper part, the keypad is anchored to the bottom with its last
 * row 20px above the safe area, and the free height goes between the two. An action goes under the
 * keypad, in the space that padding held: 8px below the last row, a 44px hit area, then 8px above
 * the safe area, so the keypad rises only 40px to make room for it. Unlock and onboarding's
 * set-up/confirm steps both draw it, so both share one keypad and one layout.
 */
export const PasscodeScreen: React.FC<PasscodeScreenProps> = ({
  title,
  message,
  isError = false,
  filled,
  length,
  errorKey,
  onDigit,
  onDelete,
  onBiometric,
  biometricLabel,
  action,
  'data-testid': dataTestId
}) => (
  <div className="bg-page h-full overflow-y-auto select-none" data-testid={dataTestId}>
    <div
      className={cn('min-h-full flex flex-col items-center px-4', action ? 'pb-2' : 'pb-5')}
      data-testid="passcode-screen-layout"
    >
      <div className="flex flex-col items-center w-full shrink-0 pt-12 [@media(max-height:720px)]:pt-6">
        <h1 className="font-heading text-2xl leading-7 font-black text-ink text-center">{title}</h1>
        <p
          role="status"
          aria-live="polite"
          className={cn(
            'mt-2 min-h-6 text-base text-center wrap-break-word',
            isError ? 'text-negative-ink' : 'text-muted'
          )}
        >
          {message}
        </p>
        <PasscodeDots className="mt-7" filled={filled} length={length} errorKey={errorKey} />
      </div>
      <div className="mt-auto w-full shrink-0 pt-6" data-testid="passcode-keypad-dock">
        <Numpad onDigit={onDigit} onDelete={onDelete} onBiometric={onBiometric} biometricLabel={biometricLabel} />
        {action && (
          <div className="mt-2 flex justify-center" data-testid="passcode-screen-action">
            {action}
          </div>
        )}
      </div>
    </div>
  </div>
);

export default PasscodeScreen;

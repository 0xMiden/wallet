import React, { useEffect } from 'react';

import { motion } from 'framer-motion';

import { usePreset } from 'lib/animation';
import { hapticError } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

export interface PasscodeDotsProps {
  /** How many digits are entered. */
  filled: number;
  /** How many dots to draw. */
  length: number;
  /**
   * Bump it on every failed attempt (a wrong passcode, a mismatched confirmation, a failed biometric
   * retry): each new value shakes the row once. 0 never shakes.
   */
  errorKey?: number;
  /** Layout only (margins). */
  className?: string;
}

/**
 * The passcode's progress: one dot per digit, `hairline` while empty and `ink` once entered, each
 * popping in as it fills. A failed attempt shakes the whole row (the `shake` preset) with the error
 * haptic; under reduced motion the dots fill in place and nothing shakes, but the haptic still
 * fires.
 */
export const PasscodeDots: React.FC<PasscodeDotsProps> = ({ filled, length, errorKey = 0, className }) => {
  const pop = usePreset('pop');
  const shake = usePreset('shake');
  // Keying the row on the error count remounts it, which replays the shake from rest. The dots
  // are empty by then anyway: every caller clears the code when an attempt fails.
  const shaking = errorKey > 0 && shake.animate !== undefined;

  useEffect(() => {
    if (errorKey > 0) hapticError();
  }, [errorKey]);

  return (
    <motion.div
      key={errorKey}
      aria-hidden="true"
      className={cn('flex items-center gap-4', className)}
      animate={shaking ? shake.animate : undefined}
      transition={shake.transition}
      data-testid="passcode-dots"
      data-shake={shaking ? 'true' : undefined}
    >
      {Array.from({ length }).map((_, index) => {
        const isFilled = index < filled;
        return (
          <span
            key={index}
            className="relative size-3.5 rounded-full bg-hairline"
            data-testid="passcode-dot"
            data-filled={isFilled ? 'true' : 'false'}
          >
            {isFilled && (
              <motion.span
                className="absolute inset-0 rounded-full bg-ink"
                initial={{ ...pop.initial, scale: 0.5 }}
                animate={pop.animate}
                transition={pop.transition}
              />
            )}
          </span>
        );
      })}
    </motion.div>
  );
};

export default PasscodeDots;

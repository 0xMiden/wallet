import React from 'react';

import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { colorTransitionClass, usePreset } from 'lib/animation';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

export interface NumpadProps {
  onDigit: (digit: string) => void;
  onDelete: () => void;
  /**
   * Draws a biometric (Face ID / Touch ID) key in the bottom-left slot. Pass it only where a
   * biometric unlock is available and enabled; without it the slot stays empty.
   */
  onBiometric?: () => void;
  /** Layout only (margins). */
  className?: string;
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

// A viewport under 720px tall (iPhone SE at 667, the 600px extension popup, small Android) steps
// the pad down a size so it still fits under the header without scrolling. The variant is spelled
// out in full in each class string: Tailwind finds classes by scanning source text, so a class
// assembled from a template literal would never be generated.

/**
 * One key's box: 76px, 64px on a short viewport. Round, like every control in the design system
 * (Radii: `full` for controls).
 */
const NUMPAD_KEY_SIZE = 'size-19 [@media(max-height:720px)]:size-16';

/** 28px between columns and 16px between rows; 24 / 12px on a short viewport. */
const NUMPAD_GAPS = 'gap-x-7 gap-y-4 [@media(max-height:720px)]:gap-x-6 [@media(max-height:720px)]:gap-y-3';

const keyBase = cn(
  NUMPAD_KEY_SIZE,
  'flex items-center justify-center rounded-full select-none outline-none touch-manipulation',
  colorTransitionClass,
  'focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-page'
);

/** A digit: `fill`, `fill-pressed` while held, the digit in the entry display type (32px, 800). */
const digitKeyClass = cn(
  keyBase,
  'bg-fill text-ink active:bg-fill-pressed font-heading text-[32px] leading-none font-extrabold'
);

/** Backspace and biometric: a bare glyph, but the same hit area as a digit. */
const bareKeyClass = cn(keyBase, 'text-ink active:bg-fill');

interface KeyProps {
  label?: string;
  testId: string;
  className: string;
  onPress: () => void;
  children: React.ReactNode;
}

const Key: React.FC<KeyProps> = ({ label, testId, className, onPress, children }) => {
  const press = usePreset('press');
  return (
    <motion.button
      type="button"
      aria-label={label}
      className={className}
      whileTap={press.whileTap}
      transition={press.transition}
      onClick={() => {
        hapticLight();
        onPress();
      }}
      data-testid={testId}
    >
      {children}
    </motion.button>
  );
};

/**
 * The passcode keypad. Every screen that takes the 6-digit passcode draws this one: unlock,
 * onboarding's set-up and confirm steps (both through `PasscodeScreen`) and `PasscodeEntry` in
 * sheets. Twelve slots in a 3 × 4 grid: 1–9, then the biometric key (or an empty slot), 0 and
 * backspace. Every key fires the light tap haptic.
 */
export const Numpad: React.FC<NumpadProps> = ({ onDigit, onDelete, onBiometric, className }) => {
  const { t } = useTranslation();

  return (
    <div className={cn('grid grid-cols-3 w-fit mx-auto', NUMPAD_GAPS, className)} data-testid="numpad">
      {DIGITS.map(digit => (
        <Key key={digit} testId={`numpad-${digit}`} className={digitKeyClass} onPress={() => onDigit(digit)}>
          {digit}
        </Key>
      ))}
      {onBiometric ? (
        <Key label={t('useFaceIdOrBiometric')} testId="numpad-biometric" className={bareKeyClass} onPress={onBiometric}>
          <Icon name={IconName.FaceId} size="lg" />
        </Key>
      ) : (
        <div aria-hidden="true" className={NUMPAD_KEY_SIZE} data-testid="numpad-spacer" />
      )}
      <Key testId="numpad-0" className={digitKeyClass} onPress={() => onDigit('0')}>
        0
      </Key>
      <Key label={t('delete')} testId="numpad-delete" className={bareKeyClass} onPress={onDelete}>
        <Icon name={IconName.Backspace} size="lg" />
      </Key>
    </div>
  );
};

export default Numpad;

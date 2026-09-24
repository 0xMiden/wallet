import React, { HTMLAttributes } from 'react';

import classNames from 'clsx';
import { motion, useReducedMotion } from 'framer-motion';

import { ACCENT_CLASSES, FlowAccent } from 'components/flow/accent';
import { colorTransitionClass, presets, resolveTransition } from 'lib/animation';
import { hapticMedium } from 'lib/mobile/haptics';
import { isExtension } from 'lib/platform';

export interface ToggleProps extends HTMLAttributes<HTMLDivElement> {
  className?: string;
  value?: boolean;
  disabled?: boolean;
  /**
   * The flow this toggle sits in (design-system.md, "Action colours"): a swap row's toggle is the
   * swap purple, not the brand orange. Defaults to the brand, which a settings row keeps.
   */
  accent?: FlowAccent;
  onChangeValue?: (value: boolean) => void;
}

export const Toggle: React.FC<ToggleProps> = ({
  className,
  value = false,
  disabled = false,
  accent = 'brand',
  onChangeValue,
  ...props
}) => {
  const reduceMotion = useReducedMotion();
  const accentClasses = ACCENT_CLASSES[accent];
  const toggleSwitch = () => {
    if (!disabled && onChangeValue) {
      hapticMedium();
      onChangeValue(!value);
    }
  };

  return (
    <div
      className={classNames(
        'w-10 h-5 rounded-full cursor-pointer flex border items-center px-1',
        value && classNames('justify-end', accentClasses.bg, accentClasses.border),
        {
          'justify-start bg-white border-border-light': !value,
          'opacity-50 cursor-not-allowed': disabled
        },
        className
      )}
      onClick={toggleSwitch}
      {...props}
    >
      {/* The thumb's colour is a class, not a framer `animate` target: the accent it takes is a
          theme token, and animating to one would mean pinning a literal hex per flow. The position
          still springs; the colour cross-fades on the shared CSS micro-interaction. */}
      <motion.div
        className={classNames(
          'w-3 h-3 rounded-full',
          colorTransitionClass,
          value ? classNames('bg-current', accentClasses.on) : accentClasses.bg
        )}
        layout={!isExtension()}
        transition={isExtension() ? { duration: 0 } : resolveTransition(reduceMotion, presets.press.transition)}
      />
    </div>
  );
};

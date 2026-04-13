import React, { HTMLAttributes } from 'react';

import classNames from 'clsx';
import { motion } from 'framer-motion';

import { hapticMedium } from 'lib/mobile/haptics';
import { isExtension } from 'lib/platform';
import { PRIMARY_HEX } from 'utils/brand-colors';

export interface ToggleProps extends HTMLAttributes<HTMLDivElement> {
  className?: string;
  value?: boolean;
  disabled?: boolean;
  onChangeValue?: (value: boolean) => void;
}

export const Toggle: React.FC<ToggleProps> = ({
  className,
  value = false,
  disabled = false,
  onChangeValue,
  ...props
}) => {
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
        {
          'justify-end bg-primary-500 border-primary-500': value,
          'justify-start bg-white border-grey-200': !value,
          'opacity-50 cursor-not-allowed': disabled
        },
        className
      )}
      onClick={toggleSwitch}
      {...props}
    >
      <motion.div
        className={classNames('w-3 h-3 rounded-full', {
          'bg-white': value,
          'bg-primary-500': !value
        })}
        animate={{ backgroundColor: value ? '#ffffff' : PRIMARY_HEX }}
        layout={!isExtension()}
        transition={
          isExtension()
            ? { duration: 0 }
            : {
                type: 'spring',
                stiffness: 700,
                damping: 30,
                backgroundColor: { duration: 0.2 }
              }
        }
      />
    </div>
  );
};

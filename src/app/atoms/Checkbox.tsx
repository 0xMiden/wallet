import React, { forwardRef, InputHTMLAttributes, useCallback, useEffect, useState } from 'react';

import classNames from 'clsx';

import { ReactComponent as CheckmarkIcon } from 'app/icons/checkmark.svg';
import { hapticMedium } from 'lib/mobile/haptics';
import { blurHandler, checkedHandler, focusHandler } from 'lib/ui/inputHandlers';

type CheckboxProps = InputHTMLAttributes<HTMLInputElement> & {
  containerClassName?: string;
  errored?: boolean;
};

const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ containerClassName, errored = false, className, checked, onChange, onFocus, onBlur, ...rest }, ref) => {
    const [localChecked, setLocalChecked] = useState(() => checked ?? false);

    useEffect(() => {
      setLocalChecked(prevChecked => checked ?? prevChecked);
    }, [setLocalChecked, checked]);

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        hapticMedium();
        checkedHandler(e, onChange!, setLocalChecked);
      },
      [onChange, setLocalChecked]
    );

    /**
     * Focus handling
     */
    const [localFocused, setLocalFocused] = useState(false);

    const handleFocus = useCallback(
      (e: React.FocusEvent<HTMLInputElement>) => focusHandler(e, onFocus!, setLocalFocused),
      [onFocus, setLocalFocused]
    );
    const handleBlur = useCallback(
      (e: React.FocusEvent<HTMLInputElement>) => blurHandler(e, onBlur!, setLocalFocused),
      [onBlur, setLocalFocused]
    );

    return (
      <div
        className={classNames(
          'h-6 w-6 shrink-0',
          localChecked ? 'bg-primary-orange' : 'bg-black-40',
          'border',
          (() => {
            switch (true) {
              case localChecked:
                return 'border-primary-orange-dark';

              case localFocused:
                return 'border-primary-orange';

              case Boolean(errored):
                return 'border-red-400';

              default:
                return 'border-gray-400';
            }
          })(),
          'rounded-sm overflow-hidden',
          'disable-outline-for-click',
          localFocused && 'shadow-outline',
          'transition ease-in-out duration-200',
          'text-white',
          'flex justify-center items-center',
          containerClassName
        )}
      >
        <input
          ref={ref}
          type="checkbox"
          className={classNames('sr-only', className)}
          checked={localChecked}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          {...rest}
        />

        <CheckmarkIcon
          className={classNames(localChecked ? 'block' : 'hidden', 'h-4 w-4', 'pointer-events-none', 'stroke-current')}
          style={{ strokeWidth: 2 }}
        />
      </div>
    );
  }
);

export default Checkbox;

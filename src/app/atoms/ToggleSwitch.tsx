import React, { forwardRef, InputHTMLAttributes, useCallback, useEffect, useState } from 'react';

import classNames from 'clsx';

import { AnalyticsEventCategory, TestIDProps, useAnalytics } from 'lib/analytics';
import { hapticMedium } from 'lib/mobile/haptics';
import { checkedHandler } from 'lib/ui/inputHandlers';

type ToggleSwitchProps = InputHTMLAttributes<HTMLInputElement> &
  TestIDProps & {
    containerClassName?: string;
    errored?: boolean;
  };

const ToggleSwitch = forwardRef<HTMLInputElement, ToggleSwitchProps>(
  (
    {
      containerClassName,
      errored = false,
      testID,
      testIDProperties,
      className,
      checked,
      onChange,
      onFocus,
      onBlur,
      ...rest
    },
    ref
  ) => {
    const [localChecked, setLocalChecked] = useState(() => checked ?? false);
    const { trackEvent } = useAnalytics();

    useEffect(() => {
      setLocalChecked(prevChecked => checked ?? prevChecked);
    }, [setLocalChecked, checked]);

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        hapticMedium();
        testID !== undefined && trackEvent(testID, AnalyticsEventCategory.Toggle, testIDProperties);
        checkedHandler(e, onChange!, setLocalChecked);
      },
      [onChange, setLocalChecked, trackEvent, testID, testIDProperties]
    );

    return (
      <div
        className={classNames('relative inline-flex shrink-0 align-middle select-none', containerClassName)}
        style={{ width: '48px', height: '24px', minWidth: '48px' }}
      >
        {/* Track - visual only, no pointer events */}
        <div
          className="rounded-full transition-colors duration-200 ease-in-out"
          style={{
            width: '48px',
            height: '24px',
            backgroundColor: localChecked ? '#F97316' : '#FFFFFF',
            border: localChecked ? 'none' : '2px solid #E5E7EB',
            pointerEvents: 'none'
          }}
        >
          {/* Dot */}
          <div
            className="absolute rounded-full transition-all duration-200 ease-in-out"
            style={{
              width: '16px',
              height: '16px',
              top: '4px',
              left: localChecked ? '28px' : '4px',
              backgroundColor: localChecked ? '#FFFFFF' : '#F97316',
              pointerEvents: 'none'
            }}
          />
        </div>
        {/* Invisible input on top for click handling */}
        <input
          ref={ref}
          type="checkbox"
          className={classNames('absolute appearance-none cursor-pointer opacity-0', className)}
          style={{ width: '48px', height: '24px', top: 0, left: 0, zIndex: 10 }}
          checked={localChecked}
          onChange={handleChange}
          {...rest}
        />
      </div>
    );
  }
);

export default ToggleSwitch;

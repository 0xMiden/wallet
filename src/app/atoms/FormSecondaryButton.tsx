import React, { ButtonHTMLAttributes, FC } from 'react';

import classNames from 'clsx';

import Spinner from 'app/atoms/Spinner/Spinner';
import { Button, ButtonVariant } from 'components/Button';
import { AnalyticsEventCategory, TestIDProps, useAnalytics } from 'lib/analytics';

type FormSecondaryButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  TestIDProps & {
    loading?: boolean;
    small?: boolean;
  };

const FormSecondaryButton: FC<FormSecondaryButtonProps> = ({
  loading,
  small,
  type = 'button',
  disabled,
  className,
  style,
  children,
  onClick,
  testID,
  testIDProperties,
  ...rest
}) => {
  const { trackEvent } = useAnalytics();

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    testID !== undefined && trackEvent(testID, AnalyticsEventCategory.ButtonPress, testIDProperties);
    onClick?.(e);
  };

  return (
    <Button
      variant={ButtonVariant.Ghost}
      type={type}
      className={classNames(
        'relative h-auto w-auto max-w-none',
        small ? 'px-6' : 'px-8',
        'bg-white hover:bg-white rounded-3xl',
        'border-2 border-primary-orange',
        'flex items-center',
        loading ? 'text-transparent' : 'text-primary-orange',
        small ? 'text-sm' : 'text-black',
        'font-semibold',
        loading || disabled ? 'opacity-75' : 'opacity-90 hover:opacity-100',
        loading || disabled ? 'shadow-inner pointer-events-none' : 'shadow-sm hover:shadow focus:shadow',
        className
      )}
      style={{
        paddingTop: small ? '0.5rem' : '0.625rem',
        paddingBottom: small ? '0.5rem' : '0.625rem',
        ...style
      }}
      disabled={disabled}
      onClick={handleClick}
      {...rest}
    >
      {children}

      {loading && (
        <div className={classNames('absolute inset-0', 'flex items-center justify-center')}>
          <Spinner />
        </div>
      )}
    </Button>
  );
};

export default FormSecondaryButton;

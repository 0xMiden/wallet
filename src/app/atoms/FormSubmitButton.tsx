import React, { ButtonHTMLAttributes, FC } from 'react';

import classNames from 'clsx';

import Spinner from 'app/atoms/Spinner/Spinner';
import { TestIDProps } from 'lib/analytics';
import useTippy from 'lib/ui/useTippy';

import { Button } from './Button';

type FormSubmitButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  TestIDProps & {
    loading?: boolean;
    small?: boolean;
    tooltip?: string;
  };

const FormSubmitButton: FC<FormSubmitButtonProps> = ({
  loading,
  small,
  tooltip,
  disabled,
  className,
  style,
  children,
  ...rest
}) => {
  const tippyProps = { ...tippyPropsMock, content: tooltip };
  const spanRef = useTippy<HTMLSpanElement>(tippyProps);
  const button = (
    <Button
      className={classNames(
        'relative py-4.5 text-base',
        small ? 'px-6' : 'px-8',
        'rounded-10',
        'bg-primary-500',
        'flex items-center',
        loading ? 'text-transparent' : 'text-white',
        'font-semibold',
        'transition duration-200 ease-in-out',
        loading || disabled ? 'opacity-60' : 'hover:opacity-90 focus:opacity-90',
        loading || disabled
          ? 'pointer-events-none'
          : 'hover:bg-linear-to-r hover:from-#472AA0 hover:from-0% hover:to-10%',
        className
      )}
      style={style}
      disabled={disabled}
      {...rest}
    >
      {children}

      {loading && (
        <div className={classNames('absolute inset-0', 'flex items-center justify-center')}>
          <Spinner color="#ffffff" />
        </div>
      )}
    </Button>
  );
  if (tooltip) {
    return <span ref={spanRef}>{button}</span>;
  }
  return button;
};

export default FormSubmitButton;

const tippyPropsMock = {
  trigger: 'mouseenter',
  hideOnClick: false,
  animation: 'shift-away-subtle'
};

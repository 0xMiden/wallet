import React, { ButtonHTMLAttributes, PropsWithChildren } from 'react';

import classNames from 'clsx';

import { TestIDProps } from 'lib/analytics';

import { Button } from './Button';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement>, TestIDProps, PropsWithChildren {
  additionalClassNames?: string;
}

const baseClassNames = classNames(
  'w-full justify-center',
  'py-3',
  'rounded-lg',
  'flex items-center',
  'text-base',
  'font-semibold',
  'transition duration-200 ease-in-out'
);

const primaryClassNames = classNames(baseClassNames, 'text-white bg-purple-950');
const secondaryClassNames = classNames(baseClassNames, 'bg-gray-800');

export const PrimaryButton = React.forwardRef<HTMLButtonElement, Props>(
  ({ additionalClassNames, children, disabled, ...props }, ref) => {
    return (
      <Button
        className={classNames(
          primaryClassNames,
          additionalClassNames,
          !disabled && 'hover:opacity-90 focus:opacity-90',
          disabled && 'opacity-75 pointer-events-none'
        )}
        {...props}
        ref={ref}
      >
        {children}
      </Button>
    );
  }
);

export const SecondaryButton = React.forwardRef<HTMLButtonElement, Props>(
  ({ additionalClassNames, children, disabled, ...props }, ref) => {
    return (
      <Button
        className={classNames(
          secondaryClassNames,
          additionalClassNames,
          !disabled && 'hover:bg-gray-300 active:bg-gray-100 text-black',
          disabled && 'pointer-events-none cursor-default text-gray-400'
        )}
        {...props}
        ref={ref}
      >
        {children}
      </Button>
    );
  }
);

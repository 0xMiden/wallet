import React, { forwardRef } from 'react';

import classNames from 'clsx';
import ICurrencyInput, { CurrencyInputProps as ICurrencyInputProps } from 'react-currency-input-field';

type Props = {
  label?: string;
  prefix?: string;
  icon?: React.ReactNode;
  containerClassName?: string;
  inputClassName?: string;
  labelClassName?: string;
  iconClassName?: string;
  id?: string;
  suffix?: string;
};

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement>, Props {}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    { label, prefix, icon, suffix, containerClassName, inputClassName, labelClassName, iconClassName, ...props },
    ref
  ) => {
    return (
      <div className={classNames('flex flex-col gap-2', containerClassName)}>
        {label && <label className={classNames('text-sm font-medium', labelClassName)}>{label}</label>}
        <div
          className={classNames(
            'relative',
            'flex flex-row items-center',
            'transition-colors duration-150 ease-hover',
            'overflow-hidden',
            'border border-border-light hover:border-border-light rounded-lg'
          )}
        >
          {prefix && (
            <div className="absolute inset-y-0 left-0 flex items-center">
              <span className="w-8 text-right text-text-muted text-base">{prefix}</span>
            </div>
          )}
          <input
            ref={ref}
            className={classNames(
              'flex-1',
              'py-3',
              'placeholder-grey-400',
              'text-base',
              'outline-none',
              prefix ? 'pl-10' : 'pl-4',
              suffix ? 'pr-2' : 'pr-4',
              inputClassName
            )}
            {...props}
          />
          {icon && (
            <div className={classNames('flex items-center justify-center', 'py-2 pr-2', iconClassName)}>{icon}</div>
          )}
          {suffix && <div className="flex text-heading-gray text-sm font-bold mr-4">{suffix}</div>}
        </div>
      </div>
    );
  }
);

type CurrencyInputProps = ICurrencyInputProps & Props;

export const CurrencyInput: React.FC<CurrencyInputProps> = ({
  label,
  icon,
  containerClassName,
  inputClassName,
  labelClassName,
  iconClassName,
  ...props
}) => {
  return (
    <div className={classNames('flex flex-col gap-2', containerClassName)}>
      {label && <label className={classNames('text-sm font-medium', labelClassName)}>{label}</label>}
      <div
        className={classNames(
          'flex flex-row items-center',
          'transition-colors duration-150 ease-hover',
          'overflow-hidden',
          'border border-border-light hover:border-border-light rounded-lg',
          'has-[:focus]:outline-none has-[:focus]:border-primary-500 has-[:focus]:ring-1 has-[:focus]:ring-primary-500'
        )}
      >
        <ICurrencyInput
          className={classNames(
            'flex-1',
            'pl-4 pr-2 py-3',
            'placeholder-grey-400',
            'text-base',
            'outline-none',
            // 'focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500',
            inputClassName
          )}
          {...props}
        />
        {icon && (
          <div className={classNames('flex items-center justify-center', 'py-2 pr-2', iconClassName)}>{icon}</div>
        )}
      </div>
    </div>
  );
};

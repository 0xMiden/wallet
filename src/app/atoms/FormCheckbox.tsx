import React, { ComponentProps, forwardRef, ReactNode } from 'react';

import classNames from 'clsx';

import Checkbox from 'app/atoms/Checkbox';

type FormCheckboxProps = ComponentProps<typeof Checkbox> & {
  label?: ReactNode;
  labelDescription?: ReactNode;
  errorCaption?: ReactNode;
  containerClassName?: string;
  labelClassName?: string;
};

const FormCheckbox = forwardRef<HTMLInputElement, FormCheckboxProps>(
  ({ label, labelDescription, errorCaption, containerClassName, labelClassName, ...rest }, ref) => (
    <div className={classNames('flex flex-col', containerClassName)}>
      <label className={classNames('p-4', 'overflow-hidden', 'cursor-pointer', 'flex items-center', labelClassName)}>
        <Checkbox ref={ref} errored={Boolean(errorCaption)} {...rest} />

        {label ? (
          <div className={classNames('ml-4', 'leading-tight', 'flex flex-col')}>
            <span className={classNames('text-sm font-semibold text-ink')}>{label}</span>

            {labelDescription && <span className={classNames('mt-1', 'text-sm text-ink')}>{labelDescription}</span>}
          </div>
        ) : null}
      </label>

      {errorCaption ? <div className="text-xs text-red-500">{errorCaption}</div> : null}
    </div>
  )
);

export default FormCheckbox;

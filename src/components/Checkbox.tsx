import React from 'react';

import classNames from 'clsx';

import { Icon, IconName } from 'app/icons/v2';

// import { ReactComponent as Icon } from 'app/icons/checkmark-2.svg';

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: boolean;
  onChange?: (value: boolean) => void;
}

const propsForStatus = {
  default: {
    backgroundColor: 'bg-white',
    border: 'border-2 border-grey-200 hover:border-grey-300'
  },
  checked: {
    backgroundColor: 'bg-primary-500 hover:bg-primary-600',
    border: 'border-0'
  },
  disabled: {
    backgroundColor: 'bg-grey-200',
    border: 'border-0'
  }
};

export const Checkbox: React.FC<CheckboxProps> = ({ value, onChange, ...props }) => {
  const backgroundColor = value ? propsForStatus.checked.backgroundColor : propsForStatus.default.backgroundColor;
  const borderWidth = value ? propsForStatus.checked.border : propsForStatus.default.border;
  return (
    <div
      className={classNames(
        backgroundColor,
        borderWidth,
        'transition duration-300 ease-in-out',
        'flex items-center justify-center p-1',
        'w-5 h-5 shrink-0 relative border-grey-100 rounded-xs'
      )}
    >
      <input
        type="checkbox"
        className="appearance-none absolute w-0 h-0 cursor-pointer"
        {...props}
        // onChange={e => {
        //   onChange?.(!e.target.checked);
        // }}
      />

      {value ? <Icon name={IconName.Checkmark} fill={'white'} size="xs" /> : null}
    </div>
  );
};

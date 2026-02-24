import React, { FC } from 'react';

import clsx from 'clsx';

import ToggleSwitch from 'app/atoms/ToggleSwitch';

interface SettingToggleProps {
  checked: boolean;
  onChange: (evt: React.ChangeEvent<HTMLInputElement>) => void;
  name: string;
  testID: string;
  title: string;
  description: string;
  className?: string;
}

const SettingToggle: FC<SettingToggleProps> = ({ checked, onChange, name, testID, title, description, className }) => {
  return (
    <div className={clsx('flex w-full flex-col items-center gap-4.25', className)}>
      <ToggleSwitch checked={checked} onChange={onChange} name={name} containerClassName="my-1" testID={testID} />
      <div className="flex flex-col gap-3.5">
        <label className="leading-tight flex flex-col" htmlFor={name}>
          <span className="font-medium my-1 text-[18px] text-center">{title}</span>
          <span className="mt-1 text-gray-400 text-center text-base" style={{ lineHeight: '16px' }}>
            {description}
          </span>
        </label>
      </div>
    </div>
  );
};

export default SettingToggle;

import React, { FC } from 'react';

import ToggleSwitch from 'app/atoms/ToggleSwitch';

interface SettingToggleProps {
  checked: boolean;
  onChange: (evt: React.ChangeEvent<HTMLInputElement>) => void;
  name: string;
  testID: string;
  title: string;
  description?: string;
}

const SettingToggle: FC<SettingToggleProps> = ({ checked, onChange, name, testID, title, description }) => {
  return (
    <div className="flex flex-col gap-y-2">
      <label htmlFor={name} className="flex items-center justify-between w-full">
        <span className="font-medium text-base leading-[130%] text-black">{title}</span>
        <ToggleSwitch checked={checked} onChange={onChange} name={name} testID={testID} />
      </label>
      {description && <span className="text-xs text-gray-400">{description}</span>}
    </div>
  );
};

export default SettingToggle;

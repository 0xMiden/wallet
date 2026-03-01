import React, { FC } from 'react';

import ToggleSwitch from 'app/atoms/ToggleSwitch';

interface SettingToggleProps {
  checked: boolean;
  onChange: (evt: React.ChangeEvent<HTMLInputElement>) => void;
  name: string;
  testID: string;
  title: string;
  description: string;
}

const SettingToggle: FC<SettingToggleProps> = ({ checked, onChange, name, testID, title, description }) => {
  return (
    <div className="flex items-center justify-between py-4 border-b border-[#E8E8E8] last:border-b-0">
      <label htmlFor={name} className="flex flex-col pr-4">
        <span className="font-medium text-sm text-[#0F131A]">{title}</span>
        <span className="text-xs text-[#555D6D] mt-1">{description}</span>
      </label>
      <ToggleSwitch checked={checked} onChange={onChange} name={name} testID={testID} />
    </div>
  );
};

export default SettingToggle;

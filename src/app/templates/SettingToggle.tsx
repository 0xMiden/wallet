import React, { FC } from 'react';

import ToggleSwitch from 'app/atoms/ToggleSwitch';
import { ListRow } from 'components/ui/ListRow';

interface SettingToggleProps {
  checked: boolean;
  onChange: (evt: React.ChangeEvent<HTMLInputElement>) => void;
  name: string;
  testID: string;
  title: string;
}

/**
 * A setting that is a switch: a `ListRow` titled with the setting, the switch trailing, and the
 * whole row its label, so a tap anywhere on it flips the switch. Goes in a `ListGroup`; what the
 * setting does belongs in the section's footnote, where it can wrap.
 *
 * The switch is still `ToggleSwitch` (a real checkbox, so `data-testid` and `checked` are what the
 * E2E helpers read) until the design system's Radix `Toggle` lands.
 */
const SettingToggle: FC<SettingToggleProps> = ({ checked, onChange, name, testID, title }) => (
  <ListRow
    title={title}
    htmlFor={name}
    trailing={<ToggleSwitch id={name} checked={checked} onChange={onChange} name={name} testID={testID} />}
  />
);

export default SettingToggle;

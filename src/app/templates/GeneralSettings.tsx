import React, { FC, useCallback, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { isMobile } from 'lib/platform';
import {
  isAutoConsumeEnabled,
  isDelegateProofEnabled,
  isHapticFeedbackEnabled,
  setAutoConsumeSetting,
  setDelegateProofSetting,
  setHapticFeedbackSetting
} from 'lib/settings/helpers';

import { GeneralSettingsSelectors } from './GeneralSettings.selectors';
import SettingToggle from './SettingToggle';

const GeneralSettings: FC = () => {
  const { t } = useTranslation();
  const mobile = isMobile();

  const delegateEnabled = isDelegateProofEnabled();
  const delegateChangingRef = useRef(false);
  const handleDelegateChange = useCallback((evt: React.ChangeEvent<HTMLInputElement>) => {
    if (delegateChangingRef.current) return;
    delegateChangingRef.current = true;
    setDelegateProofSetting(evt.target.checked);
    delegateChangingRef.current = false;
  }, []);

  const consumeEnabled = isAutoConsumeEnabled();
  const consumeChangingRef = useRef(false);
  const handleAutoConsumeChange = useCallback((evt: React.ChangeEvent<HTMLInputElement>) => {
    if (consumeChangingRef.current) return;
    consumeChangingRef.current = true;
    setAutoConsumeSetting(evt.target.checked);
    consumeChangingRef.current = false;
  }, []);

  const [hapticEnabled, setHapticEnabled] = useState(() => isHapticFeedbackEnabled());
  const handleHapticChange = useCallback((evt: React.ChangeEvent<HTMLInputElement>) => {
    const newEnabled = evt.target.checked;
    setHapticFeedbackSetting(newEnabled);
    setHapticEnabled(newEnabled);
  }, []);

  return (
    <div className="w-full flex flex-col">
      {mobile && (
        <SettingToggle
          checked={hapticEnabled}
          onChange={handleHapticChange}
          name="hapticFeedbackEnabled"
          testID={GeneralSettingsSelectors.HapticFeedbackToggle}
          title={t('hapticFeedback')}
          description={t('hapticFeedbackDescription')}
        />
      )}

      {!mobile && (
        <SettingToggle
          checked={delegateEnabled}
          onChange={handleDelegateChange}
          name="delegateEnabled"
          testID={GeneralSettingsSelectors.DelegateToggle}
          title={t('delegateProofSettings')}
          description={t('delegateProofSettingsDescription')}
        />
      )}

      <SettingToggle
        checked={consumeEnabled}
        onChange={handleAutoConsumeChange}
        name="autoConsumeEnabled"
        testID={GeneralSettingsSelectors.AutoConsumeToggle}
        title={t('autoConsumeSettings')}
        description={t('autoConsumeSettingsDescription')}
      />
    </div>
  );
};

export default GeneralSettings;

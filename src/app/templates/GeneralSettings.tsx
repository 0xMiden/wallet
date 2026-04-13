import React, { FC, useCallback, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { TabPicker } from 'components/TabPicker';
import { isMobile } from 'lib/platform';
import type { ThemeSetting } from 'lib/settings/constants';
import {
  getThemeSetting,
  isAutoConsumeEnabled,
  isDelegateProofEnabled,
  isHapticFeedbackEnabled,
  setAutoConsumeSetting,
  setDelegateProofSetting,
  setHapticFeedbackSetting
} from 'lib/settings/helpers';
import { setTheme } from 'lib/settings/theme';

import { GeneralSettingsSelectors } from './GeneralSettings.selectors';
import SettingToggle from './SettingToggle';

const GeneralSettings: FC = () => {
  const { t } = useTranslation();
  const mobile = isMobile();

  const [themeSetting, setThemeSettingState] = useState<ThemeSetting>(() => getThemeSetting());
  const themeOptions = useMemo<ThemeSetting[]>(() => ['system', 'light', 'dark'], []);
  const themeTabs = useMemo(
    () =>
      themeOptions.map(opt => ({
        id: `theme-${opt}`,
        title: t(opt === 'system' ? 'themeSystem' : opt === 'light' ? 'themeLight' : 'themeDark'),
        active: themeSetting === opt
      })),
    [t, themeOptions, themeSetting]
  );
  const handleThemeTabChange = useCallback(
    (index: number) => {
      const next = themeOptions[index];
      setThemeSettingState(next);
      setTheme(next);
    },
    [themeOptions]
  );

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
    <div className="w-full flex flex-col gap-y-6">
      <div className="flex items-center justify-between gap-x-4" data-testid={GeneralSettingsSelectors.ThemeSelector}>
        <span className="text-sm font-medium">{t('theme')}</span>
        <TabPicker className="flex-shrink-0" tabs={themeTabs} onTabChange={handleThemeTabChange} />
      </div>

      {mobile && (
        <SettingToggle
          checked={hapticEnabled}
          onChange={handleHapticChange}
          name="hapticFeedbackEnabled"
          testID={GeneralSettingsSelectors.HapticFeedbackToggle}
          title={t('hapticFeedback')}
        />
      )}

      {!mobile && (
        <SettingToggle
          checked={delegateEnabled}
          onChange={handleDelegateChange}
          name="delegateEnabled"
          testID={GeneralSettingsSelectors.DelegateToggle}
          title={t('delegateProofSettings')}
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

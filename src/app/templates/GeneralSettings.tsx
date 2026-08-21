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
  isTelemetryEnabled,
  setAutoConsumeSetting,
  setDelegateProofSetting,
  setHapticFeedbackSetting,
  setTelemetrySetting
} from 'lib/settings/helpers';
import { setTheme } from 'lib/settings/theme';
// Deep imports rather than the `lib/telemetry` barrel: the barrel would pull
// `@sentry/browser` and the bip39 wordlist into the settings chunk.
import { initCrashReporting, stopCrashReporting } from 'lib/telemetry/crash';
import { dropQueue } from 'lib/telemetry/sink';

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
        // TabPickerItem destructures `id` OUT before spreading, so the id above never
        // reaches the DOM; the raw data-testid rides ...props onto the <button>.
        'data-testid': `theme-${opt}`,
        title: t(opt === 'system' ? 'themeSystem' : opt === 'light' ? 'themeLight' : 'themeDark'),
        active: themeSetting === opt
      })),
    [t, themeOptions, themeSetting]
  );
  const handleThemeTabChange = useCallback(
    (index: number) => {
      const next = themeOptions[index];
      if (!next) return;
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

  const [telemetryEnabled, setTelemetryEnabled] = useState(() => isTelemetryEnabled());
  const handleTelemetryChange = useCallback((evt: React.ChangeEvent<HTMLInputElement>) => {
    const nextEnabled = evt.target.checked;
    setTelemetrySetting(nextEnabled);
    setTelemetryEnabled(nextEnabled);

    if (nextEnabled) {
      initCrashReporting();
      return;
    }

    // Off has to stop the sharing already under way, not merely the next event:
    // the queued payloads are discarded and the crash client is torn down.
    dropQueue();
    stopCrashReporting();
  }, []);

  return (
    <div className="w-full flex flex-col gap-y-6" data-testid="general-settings">
      <div className="flex items-center justify-between gap-x-4" data-testid={GeneralSettingsSelectors.ThemeSelector}>
        <span className="font-medium text-base leading-[130%] text-black">{t('theme')}</span>
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

      <SettingToggle
        checked={delegateEnabled}
        onChange={handleDelegateChange}
        name="delegateEnabled"
        testID={GeneralSettingsSelectors.DelegateToggle}
        title={t('delegateProofSettings')}
        description={t('delegateProofSettingsDescription')}
      />

      <SettingToggle
        checked={consumeEnabled}
        onChange={handleAutoConsumeChange}
        name="autoConsumeEnabled"
        testID={GeneralSettingsSelectors.AutoConsumeToggle}
        title={t('autoConsumeSettings')}
        description={t('autoConsumeSettingsDescription')}
      />

      <SettingToggle
        checked={telemetryEnabled}
        onChange={handleTelemetryChange}
        name="telemetryEnabled"
        testID={GeneralSettingsSelectors.TelemetryToggle}
        title={t('helpImproveWallet')}
        description={t('helpImproveWalletDescription')}
      />
    </div>
  );
};

export default GeneralSettings;

import React, { FC, useCallback, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { TabPicker } from 'components/TabPicker';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
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

  return (
    <SubPageLayout data-testid="general-settings">
      <SubPageSection>
        <ListGroup>
          <ListRow
            title={t('theme')}
            trailing={<TabPicker className="shrink-0" tabs={themeTabs} onTabChange={handleThemeTabChange} />}
            data-testid={GeneralSettingsSelectors.ThemeSelector}
          />
          {mobile && (
            <SettingToggle
              checked={hapticEnabled}
              onChange={handleHapticChange}
              name="hapticFeedbackEnabled"
              testID={GeneralSettingsSelectors.HapticFeedbackToggle}
              title={t('hapticFeedback')}
            />
          )}
        </ListGroup>
      </SubPageSection>

      <SubPageSection footnote={t('delegateProofSettingsDescription')}>
        <ListGroup>
          <SettingToggle
            checked={delegateEnabled}
            onChange={handleDelegateChange}
            name="delegateEnabled"
            testID={GeneralSettingsSelectors.DelegateToggle}
            title={t('delegateProofSettings')}
          />
        </ListGroup>
      </SubPageSection>

      <SubPageSection footnote={t('autoConsumeSettingsDescription')}>
        <ListGroup>
          <SettingToggle
            checked={consumeEnabled}
            onChange={handleAutoConsumeChange}
            name="autoConsumeEnabled"
            testID={GeneralSettingsSelectors.AutoConsumeToggle}
            title={t('autoConsumeSettings')}
          />
        </ListGroup>
      </SubPageSection>
    </SubPageLayout>
  );
};

export default GeneralSettings;

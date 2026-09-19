import React, { FC, useCallback, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { SegmentedControl, SegmentedControlItem } from 'components/ui/SegmentedControl';
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
  const themeItems = useMemo<SegmentedControlItem<ThemeSetting>[]>(
    () => [
      { id: 'system', label: t('themeSystem'), 'data-testid': 'theme-system' },
      { id: 'light', label: t('themeLight'), 'data-testid': 'theme-light' },
      { id: 'dark', label: t('themeDark'), 'data-testid': 'theme-dark' }
    ],
    [t]
  );
  const handleThemeChange = useCallback((next: ThemeSetting) => {
    setThemeSettingState(next);
    setTheme(next);
  }, []);

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
            trailing={
              <SegmentedControl
                items={themeItems}
                value={themeSetting}
                onChange={handleThemeChange}
                size="sm"
                aria-label={t('theme')}
                className="shrink-0"
              />
            }
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

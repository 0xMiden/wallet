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

  const [telemetryEnabled, setTelemetryEnabled] = useState(() => isTelemetryEnabled());
  const handleTelemetryChange = useCallback(async (evt: React.ChangeEvent<HTMLInputElement>) => {
    const nextEnabled = evt.target.checked;

    // Stop-sharing first. Both are needed and neither is sufficient: the queue
    // holds payloads already built, the mirror is what gates the next one.
    if (!nextEnabled) {
      dropQueue();
      stopCrashReporting();
    }

    // Reflected at once so the switch never lags the tap, and the write awaited
    // rather than left floating so anything this handler does afterwards runs
    // against a gate that already agrees. It does NOT make withdrawal ordered
    // against the whole app: a flow ending elsewhere in the propagation window
    // is past this handler's reach. See `setTelemetrySetting`.
    setTelemetryEnabled(nextEnabled);
    await setTelemetrySetting(nextEnabled);

    if (nextEnabled) initCrashReporting();
  }, []);

  return (
    <SubPageLayout data-testid="general-settings">
      <SubPageSection>
        <ListGroup surface="outline">
          <ListRow
            title={t('theme')}
            trailing={
              <SegmentedControl
                items={themeItems}
                value={themeSetting}
                onChange={handleThemeChange}
                size="sm"
                // A settings choice is a fill row (design-system): three equal segments, and a row
                // that never scrolls cannot ask an ancestor to scroll for it.
                layout="fill"
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
        <ListGroup surface="outline">
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
        <ListGroup surface="outline">
          <SettingToggle
            checked={consumeEnabled}
            onChange={handleAutoConsumeChange}
            name="autoConsumeEnabled"
            testID={GeneralSettingsSelectors.AutoConsumeToggle}
            title={t('autoConsumeSettings')}
          />
        </ListGroup>
      </SubPageSection>

      <SubPageSection footnote={t('helpImproveWalletDescription')}>
        <ListGroup surface="outline">
          <SettingToggle
            checked={telemetryEnabled}
            onChange={handleTelemetryChange}
            name="telemetryEnabled"
            testID={GeneralSettingsSelectors.TelemetryToggle}
            title={t('helpImproveWallet')}
          />
        </ListGroup>
      </SubPageSection>
    </SubPageLayout>
  );
};

export default GeneralSettings;

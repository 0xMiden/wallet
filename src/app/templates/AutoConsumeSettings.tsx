import React, { FC, useCallback, useRef } from 'react';

import { useTranslation } from 'react-i18next';

import ToggleSwitch from 'app/atoms/ToggleSwitch';
import { isAutoConsumeEnabled, setAutoConsumeSetting } from 'lib/settings/helpers';

import { GeneralSettingsSelectors } from './GeneralSettings.selectors';

const AutoConsumeSettings: FC<{}> = () => {
  const consumeEnabled = isAutoConsumeEnabled();
  const changingRef = useRef(false);
  const { t } = useTranslation();

  const handleAutoConsumeChange = useCallback((evt: React.ChangeEvent<HTMLInputElement>) => {
    if (changingRef.current) return;
    changingRef.current = true;

    setAutoConsumeSetting(evt.target.checked);
    changingRef.current = false;
  }, []);

  return (
    <div className="flex w-full justify-between flex-col pt-8 items-center gap-4.25">
      <ToggleSwitch
        checked={consumeEnabled}
        onChange={handleAutoConsumeChange}
        name="autoConsumeEnabled"
        containerClassName="my-1"
        testID={GeneralSettingsSelectors.AutoConsumeToggle}
      />
      <div className="flex flex-col gap-3.5">
        <label className="leading-tight flex flex-col" htmlFor="consumeEnabled">
          <span className="font-medium my-1 text-[18px] text-center">{t('autoConsumeSettings')}</span>

          <span className="mt-1 text-gray-400 text-center text-base" style={{ lineHeight: '16px' }}>
            {t('autoConsumeSettingsDescription')}
          </span>
        </label>
      </div>
    </div>
  );
};

export default AutoConsumeSettings;

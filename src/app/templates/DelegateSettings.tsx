import React, { FC, useCallback, useRef } from 'react';

import { useTranslation } from 'react-i18next';

import ToggleSwitch from 'app/atoms/ToggleSwitch';
import { isDelegateProofEnabled, setDelegateProofSetting } from 'lib/settings/helpers';

import { GeneralSettingsSelectors } from './GeneralSettings.selectors';

const DelegateSettings: FC<{}> = () => {
  const { t } = useTranslation();
  const delegateEnabled = isDelegateProofEnabled();
  const changingRef = useRef(false);

  const handleDelegateSettingChange = useCallback((evt: React.ChangeEvent<HTMLInputElement>) => {
    if (changingRef.current) return;
    changingRef.current = true;

    setDelegateProofSetting(evt.target.checked);
    changingRef.current = false;
  }, []);

  return (
    <div className="flex flex-col pb-8 items-center justify-center border-b border-[#EAE6E6] gap-4.25">
      <ToggleSwitch
        checked={delegateEnabled}
        onChange={handleDelegateSettingChange}
        name="delegateEnabled"
        containerClassName="my-1"
        testID={GeneralSettingsSelectors.DelegateToggle}
      />
      <div className="flex flex-col gap-3.5">
        <label className="leading-tight flex flex-col" htmlFor="delegateEnabled">
          <span className="font-medium my-1 text-[18px] text-center">{t('delegateProofSettings')}</span>

          <span className="mt-1 text-gray-400 text-center text-base" style={{ lineHeight: '16px' }}>
            {t('delegateProofSettingsDescription')}
          </span>
        </label>
      </div>
    </div>
  );
};

export default DelegateSettings;

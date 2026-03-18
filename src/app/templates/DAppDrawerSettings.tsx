import React, { FC, useCallback, useRef } from 'react';

import { useTranslation } from 'react-i18next';

import ToggleSwitch from 'app/atoms/ToggleSwitch';
import { Icon, IconName } from 'app/icons/v2';
import { useStorage, useMidenContext, useAccount } from 'lib/miden/front';
import { MidenDAppSessions, MidenSharedStorageKey } from 'lib/miden/types';
import { useRetryableSWR } from 'lib/swr';
import { navigate } from 'lib/woozie';

import { GeneralSettingsSelectors } from './GeneralSettings.selectors';

const DAppDrawerSettings: FC<{ onClose?: () => void }> = ({ onClose }) => {
  const { t } = useTranslation();
  const { getAllDAppSessions } = useMidenContext();
  const account = useAccount();

  const { data } = useRetryableSWR<MidenDAppSessions>(['getAllDAppSessions'], getAllDAppSessions, {
    suspense: true,
    shouldRetryOnError: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false
  });

  const hasConnectedDApps = Object.entries(data ?? {}).some(([, sessions]) =>
    sessions.some(sess => sess.accountId === account.publicKey)
  );

  const [dAppEnabled, setDAppEnabled] = useStorage(MidenSharedStorageKey.DAppEnabled, true);

  const changingRef = useRef(false);

  const handleChange = useCallback(
    async (evt: React.ChangeEvent<HTMLInputElement>) => {
      if (changingRef.current) return;
      changingRef.current = true;

      setDAppEnabled(evt.target.checked).catch((err: any) => {});

      changingRef.current = false;
    },
    [setDAppEnabled]
  );

  return (
    <div className="w-full flex flex-col gap-6">
      <div className="flex flex-col">
        <div className="flex w-full justify-between">
          <span className="font-medium text-sm text-heading-gray">{t('dAppsInteraction')}</span>
          <ToggleSwitch
            checked={dAppEnabled}
            onChange={handleChange}
            name="dAppEnabled"
            testID={GeneralSettingsSelectors.DAppToggle}
          />
        </div>
        <span className="text-xs text-[#555D6D]">{t('dAppsToggleDescription')}</span>
      </div>

      {hasConnectedDApps && (
        <button
          type="button"
          onClick={() => {
            onClose?.();
            navigate('/settings/dapps');
          }}
          className="w-full"
        >
          <div className="flex items-center justify-between text-heading-gray">
            <div className="flex flex-col">
              <span className="font-medium text-base">{t('seeConnected')}</span>
            </div>
            <Icon name={IconName.ChevronRightLucide} className="w-5 h-5" fill="none" />
          </div>
        </button>
      )}
    </div>
  );
};

export default DAppDrawerSettings;

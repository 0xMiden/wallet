import React, { FC, useCallback, useRef } from 'react';

import { useTranslation } from 'react-i18next';

import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { useStorage, useMidenContext, useAccount } from 'lib/miden/front';
import { MidenDAppSessions, MidenSharedStorageKey } from 'lib/miden/types';
import { useRetryableSWR } from 'lib/swr';
import { navigate } from 'lib/woozie';

import { GeneralSettingsSelectors } from './GeneralSettings.selectors';
import SettingToggle from './SettingToggle';

const DAppDrawerSettings: FC = () => {
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

      setDAppEnabled(evt.target.checked).catch(() => {});

      changingRef.current = false;
    },
    [setDAppEnabled]
  );

  return (
    <SubPageLayout data-testid="dapp-drawer-settings">
      <SubPageSection footnote={t('dAppsToggleDescription')}>
        <ListGroup surface="outline">
          <SettingToggle
            checked={dAppEnabled}
            onChange={handleChange}
            name="dAppEnabled"
            testID={GeneralSettingsSelectors.DAppToggle}
            title={t('dAppsInteraction')}
          />
        </ListGroup>
      </SubPageSection>

      {hasConnectedDApps && (
        <ListGroup surface="outline">
          <ListRow
            title={t('seeConnected')}
            onClick={() => navigate('/settings/dapps')}
            chevron
            data-testid="dapp-see-connected"
          />
        </ListGroup>
      )}
    </SubPageLayout>
  );
};

export default DAppDrawerSettings;

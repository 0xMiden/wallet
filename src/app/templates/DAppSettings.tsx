import React, { FC, useCallback, useRef } from 'react';

import { PrivateDataPermission } from '@demox-labs/miden-wallet-adapter-base';
import { useTranslation } from 'react-i18next';

import AddressShortView from 'app/atoms/AddressShortView';
import CopyButton from 'app/atoms/CopyButton';
import ToggleSwitch from 'app/atoms/ToggleSwitch';
import { ReactComponent as CloseIcon } from 'app/icons/close.svg';
import { ReactComponent as CopySmallIcon } from 'app/icons/copy-small.svg';
import { ReactComponent as ExternalLinkSmallIcon } from 'app/icons/external-link-small.svg';
import { useStorage, useMidenContext, useAccount } from 'lib/miden/front';
import { MidenDAppSession, MidenDAppSessions, MidenSharedStorageKey } from 'lib/miden/types';
import { useRetryableSWR } from 'lib/swr';
import { useConfirm } from 'lib/ui/dialog';

import { GeneralSettingsSelectors } from './GeneralSettings.selectors';

const DAppSettings: FC = () => {
  const { t } = useTranslation();

  const { getAllDAppSessions, removeDAppSession } = useMidenContext();
  const account = useAccount();
  const confirm = useConfirm();

  const { data, mutate } = useRetryableSWR<MidenDAppSessions>(['getAllDAppSessions'], getAllDAppSessions, {
    suspense: true,
    shouldRetryOnError: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false
  });
  let allDAppSessions = Object.entries(data!);
  let dAppSessions: Record<string, MidenDAppSession> = {};
  allDAppSessions.forEach(([origin, sessions]) => {
    const session = sessions.find(sess => sess.accountId === account.publicKey);
    if (session) dAppSessions[origin] = session;
  });

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

  const handleRemoveClick = useCallback(
    async (origin: string) => {
      if (
        await confirm({
          title: t('actionConfirmation'),
          children: t('resetPermissionsConfirmation', { origin: origin })
        })
      ) {
        await removeDAppSession(origin);
        mutate();
      }
    },
    [removeDAppSession, mutate, confirm, t]
  );

  const dAppEntries = Object.entries(dAppSessions);

  return (
    <div className="w-full max-w-sm mx-auto my-8">
      {/* Toggle Card */}
      <div className="border border-border-card rounded-5 p-4 flex justify-between items-center">
        <div className="flex flex-col">
          <span className="font-medium text-sm text-[#0F131A]">{t('dAppsInteraction')}</span>
          <span className="text-xs text-[#555D6D] mt-1">{t('dAppsToggleDescription')}</span>
        </div>
        <ToggleSwitch
          checked={dAppEnabled}
          onChange={handleChange}
          name="dAppEnabled"
          testID={GeneralSettingsSelectors.DAppToggle}
        />
      </div>

      {dAppEntries.length > 0 && (
        <>
          {/* Dashed Separator */}
          <div className="my-6" style={{ borderTop: '1px dashed #818898' }} />

          {/* Heading */}
          <h2 className="text-[20px] leading-5 font-medium text-heading-gray mb-4">{t('authorizedDApps')}</h2>

          {/* DApp Cards */}
          {dAppEntries.map(([origin, session]) => (
            <DAppCard key={origin} origin={origin} session={session} onRemove={handleRemoveClick} />
          ))}
        </>
      )}
    </div>
  );
};

export default DAppSettings;

const DAppCard: FC<{
  origin: string;
  session: MidenDAppSession;
  onRemove: (origin: string) => void;
}> = ({ origin, session, onRemove }) => {
  const { t } = useTranslation();
  const { network, accountId, privateDataPermission } = session;

  const hostname = (() => {
    try {
      return new URL(origin).hostname;
    } catch {
      return origin;
    }
  })();

  const handleRemoveClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      onRemove(origin);
    },
    [onRemove, origin]
  );

  const permissionLabel =
    privateDataPermission === PrivateDataPermission.UponRequest ? t('permissionUponRequest') : t('permissionAutomatic');

  const explorerHash = accountId.split('_')[0] || accountId;

  return (
    <div className="border border-border-card rounded-5 mb-4">
      {/* Header */}
      <div className="flex justify-between items-center border-b border-border-card px-4 py-3">
        <span className="text-[14px] font-medium text-[#0F131A]">{hostname}</span>
        <button
          className="flex-none text-gray-500 hover:text-black transition ease-in-out duration-200"
          onClick={handleRemoveClick}
        >
          <CloseIcon className="w-auto h-5 stroke-current stroke-2" title={t('delete')} />
        </button>
      </div>

      <div className="p-4">
        {/* Origin */}
        <div className="flex justify-between items-center">
          <span className="text-[#555D6D] text-sm">{t('originLabel')}</span>
          <span className="text-sm text-heading-gray">{origin}</span>
        </div>

        {/* Network */}
        <div className="flex justify-between items-center pt-2">
          <span className="text-[#555D6D] text-sm">{t('networkLabel')}</span>
          <span className="text-sm text-heading-gray capitalize">{network}</span>
        </div>

        {/* Account */}
        <div className="flex justify-between items-center pt-2">
          <span className="text-[#555D6D] text-sm">{t('pkhLabel')}</span>
          <div className="flex items-center gap-1">
            <span className="text-sm text-accent-orange">
              <AddressShortView address={accountId} />
            </span>
            <CopyButton text={accountId} small>
              <CopySmallIcon className="w-3 h-3 text-[#555D6D]" />
            </CopyButton>
            <a
              href={`https://testnet.midenscan.com/account/${explorerHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1 hover:bg-grey-50 rounded-sm transition ease-in-out duration-300"
            >
              <ExternalLinkSmallIcon className="w-3 h-3 text-[#555D6D]" />
            </a>
          </div>
        </div>

        {/* Permissions */}
        <div className="mt-2 border-border-card pt-1 border-t-[0.63px]">
          <span className="text-[#555D6D] text-sm">{t('permissions')}</span>
          <div className="flex gap-2 mt-1">
            <span className="bg-chip-bg rounded-sm px-2 py-1 text-[11px] font-medium text-heading-gray">
              {t('permissionLabel')}
            </span>
            <span className="bg-chip-bg rounded-sm px-2 py-1 text-[11px] font-medium text-heading-gray">
              {permissionLabel}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

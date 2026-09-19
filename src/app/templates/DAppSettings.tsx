import React, { FC, useCallback } from 'react';

import { PrivateDataPermission } from '@miden-sdk/miden-wallet-adapter-base';
import { useTranslation } from 'react-i18next';

import { ReactComponent as ExternalLinkSmallIcon } from 'app/icons/external-link-small.svg';
import { IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { CopyButton } from 'components/ui/CopyButton';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { EmptyState } from 'components/ui/EmptyState';
import { Pill } from 'components/ui/Pill';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { useMidenContext, useAccount } from 'lib/miden/front';
import { MidenDAppSession, MidenDAppSessions } from 'lib/miden/types';
import { getExplorerAccountUrl } from 'lib/miden-chain/constants';
import { useRetryableSWR } from 'lib/swr';
import { useConfirm } from 'lib/ui/dialog';
import { truncateAddress } from 'utils/string';

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

  const handleRemoveClick = useCallback(
    async (origin: string) => {
      if (
        await confirm({
          title: t('actionConfirmation'),
          children: t('resetPermissionsConfirmation', { origin: origin }),
          confirmLabel: t('disconnect'),
          destructive: true
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
    <SubPageLayout data-testid="dapp-settings">
      {dAppEntries.length === 0 ? (
        <EmptyState
          icon={IconName.Apps}
          title={t('noConnectedDApps')}
          description={t('noConnectedDAppsDescription')}
          data-testid="dapp-settings-empty"
        />
      ) : (
        dAppEntries.map(([origin, session]) => (
          <DAppSection key={origin} origin={origin} session={session} onRemove={handleRemoveClick} />
        ))
      )}
    </SubPageLayout>
  );
};

export default DAppSettings;

/** The detail labels predate the detail card and end in a colon ("Origin:"); a row label has none. */
const rowLabel = (label: string) => label.replace(/\s*[:：]\s*$/, '');

/** One connected dApp: its hostname as the section label, its session as a detail card. */
const DAppSection: FC<{
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

  const permissionLabel =
    privateDataPermission === PrivateDataPermission.UponRequest ? t('permissionUponRequest') : t('permissionAutomatic');

  const explorerHash = accountId.split('_')[0] || accountId;
  const explorerAccountUrl = getExplorerAccountUrl(explorerHash);

  return (
    <SubPageSection title={hostname} data-testid="dapp-session">
      <DetailCard>
        <DetailRow label={rowLabel(t('originLabel'))} stacked>
          {origin}
        </DetailRow>
        <DetailRow label={rowLabel(t('networkLabel'))}>
          <span className="capitalize">{network}</span>
        </DetailRow>
        <DetailRow label={rowLabel(t('pkhLabel'))}>
          <span>{truncateAddress(accountId, false, 8)}</span>
          <CopyButton text={accountId} className="shrink-0 font-heading text-sm font-bold" />
          {explorerAccountUrl && (
            <a
              href={explorerAccountUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('viewOnMidenscan')}
              className="flex shrink-0 items-center text-muted"
            >
              <ExternalLinkSmallIcon aria-hidden="true" className="h-3.5 w-3.5" />
            </a>
          )}
        </DetailRow>
        <DetailRow label={t('permissions')} stacked>
          <span className="flex flex-wrap gap-1.5">
            <Pill size="sm">{t('permissionLabel')}</Pill>
            <Pill size="sm">{permissionLabel}</Pill>
          </span>
        </DetailRow>
      </DetailCard>

      <Button
        variant={ButtonVariant.Destructive}
        size="sm"
        className="mt-3 self-start"
        title={t('disconnect')}
        onClick={() => onRemove(origin)}
        data-testid="dapp-disconnect"
      />
    </SubPageSection>
  );
};

import React, { FC, useCallback } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/ui/Button';
import { EmptyState } from 'components/ui/EmptyState';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Notice } from 'components/ui/Notice';
import { Pill, type PillTone } from 'components/ui/Pill';
import { SectionHeader } from 'components/ui/SectionHeader';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { ITransaction } from 'lib/miden/db/types';
import { formatMidenName } from 'lib/miden/name/encoding';
import { publishRegistryRecord, REGISTRY_PUBLISHING_SUPPORTED } from 'lib/miden/name/nfa';
import {
  type MidenNameUiState,
  ownedLabelOf,
  phaseOf,
  registerNameInputsOf,
  uiStateOf,
  useMidenNameRegistrations
} from 'lib/miden/name/registrations';
import { useMidenNameResolvesHere } from 'lib/miden/name/useMidenNameResolvesHere';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

/** The pill tone and the i18n key of each UI state. */
function statePillOf(state: MidenNameUiState): { tone: PillTone; labelKey: string } {
  switch (state) {
    case 'owned':
      return { tone: 'positive', labelKey: 'midenNameStateOwned' };
    case 'claiming':
      return { tone: 'warning', labelKey: 'midenNameStateClaiming' };
    case 'failed':
      return { tone: 'negative', labelKey: 'midenNameStateFailed' };
  }
}

interface PrimaryNameCardProps {
  label: string;
  accountId: string;
}

/** The slate card at the top: the primary name and whether it resolves to this account. */
const PrimaryNameCard: FC<PrimaryNameCardProps> = ({ label, accountId }) => {
  const { t } = useTranslation();
  // Always false in v1: the registry has no records yet.
  const resolves = useMidenNameResolvesHere(accountId, label);

  return (
    <div
      data-testid="miden-name-primary-card"
      className="flex flex-col gap-2 rounded-lg-token bg-card-slate p-4 text-surface-balance-fg dark:bg-card-slate/50"
    >
      <span className="text-label uppercase">{t('midenNamePrimaryName')}</span>
      <span data-testid="miden-name-primary-label" className="truncate text-hero-value">
        {formatMidenName(label)}
      </span>
      {resolves ? (
        <span className="flex min-w-0">
          <Pill
            tone="inverse"
            size="sm"
            icon={<Icon name={IconName.Checkmark} size="xs" />}
            data-testid="miden-name-primary-resolves"
          >
            {t('midenNameResolvesHere')}
            {' · '}
            {truncateAddress(accountId, false, 8)}
          </Pill>
        </span>
      ) : (
        <span data-testid="miden-name-primary-unresolved" className="text-label">
          {t('midenNameNotYetResolvable')}
        </span>
      )}
    </div>
  );
};

interface RegistrationRowProps {
  row: ITransaction;
  accountId: string;
}

/** One name of the account. A name that is not owned opens its status page. */
const RegistrationRow: FC<RegistrationRowProps> = ({ row, accountId }) => {
  const { t } = useTranslation();
  const label = registerNameInputsOf(row)?.label;

  const handlePublish = useCallback(() => {
    if (label === undefined) return;
    publishRegistryRecord(accountId, label).catch(error => {
      console.warn('[miden-name] Publish to registry failed:', error);
    });
  }, [accountId, label]);

  if (label === undefined) return null;

  const state = uiStateOf(phaseOf(row));
  const { tone, labelKey } = statePillOf(state);
  const pill = (
    <Pill size="xs" tone={tone} data-testid="miden-name-row-state">
      {t(labelKey)}
    </Pill>
  );

  switch (state) {
    case 'owned':
      return (
        <ListRow
          title={formatMidenName(label)}
          subtitle={
            <>
              {pill} {t('midenNameNotYetResolvable')}
            </>
          }
          trailing={
            <Button
              variant={ButtonVariant.Secondary}
              size="sm"
              className="w-auto"
              title={t('midenNamePublish')}
              disabled={!REGISTRY_PUBLISHING_SUPPORTED}
              onClick={handlePublish}
              data-testid="miden-name-publish"
            />
          }
          data-testid="miden-name-row"
        />
      );
    case 'claiming':
    case 'failed':
      return (
        <ListRow
          title={formatMidenName(label)}
          subtitle={pill}
          chevron
          onClick={() => navigate(`/miden-name/status/${encodeURIComponent(row.id)}`)}
          data-testid="miden-name-row"
        />
      );
  }
};

/**
 * Settings > Miden Name: the primary name, every name of the account with its
 * state, and the registry options. The list is a live query of the
 * registration rows, so it changes when the tracker writes a new phase.
 */
const MidenNameSettings: FC = () => {
  const { t } = useTranslation();
  const accountId = useWalletStore(state => state.currentAccount?.publicKey);
  const { rows, loaded } = useMidenNameRegistrations(accountId);
  const ownedLabel = ownedLabelOf(rows);
  const empty = loaded && rows.length === 0;

  return (
    <SubPageLayout
      data-testid="miden-name-settings"
      footer={
        loaded && (
          <Button
            className="flex-1 max-w-none"
            title={empty ? t('midenNameClaimCta') : t('midenNameClaimAnother')}
            onClick={() => navigate('/miden-name')}
            data-testid="miden-name-claim"
          />
        )
      }
    >
      {empty && <EmptyState icon={IconName.User} title={t('midenNameEmpty')} data-testid="miden-name-empty" />}

      {ownedLabel !== undefined && accountId !== undefined && (
        <PrimaryNameCard label={ownedLabel} accountId={accountId} />
      )}

      {rows.length > 0 && accountId !== undefined && (
        <section>
          <SectionHeader>{t('midenNameYourNames')}</SectionHeader>
          <ListGroup data-testid="miden-name-list">
            {rows.map(row => (
              <RegistrationRow key={row.id} row={row} accountId={accountId} />
            ))}
          </ListGroup>
        </section>
      )}

      {ownedLabel !== undefined && (
        <section className="flex flex-col gap-3">
          <div>
            <SectionHeader>{t('options')}</SectionHeader>
            <ListGroup>
              <ListRow
                title={t('midenNameClearRecords')}
                trailing={
                  // Clearing needs registry records. Wire its action when publishing is supported.
                  <Button
                    variant={ButtonVariant.Secondary}
                    size="sm"
                    className="w-auto"
                    title={t('clear')}
                    disabled={!REGISTRY_PUBLISHING_SUPPORTED}
                    data-testid="miden-name-clear-records"
                  />
                }
              />
            </ListGroup>
          </div>
          {!REGISTRY_PUBLISHING_SUPPORTED && (
            <Notice
              data-testid="miden-name-publish-coming-soon"
              icon={<Icon name={IconName.InformationFill} size="xs" fill="currentColor" />}
            >
              {t('midenNamePublishComingSoon')}
            </Notice>
          )}
        </section>
      )}
    </SubPageLayout>
  );
};

export default MidenNameSettings;

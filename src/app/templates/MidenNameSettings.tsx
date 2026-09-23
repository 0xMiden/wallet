import React, { FC, useCallback, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/ui/Button';
import { EmptyState } from 'components/ui/EmptyState';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Pill, type PillTone } from 'components/ui/Pill';
import { SectionHeader } from 'components/ui/SectionHeader';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { ITransaction } from 'lib/miden/db/types';
import { useMidenContext } from 'lib/miden/front/client';
import { formatMidenName } from 'lib/miden/name/encoding';
import { publishRegistryRecord, REGISTRY_CLEARING_SUPPORTED } from 'lib/miden/name/nfa';
import {
  type MidenNameUiState,
  ownedLabelOf,
  phaseOf,
  publishingLabelsOf,
  publishNameInputsOf,
  publishPhaseOf,
  registerNameInputsOf,
  uiStateOf,
  useMidenNamePublishes,
  useMidenNameRegistrations
} from 'lib/miden/name/registrations';
import { type MidenNameRecordState, useMidenNameRecord } from 'lib/miden/name/useMidenNameRecord';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';
import { startMidenNameProcessing } from 'screens/miden-name/processing';
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

/** The i18n key of the registry-record line under an owned name. */
function recordLineKeyOf(record: MidenNameRecordState): string {
  switch (record) {
    case 'here':
      return 'midenNameResolvesHere';
    case 'elsewhere':
      return 'midenNameResolvesElsewhere';
    case 'checking':
      return 'midenNameCheckingRecord';
    case 'none':
      return 'midenNameNotYetResolvable';
  }
}

/**
 * One key per publish row phase, so that a record read runs again the moment
 * the tracker moves a publish forward (for example to `recorded`).
 */
function publishRefreshKeyOf(rows: ITransaction[]): string {
  return rows.map(row => `${publishNameInputsOf(row)?.label ?? ''}:${publishPhaseOf(row)}`).join('|');
}

interface PrimaryNameCardProps {
  label: string;
  accountId: string;
  record: MidenNameRecordState;
}

/** The slate card at the top: the primary name and whether its registry record points here. */
const PrimaryNameCard: FC<PrimaryNameCardProps> = ({ label, accountId, record }) => {
  const { t } = useTranslation();

  return (
    <div
      data-testid="miden-name-primary-card"
      className="flex flex-col gap-2 rounded-lg-token bg-card-slate p-4 text-surface-balance-fg dark:bg-card-slate/50"
    >
      <span className="text-label uppercase">{t('midenNamePrimaryName')}</span>
      <span data-testid="miden-name-primary-label" className="truncate text-hero-value">
        {formatMidenName(label)}
      </span>
      {record === 'here' ? (
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
          {t(recordLineKeyOf(record))}
        </span>
      )}
    </div>
  );
};

interface RegistrationRowProps {
  row: ITransaction;
  accountId: string;
  /** True while a registry-record publish of this name is in flight. */
  publishing: boolean;
  /** Key that changes when a publish row changes phase: the record is read again. */
  refreshKey: string;
}

/** One name of the account. A name that is not owned opens its status page. */
const RegistrationRow: FC<RegistrationRowProps> = ({ row, accountId, publishing, refreshKey }) => {
  const { t } = useTranslation();
  const { signTransaction } = useMidenContext();
  const label = registerNameInputsOf(row)?.label;
  const state = uiStateOf(phaseOf(row));
  // The registry record, read from the chain. Only an owned name needs it.
  const record = useMidenNameRecord(accountId, state === 'owned' ? label : undefined, refreshKey);
  // True while the registry note is built (a vault read and a chain-tip read).
  const [building, setBuilding] = useState(false);

  const handlePublish = useCallback(() => {
    if (label === undefined || building) return;
    setBuilding(true);
    publishRegistryRecord(accountId, label)
      .then(txId => {
        startMidenNameProcessing(signTransaction);
        navigate(`/generating-transaction/${encodeURIComponent(txId)}`);
      })
      .catch(error => {
        console.warn('[miden-name] Publish to registry failed:', error);
      })
      .finally(() => setBuilding(false));
  }, [accountId, building, label, signTransaction]);

  if (label === undefined) return null;

  const { tone, labelKey } = statePillOf(state);
  const pill = (
    <Pill size="xs" tone={tone} data-testid="miden-name-row-state">
      {t(labelKey)}
    </Pill>
  );

  switch (state) {
    case 'owned': {
      // No Publish control while the record already points here, or until the
      // registry answered: a tap before the read lands could publish twice.
      const busy = publishing || building || record === 'checking';
      const canPublish = record !== 'here';
      return (
        <ListRow
          title={formatMidenName(label)}
          subtitle={
            <>
              {pill} <span data-testid="miden-name-row-record">{t(recordLineKeyOf(record))}</span>
            </>
          }
          trailing={
            canPublish ? (
              <Button
                variant={ButtonVariant.Secondary}
                size="sm"
                className="w-auto"
                title={publishing || building ? t('midenNamePublishing') : t('midenNamePublish')}
                disabled={busy}
                onClick={handlePublish}
                data-testid="miden-name-publish"
              />
            ) : (
              <span data-testid="miden-name-published" className="flex text-positive-ink">
                <Icon name={IconName.Checkmark} size="sm" />
              </span>
            )
          }
          data-testid="miden-name-row"
        />
      );
    }
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
 * registration rows, so it changes when the tracker writes a new phase. The
 * registry-record state of each owned name is read from the chain
 * (`useMidenNameRecord`), not from the wallet's rows.
 */
const MidenNameSettings: FC = () => {
  const { t } = useTranslation();
  const accountId = useWalletStore(state => state.currentAccount?.publicKey);
  const { rows, loaded } = useMidenNameRegistrations(accountId);
  const publishRows = useMidenNamePublishes(accountId);
  const publishing = publishingLabelsOf(publishRows);
  const refreshKey = publishRefreshKeyOf(publishRows);
  const ownedLabel = ownedLabelOf(rows);
  const primaryRecord = useMidenNameRecord(accountId, ownedLabel, refreshKey);
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
        <PrimaryNameCard label={ownedLabel} accountId={accountId} record={primaryRecord} />
      )}

      {rows.length > 0 && accountId !== undefined && (
        <section>
          <SectionHeader>{t('midenNameYourNames')}</SectionHeader>
          <ListGroup data-testid="miden-name-list">
            {rows.map(row => (
              <RegistrationRow
                key={row.id}
                row={row}
                accountId={accountId}
                publishing={publishing.has(registerNameInputsOf(row)?.label ?? '')}
                refreshKey={refreshKey}
              />
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
                  // Clearing uses the registry actions 4..6. Wire its action when their semantics are confirmed.
                  <Button
                    variant={ButtonVariant.Secondary}
                    size="sm"
                    className="w-auto"
                    title={t('clear')}
                    disabled={!REGISTRY_CLEARING_SUPPORTED}
                    data-testid="miden-name-clear-records"
                  />
                }
              />
            </ListGroup>
          </div>
        </section>
      )}
    </SubPageLayout>
  );
};

export default MidenNameSettings;

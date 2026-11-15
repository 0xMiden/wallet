import React from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { FeatureUnavailableNotice, isFeatureBlocked } from 'components/FeatureUnavailable';
import { CardButton } from 'components/ui/Card';
import { EmptyState } from 'components/ui/EmptyState';
import { SectionHeader } from 'components/ui/SectionHeader';
import { useFeatureAvailability } from 'lib/remote-config/use-feature-availability';
import { useCommandDrafts } from 'screens/command/command-drafts';

import { EarnSubjectSubtitle, earnSubjectTitle, EarnSummaryPanel } from './components';
import { EarnLoadError } from './EarnLoadError';
import { EarnLoading } from './EarnLoading';
import type { EarnPosition, EarnSummary, EarnVault } from './types';

type CommandEarnProps = {
  summary: EarnSummary;
  positions: EarnPosition[];
  vaults: EarnVault[];
  vaultsPending: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  error?: string;
  loadError?: string;
  notOnNetwork?: boolean;
  onRetry: () => void;
  onDeposit: (vaultId: string) => void;
  onWithdraw: (positionId: string) => void;
};

export function CommandEarn({
  summary,
  positions,
  vaults,
  vaultsPending,
  isLoading,
  isRefreshing,
  error,
  loadError,
  notOnNetwork,
  onRetry,
  onDeposit,
  onWithdraw
}: CommandEarnProps): React.ReactElement {
  const { t } = useTranslation();
  const drafts = useCommandDrafts();
  const draft = drafts.readDraft('earn');
  const deposit = useFeatureAvailability('earnDeposit', { hold: !notOnNetwork && !vaultsPending });
  const failed = Boolean(error || loadError);
  const openDeposit = (vaultId: string) => {
    drafts.writeDraft('earn', {
      mode: 'deposit',
      subjectId: vaultId,
      amount: draft?.mode === 'deposit' && draft.subjectId === vaultId ? draft.amount : ''
    });
    onDeposit(vaultId);
  };
  const openWithdraw = (positionId: string) => {
    drafts.writeDraft('earn', {
      mode: 'withdraw',
      subjectId: positionId,
      amount: draft?.mode === 'withdraw' && draft.subjectId === positionId ? draft.amount : ''
    });
    onWithdraw(positionId);
  };

  if (notOnNetwork)
    return <EmptyState icon={IconName.Earn} title={t('earnUnavailableOnNetwork')} data-testid="earn-unavailable" />;

  return (
    <div data-testid="command-earn" className="flex flex-col gap-5">
      <FeatureUnavailableNotice feature="earnDeposit" availability={deposit} />
      {failed && <EarnLoadError isRetrying={isRefreshing} onRetry={onRetry} />}
      {isLoading && positions.length === 0 && vaults.length === 0 && !failed ? <EarnLoading /> : null}
      {!(positions.length === 0 && (isLoading || failed)) && (
        <div data-testid="command-earn-summary">
          <EarnSummaryPanel summary={summary} titleId="command-earn-summary-title" />
        </div>
      )}
      {positions.length > 0 && (
        <section aria-label={t('earnCurrentPositionsTitle')} className="flex flex-col gap-3">
          <SectionHeader size="lg">{t('earnCurrentPositionsTitle')}</SectionHeader>
          {positions.map(position => (
            <CardButton
              key={position.id}
              surface="outline"
              padding="row"
              data-testid={`command-earn-withdraw-${position.id}`}
              disabled={position.stale || Number(position.withdrawable) <= 0}
              onClick={() => openWithdraw(position.id)}
            >
              <span className="flex w-full items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block text-row-title text-ink">{earnSubjectTitle(position)}</span>
                  <span className="block text-caption text-muted">
                    <EarnSubjectSubtitle subject={position} />
                  </span>
                </span>
                <span className="text-value text-ink">{t('withdraw')}</span>
              </span>
            </CardButton>
          ))}
        </section>
      )}
      {vaultsPending && vaults.length === 0 && <EarnLoading />}
      {vaults.length > 0 && (
        <section aria-label={t('earnVaultsTitle')} className="flex flex-col gap-3">
          <SectionHeader size="lg">{t('earnVaultsTitle')}</SectionHeader>
          {vaults.map(vault => (
            <CardButton
              key={vault.id}
              surface="outline"
              padding="row"
              data-testid={`command-earn-deposit-${vault.id}`}
              disabled={!vault.id || vault.canOpen === false || isFeatureBlocked(deposit)}
              onClick={() => openDeposit(vault.id)}
            >
              <span className="flex w-full items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block text-row-title text-ink">{earnSubjectTitle(vault)}</span>
                  <span className="block text-caption text-muted">
                    <EarnSubjectSubtitle subject={vault} />
                  </span>
                </span>
                <span className="text-value text-ink">{t('earnDeposit')}</span>
              </span>
            </CardButton>
          ))}
        </section>
      )}
      {!isLoading && !failed && positions.length === 0 && vaults.length === 0 && !vaultsPending && (
        <EmptyState icon={IconName.Earn} title={t('earnNoActivePositionsTitle')} />
      )}
    </div>
  );
}

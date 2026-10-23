import React from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/ui/Button';
import { Card } from 'components/ui/Card';
import { ErrorLine } from 'components/ui/ErrorLine';
import type { WeeklyClaimSnapshot } from 'lib/arcade/weekly-claim';
import { isUserErrorId } from 'lib/telemetry/user-visible-error';

interface AllowanceCardProps {
  snapshot: WeeklyClaimSnapshot;
  busy: boolean;
  error?: string | null;
  networkName: string;
  onClaim: () => void;
  onRecover?: (operationId: string) => void;
  onRefresh: () => void;
}

/** Also used by the explicitly fictional screenshot harness; no fixture switch in the wallet. */
export const ArcadeAllowanceCard: React.FC<AllowanceCardProps> = ({
  snapshot,
  busy,
  error,
  networkName,
  onClaim,
  onRecover,
  onRefresh
}) => {
  const { t, i18n } = useTranslation();
  const { status, balance } = snapshot;
  const previousReceipt = snapshot.receipts?.[0];
  const previousRecovery = snapshot.recoveries?.[0];
  const claimable =
    status.kind === 'receivable' ||
    status.kind === 'eligible' ||
    status.kind === 'failed' ||
    status.kind === 'reclaimable';
  const date = status.kind === 'claimed' ? new Date(status.nextEligibleAt) : null;
  const nextDate =
    date && Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'UTC'
        }).format(date)
      : null;
  const message =
    busy && status.kind !== 'pending'
      ? t('arcadeChecking')
      : status.kind === 'claimed'
        ? t('arcadeNextClaim', { date: nextDate ?? t('arcadeDateUnavailable') })
        : t(`arcadeClaimState_${status.kind}`);

  return (
    <Card surface="outline" className="flex flex-col gap-3" aria-busy={busy} data-testid="arcade-allowance">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-label text-muted">{t('arcadeGameCoins')}</h2>
          <p className="text-title-section text-ink">
            {balance === null ? t('arcadeBalanceUnknown') : t('arcadeBalance', { balance })}
          </p>
        </div>
        <span className="text-caption text-muted text-right">{networkName}</span>
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-row-title text-ink">{t('arcadeWeeklyAllowance')}</h3>
        <p className="text-body-sm text-muted">{t('arcadeWeeklyRules')}</p>
      </div>
      <p className="text-body-sm text-muted" role="status" aria-live="polite">
        {message}
      </p>
      {error && <ErrorLine errorId={isUserErrorId(error) ? error : null}>{t(error)}</ErrorLine>}
      <Button
        disabled={busy || !claimable}
        onClick={onClaim}
        title={t(
          status.kind === 'receivable'
            ? 'arcadeAcceptGc'
            : status.kind === 'reclaimable'
              ? 'arcadeRecoverBudget'
              : status.kind === 'claimed'
                ? 'arcadeClaimed'
                : status.kind === 'pending'
                  ? 'arcadeAwaitingReceipt'
                  : status.kind === 'failed'
                    ? 'arcadeRetryClaim'
                    : 'arcadeClaim'
        )}
        data-testid="arcade-claim"
      />
      {(status.kind === 'pending' || status.kind === 'checking' || status.kind === 'unavailable') && (
        <Button variant={ButtonVariant.Secondary} disabled={busy} onClick={onRefresh} title={t('arcadeCheckStatus')} />
      )}
      {previousReceipt && onRecover && (
        <div className="flex flex-col gap-2">
          <p className="text-body-sm text-muted">
            {t('arcadePreviousReceiptWeek', {
              date: new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                timeZone: 'UTC'
              }).format(new Date(previousReceipt.allocationWeekStart))
            })}
          </p>
          <Button
            variant={ButtonVariant.Secondary}
            disabled={busy}
            onClick={() => onRecover(previousReceipt.operationId)}
            title={t('arcadeAcceptGc')}
            data-testid="arcade-receive-previous"
          />
        </div>
      )}
      {previousRecovery && onRecover && (
        <div className="flex flex-col gap-2">
          <p className="text-body-sm text-muted">
            {t('arcadePreviousBudgetWeek', {
              date: new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                timeZone: 'UTC'
              }).format(new Date(previousRecovery.allocationWeekStart))
            })}
          </p>
          <Button
            variant={ButtonVariant.Secondary}
            disabled={busy}
            onClick={() => onRecover(previousRecovery.operationId)}
            title={t('arcadeRecoverBudget')}
            data-testid="arcade-recover-previous"
          />
        </div>
      )}
    </Card>
  );
};

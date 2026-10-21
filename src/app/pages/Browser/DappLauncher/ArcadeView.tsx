import React from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/ui/Button';
import { Card } from 'components/ui/Card';
import { EmptyState } from 'components/ui/EmptyState';
import { SectionHeader } from 'components/ui/SectionHeader';
import type { WeeklyClaimSnapshot } from 'lib/arcade/weekly-claim';
import type { ExploreItem } from 'lib/dapp-browser/explore-catalog';

import { AppIcon } from './AppIcon';

interface AllowanceCardProps {
  snapshot: WeeklyClaimSnapshot;
  busy: boolean;
  networkName: string;
  onClaim: () => void;
  onRefresh: () => void;
}

/** Also used by the explicitly fictional screenshot harness; no fixture switch in the wallet. */
export const ArcadeAllowanceCard: React.FC<AllowanceCardProps> = ({
  snapshot,
  busy,
  networkName,
  onClaim,
  onRefresh
}) => {
  const { t, i18n } = useTranslation();
  const { status, balance } = snapshot;
  const claimable = status.kind === 'eligible' || status.kind === 'failed';
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
    <Card surface="outline" className="flex flex-col gap-4" aria-busy={busy} data-testid="arcade-allowance">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-label text-muted">{t('arcadeGameCoins')}</h2>
          <p className="text-title-page text-ink">
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
      <Button
        disabled={busy || !claimable}
        onClick={onClaim}
        title={t(
          status.kind === 'claimed'
            ? 'arcadeClaimed'
            : status.kind === 'pending'
              ? 'arcadeAwaitingReceipt'
              : status.kind === 'failed'
                ? 'arcadeRetryClaim'
                : 'arcadeClaim'
        )}
        data-testid="arcade-claim"
      />
      {(status.kind === 'pending' || status.kind === 'unavailable') && (
        <Button variant={ButtonVariant.Secondary} disabled={busy} onClick={onRefresh} title={t('arcadeCheckStatus')} />
      )}
    </Card>
  );
};

/** Pure catalog view shared with screenshot review. Descriptions stay within each game card. */
export const ArcadeGameCatalog: React.FC<{ games: ExploreItem[]; pending: boolean; onOpen: (url: string) => void }> = ({
  games,
  pending,
  onOpen
}) => {
  const { t } = useTranslation();
  return (
    <section>
      <SectionHeader size="lg">{t('arcadeGames')}</SectionHeader>
      {pending ? (
        <p className="text-body-sm text-muted" role="status">
          {t('arcadeLoadingGames')}
        </p>
      ) : games.length === 0 ? (
        <EmptyState
          size="compact"
          icon={IconName.Rocket}
          title={t('arcadeNoGames')}
          description={t('arcadeNoGamesDescription')}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {games.map(game => (
            <Card key={game.id} className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <AppIcon url={game.url} name={game.name} icon={game.icon} surface="fill" />
                <h3 className="text-row-title text-ink min-w-0 break-words">{game.name}</h3>
              </div>
              <p className="text-body-sm text-muted">{game.tagline}</p>
              <p className="text-caption text-muted">{t('arcadeFreePlay')}</p>
              <Button
                variant={ButtonVariant.Secondary}
                onClick={() => onOpen(game.url)}
                title={t('arcadePlay', { name: game.name })}
              />
            </Card>
          ))}
        </div>
      )}
    </section>
  );
};

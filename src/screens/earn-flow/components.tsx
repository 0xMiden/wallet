import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import aaveLogoUrl from 'app/icons/earn-provider-logos/aave.svg?url';
import { PageHeader } from 'components/PageHeader';
import { TokenLogo } from 'components/TokenLogo';
import { Card } from 'components/ui/Card';
import { Pill } from 'components/ui/Pill';
import { cn } from 'lib/ui/util';
import { goBack } from 'lib/woozie';

import { EarnSummary, EarnVault } from './types';

/** Shared top bar for the vault pages: the `PageHeader` with back, a "{protocol} • {asset}"
 *  title (the route name until the vault is found) and the "{asset} on {network}" pill. Used by the vault,
 *  deposit-amount and deposit-review pages so their headers stay identical, and shaped like the
 *  withdraw-review header. The pages are unpadded, so the header brings the 16px page margin itself. */
export const EarnFlowHeader: FC<{ vault?: EarnVault }> = ({ vault }) => {
  const { t } = useTranslation();

  // No vault (loading, failed or unknown): the header names the route rather than a placeholder vault,
  // so the page keeps its h1.
  return (
    <PageHeader
      className="shrink-0 px-4"
      title={vault ? `${vault.protocol} • ${vault.asset}` : t('earnDeposit')}
      onBack={goBack}
      actions={
        vault && (
          <Pill className="shrink-0">{t('earnAssetOnNetwork', { asset: vault.asset, network: vault.network })}</Pill>
        )
      }
    />
  );
};

/** One figure of the earn summary: a `fill` card with the spec's section label over a row value.
 *  `cn` rather than `clsx` so a caller's padding or colour REPLACES the base one instead of
 *  racing it in the stylesheet. */
export const MetricCard: FC<{ label: string; value: string; valueClassName?: string; className?: string }> = ({
  label,
  value,
  valueClassName,
  className
}) => (
  <Card padding="none" className={cn('flex flex-col items-center justify-center px-3 py-3', className)}>
    <div className="text-center text-label text-muted">{label}</div>
    <div className={cn('mt-1 text-center text-value text-ink', valueClassName)}>{value}</div>
  </Card>
);

export const EarnSummaryPanel: FC<{
  summary: EarnSummary;
  titleId: string;
  className?: string;
  showMetrics?: boolean;
}> = ({ summary, titleId, className, showMetrics = true }) => {
  const { t } = useTranslation();

  return (
    <section aria-labelledby={titleId} className={className}>
      <h1 id={titleId} className="text-label text-muted">
        {t('earnTotalEarnedRewards')}
      </h1>

      {/* The figure the page is about, on the balance card's own type style. */}
      <div className="mt-0.5 text-display text-ink">{summary.totalRewards}</div>

      {/* `positive-tint-ink`, not the raw fill: #90BA89 is 2.2:1 and never carries text. */}
      <div className="mt-0.5 text-value text-positive-tint-ink">
        {t('earnEarningBlendedApy', { apy: summary.blendedApy })}
      </div>

      {/* #503 — gap-3 so Total deposited / Estimated rewards don't abut. Equal columns, so the
          two cards stay the same width whatever their labels wrap to. */}
      {showMetrics && (
        <div className="mt-4 grid grid-cols-2 items-stretch gap-3">
          <MetricCard label={t('earnTotalDeposited')} value={summary.totalDeposited} />
          <MetricCard
            label={t('earnEstimatedRewards')}
            value={summary.estimatedRewards}
            valueClassName="text-positive-tint-ink"
          />
        </div>
      )}
    </section>
  );
};

export const ProviderLogo: FC<{ protocol: string; className?: string }> = ({ protocol, className }) => (
  <span className={classNames('flex shrink-0 items-center justify-center', className)} aria-hidden="true">
    {protocol === 'Aave' ? (
      <img src={aaveLogoUrl} alt="" className="h-full w-full object-contain" />
    ) : (
      protocol.charAt(0)
    )}
  </span>
);

export const PositionLogo: FC<{ asset: string; className?: string }> = ({ asset, className }) => (
  <TokenLogo symbol={asset} size="sm" className={className} />
);

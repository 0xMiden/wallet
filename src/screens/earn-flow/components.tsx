import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import aaveLogoUrl from 'app/icons/earn-provider-logos/aave.svg?url';
import { PageHeader } from 'components/PageHeader';
import { TokenLogo } from 'components/TokenLogo';
import { Pill } from 'components/ui/Pill';
import { goBack } from 'lib/woozie';

import { EarnSummary, EarnVault } from './types';

/** Shared top bar for the vault deposit flow: the `PageHeader` with back, a "{protocol} • {asset}"
 *  title and the "{asset} on {network}" pill. Used by the deposit-amount and deposit-review pages
 *  so their headers stay identical, and shaped like the vault and withdraw-review headers. Both
 *  pages are unpadded, so the header brings the 16px page margin itself. */
export const EarnFlowHeader: FC<{ vault?: EarnVault }> = ({ vault }) => {
  const { t } = useTranslation();

  // No vault (a failed load of one that is not cached): the header names nothing rather than a
  // placeholder, and back is still there.
  return (
    <PageHeader
      className="shrink-0 px-4"
      title={vault ? `${vault.protocol} • ${vault.asset}` : undefined}
      onBack={goBack}
      actions={
        vault && (
          <Pill className="shrink-0">{t('earnAssetOnNetwork', { asset: vault.asset, network: vault.network })}</Pill>
        )
      }
    />
  );
};

export const MetricCard: FC<{ label: string; value: string; valueClassName?: string; className?: string }> = ({
  label,
  value,
  valueClassName,
  className
}) => (
  <div className={classNames('flex py-3 flex-col items-center justify-center rounded-10 bg-fill px-10', className)}>
    <div className="text-center text-[10px] font-semibold uppercase leading-none text-gray-secondary">{label}</div>
    <div className={classNames('mt-1 text-center text-sm font-bold leading-none text-ink', valueClassName)}>
      {value}
    </div>
  </div>
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
      <h1 id={titleId} className="text-base font-bold text-gray-secondary">
        {t('earnTotalEarnedRewards')}
      </h1>

      <div className="mt-0.5 font-heading text-[56px] font-bold leading-16 text-ink">{summary.totalRewards}</div>

      <div className="mt-0.5 text-base font-semibold text-status-positive">
        {t('earnEarningBlendedApy', { apy: summary.blendedApy })}
      </div>

      {/* #503 — gap-3 so TOTAL DEPOSITED / ESTIMATED REWARDS don't abut. */}
      {showMetrics && (
        <div className="mt-4 flex items-center justify-evenly gap-3">
          <MetricCard label={t('earnTotalDeposited')} value={summary.totalDeposited} />
          <MetricCard
            label={t('earnEstimatedRewards')}
            value={summary.estimatedRewards}
            valueClassName="text-status-positive"
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

import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import aaveLogoUrl from 'app/icons/earn-provider-logos/aave.svg?url';
import { IconName } from 'app/icons/v2';
import { CircleButton } from 'components/CircleButton';
import { TokenLogo } from 'components/TokenLogo';
import { goBack } from 'lib/woozie';

import { EarnSummary, EarnVault } from './types';

/** Shared top bar for the vault deposit flow: back button, "{protocol} • {asset}"
 *  title and the "{asset} on {network}" pill. Used by the deposit-amount and
 *  deposit-review pages so their headers stay identical. */
export const EarnFlowHeader: FC<{ vault: EarnVault }> = ({ vault }) => {
  const { t } = useTranslation();

  return (
    <header className="shrink-0 border-b border-rule-default px-4 pb-4 pt-5">
      <div className="flex min-w-0 items-center gap-3">
        <CircleButton
          icon={IconName.ChevronLeft}
          onClick={goBack}
          className="h-10 w-10 bg-gray-25 text-heading-gray hover:bg-gray-50 focus:bg-gray-50"
          size="md"
          aria-label={t('back')}
        />
        <h1 className="min-w-0 truncate font-heading text-[26px] font-bold leading-none text-heading-gray">
          {vault.protocol} &bull; {vault.asset}
        </h1>
        <span className="shrink-0 rounded-full bg-[#DDD4CE] px-3 py-1.5 text-xs font-medium leading-none text-heading-gray">
          {t('earnAssetOnNetwork', { asset: vault.asset, network: vault.network })}
        </span>
      </div>
    </header>
  );
};

export const MetricCard: FC<{ label: string; value: string; valueClassName?: string; className?: string }> = ({
  label,
  value,
  valueClassName,
  className
}) => (
  <div className={classNames('flex py-3 flex-col items-center justify-center rounded-10 bg-gray-25 px-4', className)}>
    <div className="text-center text-[10px] font-semibold uppercase leading-none text-gray-secondary">{label}</div>
    <div className={classNames('mt-1 text-center text-sm font-bold leading-none text-black', valueClassName)}>
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

      <div className="mt-0.5 font-heading text-[56px] font-bold leading-16 text-heading-gray">
        {summary.totalRewards}
      </div>

      <div className="mt-0.5 text-base font-semibold text-status-positive">
        {t('earnEarningBlendedApy', { apy: summary.blendedApy })}
      </div>

      {showMetrics && (
        <div className="mt-4 flex items-stretch justify-center gap-3">
          <MetricCard label={t('earnTotalDeposited')} value={summary.totalDeposited} className="min-w-0 flex-1" />
          <MetricCard
            label={t('earnEstimatedRewards')}
            value={summary.estimatedRewards}
            valueClassName="text-status-positive"
            className="min-w-0 flex-1"
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

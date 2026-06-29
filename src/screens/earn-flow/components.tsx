import React, { FC } from 'react';

import classNames from 'clsx';

import aaveLogoUrl from 'app/icons/earn-provider-logos/aave.svg?url';
import { TokenLogo } from 'components/TokenLogo';

import { EarnSummary } from './types';

export const MetricCard: FC<{ label: string; value: string; valueClassName?: string; className?: string }> = ({
  label,
  value,
  valueClassName,
  className
}) => (
  <div className={classNames('flex py-3 flex-col items-center justify-center rounded-10 bg-gray-25 px-10', className)}>
    <div className="text-center text-[10px] font-semibold uppercase leading-none text-[#8E8E93]">{label}</div>
    <div className={classNames('mt-1 text-center text-sm font-bold leading-none text-[#0B0B0C]', valueClassName)}>
      {value}
    </div>
  </div>
);

export const EarnSummaryPanel: FC<{
  summary: EarnSummary;
  titleId: string;
  className?: string;
  showMetrics?: boolean;
}> = ({ summary, titleId, className, showMetrics = true }) => (
  <section aria-labelledby={titleId} className={className}>
    <h1 id={titleId} className="text-base font-bold text-[#8E8E93]">
      Total Earned Rewards
    </h1>

    <div className="mt-0.5 font-heading text-[56px] font-bold leading-16 text-heading-gray">{summary.totalRewards}</div>

    <div className="mt-0.5 text-base font-semibold text-status-positive">Earning {summary.blendedApy} blended APY</div>

    {showMetrics && (
      <div className="mt-4 flex items-center justify-evenly">
        <MetricCard label="Total Deposited" value={summary.totalDeposited} />
        <MetricCard label="Estimated Rewards" value={summary.estimatedRewards} valueClassName="text-status-positive" />
      </div>
    )}
  </section>
);

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

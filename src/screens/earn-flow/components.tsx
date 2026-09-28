import React, { FC, ReactNode } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { NetworkChipKind, NetworkLogo } from 'components/NetworkChip';
import { PageHeader } from 'components/PageHeader';
import { TokenLogo } from 'components/TokenLogo';
import { AnimatedNumber } from 'components/ui/AnimatedNumber';
import { Card } from 'components/ui/Card';
import { cn } from 'lib/ui/util';
import { goBack } from 'lib/woozie';

import { EARN_PLACEHOLDER, usdFigureFormatter } from './earn-mapping';
import { EarnSummary } from './types';

/** What the earn flow's header knows about the thing it is showing: the two names in its title and
 *  the asset and network its mark stands for. A vault and a position both answer it. */
export interface EarnSubject {
  protocol: string;
  asset: string;
  network: string;
}

/** Earn's vaults are EVM-side, so anything that is not Miden itself takes the Ethereum mark. */
const networkKind = (network: string): NetworkChipKind => (network.toLowerCase() === 'miden' ? 'miden' : 'ethereum');

/**
 * The asset and its network as ONE compact mark: the token's logo with the network's mark badged on
 * its corner, the shape the send flow gives a token or a recipient. It replaces the wide
 * "{asset} on {network}" pill, which took the width a two-word protocol needed and wrapped the
 * header onto a second line. The pill was also the only thing naming the pair in text, so the mark
 * carries that name for assistive tech.
 */
export const EarnAssetMark: FC<{ asset: string; network: string; className?: string }> = ({
  asset,
  network,
  className
}) => {
  const { t } = useTranslation();
  const label = t('earnAssetOnNetwork', { asset, network });

  return (
    <span className={classNames('flex shrink-0 items-center', className)}>
      <TokenLogo symbol={asset} size="md" badge={<NetworkLogo kind={networkKind(network)} />} />
      <span className="sr-only">{label}</span>
    </span>
  );
};

/** The title every page of the earn flow puts in its header, so a vault and a position are named
 *  the same way wherever the flow shows them. */
export const earnSubjectTitle = (subject: EarnSubject): string => `${subject.protocol} • ${subject.asset}`;

/** Shared top bar for the earn flow's pages that are NOT on `SubPageLayout` (the amount step, which
 *  hands its whole body to the send flow's `SelectAmount`): the `PageHeader` with back, the shared
 *  title and the asset's mark. That page is unpadded, so the header brings the 16px page margin
 *  itself. */
export const EarnFlowHeader: FC<{ subject?: EarnSubject }> = ({ subject }) => {
  const { t } = useTranslation();

  // No subject (loading, failed or unknown): the header names the route rather than a placeholder
  // vault, so the page keeps its h1.
  return (
    <PageHeader
      className="shrink-0 px-4"
      title={subject ? earnSubjectTitle(subject) : t('earnDeposit')}
      onBack={goBack}
      actions={subject && <EarnAssetMark asset={subject.asset} network={subject.network} />}
    />
  );
};

/** One figure of the earn summary: a `fill` card with the spec's section label over a row value.
 *  `cn` rather than `clsx` so a caller's padding or colour REPLACES the base one instead of
 *  racing it in the stylesheet. */
export const MetricCard: FC<{ label: string; value: ReactNode; valueClassName?: string; className?: string }> = ({
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

export interface EarnHeroProps {
  /** Stable id for the caption, which is what names the section to assistive tech. */
  labelId: string;
  /** The one figure the section is about. A live figure comes in as an `AnimatedNumber`. */
  value: React.ReactNode;
  /** Colour for the figure; `ink` unless the number is itself a rate. */
  valueClassName?: string;
  /** What the figure is denominated in, drawn against it: a review's token mark and symbol. */
  unit?: React.ReactNode;
  /** The caption under the figure. A caption, not a heading: the page's own title is its `h1`. */
  label: string;
  /** The change or rate line under the caption. A live figure comes in as an `AnimatedNumber`. */
  meta?: React.ReactNode;
  /** Anything that belongs inside the section under the hero, e.g. the summary's metric cards. */
  children?: React.ReactNode;
  className?: string;
}

/**
 * The earn flow's hero: the figure first, then its caption, then the change or rate line — the one
 * shape both earn heroes take, so the tab root's total rewards and a vault's APY read as the same
 * block at the same scale.
 */
export const EarnHero: FC<EarnHeroProps> = ({
  labelId,
  value,
  valueClassName,
  unit,
  label,
  meta,
  children,
  className
}) => (
  <section aria-labelledby={labelId} className={className}>
    {/* The figure the page is about, on the balance card's own type style. */}
    <div className={cn('text-display', valueClassName ?? 'text-ink')}>{value}</div>
    {unit}
    <p id={labelId} className="mt-2 text-label text-muted">
      {label}
    </p>
    {/* `positive-tint-ink`, not the raw fill: #90BA89 is 2.2:1 and never carries text. */}
    {meta && <p className="mt-0.5 text-value text-positive-tint-ink">{meta}</p>}
    {children}
  </section>
);

export const EarnSummaryPanel: FC<{
  summary: EarnSummary;
  titleId: string;
  className?: string;
  showMetrics?: boolean;
}> = ({ summary, titleId, className, showMetrics = true }) => {
  const { t } = useTranslation();

  return (
    <EarnHero
      labelId={titleId}
      className={className}
      value={
        <AnimatedNumber
          value={summary.totalRewardsUsd}
          format={usdFigureFormatter(summary.totalRewardsUsd)}
          placeholder={EARN_PLACEHOLDER}
        />
      }
      label={t('earnTotalEarnedRewards')}
      meta={
        <AnimatedNumber
          value={summary.blendedApyPercent}
          format={apy => t('earnEarningBlendedApy', { apy: `~${apy.toFixed(1)}%` })}
          placeholder={t('earnEarningBlendedApy', { apy: EARN_PLACEHOLDER })}
        />
      }
    >
      {/* #503 — gap-3 so Total deposited / Estimated rewards don't abut. Equal columns, so the
          two cards stay the same width whatever their labels wrap to. */}
      {showMetrics && (
        <div className="mt-4 grid grid-cols-2 items-stretch gap-3">
          <MetricCard
            label={t('earnTotalDeposited')}
            value={
              <AnimatedNumber
                value={summary.totalDepositedUsd}
                format={usdFigureFormatter(summary.totalDepositedUsd)}
                placeholder={EARN_PLACEHOLDER}
              />
            }
          />
          <MetricCard
            label={t('earnEstimatedRewards')}
            value={
              <AnimatedNumber
                value={summary.estimatedRewardsUsd}
                format={usdFigureFormatter(summary.estimatedRewardsUsd, { signed: true })}
                placeholder={EARN_PLACEHOLDER}
              />
            }
            valueClassName="text-positive-tint-ink"
          />
        </div>
      )}
    </EarnHero>
  );
};

/** The token a review's figure is denominated in: its mark and its symbol, on the unit type style
 *  that sits beside an entry. One shape for the deposit and the withdraw review alike. */
export const EarnAmountUnit: FC<{ symbol: string }> = ({ symbol }) => (
  <div className="flex items-center gap-1">
    <TokenLogo symbol={symbol} size="md" />
    <span className="text-entry-unit text-ink">{symbol}</span>
  </div>
);

import React, { FC, useMemo } from 'react';

import { useTranslation } from 'react-i18next';
import { Area, AreaChart, Tooltip, YAxis } from 'recharts';

import { Button, ButtonVariant } from 'components/Button';
import { FeatureUnavailableNotice, isFeatureBlocked } from 'components/FeatureUnavailable';
import { AnimatedNumber } from 'components/ui/AnimatedNumber';
import { SectionHeader } from 'components/ui/SectionHeader';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { useFeatureAvailability } from 'lib/remote-config/use-feature-availability';
import { CHART_DOT_RING, CHART_POSITIVE, ChartContainer, ChartValueTooltip } from 'lib/ui/charts';
import { cn } from 'lib/ui/util';
import { goBack, navigate } from 'lib/woozie';

import { EarnAssetMark, EarnHero, EarnSubjectSubtitle, earnSubjectTitle, MetricCard } from './components';
import { EARN_PLACEHOLDER, formatApy, placeholderVault } from './earn-mapping';
import { EarnLoadError } from './EarnLoadError';
import { ChartDotProps, EarnVault } from './types';
import { earnItemLoadState, useEarnPositions } from './useEarnPositions';

interface EarnVaultDetailProps {
  vaultId: string;
}

const EarnVaultDetail: FC<EarnVaultDetailProps> = ({ vaultId }) => {
  const { t } = useTranslation();
  const { vaults, isLoading, loadError, refetch } = useEarnPositions();
  const found = useMemo(() => vaults.find(item => item.id === vaultId), [vaults, vaultId]);
  const vault = useMemo(() => found ?? placeholderVault(), [found]);
  const { loadFailed, pending } = earnItemLoadState(found, { isLoading, error: loadError });
  // Neither the pending nor the vault-less failed branch draws the Deposit control or its notice.
  const earnDeposit = useFeatureAvailability('earnDeposit', { hold: !((loadFailed && !found) || pending) });

  return (
    // The shared pushed-page frame: the header, a body whose sections sit 20px apart, and the CTA
    // pinned under it instead of scrolling away at the end of the page.
    <SubPageLayout
      data-testid="earn-vault-detail-page"
      // Named as every earn page names a vault: the protocol over its asset and network, the mark
      // beside them decorative. Until the vault is found the header names the route, never a
      // placeholder vault.
      title={found ? earnSubjectTitle(found) : t('earnDeposit')}
      subtitle={found && <EarnSubjectSubtitle subject={found} />}
      onBack={goBack}
      headerActions={found && <EarnAssetMark asset={found.asset} network={found.network} decorative />}
      footer={
        (loadFailed && !found) || pending ? undefined : (
          <Button
            data-testid="earn-vault-deposit-btn"
            title={t('earnDeposit')}
            variant={ButtonVariant.Primary}
            accent="earn"
            disabled={!vault.id || isFeatureBlocked(earnDeposit)}
            onClick={() => navigate(`/earn/vaults/${vaultId}/deposit`)}
            className="max-w-none"
          />
        )
      }
    >
      {/* A failed load never draws the placeholder vault as if it were real; with the vault in
          hand from an earlier load, it is still shown, under a notice that it may be stale. */}
      {loadFailed && !found ? (
        <EarnLoadError onRetry={refetch} message={t('earnVaultLoadError')} className="mt-10" />
      ) : pending ? null : (
        <>
          {loadFailed && <EarnLoadError onRetry={refetch} message={t('earnVaultLoadError')} />}
          <FeatureUnavailableNotice availability={earnDeposit} />
          <EarnHero
            layout="label-first"
            labelId="earn-vault-apy-title"
            // 28px more than the body's start, so the caption sits as far under the divider as the
            // Earn tab's "Total earned" does under its bar.
            className="mt-7"
            // The APY counts to each new rate; `vault.apy` is what shows before a rate has been read.
            value={<AnimatedNumber value={vault.aprPercent} format={formatApy} placeholder={vault.apy} />}
            valueClassName="text-positive-tint-ink"
            label={t('earnCurrentApy')}
            // The move only shows once there is one: a lone placeholder dash under the figure read as
            // a stray rule. A fall takes `muted`, never the positive ink.
            meta={
              vault.apyChange24h !== EARN_PLACEHOLDER && (
                <span
                  className={cn(
                    'text-value',
                    vault.apyChange24h.startsWith('-') ? 'text-muted' : 'text-positive-tint-ink'
                  )}
                >
                  {vault.apyChange24h}
                </span>
              )
            }
          />

          <VaultAreaChart vault={vault} />

          <VaultStats vault={vault} />
          <VaultAbout vault={vault} />
        </>
      )}
    </SubPageLayout>
  );
};

const VaultAreaChart: FC<{ vault: EarnVault }> = ({ vault }) => {
  const values = vault.chartData.map(point => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = (max - min) * 0.18 || 1;
  const lastIndex = vault.chartData.length - 1;

  return (
    // Edge to edge: the chart steps out of the body's 16px margin so the line runs the full width.
    <div className="-mx-4 h-[200px]">
      <ChartContainer config={{ apy: { color: CHART_POSITIVE } }} className="h-full w-full aspect-auto">
        <AreaChart data={vault.chartData} margin={{ top: 40, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="earn-vault-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_POSITIVE} stopOpacity={0.28} />
              <stop offset="95%" stopColor={CHART_POSITIVE} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis domain={[min - padding, max + padding]} hide />
          <Tooltip
            // A dashed guide from the scrubbed point to the baseline, held back to a quarter of ink.
            cursor={{ stroke: 'var(--ds-ink)', strokeOpacity: 0.25, strokeDasharray: '3 4' }}
            content={({ active, payload }) => {
              if (!active || !payload?.[0]) return null;
              const point = payload[0].payload;
              // A point with no date yet says only its rate, not a dash under it.
              const label = point.label === EARN_PLACEHOLDER ? undefined : point.label;
              return <ChartValueTooltip value={`${Number(point.value).toFixed(2)}%`} label={label} />;
            }}
          />
          <Area
            dataKey="value"
            type="natural"
            stroke="var(--color-apy)"
            strokeWidth={3}
            fill="url(#earn-vault-area)"
            activeDot={{ r: 5, stroke: CHART_DOT_RING, fill: CHART_POSITIVE, strokeWidth: 2.5 }}
            dot={(props: ChartDotProps) =>
              props.index === lastIndex ? (
                <circle
                  cx={props.cx}
                  cy={props.cy}
                  r={4}
                  fill={CHART_POSITIVE}
                  stroke={CHART_DOT_RING}
                  strokeWidth={2}
                />
              ) : null
            }
          />
        </AreaChart>
      </ChartContainer>
    </div>
  );
};

const VaultStats: FC<{ vault: EarnVault }> = ({ vault }) => {
  const { t } = useTranslation();

  return (
    <div className="grid grid-cols-3 gap-2">
      <MetricCard label={t('earnTvlLabel')} value={vault.tvl} />
      <MetricCard label={t('earnRiskLabel')} value={vault.risk} valueClassName="text-positive-tint-ink" />
      <MetricCard
        label={t('earnAuditedLabel')}
        value={vault.audited ? `✓ ${t('yes')}` : t('no')}
        valueClassName={vault.audited ? 'text-ink' : undefined}
      />
    </div>
  );
};

const VaultAbout: FC<{ vault: EarnVault }> = ({ vault }) => {
  const { t } = useTranslation();

  return (
    <section>
      <SectionHeader size="lg">{t('about')}</SectionHeader>
      {/* The 4px inset the section label takes, so the copy lines up under it. */}
      <p className="px-1 text-body text-muted">{vault.about}</p>
    </section>
  );
};

export default EarnVaultDetail;

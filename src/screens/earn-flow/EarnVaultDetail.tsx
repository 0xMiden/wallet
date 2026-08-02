import React, { FC, useMemo, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';
import { Area, AreaChart, Tooltip, YAxis } from 'recharts';

import { IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { CircleButton } from 'components/CircleButton';
import { hapticSelection } from 'lib/mobile/haptics';
import { ChartContainer } from 'lib/ui/charts';
import { goBack, navigate } from 'lib/woozie';

import { MetricCard } from './components';
import { placeholderVault } from './earn-mapping';
import { EarnVault } from './types';
import { useEarnPositions } from './useEarnPositions';

const TIMEFRAMES = ['1D', '1W', '1M', 'All'];
const CHART_GREEN = '#90BA89';

interface EarnVaultDetailProps {
  vaultId: string;
}

const EarnVaultDetail: FC<EarnVaultDetailProps> = ({ vaultId }) => {
  const [timeframe, setTimeframe] = useState('1M');
  const { t } = useTranslation();
  const { vaults } = useEarnPositions();
  const vault = useMemo(() => vaults.find(item => item.id === vaultId) ?? placeholderVault(), [vaults, vaultId]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-bg font-inter" data-testid="earn-vault-detail-page">
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

      <div className="flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col px-4 pb-8 pt-8">
          <section aria-labelledby="earn-vault-apy-title">
            <div
              id="earn-vault-apy-title"
              className="font-heading text-[56px] font-bold leading-none text-status-positive"
            >
              {vault.apy}
            </div>
            <div className="mt-2 text-xs font-bold uppercase leading-none tracking-wide text-gray-secondary">
              {t('earnCurrentApy')}
            </div>
            <div className="mt-0.5 text-xl font-semibold leading-none text-status-positive">{vault.apyChange24h}</div>
          </section>

          <VaultAreaChart vault={vault} />

          <div className="mt-4 flex items-center justify-between px-4 text-sm font-medium text-gray-secondary">
            {TIMEFRAMES.map(item => (
              <button
                key={item}
                type="button"
                onClick={() => {
                  hapticSelection();
                  setTimeframe(item);
                }}
                className={classNames(
                  'rounded-full px-3 py-2 leading-none',
                  timeframe === item ? 'bg-[#F2F2F4] font-semibold text-pure-black' : 'text-gray-secondary'
                )}
              >
                {item}
              </button>
            ))}
          </div>

          <VaultStats vault={vault} />
          <VaultAbout vault={vault} />

          <div className="mt-auto pt-16">
            <Button
              data-testid="earn-vault-deposit-btn"
              title={t('earnDeposit')}
              variant={ButtonVariant.Primary}
              disabled={!vault.id}
              onClick={() => navigate(`/earn/vaults/${vaultId}/deposit`)}
              className="h-14 max-w-none rounded-full text-lg font-bold"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

const VaultAreaChart: FC<{ vault: EarnVault }> = ({ vault }) => {
  const values = vault.chartData.map(point => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = (max - min) * 0.18 || 1;
  const lastIndex = vault.chartData.length - 1;

  return (
    <div className="mt-10 h-[140px]">
      <ChartContainer config={{ apy: { color: CHART_GREEN } }} className="h-full w-full aspect-auto">
        <AreaChart data={vault.chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <defs>
            <linearGradient id="earn-vault-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_GREEN} stopOpacity={0.28} />
              <stop offset="95%" stopColor={CHART_GREEN} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis domain={[min - padding, max + padding]} hide />
          <Tooltip
            cursor={false}
            content={({ active, payload }) => {
              if (!active || !payload?.[0]) return null;
              const point = payload[0].payload;
              return (
                <div className="rounded-lg bg-heading-gray px-2 py-1 text-xs text-pure-white shadow">
                  <div className="font-heading font-semibold">{Number(point.value).toFixed(2)}%</div>
                  <div className="opacity-75">{point.label}</div>
                </div>
              );
            }}
          />
          <Area
            dataKey="value"
            type="natural"
            stroke="var(--color-apy)"
            strokeWidth={2.5}
            fill="url(#earn-vault-area)"
            activeDot={{ r: 4, stroke: CHART_GREEN, fill: CHART_GREEN, strokeWidth: 1 }}
            dot={(props: any) =>
              props.index === lastIndex ? (
                <circle cx={props.cx} cy={props.cy} r={4} fill={CHART_GREEN} stroke="#FFFFFF" strokeWidth={2} />
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
    <div className="mt-6 grid grid-cols-3 gap-2">
      <MetricCard label={t('earnTvlLabel')} value={vault.tvl} className="px-3" />
      <MetricCard label={t('earnRiskLabel')} value={vault.risk} valueClassName="text-[#009B3A]" className="px-3" />
      <MetricCard
        label={t('earnAuditedLabel')}
        value={vault.audited ? `✓ ${t('yes')}` : t('no')}
        className="px-3"
        valueClassName={vault.audited ? 'text-heading-gray' : undefined}
      />
    </div>
  );
};

const VaultAbout: FC<{ vault: EarnVault }> = ({ vault }) => {
  const { t } = useTranslation();

  return (
    <section className="mt-4">
      <h2 className="font-heading text-base font-bold leading-none text-heading-gray">{t('about')}</h2>
      <p className="mt-3 text-sm leading-snug text-heading-gray">{vault.about}</p>
    </section>
  );
};

export default EarnVaultDetail;

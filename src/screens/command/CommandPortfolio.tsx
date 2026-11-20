import React, { useEffect, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant, Card, SegmentedControl, SectionHeader } from 'components/ui';
import { formatAmountDisplay } from 'lib/i18n/amount-display';
import { getNumberSymbols } from 'lib/i18n/core';
import {
  recordPortfolioObservation,
  readPortfolioObservations,
  type PortfolioObservation
} from 'lib/miden/portfolio-observations';
import type { AccountScope } from 'lib/miden-chain/account-scope';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';

import { CommandAssets } from './CommandAssets';
import { CommandHistoryTrace } from './CommandHistoryTrace';
import { useCommandPortfolio } from './useCommandPortfolio';
import { useCommandPrivacy } from './useCommandPrivacy';

const BUCKET_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const BALANCE_PLACEHOLDER = '---';
const RANGES = { '1W': 7, '1M': 30, '3M': 90, '1Y': 365 };
const ALLOCATION_COLORS = ['bg-accent-primary', 'bg-accent-tint-ink', 'bg-muted'] as const;
type HistoryRange = keyof typeof RANGES;
const RANGE_ITEMS: { id: HistoryRange; label: string }[] = [
  { id: '1W', label: '1W' },
  { id: '1M', label: '1M' },
  { id: '3M', label: '3M' },
  { id: '1Y', label: '1Y' }
];

export function CommandPortfolio({
  scope,
  prompts,
  recentActions
}: {
  scope: AccountScope;
  prompts?: React.ReactNode;
  recentActions?: React.ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  const displayOptions = {
    minimumFractionDigits: 2,
    trimTrailingZeros: false,
    grouping: true,
    separators: getNumberSymbols()
  };
  const [hidden, setHidden] = useCommandPrivacy();
  const portfolio = useCommandPortfolio(scope);
  const [range, setRange] = useState<HistoryRange>('1M');
  const [history, setHistory] = useState<{ key: string; rows: readonly PortfolioObservation[] } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const accountId = useWalletStore(state => state.currentAccount?.publicKey);
  const ready = useWalletStore(state => state.status === WalletStatus.Ready);
  // PageRouter recreates the same scope on rerender; avoid repeating a year read and bucket write.
  const stableScope = useMemo(
    () => ({ accountId: scope.accountId, network: scope.network, rpcUrl: scope.rpcUrl }),
    [scope.accountId, scope.network, scope.rpcUrl]
  );
  const key = JSON.stringify([stableScope.accountId, stableScope.network, stableScope.rpcUrl]);
  const { canRecord, capturedAt, value, coverage, coverageKey } = portfolio;

  useEffect(() => {
    if (
      !canRecord ||
      capturedAt === undefined ||
      value === null ||
      document.visibilityState !== 'visible' ||
      !ready ||
      accountId !== stableScope.accountId ||
      getEffectiveNetworkName() !== stableScope.network ||
      getEffectiveRpcUrl() !== stableScope.rpcUrl
    )
      return;
    let cancelled = false;
    const observation: PortfolioObservation = {
      ...stableScope,
      currency: 'USD',
      capturedAt,
      bucket: Math.floor(capturedAt / BUCKET_MS) * BUCKET_MS,
      value,
      coverage,
      coverageKey
    };
    void recordPortfolioObservation(observation)
      .then(async (): Promise<void> => {
        if (cancelled) return;
        const rows = await readPortfolioObservations(stableScope, Date.now() - RANGES['1Y'] * DAY_MS);
        if (!cancelled) setHistory({ key, rows });
      })
      .catch(() => {
        // Personal history is optional; a failed IndexedDB write must never block balances or Send.
        console.warn('[portfolio] observation unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, canRecord, capturedAt, coverage, coverageKey, key, ready, stableScope, value]);

  useEffect(() => {
    let cancelled = false;
    void readPortfolioObservations(stableScope, Date.now() - RANGES['1Y'] * DAY_MS)
      .then(rows => {
        if (!cancelled) setHistory({ key, rows });
      })
      .catch(() => {
        if (!cancelled) setHistory({ key, rows: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [key, stableScope]);

  const actual = useMemo(() => (history?.key === key ? history.rows : []), [history, key]);
  const points = useMemo(
    () => actual.filter(row => row.capturedAt >= Date.now() - RANGES[range] * DAY_MS),
    [actual, range]
  );
  const { samples, gaps } = useMemo(() => {
    const stride = Math.max(1, Math.ceil(points.length / 365));
    const samples: { row: (typeof points)[number]; run: number }[] = [];
    let run = 0;
    for (const [index, row] of points.entries()) {
      const previous = points[index - 1];
      // Determine continuity before thinning so skipped drawing samples never look like missing history.
      if (previous && (row.bucket - previous.bucket !== BUCKET_MS || row.coverageKey !== previous.coverageKey)) run++;
      if (index % stride === 0 || index === points.length - 1) samples.push({ row, run });
    }
    return { samples, gaps: run > 0 };
  }, [points]);
  const sampleIndex = selected === null ? samples.length - 1 : Math.min(selected, samples.length - 1);
  const sample = samples[sampleIndex]?.row;
  const inspected = sample
    ? `${new Date(sample.capturedAt).toLocaleString()} · ${hidden ? t('commandMaskedBalance') : `${formatAmountDisplay(sample.value, displayOptions)} USD${sample.coverage === 'partial' ? ` · ${t('commandPartialCoverage')}` : ''}`}`
    : '';
  const values = samples.map(({ row }) => Number(row.value));
  const min = Math.min(...values);
  const span = Math.max(...values) - min;
  const hasTrace = samples.some((sample, index) => index > 0 && samples[index - 1]?.run === sample.run);
  const rangeMs = RANGES[range] * DAY_MS;
  const rangeStart = Date.now() - rangeMs;
  const chartPoints = samples.map(({ row, run }) => ({
    x: Math.max(0, Math.min(100, (100 * (row.capturedAt - rangeStart)) / rangeMs)),
    y: span ? 82 - (64 * (Number(row.value) - min)) / span : 50,
    bucket: row.bucket,
    run
  }));
  const activePoint = chartPoints[sampleIndex];
  return (
    <div className="mx-auto grid w-full min-w-0 max-w-[90rem] grid-cols-1 gap-6 px-4 py-6 sm:px-8 lg:grid-cols-12 lg:px-[4vw] lg:py-10">
      <section
        className={`relative isolate min-w-0 overflow-hidden rounded-3xl border border-hairline bg-fill/40 p-5 sm:p-8 lg:row-start-1 ${hidden ? 'lg:col-span-12' : 'lg:col-span-8'}`}
        aria-label={t('commandPortfolio')}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top_right,var(--ds-accent-tint),transparent_68%)] opacity-75"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 -z-10 w-2/3 bg-[radial-gradient(circle,currentColor_1px,transparent_1px)] bg-size-[18px_18px] text-accent-tint-ink opacity-[0.14] mask-[radial-gradient(ellipse_at_top_right,black,transparent_72%)]"
        />
        <div className="flex items-center justify-between gap-3">
          <SectionHeader size="xl">{t('commandPortfolio')}</SectionHeader>
          <Button
            size="sm"
            variant={ButtonVariant.Secondary}
            onClick={() => {
              void setHidden(!hidden).catch(() => console.warn('[portfolio] privacy preference unavailable'));
            }}
          >
            {hidden ? t('commandShowBalances') : t('commandHideBalances')}
          </Button>
        </div>
        <p className="mt-7 text-label text-muted">{t('commandWalletBalance')}</p>
        <p className="my-2 break-words text-display tracking-tight text-ink tabular-nums sm:text-6xl xl:text-8xl">
          {hidden ? (
            t('commandMaskedBalance')
          ) : value === null ? (
            <>
              <span aria-hidden="true">{BALANCE_PLACEHOLDER}</span>
              <span className="sr-only">{t('commandBalanceUnavailable')}</span>
            </>
          ) : (
            `${formatAmountDisplay(value, displayOptions)} USD`
          )}
        </p>
        {!hidden && value !== null && coverage === 'partial' && (
          <p className="text-caption text-muted">{t('commandPartialCoverage')}</p>
        )}
        {!hidden && portfolio.current && portfolio.priceMovement24h && value !== null && (
          <p className="text-caption text-muted">
            {t('commandMarketPriceMovement24h', {
              change: `${portfolio.priceMovement24h.absolute < 0 ? '-' : '+'}${formatAmountDisplay(Math.abs(portfolio.priceMovement24h.absolute), { ...displayOptions, formatting: 'fixed' })}`,
              percentage: `${portfolio.priceMovement24h.percentage < 0 ? '-' : '+'}${formatAmountDisplay(Math.abs(portfolio.priceMovement24h.percentage), { ...displayOptions, formatting: 'fixed' })}`
            })}
          </p>
        )}
      </section>
      <section
        className="min-w-0 overflow-hidden rounded-3xl border border-hairline bg-linear-to-b from-fill/45 to-page px-4 py-5 sm:px-7 lg:col-span-12 lg:row-start-2"
        aria-label={t('commandObservedHistory')}
        aria-busy={history?.key !== key}
        data-testid="command-history"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <SectionHeader size="lg">{t('commandObservedHistory')}</SectionHeader>
          <SegmentedControl<HistoryRange>
            aria-label={t('commandHistoryRange')}
            size="sm"
            layout="fill"
            className="w-52 min-w-0 max-w-full px-1"
            value={range}
            items={RANGE_ITEMS}
            onChange={next => {
              setRange(next);
              setSelected(null);
            }}
          />
        </div>
        {hidden ? (
          <p className="text-body-sm text-muted">{t('commandMaskedBalance')}</p>
        ) : samples.length < 2 ? (
          <div className="mt-4 grid min-h-36 place-content-center gap-2 rounded-2xl border border-dashed border-hairline p-6 text-center">
            {sample ? (
              <>
                <span
                  aria-hidden="true"
                  className="mx-auto size-2 rounded-full bg-accent-primary ring-4 ring-accent-tint"
                />
                <p className="text-body-sm text-ink tabular-nums">{inspected}</p>
              </>
            ) : history?.key === key ? (
              <p className="text-body-sm text-muted">{t('commandHistoryInsufficient')}</p>
            ) : null}
          </div>
        ) : (
          <>
            <div
              data-testid="command-chart"
              data-history-kind={hasTrace ? 'trace' : 'observations'}
              className={hasTrace ? 'relative mx-2 mt-5 h-44 sm:h-56' : 'relative mx-2 mt-5 h-28 sm:h-36'}
              onMouseMove={event => {
                const rect = event.currentTarget.getBoundingClientRect();
                if (rect.width) {
                  const x = 100 * Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
                  setSelected(
                    chartPoints.reduce(
                      (nearest, point, index) =>
                        Math.abs(point.x - x) < Math.abs(chartPoints[nearest]!.x - x) ? index : nearest,
                      0
                    )
                  );
                }
              }}
            >
              <CommandHistoryTrace points={chartPoints} />
              {activePoint && (
                <span
                  aria-hidden="true"
                  data-testid="command-chart-marker"
                  className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-page bg-accent-tint-ink ring-1 ring-accent-primary"
                  style={{ left: `${activePoint.x}%`, top: `${activePoint.y}%` }}
                />
              )}
            </div>
            <input
              type="range"
              min="0"
              max={samples.length - 1}
              value={sampleIndex}
              aria-label={t('commandInspectHistory')}
              aria-valuetext={inspected}
              onChange={event => setSelected(Number(event.target.value))}
              className="mx-2 block w-[calc(100%-1rem)] accent-accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
            />
            <div className="mt-3 flex flex-wrap justify-between gap-x-4 gap-y-1 px-2">
              <output className="text-caption text-ink tabular-nums">{inspected}</output>
              {gaps && (
                <span className="text-caption text-muted" title={t('commandHistoryGaps')}>
                  {t('commandHistoryObservationsOnly')}
                </span>
              )}
            </div>
          </>
        )}
      </section>
      {!hidden && (
        <section className="min-w-0 lg:col-span-4 lg:row-start-1" aria-label={t('commandAllocation')}>
          <Card
            surface="outline"
            className="flex h-full flex-col justify-center gap-4 rounded-3xl bg-linear-to-br from-fill/80 to-page p-5 sm:p-7"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <SectionHeader>{t('commandAllocation')}</SectionHeader>
              <p className="text-caption text-muted">{t('commandPricedAssets')}</p>
            </div>
            {portfolio.allocation.length === 0 ? (
              <p className="border-t border-hairline py-4 text-body-sm text-muted">
                {t(portfolio.empty ? 'commandWalletEmpty' : 'commandAllocationUnavailable')}
              </p>
            ) : (
              <>
                <div aria-hidden="true" className="flex h-1.5 gap-1" data-testid="command-allocation-strip">
                  {portfolio.allocation.map((entry, index) => (
                    <span
                      key={entry.tokenId}
                      className={`min-w-0 basis-0 rounded-full ${ALLOCATION_COLORS[index % ALLOCATION_COLORS.length]}`}
                      style={{ flexGrow: entry.percentage }}
                    />
                  ))}
                </div>
                {coverage === 'partial' && <p className="text-caption text-muted">{t('commandPartialCoverage')}</p>}
                {portfolio.allocation.map((entry, index) => {
                  const asset = portfolio.assets.find(row => row.tokenId === entry.tokenId);
                  if (!asset) return null;
                  return (
                    <div key={entry.tokenId} className="flex items-center justify-between gap-3 text-body-sm text-ink">
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          aria-hidden="true"
                          className={`size-1.5 shrink-0 rounded-full ${ALLOCATION_COLORS[index % ALLOCATION_COLORS.length]}`}
                        />
                        <span className="truncate">{asset.metadata.name || asset.metadata.symbol}</span>
                      </span>
                      <span className="shrink-0 text-muted">
                        {formatAmountDisplay(entry.value, displayOptions)} USD
                      </span>
                      <span className="shrink-0">
                        {formatAmountDisplay(entry.percentage, { ...displayOptions, trimTrailingZeros: true })}
                        {t('percentSign')}
                      </span>
                    </div>
                  );
                })}
              </>
            )}
          </Card>
        </section>
      )}
      {prompts && <div className="lg:col-span-12">{prompts}</div>}
      <div className={recentActions ? 'min-w-0 lg:col-span-7' : 'min-w-0 lg:col-span-12'}>
        <CommandAssets
          assets={portfolio.assets}
          prices={portfolio.tokenPrices}
          hidden={hidden}
          current={portfolio.current}
        />
      </div>
      {recentActions && <div className="min-w-0 lg:col-span-5">{recentActions}</div>}
    </div>
  );
}

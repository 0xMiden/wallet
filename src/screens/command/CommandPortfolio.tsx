import React, { useEffect, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { AnimatedNumber, Button, ButtonVariant, SegmentedControl, SectionHeader } from 'components/ui';
import { formatAmountDisplay } from 'lib/i18n/amount-display';
import { getNumberSymbols } from 'lib/i18n/core';
import type { ITransaction } from 'lib/miden/db/types';
import {
  recordPortfolioObservation,
  readPortfolioObservations,
  type PortfolioObservation
} from 'lib/miden/portfolio-observations';
import * as Repo from 'lib/miden/repo';
import type { AccountScope } from 'lib/miden-chain/account-scope';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';

import { buildActivityHistoryObservations } from './activity-history';
import { CommandAiBar } from './CommandAiBar';
import { CommandAssets } from './CommandAssets';
import { CommandHistoryTrace } from './CommandHistoryTrace';
import { useCommandPortfolio } from './useCommandPortfolio';
import { useCommandPrivacy } from './useCommandPrivacy';

const BUCKET_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const BALANCE_PLACEHOLDER = '---';
const PORTFOLIO_COLUMN_PADDING = 'px-5 py-6 sm:px-8';
const PORTFOLIO_HEADER = 'flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1';
const PRESET_RANGES = { '1D': 1, '1W': 7, '1M': 30, '3M': 90, '1Y': 365 } as const;
const ALLOCATION_COLORS = [
  'text-accent-primary',
  'text-accent-receive-ink',
  'text-accent-swap-ink',
  'text-accent-earn-ink',
  'text-accent-tint-ink'
] as const;
type HistoryRange = keyof typeof PRESET_RANGES;
const RANGE_ITEMS: { id: HistoryRange; label: string }[] = [
  { id: '1D', label: '1D' },
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
  const [selectedRange, setSelectedRange] = useState<HistoryRange | null>(null);
  const [history, setHistory] = useState<{ key: string; rows: readonly PortfolioObservation[] } | null>(null);
  const [activityRows, setActivityRows] = useState<{ key: string; rows: readonly ITransaction[] } | null>(null);
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
        const rows = await readPortfolioObservations(stableScope, Date.now() - PRESET_RANGES['1Y'] * DAY_MS);
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
    void readPortfolioObservations(stableScope, Date.now() - PRESET_RANGES['1Y'] * DAY_MS)
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

  useEffect(() => {
    let cancelled = false;
    void Repo.transactions
      .toArray()
      .then(rows => {
        if (!cancelled) setActivityRows({ key, rows });
      })
      .catch(() => {
        if (!cancelled) setActivityRows({ key, rows: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [key, capturedAt, value]);

  const activityHistory = useMemo(
    () =>
      buildActivityHistoryObservations({
        scope: stableScope,
        transactions: activityRows?.key === key ? activityRows.rows : [],
        assets: portfolio.assets,
        tokenPrices: portfolio.tokenPrices,
        currentValue: value,
        coverage,
        coverageKey
      }),
    [activityRows, coverage, coverageKey, key, portfolio.assets, portfolio.tokenPrices, stableScope, value]
  );

  const actual = useMemo(
    () => (activityHistory.length >= 2 ? activityHistory : history?.key === key ? history.rows : []),
    [activityHistory, history, key]
  );
  const now = Date.now();
  const range: HistoryRange = selectedRange ?? '1D';
  const { points, rangeStart, rangeMs } = useMemo(() => {
    const windowMs = PRESET_RANGES[range] * DAY_MS;
    const start = now - windowMs;
    const windowPoints = actual.filter(row => row.capturedAt >= start);
    if (range === '1D' && actual.length >= 2) {
      const firstAt = actual[0]!.capturedAt;
      const lastAt = actual[actual.length - 1]!.capturedAt;
      const observedSpanMs = lastAt - firstAt;
      if (observedSpanMs < DAY_MS || windowPoints.length < 2) {
        const rawSpan = Math.max(0, observedSpanMs);
        const pad = rawSpan > 0 ? Math.max(rawSpan * 0.04, 1_000) : 60_000;
        const fitStart = firstAt - pad;
        return {
          points: actual,
          rangeStart: fitStart,
          rangeMs: Math.max(1, lastAt + pad - fitStart)
        };
      }
    }
    return {
      points: windowPoints,
      rangeStart: start,
      rangeMs: windowMs
    };
  }, [actual, now, range]);
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
  const maxVal = Math.max(...values);
  const span = maxVal - min;
  const firstSampleValue = samples.length >= 2 ? Number(samples[0]!.row.value) : null;
  const lastSampleValue = samples.length >= 2 ? Number(samples[samples.length - 1]!.row.value) : null;
  const periodDelta =
    !hidden &&
    firstSampleValue !== null &&
    lastSampleValue !== null &&
    Number.isFinite(firstSampleValue) &&
    Number.isFinite(lastSampleValue)
      ? {
          amount: lastSampleValue - firstSampleValue,
          percentage: firstSampleValue > 0 ? ((lastSampleValue - firstSampleValue) / firstSampleValue) * 100 : null
        }
      : null;
  const deltaAmountLabel = periodDelta
    ? `${periodDelta.amount >= 0 ? '+' : '-'}$${formatAmountDisplay(Math.abs(periodDelta.amount), displayOptions)}`
    : null;
  const deltaPercentageLabel =
    periodDelta && periodDelta.percentage !== null
      ? `(${periodDelta.percentage >= 0 ? '+' : '-'}${formatAmountDisplay(Math.abs(periodDelta.percentage), {
          ...displayOptions,
          formatting: 'fixed'
        })}${t('percentSign')})`
      : null;
  const yTicks =
    span > 0
      ? [
          { top: 18, value: maxVal },
          { top: 50, value: min + span / 2 },
          { top: 82, value: min }
        ]
      : [{ top: 50, value: min }];
  const formatAxisTime = (ts: number) =>
    rangeMs <= DAY_MS
      ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const hasTrace = samples.some((sample, index) => index > 0 && samples[index - 1]?.run === sample.run);
  const chartPoints = samples.map(({ row, run }) => ({
    x: Math.max(0, Math.min(100, (100 * (row.capturedAt - rangeStart)) / rangeMs)),
    y: span ? 82 - (64 * (Number(row.value) - min)) / span : 50,
    bucket: row.bucket,
    run
  }));
  const activePoint = chartPoints[sampleIndex];
  const assetsById = new Map(portfolio.assets.map(asset => [asset.tokenId, asset.metadata]));
  let allocationOffset = 0;
  const allocation = [...portfolio.allocation]
    .sort((a, b) => b.value - a.value)
    .map((entry, index) => {
      const offset = allocationOffset;
      allocationOffset += entry.percentage;
      const asset = assetsById.get(entry.tokenId);
      return {
        ...entry,
        offset,
        name: asset?.name || asset?.symbol || entry.tokenId,
        color: ALLOCATION_COLORS[index % ALLOCATION_COLORS.length]
      };
    });
  return (
    <div className="mx-auto grid w-full min-w-0 max-w-[90rem] grid-cols-1 gap-6 px-4 py-6 sm:px-8 lg:grid-cols-12 lg:px-[4vw] lg:py-10">
      <CommandAiBar scope={scope} assets={portfolio.assets} tokenPrices={portfolio.tokenPrices} />
      <div
        data-testid="command-portfolio-surface"
        className="relative isolate grid min-w-0 overflow-hidden rounded-3xl border border-hairline bg-linear-to-b from-fill/65 to-page lg:col-span-12 lg:grid-cols-12"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top_left,var(--ds-accent-tint),transparent_74%)] opacity-80"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 -z-10 w-2/3 bg-[radial-gradient(circle,currentColor_1px,transparent_1px)] bg-size-[18px_18px] text-accent-tint-ink opacity-[0.14] mask-[radial-gradient(ellipse_at_top_right,black,transparent_72%)]"
        />
        <section
          className={`min-w-0 lg:row-start-1 ${PORTFOLIO_COLUMN_PADDING} ${hidden ? 'lg:col-span-12' : 'lg:col-span-8'}`}
          aria-label={t('commandPortfolio')}
        >
          <div className={PORTFOLIO_HEADER}>
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
              <AnimatedNumber
                key={key}
                data-testid="command-live-balance"
                value={Number(value)}
                format={amount => `${formatAmountDisplay(amount, displayOptions)} USD`}
              />
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
          className="min-w-0 border-t border-hairline bg-page bg-[radial-gradient(ellipse_at_bottom_right,var(--ds-accent-tint),transparent_72%)] px-5 py-5 sm:px-8 lg:col-span-12 lg:row-start-2"
          aria-label={t('commandObservedHistory')}
          aria-busy={history?.key !== key || activityRows?.key !== key}
          data-testid="command-history"
        >
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <SectionHeader size="lg">{t('commandObservedHistory')}</SectionHeader>
              {periodDelta && (
                <span
                  data-testid="command-chart-delta"
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-caption font-semibold tabular-nums ${
                    periodDelta.amount >= 0
                      ? 'border-accent-receive-ink/30 bg-accent-receive-ink/10 text-accent-receive-ink'
                      : 'border-negative-tint-ink/30 bg-negative-tint/15 text-negative-tint-ink'
                  }`}
                >
                  <span>{deltaAmountLabel}</span>
                  {deltaPercentageLabel !== null && <span className="opacity-85">{deltaPercentageLabel}</span>}
                </span>
              )}
            </div>
            <SegmentedControl<HistoryRange>
              aria-label={t('commandHistoryRange')}
              size="sm"
              layout="scroll"
              className="min-w-0 max-w-full px-1"
              value={range}
              items={RANGE_ITEMS}
              onChange={next => {
                setSelectedRange(next);
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
                className="relative mx-2 mt-5 h-44 sm:h-56"
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
                onMouseLeave={() => setSelected(null)}
              >
                <CommandHistoryTrace key={range} points={chartPoints} reveal={selectedRange !== null} />
                {yTicks.map(tick => (
                  <span
                    key={tick.top}
                    aria-hidden="true"
                    className="pointer-events-none absolute right-1 -translate-y-1/2 rounded bg-page/75 px-1 text-[11px] text-muted/75 [backdrop-filter:blur(4px)] [-webkit-backdrop-filter:blur(4px)] tabular-nums"
                    style={{ top: `${tick.top}%` }}
                  >
                    ${formatAmountDisplay(tick.value, displayOptions)}
                  </span>
                ))}
                {selected !== null && activePoint && sample && (
                  <>
                    <div
                      data-testid="command-chart-tooltip"
                      className="pointer-events-none absolute top-1 z-10 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border border-accent-primary/35 bg-fill/90 px-2.5 py-1 text-[11px] font-medium text-ink shadow-md [backdrop-filter:blur(12px)] [-webkit-backdrop-filter:blur(12px)] tabular-nums"
                      style={{ left: `${Math.max(12, Math.min(88, activePoint.x))}%` }}
                    >
                      <span className="font-semibold text-accent-tint-ink">
                        ${formatAmountDisplay(Number(sample.value), displayOptions)}
                      </span>
                      <span className="text-muted">·</span>
                      <span className="text-muted">{formatAxisTime(sample.capturedAt)}</span>
                    </div>
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-y-0 w-px bg-linear-to-b from-transparent via-accent-primary/75 to-transparent shadow-[0_0_8px_var(--accent-primary)]"
                      style={{ left: `${activePoint.x}%` }}
                    >
                      <span
                        data-testid="command-chart-marker"
                        className="absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-page bg-accent-tint-ink shadow-[0_0_12px_var(--accent-primary)] ring-2 ring-accent-primary/60"
                        style={{ top: `${activePoint.y}%` }}
                      />
                    </div>
                  </>
                )}
              </div>
              <div
                aria-hidden="true"
                className="mx-2 mt-1 flex items-center justify-between text-[11px] text-muted/75 tabular-nums"
              >
                <span>{formatAxisTime(rangeStart)}</span>
                <span>{formatAxisTime(rangeStart + rangeMs / 2)}</span>
                <span>{formatAxisTime(rangeStart + rangeMs)}</span>
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
          <section
            className={`flex min-w-0 flex-col gap-4 border-t border-hairline lg:col-span-4 lg:row-start-1 lg:border-t-0 ${PORTFOLIO_COLUMN_PADDING}`}
            aria-label={t('commandAllocation')}
          >
            <div className={PORTFOLIO_HEADER}>
              <SectionHeader size="xl">{t('commandAllocation')}</SectionHeader>
              <p className="text-label text-muted">{t('commandPricedAssets')}</p>
            </div>
            {allocation.length === 0 ? (
              <p className="border-t border-hairline py-4 text-body-sm text-muted">
                {t(portfolio.empty ? 'commandWalletEmpty' : 'commandAllocationUnavailable')}
              </p>
            ) : (
              <>
                <div className="grid items-center gap-4 min-[460px]:grid-cols-[6rem_minmax(0,1fr)] lg:grid-cols-1 xl:grid-cols-[6rem_minmax(0,1fr)]">
                  <svg
                    aria-hidden="true"
                    className="mx-auto size-24 shrink-0"
                    data-testid="command-allocation-ring"
                    viewBox="0 0 100 100"
                    fill="none"
                  >
                    <circle cx="50" cy="50" r="42" className="stroke-hairline" strokeWidth="10" />
                    <g transform="rotate(-90 50 50)" strokeWidth="10">
                      {allocation.map(entry => (
                        <circle
                          key={entry.tokenId}
                          cx="50"
                          cy="50"
                          r="42"
                          pathLength="100"
                          stroke="currentColor"
                          className={entry.color}
                          strokeDasharray={`${entry.percentage} 100`}
                          strokeDashoffset={-entry.offset}
                        />
                      ))}
                    </g>
                  </svg>
                  <ul className="max-h-48 min-w-0 space-y-2.5 overflow-y-auto overscroll-contain pr-1">
                    {allocation.map(entry => (
                      <li key={entry.tokenId} className="flex min-w-0 items-start gap-2 text-body-sm text-ink">
                        <span
                          aria-hidden="true"
                          className={`mt-1.5 size-2 shrink-0 rounded-full bg-current ${entry.color}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate" title={entry.name}>
                            {entry.name}
                          </span>
                          <span className="block break-words text-caption text-muted tabular-nums">
                            {formatAmountDisplay(entry.value, displayOptions)} USD
                          </span>
                        </span>
                        <span className="shrink-0 font-semibold tabular-nums">
                          {formatAmountDisplay(entry.percentage, { ...displayOptions, trimTrailingZeros: true })}
                          {t('percentSign')}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                {coverage === 'partial' && (
                  <p className="border-t border-hairline pt-3 text-caption text-muted">{t('commandPartialCoverage')}</p>
                )}
              </>
            )}
          </section>
        )}
      </div>
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

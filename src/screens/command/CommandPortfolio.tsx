import React, { useEffect, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant, Card, SegmentedControl, SectionHeader } from 'components/ui';
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
import { useCommandPortfolio } from './useCommandPortfolio';
import { useCommandPrivacy } from './useCommandPrivacy';

const BUCKET_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const RANGES = { '1W': 7, '1M': 30, '3M': 90, '1Y': 365 };
type HistoryRange = keyof typeof RANGES;
const RANGE_ITEMS: { id: HistoryRange; label: string }[] = [
  { id: '1W', label: '1W' },
  { id: '1M', label: '1M' },
  { id: '3M', label: '3M' },
  { id: '1Y', label: '1Y' }
];

export function CommandPortfolio({ scope }: { scope: AccountScope }): React.ReactElement {
  const { t } = useTranslation();
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
    () => actual.filter(row => row.bucket >= Date.now() - RANGES[range] * DAY_MS),
    [actual, range]
  );
  // Pick actual rows only; never interpolate into a missing bucket or across a coverage change.
  const samples = useMemo(() => {
    const stride = Math.max(1, Math.ceil(points.length / 365));
    return points.filter((_, index) => index % stride === 0 || index === points.length - 1);
  }, [points]);
  const gaps = points.some(
    (row, index) =>
      index > 0 &&
      (row.bucket - points[index - 1]!.bucket > BUCKET_MS || row.coverageKey !== points[index - 1]!.coverageKey)
  );
  const sampleIndex = selected === null ? samples.length - 1 : Math.min(selected, samples.length - 1);
  const sample = samples[sampleIndex];
  const inspected = sample
    ? `${new Date(sample.capturedAt).toLocaleString()} · ${hidden ? t('commandMaskedBalance') : `${sample.value} USD${sample.coverage === 'partial' ? ` · ${t('commandPartialCoverage')}` : ''}`}`
    : '';
  const values = samples.map(row => Number(row.value));
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const firstBucket = samples[0]?.bucket ?? 0;
  const lastBucket = samples.at(-1)?.bucket ?? firstBucket;
  const chartPoints = samples.map(row => ({
    x: firstBucket === lastBucket ? 50 : (100 * (row.bucket - firstBucket)) / (lastBucket - firstBucket),
    y: 90 - (80 * (Number(row.value) - min)) / span,
    row
  }));
  const lines = chartPoints.slice(1).flatMap((point, index) => {
    const previous = chartPoints[index]!;
    return point.row.bucket - previous.row.bucket === BUCKET_MS && point.row.coverageKey === previous.row.coverageKey
      ? [
          <line
            key={point.row.bucket}
            x1={previous.x}
            y1={previous.y}
            x2={point.x}
            y2={point.y}
            stroke="var(--status-positive)"
            strokeWidth="1"
          />
        ]
      : [];
  });
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-5">
      <section aria-label={t('commandPortfolio')}>
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
        <p className="text-label text-muted">{t('commandWalletBalance')} · USD</p>
        <p className="text-display text-ink">
          {hidden
            ? t('commandMaskedBalance')
            : !portfolio.current || value === null
              ? t('commandBalanceUnavailable')
              : `${value} USD`}
        </p>
        {!hidden && coverage === 'partial' && <p className="text-caption text-muted">{t('commandPartialCoverage')}</p>}
        <Card surface="outline" className="mt-5" aria-busy={history?.key !== key} data-testid="command-history">
          <SectionHeader>{t('commandObservedHistory')}</SectionHeader>
          <SegmentedControl<HistoryRange>
            aria-label={t('commandHistoryRange')}
            size="sm"
            layout="fill"
            value={range}
            items={RANGE_ITEMS}
            onChange={next => {
              setRange(next);
              setSelected(null);
            }}
          />
          {hidden ? (
            <p className="text-body-sm text-muted">{t('commandMaskedBalance')}</p>
          ) : samples.length < 2 ? (
            <p className="text-body-sm text-muted">{t('commandHistoryInsufficient')}</p>
          ) : (
            <>
              <div
                data-testid="command-chart"
                className="mt-3 h-40 w-full"
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
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">
                  {lines}
                  {chartPoints.map(point => (
                    <circle key={point.row.bucket} cx={point.x} cy={point.y} r="1" fill="var(--status-positive)" />
                  ))}
                </svg>
              </div>
              <input
                type="range"
                min="0"
                max={samples.length - 1}
                value={sampleIndex}
                aria-label={t('commandInspectHistory')}
                aria-valuetext={inspected}
                onChange={event => setSelected(Number(event.target.value))}
                className="w-full accent-accent-primary"
              />
              <output className="text-caption text-muted">{inspected}</output>
              {gaps && <p className="text-caption text-muted">{t('commandHistoryGaps')}</p>}
            </>
          )}
          <p className="text-caption text-muted">{t('commandObservedOnDevice')}</p>
        </Card>
      </section>
      <CommandAssets
        assets={portfolio.assets}
        prices={portfolio.tokenPrices}
        hidden={hidden}
        current={portfolio.current}
      />
    </div>
  );
}

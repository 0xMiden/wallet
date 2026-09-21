import React, { FC, useRef, useState } from 'react';

import classNames from 'clsx';
import { format } from 'date-fns';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Line, LineChart, Tooltip, YAxis } from 'recharts';

import { useAppEnv } from 'app/env';
import { ReactComponent as ExternalLinkSmallIcon } from 'app/icons/external-link-small.svg';
import { ReactComponent as ReceiveIcon } from 'app/icons/v2/receive-new.svg';
import { ReactComponent as SendIcon } from 'app/icons/v2/send-new.svg';
import HashChip from 'app/templates/HashChip';
import History from 'app/templates/history/History';
import { NetworkChip } from 'components/NetworkChip';
import { PageHeader } from 'components/PageHeader';
import { TokenLogo } from 'components/TokenLogo';
import { Button, ButtonVariant } from 'components/ui/Button';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Hero } from 'components/ui/Hero';
import { Pill, PillTone } from 'components/ui/Pill';
import { SectionHeader } from 'components/ui/SectionHeader';
import { Skeleton } from 'components/ui/Skeleton';
import { usePreset } from 'lib/animation';
import { toAdaptiveFixed } from 'lib/i18n/numbers';
import { useAccount, useAllBalances, useAllTokensBaseMetadata, useNetwork } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { getExplorerAccountUrl } from 'lib/miden-chain/constants';
import { openExternalUrl } from 'lib/mobile/external-browser';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import { fetchKlineData, getTokenPrice } from 'lib/prices';
import type { Timeframe, TokenPriceInfo } from 'lib/prices';
import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';
import { ChartContainer } from 'lib/ui/charts';
import { goBack, navigate } from 'lib/woozie';
import { EXPLORER_TITLE } from 'screens/generating-transaction/constants';

const TIMEFRAMES: Timeframe[] = ['1H', '1D', '1W', '1M', 'YTD'];

const FLAT_LINE_DATA = Array.from({ length: 10 }, () => ({ value: 1 }));

// One fill shared by every timeframe pill: Framer's layoutId slides it from the old selection to
// the new one (the Activity filter row's technique).
const TIMEFRAME_PILL_LAYOUT_ID = 'token-detail-timeframe-pill';

// The chart draws in the brand accent through the chart container's `--color-price`, so the line
// follows the token rather than a hex literal.
const CHART_CONFIG = { price: { color: 'var(--accent-primary)' } };
const CHART_STROKE = 'var(--color-price)';

function formatTooltipTime(timestamp: number, tf: Timeframe): string {
  const date = new Date(timestamp);
  if (tf === '1H' || tf === '1D') return format(date, 'HH:mm');
  return format(date, 'HH:mm, dd MMM');
}

type TokenDetailProps = {
  tokenId: string;
};

const TokenDetail: FC<TokenDetailProps> = ({ tokenId }) => {
  const { t } = useTranslation();
  const { fullPage, sidePanel } = useAppEnv();
  const account = useAccount();
  const scrollParentRef = useRef<HTMLDivElement>(null);
  const allTokensMetadata = useAllTokensBaseMetadata();
  const { data: balances } = useAllBalances(account.publicKey, allTokensMetadata);
  const tokenPrices = useWalletStore(s => s.tokenPrices);

  const token = balances?.find(b => b.tokenId === tokenId);
  const metadata = token?.metadata || allTokensMetadata[tokenId];
  const symbol = metadata?.symbol || t('unknown');
  const balance = token?.balance ?? 0;
  const priceInfo = getTokenPrice(tokenPrices, symbol);
  const fiatValue = balance * priceInfo.price;
  // `balance` was divided by the placeholder's guessed decimals upstream, so for
  // an unresolved faucet it is not this user's holding — and the fiat figure
  // below is that same wrong number multiplied by a price. The hero is the most
  // emphatic number in the wallet; an em dash says "not known" where a rendered
  // quantity would say "this is what you have".
  const scaleIsKnown = hasKnownScale(metadata);
  // An em dash, not a translated phrase: this slot is a number in the hero,
  // and the header above it already names the token.
  const heroBalance = scaleIsKnown ? toAdaptiveFixed(balance) : '—';

  const handleBack = () => goBack();

  const containerClass =
    isMobile() || sidePanel
      ? 'h-full w-full'
      : fullPage
        ? 'h-[640px] max-h-[640px] w-[600px] max-w-[600px]'
        : 'h-[600px] max-h-[600px] w-[360px] max-w-[360px]';

  return (
    <div className={classNames(containerClass, 'mx-auto overflow-hidden flex flex-col bg-page')}>
      <PageHeader className="px-4" title={symbol} onBack={handleBack} />

      <div className="flex-1 min-h-0 overflow-y-auto" ref={scrollParentRef}>
        <div className="flex flex-col gap-5 px-4 pb-4">
          <Hero
            data-testid="token-detail-hero"
            className="pt-3"
            visual={<TokenLogo symbol={symbol} size="2xl" />}
            value={heroBalance}
            subtitle={scaleIsKnown ? `$${toAdaptiveFixed(fiatValue)}` : undefined}
          />

          <div className="flex gap-2.5">
            <Button
              variant={ButtonVariant.Primary}
              onClick={() => navigate({ pathname: '/send', search: `?tokenId=${tokenId}` })}
              data-testid="token-detail-send"
              className="min-w-0 flex-1 max-w-none"
            >
              <SendIcon aria-hidden="true" className="h-4 w-4 shrink-0 [&_path]:fill-current" />
              <span className="truncate">{t('send')}</span>
            </Button>
            <Button
              variant={ButtonVariant.Secondary}
              onClick={() => navigate('/receive')}
              data-testid="token-detail-receive"
              className="min-w-0 flex-1 max-w-none"
            >
              <ReceiveIcon aria-hidden="true" className="h-4 w-4 shrink-0 [&_path]:fill-current" />
              <span className="truncate">{t('receive')}</span>
            </Button>
          </div>

          <PriceChart symbol={symbol} priceInfo={priceInfo} />

          <TokenInfo tokenId={tokenId} />

          <section data-testid="token-detail-activity">
            <SectionHeader>{t('recentActivity')}</SectionHeader>
            <History
              address={account.publicKey}
              tokenId={tokenId}
              fullHistory={true}
              scrollParentRef={scrollParentRef}
            />
          </section>
        </div>
      </div>
    </div>
  );
};

export default TokenDetail;

/**
 * The 24h change as a status pill. Toned by the change as it is SHOWN (one decimal), so a move
 * that rounds to 0.0% reads neutral, not as a green "+0.0%" or a red "-0.0%". The sign carries the
 * direction too, so it is never color alone.
 */
function priceChange(change24h: number): { tone: PillTone; label: string } {
  const shown = Number(change24h.toFixed(1));
  if (shown > 0) return { tone: 'positive', label: `+${shown.toFixed(1)}` };
  if (shown < 0) return { tone: 'negative', label: shown.toFixed(1) };
  return { tone: 'neutral', label: (0).toFixed(1) };
}

const PriceChart: FC<{ symbol: string; priceInfo: TokenPriceInfo }> = ({ symbol, priceInfo }) => {
  const { t } = useTranslation();
  const [timeframe, setTimeframe] = useState<Timeframe>('1D');
  const indicator = usePreset('indicator');

  const { data: klineData } = useRetryableSWR(['kline', symbol, timeframe], () => fetchKlineData(symbol, timeframe), {
    dedupingInterval: 30_000,
    // Hold the previous timeframe's line while the next one loads, so switching does not flash
    // the skeleton; only the very first load shows it.
    keepPreviousData: true
  });

  // `fetchKlineData` resolves `[]` on failure or for a token with no market, so `undefined` only
  // ever means the first load is still in flight.
  const loading = klineData === undefined;
  const chartData = klineData && klineData.length > 0 ? klineData : FLAT_LINE_DATA;

  const values = chartData.map(d => d.value);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const padding = (maxVal - minVal) * 0.05 || maxVal * 0.01;
  const yDomain: [number, number] = [minVal - padding, maxVal + padding];

  const change = priceChange(priceInfo.change24h);

  // Sits on `page`, not a `Card`: a status pill's ink only clears 4.5:1 on `page` (see `Pill`), and
  // the chart reads better at the full content width than inset in a card.
  return (
    <section data-testid="token-detail-price">
      <SectionHeader>{t('tokenPrice')}</SectionHeader>
      <div className="flex items-center justify-between gap-3 px-1">
        <span className="min-w-0 truncate font-heading text-xl leading-[26px] font-extrabold text-ink">
          ${toAdaptiveFixed(priceInfo.price, 3)}
        </span>
        <Pill size="sm" tone={change.tone} data-testid="token-detail-price-change">
          {t('tokenDetailChange24h', { change: change.label })}
        </Pill>
      </div>
      <div className="mt-3 h-20">
        {loading ? (
          <Skeleton className="h-full w-full rounded-2xl" />
        ) : (
          <ChartContainer config={CHART_CONFIG} className="h-full w-full aspect-auto">
            <LineChart data={chartData}>
              <YAxis domain={yDomain} hide />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.[0]) return null;
                  const point = payload[0].payload;
                  return (
                    <div className="rounded-xl bg-ink px-2 py-1 text-xs text-page">
                      <div className="font-heading font-bold">${toAdaptiveFixed(point.value)}</div>
                      {point.time && <div>{formatTooltipTime(point.time, timeframe)}</div>}
                    </div>
                  );
                }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke={CHART_STROKE}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, stroke: CHART_STROKE, fill: 'var(--ds-page)', strokeWidth: 2 }}
              />
            </LineChart>
          </ChartContainer>
        )}
      </div>
      <div className="mt-3 flex items-center gap-2">
        {TIMEFRAMES.map(tf => {
          const isActive = tf === timeframe;
          return (
            <div key={tf} className="relative shrink-0">
              {isActive && (
                <motion.span
                  layoutId={TIMEFRAME_PILL_LAYOUT_ID}
                  className="pointer-events-none absolute inset-0 rounded-full bg-accent-tint"
                  transition={indicator.transition}
                />
              )}
              <Pill
                tone={isActive ? 'plain' : 'neutral'}
                selected={isActive}
                haptic="selection"
                onClick={() => setTimeframe(tf)}
                data-testid={`token-detail-timeframe-${tf}`}
                className={classNames(
                  'transition-colors motion-reduce:transition-none',
                  isActive && 'bg-transparent text-accent-tint-ink'
                )}
              >
                {tf}
              </Pill>
            </div>
          );
        })}
      </div>
    </section>
  );
};

const TokenInfo: FC<{ tokenId: string }> = ({ tokenId }) => {
  const { t } = useTranslation();
  const network = useNetwork();
  // Undefined on a build with no explorer configured for the effective network (e.g. a custom
  // dev-settings override with a blank explorer URL) — the row below degrades by not rendering,
  // the same way history's explorer links do (`TransactionStatus.tsx`'s `ExternalLinkValue`).
  const explorerUrl = getExplorerAccountUrl(tokenId);

  const handleViewExplorer = () => {
    if (!explorerUrl) return;
    hapticLight();
    void openExternalUrl({ url: explorerUrl, title: EXPLORER_TITLE });
  };

  return (
    <section data-testid="token-detail-info">
      <SectionHeader>{t('tokenInfo')}</SectionHeader>
      <DetailCard>
        {/* The same compact middle-truncated hash chip as history and contacts (`HashChip`, a
            `CopyChip` around `HashShortView`): trimmed to read, copied and stored in full — the
            hidden sibling input `CopyChip` renders carries the untrimmed id for the E2E suite. */}
        <DetailRow label={t('contract')} data-testid="token-detail-contract">
          <HashChip
            hash={tokenId}
            data-testid="token-detail-copy-contract"
            className="min-w-0 font-sans text-[15px] font-normal text-ink"
          />
        </DetailRow>
        <DetailRow label={t('type')}>{t('fungible')}</DetailRow>
        <DetailRow label={t('network')}>
          <NetworkChip kind="miden" label={network.name} />
        </DetailRow>
        {explorerUrl && (
          // An `accent-tint-ink` text action, not a nested `ListRow`: a `ListRow` draws its own
          // hairline via a `before:` pseudo-element, which would double up with `DetailCard`'s
          // `divide-y` on every row after the first. This reuses the same action styling as the
          // "Copy" row above and the success receipt's "View on Midenscan" link
          // (`generating-transaction/success/TransactionSuccessLayout.tsx`).
          <button
            type="button"
            onClick={handleViewExplorer}
            data-testid="token-detail-explorer"
            className="flex w-full items-center justify-between px-4 py-3 text-left font-heading text-[15px] font-bold text-accent-tint-ink"
          >
            {t('viewOnMidenscan')}
            <ExternalLinkSmallIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          </button>
        )}
      </DetailCard>
    </section>
  );
};

import React, { FC, useRef, useState } from 'react';

import classNames from 'clsx';
import { format } from 'date-fns';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Line, LineChart, Tooltip, YAxis } from 'recharts';

import { useAppEnv } from 'app/env';
import { ReactComponent as ReceiveIcon } from 'app/icons/receive-new.svg';
import { ReactComponent as SendIcon } from 'app/icons/send-new.svg';
import { Icon, IconName } from 'app/icons/v2';
import History from 'app/templates/history/History';
import { NavigationHeader } from 'components/NavigationHeader';
import { TokenLogo } from 'components/TokenLogo';
import { useAccount, useAllBalances, useAllTokensBaseMetadata, useNetwork } from 'lib/miden/front';
import { hapticSelection } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import { fetchKlineData, getTokenPrice } from 'lib/prices';
import type { Timeframe, TokenPriceInfo } from 'lib/prices';
import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';
import { ChartContainer } from 'lib/ui/charts';
import { goBack, navigate } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

const TIMEFRAMES: Timeframe[] = ['1H', '1D', '1W', '1M', 'YTD'];

const FLAT_LINE_DATA = Array.from({ length: 10 }, () => ({ value: 1 }));

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
  const { fullPage } = useAppEnv();
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

  const handleBack = () => goBack();

  const containerClass = isMobile()
    ? 'h-full w-full'
    : fullPage
      ? 'h-[640px] max-h-[640px] w-[600px] max-w-[600px]'
      : 'h-[600px] max-h-[600px] w-[360px] max-w-[360px]';

  return (
    <div className={classNames(containerClass, 'mx-auto overflow-hidden flex flex-col bg-app-bg')}>
      <NavigationHeader title={symbol} onBack={handleBack} />

      <div className="flex-1 min-h-0 overflow-y-auto" ref={scrollParentRef}>
        <div className="flex flex-col px-4">
          {/* Token Hero */}
          <div className="flex flex-col items-center pt-4 pb-4">
            <TokenLogo symbol={symbol} size="xl" className="rounded-10" />

            <span className="text-[44px] font-bold text-heading-gray leading-none pt-2">{balance.toFixed(2)}</span>
            <span className="text-sm font-semibold text-heading-gray opacity-50 leading-none pt-1">
              ${fiatValue.toFixed(2)}
            </span>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3">
            <button
              onClick={() => navigate({ pathname: '/send', search: `?tokenId=${tokenId}` })}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-send-blue text-pure-white font-semibold text-sm"
            >
              <SendIcon className="w-4 h-4" />
              {t('send')}
            </button>
            <button
              onClick={() => navigate('/receive')}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-receive-green text-pure-white font-semibold text-sm"
            >
              <ReceiveIcon className="w-4 h-4" />
              {t('receive')}
            </button>
          </div>
          <hr className="bg-[#BABABA] opacity-20 h-px mt-4 mb-4" />
          <PriceChart symbol={symbol} priceInfo={priceInfo} />

          <hr className="bg-[#BABABA] opacity-20 h-px mt-4 mb-4" />
          {/* Token Info Card */}
          <TokenInfoCard tokenId={tokenId} />

          {/* Recent Activity */}
          <div className="mb-4">
            <span className="text-sm font-bold text-heading-gray opacity-[0.32] uppercase block text-center mb-3">
              {t('recentActivity')}
            </span>
            <History
              address={account.publicKey}
              tokenId={tokenId}
              fullHistory={true}
              scrollParentRef={scrollParentRef}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default TokenDetail;

const PriceChart: FC<{ symbol: string; priceInfo: TokenPriceInfo }> = ({ symbol, priceInfo }) => {
  const { t } = useTranslation();
  const [timeframe, setTimeframe] = useState<Timeframe>('1D');

  const { data: klineData } = useRetryableSWR(['kline', symbol, timeframe], () => fetchKlineData(symbol, timeframe), {
    dedupingInterval: 30_000
  });

  const chartData = klineData && klineData.length > 0 ? klineData : FLAT_LINE_DATA;

  const values = chartData.map(d => d.value);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const padding = (maxVal - minVal) * 0.05 || maxVal * 0.01;
  const yDomain: [number, number] = [minVal - padding, maxVal + padding];

  return (
    <>
      <div className="rounded-2xl bg-white px-4 pt-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold text-heading-gray opacity-[0.32] uppercase">{t('tokenPrice')}</span>
          <span
            className={classNames(
              'text-xs font-semibold px-2 py-0.5 rounded-full',
              priceInfo.change24h >= 0 ? 'text-green-200 bg-green-50' : 'text-red-600 bg-red-50'
            )}
          >
            {priceInfo.change24h >= 0 ? '+' : ''}
            {priceInfo.change24h.toFixed(1)}%
          </span>
        </div>
        <span className="text-2xl font-bold text-heading-gray">${priceInfo.price.toFixed(3)}</span>
        <div className="mt-3 h-20">
          <ChartContainer config={{ price: { color: '#FF5500' } }} className="h-full w-full aspect-auto">
            <LineChart data={chartData}>
              <YAxis domain={yDomain} hide />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.[0]) return null;
                  const point = payload[0].payload;
                  return (
                    <div className="rounded-lg bg-heading-gray px-2 py-1 text-xs text-pure-white shadow">
                      <div className="font-semibold">${Number(point.value).toFixed(2)}</div>
                      {point.time && <div className="opacity-75">{formatTooltipTime(point.time, timeframe)}</div>}
                    </div>
                  );
                }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="#FF5500"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, stroke: '#FF5500', fill: '#fff', strokeWidth: 2 }}
              />
            </LineChart>
          </ChartContainer>
        </div>
      </div>
      <div className="flex justify-center gap-2 mt-1">
        {TIMEFRAMES.map(tf => (
          <button
            key={tf}
            onClick={() => {
              hapticSelection();
              setTimeframe(tf);
            }}
            className="relative text-center text-sm font-semibold py-1.5 px-4.5 rounded-5"
          >
            {tf === timeframe && (
              <motion.div
                layoutId="timeframe-pill"
                className="absolute inset-0 rounded-5 bg-white"
                transition={{ type: 'spring', bounce: 0.15, duration: 0.4 }}
              />
            )}
            <span className={classNames('relative z-10', tf === timeframe ? 'text-primary-500' : 'text-black')}>
              {tf}
            </span>
          </button>
        ))}
      </div>
    </>
  );
};

const InfoRow: FC<{ left: React.ReactNode; right: React.ReactNode }> = ({ left, right }) => (
  <div className="flex items-center justify-between px-4 py-3">
    <span className="text-sm text-heading-gray opacity-50">{left}</span>
    <span className="text-sm text-heading-gray font-medium">{right}</span>
  </div>
);

const TokenInfoCard: FC<{ tokenId: string }> = ({ tokenId }) => {
  const { t } = useTranslation();
  const network = useNetwork();

  return (
    <div className="mb-6">
      <span className="text-sm font-bold text-heading-gray opacity-[0.32] uppercase block text-center mb-4">
        {t('tokenInfo')}
      </span>
      <div className="rounded-2xl bg-white divide-y divide-heading-gray/10">
        <InfoRow
          left={t('contract')}
          right={
            <div className="flex items-center gap-2 font-bold">
              {truncateAddress(tokenId)}
              <button
                onClick={() => navigator.clipboard.writeText(tokenId)}
                className="w-6.5 h-6.5 bg-[#00000012] rounded-lg flex items-center justify-center cursor-pointer"
              >
                <Icon
                  name={IconName.Copy}
                  style={{ height: '12px', width: '12px', strokeColor: '#48484814', strokeWidth: '2px' }}
                />
              </button>
            </div>
          }
        />
        <InfoRow left={t('type')} right={t('fungible')} />
        <InfoRow left={t('network')} right={network.name} />
      </div>
    </div>
  );
};

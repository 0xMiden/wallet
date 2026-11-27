import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { SectionHeader } from 'components/ui/SectionHeader';
import { UsdAmount } from 'components/ui/TokenAmount';
import { formatUsdDisplay } from 'lib/i18n/amount-display';
import { useTrackedPosition } from 'lib/miden/front/use-tracked-position';
import type { TokenPriceInfo } from 'lib/prices';
import { valuePosition } from 'lib/prices/position-pnl';

// Micro-dollars.
const MICRO_DECIMALS = 6;

type TokenDetailPositionProps = {
  accountId: string;
  network: string;
  /** Canonical faucet id. */
  faucetId: string;
  /** The vault balance in base units. */
  held: bigint;
  decimals: number;
  symbol: string;
  quote: TokenPriceInfo | undefined;
};

/** Since-arrival profit and loss of the held amount, shown as a number only when this device's records explain it. */
export const TokenDetailPosition: FC<TokenDetailPositionProps> = ({
  accountId,
  network,
  faucetId,
  held,
  decimals,
  symbol,
  quote
}) => {
  const { t } = useTranslation();
  const tracked = useTrackedPosition(accountId, network, faucetId, quote?.kind !== 'basket');
  // A basket is valued from its vault, which has no price at the time each token arrived.
  if (quote?.kind !== 'basket' && tracked === undefined) return null;

  const pnl =
    tracked && quote?.kind !== 'basket'
      ? valuePosition(tracked.position, { held, now: Date.now(), quote, decimals })
      : undefined;
  const unknownBody =
    pnl === undefined
      ? t('tokenDetailPnlBasketBody')
      : pnl.status === 'unknown'
        ? t(pnl.reason === 'no-value' ? 'tokenDetailPnlNoPriceBody' : 'tokenDetailPnlIncompleteBody')
        : undefined;

  return (
    <section data-testid="token-detail-position">
      <SectionHeader size="2xl" tone="muted" className="px-0 pb-3">
        {t('tokenDetailPnlTitle')}
      </SectionHeader>
      <DetailCard surface="outline">
        {pnl?.status === 'known' ? (
          <>
            <DetailRow label={t('tokenDetailPnlUnrealized')} data-testid="token-detail-pnl">
              <span
                data-testid="token-detail-pnl-value"
                className={classNames(
                  pnl.pnlMicro > 0n && 'text-positive-tint-ink',
                  pnl.pnlMicro < 0n && 'text-negative-tint-ink'
                )}
              >
                <UsdAmount
                  amount={pnl.pnlMicro}
                  decimals={MICRO_DECIMALS}
                  renderText={text => (pnl.pnlMicro > 0n ? `+${text}` : text)}
                />
                {pnl.pnlBps !== undefined && ` (${t('tokenDetailPnlPercent', { percent: signedPercent(pnl.pnlBps) })})`}
              </span>
            </DetailRow>
            <DetailRow label={t('tokenDetailPnlCost')} data-testid="token-detail-pnl-cost">
              <UsdAmount amount={pnl.costMicro} decimals={MICRO_DECIMALS} />
            </DetailRow>
            {pnl.averageCostMicro !== undefined && (
              <DetailRow label={t('tokenDetailPnlAverageCost')} data-testid="token-detail-pnl-average">
                {t('tokenDetailPnlAverageCostValue', {
                  amount: formatUsdDisplay(pnl.averageCostMicro, { decimals: MICRO_DECIMALS }),
                  symbol
                })}
              </DetailRow>
            )}
          </>
        ) : (
          <DetailRow
            label={t('tokenDetailPnlUnrealized')}
            stacked
            sub={unknownBody}
            data-testid="token-detail-pnl-unknown"
          >
            {t('tokenDetailPnlUnknown')}
          </DetailRow>
        )}
      </DetailCard>
      {tracked?.trackingSince !== undefined && (
        <p className="px-1 pt-2 text-caption text-muted" data-testid="token-detail-pnl-since">
          {t('tokenDetailPnlSince', { date: new Date(tracked.trackingSince).toLocaleDateString() })}
        </p>
      )}
    </section>
  );
};

/** Hundredths of a percent as a signed percent with two decimals, e.g. 521n -> "+5.21". */
export function signedPercent(bps: bigint): string {
  const negative = bps < 0n;
  const magnitude = negative ? -bps : bps;
  const text = `${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, '0')}`;
  return bps === 0n ? text : `${negative ? '-' : '+'}${text}`;
}

import React from 'react';

import { useTranslation } from 'react-i18next';

import { TokenLogo } from 'components/TokenLogo';
import { ListGroup, ListRow, SectionHeader } from 'components/ui';
import { formatAmountDisplay } from 'lib/i18n/amount-display';
import { getNumberSymbols } from 'lib/i18n/core';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { tokenQuote } from 'lib/miden/swap/tokens';
import type { TokenPrices } from 'lib/prices';
import { isNominalQuote } from 'lib/prices/binance';
import { isFixedQuote } from 'lib/prices/fixed';
import { useWalletStore } from 'lib/store';

export function CommandAssets({
  assets,
  prices,
  hidden,
  current
}: {
  assets: readonly TokenBalanceData[];
  prices: TokenPrices;
  hidden: boolean;
  current: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  const pricesReady = useWalletStore(state => state.tokenPricesStatus === 'ready');
  const displayOptions = {
    minimumFractionDigits: 2,
    trimTrailingZeros: false,
    grouping: true,
    separators: getNumberSymbols()
  };
  return (
    <section>
      <SectionHeader size="xl">{t('assets')}</SectionHeader>
      <ListGroup surface="outline" aria-label={t('assets')}>
        {assets.map(asset => {
          const quote = tokenQuote(prices, asset.tokenId, asset.metadata.symbol);
          const known = hasKnownScale(asset.metadata);
          const now = Date.now();
          const available =
            pricesReady &&
            known &&
            quote &&
            !isNominalQuote(quote) &&
            Number.isFinite(quote.price) &&
            quote.price > 0 &&
            Number.isFinite(asset.balance) &&
            (isFixedQuote(quote) ||
              (quote.observedAt && quote.observedAt <= now && now - quote.observedAt <= 15 * 60_000));
          return (
            <ListRow
              key={asset.tokenId}
              avatar={<TokenLogo faucetId={asset.tokenId} size="lg" />}
              title={asset.metadata.name || asset.metadata.symbol}
              subtitle={
                hidden
                  ? t('commandMaskedBalance')
                  : !current
                    ? t('commandBalanceUnavailable')
                    : !Number.isFinite(asset.balance)
                      ? t('commandBalanceUnavailable')
                      : known
                        ? `${formatAmountDisplay(asset.balance, displayOptions)} ${asset.metadata.symbol}`
                        : t('assetValueUnknownScale')
              }
              value={
                hidden
                  ? t('commandMaskedBalance')
                  : !current
                    ? t('commandBalanceUnavailable')
                    : available
                      ? `${formatAmountDisplay(asset.balance * quote.price, displayOptions)} USD`
                      : t('commandPriceUnavailable')
              }
            />
          );
        })}
      </ListGroup>
    </section>
  );
}

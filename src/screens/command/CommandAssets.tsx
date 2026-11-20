import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { TokenLogo } from 'components/TokenLogo';
import { ListGroup, ListRow, SectionHeader } from 'components/ui';
import { EmptyState } from 'components/ui/EmptyState';
import { Notice } from 'components/ui/Notice';
import { SearchInput } from 'components/ui/SearchInput';
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
  const [query, setQuery] = useState('');
  const pricesReady = useWalletStore(state => state.tokenPricesStatus === 'ready');
  const search = query.trim().toLowerCase();
  const matchingAssets =
    current && search
      ? assets.filter(
          asset =>
            asset.metadata.name.toLowerCase().includes(search) || asset.metadata.symbol.toLowerCase().includes(search)
        )
      : assets;
  const displayOptions = {
    minimumFractionDigits: 2,
    trimTrailingZeros: false,
    grouping: true,
    separators: getNumberSymbols()
  };
  return (
    <section>
      <SectionHeader size="xl">{t('assets')}</SectionHeader>
      {current && assets.length > 0 && (
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={t('searchAssets')}
          inputMode="search"
          size="sm"
          className="mb-3"
        />
      )}
      {!current && assets.length === 0 ? (
        <Notice tone="neutral" variant="inline">
          {t('commandBalanceUnavailable')}
        </Notice>
      ) : assets.length === 0 ? (
        <EmptyState size="compact" icon={IconName.Coins} title={t('noNoteAssets')} />
      ) : current && matchingAssets.length === 0 ? (
        <EmptyState size="compact" icon={IconName.Search} title={t('exploreNoResultsTitle')} />
      ) : (
        <ListGroup surface="outline" aria-label={t('assets')}>
          {matchingAssets.map(asset => {
            const quote = tokenQuote(prices, asset.tokenId, asset.metadata.symbol);
            const known = hasKnownScale(asset.metadata);
            const baseUnits = !hidden && current && known ? asset.balanceBaseUnits : undefined;
            const quantity =
              typeof baseUnits === 'string' && baseUnits.length > 0 && !/[^0-9]/.test(baseUnits)
                ? BigInt(baseUnits)
                : undefined;
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
                      : !known
                        ? t('assetValueUnknownScale')
                        : quantity === undefined
                          ? t('commandBalanceUnavailable')
                          : `${formatAmountDisplay(quantity, {
                              ...displayOptions,
                              decimals: asset.metadata.decimals,
                              rounding: 'down'
                            })} ${asset.metadata.symbol}`
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
      )}
    </section>
  );
}

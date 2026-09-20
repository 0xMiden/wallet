import React, { useCallback, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { TokenLogo } from 'components/TokenLogo';
import { AssetListItem } from 'components/ui/AssetListItem';
import { SearchInput } from 'components/ui/SearchInput';
import { toAdaptiveFixed } from 'lib/i18n/numbers';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { getTokenPrice } from 'lib/prices';
import { useWalletStore } from 'lib/store';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

import { UIToken } from './types';

export interface SelectTokenDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (token: UIToken) => void;
}

/**
 * Token picker for the send flow, presented as a bottom sheet (vaul) over the
 * Amount step instead of a pushed sub-screen. Fixed at a comfortable height
 * even when the token list is short.
 *
 * Rows are the home tab's Assets rows (`AssetListItem`): 72px on the sheet's own
 * surface, divided by a hairline rather than boxed, a 36px logo, the token name
 * over its balance and the fiat value on the right — the same shape the swap
 * picker draws, so the two sheets read as one list.
 */
export const SelectTokenDrawer: React.FC<SelectTokenDrawerProps> = ({ open, onOpenChange, onSelect }) => {
  const { t } = useTranslation();
  const { publicKey } = useAccount();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balanceData = [] } = useAllBalances(publicKey, allTokensBaseMetadata);
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  const [searchQuery, setSearchQuery] = useState('');

  const filteredBalances = useMemo(() => {
    if (!searchQuery.trim()) return balanceData;
    const query = searchQuery.toLowerCase();
    return balanceData.filter(
      b => b.metadata.symbol.toLowerCase().includes(query) || b.metadata.name?.toLowerCase().includes(query)
    );
  }, [balanceData, searchQuery]);

  const onSelectToken = useCallback(
    (token: UIToken) => {
      onSelect(token);
      setSearchQuery('');
      onOpenChange(false);
    },
    [onSelect, onOpenChange]
  );

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="token">
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('selectAToken')}</DrawerTitle>
        </DrawerHeader>
        <div className="flex h-120 min-h-0 flex-col px-4 pb-4">
          <SearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={t('searchForTokens')}
            data-testid="send-token-search"
            className="shrink-0"
          />
          <div className="no-scrollbar min-h-0 overflow-y-auto pt-5">
            <div className="flex flex-col divide-y divide-rule-default">
              {filteredBalances.map(b => {
                const scaleIsKnown = hasKnownScale(b.metadata);
                const price = getTokenPrice(tokenPrices, b.metadata.symbol).price;
                return (
                  <AssetListItem
                    key={b.tokenId}
                    icon={<TokenLogo symbol={b.metadata.symbol} />}
                    name={b.metadata.name || b.metadata.symbol}
                    amount={scaleIsKnown ? `${toAdaptiveFixed(b.balance)} ${b.metadata.symbol}` : b.metadata.symbol}
                    price={scaleIsKnown ? `$${toAdaptiveFixed(b.balance * price)}` : undefined}
                    data-testid={`send-token-${b.metadata.symbol}`}
                    data-token-id={b.tokenId}
                    onClick={() =>
                      onSelectToken({
                        id: b.tokenId,
                        name: b.metadata.symbol,
                        decimals: b.metadata.decimals,
                        balance: b.balance,
                        fiatPrice: b.fiatPrice,
                        scaleIsKnown
                      })
                    }
                  />
                );
              })}
            </div>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

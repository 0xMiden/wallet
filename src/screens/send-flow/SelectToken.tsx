import React, { useCallback, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { AssetRow } from 'components/AssetRow';
import { SearchInput } from 'components/ui';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
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
        <div className="flex flex-col min-h-0 px-4 pb-4 h-120">
          <SearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={t('searchForTokens')}
            data-testid="send-token-search"
          />
          <div className="flex flex-col min-h-0 overflow-y-auto no-scrollbar divide-y divide-rule-default">
            {filteredBalances.map(b => (
              <AssetRow
                key={b.tokenId}
                asset={b}
                tokenPrices={tokenPrices}
                data-testid={`send-token-${b.metadata.symbol}`}
                onClick={() =>
                  onSelectToken({
                    id: b.tokenId,
                    name: b.metadata.symbol,
                    decimals: b.metadata.decimals,
                    balance: b.balance,
                    fiatPrice: b.fiatPrice,
                    scaleIsKnown: hasKnownScale(b.metadata)
                  })
                }
              />
            ))}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

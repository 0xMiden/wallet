import React, { useCallback, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { AssetRow } from 'components/AssetRow';
import { SearchInput } from 'components/ui';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { useWalletStore } from 'lib/store';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

import { UIToken } from './types';

export interface SelectTokenDrawerProps {
  open: boolean;
  onClose: () => void;
  onSelectToken: (token: UIToken) => void;
}

export const SelectTokenDrawer: React.FC<SelectTokenDrawerProps> = ({ open, onClose, onSelectToken }) => {
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

  const handleSelect = useCallback(
    (token: UIToken) => {
      onSelectToken(token);
      onClose();
    },
    [onSelectToken, onClose]
  );

  return (
    <Drawer open={open} onOpenChange={isOpen => !isOpen && onClose()}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('selectToken')}</DrawerTitle>
        </DrawerHeader>
        <div className="flex flex-col flex-1 min-h-0 overflow-y-auto no-scrollbar px-4 pb-4">
          <SearchInput value={searchQuery} onChange={setSearchQuery} placeholder={t('searchByNameOrSymbol')} />
          <div className="flex flex-col divide-y divide-rule-default">
            {filteredBalances.map(b => (
              <AssetRow
                key={b.tokenId}
                asset={b}
                tokenPrices={tokenPrices}
                onClick={() =>
                  handleSelect({
                    id: b.tokenId,
                    name: b.metadata.symbol,
                    decimals: b.metadata.decimals,
                    balance: b.balance,
                    fiatPrice: b.fiatPrice
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

import React, { HTMLAttributes, useCallback, useMemo, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { AssetRow } from 'components/AssetRow';
import { SearchInput } from 'components/ui';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { useWalletStore } from 'lib/store';

import { SendFlowAction, SendFlowActionId, SendFlowStep, UIToken } from './types';

export interface SelectTokenScreenProps extends HTMLAttributes<HTMLDivElement> {
  onAction?: (action: SendFlowAction) => void;
}

export const SelectToken: React.FC<SelectTokenScreenProps> = ({ className, onAction, ...props }) => {
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
      onAction?.({
        id: SendFlowActionId.SetFormValues,
        payload: {
          token
        }
      });
      onAction?.({
        id: SendFlowActionId.Navigate,
        step: SendFlowStep.SendDetails
      });
    },
    [onAction]
  );

  return (
    <div {...props} className={classNames('flex-1 flex flex-col bg-app-bg', className)}>
      <div className="flex flex-col flex-1 px-4 pt-4">
        <SearchInput value={searchQuery} onChange={setSearchQuery} placeholder={t('searchByNameOrSymbol')} />
        <div className="flex flex-col divide-y divide-rule-default">
          {filteredBalances.map(b => (
            <AssetRow
              key={b.tokenId}
              asset={b}
              tokenPrices={tokenPrices}
              onClick={() =>
                onSelectToken({
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
    </div>
  );
};

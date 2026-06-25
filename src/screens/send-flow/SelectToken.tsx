import React, { HTMLAttributes, useCallback, useMemo, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { AssetRow } from 'components/AssetRow';
import { CircleButton } from 'components/CircleButton';
import { SearchInput } from 'components/ui';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { useWalletStore } from 'lib/store';

import { SendFlowAction, SendFlowActionId, UIToken } from './types';

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
      onAction?.({ id: SendFlowActionId.SetFormValues, payload: { token } });
      // Token selection is a sub-screen pushed from SelectAmount — pop back to it.
      onAction?.({ id: SendFlowActionId.GoBack });
    },
    [onAction]
  );

  return (
    <div {...props} className={classNames('flex-1 flex flex-col bg-app-bg', className)}>
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto no-scrollbar px-4 pt-4 pb-32">
        <CircleButton
          icon={IconName.BackArrow}
          color="currentColor"
          size="sm"
          onClick={() => onAction?.({ id: SendFlowActionId.GoBack })}
          className="text-primary-500 border border-border-card self-start mb-4"
        />
        <h1 className="font-heading text-2xl font-bold text-[#808080] mb-4">{t('selectAToken')}</h1>
        <SearchInput value={searchQuery} onChange={setSearchQuery} placeholder={t('searchForTokens')} />
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

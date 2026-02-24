import React, { HTMLAttributes, useCallback, useMemo, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { Avatar } from 'components/Avatar';
import { CardItem } from 'components/CardItem';
import { NavigationHeader } from 'components/NavigationHeader';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';

import { SendFlowAction, SendFlowActionId, SendFlowStep, UIToken } from './types';

export interface SelectTokenScreenProps extends HTMLAttributes<HTMLDivElement> {
  onAction?: (action: SendFlowAction) => void;
}

export const SelectToken: React.FC<SelectTokenScreenProps> = ({ className, onAction, ...props }) => {
  const { t } = useTranslation();
  const { publicKey } = useAccount();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balanceData } = useAllBalances(publicKey, allTokensBaseMetadata);
  const midenFaucetId = useMidenFaucetId();
  const [searchQuery, setSearchQuery] = useState('');

  const tokens = useMemo(() => {
    return (
      balanceData?.map(token => ({
        id: token.tokenId,
        name: token.metadata.symbol,
        decimals: token.metadata.decimals,
        balance: token.balance,
        fiatPrice: token.fiatPrice
      })) || []
    );
  }, [balanceData]);

  const filteredTokens = useMemo(() => {
    if (!searchQuery.trim()) return tokens;
    const query = searchQuery.toLowerCase();
    return tokens.filter(token => token.name.toLowerCase().includes(query));
  }, [tokens, searchQuery]);

  const onCancel = useCallback(() => {
    onAction?.({
      id: SendFlowActionId.Finish
    });
  }, [onAction]);

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

  const fiatBalance = (token: UIToken): number => token.balance * token.fiatPrice;

  return (
    <div {...props} className={classNames('flex-1 flex flex-col', className)}>
      <NavigationHeader mode="back" title={t('send')} onBack={onCancel} showBorder />
      <div className="flex flex-col flex-1 px-4 pt-4">
        <input
          type="text"
          placeholder={t('searchByNameOrSymbol')}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="w-full bg-gray-25 rounded-xl py-4 px-4 text-center text-base placeholder-[#484848A3] outline-none"
        />
        <div className="flex flex-col py-4">
          {filteredTokens.map(token => {
            const isMiden = token.id === midenFaucetId;
            return (
              <CardItem
                key={token.id}
                iconLeft={<Avatar size="lg" image={isMiden ? '/misc/miden.png' : '/misc/token-logos/default.svg'} />}
                title={token.name}
                subtitle={token.name.toUpperCase()}
                titleRight={token.balance.toFixed(0)}
                subtitleRight={`${fiatBalance(token).toFixed(0)} USD`}
                className="border-b-[0.25px] border-[#00000033] border-dashed rounded-none px-0 py-3 justify-between"
                hoverable={true}
                onClick={() => onSelectToken(token)}
                titleClassName="!font-medium text-lg"
                subtitleClassName="!font-normal text-[#484848A3] text-xs"
              />
            );
          })}
        </div>
      </div>
    </div>
  );
};

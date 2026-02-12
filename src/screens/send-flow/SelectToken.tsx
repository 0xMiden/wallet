import React, { HTMLAttributes, useCallback, useMemo } from 'react';

import classNames from 'clsx';
import { formatValue } from 'react-currency-input-field';
import { useTranslation } from 'react-i18next';

import { AssetIcon } from 'app/templates/AssetIcon';
import { Button, ButtonVariant } from 'components/Button';
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
    <div {...props} className={classNames('flex-1 flex flex-col ', className)}>
      <NavigationHeader mode="back" title={t('chooseToken')} onBack={onCancel} showBorder />
      <div className="flex flex-col flex-1 p-4 justify-between md:w-[460px] md:mx-auto">
        <div className="flex-1">
          {tokens?.map(token => (
            <CardItem
              key={token.id}
              title={token.name.toUpperCase()}
              titleRight={formatValue({
                value: token.balance.toString()
              })}
              subtitleRight={['≈ ', '$', fiatBalance(token)].join('')}
              iconLeft={
                <AssetIcon
                  assetSlug={token.name.toLowerCase()}
                  assetId={token.id}
                  size={24}
                  className="mr-2 flex-shrink-0 rounded bg-white"
                />
              }
              onClick={() => onSelectToken(token)}
              hoverable
            />
          ))}
        </div>
      </div>
    </div>
  );
};

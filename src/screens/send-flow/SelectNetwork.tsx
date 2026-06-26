import React, { HTMLAttributes, useCallback } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { CircleButton } from 'components/CircleButton';
import { hapticLight } from 'lib/mobile/haptics';

import { BRIDGE_NETWORKS, BRIDGE_OUTPUT_TOKEN_SYMBOL, BridgeNetworkId } from './bridge-networks';
import { SendFlowAction, SendFlowActionId } from './types';

export interface SelectNetworkScreenProps extends HTMLAttributes<HTMLDivElement> {
  selectedNetwork?: BridgeNetworkId;
  onAction?: (action: SendFlowAction) => void;
}

/**
 * Destination-network picker for cross-chain (0x recipient) sends. Pushed as a
 * sub-screen from SelectAmount. Today only Sepolia is offered — whichever token
 * the user sends arrives as USDC there — but the list renders straight off
 * BRIDGE_NETWORKS so adding chains is a one-line config change.
 */
export const SelectNetwork: React.FC<SelectNetworkScreenProps> = ({
  className,
  selectedNetwork,
  onAction,
  ...props
}) => {
  const { t } = useTranslation();

  const onSelect = useCallback(
    (id: BridgeNetworkId) => {
      hapticLight();
      onAction?.({ id: SendFlowActionId.SetFormValues, payload: { bridgeNetwork: id } });
      // Network selection is a sub-screen pushed from SelectAmount — pop back to it.
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
        <h1 className="font-heading text-2xl font-bold text-[#808080] mb-4">{t('selectNetwork')}</h1>
        <div className="flex flex-col divide-y divide-rule-default">
          {BRIDGE_NETWORKS.map(network => {
            const isSelected = network.id === selectedNetwork;
            return (
              <button
                key={network.id}
                type="button"
                onClick={() => onSelect(network.id)}
                className="flex items-center gap-3 py-3.5 text-left"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-500">
                  <Icon name={IconName.Globe} size="sm" className="text-pure-white" fill="currentColor" />
                </span>
                <div className="flex flex-1 flex-col">
                  <span className="text-base font-bold text-heading-gray">{network.name}</span>
                  <span className="text-xs text-heading-gray/50">
                    {t('receiveOnArrivesAs', { network: network.name, symbol: BRIDGE_OUTPUT_TOKEN_SYMBOL })}
                  </span>
                </div>
                {isSelected && (
                  <Icon name={IconName.CheckboxCircleFill} size="sm" className="text-primary-500" fill="currentColor" />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

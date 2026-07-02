import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { DEFAULT_BRIDGE_NETWORK, BRIDGE_OUTPUT_TOKEN_SYMBOL } from 'screens/send-flow/bridge-networks';
import { SelectAmount } from 'screens/send-flow/SelectAmount';
import { UIToken } from 'screens/send-flow/types';

interface EvmBridgeDepositFormProps {
  token: UIToken;
  amount: string;
  isValidAmount: boolean;
  error?: string;
  onAmountChange: (value: string) => void;
  /** Opens the ETH/USDC token picker drawer. */
  onSelectToken: () => void;
  onContinue: () => void;
}

export const EvmBridgeDepositForm: React.FC<EvmBridgeDepositFormProps> = ({
  token,
  amount,
  isValidAmount,
  error,
  onAmountChange,
  onSelectToken,
  onContinue
}) => {
  const { t } = useTranslation();

  const title = (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-1 text-xl font-heading font-bold text-[#80808080]">
        <Icon name={IconName.CheckboxCircleFill} className="h-6 w-6 text-status-positive" fill="currentColor" />
        {t('evmWalletConnected')}
      </span>
      <span className="font-heading text-2xl font-bold text-[#808080]">{t('midenBridge')}</span>
    </div>
  );

  return (
    <SelectAmount
      token={token}
      amount={amount}
      isValidAmount={isValidAmount}
      error={error}
      isBridge
      network={DEFAULT_BRIDGE_NETWORK}
      outputSymbol={BRIDGE_OUTPUT_TOKEN_SYMBOL}
      title={title}
      onAmountChange={onAmountChange}
      onSelectToken={onSelectToken}
      onSelectNetwork={() => {}}
      onConfirm={onContinue}
    />
  );
};

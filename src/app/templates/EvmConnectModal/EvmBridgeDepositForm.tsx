import React from 'react';

import { DEFAULT_BRIDGE_NETWORK, BRIDGE_OUTPUT_TOKEN_SYMBOL } from 'screens/send-flow/bridge-networks';
import { SelectAmount } from 'screens/send-flow/SelectAmount';
import { UIToken } from 'screens/send-flow/types';

import { EvmWalletHeader } from './EvmWalletHeader';

interface EvmBridgeDepositFormProps {
  token: UIToken;
  amount: string;
  isValidAmount: boolean;
  error?: string;
  /** Connected EVM address, shown in the wallet header row. */
  evmAddress: string;
  onAmountChange: (value: string) => void;
  /** Opens the ETH/USDC token picker drawer. */
  onSelectToken: () => void;
  /** Switch/disconnect the connected EVM wallet from the header. */
  onSwitch: () => void;
  onContinue: () => void;
}

export const EvmBridgeDepositForm: React.FC<EvmBridgeDepositFormProps> = ({
  token,
  amount,
  isValidAmount,
  error,
  evmAddress,
  onAmountChange,
  onSelectToken,
  onSwitch,
  onContinue
}) => {
  const title = <EvmWalletHeader address={evmAddress} onSwitch={onSwitch} />;

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
      footerClassName="pt-4 pb-6"
      onAmountChange={onAmountChange}
      onSelectToken={onSelectToken}
      onSelectNetwork={() => {}}
      onConfirm={onContinue}
    />
  );
};

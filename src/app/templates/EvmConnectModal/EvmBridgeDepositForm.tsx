import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Notice } from 'components/ui/Notice';
import { evmTokenLabel } from 'lib/remote-config/token-labels';
import { DEFAULT_BRIDGE_NETWORK } from 'screens/send-flow/bridge-networks';
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
  const { t } = useTranslation();
  // The deposit arrives as the token picked: ETH as ETH, the bridge USDC under its testnet label.
  const tokenLabel = evmTokenLabel(token.id, token.name);
  const title = <EvmWalletHeader address={evmAddress} onSwitch={onSwitch} />;

  return (
    <SelectAmount
      token={token}
      tokenLabel={tokenLabel}
      amount={amount}
      isValidAmount={isValidAmount}
      error={error}
      isBridge
      network={DEFAULT_BRIDGE_NETWORK}
      outputSymbol={tokenLabel}
      title={title}
      onAmountChange={onAmountChange}
      onSelectToken={onSelectToken}
      onSelectNetwork={() => {}}
      onConfirm={onContinue}
    >
      {/* Funding decision point (#875): a wallet that was already connected
          skips the connect-step warning, so the form carries its own. */}
      <Notice
        tone="warning"
        icon={<Icon name={IconName.WarningFill} size="xs" fill="currentColor" />}
        title={t('bridgeTestFundsTitle')}
        className="mt-4"
        data-testid="bridge-test-funds-warning"
      >
        {t('bridgeTestFundsBody')}
      </Notice>
    </SelectAmount>
  );
};

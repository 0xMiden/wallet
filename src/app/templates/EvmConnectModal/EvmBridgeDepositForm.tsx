import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Notice } from 'components/ui/Notice';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';
import { BridgeNetwork } from 'screens/send-flow/bridge-networks';
import { SelectAmount } from 'screens/send-flow/SelectAmount';
import { UITokenWithPendingBalance } from 'screens/send-flow/types';

import { EvmWalletHeader } from './EvmWalletHeader';

interface EvmBridgeDepositFormProps {
  token: UITokenWithPendingBalance;
  /** The source network of the chosen route, or none while the route has no chain: the form then asks for one. */
  network?: BridgeNetwork;
  /** The token's name, such as the testnet label (`evmUsdcLabel`). */
  tokenLabel: string;
  /** What the deposit arrives on Miden as on the route chosen (`arrivingTokenName`), as the Review names it. */
  arrivingName: string;
  amount: string;
  isValidAmount: boolean;
  error?: string;
  /** Connected EVM address, shown in the wallet header row. */
  evmAddress: string;
  onAmountChange: (value: string) => void;
  /** Opens the ETH/USDC token picker drawer. */
  onSelectToken: () => void;
  /** Opens the source-network picker drawer; routes with one source pass nothing. */
  onSelectNetwork?: () => void;
  /** Switch/disconnect the connected EVM wallet from the header. */
  onSwitch: () => void;
  onContinue: () => void;
}

export const EvmBridgeDepositForm: React.FC<EvmBridgeDepositFormProps> = ({
  token,
  network,
  tokenLabel,
  arrivingName,
  amount,
  isValidAmount,
  error,
  evmAddress,
  onAmountChange,
  onSelectToken,
  onSelectNetwork,
  onSwitch,
  onContinue
}) => {
  const { t } = useTranslation();
  const title = <EvmWalletHeader address={evmAddress} onSwitch={onSwitch} />;
  // The test-funds warning belongs to the test networks; on mainnet the funds are real and it is not shown.
  const testNetwork = getTestNetworkNameKey() !== null;

  return (
    <SelectAmount
      token={token}
      tokenLabel={tokenLabel}
      amount={amount}
      isValidAmount={isValidAmount}
      error={error}
      isBridge
      network={network}
      outputSymbol={arrivingName}
      title={title}
      onAmountChange={onAmountChange}
      onSelectToken={onSelectToken}
      onSelectNetwork={onSelectNetwork}
      onConfirm={onContinue}
    >
      {/* Funding decision point (#875): a wallet that was already connected
          skips the connect-step warning, so the form carries its own. */}
      {testNetwork && (
        <Notice
          tone="warning"
          icon={<Icon name={IconName.WarningFill} size="xs" fill="currentColor" />}
          title={t('bridgeTestFundsTitle')}
          className="mt-4"
          data-testid="bridge-test-funds-warning"
        >
          {t('bridgeTestFundsBody')}
        </Notice>
      )}
    </SelectAmount>
  );
};

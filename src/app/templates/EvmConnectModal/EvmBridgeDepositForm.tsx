import React from 'react';

import { useTranslation } from 'react-i18next';

import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { AmountInput } from 'components/AmountInput';
import { Button } from 'components/Button';
import { TokenLogo } from 'components/TokenLogo';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { ListRow } from 'components/ui/ListRow';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { SectionHeader } from 'components/ui/SectionHeader';
import { Skeleton } from 'components/ui/Skeleton';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';
import { approxFiatAmount, balanceFormatterFor } from 'screens/send-flow/amount-format';
import { BridgeNetwork } from 'screens/send-flow/bridge-networks';
import { UITokenWithPendingBalance } from 'screens/send-flow/types';
import { truncateAddress } from 'utils/string';

interface EvmBridgeDepositFormProps {
  token: UITokenWithPendingBalance;
  network?: BridgeNetwork;
  tokenLabel: string;
  arrivingName: string;
  destinationName?: string;
  amount: string;
  isValidAmount: boolean;
  error?: string;
  evmAddress: string;
  onAmountChange: (value: string) => void;
  onSelectToken: () => void;
  onSelectNetwork?: () => void;
  onSwitch: () => void;
  onContinue: () => void;
}

/** Bridge funding uses Send's amount field and the shared flow body; the manager owns navigation. */
export const EvmBridgeDepositForm: React.FC<EvmBridgeDepositFormProps> = ({
  token,
  network,
  tokenLabel,
  arrivingName,
  destinationName,
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
  const balanceReady = token.balance !== null;
  const canProceed = token.scaleIsKnown && balanceReady && !!network && isValidAmount;
  const amountError = error && (amount || error !== 'invalidAmount') ? t(error) : undefined;
  const balanceText = token.balance === null ? null : balanceFormatterFor(token.balance)(token.balance);

  return (
    <HomeGroupPaneBody
      top="header"
      footer={
        <Button
          title={t('continue')}
          accent="receive"
          onClick={onContinue}
          disabled={!canProceed}
          className="w-full max-w-none"
          data-testid="send-amount-confirm"
        />
      }
    >
      <SectionHeader
        size="lg"
        action={
          <Pill
            onClick={onSwitch}
            aria-label={t('switchWallet')}
            aria-haspopup="dialog"
            className="text-accent-receive-ink"
            data-testid="bridge-source-wallet"
          >
            {truncateAddress(evmAddress, false, 6, 4)}
          </Pill>
        }
      >
        {t('enterAmount')}
      </SectionHeader>
      <AmountInput
        value={amount}
        onValueChange={value => onAmountChange(value || '')}
        invalid={!!amountError}
        error={amountError}
        accent="receive"
        helper={
          token.scaleIsKnown && token.fiatPrice > 0 && amount
            ? t('approxFiatValue', { value: approxFiatAmount(Number(amount) * token.fiatPrice) })
            : undefined
        }
        showDivider={false}
        data-testid="send-amount-input"
      />

      <DetailCard surface="outline" face="heading" className="mt-8">
        <ListRow
          title={tokenLabel}
          avatar={<TokenLogo symbol={token.name} faucetId={token.id} size="md" />}
          subtitle={
            token.scaleIsKnown ? (
              balanceReady ? (
                `${t('available')} ${balanceText}`
              ) : (
                <Skeleton className="h-4 w-20" />
              )
            ) : (
              t('unknownTokenScale')
            )
          }
          accent="receive"
          onClick={onSelectToken}
          chevron
          className="min-w-0 flex-1"
          data-testid="send-token-selector"
        />
        <DetailRow
          label={t('from')}
          onClick={onSelectNetwork}
          aria-haspopup={onSelectNetwork ? 'dialog' : undefined}
          data-testid="bridge-source-network"
        >
          {network?.name ?? t('selectNetwork')}
        </DetailRow>
        <DetailRow label={t('to')} sub={destinationName} data-testid="bridge-destination">
          {`${t('miden')} · ${arrivingName}`}
        </DetailRow>
      </DetailCard>
      {getTestNetworkNameKey() !== null && (
        <Notice tone="warning" variant="inline" className="mt-4" data-testid="bridge-test-funds-warning">
          {t('bridgeTestFundsBody')}
        </Notice>
      )}
    </HomeGroupPaneBody>
  );
};

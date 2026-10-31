import React from 'react';

import { useTranslation } from 'react-i18next';

import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { Button } from 'components/Button';
import { NetworkLogo } from 'components/NetworkChip';
import { TokenAmountInput } from 'components/TokenAmountInput';
import { TokenLogo } from 'components/TokenLogo';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { ListRow } from 'components/ui/ListRow';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { SectionHeader } from 'components/ui/SectionHeader';
import { Skeleton } from 'components/ui/Skeleton';
import { AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL } from 'lib/agglayer/constant';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';
import { evmQuote } from 'lib/prices/evm';
import { useWalletStore } from 'lib/store';
import type { UiEvidenceInput } from 'lib/telemetry/ui-producer-diagnostics';
import type { UserErrorId } from 'lib/telemetry/user-visible-error-contract';
import { balanceFormatterFor } from 'screens/send-flow/amount-format';
import { AmountShortcuts } from 'screens/send-flow/AmountShortcuts';
import { BridgeNetwork } from 'screens/send-flow/bridge-networks';
import { UITokenWithPendingBalance } from 'screens/send-flow/types';
import { truncateAddress } from 'utils/string';

interface EvmBridgeDepositFormProps {
  token: UITokenWithPendingBalance;
  /** The Miden faucet an Epoch token arrives in: its token-list logo stands in when the wallet ships no mark. */
  logoFaucetId?: string;
  network?: BridgeNetwork;
  tokenLabel: string;
  arrivingName: string;
  destinationName?: string;
  amount: string;
  isValidAmount: boolean;
  error?: string;
  errorId?: UserErrorId | null;
  errorDiagnostics?: UiEvidenceInput;
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
  logoFaucetId,
  network,
  tokenLabel,
  arrivingName,
  destinationName,
  amount,
  isValidAmount,
  error,
  errorId,
  errorDiagnostics,
  evmAddress,
  onAmountChange,
  onSelectToken,
  onSelectNetwork,
  onSwitch,
  onContinue
}) => {
  const { t } = useTranslation();
  const [shortcutSelection, setShortcutSelection] = React.useState(0);
  const prices = useWalletStore(state => state.tokenPrices);
  const balanceReady = token.balance !== null;
  const canProceed = token.scaleIsKnown && balanceReady && !!network && isValidAmount;
  const visibleError = error && (amount || error !== 'invalidAmount') ? error : undefined;
  const amountError =
    visibleError === 'amountMustBeLessThanBalance' || visibleError === 'invalidAmount' ? t(visibleError) : visibleError;
  const amountErrorId =
    visibleError && visibleError !== 'invalidAmount'
      ? errorId === undefined
        ? visibleError === 'amountMustBeLessThanBalance'
          ? 'amountMustBeLessThanBalance'
          : 'raw_bridge_balance_failed'
        : errorId
      : null;
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
      <TokenAmountInput
        assetId={`${network?.chainId}:${token.id}`}
        symbol={token.name}
        decimals={token.decimals}
        scaleIsKnown={token.scaleIsKnown}
        externalAsset
        quote={evmQuote(
          prices,
          network?.chainId,
          token.id === AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL ? '0x0000000000000000000000000000000000000000' : token.id
        )}
        value={amount}
        tokenIntentKey={shortcutSelection}
        onValueChange={value => onAmountChange(value || '')}
        invalid={!!amountError}
        error={amountError}
        errorId={amountErrorId}
        errorDiagnostics={amountErrorId === 'raw_bridge_balance_failed' ? errorDiagnostics : undefined}
        accent="receive"
        showDivider={false}
        data-testid="send-amount-input"
      />
      <AmountShortcuts
        balance={token.balance}
        decimals={token.decimals}
        scaleIsKnown={token.scaleIsKnown}
        onAmountChange={value => {
          setShortcutSelection(selection => selection + 1);
          onAmountChange(value);
        }}
        className="text-accent-receive-ink"
      />

      <DetailCard surface="outline" face="heading" className="mt-8">
        <ListRow
          title={tokenLabel}
          avatar={<TokenLogo symbol={token.name} faucetId={logoFaucetId ?? token.id} size="md" />}
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
          {network && <NetworkLogo kind="ethereum" network={network.id} />}
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

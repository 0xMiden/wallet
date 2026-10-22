import React from 'react';

import { useTranslation } from 'react-i18next';

import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { AmountInput } from 'components/AmountInput';
import { Button, ButtonVariant } from 'components/Button';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Notice } from 'components/ui/Notice';
import { TextField } from 'components/ui/TextField';
import { formatBigInt } from 'lib/i18n/numbers';
import { hapticLight } from 'lib/mobile/haptics';
import type { OneClickEvmBalanceSnapshot } from 'lib/one-click/evm-balance';
import { OneClickAsset } from 'lib/one-click/types';
import { WalletContact } from 'lib/shared/types';

import { OneClickAssetPicker, OneClickNetworkOption, OneClickNetworkPicker } from './OneClickPickers';

export interface OneClickAmountsProps {
  assets: readonly OneClickAsset[];
  networks: readonly OneClickNetworkOption[];
  offerNetwork: OneClickNetworkOption;
  requestNetwork: OneClickNetworkOption;
  offerAsset?: OneClickAsset;
  requestAsset?: OneClickAsset;
  offerAmount: string;
  previewAmount: string;
  offerBalance?: number;
  evmBalance?: {
    status: 'idle' | 'loading' | 'ready' | 'error';
    snapshot?: OneClickEvmBalanceSnapshot;
    error?: string;
    gasSymbol: string;
  };
  quoteLoading?: boolean;
  routeError?: string;
  externalAddressLabel?: 'recipient' | 'refund';
  externalAddressNetwork?: OneClickNetworkOption;
  externalAddress: string;
  connectedExternalAddress?: string;
  externalAddressEditable?: boolean;
  onConnectExternal?: () => void;
  contacts?: readonly WalletContact[];
  canContinue: boolean;
  onOfferNetworkChange: (network: OneClickNetworkOption) => void;
  onRequestNetworkChange: (network: OneClickNetworkOption) => void;
  onOfferAssetChange: (asset: OneClickAsset) => void;
  onRequestAssetChange: (asset: OneClickAsset) => void;
  onOfferAmountChange: (amount: string) => void;
  onExternalAddressChange: (address: string) => void;
  onContinue: () => void;
}

export const OneClickAmounts: React.FC<OneClickAmountsProps> = ({
  assets,
  networks,
  offerNetwork,
  requestNetwork,
  offerAsset,
  requestAsset,
  offerAmount,
  previewAmount,
  offerBalance,
  evmBalance,
  quoteLoading = false,
  routeError,
  externalAddressLabel,
  externalAddressNetwork,
  externalAddress,
  connectedExternalAddress,
  externalAddressEditable = true,
  onConnectExternal,
  contacts = [],
  canContinue,
  onOfferNetworkChange,
  onRequestNetworkChange,
  onOfferAssetChange,
  onRequestAssetChange,
  onOfferAmountChange,
  onExternalAddressChange,
  onContinue
}) => {
  const { t } = useTranslation();
  const payPicker = (
    <div className="flex flex-wrap items-center gap-2">
      <OneClickNetworkPicker side="pay" network={offerNetwork} networks={networks} onSelect={onOfferNetworkChange} />
      <OneClickAssetPicker
        side="pay"
        network={offerNetwork}
        asset={offerAsset}
        assets={assets}
        onSelect={onOfferAssetChange}
      />
    </div>
  );
  const receivePicker = (
    <div className="flex flex-wrap items-center gap-2">
      <OneClickNetworkPicker
        side="receive"
        network={requestNetwork}
        networks={networks}
        onSelect={onRequestNetworkChange}
      />
      <OneClickAssetPicker
        side="receive"
        network={requestNetwork}
        asset={requestAsset}
        assets={assets}
        onSelect={onRequestAssetChange}
      />
    </div>
  );
  const contactNetwork = externalAddressNetwork?.logoNetwork ?? externalAddressNetwork?.id;
  const matchedContacts = contacts.filter(contact => contact.network === contactNetwork);
  const linkedRefund = externalAddressLabel === 'refund' && !externalAddressEditable;

  return (
    <HomeGroupPaneBody
      footer={
        <Button
          title={quoteLoading ? t('calculatingQuote') : t('reviewSwap')}
          variant={ButtonVariant.Primary}
          accent="swap"
          onClick={onContinue}
          disabled={!canContinue || quoteLoading}
          data-testid="one-click-review-submit"
          className="w-full max-w-none"
        />
      }
    >
      <div className="flex flex-col gap-5">
        <AmountInput
          label={t('youPay')}
          value={offerAmount}
          onValueChange={value => onOfferAmountChange(value ?? '')}
          tokenSelector={payPicker}
          accent="swap"
          helper={
            offerBalance === undefined
              ? undefined
              : t('availableAmount', { amount: offerBalance, symbol: offerAsset?.symbol })
          }
          aria-label={t('youPay')}
          data-testid="one-click-pay-amount"
        />
        <AmountInput
          label={t('youReceive')}
          value={previewAmount}
          onValueChange={() => undefined}
          tokenSelector={receivePicker}
          accent="swap"
          loading={quoteLoading}
          disabled
          showDivider={false}
          aria-label={t('youReceive')}
          data-testid="one-click-receive-amount"
        />
        {evmBalance && externalAddressLabel === 'refund' && offerAsset && (
          <Notice
            tone={
              evmBalance.status === 'error' || (evmBalance.snapshot && !evmBalance.snapshot.canDeposit)
                ? 'warning'
                : 'neutral'
            }
            title={t(
              evmBalance.status === 'loading'
                ? 'oneClickBalanceChecking'
                : evmBalance.status === 'error'
                  ? 'oneClickBalanceUnavailable'
                  : 'oneClickAvailableBalance'
            )}
            data-testid="one-click-evm-balance"
          >
            {evmBalance.status === 'ready' && evmBalance.snapshot ? (
              <div className="flex flex-col gap-1">
                <span>
                  {formatBigInt(evmBalance.snapshot.spendableTokenBalance, offerAsset.decimals)} {offerAsset.symbol}
                </span>
                {evmBalance.snapshot.gasReserve > 0n && (
                  <span>
                    {t('oneClickGasReserve', {
                      amount: formatBigInt(evmBalance.snapshot.gasReserve, 18),
                      symbol: evmBalance.gasSymbol
                    })}
                  </span>
                )}
                {!evmBalance.snapshot.tokenSufficient && <span>{t('oneClickInsufficientTokenBalance')}</span>}
                {evmBalance.snapshot.gasCheckComplete && evmBalance.snapshot.gasSufficient === false && (
                  <span>{t('oneClickInsufficientGasBalance')}</span>
                )}
              </div>
            ) : evmBalance.status === 'error' ? (
              t('oneClickBalanceUnavailableBody')
            ) : (
              t('oneClickBalanceCheckingBody')
            )}
          </Notice>
        )}

        {externalAddressLabel && externalAddressNetwork && (
          <section className="flex flex-col gap-3" aria-label={t(`oneClick${externalAddressLabel}Section`)}>
            {linkedRefund ? (
              <Notice tone="neutral" title={t('oneClickRefundAccount')} data-testid="one-click-connected-refund">
                {connectedExternalAddress ? (
                  <span className="break-all">{connectedExternalAddress}</span>
                ) : (
                  <button
                    type="button"
                    className="text-action text-accent-tint-ink underline"
                    onClick={onConnectExternal}
                    data-testid="one-click-connect-origin-wallet"
                  >
                    {t('oneClickConnectOriginWallet', { network: externalAddressNetwork.name })}
                  </button>
                )}
              </Notice>
            ) : (
              <TextField
                label={t(externalAddressLabel === 'recipient' ? 'oneClickRecipientAddress' : 'oneClickRefundAddress')}
                value={externalAddress}
                onChange={event => onExternalAddressChange(event.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                data-testid={`one-click-${externalAddressLabel}-address`}
              />
            )}
            {externalAddressLabel === 'recipient' && matchedContacts.length > 0 && (
              <ListGroup surface="fill" aria-label={t('contacts')}>
                {matchedContacts.map(contact => (
                  <ListRow
                    key={`${contact.network}-${contact.address}`}
                    title={contact.name}
                    subtitle={contact.address}
                    onClick={() => {
                      hapticLight();
                      onExternalAddressChange(contact.address);
                    }}
                    data-testid={`one-click-contact-${contact.name}`}
                  />
                ))}
              </ListGroup>
            )}
          </section>
        )}
        {routeError && (
          <p className="text-body-sm text-negative-tint-ink" role="alert" data-testid="one-click-route-error">
            {t(routeError)}
          </p>
        )}
      </div>
    </HomeGroupPaneBody>
  );
};

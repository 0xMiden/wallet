import React, { useCallback, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import CopyButton from 'app/atoms/CopyButton';
import FormField from 'app/atoms/FormField';
import { Icon, IconName } from 'app/icons/v2';
import { useShareAddress } from 'app/pages/Receive/useShareAddress';
import { QRCode } from 'components/QRCode';
import {
  DEPOSIT_WALLETS,
  buildDepositPaymentUri,
  formatBalance,
  getDepositToken,
  openPaymentDeeplink,
  type DepositTokenId,
  type DepositWalletOption
} from 'lib/deposit-bridge';
import { hapticLight } from 'lib/mobile/haptics';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';
import { truncateAddress } from 'utils/string';

export interface DepositMethodDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: DepositTokenId;
  /** Requested deposit amount in the token's base units. */
  amount: bigint;
  /** Vault-derived EVM deposit address the counterparty wallet pays into. */
  evmAddress: string;
  /** Opens the WalletConnect bridge flow; omitted where WC is unavailable. */
  onConnectWallet?: () => void;
}

type MethodStep = 'options' | 'wallets' | 'qr';

const QR_FILE_NAME = 'miden-deposit-request.png';

interface MethodRowProps {
  icon: IconName;
  title: string;
  subtitle: string;
  testId: string;
  onClick: () => void;
}

const MethodRow: React.FC<MethodRowProps> = ({ icon, title, subtitle, testId, onClick }) => (
  <button
    type="button"
    data-testid={testId}
    onClick={() => {
      hapticLight();
      onClick();
    }}
    className="flex w-full items-center gap-3 py-4 text-left"
  >
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-50">
      <Icon name={icon} size="md" className="text-heading-gray" />
    </span>
    <span className="flex-1 min-w-0">
      <span className="block font-heading text-base font-bold text-heading-gray">{title}</span>
      <span className="block text-xs text-heading-gray opacity-60">{subtitle}</span>
    </span>
    <Icon name={IconName.ChevronRight} size="sm" className="shrink-0 text-heading-gray opacity-40" />
  </button>
);

/**
 * "How do you want to send the funds?" sheet for a cross-chain deposit: connect
 * an EVM wallet via WalletConnect, hand off to an installed wallet through an
 * EIP-681 `ethereum:` deeplink, or fall back to a QR / copyable address. The QR
 * encodes the full payment request (address + chain + amount + token), so a
 * scanning wallet lands on a pre-filled send screen.
 */
export const DepositMethodDrawer: React.FC<DepositMethodDrawerProps> = ({
  open,
  onOpenChange,
  token,
  amount,
  evmAddress,
  onConnectWallet
}) => {
  const { t } = useTranslation();
  const [step, setStep] = useState<MethodStep>('options');
  const { fieldRef, copy } = useCopyToClipboard();
  const { qrRef, share } = useShareAddress({ address: evmAddress, fileName: QR_FILE_NAME, onFallbackCopy: copy });

  const config = getDepositToken(token);
  const paymentUri = buildDepositPaymentUri(token, evmAddress, amount);
  const amountLabel = `${formatBalance(amount, config.decimals)} ${config.symbol}`;

  useEffect(() => {
    if (open) setStep('options');
  }, [open]);

  const handleConnect = useCallback(() => {
    onOpenChange(false);
    onConnectWallet?.();
  }, [onConnectWallet, onOpenChange]);

  const handleWallet = useCallback(
    (wallet: DepositWalletOption) => {
      openPaymentDeeplink(wallet.buildUri(token, evmAddress, amount));
    },
    [token, evmAddress, amount]
  );

  const handleBack = useCallback(() => {
    hapticLight();
    setStep('options');
  }, []);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="md:mx-auto md:max-w-md">
        <DrawerHeader>
          <div className="flex items-center gap-2">
            {step !== 'options' && (
              <button
                type="button"
                aria-label={t('back')}
                data-testid="deposit-method-back"
                onClick={handleBack}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100"
              >
                <Icon name={IconName.ChevronLeft} size="xs" fill="currentColor" className="text-heading-gray" />
              </button>
            )}
            <DrawerTitle>
              {step === 'qr'
                ? t('depositMethodQrTitle')
                : step === 'wallets'
                  ? t('depositWalletListTitle')
                  : t('depositMethodTitle')}
            </DrawerTitle>
          </div>
        </DrawerHeader>

        {step === 'options' && (
          <div className="flex flex-col divide-y divide-rule-default px-6 pb-6">
            {onConnectWallet && (
              <MethodRow
                icon={IconName.Wallet}
                title={t('depositMethodConnectWallet')}
                subtitle={t('depositMethodConnectWalletDesc')}
                testId="deposit-method-connect"
                onClick={handleConnect}
              />
            )}
            <MethodRow
              icon={IconName.ArrowRightUp}
              title={t('depositMethodWalletApp')}
              subtitle={t('depositMethodWalletAppDesc', { amount: amountLabel })}
              testId="deposit-method-deeplink"
              onClick={() => setStep('wallets')}
            />
            <MethodRow
              icon={IconName.QrScan}
              title={t('depositMethodQr')}
              subtitle={t('depositMethodQrDesc')}
              testId="deposit-method-qr"
              onClick={() => setStep('qr')}
            />
          </div>
        )}

        {step === 'wallets' && (
          <div className="flex flex-col divide-y divide-rule-default px-6 pb-6">
            {DEPOSIT_WALLETS.map(wallet => (
              <MethodRow
                key={wallet.id}
                icon={IconName.Wallet}
                title={wallet.name || t('depositWalletDefaultName')}
                subtitle={t(wallet.descriptionKey)}
                testId={`deposit-wallet-${wallet.id}`}
                onClick={() => handleWallet(wallet)}
              />
            ))}
          </div>
        )}

        {step === 'qr' && (
          <div className="flex flex-col items-center gap-5 px-6 pb-8">
            <FormField ref={fieldRef} value={evmAddress} style={{ display: 'none' }} />
            <p className="text-center text-sm text-heading-gray opacity-70">
              {t('depositMethodQrExplainer', { amount: amountLabel })}
            </p>
            <QRCode ref={qrRef} address={evmAddress} payload={paymentUri} size={240} />
            <CopyButton
              text={evmAddress}
              className="w-full rounded-full! text-center py-4 bg-surface-interactive hover:bg-surface-interactive"
            >
              <span className="text-base font-heading font-bold text-heading-gray">
                {truncateAddress(evmAddress, false, 14, 8)}
              </span>
            </CopyButton>
            <button type="button" onClick={share} className="flex items-center gap-3 text-accent-primary">
              <Icon name={IconName.Share} size="md" className="shrink-0" />
              <span className="font-heading text-2xl font-bold leading-none text-heading-gray">{t('share')}</span>
            </button>
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
};

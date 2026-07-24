import React, { ChangeEvent, useEffect, useRef } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { ReactComponent as ScanFrameIcon } from 'app/icons/scan-frame.svg';
import { ReactComponent as SendAddressBookIcon } from 'app/icons/send-address-book.svg';
import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { hapticLight } from 'lib/mobile/haptics';
import { AddressChain } from 'utils/miden';

import { getBridgeNetwork, SendNetworkId } from './bridge-networks';

export interface SelectRecipientProps {
  address: string;
  isValidAddress: boolean;
  error?: string;
  /**
   * Chain detected from the typed address. `ethereum` offers the cross-chain
   * destination networks; `miden` is same-chain, so Miden is its only network.
   */
  chain: AddressChain;
  /** Selected network. Miden is available before an address is entered; EVM sends use a bridge network. */
  network?: SendNetworkId;
  /** Name of a saved contact matching the entered address. */
  recipientName?: string;
  onAddressChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onAddressBook: () => void;
  onSelectNetwork: () => void;
  /** Scan a recipient address from a QR code. Omitted where scanning is unavailable (desktop/extension). */
  onScan?: () => void;
  onConfirm: () => void;
}

export const SelectRecipient: React.FC<SelectRecipientProps> = ({
  address,
  isValidAddress,
  error,
  chain,
  network,
  recipientName,
  onAddressChange,
  onAddressBook,
  onSelectNetwork,
  onScan,
  onConfirm
}) => {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selectedNetwork = network === 'miden' ? undefined : getBridgeNetwork(network);
  const isEthereum = chain === 'ethereum';
  const hasAddress = address.trim().length > 0;
  const canConfirm = isValidAddress && (!isEthereum || !!selectedNetwork);
  // eslint-disable-next-line i18next/no-literal-string -- Product-specified recipient placeholder copy.
  const addressPlaceholder = 'Enter Miden or Ethereum Address';
  // eslint-disable-next-line i18next/no-literal-string -- Product-specified scanner copy.
  const scanQrCodeLabel = 'Scan QR Code';

  // Auto-grow the borderless address field as it wraps across lines.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [address]);

  return (
    <div className={clsx('flex flex-col h-full min-h-0 bg-app-bg px-6')}>
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto no-scrollbar pt-10">
        <div className="flex items-center justify-between gap-3">
          <span className="font-heading text-2xl leading-none font-bold text-gray">{t('chooseRecipient')}</span>
          {isValidAddress && (
            <span className="rounded-full bg-primary-500 px-3 py-1 text-xs font-semibold text-pure-white">
              {/* eslint-disable-next-line i18next/no-literal-string -- EVM is a protocol acronym. */}
              {isEthereum ? 'EVM' : t('miden')}
            </span>
          )}
        </div>

        <div className="relative mt-3">
          {recipientName && (
            <div className="mb-2 flex items-center gap-3">
              <span
                data-testid="send-recipient-avatar"
                className="h-8 w-8 shrink-0 rounded-full bg-grey-300"
                aria-hidden="true"
              />
              <span className="font-heading text-2xl font-bold text-black">{recipientName}</span>
            </div>
          )}
          <textarea
            ref={textareaRef}
            data-testid="send-recipient-input"
            rows={1}
            placeholder={addressPlaceholder}
            className={clsx(
              'font-heading w-full resize-none bg-transparent outline-none',
              'text-[40px] font-bold leading-tight wrap-break-word',
              'text-heading-gray caret-primary-500',
              error ? 'text-red-500' : 'text-black'
            )}
            value={address}
            onChange={onAddressChange}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
          />
        </div>

        {error && <p className="text-red-500 text-sm mt-2">{t(`${error}`)}</p>}

        {isValidAddress && isEthereum && (
          <div className="mt-1 flex flex-col items-start">
            <span className="ml-2 h-18 w-2 rounded-full bg-grey-300" aria-hidden="true" />
            <div className="pt-3">
              <button
                type="button"
                data-testid="send-network-selector"
                onClick={() => {
                  hapticLight();
                  onSelectNetwork();
                }}
                className="flex items-center gap-2 rounded-full bg-surface-interactive py-2 pr-3 pl-2 text-left"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-500">
                  <Icon name={IconName.Globe} size="sm" className="text-pure-white" fill="currentColor" />
                </span>
                <span className="font-heading text-xl font-bold text-heading-gray">
                  {selectedNetwork?.name ?? t('selectNetwork')}
                </span>
                <Icon name={IconName.ChevronRightLucide} size="sm" className="text-primary-500" />
              </button>
            </div>
          </div>
        )}

        <div className="mt-auto flex flex-col items-start gap-3 pt-12 pb-10">
          <Button
            variant={ButtonVariant.Secondary}
            onClick={onAddressBook}
            className="h-auto! w-fit! rounded-full bg-surface-interactive! px-2! py-1! text-base font-bold hover:bg-surface-interactive!"
          >
            <SendAddressBookIcon data-testid="send-address-book-icon" className="h-4 w-4 shrink-0" />
            <span>{t('addressBook')}</span>
          </Button>
          {onScan && !hasAddress && (
            <Button
              variant={ButtonVariant.Secondary}
              onClick={onScan}
              className="h-auto! w-fit! rounded-full bg-surface-interactive! px-2! py-1! text-base font-bold hover:bg-surface-interactive!"
            >
              <ScanFrameIcon data-testid="send-scan-icon" className="h-4 w-4 shrink-0" />
              <span>{scanQrCodeLabel}</span>
            </Button>
          )}
        </div>
      </div>

      <div className="shrink-0 pb-24">
        <Button
          title={t('confirm')}
          variant={ButtonVariant.Primary}
          onClick={onConfirm}
          disabled={!canConfirm}
          data-testid="send-recipient-confirm"
          className="w-full max-w-none rounded-full text-base font-semibold"
        />
      </div>
    </div>
  );
};

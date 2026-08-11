import React, { ChangeEvent, useEffect, useRef } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { ReactComponent as ScanFrameIcon } from 'app/icons/scan-frame.svg';
import { ReactComponent as SendAddressBookIcon } from 'app/icons/send-address-book.svg';
import { Icon, IconName } from 'app/icons/v2';
import { Avatar } from 'components/Avatar';
import { Button, ButtonVariant } from 'components/Button';
import { hapticLight } from 'lib/mobile/haptics';
import { AddressChain } from 'utils/miden';
import { truncateAddress } from 'utils/string';

import { getBridgeNetwork, SendNetworkId } from './bridge-networks';
import { RecentRecipient } from './types';

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
  /** Most recent distinct send recipients. Shown only while the address field is empty. */
  recents?: RecentRecipient[];
  /**
   * True when the entered address is valid but isn't saved yet — the Address
   * Book pill becomes "Add to contacts?" and opens the add-contact sheet.
   */
  canAddContact?: boolean;
  onAddressChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onAddressBook: () => void;
  /** Opens the add-contact sheet pre-filled with the entered address. */
  onAddContact?: () => void;
  /** Fills the recipient from a "Recent" row. */
  onSelectRecent?: (recipient: RecentRecipient) => void;
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
  recents,
  canAddContact = false,
  onAddressChange,
  onAddressBook,
  onAddContact,
  onSelectRecent,
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
  const showAddContact = canAddContact && !!onAddContact;
  const recentRecipients = hasAddress ? [] : (recents ?? []);
  // eslint-disable-next-line i18next/no-literal-string -- Product-specified recipient placeholder copy.
  const addressPlaceholder = 'Enter Miden or Ethereum Address';
  // eslint-disable-next-line i18next/no-literal-string -- Product-specified scanner copy.
  const scanQrCodeLabel = 'Scan QR Code';

  // Done label on the mobile keyboard. Set via the ref because this repo's
  // @types/react version types enterKeyHint on inputs but not textareas.
  useEffect(() => {
    textareaRef.current?.setAttribute('enterkeyhint', 'done');
  }, []);

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
            onKeyDown={event => {
              // Addresses are single-line: Done/Enter dismisses the keyboard
              // instead of inserting a newline.
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
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

        <div
          className={clsx(
            'mt-2 flex items-start gap-1',
            recentRecipients.length > 0 && 'pb-6'
          )}
        >
          <Button
            variant={ButtonVariant.Secondary}
            onClick={() => {
              hapticLight();
              if (showAddContact && onAddContact) {
                onAddContact();
                return;
              }
              onAddressBook();
            }}
            data-testid="send-address-book"
            className="h-auto! w-fit! rounded-full bg-surface-interactive! px-2! py-1! text-base font-bold hover:bg-surface-interactive!"
          >
            <SendAddressBookIcon data-testid="send-address-book-icon" className="h-4 w-4 shrink-0" />
            <span>{showAddContact ? t('addToContactsPrompt') : t('addressBook')}</span>
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

        {recentRecipients.length > 0 && (
          <section className="flex flex-col pb-10" data-testid="send-recent-recipients">
            <h2 className="text-gray text-xl font-heading font-bold">{t('recent')}</h2>
            <ul className="mt-1 flex flex-col">
              {recentRecipients.map((recipient, index) => (
                <li key={recipient.address}>
                  <button
                    type="button"
                    data-testid="send-recent-recipient"
                    onClick={() => {
                      hapticLight();
                      onSelectRecent?.(recipient);
                    }}
                    className={clsx(
                      'flex w-full items-center gap-3 py-3 text-left',
                      index > 0 && 'border-t border-rule-default'
                    )}
                  >
                    <Avatar image="/misc/avatars/miden-orange.png" size="lg" className="shrink-0" />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-base font-bold text-black">
                        {recipient.name ?? truncateAddress(recipient.address)}
                      </span>
                      <span className="flex items-center gap-2 text-xs text-text-muted">
                        {recipient.chain === 'miden' ? (
                          <span className="rounded-full bg-accent-primary px-2 py-0.5 font-semibold text-pure-white">
                            {t('miden')}
                          </span>
                        ) : (
                          <span className="flex items-center gap-1">
                            <span className="h-2 w-2 shrink-0 rounded-full bg-primary-500" aria-hidden="true" />
                            <span>{recipient.networkName ?? t('ethereum')}</span>
                          </span>
                        )}
                        <span className="truncate">{truncateAddress(recipient.address)}</span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {/* pb-24 clears the floating navbar; while the soft keyboard is up the
          body's --keyboard-height padding already lifts the layout to the
          keyboard's top edge, so the cushion collapses to keep the CTA snug. */}
      <div
        className="shrink-0 pb-[max(0px,calc(6rem-var(--keyboard-height,0px)))] transition-[padding-bottom] duration-[250ms] ease-out"
        data-navbar-cushion="true"
      >
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

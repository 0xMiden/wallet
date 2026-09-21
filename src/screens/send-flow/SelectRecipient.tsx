import React, { ChangeEvent, useEffect, useRef } from 'react';

import clsx from 'clsx';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { ReactComponent as ScanFrameIcon } from 'app/icons/scan-frame.svg';
import { ReactComponent as SendAddressBookIcon } from 'app/icons/send-address-book.svg';
import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { ContactAvatar } from 'components/contacts/ContactAvatar';
import { Pill } from 'components/ui';
import { hapticLight } from 'lib/mobile/haptics';
import { AddressChain } from 'utils/miden';
import { truncateAddress } from 'utils/string';

import { BridgeNetworkId, getBridgeNetwork, SendNetworkId } from './bridge-networks';
import { NetworkField } from './NetworkField';
import { SendStepLayout } from './SendStepLayout';
import { RecentRecipient } from './types';

// One easing for everything that reacts to the address changing, so the field
// growing, the pills swapping and the chips arriving read as one movement.
const EASE = [0.32, 0.72, 0, 1] as const;
const DURATION = 0.28;

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
  /** Picks the destination network for a 0x recipient. */
  onSelectNetwork: (network: BridgeNetworkId) => void;
  /** Scan a recipient address from a QR code. Omitted where scanning is unavailable (desktop/extension). */
  onScan?: () => void;
  /** Fills the recipient from the clipboard. Shown only while the address field is empty. */
  onPaste?: () => void;
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
  onPaste,
  onConfirm
}) => {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const transition = reduceMotion ? { duration: 0 } : { duration: DURATION, ease: EASE };
  // Collapses/expands a block's height so the content under it slides instead of jumping.
  const reveal = {
    initial: { opacity: 0, height: 0 },
    animate: { opacity: 1, height: 'auto' },
    exit: { opacity: 0, height: 0 },
    transition
  };
  // Pill set swap: a quick fade out, then the next set fades in.
  const pillSwap = {
    initial: { opacity: 0, y: 4 },
    animate: { opacity: 1, y: 0, transition: reduceMotion ? { duration: 0 } : { duration: 0.2, ease: EASE } },
    exit: { opacity: 0, y: -4, transition: reduceMotion ? { duration: 0 } : { duration: 0.14, ease: EASE } }
  };
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selectedNetwork = network === 'miden' ? undefined : getBridgeNetwork(network);
  const isEthereum = chain === 'ethereum';
  const hasAddress = address.trim().length > 0;
  const canConfirm = isValidAddress && (!isEthereum || !!selectedNetwork);
  const showAddContact = canAddContact && !!onAddContact;
  const recentRecipients = hasAddress ? [] : (recents ?? []);
  const pillSet = !hasAddress ? 'empty' : showAddContact ? 'add' : 'book';
  const addressPlaceholder = t('sendRecipientPlaceholder');
  // The scanner's own key, already localised everywhere, rather than a second English literal:
  // sentence case, as the design system asks of a label.
  const scanQrCodeLabel = t('scanQrTitle');

  // Done label on the mobile keyboard. Set via the ref because this repo's
  // @types/react version types enterKeyHint on inputs but not textareas.
  useEffect(() => {
    textareaRef.current?.setAttribute('enterkeyhint', 'done');
  }, []);

  // Auto-grow the borderless address field as it wraps across lines. Measuring needs height:auto,
  // which would snap; so measure, put back the height the field is DRAWN at, force a reflow, then
  // set the new height and let the CSS transition run. Restoring the last inline target instead
  // snapped a keystroke that arrived while the previous grow was still animating.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const drawn = ta.style.height ? getComputedStyle(ta).height : '';
    ta.style.height = 'auto';
    const next = `${ta.scrollHeight}px`;
    if (!drawn || drawn === next) {
      ta.style.height = next;
      return;
    }
    ta.style.height = drawn;
    void ta.offsetHeight;
    ta.style.height = next;
  }, [address]);

  return (
    <SendStepLayout
      tabRoot
      title={t('sendTo')}
      footer={
        <Button
          title={t('confirm')}
          variant={ButtonVariant.Primary}
          accent="send"
          onClick={onConfirm}
          disabled={!canConfirm}
          data-testid="send-recipient-confirm"
          className="w-full max-w-none"
        />
      }
    >
      <div className="relative mt-3">
        {recipientName && (
          <div className="mb-2 flex items-center gap-3">
            <span data-testid="send-recipient-avatar" className="flex shrink-0">
              <ContactAvatar address={address} name={recipientName} />
            </span>
            <span data-testid="send-recipient-name" className="text-hero-name text-ink">
              {recipientName}
            </span>
          </div>
        )}
        <textarea
          ref={textareaRef}
          data-testid="send-recipient-input"
          rows={1}
          placeholder={addressPlaceholder}
          className={clsx(
            'font-heading w-full resize-none overflow-hidden bg-transparent outline-none',
            'transition-[height] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
            // Below the tab title, never above it: 24px holds the placeholder to two lines on a
            // 375pt phone, and a pasted address wraps to three.
            'text-hero-name font-bold wrap-break-word placeholder:text-muted/70',
            'caret-accent-send',
            error ? 'text-negative-tint-ink' : 'text-ink'
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

      <AnimatePresence initial={false}>
        {error && (
          <motion.p key="error" className="overflow-hidden text-body-sm text-negative-tint-ink" {...reveal}>
            <span className="block pt-2">{t(`${error}`)}</span>
          </motion.p>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {isValidAddress && (
          <motion.div key="networks" className="overflow-hidden" {...reveal}>
            <div className="pt-4">
              <NetworkField
                chain={isEthereum ? 'ethereum' : 'miden'}
                network={network === 'miden' ? undefined : network}
                onSelect={onSelectNetwork}
                testIdPrefix="send"
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className={clsx('mt-4', recentRecipients.length > 0 ? 'pb-7' : 'pb-4')}>
        {/* The pills swap as one set, never one by one: the current set fades
            out, then the next fades in. Removing Paste/Scan while Address Book
            slid over and relabelled itself raced three animations against
            each other. */}
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={pillSet}
            // One row that never wraps: on a narrow phone it scrolls sideways, bleeding past the
            // page's 24px gutter so the cut pill says there is more.
            className="no-scrollbar -mx-6 flex items-start gap-2 overflow-x-auto px-6 [&>*]:shrink-0"
            {...pillSwap}
          >
            {pillSet === 'add' ? (
              <Pill
                icon={<SendAddressBookIcon data-testid="send-address-book-icon" />}
                onClick={() => onAddContact?.()}
                data-testid="send-address-book"
              >
                {t('addToContactsPrompt')}
              </Pill>
            ) : (
              <>
                {onPaste && pillSet === 'empty' && (
                  <Pill icon={<Icon name={IconName.FileCopy} size="xs" />} onClick={onPaste} data-testid="send-paste">
                    {t('paste')}
                  </Pill>
                )}
                <Pill
                  icon={<SendAddressBookIcon data-testid="send-address-book-icon" />}
                  onClick={onAddressBook}
                  data-testid="send-address-book"
                >
                  {t('addressBook')}
                </Pill>
                {onScan && pillSet === 'empty' && (
                  <Pill icon={<ScanFrameIcon data-testid="send-scan-icon" />} onClick={onScan}>
                    {scanQrCodeLabel}
                  </Pill>
                )}
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <AnimatePresence initial={false}>
        {recentRecipients.length > 0 && (
          <motion.section
            key="recents"
            className="flex flex-col overflow-hidden pb-10"
            data-testid="send-recent-recipients"
            {...reveal}
          >
            <h2 className="text-title-section text-ink">{t('recent')}</h2>
            <ul className="mt-2 flex flex-col overflow-hidden rounded-2xl bg-fill">
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
                      'flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors active:bg-fill-pressed',
                      index > 0 && 'border-t border-hairline'
                    )}
                  >
                    <ContactAvatar
                      address={recipient.address}
                      name={recipient.name}
                      network={recipient.chain === 'miden' ? 'miden' : 'ethereum'}
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-row-title text-ink">
                        {recipient.name ?? truncateAddress(recipient.address)}
                      </span>
                      {/* The address once: with no saved name the line above already shows it, so
                          this line names the network instead. */}
                      <span className="truncate text-caption text-muted">
                        {recipient.name
                          ? truncateAddress(recipient.address)
                          : recipient.chain === 'miden'
                            ? t('miden')
                            : (recipient.networkName ?? t('ethereum'))}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </motion.section>
        )}
      </AnimatePresence>
    </SendStepLayout>
  );
};

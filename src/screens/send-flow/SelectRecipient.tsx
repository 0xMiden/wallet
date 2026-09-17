import React, { ChangeEvent, useEffect, useRef } from 'react';

import clsx from 'clsx';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { ReactComponent as ScanFrameIcon } from 'app/icons/scan-frame.svg';
import { ReactComponent as SendAddressBookIcon } from 'app/icons/send-address-book.svg';
import { Icon, IconName } from 'app/icons/v2';
import { Avatar } from 'components/Avatar';
import { Button, ButtonVariant } from 'components/Button';
import { hapticLight } from 'lib/mobile/haptics';
import { AddressChain } from 'utils/miden';
import { truncateAddress } from 'utils/string';

import { BRIDGE_NETWORKS, BridgeNetworkId, getBridgeNetwork, SendNetworkId } from './bridge-networks';
import { NetworkChip } from './NetworkChip';
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
  // Pops a small element (chip, pill) in place.
  const pop = {
    initial: { opacity: 0, scale: 0.85 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.85 },
    transition
  };
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

  // Auto-grow the borderless address field as it wraps across lines. Measuring
  // needs height:auto, which would snap; so measure, put the old height back,
  // force a reflow, then set the new height and let the CSS transition run.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const previous = ta.style.height;
    ta.style.height = 'auto';
    const next = `${ta.scrollHeight}px`;
    if (!previous || previous === next) {
      ta.style.height = next;
      return;
    }
    ta.style.height = previous;
    void ta.offsetHeight;
    ta.style.height = next;
  }, [address]);

  const titleChip = (
    <AnimatePresence initial={false} mode="popLayout">
      {isValidAddress && (
        <motion.span key={isEthereum ? 'ethereum' : 'miden'} className="inline-flex" {...pop}>
          {isEthereum ? (
            <NetworkChip
              kind="ethereum"
              label={selectedNetwork?.name ?? t('ethereum')}
              data-testid="send-recipient-network"
            />
          ) : (
            <NetworkChip kind="miden" label={t('miden')} data-testid="send-recipient-network" />
          )}
        </motion.span>
      )}
    </AnimatePresence>
  );

  return (
    <SendStepLayout
      title={t('chooseRecipient')}
      titleAccessory={titleChip}
      footer={
        <Button
          title={t('confirm')}
          variant={ButtonVariant.Primary}
          onClick={onConfirm}
          disabled={!canConfirm}
          data-testid="send-recipient-confirm"
          className="w-full max-w-none rounded-full text-base font-semibold"
        />
      }
    >
      <div className="relative mt-3">
        {recipientName && (
          <div className="mb-2 flex items-center gap-3">
            <span
              data-testid="send-recipient-avatar"
              className="h-8 w-8 shrink-0 rounded-full bg-grey-300"
              aria-hidden="true"
            />
            <span data-testid="send-recipient-name" className="font-heading text-2xl font-bold text-black">
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

      <AnimatePresence initial={false}>
        {error && (
          <motion.p key="error" className="overflow-hidden text-sm text-red-500" {...reveal}>
            <span className="block pt-2">{t(`${error}`)}</span>
          </motion.p>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {isValidAddress && isEthereum && (
          <motion.div key="networks" className="overflow-hidden" {...reveal}>
            <div className="flex flex-col gap-2 pt-4" data-testid="send-network-options">
              <span className="text-sm text-text-muted">{t('network')}</span>
              <div className="flex flex-wrap gap-2">
                {BRIDGE_NETWORKS.map(option => (
                  <NetworkChip
                    key={option.id}
                    kind="ethereum"
                    label={option.name}
                    selected={network === option.id}
                    onClick={() => {
                      hapticLight();
                      onSelectNetwork(option.id);
                    }}
                    data-testid={`send-network-${option.id}`}
                  />
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* The row itself stays a plain block: it rides the textarea's height
          transition in normal flow, and each pill animates its own entry, exit
          and shift. */}
      <div className={clsx('mt-2 flex flex-wrap items-start gap-1', recentRecipients.length > 0 ? 'pb-6' : 'pb-4')}>
        <AnimatePresence initial={false} mode="popLayout">
          {onPaste && !hasAddress && (
            <motion.span key="paste" layout={!reduceMotion} className="inline-flex" {...pop}>
              <Button
                variant={ButtonVariant.Secondary}
                onClick={() => {
                  hapticLight();
                  onPaste();
                }}
                data-testid="send-paste"
                className="h-auto! w-fit! rounded-full bg-surface-interactive! px-2! py-1! text-base font-bold hover:bg-surface-interactive!"
              >
                <Icon name={IconName.FileCopy} size="xs" className="shrink-0" />
                <span>{t('paste')}</span>
              </Button>
            </motion.span>
          )}
          <motion.span key="address-book" layout={!reduceMotion} transition={transition} className="inline-flex">
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
              <AnimatePresence initial={false} mode="wait">
                <motion.span
                  key={showAddContact ? 'add' : 'book'}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={reduceMotion ? { duration: 0 } : { duration: DURATION / 2, ease: EASE }}
                >
                  {showAddContact ? t('addToContactsPrompt') : t('addressBook')}
                </motion.span>
              </AnimatePresence>
            </Button>
          </motion.span>
          {onScan && !hasAddress && (
            <motion.span key="scan" layout={!reduceMotion} className="inline-flex" {...pop}>
              <Button
                variant={ButtonVariant.Secondary}
                onClick={onScan}
                className="h-auto! w-fit! rounded-full bg-surface-interactive! px-2! py-1! text-base font-bold hover:bg-surface-interactive!"
              >
                <ScanFrameIcon data-testid="send-scan-icon" className="h-4 w-4 shrink-0" />
                <span>{scanQrCodeLabel}</span>
              </Button>
            </motion.span>
          )}
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
                          <NetworkChip kind="miden" label={t('miden')} />
                        ) : (
                          <NetworkChip kind="ethereum" label={recipient.networkName ?? t('ethereum')} />
                        )}
                        <span className="truncate">{truncateAddress(recipient.address)}</span>
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

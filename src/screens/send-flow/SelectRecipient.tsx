import React, { ChangeEvent, useEffect, useRef } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { hapticLight } from 'lib/mobile/haptics';
import { AddressChain } from 'utils/miden';

import { BRIDGE_NETWORKS, BridgeNetworkId } from './bridge-networks';

const AddressBookIcon: React.FC = () => (
  <svg width="15" height="16" viewBox="0 0 11 12" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M5.46105 5.6433C6.81823 5.6433 7.91844 4.54309 7.91844 3.18591C7.91844 1.82873 6.81823 0.728516 5.46105 0.728516C4.10387 0.728516 3.00366 1.82873 3.00366 3.18591C3.00366 4.54309 4.10387 5.6433 5.46105 5.6433Z"
      stroke="currentColor"
      strokeWidth="1.45623"
    />
    <path
      d="M0.728271 10.6498C1.36537 8.46541 3.27668 7.28223 5.46102 7.28223C7.64537 7.28223 9.55668 8.46541 10.1938 10.6498"
      stroke="currentColor"
      strokeWidth="1.45623"
      strokeLinecap="round"
    />
  </svg>
);

const QrCodeIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2.5" y="2.5" width="7.5" height="7.5" rx="2" stroke="currentColor" strokeWidth="2.5" />
    <rect x="14" y="2.5" width="7.5" height="7.5" rx="2" stroke="currentColor" strokeWidth="2.5" />
    <rect x="2.5" y="14" width="7.5" height="7.5" rx="2" stroke="currentColor" strokeWidth="2.5" />
    <rect x="14" y="14" width="3.25" height="3.25" rx="0.5" fill="currentColor" />
    <rect x="18.25" y="14" width="3.25" height="3.25" rx="0.5" fill="currentColor" />
    <rect x="14" y="18.25" width="3.25" height="3.25" rx="0.5" fill="currentColor" />
    <rect x="18.25" y="18.25" width="3.25" height="3.25" rx="0.5" fill="currentColor" />
  </svg>
);

export interface SelectRecipientProps {
  address: string;
  isValidAddress: boolean;
  error?: string;
  /**
   * Chain detected from the typed address. `ethereum` offers the cross-chain
   * destination networks; `miden` is same-chain, so Miden is its only network.
   */
  chain: AddressChain;
  /** Selected destination network (cross-chain only). */
  network?: BridgeNetworkId;
  onNetworkChange?: (network: BridgeNetworkId) => void;
  onAddressChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onAddressBook: () => void;
  /** Scan a recipient address from a QR code. Omitted where scanning is unavailable (desktop/extension). */
  onScan?: () => void;
  onConfirm: () => void;
}

/** Network chip. A chain with a single option (Miden, and today Sepolia) renders as a static badge. */
const NetworkChip: React.FC<{ label: string; selected: boolean; onSelect?: () => void }> = ({
  label,
  selected,
  onSelect
}) => (
  <button
    type="button"
    onClick={
      onSelect &&
      (() => {
        hapticLight();
        onSelect();
      })
    }
    className={clsx(
      'rounded-full px-3 py-1 text-xs font-semibold transition-colors',
      selected ? 'bg-primary-500 text-pure-white' : 'bg-surface-interactive text-heading-gray',
      !onSelect && 'pointer-events-none'
    )}
  >
    {label}
  </button>
);

export const SelectRecipient: React.FC<SelectRecipientProps> = ({
  address,
  isValidAddress,
  error,
  chain,
  network,
  onNetworkChange,
  onAddressChange,
  onAddressBook,
  onScan,
  onConfirm
}) => {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
        <span className="font-heading text-2xl leading-none font-bold text-gray">{t('chooseRecipient')}</span>

        <div className="relative mt-3">
          <textarea
            ref={textareaRef}
            data-testid="send-recipient-input"
            rows={1}
            placeholder={t('enterMidenOrEthereumAddress')}
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

        <div className="mt-4 flex flex-col items-start gap-3">
          <Button
            variant={ButtonVariant.Secondary}
            title={t('addressBook')}
            iconLeft={<AddressBookIcon />}
            onClick={onAddressBook}
            className="rounded-full text-base font-bold w-fit!"
          />
          {onScan && (
            <Button
              variant={ButtonVariant.Secondary}
              title={t('scan')}
              iconLeft={<QrCodeIcon />}
              onClick={onScan}
              className="rounded-full text-base font-bold w-fit!"
            />
          )}
        </div>
      </div>

      <div className="shrink-0 pt-4 pb-24">
        <Button
          title={t('confirm')}
          variant={ButtonVariant.Primary}
          onClick={onConfirm}
          disabled={!isValidAddress}
          data-testid="send-recipient-confirm"
          className="w-full max-w-none rounded-full text-base font-semibold"
        />
      </div>
    </div>
  );
};

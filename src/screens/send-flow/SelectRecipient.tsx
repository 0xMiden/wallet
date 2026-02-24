import React, { ChangeEvent, useCallback, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { NavigationHeader } from 'components/NavigationHeader';
import { TextArea } from 'components/TextArea';
import { hapticSuccess, hapticError } from 'lib/mobile/haptics';
import { scanQRCode, isScanAvailable } from 'lib/qr';

export interface SelectRecipientProps {
  address?: string;
  isValidAddress: boolean;
  error?: string;
  onGoNext: () => void;
  onAddressChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onScannedAddress?: (address: string) => void;
  onYourAccounts: () => void;
  onClear: () => void;
  onClose: () => void;
  onCancel: () => void;
}

export const SelectRecipient: React.FC<SelectRecipientProps> = ({
  address,
  isValidAddress,
  error,
  onAddressChange,
  onScannedAddress,
  onYourAccounts,
  onGoNext,
  onClear,
  onClose,
  onCancel
}) => {
  const { t } = useTranslation();
  const [scanError, setScanError] = useState<string | null>(null);
  const showScanButton = isScanAvailable();

  const handleScan = useCallback(async () => {
    setScanError(null);
    const result = await scanQRCode();

    if (result.success && result.address) {
      hapticSuccess();
      onScannedAddress?.(result.address);
    } else if (result.errorKey && result.errorKey !== 'scanCancelled') {
      hapticError();
      setScanError(result.errorKey);
    }
  }, [onScannedAddress]);

  return (
    <div className="flex-1 flex flex-col">
      <NavigationHeader title={t('recipient')} onBack={onClose} showBorder />
      <div className="flex flex-col flex-1 p-4 md:w-[460px] md:mx-auto">
        <div className="flex-1 flex flex-col justify-stretch gap-y-2">
          <div className="relative">
            <TextArea
              placeholder={t('recipientAccountId')}
              className={`w-full ${showScanButton ? 'pr-20' : 'pr-10'}`}
              value={address}
              onChange={onAddressChange}
              autoFocus
            />
            <div className="absolute top-0 right-0 mt-2 mr-2 flex items-center gap-x-1">
              {showScanButton && (
                <button
                  type="button"
                  onClick={handleScan}
                  className="p-1 rounded-lg hover:bg-grey-100 transition duration-200"
                  aria-label={t('scanQr')}
                >
                  <Icon name={IconName.QrScan} fill="black" size="md" />
                </button>
              )}
              {address && (
                <button type="button" onClick={onClear} className="p-1" aria-label={t('clearText')}>
                  <Icon name={IconName.CloseCircle} fill="black" size="md" />
                </button>
              )}
            </div>
          </div>
          {(error || scanError) && <p className="text-red-500 text-xs">{scanError ? t(scanError) : t(`${error}`)}</p>}
          <Button
            title={t('yourAccounts')}
            iconLeft={IconName.ContactsBook}
            variant={ButtonVariant.Ghost}
            onClick={onYourAccounts}
          />
        </div>
        <div></div>
        <div className="flex flex-row gap-x-2">
          <Button className="flex-1" title={t('cancel')} variant={ButtonVariant.Secondary} onClick={onCancel} />
          <Button
            className="flex-1"
            title={t('next')}
            variant={ButtonVariant.Primary}
            disabled={!isValidAddress}
            onClick={onGoNext}
          />
        </div>
      </div>
    </div>
  );
};

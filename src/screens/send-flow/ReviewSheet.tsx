import React from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { truncateAddress } from 'utils/string';

export interface ReviewSheetProps {
  isOpen: boolean;
  amount: string;
  tokenName: string;
  fromAddress: string;
  toAddress: string;
  recallBlocks?: string;
  sharePrivately: boolean;
  delegateTransaction: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export const ReviewSheet: React.FC<ReviewSheetProps> = ({
  isOpen,
  amount,
  tokenName,
  fromAddress,
  toAddress,
  recallBlocks,
  sharePrivately,
  delegateTransaction,
  onCancel,
  onConfirm
}) => {
  const { t } = useTranslation();

  return (
    <Drawer open={isOpen} onOpenChange={open => !open && onCancel()}>
      <DrawerContent className="bg-white">
        <DrawerHeader>
          <DrawerTitle className="text-center">{t('reviewTransaction')}</DrawerTitle>
        </DrawerHeader>

        <div className="px-6 pb-6">
          {/* Amount */}
          <div className="text-center mb-4">
            <span className="text-3xl font-medium">
              {amount} {tokenName}
            </span>
          </div>

          {/* Details */}
          <div className="space-y-3 mb-4">
            <div className="flex justify-between">
              <span className="text-sm text-grey-600">{t('from')}</span>
              <span className="text-sm">{truncateAddress(fromAddress)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-grey-600">{t('to')}</span>
              <span className="text-sm">{truncateAddress(toAddress)}</span>
            </div>
            {recallBlocks && (
              <div className="flex justify-between">
                <span className="text-sm text-grey-600">{t('recallBlocks')}</span>
                <span className="text-sm">{recallBlocks}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-sm text-grey-600">{t('privatePayment')}</span>
              <span className="text-sm">{sharePrivately ? t('yes') : t('no')}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-grey-600">{t('delegateProving')}</span>
              <span className="text-sm">{delegateTransaction ? t('yes') : t('no')}</span>
            </div>
          </div>

          {/* Buttons */}
          <div className="flex gap-3">
            <Button title={t('cancel')} variant={ButtonVariant.Secondary} onClick={onCancel} className="flex-1" />
            <Button
              type="submit"
              title={t('confirm')}
              variant={ButtonVariant.Primary}
              onClick={onConfirm}
              className="flex-1"
            />
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

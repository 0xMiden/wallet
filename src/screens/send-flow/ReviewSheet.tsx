import React from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
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
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.5 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black z-40"
            onClick={onCancel}
          />

          {/* Sheet */}
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 35, stiffness: 600, mass: 1 }}
            className="absolute bottom-0 left-0 right-0 bg-white rounded-t-3xl z-50 px-6 pt-4 pb-6"
          >
            {/* Handle */}
            <div className="flex justify-center mb-4">
              <div className="w-12 h-1 bg-grey-200 rounded-full" />
            </div>

            {/* Title */}
            <h2 className="text-lg font-medium text-center mb-4">{t('reviewTransaction')}</h2>

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
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

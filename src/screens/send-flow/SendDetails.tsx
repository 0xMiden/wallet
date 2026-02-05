import React, { ChangeEvent, useCallback, useState } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { InputAmount } from 'components/InputAmount';
import { TextArea } from 'components/TextArea';
import { useAccount } from 'lib/miden/front';
import { hapticError, hapticSuccess } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import { isScanAvailable, scanQRCode } from 'lib/qr';

import { ReviewSheet } from './ReviewSheet';
import { SendFlowAction, SendFlowActionId, UIToken } from './types';

export interface SendDetailsProps {
  token: UIToken;
  amount: string;
  recipientAddress: string;
  sharePrivately: boolean;
  delegateTransaction: boolean;
  recallBlocks?: string;
  isValidAmount: boolean;
  isValidAddress: boolean;
  amountError?: string;
  addressError?: string;
  onAction: (action: SendFlowAction) => void;
  onGoBack: () => void;
  onAmountChange: (amount: string) => void;
  onAddressChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onScannedAddress?: (address: string) => void;
  onClearAddress: () => void;
  onYourAccounts: () => void;
  onSubmit: () => void;
}

export const SendDetails: React.FC<SendDetailsProps> = ({
  token,
  amount,
  recipientAddress,
  sharePrivately,
  delegateTransaction,
  recallBlocks,
  isValidAmount,
  isValidAddress,
  amountError,
  addressError,
  onAction,
  onGoBack,
  onAmountChange,
  onAddressChange,
  onScannedAddress,
  onClearAddress,
  onYourAccounts,
  onSubmit
}) => {
  const { t } = useTranslation();
  const { publicKey } = useAccount();
  const [showReview, setShowReview] = useState(false);
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

  const handleReviewOpen = useCallback(() => {
    if (isValidAmount && isValidAddress) {
      setShowReview(true);
    }
  }, [isValidAmount, isValidAddress]);

  const handleReviewClose = useCallback(() => {
    setShowReview(false);
  }, []);

  const handleConfirmSend = useCallback(() => {
    setShowReview(false);
    onSubmit();
  }, [onSubmit]);

  const canProceed = isValidAmount && isValidAddress;

  return (
    <div className="flex flex-col">
      <div
        className={clsx(
          'flex w-full items-center px-4 bg-white border-b-[0.5px] border-[#48484833] border-dashed',
          isMobile() ? 'pt-6 pb-[18px]' : 'py-[18px]'
        )}
      >
        <button
          type="button"
          onClick={onGoBack}
          className="p-1 rounded-lg hover:bg-grey-100 transition duration-200"
          aria-label={t('back')}
        >
          <Icon name={IconName.ChevronLeft} fill="black" size="md" />
        </button>
        <h1 className="flex-1 text-xl font-medium text-heading-gray text-center">{t('send')}</h1>
        <div className="w-8" /> {/* Spacer for centering */}
      </div>
      <div className={clsx('flex flex-col relative w-full', isMobile() ? 'px-8' : 'px-4')}>
        <div className="flex flex-col py-6 overflow-y-auto">
          {/* Amount Input */}
          <div className="flex flex-col items-center justify-center pb-4">
            <InputAmount
              className="self-stretch"
              value={amount}
              label={token.name}
              onValueChange={(value, name, values) => onAmountChange(values?.formatted || value || '')}
              autoFocus
            />
            {amountError && (
              <div className="flex items-center gap-2 mt-2">
                <Icon name={IconName.InformationFill} size="xs" className="text-red-500" />
                <span className="text-red-500 text-sm">{t(amountError)}</span>
              </div>
            )}
          </div>

          {/* Recipient Input */}
          <div className="mb-4">
            <div className="relative flex flex-col items-center justify-center">
              <TextArea
                placeholder={'mtst1qzv...5tfg'}
                className={clsx(
                  `w-full text-center border-[#00000033] border-[0.35px] rounded-[10px]`,
                  isMobile() ? 'pr-20' : ''
                )}
                value={recipientAddress}
                onChange={onAddressChange}
              />
              <div className="absolute top-0 right-0 mt-2 mr-2 flex items-center gap-x-1">
                <button
                  type="button"
                  onClick={onYourAccounts}
                  className="p-1 rounded-lg hover:bg-grey-100 transition duration-200"
                  aria-label={t('yourAccounts')}
                >
                  <Icon name={IconName.ContactsBook} fill="#9CA3AF" size="sm" />
                </button>
                {showScanButton && (
                  <button
                    type="button"
                    onClick={handleScan}
                    className="p-1 rounded-lg hover:bg-grey-100 transition duration-200"
                    aria-label={t('scanQr')}
                  >
                    <Icon name={IconName.QrScan} fill="#9CA3AF" size="sm" />
                  </button>
                )}
              </div>
            </div>
            {(addressError || scanError) && (
              <p className="text-red-500 text-xs mt-1">{scanError ? t(scanError) : t(`${addressError}`)}</p>
            )}
          </div>

          {/* Options */}
          <div className="flex flex-col gap-3">
            {/* One to Many Payment - placeholder for future */}

            {/* Private Payment */}
            <div className="border-[0.5px] border-[#00000033] rounded-[5px] overflow-hidden">
              <OptionItem
                title={t('privatePayment')}
                subTitle={t('privatePaymentDescription')}
                value={sharePrivately}
                onToggle={(val: boolean) => {
                  onAction({
                    id: SendFlowActionId.SetFormValues,
                    payload: { sharePrivately: val }
                  });
                }}
                first
              />
            </div>

            {/* Delegate Proving */}
            <div className="border-[0.5px] border-[#00000033] rounded-[5px] overflow-hidden">
              <OptionItem
                title={t('useDelegateProving')}
                subTitle={t('delegateProvingDescription')}
                value={delegateTransaction}
                onToggle={(val: boolean) => {
                  onAction({
                    id: SendFlowActionId.SetFormValues,
                    payload: { delegateTransaction: val }
                  });
                }}
                first
              />
            </div>
          </div>
        </div>

        {/* Send Button */}
        <div className="">
          <Button
            title={t('sendPayment')}
            variant={ButtonVariant.Primary}
            onClick={handleReviewOpen}
            disabled={!canProceed}
            className="w-full rounded-[5px] text-base font-semibold"
          />
        </div>

        {/* Review Sheet */}
        <ReviewSheet
          isOpen={showReview}
          amount={amount}
          tokenName={token.name}
          fromAddress={publicKey}
          toAddress={recipientAddress}
          recallBlocks={recallBlocks}
          sharePrivately={sharePrivately}
          delegateTransaction={delegateTransaction}
          onCancel={handleReviewClose}
          onConfirm={handleConfirmSend}
        />
      </div>
    </div>
  );
};

export const OptionItem = ({
  onToggle,
  title,
  subTitle,
  value,
  first
}: {
  onToggle: (val: boolean) => void;
  title: string;
  subTitle: string;
  value: boolean;
  first?: boolean;
}) => {
  return (
    <div className={`flex items-center justify-between font-geist ${first ? '' : 'border-t-[0.5px]'}`}>
      <div className="space-y-[2px] pl-5">
        <div className={clsx('font-medium text-black leading-none', isMobile() ? 'text-sm' : 'text-base')}>{title}</div>
        <div className={clsx('text-[#000000A6]', isMobile() ? 'text-[10px] ' : 'text-xs')}>{subTitle}</div>
      </div>
      <Switch2 value={value} onToggle={onToggle} />
    </div>
  );
};

const Switch2 = ({ value, onToggle }: { value: boolean; onToggle: (val: boolean) => void }) => {
  if (value) {
    return (
      <div className="flex">
        <div
          className="cursor-pointer text-primary-500 w-[64px] h-[54px] text-sm bg-[#F9F9F9] border-x-[0.35px] flex items-center justify-center px-[1px] border-x-[#00000033]"
          onClick={() => onToggle(false)}
        >
          On
        </div>
        <div className="w-[64px] h-[54px] bg-background rounded-[10px]"></div>
      </div>
    );
  } else {
    return (
      <div className="flex">
        <div className="w-[64px] h-[54px] border-l-[0.35px] border-l-[#00000033]"></div>
        <div
          className="cursor-pointer text-primary-500 text-sm w-[64px] h-[54px] flex items-center justify-center bg-[#F9F9F9] border-l-[0.35px] rounded-br-[10px] border-l-[#00000033]"
          onClick={() => onToggle(true)}
        >
          Off
        </div>
      </div>
    );
  }
};

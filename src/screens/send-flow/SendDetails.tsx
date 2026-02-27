import React, { ChangeEvent, useCallback, useState } from 'react';

import clsx from 'clsx';
import { addDays, addHours, addMinutes, format, differenceInSeconds } from 'date-fns';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { InputAmount } from 'components/InputAmount';
import { NavigationHeader } from 'components/NavigationHeader';
import { AutoSync } from 'lib/miden/front/autoSync';
import { hapticError, hapticLight, hapticSuccess } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import { isScanAvailable, scanQRCode } from 'lib/qr';
import { Calendar } from 'lib/ui/calendar';

import { SendFlowAction, SendFlowActionId, SendFlowStep, UIToken } from './types';

const SECONDS_PER_BLOCK = 3;

function dateTimeToRecallBlocks(targetDate: Date, currentBlockNum: number): number {
  const secondsUntilTarget = differenceInSeconds(targetDate, new Date());
  if (secondsUntilTarget <= 0) return currentBlockNum;
  return Math.floor(currentBlockNum + secondsUntilTarget / SECONDS_PER_BLOCK);
}
const RECALL_PRESETS = (t: any) => [
  { label: t('30mins'), fn: (d: Date) => addMinutes(d, 30) },
  { label: t('1hour'), fn: (d: Date) => addHours(d, 1) },
  { label: t('5hours'), fn: (d: Date) => addHours(d, 5) },
  { label: t('tomorrow'), fn: (d: Date) => addDays(d, 1) },
  { label: t('inAWeek'), fn: (d: Date) => addDays(d, 7) },
  { label: t('in2Weeks'), fn: (d: Date) => addDays(d, 14) }
];
export interface SendDetailsProps {
  token: UIToken;
  amount: string;
  recipientAddress: string;
  sharePrivately: boolean;
  delegateTransaction: boolean;
  recallBlocks?: string;
  isValidAmount: boolean;
  isValidAddress: boolean;
  recallDate?: Date;
  recallTime: string;
  amountError?: string;
  addressError?: string;
  onAction: (action: SendFlowAction) => void;
  onGoBack: () => void;
  onAmountChange: (amount: string) => void;
  onAddressChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onScannedAddress?: (address: string) => void;
  onClearAddress: () => void;
  onYourAccounts: () => void;
  onRecallDateChange: (date: Date | undefined) => void;
  onRecallTimeChange: (time: string) => void;
}

export const SendDetails: React.FC<SendDetailsProps> = ({
  token,
  amount,
  recipientAddress,
  sharePrivately,
  delegateTransaction,
  isValidAmount,
  isValidAddress,
  amountError,
  addressError,
  recallDate,
  recallTime,
  onAction,
  onGoBack,
  onAmountChange,
  onAddressChange,
  onScannedAddress,
  onYourAccounts,
  onRecallDateChange,
  onRecallTimeChange
}) => {
  const { t } = useTranslation();
  const [scanError, setScanError] = useState<string | null>(null);
  const [showCalendar, setShowCalendar] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [calendarMonth, setCalendarMonth] = useState<Date>(
    new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  );
  const showScanButton = isScanAvailable();

  const computeAndSetRecallBlocks = useCallback(
    (targetDate: Date) => {
      const currentBlockNum = AutoSync.lastHeight;
      const blocks = dateTimeToRecallBlocks(targetDate, currentBlockNum);
      onAction({
        id: SendFlowActionId.SetFormValues,
        payload: { recallBlocks: String(blocks) }
      });
    },
    [onAction]
  );

  const applyDateTimeSelection = useCallback(
    (date: Date, time: string) => {
      const [hours, minutes] = time.split(':').map(Number);
      const dateWithTime = new Date(date);
      dateWithTime.setHours(hours, minutes, 0, 0);
      onRecallDateChange(date);
      onRecallTimeChange(time);
      computeAndSetRecallBlocks(dateWithTime);
      setShowCalendar(false);
    },
    [computeAndSetRecallBlocks, onRecallDateChange, onRecallTimeChange]
  );

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
      onAction({ id: SendFlowActionId.Navigate, step: SendFlowStep.ReviewTransaction });
    }
  }, [isValidAmount, isValidAddress, onAction]);

  const canProceed = isValidAmount && isValidAddress;

  const displayRecallLabel = recallDate ? `${format(recallDate, 'MMM d, yyyy')} ${recallTime}` : t('selectRecallDate');

  return (
    <div className="flex flex-col h-full">
      <NavigationHeader mode="back" title={t('send')} onBack={onGoBack} showBorder />

      <div className={clsx('flex flex-col flex-1 overflow-hidden relative w-full', isMobile() ? 'px-8' : 'px-4')}>
        <div className="flex flex-col flex-1 pt-8 pb-4 overflow-y-auto min-h-0 no-scrollbar">
          <div className="relative flex flex-col items-center justify-center shrink-0">
            <InputAmount
              className="self-stretch"
              value={amount}
              label={token.name}
              onValueChange={(value, name, values) => onAmountChange(values?.formatted || value || '')}
              autoFocus
            />
            <div className="flex items-center justify-center">
              {amountError ? (
                <div className="flex items-center gap-2">
                  <Icon name={IconName.InformationFill} size="xs" className="text-red-500" />
                  <span className="text-red-500 text-sm">{t(amountError)}</span>
                </div>
              ) : (
                <span className="text-heading-gray/60 text-base">
                  {t('balance')}: {token.balance.toFixed(2)} {token.name}
                </span>
              )}
            </div>
          </div>

          {/* Recipient Address */}
          <div className="mt-5">
            <div className="flex items-center justify-between">
              <h3 className="text-base leading-4 font-semibold text-heading-gray">{t('recipientAddress')}</h3>
              <div className="flex items-center gap-x-1">
                <button
                  type="button"
                  onClick={onYourAccounts}
                  className="p-1 rounded-lg hover:bg-grey-100 transition duration-200"
                  aria-label={t('yourAccounts')}
                >
                  <Icon name={IconName.AddressBook} size="xs" className="text-[#808080]" />
                </button>
                {showScanButton && (
                  <button
                    type="button"
                    onClick={handleScan}
                    className="p-1 rounded-lg hover:bg-grey-100 transition duration-200"
                    aria-label={t('scanQr')}
                  >
                    <Icon name={IconName.ScanFrame} size="xs" className="text-[#808080]" />
                  </button>
                )}
              </div>
            </div>
            <div className="mt-3">
              <input
                type="text"
                placeholder={t('enterWalletAddress')}
                className="w-full bg-[#F2F2F2] border-none rounded-[10px] h-14 px-3 font-medium text-base text-heading-gray placeholder-grey-400 outline-none overflow-hidden text-ellipsis"
                value={recipientAddress}
                onChange={e => onAddressChange(e as any)}
              />
            </div>
            {(addressError || scanError) && (
              <p className="text-red-500 text-xs mt-1">{scanError ? t(scanError) : t(`${addressError}`)}</p>
            )}
          </div>

          {/* Advanced Toggle */}
          <button
            type="button"
            className="mt-5 flex items-center gap-2 self-start rounded-[10px] bg-[#F2F2F2] px-4 py-2.5 transition-colors active:bg-[#E5E5E5]"
            onClick={() => {
              hapticLight();
              setShowAdvanced(prev => !prev);
            }}
          >
            <span className="text-sm font-semibold text-heading-gray">{t('advanced')}</span>
            <motion.div animate={{ rotate: showAdvanced ? 180 : 0 }} transition={{ duration: 0.2 }}>
              <Icon name={IconName.ChevronDown} size="xs" fill="#484848" />
            </motion.div>
          </button>

          <div
            className={clsx(
              'overflow-hidden transition-all duration-200 ease-in-out',
              showAdvanced ? 'max-h-[800px] opacity-100' : 'max-h-0 opacity-0'
            )}
          >
            {/* Recall Height */}
            <div className="mt-4">
              <h3 className="text-base leading-4 font-semibold text-heading-gray">{t('recallHeight')}</h3>
              <p className="text-xs text-heading-gray mt-1">{t('recallHeightDescription')}</p>
              <button
                type="button"
                className="w-full h-14 flex items-center justify-between bg-[#F2F2F2] rounded-[10px] px-4 mt-3"
                onClick={() => setShowCalendar(true)}
              >
                <div className="flex items-center gap-2">
                  <Icon name={IconName.Calendar} size="xs" className="text-[#808080]" />
                  <span
                    className={clsx('text-sm font-medium', recallDate ? 'text-heading-gray' : 'text-heading-gray/60')}
                  >
                    {displayRecallLabel}
                  </span>
                </div>
                <Icon name={IconName.ChevronDown} size="xs" fill="#484848" />
              </button>
            </div>

            {/* Divider */}
            <div className="mt-4 border-t border-[#BABABA]" />

            {/* Privacy Options */}
            <div className="mt-4">
              <h3 className="text-base leading-4 font-semibold text-heading-gray">{t('privacyOptions')}</h3>
              <p className="text-xs text-heading-gray mt-1">{t('privacyOptionsDescription')}</p>

              <div className="flex flex-col gap-6 mt-6">
                {/* Private Payment */}
                <OptionItem
                  icon={IconName.Lock}
                  title={t('privatePayment')}
                  subTitle={t('privatePaymentDescription')}
                  value={sharePrivately}
                  onToggle={(val: boolean) => {
                    onAction({
                      id: SendFlowActionId.SetFormValues,
                      payload: { sharePrivately: val }
                    });
                  }}
                />

                {/* Delegate Proving */}
                <OptionItem
                  icon={IconName.DelegateProving}
                  title={t('delegateProving')}
                  subTitle={t('delegateProvingDescription')}
                  value={delegateTransaction}
                  onToggle={(val: boolean) => {
                    onAction({
                      id: SendFlowActionId.SetFormValues,
                      payload: { delegateTransaction: val }
                    });
                  }}
                />
              </div>
            </div>
          </div>

          {/* Continue Button */}
          <div className="pt-8 pb-4 shrink-0">
            <Button
              title={t('continue')}
              variant={ButtonVariant.Primary}
              onClick={handleReviewOpen}
              disabled={!canProceed}
              className="w-full rounded-[10px] text-base font-semibold"
            />
          </div>
        </div>

        {/* Calendar Bottom Sheet */}
        <AnimatePresence>
          {showCalendar && (
            <>
              <motion.div
                className="absolute inset-0 bg-black/30 z-40"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowCalendar(false)}
              />
              <motion.div
                className="absolute bottom-0 left-0 right-0 z-50 bg-white rounded-t-2xl"
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                style={{ paddingBottom: isMobile() ? 'max(1rem, env(safe-area-inset-bottom))' : '1rem' }}
              >
                <div className="flex justify-center pt-4 pb-2">
                  <div className="w-12 h-1 bg-grey-200 rounded-full" />
                </div>
                <h3 className="text-center text-heading-gray font-medium text-base pb-2">{t('recallHeight')}</h3>
                <div className="px-4 pb-4 flex flex-col items-center overflow-y-auto no-scrollbar max-h-[70vh]">
                  <Calendar
                    mode="single"
                    selected={recallDate}
                    onSelect={date => {
                      if (date) {
                        onRecallDateChange(date);
                        setCalendarMonth(new Date(date.getFullYear(), date.getMonth(), 1));
                      }
                    }}
                    month={calendarMonth}
                    onMonthChange={setCalendarMonth}
                    disabled={{ before: new Date() }}
                    className="p-0 [--cell-size:--spacing(8)]"
                  />

                  {/* Time Input */}
                  <div className="flex items-center gap-2 w-full mt-3 pt-3 border-t border-[#00000015]">
                    <Icon name={IconName.Calendar} size="xs" className="text-[#808080]" />
                    <span className="text-sm font-medium text-heading-gray">{t('time')}</span>
                    <input
                      type="time"
                      value={recallTime}
                      onChange={e => onRecallTimeChange(e.target.value)}
                      className="ml-auto bg-[#F2F2F2] rounded-[10px] px-3 py-2 text-sm text-heading-gray outline-none font-medium"
                    />
                  </div>

                  {/* Confirm button */}
                  {recallDate && (
                    <button
                      type="button"
                      className="w-full mt-3 py-2.5 rounded-[10px] bg-primary-500 text-white text-sm font-medium"
                      onClick={() => applyDateTimeSelection(recallDate, recallTime)}
                    >
                      {t('confirm')}
                    </button>
                  )}

                  {/* Presets */}
                  <div className="flex flex-wrap gap-2 border-t border-[#00000015] pt-3 mt-3 w-full">
                    {RECALL_PRESETS(t).map((preset, i) => (
                      <button
                        key={i}
                        type="button"
                        className="flex-1 min-w-[30%] text-xs py-2 px-2 rounded-[10px] border border-[#00000033] text-heading-gray hover:bg-[#F2F2F2] transition-colors"
                        onClick={() => {
                          const date = preset.fn(new Date());
                          applyDateTimeSelection(date, format(date, 'HH:mm'));
                        }}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

export const OptionItem = ({
  icon,
  onToggle,
  title,
  subTitle,
  value
}: {
  icon: IconName;
  onToggle: (val: boolean) => void;
  title: string;
  subTitle: string;
  value: boolean;
}) => {
  return (
    <div className="flex items-center justify-between font-geist">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-[10px] flex items-center justify-center shrink-0">
          <Icon name={icon} size="sm" className="text-primary-500" />
        </div>
        <div className="space-y-0.5">
          <div className={clsx('font-medium text-heading-gray leading-none', isMobile() ? 'text-sm' : 'text-base')}>
            {title}
          </div>
          <div className={clsx('text-heading-gray/60', isMobile() ? 'text-[10px]' : 'text-xs')}>{subTitle}</div>
        </div>
      </div>
      <ToggleSwitch value={value} onToggle={onToggle} />
    </div>
  );
};

const ToggleSwitch = ({ value, onToggle }: { value: boolean; onToggle: (val: boolean) => void }) => {
  const { t } = useTranslation();
  return (
    <div className="flex rounded-[10px] border border-[#00000033] overflow-hidden">
      <button
        type="button"
        className={clsx(
          'w-14 h-9 text-xs font-medium flex items-center justify-center transition-colors cursor-pointer',
          value ? 'bg-white text-primary-500' : 'bg-[#F2F2F2] text-heading-gray/40'
        )}
        onClick={() => onToggle(true)}
      >
        {t('on')}
      </button>
      <button
        type="button"
        className={clsx(
          'w-14 h-9 text-xs font-medium flex items-center justify-center transition-colors border-l border-[#00000033] cursor-pointer',
          !value ? 'bg-white text-primary-500' : 'bg-[#F2F2F2] text-heading-gray/40'
        )}
        onClick={() => onToggle(false)}
      >
        {t('off')}
      </button>
    </div>
  );
};

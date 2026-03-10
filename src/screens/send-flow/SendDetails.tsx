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
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

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
  note: string;
  onAction: (action: SendFlowAction) => void;
  onGoBack: () => void;
  onAmountChange: (amount: string) => void;
  onAddressChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onScannedAddress?: (address: string) => void;
  onClearAddress: () => void;
  onYourAccounts: () => void;
  onRecallDateChange: (date: Date | undefined) => void;
  onRecallTimeChange: (time: string) => void;
  onNoteChange: (note: string) => void;
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
  note,
  onAction,
  onGoBack,
  onAmountChange,
  onAddressChange,
  onScannedAddress,
  onYourAccounts,
  onRecallDateChange,
  onRecallTimeChange,
  onNoteChange
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
    <div className="flex flex-col h-full bg-app-bg text-black">
      <NavigationHeader mode="back" title={t('details')} onBack={onGoBack} showBorder />

      <div className={clsx('flex flex-col flex-1 overflow-hidden relative w-full', isMobile() ? 'px-8' : 'px-4')}>
        <div className="flex flex-col flex-1 overflow-y-auto min-h-0 no-scrollbar">
          {/* Amount */}
          <div className="relative flex flex-col items-center justify-center shrink-0 gap-2 py-4 border-b border-grey-300/20">
            <InputAmount
              className="self-stretch text-black"
              value={amount}
              label={token.name}
              onValueChange={(value, name, values) => onAmountChange(values?.formatted || value || '')}
            />
            <div className="flex items-center justify-center">
              {amountError ? (
                <div className="flex items-center gap-2">
                  <Icon name={IconName.InformationFill} size="xs" className="text-red-500" />
                  <span className="text-red-500 text-sm">{t(amountError)}</span>
                </div>
              ) : (
                <span className="text-heading-gray/60 text-sm">
                  {t('balance')}: {token.balance.toFixed(2)} {token.name}
                </span>
              )}
            </div>
          </div>

          {/* Recipient Address */}
          <div className="mt-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base leading-none font-medium text-heading-gray">{t('recipientAddress')}</h3>
              <div className="flex items-center gap-x-1">
                <button
                  type="button"
                  onClick={onYourAccounts}
                  className="p-1 rounded-lg hover:bg-grey-100 transition duration-200"
                  aria-label={t('yourAccounts')}
                >
                  <Icon name={IconName.AddressBook} size="xs" className="text-text-muted" />
                </button>
                {showScanButton && (
                  <button
                    type="button"
                    onClick={handleScan}
                    className="p-1 rounded-lg hover:bg-grey-100 transition duration-200"
                    aria-label={t('scanQr')}
                  >
                    <Icon name={IconName.ScanFrame} size="xs" className="text-text-muted" />
                  </button>
                )}
              </div>
            </div>
            <div className="mt-2">
              <input
                type="text"
                placeholder={t('enterWalletAddress')}
                className="w-full bg-pure-white border-none rounded-[10px] h-14 px-3 font-medium text-base text-heading-gray placeholder-grey-400 outline-none overflow-hidden text-ellipsis"
                value={recipientAddress}
                onChange={e => onAddressChange(e as any)}
              />
            </div>
            {(addressError || scanError) && (
              <p className="text-red-500 text-xs mt-1">{scanError ? t(scanError) : t(`${addressError}`)}</p>
            )}
          </div>

          {/* Private Payment */}
          <div className="mt-6">
            <h3 className="text-base leading-4 font-medium text-heading-gray">{t('privatePayment')}</h3>
            <div className="flex mt-2 gap-2">
              <button
                type="button"
                className={clsx(
                  'flex-1 py-3 rounded-10 text-sm font-semibold transition-colors cursor-pointer',
                  sharePrivately ? 'bg-primary-500 text-pure-white' : 'bg-pure-white text-heading-gray/40'
                )}
                onClick={() => {
                  hapticLight();
                  onAction({ id: SendFlowActionId.SetFormValues, payload: { sharePrivately: true } });
                }}
              >
                {t('on')}
              </button>
              <button
                type="button"
                className={clsx(
                  'flex-1 py-3 rounded-10 text-sm font-semibold transition-colors cursor-pointer',
                  !sharePrivately ? 'bg-primary-500 text-pure-white' : 'bg-input-bg text-heading-gray/40'
                )}
                onClick={() => {
                  hapticLight();
                  onAction({ id: SendFlowActionId.SetFormValues, payload: { sharePrivately: false } });
                }}
              >
                {t('off')}
              </button>
            </div>
          </div>

          {/* Add a Note */}
          {/* <div className="mt-6">
            <textarea
              placeholder={t('addANote')}
              value={note}
              onChange={e => onNoteChange(e.target.value)}
              className="w-full bg-pure-white border-none rounded-10 px-4 py-4 font-medium text-base text-heading-gray placeholder-grey-400 outline-none resize-none min-h-[100px]"
            />
          </div> */}

          {/* Advanced Options */}
          <button
            type="button"
            className="mt-6 flex items-center justify-between w-full rounded-[10px] px-4 py-3.5 transition-colors bg-pure-white"
            onClick={() => {
              hapticLight();
              setShowAdvanced(prev => !prev);
            }}
          >
            <span className="text-sm font-semibold text-heading-gray">{t('advancedOptions')}</span>
            <motion.div animate={{ rotate: showAdvanced ? 90 : 0 }} transition={{ duration: 0.2 }}>
              <Icon name={IconName.ChevronRight} size="xs" />
            </motion.div>
          </button>
          <AnimatePresence initial={false}>
            {showAdvanced && (
              <motion.section
                key="content"
                initial="collapsed"
                animate="open"
                exit="collapsed"
                variants={{
                  open: { opacity: 1, height: 'auto' },
                  collapsed: { opacity: 0, height: 0 }
                }}
                transition={{ duration: 0.3 }}
                className="bg-white"
              >
                <div className="px-4 bg-white rounded-b-10">
                  <div className="mt-4">
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

                  {/* Recall Height */}
                  <div className="mt-4 pb-2">
                    <h3 className="text-base leading-4 font-semibold text-heading-gray">{t('recallHeight')}</h3>
                    <p className="text-xs text-heading-gray mt-1">{t('recallHeightDescription')}</p>
                    <button
                      type="button"
                      className="w-full h-14 flex items-center justify-between bg-input-bg rounded-[10px] px-4 mt-3"
                      onClick={() => setShowCalendar(true)}
                    >
                      <div className="flex items-center gap-2">
                        <Icon name={IconName.Calendar} size="xs" className="text-text-muted" />
                        <span
                          className={clsx(
                            'text-sm font-medium',
                            recallDate ? 'text-heading-gray' : 'text-heading-gray/60'
                          )}
                        >
                          {displayRecallLabel}
                        </span>
                      </div>
                      <Icon name={IconName.ChevronDown} size="xs" fill="currentColor" />
                    </button>
                  </div>
                </div>
              </motion.section>
            )}
          </AnimatePresence>

          {/* Continue Button */}
          <div className="mt-auto pt-8 pb-4 shrink-0">
            <Button
              title={t('continue')}
              variant={ButtonVariant.Primary}
              onClick={handleReviewOpen}
              disabled={!canProceed}
              className="w-full rounded-[10px] text-base font-semibold"
            />
          </div>
        </div>

        {/* Calendar Drawer */}
        <Drawer open={showCalendar} onOpenChange={setShowCalendar}>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>{t('recallHeight')}</DrawerTitle>
            </DrawerHeader>
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
              <div className="flex items-center gap-2 w-full mt-3 pt-3 border-t border-border-subtle">
                <Icon name={IconName.Calendar} size="xs" className="text-text-muted" />
                <span className="text-sm font-medium text-heading-gray">{t('time')}</span>
                <input
                  type="time"
                  value={recallTime}
                  onChange={e => onRecallTimeChange(e.target.value)}
                  className="ml-auto bg-input-bg rounded-[10px] px-3 py-2 text-sm text-heading-gray outline-none font-medium"
                />
              </div>

              {/* Confirm button */}
              {recallDate && (
                <button
                  type="button"
                  className="w-full mt-3 py-2.5 rounded-[10px] bg-primary-500 text-pure-white text-sm font-medium"
                  onClick={() => applyDateTimeSelection(recallDate, recallTime)}
                >
                  {t('confirm')}
                </button>
              )}

              {/* Presets */}
              <div className="flex flex-wrap gap-2 border-t border-border-subtle pt-3 mt-3 w-full">
                {RECALL_PRESETS(t).map((preset, i) => (
                  <button
                    key={i}
                    type="button"
                    className="flex-1 min-w-[30%] text-xs py-2 px-2 rounded-[10px] border border-border-card text-heading-gray hover:bg-input-bg transition-colors"
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
          </DrawerContent>
        </Drawer>
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
    <div className="flex rounded-[10px] border border-border-card overflow-hidden">
      <button
        type="button"
        className={clsx(
          'w-14 h-9 text-xs font-medium flex items-center justify-center transition-colors cursor-pointer',
          value ? 'bg-app-bg text-primary-500' : 'bg-input-bg text-heading-gray/40'
        )}
        onClick={() => onToggle(true)}
      >
        {t('on')}
      </button>
      <button
        type="button"
        className={clsx(
          'w-14 h-9 text-xs font-medium flex items-center justify-center transition-colors border-l border-border-card cursor-pointer',
          !value ? 'bg-app-bg text-primary-500' : 'bg-input-bg text-heading-gray/40'
        )}
        onClick={() => onToggle(false)}
      >
        {t('off')}
      </button>
    </div>
  );
};

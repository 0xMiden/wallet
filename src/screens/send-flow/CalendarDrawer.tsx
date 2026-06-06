import React, { useCallback, useState } from 'react';

import { addDays, addHours, addMinutes, format, differenceInSeconds } from 'date-fns';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Calendar } from 'lib/ui/calendar';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

import { SendFlowAction, SendFlowActionId } from './types';

const SECONDS_PER_BLOCK = 3;

function dateTimeToRecallBlocks(targetDate: Date, currentBlockNum: number): number {
  const secondsUntilTarget = differenceInSeconds(targetDate, new Date());
  if (secondsUntilTarget <= 0) return currentBlockNum;
  return Math.floor(currentBlockNum + secondsUntilTarget / SECONDS_PER_BLOCK);
}

const RECALL_PRESETS = (t: (key: string) => string) => [
  { label: t('30mins'), fn: (d: Date) => addMinutes(d, 30) },
  { label: t('1hour'), fn: (d: Date) => addHours(d, 1) },
  { label: t('5hours'), fn: (d: Date) => addHours(d, 5) },
  { label: t('tomorrow'), fn: (d: Date) => addDays(d, 1) },
  { label: t('inAWeek'), fn: (d: Date) => addDays(d, 7) },
  { label: t('in2Weeks'), fn: (d: Date) => addDays(d, 14) }
];

export const CalendarDrawer = ({
  showCalendar,
  setShowCalendar,
  recallDate,
  onRecallDateChange,
  recallTime,
  onRecallTimeChange,
  syncHeight,
  onAction
}: {
  showCalendar: boolean;
  setShowCalendar: React.Dispatch<React.SetStateAction<boolean>>;
  recallDate: Date | undefined;
  onRecallDateChange: (date: Date | undefined) => void;
  onRecallTimeChange: (time: string) => void;
  syncHeight: number;
  recallTime: string;
  onAction: (action: SendFlowAction) => void;
}) => {
  const { t } = useTranslation();
  const [calendarMonth, setCalendarMonth] = useState<Date>(
    new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  );
  const computeAndSetRecallBlocks = useCallback(
    (targetDate: Date) => {
      const blocks = dateTimeToRecallBlocks(targetDate, syncHeight);
      onAction({ id: SendFlowActionId.SetFormValues, payload: { recallBlocks: String(blocks) } });
    },
    [onAction, syncHeight]
  );

  const applyDateTimeSelection = useCallback(
    (date: Date, time: string) => {
      const [hours, minutes] = time.split(':').map(Number);
      const dateWithTime = new Date(date);
      dateWithTime.setHours(hours ?? 0, minutes ?? 0, 0, 0);
      onRecallDateChange(date);
      onRecallTimeChange(time);
      computeAndSetRecallBlocks(dateWithTime);
      setShowCalendar(false);
    },
    [computeAndSetRecallBlocks, onRecallDateChange, onRecallTimeChange, setShowCalendar]
  );
  return (
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
              className="ml-auto bg-input-bg rounded-[10px] px-3 py-2 text-sm text-heading-gray outline-none font-medium [&::-webkit-calendar-picker-indicator]:cursor-pointer"
            />
          </div>

          {/* Confirm button */}
          {recallDate && (
            <button
              type="button"
              className="w-full mt-3 py-2.5 rounded-[10px] bg-primary-500 text-pure-white text-sm font-medium cursor-pointer"
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
                className="flex-1 min-w-[30%] text-xs py-2 px-2 rounded-[10px] border border-border-card text-heading-gray hover:bg-input-bg transition-colors cursor-pointer"
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
  );
};

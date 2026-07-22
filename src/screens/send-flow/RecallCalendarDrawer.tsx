import React, { useCallback, useState } from 'react';

import { addDays, addHours, addMinutes, differenceInSeconds, format } from 'date-fns';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Calendar } from 'lib/ui/calendar';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

export const SECONDS_PER_BLOCK = 3;

/**
 * Number of blocks from *now* until the given target date — a RELATIVE offset,
 * not an absolute height. The SDK interface (`sendTransaction`) turns this into
 * the note's absolute P2IDE reclaim height by adding the current sync height:
 * `reclaimAfter = sync.blockNum() + offset`. Keeping this relative means the
 * current height is added in exactly one place (see the note on
 * `SendTransaction.extraInputs.recallBlocks`). Returns 0 for a past/now target.
 */
export function dateTimeToRecallBlocks(targetDate: Date): number {
  const secondsUntilTarget = differenceInSeconds(targetDate, new Date());
  if (secondsUntilTarget <= 0) return 0;
  return Math.floor(secondsUntilTarget / SECONDS_PER_BLOCK);
}

const RECALL_PRESETS = (t: (key: string) => string) => [
  { label: t('30mins'), fn: (d: Date) => addMinutes(d, 30) },
  { label: t('1hour'), fn: (d: Date) => addHours(d, 1) },
  { label: t('5hours'), fn: (d: Date) => addHours(d, 5) },
  { label: t('tomorrow'), fn: (d: Date) => addDays(d, 1) },
  { label: t('inAWeek'), fn: (d: Date) => addDays(d, 7) },
  { label: t('in2Weeks'), fn: (d: Date) => addDays(d, 14) }
];

export interface RecallCalendarDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recallDate?: Date;
  recallTime: string;
  onRecallBlocksChange: (blocks: string) => void;
  onRecallDateChange: (date: Date | undefined) => void;
  onRecallTimeChange: (time: string) => void;
}

/**
 * Calendar + preset picker for the send "Expiration Date" (reclaim height).
 * Self-contained: converts the chosen date/time into a RELATIVE `recallBlocks`
 * offset via `onRecallBlocksChange`. The current chain height is added later,
 * once, by the SDK interface. Extracted from the old SendDetails screen so the
 * Review page can reuse it.
 */
export const RecallCalendarDrawer: React.FC<RecallCalendarDrawerProps> = ({
  open,
  onOpenChange,
  recallDate,
  recallTime,
  onRecallBlocksChange,
  onRecallDateChange,
  onRecallTimeChange
}) => {
  const { t } = useTranslation();
  const [calendarMonth, setCalendarMonth] = useState<Date>(
    new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  );

  const applyDateTimeSelection = useCallback(
    (date: Date, time: string) => {
      const [hours, minutes] = time.split(':').map(Number);
      const dateWithTime = new Date(date);
      dateWithTime.setHours(hours ?? 0, minutes ?? 0, 0, 0);
      onRecallDateChange(date);
      onRecallTimeChange(time);
      onRecallBlocksChange(String(dateTimeToRecallBlocks(dateWithTime)));
      onOpenChange(false);
    },
    [onRecallBlocksChange, onOpenChange, onRecallDateChange, onRecallTimeChange]
  );

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('expirationDate')}</DrawerTitle>
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

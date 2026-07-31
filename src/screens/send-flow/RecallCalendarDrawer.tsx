import React, { useCallback, useEffect, useState } from 'react';

import clsx from 'clsx';
import { addDays, addHours, addMinutes, differenceInSeconds, format } from 'date-fns';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Calendar } from 'lib/ui/calendar';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

export const SECONDS_PER_BLOCK = 3;

/**
 * Blocks-until-recall (RELATIVE offset) for the given target date. The
 * SDK-interface layer (`sendTransaction`) converts this to an absolute
 * reclaim height by adding the current sync height — the single place that
 * addition happens. Never return an absolute height here: that double-adds
 * the chain height into the on-chain P2IDE reclaim input (#308).
 * A past/now target maps to 1 so the note stays recallable immediately
 * (0 would read as "no recall" downstream).
 */
export function dateTimeToRecallBlocks(targetDate: Date): number {
  const secondsUntilTarget = differenceInSeconds(targetDate, new Date());
  if (secondsUntilTarget <= 0) return 1;
  return Math.max(1, Math.floor(secondsUntilTarget / SECONDS_PER_BLOCK));
}

/**
 * The full expiration instant: the calendar date with the 'HH:mm' time-input
 * value applied. The drawer keeps date and time as separate pieces of state,
 * so every consumer (blocks computation, review-row label, past-time
 * validation) must combine them through this ONE helper — formatting the bare
 * date alone renders midnight, not the chosen time.
 */
export function combineDateAndTime(date: Date, time: string): Date {
  const [hours, minutes] = time.split(':').map(Number);
  const dateWithTime = new Date(date);
  dateWithTime.setHours(hours ?? 0, minutes ?? 0, 0, 0);
  return dateWithTime;
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
  /** Clear the reclaim height entirely — sends a plain P2ID note (no recall window). */
  onRecallNever: () => void;
}

/**
 * Calendar + preset picker for the send "Expiration Date" (reclaim height).
 * Converts the chosen date/time into a relative `recallBlocks` offset via
 * `onRecallBlocksChange` — no chain access needed. Extracted from the old
 * SendDetails screen so the Review page can reuse it.
 */
export const RecallCalendarDrawer: React.FC<RecallCalendarDrawerProps> = ({
  open,
  onOpenChange,
  recallDate,
  recallTime,
  onRecallBlocksChange,
  onRecallDateChange,
  onRecallTimeChange,
  onRecallNever
}) => {
  const { t } = useTranslation();
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => {
    const anchor = recallDate ?? new Date();
    return new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  });

  // Re-anchor the visible month to the selected date each time the drawer
  // opens: the mount-time initializer can run before the parent seeds the
  // default 7-day date, and near month-end that default lives in the NEXT
  // month — opening on the current month would hide the selected day.
  useEffect(() => {
    if (!open || !recallDate) return;
    setCalendarMonth(new Date(recallDate.getFullYear(), recallDate.getMonth(), 1));
  }, [open, recallDate]);

  // Time ticks while the drawer is open so a selection that WAS in the future
  // when typed goes red the moment the clock passes it (15s granularity is
  // plenty for an expiration picker).
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!open) return;
    setNow(new Date());
    const interval = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(interval);
  }, [open]);

  // The native time input happily accepts a time earlier than now for today's
  // date — that selection is invalid (the note would be recallable instantly),
  // so it renders red and blocks both Confirm and dismissal until fixed.
  const selectionInPast = !!recallDate && combineDateAndTime(recallDate, recallTime) <= now;

  const applyDateTimeSelection = useCallback(
    (date: Date, time: string) => {
      const dateWithTime = combineDateAndTime(date, time);
      if (dateWithTime <= new Date()) return;
      onRecallDateChange(date);
      onRecallTimeChange(time);
      onRecallBlocksChange(String(dateTimeToRecallBlocks(dateWithTime)));
      onOpenChange(false);
    },
    [onRecallBlocksChange, onOpenChange, onRecallDateChange, onRecallTimeChange]
  );

  return (
    <Drawer
      open={open}
      onOpenChange={next => {
        // A past-time selection must be corrected before the drawer can close
        // (swipe-down / backdrop included) — otherwise the stale valid
        // recallBlocks silently disagrees with the red time shown.
        if (!next && selectionInPast) return;
        onOpenChange(next);
      }}
    >
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
                // Keep recallBlocks in lockstep with the date so the review row's
                // label/note can never disagree with what is actually sent — even
                // if the drawer is dismissed without pressing Confirm.
                onRecallBlocksChange(String(dateTimeToRecallBlocks(combineDateAndTime(date, recallTime))));
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
              data-testid="recall-time-input"
              value={recallTime}
              onChange={e => {
                onRecallTimeChange(e.target.value);
                // Keep recallBlocks in lockstep with the time too (see onSelect).
                if (recallDate) {
                  onRecallBlocksChange(String(dateTimeToRecallBlocks(combineDateAndTime(recallDate, e.target.value))));
                }
              }}
              className={clsx(
                'ml-auto bg-input-bg rounded-[10px] px-3 py-2 text-sm outline-none font-medium [&::-webkit-calendar-picker-indicator]:cursor-pointer',
                selectionInPast ? 'text-red-500' : 'text-heading-gray'
              )}
            />
          </div>
          {selectionInPast && <p className="w-full mt-2 text-xs text-red-500">{t('recallTimeInPast')}</p>}

          {/* Confirm button */}
          {recallDate && (
            <button
              type="button"
              disabled={selectionInPast}
              className={clsx(
                'w-full mt-3 py-2.5 rounded-[10px] bg-primary-500 text-pure-white text-sm font-medium',
                selectionInPast ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
              )}
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

          {/* No expiration — clears the reclaim height so the send goes out as a
              plain P2ID note (recipient keeps it; the sender has no recall window). */}
          <button
            type="button"
            className="w-full mt-2 py-2.5 rounded-[10px] border border-border-card text-heading-gray text-sm font-medium hover:bg-input-bg transition-colors cursor-pointer"
            onClick={() => {
              onRecallNever();
              onOpenChange(false);
            }}
          >
            {t('never')}
          </button>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

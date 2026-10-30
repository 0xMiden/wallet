interface HoldDeadlineOptions {
  /** The wallet's locale, in its own `en_GB` form or as a BCP 47 tag. */
  locale?: string;
  timeZone?: string;
  nowMs?: number;
}

const format = (at: number, locale: string | undefined, options: Intl.DateTimeFormatOptions): string => {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZoneName: 'shortOffset' }).format(at);
  } catch (error) {
    // iOS 15, which the app still targets, predates 'shortOffset'.
    if (!(error instanceof RangeError)) throw error;
    return new Intl.DateTimeFormat(locale, { ...options, timeZoneName: 'short' }).format(at);
  }
};

const calendarDay = (at: number, timeZone: string | undefined): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(at);

/**
 * When a Guardian hold clears (#2060), in the wallet's locale and with its UTC offset, so the time still means one
 * instant once it is repeated to someone in another zone. The date appears only when the deadline is not today.
 * Callers pass the wallet's locale (`getCurrentLocale`), so the log line can stay in English.
 */
export const formatHoldDeadline = (
  clearsAtSec: number,
  { locale, timeZone, nowMs = Date.now() }: HoldDeadlineOptions = {}
): string => {
  const at = clearsAtSec * 1000;
  return format(at, locale?.replace('_', '-'), {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    ...(calendarDay(at, timeZone) === calendarDay(nowMs, timeZone) ? {} : { month: 'short', day: 'numeric' })
  });
};

/** Whole seconds until `clearsAtSec`, rounded up, so a hold that has not cleared never reads as zero. */
export const holdSecondsLeft = (clearsAtSec: number, nowMs: number): number =>
  Math.ceil((clearsAtSec * 1000 - nowMs) / 1000);

/** `mm:ss`, whose minutes run past 59 rather than wrap. */
export const formatHoldCountdown = (secondsLeft: number): string =>
  [Math.floor(secondsLeft / 60), secondsLeft % 60].map(part => String(part).padStart(2, '0')).join(':');

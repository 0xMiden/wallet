/**
 * The swap order's expiry, as a number plus a unit.
 *
 * WHAT EXPIRY ACTUALLY IS HERE. `expirySeconds` never reaches the SDK: `swapTransaction`
 * builds the PSWAP note from the two faucets and amounts alone, so the protocol enforces no
 * deadline of its own. What the number does is stamp `extraInputs.expiresAt` at completion
 * (`transaction/complete.ts`), which is the moment `reconcileSwapOrderNotes`
 * (`lib/miden/swap/settlement.ts`) stops waiting for a fill and reclaims the offered tip back
 * into the wallet. So the bounds below are the wallet's own, not the chain's — there is no
 * protocol maximum to read off.
 *
 * MINIMUM — 30 seconds. Below that the order can expire before the settlement tick has had a
 * chance to see a fill at all, so the reclaim would race the solver that is filling it; the
 * pair's own "usually fills in" estimate is tens of seconds at best.
 *
 * MAXIMUM — 7 days. Until it expires the offered asset sits in a public note that any solver
 * may fill at the rate quoted when it was placed, so the cap is really "how long is it
 * reasonable to leave a stale quote standing". A week is a round, conservative answer that
 * still covers leaving an order out over a holiday; it is a product choice, not a chain limit,
 * and it can be raised without touching anything downstream.
 */

export type ExpiryUnit = 'seconds' | 'minutes' | 'hours' | 'days';

export const EXPIRY_UNITS: readonly ExpiryUnit[] = ['seconds', 'minutes', 'hours', 'days'];

/** How many seconds one of each unit is. Seconds stay the stored unit throughout. */
export const EXPIRY_UNIT_SECONDS: Record<ExpiryUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 60 * 60,
  days: 24 * 60 * 60
};

export const MIN_EXPIRY_SECONDS = 30;
export const MAX_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

/** The i18n key for each unit's label, so the picker never hand-builds one. */
export const EXPIRY_UNIT_LABEL_KEYS: Record<ExpiryUnit, string> = {
  seconds: 'durationUnitSeconds',
  minutes: 'durationUnitMinutes',
  hours: 'durationUnitHours',
  days: 'durationUnitDays'
};

export interface ExpiryBounds {
  min: number;
  max: number;
}

/**
 * The whole-number range this unit may be typed in, derived from the one pair of second
 * bounds so the two can never disagree. A minimum always rounds UP and a maximum always
 * rounds DOWN, so every accepted value is inside the real range; the minimum is at least 1,
 * since a unit whose whole step is coarser than `MIN_EXPIRY_SECONDS` (days) would otherwise
 * offer a floor of zero.
 */
export const expiryBounds = (unit: ExpiryUnit): ExpiryBounds => {
  const step = EXPIRY_UNIT_SECONDS[unit];
  return {
    min: Math.max(1, Math.ceil(MIN_EXPIRY_SECONDS / step)),
    max: Math.floor(MAX_EXPIRY_SECONDS / step)
  };
};

/** Whole units, rounded to the nearest one and then clamped into that unit's range. */
export const secondsToUnitValue = (seconds: number, unit: ExpiryUnit): number => {
  const { min, max } = expiryBounds(unit);
  if (!Number.isFinite(seconds)) return min;
  return Math.min(max, Math.max(min, Math.round(seconds / EXPIRY_UNIT_SECONDS[unit])));
};

/** Back to the stored unit. Always a whole number of seconds, since the value is a whole unit. */
export const unitValueToSeconds = (value: number, unit: ExpiryUnit): number =>
  Math.round(value) * EXPIRY_UNIT_SECONDS[unit];

/**
 * The coarsest unit this many seconds divides into exactly — so a restored 120 reopens as
 * "2 Minutes" rather than "120 Seconds", and an unroundable value keeps its seconds rather
 * than being silently rewritten on the way in.
 */
export const bestUnitForSeconds = (seconds: number): ExpiryUnit => {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'seconds';
  for (const unit of [...EXPIRY_UNITS].reverse()) {
    const step = EXPIRY_UNIT_SECONDS[unit];
    if (seconds % step === 0 && seconds / step >= expiryBounds(unit).min) return unit;
  }
  return 'seconds';
};

/** Is this a value the flow may submit? Whole seconds, inside the wallet's own range. */
export const isValidExpirySeconds = (seconds: number): boolean =>
  Number.isInteger(seconds) && seconds >= MIN_EXPIRY_SECONDS && seconds <= MAX_EXPIRY_SECONDS;

/** Pull any number back inside the range, for a unit switch that would otherwise leave it outside. */
export const clampExpirySeconds = (seconds: number): number => {
  if (!Number.isFinite(seconds)) return MIN_EXPIRY_SECONDS;
  return Math.min(MAX_EXPIRY_SECONDS, Math.max(MIN_EXPIRY_SECONDS, Math.round(seconds)));
};

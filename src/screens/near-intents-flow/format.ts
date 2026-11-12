import BigNumber from 'bignumber.js';

import { formatUsd, toLocalFormat } from 'lib/i18n/numbers';

/** A 1Click USD string (for example "45.99") as a display value, or undefined when it is not a number. */
export function formatQuoteUsd(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? formatUsd(parsed) : undefined;
}

/** How much of the output one unit of the input gives, to six decimals, or undefined for a zero input. */
export function formatRate(amountIn: string, amountOut: string): string | undefined {
  const input = new BigNumber(amountIn);
  const output = new BigNumber(amountOut);
  if (!input.isFinite() || !output.isFinite() || input.lte(0)) return undefined;
  return toLocalFormat(output.div(input).decimalPlaces(6, BigNumber.ROUND_DOWN), {});
}

/** The 1Click time estimate, in seconds, as whole minutes. The minimum is one minute. */
export function arrivalMinutes(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.max(1, Math.ceil(seconds / 60));
}

/** The time that is left, as "m:ss", or "h:mm:ss" from one hour. Zero for a time in the past. */
export function formatCountdown(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

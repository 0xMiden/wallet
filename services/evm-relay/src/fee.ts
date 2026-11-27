// The fee rule of `deduct` mode, in integers only. The fee of a batch is its gas cost in the native coin, priced in the
// fee token:
//
//   cost = gas × maxFeePerGas                                   (wei)
//   fee  = cost × price(native in USD) ÷ price(token in USD)    (token base units, rounded up)
//
// A price arrives as decimal text. The Worker reads it as an integer and a power of ten (`Decimal`), and keeps the fee
// as one exact fraction until the last step, which rounds up. No step multiplies a token amount by a float.

/** The quote is the fee plus this percentage, rounded up: the gas price can go up between the quote and the relay. */
export const QUOTE_MARGIN_PERCENT = 15n;
/**
 * The relay route accepts a signed fee down to the fee of its own estimate minus this percentage. The estimates of the
 * quote and of the relay are not the same number (see quote-gas.ts), and this tolerance absorbs the difference.
 */
export const FEE_TOLERANCE_PERCENT = 5n;
/** A quote is valid for this many seconds after the Worker makes it. */
export const QUOTE_VALID_SECONDS = 120;
/** The decimals of the native coin of every served chain. */
export const NATIVE_DECIMALS = 18;
/** The most decimals that the Worker takes from a token's `decimals()`. */
export const MAX_TOKEN_DECIMALS = 36;

/** A positive decimal number: `units / 10^scale`. */
export interface Decimal {
  units: bigint;
  scale: number;
}

/** The price 1, of a USD stablecoin. */
export const ONE: Decimal = { units: 1n, scale: 0 };

/**
 * Plain decimal text of at most 30 integer digits and at most 18 fraction digits. No sign, no exponent, no spaces.
 * A leading zero is allowed only before the point, so "0.5" passes and "007" does not.
 */
const DECIMAL_TEXT = /^(0|[1-9][0-9]{0,29})(?:\.([0-9]{1,18}))?$/;

/** Read a price. Null when the text is not a positive finite decimal of the accepted form. */
export function parseDecimal(text: unknown): Decimal | null {
  if (typeof text !== 'string') return null;
  const match = DECIMAL_TEXT.exec(text);
  if (match === null) return null;
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  const units = BigInt(`${whole}${fraction}`);
  if (units === 0n) return null;
  return { units, scale: fraction.length };
}

/** The decimal text of a price, as the cache stores it. `parseDecimal` reads it back to the same value. */
export function formatDecimal({ units, scale }: Decimal): string {
  if (scale === 0) return units.toString();
  const digits = units.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** An exact fraction of token base units. `denominator` is above 0. */
export interface Fraction {
  numerator: bigint;
  denominator: bigint;
}

export interface FeeInput {
  gas: bigint;
  maxFeePerGas: bigint;
  /** The price of the native coin in USD. Not read when the fee token is the native coin. */
  nativePrice: Decimal;
  /** The price of the fee token in USD. Not read when the fee token is the native coin. */
  tokenPrice: Decimal;
  /** The decimals of the fee token. */
  tokenDecimals: number;
  /** True when the fee token is the native coin: then the fee is the cost in wei. */
  native: boolean;
}

/**
 * The exact fee, before rounding:
 *   gas × maxFeePerGas × nativeUnits × 10^tokenScale × 10^tokenDecimals
 *   ÷ (10^18 × 10^nativeScale × tokenUnits)
 */
export function exactFee(input: FeeInput): Fraction {
  const cost = input.gas * input.maxFeePerGas;
  if (input.native) return { numerator: cost, denominator: 1n };
  const { nativePrice, tokenPrice } = input;
  return {
    numerator: cost * nativePrice.units * 10n ** BigInt(tokenPrice.scale + input.tokenDecimals),
    denominator: 10n ** BigInt(NATIVE_DECIMALS + nativePrice.scale) * tokenPrice.units
  };
}

/** `⌈fraction × percent / 100⌉`. */
function scaledUp({ numerator, denominator }: Fraction, percent: bigint): bigint {
  const top = numerator * percent;
  const bottom = denominator * 100n;
  return (top + bottom - 1n) / bottom;
}

/**
 * The fee that the Worker quotes: the exact fee plus QUOTE_MARGIN_PERCENT, rounded up once, and at least 1 base unit,
 * because a fee call of 0 is not a fee call (`readFeeCall`).
 */
export function quotedFee(fee: Fraction): bigint {
  const quoted = scaledUp(fee, 100n + QUOTE_MARGIN_PERCENT);
  return quoted > 0n ? quoted : 1n;
}

/** The lowest fee that the relay route accepts: the exact fee minus FEE_TOLERANCE_PERCENT, rounded up, at least 1. */
export function minimumFee(fee: Fraction): bigint {
  const minimum = scaledUp(fee, 100n - FEE_TOLERANCE_PERCENT);
  return minimum > 0n ? minimum : 1n;
}

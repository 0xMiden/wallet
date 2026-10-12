/**
 * What the wallet reads from a 0xMiden faucet reply: the amount to ask for and what a refusal names. It imports
 * nothing, so a Node process such as the E2E faucet helper can load it without the SDK.
 */

// 10^19 is the largest power of ten a u64 base-unit amount holds; the faucet refuses more decimals at startup.
const MAX_DECIMALS = 19;

const field = (record: unknown, name: string): unknown =>
  record !== null && typeof record === 'object' ? Reflect.get(record, name) : undefined;

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * Base units to ask for: the largest whole-token amount the faucet offers (`token_amounts`, 0.17.1 on, each checked
 * against its cap at startup) at its `decimals`, else `base_amount`, which sets only the proof-of-work difficulty
 * and is within the cap by the operator's choice alone.
 */
export function faucetGrantAmount(metadata: unknown): bigint {
  const tokens = field(metadata, 'token_amounts');
  const decimals = field(metadata, 'decimals');
  if (
    Array.isArray(tokens) &&
    tokens.length > 0 &&
    tokens.every(isPositiveSafeInteger) &&
    typeof decimals === 'number' &&
    Number.isInteger(decimals) &&
    decimals >= 0 &&
    decimals <= MAX_DECIMALS
  ) {
    return BigInt(Math.max(...tokens)) * 10n ** BigInt(decimals);
  }
  const baseAmount = field(metadata, 'base_amount');
  if (isPositiveSafeInteger(baseAmount)) return BigInt(baseAmount);
  throw new Error('Faucet metadata base_amount must be a positive safe integer');
}

/** The cap, in base units, that an over-cap refusal names ("maximum claimable amount of M"), or null. */
export function faucetCapFromRefusal(detail: string): bigint | null {
  const cap = /maximum claimable amount of (\d+)/.exec(detail)?.[1];
  return cap === undefined ? null : BigInt(cap);
}

/** The wait a rate-limit refusal names ("rate limited for N more seconds"), or null. */
export function faucetRateLimitSeconds(detail: string): number | null {
  const seconds = /(\d+)\s+more\s+seconds?/i.exec(detail)?.[1];
  if (seconds === undefined) return null;
  const value = Number(seconds);
  return Number.isSafeInteger(value) ? value : null;
}

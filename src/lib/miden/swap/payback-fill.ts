import type { PswapLineageDto } from 'lib/miden/sdk/pswap-lineage';

const LINEAGE_RECLAIMED = 2;

const parseAmount = (value: bigint | string): bigint | undefined => {
  if (typeof value === 'bigint') return value;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
};

/**
 * What the order's lineage says was filled: the ask minus what is still requested.
 * A reclaim zeroes both remainders, so it no longer says anything and yields undefined,
 * as does a remainder above the ask or one that does not parse.
 */
export function lineageFilledAmount(
  requestedAmount: bigint | string,
  lineage: Pick<PswapLineageDto, 'state' | 'remainingRequested'>
): bigint | undefined {
  if (lineage.state === LINEAGE_RECLAIMED) return undefined;
  const requested = parseAmount(requestedAmount);
  const remaining = parseAmount(lineage.remainingRequested);
  if (requested === undefined || remaining === undefined) return undefined;
  if (remaining < 0n || remaining > requested) return undefined;
  return requested - remaining;
}

/**
 * Whether the rounds already held plus the rounds claimable now pay at least the filled amount.
 * Each round counts once: a held round by the amount its claim recorded, any other by its
 * claimable amount. "At least" because the last fill may pay more than was left.
 */
export function paybacksCoverFill(
  filled: bigint | undefined,
  heldAmounts: ReadonlyMap<number, bigint>,
  claimableAmounts: ReadonlyMap<number, bigint>
): boolean {
  if (filled === undefined || filled <= 0n) return false;
  let total = 0n;
  for (const held of heldAmounts.values()) total += held;
  for (const [round, amount] of claimableAmounts) {
    if (!heldAmounts.has(round)) total += amount;
  }
  return total >= filled;
}

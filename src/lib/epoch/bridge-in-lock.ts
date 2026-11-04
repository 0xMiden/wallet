import type { EpochIntentSDK } from '@epoch-protocol/epoch-intents-sdk';
import { isAddress } from 'viem';

import type { IBridgedReceivePhase, IEpochLockedDeposit } from 'lib/miden/db/types';

/** The balance of one Compact resource lock, in base units. */
export interface CompactLockBalance {
  lockId: string;
  balance: bigint;
}

/**
 * Read the sponsor's balance in the Compact lock of `tokenAddress`. Return undefined when the SDK cannot read it: the
 * read only helps to find a stranded deposit, so it must never stop a bridge.
 */
export async function readCompactLockBalance(
  sdk: Partial<Pick<EpochIntentSDK, 'getDepositedBalances'>>,
  sponsorAddress: string,
  tokenAddress: string
): Promise<CompactLockBalance | undefined> {
  if (sdk.getDepositedBalances === undefined || !isAddress(tokenAddress)) return undefined;
  try {
    // The SDK formats the balance with these decimals. Zero decimals give the base units without change.
    const [row] = await sdk.getDepositedBalances(sponsorAddress, [{ address: tokenAddress, symbol: '', decimals: 0 }]);
    if (row === undefined || !/^[0-9]+$/.test(row.balance) || !/^[0-9]+$/.test(row.depositId)) return undefined;
    return { lockId: row.depositId, balance: BigInt(row.balance) };
  } catch (err) {
    console.warn('[epoch] Compact lock balance read failed', err);
    return undefined;
  }
}

function baseUnits(value: string | undefined): bigint | undefined {
  if (value === undefined || !/^[0-9]+$/.test(value)) return undefined;
  return BigInt(value);
}

/**
 * The base units that a failed solve left in the lock, or undefined when no deposit landed.
 *
 * With a balance from before the solve, the increase is the deposit. Without one, only a lock that holds at least the
 * quoted deposit counts, and the quoted amount is the deposit.
 */
export function strandedDepositAmount(
  before: CompactLockBalance | undefined,
  after: CompactLockBalance | undefined,
  quotedAmount: string | undefined
): bigint | undefined {
  if (after === undefined) return undefined;
  if (before !== undefined) {
    if (before.lockId !== after.lockId) return undefined;
    const added = after.balance - before.balance;
    return added > 0n ? added : undefined;
  }
  const quoted = baseUnits(quotedAmount);
  if (quoted === undefined || quoted <= 0n || after.balance < quoted) return undefined;
  return quoted;
}

/** What a row with a locked Epoch deposit shows. `undefined`: the row is a normal bridge-in. */
export type EpochLockedDepositState = 'locked' | 'withdrawn';

/**
 * The state of a locked Epoch deposit. A row restored from a backup has no state: its contents come from the file,
 * so the wallet never acts on them.
 */
export function epochLockedDepositState(
  lock: IEpochLockedDeposit | undefined,
  phase: IBridgedReceivePhase | undefined,
  restoredFromBackup: boolean
): EpochLockedDepositState | undefined {
  if (lock === undefined || restoredFromBackup) return undefined;
  if (lock.withdrawnAt !== undefined) return 'withdrawn';
  if (phase === 'failed' && lock.reallocatedAt === undefined) return 'locked';
  return undefined;
}

/** Seconds until the forced withdrawal is due, never below zero. */
export function secondsUntilWithdrawable(withdrawableAt: number, nowSec: number): number {
  return Math.max(0, Math.ceil(withdrawableAt - nowSec));
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);

const twoDigits = (value: number): string => String(value).padStart(2, '0');

/** A countdown as `m:ss`, or `h:mm:ss` from one hour. */
export function formatWithdrawCountdown(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours > 0 ? `${hours}:${twoDigits(minutes)}:${twoDigits(rest)}` : `${minutes}:${twoDigits(rest)}`;
}

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

/** The lock of one sponsor on one chain. */
export interface CompactLockRef {
  sponsorAddress: string;
  chainId: number;
  /** The lock id, as a decimal string. */
  lockId: string;
}

/**
 * A forced withdrawal that this wallet started on a lock with no locked history row to hold it. The Settings page
 * shows its countdown from this record when The Compact does not answer.
 */
export interface ForcedWithdrawalRecord {
  /** Unix seconds at which this wallet enabled the forced withdrawal. */
  enabledAt: number;
  /** Unix seconds from which The Compact lets the sponsor withdraw. */
  withdrawableAt?: number;
}

const forcedWithdrawalKey = (ref: CompactLockRef): string =>
  `epoch_forced_withdrawal_v1:${ref.chainId}:${ref.lockId}:${ref.sponsorAddress.toLowerCase()}`;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** The record of `ref`, or undefined when there is none or it does not read back. */
export async function readForcedWithdrawalRecord(ref: CompactLockRef): Promise<ForcedWithdrawalRecord | undefined> {
  const stored = await fetchFromStorage<unknown>(forcedWithdrawalKey(ref));
  if (typeof stored !== 'object' || stored === null) return undefined;
  const enabledAt = finiteNumber(Reflect.get(stored, 'enabledAt'));
  if (enabledAt === undefined) return undefined;
  return { enabledAt, withdrawableAt: finiteNumber(Reflect.get(stored, 'withdrawableAt')) };
}

export async function writeForcedWithdrawalRecord(ref: CompactLockRef, record: ForcedWithdrawalRecord): Promise<void> {
  await putToStorage(forcedWithdrawalKey(ref), record);
}

/** Remove the record of `ref`: the withdrawal finished or was cancelled. */
export async function clearForcedWithdrawalRecord(ref: CompactLockRef): Promise<void> {
  await putToStorage(forcedWithdrawalKey(ref), null);
}

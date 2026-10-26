import type { RecoveryRetirementReads } from './retirement';
import type { RecoveryNullifierScan } from './types';

export async function scanRecoveryNullifier(
  nullifier: string,
  fromBlock: number,
  previous: RecoveryNullifierScan | undefined,
  reads: Pick<RecoveryRetirementReads, 'header' | 'scan'>,
  check: () => void
): Promise<RecoveryNullifierScan | undefined> {
  check();
  if (previous) {
    const anchor = await reads.header(previous.anchorBlock);
    check();
    if (anchor !== previous.anchor) return undefined;
    if (previous.height !== undefined) return previous;
  }
  const block = Math.max(fromBlock, previous?.nextBlock ?? 0);
  if (!Number.isSafeInteger(block) || block < 0 || block >= 0xffffffff) return undefined;
  const before = await reads.header(block);
  check();
  if (!before) return undefined;
  const updates = await reads.scan(nullifier, block);
  check();
  if (updates.some(update => update.block !== block || !Number.isSafeInteger(update.block))) return undefined;
  const after = await reads.header(block);
  check();
  if (before !== after) return undefined;
  return {
    nullifier,
    nextBlock: block + 1,
    anchorBlock: block,
    anchor: before,
    ...(updates.some(update => update.nullifier === nullifier) ? { height: block } : {})
  };
}

// The rotation rows this device left Failed without a committed verdict (#1233), for the sync loop's
// cold heal: once the chain-verified signer set names a row's new hot key, the heal swaps to it and
// completes the row.

import * as Repo from 'lib/miden/repo';

import { ITransactionStatus, type ITransaction } from '../db/types';
import { sameWalletAccountId } from '../sdk/helpers';

export interface FailedHotKeyRotation {
  id: string;
  newHotPublicKey: string;
}

const isFailedRotation = (tx: ITransaction): boolean =>
  tx.type === 'replace-hot-key' && tx.status === ITransactionStatus.Failed;

/** This account's Failed rotations that name a new key, newest first. A restored row is a record, never work. */
export async function findFailedHotKeyRotations(accountPublicKey: string): Promise<FailedHotKeyRotation[]> {
  const rows = await Repo.transactions
    .filter(
      tx =>
        isFailedRotation(tx) && tx.restoredFromBackup !== true && sameWalletAccountId(tx.accountId, accountPublicKey)
    )
    .toArray();
  const rotations: FailedHotKeyRotation[] = [];
  for (const row of rows.sort((a, b) => b.initiatedAt - a.initiatedAt)) {
    const newHotPublicKey: unknown = row.extraInputs?.newHotPublicKey;
    if (typeof newHotPublicKey === 'string') rotations.push({ id: row.id, newHotPublicKey });
  }
  return rotations;
}

/** Complete a rotation the heal finished, with what completion writes minus the result fields. */
export async function markRotationCompleted(rowId: string): Promise<void> {
  await Repo.transactions.where({ id: rowId }).modify(tx => {
    // `false`, not a bare return: Dexie reads `undefined` as modified and writes the unchanged row.
    if (!isFailedRotation(tx)) return false;
    tx.status = ITransactionStatus.Completed;
    tx.displayMessage = 'Everyday key rotated';
    // The rotation row's own icon; cancelling it wrote 'FAILED'.
    tx.displayIcon = 'DEFAULT';
    tx.completedAt = Math.floor(Date.now() / 1000);
    tx.stage = 'complete';
    delete tx.error;
    delete tx.rawError;
    return undefined;
  });
}

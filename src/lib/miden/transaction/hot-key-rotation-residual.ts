// The rotation rows this device left Failed without a committed verdict (#1233), for the sync loop's
// cold heal: once the chain-verified signer set names a row's new hot key, the heal swaps to it and
// completes the row. A node discard is a verdict: that row never lands, so it is a record, not work.

import { signalTransactionCompleted } from 'lib/backup/adopt-signal';
import * as Repo from 'lib/miden/repo';

import { isNodeDiscardedRow } from './constants';
import { type HotKeyActivationMode, ITransactionStatus, type ITransaction } from '../db/types';
import { sameWalletAccountId } from '../sdk/helpers';

export interface FailedHotKeyRotation {
  id: string;
  newHotPublicKey: string;
}

/** The history message of a landed rotation: an add keeps the other devices, a replace rotates them out. */
export const hotKeyActivationMessage = (mode: HotKeyActivationMode | undefined): string => {
  switch (mode) {
    case 'add':
      return 'Device added';
    default:
      return 'Everyday key rotated';
  }
};

const isFailedRotation = (tx: ITransaction): boolean =>
  tx.type === 'replace-hot-key' && tx.status === ITransactionStatus.Failed;

/** This account's Failed rotations that name a new key, newest first. A restored or discarded row is a record, never work. */
export async function findFailedHotKeyRotations(accountPublicKey: string): Promise<FailedHotKeyRotation[]> {
  const rows = await Repo.transactions
    .filter(
      tx =>
        isFailedRotation(tx) &&
        tx.restoredFromBackup !== true &&
        !isNodeDiscardedRow(tx) &&
        sameWalletAccountId(tx.accountId, accountPublicKey)
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
  const completed = await Repo.transactions.where({ id: rowId }).modify(tx => {
    // `false`, not a bare return: Dexie reads `undefined` as modified and writes the unchanged row.
    if (!isFailedRotation(tx)) return false;
    tx.status = ITransactionStatus.Completed;
    // The row records its mode, so a promoted add reads "Device added" like a landed one.
    const mode: unknown = tx.extraInputs?.mode;
    tx.displayMessage = hotKeyActivationMessage(mode === 'add' ? 'add' : undefined);
    // The rotation row's own icon; cancelling it wrote 'FAILED'.
    tx.displayIcon = 'DEFAULT';
    tx.completedAt = Math.floor(Date.now() / 1000);
    tx.stage = 'complete';
    delete tx.error;
    delete tx.rawError;
    return undefined;
  });
  // A Completed row goes to the encrypted backup at once, as a row the pipeline completes does.
  if (completed > 0) signalTransactionCompleted();
}

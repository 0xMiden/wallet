/**
 * A queued claim that another device of the same account made (multi-device).
 *
 * The other device has the transaction, so the claim on this device can only fail. Its row is removed and not
 * failed: a failed row shows "Transaction failed" with a Retry that fails again, for a note the account holds.
 * A removed row leaves the note with no claim on this device. While the note is still unspent, the claim list
 * offers it again; when the other claim lands, the sync takes the note out of the list.
 */
import { InputNoteState } from '@miden-sdk/miden-sdk/lazy';

import * as Repo from 'lib/miden/repo';
import { WASM_LOCK_SYNC_WATCHDOG_MS } from 'lib/miden/sdk/wasm-client-poison';
import type { ConsumeEntryPoint } from 'lib/telemetry/transaction-failure';

import { isUnresolvedEntry } from './verdict-rules';
import { midenClientProxy } from '../back/miden-client-proxy';
import { ITransaction, ITransactionStatus } from '../db/types';
import { assertWasmHoldCurrent, withWasmClientLock } from '../sdk/miden-client';

/**
 * How long a claim whose note the chain shows consumed waits for the Guardian's history to name the note
 * (`ITransaction.claimedElsewhereCheckUntil`). The Guardian makes a delta canonical some seconds after its
 * transaction lands.
 */
export const CLAIMED_ELSEWHERE_CHECK_SEC = 90;

/**
 * Which entry points queue a claim that may be removed. A Record over the union, so an entry point added later
 * does not compile until someone decides its side. A dApp waits for the result of its row. A bridge reclaim,
 * the rotation gate's claim and the Arcade purchase each read their own row after it ends.
 */
const REMOVABLE_ENTRY_POINT: Readonly<Record<ConsumeEntryPoint, boolean>> = {
  auto_consume: true,
  claim: true,
  claim_all: true,
  swap_settlement: true,
  dapp: false,
  bridge_reclaim: false,
  rotation_funding: false,
  arcade_gc_purchase: false
};

/** True for a claim row that may be removed. A row with no entry point is a claim, as the queue treats it. */
export function isRemovableClaim(
  row: Pick<ITransaction, 'type' | 'consumeEntryPoint' | 'rotationFunding' | 'restoredFromBackup'>
): boolean {
  if (row.type !== 'consume' || row.rotationFunding === true || row.restoredFromBackup === true) return false;
  return row.consumeEntryPoint === undefined || REMOVABLE_ENTRY_POINT[row.consumeEntryPoint];
}

/** The note ids a claim row consumes. */
export function claimNoteIdsOf(row: Pick<ITransaction, 'noteId' | 'noteIds'>): string[] {
  const noteIds = row.noteIds ?? [];
  if (noteIds.length > 0) return noteIds;
  return row.noteId ? [row.noteId] : [];
}

/**
 * The notes of `noteIds` that the local store records as consumed by a transaction this client did not make. That
 * state does not say who consumed the note: another device of the account, or the sender that took the note back.
 * The hold is bounded at the sync ceiling and labelled, like every read of this kind.
 */
export async function notesConsumedOutsideClient(noteIds: readonly string[]): Promise<string[]> {
  if (noteIds.length === 0) return [];
  const details = await withWasmClientLock(
    async hold =>
      midenClientProxy.getInputNoteDetails({ ids: [...noteIds] }, () =>
        assertWasmHoldCurrent(hold, 'while reading the notes of a claim made elsewhere')
      ),
    { label: 'claim-made-elsewhere-notes', watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS }
  );
  return details.filter(note => note.state === InputNoteState.ConsumedExternal).map(note => note.noteId);
}

/**
 * Remove the claim row `id` while attempt `attemptId` is still the one that runs it. Returns true when the row was
 * removed.
 *
 * A row that may have submitted is never removed: `mayHaveSubmitted`, or a submit record that is not proven dead.
 * The note of such a row can be consumed by this device's own transaction, and then the row is the receipt.
 */
export async function removeClaimMadeElsewhere(id: string, attemptId: string | undefined): Promise<boolean> {
  return Repo.db.transaction('rw', Repo.transactions, async () => {
    const row = await Repo.transactions.get(id);
    if (
      row === undefined ||
      !isRemovableClaim(row) ||
      row.status !== ITransactionStatus.GeneratingTransaction ||
      row.attemptId !== attemptId ||
      row.mayHaveSubmitted === true ||
      (row.submitEvidence ?? []).some(isUnresolvedEntry)
    ) {
      return false;
    }
    await Repo.transactions.delete(id);
    return true;
  });
}

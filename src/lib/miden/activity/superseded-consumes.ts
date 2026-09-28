import * as Repo from 'lib/miden/repo';

import { compareAccountIds } from './utils';
import { ITransaction, ITransactionStatus } from '../db/types';

const noteIdsOf = (tx: ITransaction): string[] => tx.noteIds ?? (tx.noteId ? [tx.noteId] : []);

/**
 * The Failed claim rows in `transactions` whose every note this account has claimed (#771). Failed rows are
 * never deleted, because the auto-consume backoff counts them, so without this a note the wallet now holds shows
 * one "Transaction failed" per earlier attempt. The evidence is read from the database rather than the batch, since
 * the successful claim can sit on another page, and it follows the claim dedup's rule: a Completed consume row of
 * the same account that was not restored from a backup.
 */
export async function supersededFailedConsumeIds(transactions: ITransaction[]): Promise<Set<string>> {
  const failed = transactions.filter(
    tx => tx.type === 'consume' && tx.status === ITransactionStatus.Failed && noteIdsOf(tx).length > 0
  );
  if (failed.length === 0) return new Set();
  const noteIds = [...new Set(failed.flatMap(noteIdsOf))];
  const [byScalar, byBatch] = await Promise.all([
    Repo.transactions.where('noteId').anyOf(noteIds).toArray(),
    Repo.transactions.where('noteIds').anyOf(noteIds).toArray()
  ]);
  const claims = [...byScalar, ...byBatch].filter(
    tx => tx.type === 'consume' && tx.status === ITransactionStatus.Completed && !tx.restoredFromBackup
  );
  const superseded = new Set<string>();
  for (const tx of failed) {
    const claimed = (noteId: string) =>
      claims.some(claim => compareAccountIds(claim.accountId, tx.accountId) && noteIdsOf(claim).includes(noteId));
    if (noteIdsOf(tx).every(claimed)) superseded.add(tx.id);
  }
  return superseded;
}

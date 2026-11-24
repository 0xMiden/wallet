import * as Repo from 'lib/miden/repo';

import { compareAccountIds } from './utils';
import { ITransaction, ITransactionStatus } from '../db/types';
import { isFailedClaim } from '../transaction/verdict-rules';

const noteIdsOf = (tx: ITransaction): string[] => tx.noteIds ?? (tx.noteId ? [tx.noteId] : []);

export type ClaimEvidenceLookup = (accountId: string, noteId: string) => Promise<boolean>;

export function createClaimEvidenceLookup(): ClaimEvidenceLookup {
  const accounts = new Map<string | null, Map<string, Promise<boolean>>>();
  return (accountId, noteId) => {
    const accountKey = accountId ? (accountId.split('_')[0] ?? accountId) : null;
    let notes = accounts.get(accountKey);
    if (!notes) {
      notes = new Map();
      accounts.set(accountKey, notes);
    }
    let claimed = notes.get(noteId);
    if (!claimed) {
      const isClaim = (tx: ITransaction) =>
        tx.type === 'consume' &&
        tx.status === ITransactionStatus.Completed &&
        !tx.restoredFromBackup &&
        compareAccountIds(tx.accountId, accountId) &&
        noteIdsOf(tx).includes(noteId);
      claimed = (async () => {
        if (!accountId) return false;
        if (Boolean(await Repo.transactions.where('noteId').equals(noteId).filter(isClaim).first())) return true;
        return Boolean(await Repo.transactions.where('noteIds').equals(noteId).filter(isClaim).first());
      })();
      notes.set(noteId, claimed);
    }
    return claimed;
  };
}

/**
 * The failed claims (`isFailedClaim`) in `transactions` whose every note this account has claimed (#771). Failed
 * rows are never deleted, because the auto-consume backoff counts them, so without this a note the wallet now holds
 * shows one "Transaction failed" per earlier attempt. The evidence is read from the database rather than the batch,
 * since the successful claim can sit on another page, and it follows the claim dedup's rule: a Completed consume row
 * of the same account that was not restored from a backup.
 */
export async function supersededFailedConsumeIds(
  transactions: ITransaction[],
  lookup: ClaimEvidenceLookup = createClaimEvidenceLookup()
): Promise<Set<string>> {
  const nowSec = Math.floor(Date.now() / 1000);
  // A failed claim is one whose notes a fresh claim may take, Unconfirmed or Failed (#1081); a claim that holds its
  // notes is never superseded.
  const superseded = new Set<string>();
  for (const tx of transactions) {
    if (!isFailedClaim(tx, nowSec)) continue;
    const noteIds = noteIdsOf(tx);
    if (noteIds.length === 0) continue;
    let claimed = true;
    for (const noteId of noteIds) {
      if (!(await lookup(tx.accountId, noteId))) {
        claimed = false;
        break;
      }
    }
    if (claimed) superseded.add(tx.id);
  }
  return superseded;
}

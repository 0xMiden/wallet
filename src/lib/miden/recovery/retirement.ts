import { recoveryNoteMaterials } from './note-candidates';
import { withRecoveryReadTurn } from './read-turn';
import { resolveRecoveryDebit } from './retry-transition';
import { validateRecoveryReceipt } from './transaction-record';
import type { RecoveryEntry, RecoveryJournalSnapshot, RecoveryNoteEntry, RecoveryTransactionEntry } from './types';
import { validateJournal } from './validation';
import { MAX_WINDOW_SECONDS } from '../spending-limits/window';

export interface RecoveryRetirementReads {
  identity: (
    note: RecoveryNoteEntry,
    family?: RecoveryNoteEntry
  ) => Promise<{ nullifier: string; fromBlock: number } | undefined>;
  header: (block: number) => Promise<string | undefined>;
  scan: (nullifier: string, block: number) => Promise<readonly { nullifier: string; block: number }[]>;
}
export interface RecoveryRetirementContext {
  snapshot: RecoveryJournalSnapshot;
  reads: RecoveryRetirementReads;
  deadline: number;
  assertCurrent: () => void;
  retain: (entries: RecoveryEntry[]) => Promise<void>;
}

export function selectRecoveryNoteFamilies(entries: readonly RecoveryEntry[]): RecoveryNoteEntry[] {
  return entries
    .filter((entry): entry is RecoveryNoteEntry => entry.kind === 'note')
    .filter(
      note =>
        !entries.some(
          entry =>
            entry.kind === 'transaction' &&
            !entry.resolved &&
            (note.accountId === undefined || entry.accountId === note.accountId)
        )
    )
    .sort((a, b) => (a.scan?.nextBlock ?? 0) - (b.scan?.nextBlock ?? 0))
    .slice(0, 4);
}
function canRetireTransaction(entry: RecoveryTransactionEntry, entries: RecoveryEntry[]): boolean {
  const row = entry.row;
  if (
    !row ||
    entry.resolved?.outcome !== 'landed' ||
    !entry.resolved.transactionId ||
    row.transactionId !== entry.resolved.transactionId ||
    row.noteType !== 'public' ||
    !row.inputNoteIds ||
    !row.outputNoteIds ||
    row.heldNoteIds?.length ||
    row.noteDelivery === 'pending' ||
    row.noteDelivery === 'undelivered' ||
    (row.restoredFromBackup && !row.restoredFromJournal)
  )
    return false;
  const debit = entries.find(
    value => value.kind === 'debit' && value.id === row.id && value.accountId === row.accountId
  );
  if (debit?.kind === 'debit' && debit.retry) return false;
  const charge = debit?.kind === 'debit' ? resolveRecoveryDebit(debit) : undefined;
  const cutoff = Math.floor(Date.now() / 1000) - MAX_WINDOW_SECONDS;
  if (
    (row.spentUsd !== undefined || row.spendingLimitAuthorizationId !== undefined || charge) &&
    (row.initiatedAt >= cutoff || (charge && charge.initiatedAt >= cutoff))
  ) {
    if (
      !charge ||
      charge.initiatedAt !== row.initiatedAt ||
      charge.spentUsd !== row.spentUsd ||
      charge.authorizationId !== row.spendingLimitAuthorizationId
    )
      return false;
  }
  if (row.type === 'consume')
    return row.outputNoteIds.length === 0 && Object.values(row.extraInputs ?? {}).every(value => value === undefined);
  if (row.type === 'send' && !row.extraInputs?.oneClick)
    return Object.values(row.extraInputs ?? {}).every(value => value === undefined);
  return (
    row.type === 'bridged-send' ||
    row.type === 'earn-deposit' ||
    (row.type === 'send' && Boolean(row.extraInputs?.oneClick))
  );
}

export async function retireRecoveryNotes(context: RecoveryRetirementContext): Promise<number> {
  const snapshot = validateJournal(context.snapshot);
  return (
    (await withRecoveryReadTurn(
      JSON.stringify(snapshot.scope),
      context.deadline,
      context.assertCurrent,
      async check => {
        let retired = 0;
        const entries = [...snapshot.entries];
        for (const entry of snapshot.entries) {
          check();
          if (entry.kind !== 'transaction' || !canRetireTransaction(entry, entries) || !entry.row) continue;
          const index = entries.indexOf(entry);
          if (
            entry.row.extraInputs?.oneClick ||
            entry.row.type === 'bridged-send' ||
            entry.row.type === 'earn-deposit'
          ) {
            const existing = entries.find(value => value.kind === 'receipt' && value.id === entry.id);
            if (!existing) {
              try {
                const row = validateRecoveryReceipt(entry.row);
                entries[index] = { kind: 'receipt', id: entry.id, accountId: entry.accountId, row };
              } catch {
                continue;
              }
            } else entries.splice(index, 1);
          } else entries.splice(index, 1);
          retired++;
        }
        const notes = selectRecoveryNoteFamilies(entries);
        for (const note of notes) {
          try {
            check();
            let identity: { nullifier: string; fromBlock: number } | undefined;
            for (const material of recoveryNoteMaterials(note)) {
              const candidate = await context.reads.identity({ ...material, kind: 'note' }, note);
              check();
              if (
                !candidate ||
                !candidate.nullifier ||
                !Number.isSafeInteger(candidate.fromBlock) ||
                candidate.fromBlock < 0 ||
                (identity && identity.nullifier !== candidate.nullifier)
              ) {
                identity = undefined;
                break;
              }
              identity = {
                nullifier: candidate.nullifier,
                fromBlock: Math.min(identity?.fromBlock ?? candidate.fromBlock, candidate.fromBlock)
              };
            }
            if (!identity) continue;
            if (note.scan) {
              const anchor = await context.reads.header(note.scan.anchorBlock);
              check();
              if (anchor !== note.scan.anchor) continue;
            }
            const block = Math.max(identity.fromBlock, note.scan?.nextBlock ?? 0);
            if (!Number.isSafeInteger(block) || block >= 0xffffffff) continue;
            const before = await context.reads.header(block);
            check();
            if (!before) continue;
            const updates = await context.reads.scan(identity.nullifier, block);
            check();
            if (updates.some(update => update.block !== block || !Number.isSafeInteger(update.block))) continue;
            const after = await context.reads.header(block);
            check();
            if (before !== after) continue;
            const index = entries.findIndex(entry => entry.kind === 'note' && entry.id === note.id);
            if (updates.some(update => update.nullifier === identity.nullifier)) {
              entries.splice(index, 1);
              retired++;
            } else entries[index] = { ...note, scan: { nextBlock: block + 1, anchorBlock: block, anchor: before } };
          } catch (error) {
            check();
          }
        }
        check();
        if (
          JSON.stringify(entries.map(entry => (entry.kind === 'note' ? entry.scan : null))) !==
            JSON.stringify(snapshot.entries.map(entry => (entry.kind === 'note' ? entry.scan : null))) ||
          retired > 0
        ) {
          await context.retain(entries);
          check();
        }
        return retired;
      }
    )) ?? 0
  );
}

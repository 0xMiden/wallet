import type { RecoveryEntry, RecoveryJournalSnapshot, RecoveryNoteEntry } from './types';
import { withRecoveryReadTurn } from './read-turn';
import { validateJournal } from './validation';

export interface RecoveryRetirementReads {
  identity: (note: RecoveryNoteEntry) => Promise<{ nullifier: string; fromBlock: number } | undefined>;
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
export async function retireRecoveryNotes(context: RecoveryRetirementContext): Promise<number> {
  const snapshot = validateJournal(context.snapshot);
  return (await withRecoveryReadTurn(JSON.stringify(snapshot.scope), context.deadline, context.assertCurrent, async check => {
    let retired = 0;
    const entries = [...snapshot.entries];
    const notes = entries.filter((entry): entry is RecoveryNoteEntry => entry.kind === 'note')
      .filter(note => !entries.some(entry => entry.kind === 'transaction' && !entry.resolved &&
        (note.accountId === undefined || entry.accountId === note.accountId)))
      .sort((a, b) => (a.scan?.nextBlock ?? 0) - (b.scan?.nextBlock ?? 0)).slice(0, 4);
    for (const note of notes) {
      try {
        check();
        const identity = await context.reads.identity(note);
        check();
        if (!identity || !identity.nullifier || !Number.isSafeInteger(identity.fromBlock) || identity.fromBlock < 0) continue;
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
      } catch (error) { check(); }
    }
    check();
    if (JSON.stringify(entries.map(entry => entry.kind === 'note' ? entry.scan : null)) !==
      JSON.stringify(snapshot.entries.map(entry => entry.kind === 'note' ? entry.scan : null)) || retired > 0) {
      await context.retain(entries);
      check();
    }
    return retired;
  })) ?? 0;
}

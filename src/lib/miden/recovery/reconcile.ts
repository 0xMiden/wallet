import type Dexie from 'dexie';

import { scanRecoveryNullifier } from './nullifier-scan';
import { withRecoveryReadTurn } from './read-turn';
import type { RecoveryRetirementReads } from './retirement';
import { toSerializable } from './serialization';
import type { RecoveryJournalSnapshot, RecoveryEntry, RecoveryTransactionEntry } from './types';
import { validateJournal } from './validation';
import { ITransactionStatus, type ITransaction, type ISubmitEvidence } from '../db/types';
import { canonicalWalletAccountId, sameWalletAccountId } from '../sdk/helpers';
import { judgeSubmitEvidence } from '../transaction/reconcile-judge';
import type { NodeReads } from '../transaction/reconcile-reads';
import { canAwaitVerdict, evidenceKey } from '../transaction/verdict-rules';

export interface RecoveryReconcileContext {
  snapshot: RecoveryJournalSnapshot;
  database: Dexie;
  node: NodeReads;
  deadline: number;
  assertCurrent: () => void;
  retain: (entries: RecoveryEntry[]) => Promise<void>;
  nullifiers?: Pick<RecoveryRetirementReads, 'header' | 'scan'>;
}

function submissionKey(row: Pick<ITransaction, 'submitEvidence'>): string {
  return evidenceKey(
    row.submitEvidence?.map(entry => ({
      ...entry,
      verdict: undefined,
      neverCommittedBy: undefined,
      landingSeenAtBlock: undefined,
      landingSeenBy: undefined
    }))
  );
}

export async function reconcileRecoveryTransactions(context: RecoveryReconcileContext): Promise<number> {
  const snapshot = validateJournal(context.snapshot);
  return (
    (await withRecoveryReadTurn(
      JSON.stringify(snapshot.scope),
      context.deadline,
      context.assertCurrent,
      async check => {
        const table = context.database.table<ITransaction>('transactions');
        const entries = [...snapshot.entries];
        let completed = 0;
        const budget = { remainingReads: 32 };
        const read = async <T>(operation: () => Promise<T>, unknown: T): Promise<T> => {
          check();
          if (budget.remainingReads-- <= 0) return unknown;
          try {
            const result = await operation();
            check();
            return result;
          } catch {
            check();
            return unknown;
          }
        };
        const node: NodeReads = {
          blockCommitment: block => read(() => context.node.blockCommitment(block), undefined),
          account: (id, block, timeout) =>
            read(() => context.node.account(id, block, timeout), { ok: false, pruned: false, timedOut: false }),
          noteInclusions: (ids, timeout) => read(() => context.node.noteInclusions(ids, timeout), undefined),
          nullifierHeight: (id, block, timeout) =>
            read(() => context.node.nullifierHeight(id, block, timeout), undefined)
        };
        const transactions = entries
          .filter((entry): entry is RecoveryTransactionEntry => entry.kind === 'transaction')
          .sort((a, b) => (a.resolved?.at ?? 0) - (b.resolved?.at ?? 0))
          .slice(0, 4);
        for (const entry of transactions) {
          check();
          if (entry.kind !== 'transaction' || !entry.row) continue;
          const row = await table.get(entry.id);
          check();
          if (
            !row ||
            (row.status !== ITransactionStatus.Unconfirmed &&
              row.status !== ITransactionStatus.Completed &&
              row.status !== ITransactionStatus.Failed) ||
            (row.restoredFromBackup && !row.restoredFromJournal) ||
            !sameWalletAccountId(row.accountId, entry.accountId) ||
            !canAwaitVerdict({ ...row, restoredFromBackup: false })
          )
            continue;
          if (
            entry.resolved
              ? submissionKey(row) !== submissionKey(entry.row)
              : evidenceKey(row.submitEvidence) !== evidenceKey(entry.row.submitEvidence)
          )
            continue;
          const aliases = [
            ...new Set([entry.accountId, entry.accountId.split('_')[0]!, canonicalWalletAccountId(entry.accountId)])
          ];
          const locals = await table.where('accountId').anyOf(aliases).limit(257).toArray();
          check();
          if (locals.length > 256) continue;
          const trusted = entries.filter(
            other => other.kind === 'transaction' && sameWalletAccountId(other.accountId, entry.accountId)
          );
          const proofRows = new Map<string, ITransaction>();
          for (const other of locals) {
            if (!other.restoredFromBackup) proofRows.set(other.id, other);
          }
          let complete = true;
          for (const other of trusted) {
            if (other.kind !== 'transaction' || !other.row) {
              complete = false;
              break;
            }
            const live = locals.find(value => value.id === other.id);
            if (
              !live ||
              (live.restoredFromBackup && !live.restoredFromJournal) ||
              submissionKey(live) !== submissionKey(other.row)
            ) {
              complete = false;
              break;
            }
            proofRows.set(live.id, { ...live, restoredFromBackup: false });
          }
          if (!complete) continue;
          const baseline = JSON.stringify(toSerializable(locals));
          const scans = [...(entry.scans ?? [])];
          let tipBlock: number | undefined;
          const boundedNode: NodeReads = context.nullifiers
            ? {
                ...node,
                account: async (id, block, timeout) => {
                  const result = await node.account(id, block, timeout);
                  if (block === undefined && result.ok) tipBlock = result.state.blockNum;
                  return result;
                },
                nullifierHeight: async (nullifier, fromBlock) => {
                  if (budget.remainingReads < 4 || scans.length >= 256 || tipBlock === undefined) return undefined;
                  budget.remainingReads -= 4;
                  const previous = scans.find(scan => scan.nullifier === nullifier);
                  try {
                    const next = await scanRecoveryNullifier(
                      nullifier,
                      fromBlock,
                      previous,
                      context.nullifiers!,
                      check
                    );
                    check();
                    if (!next) return undefined;
                    if (previous) scans[scans.indexOf(previous)] = next;
                    else scans.push(next);
                    return next.height ?? (next.nextBlock > tipBlock ? null : undefined);
                  } catch {
                    check();
                    return undefined;
                  }
                }
              }
            : node;
          const judgement = await judgeSubmitEvidence(
            {
              ...row,
              restoredFromBackup: false,
              submitEvidence: row.submitEvidence?.map(attempt => ({
                ...attempt,
                verdict: undefined,
                neverCommittedBy: undefined,
                landingSeenAtBlock: undefined,
                landingSeenBy: undefined
              }))
            },
            {
              node: boundedNode,
              accountRows: [...proofRows.values()],
              nowSec: Math.floor(Date.now() / 1000),
              cadenceMs: 500
            }
          );
          check();
          if (!judgement.landed && !judgement.allDead) {
            if (JSON.stringify(scans) !== JSON.stringify(entry.scans ?? [])) {
              entries[entries.indexOf(entry)] = { ...entry, scans };
              await context.retain(entries);
              check();
            }
            continue;
          }
          if (budget.remainingReads <= 0) continue;
          let canonical = true;
          for (const attempt of judgement.judgedEntries) {
            if (attempt.refBlock === undefined || attempt.refBlockCommitment === undefined) {
              canonical = false;
              break;
            }
            if ((await node.blockCommitment(attempt.refBlock)) !== attempt.refBlockCommitment) {
              canonical = false;
              break;
            }
          }
          check();
          if (!canonical) continue;
          const now = Math.floor(Date.now() / 1000);
          const evidence: ISubmitEvidence[] = (row.submitEvidence ?? []).map(attempt => {
            const verdict = judgement.entries.find(value => value.attemptId === attempt.attemptId);
            return verdict?.result === 'never-committed'
              ? { ...attempt, verdict: 'never-committed', neverCommittedBy: verdict.neverCommittedBy }
              : verdict?.landingRecord
                ? {
                    ...attempt,
                    landingSeenAtBlock: verdict.landingRecord.block,
                    landingSeenBy: verdict.landingRecord.by
                  }
                : attempt;
          });
          const next: RecoveryTransactionEntry = {
            ...entry,
            scans,
            row: { ...entry.row, submitEvidence: evidence },
            resolved: {
              outcome: judgement.landed ? 'landed' : 'never-committed',
              at: now,
              ...(judgement.landed?.boundTransactionId ? { transactionId: judgement.landed.boundTransactionId } : {})
            }
          };
          const beforeWrite = await table.where('accountId').anyOf(aliases).limit(257).toArray();
          check();
          if (JSON.stringify(toSerializable(beforeWrite)) !== baseline) continue;
          entries[entries.indexOf(entry)] = next;
          await context.retain(entries);
          check();
          const written = await context.database.transaction('rw', table, async () => {
            const fresh = await table.where('accountId').anyOf(aliases).limit(257).toArray();
            check();
            if (JSON.stringify(toSerializable(fresh)) !== baseline) return false;
            if (!row.restoredFromJournal) return true;
            const update: Partial<ITransaction> = {
              submitEvidence: evidence,
              status: judgement.landed ? ITransactionStatus.Completed : ITransactionStatus.Failed,
              ...(judgement.landed
                ? { completedAt: row.completedAt ?? now, transactionId: judgement.landed.boundTransactionId }
                : { neverCommittedAt: now })
            };
            await table.update(row.id, update);
            check();
            const readback = await table.get(row.id);
            check();
            if (
              !readback ||
              readback.status !== update.status ||
              !readback.restoredFromBackup ||
              !readback.restoredFromJournal
            )
              throw new Error('Recovery verdict readback mismatch');
            return true;
          });
          if (written) completed++;
        }
        return completed;
      }
    )) ?? 0
  );
}

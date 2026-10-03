// Settles rows whose submit outcome is unknown (#1081): judges each recorded attempt against the node and writes the
// verdict. Every judge-then-write sequence on a row runs under that row's verdict lock (`inVerdictTurn`), taken by
// the caller. What still writes outside the lock (the pipeline's stamps, the out-of-band enders, the Agglayer
// promotion) can only fill or add entries or complete the row, so the status-changing writes re-check the status and
// the entries' evidence, and the landed write the account's other rows.
import * as Repo from 'lib/miden/repo';

import { TRANSACTION_NEVER_COMMITTED_ERROR } from './constants';
import { applyVerifiedLanding, landedValueRowFields, reportVerifiedLanding } from './helper';
import { accountOthers, deferralHolds, judgeSubmitEvidence, RowJudgement } from './reconcile-judge';
import { createNodeReads, NodeReads, observedCadenceMs } from './reconcile-reads';
import { awaitingVerdict, evidenceKey, nowSeconds } from './verdict-rules';
import { ISubmitEvidence, ITransaction, ITransactionStatus } from '../db/types';
import { sameWalletAccountId } from '../sdk/helpers';

export { judgeSubmitEvidence } from './reconcile-judge';

export interface JudgeContext {
  node: NodeReads;
  nowSec: number;
  cadenceMs: number;
}

export type RowOutcome =
  | { kind: 'skipped' }
  | { kind: 'landed' }
  | { kind: 'landing-pending'; judgement: RowJudgement; baseline: string }
  | { kind: 'never-committed'; judgement: RowJudgement; baseline: string }
  | { kind: 'pending'; judgement: RowJudgement; baseline: string };

/** Every row of `row`'s account that was not restored, scanned rather than indexed: dApp rows store the bare address. */
export const accountRowsOf = async (row: ITransaction): Promise<ITransaction[]> =>
  Repo.transactions
    .filter(other => other.restoredFromBackup !== true && sameWalletAccountId(other.accountId, row.accountId))
    .toArray();

const accountEvidenceKey = (rows: readonly ITransaction[]): string =>
  JSON.stringify(
    [...rows]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(other => [other.id, evidenceKey(other.submitEvidence)])
  );

/** `entries` with the verdicts and the network marks this judgement decided; never the seen fields. */
export const applyEntryWrites = (entries: readonly ISubmitEvidence[], judgement: RowJudgement): ISubmitEvidence[] =>
  entries.map(entry => {
    const judged = judgement.entries.find(candidate => candidate.attemptId === entry.attemptId);
    if (judged === undefined) return entry;
    const next: ISubmitEvidence = { ...entry };
    if (judged.result === 'never-committed' || judged.result === 'unresolvable') next.verdict = judged.result;
    if (typeof judged.otherNetworkSince === 'number') next.otherNetworkSince = judged.otherNetworkSince;
    if (judged.otherNetworkSince === null) delete next.otherNetworkSince;
    return next;
  });

/**
 * Persist what the account reads saw, before acting on any verdict (#1081): guard-free, because only the verdict
 * lock's holder writes these fields, and none of them counts in a write's evidence check. So the fact survives a
 * landed write that gives up and a pass that ends pending.
 */
async function writeSeenBlocks(rowId: string, judgement: RowJudgement): Promise<void> {
  await Repo.transactions.where({ id: rowId }).modify(tx => {
    let changed = false;
    const entries = (tx.submitEvidence ?? []).map(entry => {
      const judged = judgement.entries.find(candidate => candidate.attemptId === entry.attemptId);
      const asRead = judgement.judgedEntries.find(candidate => candidate.attemptId === entry.attemptId);
      if (judged === undefined || asRead === undefined) return entry;
      const next: ISubmitEvidence = { ...entry };
      if (
        judged.initialSeenAtBlock !== undefined &&
        entry.initialCommitment === asRead.initialCommitment &&
        (entry.initialSeenAtBlock === undefined || judged.initialSeenAtBlock < entry.initialSeenAtBlock)
      ) {
        next.initialSeenAtBlock = judged.initialSeenAtBlock;
        changed = true;
      }
      const record = judged.landingRecord;
      // A row 1 or 3 record is never replaced; one of those replaces a row 2 record, which proves no account state.
      if (
        record !== undefined &&
        (entry.landingSeenAtBlock === undefined || (entry.landingSeenBy === 2 && record.by !== 2))
      ) {
        next.landingSeenAtBlock = record.block;
        next.landingSeenBy = record.by;
        changed = true;
      }
      return next;
    });
    if (!changed) return false;
    tx.submitEvidence = entries;
    return undefined;
  });
}

/** The network check, again, right before a write: a header that moved since voids the verdict. */
async function networkStillMatches(node: NodeReads, entries: readonly ISubmitEvidence[]): Promise<boolean> {
  for (const entry of entries) {
    if (entry.refBlock === undefined) continue;
    if ((await node.blockCommitment(entry.refBlock)) !== entry.refBlockCommitment) return false;
  }
  return true;
}

/**
 * The landed write: one rw transaction that re-reads every row of the account, the target's included. If any entry
 * differs from what the judgement read, or the deferral now holds the landing, it writes nothing and the next pass
 * judges again from the fresh rows.
 */
async function writeLanding(rowId: string, judgement: RowJudgement, accountKey: string): Promise<boolean> {
  const landing = judgement.landed;
  const landedEntry = judgement.judgedEntries.find(entry => entry.attemptId === landing?.attemptId);
  if (landing === undefined || landedEntry === undefined) return false;
  let landed: ITransaction | undefined;
  await Repo.db.transaction('rw', Repo.transactions, async () => {
    const fresh = await Repo.transactions.where({ id: rowId }).first();
    if (
      fresh === undefined ||
      (fresh.status !== ITransactionStatus.Unconfirmed && fresh.status !== ITransactionStatus.Failed)
    )
      return;
    const freshRows = await accountRowsOf(fresh);
    if (accountEvidenceKey(freshRows) !== accountKey) return;
    if (deferralHolds(landedEntry, landing.proof, accountOthers(fresh, freshRows))) return;
    applyVerifiedLanding(fresh, {
      ...landedValueRowFields(fresh),
      ...(landing.boundTransactionId === undefined ? {} : { transactionId: landing.boundTransactionId }),
      completedAt: fresh.completedAt
    });
    await Repo.transactions.put(fresh);
    landed = fresh;
  });
  if (landed === undefined) return false;
  reportVerifiedLanding(landed);
  return true;
}

/**
 * Every entry provable and dead, or retired before its submit: the row is marked safe to retry. Guarded on the status
 * and the entries' evidence (the seen fields aside), so a late stamp voids it. No report and no notice: Activity shows
 * a verdict that can arrive long after.
 */
async function writeNeverCommitted(rowId: string, judgement: RowJudgement, nowSec: number): Promise<boolean> {
  const baseline = evidenceKey(judgement.judgedEntries);
  let wrote = false;
  await Repo.transactions.where({ id: rowId }).modify(fresh => {
    if (fresh.status !== ITransactionStatus.Unconfirmed && fresh.status !== ITransactionStatus.Failed) return false;
    if (fresh.neverCommittedAt !== undefined || evidenceKey(fresh.submitEvidence) !== baseline) return false;
    fresh.submitEvidence = applyEntryWrites(fresh.submitEvidence ?? [], judgement);
    fresh.rawError = fresh.rawError ?? fresh.error;
    fresh.status = ITransactionStatus.Failed;
    fresh.error = TRANSACTION_NEVER_COMMITTED_ERROR;
    fresh.displayMessage = 'Failed';
    fresh.displayIcon = 'FAILED';
    fresh.neverCommittedAt = nowSec;
    wrote = true;
    return undefined;
  });
  return wrote;
}

/** Persist only the verdicts and network marks that changed, each on an entry whose evidence is still as judged. */
async function writeVerdicts(rowId: string, judgement: RowJudgement): Promise<void> {
  await Repo.transactions.where({ id: rowId }).modify(fresh => {
    let changed = false;
    const entries = (fresh.submitEvidence ?? []).map(entry => {
      const asRead = judgement.judgedEntries.find(candidate => candidate.attemptId === entry.attemptId);
      if (asRead === undefined || evidenceKey([entry]) !== evidenceKey([asRead])) return entry;
      const [written] = applyEntryWrites([entry], judgement);
      if (written === undefined || evidenceKey([written]) === evidenceKey([entry])) return entry;
      changed = true;
      return written;
    });
    if (!changed) return false;
    fresh.submitEvidence = entries;
    return undefined;
  });
}

/**
 * Judge one row and write its verdict. The caller holds the row's verdict lock. `baseline` is the row's evidence key
 * as this call judged and wrote it, which Retry's requeue write compares against instead of re-reading.
 */
export async function judgeAndWrite(rowId: string, context: JudgeContext): Promise<RowOutcome> {
  const row = await Repo.transactions.where({ id: rowId }).first();
  if (row === undefined || !awaitingVerdict(row, context.nowSec)) return { kind: 'skipped' };
  const accountRows = await accountRowsOf(row);
  const accountKey = accountEvidenceKey(accountRows);
  const judgement = await judgeSubmitEvidence(row, {
    node: context.node,
    accountRows,
    nowSec: context.nowSec,
    cadenceMs: context.cadenceMs
  });
  await writeSeenBlocks(row.id, judgement);

  // The network check runs once more before any verdict is written: a header that moved since voids them all.
  const decided = judgement.judgedEntries.filter(entry =>
    judgement.entries.some(
      judged =>
        judged.attemptId === entry.attemptId &&
        (judged.result === 'landed' || judged.result === 'never-committed' || judged.result === 'unresolvable')
    )
  );
  if (!(await networkStillMatches(context.node, decided))) {
    return {
      kind: judgement.landingHeld ? 'landing-pending' : 'pending',
      judgement,
      baseline: evidenceKey(judgement.judgedEntries)
    };
  }
  const baseline = evidenceKey(applyEntryWrites(judgement.judgedEntries, judgement));

  if (judgement.landed !== undefined) {
    if (await writeLanding(row.id, judgement, accountKey)) return { kind: 'landed' };
    return { kind: 'landing-pending', judgement, baseline };
  }
  if (judgement.allDead && (await writeNeverCommitted(row.id, judgement, context.nowSec))) {
    return { kind: 'never-committed', judgement, baseline };
  }
  await writeVerdicts(row.id, judgement);
  return { kind: judgement.landingHeld ? 'landing-pending' : 'pending', judgement, baseline };
}

export type RetryEvidenceCheck =
  | { kind: 'landed' }
  | { kind: 'landing-pending' }
  | { kind: 'proven'; baseline: string }
  | { kind: 'undecided'; baseline: string };

/**
 * Retry's tap-time proof (#1081): the same judgement and network check as a pass, with no schedule. The caller holds
 * the row's verdict lock. It never releases a Guardian candidate: Retry never abandons one.
 */
export async function checkEvidenceForRetry(
  row: ITransaction,
  deps: { createReads?: () => Promise<NodeReads> } = {}
): Promise<RetryEvidenceCheck> {
  const node = await (deps.createReads ?? createNodeReads)();
  const outcome = await judgeAndWrite(row.id, { node, nowSec: nowSeconds(), cadenceMs: observedCadenceMs() });
  switch (outcome.kind) {
    case 'landed':
      return { kind: 'landed' };
    case 'landing-pending':
      return { kind: 'landing-pending' };
    case 'never-committed':
      return { kind: 'proven', baseline: outcome.baseline };
    case 'pending':
      return { kind: 'undecided', baseline: outcome.baseline };
    case 'skipped':
      return { kind: 'undecided', baseline: evidenceKey(row.submitEvidence) };
  }
}

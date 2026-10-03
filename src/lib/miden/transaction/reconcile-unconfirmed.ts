// Settles rows whose submit outcome is unknown (#1081): judges each recorded attempt against the node and writes the
// verdict. Every judge-then-write sequence on a row runs under that row's verdict lock (`inVerdictTurn`), taken by
// the caller. What still writes outside the lock (the pipeline's stamps, the out-of-band enders, the Agglayer
// promotion) can only fill or add entries or complete the row, so the status-changing writes re-check the status and
// the entries' evidence, and the landed write the account's other rows.
import { inVerdictTurn } from 'lib/miden/front/storage';
import * as Repo from 'lib/miden/repo';
import { getStorageProvider, type StorageProvider } from 'lib/platform/storage-adapter';

import { TRANSACTION_NEVER_COMMITTED_ERROR } from './constants';
import { applyVerifiedLanding, reportVerifiedLanding, verifiedLandingRowFields } from './helper';
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
      ...verifiedLandingRowFields(fresh),
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
  // A landing this call found but did not write still reads as one, so Retry refuses it rather than reach the
  // acknowledgeable refusal a plain send could pay twice through.
  const unsettled = judgement.landed !== undefined || judgement.landingHeld ? 'landing-pending' : 'pending';
  if (!(await networkStillMatches(context.node, decided))) {
    return { kind: unsettled, judgement, baseline: evidenceKey(judgement.judgedEntries) };
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
  return { kind: unsettled, judgement, baseline };
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

/** One storage key for the schedule; no storage hook reads it, so a direct provider write is safe. */
export const SCHEDULE_KEY = 'miden_unconfirmed_reconcile_schedule';
export const PENDING_BACKOFF_BASE_MS = 15_000;
export const PENDING_BACKOFF_CAP_MS = 300_000;
export const STALE_ROW_INTERVAL_MS = 3_600_000;
const STALE_ROW_AGE_SEC = 24 * 60 * 60;
const NULLIFIER_WATCH_SEC = 60 * 60;

export interface ScheduleEntry {
  nextCheckAt: number; // ms
  step: number;
}
export type Schedule = Record<string, ScheduleEntry>;

/** A spend can lose its binding read within ~40 blocks, so a nullifier is watched every 10 blocks, never backed off. */
export const nullifierIntervalMs = (cadenceMs: number): number => Math.min(15_000, Math.max(2_000, 10 * cadenceMs));

/** A malformed stored value (an older build, a corrupted store) reads as an empty schedule. */
export const parseSchedule = (value: unknown): Schedule => {
  const schedule: Schedule = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return schedule;
  for (const id of Object.keys(value)) {
    const entry: unknown = Reflect.get(value, id);
    if (typeof entry !== 'object' || entry === null) continue;
    const nextCheckAt: unknown = Reflect.get(entry, 'nextCheckAt');
    const step: unknown = Reflect.get(entry, 'step');
    if (
      typeof nextCheckAt === 'number' &&
      Number.isFinite(nextCheckAt) &&
      typeof step === 'number' &&
      Number.isSafeInteger(step) &&
      step >= 0
    ) {
      schedule[id] = { nextCheckAt, step };
    }
  }
  return schedule;
};

/** Due at its time, or when that time lies further ahead than any interval: a clock stepped back never starves a row. */
export const isDue = (entry: ScheduleEntry | undefined, nowMs: number): boolean =>
  entry === undefined || entry.nextCheckAt <= nowMs || entry.nextCheckAt - nowMs > STALE_ROW_INTERVAL_MS;

const watchesNullifier = (entries: readonly ISubmitEvidence[], tipBlock: number | undefined, nowSec: number): boolean =>
  entries.some(
    entry =>
      entry.verdict === undefined &&
      entry.preSubmitEnd !== true &&
      (entry.nullifiers?.length ?? 0) > 0 &&
      (entry.expirationBlock !== undefined
        ? tipBlock === undefined || tipBlock <= entry.expirationBlock
        : nowSec - entry.capturedAt < NULLIFIER_WATCH_SEC)
  );

/** The next check after a pass that reached no final verdict for the row. */
export const nextScheduleEntry = (
  previous: ScheduleEntry | undefined,
  row: Pick<ITransaction, 'initiatedAt'>,
  entries: readonly ISubmitEvidence[],
  tipBlock: number | undefined,
  nowMs: number,
  cadenceMs: number
): ScheduleEntry => {
  const step = previous?.step ?? 0;
  const nowSec = Math.floor(nowMs / 1000);
  if (watchesNullifier(entries, tipBlock, nowSec)) return { nextCheckAt: nowMs + nullifierIntervalMs(cadenceMs), step };
  const waitMs =
    nowSec - row.initiatedAt > STALE_ROW_AGE_SEC
      ? STALE_ROW_INTERVAL_MS
      : Math.min(PENDING_BACKOFF_BASE_MS * 2 ** step, PENDING_BACKOFF_CAP_MS);
  return { nextCheckAt: nowMs + waitMs, step: step + 1 };
};

export interface ReconcileDeps {
  storage?: StorageProvider;
  createReads?: () => Promise<NodeReads>;
  now?: () => number;
}

let runningPass: Promise<void> | undefined;

/**
 * One reconciler pass in this realm (#1081), fired and forgotten after a successful sync; a second call joins the
 * running pass. It takes no WASM client lock and never rejects: each row is judged in its own try.
 */
export const reconcileUnconfirmedTransactions = (deps: ReconcileDeps = {}): Promise<void> => {
  runningPass ??= runPass(deps).finally(() => {
    runningPass = undefined;
  });
  return runningPass;
};

async function runPass(deps: ReconcileDeps): Promise<void> {
  const storage = deps.storage ?? getStorageProvider();
  const now = deps.now ?? Date.now;
  try {
    const startedMs = now();
    const rows = await Repo.transactions.filter(row => awaitingVerdict(row, Math.floor(startedMs / 1000))).toArray();
    const raw: unknown = (await storage.get([SCHEDULE_KEY]))[SCHEDULE_KEY];
    const stored = parseSchedule(raw);
    const schedule: Schedule = {};
    for (const row of rows) {
      const entry = stored[row.id];
      if (entry !== undefined) schedule[row.id] = entry;
    }
    const due = rows.filter(row => isDue(schedule[row.id], startedMs));
    if (due.length > 0) {
      const node = await (deps.createReads ?? createNodeReads)();
      for (const row of due) {
        try {
          const turn = await inVerdictTurn(
            row.id,
            () => judgeAndWrite(row.id, { node, nowSec: Math.floor(now() / 1000), cadenceMs: observedCadenceMs() }),
            { ifAvailable: true }
          );
          if (!turn.ran) continue;
          const outcome = turn.value;
          if (outcome.kind === 'pending' || outcome.kind === 'landing-pending') {
            schedule[row.id] = nextScheduleEntry(
              schedule[row.id],
              row,
              applyEntryWrites(outcome.judgement.judgedEntries, outcome.judgement),
              outcome.judgement.tipBlock,
              now(),
              observedCadenceMs()
            );
          } else {
            delete schedule[row.id];
          }
        } catch (error) {
          console.warn(`[reconcile] could not judge transaction ${row.id}`, error);
        }
      }
    }
    if (JSON.stringify(raw) !== JSON.stringify(schedule)) await storage.set({ [SCHEDULE_KEY]: schedule });
  } catch (error) {
    console.warn('[reconcile] the unconfirmed reconcile pass failed', error);
  }
}

// Settles rows whose submit outcome is unknown (#1081): judges each recorded attempt against the node and writes the
// verdict. Every judge-then-write sequence on a row runs under that row's verdict lock (`inVerdictTurn`), taken by
// the caller. What still writes outside the lock (the pipeline's stamps, the out-of-band enders, the Agglayer
// promotion) can only fill or add entries or complete the row, so the status-changing writes re-check the status and
// the entries' evidence, and the landed write the account's other rows.
import type { AbandonStatus } from '@openzeppelin/guardian-client';

import { inVerdictTurn } from 'lib/miden/front/storage';
import * as Repo from 'lib/miden/repo';
import { monotonicNowMs } from 'lib/miden/sync-backoff';
import { getStorageProvider, type StorageProvider } from 'lib/platform/storage-adapter';

import { TRANSACTION_NEVER_COMMITTED_ERROR } from './constants';
import { applyVerifiedLanding, reportVerifiedLanding, verifiedLandingRowFields } from './helper';
import { accountOthers, deferralHolds, judgeSubmitEvidence, RowJudgement } from './reconcile-judge';
import { createNodeReads, NodeReads, observedCadenceMs } from './reconcile-reads';
import { awaitingVerdict, evidenceKey, isCheckable, nowSeconds } from './verdict-rules';
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
    // A row re-derived as undelivered with no output note to push is inert to the delivery sweep.
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

/**
 * Only an entry the pass reads can use the binding budget, so one on another network is not watched. A tip the pass
 * could not read (a reset chain still short of refBlock never answers the network check) ends the watch as if E had
 * no X: an hour after the crossing.
 */
const watchesNullifier = (entries: readonly ISubmitEvidence[], tipBlock: number | undefined, nowSec: number): boolean =>
  entries.some(
    entry =>
      isCheckable(entry, nowSec) &&
      entry.otherNetworkSince === undefined &&
      entry.nullifiers.length > 0 &&
      (entry.expirationBlock !== undefined && tipBlock !== undefined
        ? tipBlock <= entry.expirationBlock
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

/** Polls one abandon's resolution on the service that asked for it. */
export interface KeptCandidatePoll {
  /**
   * Where the abandon stands. Rejects once `timeoutMs`, or the outgoing-guardian deadline if that comes first, passes
   * with no answer.
   */
  status(timeoutMs: number): Promise<AbandonStatus>;
}

/**
 * Releases a kept Guardian candidate (#1081). Injected, because only `index.ts` can build the cold service and each
 * realm passes its own provider: the service worker its vault, the app realm its store.
 */
export interface CandidateRelease {
  /**
   * Asks the account's Guardian to abandon the candidate at `nonce` that the attempt `attemptId` kept. Undefined when
   * there is nothing to poll: this realm's record of the account's candidate is not that attempt's at that nonce
   * (another realm, a restart, another write's record), its abandon window closed, the account's Guardian changed, no
   * service could be built, or the abandon failed, so the Guardian may never have taken it.
   */
  abandon(accountId: string, nonce: number, attemptId: string): Promise<KeptCandidatePoll | undefined>;
}

export const CANDIDATE_RELEASE_POLL_MS = 3_000;
export const CANDIDATE_RELEASE_BOUND_MS = 60_000;
const CANDIDATE_CLEAR_WAIT_MS = 10_000;

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Clear the kept mark of one candidate the Guardian released, under the row's verdict lock like every evidence write. */
const clearKeptCandidate = async (rowId: string, attemptId: string, nonce: number): Promise<void> => {
  await inVerdictTurn(
    rowId,
    () =>
      Repo.transactions.where({ id: rowId }).modify(row => {
        const entries = row.submitEvidence ?? [];
        const index = entries.findIndex(
          entry =>
            entry.attemptId === attemptId && entry.guardianProposalNonce === nonce && entry.candidateKept === true
        );
        const current = entries[index];
        if (current === undefined) return false;
        const released: ISubmitEvidence = { ...current };
        delete released.candidateKept;
        row.submitEvidence = entries.map((entry, at) => (at === index ? released : entry));
        return undefined;
      }),
    { waitMs: CANDIDATE_CLEAR_WAIT_MS }
  );
};

/**
 * After a never-committed write, ask the Guardian to abandon each candidate the row's attempts kept (#1081). An
 * accepted abandon is only an intent: the Guardian quarantines the candidate before it releases the account, so the
 * resolution is polled every 3 s for at most 60 s. Only 'abandoned' clears the mark; any other answer, no poll
 * (nothing asked, or an abandon that failed), or the time running out leaves it, and Retry's hold then waits for the
 * Guardian's own discard. Best-effort and bounded: a later pass joins this one meanwhile, which is rare (only right
 * after such a proof) and cheaper than a second release. The bound reads the monotonic clock and caps every read at
 * the time left, so neither a wall clock set back nor a Guardian slow to answer can hold the pass past it.
 */
async function releaseKeptCandidates(
  accountId: string,
  rowId: string,
  entries: readonly ISubmitEvidence[],
  release: CandidateRelease,
  nowMono: () => number,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  for (const entry of entries) {
    const nonce = entry.guardianProposalNonce;
    if (entry.candidateKept !== true || nonce === undefined) continue;
    try {
      const poll = await release.abandon(accountId, nonce, entry.attemptId);
      if (poll === undefined) continue;
      const deadline = nowMono() + CANDIDATE_RELEASE_BOUND_MS;
      let status: AbandonStatus = 'waiting';
      // Another interval only while a read would still have time after it.
      while (status === 'waiting' && deadline - nowMono() > CANDIDATE_RELEASE_POLL_MS) {
        await sleep(CANDIDATE_RELEASE_POLL_MS);
        // A timer can fire late, so the time left is read again after the sleep.
        const left = deadline - nowMono();
        if (left <= 0) break;
        // A failed or cut-off read is no answer: keep polling until the bound.
        status = await poll.status(left).catch((): AbandonStatus => 'waiting');
      }
      if (status === 'abandoned') await clearKeptCandidate(rowId, entry.attemptId, nonce);
      else console.warn(`[reconcile] the Guardian has not released candidate ${nonce} of ${rowId} (${status})`);
    } catch (error) {
      console.warn(`[reconcile] could not release candidate ${nonce} of ${rowId}`, error);
    }
  }
}

export interface ReconcileDeps {
  storage?: StorageProvider;
  createReads?: () => Promise<NodeReads>;
  now?: () => number;
  /** Releases kept Guardian candidates after a never-committed write; absent, none is released. */
  release?: CandidateRelease;
  sleep?: (ms: number) => Promise<void>;
  /** The release's clock (`monotonicNowMs` when absent): a wall clock set back must not stretch its 60 s. */
  nowMono?: () => number;
}

let runningPass: Promise<void> | undefined;

/**
 * One reconciler pass in this realm (#1081), fired and forgotten after a successful sync; a second call joins the
 * running pass. Judging takes no WASM client lock: its reads go to the node. With a `release`, each kept Guardian
 * candidate of a row proven never committed adds a short WASM-lock read to build the cold service, a Guardian abandon
 * under the outgoing deadline, and at most 60 s of polling. Never rejects: each row is judged, and each candidate
 * released, in its own try.
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
    const released: Array<{ accountId: string; rowId: string; entries: ISubmitEvidence[] }> = [];
    for (const row of rows) {
      const entry = stored[row.id];
      if (entry !== undefined) schedule[row.id] = entry;
    }
    const due = rows.filter(row => isDue(schedule[row.id], startedMs));
    if (due.length > 0) {
      const node = await (deps.createReads ?? createNodeReads)();
      const failures: Record<string, unknown> = {};
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
            if (outcome.kind === 'never-committed') {
              released.push({
                accountId: row.accountId,
                rowId: row.id,
                entries: applyEntryWrites(outcome.judgement.judgedEntries, outcome.judgement)
              });
            }
          }
        } catch (error) {
          // No reachable read throws, so this is a fault: it backs off like a pass with no verdict, never every lap.
          schedule[row.id] = nextScheduleEntry(schedule[row.id], row, [], undefined, now(), observedCadenceMs());
          failures[row.id] = error;
        }
      }
      if (Object.keys(failures).length > 0) console.warn('[reconcile] could not judge these transactions', failures);
    }
    if (JSON.stringify(raw) !== JSON.stringify(schedule)) await storage.set({ [SCHEDULE_KEY]: schedule });
    // After the schedule is saved, so a slow Guardian never costs a row its next check time.
    if (deps.release !== undefined) {
      for (const { accountId, rowId, entries } of released) {
        await releaseKeptCandidates(
          accountId,
          rowId,
          entries,
          deps.release,
          deps.nowMono ?? monotonicNowMs,
          deps.sleep ?? delay
        );
      }
    }
  } catch (error) {
    console.warn('[reconcile] the unconfirmed reconcile pass failed', error);
  }
}

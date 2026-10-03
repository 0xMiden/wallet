// The verdict on each recorded attempt of a row whose submit outcome is unknown (#1081): spec section 7's table,
// rows 1 to 9 in order, with its network check, live-sibling deferral and binding. Pure apart from the injected node
// reads and clock. Every never-committed verdict rests on a read that names its block, never on a missing mark: a
// batch can erase a landed attempt's notes and its nullifiers with them.
import { pipelineMayStillBeRunning } from './cancel';
import { AccountRead, AccountState, NodeReads, RPC_READ_TIMEOUT_MS } from './reconcile-reads';
import { isCheckable, isProvable, latestEntry, ProvableEvidence } from './verdict-rules';
import { ISubmitEvidence, ITransaction, isLiveTransaction } from '../db/types';
import { sameWalletAccountId } from '../sdk/helpers';

/** The node keeps ~50 blocks of account history; a read pinned to a block stops 10 short of losing it. */
export const BINDING_HISTORY_BLOCKS = 40;

export type EntryResult =
  | 'landed'
  | 'deferred'
  | 'never-committed'
  | 'unresolvable'
  | 'pending'
  | 'no-read'
  | 'other-network';

export type LandingProof =
  | { kind: 'commitment' }
  | { kind: 'note'; noteId: string }
  | { kind: 'nullifier'; nullifier: string; finalCommitment: string };

export interface EntryJudgement {
  attemptId: string;
  result: EntryResult;
  proof?: LandingProof;
  /** A landing to record: the block the judgement rested on and the verdict row that judged it. */
  landingRecord?: { block: number; by: 1 | 2 | 3 };
  /** An earlier block than the stored one at which an account read returned the entry's pre-state. */
  initialSeenAtBlock?: number;
  /** A number to record, null to clear, undefined to leave as it is. */
  otherNetworkSince?: number | null;
  readsFailed: boolean;
}

export interface VerdictReads {
  node: NodeReads;
  /** Every row of the account that was not restored from a backup, the judged row included. */
  accountRows: readonly ITransaction[];
  nowSec: number;
  cadenceMs: number;
}

export interface RowJudgement {
  rowId: string;
  /** The entries as judged: what every write compares its fresh read against. */
  judgedEntries: ISubmitEvidence[];
  entries: EntryJudgement[];
  landed?: { attemptId: string; proof: LandingProof; boundTransactionId?: string };
  allDead: boolean;
  /** A landing or candidate note the deferral holds, or a recorded landing whose reads failed this time. */
  landingHeld: boolean;
  tipBlock?: number;
}

/** How long a read pinned to `block` may take while the node still holds that block's account history. */
export const bindingBudgetMs = (tipBlock: number, block: number, cadenceMs: number): number =>
  Math.min(RPC_READ_TIMEOUT_MS, (BINDING_HISTORY_BLOCKS - (tipBlock - block)) * cadenceMs);

/** A retired pin is ruled out everywhere, so only the other entries speak for a row. */
const activeEntries = (row: ITransaction): ISubmitEvidence[] =>
  (row.submitEvidence ?? []).filter(entry => entry.preSubmitEnd !== true);

/**
 * The account's other rows, matched across the bare-address and composite id forms (a dApp's rows store the bare
 * address), restored rows aside: a restored row is whatever the backup's author wrote.
 */
export const accountOthers = (row: ITransaction, accountRows: readonly ITransaction[]): ITransaction[] =>
  accountRows.filter(
    other =>
      other.id !== row.id && other.restoredFromBackup !== true && sameWalletAccountId(other.accountId, row.accountId)
  );

/**
 * A row whose latest attempt may still be running: Queued or Generating, or ended outside its pipeline within the
 * bound the stuck reaper and Retry's liveness refusal already use. Status alone cannot say: a cancel fails the row and
 * its pipeline runs on, and its stamp may not be durable yet.
 */
export const isLiveSibling = (row: ITransaction): boolean => {
  if (isLiveTransaction(row)) return true;
  const latest = latestEntry(row);
  return latest?.endedBy !== undefined && pipelineMayStillBeRunning(latest.endedAt);
};

/** The sibling's latest attempt has no entry that records its output list (a retired one leaves nothing unknown). */
const latestOutputsUnknown = (row: ITransaction): boolean => {
  const attemptId = row.attemptId ?? latestEntry(row)?.attemptId;
  if (attemptId === undefined) return false;
  const entry = (row.submitEvidence ?? []).find(candidate => candidate.attemptId === attemptId);
  return entry?.preSubmitEnd !== true && entry?.outputNoteIds === undefined;
};

/** Ran as an execute: an entry says so, or a live row's type does (a completion rewrites the type only on landing). */
const ranAsExecute = (row: ITransaction): boolean =>
  activeEntries(row).some(entry => entry.fromExecute === true) || (isLiveTransaction(row) && row.type === 'execute');

/** Only an execute runs bytes it did not build, so a copied note can run either way between E and the sibling. */
const deferringSiblings = (entry: ISubmitEvidence, others: readonly ITransaction[]): ITransaction[] =>
  others.filter(
    sibling =>
      isLiveSibling(sibling) && latestOutputsUnknown(sibling) && (ranAsExecute(sibling) || entry.fromExecute === true)
  );

/** Whether the deferral holds this landing now; the landed write asks it again on fresh rows. */
export const deferralHolds = (entry: ISubmitEvidence, proof: LandingProof, others: readonly ITransaction[]): boolean =>
  proof.kind === 'note' ? deferringSiblings(entry, others).length > 0 : others.some(isLiveSibling);

/** The other rows that could have produced `noteId`: one naming it, or an execute whose output list is unknown. */
const noteBlockers = (noteId: string, others: readonly ITransaction[]): ITransaction[] =>
  others.filter(other =>
    activeEntries(other).some(
      entry =>
        entry.outputNoteIds?.includes(noteId) === true ||
        (entry.fromExecute === true && entry.outputNoteIds === undefined)
    )
  );

/**
 * Another recorded attempt that is not proven dead and reaches the same final commitment, whatever its pre-state: the
 * commitment does not cover the notes a transaction consumed, so its landing would look exactly like E's.
 */
const sameFinalElsewhere = (finalCommitment: string, others: readonly ITransaction[]): boolean =>
  others.some(other =>
    activeEntries(other).some(entry => entry.verdict !== 'never-committed' && entry.finalCommitment === finalCommitment)
  );

interface EntryContext {
  row: ITransaction;
  others: readonly ITransaction[];
  liveSiblings: readonly ITransaction[];
  reads: VerdictReads;
  /** A fresh read on every call: a tip read before E's first check is outside the bracket that proves E's chain. */
  tip: () => Promise<AccountRead>;
}

async function judgeEntry(entry: ProvableEvidence, context: EntryContext): Promise<EntryJudgement> {
  const { row, others, reads } = context;
  // Nothing is written for E until the post-read check passes, a cleared otherNetworkSince included.
  const noRead = (): EntryJudgement => ({ attemptId: entry.attemptId, result: 'no-read', readsFailed: true });

  // The reference block's commitment is the network identity: what the executing client's chain said at execution.
  const before = await reads.node.blockCommitment(entry.refBlock);
  if (before === undefined) return noRead();
  if (before !== entry.refBlockCommitment) {
    return {
      attemptId: entry.attemptId,
      result: 'other-network',
      readsFailed: false,
      otherNetworkSince: entry.otherNetworkSince ?? reads.nowSec
    };
  }
  const otherNetworkSince = entry.otherNetworkSince === undefined ? undefined : null;

  const tipRead = await context.tip();
  if (!tipRead.ok) return noRead();
  const tip = tipRead.state;
  const moved = entry.finalCommitment !== entry.initialCommitment;
  const expiration = entry.expirationBlock;
  const offInitial = tip.commitment !== entry.initialCommitment;
  const accountReads: AccountState[] = [tip];

  let notes: ReadonlyMap<string, number> = new Map();
  if ((offInitial || !moved) && entry.outputNoteIds.length > 0) {
    const read = await reads.node.noteInclusions(entry.outputNoteIds, RPC_READ_TIMEOUT_MS);
    if (read === undefined) return noRead();
    notes = read;
  }
  // A transaction is included only after its reference block, so an earlier copy of the note is never E's.
  const onChain = [...notes].filter(([, block]) => block > entry.refBlock);

  let spend: { nullifier: string; height: number } | undefined;
  for (const nullifier of entry.nullifiers) {
    const height = await reads.node.nullifierHeight(nullifier, entry.refBlock, RPC_READ_TIMEOUT_MS);
    if (height === undefined) return noRead();
    // E could commit only after its reference block and at or before X, and a nullifier is spent once.
    const inWindow = height !== null && height >= entry.refBlock && (expiration === undefined || height <= expiration);
    if (inWindow && (spend === undefined || height < spend.height)) spend = { nullifier, height };
  }

  const recordedByAccount =
    entry.landingSeenAtBlock !== undefined && (entry.landingSeenBy === 1 || entry.landingSeenBy === 3);
  let atSpend: AccountState | undefined;
  let bindingLost = false;
  if (spend !== undefined && moved && offInitial && !(recordedByAccount && entry.landingSeenAtBlock === spend.height)) {
    const budget = bindingBudgetMs(tip.blockNum, spend.height, reads.cadenceMs);
    if (budget <= 0) bindingLost = true;
    else {
      const read = await reads.node.account(row.accountId, spend.height, budget);
      if (read.ok) {
        atSpend = read.state;
        accountReads.push(read.state);
      } else if (read.pruned || (read.timedOut && budget < RPC_READ_TIMEOUT_MS)) {
        // A pruned block, or a read that ran out the time the budget allowed, is the budget spent.
        bindingLost = true;
      } else return noRead();
    }
  }

  const deferring = deferringSiblings(entry, context.liveSiblings);
  let attributable: [string, number] | undefined;
  let candidate: [string, number] | undefined;
  for (const [noteId, block] of onChain) {
    const blockers = noteBlockers(noteId, others);
    if (deferring.length > 0 && blockers.every(blocker => deferring.includes(blocker))) candidate ??= [noteId, block];
    else if (blockers.length === 0) attributable ??= [noteId, block];
  }

  if (offInitial && attributable === undefined && spend === undefined) {
    // The one-off read, while E has no landing mark (a candidate note is not one): X once the tip passed it,
    // otherwise the reference block. Skipped without budget, which only withholds a proof.
    const block = expiration !== undefined && tip.blockNum >= expiration ? expiration : entry.refBlock;
    const budget = bindingBudgetMs(tip.blockNum, block, reads.cadenceMs);
    if (budget > 0) {
      const read = await reads.node.account(row.accountId, block, budget);
      if (read.ok) accountReads.push(read.state);
      // A pruned block, or a read that ran out the time the budget allowed, is no time left: it only withholds a
      // proof. Any other failure is retried next pass, except beside a candidate note: the read cannot change its
      // verdict, and a no-read would drop its hold and let Retry offer a second payment.
      else if (candidate === undefined && !read.pruned && !(read.timedOut && budget < RPC_READ_TIMEOUT_MS)) {
        return noRead();
      }
    }
  }

  // Checked again after the reads: nothing is written for E unless both checks pass, so a pass on another chain
  // leaves no seen block a later pass could use.
  const after = await reads.node.blockCommitment(entry.refBlock);
  if (after !== entry.refBlockCommitment) return noRead();

  const seenBlocks = accountReads
    .filter(state => state.commitment === entry.initialCommitment)
    .map(state => state.blockNum);
  const earliestSeen = seenBlocks.length > 0 ? Math.min(...seenBlocks) : undefined;
  const initialSeenAtBlock =
    earliestSeen !== undefined && (entry.initialSeenAtBlock === undefined || earliestSeen < entry.initialSeenAtBlock)
      ? earliestSeen
      : undefined;
  const seenEver = entry.initialSeenAtBlock !== undefined || earliestSeen !== undefined;
  // S-1: a strictly greater nonce, or E.initial seen on chain and gone now.
  const pastInitial =
    (tip.nonce !== undefined && BigInt(tip.nonce) > BigInt(entry.initialNonce)) || (seenEver && offInitial);
  const judged = {
    attemptId: entry.attemptId,
    readsFailed: false,
    ...(otherNetworkSince === undefined ? {} : { otherNetworkSince }),
    ...(initialSeenAtBlock === undefined ? {} : { initialSeenAtBlock })
  };

  const landsByAccount = moved && !sameFinalElsewhere(entry.finalCommitment, others);
  const finalRead = accountReads.find(state => state.commitment === entry.finalCommitment);
  const row1 =
    landsByAccount &&
    entry.outputNoteIds.length === 0 &&
    entry.nullifiers.length === 0 &&
    (finalRead !== undefined || recordedByAccount);
  const row3 =
    landsByAccount &&
    spend !== undefined &&
    (atSpend?.commitment === entry.finalCommitment || (recordedByAccount && entry.landingSeenAtBlock === spend.height));

  // Row 3 outranks row 1 and row 2 for the record: only an account read lets rows 1 and 3 accept a record later.
  const landingRecord: { block: number; by: 1 | 2 | 3 } | undefined =
    row3 && spend !== undefined
      ? { block: spend.height, by: 3 }
      : row1 && finalRead !== undefined
        ? { block: finalRead.blockNum, by: 1 }
        : attributable !== undefined
          ? { block: attributable[1], by: 2 }
          : candidate !== undefined
            ? { block: candidate[1], by: 2 }
            : undefined;
  const withRecord = { ...judged, ...(landingRecord === undefined ? {} : { landingRecord }) };
  if (row1) {
    const proof: LandingProof = { kind: 'commitment' };
    return { ...withRecord, result: deferralHolds(entry, proof, others) ? 'deferred' : 'landed', proof };
  }
  if (attributable !== undefined)
    return { ...withRecord, result: 'landed', proof: { kind: 'note', noteId: attributable[0] } };
  if (row3 && spend !== undefined) {
    const proof: LandingProof = {
      kind: 'nullifier',
      nullifier: spend.nullifier,
      finalCommitment: entry.finalCommitment
    };
    return { ...withRecord, result: deferralHolds(entry, proof, others) ? 'deferred' : 'landed', proof };
  }
  // A candidate note might still turn out to be a live sibling's: rows 4 to 9 are not evaluated for it.
  if (candidate !== undefined) return { ...withRecord, result: 'deferred' };

  if (moved && expiration !== undefined) {
    const expired = accountReads.some(
      state =>
        state.blockNum >= expiration && (state.commitment === undefined || state.commitment === entry.initialCommitment)
    );
    if (expired) return { ...withRecord, result: 'never-committed' };
  }
  if (moved) {
    const superseded = accountReads.some(
      state =>
        state.nonce !== undefined &&
        BigInt(state.nonce) === BigInt(entry.initialNonce) + 1n &&
        state.commitment !== undefined &&
        state.commitment !== entry.finalCommitment
    );
    if (superseded) return { ...withRecord, result: 'never-committed' };
  }
  if (moved && spend !== undefined) {
    const spentElsewhere =
      (atSpend !== undefined && atSpend.blockNum >= spend.height && atSpend.commitment === entry.initialCommitment) ||
      (spend.height <= tip.blockNum && tip.commitment === entry.initialCommitment);
    if (spentElsewhere) return { ...withRecord, result: 'never-committed' };
    if (bindingLost) return { ...withRecord, result: 'unresolvable' };
  }
  return { ...withRecord, result: pastInitial ? 'unresolvable' : 'pending' };
}

const ruledOutFor = (
  entry: ISubmitEvidence,
  proof: LandingProof,
  verdictOf: (entry: ISubmitEvidence) => string | undefined
): boolean => {
  if (verdictOf(entry) === 'never-committed' || entry.preSubmitEnd === true) return true;
  if (proof.kind === 'note') return entry.outputNoteIds !== undefined && !entry.outputNoteIds.includes(proof.noteId);
  if (proof.kind === 'nullifier') {
    return (
      (entry.nullifiers !== undefined && !entry.nullifiers.includes(proof.nullifier)) ||
      (entry.finalCommitment !== undefined && entry.finalCommitment !== proof.finalCommitment)
    );
  }
  return false;
};

const matchesProof = (entry: ISubmitEvidence, proof: LandingProof): boolean => {
  if (proof.kind === 'note') return entry.outputNoteIds?.includes(proof.noteId) === true;
  if (proof.kind === 'nullifier') {
    return (
      entry.nullifiers?.includes(proof.nullifier) === true &&
      entry.finalCommitment === proof.finalCommitment &&
      entry.finalCommitment !== entry.initialCommitment
    );
  }
  return false;
};

/**
 * The id a landing names: only when exactly one entry matches the proof and every other entry is ruled out. Row 1
 * never binds, because a transaction with the same effect from the same pre-state reaches the same commitment.
 */
const bindingFor = (
  proof: LandingProof,
  entries: readonly ISubmitEvidence[],
  verdictOf: (entry: ISubmitEvidence) => string | undefined
): string | undefined => {
  if (proof.kind === 'commitment') return undefined;
  const matching = entries.filter(entry => matchesProof(entry, proof));
  if (matching.length !== 1) return undefined;
  const [match] = matching;
  if (match === undefined || !entries.every(entry => entry === match || ruledOutFor(entry, proof, verdictOf)))
    return undefined;
  return match.transactionId;
};

export async function judgeSubmitEvidence(row: ITransaction, reads: VerdictReads): Promise<RowJudgement> {
  const judgedEntries = [...(row.submitEvidence ?? [])];
  const others = accountOthers(row, reads.accountRows);
  const liveSiblings = others.filter(isLiveSibling);
  let tipBlock: number | undefined;
  const tip = async (): Promise<AccountRead> => {
    const read = await reads.node.account(row.accountId, undefined, RPC_READ_TIMEOUT_MS);
    if (read.ok) tipBlock = read.state.blockNum;
    return read;
  };

  const entries: EntryJudgement[] = [];
  for (const entry of judgedEntries) {
    if (!isCheckable(entry, reads.nowSec)) continue;
    entries.push(await judgeEntry(entry, { row, others, liveSiblings, reads, tip }));
  }

  const verdictOf = (entry: ISubmitEvidence): string | undefined =>
    entries.find(judgement => judgement.attemptId === entry.attemptId)?.result ?? entry.verdict;
  const landedJudgement = entries.find(judgement => judgement.result === 'landed' && judgement.proof !== undefined);
  const allDead =
    landedJudgement === undefined &&
    judgedEntries.some(entry => verdictOf(entry) === 'never-committed') &&
    judgedEntries.every(
      entry => entry.preSubmitEnd === true || (isProvable(entry) && verdictOf(entry) === 'never-committed')
    );
  const landingHeld =
    entries.some(judgement => judgement.result === 'deferred') ||
    entries.some(
      judgement =>
        judgement.readsFailed &&
        judgedEntries.find(entry => entry.attemptId === judgement.attemptId)?.landingSeenAtBlock !== undefined
    );

  return {
    rowId: row.id,
    judgedEntries,
    entries,
    ...(landedJudgement?.proof === undefined
      ? {}
      : {
          landed: {
            attemptId: landedJudgement.attemptId,
            proof: landedJudgement.proof,
            boundTransactionId: bindingFor(landedJudgement.proof, judgedEntries, verdictOf)
          }
        }),
    allDead,
    landingHeld,
    ...(tipBlock === undefined ? {} : { tipBlock })
  };
}

// Pure row predicates for unknown-outcome submits (#1081). A leaf on purpose: constants.ts, get.ts, initiate.ts and
// the claim readers import it, and retry.ts imports those, so living in retry.ts would close an import cycle of the
// kind the service-worker bundle has deadlocked on before (back/transaction-processor.ts).
import {
  IBridgedSendExtraInputs,
  ISubmitEvidence,
  ITransaction,
  ITransactionStatus,
  ITransactionType,
  SubmitEvidenceFields,
  SubmitEvidenceSource
} from '../db/types';

/** Retry's types (`REQUEUEABLE_TYPES` in retry.ts); a bridged-send only on the Agglayer route. */
const VERDICT_TYPES: ReadonlySet<ITransactionType> = new Set<ITransactionType>([
  'send',
  'consume',
  'swap',
  'execute',
  'bridged-send'
]);

/** The Guardian's production grace for a pending candidate. */
export const GUARDIAN_PENDING_HOLD_SEC = 600;
/** How long an entry recorded on another network stays checkable. */
export const OTHER_NETWORK_GIVE_UP_SEC = 24 * 60 * 60;

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export type VerdictRow = Pick<
  ITransaction,
  'type' | 'extraInputs' | 'restoredFromBackup' | 'rotationFunding' | 'status' | 'neverCommittedAt' | 'submitEvidence'
>;

/**
 * Whether a row may wait for the node's verdict (#1081). Structural Guardian ops, earn deposits and Epoch bridges
 * keep today's Failed tail: their heals or awaiting callers need a terminal answer. A restored row is a record, never
 * work, and a rotation-funding claim has no Unconfirmed state in the rotation gate.
 */
export const canAwaitVerdict = (
  tx: Pick<ITransaction, 'type' | 'extraInputs' | 'restoredFromBackup' | 'rotationFunding'>
): boolean => {
  if (!VERDICT_TYPES.has(tx.type)) return false;
  if (tx.restoredFromBackup === true || tx.rotationFunding === true) return false;
  if (tx.type !== 'bridged-send') return true;
  const extra: IBridgedSendExtraInputs | undefined = tx.extraInputs;
  return extra?.provider === 'agglayer';
};

export type ProvableEvidence = ISubmitEvidence &
  Required<
    Pick<
      ISubmitEvidence,
      | 'transactionId'
      | 'initialCommitment'
      | 'finalCommitment'
      | 'initialNonce'
      | 'outputNoteIds'
      | 'nullifiers'
      | 'refBlock'
      | 'refBlockCommitment'
    >
  >;

/** Every field a verdict reads is present; the expiration is optional (without it only rows 5 and 6 prove death). */
export const isProvable = (entry: ISubmitEvidence): entry is ProvableEvidence =>
  entry.transactionId !== undefined &&
  entry.initialCommitment !== undefined &&
  entry.finalCommitment !== undefined &&
  entry.initialNonce !== undefined &&
  entry.outputNoteIds !== undefined &&
  entry.nullifiers !== undefined &&
  entry.refBlock !== undefined &&
  entry.refBlockCommitment !== undefined;

/** Provable, unjudged, not retired before its submit, and not more than a day on another network. */
export const isCheckable = (entry: ISubmitEvidence, nowSec: number): entry is ProvableEvidence =>
  isProvable(entry) &&
  entry.verdict === undefined &&
  entry.preSubmitEnd !== true &&
  (entry.otherNetworkSince === undefined || nowSec - entry.otherNetworkSince <= OTHER_NETWORK_GIVE_UP_SEC);

/** The reconciler's set: Unconfirmed or Failed, eligible, and not already marked safe. */
export const isInVerdictSet = (row: VerdictRow): boolean =>
  (row.status === ITransactionStatus.Unconfirmed || row.status === ITransactionStatus.Failed) &&
  canAwaitVerdict(row) &&
  row.neverCommittedAt === undefined;

/** The reconciler will still judge this row: it is in the set and holds a checkable entry. */
export const awaitingVerdict = (row: VerdictRow, nowSec: number = nowSeconds()): boolean =>
  isInVerdictSet(row) && (row.submitEvidence ?? []).some(entry => isCheckable(entry, nowSec));

/**
 * The only definition of a claim holding its notes: only a verdict can release them, so a consume the reconciler
 * will never judge (restored, rotation funding, marked safe, nothing checkable left) holds nothing.
 */
export const holdsNotes = (row: VerdictRow, nowSec?: number): boolean =>
  row.type === 'consume' && awaitingVerdict(row, nowSec);

/** The hold's complement for claims: a Failed or Unconfirmed consume whose notes a fresh claim may take. */
export const isFailedClaim = (row: VerdictRow, nowSec?: number): boolean =>
  row.type === 'consume' &&
  (row.status === ITransactionStatus.Failed || row.status === ITransactionStatus.Unconfirmed) &&
  !holdsNotes(row, nowSec);

export type NotConfirmedHintKey =
  | 'transactionNotConfirmedHint'
  | 'transactionUndeterminedHint'
  | 'transactionRestoredHint';

/**
 * The not-confirmed hint (#1081): "it may still complete" only while the reconciler still judges the row; a restored
 * row is never judged and Retry refuses it, so its copy offers no retry; any other row the reconciler does not judge
 * (every entry unresolvable, evidence-less, a day on another network, or a #1250 row from before this change) says
 * the wallet is not checking it. The 'Not confirmed' label and pill stay for all three.
 */
export const notConfirmedHintKey = (row: VerdictRow, nowSec?: number): NotConfirmedHintKey => {
  if (awaitingVerdict(row, nowSec)) return 'transactionNotConfirmedHint';
  return row.restoredFromBackup === true ? 'transactionRestoredHint' : 'transactionUndeterminedHint';
};

/** Not proven dead and not retired before its submit: this attempt may still have landed. */
export const isUnresolvedEntry = (entry: ISubmitEvidence): boolean =>
  entry.verdict !== 'never-committed' && entry.preSubmitEnd !== true;

/** The row's latest attempt entry; entries are appended in attempt order. */
export const latestEntry = (row: Pick<ITransaction, 'submitEvidence'>): ISubmitEvidence | undefined => {
  const entries = row.submitEvidence ?? [];
  return entries[entries.length - 1];
};

/**
 * When Retry's Guardian hold clears (#1081): the latest `capturedAt + GUARDIAN_PENDING_HOLD_SEC` over the entries
 * whose candidate the Guardian may still hold, while that is still ahead. A capture ahead of the clock means the
 * clock stepped back since, so the candidate's age is unknown; it is not held, because an unbounded hold would strand
 * the row, and the Guardian's pending-delta conflict still stops a second proposal.
 */
export const keptCandidateHoldUntil = (
  row: Pick<ITransaction, 'submitEvidence'>,
  nowSec: number
): number | undefined => {
  let until: number | undefined;
  for (const entry of row.submitEvidence ?? []) {
    if (entry.candidateKept !== true || entry.capturedAt > nowSec) continue;
    const clears = entry.capturedAt + GUARDIAN_PENDING_HOLD_SEC;
    if (clears > nowSec && (until === undefined || clears > until)) until = clears;
  }
  return until;
};

export interface EvidencePatch {
  source: SubmitEvidenceSource;
  evidence?: SubmitEvidenceFields;
  guardianProposalNonce?: number;
  fromExecute?: boolean;
  endedBy?: 'kill' | 'out-of-band';
  raisedFlag?: true;
  candidateKept?: true;
  preSubmitEnd?: true;
}

/**
 * Upsert the entry of `attemptId` (#1081). Evidence fills what the entry lacks; an id never changes once set, because
 * an attempt submits at most one transaction and its stamp precedes any error text about it, so evidence naming
 * another id is a contradiction: logged, not recorded. The first end wins, and `fromExecute` and `preSubmitEnd` are
 * sticky. `raisedFlag` is honoured only when the pin creates the entry.
 */
export function upsertEvidenceEntry(
  entries: readonly ISubmitEvidence[] | undefined,
  attemptId: string,
  patch: EvidencePatch,
  nowSec: number
): ISubmitEvidence[] {
  const list = [...(entries ?? [])];
  const index = list.findIndex(entry => entry.attemptId === attemptId);
  const current = index === -1 ? undefined : list[index];
  const evidence = patch.evidence ?? {};
  if (
    current?.transactionId !== undefined &&
    evidence.transactionId !== undefined &&
    current.transactionId !== evidence.transactionId
  ) {
    console.warn(
      `[submit-evidence] attempt ${attemptId} already names ${current.transactionId}; not recording ${evidence.transactionId}`
    );
    return list;
  }
  const next: ISubmitEvidence =
    current === undefined ? { attemptId, capturedAt: nowSec, source: patch.source } : { ...current };
  if (next.transactionId === undefined && evidence.transactionId !== undefined) {
    next.transactionId = evidence.transactionId;
  }
  if (next.initialCommitment === undefined && evidence.initialCommitment !== undefined) {
    next.initialCommitment = evidence.initialCommitment;
  }
  if (next.finalCommitment === undefined && evidence.finalCommitment !== undefined) {
    next.finalCommitment = evidence.finalCommitment;
  }
  if (next.initialNonce === undefined && evidence.initialNonce !== undefined) next.initialNonce = evidence.initialNonce;
  if (next.outputNoteIds === undefined && evidence.outputNoteIds !== undefined) {
    next.outputNoteIds = evidence.outputNoteIds;
  }
  if (next.nullifiers === undefined && evidence.nullifiers !== undefined) next.nullifiers = evidence.nullifiers;
  if (next.refBlock === undefined && evidence.refBlock !== undefined) next.refBlock = evidence.refBlock;
  if (next.refBlockCommitment === undefined && evidence.refBlockCommitment !== undefined) {
    next.refBlockCommitment = evidence.refBlockCommitment;
  }
  if (next.expirationBlock === undefined && evidence.expirationBlock !== undefined) {
    next.expirationBlock = evidence.expirationBlock;
  }
  if (next.guardianProposalNonce === undefined && patch.guardianProposalNonce !== undefined) {
    next.guardianProposalNonce = patch.guardianProposalNonce;
  }
  if (patch.fromExecute === true) next.fromExecute = true;
  if (patch.endedBy !== undefined && next.endedBy === undefined) {
    next.endedBy = patch.endedBy;
    next.endedAt = nowSec;
  }
  if (patch.raisedFlag === true && current === undefined) next.raisedFlag = true;
  if (patch.candidateKept === true) next.candidateKept = true;
  if (patch.preSubmitEnd === true) next.preSubmitEnd = true;
  if (index === -1) list.push(next);
  else list[index] = next;
  return list;
}

// Fixed field order, so two writers that built the same entry in different key orders still compare equal.
const canonicalEntry = (entry: ISubmitEvidence): unknown[] => [
  entry.attemptId,
  entry.capturedAt,
  entry.source,
  entry.transactionId ?? null,
  entry.initialCommitment ?? null,
  entry.finalCommitment ?? null,
  entry.initialNonce ?? null,
  entry.outputNoteIds ?? null,
  entry.nullifiers ?? null,
  entry.refBlock ?? null,
  entry.refBlockCommitment ?? null,
  entry.expirationBlock ?? null,
  entry.guardianProposalNonce ?? null,
  entry.candidateKept ?? null,
  entry.otherNetworkSince ?? null,
  entry.verdict ?? null,
  entry.endedBy ?? null,
  entry.endedAt ?? null,
  entry.preSubmitEnd ?? null,
  entry.raisedFlag ?? null,
  entry.fromExecute ?? null
];

/**
 * The entries' evidence as one comparable string, the seen fields aside (`initialSeenAtBlock`, `landingSeenAtBlock`,
 * `landingSeenBy`): only the verdict lock's holder writes those, so recording a seen block never voids its own next
 * write (#1081).
 */
export const evidenceKey = (entries: readonly ISubmitEvidence[] | undefined): string =>
  JSON.stringify((entries ?? []).map(canonicalEntry));

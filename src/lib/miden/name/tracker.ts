/**
 * Miden Name registration tracker.
 *
 * One pass (`reconcileMidenNameRegistrations`) moves each non-terminal
 * `register-name` row of the effective network one step forward:
 *
 *   1. register row Failed                      → failed / tx-failed
 *   2. register row Completed, phase submitted  → read the register note state:
 *      (or requested, see `phaseOf`)              consumed + issued → issued
 *                                                 discarded         → failed / taken or discarded
 *                                                 not consumed and tip > reclaimHeight → failed / expired
 *   3. issued   → find the delivery note, queue a consume of it → claiming
 *   4. claiming → claim row Completed → owned; claim row Failed → issued
 *
 * The tracker uses RPC reads and Dexie only. It does not call `syncState()` and
 * it does not take the WASM client lock itself: only
 * `initiateConsumeTransactionFromId` takes it, for one note read. Every RPC in
 * `./reads` has a time limit (`withRpcTimeout`). An error on one row does not
 * stop the pass.
 */

import { compareAccountIds } from 'lib/miden/activity/utils';
import {
  IConsumeMidenNameExtraInputs,
  IMidenNameClaimLink,
  IRegisterNameExtraInputs,
  isLiveTransaction,
  ITransaction,
  ITransactionStatus,
  MidenNameFailure,
  MidenNamePhase
} from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { patchRegisterNameExtraInputs, promoteLandedRegisterNameRow } from 'lib/miden/transaction/complete';
import { initiateConsumeTransactionFromId, tagConsumeAsMidenNameClaim } from 'lib/miden/transaction/initiate';
import { awaitingVerdict } from 'lib/miden/transaction/verdict-rules';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { isDelegateProofEnabled } from 'lib/settings/helpers';

import { isMidenNameSupported } from './config';
import {
  type RegistrationNoteState,
  fetchMidenNameIssued,
  fetchRegistrationNoteState,
  findRegistryDeliveryNoteIds,
  getChainTip
} from './reads';
import { isLiveRegistrationRow, phaseOf, registerNameInputsOf } from './registrations';
import { fetchDomainRecordAccount } from './resolver';

const LOG_PREFIX = '[miden-name]';
const MAX_CLAIM_ATTEMPTS = 3;

export interface MidenNameTrackerDeps {
  /** Start the transaction loop after the tracker queued a claim consume. */
  startProcessing: () => void;
}

/** State that the rows of one pass share. */
interface PassContext {
  deps: MidenNameTrackerDeps;
  /** The chain tip. Read one time per pass, only when a row needs it. */
  chainTip: () => Promise<number>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNonTerminal(inputs: IRegisterNameExtraInputs): boolean {
  switch (inputs.phase) {
    case 'owned':
    case 'failed':
      return false;
    default:
      return true;
  }
}

/** True for a non-terminal registration row of the network. */
function needsTracking(row: ITransaction, network: string): boolean {
  if (row.type !== 'register-name') return false;
  const inputs = registerNameInputsOf(row);
  return inputs !== undefined && isLiveRegistrationRow(row, network) && isNonTerminal(inputs);
}

/**
 * Do one tracker pass over the non-terminal registrations of all accounts on
 * the effective network. Does nothing when the network has no deployment.
 */
export async function reconcileMidenNameRegistrations(deps: MidenNameTrackerDeps): Promise<void> {
  if (!isMidenNameSupported()) return;
  const network = getEffectiveNetworkName();
  const rows = await Repo.transactions
    .where('type')
    .equals('register-name')
    .filter(row => needsTracking(row, network))
    .toArray();
  if (rows.length === 0) return;

  let tip: Promise<number> | undefined;
  const context: PassContext = {
    deps,
    chainTip: () => {
      if (!tip) {
        tip = getChainTip();
        // A failed read must not stay in the cache for the other rows.
        tip.catch(() => {
          tip = undefined;
        });
      }
      return tip;
    }
  };

  for (const row of rows) {
    try {
      await reconcileRow(row, context);
    } catch (error) {
      console.warn(`${LOG_PREFIX} tracker step failed`, { txId: row.id, error });
    }
  }
}

async function sealFailed(
  rowId: string,
  expectPhase: MidenNamePhase,
  failure: MidenNameFailure,
  lastError?: string
): Promise<void> {
  await patchRegisterNameExtraInputs(
    rowId,
    { phase: 'failed', failure, ...(lastError !== undefined ? { lastError } : {}) },
    { expectPhase }
  );
}

async function sealDiscarded(
  rowId: string,
  expectPhase: MidenNamePhase,
  label: string,
  lastError?: string
): Promise<void> {
  const taken = await fetchMidenNameIssued(label);
  await sealFailed(rowId, expectPhase, taken ? 'taken' : 'discarded', lastError);
}

async function sealExpiredIfPastReclaim(
  rowId: string,
  expectPhase: MidenNamePhase,
  inputs: IRegisterNameExtraInputs,
  context: PassContext,
  lastError?: string,
  checkTaken = true
): Promise<void> {
  const tip = await context.chainTip();
  if (tip <= inputs.reclaimHeight) return;
  const taken = checkTaken ? await fetchMidenNameIssued(inputs.label) : false;
  await sealFailed(rowId, expectPhase, taken ? 'taken' : 'expired', lastError);
}

async function hasSiblingClaimOrOwner(row: ITransaction, inputs: IRegisterNameExtraInputs): Promise<boolean> {
  const siblings = await Repo.transactions
    .where('type')
    .equals('register-name')
    .filter(other => {
      if (other.id === row.id || !isLiveRegistrationRow(other, inputs.network)) return false;
      const otherInputs = registerNameInputsOf(other);
      if (!otherInputs || otherInputs.label !== inputs.label) return false;
      const phase = phaseOf(other);
      return phase === 'issued' || phase === 'claiming' || phase === 'owned';
    })
    .toArray();
  return siblings.length > 0;
}

async function reconcileRow(row: ITransaction, context: PassContext): Promise<void> {
  const inputs = registerNameInputsOf(row);
  if (!inputs) return;

  if (row.status === ITransactionStatus.Failed || row.status === ITransactionStatus.Unconfirmed) {
    await reconcileFailedRow(row, inputs, context);
    return;
  }

  switch (inputs.phase) {
    case 'requested':
    case 'submitted':
      // A Completed row in phase `requested` landed with no result: same as `submitted`.
      if (row.status === ITransactionStatus.Completed) await checkRegisterNote(row, inputs, context);
      return;
    case 'issued':
      await claimDeliveryNote(row, inputs, context);
      return;
    case 'claiming':
      await checkClaim(row, inputs);
      return;
    default:
      return;
  }
}

/**
 * Step 1: verify on-chain state before sealing a Failed or Unconfirmed row, or
 * promote if landed. A row whose verdict is still pending is left to the
 * verdict reconciler.
 */
async function reconcileFailedRow(
  row: ITransaction,
  inputs: IRegisterNameExtraInputs,
  context: PassContext
): Promise<void> {
  if (awaitingVerdict(row)) return;
  const neverSubmitted = !row.mayHaveSubmitted && !row.submitEvidence?.length && row.transactionId === undefined;
  if (row.neverCommittedAt !== undefined || neverSubmitted) {
    await sealFailed(row.id, inputs.phase, 'tx-failed', row.error);
    return;
  }

  const state = await fetchRegistrationNoteState(inputs.registrationNoteId);
  switch (state.status) {
    case 'consumed':
    case 'pending':
    case 'inflight': {
      const promoted = await promoteLandedRegisterNameRow(row.id, {}, { expectPhase: inputs.phase });
      if (!promoted) return;
      await checkRegisterNote(row, promoted, context, state);
      return;
    }
    case 'discarded':
      await sealDiscarded(row.id, inputs.phase, inputs.label, state.lastError ?? row.error);
      return;
    case 'unknown':
      // The builder may not have seen the note of a submit that crossed yet: wait until it can no longer be consumed.
      if ((await context.chainTip()) > inputs.reclaimHeight) {
        await sealFailed(row.id, inputs.phase, 'tx-failed', row.error);
      }
      return;
  }
}

/** Step 2: read the state of the register note. */
async function checkRegisterNote(
  row: ITransaction,
  inputs: IRegisterNameExtraInputs,
  context: PassContext,
  prefetchedState?: RegistrationNoteState
): Promise<void> {
  const expectPhase = inputs.phase;
  const state = prefetchedState ?? (await fetchRegistrationNoteState(inputs.registrationNoteId));
  switch (state.status) {
    case 'consumed': {
      if (await fetchMidenNameIssued(inputs.label)) {
        const owner = await fetchDomainRecordAccount(inputs.label);
        if (
          (owner !== null && !compareAccountIds(owner, row.accountId)) ||
          (await hasSiblingClaimOrOwner(row, inputs))
        ) {
          await sealFailed(row.id, expectPhase, 'taken', state.lastError);
          return;
        }
        await patchRegisterNameExtraInputs(row.id, { phase: 'issued' }, { expectPhase });
        return;
      }
      await sealExpiredIfPastReclaim(row.id, expectPhase, inputs, context, state.lastError, false);
      return;
    }
    case 'discarded':
      await sealDiscarded(row.id, expectPhase, inputs.label, state.lastError);
      return;
    case 'unknown':
      return;
    case 'pending':
    case 'inflight':
      await sealExpiredIfPastReclaim(row.id, expectPhase, inputs, context, state.lastError);
      return;
  }
}

function normalizeNoteId(noteId: string): string {
  return noteId.toLowerCase();
}

/** The consume rows of this account that include a note. */
async function consumeRowsForNote(accountId: string, noteId: string): Promise<ITransaction[]> {
  const normalized = normalizeNoteId(noteId);
  const lookupIds = normalized === noteId ? [noteId] : [noteId, normalized];
  const matched: ITransaction[] = [];
  for (const key of lookupIds) {
    matched.push(...(await Repo.transactions.where('noteId').equals(key).toArray()));
    matched.push(...(await Repo.transactions.where('noteIds').equals(key).toArray()));
  }
  const rows = new Map(matched.map(row => [row.id, row]));
  return [...rows.values()].filter(
    row => row.type === 'consume' && row.restoredFromBackup !== true && compareAccountIds(row.accountId, accountId)
  );
}

function claimForNote(row: ITransaction, noteId: string): IMidenNameClaimLink | undefined {
  const inputs: Partial<IConsumeMidenNameExtraInputs> | undefined = row.extraInputs;
  const normalized = normalizeNoteId(noteId);
  const byNote = inputs?.midenNameClaims?.[normalized];
  if (byNote) return byNote;
  if ((row.noteIds?.length ?? 0) <= 1) return inputs?.midenNameClaim;
  if (inputs?.midenNameClaim && row.noteId !== undefined && normalizeNoteId(row.noteId) === normalized) {
    return inputs.midenNameClaim;
  }
  return undefined;
}

/** The id of the register row that a tagged consume row belongs to for `noteId`. */
function linkedRowIdOf(row: ITransaction, noteId: string): string | undefined {
  return claimForNote(row, noteId)?.registerTxId;
}

function isClaimRowLive(row: ITransaction): boolean {
  return isLiveTransaction(row) || row.status === ITransactionStatus.Completed || awaitingVerdict(row);
}

/**
 * How the delivery scan sees one note. The scan returns only the notes that
 * carry the name NFA of the row's label (`findRegistryDeliveryNoteIds` with
 * `label`), so a consume row of that note with no name tag is a consume of
 * THIS name: the realm closed between the queue of the consume and the write
 * of its tag.
 */
type DeliveryNoteState =
  /** A live consume row of this row claims it. */
  | { kind: 'ours'; claimTxId: string; completed: boolean }
  /** A live consume row with no name tag has it: adopt it. */
  | { kind: 'untagged'; claimTxId: string; completed: boolean }
  /** A live consume row of an other register row has it. */
  | { kind: 'settled' }
  /** No live consume row has it (dead Failed rows do not count). */
  | { kind: 'free' };

function deliveryNoteState(ownerRowId: string, consumeRows: ITransaction[], noteId: string): DeliveryNoteState {
  const live = consumeRows.filter(isClaimRowLive);
  const oursRows = live.filter(row => linkedRowIdOf(row, noteId) === ownerRowId);
  // Prefer a Completed row: the name is already in the account.
  const ours = oursRows.find(row => row.status === ITransactionStatus.Completed) ?? oursRows[0];
  if (ours) {
    return { kind: 'ours', claimTxId: ours.id, completed: ours.status === ITransactionStatus.Completed };
  }
  if (live.length === 0) return { kind: 'free' };
  if (live.some(row => linkedRowIdOf(row, noteId) !== undefined)) return { kind: 'settled' };
  // Prefer a Completed row: the name is already in the account.
  const untagged = live.find(row => row.status === ITransactionStatus.Completed) ?? live[0];
  if (!untagged) return { kind: 'free' };
  return { kind: 'untagged', claimTxId: untagged.id, completed: untagged.status === ITransactionStatus.Completed };
}

async function markClaiming(
  row: ITransaction,
  deliveryNoteId: string,
  claimTxId: string,
  context: PassContext
): Promise<void> {
  const written = await patchRegisterNameExtraInputs(
    row.id,
    { phase: 'claiming', deliveryNoteId, claimTxId },
    { expectPhase: 'issued' }
  );
  if (written) context.deps.startProcessing();
}

async function markClaimOrOwned(
  row: ITransaction,
  deliveryNoteId: string,
  claimTxId: string,
  completed: boolean,
  context: PassContext
): Promise<void> {
  if (completed) {
    await patchRegisterNameExtraInputs(
      row.id,
      { phase: 'owned', deliveryNoteId, claimTxId },
      { expectPhase: 'issued' }
    );
    return;
  }
  await markClaiming(row, deliveryNoteId, claimTxId, context);
}

type ClaimAttemptOutcome = 'done' | 'settled' | 'retry';

async function tryClaimNote(
  row: ITransaction,
  inputs: IRegisterNameExtraInputs,
  noteId: string,
  context: PassContext
): Promise<ClaimAttemptOutcome> {
  const state = deliveryNoteState(row.id, await consumeRowsForNote(row.accountId, noteId), noteId);
  switch (state.kind) {
    case 'ours':
      // A claim was queued, but the phase write did not occur (for example the realm closed).
      await markClaimOrOwned(row, noteId, state.claimTxId, state.completed, context);
      return 'done';
    case 'untagged':
      // A consume of this name's note lost its tag. Adopt it: with no tag the
      // consume completion cannot move this row, and the scan would pass the note.
      if (!(await tagConsumeAsMidenNameClaim(state.claimTxId, inputs.label, row.id, noteId))) {
        return 'retry';
      }
      await markClaimOrOwned(row, noteId, state.claimTxId, state.completed, context);
      return 'done';
    case 'settled':
      return 'settled';
    case 'free':
      return (await startClaim(row, inputs, noteId, context)) ? 'done' : 'retry';
  }
}

/**
 * Step 3: find the note with which the registry delivers the name, and queue a
 * consume of it. The scan is filtered by the label of the row: the registry
 * can deliver the notes of two names in any order.
 *
 * When `deliveryNoteId` is already persisted on the row (for instance on a
 * retry after a failed claim), reuse it without scanning RPC blocks again.
 *
 * `deliveryScanFrom` moves forward only when the scan found no note that can
 * still need a claim. Else the next pass scans the same blocks again, so a
 * delivery note that is found but not claimed is found again.
 */
async function claimDeliveryNote(
  row: ITransaction,
  inputs: IRegisterNameExtraInputs,
  context: PassContext
): Promise<void> {
  if (inputs.deliveryNoteId !== undefined) {
    const outcome = await tryClaimNote(row, inputs, inputs.deliveryNoteId, context);
    if (outcome !== 'settled') return;
  }

  const fromBlock = inputs.deliveryScanFrom ?? inputs.builtAtBlock;
  const scan = await findRegistryDeliveryNoteIds({ accountId: row.accountId, fromBlock, label: inputs.label });

  let canAdvance = true;
  for (const noteId of scan.noteIds) {
    const outcome = await tryClaimNote(row, inputs, noteId, context);
    if (outcome === 'done') return;
    if (outcome === 'retry') canAdvance = false;
  }

  if (canAdvance && scan.scannedTo + 1 > fromBlock) {
    await patchRegisterNameExtraInputs(row.id, { deliveryScanFrom: scan.scannedTo + 1 }, { expectPhase: 'issued' });
  }
}

/**
 * Queue a consume of one delivery note. Returns true when the registration
 * moved to `claiming` or `owned`.
 */
async function startClaim(
  row: ITransaction,
  inputs: IRegisterNameExtraInputs,
  noteId: string,
  context: PassContext
): Promise<boolean> {
  let claimTxId: string;
  try {
    claimTxId = await initiateConsumeTransactionFromId(
      row.accountId,
      noteId,
      isDelegateProofEnabled(),
      false,
      undefined,
      undefined,
      { label: inputs.label, registerTxId: row.id }
    );
  } catch (error) {
    // "not found": the local store did not import the note yet. The next pass tries again.
    const message = errorMessage(error);
    if (message.toLowerCase().includes('not found')) {
      console.info(`${LOG_PREFIX} delivery note is not in the local store yet`, { txId: row.id, noteId });
    } else {
      console.warn(`${LOG_PREFIX} could not queue the claim`, { txId: row.id, noteId, error });
    }
    return false;
  }

  // The consume queue can give the id of an earlier Failed row (retry backoff).
  // Do not link a dead Failed row: the next pass tries again.
  const claimRow = await Repo.transactions.where({ id: claimTxId }).first();
  if (!claimRow || claimRow.type !== 'consume') return false;
  if (claimRow.status === ITransactionStatus.Failed && !awaitingVerdict(claimRow)) return false;
  const existingClaim = claimForNote(claimRow, noteId);
  if (existingClaim && existingClaim.registerTxId !== row.id) return false;
  if (!existingClaim && !(await tagConsumeAsMidenNameClaim(claimTxId, inputs.label, row.id, noteId))) {
    return false;
  }

  await markClaimOrOwned(row, noteId, claimTxId, claimRow.status === ITransactionStatus.Completed, context);
  return true;
}

async function handleClaimFailure(rowId: string, inputs: IRegisterNameExtraInputs, lastError: string): Promise<void> {
  const claimAttempts = (inputs.claimAttempts ?? 0) + 1;
  if (claimAttempts >= MAX_CLAIM_ATTEMPTS) {
    await patchRegisterNameExtraInputs(
      rowId,
      { phase: 'failed', failure: 'claim-failed', claimAttempts, lastError },
      { expectPhase: 'claiming' }
    );
    return;
  }
  await patchRegisterNameExtraInputs(rowId, { phase: 'issued', claimAttempts, lastError }, { expectPhase: 'claiming' });
}

/** Step 4: follow the claim consume row. */
async function checkClaim(row: ITransaction, inputs: IRegisterNameExtraInputs): Promise<void> {
  const claimRow = inputs.claimTxId ? await Repo.transactions.where({ id: inputs.claimTxId }).first() : undefined;
  if (!claimRow) {
    await handleClaimFailure(row.id, inputs, 'The claim transaction is missing');
    return;
  }
  if (claimRow.status === ITransactionStatus.Completed) {
    await patchRegisterNameExtraInputs(row.id, { phase: 'owned' }, { expectPhase: 'claiming' });
    return;
  }
  if (isLiveTransaction(claimRow) || awaitingVerdict(claimRow)) {
    return;
  }
  await handleClaimFailure(row.id, inputs, claimRow.error ?? 'The claim transaction failed');
}

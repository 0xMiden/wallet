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
  IRegisterNameExtraInputs,
  ITransaction,
  ITransactionStatus
} from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { patchRegisterNameExtraInputs } from 'lib/miden/transaction/complete';
import { initiateConsumeTransactionFromId, tagConsumeAsMidenNameClaim } from 'lib/miden/transaction/initiate';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { isDelegateProofEnabled } from 'lib/settings/helpers';

import { isMidenNameSupported } from './config';
import { fetchMidenNameIssued, fetchRegistrationNoteState, findRegistryDeliveryNoteIds, getChainTip } from './reads';
import { isLiveRegistrationRow, registerNameInputsOf } from './registrations';

const LOG_PREFIX = '[miden-name]';

export interface MidenNameTrackerDeps {
  /** Start the transaction loop after the tracker queued a claim consume. */
  startProcessing: () => void;
  /** Clock (ms since epoch). Tests replace it. The default is `Date.now`. */
  now?: () => number;
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

/**
 * Do one tracker pass over the non-terminal registrations of all accounts on
 * the effective network. Does nothing when the network has no deployment.
 */
export async function reconcileMidenNameRegistrations(deps: MidenNameTrackerDeps): Promise<void> {
  if (!isMidenNameSupported()) return;
  const network = getEffectiveNetworkName();
  const rows = await Repo.transactions
    .filter(row => {
      const inputs = registerNameInputsOf(row);
      return inputs !== undefined && isLiveRegistrationRow(row, network) && isNonTerminal(inputs);
    })
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

async function reconcileRow(row: ITransaction, context: PassContext): Promise<void> {
  const inputs = registerNameInputsOf(row);
  if (!inputs) return;

  if (row.status === ITransactionStatus.Failed) {
    await patchRegisterNameExtraInputs(
      row.id,
      { phase: 'failed', failure: 'tx-failed', ...(row.error ? { lastError: row.error } : {}) },
      { expectPhase: inputs.phase }
    );
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

/** Step 2: read the state of the register note. */
async function checkRegisterNote(
  row: ITransaction,
  inputs: IRegisterNameExtraInputs,
  context: PassContext
): Promise<void> {
  const expectPhase = inputs.phase;
  const state = await fetchRegistrationNoteState(inputs.registrationNoteId);
  switch (state.status) {
    case 'consumed': {
      // The registry consumed the note. Wait until the issued status is visible.
      if (await fetchMidenNameIssued(inputs.label)) {
        await patchRegisterNameExtraInputs(row.id, { phase: 'issued' }, { expectPhase });
      }
      return;
    }
    case 'discarded': {
      const taken = await fetchMidenNameIssued(inputs.label);
      await patchRegisterNameExtraInputs(
        row.id,
        {
          phase: 'failed',
          failure: taken ? 'taken' : 'discarded',
          ...(state.lastError !== undefined ? { lastError: state.lastError } : {})
        },
        { expectPhase }
      );
      return;
    }
    case 'pending':
    case 'inflight':
    case 'unknown': {
      const tip = await context.chainTip();
      if (tip > inputs.reclaimHeight) {
        await patchRegisterNameExtraInputs(
          row.id,
          {
            phase: 'failed',
            failure: 'expired',
            ...(state.lastError !== undefined ? { lastError: state.lastError } : {})
          },
          { expectPhase }
        );
      }
      return;
    }
  }
}

/** The consume rows of this account that include a note. */
async function consumeRowsForNote(accountId: string, noteId: string): Promise<ITransaction[]> {
  const byScalar = await Repo.transactions.where('noteId').equals(noteId).toArray();
  const byBatch = await Repo.transactions.where('noteIds').equals(noteId).toArray();
  const rows = new Map([...byScalar, ...byBatch].map(row => [row.id, row]));
  return [...rows.values()].filter(
    row => row.type === 'consume' && row.restoredFromBackup !== true && compareAccountIds(row.accountId, accountId)
  );
}

function claimOf(row: ITransaction): IConsumeMidenNameExtraInputs['midenNameClaim'] | undefined {
  const inputs: Partial<IConsumeMidenNameExtraInputs> | undefined = row.extraInputs;
  return inputs?.midenNameClaim;
}

/** How the delivery scan sees one delivery note. */
type DeliveryNoteState =
  /** A live consume row of this registration claims it. */
  | { kind: 'ours'; claimTxId: string }
  /** A Completed consume row or a live claim of an other registration has it. */
  | { kind: 'settled' }
  /** A live consume row with no claim tag has it. It can still fail. */
  | { kind: 'busy' }
  /** No live consume row has it (Failed rows do not count). */
  | { kind: 'free' };

function deliveryNoteState(registerTxId: string, consumeRows: ITransaction[]): DeliveryNoteState {
  const live = consumeRows.filter(row => row.status !== ITransactionStatus.Failed);
  const ours = live.find(row => claimOf(row)?.registerTxId === registerTxId);
  if (ours) return { kind: 'ours', claimTxId: ours.id };
  if (live.length === 0) return { kind: 'free' };
  const settled = live.some(row => row.status === ITransactionStatus.Completed || claimOf(row) !== undefined);
  return settled ? { kind: 'settled' } : { kind: 'busy' };
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

/**
 * Step 3: find the note with which the registry delivers the name, and queue a
 * consume of it.
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
  const fromBlock = inputs.deliveryScanFrom ?? inputs.builtAtBlock;
  const scan = await findRegistryDeliveryNoteIds({ accountId: row.accountId, fromBlock });

  let canAdvance = true;
  for (const noteId of scan.noteIds) {
    const state = deliveryNoteState(row.id, await consumeRowsForNote(row.accountId, noteId));
    switch (state.kind) {
      case 'ours':
        // A claim was queued, but the phase write did not occur (for example the realm closed).
        await markClaiming(row, noteId, state.claimTxId, context);
        return;
      case 'settled':
        continue;
      case 'busy':
        canAdvance = false;
        continue;
      case 'free':
        canAdvance = false;
        if (await startClaim(row, inputs, noteId, context)) return;
        continue;
    }
  }

  if (canAdvance && scan.scannedTo + 1 > fromBlock) {
    await patchRegisterNameExtraInputs(row.id, { deliveryScanFrom: scan.scannedTo + 1 }, { expectPhase: 'issued' });
  }
}

/**
 * Queue a consume of one delivery note. Returns true when the registration
 * moved to `claiming`.
 */
async function startClaim(
  row: ITransaction,
  inputs: IRegisterNameExtraInputs,
  noteId: string,
  context: PassContext
): Promise<boolean> {
  let claimTxId: string;
  try {
    claimTxId = await initiateConsumeTransactionFromId(row.accountId, noteId, isDelegateProofEnabled(), false);
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
  // Do not link a Failed row: the next pass tries again.
  const claimRow = await Repo.transactions.where({ id: claimTxId }).first();
  if (!claimRow || claimRow.status === ITransactionStatus.Failed) return false;
  const existingClaim = claimOf(claimRow);
  if (existingClaim && existingClaim.registerTxId !== row.id) return false;

  await tagConsumeAsMidenNameClaim(claimTxId, inputs.label, row.id);
  await markClaiming(row, noteId, claimTxId, context);
  return true;
}

/** Step 4: follow the claim consume row. */
async function checkClaim(row: ITransaction, inputs: IRegisterNameExtraInputs): Promise<void> {
  const claimRow = inputs.claimTxId ? await Repo.transactions.where({ id: inputs.claimTxId }).first() : undefined;
  if (!claimRow) {
    await patchRegisterNameExtraInputs(
      row.id,
      { phase: 'issued', lastError: 'The claim transaction is missing' },
      { expectPhase: 'claiming' }
    );
    return;
  }
  switch (claimRow.status) {
    case ITransactionStatus.Completed:
      await patchRegisterNameExtraInputs(row.id, { phase: 'owned' }, { expectPhase: 'claiming' });
      return;
    case ITransactionStatus.Failed:
      await patchRegisterNameExtraInputs(
        row.id,
        { phase: 'issued', lastError: claimRow.error ?? 'The claim transaction failed' },
        { expectPhase: 'claiming' }
      );
      return;
    default:
      return;
  }
}

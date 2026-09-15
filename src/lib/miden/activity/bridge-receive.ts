import { midenAddrToEvmAddr } from 'lib/agglayer/contract';
import { fetchDeposits, isAgglayerDepositReady } from 'lib/agglayer/status';
import * as Repo from 'lib/miden/repo';
import { waitForSepoliaReceipt } from 'lib/walletconnect/receipt';

import { registerPendingBridgeIn, resolveBridgeInNoteId } from './bridge-in';
import { IBridgedReceiveExtraInputs, ITransaction } from '../db/types';
import { updateBridgedReceivePhase } from '../transaction/complete';

const BRIDGE_RECEIVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const SUBMISSION_LOCK = 'bridge-receive-submission';

/**
 * A restored bridge row's delivery cannot be confirmed: the tracking state that
 * would resume it lives outside the dump, and the row's own contents are only as
 * trustworthy as the file they came from. If the bridged note really did land,
 * normal sync surfaces it on its own — this row is just the tracker.
 */
const RESTORED_BRIDGE_UNVERIFIABLE = 'Restored from a backup — delivery could not be verified.';

export interface BridgeReceiveLockManager {
  request(
    name: string,
    options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
    callback: (lock: object | null) => Promise<void>
  ): Promise<void>;
}

const getNavigatorLocks = (): BridgeReceiveLockManager | undefined =>
  typeof navigator === 'undefined' ? undefined : navigator.locks;

function sameHash(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function firstString(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const value: unknown = Reflect.get(source, key);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function reconcileAgglayerRow(row: ITransaction, inputs: IBridgedReceiveExtraInputs): Promise<void> {
  if (!inputs.evmTxHash) {
    if (inputs.phase === 'submitting') {
      await updateBridgedReceivePhase(row.id, 'failed', {
        error: 'Bridge submission was interrupted before a transaction hash was recorded.'
      });
    }
    return;
  }

  if (inputs.phase === 'submitting') {
    try {
      await waitForSepoliaReceipt(inputs.evmTxHash as `0x${string}`);
      await updateBridgedReceivePhase(row.id, 'delivering');
    } catch (error) {
      await updateBridgedReceivePhase(row.id, 'failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
  }

  try {
    const deposits = await fetchDeposits(midenAddrToEvmAddr(row.accountId));
    const deposit = deposits.find(candidate => sameHash(candidate.tx_hash, inputs.evmTxHash!));
    if (deposit && isAgglayerDepositReady(deposit)) {
      await updateBridgedReceivePhase(row.id, 'ready');
    }
  } catch (error) {
    // Indexer outages are transient. Leave the row pending so the next tick can
    // retry instead of incorrectly failing delivery.
    console.warn('[bridge-receive] AggLayer status poll failed', error);
  }
}

async function reconcileEpochRow(row: ITransaction, inputs: IBridgedReceiveExtraInputs): Promise<void> {
  if (!inputs.intentNonce) {
    if (inputs.phase === 'submitting') {
      await updateBridgedReceivePhase(row.id, 'failed', {
        error: 'Bridge submission was interrupted before an intent was recorded.'
      });
    }
    return;
  }

  await registerPendingBridgeIn(inputs.sourceAddress, inputs.intentNonce, {
    provider: 'epoch',
    sourceAmount: inputs.sourceAmount,
    sourceSymbol: inputs.sourceSymbol,
    intentNonce: inputs.intentNonce,
    evmTxHash: inputs.evmTxHash,
    bridgeReceiveTxId: row.id
  });

  try {
    const { getEpochReadOnlySdk } = await import('lib/epoch/sdk');
    const sdk = await getEpochReadOnlySdk(inputs.sourceAddress as `0x${string}`);
    const results = await sdk.getIntentStatus(inputs.sourceAddress as `0x${string}`, inputs.intentNonce);
    const noteId = results.map(result => firstString(result, 'midenNoteId')).find(Boolean);
    if (noteId) await resolveBridgeInNoteId(inputs.sourceAddress, inputs.intentNonce, noteId);
    const midenLeg = results.find(result => result.chainId === 999999999);
    if (midenLeg && midenLeg.status.toLowerCase() === 'failed') {
      await updateBridgedReceivePhase(row.id, 'failed', { error: 'The Epoch bridge intent failed.' });
    }
  } catch (error) {
    console.warn('[bridge-receive] Epoch reconcile poll failed', error);
  }
}

async function readUnsettledRows(): Promise<ITransaction[]> {
  return Repo.transactions
    .filter(tx => {
      if (tx.type !== 'bridged-receive') return false;
      // Optional-chained: a throw in here rejects the whole `toArray()`, which
      // this function's only caller swallows — so one legacy or partially
      // written row without `extraInputs` would silently disable reconciliation
      // for every genuine row, on every tick.
      const inputs: IBridgedReceiveExtraInputs | undefined = tx.extraInputs;
      return (
        inputs !== undefined && inputs.phase !== 'ready' && inputs.phase !== 'received' && inputs.phase !== 'failed'
      );
    })
    .toArray();
}

/**
 * A deposit screen creates its `bridged-receive` row in phase `submitting` before
 * the EVM wallet signs, and writes the hash (AggLayer) or intent nonce (Epoch)
 * only afterwards. Such a row is an orphan only when the flow that created it is
 * gone, so the flow holds `bridge-receive-submission` in shared mode while it
 * drives the row, and a reconcile pass reads its rows under the same lock taken
 * exclusively with `ifAvailable`: rows read while no flow holds it cannot have a
 * live owner. Web Locks span every page of the origin and are released when a
 * page dies. Without them an in-realm counter stands in for the same rule.
 */
export function createBridgeReceiveReconciler({
  getLocks = getNavigatorLocks
}: {
  getLocks?: () => BridgeReceiveLockManager | undefined;
} = {}) {
  let liveSubmissions = 0;
  let startedSubmissions = 0;

  /** Resolves with the new row's id as soon as `create` returns it; the lock is held until `drive` settles. */
  function startSubmission(create: () => Promise<string>, drive: (txId: string) => Promise<void>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const run = async () => {
        let txId: string;
        try {
          txId = await create();
        } catch (error) {
          reject(error);
          return;
        }
        resolve(txId);
        try {
          await drive(txId);
        } catch (error) {
          console.error('[bridge-receive] deposit submission failed', error);
        }
      };

      const locks = getLocks();
      if (locks) {
        locks.request(SUBMISSION_LOCK, { mode: 'shared' }, run).catch(reject);
        return;
      }
      liveSubmissions += 1;
      startedSubmissions += 1;
      void run().finally(() => {
        liveSubmissions -= 1;
      });
    });
  }

  async function readRows(): Promise<{ rows: ITransaction[]; resumeOrphans: boolean }> {
    const locks = getLocks();
    if (locks) {
      let read: { rows: ITransaction[]; resumeOrphans: boolean } = { rows: [], resumeOrphans: false };
      await locks.request(SUBMISSION_LOCK, { ifAvailable: true }, async lock => {
        read = { rows: await readUnsettledRows(), resumeOrphans: lock !== null };
      });
      return read;
    }
    // A flow that was live at the start, or started during the read, may have
    // written after its row was read, so only a quiet read resumes orphans.
    const idle = liveSubmissions === 0;
    const started = startedSubmissions;
    const rows = await readUnsettledRows();
    return { rows, resumeOrphans: idle && liveSubmissions === 0 && startedSubmissions === started };
  }

  /**
   * Poll every unsettled EVM→Miden row once, for both providers, without ever
   * queueing a Miden transaction. The app-root `BridgeIntentWatcher` runs this on
   * an interval; keeping the operation one-shot prevents hidden background
   * timers, and one enumeration per pass keeps the tick to a single walk of the
   * history.
   */
  async function reconcile(): Promise<void> {
    const { rows, resumeOrphans } = await readRows();
    const cutoffSec = Math.floor((Date.now() - BRIDGE_RECEIVE_MAX_AGE_MS) / 1000);

    for (const row of rows) {
      const inputs: IBridgedReceiveExtraInputs | undefined = row.extraInputs;
      if (inputs === undefined) continue;
      // Terminalize rather than skip. Resuming would register a pending bridge-in
      // for the dump's `sourceAddress` and drive the incoming-funds UI off it with
      // no user action — but merely skipping strands the row: these rows are born
      // `Completed` with their lifecycle in `extraInputs.phase`, and the only other
      // writers of that phase are driven by the pending-bridge-in registry, which
      // lives in platform storage and does NOT travel in the dump. The row would
      // read "Delivering" forever and keep suppressing its linked consume row.
      if (row.restoredFromBackup) {
        await updateBridgedReceivePhase(row.id, 'failed', { error: RESTORED_BRIDGE_UNVERIFIABLE });
        continue;
      }
      if (row.initiatedAt < cutoffSec) {
        await updateBridgedReceivePhase(row.id, 'failed', { error: 'Bridge delivery timed out.' });
        continue;
      }
      if (inputs.phase === 'submitting' && !resumeOrphans) continue;

      if (inputs.provider === 'agglayer') await reconcileAgglayerRow(row, inputs);
      else await reconcileEpochRow(row, inputs);
    }
  }

  return { startSubmission, reconcile };
}

const reconciler = createBridgeReceiveReconciler();
export const startBridgeReceiveSubmission = reconciler.startSubmission;
export const reconcileBridgedReceives = reconciler.reconcile;

import { midenAddrToEvmAddr } from 'lib/agglayer/contract';
import { fetchDeposits, isAgglayerDepositReady } from 'lib/agglayer/status';
import * as Repo from 'lib/miden/repo';
import { waitForSepoliaReceipt } from 'lib/walletconnect/receipt';

import { registerPendingBridgeIn, resolveBridgeInNoteId } from './bridge-in';
import { IBridgedReceiveExtraInputs, ITransaction } from '../db/types';
import { updateBridgedReceivePhase } from '../transaction/complete';

const BRIDGE_RECEIVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A restored bridge row's delivery cannot be confirmed: the tracking state that
 * would resume it lives outside the dump, and the row's own contents are only as
 * trustworthy as the file they came from. If the bridged note really did land,
 * normal sync surfaces it on its own — this row is just the tracker.
 */
const RESTORED_BRIDGE_UNVERIFIABLE = 'Restored from a backup — delivery could not be verified.';

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

/**
 * Poll every unsettled EVM→Miden row once, for both providers, without ever
 * queueing a Miden transaction. The app-root `BridgeIntentWatcher` runs this on
 * an interval; keeping the operation one-shot prevents hidden background timers,
 * and one enumeration per pass keeps the tick to a single walk of the history.
 */
export async function reconcileBridgedReceives(): Promise<void> {
  const rows = await Repo.transactions
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

    if (inputs.provider === 'agglayer') await reconcileAgglayerRow(row, inputs);
    else await reconcileEpochRow(row, inputs);
  }
}

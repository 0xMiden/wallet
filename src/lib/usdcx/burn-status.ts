import { NoteId, RpcClient } from '@miden-sdk/miden-sdk/lazy';

import { IBridgedSendExtraInputs, ITransaction, ITransactionStatus, IUsdcxBurn } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { assertWasmHoldCurrent, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { getRpcEndpoint } from 'lib/miden-chain/constants';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

export interface BurnObservation {
  status: string;
  attemptCount: number;
  lastAttemptBlockNum?: number;
  lastError?: string;
}

export function burnPhaseFromStatus(status: string): IUsdcxBurn['phase'] | undefined {
  switch (status) {
    case 'Pending':
      return 'pending';
    case 'NullifierInflight':
      return 'consuming';
    case 'NullifierCommitted':
      return 'confirmed';
    case 'Discarded':
      return 'discarded';
    default:
      return undefined;
  }
}

async function readBurnStatus(noteId: string): Promise<BurnObservation> {
  return withWasmClientLock(async hold => {
    const rpc = new RpcClient(getRpcEndpoint());
    try {
      const result = await rpc.getNetworkNoteStatus(NoteId.fromHex(noteId));
      assertWasmHoldCurrent(hold, 'before reading USDCx burn status');
      return {
        status: result.status,
        attemptCount: result.attemptCount,
        lastAttemptBlockNum: result.lastAttemptBlockNum,
        lastError: result.lastError
      };
    } finally {
      rpc.free();
    }
  });
}

/** Read-only network polling: errors leave the durable row eligible for the next pass. */
export async function pollUsdcxBurn(
  tx: ITransaction,
  readStatus: (noteId: string) => Promise<BurnObservation> = readBurnStatus
): Promise<void> {
  const extra: IBridgedSendExtraInputs | undefined = tx.extraInputs;
  const burn = extra?.usdcxBurn;
  if (
    getEffectiveNetworkName() !== 'testnet' ||
    tx.restoredFromBackup ||
    tx.type !== 'bridged-send' ||
    extra?.provider !== 'usdcx' ||
    tx.status !== ITransactionStatus.Completed ||
    !burn ||
    burn.phase === 'confirmed' ||
    burn.phase === 'discarded'
  ) {
    return;
  }

  const observation = await readStatus(burn.noteId);
  const phase = burnPhaseFromStatus(observation.status);
  if (!phase) return;
  await Repo.transactions.where({ id: tx.id }).modify(row => {
    const current: IBridgedSendExtraInputs | undefined = row.extraInputs;
    const previous = current?.usdcxBurn;
    // Another surface may already have settled it while this RPC was in flight.
    if (
      row.restoredFromBackup ||
      row.status !== ITransactionStatus.Completed ||
      current?.provider !== 'usdcx' ||
      !previous ||
      previous.noteId !== burn.noteId ||
      previous.phase === 'confirmed' ||
      previous.phase === 'discarded'
    ) {
      return;
    }
    row.extraInputs = {
      ...current,
      usdcxBurn: {
        ...previous,
        phase: previous.phase === 'consuming' && phase === 'pending' ? previous.phase : phase,
        attemptCount: observation.attemptCount,
        lastAttemptBlockNum: observation.lastAttemptBlockNum,
        lastError: observation.lastError
      }
    };
  });
}

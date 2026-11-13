import { NoteId } from '@miden-sdk/miden-sdk/lazy';

import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';
import { readWithOwnRpcClient } from 'lib/usdcx/rpc-client';

export type EpochNoteState = 'absent' | 'spent' | 'waiting' | 'ready';

const pendingReads = new Map<string, Promise<EpochNoteState>>();

/** Read the public note and its nullifier on a separate RPC client. */
export function readEpochNoteState(noteId: string, reclaimHeight: number): Promise<EpochNoteState> {
  const key = `${getEffectiveRpcUrl()}:${noteId}:${reclaimHeight}`;
  const existing = pendingReads.get(key);
  if (existing) return withRpcTimeout(() => existing, 'Epoch return state', { timeoutMs: 10000, retries: 0 });
  const pending = (async (): Promise<EpochNoteState> => {
    await ensureSdkWasmReady();
    return readWithOwnRpcClient(async rpc => {
      const fetched = await rpc.getNotesById([NoteId.fromHex(noteId)]);
      const entry = fetched.find(candidate => candidate.noteId.toString() === noteId);
      if (!entry?.note) return 'absent';
      const spent = await rpc.getNullifierCommitHeight(
        entry.note.nullifier(),
        entry.inclusionProof.location().blockNum()
      );
      if (spent !== undefined) return 'spent';
      const head = await rpc.getBlockHeaderByNumber(undefined);
      return head.blockNum() >= reclaimHeight ? 'ready' : 'waiting';
    });
  })();
  pendingReads.set(key, pending);
  pending.then(
    () => pendingReads.delete(key),
    () => pendingReads.delete(key)
  );
  return withRpcTimeout(() => pending, 'Epoch return state', { timeoutMs: 10000, retries: 0 });
}

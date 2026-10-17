import { NoteId, NoteScript, type Note } from '@miden-sdk/miden-sdk/lazy';

import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';
import { readWithOwnRpcClient } from 'lib/usdcx/rpc-client';

import { walletAccountIdToSdk } from './helpers';

// Per node read. The cancel-request build makes two of them inside its offscreen op, whose deadline allows for both.
const PSWAP_ORDER_NOTE_READ_TIMEOUT_MS = 5_000;

export type PswapOrderNoteRead = { kind: 'open'; note: Note } | { kind: 'spent' } | { kind: 'absent' };

const isPswapNoteOf = (note: Note, noteId: string, creatorAccountId: string): boolean =>
  note.id().toString() === noteId &&
  note.script().root().toHex() === NoteScript.pswap().root().toHex() &&
  note.metadata().sender().toString() === walletAccountIdToSdk(creatorAccountId).toString();

/**
 * What the node says about a creator's public PSWAP order note: `open`, with the full note a cancel by note needs,
 * `spent`, or `absent`, which also covers a note under that id that is not this creator's PSWAP note. A failed read
 * rejects. It reads on RpcClients of its own and takes no WASM client lock, so a device that never tracked the order,
 * such as one that recovered the account through Guardian, can still see and cancel it (#1487).
 */
export async function readPswapOrderNote(noteId: string, creatorAccountId: string): Promise<PswapOrderNoteRead> {
  const fetched = await withRpcTimeout(
    () => readWithOwnRpcClient(rpc => rpc.getNotesById([NoteId.fromHex(noteId)])),
    'PSWAP order note',
    { timeoutMs: PSWAP_ORDER_NOTE_READ_TIMEOUT_MS, retries: 0 }
  );
  const entry = fetched.find(candidate => candidate.noteId.toString() === noteId);
  const note = entry?.note;
  if (!entry || !note || !isPswapNoteOf(note, noteId, creatorAccountId)) return { kind: 'absent' };
  // A note is spent no earlier than the block that included it.
  const includedAt = entry.inclusionProof.location().blockNum();
  const spentAt = await withRpcTimeout(
    () => readWithOwnRpcClient(rpc => rpc.getNullifierCommitHeight(note.nullifier(), includedAt)),
    'PSWAP order note nullifier',
    { timeoutMs: PSWAP_ORDER_NOTE_READ_TIMEOUT_MS, retries: 0 }
  );
  return spentAt === undefined ? { kind: 'open', note } : { kind: 'spent' };
}

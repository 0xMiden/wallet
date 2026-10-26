import { NoteFile, NoteId, RpcClient, Word } from '@miden-sdk/miden-sdk/lazy';

import { ensureSdkWasmReady, getRpcEndpoint } from 'lib/miden-chain/constants';

import type { RecoveryRetirementReads } from './retirement';
import type { RecoveryNoteEntry } from './types';
import { normalizeHex } from '../sdk/submit-evidence';
import { accountRefToSdk } from '../sdk/helpers';
import type { NodeReads } from '../transaction/reconcile-reads';

export function retainedNoteIdentity(note: RecoveryNoteEntry): { nullifier: string; fromBlock: number } | undefined {
  const file = NoteFile.deserialize(note.noteFile);
  try {
    const id = file.noteId();
    try {
      if (!id || normalizeHex(id.toString()) !== normalizeHex(note.id)) return undefined;
      const nullifier = file.nullifier();
      if (!nullifier) return undefined;
      const proof = file.inclusionProof();
      const location = proof?.location();
      try {
        return { nullifier: normalizeHex(nullifier), fromBlock: location?.blockNum() ?? 0 };
      } finally { location?.free(); proof?.free(); }
    } finally { id?.free(); }
  } finally { file.free(); }
}

export async function createRecoveryCanonicalReads(): Promise<RecoveryRetirementReads & { node: NodeReads; dispose: () => void }> {
  await ensureSdkWasmReady();
  const rpc = new RpcClient(getRpcEndpoint());
  const header = async (block: number) => {
      const header = await rpc.getBlockHeaderByNumber(block, false);
      const commitment = header.commitment();
      try { return normalizeHex(commitment.toHex()); } finally { commitment.free(); header.free(); }
  };
  return {
    dispose: () => {},
    identity: async note => retainedNoteIdentity(note),
    header,
    node: {
      blockCommitment: header,
      account: async (id, atBlock) => {
        const accountId = accountRefToSdk(id);
        try {
          const proof = await rpc.getAccountProof(accountId, null, atBlock ?? null);
          const commitment = proof.accountCommitment();
          try {
            const state = { blockNum: proof.blockNum(), commitment: normalizeHex(commitment.toHex()) };
            return { ok: true, state };
          } finally { commitment.free(); proof.free(); }
        } catch { return { ok: false, pruned: false, timedOut: false }; }
        finally { accountId.free(); }
      },
      noteInclusions: async ids => {
        const notes = await rpc.getNotesById(ids.map(id => NoteId.fromHex(id)));
        try {
          return new Map(notes.map(note => {
            const id = note.noteId;
            const proof = note.inclusionProof;
            const location = proof.location();
            try { return [normalizeHex(id.toString()), location.blockNum()]; }
            finally { location.free(); proof.free(); id.free(); }
          }));
        } finally { notes.forEach(note => note.free()); }
      },
      nullifierHeight: async () => undefined
    },
    scan: async (nullifier, block) => {
      const word = Word.fromHex(nullifier);
      let prefix: number;
      try { prefix = Number(word.toU64s()[3]! >> 48n); } finally { word.free(); }
      const updates = await rpc.syncNullifiers(new Uint16Array([prefix]), block, block);
      try {
        return updates.map(update => {
          const value = update.nullifier();
          try { return { nullifier: normalizeHex(value.toHex()), block: update.blockNum() }; }
          finally { value.free(); }
        });
      } finally { updates.forEach(update => update.free()); }
    }
  };
}

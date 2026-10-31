import { NoteFile, NoteId, RpcClient, Word } from '@miden-sdk/miden-sdk/lazy';

import { ensureSdkWasmReady, getRpcEndpoint } from 'lib/miden-chain/constants';

import { bindCanonicalNoteFamilies } from './canonical-note-bindings';
import type { CanonicalNoteReadback } from './canonical-note-readback';
import type { RecoveryRetirementReads } from './retirement';
import type { RecoveryNoteEntry } from './types';
import { accountRefToSdk } from '../sdk/helpers';
import { normalizedCommitment } from '../sdk/note-details-commitment';
import { normalizeHex } from '../sdk/submit-evidence';
import type { AccountRead, NodeReads } from '../transaction/reconcile-reads';

export function retainedNoteIdentity(note: RecoveryNoteEntry): { nullifier: string; fromBlock: number } | undefined {
  const file = NoteFile.deserialize(note.noteFile);
  try {
    const id = file.noteId();
    try {
      if (!id || normalizedCommitment(id.toString()) !== normalizedCommitment(note.id)) return undefined;
      const nullifier = file.nullifier();
      if (!nullifier) return undefined;
      const proof = file.inclusionProof();
      const location = proof?.location();
      try {
        return { nullifier: normalizeHex(nullifier), fromBlock: location?.blockNum() ?? 0 };
      } finally {
        location?.free();
        proof?.free();
      }
    } finally {
      id?.free();
    }
  } finally {
    file.free();
  }
}

export async function createRecoveryCanonicalReads(
  families: readonly RecoveryNoteEntry[] = [],
  canonicalNotes: readonly CanonicalNoteReadback[] = []
): Promise<RecoveryRetirementReads & { node: NodeReads; dispose: () => void }> {
  await ensureSdkWasmReady();
  const boundIdentity = bindCanonicalNoteFamilies(families, canonicalNotes);
  const rpc = new RpcClient(getRpcEndpoint());
  let pending = 0;
  let disposed = false;
  let freed = false;
  const release = () => {
    if (disposed && pending === 0 && !freed) {
      freed = true;
      rpc.free();
    }
  };
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (disposed) throw new Error('Recovery canonical reader is closed');
    pending++;
    try {
      return await operation();
    } finally {
      pending--;
      release();
    }
  };
  const header = (block: number) =>
    read(async () => {
      const header = await rpc.getBlockHeaderByNumber(block, false);
      const commitment = header.commitment();
      try {
        return normalizeHex(commitment.toHex());
      } finally {
        commitment.free();
        header.free();
      }
    });
  return {
    dispose: () => {
      disposed = true;
      release();
    },
    identity: (note, family) =>
      read(async () => {
        if (family) {
          const bound = boundIdentity(note, family);
          if (bound) return bound.identity;
          if (normalizedCommitment(note.id) !== normalizedCommitment(family.id)) return undefined;
        }
        return retainedNoteIdentity(note);
      }),
    header,
    node: {
      blockCommitment: header,
      account: (id, atBlock) =>
        read<AccountRead>(async () => {
          const accountId = accountRefToSdk(id);
          try {
            const proof = await rpc.getAccountProof(accountId, null, atBlock ?? null);
            const commitment = proof.accountCommitment();
            try {
              const state = { blockNum: proof.blockNum(), commitment: normalizeHex(commitment.toHex()) };
              return { ok: true, state };
            } finally {
              commitment.free();
              proof.free();
            }
          } catch {
            return { ok: false, pruned: false, timedOut: false };
          } finally {
            accountId.free();
          }
        }),
      noteInclusions: ids =>
        read(async () => {
          const notes = await rpc.getNotesById(ids.map(id => NoteId.fromHex(id)));
          try {
            return new Map(
              notes.map(note => {
                const id = note.noteId;
                const proof = note.inclusionProof;
                const location = proof.location();
                try {
                  return [normalizeHex(id.toString()), location.blockNum()];
                } finally {
                  location.free();
                  proof.free();
                  id.free();
                }
              })
            );
          } finally {
            notes.forEach(note => note.free());
          }
        }),
      nullifierHeight: () => read(async () => undefined)
    },
    scan: (nullifier, block) =>
      read(async () => {
        const word = Word.fromHex(`0x${normalizedCommitment(nullifier)}`);
        let prefix: number;
        try {
          prefix = Number(word.toU64s()[3]! >> 48n);
        } finally {
          word.free();
        }
        const updates = await rpc.syncNullifiers(new Uint16Array([prefix]), block, block);
        try {
          return updates.map(update => {
            const value = update.nullifier();
            try {
              return { nullifier: normalizeHex(value.toHex()), block: update.blockNum() };
            } finally {
              value.free();
            }
          });
        } finally {
          updates.forEach(update => update.free());
        }
      })
  };
}

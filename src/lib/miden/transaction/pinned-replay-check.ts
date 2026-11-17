// What the node holds of the notes a row's saved request creates, asked before Retry replays it. A replay re-creates
// those notes byte for byte, and the node rejects a note it already holds only while the first copy is in its
// mempool, which keeps a transaction for five blocks after it commits. Past that the replay is accepted: it debits the
// account again for a second copy of a note that shares the first one's nullifier, so at most one copy is ever spent.
import { type Note, TransactionRequest } from '@miden-sdk/miden-sdk/lazy';

import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';

import { createNodeReads, NodeReads, RPC_READ_TIMEOUT_MS } from './reconcile-reads';
import type { ITransaction } from '../db/types';
import { recordedSwapOrder, swapOrderOf } from '../sdk/apply-after-submit';
import { canonicalWalletAccountId } from '../sdk/helpers';
import { withWasmClientLock } from '../sdk/miden-client';
import { landedOrderFacts, type LandedTransaction, rethrowTrapOrKill } from '../sdk/sdk-error-code';
import { normalizeHex } from '../sdk/submit-evidence';

export type PinnedReplayCheck =
  /** No saved request, or one that creates no own note (nor, for an execute, an approved one) to check. */
  | { kind: 'none' }
  | { kind: 'absent'; noteIds: string[] }
  | {
      kind: 'committed';
      noteIds: string[];
      /** The pinned note the node holds. */
      noteId: string;
      /** The block that includes it, numbered by `scope`, the endpoint the check took before its read. */
      block: number;
      scope: string;
      /** A swap's order, from its one public PSWAP note, in the landed facts' shape. */
      order?: Pick<LandedTransaction, 'orderId' | 'orderNoteId'>;
    }
  /**
   * `decode`: the saved request's bytes do not deserialize, so no Retry can resend it. `sender`: an execute's request
   * declares a note in another account's name, which no run as its own account creates, so no Retry can send it
   * either. `read`: the SDK, the WASM engine (a trap), the WASM lock or the node gave no answer this time.
   */
  | { kind: 'unknown'; cause: 'decode' | 'sender' | 'read' };

interface PinnedNotes {
  noteIds: string[];
  order?: Pick<LandedTransaction, 'orderId' | 'orderNoteId'>;
}

/** The saved request's own bytes did not deserialize, so no Retry can resend them. */
class SavedRequestUnreadable extends Error {}

/** An execute's saved request declares a note under another account, so no run as the row's account can send it. */
class SavedRequestForeignSender extends Error {}

const NOTE_ID_HEX = /^0x[0-9a-f]{64}$/i;

/**
 * The notes an execute's approval recorded, which the signing guard lets an attempt create only from (by id), added
 * to its own notes. The store can hold anything here (`importDb`), and the node read takes every id or none, so an id
 * that is not note-id shaped is left out.
 */
const withApprovedNoteIds = (
  noteIds: string[],
  approvedEffects: ITransaction['approvedEffects'] | undefined
): string[] => {
  const approved: unknown = approvedEffects?.approvedOutputNoteIds;
  if (!Array.isArray(approved)) return noteIds;
  const ids = new Set(noteIds);
  for (const noteId of approved) {
    if (typeof noteId === 'string' && NOTE_ID_HEX.test(noteId)) ids.add(normalizeHex(noteId));
  }
  return [...ids];
};

/** `swapOrderOf` on the saved request's notes, with the fee note not set aside. */
const pinnedOrderOf = (notes: Note[]): ReturnType<typeof swapOrderOf> =>
  swapOrderOf({ feeNote: undefined, userNotes: notes });

/**
 * True when a landed writer still needs its saved request decoded for the order `completedSwapFields` opens: a swap
 * row with `extraInputs`, no `orderId`, no well-formed held order (`landedOrderFacts` keeps an id and `expiresAt` is a
 * safe integer), and no well-formed order recorded from those bytes (`requestOrder`), which a decode would only repeat.
 */
export const swapOpensOrderFromRead = (row: Pick<ITransaction, 'type' | 'extraInputs'>): boolean => {
  if (row.type !== 'swap') return false;
  const extra: unknown = row.extraInputs;
  if (extra === null || typeof extra !== 'object') return false;
  if ('orderId' in extra && extra.orderId != null) return false;
  if (recordedSwapOrder(extra) !== undefined) return false;
  const landed = 'landedOrder' in extra ? extra.landedOrder : undefined;
  if (landed === null || typeof landed !== 'object') return true;
  const held = landedOrderFacts(
    'orderId' in landed ? landed.orderId : undefined,
    'noteId' in landed ? landed.noteId : undefined
  );
  const expiresAt = 'expiresAt' in landed ? landed.expiresAt : undefined;
  return !(held.orderId !== undefined && typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt));
};

/** The saved request's bytes, compared before a write passes the order they named. */
export const sameRequestBytes = (left: Uint8Array | undefined, right: Uint8Array | undefined): boolean =>
  left !== undefined &&
  right !== undefined &&
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

/**
 * The order a saved request names: its one public own note, fee not set aside. Missing or empty bytes return
 * undefined and take no lock. The lazy SDK loads its WASM first, as `checkPinnedReplayNotes` does, since a static
 * decode in a realm that has not loaded it would fail. A trap is not caught inside the callback, so the lock retires
 * it; the caller catches outside and returns undefined. No node read, and the landing still completes.
 */
export const orderFromSavedRequest = async (bytes: Uint8Array | undefined): Promise<ReturnType<typeof swapOrderOf>> => {
  if (bytes === undefined || bytes.length === 0) return undefined;
  try {
    await ensureSdkWasmReady();
  } catch (error) {
    console.warn('[swap] the SDK is not ready to read the order the saved request names', error);
    return undefined;
  }
  try {
    return await withWasmClientLock(
      async () => pinnedOrderOf(TransactionRequest.deserialize(bytes).expectedOutputOwnNotes()),
      { label: 'saved-request-order' }
    );
  } catch (error) {
    console.warn('[swap] could not read the order the saved request names', error);
    return undefined;
  }
};

/**
 * Ask the node whether a note `row`'s request bytes create is committed, and for an execute a note its approval
 * recorded, counted only as `row.accountId` created it. The decode is static but runs in a labelled hold that catches
 * nothing, so a trap reaches the lock, which retires the client it trapped on. Every failure answers `unknown`, never
 * `absent`: the caller replays nothing on it.
 */
export async function checkPinnedReplayNotes(
  row: Pick<ITransaction, 'type' | 'accountId' | 'requestBytes' | 'approvedEffects'>,
  deps: { createReads?: () => Promise<NodeReads> } = {}
): Promise<PinnedReplayCheck> {
  const bytes = row.requestBytes;
  if (bytes === undefined || bytes.length === 0) return { kind: 'none' };
  try {
    await ensureSdkWasmReady();
  } catch (error) {
    console.warn('[retry] the SDK is not ready to read the saved request', error);
    return { kind: 'unknown', cause: 'read' };
  }
  let pinned: PinnedNotes;
  try {
    pinned = await withWasmClientLock(
      async (): Promise<PinnedNotes> => {
        let request: TransactionRequest;
        try {
          request = TransactionRequest.deserialize(bytes);
        } catch (error) {
          // A trap is the engine failing, not the bytes, so it leaves as itself for the lock to retire.
          rethrowTrapOrKill(error);
          throw new SavedRequestUnreadable('the saved request does not deserialize', { cause: error });
        }
        const notes = request.expectedOutputOwnNotes();
        // The SDK refuses a note declared under another account only when it executes the request, and the wallet once
        // queued a dApp's request whose approval run failed: such bytes never run as this row, so they are refused here
        // rather than asked about on every Retry.
        if (row.type === 'execute' && notes.length > 0) {
          const owner = normalizeHex(canonicalWalletAccountId(row.accountId));
          if (notes.some(note => normalizeHex(note.metadata().sender().toString()) !== owner)) {
            throw new SavedRequestForeignSender('the saved request declares a note under another account');
          }
        }
        const noteIds = notes.map(note => normalizeHex(note.id().toString()));
        if (row.type !== 'swap') return { noteIds };
        const order = pinnedOrderOf(notes);
        return order === undefined ? { noteIds } : { noteIds, order };
      },
      { label: 'retry-pinned-notes' }
    );
  } catch (error) {
    if (error instanceof SavedRequestForeignSender) {
      console.warn('[retry] the saved request declares a note under another account, so no Retry sends it');
      return { kind: 'unknown', cause: 'sender' };
    }
    console.warn('[retry] could not read the notes the saved request creates', error);
    return { kind: 'unknown', cause: error instanceof SavedRequestUnreadable ? 'decode' : 'read' };
  }
  const noteIds = row.type === 'execute' ? withApprovedNoteIds(pinned.noteIds, row.approvedEffects) : pinned.noteIds;
  if (noteIds.length === 0) return { kind: 'none' };

  const scope = getEffectiveRpcUrl();
  let node: NodeReads;
  try {
    node = await (deps.createReads ?? createNodeReads)();
  } catch (error) {
    console.warn('[retry] could not reach the node to check the saved request', error);
    return { kind: 'unknown', cause: 'read' };
  }
  // A dApp built an execute's bytes and knows its notes' serials, so it can commit the same note from another account:
  // only a copy this row's account created is the row's, and one held only as another account's answers nothing, never
  // absent, since absent replays. The wallet drew a send's and a swap's serials itself.
  const held =
    row.type === 'execute'
      ? await node.noteInclusions(noteIds, RPC_READ_TIMEOUT_MS, row.accountId)
      : await node.noteInclusions(noteIds, RPC_READ_TIMEOUT_MS);
  if (held === undefined) return { kind: 'unknown', cause: 'read' };
  for (const noteId of noteIds) {
    const block = held.get(noteId);
    if (block === undefined) continue;
    return {
      kind: 'committed',
      noteIds,
      noteId,
      block,
      scope,
      ...(pinned.order ? { order: pinned.order } : {})
    };
  }
  return { kind: 'absent', noteIds };
}

import { AccountId, NoteId, NoteScript, type FetchedNote, type Note, type RpcClient } from '@miden-sdk/miden-sdk/lazy';

import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';
import { readWithOwnRpcClient } from 'lib/usdcx/rpc-client';

import { walletAccountIdToSdk } from './helpers';

// Per node read. The cancel-request build makes two of them inside its offscreen op, whose deadline allows for both.
const PSWAP_ORDER_NOTE_READ_TIMEOUT_MS = 5_000;
// Rounds one lineage read follows; each is a partial fill, and an order with more is left unresolved.
const MAX_LINEAGE_ROUNDS = 16;
// Notes under the order's tag in one spending block whose bodies the read fetches; a busier block is left unresolved.
const MAX_SUCCESSOR_CANDIDATES = 100;

export type PswapOrderNoteRead = { kind: 'open'; note: Note } | { kind: 'spent' } | { kind: 'absent' };

export type PswapOrderLineageRead =
  | { kind: 'open'; noteId: string; depth: number; offeredAmount: bigint; requestedAmount: bigint }
  | { kind: 'finished' }
  | { kind: 'absent' };

/** The PSWAP fields a remainder carries over from its parent, as `PswapNote::remainder_note` builds it. */
interface PswapFields {
  /** [s0, order id, s2, round]: a remainder bumps only the last. */
  serial: bigint[];
  /** [requested faucet suffix, prefix, requested amount, min fill step, payback type, creator suffix, prefix] */
  storage: bigint[];
  offeredFaucet: string;
  offeredAmount: bigint;
}

interface LineageTip {
  note: Note;
  noteId: string;
  /** The block that included it, from which its spend is looked for. */
  block: number;
  fields: PswapFields;
  depth: number;
}

const read = <T>(label: string, run: (rpc: RpcClient) => Promise<T>): Promise<T> =>
  withRpcTimeout(() => readWithOwnRpcClient(run), label, { timeoutMs: PSWAP_ORDER_NOTE_READ_TIMEOUT_MS, retries: 0 });

/**
 * The PSWAP fields of `note` when it is a PSWAP note under `noteId` whose storage names `creatorAccountId` as its
 * creator: the one account the PSWAP script lets cancel it, whoever sent it (a remainder's sender is the solver).
 */
function ownPswapFields(note: Note, noteId: string, creatorAccountId: string): PswapFields | undefined {
  if (note.id().toString() !== noteId) return undefined;
  if (note.script().root().toHex() !== NoteScript.pswap().root().toHex()) return undefined;
  const items = note.recipient().storage().items();
  const serial = note.recipient().serialNum().toFelts();
  const [asset, ...otherAssets] = note.assets().fungibleAssets();
  const [creatorSuffix, creatorPrefix] = [items[5], items[6]];
  if (items.length !== 7 || serial.length !== 4 || !asset || otherAssets.length > 0) return undefined;
  if (!creatorSuffix || !creatorPrefix) return undefined;
  const storage = items.map(item => item.asInt());
  let creator: string;
  try {
    creator = AccountId.fromPrefixSuffix(creatorPrefix, creatorSuffix).toString();
  } catch {
    return undefined;
  }
  if (creator !== walletAccountIdToSdk(creatorAccountId).toString()) return undefined;
  return {
    serial: serial.map(felt => felt.asInt()),
    storage,
    offeredFaucet: asset.faucetId().toString(),
    offeredAmount: asset.amount()
  };
}

const fetchedEntry = (fetched: FetchedNote[], noteId: string): FetchedNote | undefined =>
  fetched.find(candidate => candidate.noteId.toString() === noteId);

/** The block that spent `note` at or after `fromBlock`; undefined while it is unspent. */
const spendOf = (note: Note, fromBlock: number, label: string): Promise<number | undefined> =>
  read(label, rpc => rpc.getNullifierCommitHeight(note.nullifier(), fromBlock));

/**
 * What the node says about a public PSWAP note this account created: `open`, with the full note a cancel by note
 * needs, `spent`, or `absent`, which also covers a note under that id that is not this account's PSWAP note. A failed
 * read rejects. It reads on RpcClients of its own and takes no WASM client lock, so a device that never tracked the
 * order, such as one that recovered the account through Guardian, can still see and cancel it (#1487).
 */
export async function readPswapOrderNote(noteId: string, creatorAccountId: string): Promise<PswapOrderNoteRead> {
  const fetched = await read('PSWAP order note', rpc => rpc.getNotesById([NoteId.fromHex(noteId)]));
  const entry = fetchedEntry(fetched, noteId);
  const note = entry?.note;
  if (!entry || !note || !ownPswapFields(note, noteId, creatorAccountId)) return { kind: 'absent' };
  const spentAt = await spendOf(note, entry.inclusionProof.location().blockNum(), 'PSWAP order note nullifier');
  return spentAt === undefined ? { kind: 'open', note } : { kind: 'spent' };
}

// A remainder keeps its parent's serial but for the round, its asset pair, fill floor, payback type and creator, and
// holds no more than its parent had left; anything else under the tag is another note.
const isNextRound = (parent: PswapFields, next: PswapFields): boolean =>
  next.serial[0] === parent.serial[0] &&
  next.serial[1] === parent.serial[1] &&
  next.serial[2] === parent.serial[2] &&
  next.serial[3] === (parent.serial[3] ?? 0n) + 1n &&
  [0, 1, 3, 4, 5, 6].every(index => next.storage[index] === parent.storage[index]) &&
  next.offeredFaucet === parent.offeredFaucet &&
  next.offeredAmount <= parent.offeredAmount &&
  (next.storage[2] ?? 0n) <= (parent.storage[2] ?? 0n);

/**
 * The remainder a partial fill of `tip` left, if any. The fill that spent the tip created it in the same transaction,
 * so it is in the spending block, under the tip's own tag (a PSWAP remainder carries its parent's tag over).
 */
async function remainderOf(
  tip: LineageTip,
  spentAt: number,
  creatorAccountId: string
): Promise<LineageTip | undefined> {
  const committed = await read('PSWAP remainder search', rpc =>
    rpc.syncNotes(spentAt - 1, spentAt, [tip.note.metadata().tag()])
  );
  const candidateIds = [
    ...new Set(
      committed
        .notes()
        .filter(candidate => candidate.inclusionProof().location().blockNum() === spentAt)
        .map(candidate => candidate.noteId().toString())
    )
  ].filter(noteId => noteId !== tip.noteId);
  if (candidateIds.length === 0) return undefined;
  if (candidateIds.length > MAX_SUCCESSOR_CANDIDATES) throw new Error('Too many notes to search for a PSWAP remainder');
  const fetched = await read('PSWAP remainder candidates', rpc =>
    rpc.getNotesById(candidateIds.map(noteId => NoteId.fromHex(noteId)))
  );
  const remainders = new Map<string, LineageTip>();
  for (const noteId of candidateIds) {
    const note = fetchedEntry(fetched, noteId)?.note;
    const fields = note && ownPswapFields(note, noteId, creatorAccountId);
    if (note && fields && isNextRound(tip.fields, fields)) {
      remainders.set(noteId, { note, noteId, block: spentAt, fields, depth: tip.depth + 1 });
    }
  }
  if (remainders.size > 1) throw new Error('Two notes claim to be the same PSWAP remainder');
  return [...remainders.values()][0];
}

/**
 * Follow a PSWAP order this account created from its order note to the open end of its lineage, as the node holds
 * it: `open` at the current tip (the order note at depth 0, else the remainder the last partial fill left), with what
 * it still offers and asks for; `finished` when a spend left no remainder (a full fill or a reclaim); `absent` when
 * the order note is not this account's PSWAP note of that order. A failed or ambiguous read rejects.
 */
export async function readPswapOrderLineage(
  orderNoteId: string,
  orderId: string,
  creatorAccountId: string
): Promise<PswapOrderLineageRead> {
  const fetched = await read('PSWAP order note', rpc => rpc.getNotesById([NoteId.fromHex(orderNoteId)]));
  const entry = fetchedEntry(fetched, orderNoteId);
  const note = entry?.note;
  const fields = note && ownPswapFields(note, orderNoteId, creatorAccountId);
  if (!entry || !note || !fields || fields.serial[1] !== BigInt(orderId)) return { kind: 'absent' };

  let tip: LineageTip = {
    note,
    noteId: orderNoteId,
    block: entry.inclusionProof.location().blockNum(),
    fields,
    depth: 0
  };
  for (;;) {
    const spentAt = await spendOf(tip.note, tip.block, 'PSWAP lineage nullifier');
    if (spentAt === undefined) {
      return {
        kind: 'open',
        noteId: tip.noteId,
        depth: tip.depth,
        offeredAmount: tip.fields.offeredAmount,
        requestedAmount: tip.fields.storage[2] ?? 0n
      };
    }
    if (tip.depth >= MAX_LINEAGE_ROUNDS) throw new Error('PSWAP lineage is deeper than one read follows');
    const remainder = await remainderOf(tip, spentAt, creatorAccountId);
    if (!remainder) return { kind: 'finished' };
    tip = remainder;
  }
}

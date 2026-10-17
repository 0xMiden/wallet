import { AccountId, NoteId, NoteScript, type FetchedNote, type Note, type RpcClient } from '@miden-sdk/miden-sdk/lazy';

import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';
import { readWithOwnRpcClient } from 'lib/usdcx/rpc-client';

import { walletAccountIdToSdk } from './helpers';

// Per node read. The cancel-request build makes two of them inside its offscreen op, whose deadline allows for both.
const PSWAP_ORDER_NOTE_READ_TIMEOUT_MS = 5_000;
// The deepest tip one lineage read follows, in fill rounds over the order note; a deeper one is left unresolved.
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
  /** The account its storage names as creator (items 6 and 5). */
  creator: string;
}

interface LineageTip {
  note: Note;
  noteId: string;
  /** The block that included it, from which its spend is looked for. */
  block: number;
  fields: PswapFields;
  depth: number;
}

/**
 * Keys with a node read still unsettled in this realm. The timeout ends the caller's wait, not the read, and a read's
 * client is freed only once it settles, so against a node that accepts and never answers every later poll parked one
 * more client: a key with a read out refuses the next until it settles, at most one per note or order (#1487).
 */
const unsettledReads = new Set<string>();

function read<T>(key: string, label: string, run: (rpc: RpcClient) => Promise<T>): Promise<T> {
  if (unsettledReads.has(key)) return Promise.reject(new Error(`${label}: the previous node read has not settled`));
  unsettledReads.add(key);
  const settled = () => {
    unsettledReads.delete(key);
  };
  let pending: Promise<T>;
  try {
    pending = readWithOwnRpcClient(run);
  } catch (error) {
    settled();
    return Promise.reject(error);
  }
  void pending.then(settled, settled);
  return withRpcTimeout(() => pending, label, { timeoutMs: PSWAP_ORDER_NOTE_READ_TIMEOUT_MS, retries: 0 });
}

/** The PSWAP fields of `note`, a PSWAP note under `noteId` of the script's shape; undefined for any other note. */
function pswapFieldsOf(note: Note, noteId: string): PswapFields | undefined {
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
  return {
    serial: serial.map(felt => felt.asInt()),
    storage,
    offeredFaucet: asset.faucetId().toString(),
    offeredAmount: asset.amount(),
    creator
  };
}

const createdBy = (fields: PswapFields, creatorAccountId: string): boolean =>
  fields.creator === walletAccountIdToSdk(creatorAccountId).toString();

/**
 * `pswapFieldsOf` for a note whose storage names `creatorAccountId` as its creator: the one account the PSWAP script
 * lets cancel it, whoever sent it (a remainder's sender is the solver).
 */
function ownPswapFields(note: Note, noteId: string, creatorAccountId: string): PswapFields | undefined {
  const fields = pswapFieldsOf(note, noteId);
  return fields && createdBy(fields, creatorAccountId) ? fields : undefined;
}

const fetchedEntry = (fetched: FetchedNote[], noteId: string): FetchedNote | undefined =>
  fetched.find(candidate => candidate.noteId.toString() === noteId);

/** The block that spent `note` at or after `fromBlock`; undefined while it is unspent. */
const spendOf = (key: string, note: Note, fromBlock: number, label: string): Promise<number | undefined> =>
  read(key, label, rpc => rpc.getNullifierCommitHeight(note.nullifier(), fromBlock));

/**
 * What the node says about a public PSWAP note this account created: `open`, with the full note a cancel by note
 * needs, `spent`, or `absent`, which also covers a note under that id that is not this account's PSWAP note. A failed
 * read rejects. It reads on RpcClients of its own and takes no WASM client lock, so a device that never tracked the
 * order, such as one that recovered the account through Guardian, can still see and cancel it (#1487).
 */
export async function readPswapOrderNote(noteId: string, creatorAccountId: string): Promise<PswapOrderNoteRead> {
  const key = `note:${noteId}`;
  const fetched = await read(key, 'PSWAP order note', rpc => rpc.getNotesById([NoteId.fromHex(noteId)]));
  const entry = fetchedEntry(fetched, noteId);
  const note = entry?.note;
  if (!entry || !note || !ownPswapFields(note, noteId, creatorAccountId)) return { kind: 'absent' };
  const spentAt = await spendOf(key, note, entry.inclusionProof.location().blockNum(), 'PSWAP order note nullifier');
  return spentAt === undefined ? { kind: 'open', note } : { kind: 'spent' };
}

// Every note of an order keeps the order note's serial but for the round (`create_remainder_note` adds 1 to its last
// element), so a PSWAP note this account created with that serial claims to be this order's.
const claimsOrder = (order: PswapFields, fields: PswapFields): boolean =>
  [0, 1, 2].every(index => fields.serial[index] === order.serial[index]);

// A remainder keeps its parent's storage but for the requested amount (`create_remainder_note` rewrites only
// MIN_REQUESTED_AMOUNT_ITEM before the recipient is built) and offers the parent's token.
const keepsFixedFields = (parent: PswapFields, next: PswapFields): boolean =>
  [0, 1, 3, 4, 5, 6].every(index => next.storage[index] === parent.storage[index]) &&
  next.offeredFaucet === parent.offeredFaucet;

/**
 * Whether `rounds` partial fills can take a PSWAP note from `parent` to `next`, by the arithmetic of the PSWAP script
 * the pinned SDK runs (miden-standards 0.17.1, `asm/standards/notes/pswap.masm`, `execute_pswap` and
 * `create_remainder_note`). The pinned RpcClient serves no link from a note to the transaction that created it, so
 * this is the whole tie between a remainder and its parent. One fill of F of the R a note asks for, the note offering
 * O with fill floor S (storage item 3):
 *  - F >= min(S, R) (`ERR_PSWAP_FILL_BELOW_MINIMUM`), and F >= 1, since `main` runs a zero fill as a full one;
 *  - a remainder only for F < R, asking R - F (`execute_pswap`'s partial-fill branch), so a note asking no more than
 *    S is only ever filled whole, and every fill that leaves a remainder takes at least max(1, S);
 *  - the payout is `calculate_output_amount` over the account and the note legs, a + b = F, with fill_reference R:
 *    floor(O a / R) + floor(O b / R), which is floor(O F / R) or one less, and the remainder offers O less it.
 * So k fills lower the request by at least k max(1, S), and any such drop is k - 1 fills of max(1, S) and one of the
 * rest. Each fill leaves O_i in [O_{i-1} R_i / R_{i-1}, that + 2), exactly ceil(O R' / R) and one more for one
 * round; over k rounds every chain keeps O R_k <= O_k R < O R_k + 2 k R, though for k > 1 that bound also holds
 * some offers no chain of fills reaches.
 */
function fillsAllow(parent: PswapFields, next: PswapFields, rounds: bigint): boolean {
  const offered = parent.offeredAmount;
  const requested = parent.storage[2] ?? 0n;
  const fillStep = parent.storage[3] ?? 0n;
  const nextOffered = next.offeredAmount;
  const nextRequested = next.storage[2] ?? 0n;
  if (rounds < 1n || nextRequested < 1n || nextOffered < 1n || nextOffered > offered) return false;
  if (requested - nextRequested < rounds * (fillStep > 1n ? fillStep : 1n)) return false;
  return (
    nextOffered * requested >= offered * nextRequested &&
    nextOffered * requested < offered * nextRequested + 2n * rounds * requested
  );
}

/**
 * The next tip after `tip`, spent at `spentAt`: undefined when that block holds no note of this order at all. The fill
 * that spent the tip created its remainder in the same transaction, so in that block, under the tip's own tag (a
 * PSWAP remainder carries its parent's tag over). Fills of one order inside one batch erase the remainders between
 * them, so the block can hold only a later round: the lowest round the fill arithmetic allows is the next tip, and
 * any later one is followed from it. Anything the walk cannot tie (a note under the tag with no body, a note claiming
 * this order that is not its lineage, two notes of one round) rejects, leaving the order to the next read.
 */
async function successorOf(
  key: string,
  order: PswapFields,
  tip: LineageTip,
  spentAt: number,
  creatorAccountId: string
): Promise<LineageTip | undefined> {
  const committed = await read(key, 'PSWAP remainder search', rpc =>
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
  const fetched = await read(key, 'PSWAP remainder candidates', rpc =>
    rpc.getNotesById(candidateIds.map(noteId => NoteId.fromHex(noteId)))
  );
  const lineage: LineageTip[] = [];
  for (const noteId of candidateIds) {
    const note = fetchedEntry(fetched, noteId)?.note;
    if (!note || note.id().toString() !== noteId) {
      throw new Error('A note under the PSWAP order tag has no public body');
    }
    const fields = pswapFieldsOf(note, noteId);
    if (!fields || !createdBy(fields, creatorAccountId) || !claimsOrder(order, fields)) continue;
    const rounds = (fields.serial[3] ?? 0n) - (tip.fields.serial[3] ?? 0n);
    if (!keepsFixedFields(tip.fields, fields) || !fillsAllow(tip.fields, fields, rounds)) {
      throw new Error('A note claims this PSWAP order but is not its lineage');
    }
    const depth = Number((fields.serial[3] ?? 0n) - (order.serial[3] ?? 0n));
    lineage.push({ note, noteId, block: spentAt, fields, depth });
  }
  if (lineage.length === 0) return undefined;
  const nextDepth = Math.min(...lineage.map(candidate => candidate.depth));
  const next = lineage.filter(candidate => candidate.depth === nextDepth);
  if (next.length > 1) throw new Error('Two notes claim the same round of this PSWAP order');
  return next[0];
}

/**
 * Follow a PSWAP order this account created from its order note to the open end of its lineage, as the node holds
 * it: `open` at the current tip (the order note at depth 0, else the remainder the last partial fill left, its depth
 * the serial round over the order note's), with what it still offers and asks for; `finished` only when a spend left
 * no note of the order at all (a full fill or a reclaim); `absent` when the order note is not this account's PSWAP
 * note of that order. A failed or ambiguous read rejects, and the order stays open until a later read settles it.
 */
export async function readPswapOrderLineage(
  orderNoteId: string,
  orderId: string,
  creatorAccountId: string
): Promise<PswapOrderLineageRead> {
  const key = `order:${orderNoteId}`;
  const fetched = await read(key, 'PSWAP order note', rpc => rpc.getNotesById([NoteId.fromHex(orderNoteId)]));
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
    const spentAt = await spendOf(key, tip.note, tip.block, 'PSWAP lineage nullifier');
    if (spentAt === undefined) {
      return {
        kind: 'open',
        noteId: tip.noteId,
        depth: tip.depth,
        offeredAmount: tip.fields.offeredAmount,
        requestedAmount: tip.fields.storage[2] ?? 0n
      };
    }
    const next = await successorOf(key, fields, tip, spentAt, creatorAccountId);
    if (!next) return { kind: 'finished' };
    if (next.depth > MAX_LINEAGE_ROUNDS) throw new Error('PSWAP lineage is deeper than one read follows');
    tip = next;
  }
}

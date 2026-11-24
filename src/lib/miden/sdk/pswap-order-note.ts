import {
  AccountId,
  Note,
  NoteAttachment,
  NoteAttachmentScheme,
  NoteId,
  NoteScript,
  NoteTag,
  type FetchedNote,
  type NoteInclusionProof,
  type RpcClient
} from '@miden-sdk/miden-sdk/lazy';

import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';
import { readWithOwnRpcClient } from 'lib/usdcx/rpc-client';

import { walletAccountIdToSdk } from './helpers';

/** The GameCoin sale script requires an explicit payment from each buyer. */
export const GC_SALE_SCRIPT_ROOT = '0xfe5c6de19f05ae3c77227128bcf15180fc252b94429a3b030967126077e1db2a';

// Per node read. The cancel-request build makes two of them inside its offscreen op, whose deadline allows for both.
const PSWAP_ORDER_NOTE_READ_TIMEOUT_MS = 5_000;
// Fill rounds from a read's validated start; checkpoint the spent tip at the bound or last spent tip before a jump
// past it, which is the start only when the read made no progress.
const MAX_LINEAGE_ROUNDS = 16;
// Notes under one tag in one spending block whose bodies the read fetches; a busier block is left unresolved.
const MAX_SUCCESSOR_CANDIDATES = 100;
// The attachment scheme `pswap.masm` stamps on a fill's payback, one word [total fill, order id, depth, 0].
const PSWAP_ATTACHMENT_SCHEME = 3;

export type PswapOrderNoteRead = { kind: 'open'; note: Note } | { kind: 'spent' } | { kind: 'absent' };

export interface PswapOrderLineageCheckpoint {
  noteId: string;
  depth: number;
}

export type PswapOrderLineageRead =
  | { kind: 'open'; noteId: string; depth: number; offeredAmount: bigint; requestedAmount: bigint }
  | { kind: 'unresolved'; checkpoint: PswapOrderLineageCheckpoint }
  | { kind: 'finished' }
  | { kind: 'absent' };

/** The PSWAP fields a remainder carries over from its parent, as `PswapNote::remainder_note` builds it. */
export interface PswapFields {
  /** [s0, order id, s2, round]: a remainder bumps only the last. */
  serial: bigint[];
  /** [requested faucet suffix, prefix, requested amount, min fill step, payback type, creator suffix, prefix] */
  storage: bigint[];
  offeredFaucet: string;
  offeredAmount: bigint;
  /** The faucet its storage asks for (items 1 and 0). */
  requestedFaucet: string;
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
 * Node and key pairs with a read still unsettled in this realm. The timeout ends the caller's wait, not the read, and
 * a read's client is freed only once it settles, so against a node that accepts and never answers every later poll
 * parked one more client: a key with a read out on a node refuses the next read of it there until it settles, at most
 * one per note or order and node. A read parked on one node says nothing of another, so after an endpoint change every
 * note and order is read on the new node at once (#1487).
 */
const unsettledReads = new Set<string>();

function read<T>(key: string, label: string, run: (rpc: RpcClient) => Promise<T>): Promise<T> {
  // The node `readWithOwnRpcClient` builds its client for, read in the same synchronous turn.
  const slot = `${getEffectiveRpcUrl()} ${key}`;
  if (unsettledReads.has(slot)) return Promise.reject(new Error(`${label}: the previous node read has not settled`));
  unsettledReads.add(slot);
  const settled = () => {
    unsettledReads.delete(slot);
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
export function pswapFieldsOf(
  note: Note,
  noteId: string,
  scriptRoot: string = NoteScript.pswap().root().toHex()
): PswapFields | undefined {
  if (note.id().toString() !== noteId) return undefined;
  if (note.script().root().toHex() !== scriptRoot) return undefined;
  const items = note.recipient().storage().items();
  const serial = note.recipient().serialNum().toFelts();
  const [asset, ...otherAssets] = note.assets().fungibleAssets();
  const [requestedSuffix, requestedPrefix] = [items[0], items[1]];
  const [creatorSuffix, creatorPrefix] = [items[5], items[6]];
  if (items.length !== 7 || serial.length !== 4 || !asset || otherAssets.length > 0) return undefined;
  if (note.assets().nonFungibleAssets().length > 0) return undefined;
  if (!creatorSuffix || !creatorPrefix || !requestedSuffix || !requestedPrefix) return undefined;
  const storage = items.map(item => item.asInt());
  let creator: string;
  let requestedFaucet: string;
  try {
    creator = AccountId.fromPrefixSuffix(creatorPrefix, creatorSuffix).toString();
    requestedFaucet = AccountId.fromPrefixSuffix(requestedPrefix, requestedSuffix).toString();
  } catch {
    return undefined;
  }
  return {
    serial: serial.map(felt => felt.asInt()),
    storage,
    offeredFaucet: asset.faucetId().toString(),
    offeredAmount: asset.amount(),
    requestedFaucet,
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

export type PublicPswapNoteRead =
  | { kind: 'open'; note: Note; fields: PswapFields; block: number; inclusionProof: NoteInclusionProof }
  | { kind: 'spent' }
  | { kind: 'absent' };

// Share the whole body-and-nullifier read; the two steps use the same guarded key for different operations.
const publicPswapNoteReads = new Map<string, Promise<PublicPswapNoteRead>>();

/**
 * What the node says about a public PSWAP note of any creator: `open`, with the full note and its decoded fields,
 * `spent`, or `absent`, which also covers a note under that id that is not a PSWAP note. A failed read rejects. Like
 * `readPswapOrderNote`, it reads on RpcClients of its own and takes no WASM client lock: the note is somebody else's
 * sale, which this client never tracked.
 */
export function readPublicPswapNote(
  noteId: string,
  scriptRoot: string = NoteScript.pswap().root().toHex()
): Promise<PublicPswapNoteRead> {
  const slot = `${getEffectiveRpcUrl()} ${noteId} ${scriptRoot}`;
  const existing = publicPswapNoteReads.get(slot);
  if (existing) return existing;
  const pending = (async (): Promise<PublicPswapNoteRead> => {
    const key = `note:${noteId}`;
    const fetched = await read(key, 'public PSWAP note', rpc => rpc.getNotesById([NoteId.fromHex(noteId)]));
    const entry = fetchedEntry(fetched, noteId);
    const note = entry?.note;
    const fields = entry && note ? pswapFieldsOf(note, noteId, scriptRoot) : undefined;
    if (!entry || !note || !fields) return { kind: 'absent' };
    const block = entry.inclusionProof.location().blockNum();
    const spentAt = await spendOf(key, note, block, 'public PSWAP note nullifier');
    return spentAt === undefined
      ? { kind: 'open', note, fields, block, inclusionProof: entry.inclusionProof }
      : { kind: 'spent' };
  })();
  publicPswapNoteReads.set(slot, pending);
  const settled = () => {
    publicPswapNoteReads.delete(slot);
  };
  void pending.then(settled, settled);
  return pending;
}

// `NoteType::Public as u8` in miden-protocol, the two top bits of a public note's tag.
const PUBLIC_NOTE_TYPE_BITS = 1;

/**
 * The tag of a public PSWAP note offering `offeredFaucet` for `requestedFaucet`, as miden-standards 0.17.1
 * `PswapNote::create_tag` builds it: the note type in the top two bits, the 14 most significant bits of the PSWAP
 * script root, then the top byte of the offered faucet's prefix and the top byte of the requested one's. A remainder
 * keeps its parent's tag, so one tag lists a whole sale lineage. This is not `buildSwapTag`, the SWAP script's.
 */
export function pswapNoteTag(offeredFaucet: AccountId, requestedFaucet: AccountId): number {
  const root = NoteScript.pswap().root().toHex().slice(2);
  const [first, second] = [parseInt(root.slice(0, 2), 16), parseInt(root.slice(2, 4), 16)];
  const useCase = ((first << 6) | (second >> 2)) & 0x3fff;
  const topByte = (id: AccountId) => Number((id.prefix().asInt() >> 56n) & 0xffn);
  return (
    ((PUBLIC_NOTE_TYPE_BITS << 30) | (useCase << 16) | (topByte(offeredFaucet) << 8) | topByte(requestedFaucet)) >>> 0
  );
}

/** The node's current block height, on an RpcClient of its own. */
export function readChainTip(): Promise<number> {
  return read('chain-tip', 'chain tip', async rpc => (await rpc.getBlockHeaderByNumber(null, false)).blockNum());
}

// Note-sync calls one tag listing makes before it gives up: the node answers a sync one block of matches at a time.
const MAX_TAG_SYNC_CALLS = 64;

/**
 * The ids of committed notes under `tag` in the inclusive block range, newest first. The SDK paginates
 * syncNotes internally; the outer loop handles any remaining range and refuses an incomplete listing.
 */
export async function listCommittedNoteIdsByTag(
  tag: number,
  fromBlock: number,
  toBlock: number
): Promise<{ noteId: string; block: number }[]> {
  const found: { noteId: string; block: number }[] = [];
  let from = fromBlock;
  for (let call = 0; call < MAX_TAG_SYNC_CALLS; call++) {
    const start = from;
    const synced = await read(`tag:${tag}:${start}`, 'PSWAP tag sync', rpc =>
      rpc.syncNotes(start, toBlock, [new NoteTag(tag)])
    );
    const notes = synced.notes();
    if (notes.length === 0) return found.sort((a, b) => b.block - a.block);
    let lastBlock = from;
    for (const committed of notes) {
      const block = committed.inclusionProof().location().blockNum();
      lastBlock = Math.max(lastBlock, block);
      found.push({ noteId: committed.noteId().toString(), block });
    }
    if (lastBlock >= toBlock) return found.sort((a, b) => b.block - a.block);
    from = lastBlock + 1;
  }
  throw new Error(`PSWAP tag sync: more than ${MAX_TAG_SYNC_CALLS} blocks of notes under tag ${tag}`);
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
 * for one round this is the whole tie between a remainder and its parent. One fill of F of the R a note asks for, the
 * note offering O with fill floor S (storage item 3):
 *  - F >= min(S, R) (`ERR_PSWAP_FILL_BELOW_MINIMUM`), and F >= 1, since `main` runs a zero fill as a full one;
 *  - a remainder only for F < R, asking R - F (`execute_pswap`'s partial-fill branch), so a note asking no more than
 *    S is only ever filled whole, and every fill that leaves a remainder takes at least max(1, S);
 *  - the payout is `calculate_output_amount` over the account and the note legs, a + b = F, with fill_reference R:
 *    floor(O a / R) + floor(O b / R), which is floor(O F / R) or one less, and the remainder offers O less it.
 * So k fills lower the request by at least k max(1, S). Each fill leaves O_i in [O_{i-1} R_i / R_{i-1}, that + 2),
 * exactly ceil(O R' / R) and one more for one round; over k rounds every chain keeps O R_k <= O_k R < O R_k + 2 k R,
 * but for k > 1 that bound also holds offers no chain reaches, so a jump is taken only once its fills' paybacks
 * rebuild it (`fillsReach`).
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
 * Whether `fills`, applied in depth order to `parent` by `fillsAllow`'s arithmetic, land exactly on `next`. Each step
 * carries the set of offers it may leave, O - floor(O F / R) or, from a fill split between the two legs, one more.
 */
function fillsReach(parent: PswapFields, next: PswapFields, fills: bigint[]): boolean {
  const fillStep = parent.storage[3] ?? 0n;
  let requested = parent.storage[2] ?? 0n;
  let offers = new Set([parent.offeredAmount]);
  for (const fill of fills) {
    if (fill < (fillStep > 1n ? fillStep : 1n) || fill >= requested) return false;
    const reached = new Set<bigint>();
    for (const offered of offers) {
      const payout = (offered * fill) / requested;
      reached.add(offered - payout);
      if (payout > 0n) reached.add(offered - payout + 1n);
    }
    offers = reached;
    requested -= fill;
  }
  return requested === (next.storage[2] ?? 0n) && offers.has(next.offeredAmount);
}

/**
 * The fill and depth `note` reports as a payback of `order`: a P2ID note carrying the PSWAP attachment
 * `create_p2id_note` gives every payback, with this order's id; undefined for any other note. The pinned SDK reads no
 * attachment's scheme, but a note id commits to every scheme (miden-protocol 0.17.1 `NoteMetadata::to_metadata_word`),
 * so the note rebuilt with that word under scheme 3 keeps its id only if it carries it there.
 */
function paybackOf(note: Note, noteId: string, order: PswapFields): { depth: bigint; fill: bigint } | undefined {
  if (note.id().toString() !== noteId) return undefined;
  if (note.script().root().toHex() !== NoteScript.p2id().root().toHex()) return undefined;
  for (const [index, attachment] of note.attachments().entries()) {
    const [word, ...otherWords] = attachment.toWords();
    const [fill, orderId, depth, last] = word ? [...word.toU64s()] : [];
    if (!word || otherWords.length > 0 || fill === undefined || depth === undefined) continue;
    if (orderId !== order.serial[1] || last !== 0n) continue;
    const asPswap = note.attachments();
    asPswap[index] = NoteAttachment.fromWord(new NoteAttachmentScheme(PSWAP_ATTACHMENT_SCHEME), word);
    if (Note.withAttachments(note.assets(), note.metadata(), note.recipient(), asPswap).id().toString() === noteId) {
      return { depth, fill };
    }
  }
  return undefined;
}

/**
 * The fills of `order` from depth `from` to `to`, in depth order, as the paybacks block `spentAt` holds under the
 * creator's account-target tag (`create_p2id_note` tags every payback so): undefined unless each depth has exactly one.
 * A note without a public body is skipped, so a private payback leaves its depth missing.
 */
async function paybackFills(
  key: string,
  order: PswapFields,
  creatorAccountId: string,
  spentAt: number,
  from: number,
  to: number
): Promise<bigint[] | undefined> {
  const committed = await read(key, 'PSWAP payback search', rpc =>
    rpc.syncNotes(spentAt - 1, spentAt, [NoteTag.withAccountTarget(walletAccountIdToSdk(creatorAccountId))])
  );
  const noteIds = [
    ...new Set(
      committed
        .notes()
        .filter(candidate => candidate.inclusionProof().location().blockNum() === spentAt)
        .map(candidate => candidate.noteId().toString())
    )
  ];
  if (noteIds.length > MAX_SUCCESSOR_CANDIDATES) throw new Error('Too many notes to search for PSWAP paybacks');
  const fetched =
    noteIds.length === 0
      ? []
      : await read(key, 'PSWAP paybacks', rpc => rpc.getNotesById(noteIds.map(noteId => NoteId.fromHex(noteId))));
  const fillsByDepth = new Map<bigint, bigint[]>();
  for (const noteId of noteIds) {
    const note = fetchedEntry(fetched, noteId)?.note;
    const payback = note && paybackOf(note, noteId, order);
    if (payback) fillsByDepth.set(payback.depth, [...(fillsByDepth.get(payback.depth) ?? []), payback.fill]);
  }
  const fills: bigint[] = [];
  for (let depth = from; depth <= to; depth += 1) {
    const [fill, ...others] = fillsByDepth.get(BigInt(depth)) ?? [];
    if (fill === undefined || others.length > 0) return undefined;
    fills.push(fill);
  }
  return fills;
}

/**
 * The next tip after `tip`, spent at `spentAt`: undefined when that block holds no note of this order at all. The fill
 * that spent the tip created its remainder in the same transaction, so in that block, under the tip's own tag (a
 * PSWAP remainder carries its parent's tag over). One round on, the fill arithmetic ties it exactly. Fills of one
 * order inside one batch erase the remainders between them, so the block can hold only a later round: the lowest
 * round the arithmetic allows is the next tip, taken only when the block also holds, under the creator's account-target
 * tag, one public payback per round between them whose fills rebuild it, and any later one is followed from it.
 * Anything the walk cannot tie (a note under the tag with no body, a note claiming this order that is not its lineage,
 * two notes of one round, a jump with a missing, private or duplicated payback) rejects, leaving the order to the next
 * read.
 * A jump past the read's budget returns `unresolved`; the caller checkpoints the spent tip at the bound or the last
 * spent tip before such a jump, which is the read's start only when the read made no progress.
 */
async function successorOf(
  key: string,
  order: PswapFields,
  tip: LineageTip,
  spentAt: number,
  creatorAccountId: string,
  startDepth: number
): Promise<LineageTip | 'unresolved' | undefined> {
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
  const [successor] = next;
  if (!successor) return undefined;
  if (!Number.isSafeInteger(successor.depth) || successor.depth - startDepth > MAX_LINEAGE_ROUNDS) return 'unresolved';
  if (successor.depth === tip.depth + 1) return successor;
  const fills = await paybackFills(key, order, creatorAccountId, spentAt, tip.depth + 1, successor.depth);
  if (!fills || !fillsReach(tip.fields, successor.fields, fills)) {
    throw new Error("A later round of this PSWAP order is not rebuilt by its fills' paybacks");
  }
  return successor;
}

/**
 * Follow a PSWAP order this account created from its order note to the open end of its lineage, as the node holds
 * it: `open` at the current tip (the order note at depth 0, else the remainder the last partial fill left, its depth
 * the serial round over the order note's), with what it still offers and asks for; `finished` only when a spend left
 * no note of the order at all (a full fill or a reclaim); `absent` when the order note is not this account's PSWAP
 * note of that order. A validated start resumes the walk there, following at most MAX_LINEAGE_ROUNDS more rounds;
 * `unresolved` carries the spent tip at the bound or the last spent tip before a jump past it as a checkpoint,
 * which is the read's start only when the read made no progress.
 * A failed or ambiguous read rejects, and the order stays open until a later read settles it.
 */
export async function readPswapOrderLineage(
  orderNoteId: string,
  orderId: string,
  creatorAccountId: string,
  start?: PswapOrderLineageCheckpoint
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
  if (start && typeof start.noteId === 'string' && Number.isSafeInteger(start.depth) && start.depth > 0) {
    let startNoteId: NoteId | undefined;
    try {
      startNoteId = NoteId.fromHex(start.noteId);
    } catch {
      startNoteId = undefined;
    }
    const resumeId = startNoteId;
    const fetchedStart = resumeId ? await read(key, 'PSWAP lineage start', rpc => rpc.getNotesById([resumeId])) : [];
    const startEntry = fetchedEntry(fetchedStart, start.noteId);
    const startNote = startEntry?.note;
    const startFields = startNote && ownPswapFields(startNote, start.noteId, creatorAccountId);
    if (
      startEntry &&
      startNote &&
      startFields &&
      claimsOrder(fields, startFields) &&
      keepsFixedFields(fields, startFields) &&
      (startFields.serial[3] ?? 0n) - (fields.serial[3] ?? 0n) === BigInt(start.depth)
    ) {
      tip = {
        note: startNote,
        noteId: start.noteId,
        block: startEntry.inclusionProof.location().blockNum(),
        fields: startFields,
        depth: start.depth
      };
    }
  }
  const startDepth = tip.depth;
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
    if (tip.depth - startDepth >= MAX_LINEAGE_ROUNDS) {
      return { kind: 'unresolved', checkpoint: { noteId: tip.noteId, depth: tip.depth } };
    }
    const next = await successorOf(key, fields, tip, spentAt, creatorAccountId, startDepth);
    if (next === 'unresolved') return { kind: 'unresolved', checkpoint: { noteId: tip.noteId, depth: tip.depth } };
    if (!next) return { kind: 'finished' };
    tip = next;
  }
}

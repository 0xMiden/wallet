/**
 * Note spam list.
 *
 * The user's own answer to unsolicited notes: from the pending-notes list they
 * can hide one note, block the asset (faucet) a note carries — which hides every
 * note of that asset — or block the sender and the asset together. Everything
 * hidden this way lands in the spam bin, where it can be restored or unblocked.
 *
 * Unlike `note-quarantine.ts` this is deliberately PERMANENT until the user
 * undoes it: quarantine hides notes a dApp dry-run imported behind the user's
 * back and therefore expires, whereas an entry here is an explicit decision the
 * user made in a confirmation sheet, and the spam bin is its exit. Adding a TTL
 * would re-surface a blocked spammer's notes every week.
 *
 * Scope: one wallet-wide key. Faucet ids and sender addresses already encode the
 * network, so a devnet entry can never match a testnet note, and note ids are
 * globally unique. Per-account scoping would only reproduce the spam after an
 * account switch.
 *
 * The state is read by every claimable-notes consumer in the frontend (through
 * the store slice) and by the service worker's sync loop (to skip auto-consume
 * and the "note received" notification), so the classifier `isNoteSpam` is pure
 * and synchronous. Storage access is defensive: a read failure yields the empty
 * state rather than throwing, so a broken read can never break sync — and
 * mutators are serialized behind a module lock, because two read-modify-writes
 * that overlap (Undo racing a second hide) would otherwise erase each other.
 */
import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

export const NOTE_SPAM_STORAGE_KEY = 'miden_note_spam_state';

// Bounds growth. Dropping the OLDEST entry is the recoverable direction: a note
// or asset that falls off the list merely reappears as claimable.
const MAX_HIDDEN_NOTES = 500;
const MAX_BLOCKED_FAUCETS = 200;
const MAX_BLOCKED_SENDERS = 200;

/** A spam-listed value plus the wall-clock ms it was added — used only to order the bin. */
export interface NoteSpamEntry {
  value: string;
  at: number;
}

export interface NoteSpamState {
  hiddenNoteIds: NoteSpamEntry[];
  blockedFaucetIds: NoteSpamEntry[];
  blockedSenders: NoteSpamEntry[];
}

export const EMPTY_NOTE_SPAM_STATE: NoteSpamState = {
  hiddenNoteIds: [],
  blockedFaucetIds: [],
  blockedSenders: []
};

export type SpamAction =
  | { kind: 'hide-note'; noteId: string }
  | { kind: 'block-faucet'; faucetId: string }
  | { kind: 'block-sender'; senderAddress: string }
  | { kind: 'block-sender-and-faucet'; senderAddress: string; faucetId: string };

export type SpamEntryKind = 'hidden-note' | 'blocked-faucet' | 'blocked-sender';

/** The fields of a note the classifier looks at; both `ConsumableNote` and the SW's serialized shape satisfy it. */
export interface SpamClassifiableNote {
  id: string;
  faucetId: string;
  senderAddress: string;
}

export interface NoteSpamSets {
  hidden: Set<string>;
  faucets: Set<string>;
  senders: Set<string>;
}

export const EMPTY_NOTE_SPAM_SETS: NoteSpamSets = {
  hidden: new Set(),
  faucets: new Set(),
  senders: new Set()
};

export function toNoteSpamSets(state: NoteSpamState): NoteSpamSets {
  return {
    hidden: new Set(state.hiddenNoteIds.map(entry => entry.value)),
    faucets: new Set(state.blockedFaucetIds.map(entry => entry.value)),
    senders: new Set(state.blockedSenders.map(entry => entry.value))
  };
}

export function isNoteSpam(note: SpamClassifiableNote, sets: NoteSpamSets): boolean {
  return sets.hidden.has(note.id) || sets.faucets.has(note.faucetId) || sets.senders.has(note.senderAddress);
}

/** True when the state hides nothing — lets hot paths skip the per-note filter. */
export function isNoteSpamStateEmpty(state: NoteSpamState): boolean {
  return state.hiddenNoteIds.length === 0 && state.blockedFaucetIds.length === 0 && state.blockedSenders.length === 0;
}

function isEntry(value: unknown): value is NoteSpamEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate: { value?: unknown; at?: unknown } = value;
  return typeof candidate.value === 'string' && candidate.value.length > 0 && typeof candidate.at === 'number';
}

function parseEntries(raw: unknown): NoteSpamEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isEntry);
}

/** Accepts only well-formed entries; anything malformed is dropped (un-hiding is the safe direction). */
export function parseNoteSpamState(raw: unknown): NoteSpamState {
  if (typeof raw !== 'object' || raw === null) return EMPTY_NOTE_SPAM_STATE;
  const candidate: { hiddenNoteIds?: unknown; blockedFaucetIds?: unknown; blockedSenders?: unknown } = raw;
  return {
    hiddenNoteIds: parseEntries(candidate.hiddenNoteIds),
    blockedFaucetIds: parseEntries(candidate.blockedFaucetIds),
    blockedSenders: parseEntries(candidate.blockedSenders)
  };
}

// Serializes this realm's read-modify-writes. Same shape and reason as
// `withDeadletterLock` in note-deadletter.ts: two overlapping mutators read the
// same snapshot and the second write erases the first's change.
let writeTail: Promise<unknown> = Promise.resolve();
const withSpamLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = writeTail.then(fn, fn);
  writeTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
};

async function readState(): Promise<NoteSpamState> {
  return parseNoteSpamState(await fetchFromStorage<unknown>(NOTE_SPAM_STORAGE_KEY));
}

/** Reads the persisted spam state (empty on missing/malformed/error). Never throws. */
export async function getNoteSpamState(): Promise<NoteSpamState> {
  try {
    return await readState();
  } catch {
    return EMPTY_NOTE_SPAM_STATE;
  }
}

function addEntry(entries: NoteSpamEntry[], value: string, max: number, now: number): NoteSpamEntry[] {
  const withoutDuplicate = entries.filter(entry => entry.value !== value);
  return [...withoutDuplicate, { value, at: now }].slice(-max);
}

function removeEntry(entries: NoteSpamEntry[], value: string): NoteSpamEntry[] {
  return entries.filter(entry => entry.value !== value);
}

function applyToState(state: NoteSpamState, action: SpamAction, now: number): NoteSpamState {
  switch (action.kind) {
    case 'hide-note':
      return { ...state, hiddenNoteIds: addEntry(state.hiddenNoteIds, action.noteId, MAX_HIDDEN_NOTES, now) };
    case 'block-faucet':
      return {
        ...state,
        blockedFaucetIds: addEntry(state.blockedFaucetIds, action.faucetId, MAX_BLOCKED_FAUCETS, now)
      };
    case 'block-sender':
      return {
        ...state,
        blockedSenders: addEntry(state.blockedSenders, action.senderAddress, MAX_BLOCKED_SENDERS, now)
      };
    case 'block-sender-and-faucet':
      return {
        ...state,
        blockedFaucetIds: addEntry(state.blockedFaucetIds, action.faucetId, MAX_BLOCKED_FAUCETS, now),
        blockedSenders: addEntry(state.blockedSenders, action.senderAddress, MAX_BLOCKED_SENDERS, now)
      };
  }
}

function revertFromState(state: NoteSpamState, action: SpamAction): NoteSpamState {
  switch (action.kind) {
    case 'hide-note':
      return { ...state, hiddenNoteIds: removeEntry(state.hiddenNoteIds, action.noteId) };
    case 'block-faucet':
      return { ...state, blockedFaucetIds: removeEntry(state.blockedFaucetIds, action.faucetId) };
    case 'block-sender':
      return { ...state, blockedSenders: removeEntry(state.blockedSenders, action.senderAddress) };
    case 'block-sender-and-faucet':
      return {
        ...state,
        blockedFaucetIds: removeEntry(state.blockedFaucetIds, action.faucetId),
        blockedSenders: removeEntry(state.blockedSenders, action.senderAddress)
      };
  }
}

function removeEntryFromState(state: NoteSpamState, kind: SpamEntryKind, value: string): NoteSpamState {
  switch (kind) {
    case 'hidden-note':
      return { ...state, hiddenNoteIds: removeEntry(state.hiddenNoteIds, value) };
    case 'blocked-faucet':
      return { ...state, blockedFaucetIds: removeEntry(state.blockedFaucetIds, value) };
    case 'blocked-sender':
      return { ...state, blockedSenders: removeEntry(state.blockedSenders, value) };
  }
}

/**
 * Pure counterparts of the persisting mutators, for the store's optimistic
 * update: the slice applies the same transformation locally, then adopts the
 * persisted result when the write settles.
 */
export function applySpamActionToState(state: NoteSpamState, action: SpamAction, now = Date.now()): NoteSpamState {
  return applyToState(state, action, now);
}

export function revertSpamActionFromState(state: NoteSpamState, action: SpamAction): NoteSpamState {
  return revertFromState(state, action);
}

export function removeSpamEntryFromState(state: NoteSpamState, kind: SpamEntryKind, value: string): NoteSpamState {
  return removeEntryFromState(state, kind, value);
}

async function mutate(transform: (state: NoteSpamState) => NoteSpamState): Promise<NoteSpamState> {
  return withSpamLock(async () => {
    // A failed READ is not an empty store: writing on top of it would erase every
    // block the user made. Let it throw so the caller keeps its previous state.
    const current = await readState();
    const next = transform(current);
    await putToStorage(NOTE_SPAM_STORAGE_KEY, next);
    return next;
  });
}

/** Persists `action` and returns the new state. Throws on storage failure. */
export function applySpamAction(action: SpamAction): Promise<NoteSpamState> {
  const now = Date.now();
  return mutate(state => applyToState(state, action, now));
}

/** Exact inverse of `applySpamAction` (Undo). Throws on storage failure. */
export function revertSpamAction(action: SpamAction): Promise<NoteSpamState> {
  return mutate(state => revertFromState(state, action));
}

/** Removes one entry from the spam bin (restore a note / unblock an asset or sender). */
export function removeSpamEntry(kind: SpamEntryKind, value: string): Promise<NoteSpamState> {
  return mutate(state => removeEntryFromState(state, kind, value));
}

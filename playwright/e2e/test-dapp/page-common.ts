/**
 * What both test dApp pages share, `test-dapp.ts` and `react-dapp.ts`: a wallet or adapter error becomes `Outcome`
 * data, the page's own fault and the node's failure throw under their own names, and an output note crosses to the
 * driver in one shape. One copy, so a known-bug signature reads the same fields whichever page recorded them.
 */
import { Note, NoteScript, NoteType } from '@miden-sdk/miden-sdk';
import { u8ToB64 } from '@miden-sdk/miden-wallet-adapter-base';

import type { DappError, NoteTypeName, Outcome, OutputNoteView } from './protocol';

/** A dApp-side failure: thrown through to the driver as a harness fault, never folded into an Outcome. */
export class HarnessCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessCheckError';
  }
}
/**
 * The node failed a call the page made, or the chain did not advance: the network's fault, not the page's. The driver
 * matches the name, asks again a command a repeat cannot change, and records the rest as an infrastructure failure of
 * that cell alone (callDapp).
 */
export class ChainUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ChainUnavailableError';
  }
}

// The wallet hands out its stored account key, which can carry a `_<suffix>` (dapp.ts:443-453); the SDK parses only the
// bech32 part, so this drops the suffix the way the wallet's own canonicalWalletAccountId does (helpers.ts:72-79).
export const canonical = (address: string): string => address.split('_')[0] ?? address;
export const noteTypeName = (type: NoteType): NoteTypeName => (type === NoteType.Public ? 'public' : 'private');
// By script root, as the wallet's own guardian-history.ts reads a payment note.
export function scriptOf(note: Note): OutputNoteView['script'] {
  const root = note.script().root().toHex();
  if (root === NoteScript.p2id().root().toHex()) return 'p2id';
  return root === NoteScript.p2ide().root().toHex() ? 'p2ide' : 'other';
}

export const field = (value: unknown, key: string): string | undefined => {
  const found: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
  return typeof found === 'string' ? found : undefined;
};

// Provider errors are MidenWalletError objects that implement Error without extending it, so read fields, not instanceof.
export function describeError(error: unknown): DappError {
  const cause: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'error') : undefined;
  const causeName = field(cause, 'name');
  return {
    name: field(error, 'name') ?? 'NonError',
    message: field(error, 'message') ?? String(error),
    ...(causeName === undefined ? {} : { causeName, causeMessage: field(cause, 'message') ?? '' })
  };
}

// Wallet and adapter errors are the verdicts under test, so they come back as data with their exact class and text
// (spec section 2.4). A HarnessCheckError is the page's own fault and a ChainUnavailableError the node's: both throw.
export async function outcome<T>(work: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof HarnessCheckError || error instanceof ChainUnavailableError) throw error;
    return { ok: false, error: describeError(error) };
  }
}

// Every call the page makes to the node goes through here, so the driver can tell a failed request from a page fault.
export async function fromNode<T>(what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HarnessCheckError) throw error;
    const { name, message } = describeError(error);
    throw new ChainUnavailableError(`${what}: ${name}: ${message}`, { cause: error });
  }
}

/** The adapter deserializes with the bare specifier, so one import map means one SDK instance (`isSameSdkNote`). */
export const outputNoteView = (note: Note): OutputNoteView => ({
  noteId: note.id().toString(),
  noteType: noteTypeName(note.metadata().noteType()),
  bytesB64: u8ToB64(note.serialize()),
  isSameSdkNote: note instanceof Note,
  script: scriptOf(note)
});

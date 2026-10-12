// What an attempt's leaf reads off its executed and proven transaction immediately before it submits (#1081), and
// the service worker's parser for the copy that crosses the offscreen bus. Synchronous and total: each field is read
// in its own try, and an unreadable field is left out, which only keeps the entry from being provable.
import type { SubmitEvidenceFields } from '../db/types';

/** A delta can move the expiration at most this far past the reference block. */
export const EXPIRATION_DELTA_RANGE = 65535;
/** The most entries the parser accepts in one list. */
export const MAX_EVIDENCE_LIST = 256;

const WORD_HEX = /^0x[0-9a-f]{64}$/i;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** Node reads return lower case; every captured and parsed value is lowered to compare equal with them. */
export const normalizeHex = (hex: string): string => hex.toLowerCase();

interface EvidenceHeader {
  to_commitment(): { toHex(): string };
  nonce(): { asInt(): bigint };
}

/** The slice of `TransactionResult` the reader touches. */
export interface EvidenceResult {
  executedTransaction(): {
    id(): { toHex(): string };
    initialAccountHeader(): EvidenceHeader;
    finalAccountHeader(): EvidenceHeader;
    userOutputNotes(): { id(): { toString(): string } }[];
  };
}

/** The slice of `ProvenTransaction` the reader touches. */
export interface EvidenceProof {
  nullifiers(): { toHex(): string }[];
  refBlockNumber(): number;
  refBlockCommitment(): { toHex(): string };
  expirationBlockNumber(): number;
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * The evidence of an attempt about to submit. Reads nothing once `holdIsCurrent` says the WASM hold that executed it
 * is gone, the rule `readLanded` follows: the handles are borrows of a client the flow no longer owns. The fee note
 * is never captured, because another transaction from the same pre-state paying the same fee can carry the same one.
 */
export function readSubmitEvidence(
  result: EvidenceResult,
  proof: EvidenceProof,
  holdIsCurrent: () => boolean
): SubmitEvidenceFields {
  if (!holdIsCurrent()) return {};
  const evidence: SubmitEvidenceFields = {};
  const executed = attempt(() => result.executedTransaction());
  if (executed !== undefined) {
    const transactionId = attempt(() => normalizeHex(executed.id().toHex()));
    if (transactionId !== undefined) evidence.transactionId = transactionId;
    const initialCommitment = attempt(() => normalizeHex(executed.initialAccountHeader().to_commitment().toHex()));
    if (initialCommitment !== undefined) evidence.initialCommitment = initialCommitment;
    const finalCommitment = attempt(() => normalizeHex(executed.finalAccountHeader().to_commitment().toHex()));
    if (finalCommitment !== undefined) evidence.finalCommitment = finalCommitment;
    const initialNonce = attempt(() => executed.initialAccountHeader().nonce().asInt().toString());
    if (initialNonce !== undefined) evidence.initialNonce = initialNonce;
    const outputNoteIds = attempt(() => executed.userOutputNotes().map(note => normalizeHex(note.id().toString())));
    if (outputNoteIds !== undefined) evidence.outputNoteIds = outputNoteIds;
  }
  const nullifiers = attempt(() => proof.nullifiers().map(nullifier => normalizeHex(nullifier.toHex())));
  if (nullifiers !== undefined) evidence.nullifiers = nullifiers;
  const refBlock = attempt(() => proof.refBlockNumber());
  if (refBlock !== undefined) evidence.refBlock = refBlock;
  const refBlockCommitment = attempt(() => normalizeHex(proof.refBlockCommitment().toHex()));
  if (refBlockCommitment !== undefined) evidence.refBlockCommitment = refBlockCommitment;
  // A request without a delta proves with the kernel's no-expiration sentinel; only a delta's range is evidence.
  const expirationBlock = attempt(() => proof.expirationBlockNumber());
  if (
    expirationBlock !== undefined &&
    refBlock !== undefined &&
    expirationBlock > refBlock &&
    expirationBlock <= refBlock + EXPIRATION_DELTA_RANGE
  ) {
    evidence.expirationBlock = expirationBlock;
  }
  return evidence;
}

const readWord = (value: unknown): string | undefined | null =>
  value === undefined ? undefined : typeof value === 'string' && WORD_HEX.test(value) ? normalizeHex(value) : null;

const readBlock = (value: unknown): number | undefined | null =>
  value === undefined
    ? undefined
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;

const readWords = (value: unknown): string[] | undefined | null => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_LIST) return null;
  const words: string[] = [];
  for (const item of value) {
    const word = readWord(item);
    if (typeof word !== 'string') return null;
    words.push(word);
  }
  return words;
};

/**
 * Evidence as it crossed the offscreen bus, or undefined when there is none or any field is malformed. The caller
 * still records the crossing then, as an evidence-less entry that can only hold a row back from "safe".
 */
export function parseSubmitEvidence(value: unknown): SubmitEvidenceFields | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  try {
    const transactionId = readWord(Reflect.get(value, 'transactionId'));
    const initialCommitment = readWord(Reflect.get(value, 'initialCommitment'));
    const finalCommitment = readWord(Reflect.get(value, 'finalCommitment'));
    const refBlockCommitment = readWord(Reflect.get(value, 'refBlockCommitment'));
    const outputNoteIds = readWords(Reflect.get(value, 'outputNoteIds'));
    const nullifiers = readWords(Reflect.get(value, 'nullifiers'));
    const refBlock = readBlock(Reflect.get(value, 'refBlock'));
    const expirationBlock = readBlock(Reflect.get(value, 'expirationBlock'));
    const rawNonce: unknown = Reflect.get(value, 'initialNonce');
    const initialNonce =
      rawNonce === undefined ? undefined : typeof rawNonce === 'string' && DECIMAL.test(rawNonce) ? rawNonce : null;
    if (
      transactionId === null ||
      initialCommitment === null ||
      finalCommitment === null ||
      refBlockCommitment === null ||
      outputNoteIds === null ||
      nullifiers === null ||
      refBlock === null ||
      expirationBlock === null ||
      initialNonce === null
    ) {
      return undefined;
    }
    const evidence: SubmitEvidenceFields = {};
    if (transactionId !== undefined) evidence.transactionId = transactionId;
    if (initialCommitment !== undefined) evidence.initialCommitment = initialCommitment;
    if (finalCommitment !== undefined) evidence.finalCommitment = finalCommitment;
    if (initialNonce !== undefined) evidence.initialNonce = initialNonce;
    if (outputNoteIds !== undefined) evidence.outputNoteIds = outputNoteIds;
    if (nullifiers !== undefined) evidence.nullifiers = nullifiers;
    if (refBlock !== undefined) evidence.refBlock = refBlock;
    if (refBlockCommitment !== undefined) evidence.refBlockCommitment = refBlockCommitment;
    if (expirationBlock !== undefined) evidence.expirationBlock = expirationBlock;
    return evidence;
  } catch {
    return undefined;
  }
}

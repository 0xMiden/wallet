/**
 * Pure bigint encoding of Miden Name labels and storage keys.
 *
 * This file does not import the SDK. All felt orders here agree with the
 * domain-faucet contract v0.16 and were verified on testnet:
 *
 * - Character codes: a-z -> 1..26, 0-9 -> 27..36.
 * - 7 codes per felt, 8 bits each, little-endian (char 0 in the low byte).
 * - Domain word: [f1 = chars 14..20, f2 = chars 7..13, f3 = chars 0..6, length].
 */

import { MidenNameInvalidLabelError } from './errors';

/** Four felts in word order (element 0 first). */
export type Felts4 = readonly [bigint, bigint, bigint, bigint];

/** The prefix and suffix felts of an account id. */
export interface AccountIdParts {
  prefix: bigint;
  suffix: bigint;
}

export type MidenLabelError = 'empty' | 'too-long' | 'invalid-chars';

export const MIDEN_NAME_SUFFIX = '.miden';
export const MIDEN_NAME_MAX_LENGTH = 21;

const CHARS_PER_FELT = 7;
const BITS_PER_CHAR = 8n;
const CHAR_MASK = 0xffn;
const LABEL_PATTERN = /^[a-z0-9]+$/;
const U32_MAX = 0xffff_ffff;

/**
 * Domain separation tag of the commitment preimage (4 felts). The contract
 * hashes TAG ‖ domainWord ‖ [0, 0, registry.suffix, registry.prefix].
 */
export const MIDEN_NAME_COMMITMENT_TAG: Felts4 = [31013299120531821n, 30803248544050529n, 54383671667041n, 20n];

/** Highest name length that has its own price. Longer names use this price. */
const PRICE_LENGTH_CAP = 5;

/**
 * Normalize user input to a bare label: trim, lowercase, and remove one
 * trailing ".miden". This does not validate the label.
 */
export function normalizeMidenNameInput(input: string): string {
  const lowered = input.trim().toLowerCase();
  return lowered.endsWith(MIDEN_NAME_SUFFIX) ? lowered.slice(0, -MIDEN_NAME_SUFFIX.length) : lowered;
}

/** Return why the label is not valid, or null when it is valid. */
export function validateMidenLabel(label: string): MidenLabelError | null {
  if (label.length === 0) return 'empty';
  if (label.length > MIDEN_NAME_MAX_LENGTH) return 'too-long';
  if (!LABEL_PATTERN.test(label)) return 'invalid-chars';
  return null;
}

/**
 * True when the input has the ".miden" suffix and the label before it is valid.
 * A bech32 address never matches, so a send recipient that is an address does
 * not start a name lookup.
 */
export function looksLikeMidenName(input: string): boolean {
  const lowered = input.trim().toLowerCase();
  if (!lowered.endsWith(MIDEN_NAME_SUFFIX)) return false;
  return validateMidenLabel(normalizeMidenNameInput(lowered)) === null;
}

export function formatMidenName(label: string): string {
  return `${label}${MIDEN_NAME_SUFFIX}`;
}

/** Code of one character. The caller must validate the label first ([a-z0-9] only). */
function charCode(char: string): bigint {
  const code = char.charCodeAt(0);
  // 'a'..'z' -> 1..26, '0'..'9' -> 27..36
  return code >= 97 ? BigInt(code - 96) : BigInt(code - 48 + 27);
}

function codeChar(code: number): string | null {
  if (code >= 1 && code <= 26) return String.fromCharCode(code + 96);
  if (code >= 27 && code <= 36) return String.fromCharCode(code - 27 + 48);
  return null;
}

function packChunk(chunk: string): bigint {
  let felt = 0n;
  for (let i = 0; i < chunk.length; i++) {
    felt |= charCode(chunk.charAt(i)) << (BigInt(i) * BITS_PER_CHAR);
  }
  return felt;
}

/**
 * Encode a label to its domain word. Throws MidenNameInvalidLabelError when the
 * label is not valid.
 */
export function encodeDomainFelts(label: string): Felts4 {
  const error = validateMidenLabel(label);
  if (error !== null) throw new MidenNameInvalidLabelError(label, error);
  const f3 = packChunk(label.slice(0, CHARS_PER_FELT));
  const f2 = packChunk(label.slice(CHARS_PER_FELT, 2 * CHARS_PER_FELT));
  const f1 = packChunk(label.slice(2 * CHARS_PER_FELT, 3 * CHARS_PER_FELT));
  return [f1, f2, f3, BigInt(label.length)];
}

function unpackChunk(felt: bigint, count: number): string | null {
  let out = '';
  for (let i = 0; i < CHARS_PER_FELT; i++) {
    const code = Number((felt >> (BigInt(i) * BITS_PER_CHAR)) & CHAR_MASK);
    if (i < count) {
      const char = codeChar(code);
      if (char === null) return null;
      out += char;
    } else if (code !== 0) {
      // A code after the end of the label means that the word is not canonical.
      return null;
    }
  }
  // Bits above the 7 codes must be zero.
  if (felt >> (BigInt(CHARS_PER_FELT) * BITS_PER_CHAR) !== 0n) return null;
  return out;
}

/**
 * Decode a domain word to its label. Return null when the word is not a
 * canonical encoding of a valid label (this includes the zero word).
 */
export function decodeDomainFelts(felts: Felts4): string | null {
  const [f1, f2, f3, lengthFelt] = felts;
  if (lengthFelt < 1n || lengthFelt > BigInt(MIDEN_NAME_MAX_LENGTH)) return null;
  const length = Number(lengthFelt);
  const count = (start: number): number => Math.max(0, Math.min(CHARS_PER_FELT, length - start));
  const a = unpackChunk(f3, count(0));
  const b = unpackChunk(f2, count(CHARS_PER_FELT));
  const c = unpackChunk(f1, count(2 * CHARS_PER_FELT));
  if (a === null || b === null || c === null) return null;
  const label = a + b + c;
  return validateMidenLabel(label) === null ? label : null;
}

/**
 * The 12-felt preimage of the domain commitment:
 * TAG ‖ domainWord ‖ [0, 0, registry.suffix, registry.prefix].
 * Note: the suffix comes BEFORE the prefix here.
 */
export function commitmentPreimage(domainWord: Felts4, registry: AccountIdParts): bigint[] {
  return [...MIDEN_NAME_COMMITMENT_TAG, ...domainWord, 0n, 0n, registry.suffix, registry.prefix];
}

/**
 * Key of the `asset_status` and `token_to_domain` maps: the first two felts of
 * the domain commitment, then two zeros.
 */
export function statusKeyFelts(commitment: Felts4): Felts4 {
  return [commitment[0], commitment[1], 0n, 0n];
}

/** Key of the `prices` map: [min(length, 5), 0, token.suffix, token.prefix]. */
export function priceKeyFelts(labelLength: number, token: AccountIdParts): Felts4 {
  return [BigInt(Math.min(labelLength, PRICE_LENGTH_CAP)), 0n, token.suffix, token.prefix];
}

/** Key of the `account_to_domain` map: [0, 0, account.suffix, account.prefix]. */
export function accountKeyFelts(account: AccountIdParts): Felts4 {
  return [0n, 0n, account.suffix, account.prefix];
}

/**
 * The 7 storage felts of the register note, in this exact order:
 * [registry.prefix, registry.suffix, dw0, dw1, dw2, dw3, reclaimHeight].
 * Note: the prefix comes BEFORE the suffix here.
 */
export function registerNoteInputs(registry: AccountIdParts, domainWord: Felts4, reclaimHeight: number): bigint[] {
  if (!Number.isInteger(reclaimHeight) || reclaimHeight < 0 || reclaimHeight > U32_MAX) {
    throw new RangeError(`Reclaim height ${reclaimHeight} does not fit in a u32`);
  }
  return [registry.prefix, registry.suffix, ...domainWord, BigInt(reclaimHeight)];
}

/**
 * Action codes of the registry note (contract v0.16):
 * 3 writes the `domain_to_account` and `account_to_domain` records of the name
 * to the target account; 4..6 clear records and carry no asset.
 */
export type RegistryNoteAction = 3n;

export const REGISTRY_NOTE_ACTION: { readonly updateRecords: RegistryNoteAction } = {
  updateRecords: 3n
};

/**
 * The 8 storage felts of the registry note, in this exact order:
 * [registry.prefix, registry.suffix, dw0, dw1, dw2, dw3, reclaimHeight, action].
 * The target is the registry account. The note sender gets the record.
 * The first seven are the same layout as the register note.
 */
export function registryNoteInputs(
  target: AccountIdParts,
  domainWord: Felts4,
  reclaimHeight: number,
  action: RegistryNoteAction
): bigint[] {
  return [...registerNoteInputs(target, domainWord, reclaimHeight), action];
}

export function feltsEqual(a: Felts4, b: Felts4): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

export function isZeroFelts(felts: Felts4): boolean {
  return felts[0] === 0n && felts[1] === 0n && felts[2] === 0n && felts[3] === 0n;
}

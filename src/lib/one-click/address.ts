import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import bs58 from 'bs58';
import { isAddress } from 'viem';

import type { NearIntentsAddressKind } from './types';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
// A bech32 or bech32m address of Bitcoin mainnet: `bc1` and 11 to 71 characters of the bech32 set, in lower case.
const BITCOIN_SEGWIT = /^bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{11,71}$/;
// A legacy P2PKH (`1`) or P2SH (`3`) address of Bitcoin mainnet.
const BITCOIN_LEGACY = /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const NEAR_IMPLICIT = /^[0-9a-f]{64}$/;
// A NEAR named account: parts of `a-z0-9` joined by one `.`, `-` or `_`, with no separator at an end.
const NEAR_NAMED = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
// The Solana system program: 32 zero bytes. It is a valid ed25519 point, but nobody holds its key.
const SOLANA_SYSTEM_PROGRAM = '11111111111111111111111111111111';

function base58Bytes(value: string): Uint8Array | undefined {
  if (!BASE58.test(value)) return undefined;
  try {
    return bs58.decode(value);
  } catch {
    return undefined;
  }
}

/** The 32 bytes of a Solana address, or undefined when `value` is not 32 bytes of base58. */
function solanaBytes(value: string): Uint8Array | undefined {
  if (value.length < 32 || value.length > 44) return undefined;
  const bytes = base58Bytes(value);
  return bytes?.length === 32 ? bytes : undefined;
}

function isSolanaAddress(value: string): boolean {
  return solanaBytes(value) !== undefined;
}

/** True when the 32 bytes are a point on the ed25519 curve, so a private key can sign for the address. */
function isOnEd25519Curve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/** A Solana wallet address: 32 bytes on the ed25519 curve. A program derived address is not on the curve. */
function isSolanaDestination(value: string): boolean {
  if (value === SOLANA_SYSTEM_PROGRAM) return false;
  const bytes = solanaBytes(value);
  return bytes !== undefined && isOnEd25519Curve(bytes);
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values: number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit++) if ((top >>> bit) & 1) checksum ^= BECH32_GENERATOR[bit] ?? 0;
  }
  return checksum >>> 0;
}

/** Regroup 5-bit words into bytes. Undefined when the padding is longer than 4 bits or not zero (BIP 173). */
function bech32WordsToBytes(words: number[]): number[] | undefined {
  let accumulator = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const word of words) {
    accumulator = ((accumulator << 5) | word) & 0xfff;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }
  if (bits >= 5 || ((accumulator << (8 - bits)) & 0xff) !== 0) return undefined;
  return bytes;
}

/** A mainnet SegWit address: the BIP 173 checksum for version 0, BIP 350 for 1 to 16, and a valid witness program. */
function isBitcoinSegwitAddress(value: string): boolean {
  if (!BITCOIN_SEGWIT.test(value)) return false;
  const data = value
    .slice('bc1'.length)
    .split('')
    .map(char => BECH32_CHARSET.indexOf(char));
  const version = data[0];
  if (version === undefined || version > 16) return false;
  const expected = version === 0 ? BECH32_CONST : BECH32M_CONST;
  const hrp = [0x62, 0x63];
  const polymodInput = [...hrp.map(code => code >> 5), 0, ...hrp.map(code => code & 31), ...data];
  if (bech32Polymod(polymodInput) !== expected) return false;
  const program = bech32WordsToBytes(data.slice(1, -6));
  if (!program) return false;
  return version === 0 ? program.length === 20 || program.length === 32 : program.length >= 2 && program.length <= 40;
}

/** A legacy address is a version byte (0x00 or 0x05), a 20-byte hash and a 4-byte double-SHA-256 checksum. */
function isBitcoinLegacyAddress(value: string): boolean {
  if (!BITCOIN_LEGACY.test(value)) return false;
  const bytes = base58Bytes(value);
  if (!bytes || bytes.length !== 25) return false;
  if (bytes[0] !== 0x00 && bytes[0] !== 0x05) return false;
  const checksum = sha256(sha256(bytes.slice(0, 21))).slice(0, 4);
  return checksum.every((byte, index) => byte === bytes[21 + index]);
}

function isBitcoinAddress(value: string): boolean {
  return isBitcoinSegwitAddress(value) || isBitcoinLegacyAddress(value);
}

/** Bech32 is one case only, so an address in upper case is the same address in lower case. */
function isUpperCaseBech32(value: string): boolean {
  return value.startsWith('BC1') && value === value.toUpperCase();
}

function isBitcoinDestination(value: string): boolean {
  return isBitcoinAddress(isUpperCaseBech32(value) ? value.toLowerCase() : value);
}

function isNearAccount(value: string): boolean {
  if (NEAR_IMPLICIT.test(value)) return true;
  return value.length >= 2 && value.length <= 64 && NEAR_NAMED.test(value);
}

/** A NEAR destination: an implicit account, or a named account with a dot. A `0x` value is never a NEAR account. */
function isNearDestination(value: string): boolean {
  if (NEAR_IMPLICIT.test(value)) return true;
  return value.includes('.') && isNearAccount(value);
}

/** An EVM address in one case, or with a correct EIP-55 checksum. The zero address is refused. */
function isEvmDestination(value: string): boolean {
  if (!EVM_ADDRESS.test(value) || value.toLowerCase() === EVM_ZERO_ADDRESS) return false;
  const hex = value.slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true;
  return isAddress(value, { strict: true });
}

/**
 * Check the format of a destination address on a chain. This does not use the network, so an address that passes
 * can still be one that nobody controls. The value must be trimmed.
 */
export function isValidNearIntentsAddress(kind: NearIntentsAddressKind, value: string): boolean {
  if (typeof value !== 'string') return false;
  switch (kind) {
    case 'evm':
      return isEvmDestination(value);
    case 'solana':
      return isSolanaDestination(value);
    case 'bitcoin':
      return isBitcoinDestination(value);
    case 'near':
      return isNearDestination(value);
    default:
      return false;
  }
}

/**
 * Check the format of a refund address on an origin chain, with the rules that the Receive page used before the
 * send direction. These rules are less strict than `isValidNearIntentsAddress`: a NEAR name with no dot, an EVM
 * address with no checksum in mixed case and any 32-byte Solana value pass.
 */
export function isValidNearIntentsRefundAddress(kind: NearIntentsAddressKind, value: string): boolean {
  if (typeof value !== 'string') return false;
  switch (kind) {
    case 'evm':
      return EVM_ADDRESS.test(value);
    case 'solana':
      return isSolanaAddress(value);
    case 'bitcoin':
      return isBitcoinAddress(value);
    case 'near':
      return isNearAccount(value);
    default:
      return false;
  }
}

/** The address kind that the shape of `value` has, or undefined. Order: evm, bitcoin, solana, near. */
export function detectNearIntentsAddressKind(value: string): NearIntentsAddressKind | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  // A `0x` value is an EVM address or nothing, never a NEAR account.
  if (value.startsWith('0x') || value.startsWith('0X')) return isEvmDestination(value) ? 'evm' : undefined;
  if (isBitcoinDestination(value)) return 'bitcoin';
  if (isSolanaDestination(value)) return 'solana';
  if (isNearDestination(value)) return 'near';
  return undefined;
}

/**
 * Write a destination address in the form the wallet sends to 1Click: lower case for upper-case bech32 bitcoin;
 * else unchanged (trimmed).
 */
export function normalizeNearIntentsAddress(kind: NearIntentsAddressKind, value: string): string {
  const trimmed = value.trim();
  switch (kind) {
    case 'bitcoin':
      return isUpperCaseBech32(trimmed) ? trimmed.toLowerCase() : trimmed;
    default:
      return trimmed;
  }
}

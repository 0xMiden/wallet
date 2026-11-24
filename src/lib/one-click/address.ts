import { sha256 } from '@noble/hashes/sha2';
import bs58 from 'bs58';

import type { NearIntentsAddressKind } from './types';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
// A bech32 or bech32m address of Bitcoin mainnet: `bc1` and 11 to 71 characters of the bech32 set, in lower case.
const BITCOIN_SEGWIT = /^bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{11,71}$/;
// A legacy P2PKH (`1`) or P2SH (`3`) address of Bitcoin mainnet.
const BITCOIN_LEGACY = /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const NEAR_IMPLICIT = /^[0-9a-f]{64}$/;
// A NEAR named account: parts of `a-z0-9` joined by one `.`, `-` or `_`, with no separator at an end.
const NEAR_NAMED = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function base58Length(value: string): number | undefined {
  if (!BASE58.test(value)) return undefined;
  try {
    return bs58.decode(value).length;
  } catch {
    return undefined;
  }
}

function isSolanaAddress(value: string): boolean {
  return value.length >= 32 && value.length <= 44 && base58Length(value) === 32;
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
  if (!BITCOIN_LEGACY.test(value) || base58Length(value) !== 25) return false;
  const bytes = bs58.decode(value);
  if (bytes[0] !== 0x00 && bytes[0] !== 0x05) return false;
  const checksum = sha256(sha256(bytes.slice(0, 21))).slice(0, 4);
  return checksum.every((byte, index) => byte === bytes[21 + index]);
}

function isBitcoinAddress(value: string): boolean {
  return isBitcoinSegwitAddress(value) || isBitcoinLegacyAddress(value);
}

function isNearAccount(value: string): boolean {
  if (NEAR_IMPLICIT.test(value)) return true;
  return value.length >= 2 && value.length <= 64 && NEAR_NAMED.test(value);
}

/**
 * Check the format of an address on an origin chain, for example a refund address. This does not use the network,
 * so an address that passes can still be one that nobody controls.
 */
export function isValidNearIntentsAddress(kind: NearIntentsAddressKind, value: string): boolean {
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

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

function isBitcoinAddress(value: string): boolean {
  if (BITCOIN_SEGWIT.test(value)) return true;
  // A legacy address is a version byte, a 20-byte hash and a 4-byte checksum.
  return BITCOIN_LEGACY.test(value) && base58Length(value) === 25;
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

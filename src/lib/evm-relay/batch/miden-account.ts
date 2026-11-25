import type { Address } from 'viem';

/** A Miden account ID as hex: `0x` and 15 bytes (30 hex characters). */
export const MIDEN_ACCOUNT_HEX_PATTERN = /^0x[0-9a-fA-F]{30}$/;

/** True when the value is `0x` and 30 hex characters. */
export function isMidenAccountHex(value: string): boolean {
  return MIDEN_ACCOUNT_HEX_PATTERN.test(value);
}

/**
 * The Agglayer destination address of a Miden account: 4 zero bytes, the 15-byte account ID, 1 zero byte.
 * The result is lower case. Throws when the value is not a 15-byte hex account ID.
 */
export function midenAccountHexToEvmAddress(midenAccountHex: string): Address {
  if (!isMidenAccountHex(midenAccountHex)) {
    throw new Error('midenAccountHex is not a 15-byte hex account ID');
  }
  return `0x${'00'.repeat(4)}${midenAccountHex.slice(2).toLowerCase()}00`;
}

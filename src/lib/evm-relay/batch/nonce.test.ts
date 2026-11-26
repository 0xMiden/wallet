/**
 * @jest-environment node
 */
import { keccak256, stringToHex } from 'viem';

import { RELAY_NONCE_KEY, batchNonceOf, isRelayNonce } from './nonce';

describe('relay nonce', () => {
  it('uses the top 192 bits of the hash of the relay label as the key', () => {
    expect(RELAY_NONCE_KEY).toBe(BigInt(keccak256(stringToHex('miden.relay'))) >> 64n);
    expect(RELAY_NONCE_KEY).toBe(0x625edc9eddd5ad2d8507ea3f5fb24de6b1113c046527be38n);
  });

  it('puts the key above the 64-bit sequence', () => {
    expect(batchNonceOf(0n)).toBe(RELAY_NONCE_KEY << 64n);
    expect(batchNonceOf(7n)).toBe((RELAY_NONCE_KEY << 64n) | 7n);
    expect(batchNonceOf((1n << 64n) - 1n) >> 64n).toBe(RELAY_NONCE_KEY);
  });

  it('refuses a sequence that is not a uint64', () => {
    expect(() => batchNonceOf(-1n)).toThrow('The sequence must be a uint64');
    expect(() => batchNonceOf(1n << 64n)).toThrow('The sequence must be a uint64');
  });

  it('accepts only a nonce of the relay key', () => {
    expect(isRelayNonce(batchNonceOf(3n))).toBe(true);
    expect(isRelayNonce(3n)).toBe(false);
    expect(isRelayNonce(((RELAY_NONCE_KEY + 1n) << 64n) | 3n)).toBe(false);
    expect(isRelayNonce(-1n)).toBe(false);
  });
});

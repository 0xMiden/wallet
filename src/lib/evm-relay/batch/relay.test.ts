/**
 * @jest-environment node
 */
import { keccak256, stringToHex } from 'viem';

import { buildAgglayerDepositCalls } from './agglayer-deposit';
import { batchNonceOf, buildRelayCalls, nonceKeyOf } from './relay';
import { SEPOLIA_AGGLAYER_CONFIG, TEST_ERC20, TEST_MIDEN_ACCOUNT_HEX, prototypeNonceKey } from './testing';

describe('relay nonce', () => {
  it('derives the key of a kind from its label', () => {
    const key = nonceKeyOf('agglayer-deposit');
    expect(key).toBe(BigInt(keccak256(stringToHex('miden.relay.agglayer-deposit'))) >> 64n);
    expect(key < 1n << 192n).toBe(true);
    expect(key).not.toBe(prototypeNonceKey('miden.onramp'));
  });

  it('puts the key above the 64-bit sequence', () => {
    const key = nonceKeyOf('agglayer-deposit');
    expect(batchNonceOf('agglayer-deposit', 0n)).toBe(key << 64n);
    expect(batchNonceOf('agglayer-deposit', 9n)).toBe((key << 64n) + 9n);
    expect(batchNonceOf('agglayer-deposit', 9n) >> 64n).toBe(key);
  });

  it('refuses a sequence that is not a uint64', () => {
    expect(() => batchNonceOf('agglayer-deposit', -1n)).toThrow('uint64');
    expect(() => batchNonceOf('agglayer-deposit', 1n << 64n)).toThrow('uint64');
  });
});

describe('buildRelayCalls', () => {
  it('builds the calls of an agglayer deposit', () => {
    const params = { token: TEST_ERC20, amount: 100n, midenAccountHex: TEST_MIDEN_ACCOUNT_HEX, fee: null };
    expect(buildRelayCalls('agglayer-deposit', SEPOLIA_AGGLAYER_CONFIG, params)).toEqual(
      buildAgglayerDepositCalls(SEPOLIA_AGGLAYER_CONFIG, params)
    );
  });
});

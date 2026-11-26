import { keccak256, stringToHex, type Address, type Hex } from 'viem';

import type { BatchEnvelope, CaliburPin } from './calibur';

/**
 * Test vectors. They are the inputs of the golden digests of the onramp prototype (Sepolia), so the tests prove that
 * this module hashes a batch exactly as the prototype did.
 */

export const SEPOLIA_CALIBUR_PIN: CaliburPin = {
  address: '0x00000cAbFc76478C1537dd418aB00967cBbE4AE6',
  runtimeHash: '0xd8f2157116f6901840d009511732cb247c1ced614af48351f1c1e5d52deea1eb',
  domainName: 'Calibur',
  domainVersion: '1.0.0'
};

/** The nonce key of a prototype label (`miden.onramp`, `miden.offramp`). */
export function prototypeNonceKey(label: string): bigint {
  return BigInt(keccak256(stringToHex(label))) >> 64n;
}

export const PROTOTYPE_SALT: Hex = `0x${'0'.repeat(24)}00000cabfc76478c1537dd418ab00967cbbe4ae6`;

export const TEST_EVM_ADDRESS: Address = '0x1111111111111111111111111111111111111111';
export const TEST_EXECUTOR: Address = '0x2222222222222222222222222222222222222222';
export const TEST_FEE_RECIPIENT: Address = '0x3333333333333333333333333333333333333333';
export const TEST_ERC20: Address = '0x0c86a754a29714c4fe9c6f1359fa7099ed174c0b';
/** A contract that a test batch calls. It is the bridge of the prototype's buy vector. */
export const TEST_TARGET: Address = '0x528e26b25a34a4a5d0dbda1d57d318153d2ed582';

/** The envelope of the prototype's golden buy vector. */
export const PROTOTYPE_BUY_ENVELOPE: BatchEnvelope = {
  chainId: 11155111,
  evmAddress: TEST_EVM_ADDRESS,
  executor: TEST_EXECUTOR,
  batchNonce: prototypeNonceKey('miden.onramp') << 64n,
  salt: PROTOTYPE_SALT,
  deadline: 1900000000n
};

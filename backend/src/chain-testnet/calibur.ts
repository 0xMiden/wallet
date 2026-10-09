import {
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  parseAbi,
  stringToHex,
  zeroHash,
  type Address,
  type Hex,
  type TypedData
} from 'viem';

import { agglayerBridgeCalls } from './agglayer.js';
import { offrampTransferCalls } from './offramp.js';
import type { OrderSide } from '../orders/states.js';

/**
 * The Calibur signed batch of an order. A buy batches the Agglayer bridge calls (`agglayer.ts`); a sell batches one
 * transfer to Transak's deposit address (`offramp.ts`). The wallet has a byte-identical twin in
 * `src/lib/onramp/buy-batch.ts`. If you change a batch, the types or the domain, change the twin at the same time.
 */

export const SEPOLIA_CHAIN_ID = 11155111;

// Uniswap Calibur v1.1.0 on Sepolia. The runtime hash is checked before each prepare and relay.
export const CALIBUR_SEPOLIA_ADDRESS: Address = '0x00000cAbFc76478C1537dd418aB00967cBbE4AE6';
export const CALIBUR_RUNTIME_HASH: Hex = '0xd8f2157116f6901840d009511732cb247c1ced614af48351f1c1e5d52deea1eb';
/** The EIP-7702 code of an EOA that delegates to Calibur. */
export const CALIBUR_DELEGATION: Hex = `0xef0100${CALIBUR_SEPOLIA_ADDRESS.slice(2).toLowerCase()}`;
/** The Calibur nonce key of the on-ramp. The batch nonce is `key << 64 | sequence`. */
export const ONRAMP_NONCE_KEY = BigInt(keccak256(stringToHex('miden.onramp'))) >> 64n;
/** The Calibur nonce key of the off-ramp. Its own key, so a sell and a buy of one address never share a sequence. */
export const OFFRAMP_NONCE_KEY = BigInt(keccak256(stringToHex('miden.offramp'))) >> 64n;
/** A signed batch stays valid for at most this number of seconds. */
export const BUY_BATCH_TTL_SECONDS = 86_400;

export function nonceKeyOf(side: OrderSide): bigint {
  switch (side) {
    case 'buy':
      return ONRAMP_NONCE_KEY;
    case 'sell':
      return OFFRAMP_NONCE_KEY;
  }
}

export const CALIBUR_ABI = parseAbi([
  'struct Call { address to; uint256 value; bytes data; }',
  'struct BatchedCall { Call[] calls; bool revertOnFailure; }',
  'struct SignedBatchedCall { BatchedCall batchedCall; uint256 nonce; bytes32 keyHash; address executor; uint256 deadline; }',
  'function execute(SignedBatchedCall signedBatchedCall, bytes wrappedSignature) payable',
  'function getSeq(uint256 key) view returns (uint256)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)'
]);

/** One call of a Calibur batch. */
export interface BatchCall {
  to: Address;
  value: bigint;
  data: Hex;
}

const batchTypes = {
  SignedBatchedCall: [
    { name: 'batchedCall', type: 'BatchedCall' },
    { name: 'nonce', type: 'uint256' },
    { name: 'keyHash', type: 'bytes32' },
    { name: 'executor', type: 'address' },
    { name: 'deadline', type: 'uint256' }
  ],
  BatchedCall: [
    { name: 'calls', type: 'Call[]' },
    { name: 'revertOnFailure', type: 'bool' }
  ],
  Call: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' }
  ]
} satisfies TypedData;

export interface BatchInput {
  side: OrderSide;
  /** The EOA that delegates to Calibur. It is the verifying contract of the domain. */
  evmAddress: Address;
  midenAccountHex: string;
  token: Address;
  /** Sell only: Transak's deposit address. Null for a buy. */
  depositAddress: Address | null;
  /** Token base units. */
  amount: bigint;
  batchNonce: bigint;
  /** The `salt` of the Calibur `eip712Domain`. */
  salt: Hex;
  /** The only account that can execute the batch. */
  executor: Address;
  /** Unix time in seconds. */
  deadline: bigint;
}

function batchCalls(input: BatchInput): BatchCall[] {
  switch (input.side) {
    case 'buy':
      return agglayerBridgeCalls(input.token, input.amount, input.midenAccountHex);
    case 'sell':
      if (input.depositAddress === null) throw new Error('A sell batch needs the deposit address');
      return offrampTransferCalls(input.token, input.amount, input.depositAddress);
  }
}

export function buildBatch(input: BatchInput) {
  return {
    batchedCall: {
      calls: batchCalls(input),
      revertOnFailure: true
    },
    nonce: input.batchNonce,
    // The zero key hash selects the root key: the EOA key itself.
    keyHash: zeroHash,
    executor: input.executor,
    deadline: input.deadline
  };
}

export function batchTypedData(input: BatchInput) {
  const primaryType: 'SignedBatchedCall' = 'SignedBatchedCall';
  return {
    domain: {
      name: 'Calibur',
      version: '1.0.0',
      chainId: SEPOLIA_CHAIN_ID,
      verifyingContract: input.evmAddress,
      salt: input.salt
    },
    types: batchTypes,
    primaryType,
    message: buildBatch(input)
  };
}

export function batchDigest(input: BatchInput): Hex {
  return hashTypedData(batchTypedData(input));
}

/** The calldata of `execute` on the EOA. The wrapped signature is `abi.encode(bytes signature, bytes hookData)`. */
export function encodeExecution(input: BatchInput, signature: Hex): Hex {
  return encodeFunctionData({
    abi: CALIBUR_ABI,
    functionName: 'execute',
    args: [buildBatch(input), encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [signature, '0x'])]
  });
}

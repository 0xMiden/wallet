// The gas of a quote. At quote time the batch has no signature, so the Worker cannot simulate the real relay
// transaction, `execute(SignedBatchedCall, signature)` from the relayer. It simulates two things in its place, in the
// one JSON-RPC batch of the quote read (chain.ts):
//
// 1. The batch as the address itself: `execute(BatchedCall)` from the address to the address, with the delegation to
//    the pinned Calibur put on it by a state override. Calibur takes this self-call with the root key
//    (`msg.sender == address(this)`), and runs every call of the batch with the address as `msg.sender`, as the
//    signed path does. This is the gas of the calls, the self-call frame and its calldata.
// 2. The calibration batch: an empty batch of the Worker's own calibration account, once as a self-call and once
//    signed, from the relayer (with and without an EIP-7702 authorization). The difference is what the signed path
//    adds on this chain now: the 448 more calldata bytes, the signature check (ecrecover), the nonce write and the
//    authorization. The calibration account is new and empty, so its nonce write is a write to an empty slot and its
//    authorization is the one of an empty account: the most expensive cases. The chain's own gas schedule thus prices
//    these parts, not a constant of this file.
//
// The quote gas is (1) plus the larger of the measured difference and the floors below, plus what the empty
// calibration batch cannot measure: the parts of the signed path whose cost grows with the calls (the EIP-712 hash of
// each call, the hash of its data and one more copy of the batch into memory), and the calldata bytes whose value is
// not known at quote time (the fee amount, the sequence and the signature).
//
// Why the calibration batch is empty: under EIP-7623 a transaction with a lot of calldata pays the calldata floor price
// instead of its execution, and a calibration batch at the floor would measure the floor, not the signed path. An
// empty batch is never at the floor. When the user's batch is at the floor, the signed path adds at most the floor
// price of its extra calldata, which is the constant floor term below. A calibration batch with empty calls was tried
// too: on Ethereum Sepolia (a newer gas schedule) its per-call cost differed between the two paths, and it measured
// less than the real difference, so the per-call part stays a constant.
//
// The test `quote-gas.test.ts` proves the two encoding facts that this method depends on, and the README gives the
// live measurements on Base Sepolia and Ethereum Sepolia.
import { encodeFunctionData, maxUint256, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import type { QuoteCall, QuoteState, RelayAuthorization } from './chain';
import type { ChainConfig } from './config';
import type { Hex } from './parse';
import {
  batchNonceOf,
  batchTypedData,
  encodeExecution,
  type BatchCall,
  type BatchEnvelope
} from '../../../src/lib/evm-relay/batch';

/**
 * The self-call path of Calibur: `execute(BatchedCall)`. Only the address itself (the root key) or a registered key
 * can call it. The shared CALIBUR_ABI has the signed path only, so this file has its own fragment.
 */
export const SELF_EXECUTE_ABI = parseAbi([
  'struct Call { address to; uint256 value; bytes data; }',
  'struct BatchedCall { Call[] calls; bool revertOnFailure; }',
  'function execute(BatchedCall batchedCall) payable'
]);

/**
 * `execute(SignedBatchedCall, bytes)` has exactly this many calldata bytes more than `execute(BatchedCall)` of the same
 * calls, for any calls: two head words, the four fixed fields of SignedBatchedCall, and the wrapped signature (a
 * length word, two offsets, two lengths and three words for 65 bytes). The calibration batch measures their cost; the
 * floor term below needs the count.
 */
export const SIGNED_EXTRA_CALLDATA_BYTES = 448n;
/**
 * An upper bound of the gas of one calldata byte in any regime: a non-zero byte is 4 tokens, and the EIP-7623 floor
 * price is 10 gas per token (40 per byte). 64 leaves room for a higher floor price.
 */
export const CALLDATA_GAS_PER_BYTE_BOUND = 64n;
/**
 * The calldata bytes whose value the quote does not know: the fee amount (32, the quote simulates a fee of 1), the
 * sequence in the nonce (8, the calibration batch uses sequence 0) and the signature (65, its zero bytes vary).
 */
export const VARIABLE_CALLDATA_BYTES = 105n;
/**
 * Per call of the batch: the EIP-712 hash of the Call struct in the signed path (its encoding, two keccak256 and the
 * loop). The empty calibration batch has no call, so the quote adds this per call. Measured: the real difference grew
 * by about 1600 gas per call on Base Sepolia and 2000 on Ethereum Sepolia above the empty calibration batch.
 */
export const HASH_GAS_PER_CALL = 3_000n;
/**
 * Per byte of the self-call calldata: the signed path hashes the data of each call (6 gas per word) and copies the
 * batch into memory one time more than the self-call (3 gas per word to copy, 3 per word of memory, and the quadratic
 * memory cost). Measured: about 0.9 gas per byte on Base Sepolia and 0.4 on Ethereum Sepolia for a 2 KB call.
 */
export const HASH_GAS_PER_BYTE = 2n;
/**
 * The floor of the measured signature overhead: ecrecover (3000), the cold read and the first write of the nonce slot
 * (2100 + 20000), the cold read of the salt prefix (2100) and the calldata. A node that measures less is wrong.
 */
export const MIN_SIGNATURE_CHECK_GAS = 30_000n;
/** The floor of the measured authorization overhead: PER_EMPTY_ACCOUNT_COST of EIP-7702. */
export const MIN_AUTHORIZATION_GAS = 25_000n;

/** The batch of a quote: the calls of the request and a fee call of 1 base unit at its end. */
export function encodeSelfExecution(calls: readonly BatchCall[]): Hex {
  return encodeFunctionData({
    abi: SELF_EXECUTE_ABI,
    functionName: 'execute',
    args: [{ calls: [...calls], revertOnFailure: true }]
  });
}

/** The calibration account of this isolate: a new random key, so its nonce is 0 and its nonce slot is empty. */
let calibrationAccount: PrivateKeyAccount | null = null;
/** The signed calibration data of each chain, Calibur pin and executor. */
const CALIBRATIONS = new Map<string, QuoteCall['calibration']>();

function account(): PrivateKeyAccount {
  calibrationAccount ??= privateKeyToAccount(generatePrivateKey());
  return calibrationAccount;
}

/**
 * The calibration batch of the chain, for the executor: an empty batch with sequence 0 and the largest deadline (32
 * non-zero bytes, never below a real deadline's), and an authorization at nonce 0. The salt is the one of a new
 * account: a zero prefix and the Calibur address. The key is not a secret of the service: it controls no funds, and
 * it signs only these simulations. Each isolate signs one batch per chain.
 */
export async function calibrationFor(chain: ChainConfig, executor: Hex): Promise<QuoteCall['calibration']> {
  const key = `${chain.chainId}:${chain.calibur.address}:${chain.calibur.runtimeHash}:${executor}`;
  const known = CALIBRATIONS.get(key);
  if (known !== undefined) return known;
  const calls: BatchCall[] = [];
  const signer = account();
  const address: Hex = `0x${signer.address.slice(2).toLowerCase()}`;
  const salt: Hex = `0x${'00'.repeat(12)}${chain.calibur.address.slice(2)}`;
  const envelope: BatchEnvelope = {
    chainId: chain.chainId,
    evmAddress: address,
    executor,
    batchNonce: batchNonceOf(0n),
    salt,
    deadline: maxUint256
  };
  const signature = await signer.signTypedData(batchTypedData(chain.calibur, envelope, calls));
  const signed = await signer.signAuthorization({ address: chain.calibur.address, chainId: chain.chainId, nonce: 0 });
  if (typeof signed.yParity !== 'number') throw new Error('The calibration authorization has no yParity.');
  const authorization: RelayAuthorization = {
    address: chain.calibur.address,
    chainId: chain.chainId,
    nonce: 0,
    r: signed.r,
    s: signed.s,
    yParity: signed.yParity
  };
  const calibration = {
    address,
    selfData: encodeSelfExecution(calls),
    signedData: encodeExecution(envelope, calls, signature),
    authorization
  };
  CALIBRATIONS.set(key, calibration);
  return calibration;
}

function larger(...values: bigint[]): bigint {
  return values.reduce((left, right) => (left > right ? left : right));
}

export interface QuoteGasInput {
  /** The estimate of the batch as the address itself. */
  batchEstimate: bigint;
  calibration: QuoteState['calibration'];
  /** True when the relay transaction will carry an authorization. */
  authorization: boolean;
  /** The number of calls of the batch, the fee call included. */
  calls: number;
  /** The byte length of the self-call calldata. */
  dataBytes: number;
}

/** The overhead of the signed path: the measured difference, or the floors when they are higher. */
export function signedOverheadOf(input: Pick<QuoteGasInput, 'calibration' | 'authorization'>): bigint {
  const { calibration, authorization } = input;
  const signed = authorization ? calibration.signedWithAuthorization : calibration.signed;
  const measured = signed - calibration.self;
  const checkFloor = MIN_SIGNATURE_CHECK_GAS + (authorization ? MIN_AUTHORIZATION_GAS : 0n);
  return larger(measured, checkFloor, SIGNED_EXTRA_CALLDATA_BYTES * CALLDATA_GAS_PER_BYTE_BOUND);
}

/** The gas of a quote. See the head of this file. */
export function quoteGasOf(input: QuoteGasInput): bigint {
  return (
    input.batchEstimate +
    signedOverheadOf(input) +
    HASH_GAS_PER_CALL * BigInt(input.calls) +
    HASH_GAS_PER_BYTE * BigInt(input.dataBytes) +
    VARIABLE_CALLDATA_BYTES * CALLDATA_GAS_PER_BYTE_BOUND
  );
}

/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, erc20Abi, maxUint256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverAuthorizationAddress } from 'viem/utils';

import { CALIBUR_ADDRESS, TEST_EXECUTOR, oneChainConfig, quoteState } from './harness';
import {
  CALIBUR_ABI,
  RELAY_NONCE_KEY,
  batchNonceOf,
  buildFeeCall,
  encodeExecution,
  recoverBatchSigner,
  type BatchCall,
  type BatchEnvelope
} from '../../../src/lib/evm-relay/batch';
import { parseRelayConfig, type ChainConfig } from '../src/config';
import {
  CALLDATA_GAS_PER_BYTE_BOUND,
  HASH_GAS_PER_BYTE,
  HASH_GAS_PER_CALL,
  MIN_AUTHORIZATION_GAS,
  MIN_SIGNATURE_CHECK_GAS,
  SELF_EXECUTE_ABI,
  SIGNED_EXTRA_CALLDATA_BYTES,
  VARIABLE_CALLDATA_BYTES,
  calibrationFor,
  encodeSelfExecution,
  quoteGasOf,
  signedOverheadOf
} from '../src/quote-gas';

function chainOf(): ChainConfig {
  const chain = parseRelayConfig(oneChainConfig(), 'deduct', [8453]).chains.get(8453);
  if (chain === undefined) throw new Error('The test chain did not parse');
  return chain;
}

const bytesOf = (data: Hex): number => (data.length - 2) / 2;
const RECIPIENT: Hex = `0x${'fe'.repeat(20)}`;

/** Batches of 1 to 8 calls with data of many sizes, values and fee calls. */
function batches(): BatchCall[][] {
  const result: BatchCall[][] = [];
  for (let count = 1; count <= 8; count += 1) {
    for (const size of [0, 1, 31, 32, 33, 68, 500, 4_096]) {
      const calls: BatchCall[] = Array.from({ length: count - 1 }, (_value, index) => ({
        to: `0x${(index + 1).toString(16).padStart(40, '7')}`,
        value: BigInt(index) * 10n ** 18n,
        data: `0x${'ab'.repeat(size + index)}`
      }));
      calls.push(buildFeeCall({ token: `0x${'aa'.repeat(20)}`, recipient: RECIPIENT, amount: BigInt(size + 1) }));
      result.push(calls);
    }
  }
  return result;
}

describe('the encoding facts of the quote method', () => {
  it('encodes execute(BatchedCall) as the Calibur self-call selector 0x99e1d016, with the calls as sent', () => {
    const calls = batches()[20] ?? [];
    const data = encodeSelfExecution(calls);
    // The selector is in the pinned Calibur runtime code: see the README (Quote) for the check.
    expect(data.slice(0, 10)).toBe('0x99e1d016');
    const decoded = decodeFunctionData({ abi: SELF_EXECUTE_ABI, data });
    expect(decoded.args[0].revertOnFailure).toBe(true);
    expect(decoded.args[0].calls.map(call => [call.to.toLowerCase(), call.value, call.data])).toEqual(
      calls.map(call => [call.to, call.value, call.data])
    );
  });

  it('gives the signed execute exactly 448 calldata bytes more than the self-call, for every batch', () => {
    for (const calls of batches()) {
      const envelope: BatchEnvelope = {
        chainId: 8453,
        evmAddress: `0x${'12'.repeat(20)}`,
        executor: TEST_EXECUTOR,
        batchNonce: batchNonceOf(2n ** 64n - 1n),
        salt: `0x${'00'.repeat(12)}${CALIBUR_ADDRESS.slice(2)}`,
        deadline: maxUint256
      };
      const signed = encodeExecution(envelope, calls, `0x${'ff'.repeat(65)}`);
      expect(BigInt(bytesOf(signed) - bytesOf(encodeSelfExecution(calls)))).toBe(SIGNED_EXTRA_CALLDATA_BYTES);
    }
  });

  it('keeps the fee amount in 32 bytes of calldata, within the variable bytes', () => {
    const transfer = (amount: bigint): Hex =>
      encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [RECIPIENT, amount] });
    expect(bytesOf(transfer(1n))).toBe(bytesOf(transfer(2n ** 256n - 1n)));
    expect(VARIABLE_CALLDATA_BYTES).toBe(32n + 8n + 65n);
  });
});

describe('calibrationFor', () => {
  it('signs an empty batch with sequence 0 and the largest deadline, for the executor, and an authorization', async () => {
    const chain = chainOf();
    const calibration = await calibrationFor(chain, TEST_EXECUTOR);
    const decoded = decodeFunctionData({ abi: CALIBUR_ABI, data: calibration.signedData });
    if (decoded.functionName !== 'execute') throw new Error('The calibration data is not execute');
    const [batch] = decoded.args;
    expect(batch.batchedCall.calls).toEqual([]);
    expect(batch.nonce).toBe(RELAY_NONCE_KEY << 64n);
    expect(batch.executor.toLowerCase()).toBe(TEST_EXECUTOR);
    expect(batch.deadline).toBe(maxUint256);
    expect(calibration.selfData).toBe(encodeSelfExecution([]));

    const envelope: BatchEnvelope = {
      chainId: 8453,
      evmAddress: calibration.address,
      executor: TEST_EXECUTOR,
      batchNonce: batch.nonce,
      salt: `0x${'00'.repeat(12)}${CALIBUR_ADDRESS.slice(2)}`,
      deadline: maxUint256
    };
    const [signature] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], decoded.args[1]);
    const signer = await recoverBatchSigner(chain.calibur, envelope, [], signature);
    expect(signer.toLowerCase()).toBe(calibration.address);

    expect(calibration.authorization).toMatchObject({ address: CALIBUR_ADDRESS, chainId: 8453, nonce: 0 });
    const authority = await recoverAuthorizationAddress({ authorization: calibration.authorization });
    expect(authority.toLowerCase()).toBe(calibration.address);
  });

  it('signs once per chain and executor, and uses an account that is not the relayer', async () => {
    const chain = chainOf();
    const first = await calibrationFor(chain, TEST_EXECUTOR);
    expect(await calibrationFor(chain, TEST_EXECUTOR)).toBe(first);
    const other = privateKeyToAccount(`0x${'44'.repeat(32)}`).address.toLowerCase();
    const second = await calibrationFor(chain, `0x${other.slice(2)}`);
    expect(second).not.toBe(first);
    expect(second.address).toBe(first.address);
    expect(first.address).not.toBe(TEST_EXECUTOR);
  });

  it('keeps the calibration batch far below the EIP-7623 floor: its calldata is small', async () => {
    // At most 4 tokens per byte at 10 gas per token: the signed calldata adds at most 40 gas per byte above 21000,
    // while the signature check alone (ecrecover and the nonce write) is above 25000.
    const calibration = await calibrationFor(chainOf(), TEST_EXECUTOR);
    expect(bytesOf(calibration.signedData)).toBeLessThan(600);
    expect(bytesOf(calibration.selfData)).toBeLessThan(150);
  });
});

describe('quoteGasOf', () => {
  const calibration = quoteState().calibration;
  const extras = (calls: number, dataBytes: number): bigint =>
    HASH_GAS_PER_CALL * BigInt(calls) +
    HASH_GAS_PER_BYTE * BigInt(dataBytes) +
    VARIABLE_CALLDATA_BYTES * CALLDATA_GAS_PER_BYTE_BOUND;

  it('adds the measured overhead of the signed path when it is above the floors', () => {
    // signed 65000 - self 25000 = 40000, above the floor 30000 and the calldata floor 448 × 64 = 28672.
    expect(signedOverheadOf({ calibration, authorization: false })).toBe(40_000n);
    // signed with authorization 90000 - 25000 = 65000, above 30000 + 25000.
    expect(signedOverheadOf({ calibration, authorization: true })).toBe(65_000n);
    expect(quoteGasOf({ batchEstimate: 150_000n, calibration, authorization: false, calls: 3, dataBytes: 600 })).toBe(
      150_000n + 40_000n + extras(3, 600)
    );
  });

  it('uses the floors when a node measures less', () => {
    const low = { self: 30_000n, signed: 31_000n, signedWithAuthorization: 32_000n };
    // The larger floor: the signature check (30000) is above the calldata floor (448 × 64 = 28672).
    expect(SIGNED_EXTRA_CALLDATA_BYTES * CALLDATA_GAS_PER_BYTE_BOUND).toBe(28_672n);
    expect(signedOverheadOf({ calibration: low, authorization: false })).toBe(MIN_SIGNATURE_CHECK_GAS);
    expect(signedOverheadOf({ calibration: low, authorization: true })).toBe(
      MIN_SIGNATURE_CHECK_GAS + MIN_AUTHORIZATION_GAS
    );
    const negative = { self: 50_000n, signed: 40_000n, signedWithAuthorization: 40_000n };
    expect(signedOverheadOf({ calibration: negative, authorization: false })).toBeGreaterThan(0n);
  });

  it('follows a chain whose storage writes cost more: the measured overhead grows with it', () => {
    // Ethereum Sepolia measured 133438 for the signed path of an empty batch (README, Quote gas).
    const repriced = { self: 25_000n, signed: 158_438n, signedWithAuthorization: 183_438n };
    expect(signedOverheadOf({ calibration: repriced, authorization: false })).toBe(133_438n);
  });
});

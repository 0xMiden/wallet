import assert from 'node:assert/strict';
import { decodeFunctionData, isAddressEqual, keccak256, parseAbi, parseTransaction, recoverTransactionAddress } from 'viem';

const withdrawalAbi = parseAbi(['function forcedWithdrawal(uint256,address,uint256) returns (bool)']);

export function verifyGreen10ActivationEnvelope(serializedTransaction, plan) {
  return verifyEnvelope(serializedTransaction, plan, 122);
}

export async function verifyGreen10WithdrawalEnvelope(serializedTransaction, plan) {
  const { args: [, recipient, amount] } = decodeFunctionData({ abi: withdrawalAbi, data: plan.transaction.data });
  assert.ok(isAddressEqual(recipient, plan.account), 'Withdrawal recipient must be the original owner');
  assert.equal(amount, 981231n);
  return verifyEnvelope(serializedTransaction, plan, 123);
}

export async function verifyGreen10CleanupEnvelope(serializedTransaction, plan) {
  decodeFunctionData({ abi: parseAbi(['function disableForcedWithdrawal(uint256) returns (bool)']), data: plan.transaction.data });
  return verifyEnvelope(serializedTransaction, plan, 124);
}

// Return the hash only after the signed bytes match every frozen field.
async function verifyEnvelope(serializedTransaction, plan, nonce) {
  const decoded = parseTransaction(serializedTransaction);
  const tx = plan.transaction;
  assert.equal(tx.type, 'eip1559');
  assert.equal(tx.chainId, 1);
  assert.equal(tx.nonce, nonce);
  assert.equal(tx.value, 0n);
  assert.ok(isAddressEqual(decoded.to, tx.to), 'Activation destination changed');
  const signer = await recoverTransactionAddress({ serializedTransaction });
  assert.ok(isAddressEqual(signer, plan.account), 'Activation owner changed');
  assert.ok(!decoded.accessList?.length, 'Unexpected activation access list');
  assert.equal(decoded.value ?? 0n, tx.value);
  for (const key of ['type', 'chainId', 'nonce', 'data', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas'])
    assert.equal(decoded[key], tx[key], `Signed activation ${key} changed`);
  return keccak256(serializedTransaction);
}

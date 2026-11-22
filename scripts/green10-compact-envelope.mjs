import assert from 'node:assert/strict';
import { isAddressEqual, keccak256, parseTransaction, recoverTransactionAddress } from 'viem';

// Return only the hash of a signed activation whose complete envelope matches the frozen plan.
export async function verifyGreen10ActivationEnvelope(serializedTransaction, plan) {
  const decoded = parseTransaction(serializedTransaction);
  const tx = plan.transaction;
  assert.equal(tx.type, 'eip1559');
  assert.equal(tx.chainId, 1);
  assert.equal(tx.nonce, 122);
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

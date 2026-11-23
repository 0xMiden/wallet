import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from '../../fixtures/two-wallets';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { loadMainnetEpochCheckpoint } from '../../helpers/mainnet-epoch-checkpoint';
import { loadMainnetNearCheckpoint } from '../../helpers/mainnet-near-checkpoint';
import { parsePrivateKeyPair } from '../../../../src/lib/miden/guardian/private-key-pair';

test('reconcile canonical Epoch claim fees and restored native custody', async ({ walletB }) => {
  test.setTimeout(240_000);
  const read = (name: string) => JSON.parse(readFileSync(`test-results/fee-audit/${name}.json`, 'utf8'));
  const epoch = loadMainnetEpochCheckpoint('test-results/fee-audit/epoch.json');
  const swap = read('swap');
  const forward = read('forward');
  const reverse = read('reverse');
  assert.ok(epoch && epoch.sourceRunId === '45144351907' && epoch.phase === 'complete' && epoch.after && epoch.returnNoteId && epoch.returnMidenTxId);
  assert.equal(swap.phase, 'complete');
  for (const item of [swap, forward, reverse]) assert.equal(item.sourceRunId, epoch.sourceRunId);
  assert.equal(swap.account, epoch.account);
  assert.equal(swap.native.hex, epoch.native.hex);
  assert.equal(reverse.nativeFinal, epoch.native.balance);
  assert.equal(reverse.requestFinal, '0');
  const key = process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '';
  await restoreMainnetLoopGuardian(walletB, key);
  assert.equal(await walletB.getAccountAddress(), epoch.account);
  const vault = await vaultBalanceByFaucetId(walletB.page, epoch.native.faucetId);
  const near = loadMainnetNearCheckpoint('test-results/fee-audit/near.json');
  assert.ok(near && near.sourceRunId === epoch.sourceRunId && near.account === epoch.account && near.native.hex === epoch.native.hex && near.sendAuthority && near.returnNoteId && near.phase === "complete" && near.reverseReceived);
  const epochVault = BigInt(epoch.after.native);
  assert.equal(epochVault, BigInt(epoch.native.balance) - BigInt(epoch.principal) + BigInt(epoch.reverseReceived!) - BigInt(epoch.paidMidenFees));
  assert.equal(BigInt(near.native.balance), epochVault);

  const { GuardianHttpClient } = await import('@openzeppelin/guardian-client');
  const { EcdsaSigner } = await import('@openzeppelin/miden-multisig-client');
  const { AuthSecretKey, TransactionSummary } = await import('@miden-sdk/miden-sdk');
  const pair = parsePrivateKeyPair(key);
  assert.ok(pair);
  const bytes = Buffer.from(`01${pair.hotPrivateKey}`, 'hex');
  const signer = new EcdsaSigner(AuthSecretKey.deserialize(bytes));
  bytes.fill(0);
  const guardian = new GuardianHttpClient('https://guardian.cedar.internal.lambdaclass.com');
  guardian.setSigner(signer);
  const history = await guardian.getDeltaHistory(epoch.accountHex, { limit: 20 });
  const scopes = [
    [forward.originalNoteId, false], [forward.paybackNoteId, true],
    [reverse.originalNoteId, false], [reverse.paybackNoteId, true], [epoch.forwardNoteId, false], [epoch.returnNoteId, true], [near.sendAuthority.noteId, false], [near.returnNoteId, true]
  ] as const;
  const nonces = new Set<number>();
  const fees: bigint[] = [];
  assert.ok(history.entries.length <= 20);
  for (const [id, input] of scopes) {
    assert.match(id, /^0x[\da-f]{64}$/i);
    const matches = history.entries.filter(entry => (input ? entry.inputNotes : entry.outputNotes).some(note => note.noteId === id));
    assert.equal(matches.length, 1);
    const entry = matches[0];
    assert.ok(entry && entry.status === 'canonical' && Number.isSafeInteger(entry.nonce) && entry.nonce > 0 && !nonces.has(entry.nonce));
    nonces.add(entry.nonce);
    const row = await guardian.getDelta(epoch.accountHex, entry.nonce);
    assert.equal(row.accountId.toLowerCase(), epoch.accountHex);
    assert.equal(row.nonce, entry.nonce);
    assert.equal(row.status.status, 'canonical');
    const data = row.deltaPayload.txSummary.data;
    assert.ok(data.length > 0 && data.length <= 4_000_000);
    const tx = TransactionSummary.deserialize(Buffer.from(data, 'base64'));
    assert.equal(tx.accountDelta().id().toString(), epoch.accountHex);
    const outputs = tx.outputNotes().notes();
    const ids = input ? tx.inputNotes().notes().map(n => n.note().id().toString()) : outputs.map(n => n.id().toString());
    assert.equal(ids.filter(n => n === id).length, 1);
    const feeNotes = outputs.filter(output => output.metadata().tag().asU32() === 0xfee);
    assert.equal(feeNotes.length, 1);
    const paid = feeNotes[0]?.assets()?.fungibleAssets();
    assert.ok(paid?.length === 1 && paid[0]?.faucetId().toString() === epoch.native.hex && paid[0].amount() > 0n);
    fees.push(paid[0].amount());
  }
  assert.deepEqual(fees.slice(0, 4), [forward.legNativeDebitsBeforeClaim, forward.claimFee, reverse.legNativeDebitsBeforeClaim, reverse.claimFee].map(BigInt));
  const total = fees.slice(0, 4).reduce((sum, fee) => sum + fee, 0n);
  assert.equal(total, BigInt(swap.paidFees));
  const epochFee = fees[4]! + fees[5]!;
  assert.equal(epochFee, BigInt(epoch.paidMidenFees));
  const valuation = epoch.reverseAuthority?.valuation;
  assert.ok(valuation);
  const loss = (debit: bigint, price: string, unit: bigint) => debit > 0n ? (debit * BigInt(price) + unit - 1n) / unit : 0n;
  const nearFee = fees[6]!;
  const nearClaimFee = fees[7]!;
  assert.equal(nearFee + nearClaimFee, BigInt(near.paidMidenFees));
  assert.equal(vault, epochVault - BigInt(near.principal) + BigInt(near.reverseReceived) - nearFee - nearClaimFee);
  const cost = loss(BigInt(epoch.native.balance) - epochVault, valuation.stableUsdMicros, 10n ** 6n) +
    loss(BigInt(epoch.evm.tokenBalance) - BigInt(epoch.after.evmToken), valuation.stableUsdMicros, 10n ** 6n) +
    loss(BigInt(epoch.evm.nativeBalance) - BigInt(epoch.after.evmNative), valuation.gasUsdMicros, 10n ** 18n);
  const retained = BigInt(epoch.after.evmToken) - BigInt(epoch.evm.tokenBalance);
  assert.equal(retained, BigInt(epoch.forwardReceived!) - BigInt(epoch.returnAmount!));
  assert.ok(retained >= 0n);
  const net = cost - retained * BigInt(valuation.stableUsdMicros) / 1_000_000n;
  assert.equal(net > 0n ? net : 0n, BigInt(epoch.realizedCostUsdMicros!));
  const swapCost = loss(BigInt(swap.native.balance) - BigInt(epoch.native.balance), swap.native.usdMicros, 10n ** BigInt(swap.native.decimals));
  assert.equal(swapCost, BigInt(swap.realizedCostUsdMicros));
  console.log(`GREEN16_FEE_AUDIT ${JSON.stringify({ swapFees: String(total), swapCostUsdMicros: String(swapCost), epochNativeFee: String(epochFee), epochCostUsdMicros: String(cost), netCostUsdMicros: String(net), custodyMatches: true, nearForwardFee: String(nearFee), nearClaimFee: String(nearClaimFee) })}`);
});

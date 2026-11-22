import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from '../../fixtures/two-wallets';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { loadMainnetEpochCheckpoint } from '../../helpers/mainnet-epoch-checkpoint';
import { parsePrivateKeyPair } from '../../../../src/lib/miden/guardian/private-key-pair';

test('reconcile canonical Swap fees and held Epoch native custody', async ({ walletB }) => {
  test.setTimeout(240_000);
  const read = (name: string) => JSON.parse(readFileSync(`test-results/fee-audit/${name}.json`, 'utf8'));
  const epoch = loadMainnetEpochCheckpoint('test-results/fee-audit/epoch.json');
  const swap = read('swap');
  const forward = read('forward');
  const reverse = read('reverse');
  assert.ok(epoch && epoch.sourceRunId === '44985161986' && epoch.phase === 'recovery-required');
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
  assert.equal(vault, BigInt(epoch.native.balance) - BigInt(epoch.principal) - BigInt(epoch.paidMidenFees));

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
    [reverse.originalNoteId, false], [reverse.paybackNoteId, true], [epoch.forwardNoteId, false]
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
  assert.equal(fees[4], BigInt(epoch.paidMidenFees));
  const debit = BigInt(swap.native.balance) - vault - BigInt(epoch.principal) - fees[4]!;
  const unit = 10n ** BigInt(swap.native.decimals);
  const cost = debit > 0n ? (debit * BigInt(swap.native.usdMicros) + unit - 1n) / unit : 0n;
  assert.equal(cost, BigInt(swap.realizedCostUsdMicros));
  console.log(`GREEN10_FEE_AUDIT ${JSON.stringify({ swapFees: String(total), epochNativeFee: String(fees[4]), swapCostUsdMicros: String(cost), custodyMatches: true })}`);
});

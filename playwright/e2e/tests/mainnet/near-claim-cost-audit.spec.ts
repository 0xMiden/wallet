import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from '../../fixtures/two-wallets';
import { loadMainnetNearCheckpoint } from '../../helpers/mainnet-near-checkpoint';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { parsePrivateKeyPair } from '../../../../src/lib/miden/guardian/private-key-pair';

const path = 'test-results/near-claim-audit/roundtrip.json';
test('audit the two canonical NEAR fees and restored native custody without spending', async ({ walletB }) => {
  test.setTimeout(220_000);
  const state = loadMainnetNearCheckpoint(path);
  assert.ok(state?.phase === 'complete' && state.sendAuthority && state.returnNoteId && state.reverseReceived);
  let stage = 'restore';
  const emit = (facts: object) => writeFileSync('test-results/near-claim-audit-result.json', JSON.stringify({ stage, ...facts }), { mode: 0o600 });
  try {
    const scope = process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '';
    await restoreMainnetLoopGuardian(walletB, scope);
    assert.equal(await walletB.getAccountAddress(), state.account);
    stage = 'guardian-history';
    const pair = parsePrivateKeyPair(scope);
    assert.ok(pair);
    const { GuardianHttpClient } = await import('@openzeppelin/guardian-client');
    const { EcdsaSigner } = await import('@openzeppelin/miden-multisig-client');
    const { AuthSecretKey, TransactionSummary } = await import('@miden-sdk/miden-sdk');
    const raw = Buffer.from(`01${pair.hotPrivateKey}`, 'hex');
    const key = (() => { try { return AuthSecretKey.deserialize(raw); } finally { raw.fill(0); } })();
    const guardian = new GuardianHttpClient('https://guardian.cedar.internal.lambdaclass.com');
    guardian.setSigner(new EcdsaSigner(key));
    const history = await guardian.getDeltaHistory(state.accountHex, { limit: 20 });
    assert.ok(history.entries.length <= 20);
    const fee = async (id: string, side: 'inputNotes' | 'outputNotes') => {
      const hits = history.entries.filter(x => x[side].some(n => n.noteId === id));
      assert.equal(hits.length, 1);
      const hit = hits[0]!;
      assert.equal(hit.status, 'canonical');
      const delta = await guardian.getDelta(state.accountHex, hit.nonce);
      assert.equal(delta.accountId, state.accountHex);
      assert.equal(delta.nonce, hit.nonce);
      assert.equal(delta.status.status, 'canonical');
      const encoded = delta.deltaPayload.txSummary.data;
      assert.ok(encoded.length > 0 && encoded.length <= 4_000_000);
      const summary = TransactionSummary.deserialize(Buffer.from(encoded, 'base64'));
      assert.equal(summary.accountDelta().id().toString(), state.accountHex);
      const ids = side === 'inputNotes' ? summary.inputNotes().notes().map(n => n.note().id().toString()) :
        summary.outputNotes().notes().map(n => n.id().toString());
      assert.equal(ids.filter(x => x === id).length, 1);
      if (side === 'inputNotes') assert.deepEqual(ids, [id]);
      const feeOutputs = summary.outputNotes().notes().filter(n => n.metadata().tag().asU32() === 0xfee);
      assert.equal(feeOutputs.length, 1);
      const assets = feeOutputs[0]!.assets();
      assert.equal(assets?.assets().length, 1);
      const asset = assets?.fungibleAssets()[0];
      assert.equal(asset?.faucetId().toString(), state.native.hex);
      assert.ok(asset && asset.amount() > 0n);
      return { amount: asset.amount(), nonce: hit.nonce };
    };
    const forward = await fee(state.sendAuthority.noteId, 'outputNotes');
    const claim = await fee(state.returnNoteId, 'inputNotes');
    assert.equal(claim.nonce, forward.nonce + 1);
    assert.equal((forward.amount + claim.amount).toString(), state.paidMidenFees);
    stage = 'custody';
    const live = await vaultBalanceByFaucetId(walletB.page, state.native.faucetId);
    assert.equal(live, BigInt(state.native.balance) - BigInt(state.principal) + BigInt(state.reverseReceived) - forward.amount - claim.amount);
    emit({ custodyVerified: true, forwardFee: forward.amount.toString(), claimFee: claim.amount.toString() });
  } catch {
    emit({ failed: true });
    throw new Error(`Read-only NEAR settlement audit stopped at ${stage}`);
  }
});

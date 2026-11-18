import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from '../../fixtures/two-wallets';
import { canonicalMainnetLoopFaucet } from '../../helpers/mainnet-loop-config';
import { vaultBalanceByFaucetId, walletDiscoveredBaseFee } from '../../helpers/balance-truth';
import { readTransactionRows, TxStatus } from '../../helpers/history';
import { readLiveSwapLeg } from '../../helpers/mainnet-swap-ui';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { loadMainnetSwapCheckpoint, minimumFirstSwapRecoveryReturn } from '../../helpers/mainnet-swap-checkpoint';
import { authorizeMainnetSwapRecoveryReturn, readMainnetSwapPayback } from '../../helpers/mainnet-swap-claim';
import { tokenValueUsdMicro } from '../../helpers/mainnet-one-click-plan';

const checkpoint = 'test-results/producer/roundtrip.json';
const digest = () => createHash('sha256').update(readFileSync(checkpoint)).digest('hex');

test.use({ injectFeeFaucet: false });
test('reconcile original Swap forward receipt and held custody without spending', async ({ walletB }) => {
  test.setTimeout(300_000);
  const hash = digest();
  assert.equal(hash, '98a6648aca629253a93799afa01f931e1fe33b98feff6ec7b6237f687461e072');
  const state = loadMainnetSwapCheckpoint(checkpoint);
  const receipt = JSON.parse(readFileSync('test-results/summary/mainnet-swap-forward-claim.json', 'utf8'));
  assert.equal(state?.sourceRunId, '44201522315');
  assert.equal(state.phase, 'forward-settled');
  const authority = state.forwardRequestAuthority;
  assert.ok(authority && state.forwardClaimAuthority && state.forwardReceived);
  assert.equal(state.reverseRequestAuthority, undefined);
  assert.equal(state.reverseOrderId, undefined);
  const proof = await readMainnetSwapPayback('https://rpc.mainnet.miden.io', {
    kind: 'swap', accountId: canonicalMainnetLoopFaucet(state.account), faucetId: state.offer.hex, amount: state.principal,
    requestedFaucetId: state.request.hex, requestedAmount: authority.minimumReceive, noteId: authority.noteId,
    orderId: authority.orderId
  });
  assert.ok(proof && proof.claimedAtBlock !== undefined);
  assert.equal(proof.noteId, state.forwardClaimAuthority.noteId);
  assert.equal(proof.noteId, receipt.paybackNoteId);
  assert.equal(proof.claimedAtBlock, receipt.claimedAtBlock);
  assert.equal(proof.originalCreatedAtBlock, receipt.creationAtBlock);
  assert.equal(proof.amount.toString(), state.forwardReceived);
  await restoreMainnetLoopGuardian(walletB, process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '');
  assert.equal(await walletB.getAccountAddress(), state.account);
  const native = await vaultBalanceByFaucetId(walletB.page, state.native.faucetId);
  const held = await vaultBalanceByFaucetId(walletB.page, state.request.faucetId);
  assert.equal(native.toString(), receipt.nativeFinal);
  assert.equal(held.toString(), receipt.requestFinal);
  assert.equal(held, BigInt(state.request.balance) + proof.amount);
  const fees = BigInt(state.native.balance) - BigInt(state.principal) - native;
  assert.equal(fees.toString(), state.paidFees);
  assert.equal(fees, BigInt(receipt.claimFee) + BigInt(receipt.legNativeDebitsBeforeClaim));
  const keys = ['e2e_mainnet_send_authorization', 'e2e_mainnet_consume_authorization', 'e2e_mainnet_consume_authorization_required'];
  const policies = await walletB.page.evaluate(names => chrome.storage.local.get(names), keys);
  assert.equal(policies[keys[0]!], undefined);
  assert.equal(policies[keys[1]!], undefined);
  assert.deepEqual(policies[keys[2]!], { status: 'blocked' });
  assert.ok(
    !(await readTransactionRows(walletB.page)).some(
      row => row.status === TxStatus.Queued || row.status === TxStatus.GeneratingTransaction || row.status === TxStatus.Unconfirmed
    )
  );
  const fee = await walletDiscoveredBaseFee(walletB.page);
  assert.ok(fee !== null && fee > 0 && BigInt(fee) <= BigInt(state.baseFee));
  const quote = await readLiveSwapLeg('https://api.forkchoice.xyz', state.request, state.offer, proof.amount);
  const recoveryFloor = minimumFirstSwapRecoveryReturn(state);
  const priceEligible = quote.minimumReceive >= recoveryFloor;
  if (priceEligible) {
    const runId = process.env.GITHUB_RUN_ID;
    assert.ok(runId);
    const preview = authorizeMainnetSwapRecoveryReturn(
      state, proof, { offer: native, native, request: held }, runId,
      new Date().toISOString(), quote.minimumReceive
    );
    assert.equal(preview.reverseMinimum, state.reverseMinimum);
    assert.equal(preview.reverseRequestAuthority, undefined);
    assert.equal(preview.phase, 'reverse-authorized');
  }
  assert.equal(digest(), hash);
  const debit = tokenValueUsdMicro(BigInt(state.native.balance) - native, state.native.decimals, BigInt(state.native.usdMicros), true);
  const heldValue = tokenValueUsdMicro(proof.amount, state.request.decimals, BigInt(state.request.usdMicros), false);
  writeFileSync('test-results/green03-custody.json', JSON.stringify({
    sourceRunId: state.sourceRunId, checkpointHash: hash, publicForwardProofPassed: true,
    privateHeldCustodyPassed: true, noLiveAuthorization: true, checkpointUnchanged: true,
    nativeFees: fees.toString(), heldBaseUnits: held.toString(),
    interimPortfolioLossUsdMicros: (debit > heldValue ? debit - heldValue : 0n).toString(),
    recoveryFloor: recoveryFloor.toString(), quotedMinimum: quote.minimumReceive.toString(),
    priceEligible, grantPersisted: false, roundTripComplete: false
  }));
});

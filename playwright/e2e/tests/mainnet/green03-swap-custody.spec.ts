import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from '../../fixtures/two-wallets';
import { canonicalMainnetLoopFaucet } from '../../helpers/mainnet-loop-config';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { loadMainnetSwapCheckpoint } from '../../helpers/mainnet-swap-checkpoint';
import { readMainnetSwapPayback } from '../../helpers/mainnet-swap-claim';
import { tokenValueUsdMicro } from '../../helpers/mainnet-one-click-plan';

const finalPath = 'test-results/settled/roundtrip.json';
const digest = () => createHash('sha256').update(readFileSync(finalPath)).digest('hex');

test.use({ injectFeeFaucet: false });
test('independently reconcile completed original Swap custody and costs', async ({ walletB }) => {
  test.setTimeout(300_000);
  const hash = digest();
  assert.equal(hash, '540c4131b0a12efccf66188aa75027db599939c9bd266698a82f7f4782ac85c9');
  const state = loadMainnetSwapCheckpoint(finalPath);
  assert.ok(state);
  assert.equal(state.phase, 'complete');
  assert.equal(state.sourceRunId, '44201522315');
  assert.equal(state.authorizationRunId, '44311095206');
  assert.equal(state.reverseMinimum, '1009546');
  assert.equal(state.recoveryReturnMinimum, '1009445');
  let fees = 0n;
  for (const leg of ['forward', 'reverse'] as const) {
    const forward = leg === 'forward';
    const authority = forward ? state.forwardRequestAuthority : state.reverseRequestAuthority;
    const claim = forward ? state.forwardClaimAuthority : state.reverseClaimAuthority;
    const amount = forward ? state.principal : state.returnAmount;
    assert.ok(authority && claim && amount);
    const receipt = JSON.parse(readFileSync(`test-results/${leg}/mainnet-swap-${leg}-claim.json`, 'utf8'));
    const proof = await readMainnetSwapPayback('https://rpc.mainnet.miden.io', {
      kind: 'swap', accountId: canonicalMainnetLoopFaucet(state.account),
      faucetId: (forward ? state.offer : state.request).hex, amount,
      requestedFaucetId: (forward ? state.request : state.offer).hex,
      requestedAmount: authority.minimumReceive, noteId: authority.noteId, orderId: authority.orderId
    });
    assert.ok(proof && proof.claimedAtBlock !== undefined);
    assert.equal(proof.noteId, claim.noteId);
    assert.equal(proof.noteId, receipt.paybackNoteId);
    assert.equal(proof.claimedAtBlock, receipt.claimedAtBlock);
    assert.equal(proof.originalCreatedAtBlock, receipt.creationAtBlock);
    assert.equal(proof.amount.toString(), receipt.paybackAmount);
    assert.equal(proof.amount.toString(), forward ? state.forwardReceived : state.reverseReceived);
    fees += BigInt(receipt.claimFee) + BigInt(receipt.legNativeDebitsBeforeClaim);
  }
  await restoreMainnetLoopGuardian(walletB, process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '');
  assert.equal(await walletB.getAccountAddress(), state.account);
  const native = await vaultBalanceByFaucetId(walletB.page, state.native.faucetId);
  const requested = await vaultBalanceByFaucetId(walletB.page, state.request.faucetId);
  assert.equal(requested, BigInt(state.request.balance));
  assert.ok(state.reverseReceived);
  assert.equal(native, BigInt(state.native.balance) - BigInt(state.principal) + BigInt(state.reverseReceived) - fees);
  assert.equal(fees.toString(), state.paidFees);
  const keys = ['e2e_mainnet_send_authorization', 'e2e_mainnet_consume_authorization', 'e2e_mainnet_consume_authorization_required'];
  const policies = await walletB.page.evaluate(names => chrome.storage.local.get(names), keys);
  assert.equal(policies[keys[0]!], undefined);
  assert.equal(policies[keys[1]!], undefined);
  assert.deepEqual(policies[keys[2]!], { status: 'blocked' });
  const debit = BigInt(state.native.balance) - native;
  assert.ok(debit >= 0n);
  const actual = tokenValueUsdMicro(debit, state.native.decimals, BigInt(state.native.usdMicros), true);
  assert.equal(actual.toString(), state.realizedCostUsdMicros);
  assert.equal(digest(), hash);
  writeFileSync('test-results/green03-custody.json', JSON.stringify({
    sourceRunId: state.sourceRunId, recoveryRunId: state.authorizationRunId, checkpointHash: hash,
    publicBothLegsPassed: true, privateCustodyPassed: true, noLiveAuthorization: true,
    actualCostUsdMicros: actual.toString(), paidNativeFees: fees.toString(),
    checkpointUnchanged: true, noNewAuthority: true
  }));
});

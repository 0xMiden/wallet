import assert from 'node:assert/strict';
import { test } from '../../fixtures/two-wallets';
import { fetchOneClickStatus } from '../../../../src/lib/one-click/client';
import { hashOneClickQuote } from '../../../../src/lib/one-click/signature';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { loadMainnetNearCheckpoint } from '../../helpers/mainnet-near-checkpoint';
import { createMainnetOneClickOriginFetcher } from '../../helpers/mainnet-one-click-origin';
import { readMainnetMidenOutputCandidates } from '../../helpers/mainnet-miden-indexer';
import { readTransactionRowsWithBytes } from '../../helpers/history';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { exportPublicInputNote } from '../../helpers/swap';
import { inspectMainnetReturnNote } from '../../helpers/mainnet-miden-request';

const path = 'test-results/near-claim-readonly/roundtrip.json';
test('inspect the staged native return in the original wallet without authorizing a claim', async ({ walletB }) => {
  test.setTimeout(220_000);
  const state = loadMainnetNearCheckpoint(path);
  assert.ok(state?.retiredReturn && state.reverseQuote && state.transactions?.[0]?.feeWei && !state.consumeAuthority);
  let stage = 'restore';
  try {
    await restoreMainnetLoopGuardian(walletB, process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '');
    assert.equal(await walletB.getAccountAddress(), state.account);
    stage = 'provider';
    const quote = state.reverseQuote;
    const status = await fetchOneClickStatus(
      { serviceUrl: state.serviceUrl, chains: [], midenAssets: [] }, quote.depositAddress, undefined, undefined,
      createMainnetOneClickOriginFetcher(state.serviceUrl, walletB.extensionId)
    );
    assert.equal(hashOneClickQuote(status.quoteResponse), quote.quoteHash);
    assert.equal(status.status, 'SUCCESS');
    assert.deepEqual(status.swapDetails.originChainTxHashes.map(x => x.hash.toLowerCase()), [state.transactions[0].hash]);
    const destination = status.swapDetails.destinationChainTxHashes;
    assert.equal(destination.length, 1);
    const id = destination[0]!.hash.toLowerCase();
    stage = 'indexer';
    const exact = await readMainnetMidenOutputCandidates(id, state.accountHex, fetch, true);
    assert.deepEqual(exact.noteIds, [id]);
    stage = 'wallet';
    await walletB.triggerSync(true);
    await walletB.navigateTo('/history?filter=pending&view=list');
    let exportMatches = false;
    try {
      exportMatches = inspectMainnetReturnNote(
        { noteId: id, accountHex: state.accountHex, faucetHex: state.native.hex, minimumOutput: BigInt(quote.minimumOutput) },
        Buffer.from(await exportPublicInputNote(walletB, id), 'hex')
      ).toString() === status.swapDetails.amountOut;
    } catch { /* Missing local bytes is evidence, not proof of custody loss. */ }
    const visible = await walletB.page.locator(`[data-pending-note-id="${id}"]`).count() === 1;
    const claimRows = (await readTransactionRowsWithBytes(walletB.page, 'consume')).filter(row => row.noteIds?.includes(id)).length;
    const custodyMatches = await vaultBalanceByFaucetId(walletB.page, state.native.faucetId) ===
      BigInt(state.native.balance) - BigInt(state.principal) - BigInt(state.paidMidenFees);
    const { writeFileSync } = await import('node:fs');
    writeFileSync('test-results/near-claim-observation.json', JSON.stringify({ stage, exportMatches, visible, claimRows, custodyMatches }), { mode: 0o600 });
  } catch {
    const { writeFileSync } = await import('node:fs');
    writeFileSync('test-results/near-claim-observation.json', JSON.stringify({ stage, failed: true }), { mode: 0o600 });
    throw new Error(`Read-only NEAR diagnostic failed at ${stage}`);
  }
});

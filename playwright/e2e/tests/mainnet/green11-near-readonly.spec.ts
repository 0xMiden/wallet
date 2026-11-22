import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createPublicClient, erc20Abi, getAddress, http } from 'viem';
import { test } from '../../fixtures/two-wallets';
import { plantQueueBlocker, releaseQueueBlocker } from '../../helpers/history';
import { fromBaseUnits, vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { mainnetChain, mainnetRpc } from '../../helpers/mainnet-bridge-sources';
import { loadMainnetNearCheckpoint } from '../../helpers/mainnet-near-checkpoint';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { createMainnetOneClickOriginFetcher } from '../../helpers/mainnet-one-click-origin';
import { fetchOneClickStatus } from '../../../../src/lib/one-click/client';
import { hashOneClickQuote } from '../../../../src/lib/one-click/signature';

test('verify expired NEAR quote custody and observe Send review without arming', async ({ walletB }) => {
  test.setTimeout(240_000);
  let stage = 'checkpoint';
  let custodyMatches = false;
  let providerUnused = false;
  let reviewReached = false;
  try {
    const state = loadMainnetNearCheckpoint('test-results/near-readonly/roundtrip.json');
    const quote = state?.forwardQuote;
    assert.ok(state && state.sourceRunId === '45055827591' && state.phase === 'forward-authorized' && quote);
    assert.ok(!state.sendAuthority && !state.forwardMidenTxId && !state.forwardEvmTxHash && Date.now() > Date.parse(quote.deadline));
    stage = 'restore';
    await restoreMainnetLoopGuardian(walletB, process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '');
    assert.equal(await walletB.getAccountAddress(), state.account);
    stage = 'custody';
    assert.equal(await vaultBalanceByFaucetId(walletB.page, state.native.faucetId), BigInt(state.native.balance));
    const evm = state.evm;
    assert.equal(evm.chainId, 42161);
    const client = createPublicClient({ chain: mainnetChain(evm.chainId), transport: http(mainnetRpc(evm.chainId), { retryCount: 0 }) });
    const account = getAddress(evm.account);
    assert.equal(await client.getChainId(), evm.chainId);
    for (const blockTag of ['latest', 'pending', 'finalized'] as const) {
      assert.equal(await client.getBalance({ address: account, blockTag }), BigInt(evm.nativeBalance));
      assert.equal(await client.readContract({ address: getAddress(evm.token), abi: erc20Abi, functionName: 'balanceOf', args: [account], blockTag }), BigInt(evm.tokenBalance));
      assert.equal(await client.getTransactionCount({ address: account, blockTag }), 87);
    }
    custodyMatches = true;
    stage = 'signed-provider-status';
    const status = await fetchOneClickStatus({ serviceUrl: state.serviceUrl, chains: [], midenAssets: [{ id: 'usdcx', assetId: state.nativeAssetId, faucetId: state.native.hex, decimals: 6 }] }, quote.depositAddress, undefined, undefined, createMainnetOneClickOriginFetcher(state.serviceUrl, walletB.extensionId));
    assert.equal(hashOneClickQuote(status.quoteResponse), quote.quoteHash);
    assert.equal(status.status, 'PENDING_DEPOSIT');
    const details = status.swapDetails;
    assert.ok(!details.intentHashes.length && !details.nearTxHashes.length && !details.originChainTxHashes.length && !details.destinationChainTxHashes.length);
    assert.equal(BigInt(details.depositedAmount ?? 0), 0n);
    providerUnused = true;
    stage = 'queue-blocker';
    const blocker = await plantQueueBlocker(walletB.page);
    try {
      stage = 'send-review-with-blocker';
      await walletB.prepareSendReview({ recipientAddress: quote.depositAddress, amount: fromBaseUnits(BigInt(state.principal), 6), isPrivate: false, tokenSymbol: 'USDCX' });
      reviewReached = true;
    } finally {
      await releaseQueueBlocker(walletB.page, blocker);
    }
  } finally {
    writeFileSync('test-results/near-readonly-result.json', JSON.stringify({ stage, custodyMatches, providerUnused, reviewReached }), { mode: 0o600 });
  }
});

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createPublicClient, erc20Abi, getAddress, http } from 'viem';
import { test } from '../../fixtures/two-wallets';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { mainnetChain, mainnetRpc } from '../../helpers/mainnet-bridge-sources';
import { loadMainnetNearCheckpoint } from '../../helpers/mainnet-near-checkpoint';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';

test('verify the quote-less NEAR forward checkpoint left custody and the EVM nonce unchanged', async ({ walletB }) => {
  test.setTimeout(240_000);
  let stage = 'checkpoint';
  let custodyMatches = false;
  try {
    const state = loadMainnetNearCheckpoint('test-results/near-readonly/roundtrip.json');
    assert.ok(state && state.sourceRunId === '45334301017' && state.authorizationRunId === '45334301017');
    assert.ok(state.phase === 'forward-authorized' && state.paidMidenFees === '0' && state.paidEvmFees === '0');
    assert.ok(!state.forwardQuote && !state.sendAuthority && !state.forwardMidenTxId && !state.forwardEvmTxHash);
    assert.ok(!state.reverseQuote && !state.consumeAuthority && !state.transactions?.length);
    assert.equal(state.evmNonceBefore, undefined);
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
  } finally {
    writeFileSync('test-results/near-readonly-result.json', JSON.stringify({ stage, custodyMatches }), { mode: 0o600 });
  }
});

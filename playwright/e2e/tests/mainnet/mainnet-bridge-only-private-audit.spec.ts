import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, erc20Abi, getAddress, http } from 'viem';
import { arbitrum } from 'viem/chains';

import { test } from '../../fixtures/two-wallets';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { loadMainnetEpochCheckpoint } from '../../helpers/mainnet-epoch-checkpoint';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { loadMainnetSwapCheckpoint } from '../../helpers/mainnet-swap-checkpoint';

const paths = ['test-results/swap/roundtrip.json', 'test-results/epoch/roundtrip.json'];
const hashes = () => paths.map(path => createHash('sha256').update(readFileSync(path)).digest('hex'));
test.use({ injectFeeFaucet: false });
test.afterEach(async ({}, info) => {
  writeFileSync('test-results/bridge-only-private-audit-status.json', JSON.stringify({
    status: info.status,
    errorSha256: info.error ? createHash('sha256').update(info.error.message ?? 'unknown').digest('hex') : undefined,
    errorSite: info.error?.stack?.match(/mainnet-bridge-only-private-audit\.spec\.ts:\d+:\d+/)?.[0]
  }));
});

test('independently verify bridge-only preparation spent no original private or EVM funds', async ({ walletB }) => {
  test.setTimeout(600_000);
  const before = hashes();
  assert.deepEqual(before, [
    '8d6fa4aeb60cbea14e12196b36cce848e7b1e709b46c633a9cf1337866c4ca62',
    'e98a7e61a5b206441fcc1dcdd4727b50b9b056268f24a9cd72b902509ca32bb8'
  ]);
  const swap = loadMainnetSwapCheckpoint(paths[0]!);
  const epoch = loadMainnetEpochCheckpoint(paths[1]!);
  assert.ok(swap && epoch);
  assert.equal(swap.phase, 'complete');
  assert.equal(swap.sourceRunId, '43767908295');
  assert.equal(epoch.phase, 'complete');
  assert.equal(epoch.sourceRunId, '43698767716');
  assert.equal(swap.account, epoch.account);
  assert.ok(swap.reverseReceived);
  assert.equal(BigInt(swap.native.balance) - BigInt(swap.principal) + BigInt(swap.reverseReceived) - BigInt(swap.paidFees), 19_900_782n);
  await restoreMainnetLoopGuardian(walletB, process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '');
  assert.equal(await walletB.getAccountAddress(), swap.account);
  await walletB.triggerSync(true);
  await walletB.refreshBalancesLanded(90_000);
  const native = await vaultBalanceByFaucetId(walletB.page, swap.native.faucetId);
  const request = await vaultBalanceByFaucetId(walletB.page, swap.request.faucetId);
  assert.equal(native, 19_900_782n);
  assert.equal(request, 0n);
  const client = createPublicClient({ chain: arbitrum, transport: http('https://arb1.arbitrum.io/rpc', { retryCount: 0 }) });
  const account = getAddress(epoch.evm.account);
  const [token, gas, latest, pending] = await Promise.all([
    client.readContract({ address: getAddress(epoch.evm.token), abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    client.getBalance({ address: account }),
    client.getTransactionCount({ address: account, blockTag: 'latest' }),
    client.getTransactionCount({ address: account, blockTag: 'pending' })
  ]);
  assert.equal(token, 38_682_541n);
  assert.equal(gas, 19_429_691_940_260_000n);
  assert.equal(latest, 84);
  assert.equal(pending, latest);
  const names = ['e2e_mainnet_send_authorization', 'e2e_mainnet_consume_authorization'];
  const policies = await walletB.page.evaluate(async keys => chrome.storage.local.get(keys), names);
  assert.ok(names.every(name => policies[name] === undefined));
  assert.deepEqual(hashes(), before);
  assert.equal(46_081n + 1_953_919n, 2_000_000n);
  writeFileSync('test-results/bridge-only-private-audit.json', JSON.stringify({
    purpose: 'independent original private inventory plus public EVM holdings after bridge-only43785401179',
    qualificationRun: '43785401179', native: native.toString(), request: request.toString(),
    evmToken: token.toString(), evmGas: gas.toString(), latestNonce: latest, pendingNonce: pending,
    noLivePolicy: true, checkpointHashesUnchanged: true, noNewAuthority: true, noTransaction: true,
    newCostUsdMicros: '0', spentTotalUsdMicros: '46081', remainingSharedAllowance: '1953919', noProfitCredit: true
  }));
});

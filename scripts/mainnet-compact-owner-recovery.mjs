import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, isAddressEqual } from 'viem';
import { mainnet } from 'viem/chains';
import { COMPACT_ABI } from '../node_modules/@epoch-protocol/epoch-intents-sdk/dist/abis/compact.js';
import { fetchMainnetOneClickUsdPrices } from '../node_modules/.cache/nightly-compact-prices.mjs';
import {
  ORIGINAL_COMPACT_RECOVERY as c,
  compactRecoveryIntent,
  assertCompactRecoveryFees
} from './mainnet-compact-recovery-guard.mjs';

const fingerprintKey = randomBytes(32);
const client = createPublicClient({
  chain: mainnet,
  transport: http('https://ethereum-rpc.publicnode.com', { retryCount: 0 })
});
const json = value => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
const report = {
  version: 1,
  sourceRunId: c.sourceRunId,
  checkpointSha256: c.checkpointSha256,
  runId: process.env.GITHUB_RUN_ID,
  sourceSha: process.env.GITHUB_SHA,
  stage: 'enable',
  status: 'running',
  ownerPrivateKeyLoaded: false,
  signatureCreated: false,
  broadcast: false
};
let site = 'public-private-binding';
try {
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1');
  assert.equal(process.env.COMPACT_RECOVERY_STAGE, 'enable');
  assert.match(report.runId, /^\d+$/);
  assert.match(report.sourceSha, /^[0-9a-f]{40}$/);
  const originalBytes = readFileSync('test-results/epoch/roundtrip.json');
  const original = {
    checkpointSha256: createHash('sha256').update(originalBytes).digest('hex'),
    checkpoint: JSON.parse(originalBytes.toString())
  };
  assert.equal(original.checkpointSha256, c.checkpointSha256);
  const publicOutcome = JSON.parse(readFileSync('test-results/green02-public-outcome.json', 'utf8'));
  const privateOutcome = JSON.parse(readFileSync('test-results/green02-private-outcome.json', 'utf8'));
  assert.equal(publicOutcome.status, 'passed');
  assert.equal(publicOutcome.originalIntentStatusEmpty, true);
  assert.equal(publicOutcome.compactOriginalRegistrationActive, true);
  assert.equal(publicOutcome.compactPrincipalStillOwnedByOriginalAccount, true);
  for (const outcome of [publicOutcome, privateOutcome]) {
    assert.equal(outcome.sourceRunId, c.sourceRunId);
    assert.equal(outcome.applicationSource, '775f30df7ab450165d82f0f2ddd9ff1742431585');
    assert.equal(outcome.sdkVersion, '0.18.0');
    assert.equal(outcome.newAccruedAttemptCostUsdMicros, '39243');
    assert.equal(outcome.noTransactionSent, true);
  }
  assert.equal(privateOutcome.requiredConsumeGuardBlocked, true);
  assert.equal(privateOutcome.noLiveSpendingPolicy, true);
  assert.equal(privateOutcome.noNewAuthority, true);
  assert.equal(privateOutcome.noCheckpointMutation, true);
  assert.equal(privateOutcome.actualOriginalPrivateAccount, original.checkpoint.account);
  assert.equal(privateOutcome.native, '18835663');
  assert.equal(privateOutcome.request, '0');
  assert.equal(privateOutcome.compactPrincipal, String(c.amount));
  assert.equal(privateOutcome.ethereumLatestNonce, 111);
  assert.equal(privateOutcome.ethereumPendingNonce, 111);
  assert.equal(privateOutcome.arbitrumLatestNonce, 84);
  assert.equal(privateOutcome.arbitrumPendingNonce, 84);

  site = 'original-compact-status';
  const observedAt = Date.now();
  const [chainId, latestNonce, pendingNonce, balance, withdrawal, lock, block] = await Promise.all([
    client.getChainId(),
    client.getTransactionCount({ address: c.owner, blockTag: 'latest' }),
    client.getTransactionCount({ address: c.owner, blockTag: 'pending' }),
    client.readContract({
      address: c.compact,
      abi: COMPACT_ABI,
      functionName: 'balanceOf',
      args: [c.owner, c.tokenId]
    }),
    client.readContract({
      address: c.compact,
      abi: COMPACT_ABI,
      functionName: 'getForcedWithdrawalStatus',
      args: [c.owner, c.tokenId]
    }),
    client.readContract({ address: c.compact, abi: COMPACT_ABI, functionName: 'getLockDetails', args: [c.tokenId] }),
    client.getBlock({ blockTag: 'latest' })
  ]);
  assert.equal(isAddressEqual(lock[0], c.token), true);
  assert.equal(isAddressEqual(lock[1], original.checkpoint.evm.allocator), true);
  assert.equal(Number(lock[2]), 4);
  assert.equal(Number(lock[3]), 0);
  assert.equal(BigInt(lock[4]), BigInt(c.lockTag));
  const live = {
    chainId,
    owner: c.owner,
    compact: c.compact,
    tokenId: c.tokenId,
    balance,
    latestNonce,
    pendingNonce,
    status: Number(withdrawal[0]),
    withdrawableAt: withdrawal[1],
    blockTimestamp: block.timestamp,
    observedAt,
    now: Date.now(),
    remainingUsdMicros: c.remainingUsdMicros
  };
  const intent = compactRecoveryIntent('enable', original, live);

  site = 'fee-quote';
  const prices = await fetchMainnetOneClickUsdPrices(['ethereum']);
  const ethUsdMicros =
    prices.usdMicrosById.ethereum > c.minimumEthUsdMicros ? prices.usdMicrosById.ethereum : c.minimumEthUsdMicros;
  const estimate = await client.estimateGas(intent);
  const fees = await client.estimateFeesPerGas();
  const transaction = {
    ...intent,
    type: 'eip1559',
    gas: estimate + estimate / 5n + 1n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas
  };
  const maximumCostUsdMicros = assertCompactRecoveryFees(transaction, ethUsdMicros, c.remainingUsdMicros);
  site = 'owner-only-simulation';
  const simulated = await client.simulateContract({
    address: c.compact,
    abi: COMPACT_ABI,
    functionName: 'enableForcedWithdrawal',
    args: [c.tokenId],
    account: c.owner
  });
  assert.ok(simulated.result > block.timestamp);
  assert.ok(simulated.result <= block.timestamp + 3900n + 60n);
  assert.equal(
    (
      await client.readContract({
        address: c.compact,
        abi: COMPACT_ABI,
        functionName: 'getForcedWithdrawalStatus',
        args: [c.owner, c.tokenId]
      })
    )[0],
    0
  );
  Object.assign(report, {
    status: 'readonly-ready',
    observedAt: new Date().toISOString(),
    originalCompactPrincipal: balance,
    currentForcedWithdrawalStatus: 0,
    currentWithdrawableAt: '0',
    hypotheticalSimulatedWithdrawableAt: simulated.result,
    simulationDidNotEnableTimer: true,
    transaction,
    gasEstimate: estimate,
    ethUsdMicros,
    priceSource: prices.source,
    priceFetchedAt: prices.fetchedAt,
    priceUpdatedAt: prices.pricesUpdatedAt,
    maximumCostUsdMicros,
    originalRemainingUsdMicros: c.remainingUsdMicros,
    currentPrivateSdk018AndPublicSettlementVerified: true,
    immutableAckAndQualifiedOneShotRequiredBeforeAnySigning: true,
    notFundedGreen: true
  });
} catch (error) {
  Object.assign(report, {
    status: 'blocked',
    site,
    fingerprint: createHmac('sha256', fingerprintKey)
      .update(error instanceof Error ? error.message : String(error))
      .digest('hex')
  });
  process.exitCode = 1;
} finally {
  writeFileSync('test-results/compact-owner-recovery-readonly.json', json(report));
  console.log(json(report));
}

import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, isAddressEqual } from 'viem';
import { mainnet } from 'viem/chains';
import { COMPACT_ABI } from '../node_modules/@epoch-protocol/epoch-intents-sdk/dist/abis/compact.js';
import { fetchMainnetOneClickUsdPrices } from '../node_modules/.cache/nightly-compact-prices.mjs';
import { epochReadOnlyProvider } from '../node_modules/.cache/nightly-epoch-provider.mjs';
import {
  ORIGINAL_COMPACT_RECOVERY as c,
  compactRecoveryIntent,
  assertCompactRecoveryFees,
  verifyCompactRecoverySignature,
  broadcastOriginalCompactOnce
} from './mainnet-compact-recovery-guard.mjs';

const execute = process.env.COMPACT_OWNER_RECOVERY_EXECUTE === 'true';
const resultPath = execute
  ? 'test-results/compact-owner-recovery-result.json'
  : 'test-results/compact-owner-recovery-readonly.json';
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
  site = 'prior-held-grant-outcome';
  const priorHeldHash = c.retiredEnableSignedHash;
  assert.ok(live.blockTimestamp * 1000n >= 1794906404239n);
  const priorOutcome = await Promise.all([
    client.request({ method: 'eth_getTransactionByHash', params: [priorHeldHash] }),
    client.request({ method: 'eth_getTransactionReceipt', params: [priorHeldHash] })
  ]);
  assert.deepEqual(priorOutcome, [null, null]);
  Object.assign(report, {
    priorHeldGrantHash: priorHeldHash,
    priorHeldGrantExpiredAndNeverAckReleased: true,
    priorHeldHashAndReceiptAbsent: true,
    priorEnableMarkerPermanentlyConsumed: true
  });
  if (execute) {
    site = 'original-owner-signing';
    assert.equal(process.env.GITHUB_REF, 'refs/heads/wiktor/green02-compact-enable-replacement-01');
    assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
    const frontier = JSON.parse(readFileSync(`${process.env.RUNNER_TEMP}/producer-frontier.json`, 'utf8'));
    assert.equal(String(frontier.workflow_runs?.[0]?.id), c.sourceRunId);
    assert.equal(frontier.workflow_runs[0].head_sha, '775f30df7ab450165d82f0f2ddd9ff1742431585');
    assert.equal(frontier.workflow_runs[0].conclusion, 'failure');
    compactRecoveryIntent('enable', original, { ...live, now: Date.now() });
    const rawKey = (process.env.E2E_MAINNET_EVM_KEY ?? '').trim().replace(/^0x/, '');
    assert.match(rawKey, /^[0-9a-f]{64}$/i);
    const signer = privateKeyToAccount(`0x${rawKey}`);
    assert.equal(isAddressEqual(signer.address, c.owner), true);
    report.ownerPrivateKeyLoaded = true;
    const preparedAt = Date.now();
    const serializedTransaction = await signer.signTransaction(transaction);
    const signedHash = await verifyCompactRecoverySignature(serializedTransaction, transaction);
    assert.notEqual(signedHash.toLowerCase(), c.retiredEnableSignedHash);
    Object.assign(report, {
      status: 'signed-held',
      signatureCreated: true,
      signedHash,
      preparedAt,
      expiresAt: preparedAt + 240000,
      immutableAckAndQualifiedOneShotRequiredBeforeAnySigning: undefined,
      rawSignatureMemoryOnly: true
    });
    const authorityBytes = json(report);
    const journalPath = 'test-results/compact-recovery-enable-authority.json';
    const journalFile = openSync(journalPath, 'wx', 0o600);
    try {
      writeFileSync(journalFile, authorityBytes);
      fsyncSync(journalFile);
    } finally {
      closeSync(journalFile);
    }
    site = 'immutable-journal-ack';
    while (!existsSync('test-results/compact-ack/ready')) {
      if (Date.now() >= report.expiresAt) throw new Error('Original Compact immutable acknowledgement expired');
      await delay(500);
    }
    const downloadedBytes = readFileSync('test-results/compact-ack/compact-recovery-enable-authority.json', 'utf8');
    site = 'fresh-original-recheck';
    assert.equal(
      createHash('sha256').update(readFileSync('test-results/epoch/roundtrip.json')).digest('hex'),
      c.checkpointSha256
    );
    const recheckedAt = Date.now();
    const [freshChain, freshLatest, freshPending, freshBalance, freshWithdrawal, freshBlock, freshGas] =
      await Promise.all([
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
        client.getBlock({ blockTag: 'latest' }),
        client.getBalance({ address: c.owner })
      ]);
    compactRecoveryIntent('enable', original, {
      ...live,
      chainId: freshChain,
      latestNonce: freshLatest,
      pendingNonce: freshPending,
      balance: freshBalance,
      status: Number(freshWithdrawal[0]),
      withdrawableAt: freshWithdrawal[1],
      blockTimestamp: freshBlock.timestamp,
      observedAt: recheckedAt,
      now: Date.now()
    });
    assert.ok(freshGas >= transaction.gas * transaction.maxFeePerGas);
    assert.ok((freshBlock.baseFeePerGas ?? 0n) + transaction.maxPriorityFeePerGas <= transaction.maxFeePerGas);
    const provider = epochReadOnlyProvider(original.checkpoint.allocatorUrl, 1, c.owner);
    const intentStatus = await provider.sdk.getIntentStatus(
      provider.config,
      c.owner,
      original.checkpoint.reverseNonce,
      AbortSignal.timeout(30000)
    );
    assert.ok(Array.isArray(intentStatus));
    assert.equal(intentStatus.length, 0);
    assertCompactRecoveryFees(transaction, ethUsdMicros, c.remainingUsdMicros);
    assert.equal(await verifyCompactRecoverySignature(serializedTransaction, transaction), signedHash);
    site = 'one-broadcast';
    report.submissionAttemptMayHaveBeenSent = true;
    const sentHash = await broadcastOriginalCompactOnce({
      authorityBytes,
      downloadedBytes,
      binding: { runId: report.runId, sourceSha: report.sourceSha, stage: 'enable' },
      now: Date.now(),
      markerPath: 'test-results/compact-recovery-enable.broadcast.once',
      signedHash,
      submit: () => client.sendRawTransaction({ serializedTransaction })
    });
    assert.equal(sentHash, signedHash);
    Object.assign(report, { status: 'broadcast', broadcast: true, immutableJournalAcked: true });
    writeFileSync(resultPath, json(report));
    site = 'original-enable-receipt';
    const receipt = await client.waitForTransactionReceipt({ hash: signedHash, confirmations: 2, timeout: 180000 });
    assert.equal(receipt.transactionHash, signedHash);
    assert.equal(receipt.status, 'success');
    assert.equal(isAddressEqual(receipt.from, c.owner), true);
    assert.equal(isAddressEqual(receipt.to, c.compact), true);
    const minedBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
    const [afterStatus, afterEscrow] = await Promise.all([
      client.readContract({
        address: c.compact,
        abi: COMPACT_ABI,
        functionName: 'getForcedWithdrawalStatus',
        args: [c.owner, c.tokenId],
        blockNumber: receipt.blockNumber
      }),
      client.readContract({
        address: c.compact,
        abi: COMPACT_ABI,
        functionName: 'balanceOf',
        args: [c.owner, c.tokenId],
        blockNumber: receipt.blockNumber
      })
    ]);
    assert.equal(Number(afterStatus[0]), 1);
    assert.equal(afterStatus[1], minedBlock.timestamp + 3900n);
    assert.equal(afterEscrow, c.amount);
    const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
    const accruedUsdMicros = (feeWei * ethUsdMicros + 10n ** 18n - 1n) / 10n ** 18n;
    assert.ok(accruedUsdMicros <= maximumCostUsdMicros);
    Object.assign(report, {
      status: 'enable-confirmed',
      receipt: {
        hash: signedHash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
        feeWei,
        accruedUsdMicros
      },
      onChainWithdrawableAt: afterStatus[1],
      onChainForcedWithdrawalStatus: Number(afterStatus[0]),
      principalStillHeld: afterEscrow,
      noCostBookedByRunner: true,
      independentPhaseAuditRequired: true
    });
  }
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
  writeFileSync(resultPath, json(report));
  if (execute)
    writeFileSync('test-results/compact-recovery-enable.exit.json', json({ exitCode: process.exitCode ?? 0 }));
  console.log(json(report));
}

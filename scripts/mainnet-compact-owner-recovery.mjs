import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, erc20Abi, http, isAddressEqual } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
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
const client = createPublicClient({
  chain: mainnet,
  transport: http('https://ethereum-rpc.publicnode.com', { retryCount: 0 })
});
const json = value => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
const errorKey = randomBytes(32),
  enableHash = '0x07ace35385269a6f107fce317494817e8c6839a07b651ecd50a7c0d018ff4386',
  withdrawHash = '0x72d2c37bf18113cb12904596669d1f2a2ab9f261e2b2949eadf0c9aba550158c';
const report = {
  version: 1,
  sourceRunId: c.sourceRunId,
  checkpointSha256: c.checkpointSha256,
  runId: process.env.GITHUB_RUN_ID,
  sourceSha: process.env.GITHUB_SHA,
  stage: 'disable',
  status: 'running',
  ownerPrivateKeyLoaded: false,
  signatureCreated: false,
  broadcast: false,
  notFundedGreen: true
};
let site = 'original-refunded-principal-and-post-phase-binding';
try {
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1');
  assert.equal(process.env.COMPACT_RECOVERY_STAGE, 'disable');
  assert.match(report.runId, /^\d+$/);
  assert.match(report.sourceSha, /^[0-9a-f]{40}$/);
  const bytes = readFileSync('test-results/epoch/roundtrip.json');
  const original = {
    checkpointSha256: createHash('sha256').update(bytes).digest('hex'),
    checkpoint: JSON.parse(bytes.toString())
  };
  assert.equal(original.checkpointSha256, c.checkpointSha256);
  const records = [];
  for (const [role, expectedSha, expectedRun, expectedSource, expectedHash, expectedNonce] of [
    [
      'enable',
      '3bd825c51b868b3129fb3afd84e416cc7d35c742b4e2f376539d81b0f1f8e4a4',
      '44055319371',
      '09070f46e3b302d87dfdb15bd31772a8733941da',
      enableHash,
      111
    ],
    [
      'withdraw',
      '087550abab7094fb719a62a5f1c9a693f5ce53cd4cb16eaae384232fb587d7e1',
      '44067623911',
      '026475b9becfb265e0c739989bdddcf4b4265ee6',
      withdrawHash,
      112
    ]
  ]) {
    const authorityBytes = readFileSync(`test-results/${role}/compact-recovery-${role}-authority.json`);
    assert.equal(createHash('sha256').update(authorityBytes).digest('hex'), expectedSha);
    const authority = JSON.parse(authorityBytes.toString());
    assert.equal(authority.runId, expectedRun);
    assert.equal(authority.sourceSha, expectedSource);
    assert.equal(authority.signedHash, expectedHash);
    const [tx, receipt] = await Promise.all([
      client.getTransaction({ hash: expectedHash }),
      client.getTransactionReceipt({ hash: expectedHash })
    ]);
    assert.equal(receipt.status, 'success');
    assert.equal(receipt.transactionHash, expectedHash);
    assert.equal(isAddressEqual(tx.from, c.owner), true);
    assert.equal(isAddressEqual(tx.to, c.compact), true);
    assert.equal(tx.nonce, expectedNonce);
    assert.equal(tx.value, 0n);
    assert.equal(tx.input, authority.transaction.data);
    records.push({ authority, receipt, fee: receipt.gasUsed * receipt.effectiveGasPrice });
  }
  const [enabled, withdrawn] = records;
  assert.equal(enabled.fee, 6724237593578n);
  assert.equal(withdrawn.fee, 7322832439915n);
  assert.equal(withdrawn.authority.originalRecipient.toLowerCase(), c.owner.toLowerCase());
  assert.equal(withdrawn.authority.originalAmount, String(c.amount));
  const publicOutcome = JSON.parse(readFileSync('test-results/green02-public-outcome.json', 'utf8'));
  const privateOutcome = JSON.parse(readFileSync('test-results/green02-private-outcome.json', 'utf8'));
  assert.equal(publicOutcome.status, 'passed');
  assert.equal(publicOutcome.originalIntentStatusEmpty, true);
  assert.equal(publicOutcome.originalCompactPrincipalReturnedToOriginalOwner, true);
  for (const outcome of [publicOutcome, privateOutcome]) {
    assert.equal(outcome.sourceRunId, c.sourceRunId);
    assert.equal(outcome.applicationSource, '775f30df7ab450165d82f0f2ddd9ff1742431585');
    assert.equal(outcome.sdkVersion, '0.18.0');
    assert.equal(outcome.enableHash, enableHash);
    assert.equal(outcome.withdrawalHash, withdrawHash);
    assert.equal(outcome.compactPrincipal, '0');
    assert.equal(outcome.ethereumToken, '254080030');
    assert.equal(outcome.alreadyBookedAttemptPlusEnableUsdMicros, '51515');
    assert.equal(outcome.totalAccruedAttemptIncludingOwnerRefundUsdMicros, '64878');
    assert.equal(outcome.newOriginalOwnerWithdrawalGasCostUsdMicros, '13365');
    assert.equal(outcome.noTransactionSent, true);
  }
  assert.equal(privateOutcome.requiredConsumeGuardBlocked, true);
  assert.equal(privateOutcome.noLiveSpendingPolicy, true);
  assert.equal(privateOutcome.noNewAuthority, true);
  assert.equal(privateOutcome.noCheckpointMutation, true);
  assert.equal(privateOutcome.actualOriginalPrivateAccount, original.checkpoint.account);
  assert.equal(privateOutcome.native, '18835663');
  assert.equal(privateOutcome.request, '0');
  assert.equal(privateOutcome.ethereumLatestNonce, 113);
  assert.equal(privateOutcome.ethereumPendingNonce, 113);
  assert.equal(privateOutcome.arbitrumLatestNonce, 84);
  assert.equal(privateOutcome.arbitrumPendingNonce, 84);
  assert.equal(BigInt(original.checkpoint.reverseAuthority.valuation.gasUsdMicros), c.minimumEthUsdMicros);
  const enableBooked = (enabled.fee * c.minimumEthUsdMicros + 10n ** 18n - 1n) / 10n ** 18n;
  assert.equal(enableBooked, 12272n);
  const pairedWithdraw =
    BigInt(publicOutcome.totalAccruedAttemptIncludingOwnerRefundUsdMicros) -
    BigInt(publicOutcome.alreadyBookedAttemptPlusEnableUsdMicros);
  const ownWithdraw = BigInt(publicOutcome.newOriginalOwnerWithdrawalGasCostUsdMicros);
  const withdrawBooked = ownWithdraw > pairedWithdraw ? ownWithdraw : pairedWithdraw;
  assert.equal(withdrawBooked, 13365n);
  const remainingUsdMicros = c.remainingUsdMicros - enableBooked - withdrawBooked;
  assert.equal(remainingUsdMicros, 1762751n);
  const enabledBlock = await client.getBlock({ blockNumber: enabled.receipt.blockNumber });
  const withdrawableAt = enabledBlock.timestamp + 3900n;
  assert.equal(withdrawableAt, 1794911867n);
  const prior = {
    enable: {
      hash: enableHash,
      nonce: 111,
      success: true,
      owner: c.owner,
      compact: c.compact,
      tokenId: c.tokenId,
      withdrawableAt
    },
    withdraw: {
      hash: withdrawHash,
      nonce: 112,
      success: true,
      owner: c.owner,
      recipient: c.owner,
      compact: c.compact,
      tokenId: c.tokenId,
      amount: c.amount
    }
  };
  async function liveSnapshot() {
    const observedAt = Date.now();
    const [chainId, latestNonce, pendingNonce, balance, forced, block, gasBalance, tokenBalance] = await Promise.all([
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
      client.getBalance({ address: c.owner }),
      client.readContract({ address: c.token, abi: erc20Abi, functionName: 'balanceOf', args: [c.owner] })
    ]);
    assert.equal(chainId, 1);
    assert.equal(latestNonce, 113);
    assert.equal(pendingNonce, 113);
    assert.equal(balance, 0n);
    assert.equal(tokenBalance, 254080030n);
    assert.equal(gasBalance, 297490806405040756n);
    assert.equal(Number(forced[0]), 2);
    assert.equal(forced[1], withdrawableAt);
    return {
      chainId,
      latestNonce,
      pendingNonce,
      balance,
      status: Number(forced[0]),
      withdrawableAt: forced[1],
      blockTimestamp: block.timestamp,
      baseFeePerGas: block.baseFeePerGas,
      owner: c.owner,
      compact: c.compact,
      tokenId: c.tokenId,
      observedAt,
      now: Date.now(),
      remainingUsdMicros,
      gasBalance,
      tokenBalance
    };
  }
  site = 'original-empty-lock-cleanup-readiness';
  const live = await liveSnapshot();
  const intent = compactRecoveryIntent('disable', original, live, prior);
  const prices = await fetchMainnetOneClickUsdPrices(['ethereum']);
  const ethUsdMicros =
    prices.usdMicrosById.ethereum > c.minimumEthUsdMicros ? prices.usdMicrosById.ethereum : c.minimumEthUsdMicros;
  const estimate = await client.estimateGas(intent),
    fees = await client.estimateFeesPerGas();
  const transaction = {
    ...intent,
    type: 'eip1559',
    gas: estimate + estimate / 5n + 1n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas
  };
  const maximumCostUsdMicros = assertCompactRecoveryFees(transaction, ethUsdMicros, remainingUsdMicros);
  const simulated = await client.simulateContract({
    address: c.compact,
    abi: COMPACT_ABI,
    functionName: 'disableForcedWithdrawal',
    args: [c.tokenId],
    account: c.owner
  });
  assert.equal(simulated.result, true);
  Object.assign(report, {
    status: 'readonly-ready',
    observedAt: new Date().toISOString(),
    enableHash,
    withdrawalHash: withdrawHash,
    originalReturnedPrincipal: c.amount,
    currentEscrow: live.balance,
    currentOriginalOwnerUsdc: live.tokenBalance,
    currentForcedWithdrawalStatus: live.status,
    originalRemainingUsdMicros: remainingUsdMicros,
    enableGasAlreadyBookedOnce: enableBooked,
    withdrawalGasAlreadyBookedOnce: withdrawBooked,
    transaction,
    gasEstimate: estimate,
    ethUsdMicros,
    maximumCostUsdMicros,
    priceFetchedAt: prices.fetchedAt,
    priceUpdatedAt: prices.pricesUpdatedAt,
    actualOriginalOwnerDisableSimulationPassed: true,
    currentPrivateSdk018AndPublicPrincipalReturnVerified: true
  });
  if (execute) {
    site = 'original-owner-disable-signing';
    assert.equal(process.env.GITHUB_REF, 'refs/heads/wiktor/green02-compact-disable-once');
    assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
    const frontier = JSON.parse(readFileSync(`${process.env.RUNNER_TEMP}/producer-frontier.json`, 'utf8'));
    assert.equal(String(frontier.workflow_runs?.[0]?.id), c.sourceRunId);
    compactRecoveryIntent('disable', original, { ...live, now: Date.now() }, prior);
    const key = (process.env.E2E_MAINNET_EVM_KEY ?? '').trim().replace(/^0x/, '');
    assert.match(key, /^[0-9a-f]{64}$/i);
    const signer = privateKeyToAccount(`0x${key}`);
    assert.equal(isAddressEqual(signer.address, c.owner), true);
    report.ownerPrivateKeyLoaded = true;
    const preparedAt = Date.now(),
      serializedTransaction = await signer.signTransaction(transaction),
      signedHash = await verifyCompactRecoverySignature(serializedTransaction, transaction);
    assert.ok(![c.retiredEnableSignedHash, enableHash, withdrawHash].includes(signedHash));
    Object.assign(report, {
      status: 'signed-held',
      signatureCreated: true,
      signedHash,
      preparedAt,
      expiresAt: preparedAt + 240000,
      rawSignatureMemoryOnly: true
    });
    const authorityBytes = json(report),
      file = openSync('test-results/compact-recovery-disable-authority.json', 'wx', 0o600);
    try {
      writeFileSync(file, authorityBytes);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    site = 'immutable-disable-journal-ack';
    while (!existsSync('test-results/compact-ack/ready')) {
      if (Date.now() >= report.expiresAt) throw new Error('Original owner disable acknowledgement expired');
      await delay(500);
    }
    const downloadedBytes = readFileSync('test-results/compact-ack/compact-recovery-disable-authority.json', 'utf8');
    site = 'fresh-original-empty-lock-recheck';
    assert.equal(
      createHash('sha256').update(readFileSync('test-results/epoch/roundtrip.json')).digest('hex'),
      c.checkpointSha256
    );
    const fresh = await liveSnapshot();
    compactRecoveryIntent('disable', original, fresh, prior);
    assert.ok(fresh.gasBalance >= transaction.gas * transaction.maxFeePerGas);
    assert.ok((fresh.baseFeePerGas ?? 0n) + transaction.maxPriorityFeePerGas <= transaction.maxFeePerGas);
    const provider = epochReadOnlyProvider(original.checkpoint.allocatorUrl, 1, c.owner);
    const status = await provider.sdk.getIntentStatus(
      provider.config,
      c.owner,
      original.checkpoint.reverseNonce,
      AbortSignal.timeout(30000)
    );
    assert.ok(Array.isArray(status));
    assert.equal(status.length, 0);
    assertCompactRecoveryFees(transaction, ethUsdMicros, remainingUsdMicros);
    assert.equal(await verifyCompactRecoverySignature(serializedTransaction, transaction), signedHash);
    site = 'one-original-owner-disable-broadcast';
    report.submissionAttemptMayHaveBeenSent = true;
    const sent = await broadcastOriginalCompactOnce({
      authorityBytes,
      downloadedBytes,
      binding: { runId: report.runId, sourceSha: report.sourceSha, stage: 'disable' },
      now: Date.now(),
      markerPath: 'test-results/compact-recovery-disable.broadcast.once',
      signedHash,
      submit: () => client.sendRawTransaction({ serializedTransaction })
    });
    assert.equal(sent, signedHash);
    Object.assign(report, { status: 'broadcast', broadcast: true, immutableJournalAcked: true });
    writeFileSync(resultPath, json(report));
    site = 'original-owner-disable-receipt';
    const receipt = await client.waitForTransactionReceipt({ hash: signedHash, confirmations: 2, timeout: 180000 });
    assert.equal(receipt.transactionHash, signedHash);
    assert.equal(receipt.status, 'success');
    assert.equal(isAddressEqual(receipt.from, c.owner), true);
    assert.equal(isAddressEqual(receipt.to, c.compact), true);
    const [after, escrowAfter, tokenAfter] = await Promise.all([
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
      }),
      client.readContract({
        address: c.token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [c.owner],
        blockNumber: receipt.blockNumber
      })
    ]);
    assert.equal(Number(after[0]), 0);
    assert.equal(after[1], 0n);
    assert.equal(escrowAfter, 0n);
    assert.equal(tokenAfter, live.tokenBalance);
    const feeWei = receipt.gasUsed * receipt.effectiveGasPrice,
      accruedUsdMicros = (feeWei * ethUsdMicros + 10n ** 18n - 1n) / 10n ** 18n;
    assert.ok(accruedUsdMicros <= maximumCostUsdMicros);
    Object.assign(report, {
      status: 'original-owner-recovery-cleanup-disabled',
      originalPrincipalReturnedToOriginalOwner: true,
      originalEscrowAfter: escrowAfter,
      originalOwnerUsdcAfter: tokenAfter,
      forcedWithdrawalDisabled: true,
      receipt: {
        hash: signedHash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
        feeWei,
        accruedUsdMicros
      },
      noCostBookedByRunner: true,
      independentPostPhasePublicPrivateAuditRequired: true,
      canonicalOriginalCheckpointRetirementStillRequired: true,
      noNativeRoundTripCompletionClaim: true
    });
  }
} catch (error) {
  Object.assign(report, {
    status: 'blocked',
    site,
    fingerprint: createHmac('sha256', errorKey)
      .update(error instanceof Error ? error.message : String(error))
      .digest('hex')
  });
  process.exitCode = 1;
} finally {
  writeFileSync(resultPath, json(report));
  if (execute)
    writeFileSync('test-results/compact-recovery-disable.exit.json', json({ exitCode: process.exitCode ?? 0 }));
  console.log(json(report));
}

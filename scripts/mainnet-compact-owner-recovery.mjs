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
const errorKey = randomBytes(32);
const enableHash = '0x07ace35385269a6f107fce317494817e8c6839a07b651ecd50a7c0d018ff4386';
const report = {
  version: 1,
  sourceRunId: c.sourceRunId,
  checkpointSha256: c.checkpointSha256,
  runId: process.env.GITHUB_RUN_ID,
  sourceSha: process.env.GITHUB_SHA,
  stage: 'withdraw',
  status: 'running',
  ownerPrivateKeyLoaded: false,
  signatureCreated: false,
  broadcast: false,
  notFundedGreen: true
};
let site = 'original-and-enabled-phase-binding';
try {
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1');
  assert.equal(process.env.COMPACT_RECOVERY_STAGE, 'withdraw');
  assert.match(report.runId, /^\d+$/);
  assert.match(report.sourceSha, /^[0-9a-f]{40}$/);
  const originalBytes = readFileSync('test-results/epoch/roundtrip.json');
  const original = {
    checkpointSha256: createHash('sha256').update(originalBytes).digest('hex'),
    checkpoint: JSON.parse(originalBytes.toString())
  };
  assert.equal(original.checkpointSha256, c.checkpointSha256);
  const enableBytes = readFileSync('test-results/enable/compact-recovery-enable-authority.json');
  assert.equal(
    createHash('sha256').update(enableBytes).digest('hex'),
    '3bd825c51b868b3129fb3afd84e416cc7d35c742b4e2f376539d81b0f1f8e4a4'
  );
  const enable = JSON.parse(enableBytes.toString());
  assert.equal(enable.signedHash, enableHash);
  assert.equal(enable.runId, '44055319371');
  assert.equal(enable.sourceSha, '09070f46e3b302d87dfdb15bd31772a8733941da');
  const publicOutcome = JSON.parse(readFileSync('test-results/green02-public-outcome.json', 'utf8'));
  const privateOutcome = JSON.parse(readFileSync('test-results/green02-private-outcome.json', 'utf8'));
  assert.equal(publicOutcome.status, 'passed');
  assert.equal(publicOutcome.originalIntentStatusEmpty, true);
  assert.equal(publicOutcome.compactOriginalRegistrationAtOriginalDepositVerified, true);
  for (const outcome of [publicOutcome, privateOutcome]) {
    assert.equal(outcome.sourceRunId, c.sourceRunId);
    assert.equal(outcome.applicationSource, '775f30df7ab450165d82f0f2ddd9ff1742431585');
    assert.equal(outcome.sdkVersion, '0.18.0');
    assert.equal(outcome.enableHash, enableHash);
    assert.equal(outcome.alreadyBookedOriginalAttemptUsdMicros, '39243');
    assert.equal(outcome.totalAccruedAttemptIncludingEnableUsdMicros, '51515');
    assert.equal(outcome.noTransactionSent, true);
  }
  assert.equal(privateOutcome.requiredConsumeGuardBlocked, true);
  assert.equal(privateOutcome.noLiveSpendingPolicy, true);
  assert.equal(privateOutcome.noNewAuthority, true);
  assert.equal(privateOutcome.noCheckpointMutation, true);
  assert.equal(privateOutcome.actualOriginalPrivateAccount, original.checkpoint.account);
  assert.equal(privateOutcome.native, '18835663');
  assert.equal(privateOutcome.request, '0');
  assert.equal(privateOutcome.ethereumLatestNonce, 112);
  assert.equal(privateOutcome.ethereumPendingNonce, 112);
  assert.equal(privateOutcome.arbitrumLatestNonce, 84);
  assert.equal(privateOutcome.arbitrumPendingNonce, 84);
  const [enabledTx, enabledReceipt] = await Promise.all([
    client.getTransaction({ hash: enableHash }),
    client.getTransactionReceipt({ hash: enableHash })
  ]);
  assert.equal(enabledReceipt.status, 'success');
  assert.equal(enabledReceipt.transactionHash, enableHash);
  assert.equal(isAddressEqual(enabledTx.from, c.owner), true);
  assert.equal(isAddressEqual(enabledTx.to, c.compact), true);
  assert.equal(enabledTx.nonce, 111);
  assert.equal(enabledTx.value, 0n);
  assert.equal(enabledTx.input, enable.transaction.data);
  const enabledBlock = await client.getBlock({ blockNumber: enabledReceipt.blockNumber });
  const enableFee = enabledReceipt.gasUsed * enabledReceipt.effectiveGasPrice;
  assert.equal(enableFee, 6724237593578n);
  assert.equal(BigInt(original.checkpoint.reverseAuthority.valuation.gasUsdMicros), c.minimumEthUsdMicros);
  const enableBooked = (enableFee * c.minimumEthUsdMicros + 10n ** 18n - 1n) / 10n ** 18n;
  assert.equal(enableBooked, 12272n);
  const remainingUsdMicros = c.remainingUsdMicros - enableBooked;
  assert.equal(remainingUsdMicros, 1776116n);
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
    }
  };
  async function liveSnapshot() {
    const observedAt = Date.now();
    const [chainId, latestNonce, pendingNonce, balance, withdrawal, block, gasBalance, tokenBalance] =
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
        client.getBalance({ address: c.owner }),
        client.readContract({ address: c.token, abi: erc20Abi, functionName: 'balanceOf', args: [c.owner] })
      ]);
    assert.equal(chainId, 1);
    assert.equal(latestNonce, 112);
    assert.equal(pendingNonce, 112);
    assert.equal(balance, c.amount);
    assert.equal(tokenBalance, 253099172n);
    assert.equal(gasBalance, 297498129237480671n);
    assert.equal(withdrawal[1], withdrawableAt);
    return {
      chainId,
      latestNonce,
      pendingNonce,
      balance,
      blockTimestamp: block.timestamp,
      baseFeePerGas: block.baseFeePerGas,
      status: Number(withdrawal[0]),
      withdrawableAt: withdrawal[1],
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
  site = 'actual-chain-maturity';
  const live = await liveSnapshot();
  Object.assign(report, {
    enableHash,
    enableGasBookedOnceUsdMicros: enableBooked,
    originalRemainingUsdMicros: remainingUsdMicros,
    actualWithdrawableAt: withdrawableAt,
    actualForcedWithdrawalStatus: live.status,
    actualBlockTimestamp: live.blockTimestamp,
    originalCompactPrincipal: live.balance,
    originalRecipient: c.owner,
    originalAmount: c.amount,
    currentPrivateSdk018AndOriginalPublicSettlementVerified: true
  });
  if (live.status === 1) {
    assert.ok(live.blockTimestamp < withdrawableAt);
    assert.equal(execute, false);
    Object.assign(report, { status: 'protocol-wait', noPositiveSimulationOrSigningBeforeActualChainMaturity: true });
  } else {
    const intent = compactRecoveryIntent('withdraw', original, live, prior);
    site = 'mature-owner-only-fee-and-simulation';
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
    const maximumCostUsdMicros = assertCompactRecoveryFees(transaction, ethUsdMicros, remainingUsdMicros);
    const simulated = await client.simulateContract({
      address: c.compact,
      abi: COMPACT_ABI,
      functionName: 'forcedWithdrawal',
      args: [c.tokenId, c.owner, c.amount],
      account: c.owner
    });
    assert.equal(simulated.result, true);
    Object.assign(report, {
      status: 'readonly-ready',
      observedAt: new Date().toISOString(),
      transaction,
      gasEstimate: estimate,
      ethUsdMicros,
      priceSource: prices.source,
      priceFetchedAt: prices.fetchedAt,
      priceUpdatedAt: prices.pricesUpdatedAt,
      maximumCostUsdMicros,
      actualMatureOwnerOnlySimulationPassed: true
    });
    if (execute) {
      site = 'original-owner-withdraw-signing';
      assert.equal(process.env.GITHUB_REF, 'refs/heads/wiktor/green02-compact-withdraw-once');
      assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
      const frontier = JSON.parse(readFileSync(`${process.env.RUNNER_TEMP}/producer-frontier.json`, 'utf8'));
      assert.equal(String(frontier.workflow_runs?.[0]?.id), c.sourceRunId);
      assert.equal(frontier.workflow_runs[0].head_sha, '775f30df7ab450165d82f0f2ddd9ff1742431585');
      compactRecoveryIntent('withdraw', original, { ...live, now: Date.now() }, prior);
      const key = (process.env.E2E_MAINNET_EVM_KEY ?? '').trim().replace(/^0x/, '');
      assert.match(key, /^[0-9a-f]{64}$/i);
      const signer = privateKeyToAccount(`0x${key}`);
      assert.equal(isAddressEqual(signer.address, c.owner), true);
      report.ownerPrivateKeyLoaded = true;
      const preparedAt = Date.now();
      const serializedTransaction = await signer.signTransaction(transaction);
      const signedHash = await verifyCompactRecoverySignature(serializedTransaction, transaction);
      assert.notEqual(signedHash, c.retiredEnableSignedHash);
      assert.notEqual(signedHash, enableHash);
      Object.assign(report, {
        status: 'signed-held',
        signatureCreated: true,
        signedHash,
        preparedAt,
        expiresAt: preparedAt + 240000,
        rawSignatureMemoryOnly: true
      });
      const authorityBytes = json(report);
      const file = openSync('test-results/compact-recovery-withdraw-authority.json', 'wx', 0o600);
      try {
        writeFileSync(file, authorityBytes);
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      site = 'immutable-withdraw-journal-ack';
      while (!existsSync('test-results/compact-ack/ready')) {
        if (Date.now() >= report.expiresAt) throw new Error('Original owner withdrawal acknowledgement expired');
        await delay(500);
      }
      const downloadedBytes = readFileSync('test-results/compact-ack/compact-recovery-withdraw-authority.json', 'utf8');
      site = 'fresh-original-mature-recheck';
      assert.equal(
        createHash('sha256').update(readFileSync('test-results/epoch/roundtrip.json')).digest('hex'),
        c.checkpointSha256
      );
      const fresh = await liveSnapshot();
      compactRecoveryIntent('withdraw', original, fresh, prior);
      assert.ok(fresh.gasBalance >= transaction.gas * transaction.maxFeePerGas);
      assert.ok((fresh.baseFeePerGas ?? 0n) + transaction.maxPriorityFeePerGas <= transaction.maxFeePerGas);
      const provider = epochReadOnlyProvider(original.checkpoint.allocatorUrl, 1, c.owner);
      const intentStatus = await provider.sdk.getIntentStatus(
        provider.config,
        c.owner,
        original.checkpoint.reverseNonce,
        AbortSignal.timeout(30000)
      );
      assert.ok(Array.isArray(intentStatus));
      assert.equal(intentStatus.length, 0);
      assertCompactRecoveryFees(transaction, ethUsdMicros, remainingUsdMicros);
      assert.equal(await verifyCompactRecoverySignature(serializedTransaction, transaction), signedHash);
      site = 'one-original-owner-withdraw-broadcast';
      report.submissionAttemptMayHaveBeenSent = true;
      const sent = await broadcastOriginalCompactOnce({
        authorityBytes,
        downloadedBytes,
        binding: { runId: report.runId, sourceSha: report.sourceSha, stage: 'withdraw' },
        now: Date.now(),
        markerPath: 'test-results/compact-recovery-withdraw.broadcast.once',
        signedHash,
        submit: () => client.sendRawTransaction({ serializedTransaction })
      });
      assert.equal(sent, signedHash);
      Object.assign(report, { status: 'broadcast', broadcast: true, immutableJournalAcked: true });
      writeFileSync(resultPath, json(report));
      site = 'original-owner-withdraw-receipt';
      const receipt = await client.waitForTransactionReceipt({ hash: signedHash, confirmations: 2, timeout: 180000 });
      assert.equal(receipt.transactionHash, signedHash);
      assert.equal(receipt.status, 'success');
      assert.equal(isAddressEqual(receipt.from, c.owner), true);
      assert.equal(isAddressEqual(receipt.to, c.compact), true);
      const [escrowAfter, tokenAfter, withdrawalAfter] = await Promise.all([
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
        }),
        client.readContract({
          address: c.compact,
          abi: COMPACT_ABI,
          functionName: 'getForcedWithdrawalStatus',
          args: [c.owner, c.tokenId],
          blockNumber: receipt.blockNumber
        })
      ]);
      assert.equal(escrowAfter, 0n);
      assert.equal(tokenAfter, live.tokenBalance + c.amount);
      assert.equal(Number(withdrawalAfter[0]), 2);
      const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
      const accruedUsdMicros = (feeWei * ethUsdMicros + 10n ** 18n - 1n) / 10n ** 18n;
      assert.ok(accruedUsdMicros <= maximumCostUsdMicros);
      Object.assign(report, {
        status: 'original-principal-returned-to-original-evm-owner',
        originalReturnedPrincipal: c.amount,
        escrowAfter,
        ethereumTokenAfter: tokenAfter,
        requiredDisableCleanupStillPending: true,
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
        noNativeRoundTripCompletionClaim: true
      });
    }
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
    writeFileSync('test-results/compact-recovery-withdraw.exit.json', json({ exitCode: process.exitCode ?? 0 }));
  console.log(json(report));
}

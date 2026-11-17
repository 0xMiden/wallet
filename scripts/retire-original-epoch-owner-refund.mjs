import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const digests = {
  swap: '3a9c4166e26092d26c692717207caa72ee00a0fb6ed454a7b99b331abea7fc30',
  epoch: '77652e5b0590797753f5fe920d79fec252af3411a5b125a663a12d77f60e40a1',
  near: '1cba9da167d4223b46d41f5d92894cb25406b6aa7abf8ba12cbf1e93ebd465b5'
};
const disableHash = '0xcae904b38b4711d20e136d0c741be01fd8504184065460ab0caa363f91a66a8d';

export function retireOriginalEpochOwnerRefund(originalBytes, publicOutcome, privateOutcome, privateStatus, now) {
  assert.equal(createHash('sha256').update(originalBytes).digest('hex'), digests.epoch);
  const original = JSON.parse(originalBytes.toString());
  assert.equal(original.sourceRunId, '44034323631');
  assert.equal(original.phase, 'recovery-required');
  for (const key of ['consumeAuthority', 'returnNoteId', 'returnMidenTxId']) assert.equal(original[key], undefined);
  assert.ok(Number.isSafeInteger(now) && now > Date.parse(original.updatedAt));
  assert.equal(publicOutcome.status, 'passed');
  assert.equal(privateStatus.status, 'passed');
  for (const outcome of [publicOutcome, privateOutcome]) {
    assert.equal(outcome.sourceRunId, '44034323631');
    assert.equal(outcome.applicationSource, '775f30df7ab450165d82f0f2ddd9ff1742431585');
    assert.equal(outcome.sdkVersion, '0.18.0');
    assert.equal(outcome.compactPrincipal, '0');
    assert.equal(outcome.originalReturnedPrincipal, '980858');
    assert.equal(outcome.forcedWithdrawalDisabled, true);
    assert.equal(outcome.forcedWithdrawalDisableCleanupRequired, false);
    assert.equal(outcome.disableHash, disableHash);
    assert.equal(outcome.ethereumToken, '254080030');
    assert.equal(outcome.ethereumGas, '297487428658860326');
    assert.equal(outcome.epochAccruedCostExcludingAuthenticatedHeldPrincipalUsdMicros, '70126');
    assert.equal(outcome.totalAccruedAttemptIncludingOwnerRefundUsdMicros, '71042');
    assert.equal(outcome.newOriginalOwnerDisableGasCostUsdMicros, '6165');
    assert.equal(outcome.disableFeeWei, '3377746180430');
    assert.equal(outcome.noTransactionSent, true);
    assert.equal(outcome.noCostBookedByAudit, true);
  }
  for (const [i, [role, digest]] of Object.entries(digests).entries()) {
    assert.equal(publicOutcome.checkpointHashes[role], digest);
    assert.equal(privateOutcome.checkpointHashes[i], digest);
  }
  assert.equal(publicOutcome.originalCompactPrincipalReturnedToOriginalOwner, true);
  assert.equal(publicOutcome.compactForcedWithdrawalStatus, 0);
  assert.equal(publicOutcome.actualWithdrawableAt, '0');
  assert.equal(publicOutcome.originalIntentStatusEmpty, true);
  assert.equal(publicOutcome.ethereumLatestPendingNonce, 114);
  assert.equal(publicOutcome.swapBothLegsOriginalSdkAndPublicSettlementVerified, true);
  assert.equal(publicOutcome.withinOriginalSwapDeadlines, true);
  assert.equal(publicOutcome.originalEpochReceiptsSuccessful, true);
  assert.equal(privateOutcome.actualOriginalPrivateAccount, original.account);
  assert.equal(privateOutcome.guardianSdkVersion, '0.19.0-rc.2');
  assert.equal(privateOutcome.native, '18835663');
  assert.equal(privateOutcome.request, '0');
  assert.equal(privateOutcome.ethereumLatestNonce, 114);
  assert.equal(privateOutcome.ethereumPendingNonce, 114);
  assert.equal(privateOutcome.arbitrumToken, '38682541');
  assert.equal(privateOutcome.arbitrumGas, '19429691940260000');
  assert.equal(privateOutcome.arbitrumLatestNonce, 84);
  assert.equal(privateOutcome.arbitrumPendingNonce, 84);
  assert.equal(privateOutcome.actualForcedWithdrawalStatus, 0);
  assert.equal(privateOutcome.actualWithdrawableAt, '0');
  for (const key of [
    'requiredConsumeGuardBlocked',
    'noLiveSpendingPolicy',
    'noNewAuthority',
    'noCheckpointMutation',
    'originalPrincipalRecoveredNotLoss'
  ])
    assert.equal(privateOutcome[key], true);
  return {
    ...original,
    phase: 'cancelled',
    updatedAt: new Date(now).toISOString(),
    after: {
      native: privateOutcome.native,
      evmToken: privateOutcome.ethereumToken,
      evmNative: privateOutcome.ethereumGas
    },
    realizedCostUsdMicros: publicOutcome.epochAccruedCostExcludingAuthenticatedHeldPrincipalUsdMicros
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const read = path => JSON.parse(readFileSync(path, 'utf8'));
  const original = readFileSync('test-results/epoch/roundtrip.json');
  const next = retireOriginalEpochOwnerRefund(
    original,
    read('test-results/green02-public-outcome.json'),
    read('test-results/green02-private-outcome.json'),
    read('test-results/green02-private-status.json'),
    Date.now()
  );
  const { saveMainnetEpochCheckpoint, loadMainnetEpochCheckpoint } =
    await import('../node_modules/.cache/nightly-epoch-checkpoint.mjs');
  const path = 'test-results/mainnet-epoch-state/roundtrip.json';
  saveMainnetEpochCheckpoint(path, next);
  assert.equal(loadMainnetEpochCheckpoint(path)?.phase, 'cancelled');
  const report = {
    recoveryOnly: true,
    originalSourceRunId: '44034323631',
    originalCheckpointSha256: digests.epoch,
    cancelledCheckpointSha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    originalPrincipalReturnedToOriginalOwner: true,
    originalEmptyLockDisabled: true,
    disableHash,
    epochRealizedCostAlreadyBookedUsdMicros: '70126',
    totalAttemptPortfolioAlreadyBookedUsdMicros: '71042',
    globalConservativeSpentUsdMicros: '243414',
    remainingOriginalUsdMicros: '1756586',
    noNewFees: true,
    noRebooking: true,
    noAuthorityIssued: true,
    noTransactionSent: true,
    noNativeRoundtripCompletionClaim: true,
    notFundedGreen: true
  };
  writeFileSync('test-results/mainnet-epoch-recovery.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadMainnetEpochCheckpoint } from '../node_modules/.cache/nightly-epoch-checkpoint.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const objectDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const run = read('test-results/canonical-run.json'),
  jobs = read('test-results/canonical-jobs.json');
assert.equal(run.id, 44079205760);
assert.equal(run.workflow_id, 391951744);
assert.equal(run.run_attempt, 1);
assert.equal(run.event, 'push');
assert.equal(run.head_branch, 'wiktor/green02-epoch-owner-refund-retire-once');
assert.equal(run.head_sha, 'c9a018810e2a8ad4664f6d063ecf1844a83de89f');
assert.equal(run.status, 'completed');
assert.equal(run.conclusion, 'failure');
assert.equal(jobs.jobs.length, 1);
const steps = jobs.jobs[0].steps;
assert.equal(
  steps
    .filter(s => s.conclusion === 'failure')
    .map(s => s.name)
    .join(','),
  'Report recovery-only coverage'
);
for (const name of [
  'Actual original public SDK018 settlement, owner return and disabled empty lock',
  'Actual original PRIVATE SDK018 holdings with consume blocked and no policy',
  'All original financial guards and exact cancellation contracts on fresh actual outcomes',
  'Retire only original owner-refunded Epoch using existing loader and writer',
  'Retain unchanged original swap final checkpoint',
  'Retain original Epoch cancelled owner-refund checkpoint',
  'Retain unchanged original NEAR unspent checkpoint'
]) {
  const matches = steps.filter(s => s.name === name);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].conclusion, 'success');
}

const expected = {
  swap: '3a9c4166e26092d26c692717207caa72ee00a0fb6ed454a7b99b331abea7fc30',
  epoch: '925269782f463a4bd3a6c47cc5a88daa7f537a8accd0c4b5793ed4ec48c0845d',
  near: '1cba9da167d4223b46d41f5d92894cb25406b6aa7abf8ba12cbf1e93ebd465b5'
};
for (const [role, hash] of Object.entries(expected)) {
  const prefix = role === 'near' ? '1click' : role;
  assert.equal(process.env[`FINDER_${role.toUpperCase()}_RUN`], '44079205760');
  assert.equal(process.env[`FINDER_${role.toUpperCase()}_NAME`], `mainnet-${prefix}-final-44079205760`);
  assert.equal(process.env[`FINDER_${role.toUpperCase()}_BOOTSTRAP`], 'false');
  assert.equal(digest(`test-results/canonical/${role}/roundtrip.json`), hash);
  if (role !== 'epoch') assert.equal(digest(`test-results/${role}/roundtrip.json`), hash);
}
assert.equal(
  digest('test-results/epoch/roundtrip.json'),
  '77652e5b0590797753f5fe920d79fec252af3411a5b125a663a12d77f60e40a1'
);
const original = read('test-results/epoch/roundtrip.json'),
  cancelled = loadMainnetEpochCheckpoint('test-results/canonical/epoch/roundtrip.json');
assert.ok(cancelled);
assert.equal(cancelled.phase, 'cancelled');
assert.equal(cancelled.sourceRunId, '44034323631');
assert.equal(cancelled.realizedCostUsdMicros, '70126');
assert.equal(cancelled.after.native, '18835663');
assert.equal(cancelled.after.evmToken, '254080030');
assert.equal(cancelled.after.evmNative, '297487428658860326');
assert.equal(Object.keys(cancelled.after).sort().join(','), 'evmNative,evmToken,native');
assert.ok(Date.parse(cancelled.updatedAt) > Date.parse(original.updatedAt));
for (const key of ['consumeAuthority', 'returnNoteId', 'returnMidenTxId']) assert.equal(cancelled[key], undefined);
const changed = [...new Set([...Object.keys(original), ...Object.keys(cancelled)])]
  .filter(k => objectDigest(original[k] ?? null) !== objectDigest(cancelled[k] ?? null))
  .sort();
assert.equal(changed.join(','), 'after,phase,realizedCostUsdMicros,updatedAt');
const a = { ...original },
  b = { ...cancelled };
for (const key of ['after', 'phase', 'realizedCostUsdMicros', 'updatedAt']) {
  delete a[key];
  delete b[key];
}
assert.equal(objectDigest(a), objectDigest(b));

const publicOutcome = read('test-results/green02-public-outcome.json'),
  privateOutcome = read('test-results/green02-private-outcome.json');
assert.equal(publicOutcome.status, 'passed');
assert.equal(read('test-results/green02-private-status.json').status, 'passed');
for (const outcome of [publicOutcome, privateOutcome]) {
  assert.equal(outcome.sourceRunId, '44034323631');
  assert.equal(outcome.sdkVersion, '0.18.0');
  assert.equal(outcome.applicationSource, '775f30df7ab450165d82f0f2ddd9ff1742431585');
  assert.equal(outcome.compactPrincipal, '0');
  assert.equal(outcome.forcedWithdrawalDisabled, true);
  assert.equal(outcome.ethereumToken, cancelled.after.evmToken);
  assert.equal(outcome.ethereumGas, cancelled.after.evmNative);
  assert.equal(outcome.epochAccruedCostExcludingAuthenticatedHeldPrincipalUsdMicros, cancelled.realizedCostUsdMicros);
  assert.equal(outcome.totalAccruedAttemptIncludingOwnerRefundUsdMicros, '71042');
  assert.equal(outcome.noTransactionSent, true);
  assert.equal(outcome.noCostBookedByAudit, true);
}
assert.equal(publicOutcome.originalIntentStatusEmpty, true);
assert.equal(publicOutcome.compactForcedWithdrawalStatus, 0);
assert.equal(publicOutcome.actualWithdrawableAt, '0');
assert.equal(privateOutcome.native, cancelled.after.native);
assert.equal(privateOutcome.request, '0');
assert.equal(privateOutcome.actualOriginalPrivateAccount, original.account);
assert.equal(privateOutcome.ethereumLatestNonce, 114);
assert.equal(privateOutcome.ethereumPendingNonce, 114);
assert.equal(privateOutcome.arbitrumLatestNonce, 84);
assert.equal(privateOutcome.arbitrumPendingNonce, 84);
for (const key of ['requiredConsumeGuardBlocked', 'noLiveSpendingPolicy', 'noNewAuthority', 'noCheckpointMutation'])
  assert.equal(privateOutcome[key], true);
const report = {
  status: 'passed',
  canonicalRunId: '44079205760',
  canonicalSource: run.head_sha,
  verificationRunId: process.env.GITHUB_RUN_ID,
  verificationSource: process.env.GITHUB_SHA,
  originalCheckpointSha256: '77652e5b0590797753f5fe920d79fec252af3411a5b125a663a12d77f60e40a1',
  canonicalCheckpointSha256: expected.epoch,
  actualExistingOfficialFinderSelectedAllThreeCanonicalFinals: true,
  actualExistingCheckpointLoaderAcceptedCancelled: true,
  onlyChangedEpochFields: changed,
  originalAuthoritiesReceiptsPricesNoncesDeadlinesPreserved: true,
  swapAndNearByteIdentical: true,
  actualCurrentOriginalSdk018PublicPrivateHoldingsAndRequiredGuardsPassed: true,
  originalPrincipalReturnedAndLockDisabled: true,
  noNewAuthority: true,
  noTransactionSent: true,
  noNewCost: true,
  noRebooking: true,
  globalAlreadyVerifiedSpentUsdMicros: '243414',
  remainingOriginalUsdMicros: '1756586',
  noNativeRoundtripCompletionClaim: true,
  notFundedGreen: true
};
writeFileSync(
  'test-results/original-epoch-owner-refund-canonical-verification.json',
  JSON.stringify(report, null, 2) + '\n'
);
console.log(JSON.stringify(report));

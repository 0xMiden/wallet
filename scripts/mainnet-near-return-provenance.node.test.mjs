import assert from 'node:assert/strict';
import test from 'node:test';
import * as provenance from './mainnet-near-return-provenance.mjs';

const steps = [
  { name: 'Authorize original NEAR reverse', conclusion: 'success' },
  { name: 'Upload mainnet near signed EVM 1', conclusion: 'failure' },
  { name: 'Upload mainnet near native return claim', conclusion: 'skipped' },
  { name: 'Prepare mainnet solver swap', conclusion: 'skipped' }
];
const digest = 'sha256:6a8cf4b067cd5809cf39800521158e666ec747de39d673f6615a0470299117f7';
const candidate = {
  run: { id: 44844609625, repository: { id: 853430876 }, workflow_id: 391951744,
    head_sha: '71287e0742a62e29a5bc06c4f398eee8978336ab', head_branch: 'main', event: 'workflow_dispatch',
    run_attempt: 1, status: 'completed', conclusion: 'failure' },
  jobs: { jobs: [{ name: 'Chrome mainnet round trip', steps }] },
  artifacts: { artifacts: ['final', 'reverse-authorized'].map((stage, i) => ({ id: [14681873349, 14681848612][i],
    name: `mainnet-1click-${stage}-44844609625`, digest, expired: false })) }
};
const check = provenance.matchesExpiredNearReturnProvenance;

test('requires a pending retired quote with no provider settlement or deposit evidence', () => {
  const matches = provenance.hasNoNearReturnProviderActivity ?? (() => false);
  const swapDetails = { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [] };
  assert.equal(matches({ status: 'PENDING_DEPOSIT', swapDetails }), true);
  assert.equal(matches({ status: 'INCOMPLETE_DEPOSIT', swapDetails }), false);
  for (const key of Object.keys(swapDetails)) {
    assert.equal(matches({ status: 'PENDING_DEPOSIT', swapDetails: { ...swapDetails, [key]: ['observed'] } }), false);
  }
  assert.equal(matches({ status: 'PENDING_DEPOSIT', swapDetails: { ...swapDetails, depositedAmount: '1' } }), false);
  assert.equal(matches({ status: 'PENDING_DEPOSIT' }), false);
});

test('checks historical bytes rather than trusting reported checkpoint digests', () => {
  const verify = provenance.verifyNearReturnCheckpointBytes ?? (() => false);
  assert.throws(() => verify(Buffer.from('{}'), Buffer.from('{}')), /checkpoint bytes/);
  assert.throws(() => verify(undefined, undefined), /checkpoint bytes/);
});

test('scheduled retention must have failed closed without reaching signing or fresh preparation', () => {
  const matches = provenance.matchesNearRetentionSteps ?? (() => false);
  const steps = [
    { name: 'Authorize original NEAR reverse', conclusion: 'failure' },
    { name: 'Upload mainnet near signed EVM 1', conclusion: 'skipped' },
    { name: 'Upload mainnet near native return claim', conclusion: 'skipped' },
    { name: 'Prepare mainnet solver swap', conclusion: 'skipped' }
  ];
  const jobs = entries => ({ jobs: [{ name: 'Chrome mainnet round trip', steps: entries }] });
  assert.equal(matches(jobs(steps)), true);
  for (const index of [1, 2, 3]) {
    const changed = structuredClone(steps);
    changed[index].conclusion = 'success';
    assert.equal(matches(jobs(changed)), false);
    assert.equal(matches(jobs(steps.filter((_, i) => i !== index))), false);
  }
  assert.equal(matches(jobs([...steps, steps[0]])), false);
});

test('rejects changed retired quote identity even under a fresh deadline', () => {
  const match = provenance.isDistinctNearReplacementQuote ?? (() => false);
  const old = { quoteHash: 'old', depositAddress: '0x' + 'a'.repeat(40), deadline: '2026-11-21T00:43:00Z' };
  const next = { quoteHash: 'new', depositAddress: '0x' + 'b'.repeat(40), deadline: '2026-11-21T05:43:00Z' };
  assert.equal(match(old, next), true);
  assert.equal(match(old, { ...next, quoteHash: old.quoteHash }), false);
  assert.equal(match(old, { ...next, depositAddress: '0x' + 'A'.repeat(40) }), false);
  assert.equal(match(old, { ...next, deadline: old.deadline }), false);
});

test('binds the scheduled retention to the exact current and original checkpoint bytes', () => {
  const match = provenance.matchesRetainedNearReturn ?? (() => false);
  const evidence = {
    runId: 44871541172,
    artifactId: 14694460888,
    archiveDigest: 'sha256:55e22c8a7fb31e77b345848714fdd7264a8bc2d68f4a863ed73884846f18f738',
    checkpointDigest: 'd3f5e34cfe19c980f173972e8e28763e4a59bd6040cfee84df5acf307f615fda',
    originalDigest: 'fe8dcc6aaae3df3c6c5a9d8a32b465a3d200ca981510eef346ebff237b685d28'
  };
  assert.equal(match(evidence), true);
  for (const key of Object.keys(evidence)) assert.equal(match({ ...evidence, [key]: null }), false);
  assert.equal(match({ ...evidence, runId: 44871541173 }), false);
  assert.equal(match({ ...evidence, checkpointDigest: evidence.originalDigest }), false);
});

test('only permits a phase and timestamp change when tracing retained authority', () => {
  const matches = provenance.hasUnchangedNearReturnAuthority ?? (() => false);
  const original = { phase: 'reverse-authorized', updatedAt: '2026-11-21T00:38:30.469Z', reverseQuote: { quoteHash: 'original' }, evmNonceBefore: 84 };
  const retained = { ...original, phase: 'recovery-required', updatedAt: '2026-11-21T05:40:00.000Z' };
  assert.equal(matches(original, retained), true);
  assert.equal(matches(original, { ...retained, evmNonceBefore: 85 }), false);
  assert.equal(matches(original, { ...retained, transactions: [{ hash: 'unexpected' }] }), false);
  assert.equal(matches(original, { ...retained, updatedAt: original.updatedAt }), false);
});
test('binds the failed unsigned return, without granting replacement authority', () => {
  assert.equal(check(candidate), true);
});
test('rejects mismatched or ambiguous provenance', () => {
  for (const mutate of [
    x => x.run.run_attempt++,
    x => x.run.workflow_id++,
    x => x.jobs.jobs[0].steps[1].conclusion = 'success',
    x => x.jobs.jobs[0].steps[2].conclusion = 'success',
    x => x.jobs.jobs[0].steps.push(steps[1]),
    x => x.artifacts.artifacts[1].digest = 'sha256:' + '3'.repeat(64),
    x => x.artifacts.artifacts.forEach(a => { a.digest = 'sha256:' + '3'.repeat(64); }),
    x => x.artifacts.artifacts[0].id++,
    x => x.artifacts.artifacts[0].expired = true,
    x => x.artifacts.artifacts.push({ name: 'mainnet-1click-reverse-signed-1-44844609625' })
  ]) {
    const changed = structuredClone(candidate);
    mutate(changed);
    assert.equal(check(changed), false);
  }
});

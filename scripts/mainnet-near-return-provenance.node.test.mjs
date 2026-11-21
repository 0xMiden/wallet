import assert from 'node:assert/strict';
import test from 'node:test';
import * as provenance from './mainnet-near-return-provenance.mjs';

const steps = [
  { name: 'Authorize original NEAR reverse', conclusion: 'success' },
  { name: 'Upload mainnet near signed EVM 1', conclusion: 'failure' },
  { name: 'Upload mainnet near native return claim', conclusion: 'skipped' },
  { name: 'Prepare mainnet solver swap', conclusion: 'skipped' }
];
const digest = 'sha256:' + '2'.repeat(64);
const candidate = {
  run: { id: 44844609625, repository: { id: 853430876 }, workflow_id: 391951744,
    head_sha: '71287e0742a62e29a5bc06c4f398eee8978336ab', head_branch: 'main', event: 'workflow_dispatch',
    run_attempt: 1, status: 'completed', conclusion: 'failure' },
  jobs: { jobs: [{ name: 'Chrome mainnet round trip', steps }] },
  artifacts: { artifacts: ['final', 'reverse-authorized'].map((stage, i) => ({ id: i + 1,
    name: `mainnet-1click-${stage}-44844609625`, digest, expired: false })) }
};
const check = provenance.matchesExpiredNearReturnProvenance;
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
    x => x.artifacts.artifacts[0].expired = true,
    x => x.artifacts.artifacts.push({ name: 'mainnet-1click-reverse-signed-1-44844609625' })
  ]) {
    const changed = structuredClone(candidate);
    mutate(changed);
    assert.equal(check(changed), false);
  }
});

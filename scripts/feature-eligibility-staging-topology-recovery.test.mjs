import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareTopologyRecovery } from './feature-eligibility-staging-topology-recovery.mjs';

const sourceSha = 'a'.repeat(40);
const context = {
  repository: '0xMiden/wallet',
  workflowPath: '.github/workflows/feature-eligibility-topology.yml',
  ref: 'refs/heads/main',
  eventName: 'workflow_dispatch',
  runId: '88',
  runAttempt: '1',
  sourceSha: 'b'.repeat(40)
};

function githubRecord(overrides = {}) {
  return {
    id: 77,
    run_attempt: 1,
    status: 'completed',
    event: 'workflow_dispatch',
    head_branch: 'main',
    path: '.github/workflows/feature-eligibility-topology.yml',
    head_sha: sourceSha,
    workflow_id: 9,
    repository: { id: 1, full_name: '0xMiden/wallet', fork: false },
    head_repository: { id: 1, full_name: '0xMiden/wallet', fork: false },
    ...overrides
  };
}

function effects({ artifactOverrides = {}, resultArtifactOverrides = {}, contextOverrides = {} } = {}) {
  const calls = [];
  const prior = githubRecord({ run_attempt: 1 });
  const run = githubRecord();
  const api = async pathname => {
    calls.push(pathname);
    if (pathname === '/actions/runs/77') return run;
    if (pathname === '/actions/runs/77/attempts/1') return prior;
    if (pathname === '/actions/workflows/9')
      return { id: 9, path: '.github/workflows/feature-eligibility-topology.yml' };
    if (pathname === '/actions/workflows/9/runs?event=workflow_dispatch&per_page=100&page=1')
      return { total_count: 0, workflow_runs: [] };
    if (pathname === '/actions/runs/77/artifacts?per_page=100&page=1')
      return {
        total_count: 2,
        artifacts: [
          {
            id: 1234,
            name: 'eligibility-topology-prepared-77-1',
            expired: false,
            size_in_bytes: 1024,
            workflow_run: {
              id: 77,
              repository_id: 1,
              head_repository_id: 1,
              head_branch: 'main',
              head_sha: sourceSha,
              ...artifactOverrides
            }
          },
          {
            id: 5678,
            name: 'eligibility-topology-result-77-1',
            expired: false,
            size_in_bytes: 1024,
            workflow_run: {
              id: 77,
              repository_id: 1,
              head_repository_id: 1,
              head_branch: 'main',
              head_sha: sourceSha,
              ...resultArtifactOverrides
            }
          }
        ]
      };
    throw new Error(`unexpected GitHub endpoint: ${pathname}`);
  };
  return { calls, value: { context: { ...context, ...contextOverrides }, github: api } };
}

function lineageEffects({
  runs = [],
  selected = githubRecord(),
  artifacts = null,
  duplicateArtifact = false,
  historyTotal = runs.length,
  contextOverrides = {}
} = {}) {
  const calls = [];
  const baseArtifacts = artifacts ?? [
    ['prepared', 1234],
    ['result', 5678]
  ].map(([kind, artifactId]) => ({
    id: artifactId,
    name: `eligibility-topology-${kind === 'prepared' ? 'prepared' : 'result'}-${selected.id}-${selected.run_attempt}`,
    expired: false,
    size_in_bytes: 1024,
    workflow_run: {
      id: selected.id,
      repository_id: 1,
      head_repository_id: 1,
      head_branch: 'main',
      head_sha: sourceSha
    }
  }));
  if (duplicateArtifact) baseArtifacts.push({ ...baseArtifacts[0], id: 9100 });
  const api = async pathname => {
    calls.push(pathname);
    if (pathname === `/actions/runs/${selected.id}`) return selected;
    if (pathname === `/actions/runs/${selected.id}/attempts/${selected.run_attempt}`) return selected;
    if (pathname === '/actions/workflows/9') return { id: 9, path: '.github/workflows/feature-eligibility-topology.yml' };
    if (pathname === `/actions/runs/${selected.id}/artifacts?per_page=100&page=1`)
      return { total_count: baseArtifacts.length, artifacts: baseArtifacts };
    if (pathname === '/actions/workflows/9/runs?event=workflow_dispatch&per_page=100&page=1')
      return { total_count: historyTotal, workflow_runs: runs };
    throw new Error(`unexpected GitHub endpoint: ${pathname}`);
  };
  return { calls, value: { context: { ...context, ...contextOverrides }, github: api } };
}

test('recovery receipt binds one completed same-workflow main run, attempt and artifact', async () => {
  const { calls, value } = effects();
  const receipt = await prepareTopologyRecovery({ runId: '77', runAttempt: '1' }, value);

  assert.deepEqual(receipt, {
    schema: 1,
    repository: '0xMiden/wallet',
    workflowPath: '.github/workflows/feature-eligibility-topology.yml',
    runId: '77',
    runAttempt: '1',
    sourceSha,
    artifactId: '1234',
    resultArtifactId: '5678'
  });
  assert.equal(calls.length, 5);
});

test('a cleanup continuation may select the latest cleanup run once', async () => {
  const { value } = lineageEffects({
    selected: githubRecord({ id: 88, run_attempt: 1, name: 'cleanup_run_id=77 cleanup_attempt=1' }),
    contextOverrides: { runId: '99' }
  });
  const receipt = await prepareTopologyRecovery({ runId: '88', runAttempt: '1' }, value);
  assert.equal(receipt.runId, '88');
});

test('recovery refuses a reused original parent, including queued duplicate lineages', async () => {
  for (const runs of [
    [githubRecord({ id: 89, name: 'cleanup_run_id=77 cleanup_attempt=1' })],
    [
      githubRecord({ id: 89, name: 'cleanup_run_id=77 cleanup_attempt=1' }),
      githubRecord({ id: 90, name: 'cleanup_run_id=77 cleanup_attempt=1' })
    ],
    [githubRecord({ id: 89, status: 'queued', name: 'cleanup_run_id=77 cleanup_attempt=1' })]
  ]) {
    const { value } = lineageEffects({ runs });
    await assert.rejects(prepareTopologyRecovery({ runId: '77', runAttempt: '1' }, value), /Recovery provenance blocked/);
  }
});

test('recovery requires the selected latest attempt and rejects cleanup workflow reruns', async () => {
  const { value } = lineageEffects({ selected: githubRecord({ run_attempt: 2 }) });
  await assert.rejects(prepareTopologyRecovery({ runId: '77', runAttempt: '1' }, value), /Recovery provenance blocked/);
  const rerun = lineageEffects({ contextOverrides: { runAttempt: '2' } });
  await assert.rejects(prepareTopologyRecovery({ runId: '77', runAttempt: '1' }, rerun.value), /Recovery provenance blocked/);
});

test('recovery requires unique artifacts and bounded complete workflow history', async () => {
  const missing = lineageEffects({ artifacts: [] });
  await assert.rejects(prepareTopologyRecovery({ runId: '77', runAttempt: '1' }, missing.value), /Recovery provenance blocked/);
  const duplicate = lineageEffects({ duplicateArtifact: true });
  await assert.rejects(prepareTopologyRecovery({ runId: '77', runAttempt: '1' }, duplicate.value), /Recovery provenance blocked/);
  const overflow = lineageEffects({ historyTotal: 1001 });
  await assert.rejects(prepareTopologyRecovery({ runId: '77', runAttempt: '1' }, overflow.value), /Recovery provenance blocked/);
});

test('recovery refuses a non-main caller before making GitHub requests', async () => {
  const { calls, value } = effects({ contextOverrides: { ref: 'refs/heads/recovery' } });

  await assert.rejects(prepareTopologyRecovery({ runId: '77', runAttempt: '1' }, value), /Recovery provenance blocked/);
  assert.equal(calls.length, 0);
});

test('recovery refuses an artifact owned by a different run source', async () => {
  const { calls, value } = effects({ artifactOverrides: { head_sha: 'c'.repeat(40) } });

  await assert.rejects(prepareTopologyRecovery({ runId: '77', runAttempt: '1' }, value), /Recovery provenance blocked/);
  assert.equal(calls.length, 5);
});

test('recovery refuses a result artifact owned by a different source', async () => {
  const { calls, value } = effects({ resultArtifactOverrides: { head_sha: 'c'.repeat(40) } });

  await assert.rejects(prepareTopologyRecovery({ runId: '77', runAttempt: '1' }, value), /Recovery provenance blocked/);
  assert.equal(calls.length, 5);
});

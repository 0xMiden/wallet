import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { prepareTopologyRecovery } from './feature-eligibility-staging-topology-recovery.mjs';
import * as recoveryRunner from './feature-eligibility-staging-topology-recovery.mjs';

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
  const id = overrides.id ?? 77;
  return {
    id,
    name: 'cleanup_run_id= cleanup_attempt=',
    run_number: id,
    run_attempt: 1,
    status: 'completed',
    event: 'workflow_dispatch',
    head_branch: 'main',
    path: '.github/workflows/feature-eligibility-topology.yml',
    head_sha: sourceSha,
    workflow_id: 9,
    repository: { id: 1, full_name: '0xMiden/wallet', fork: false },
    head_repository: { id: 1, full_name: '0xMiden/wallet', fork: false },
    ...overrides,
    run_number: overrides.run_number ?? id
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
      return { total_count: 1, workflow_runs: [prior] };
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
  historyTotal,
  includeSelected = true,
  attemptsByRun = {},
  artifactsByRun = {},
  contextOverrides = {}
} = {}) {
  const calls = [];
  const history = [...runs];
  if (includeSelected && !history.some(run => run.id === selected.id)) history.push(selected);
  const totalCount = historyTotal ?? history.length;
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
    if (pathname.startsWith(`/actions/runs/${selected.id}/attempts/`)) return selected;
    if (pathname === '/actions/workflows/9') return { id: 9, path: '.github/workflows/feature-eligibility-topology.yml' };
    const historyPage = pathname.match(/^\/actions\/workflows\/9\/runs\?event=workflow_dispatch&per_page=100&page=(\d+)$/);
    if (historyPage) {
      const page = Number(historyPage[1]);
      return { total_count: totalCount, workflow_runs: history.slice((page - 1) * 100, page * 100) };
    }
    const runAttempt = pathname.match(/^\/actions\/runs\/([1-9][0-9]*)\/attempts\/([1-9][0-9]*)$/);
    if (runAttempt) {
      const runId = Number(runAttempt[1]);
      const attemptNumber = Number(runAttempt[2]);
      if (runId === selected.id) return selected;
      const provided = attemptsByRun[runId];
      if (provided) return provided[attemptNumber - 1] ?? null;
      const candidate = history.find(run => run.id === runId);
      return candidate ? { ...candidate, run_attempt: attemptNumber } : null;
    }
    const runArtifacts = pathname.match(/^\/actions\/runs\/([1-9][0-9]*)\/artifacts\?per_page=100&page=(\d+)$/);
    if (runArtifacts) {
      const runId = Number(runArtifacts[1]);
      const page = Number(runArtifacts[2]);
      const listed = runId === selected.id ? baseArtifacts : (artifactsByRun[runId] ?? []);
      return { total_count: listed.length, artifacts: listed.slice((page - 1) * 100, page * 100) };
    }
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

test('recovery refuses exact cleanup parent markers before reading attempts or candidate artifacts', async () => {
  const marker = 'cleanup_run_id=77 cleanup_attempt=1';
  const cases = [
    {
      runs: [githubRecord({ id: 89, run_attempt: 1, name: marker, conclusion: 'failure' })],
      attemptsByRun: { 89: [githubRecord({ id: 89, run_attempt: 1, name: marker, conclusion: 'failure' })] },
      candidateIds: [89]
    },
    {
      runs: [
        githubRecord({ id: 90, run_attempt: 1, name: marker, conclusion: 'failure' }),
        githubRecord({ id: 89, run_attempt: 1, name: marker, conclusion: 'failure' })
      ],
      attemptsByRun: {
        90: [githubRecord({ id: 90, run_attempt: 1, name: marker, conclusion: 'failure' })],
        89: [githubRecord({ id: 89, run_attempt: 1, name: marker, conclusion: 'failure' })]
      },
      candidateIds: [90, 89]
    },
    {
      runs: [githubRecord({ id: 89, run_attempt: 2, name: marker, conclusion: 'failure' })],
      attemptsByRun: {
        89: [
          githubRecord({ id: 89, run_attempt: 1, name: marker, conclusion: 'failure' }),
          githubRecord({ id: 89, run_attempt: 2, name: marker, conclusion: 'failure' })
        ]
      },
      candidateIds: [89]
    }
  ];

  for (const { runs, attemptsByRun, candidateIds } of cases) {
    const { calls, value } = lineageEffects({ runs, attemptsByRun });

    await assert.rejects(
      prepareTopologyRecovery({ runId: '77', runAttempt: '1' }, value),
      /Recovery provenance blocked/
    );
    assert.equal(
      calls.some(path => candidateIds.some(id => path.startsWith(`/actions/runs/${id}/attempts/`))),
      false
    );
    assert.equal(
      calls.some(path => candidateIds.some(id => path.startsWith(`/actions/runs/${id}/artifacts?`))),
      false
    );
  }
});

test('recovery blocks any matching cleanup attempt that is non-failed or incompletely described', async () => {
  const marker = 'cleanup_run_id=77 cleanup_attempt=1';
  const failed = githubRecord({ id: 89, run_attempt: 2, name: marker, conclusion: 'failure' });
  const failureAttempt = attempt =>
    githubRecord({ id: 89, run_attempt: attempt, name: marker, conclusion: 'failure' });
  const cases = [
    {
      run: failed,
      attemptsByRun: { 89: [githubRecord({ ...failureAttempt(1), conclusion: 'success' }), failureAttempt(2)] }
    },
    {
      run: githubRecord({ id: 89, name: marker, conclusion: 'success' }),
      attemptsByRun: { 89: [githubRecord({ id: 89, run_attempt: 1, name: marker, conclusion: 'success' })] }
    },
    {
      run: githubRecord({ id: 89, name: marker, status: 'queued', conclusion: null }),
      attemptsByRun: { 89: [githubRecord({ id: 89, run_attempt: 1, name: marker, status: 'queued', conclusion: null })] }
    },
    {
      run: githubRecord({ id: 89, name: marker, status: 'in_progress', conclusion: null }),
      attemptsByRun: { 89: [githubRecord({ id: 89, run_attempt: 1, name: marker, status: 'in_progress', conclusion: null })] }
    },
    {
      run: githubRecord({ id: 89, name: marker, conclusion: undefined }),
      attemptsByRun: { 89: [githubRecord({ id: 89, run_attempt: 1, name: marker, conclusion: undefined })] }
    },
    {
      run: githubRecord({ id: 89, name: marker, status: 'unknown', conclusion: null }),
      attemptsByRun: { 89: [githubRecord({ id: 89, run_attempt: 1, name: marker, status: 'unknown', conclusion: null })] }
    },
    {
      run: failed,
      attemptsByRun: { 89: [failureAttempt(1), null] }
    },
    {
      run: githubRecord({ id: 89, run_attempt: undefined, name: marker, conclusion: 'failure' }),
      attemptsByRun: { 89: [] }
    }
  ];

  for (const candidate of cases) {
    const { value } = lineageEffects({ runs: [candidate.run], attemptsByRun: candidate.attemptsByRun });
    await assert.rejects(
      prepareTopologyRecovery({ runId: '77', runAttempt: '1' }, value),
      /Recovery provenance blocked/
    );
  }
});

test('recovery blocks matching cleanup attempts that have prepared or result artifacts', async () => {
  const marker = 'cleanup_run_id=77 cleanup_attempt=1';
  const candidate = githubRecord({ id: 89, run_attempt: 2, name: marker, conclusion: 'failure' });
  const failedAttempts = [
    githubRecord({ id: 89, run_attempt: 1, name: marker, conclusion: 'failure' }),
    githubRecord({ id: 89, run_attempt: 2, name: marker, conclusion: 'failure' })
  ];

  for (const kind of ['prepared', 'result']) {
    const artifact = {
      id: 3456,
      name: `eligibility-topology-${kind}-89-1`,
      expired: false,
      size_in_bytes: 1024,
      workflow_run: { id: 89, repository_id: 1, head_repository_id: 1, head_branch: 'main', head_sha: sourceSha }
    };
    const { value } = lineageEffects({
      runs: [candidate],
      attemptsByRun: { 89: failedAttempts },
      artifactsByRun: { 89: [artifact] }
    });
    await assert.rejects(
      prepareTopologyRecovery({ runId: '77', runAttempt: '1' }, value),
      /Recovery provenance blocked/
    );
  }

  const ambiguous = lineageEffects({
    runs: [candidate],
    attemptsByRun: { 89: failedAttempts },
    artifactsByRun: { 89: [{ id: 3457, workflow_run: { id: 89 } }] }
  });
  await assert.rejects(
    prepareTopologyRecovery({ runId: '77', runAttempt: '1' }, ambiguous.value),
    /Recovery provenance blocked/
  );
});

test('recovery refuses a reused original parent, including queued duplicate lineages', async () => {
  for (const runs of [
    [githubRecord({ id: 89, name: 'cleanup_run_id=77 cleanup_attempt=1' })],
    [
      githubRecord({ id: 90, name: 'cleanup_run_id=77 cleanup_attempt=1' }),
      githubRecord({ id: 89, name: 'cleanup_run_id=77 cleanup_attempt=1' })
    ],
    [githubRecord({ id: 89, status: 'queued', name: 'cleanup_run_id=77 cleanup_attempt=1' })],
    [githubRecord({ id: 89, name: 'cleanup_run_id=77 cleanup_attempt=' })]
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

test('recovery requires unique artifacts and refuses history that omits the parent beyond the scan bound', async () => {
  const missing = lineageEffects({ artifacts: [] });
  await assert.rejects(prepareTopologyRecovery({ runId: '77', runAttempt: '1' }, missing.value), /Recovery provenance blocked/);
  const duplicate = lineageEffects({ duplicateArtifact: true });
  await assert.rejects(prepareTopologyRecovery({ runId: '77', runAttempt: '1' }, duplicate.value), /Recovery provenance blocked/);
  const history = Array.from({ length: 1000 }, (_, index) => githubRecord({ id: 10000 - index }));
  const overflow = lineageEffects({ runs: history, includeSelected: false, historyTotal: 1001 });
  await assert.rejects(prepareTopologyRecovery({ runId: '77', runAttempt: '1' }, overflow.value), /Recovery provenance blocked/);
  assert.equal(overflow.calls.filter(path => path.startsWith('/actions/workflows/9/runs?')).length, 10);
});

test('recovery permits over-1000 global history when the selected parent is reached inside the bounded scan', async () => {
  const selected = githubRecord();
  const newerRuns = Array.from({ length: 99 }, (_, index) => githubRecord({ id: 10000 - index }));
  const { calls, value } = lineageEffects({ runs: [...newerRuns, selected], selected, historyTotal: 1001 });

  await assert.doesNotReject(prepareTopologyRecovery({ runId: '77', runAttempt: '1' }, value));
  assert.equal(calls.filter(path => path.startsWith('/actions/workflows/9/runs?')).length, 1);
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

test('recovery permits interrupted initial run without result artifact and blocks continuations missing result', async () => {
  const preparedOnly = [
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
        head_sha: sourceSha
      }
    }
  ];
  const { value } = lineageEffects({ artifacts: preparedOnly });
  const receipt = await prepareTopologyRecovery({ runId: '77', runAttempt: '1' }, value);
  assert.deepEqual(receipt, {
    schema: 1,
    repository: '0xMiden/wallet',
    workflowPath: '.github/workflows/feature-eligibility-topology.yml',
    runId: '77',
    runAttempt: '1',
    sourceSha,
    artifactId: '1234',
    resultArtifactId: null
  });

  const continuationPreparedOnly = [
    {
      id: 1234,
      name: 'eligibility-topology-prepared-88-1',
      expired: false,
      size_in_bytes: 1024,
      workflow_run: {
        id: 88,
        repository_id: 1,
        head_repository_id: 1,
        head_branch: 'main',
        head_sha: sourceSha
      }
    }
  ];
  const continuation = lineageEffects({
    selected: githubRecord({ id: 88, run_attempt: 1, name: 'cleanup_run_id=77 cleanup_attempt=1' }),
    artifacts: continuationPreparedOnly,
    contextOverrides: { runId: '99' }
  });
  await assert.rejects(
    prepareTopologyRecovery({ runId: '88', runAttempt: '1' }, continuation.value),
    /Recovery provenance blocked/
  );
});

test('topology workflow gates prior result download and env binding on non-empty result_artifact_id', async () => {
  const workflow = await readFile(new URL('../.github/workflows/feature-eligibility-topology.yml', import.meta.url), 'utf8');
  assert.match(workflow, /if:\s*inputs\.operation == 'cleanup' && steps\.recovery\.outputs\.result_artifact_id != ''/);
  assert.match(
    workflow,
    /TOPOLOGY_PRIOR_RESULT_FILE:\s*\$\{\{\s*steps\.recovery\.outputs\.result_artifact_id != '' && format\('\{0\}\/eligibility-topology-prior-result\/result\.json', runner\.temp\) \|\| ''\s*\}\}/
  );
  assert.equal(
    recoveryRunner.formatRecoveryOutputs({
      artifactId: '1234',
      resultArtifactId: null,
      sourceSha,
      runId: '77',
      runAttempt: '1'
    }),
    `artifact_id=1234\nresult_artifact_id=\nsource_sha=${sourceSha}\nrun_id=77\nrun_attempt=1\n`
  );
  assert.equal(
    recoveryRunner.formatRecoveryOutputs({
      artifactId: '1234',
      resultArtifactId: '5678',
      sourceSha,
      runId: '77',
      runAttempt: '1'
    }),
    `artifact_id=1234\nresult_artifact_id=5678\nsource_sha=${sourceSha}\nrun_id=77\nrun_attempt=1\n`
  );
});

test('recovery CLI prepare writes formatted GITHUB_OUTPUT and receipt with empty result_artifact_id when result artifact is absent', async () => {
  const preparedOnly = [
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
        head_sha: sourceSha
      }
    }
  ];
  const { value } = lineageEffects({ artifacts: preparedOnly });
  const runnerTemp = await mkdtemp(path.join(tmpdir(), 'topology-recovery-cli-'));
  const outputPath = path.join(runnerTemp, 'github-output.txt');
  await writeFile(outputPath, '', { mode: 0o600 });
  const server = createServer(async (req, res) => {
    try {
      const prefix = '/repos/0xMiden/wallet';
      if (!req.url?.startsWith(prefix)) throw new Error(`unexpected URL: ${req.url}`);
      const payload = await value.github(req.url.slice(prefix.length));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    } catch {
      res.writeHead(404);
      res.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const scriptPath = fileURLToPath(new URL('./feature-eligibility-staging-topology-recovery.mjs', import.meta.url));
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath, 'prepare'], {
        env: {
          ...process.env,
          GH_TOKEN: 't'.repeat(24),
          GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
          GITHUB_REPOSITORY: context.repository,
          GITHUB_REF: context.ref,
          GITHUB_EVENT_NAME: context.eventName,
          GITHUB_RUN_ID: context.runId,
          GITHUB_RUN_ATTEMPT: context.runAttempt,
          GITHUB_SHA: context.sourceSha,
          CLEANUP_RUN_ID: '77',
          CLEANUP_ATTEMPT: '1',
          RUNNER_TEMP: runnerTemp,
          GITHUB_OUTPUT: outputPath
        },
        stdio: 'ignore'
      });
      child.once('error', reject);
      child.once('exit', resolve);
    });

    assert.equal(exitCode, 0);
    const outputs = await readFile(outputPath, 'utf8');
    assert.equal(
      outputs,
      `artifact_id=1234\nresult_artifact_id=\nsource_sha=${sourceSha}\nrun_id=77\nrun_attempt=1\n`
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(runnerTemp, { recursive: true, force: true });
  }
});

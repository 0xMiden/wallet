import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

// Last verified nightly before native swaps existed. Never bootstrap past an unknown funded run.
const BASELINE_RUN = 42966766471;
const BASELINE_SHA = '96a3228a181d050395241d00071c5863a1815ab5';
const LEGACY_SPENDING_STEPS = [
  'Run native mainnet round trip',
  'Run USDCx bridge loops',
  'Run the mainnet AggLayer loop',
  'Run mainnet round trip, USDCx bridge loops, and read-only 1Click preflight'
];

export function knownUnspentEpochPreAuthorization(checkpointDigest, run, jobs, now = Date.now()) {
  // This exact no-authority checkpoint preceded the pinned source's first native ACK and queue release.
  if (
    checkpointDigest !== '8ec4e65e7f1f912ef290881fe65b69158af56838b0afd3b93bb6fb73f65646ef' ||
    run?.id !== 43619310746 ||
    run.repository?.id !== 853430876 ||
    run.workflow_id !== 391951744 ||
    run.head_sha !== '9fbe3807bcdd68ce728ed15bc3ab98c63815fba4' ||
    run.head_branch !== 'wiktor/nightly-swap-loop' ||
    run.event !== 'workflow_dispatch' ||
    run.run_attempt !== 1 ||
    run.status !== 'completed' ||
    run.conclusion !== 'failure' ||
    !Number.isSafeInteger(now) ||
    now <= Date.parse('2026-11-14T17:24:34.674Z') ||
    !Array.isArray(jobs?.jobs)
  )
    return false;
  const matching = jobs.jobs.filter(job => job.name === 'Chrome mainnet round trip');
  if (matching.length !== 1 || matching[0].status !== 'completed' || matching[0].conclusion !== 'failure') return false;
  const steps = matching[0].steps;
  if (!Array.isArray(steps)) return false;
  return [
    ['Prepare mainnet Epoch loop', 'success'],
    ['Run mainnet epoch forward', 'success'],
    ['Upload Epoch native forward authority', 'failure'],
    ['Upload Epoch SDK forward authority', 'skipped'],
    ['Wait for mainnet Epoch forward', 'skipped'],
    ['Run mainnet epoch reverse', 'skipped'],
    ['Upload Epoch reverse authority', 'skipped'],
    // Recovery and fresh EVM/claim uploads share names in this pinned workflow; both copies must be skipped.
    ['Upload mainnet epoch signed EVM 1', 'skipped', 2],
    ['Upload mainnet epoch signed EVM 2', 'skipped', 2],
    ['Upload mainnet epoch signed EVM 3', 'skipped', 2],
    ['Upload mainnet epoch native return claim', 'skipped', 2],
    ['Wait for mainnet Epoch return', 'skipped']
  ].every(([name, conclusion, count = 1]) => {
    const matches = steps.filter(step => step.name === name);
    return (
      matches.length === count && matches.every(step => step.status === 'completed' && step.conclusion === conclusion)
    );
  });
}

export function knownUnspentNearPreAuthorization(checkpointDigest, run, jobs, audit, auditJobs, now = Date.now()) {
  // The pinned native gate persists its SDK request before upload, then releases it only after immutable ACK.
  if (
    checkpointDigest !== 'd2283bdd2372696ebe109c6b31ce5190ac7b29be07901e2ede142ba8c1f18524' ||
    !Number.isSafeInteger(now) ||
    now <= Date.parse('2026-11-16T05:57:46.601Z') ||
    !Array.isArray(jobs?.jobs) ||
    !Array.isArray(auditJobs?.jobs)
  )
    return false;
  const scheduled = {
    id: 43811169447,
    workflow_id: 391951744,
    head_sha: '7fccdbfc371cdefc542b45af51de192032a8d415',
    head_branch: 'main',
    event: 'schedule',
    run_attempt: 1,
    status: 'completed',
    conclusion: 'failure'
  };
  const reviewed = {
    id: 43925502671,
    workflow_id: 415130600,
    head_sha: '748558a9438ecbbaf73639c4c4b81c303609a068',
    head_branch: 'wiktor/mainnet-438111-audit',
    event: 'push',
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success'
  };
  if (
    run?.repository?.id !== 853430876 ||
    audit?.repository?.id !== 853430876 ||
    !Object.entries(scheduled).every(([key, value]) => run[key] === value) ||
    !Object.entries(reviewed).every(([key, value]) => audit[key] === value)
  )
    return false;
  if (
    auditJobs.jobs.length !== 2 ||
    !['public-sdk', 'private-inventory'].every(name => {
      const matches = auditJobs.jobs.filter(job => job.name === name);
      return matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === 'success';
    })
  )
    return false;
  const matching = jobs.jobs.filter(job => job.name === 'Chrome mainnet round trip');
  if (
    matching.length !== 1 ||
    matching[0].status !== 'completed' ||
    matching[0].conclusion !== 'failure' ||
    !Array.isArray(matching[0].steps)
  )
    return false;
  return [
    ['Prepare mainnet NEAR loop', 'success'],
    ['Upload native NEAR read-only preflight', 'success'],
    ['Run mainnet near forward', 'success'],
    ['Upload NEAR native forward authority', 'failure'],
    ['Wait for mainnet NEAR forward', 'skipped'],
    ['Run mainnet near reverse', 'skipped'],
    ['Upload NEAR reverse authority', 'skipped'],
    ['Upload mainnet near signed EVM 1', 'skipped', 2],
    ['Upload mainnet near native return claim', 'skipped', 2],
    ['Authorize original near return claim', 'skipped'],
    ['Authorize original near refund', 'skipped'],
    ['Wait for mainnet NEAR return', 'skipped']
  ].every(([name, conclusion, count = 1]) => {
    const matches = matching[0].steps.filter(step => step.name === name);
    return (
      matches.length === count && matches.every(step => step.status === 'completed' && step.conclusion === conclusion)
    );
  });
}

function validateProvider(provider) {
  if (!['swap', 'epoch', 'near'].includes(provider)) throw new Error('Invalid mainnet loop provider');
}

function stepAttempted(jobs, names) {
  if (!Array.isArray(jobs?.jobs)) throw new Error('Invalid workflow jobs response');
  return jobs.jobs.some(job =>
    (job.steps ?? []).some(
      step =>
        names.includes(step.name) && ['in_progress', 'completed'].includes(step.status) && step.conclusion !== 'skipped'
    )
  );
}

export function swapStepAttempted(jobs, leg, provider = 'swap') {
  validateProvider(provider);
  return stepAttempted(jobs, [
    `Run mainnet ${provider} ${leg}`,
    ...(provider === 'near' ? ['Run funded 1Click swap-out and swap-back acceptance'] : [])
  ]);
}

async function reconciledReadOnlyLegacyFailure(run, step, getArtifacts) {
  // This immutable report stops at the reviewed source's first indexer read, before its AggLayer deposit call.
  // shortcut: requires retained artifact metadata; archive the verified receipt before its retention expires.
  const source = '46d7fcf8ac612ca48997753574b53b308e365070';
  if (
    run.id !== 43562192705 ||
    run.head_sha !== source ||
    run.head_branch !== 'main' ||
    run.event !== 'schedule' ||
    step.name !== 'Run the mainnet AggLayer loop' ||
    step.status !== 'completed' ||
    step.conclusion !== 'failure'
  )
    return false;
  const result = await getArtifacts(run.id);
  if (!Array.isArray(result?.artifacts)) throw new Error('Invalid legacy reconciliation artifact response');
  const reports = result.artifacts.filter(item => item.name === 'mainnet-agglayer-43562192705');
  if (reports.length !== 1) return false;
  const [report] = reports;
  return (
    report.id === 14100963457 &&
    report.expired === false &&
    report.digest === 'sha256:dbf7bc5943653fc30cb53f633fc9db1e059f6ab06b17f850e9cfe5135cbcaedb' &&
    report.workflow_run?.id === run.id &&
    report.workflow_run.head_sha === source &&
    report.workflow_run.head_branch === 'main' &&
    report.workflow_run.repository_id === 853430876 &&
    report.workflow_run.head_repository_id === 853430876
  );
}

export async function chooseSwapCheckpoint(runs, getArtifacts, getJobs, baseline = BASELINE_RUN, provider = 'swap') {
  validateProvider(provider);
  const orderedRuns = [...runs].sort((a, b) => b.id - a.id);
  if (provider === 'swap') {
    // A newer swap checkpoint cannot resolve an older interrupted legacy transfer.
    for (const run of orderedRuns) {
      if (!Number.isSafeInteger(run.id)) throw new Error('Invalid workflow run identity');
      if (run.id <= baseline) break;
      const jobs = await getJobs(run.id);
      if (!Array.isArray(jobs?.jobs)) throw new Error('Invalid workflow jobs response');
      for (const step of jobs.jobs.flatMap(job => job.steps ?? [])) {
        if (
          LEGACY_SPENDING_STEPS.includes(step.name) &&
          step.conclusion !== 'skipped' &&
          !(step.status === 'completed' && step.conclusion === 'success')
        ) {
          if (await reconciledReadOnlyLegacyFailure(run, step, getArtifacts)) continue;
          throw new Error(`Unresolved legacy activity in run ${run.id}; reconcile original outcomes before spending`);
        }
      }
    }
  }
  const prefix = provider === 'near' ? '1click' : provider;
  const signed =
    provider === 'swap'
      ? []
      : Array.from({ length: provider === 'epoch' ? 3 : 1 }, (_, index) => `reverse-signed-${index + 1}`).reverse();
  const reverseStages = [
    ...(provider === 'swap'
      ? ['reverse-claim-sdk-authorized', 'reverse-sdk-authorized']
      : ['return-authorized', ...signed]),
    'reverse-authorized'
  ];
  const stages = [
    'final',
    ...(provider === 'swap' ? [] : ['refund-authorized']),
    ...reverseStages,
    ...(provider === 'swap' ? ['forward-claim-sdk-authorized'] : []),
    ...(provider === 'near' ? [] : ['forward-sdk-authorized']),
    'forward-authorized'
  ];
  if (provider === 'near') stages.push('execute-started', 'preflight');
  for (const run of orderedRuns) {
    if (!Number.isSafeInteger(run.id)) throw new Error('Invalid workflow run identity');
    if (run.id <= baseline) return { bootstrap: true };
    const artifacts = await getArtifacts(run.id);
    if (!Array.isArray(artifacts?.artifacts)) throw new Error('Invalid workflow artifact response');
    const has = stage => artifacts.artifacts.some(artifact => artifact.name === `mainnet-${prefix}-${stage}-${run.id}`);
    if (provider !== 'swap' && !has('final') && has('return-authorized') && has('refund-authorized'))
      throw new Error(`Contradictory mainnet ${provider} return and refund authorization`);
    const jobs = has('final') ? { jobs: [] } : await getJobs(run.id);
    if (!has('final')) {
      if (provider === 'swap') {
        if (
          stepAttempted(jobs, ['Upload original swap recovery claim authority']) &&
          !['forward-claim-sdk-authorized', 'reverse-claim-sdk-authorized'].some(has)
        )
          throw new Error('Original swap recovery claim checkpoint missing; refusing an older authority');
        if (
          stepAttempted(jobs, ['Upload swap SDK forward authority']) &&
          ![
            'forward-sdk-authorized',
            'forward-claim-sdk-authorized',
            'reverse-sdk-authorized',
            'reverse-claim-sdk-authorized'
          ].some(has)
        )
          throw new Error('Actual mainnet swap forward SDK checkpoint missing; refusing a pre-SDK downgrade');
        if (
          stepAttempted(jobs, ['Upload swap SDK reverse authority', 'Upload recovered swap SDK return authority']) &&
          !['reverse-sdk-authorized', 'reverse-claim-sdk-authorized'].some(has)
        )
          throw new Error('Actual mainnet swap reverse SDK checkpoint missing; refusing a pre-SDK downgrade');
        if (
          stepAttempted(jobs, ['Upload swap SDK forward claim authority']) &&
          !['forward-claim-sdk-authorized', ...reverseStages].some(has)
        )
          throw new Error('Actual forward claim checkpoint missing; refusing a create-only downgrade');
        if (
          stepAttempted(jobs, [
            'Upload swap SDK reverse claim authority',
            'Upload recovered swap SDK return claim authority'
          ]) &&
          !has('reverse-claim-sdk-authorized')
        )
          throw new Error('Actual return claim checkpoint missing; refusing a create-only downgrade');
      }
      if (
        provider === 'epoch' &&
        stepAttempted(jobs, ['Upload Epoch SDK forward authority']) &&
        !['forward-sdk-authorized', 'refund-authorized', ...reverseStages].some(has)
      )
        throw new Error('Actual Epoch forward SDK checkpoint missing; refusing a pre-SDK downgrade');
      if (provider !== 'swap') {
        if (
          stepAttempted(jobs, [
            `Upload mainnet ${provider} native return claim`,
            `Authorize original ${provider} return claim`
          ]) &&
          !has('return-authorized')
        )
          throw new Error(`Original mainnet ${provider} claim checkpoint missing; refusing a pre-claim downgrade`);
        if (stepAttempted(jobs, [`Authorize original ${provider} refund`]) && !has('refund-authorized'))
          throw new Error(`Original mainnet ${provider} refund checkpoint missing; refusing an older authority`);
      }
      if (
        provider === 'near' &&
        stepAttempted(jobs, ['Run mainnet near forward']) &&
        !['forward-authorized', 'refund-authorized', ...reverseStages].some(has)
      )
        throw new Error(
          'Recovery checkpoint missing for attempted native NEAR forward; refusing a read-only preflight downgrade'
        );
      if (stepAttempted(jobs, [`Run mainnet ${provider} reverse`]) && !reverseStages.some(has))
        throw new Error(
          `Recovery checkpoint missing for attempted mainnet ${provider} reverse; refusing a forward downgrade`
        );
      for (const [index, stage] of signed.entries()) {
        const number = stage.slice('reverse-signed-'.length);
        if (
          stepAttempted(jobs, [`Upload mainnet ${provider} signed EVM ${number}`]) &&
          !['return-authorized', ...signed.slice(0, index + 1)].some(has)
        )
          throw new Error(
            `Signed mainnet ${provider} journal missing after upload stage ${number}; refusing an older authority`
          );
      }
    }
    for (const stage of stages) {
      const name = `mainnet-${prefix}-${stage}-${run.id}`;
      const matching = artifacts.artifacts.filter(artifact => artifact.name === name);
      if (matching.length > 1) throw new Error(`Duplicate mainnet ${provider} checkpoint artifact`);
      const [artifact] = matching;
      if (artifact) {
        if (artifact.expired)
          throw new Error(`Newest ${provider} checkpoint expired in run ${run.id}; recover before restarting`);
        return { runId: run.id, name, bootstrap: false };
      }
    }
    if (swapStepAttempted(jobs, 'forward', provider) || swapStepAttempted(jobs, 'reverse', provider)) {
      throw new Error(
        `Recovery checkpoint missing for potentially funded run ${run.id}; refusing an older complete checkpoint`
      );
    }
  }
  throw new Error('Swap checkpoint history did not reach the verified baseline; refusing to bootstrap');
}

async function github(path) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) throw new Error('Missing GitHub workflow identity/token');
  const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`Checkpoint GitHub API failed: HTTP ${response.status}`);
  return response.json();
}

function output(name, value) {
  if (!process.env.GITHUB_OUTPUT) throw new Error('This command must run in GitHub Actions');
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function main() {
  const mode = process.argv[2];
  const provider = process.argv[3] ?? 'swap';
  validateProvider(provider);
  const prefix = provider === 'near' ? '1click' : provider;
  if (mode === 'attempts') {
    const checkpoint = readFileSync(`test-results/mainnet-${prefix}-state/roundtrip.json`, 'utf8');
    const state = JSON.parse(checkpoint);
    for (const [leg, id] of [
      ['forward', state.sourceRunId],
      ['reverse', state.authorizationRunId ?? state.sourceRunId]
    ]) {
      if (typeof id !== 'string' || !/^\d+$/.test(id)) throw new Error('Invalid checkpoint source workflow identity');
      const run = await github(`actions/runs/${id}`);
      const current = await github(`actions/runs/${process.env.GITHUB_RUN_ID}`);
      if (run.workflow_id !== current.workflow_id) throw new Error('Checkpoint source belongs to a different workflow');
      const jobs = await github(`actions/runs/${id}/jobs?per_page=100`);
      output(`${leg}_attempted`, swapStepAttempted(jobs, leg, provider));
      if (provider === 'near' && leg === 'forward') {
        let verified = false;
        if (id === '43811169447') {
          const audit = await github('actions/runs/43925502671');
          const auditJobs = await github('actions/runs/43925502671/jobs?per_page=100');
          verified = knownUnspentNearPreAuthorization(
            createHash('sha256').update(checkpoint).digest('hex'),
            run,
            jobs,
            audit,
            auditJobs
          );
        }
        output('forward_pre_authority_unspent', verified);
      }
      if (provider === 'epoch' && leg === 'forward')
        output(
          'forward_pre_authority_unspent',
          knownUnspentEpochPreAuthorization(createHash('sha256').update(checkpoint).digest('hex'), run, jobs)
        );
    }
    return;
  }
  if (mode !== 'find') throw new Error('Use find or attempts');
  const anchor = await github(`actions/runs/${BASELINE_RUN}`);
  const current = await github(`actions/runs/${process.env.GITHUB_RUN_ID}`);
  if (
    anchor.head_sha !== BASELINE_SHA ||
    anchor.workflow_id !== current.workflow_id ||
    anchor.conclusion !== 'success'
  ) {
    throw new Error('The pre-swap baseline is not the verified successful mainnet nightly');
  }
  const runs = [];
  for (let page = 1; page <= 10; page++) {
    const result = await github(`actions/workflows/${current.workflow_id}/runs?per_page=100&page=${page}`);
    if (!Array.isArray(result.workflow_runs)) throw new Error('Invalid workflow history response');
    runs.push(...result.workflow_runs.filter(run => run.id < Number(process.env.GITHUB_RUN_ID)));
    if (result.workflow_runs.some(run => run.id <= BASELINE_RUN) || result.workflow_runs.length < 100) break;
  }
  const selected = await chooseSwapCheckpoint(
    runs,
    id => github(`actions/runs/${id}/artifacts?per_page=100`),
    id => github(`actions/runs/${id}/jobs?per_page=100`),
    BASELINE_RUN,
    provider
  );
  output('bootstrap', selected.bootstrap);
  if (!selected.bootstrap) {
    output('run_id', selected.runId);
    output('name', selected.name);
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'mainnet-swap-artifacts.mjs') {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

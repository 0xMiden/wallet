import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoundedBytes } from '../services/feature-eligibility/staging-topology-api.mjs';

const REPOSITORY = '0xMiden/wallet';
const WORKFLOW = '.github/workflows/feature-eligibility-topology.yml';
const MAX_ARTIFACT_BYTES = 12 * 1024 * 1024;
const MAX_HISTORY_RUNS = 1000;
const MAX_JOB_LOOKUPS = 5;
const marker = /^cleanup_run_id=([1-9][0-9]{0,17}) cleanup_attempt=([1-9][0-9]{0,5})$/;
const NOT_EXECUTED_STATUSES = ['queued', 'waiting', 'requested', 'pending'];
const CLEANUP_STEP = 'Clean exact current run';
const RUN_ONLY_STEPS = [
  'Bundle exact topology Worker',
  'Observe inventory and prepare exact run artifact',
  'Retain pre-deployment recovery artifact',
  'Deploy and exercise all synthetic scenarios',
  CLEANUP_STEP
];
const RETAIN_STEP = 'Retain unchanged prepared artifact for continuation';
const RECOVER_STEP = 'Recover exact prior Worker cleanup';
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,17}$/.test(value);
const attempt = value => typeof value === 'string' && /^[1-9][0-9]{0,5}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const requireValue = value => {
  if (!value) throw new Error('Recovery provenance blocked');
};

function trusted(context) {
  return (
    context?.repository === REPOSITORY &&
    context.workflowPath === WORKFLOW &&
    context.ref === 'refs/heads/main' &&
    context.eventName === 'workflow_dispatch' &&
    id(context.runId) &&
    context.runAttempt === '1' &&
    sha(context.sourceSha)
  );
}

export async function prepareTopologyRecovery(input, effects) {
  requireValue(trusted(effects?.context) && input && Object.keys(input).sort().join(',') === 'runAttempt,runId');
  requireValue(id(input.runId) && attempt(input.runAttempt) && input.runId !== effects.context.runId);
  const run = await effects.github(`/actions/runs/${input.runId}`);
  requireValue(run?.run_attempt === Number(input.runAttempt));
  const prior = await effects.github(`/actions/runs/${input.runId}/attempts/${input.runAttempt}`);
  const validRun = value =>
    value?.id === Number(input.runId) &&
    value.status === 'completed' &&
    value.event === 'workflow_dispatch' &&
    value.head_branch === 'main' &&
    value.path === WORKFLOW &&
    sha(value.head_sha) &&
    Number.isSafeInteger(value.workflow_id) &&
    value.workflow_id > 0 &&
    value.repository?.full_name === REPOSITORY &&
    value.repository.fork === false &&
    Number.isSafeInteger(value.repository.id) &&
    value.head_repository?.full_name === REPOSITORY &&
    value.head_repository.fork === false &&
    value.head_repository.id === value.repository.id;
  requireValue(
    validRun(run) &&
      validRun(prior) &&
      prior.run_attempt === Number(input.runAttempt) &&
      run.head_sha === prior.head_sha &&
      run.workflow_id === prior.workflow_id &&
      run.repository.id === prior.repository.id
  );
  const workflow = await effects.github(`/actions/workflows/${prior.workflow_id}`);
  requireValue(workflow?.id === prior.workflow_id && workflow.path === WORKFLOW);
  const listArtifacts = async runId => {
    const artifacts = [];
    let total;
    for (let page = 1; ; page++) {
      requireValue(page <= 10);
      const listing = await effects.github(`/actions/runs/${runId}/artifacts?per_page=100&page=${page}`);
      requireValue(
        Array.isArray(listing?.artifacts) &&
          Number.isSafeInteger(listing.total_count) &&
          listing.total_count >= 0 &&
          listing.total_count <= 1000 &&
          listing.artifacts.length <= 100 &&
          (total === undefined || total === listing.total_count)
      );
      total = listing.total_count;
      artifacts.push(...listing.artifacts);
      requireValue(artifacts.length <= total);
      if (artifacts.length === total) break;
      requireValue(listing.artifacts.length === 100);
    }
    return artifacts;
  };
  const readCompletedTopologyJob = async (runId, runAttempt) => {
    let listing;
    try {
      listing = await effects.github(`/actions/runs/${runId}/jobs?per_page=100&filter=latest`);
    } catch {
      return null;
    }
    if (!(Array.isArray(listing?.jobs) && listing.total_count === 1 && listing.jobs.length === 1)) return null;
    const [job] = listing.jobs;
    if (
      !(
        job?.run_id === runId &&
        job.name === 'topology' &&
        job.status === 'completed' &&
        job.run_attempt === runAttempt &&
        Array.isArray(job.steps) &&
        job.steps.length <= 100
      )
    )
      return null;
    if (job.steps.length === 0) {
      return {
        emptyOffline: job.runner_id === null && ['cancelled', 'skipped'].includes(job.conclusion),
        conclusionOf: () => undefined
      };
    }
    const names = job.steps.map(step => step?.name);
    if (names.some(name => typeof name !== 'string') || new Set(names).size !== names.length) return null;
    return { emptyOffline: false, conclusionOf: name => job.steps.find(step => step.name === name)?.conclusion };
  };
  let jobLookups = 0;
  const neverRetained = async candidate => {
    if (
      !(
        candidate.status === 'completed' &&
        candidate.event === 'workflow_dispatch' &&
        candidate.head_branch === 'main' &&
        candidate.path === WORKFLOW &&
        candidate.workflow_id === prior.workflow_id &&
        candidate.repository?.id === prior.repository.id &&
        candidate.repository.full_name === REPOSITORY &&
        candidate.repository.fork === false &&
        candidate.run_attempt === 1 &&
        ['failure', 'cancelled', 'timed_out'].includes(candidate.conclusion)
      )
    )
      return false;
    if (jobLookups >= MAX_JOB_LOOKUPS) return false;
    jobLookups++;
    const parsed = await readCompletedTopologyJob(candidate.id, 1);
    if (!parsed) return false;
    if (parsed.emptyOffline) return true;
    return (
      [...RUN_ONLY_STEPS, RECOVER_STEP].every(name => parsed.conclusionOf(name) === 'skipped') &&
      ['skipped', 'failure'].includes(parsed.conclusionOf(RETAIN_STEP))
    );
  };
  const seenRuns = new Set();
  let historyTotal;
  let historyCount = 0;
  let previousRunNumber = Number.MAX_SAFE_INTEGER;
  let parentFound = false;
  let currentRunSeen = false;
  for (let page = 1; ; page++) {
    requireValue(page <= MAX_HISTORY_RUNS / 100);
    const listing = await effects.github(
      `/actions/workflows/${prior.workflow_id}/runs?event=workflow_dispatch&per_page=100&page=${page}`
    );
    requireValue(
      Array.isArray(listing?.workflow_runs) &&
        Number.isSafeInteger(listing.total_count) &&
        listing.total_count >= 0 &&
        listing.workflow_runs.length <= 100 &&
        (historyTotal === undefined || historyTotal === listing.total_count)
    );
    historyTotal = listing.total_count;
    historyCount += listing.workflow_runs.length;
    requireValue(historyCount <= historyTotal && historyCount <= MAX_HISTORY_RUNS);
    for (const candidate of listing.workflow_runs) {
      requireValue(
        Number.isSafeInteger(candidate?.id) &&
          candidate.id > 0 &&
          Number.isSafeInteger(candidate.run_number) &&
          candidate.run_number > 0 &&
          candidate.run_number < previousRunNumber &&
          !seenRuns.has(candidate.id)
      );
      previousRunNumber = candidate.run_number;
      seenRuns.add(candidate.id);
      if (candidate.id === prior.id) {
        requireValue(validRun(candidate) && candidate.run_attempt === prior.run_attempt && candidate.run_number === prior.run_number);
        parentFound = true;
        break;
      }
      if (candidate.id === Number(effects.context.runId)) {
        currentRunSeen = true;
        continue;
      }
      if (!currentRunSeen && NOT_EXECUTED_STATUSES.includes(candidate.status)) continue;
      requireValue(typeof candidate.name === 'string');
      const skippedNonMain =
        candidate.status === 'completed' &&
        candidate.conclusion === 'skipped' &&
        candidate.event === 'workflow_dispatch' &&
        typeof candidate.head_branch === 'string' &&
        candidate.head_branch.length > 0 &&
        candidate.head_branch !== 'main' &&
        candidate.path === WORKFLOW &&
        candidate.workflow_id === prior.workflow_id &&
        candidate.repository?.id === prior.repository.id &&
        candidate.repository?.full_name === REPOSITORY &&
        candidate.repository?.fork === false;
      if (skippedNonMain) continue;
      const parent = marker.exec(candidate.name);
      const blocksParent =
        (candidate.name.startsWith(`cleanup_run_id=${input.runId} `) && parent === null) ||
        (parent?.[1] === input.runId && parent?.[2] === input.runAttempt);
      if (blocksParent) requireValue(await neverRetained(candidate));
    }
    if (parentFound) {
      requireValue(historyCount === historyTotal || listing.workflow_runs.length === 100);
      break;
    }
    if (historyCount === historyTotal) break;
    requireValue(listing.workflow_runs.length === 100);
  }
  requireValue(parentFound && currentRunSeen);
  const artifacts = await listArtifacts(input.runId);
  requireValue(new Set(artifacts.map(value => value.id)).size === artifacts.length);
  const validateArtifact = artifact => {
    const provenance = artifact.workflow_run;
    requireValue(
      Number.isSafeInteger(artifact.id) &&
        artifact.id > 0 &&
        artifact.expired === false &&
        Number.isSafeInteger(artifact.size_in_bytes) &&
        artifact.size_in_bytes > 0 &&
        artifact.size_in_bytes <= MAX_ARTIFACT_BYTES &&
        provenance?.id === prior.id &&
        provenance.repository_id === prior.repository.id &&
        provenance.head_repository_id === prior.repository.id &&
        provenance.head_branch === 'main' &&
        provenance.head_sha === prior.head_sha
    );
    return String(artifact.id);
  };
  const artifactFor = (name, { optional = false } = {}) => {
    const matches = artifacts.filter(value => value.name === name);
    if (optional && matches.length === 0) return null;
    requireValue(matches.length === 1);
    return validateArtifact(matches[0]);
  };
  const isCleanupRun = typeof prior.name === 'string' && marker.test(prior.name);
  const artifactId = artifactFor(`eligibility-topology-prepared-${input.runId}-${input.runAttempt}`);
  const resultArtifactId = artifactFor(`eligibility-topology-result-${input.runId}-${input.runAttempt}`, {
    optional: !isCleanupRun
  });
  let priorCleanupSkipped = false;
  if (resultArtifactId === null) {
    const parsed = await readCompletedTopologyJob(prior.id, prior.run_attempt);
    priorCleanupSkipped = Boolean(
      parsed && (parsed.emptyOffline || parsed.conclusionOf(CLEANUP_STEP) === 'skipped')
    );
  }
  return Object.freeze({
    schema: 1,
    repository: REPOSITORY,
    workflowPath: WORKFLOW,
    runId: input.runId,
    runAttempt: input.runAttempt,
    sourceSha: prior.head_sha,
    artifactId,
    resultArtifactId,
    priorCleanupSkipped
  });
}

export function formatRecoveryOutputs(receipt) {
  return `artifact_id=${receipt.artifactId}\nresult_artifact_id=${receipt.resultArtifactId ?? ''}\nsource_sha=${receipt.sourceSha}\nrun_id=${receipt.runId}\nrun_attempt=${receipt.runAttempt}\n`;
}

export function createGitHubReader({
  token,
  apiUrl = 'https://api.github.com',
  fetchImpl = fetch,
  requestTimeoutMs = 5_000,
  deadlineMs = 120_000,
  maxBytes = 8 * 1024 * 1024,
  now = Date.now
} = {}) {
  const startedAt = now();
  return async pathname => {
    const remaining = deadlineMs - (now() - startedAt);
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('GitHub recovery metadata unavailable');
    const controller = new AbortController();
    let timer;
    try {
      const work = (async () => {
        const response = await fetchImpl(`${apiUrl}/repos/${REPOSITORY}${pathname}`, {
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
          redirect: 'error',
          signal: controller.signal
        });
        if (!response.ok) throw new Error('GitHub recovery metadata unavailable');
        const bytes = await readBoundedBytes(response, { maxBytes, signal: controller.signal });
        if (bytes === null) throw new Error('GitHub recovery metadata unavailable');
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      })();
      work.catch(() => {});
      const timeoutRace = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('GitHub recovery metadata unavailable'));
        }, Math.min(requestTimeoutMs, remaining));
      });
      return await Promise.race([work, timeoutRace]);
    } catch {
      throw new Error('GitHub recovery metadata unavailable');
    } finally {
      clearTimeout(timer);
    }
  };
}

async function main() {
  if (process.argv[2] !== 'prepare') throw new Error('Invalid recovery operation');
  const env = process.env;
  const token = env.GH_TOKEN;
  if (typeof token !== 'string' || token.length < 20) throw new Error('GitHub recovery token unavailable');
  const context = {
    repository: env.GITHUB_REPOSITORY,
    workflowPath: WORKFLOW,
    ref: env.GITHUB_REF,
    eventName: env.GITHUB_EVENT_NAME,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    sourceSha: env.GITHUB_SHA
  };
  const reader = createGitHubReader({ token, apiUrl: env.GITHUB_API_URL });
  const receipt = await prepareTopologyRecovery(
    { runId: env.CLEANUP_RUN_ID, runAttempt: env.CLEANUP_ATTEMPT },
    { context, github: reader }
  );
  const root = env.RUNNER_TEMP;
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof env.GITHUB_OUTPUT !== 'string')
    throw new Error('Runner output unavailable');
  const directory = path.join(root, 'eligibility-topology-recovery');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, 'recovery.json'), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  await writeFile(env.GITHUB_OUTPUT, formatRecoveryOutputs(receipt), { flag: 'a', mode: 0o600 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Topology recovery provenance validation failed.\n');
    process.exitCode = 1;
  });
}

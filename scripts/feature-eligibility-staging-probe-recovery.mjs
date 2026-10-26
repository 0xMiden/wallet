import { isDeepStrictEqual } from 'node:util';
import { chmod, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildProbeManifest,
  createLocalProbeEffects,
  createProbeController
} from './feature-eligibility-staging-probe.mjs';

const WORKFLOW = '.github/workflows/probe-feature-eligibility.yml';
const REPOSITORY = '0xMiden/wallet';
const STATES = ['prepared', 'deploying', 'deployed', 'uncertain', 'cleaned', 'cleanup_blocked'];
const REASONS = [
  'complete',
  'deploy_rejected',
  'auth',
  'quota',
  'network',
  'no_refusal',
  'invalid_response',
  'ownership_mismatch',
  'cleanup_failed',
  'inventory_incomplete',
  'bounds_reached'
];
const blocked = () => ({
  support: 'unknown',
  caller: 'unknown',
  colo: 'unknown',
  cleanup: 'blocked',
  counts: { requests: 0, allowed: 0, limited: 0, unavailable: 0 },
  reason: 'ownership_mismatch'
});
const requireValue = value => {
  if (!value) throw new Error('Recovery provenance blocked');
};
const keys = (value, expected) => value && isDeepStrictEqual(Object.keys(value).sort(), expected.sort());
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,17}$/.test(value);
const attempt = value => typeof value === 'string' && /^[1-9][0-9]{0,5}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const contextIdentity = context =>
  Object.fromEntries(
    ['repository', 'workflowPath', 'runId', 'runAttempt', 'sourceSha'].map(key => [key, context[key]])
  );
function trusted(context) {
  return (
    context?.repository === REPOSITORY &&
    context.workflowPath === WORKFLOW &&
    context.ref === 'refs/heads/main' &&
    context.eventName === 'workflow_dispatch' &&
    id(context.runId) &&
    attempt(context.runAttempt) &&
    sha(context.sourceSha)
  );
}
function validateManifest(manifest, workerBytes) {
  requireValue(STATES.includes(manifest?.deploymentState));
  const expected = buildProbeManifest(manifest.identity, workerBytes, []);
  expected.deploymentState = manifest.deploymentState;
  requireValue(isDeepStrictEqual(manifest, expected));
}

/** Verify GitHub provenance before a separate credential step can compose cleanup. */
export async function prepareRecovery(input, effects) {
  requireValue(
    trusted(effects.context) && keys(input, ['runId', 'runAttempt']) && id(input.runId) && attempt(input.runAttempt)
  );
  requireValue(input.runId !== effects.context.runId);
  const run = await effects.github(`/actions/runs/${input.runId}`);
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
      run.run_attempt >= prior.run_attempt &&
      run.head_sha === prior.head_sha &&
      run.workflow_id === prior.workflow_id &&
      run.repository.id === prior.repository.id
  );
  const workflow = await effects.github(`/actions/workflows/${prior.workflow_id}`);
  requireValue(workflow?.id === prior.workflow_id && workflow.path === WORKFLOW);
  const artifacts = [];
  let total;
  for (let page = 1; ; page++) {
    requireValue(page <= 10);
    const listing = await effects.github(`/actions/runs/${input.runId}/artifacts?per_page=100&page=${page}`);
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
  requireValue(new Set(artifacts.map(value => value.id)).size === artifacts.length);
  const matches = artifacts.filter(value => value.name === `eligibility-probe-${input.runId}-${input.runAttempt}`);
  requireValue(matches.length === 1);
  const artifact = matches[0];
  const provenance = artifact.workflow_run;
  requireValue(
    Number.isSafeInteger(artifact.id) &&
      artifact.id > 0 &&
      artifact.expired === false &&
      Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= 65536 &&
      provenance?.id === prior.id &&
      provenance.repository_id === prior.repository.id &&
      provenance.head_repository_id === prior.repository.id &&
      provenance.head_branch === 'main' &&
      provenance.head_sha === prior.head_sha
  );
  const source = await effects.github(`/contents/services/feature-eligibility/staging-probe.mjs?ref=${prior.head_sha}`);
  requireValue(
    source?.type === 'file' &&
      source.encoding === 'base64' &&
      typeof source.content === 'string' &&
      source.content.length <= 350000 &&
      /^[a-zA-Z0-9+/=\n\r]+$/.test(source.content)
  );
  const workerBytes = Buffer.from(source.content, 'base64');
  requireValue(workerBytes.length > 0 && workerBytes.length <= 256 * 1024);
  return {
    identity: {
      repository: REPOSITORY,
      workflowPath: WORKFLOW,
      runId: input.runId,
      runAttempt: input.runAttempt,
      sourceSha: prior.head_sha
    },
    artifactId: String(artifact.id),
    workerBase64: workerBytes.toString('base64')
  };
}

/** Preserve current context and reuse authenticated content/owner checks for the prior source. */
export async function cleanupRecovery(prepared, manifest, effects, controllerFactory = createProbeController) {
  try {
    requireValue(
      trusted(effects.context) &&
        keys(prepared, ['identity', 'artifactId', 'workerBase64']) &&
        id(prepared.artifactId) &&
        typeof prepared.workerBase64 === 'string'
    );
    const workerBytes = Buffer.from(prepared.workerBase64, 'base64');
    requireValue(
      isDeepStrictEqual(prepared.identity, manifest?.identity) && prepared.identity.runId !== effects.context.runId
    );
    validateManifest(manifest, workerBytes);
    return await controllerFactory({
      ...effects,
      workerBytes,
      verifyRecovery: async identity => isDeepStrictEqual(identity, prepared.identity)
    }).cleanup(manifest);
  } catch {
    return { cleanup: 'blocked', reason: 'ownership_mismatch' };
  }
}

/** Reject unknown fields instead of copying raw objects into an artifact. */
export function sanitizeEvidence(manifest, result, workerBytes) {
  if (manifest !== null) validateManifest(manifest, workerBytes);
  requireValue(
    keys(result, ['support', 'caller', 'colo', 'cleanup', 'counts', 'reason']) &&
      ['supported', 'unknown'].includes(result.support) &&
      ['refused', 'unknown'].includes(result.caller) &&
      ['refused', 'unknown'].includes(result.colo) &&
      ['absent', 'removed', 'blocked'].includes(result.cleanup) &&
      REASONS.includes(result.reason)
  );
  requireValue(
    keys(result.counts, ['requests', 'allowed', 'limited', 'unavailable']) &&
      Object.values(result.counts).every(value => Number.isSafeInteger(value) && value >= 0 && value <= 120) &&
      result.counts.requests <= 120 &&
      result.counts.allowed + result.counts.limited + result.counts.unavailable <= result.counts.requests
  );
  requireValue(
    result.support !== 'supported' ||
      (manifest !== null &&
        result.caller === 'refused' &&
        result.colo === 'refused' &&
        result.cleanup !== 'blocked' &&
        result.reason === 'complete')
  );
  return { manifest: manifest === null ? null : structuredClone(manifest), result: structuredClone(result) };
}

async function readJson(path) {
  const bytes = await readFile(path);
  requireValue(bytes.length <= 65536);
  return JSON.parse(bytes.toString('utf8'));
}
async function privateWrite(path, value) {
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await chmod(path, 0o600);
}
async function github(path, env) {
  requireValue(env.GH_TOKEN && path.startsWith('/'));
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    redirect: 'error',
    signal: AbortSignal.timeout(15000)
  });
  requireValue(response.ok);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      requireValue(size <= 2 * 1024 * 1024);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function main(args, env = process.env) {
  let result = blocked();
  requireValue(args.length === 1 && ['prepare', 'cleanup', 'evidence'].includes(args[0]) && env.RUNNER_TEMP);
  const effects = createLocalProbeEffects(env);
  requireValue(trusted(effects.context));
  const root = env.RUNNER_TEMP;
  const preparation = join(root, 'probe-recovery.json');
  if (args[0] === 'prepare') {
    const prepared = await prepareRecovery(
      { runId: env.CLEANUP_RUN_ID, runAttempt: env.CLEANUP_ATTEMPT },
      { context: effects.context, github: path => github(path, env) }
    );
    await privateWrite(preparation, prepared);
    requireValue(env.GITHUB_OUTPUT);
    await writeFile(env.GITHUB_OUTPUT, `artifact_id=${prepared.artifactId}\n`, { flag: 'a', mode: 0o600 });
    return { prepared: true };
  }
  if (args[0] === 'cleanup') {
    requireValue(/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID || '') && env.CLOUDFLARE_API_TOKEN);
    try {
      const prepared = await readJson(preparation);
      const files = await readdir(join(root, 'probe-recovered'));
      requireValue(isDeepStrictEqual(files.sort(), ['manifest.json', 'result.json']));
      const manifest = await readJson(join(root, 'probe-recovered/manifest.json'));
      sanitizeEvidence(
        manifest,
        await readJson(join(root, 'probe-recovered/result.json')),
        Buffer.from(prepared.workerBase64, 'base64')
      );
      const outcome = await cleanupRecovery(prepared, manifest, effects);
      result = { ...blocked(), ...outcome };
    } catch {
      result = blocked();
    }
    await privateWrite(join(root, 'probe-result.json'), result);
    return result;
  }
  let manifest = null;
  let workerBytes = await readFile(new URL('../services/feature-eligibility/staging-probe.mjs', import.meta.url));
  try {
    try {
      if (env.PROBE_OPERATION === 'probe') {
        try {
          manifest = await readJson(join(root, 'feature-eligibility-probe/manifest.json'));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (manifest) requireValue(isDeepStrictEqual(manifest.identity, contextIdentity(effects.context)));
      } else {
        requireValue(env.PROBE_OPERATION === 'cleanup');
        const prepared = await readJson(preparation);
        workerBytes = Buffer.from(prepared.workerBase64, 'base64');
        manifest = await readJson(join(root, 'probe-recovered/manifest.json'));
        requireValue(isDeepStrictEqual(manifest.identity, prepared.identity));
      }
      if (manifest) validateManifest(manifest, workerBytes);
    } catch {
      manifest = null;
    }
    try {
      result = await readJson(join(root, 'probe-result.json'));
      sanitizeEvidence(manifest, result, workerBytes);
    } catch {
      result = { ...blocked(), reason: 'invalid_response' };
    }
    if (env.PROBE_OPERATION === 'probe') {
      try {
        const cleanup = await readJson(join(root, 'probe-cleanup-result.json'));
        sanitizeEvidence(null, cleanup, workerBytes);
        requireValue(cleanup.reason === 'complete' && cleanup.cleanup !== 'blocked');
        result = { ...result, cleanup: cleanup.cleanup };
      } catch {
        result = { ...result, support: 'unknown', cleanup: 'blocked', reason: 'cleanup_failed' };
      }
    }
    const sanitized = sanitizeEvidence(manifest, result, workerBytes);
    const directory = join(root, 'probe-evidence');
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
    if (sanitized.manifest) await privateWrite(join(directory, 'manifest.json'), sanitized.manifest);
    await privateWrite(join(directory, 'result.json'), sanitized.result);
    return sanitized.result;
  } finally {
    for (const path of [
      'feature-eligibility-probe/secrets.json',
      'feature-eligibility-probe/wrangler.json',
      'feature-eligibility-probe/deploy.stdout',
      'feature-eligibility-probe/deploy.stderr',
      'probe-recovery.json'
    ]) {
      try {
        await unlink(join(root, path));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then(result => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode =
        result.prepared === true ||
        result.support === 'supported' ||
        (process.env.PROBE_OPERATION === 'cleanup' && result.cleanup !== 'blocked' && result.reason === 'complete')
          ? 0
          : 1;
    })
    .catch(() => {
      process.stdout.write(`${JSON.stringify(blocked())}\n`);
      process.exitCode = 1;
    });
}

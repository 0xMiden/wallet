import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTopologyReadApi, createTopologyScriptDeleter } from '../services/feature-eligibility/staging-topology-api.mjs';
import {
  cleanupTopologyWorker,
  createTopologyApiBudget,
  observeTopologyOwnership,
  observeTopologyWorkerUrl,
  prepareTopologyInventory
} from '../services/feature-eligibility/staging-topology-preflight.mjs';
import { verifyTopologyManifest } from '../services/feature-eligibility/staging-topology-manifest.mjs';
import { TOPOLOGY_SCENARIOS } from '../services/feature-eligibility/staging-topology.mjs';

const WORKFLOW = '.github/workflows/feature-eligibility-topology.yml';
const SOURCE = 'services/feature-eligibility/staging-topology-worker.mjs';
const PREPARED = 'eligibility-topology-prepared';
const RESULT = 'eligibility-topology-result';
const RUN_WINDOW_MS = 8 * 60_000;
const SCENARIO_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 1_024;
const MAX_BUNDLE_BYTES = 10_000_000;
const MAX_PHASE_READS = 250;
const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;

const hash = value => createHash('sha256').update(value).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));

function fail(reason) {
  throw Object.assign(new Error(reason), { reason });
}

export function topologyIdentity(context) {
  if (
    !context ||
    context.repository !== '0xMiden/wallet' ||
    context.workflowPath !== WORKFLOW ||
    context.ref !== 'refs/heads/main' ||
    context.eventName !== 'workflow_dispatch' ||
    typeof context.runId !== 'string' ||
    !/^[1-9][0-9]{0,17}$/.test(context.runId) ||
    typeof context.runAttempt !== 'string' ||
    !/^[1-9][0-9]{0,5}$/.test(context.runAttempt) ||
    typeof context.sourceSha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(context.sourceSha)
  )
    fail('untrusted_workflow_context');
  return Object.freeze({
    repository: context.repository,
    workflowPath: context.workflowPath,
    runId: context.runId,
    runAttempt: context.runAttempt,
    sourceSha: context.sourceSha
  });
}

export function topologyRecoveryIdentity({ recovery, previous, selectedRunId, selectedRunAttempt } = {}) {
  if (
    recovery?.schema !== 1 ||
    recovery.runId !== selectedRunId ||
    recovery.runAttempt !== selectedRunAttempt ||
    typeof selectedRunId !== 'string' ||
    !/^[1-9][0-9]{0,17}$/.test(selectedRunId) ||
    typeof selectedRunAttempt !== 'string' ||
    !/^[1-9][0-9]{0,5}$/.test(selectedRunAttempt)
  )
    fail('recovery_identity_mismatch');
  if (recovery.resultArtifactId === null && previous !== undefined && previous !== null)
    fail('recovery_identity_mismatch');
  const identity = recovery.resultArtifactId === null ? recovery : previous?.identity;
  let validated;
  try {
    validated = topologyIdentity({
      repository: identity?.repository,
      workflowPath: identity?.workflowPath,
      ref: 'refs/heads/main',
      eventName: 'workflow_dispatch',
      runId: identity?.runId,
      runAttempt: identity?.runAttempt,
      sourceSha: identity?.sourceSha
    });
  } catch {
    fail('recovery_identity_mismatch');
  }
  if (recovery.resultArtifactId !== null && !same(identity, validated)) fail('recovery_identity_mismatch');
  return validated;
}

function currentIdentity(env) {
  return topologyIdentity({
    repository: env.GITHUB_REPOSITORY,
    workflowPath: WORKFLOW,
    ref: env.GITHUB_REF,
    eventName: env.GITHUB_EVENT_NAME,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    sourceSha: env.GITHUB_SHA
  });
}

export function findTopologyBundle({ metafile, bundleDirectory, sourceFile, cwd = process.cwd() } = {}) {
  if (
    !exactKeys(metafile, ['inputs', 'outputs']) ||
    !metafile.outputs ||
    typeof metafile.outputs !== 'object' ||
    Array.isArray(metafile.outputs) ||
    typeof bundleDirectory !== 'string' ||
    typeof sourceFile !== 'string'
  )
    fail('invalid_bundle_metadata');
  const expectedSource = path.resolve(cwd, sourceFile);
  const candidates = Object.entries(metafile.outputs).filter(([, output]) => {
    if (!output || typeof output.entryPoint !== 'string' || !Array.isArray(output.imports)) return false;
    return path.resolve(cwd, output.entryPoint) === expectedSource;
  });
  if (candidates.length !== 1 || candidates[0][1].imports.length !== 0) fail('invalid_bundle_entrypoint');
  const [outputPath] = candidates[0];
  const outputDirectory = path.resolve(bundleDirectory);
  const absolute = path.isAbsolute(outputPath) ? path.resolve(outputPath) : path.resolve(cwd, outputPath);
  const relative = path.relative(outputDirectory, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('bundle_outside_directory');
  return absolute;
}

async function readBuiltBundle(env) {
  const bundleDirectory = env.TOPOLOGY_BUNDLE_DIRECTORY;
  const metafilePath = env.TOPOLOGY_BUNDLE_METAFILE;
  if (typeof bundleDirectory !== 'string' || typeof metafilePath !== 'string') fail('missing_bundle_paths');
  const metafile = JSON.parse(await readFile(metafilePath, 'utf8'));
  const outputPath = findTopologyBundle({ metafile, bundleDirectory, sourceFile: SOURCE, cwd: env.GITHUB_WORKSPACE });
  const entry = await lstat(outputPath);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 1 || entry.size > MAX_BUNDLE_BYTES)
    fail('invalid_bundle_file');
  return new Uint8Array(await readFile(outputPath));
}

function preparedPaths(env) {
  const root = env.RUNNER_TEMP;
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('missing_runner_temp');
  const directory = path.join(root, PREPARED);
  return {
    directory,
    manifest: path.join(directory, 'prepared.json'),
    bundle: path.join(directory, 'staging-topology-worker.mjs'),
    state: path.join(directory, 'run-state.json'),
    config: path.join(directory, 'wrangler.json'),
    secrets: path.join(directory, 'secrets.json')
  };
}

function resultPath(env) {
  const root = env.RUNNER_TEMP;
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('missing_runner_temp');
  return path.join(root, RESULT, 'result.json');
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

async function writeResult(env, value) {
  await writeJson(resultPath(env), value);
}

function accountCredentials(env) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId) || typeof token !== 'string' || token.length < 20 || token.length > 512)
    fail('cloudflare_credentials_unavailable');
  return { accountId, token, accountSha256: hash(accountId) };
}

function validatePrepared(value, { identity, accountSha256, bundle } = {}) {
  if (
    !exactKeys(value, ['schema', 'identity', 'accountSha256', 'startedAt', 'preflightCalls', 'expiresAt', 'maxRuns', 'manifest']) ||
    value.schema !== 1 ||
    !same(value.identity, identity) ||
    value.accountSha256 !== accountSha256 ||
    !SHA256.test(value.accountSha256) ||
    !Number.isSafeInteger(value.startedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt !== value.startedAt + RUN_WINDOW_MS ||
    !Number.isSafeInteger(value.preflightCalls) ||
    value.preflightCalls < 1 ||
    value.preflightCalls > 250 ||
    value.maxRuns !== TOPOLOGY_SCENARIOS.length ||
    !verifyTopologyManifest(value.manifest, {
      identity,
      bundle,
      now: value.startedAt,
      expiresAt: value.expiresAt,
      maxRuns: value.maxRuns,
      inventory: []
    })
  )
    fail('prepared_artifact_mismatch');
  return value;
}

function validProviderReads(value, preflightStartedAt) {
  return (
    exactKeys(value, [
      'preflight',
      'cleanup',
      'total',
      'elapsedMs',
      'preflightStartedAt',
      'preflightDeadlineAt',
      'cleanupStartedAt',
      'cleanupDeadlineAt',
      'preflightElapsedMs',
      'cleanupElapsedMs'
    ]) &&
    Number.isSafeInteger(value.preflight) && value.preflight >= 0 && value.preflight <= 250 &&
    Number.isSafeInteger(value.cleanup) && value.cleanup >= 0 && value.cleanup <= 250 &&
    value.total === value.preflight + value.cleanup && value.total <= 500 &&
    Number.isSafeInteger(value.elapsedMs) &&
    value.elapsedMs >= 0 &&
    value.preflightStartedAt === preflightStartedAt &&
    value.preflightDeadlineAt === preflightStartedAt + 120_000 &&
    value.preflightElapsedMs === value.elapsedMs &&
    ((value.cleanupStartedAt === null && value.cleanupDeadlineAt === null && value.cleanupElapsedMs === null) ||
      (Number.isSafeInteger(value.cleanupStartedAt) &&
        value.cleanupStartedAt >= preflightStartedAt &&
        value.cleanupDeadlineAt === value.cleanupStartedAt + 120_000 &&
        Number.isSafeInteger(value.cleanupElapsedMs) &&
        value.cleanupElapsedMs >= 0 &&
        value.cleanupElapsedMs <= value.elapsedMs))
  );
}

export function topologyCleanupBudget({
  state,
  previousReads,
  preflightStartedAt,
  allowPreparedFallback = false,
  now = Date.now
} = {}) {
  const prior = validProviderReads(previousReads, preflightStartedAt) ? previousReads : null;
  if (!state && !prior) {
    if (!allowPreparedFallback || !Number.isSafeInteger(preflightStartedAt)) fail('cleanup_budget_lineage_unavailable');
    return {
      cleanupStartedAt: Math.max(preflightStartedAt, now()),
      initialCalls: {
        preflight: MAX_PHASE_READS,
        cleanup: 0
      }
    };
  }
  const stateCleanupStart = Number.isSafeInteger(state?.cleanupStartedAt) ? state.cleanupStartedAt : null;
  const priorCleanupStart = Number.isSafeInteger(prior?.cleanupStartedAt) ? prior.cleanupStartedAt : null;
  const cleanupStarts = [stateCleanupStart, priorCleanupStart].filter(Number.isSafeInteger);
  return {
    cleanupStartedAt: cleanupStarts.length ? Math.min(...cleanupStarts) : now(),
    initialCalls: {
      preflight: Math.max(state?.preflightCalls ?? 0, prior?.preflight ?? 0),
      cleanup: Math.max(state?.cleanupCalls ?? 0, prior?.cleanup ?? 0)
    }
  };
}

async function loadPrepared(env, { identity, accountSha256 } = {}) {
  const paths = preparedPaths(env);
  const value = JSON.parse(await readFile(paths.manifest, 'utf8'));
  const bundle = new Uint8Array(await readFile(paths.bundle));
  return { paths, value: validatePrepared(value, { identity, accountSha256, bundle }), bundle };
}

async function readRecoveryReceipt(env, { requireNullResult = false } = {}) {
  const recoveryFile = env.TOPOLOGY_RECOVERY_FILE;
  if (typeof recoveryFile !== 'string') fail('missing_recovery_receipt');
  const recovery = JSON.parse(await readFile(recoveryFile, 'utf8'));
  if (!exactKeys(recovery, ['schema', 'repository', 'workflowPath', 'runId', 'runAttempt', 'sourceSha', 'artifactId', 'resultArtifactId']))
    fail('invalid_recovery_receipt');
  if (requireNullResult && recovery.resultArtifactId !== null) fail('invalid_recovery_receipt');
  const priorPath = env.TOPOLOGY_PRIOR_RESULT_FILE;
  let previous = {};
  let identity;
  if (recovery.resultArtifactId === null) {
    if (typeof priorPath === 'string' && priorPath.length > 0) fail('invalid_recovery_receipt');
    identity = topologyRecoveryIdentity({
      recovery,
      selectedRunId: env.CLEANUP_RUN_ID,
      selectedRunAttempt: env.CLEANUP_ATTEMPT
    });
  } else {
    if (typeof recovery.resultArtifactId !== 'string' || !/^[1-9][0-9]{0,17}$/.test(recovery.resultArtifactId))
      fail('invalid_recovery_receipt');
    if (typeof priorPath !== 'string' || priorPath.length === 0) fail('missing_prior_topology_result');
    previous = JSON.parse(await readFile(priorPath, 'utf8'));
    identity = topologyRecoveryIdentity({
      recovery,
      previous,
      selectedRunId: env.CLEANUP_RUN_ID,
      selectedRunAttempt: env.CLEANUP_ATTEMPT
    });
  }
  if (
    recovery.repository !== identity.repository ||
    recovery.workflowPath !== identity.workflowPath ||
    typeof recovery.sourceSha !== 'string' ||
    recovery.sourceSha !== identity.sourceSha ||
    !/^[a-f0-9]{40}$/.test(recovery.sourceSha) ||
    !/^[1-9][0-9]{0,17}$/.test(String(recovery.artifactId))
  )
    fail('invalid_recovery_receipt');
  return { recovery, identity, previous };
}

async function readValidRunState(statePath, { identity, accountSha256, startedAt, preflightCalls }) {
  try {
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    if (
      exactKeys(saved, [
        'schema',
        'identity',
        'accountSha256',
        'startedAt',
        'preflightCalls',
        'cleanupCalls',
        'cleanupStartedAt',
        'cleanupDeadlineAt',
        'deploymentAttempted',
        'deploymentExitCode',
        'phase'
      ]) &&
      saved.schema === 1 &&
      same(saved.identity, identity) &&
      saved.accountSha256 === accountSha256 &&
      saved.startedAt === startedAt &&
      Number.isSafeInteger(saved.preflightCalls) &&
      saved.preflightCalls >= preflightCalls &&
      saved.preflightCalls <= 250 &&
      Number.isSafeInteger(saved.cleanupCalls) &&
      saved.cleanupCalls >= 0 &&
      saved.cleanupCalls <= 250 &&
      ((saved.cleanupStartedAt === null && saved.cleanupDeadlineAt === null && saved.cleanupCalls === 0) ||
        (Number.isSafeInteger(saved.cleanupStartedAt) &&
          saved.cleanupDeadlineAt === saved.cleanupStartedAt + 120_000)) &&
      typeof saved.deploymentAttempted === 'boolean'
    )
      return saved;
  } catch {
  }
  return undefined;
}

function buildFallbackProviderReads(startedAt, state) {
  const hasCleanupWindow =
    Number.isSafeInteger(state?.cleanupStartedAt) && state.cleanupStartedAt >= startedAt;
  const nowMs = Math.max(Date.now(), startedAt, hasCleanupWindow ? state.cleanupStartedAt : startedAt);
  const preflightElapsedMs = nowMs - startedAt;
  const cleanup = state?.cleanupCalls ?? 0;
  const providerReads = {
    preflight: MAX_PHASE_READS,
    cleanup,
    total: MAX_PHASE_READS + cleanup,
    elapsedMs: preflightElapsedMs,
    preflightStartedAt: startedAt,
    preflightDeadlineAt: startedAt + 120_000,
    cleanupStartedAt: hasCleanupWindow ? state.cleanupStartedAt : null,
    cleanupDeadlineAt: hasCleanupWindow ? state.cleanupStartedAt + 120_000 : null,
    preflightElapsedMs,
    cleanupElapsedMs: hasCleanupWindow ? nowMs - state.cleanupStartedAt : null
  };
  if (!validProviderReads(providerReads, startedAt)) fail('cleanup_budget_lineage_unavailable');
  return providerReads;
}

async function buildNullResultRecoveryFallback(env) {
  const { identity } = await readRecoveryReceipt(env, { requireNullResult: true });
  const paths = preparedPaths(env);
  const rawPrepared = JSON.parse(await readFile(paths.manifest, 'utf8'));
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const expectedAccountSha256 =
    typeof accountId === 'string' && ACCOUNT_ID.test(accountId) ? hash(accountId) : rawPrepared?.accountSha256;
  if (typeof expectedAccountSha256 !== 'string' || !SHA256.test(expectedAccountSha256)) {
    fail('prepared_artifact_mismatch');
  }
  const loaded = await loadPrepared(env, { identity, accountSha256: expectedAccountSha256 });
  const state = await readValidRunState(loaded.paths.state, {
    identity,
    accountSha256: loaded.value.accountSha256,
    startedAt: loaded.value.startedAt,
    preflightCalls: loaded.value.preflightCalls
  });
  return {
    schema: 1,
    identity,
    phase: 'recovery_cleanup',
    manifestSha256: hash(JSON.stringify(loaded.value.manifest)),
    bundleSha256: loaded.value.manifest.bundleSha256,
    deploymentAttempted: state?.deploymentAttempted ?? 'unknown',
    cleanup: 'blocked',
    reason: 'cleanup_failed',
    providerReads: buildFallbackProviderReads(loaded.value.startedAt, state)
  };
}

async function writeRunState(file, value) {
  await writeJson(file, value);
}

async function readBoundedJson(response, signal) {
  if (!response.body) return null;
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) return null;
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) return null;
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function exerciseTopologyScenarios({ baseUrl, bearer, fetchImpl = fetch, timeoutMs = SCENARIO_TIMEOUT_MS } = {}) {
  if (
    typeof baseUrl !== 'string' ||
    !/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(baseUrl) ||
    typeof bearer !== 'string' ||
    bearer.length < 32 ||
    bearer.length > 128 ||
    typeof fetchImpl !== 'function' ||
    timeoutMs !== SCENARIO_TIMEOUT_MS
  )
    fail('invalid_scenario_request');
  const results = [];
  for (const scenario of TOPOLOGY_SCENARIOS) {
    const controller = new AbortController();
    let timer;
    try {
      const responseAndBody = (async () => {
        const response = await fetchImpl(`${baseUrl}/scenario/${scenario}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}` },
          signal: controller.signal
        });
        return { response, body: await readBoundedJson(response, controller.signal) };
      })();
      const { response, body } = await Promise.race([
        responseAndBody,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('scenario_timeout'));
          }, timeoutMs);
        })
      ]);
      const valid =
        response.status === 200 &&
        exactKeys(body, ['scenario', 'status']) &&
        body.scenario === scenario &&
        body.status === 'passed';
      results.push({ scenario, result: valid ? 'passed' : 'failed' });
      if (controller.signal.aborted) break;
    } catch {
      results.push({ scenario, result: 'unavailable' });
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  return Object.freeze(results);
}

async function command(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

async function prepare(env) {
  const identity = currentIdentity(env);
  const { accountId, token, accountSha256 } = accountCredentials(env);
  const bundle = await readBuiltBundle(env);
  const startedAt = Date.now();
  const expiresAt = startedAt + RUN_WINDOW_MS;
  const api = createTopologyReadApi({ accountId, token, now: Date.now, startedAt });
  const budget = createTopologyApiBudget(api, { now: Date.now, startedAt });
  const prepared = await prepareTopologyInventory({
    api: budget.preflight,
    accountId,
    identity,
    bundle,
    now: startedAt,
    expiresAt,
    maxRuns: TOPOLOGY_SCENARIOS.length
  });
  if (!prepared || prepared.status !== 'inventory_observed' || prepared.deploymentAuthorized !== false)
    fail('inventory_preflight_failed');
  const stats = budget.stats();
  if (stats.total > 250 || stats.cleanup !== 0) fail('preflight_read_limit');
  const paths = preparedPaths(env);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await writeFile(paths.bundle, bundle, { mode: 0o600 });
  await chmod(paths.bundle, 0o600);
  const bundleCopy = new Uint8Array(await readFile(paths.bundle));
  const value = validatePrepared({
    schema: 1,
    identity,
    accountSha256,
    startedAt,
    preflightCalls: stats.preflight,
    expiresAt,
    maxRuns: TOPOLOGY_SCENARIOS.length,
    manifest: prepared.manifest
  }, { identity, accountSha256, bundle: bundleCopy });
  await writeJson(paths.manifest, value);
  await writeResult(env, {
    schema: 1,
    identity,
    phase: 'prepared',
    manifestSha256: hash(JSON.stringify(prepared.manifest)),
    bundleSha256: prepared.manifest.bundleSha256,
    providerReads: stats,
    deploymentAttempted: false,
    cleanup: 'not_attempted',
    reason: 'prepared'
  });
  return 0;
}

function targetAbsent(value) {
  return (
    value?.status === 404 &&
    value.body?.success === false &&
    Array.isArray(value.body.errors) &&
    value.body.errors.length === 1 &&
    value.body.errors[0]?.code === 10007 &&
    Reflect.ownKeys(value.body).length === 2 &&
    Reflect.ownKeys(value.body.errors[0]).length === 1
  );
}

export async function execute(env, { createReadApi = createTopologyReadApi, runCommand = command } = {}) {
  const identity = currentIdentity(env);
  const { accountId, token, accountSha256 } = accountCredentials(env);
  const { paths, value, bundle } = await loadPrepared(env, { identity, accountSha256 });
  const state = {
    schema: 1,
    identity,
    accountSha256,
    startedAt: value.startedAt,
    preflightCalls: value.preflightCalls,
    cleanupCalls: 0,
    cleanupStartedAt: null,
    cleanupDeadlineAt: null,
    deploymentAttempted: false,
    deploymentExitCode: null,
    phase: 'ready'
  };
  const persist = () => writeRunState(paths.state, state);
  let syncResult = async () => {};
  const api = createReadApi({ accountId, token, now: Date.now, startedAt: value.startedAt });
  const budget = createTopologyApiBudget(api, {
    now: Date.now,
    startedAt: value.startedAt,
    initialCalls: { preflight: value.preflightCalls, cleanup: 0 },
    onRequest: async stats => {
      state.preflightCalls = stats.preflight;
      state.cleanupCalls = stats.cleanup;
      await persist();
      await syncResult(stats);
    }
  });
  const result = {
    schema: 1,
    identity,
    phase: 'execution',
    manifestSha256: hash(JSON.stringify(value.manifest)),
    bundleSha256: value.manifest.bundleSha256,
    deploymentAttempted: false,
    deploymentExitCode: null,
    ownership: 'not_observed',
    scenarioResults: [],
    cleanup: 'pending',
    reason: 'execution_failed'
  };
  syncResult = stats => writeResult(env, { ...result, providerReads: stats });
  try {
    if (!targetAbsent(await budget.preflight(`/workers/scripts/${value.manifest.scriptName}/settings`)))
      fail('target_not_absent');
    const deploymentDirectory = path.join(paths.directory, 'deploy');
    await mkdir(deploymentDirectory, { recursive: true, mode: 0o700 });
    const workerFile = path.join(deploymentDirectory, 'staging-topology-worker.mjs');
    const configFile = path.join(deploymentDirectory, 'wrangler.json');
    await writeFile(workerFile, bundle, { mode: 0o600 });
    await writeJson(configFile, value.manifest.config);
    const bearer = randomBytes(32).toString('base64url');
    await writeJson(paths.secrets, { TOPOLOGY_BEARER: bearer });
    await chmod(paths.secrets, 0o600);
    state.deploymentAttempted = true;
    state.phase = 'deploying';
    result.deploymentAttempted = true;
    await persist();
    await syncResult(budget.stats());
    const deployed = await runCommand(
      'npx',
      [
        '--yes',
        'wrangler@4.151.3',
        'deploy',
        '--config',
        configFile,
        '--no-bundle',
        '--secrets-file',
        paths.secrets,
        '--strict'
      ],
      { cwd: deploymentDirectory, env: { ...env, WRANGLER_SEND_METRICS: 'false' } }
    );
    state.deploymentExitCode = deployed.code;
    result.deploymentExitCode = deployed.code;
    await persist();
    if (deployed.code !== 0) fail('deployment_failed');
    state.phase = 'deployed';
    await persist();
    const ownership = await observeTopologyOwnership({
      api: budget.preflight,
      accountId,
      manifest: value.manifest,
      options: {
        identity,
        bundle,
        now: value.startedAt,
        expiresAt: value.expiresAt,
        maxRuns: value.maxRuns,
        inventory: []
      },
      onMismatch: value => {
        result.ownershipDiagnostic = { gate: value.gate, form: value.form };
      }
    });
    if (ownership?.status !== 'observed') fail('deployed_worker_ownership_not_verified');
    const deployedRoute = await observeTopologyWorkerUrl({ api: budget.preflight, scriptName: value.manifest.scriptName });
    if (deployedRoute?.status !== 'observed') fail('deployed_worker_route_not_verified');
    result.ownership = 'verified';
    state.phase = 'exercising';
    await persist();
    result.scenarioResults = await exerciseTopologyScenarios({ baseUrl: deployedRoute.url, bearer });
    result.reason =
      result.scenarioResults.length === TOPOLOGY_SCENARIOS.length &&
      result.scenarioResults.every(item => item.result === 'passed')
        ? 'complete'
        : 'scenario_failed';
    state.phase = 'exercised';
  } catch (error) {
    result.reason = ['target_not_absent', 'worker_url_not_ready', 'deployment_failed', 'deployed_worker_ownership_not_verified', 'deployed_worker_route_not_verified', 'scenario_failed'].includes(error?.reason)
      ? error.reason
      : 'execution_failed';
    state.phase = 'execution_stopped';
  } finally {
    const stats = budget.stats();
    state.preflightCalls = stats.preflight;
    state.cleanupCalls = stats.cleanup;
    result.providerReads = stats;
    await persist();
    await unlink(paths.secrets).catch(() => {});
    await rm(path.join(paths.directory, 'deploy'), { recursive: true, force: true }).catch(() => {});
    await writeResult(env, result);
  }
  return result.reason === 'complete' ? 0 : 1;
}

export async function cleanup(
  env,
  recovered = false,
  { createReadApi = createTopologyReadApi, createScriptDeleter = createTopologyScriptDeleter } = {}
) {
  const credentials = accountCredentials(env);
  let identity;
  let recovery;
  let previous = {};
  if (recovered) {
    ({ recovery, identity, previous } = await readRecoveryReceipt(env));
  } else identity = currentIdentity(env);

  const loaded = await loadPrepared(env, { identity, accountSha256: credentials.accountSha256 });
  const state = await readValidRunState(loaded.paths.state, {
    identity,
    accountSha256: credentials.accountSha256,
    startedAt: loaded.value.startedAt,
    preflightCalls: loaded.value.preflightCalls
  });
  if (recovered && recovery.resultArtifactId !== null) {
    if (
      previous?.schema !== 1 ||
      !same(previous.identity, identity) ||
      !validProviderReads(previous.providerReads, loaded.value.startedAt) ||
      previous.providerReads.preflight < loaded.value.preflightCalls
    )
      fail('prior_topology_budget_unavailable');
  } else if (!recovered) {
    try {
      const candidate = JSON.parse(await readFile(resultPath(env), 'utf8'));
      if (candidate?.schema === 1 && same(candidate.identity, identity)) previous = candidate;
    } catch {
    }
  }
  const { cleanupStartedAt, initialCalls } = topologyCleanupBudget({
    state,
    previousReads: previous.providerReads,
    preflightStartedAt: loaded.value.startedAt,
    allowPreparedFallback: recovered && recovery.resultArtifactId === null,
    now: Date.now
  });
  const api = createReadApi({
    accountId: credentials.accountId,
    token: credentials.token,
    now: Date.now,
    startedAt: loaded.value.startedAt,
    cleanupStartedAt
  });
  const buildCleanupResult = (stats, extra = {}) => {
    const base = { ...(previous ?? {}) };
    delete base.ownershipDiagnostic;
    return {
      ...base,
      schema: 1,
      identity,
      phase: recovered ? 'recovery_cleanup' : 'cleanup',
      manifestSha256: hash(JSON.stringify(loaded.value.manifest)),
      bundleSha256: loaded.value.manifest.bundleSha256,
      deploymentAttempted:
        state?.deploymentAttempted ?? (typeof previous?.deploymentAttempted === 'boolean' ? previous.deploymentAttempted : 'unknown'),
      cleanup: 'pending',
      reason: 'cleanup_in_progress',
      ...extra,
      providerReads: stats
    };
  };
  let writeCleanupResult = async () => {};
  const budget = createTopologyApiBudget(api, {
    now: Date.now,
    startedAt: loaded.value.startedAt,
    cleanupStartedAt,
    initialCalls,
    onRequest: async stats => {
      if (state) {
        state.cleanupCalls = stats.cleanup;
        state.cleanupStartedAt = stats.cleanupStartedAt;
        state.cleanupDeadlineAt = stats.cleanupDeadlineAt;
        await writeRunState(loaded.paths.state, state);
      }
      await writeCleanupResult(stats);
    }
  });
  writeCleanupResult = (stats, extra) => writeResult(env, buildCleanupResult(stats, extra));
  if (state) {
    state.cleanupStartedAt = cleanupStartedAt;
    state.cleanupDeadlineAt = cleanupStartedAt + 120_000;
    state.phase = 'cleanup';
    await writeRunState(loaded.paths.state, state);
  }
  const result = await cleanupTopologyWorker({
    api: budget.cleanup,
    deleteScript: createScriptDeleter(credentials),
    accountId: credentials.accountId,
    manifest: loaded.value.manifest,
    options: {
      identity,
      bundle: loaded.bundle,
      now: loaded.value.startedAt,
      expiresAt: loaded.value.expiresAt,
      maxRuns: loaded.value.maxRuns,
      inventory: []
    }
  });
  await writeCleanupResult(budget.stats(), {
    cleanup: result.cleanup,
    reason: result.reason,
    ...(result.ownershipDiagnostic ? { ownershipDiagnostic: result.ownershipDiagnostic } : {})
  });
  return result.cleanup === 'blocked' ? 1 : 0;
}

async function hasValidResultOnDisk(env) {
  try {
    const existing = JSON.parse(await readFile(resultPath(env), 'utf8'));
    return existing?.schema === 1 && existing.identity !== null && typeof existing.identity === 'object';
  } catch {
    return false;
  }
}

async function readValidPriorResult(env) {
  try {
    const priorPath = env.TOPOLOGY_PRIOR_RESULT_FILE;
    if (typeof priorPath !== 'string' || !priorPath.length) return null;
    const prior = JSON.parse(await readFile(priorPath, 'utf8'));
    return prior?.schema === 1 && prior.identity !== null && typeof prior.identity === 'object' ? prior : null;
  } catch {
    return null;
  }
}

async function main() {
  const operation = process.argv[2];
  if (operation === 'prepare') return await prepare(process.env);
  if (operation === 'execute') return await execute(process.env);
  if (operation === 'cleanup') return await cleanup(process.env);
  if (operation === 'cleanup-recovered') return await cleanup(process.env, true);
  fail('invalid_operation');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then(code => {
      process.exitCode = code;
    })
    .catch(async error => {
      const env = process.env;
      if (!(await hasValidResultOnDisk(env))) {
        const priorPath = env.TOPOLOGY_PRIOR_RESULT_FILE;
        const isRecoveredCli = process.argv[2] === 'cleanup-recovered';
        const prior = isRecoveredCli ? await readValidPriorResult(env) : null;
        const fallback =
          prior !== null
            ? {
                ...prior,
                phase: 'recovery_cleanup',
                cleanup: 'blocked',
                reason: 'cleanup_failed'
              }
            : isRecoveredCli && (typeof priorPath !== 'string' || priorPath.length === 0)
              ? await buildNullResultRecoveryFallback(env).catch(() => null)
              : null;
        await writeResult(
          env,
          fallback ?? {
            schema: 1,
            identity: null,
            phase: 'preparation',
            deploymentAttempted: false,
            cleanup: 'not_attempted',
            reason: ['untrusted_workflow_context', 'cloudflare_credentials_unavailable', 'inventory_preflight_failed'].includes(
              error?.reason
            )
              ? error.reason
              : 'preparation_failed'
          }
        ).catch(() => {});
      }
      process.exitCode = 1;
    });
}

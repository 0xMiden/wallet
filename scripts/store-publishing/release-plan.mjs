import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { loadPrivateJson } from './auth.mjs';
import { validateBuildRequest } from './create-receipt.mjs';
import { validatePublishRequest } from './publish-plan.mjs';
import { selectStoreTargets, STORE_TARGETS } from './targets.mjs';

const repository = '0xMiden/wallet';
const stages = ['build', 'status', 'prepare', 'begin-edit', 'upload', 'submit', 'release'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(value);
const validRunId = value => Number.isSafeInteger(value) && value > 0;
const operationKey = (stage, id) => `${stage}:${id}`;
const intentFields = intent => JSON.stringify({ targetId: intent.targetId, workflowPath: intent.workflowPath, inputs: {
  ...intent.inputs, request_token: undefined
} });

export function validateReleasePlan(plan, { stage, target = 'all' } = {}) {
  if (!object(plan) || plan.schemaVersion !== 1 || !object(plan.targets)) throw new Error('Invalid release plan');
  if (!stages.includes(stage)) throw new Error('An explicit release stage is required');
  if (['prepare', 'begin-edit'].includes(stage) && target === 'all')
    throw new Error('Preparation and edit creation require an individual target');
  const targets = selectStoreTargets(target);
  for (const [id, entry] of Object.entries(plan.targets)) {
    if (!STORE_TARGETS.some(value => value.id === id)) throw new Error('Unknown release plan target');
    if (!object(entry) || Object.keys(entry).some(key => !['producerRunId', 'stateRunId', 'editId', 'acknowledgement'].includes(key)))
      throw new Error('Unsupported target field or identity override');
  }
  return targets.map(store => {
    const entry = plan.targets[store.id] ?? {};
    const native = store.platform !== 'chrome';
    const common = {
      releaseTag: plan.releaseTag,
      sourceSha: plan.sourceSha,
      platform: store.platform,
      network: store.network,
      buildNumber: native ? plan.buildNumber : ''
    };
    const mutation = ['upload', 'submit', 'release'].includes(stage);
    const edits = store.platform === 'android' && ['upload', 'submit'].includes(stage);
    const request = stage === 'build' ? validateBuildRequest(common) : validatePublishRequest({
      ...common,
      action: stage,
      producerRunId: mutation ? entry.producerRunId : '',
      stateRunId: mutation ? entry.stateRunId : '',
      editId: edits ? entry.editId : '',
      acknowledgement: store.platform === 'android' && ['begin-edit', 'submit'].includes(stage) ? entry.acknowledgement : 'none'
    });
    const inputs = {
      release_tag: request.releaseTag,
      source_sha: request.sourceSha,
      platform: store.platform,
      network: store.network,
      build_number: request.buildNumber ?? ''
    };
    if (stage !== 'build') Object.assign(inputs, {
      action: stage,
      producer_run_id: request.producerRunId ?? '',
      state_run_id: request.stateRunId ?? '',
      edit_id: request.editId ?? '',
      acknowledgement: request.acknowledgement
    });
    return {
      targetId: store.id,
      workflowPath: `.github/workflows/${stage === 'build' ? 'build-store-artifacts' : 'publish-stores'}.yml`,
      inputs
    };
  });
}

export function matchDispatchedRun(runs, intent) {
  if (!Array.isArray(runs) || !validToken(intent.token)) throw new Error('Invalid dispatch correlation');
  const matches = runs.filter(run => run?.display_title === `Store request ${intent.token}`);
  if (matches.length !== 1) throw new Error('Cannot correlate exactly one trusted run; inspect uncertain dispatch');
  const run = matches[0];
  if (
    !validRunId(run.id) || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 ||
    run.path !== intent.workflowPath || run.event !== 'workflow_dispatch' || run.head_branch !== 'main' ||
    !/^[a-f0-9]{40}$/.test(run.head_sha ?? '') ||
    run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
  ) throw new Error('Correlated run is not from the trusted main workflow');
  return run;
}

function checkpointFor(plan, intents, stage, previous) {
  const checkpoint = previous === undefined ? {
    schemaVersion: 1, releaseTag: plan.releaseTag, sourceSha: plan.sourceSha.toLowerCase(), operations: {}
  } : structuredClone(previous);
  if (!object(checkpoint) || checkpoint.schemaVersion !== 1 || checkpoint.releaseTag !== plan.releaseTag ||
    checkpoint.sourceSha !== plan.sourceSha.toLowerCase() || !object(checkpoint.operations))
    throw new Error('Journal source or release does not match the plan');
  for (const intent of intents) {
    const saved = checkpoint.operations[operationKey(stage, intent.targetId)];
    if (!saved) continue;
    if (!object(saved) || !object(saved.intent) || !validToken(saved.intent.token) ||
      saved.intent.inputs?.request_token !== saved.intent.token || intentFields(saved.intent) !== intentFields(intent) ||
      !['dispatch-started', 'watching', 'success', 'failure'].includes(saved.status) ||
      (saved.status !== 'dispatch-started' && !validRunId(saved.runId)))
      throw new Error('Saved child intent or build does not match the plan');
  }
  return checkpoint;
}

export async function executeReleaseStage(plan, options = {}) {
  const { stage, target = 'all', save, dispatch, findRuns, watch, readRun, token = randomUUID } = options;
  const intents = validateReleasePlan(plan, { stage, target });
  const checkpoint = checkpointFor(plan, intents, stage, options.checkpoint);
  for (const name of ['save', 'dispatch', 'findRuns', 'watch', 'readRun'])
    if (typeof options[name] !== 'function') throw new Error(`Missing coordinator transport ${name}`);
  for (const selected of intents) {
    const key = operationKey(stage, selected.targetId);
    let operation = checkpoint.operations[key];
    if (operation?.status === 'failure') throw new Error(`Child run ${operation.runId} failed; inspection is required`);
    if (!operation) {
      const requestToken = token();
      if (!validToken(requestToken)) throw new Error('Invalid request correlation token');
      if (Object.values(checkpoint.operations).some(value => value.intent?.token === requestToken))
        throw new Error('Duplicate request correlation token');
      operation = { status: 'dispatch-started', intent: {
        ...selected, token: requestToken, inputs: { ...selected.inputs, request_token: requestToken }
      } };
      checkpoint.operations[key] = operation;
      // Persist uncertainty before sending; a restart must never repeat a possibly accepted dispatch.
      await save(checkpoint);
      await dispatch(operation.intent);
    }
    let run;
    if (operation.runId) {
      run = matchDispatchedRun([await readRun(operation.runId)], operation.intent);
      if (run.id !== operation.runId) throw new Error('Saved run ID does not match its dispatch');
    } else {
      run = matchDispatchedRun(await findRuns(operation.intent), operation.intent);
      operation.runId = run.id;
      operation.status = 'watching';
      await save(checkpoint);
    }
    if (operation.status === 'success') {
      if (run.status !== 'completed' || run.conclusion !== 'success')
        throw new Error('Previously successful child is no longer a successful completed run');
      continue;
    }
    try { await watch(operation.runId); } catch { /* The terminal API result below is authoritative. */ }
    run = matchDispatchedRun([await readRun(operation.runId)], operation.intent);
    if (run.id !== operation.runId || run.status !== 'completed') throw new Error('Child run is not terminal or completed');
    operation.status = run.conclusion === 'success' ? 'success' : 'failure';
    operation.conclusion = run.conclusion;
    await save(checkpoint);
    if (operation.status !== 'success') throw new Error(`Child run ${operation.runId} failed; inspection is required`);
  }
  return checkpoint;
}

function command(args, { inherit = false } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn('gh', args, { stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    if (!inherit) {
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
    }
    child.on('error', reject);
    child.on('close', code => code === 0 ? accept(stdout) : reject(new Error(`GitHub command failed (${code}): ${stderr}`)));
  });
}

function githubTransport() {
  return {
    dispatch: intent => command(['workflow', 'run', intent.workflowPath, '--repo', repository, '--ref', 'main',
      ...Object.entries(intent.inputs).flatMap(([key, value]) => ['-f', `${key}=${value}`])]),
    findRuns: async intent => {
      const path = intent.workflowPath.split('/').at(-1);
      // This bounded lookup discovers one dispatch, never polls a store or sends a replacement request.
      for (let attempt = 0; attempt < 6; attempt++) {
        const data = JSON.parse(await command(['api', `repos/${repository}/actions/workflows/${path}/runs?event=workflow_dispatch&branch=main&per_page=100`]));
        const runs = data.workflow_runs;
        if (!Array.isArray(runs)) throw new Error('Invalid dispatch run inventory');
        if (runs.some(run => run.display_title === `Store request ${intent.token}`)) return runs;
        if (attempt < 5) await new Promise(accept => setTimeout(accept, 2_000));
      }
      throw new Error('Dispatch acceptance is uncertain; inspect the saved request token before further action');
    },
    watch: id => command(['run', 'watch', String(id), '--repo', repository, '--interval', '30', '--exit-status'], { inherit: true }),
    readRun: async id => JSON.parse(await command(['api', `repos/${repository}/actions/runs/${id}`]))
  };
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await stat(path);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid()))
    throw new Error('A caller-owned private journal directory is required');
}

async function saveJournal(path, checkpoint) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(`${JSON.stringify(checkpoint, null, 2)}\n`);
    await file.sync();
    await file.close(); file = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    plan: { type: 'string' }, journal: { type: 'string' }, stage: { type: 'string' }, target: { type: 'string', default: 'all' }
  } });
  if (!values.plan || !values.journal) throw new Error('Explicit private --plan and --journal files are required');
  const planPath = resolve(values.plan);
  const journalPath = resolve(values.journal);
  if (planPath === journalPath) throw new Error('Plan and journal paths must differ');
  const plan = await loadPrivateJson(planPath);
  validateReleasePlan(plan, { stage: values.stage, target: values.target });
  await privateDirectory(dirname(journalPath));
  const lockPath = `${journalPath}.lock`;
  const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let checkpoint;
    try { await stat(journalPath); checkpoint = await loadPrivateJson(journalPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const result = await executeReleaseStage(plan, {
      stage: values.stage, target: values.target, checkpoint, save: value => saveJournal(journalPath, value), ...githubTransport()
    });
    console.log(JSON.stringify(result));
    return result;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

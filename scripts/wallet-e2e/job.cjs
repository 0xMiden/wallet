'use strict';

const { createHash } = require('node:crypto');
const { createReadStream, existsSync, readFileSync, readdirSync, rmSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { INVOCATIONS, STAGE_TIMEOUTS } = require('./invocations.cjs');
const {
  MAX_REPORT_BYTES,
  REPORT_FILENAME,
  createStage,
  formatReport,
  known,
  makeReport,
  matches,
  publishAtomically,
  schema,
  unknown,
  valueOrUnknown
} = require('./report.cjs');

const INSTALLATION = 'dist/chrome_unpacked';
const WORKFLOW_PATH = '.github/workflows/e2e-mainnet-nightly.yml';
const WORKFLOW_REF = '0xMiden/wallet/' + WORKFLOW_PATH + '@refs/heads/main';
const JOB_CODES = new Map([
  ['mainnet-nightly', 'mainnet'],
  ['mainnet-agglayer', 'agglayer']
]);
const CURRENT_JOB = new Map([
  ['mainnet', { scheduled: 200, manual: 245 }],
  ['agglayer', { scheduled: 185, manual: 230 }]
]);

function utcNow() {
  return new Date().toISOString();
}

function trustedEnvironment(env) {
  const jobKey = JOB_CODES.get(env.GITHUB_JOB);
  const sourceSha = env.GITHUB_SHA;
  const runId = env.GITHUB_RUN_ID;
  const runNumber = env.GITHUB_RUN_NUMBER;
  const runAttempt = env.GITHUB_RUN_ATTEMPT;
  if (
    env.GITHUB_REPOSITORY !== '0xMiden/wallet' ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    env.GITHUB_WORKFLOW_REF !== WORKFLOW_REF ||
    env.MIDEN_E2E_MAINNET_NIGHTLY !== 'true' ||
    env.E2E_NETWORK !== 'mainnet' ||
    runAttempt !== '1' ||
    !jobKey ||
    (env.E2E_WALLET_REPORT_JOB_KEY && env.E2E_WALLET_REPORT_JOB_KEY !== jobKey) ||
    !matches(sourceSha, schema.$defs.sha) ||
    ![runId, runNumber].every(id => matches(id, schema.$defs.id)) ||
    !['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
  ) {
    return undefined;
  }
  return {
    repository: '0xMiden/wallet',
    workflowId: '391951744',
    workflowPath: WORKFLOW_PATH,
    sourceSha,
    sourceRef: 'refs/heads/main',
    event: env.GITHUB_EVENT_NAME,
    runId,
    runNumber,
    runAttempt,
    jobKey
  };
}

function readOptional(path) {
  if (!existsSync(path)) return undefined;
  try {
    if (statSync(path).size > MAX_REPORT_BYTES) return undefined;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeInternal(path, record) {
  publishAtomically(path, JSON.stringify(record) + '\n');
}

function initialize(root, identity, env) {
  // A rerun or an untrusted manual ref never writes the report manifest.
  rmSync(join(root, REPORT_FILENAME), { force: true });
  writeInternal(join(root, 'job.json'), {
    identity,
    startAt: utcNow(),
    swapsOnly: env.REPORT_SWAPS_ONLY === 'true',
    bridgesOnly: env.REPORT_BRIDGES_ONLY === 'true',
    loopsOnly: env.REPORT_LOOPS_ONLY === 'true',
    approvalsOnly: env.REPORT_EXPLICIT_RECOVERY_ONLY === 'true'
  });
}

async function hashTree(root) {
  const hash = createHash('sha256');
  async function walk(path = '') {
    const absolute = resolve(root, path);
    const entries = readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    for (const entry of entries) {
      const relative = path ? path + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await walk(relative);
      else if (entry.isFile()) {
        const fileHash = createHash('sha256');
        for await (const block of createReadStream(resolve(root, relative))) fileHash.update(block);
        hash.update(relative + '\0' + fileHash.digest('hex') + '\0');
      } else {
        throw new Error('Extension has a nonregular build entry');
      }
    }
  }
  await walk();
  return hash.digest('hex');
}

async function recordBuild(root) {
  const manifest = readOptional(join(INSTALLATION, 'manifest.json'));
  if (!manifest) throw new Error('Extension build manifest unavailable');
  const sdk = readOptional('node_modules/@miden-sdk/miden-sdk/package.json');
  const versionRule = schema.properties.build.properties.extensionVersion.anyOf[0].properties.value;
  const sdkRule = schema.properties.build.properties.sdkVersion.anyOf[0].properties.value;
  writeInternal(join(root, 'build.json'), {
    extensionVersion: valueOrUnknown(matches(manifest.version, versionRule) ? manifest.version : undefined),
    extensionSha256: known(await hashTree(INSTALLATION)),
    sdkVersion: valueOrUnknown(matches(sdk?.version, sdkRule) ? sdk.version : undefined),
    remoteConfigSha256: unknown(),
    endpointLabels: []
  });
}

function invocationMarkers(root, command, id, codeText) {
  const identity = INVOCATIONS.get(id);
  if (!identity) throw new Error('Unknown wallet E2E invocation');
  const path = join(root, 'invocations', id);
  if (command === 'invocation-start') return writeInternal(join(path, 'start.json'), { startAt: utcNow() });
  if (!/^(0|[1-9][0-9]{0,2})$/.test(codeText ?? '') || Number(codeText) > 255) {
    throw new Error('Invalid wallet E2E command exit code');
  }
  return writeInternal(join(path, 'exit.json'), { endAt: utcNow(), code: Number(codeText) });
}

function invocationState(root, expected) {
  const path = join(root, 'invocations', expected.id);
  const start = readOptional(join(path, 'start.json'));
  const exit = readOptional(join(path, 'exit.json'));
  const candidate = readOptional(join(path, 'playwright.json'));
  if (!start && !exit && !candidate) return undefined;
  const report =
    candidate &&
    matches(candidate, schema.$defs.invocation) &&
    candidate.id === expected.id &&
    candidate.mode === expected.mode &&
    candidate.suite === expected.suite &&
    candidate.spec === expected.spec
      ? candidate
      : undefined;
  const exitCode = valueOrUnknown(exit?.code, 'report_incomplete');
  const playwrightOutcome = report?.playwrightOutcome ?? unknown('report_incomplete');
  const commandFailed = exitCode.value !== null && exitCode.value > 0;
  const status =
    commandFailed && playwrightOutcome.value === 'passed'
      ? 'failed'
      : (playwrightOutcome.value ?? (commandFailed ? 'failed' : 'unknown'));
  return {
    ...report,
    id: expected.id,
    mode: expected.mode,
    suite: expected.suite,
    spec: expected.spec,
    shard: report?.shard ?? unknown('not_applicable'),
    status,
    startAt: start?.startAt ? known(start.startAt) : (report?.startAt ?? unknown('report_incomplete')),
    endAt: exit?.endAt ? known(exit.endAt) : (report?.endAt ?? unknown('report_incomplete')),
    elapsedMs: report?.elapsedMs ?? unknown('report_incomplete'),
    deadlineAt: unknown('not_observed'),
    timeoutMs: valueOrUnknown(STAGE_TIMEOUTS.get(expected.id), 'not_applicable'),
    exitCode,
    playwrightOutcome,
    tests: report?.tests ?? []
  };
}

function coverageFor(selection, expected, dispositions, blocked) {
  if (!selection) return { selection: 'not_selected', status: 'not_started', reason: 'workflow_selection' };
  const states = expected.map(id => dispositions.get(id));
  if (states.includes('failed')) return { selection: 'selected', status: 'failed', reason: null };
  if (states.includes('timed_out')) return { selection: 'selected', status: 'timed_out', reason: null };
  if (states.includes('interrupted')) return { selection: 'selected', status: 'interrupted', reason: null };
  if (states.every(state => state === 'passed')) {
    return { selection: 'selected', status: 'passed', reason: null };
  }
  if (states.every(state => state === 'skipped')) {
    return { selection: 'selected', status: 'skipped', reason: null };
  }
  if (states.every(state => state === undefined) && blocked) {
    return { selection: 'selected', status: 'not_started', reason: blocked };
  }
  return { selection: 'selected', status: 'unknown', reason: 'report_incomplete' };
}

function workflowObservations(env) {
  const statuses = new Map([
    ['success', 'passed'],
    ['failure', 'failed'],
    ['cancelled', 'interrupted']
  ]);
  const stages = [];
  const build = statuses.get(env.REPORT_BUILD_OUTCOME);
  const recoveryOutcomes = [
    env.REPORT_INVOCATION_SWAP_RECOVERY_GRANT,
    env.REPORT_INVOCATION_SWAP_RECOVER,
    env.REPORT_WAIT_SWAP_RECOVER,
    env.REPORT_INVOCATION_SWAP_RECOVERED_RETURN,
    env.REPORT_WAIT_SWAP_RECOVERED_RETURN,
    env.REPORT_INVOCATION_EPOCH_RECOVER,
    env.REPORT_WAIT_EPOCH_RECOVER,
    env.REPORT_INVOCATION_NEAR_RECOVER,
    env.REPORT_WAIT_NEAR_RECOVER,
    env.REPORT_BARRIER_OUTCOME,
    ...(env.REPORT_RECOVERY_AUTH_OUTCOMES ?? '').split(/\s+/)
  ];
  const recovery = recoveryOutcomes.includes('failure')
    ? 'failed'
    : recoveryOutcomes.includes('cancelled')
      ? 'interrupted'
      : statuses.get(env.REPORT_BARRIER_OUTCOME);
  if (build) {
    stages.push(
      createStage({
        key: 'setup',
        status: build,
        origin: 'workflow',
        errorCode: build === 'failed' ? 'setup_failed' : null
      })
    );
  }
  if (recovery) {
    stages.push(
      createStage({
        key: 'recovery_gate',
        status: recovery,
        origin: 'workflow',
        errorCode: recovery === 'failed' ? 'recovery_gate_failed' : null
      })
    );
  }
  const blockedByRecovery = recovery === 'failed' || recovery === 'interrupted' || env.REPORT_RECOVERY_ONLY === 'true';
  return {
    stages,
    blocked: blockedByRecovery ? 'blocked_by_recovery' : build === 'failed' ? 'blocked_by_setup' : undefined
  };
}

function assemble(root, identity, env) {
  const destination = join(root, REPORT_FILENAME);
  rmSync(destination, { force: true });
  const job = readOptional(join(root, 'job.json'));
  if (!job || Object.keys(identity).some(key => job.identity?.[key] !== identity[key])) {
    throw new Error('Wallet E2E manifest unavailable');
  }
  const invocations = Array.from(INVOCATIONS.values())
    .filter(invocation => invocation.jobKey === identity.jobKey)
    .map(invocation => invocationState(root, invocation))
    .filter(Boolean);
  const dispositions = new Map(
    invocations.map(invocation => {
      if (invocation.status !== 'passed') return [invocation.id, invocation.status];
      const statuses = invocation.tests.map(test => test.status);
      const observed = statuses.includes('passed')
        ? 'passed'
        : statuses.length > 0 && statuses.every(status => status === 'skipped')
          ? 'skipped'
          : 'unknown';
      return [invocation.id, observed];
    })
  );
  const jobLimits = CURRENT_JOB.get(identity.jobKey);
  const timeoutMs = jobLimits[identity.event === 'schedule' ? 'scheduled' : 'manual'] * 60_000;
  const observations = workflowObservations(env);
  const agglayer = identity.jobKey === 'agglayer';
  const forward = invocations.find(invocation => invocation.id === 'swap-forward');
  const forwardOperations = forward?.tests.flatMap(test => test.attempts.flatMap(attempt => attempt.operations));
  const forwardStages = forwardOperations
    ?.filter(operation => operation.key === 'swap-forward')
    .flatMap(operation => operation.stages);
  const freshStarted = agglayer
    ? unknown('not_applicable')
    : forwardStages?.some(
          stage => stage.key === 'execution' && stage.origin === 'wallet_ui' && stage.status === 'in_progress'
        )
      ? known(1)
      : env.REPORT_INVOCATION_SWAP_FORWARD === 'skipped' ||
          forwardStages?.some(stage => stage.key === 'wallet_session' && stage.status === 'failed')
        ? known(0)
        : unknown();
  const bridges = agglayer
    ? ['agglayer-round-trip']
    : ['epoch-forward', 'epoch-reverse', 'near-forward', 'near-reverse'];
  if (!agglayer && !job.loopsOnly) bridges.push('usdcx-round-trip');
  const coverage = {
    swap: agglayer
      ? { selection: 'not_selected', status: 'not_started', reason: 'outside_job' }
      : coverageFor(
          !job.bridgesOnly && !job.approvalsOnly,
          ['swap-forward', 'swap-reverse'],
          dispositions,
          observations.blocked
        ),
    bridge: coverageFor(!job.swapsOnly && !job.approvalsOnly, bridges, dispositions, observations.blocked),
    freshSwapsStarted: freshStarted
  };
  const incomplete =
    invocations.some(invocation => invocation.exitCode.value === null || invocation.playwrightOutcome.value === null) ||
    Array.from(INVOCATIONS.values()).some(invocation => {
      if (invocation.jobKey !== identity.jobKey || dispositions.has(invocation.id)) return false;
      const envKey = invocation.id.replaceAll('-', '_').toUpperCase();
      const outcomes = [env['REPORT_INVOCATION_' + envKey], env['REPORT_WAIT_' + envKey]];
      return outcomes.some(outcome => ['success', 'failure', 'cancelled'].includes(outcome));
    });
  const now = utcNow();
  const report = makeReport({
    ...identity,
    generatedAt: now,
    availability: incomplete ? 'partial' : 'available',
    startAt: job.startAt,
    endAt: now,
    timeoutMs,
    build: readOptional(join(root, 'build.json')),
    coverage,
    stages: observations.stages,
    invocations
  });
  publishAtomically(destination, formatReport(report));
}

async function main(env = process.env, args = process.argv.slice(2)) {
  const identity = trustedEnvironment(env);
  const root =
    env.E2E_WALLET_REPORT_ROOT ??
    (identity && env.RUNNER_TEMP ? join(env.RUNNER_TEMP, 'wallet-e2e', identity.jobKey) : undefined);
  if (!identity || !root) return;
  const [command, invocationId, code] = args;
  if (command === 'initialize') return initialize(root, identity, env);
  if (command === 'capture-build') return recordBuild(root);
  if (command === 'assemble') return assemble(root, identity, env);
  if (
    ['invocation-start', 'invocation-end'].includes(command) &&
    INVOCATIONS.get(invocationId)?.jobKey === identity.jobKey
  ) {
    return invocationMarkers(root, command, invocationId, code);
  }
  throw new Error('Unknown wallet E2E reporting command');
}

if (require.main === module) {
  main().catch(() => {
    // Report failures contain no path, input, URL, error context or command.
    process.stderr.write('Wallet E2E reporting evidence unavailable.\n');
    process.exitCode = 1;
  });
}

module.exports = { assemble, hashTree, invocationState, main, trustedEnvironment };

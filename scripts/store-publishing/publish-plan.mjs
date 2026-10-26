import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { appendFile, mkdir, open, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safeStoreFailure } from './auth.mjs';
import { validateRolloverSession, validateUploadSession } from './chrome.mjs';
import { androidVersionCode, verifyReleaseSource } from './create-receipt.mjs';

const repository = '0xMiden/wallet';
const workflowPath = '.github/workflows/publish-stores.yml';
const items = { testnet: 'coajhopfooegmaifelglfboehacldcbo', devnet: 'eeghndabgeicdpkbcohgglidpfpiafnb' };
const sha = /^[a-f0-9]{40}$/;
const hash = /^[a-f0-9]{64}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const identity = plan =>
  plan.platform === 'ios' ? 'com.miden.bread' : plan.platform === 'android' ? 'com.miden.wallet' : items[plan.network];
const storeId = plan => (plan.platform === 'ios' ? '6789341854' : identity(plan));
const recordName = plan =>
  `${plan.platform}-${storeId(plan)}-${plan.version}-${plan.platform === 'ios' ? plan.buildNumber : (plan.versionCode ?? 'package')}.json`;
const journalName = plan => `chrome-${identity(plan)}-upload.json`;
const stateName = (plan, runId, attempt) =>
  `WalletStoreState-${plan.platform}-${plan.version}-${plan.network}-${runId}-${attempt}`;

export function validatePublishRequest(input) {
  const { releaseTag, platform, action, network } = input;
  if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(releaseTag ?? ''))
    throw new Error('A stable release tag is required');
  if (typeof input.sourceSha !== 'string' || !sha.test(input.sourceSha.toLowerCase()))
    throw new Error('An exact source SHA is required');
  if (
    !['chrome', 'ios', 'android'].includes(platform) ||
    !['status', 'prepare', 'begin-edit', 'upload', 'submit', 'release'].includes(action)
  )
    throw new Error('Unsupported platform or action');
  if (
    !['testnet', 'mainnet', 'devnet'].includes(network) ||
    (network === 'devnet' && platform !== 'chrome') ||
    (platform === 'chrome' && network === 'mainnet')
  )
    throw new Error('Unsupported store network');
  if ((action === 'prepare' && platform !== 'ios') || (action === 'begin-edit' && platform !== 'android'))
    throw new Error('Action does not match platform');
  const inspectEdit = platform === 'android' && action === 'status' && Boolean(input.editId);
  const needsProducer = ['upload', 'submit', 'release'].includes(action) || inspectEdit;
  const needsState =
    ['submit', 'release'].includes(action) || (platform === 'android' && action === 'upload') || inspectEdit;
  const producerRunId = input.producerRunId || undefined;
  const stateRunId = input.stateRunId || undefined;
  for (const value of [producerRunId, stateRunId])
    if (value !== undefined && !/^[1-9][0-9]*$/.test(value)) throw new Error('Invalid explicit run ID');
  if (
    (needsProducer && !producerRunId) ||
    (!needsProducer && producerRunId) ||
    (needsState && !stateRunId) ||
    (!needsProducer && stateRunId)
  )
    throw new Error('Explicit evidence run IDs do not match the action');
  const buildNumber = input.buildNumber || undefined;
  if (buildNumber !== undefined && !/^[1-9][0-9]{0,2}$/.test(buildNumber))
    throw new Error('Mobile build number must be 1 through 999');
  if (platform !== 'chrome' && (!['status', 'prepare'].includes(action) || inspectEdit) && !buildNumber)
    throw new Error('An explicit mobile build number is required');
  if (platform === 'chrome' && buildNumber) throw new Error('Chrome does not use a native build number');
  const editId = input.editId || undefined;
  const needsEdit = platform === 'android' && (['upload', 'submit'].includes(action) || inspectEdit);
  if ((needsEdit && !editId) || (!needsEdit && editId) || (editId && !/^[A-Za-z0-9_-]+$/.test(editId)))
    throw new Error('Explicit Play edit does not match the action');
  const acknowledgement = input.acknowledgement || 'none';
  const expectedAck =
    action === 'begin-edit'
      ? 'create-new-play-edit'
      : platform === 'android' && action === 'submit'
        ? 'submit-pending-play-changes'
        : 'none';
  if (acknowledgement !== expectedAck) throw new Error('Exact action acknowledgement is required');
  const version = releaseTag.slice(1);
  return {
    releaseTag,
    version,
    sourceSha: input.sourceSha.toLowerCase(),
    platform,
    action,
    network,
    producerRunId,
    stateRunId,
    buildNumber,
    editId,
    acknowledgement,
    needsProducer,
    needsState,
    ...(platform === 'android' && buildNumber ? { versionCode: androidVersionCode(version, buildNumber) } : {})
  };
}

export function verifyWorkflowRun(run, { runId, kind }) {
  const path = kind === 'producer' ? '.github/workflows/build-store-artifacts.yml' : workflowPath;
  if (
    !['producer', 'state'].includes(kind) ||
    String(run?.id) !== String(runId) ||
    run.path !== path ||
    run.event !== 'workflow_dispatch' ||
    run.head_branch !== 'main' ||
    run.status !== 'completed' ||
    !(kind === 'producer' ? ['success'] : ['success', 'failure']).includes(run.conclusion) ||
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository ||
    !sha.test(run.head_sha ?? '') ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1
  )
    throw new Error('Evidence must come from the exact completed trusted main workflow run');
  return run;
}

export function selectRunArtifact(inventory, runId, name) {
  if (!Array.isArray(inventory?.artifacts) || inventory.total_count !== inventory.artifacts.length)
    throw new Error('Complete artifact inventory is required');
  const selected = inventory.artifacts.filter(artifact => artifact.name === name);
  if (
    selected.length !== 1 ||
    selected[0].expired !== false ||
    String(selected[0].workflow_run?.id) !== String(runId) ||
    !Number.isSafeInteger(selected[0].id)
  )
    throw new Error('Exact unexpired run artifact is required');
  return selected[0];
}

export function producerArtifact(plan) {
  const suffix =
    plan.platform === 'chrome' ? 'Chrome' : `${plan.platform === 'ios' ? 'iOS' : 'Android'}-${plan.buildNumber}`;
  const prefix = `BreadWallet-${plan.version}-${plan.network}-${suffix}`;
  const file = `${prefix}.${plan.platform === 'chrome' ? 'zip' : plan.platform === 'ios' ? 'ipa' : 'aab'}`;
  return { name: `${prefix}-Store`, file, receiptFile: `${file}.receipt.json` };
}

export function validateProducerReceipt(plan, receipt) {
  if (
    !receipt ||
    ['platform', 'version', 'network', 'sourceSha'].some(key => receipt[key] !== plan[key]) ||
    receipt.identity !== identity(plan) ||
    !hash.test(receipt.sha256 ?? '') ||
    (plan.platform === 'ios' && receipt.buildNumber !== plan.buildNumber) ||
    (plan.platform === 'android' && receipt.versionCode !== plan.versionCode)
  )
    throw new Error('Producer receipt does not match the exact intended artifact');
  return receipt;
}

function validateAttestation(plan, record, receipt, publisherId) {
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.uploaded !== true ||
    record.storeId !== storeId(plan) ||
    record.identity !== identity(plan) ||
    ['platform', 'version', 'network', 'sourceSha'].some(key => record[key] !== plan[key]) ||
    !hash.test(record.sha256 ?? '') ||
    (receipt && record.sha256 !== receipt.sha256) ||
    (plan.platform === 'ios' && record.buildNumber !== plan.buildNumber) ||
    (plan.platform === 'android' && record.versionCode !== plan.versionCode) ||
    (plan.platform === 'chrome' && (!publisherId || record.publisherId !== publisherId)) ||
    (plan.platform === 'android' && ['submit', 'status'].includes(plan.action) && record.editId !== plan.editId)
  )
    throw new Error('Prior upload attestation does not match the exact artifact and target');
}

function validateEdit(plan, edit, nowSeconds) {
  if (
    !edit ||
    edit.packageName !== identity(plan) ||
    ['version', 'network', 'sourceSha'].some(key => edit[key] !== plan[key]) ||
    !/^[A-Za-z0-9_-]+$/.test(edit.editId ?? '') ||
    (plan.editId && edit.editId !== plan.editId) ||
    !/^[0-9]+$/.test(String(edit.expiryTimeSeconds ?? '')) ||
    (['upload', 'submit'].includes(plan.action) && Number(edit.expiryTimeSeconds) <= nowSeconds)
  )
    throw new Error('Prior Play edit must match the caller-owned unexpired edit');
}

function validateChromeJournal(plan, journal, receipt, publisherId, nowSeconds, allowExpired = false) {
  if (plan.platform !== 'chrome' || !publisherId) throw new Error('Chrome pending journal has no matching publisher');
  validateUploadSession(
    journal,
    {
      itemId: identity(plan),
      publisherId,
      version: plan.version,
      network: plan.network,
      sourceSha: plan.sourceSha,
      sha256: receipt?.sha256 ?? journal?.sha256
    },
    nowSeconds,
    { allowExpired }
  );
}

function cleanRecord(record, edit = false) {
  const fields = edit
    ? ['packageName', 'editId', 'version', 'network', 'sourceSha', 'expiryTimeSeconds']
    : [
        'schemaVersion',
        'platform',
        'identity',
        'storeId',
        'version',
        'network',
        'sourceSha',
        'sha256',
        'uploaded',
        'buildNumber',
        'versionCode',
        'editId',
        'publisherId',
        'state',
        'startedAt',
        'acceptedAt',
        'completedAt',
        'crxVersion',
        'completionEvidence'
      ];
  return Object.fromEntries(fields.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
}

export function validateStateSnapshot(
  plan,
  snapshot,
  { run, receipt, publisherId, nowSeconds = Math.floor(Date.now() / 1000) }
) {
  verifyWorkflowRun(run, { runId: plan.stateRunId, kind: 'state' });
  const manifest = snapshot?.manifest;
  const rollover = plan.platform === 'chrome' && plan.action === 'upload' && manifest?.intent?.version !== plan.version;
  const evidencePlan = rollover
    ? validatePublishRequest({
        ...plan,
        ...manifest?.intent,
        action: 'upload',
        stateRunId: '',
        buildNumber: '',
        editId: '',
        acknowledgement: 'none'
      })
    : plan;
  if (
    rollover &&
    (evidencePlan.platform !== plan.platform ||
      evidencePlan.network !== plan.network ||
      manifest.intent.version !== evidencePlan.version)
  )
    throw new Error('Prior Chrome journal intent does not match this store target');
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    manifest.repository !== repository ||
    manifest.workflowPath !== workflowPath ||
    manifest.runId !== run.id ||
    manifest.runAttempt !== run.run_attempt ||
    manifest.automationSha !== run.head_sha ||
    !['success', 'failure'].includes(manifest.outcome) ||
    !Array.isArray(manifest.files) ||
    ['platform', 'releaseTag', 'version', 'network', 'sourceSha', 'buildNumber'].some(
      key => manifest.intent?.[key] !== evidencePlan[key]
    )
  )
    throw new Error('Publication state manifest is not bound to this run and release');
  const records = {};
  const allowed = [
    recordName(evidencePlan),
    ...(plan.platform === 'android' ? ['android-edit.json'] : []),
    ...(plan.platform === 'chrome' ? [journalName(plan)] : [])
  ];
  if (!snapshot.files || Object.keys(snapshot.files).length !== manifest.files.length)
    throw new Error('State inventory mismatch');
  for (const file of manifest.files) {
    if (
      !allowed.includes(file.name) ||
      records[file.name] ||
      !hash.test(file.sha256 ?? '') ||
      !(snapshot.files[file.name] instanceof Uint8Array) ||
      digest(snapshot.files[file.name]) !== file.sha256
    )
      throw new Error('State contains an unexpected file or checksum');
    try {
      records[file.name] = JSON.parse(Buffer.from(snapshot.files[file.name]).toString('utf8'));
    } catch {
      throw new Error('Invalid publication state JSON');
    }
  }
  const journal = plan.platform === 'chrome' ? records[journalName(plan)] : undefined;
  if (rollover && !journal) throw new Error('A prior terminal Chrome journal is required for rollover');
  const evidenceReceipt = rollover ? { sha256: journal?.sha256 } : receipt;
  if (journal)
    validateChromeJournal(
      evidencePlan,
      journal,
      evidenceReceipt,
      publisherId,
      nowSeconds,
      rollover || plan.action === 'release'
    );
  if (rollover)
    validateRolloverSession(
      journal,
      { itemId: identity(plan), publisherId, version: plan.version, network: plan.network },
      nowSeconds
    );
  if (
    run.conclusion === 'failure' &&
    !journal &&
    !(plan.platform === 'android' && plan.action === 'status' && plan.editId)
  )
    throw new Error('A failed state run requires a validated Chrome pending journal');
  const attestation = records[recordName(evidencePlan)];
  if (attestation) validateAttestation(evidencePlan, attestation, evidenceReceipt, publisherId);
  if (rollover) return { [journalName(plan)]: journal };
  if (
    (['submit', 'release'].includes(plan.action) ||
      (plan.platform === 'android' && plan.action === 'status' && plan.editId)) &&
    !attestation &&
    !(plan.action === 'submit' && journal)
  )
    throw new Error('Prior upload attestation is required');
  if (
    plan.platform === 'android' &&
    (['upload', 'submit'].includes(plan.action) || (plan.action === 'status' && plan.editId))
  )
    validateEdit(plan, records['android-edit.json'], nowSeconds);
  return records;
}

async function readBytes(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw new Error('A regular evidence file is required');
    return await file.readFile();
  } finally {
    await file.close();
  }
}
const readJson = async path => JSON.parse((await readBytes(path)).toString('utf8'));
async function privateWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    typeof value === 'string' || value instanceof Uint8Array ? value : `${JSON.stringify(value, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 }
  );
}
async function output(values, env) {
  if (!env.GITHUB_OUTPUT) throw new Error('GitHub output path is required');
  await appendFile(
    env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join('')
  );
}
function fromEnv(env) {
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== 'refs/heads/main')
    throw new Error('Only the trusted main workflow may publish');
  return validatePublishRequest({
    releaseTag: env.RELEASE_TAG,
    sourceSha: env.SOURCE_SHA,
    platform: env.PLATFORM,
    action: env.STORE_ACTION,
    network: env.NETWORK,
    producerRunId: env.PRODUCER_RUN_ID,
    stateRunId: env.STATE_RUN_ID,
    buildNumber: env.BUILD_NUMBER,
    editId: env.EDIT_ID,
    acknowledgement: env.ACKNOWLEDGEMENT
  });
}
function paths(env) {
  if (!env.RUNNER_TEMP) throw new Error('Runner temporary directory is required');
  const root = resolve(env.RUNNER_TEMP, 'wallet-store-publishing');
  return {
    state: resolve(root, 'state'),
    config: resolve(root, 'config.json'),
    private: resolve(root, 'private'),
    intent: resolve(root, 'intent.json'),
    result: resolve(root, 'result.json'),
    export: resolve(root, 'export')
  };
}
function safeResult(result) {
  const fields = [
    'platform',
    'action',
    'version',
    'buildNumber',
    'versionCode',
    'editId',
    'expiryTimeSeconds',
    'uploaded',
    'status',
    'state',
    'actionRequired',
    'releaseType',
    'autoReleaseAfterApproval',
    'name',
    'itemId',
    'appId',
    'packageName',
    'track',
    'crxVersion',
    'uploadState',
    'lastAsyncUploadState',
    'takenDown',
    'warned',
    'published',
    'publication',
    'releaseRequested',
    'submissionRequested',
    'releaseRequestId',
    'reviewSubmissionId',
    'fullRolloutVerified',
    'includesPendingConsoleChanges',
    'id',
    'bundleId',
    'processingState',
    'expired',
    'buildAudienceType',
    'buildId',
    'deployPercentage',
    'releaseLifecycleState',
    'completionEvidence',
    'submittedRevisionVerified'
  ];
  if (Array.isArray(result)) return result.map(value => (typeof value === 'object' ? safeResult(value) : value));
  const clean = Object.fromEntries(
    fields
      .filter(key => ['string', 'number', 'boolean'].includes(typeof result?.[key]) || result?.[key] === null)
      .map(key => [key, result[key]])
  );
  for (const key of [
    'app',
    'versions',
    'builds',
    'publishedItemRevisionStatus',
    'submittedItemRevisionStatus',
    'distributionChannels',
    'releases',
    'activeArtifacts'
  ]) {
    if (result?.[key] && typeof result[key] === 'object') clean[key] = safeResult(result[key]);
  }
  if (Array.isArray(result?.versionCodes)) {
    clean.versionCodes = result.versionCodes
      .slice(0, 100)
      .filter(
        value => typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value) && Number(value) <= 2100000000
      );
  }
  if (result?.failure) clean.failure = safeStoreFailure({ ...result.failure, status: result.failure.httpStatus });
  if (result?.editInspection) {
    clean.editInspection = result.editInspection.id
      ? safeResult(result.editInspection)
      : safeStoreFailure({ ...result.editInspection, status: result.editInspection.httpStatus });
  }
  return clean;
}
async function loadSnapshot(directory) {
  const manifest = await readJson(resolve(directory, 'manifest.json'));
  const files = {};
  const entries = await readdir(directory);
  const expected = ['manifest.json', 'result.json', ...manifest.files.map(file => file.name)];
  if (entries.some(name => !expected.includes(name))) throw new Error('Unexpected state archive file');
  for (const name of entries.filter(name => !['manifest.json', 'result.json'].includes(name)))
    files[name] = await readBytes(resolve(directory, name));
  return { manifest, files };
}

export async function main(command, env = process.env, dependencies = {}) {
  const plan = fromEnv(env);
  const path = paths(env);
  const artifact = producerArtifact(plan);
  if (command === 'request') {
    await output(
      {
        version: plan.version,
        needs_producer: plan.needsProducer,
        needs_state: Boolean(plan.stateRunId),
        state_artifact_name: stateName(plan, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT)
      },
      env
    );
  } else if (command === 'source') {
    verifyReleaseSource(plan, {
      release: await readJson(env.RELEASE_FILE),
      tagSha: (await readJson(env.TAG_COMMIT_FILE)).sha,
      checkedOutSha: env.CHECKOUT_SHA,
      packageVersion: (await readJson(resolve(env.SOURCE_DIR, 'package.json'))).version,
      manifestVersion: (await readJson(resolve(env.SOURCE_DIR, 'public/manifest.json'))).version
    });
  } else if (command === 'producer' || command === 'state-run') {
    const producer = command === 'producer';
    const run = verifyWorkflowRun(await readJson(producer ? env.PRODUCER_RUN_FILE : env.STATE_RUN_FILE), {
      runId: producer ? plan.producerRunId : plan.stateRunId,
      kind: producer ? 'producer' : 'state'
    });
    const inventory = await readJson(producer ? env.PRODUCER_ARTIFACTS_FILE : env.STATE_ARTIFACTS_FILE);
    let expectedName = producer ? artifact.name : stateName(plan, run.id, run.run_attempt);
    if (!producer && plan.platform === 'chrome' && plan.action === 'upload') {
      const pattern = new RegExp(
        `^WalletStoreState-chrome-(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)-${plan.network}-${run.id}-${run.run_attempt}$`
      );
      const candidates = inventory.artifacts?.filter(value => pattern.test(value.name)) ?? [];
      if (candidates.length !== 1) throw new Error('Exactly one prior Chrome publication state artifact is required');
      expectedName = candidates[0].name;
    }
    const selected = selectRunArtifact(inventory, run.id, expectedName);
    await output({ artifact_id: selected.id }, env);
  } else if (command === 'prepare') {
    let receipt;
    if (plan.needsProducer) {
      receipt = validateProducerReceipt(plan, await readJson(resolve(env.PRODUCER_DIR, artifact.receiptFile)));
      if (digest(await readBytes(resolve(env.PRODUCER_DIR, artifact.file))) !== receipt.sha256)
        throw new Error('Downloaded artifact checksum mismatch');
    }
    const records = plan.stateRunId
      ? validateStateSnapshot(plan, await loadSnapshot(env.PRIOR_STATE_DIR), {
          run: await readJson(env.STATE_RUN_FILE),
          receipt,
          publisherId: env.CHROME_WEB_STORE_PUBLISHER_ID
        })
      : {};
    await mkdir(path.state, { recursive: true, mode: 0o700 });
    for (const [name, record] of Object.entries(records))
      await privateWrite(resolve(path.state, name), cleanRecord(record, name === 'android-edit.json'));
    const config = { stateDir: path.state };
    if (plan.platform === 'chrome') {
      if (!env.CHROME_WEB_STORE_PUBLISHER_ID) throw new Error('Chrome publisher configuration is required');
      const oauth = JSON.parse(env.CHROME_WEB_STORE_OAUTH_JSON ?? '{}');
      if (
        ![oauth.client_id, oauth.client_secret, oauth.refresh_token].every(value => typeof value === 'string' && value)
      )
        throw new Error('Chrome OAuth credentials are required');
      const oauthPath = resolve(path.private, 'chrome-oauth.json');
      await privateWrite(
        oauthPath,
        Object.fromEntries(
          ['client_id', 'client_secret', 'refresh_token', 'scope']
            .filter(key => typeof oauth[key] === 'string')
            .map(key => [key, oauth[key]])
        )
      );
      config.chrome = { publisherId: env.CHROME_WEB_STORE_PUBLISHER_ID, items, oauthPath };
    } else if (plan.platform === 'ios') {
      if (
        ![env.APP_STORE_CONNECT_KEY_ID, env.APP_STORE_CONNECT_ISSUER_ID, env.APP_STORE_CONNECT_KEY_P8].every(
          value => typeof value === 'string' && value
        )
      )
        throw new Error('Apple API credentials are required');
      if (!/^[A-Z0-9]{10}$/.test(env.APP_STORE_CONNECT_KEY_ID)) throw new Error('Invalid Apple key identifier');
      const keyPath = resolve(path.private, `AuthKey_${env.APP_STORE_CONNECT_KEY_ID}.p8`);
      await privateWrite(keyPath, env.APP_STORE_CONNECT_KEY_P8);
      config.apple = {
        appId: '6789341854',
        bundleId: 'com.miden.bread',
        keyId: env.APP_STORE_CONNECT_KEY_ID,
        issuerId: env.APP_STORE_CONNECT_ISSUER_ID,
        keyPath
      };
    } else config.play = { packageName: 'com.miden.wallet', developerId: '6520373044208011012' };
    await privateWrite(path.config, config);
    await privateWrite(path.intent, { plan, receipt });
  } else if (command === 'execute') {
    const args = [
      plan.platform,
      plan.action,
      '--config',
      path.config,
      '--version',
      plan.version,
      '--network',
      plan.network,
      '--source-sha',
      plan.sourceSha
    ];
    if (plan.action !== 'status') args.push('--confirm', plan.version);
    if (plan.buildNumber) args.push('--build-number', plan.buildNumber);
    if (plan.platform === 'android' && plan.versionCode) args.push('--version-code', String(plan.versionCode));
    if (plan.editId) args.push('--edit-id', plan.editId);
    if (plan.action === 'begin-edit') args.push('--confirm-new-edit');
    if (plan.platform === 'android' && plan.action === 'submit') args.push('--allow-pending-changes');
    if (plan.action === 'upload' || (plan.platform === 'chrome' && plan.action === 'submit'))
      args.push(
        '--artifact',
        resolve(env.PRODUCER_DIR, artifact.file),
        '--receipt',
        resolve(env.PRODUCER_DIR, artifact.receiptFile)
      );
    const run = dependencies.run ?? (await import('./cli.mjs')).run;
    let result;
    try {
      result = safeResult(await run(args));
    } catch (error) {
      const failure = safeStoreFailure(error);
      await privateWrite(path.result, { failure });
      console.error(JSON.stringify({ failure }));
      throw error;
    }
    await privateWrite(path.result, result);
    console.log(JSON.stringify(result));
  } else if (command === 'export') {
    const { receipt } = await readJson(path.intent);
    const files = [];
    for (const name of [
      recordName(plan),
      ...(plan.platform === 'android' ? ['android-edit.json'] : []),
      ...(plan.platform === 'chrome' ? [journalName(plan)] : [])
    ]) {
      let bytes;
      try {
        bytes = await readBytes(resolve(path.state, name));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const value = JSON.parse(bytes.toString('utf8'));
      if (
        plan.platform === 'chrome' &&
        plan.action === 'upload' &&
        name === journalName(plan) &&
        value.version !== plan.version
      ) {
        validateRolloverSession(
          value,
          {
            itemId: identity(plan),
            publisherId: env.CHROME_WEB_STORE_PUBLISHER_ID,
            version: plan.version,
            network: plan.network
          },
          Math.floor(Date.now() / 1000)
        );
        continue;
      }
      if (name === 'android-edit.json') validateEdit(plan, value, 0);
      else if (name === journalName(plan) && plan.platform === 'chrome')
        validateChromeJournal(
          plan,
          value,
          receipt,
          env.CHROME_WEB_STORE_PUBLISHER_ID,
          Math.floor(Date.now() / 1000),
          true
        );
      else validateAttestation(plan, value, receipt, env.CHROME_WEB_STORE_PUBLISHER_ID);
      const cleanBytes = Buffer.from(`${JSON.stringify(cleanRecord(value, name === 'android-edit.json'), null, 2)}\n`);
      await privateWrite(resolve(path.export, name), cleanBytes);
      files.push({ name, sha256: digest(cleanBytes) });
    }
    let result = {};
    try {
      result = safeResult(await readJson(path.result));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await privateWrite(resolve(path.export, 'result.json'), result);
    const intent = Object.fromEntries(
      ['platform', 'releaseTag', 'version', 'network', 'sourceSha', 'buildNumber']
        .filter(key => plan[key] !== undefined)
        .map(key => [key, plan[key]])
    );
    await privateWrite(resolve(path.export, 'manifest.json'), {
      schemaVersion: 1,
      repository,
      workflowPath,
      runId: Number(env.GITHUB_RUN_ID),
      runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
      automationSha: env.AUTOMATION_SHA,
      action: plan.action,
      outcome: env.OPERATION_OUTCOME === 'success' ? 'success' : 'failure',
      intent,
      files,
      result
    });
  } else throw new Error('Unknown publishing workflow helper command');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(() => {
    console.error(
      'Publishing workflow validation or operation failed; inspect the selected run and store status before another attempt'
    );
    process.exitCode = 1;
  });
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  main,
  producerArtifact,
  selectRunArtifact,
  validateProducerReceipt,
  validatePublishRequest,
  validateStateSnapshot,
  verifyWorkflowRun
} from './publish-plan.mjs';

const sha = 'a'.repeat(40);
const automationSha = 'b'.repeat(40);
const hash = 'c'.repeat(64);
const input = {
  releaseTag: 'v1.17.7',
  sourceSha: sha,
  platform: 'chrome',
  action: 'upload',
  network: 'testnet',
  producerRunId: '42',
  stateRunId: '',
  buildNumber: '',
  editId: '',
  acknowledgement: 'none'
};
const run = (kind = 'producer', extra = {}) => ({
  id: kind === 'producer' ? 42 : 80,
  run_attempt: 1,
  head_sha: automationSha,
  path: `.github/workflows/${kind === 'producer' ? 'build-store-artifacts' : 'publish-stores'}.yml`,
  event: 'workflow_dispatch',
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
  repository: { full_name: '0xMiden/wallet' },
  head_repository: { full_name: '0xMiden/wallet' },
  ...extra
});
const receipt = (extra = {}) => ({
  platform: 'chrome',
  version: '1.17.7',
  network: 'testnet',
  sourceSha: sha,
  identity: 'coajhopfooegmaifelglfboehacldcbo',
  sha256: hash,
  ...extra
});
const bytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const digest = value => createHash('sha256').update(value).digest('hex');

function snapshot(plan, { attestation = {}, edit, extraManifest = {} } = {}) {
  const native =
    plan.platform === 'ios'
      ? { buildNumber: plan.buildNumber }
      : plan.platform === 'android'
        ? { versionCode: plan.versionCode, editId: plan.editId }
        : { publisherId: 'publisher' };
  const identity =
    plan.platform === 'ios'
      ? 'com.miden.bread'
      : plan.platform === 'android'
        ? 'com.miden.wallet'
        : 'coajhopfooegmaifelglfboehacldcbo';
  const storeId = plan.platform === 'ios' ? '6789341854' : identity;
  const record = {
    schemaVersion: 1,
    platform: plan.platform,
    identity,
    storeId,
    version: plan.version,
    network: plan.network,
    sourceSha: plan.sourceSha,
    sha256: hash,
    uploaded: true,
    ...native,
    ...attestation
  };
  const file = `${plan.platform}-${storeId}-${plan.version}-${plan.buildNumber && plan.platform === 'ios' ? plan.buildNumber : (plan.versionCode ?? 'package')}.json`;
  const files = { [file]: bytes(record), ...(edit ? { 'android-edit.json': bytes(edit) } : {}) };
  return {
    files,
    manifest: {
      schemaVersion: 1,
      repository: '0xMiden/wallet',
      workflowPath: '.github/workflows/publish-stores.yml',
      runId: 80,
      runAttempt: 1,
      automationSha,
      action: 'upload',
      outcome: 'success',
      intent: {
        platform: plan.platform,
        releaseTag: plan.releaseTag,
        version: plan.version,
        network: plan.network,
        sourceSha: plan.sourceSha,
        ...(plan.buildNumber ? { buildNumber: plan.buildNumber } : {})
      },
      files: Object.entries(files).map(([name, value]) => ({ name, sha256: digest(value) })),
      ...extraManifest
    }
  };
}

test('manual publishing intent binds a stable version, exact source and explicit producer', () => {
  const plan = validatePublishRequest(input);
  assert.equal(plan.version, '1.17.7');
  assert.equal(plan.sourceSha, sha);
  assert.equal(plan.needsProducer, true);
  assert.equal(plan.needsState, false);
  assert.deepEqual(producerArtifact(plan), {
    name: 'BreadWallet-1.17.7-testnet-Chrome-Store',
    file: 'BreadWallet-1.17.7-testnet-Chrome.zip',
    receiptFile: 'BreadWallet-1.17.7-testnet-Chrome.zip.receipt.json'
  });
});

test('invalid tags, mutable sources, mismatched action selectors and missing evidence are refused', () => {
  for (const extra of [
    { releaseTag: 'v1.17.7-rc.1' },
    { sourceSha: 'main' },
    { sourceSha: sha.slice(1) },
    { platform: 'all' },
    { action: 'deploy' },
    { producerRunId: '' },
    { producerRunId: '1/../2' },
    { action: 'release', stateRunId: '' },
    { action: 'prepare' },
    { action: 'begin-edit' }
  ]) {
    assert.throws(() => validatePublishRequest({ ...input, ...extra }));
  }
});

test('status and iOS preparation need no producer, while native package actions bind build numbers', () => {
  const status = validatePublishRequest({ ...input, action: 'status', producerRunId: '' });
  assert.equal(status.needsProducer, false);
  const prepare = validatePublishRequest({ ...input, platform: 'ios', action: 'prepare', producerRunId: '' });
  assert.equal(prepare.needsProducer, false);
  const ios = validatePublishRequest({ ...input, platform: 'ios', buildNumber: '19' });
  assert.equal(producerArtifact(ios).name, 'BreadWallet-1.17.7-testnet-iOS-19-Store');
  assert.equal(producerArtifact(ios).file, 'BreadWallet-1.17.7-testnet-iOS-19.ipa');
  for (const buildNumber of ['', '0', '1000', '1\nOTHER=value'])
    assert.throws(() => validatePublishRequest({ ...input, platform: 'ios', buildNumber }));
});

test('Devnet targets only its Chrome listing and unsupported mainnet Chrome stays refused', () => {
  assert.equal(validatePublishRequest({ ...input, network: 'devnet' }).network, 'devnet');
  assert.throws(() => validatePublishRequest({ ...input, network: 'mainnet' }));
  assert.throws(() =>
    validatePublishRequest({
      ...input,
      platform: 'android',
      network: 'devnet',
      buildNumber: '19',
      stateRunId: '80',
      editId: 'edit-1'
    })
  );
});

test('Play edit creation and submission each require their exact acknowledgement and state', () => {
  const base = { ...input, platform: 'android', buildNumber: '19', stateRunId: '80', editId: 'edit-1' };
  assert.throws(() => validatePublishRequest({ ...base, action: 'begin-edit', producerRunId: '', stateRunId: '' }));
  const edit = validatePublishRequest({
    ...base,
    action: 'begin-edit',
    producerRunId: '',
    stateRunId: '',
    editId: '',
    acknowledgement: 'create-new-play-edit'
  });
  assert.equal(edit.needsProducer, false);
  assert.equal(edit.needsState, false);
  const submit = validatePublishRequest({ ...base, action: 'submit', acknowledgement: 'submit-pending-play-changes' });
  assert.equal(submit.versionCode, 11707019);
  assert.equal(submit.needsState, true);
  for (const extra of [{ editId: '' }, { stateRunId: '' }, { acknowledgement: 'none' }])
    assert.throws(() =>
      validatePublishRequest({ ...base, action: 'submit', acknowledgement: 'submit-pending-play-changes', ...extra })
    );
});

test('only completed trusted manual main runs from the exact workflow/repository are accepted', () => {
  const producer = run();
  assert.equal(verifyWorkflowRun(producer, { runId: '42', kind: 'producer' }), producer);
  for (const extra of [
    { id: 43 },
    { event: 'pull_request' },
    { head_branch: 'feature' },
    { path: '.github/workflows/untrusted.yml' },
    { repository: { full_name: 'fork/wallet' } },
    { head_repository: { full_name: 'fork/wallet' } },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { head_sha: 'main' },
    { run_attempt: 0 }
  ]) {
    assert.throws(() => verifyWorkflowRun(run('producer', extra), { runId: '42', kind: 'producer' }));
  }
  assert.equal(
    verifyWorkflowRun(run('state', { conclusion: 'failure' }), { runId: '80', kind: 'state' }).conclusion,
    'failure'
  );
  assert.throws(() => verifyWorkflowRun(run('state', { conclusion: 'cancelled' }), { runId: '80', kind: 'state' }));
});

test('artifact selection rejects expired, duplicated, foreign-run and incomplete inventories', () => {
  const artifact = { id: 123, name: 'expected', expired: false, workflow_run: { id: 42 } };
  assert.equal(selectRunArtifact({ total_count: 1, artifacts: [artifact] }, '42', 'expected'), artifact);
  for (const inventory of [
    { total_count: 0, artifacts: [] },
    { total_count: 2, artifacts: [artifact] },
    { total_count: 1, artifacts: [{ ...artifact, expired: true }] },
    { total_count: 2, artifacts: [artifact, { ...artifact, id: 124 }] },
    { total_count: 1, artifacts: [{ ...artifact, workflow_run: { id: 99 } }] }
  ]) {
    assert.throws(() => selectRunArtifact(inventory, '42', 'expected'));
  }
});

test('producer receipts bind platform, identity, checksum, version, network, source and native build', () => {
  const plan = validatePublishRequest(input);
  const valid = receipt();
  assert.equal(validateProducerReceipt(plan, valid), valid);
  for (const extra of [
    { version: '1.17.8' },
    { network: 'devnet' },
    { sourceSha: 'd'.repeat(40) },
    { platform: 'ios' },
    { identity: 'retired' },
    { sha256: 'bad' }
  ])
    assert.throws(() => validateProducerReceipt(plan, receipt(extra)));
  const ios = validatePublishRequest({ ...input, platform: 'ios', buildNumber: '19' });
  assert.throws(() =>
    validateProducerReceipt(ios, receipt({ platform: 'ios', identity: 'com.miden.bread', buildNumber: '18' }))
  );
});

test('state restore requires exact trusted run metadata and the producer-bound upload attestation', () => {
  const plan = validatePublishRequest({ ...input, action: 'release', stateRunId: '80' });
  const previous = snapshot(plan);
  const restored = validateStateSnapshot(plan, previous, {
    run: run('state'),
    receipt: receipt(),
    publisherId: 'publisher'
  });
  assert.equal(Object.keys(restored).length, 1);
  assert.equal(Object.values(restored)[0].sha256, hash);
  for (const extraManifest of [
    { runId: 81 },
    { runAttempt: 2 },
    { automationSha: 'd'.repeat(40) },
    { workflowPath: '.github/workflows/untrusted.yml' },
    { intent: { ...previous.manifest.intent, sourceSha: 'd'.repeat(40) } }
  ]) {
    assert.throws(() =>
      validateStateSnapshot(plan, snapshot(plan, { extraManifest }), {
        run: run('state'),
        receipt: receipt(),
        publisherId: 'publisher'
      })
    );
  }
});

test('state restore refuses forged digests, extra files, missing uploads and a different artifact hash', () => {
  const plan = validatePublishRequest({ ...input, action: 'submit', stateRunId: '80' });
  const context = { run: run('state'), receipt: receipt(), publisherId: 'publisher' };
  for (const attestation of [{ uploaded: false }, { sha256: 'd'.repeat(64) }, { publisherId: 'other' }])
    assert.throws(() => validateStateSnapshot(plan, snapshot(plan, { attestation }), context));
  const forged = snapshot(plan);
  forged.manifest.files[0].sha256 = 'd'.repeat(64);
  assert.throws(() => validateStateSnapshot(plan, forged, context));
  const extra = snapshot(plan);
  extra.files['credentials.json'] = bytes({ secret: 'must-never-import' });
  assert.throws(() => validateStateSnapshot(plan, extra, context));
});

test('Android upload and submission restore only the exact caller-owned unexpired edit', () => {
  const plan = validatePublishRequest({
    ...input,
    platform: 'android',
    buildNumber: '19',
    stateRunId: '80',
    editId: 'edit-1'
  });
  const edit = {
    packageName: 'com.miden.wallet',
    editId: 'edit-1',
    version: plan.version,
    network: plan.network,
    sourceSha: sha,
    expiryTimeSeconds: '2000000000'
  };
  const previous = snapshot(plan, { edit });
  delete previous.files[previous.manifest.files[0].name];
  previous.manifest.files.shift();
  const context = {
    run: run('state'),
    receipt: receipt({ platform: 'android', identity: 'com.miden.wallet', versionCode: 11707019 }),
    nowSeconds: 1700000000
  };
  assert.equal(validateStateSnapshot(plan, previous, context)['android-edit.json'].editId, 'edit-1');
  for (const extra of [{ editId: 'other' }, { expiryTimeSeconds: '1600000000' }, { packageName: 'com.other.wallet' }]) {
    const bad = snapshot(plan, { edit: { ...edit, ...extra } });
    delete bad.files[bad.manifest.files[0].name];
    bad.manifest.files.shift();
    assert.throws(() => validateStateSnapshot(plan, bad, context));
  }
});

test('publishing workflow is manual, main-only, protected and pins trusted automation', () => {
  const text = readFileSync(new URL('../../.github/workflows/publish-stores.yml', import.meta.url), 'utf8');
  assert.match(text, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(text, /^ {2}(push|pull_request|release|schedule|workflow_call):/m);
  assert.match(text, /github\.ref == 'refs\/heads\/main'/);
  assert.match(text, /github\.repository == '0xMiden\/wallet'/);
  assert.match(text, /environment: wallet-store-publishing/);
  assert.match(text, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(text, /cancel-in-progress: false/);
});

test('workflow uses bounded OIDC credentials and never persists or archives authentication material', () => {
  const text = readFileSync(new URL('../../.github/workflows/publish-stores.yml', import.meta.url), 'utf8');
  assert.match(text, /uses: google-github-actions\/auth@v3/);
  assert.match(text, /service_account: bread-wallet-play-publisher@bread-wallet-publishing\.iam\.gserviceaccount\.com/);
  assert.match(
    text,
    /workload_identity_provider: projects\/538324806738\/locations\/global\/workloadIdentityPools\/wallet-publishing\/providers\/github/
  );
  assert.match(text, /access_token_scopes: https:\/\/www\.googleapis\.com\/auth\/androidpublisher/);
  assert.match(text, /create_credentials_file: false/);
  assert.match(text, /export_environment_variables: false/);
  assert.match(text, /WALLET_PLAY_ACCESS_TOKEN: \$\{\{ steps\.google_auth\.outputs\.access_token \}\}/);
  assert.match(text, /artifact-ids: \$\{\{ steps\.producer\.outputs\.artifact_id \}\}/);
  assert.match(text, /name: Preserve publication state/);
  assert.match(text, /publish-plan\.mjs export/);
  assert.doesNotMatch(text, /path:.*(?:private|credentials|\.p8|\.log)/);
});

async function workspace(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-publish-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = {
    RUNNER_TEMP: directory,
    GITHUB_REPOSITORY: '0xMiden/wallet',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ID: '99',
    GITHUB_RUN_ATTEMPT: '1',
    AUTOMATION_SHA: automationSha,
    RELEASE_TAG: input.releaseTag,
    SOURCE_SHA: sha,
    PLATFORM: 'chrome',
    STORE_ACTION: 'upload',
    NETWORK: 'testnet',
    PRODUCER_RUN_ID: '42',
    STATE_RUN_ID: '',
    BUILD_NUMBER: '',
    EDIT_ID: '',
    ACKNOWLEDGEMENT: 'none',
    PRODUCER_DIR: join(directory, 'producer'),
    SOURCE_DIR: join(directory, 'source'),
    CHROME_WEB_STORE_PUBLISHER_ID: 'publisher',
    CHROME_WEB_STORE_OAUTH_JSON: JSON.stringify({
      client_id: 'client',
      client_secret: 'private-secret',
      refresh_token: 'private-refresh',
      access_token: 'must-not-persist'
    }),
    ...extra
  };
  await mkdir(env.PRODUCER_DIR);
  const artifact = producerArtifact(
    validatePublishRequest({
      ...input,
      platform: env.PLATFORM,
      action: env.STORE_ACTION,
      producerRunId: env.PRODUCER_RUN_ID,
      buildNumber: env.BUILD_NUMBER
    })
  );
  const packaged = Buffer.from('verified artifact bytes');
  await writeFile(join(env.PRODUCER_DIR, artifact.file), packaged);
  await writeFile(join(env.PRODUCER_DIR, artifact.receiptFile), bytes(receipt({ sha256: digest(packaged) })));
  return { directory, env, artifact, packaged, root: join(directory, 'wallet-store-publishing') };
}

test('private configuration excludes access tokens and exports only validated publication evidence', async t => {
  const { env, root, packaged } = await workspace(t);
  await main('prepare', env);
  const config = JSON.parse(await readFile(join(root, 'config.json')));
  assert.equal((await stat(join(root, 'config.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(config.stateDir)).mode & 0o777, 0o700);
  const oauth = JSON.parse(await readFile(config.chrome.oauthPath));
  assert.equal(oauth.access_token, undefined);
  const plan = validatePublishRequest(input);
  const own = snapshot(plan, { attestation: { sha256: digest(packaged) } });
  await writeFile(join(config.stateDir, Object.keys(own.files)[0]), Object.values(own.files)[0]);
  await writeFile(join(config.stateDir, 'ios-upload-private.log'), 'secret provider output');
  await writeFile(join(config.stateDir, '.mutation.lock'), 'lock');
  await main('export', { ...env, OPERATION_OUTCOME: 'success' });
  const exported = await readdir(join(root, 'export'));
  assert.deepEqual(exported.sort(), [Object.keys(own.files)[0], 'manifest.json', 'result.json'].sort());
  assert.doesNotMatch(
    (await Promise.all(exported.map(name => readFile(join(root, 'export', name), 'utf8')))).join(''),
    /private-secret|private-refresh|secret provider/
  );
});

test('artifact checksum mismatch fails before credentials are materialized', async t => {
  const { env, root, artifact } = await workspace(t);
  await writeFile(join(env.PRODUCER_DIR, artifact.file), 'changed artifact');
  await assert.rejects(main('prepare', env), /checksum/);
  await assert.rejects(stat(join(root, 'config.json')), { code: 'ENOENT' });
});

test('mocked workflow execution preserves release status and strips arbitrary provider fields', async t => {
  const { env, root, artifact } = await workspace(t);
  await main('prepare', env);
  let args;
  await main('execute', env, {
    run: async value => {
      args = value;
      return {
        uploadState: 'SUCCEEDED',
        crxVersion: '1.17.7',
        published: false,
        publishedItemRevisionStatus: {
          state: 'PUBLISHED',
          distributionChannels: [{ crxVersion: '1.17.6', deployPercentage: 100, token: 'secret' }]
        },
        access_token: 'secret',
        logPath: '/private/provider.log'
      };
    }
  });
  assert.deepEqual(args.slice(0, 2), ['chrome', 'upload']);
  assert.equal(args[args.indexOf('--artifact') + 1], join(env.PRODUCER_DIR, artifact.file));
  const result = JSON.parse(await readFile(join(root, 'result.json')));
  assert.equal(result.uploadState, 'SUCCEEDED');
  assert.equal(result.published, false);
  assert.equal(result.publishedItemRevisionStatus.distributionChannels[0].crxVersion, '1.17.6');
  assert.doesNotMatch(JSON.stringify(result), /secret|provider.log/);
});

test('Chrome state restore binds a pending asynchronous journal to the exact producer without fabricating upload proof', () => {
  const plan = validatePublishRequest({ ...input, action: 'submit', stateRunId: '80' });
  const journal = {
    schemaVersion: 1,
    platform: 'chrome',
    identity: receipt().identity,
    storeId: receipt().identity,
    publisherId: 'publisher',
    version: plan.version,
    network: plan.network,
    sourceSha: sha,
    sha256: hash,
    state: 'accepted-async',
    acceptedAt: 1700000000
  };
  const name = `chrome-${journal.identity}-upload.json`;
  const previous = snapshot(plan);
  previous.files = { [name]: bytes(journal) };
  previous.manifest.files = [{ name, sha256: digest(previous.files[name]) }];
  previous.manifest.outcome = 'failure';
  const context = {
    run: run('state', { conclusion: 'failure' }),
    receipt: receipt(),
    publisherId: 'publisher',
    nowSeconds: 1700000010
  };
  const restored = validateStateSnapshot(plan, previous, context);
  assert.equal(restored[name].state, 'accepted-async');
  assert.equal(restored[name].uploaded, undefined);
  for (const extra of [
    { sha256: 'f'.repeat(64) },
    { publisherId: 'other' },
    { acceptedAt: 1700000100 },
    { acceptedAt: 1699900000 }
  ]) {
    const invalid = { ...journal, ...extra };
    const data = bytes(invalid);
    assert.throws(() =>
      validateStateSnapshot(
        plan,
        {
          ...previous,
          files: { [name]: data },
          manifest: { ...previous.manifest, files: [{ name, sha256: digest(data) }] }
        },
        context
      )
    );
  }
  assert.throws(() => validateStateSnapshot(plan, snapshot(plan), context), /journal|pending|failed/i);
});

test('failed workflow exports the exact pending Chrome journal without uploader logs or credentials', async t => {
  const { env, root, packaged } = await workspace(t);
  await main('prepare', env);
  const name = `chrome-${receipt().identity}-upload.json`;
  const journal = {
    schemaVersion: 1,
    platform: 'chrome',
    identity: receipt().identity,
    storeId: receipt().identity,
    publisherId: 'publisher',
    version: '1.17.7',
    network: 'testnet',
    sourceSha: sha,
    sha256: digest(packaged),
    state: 'accepted-async',
    acceptedAt: Math.floor(Date.now() / 1000),
    privateProviderOutput: 'must-not-export'
  };
  await writeFile(join(root, 'state', name), bytes(journal));
  await main('export', { ...env, OPERATION_OUTCOME: 'failure' });
  const exported = JSON.parse(await readFile(join(root, 'export', name)));
  assert.equal(exported.state, 'accepted-async');
  assert.equal(exported.sha256, digest(packaged));
  assert.equal(exported.uploaded, undefined);
  assert.equal(exported.privateProviderOutput, undefined);
  const manifest = JSON.parse(await readFile(join(root, 'export', 'manifest.json')));
  assert.equal(manifest.outcome, 'failure');
  assert.deepEqual(manifest.files, [{ name, sha256: digest(await readFile(join(root, 'export', name))) }]);
});

test('new Chrome upload may restore only a prior terminal journal and never its old upload attestation', () => {
  const priorPlan = validatePublishRequest({ ...input, action: 'release', stateRunId: '80' });
  const previous = snapshot(priorPlan);
  const journal = {
    schemaVersion: 1,
    platform: 'chrome',
    identity: receipt().identity,
    storeId: receipt().identity,
    publisherId: 'publisher',
    version: '1.17.7',
    network: 'testnet',
    sourceSha: sha,
    sha256: hash,
    state: 'submitted',
    acceptedAt: 1690000000,
    completedAt: 1690000005
  };
  const name = `chrome-${journal.identity}-upload.json`;
  previous.files[name] = bytes(journal);
  previous.manifest.files.push({ name, sha256: digest(previous.files[name]) });
  const plan = validatePublishRequest({ ...input, releaseTag: 'v1.17.8', sourceSha: 'd'.repeat(40), stateRunId: '80' });
  const context = {
    run: run('state'),
    receipt: receipt({ version: '1.17.8', sourceSha: plan.sourceSha, sha256: 'e'.repeat(64) }),
    publisherId: 'publisher',
    nowSeconds: 1700000010
  };
  const restored = validateStateSnapshot(plan, previous, context);
  assert.deepEqual(Object.keys(restored), [name]);
  assert.equal(restored[name].version, '1.17.7');
  for (const state of ['request-started', 'accepted-async', 'submission-requested']) {
    const data = bytes({ ...journal, state });
    const bad = {
      ...previous,
      files: { ...previous.files, [name]: data },
      manifest: {
        ...previous.manifest,
        files: previous.manifest.files.map(file => (file.name === name ? { name, sha256: digest(data) } : file))
      }
    };
    assert.throws(() => validateStateSnapshot(plan, bad, context));
  }
});

test('workflow state selection accepts exactly the explicit prior Chrome run artifact before rollover validation', async t => {
  const { directory, env } = await workspace(t);
  env.RELEASE_TAG = 'v1.17.8';
  env.SOURCE_SHA = 'd'.repeat(40);
  env.STATE_RUN_ID = '80';
  env.STATE_RUN_FILE = join(directory, 'state-run.json');
  env.STATE_ARTIFACTS_FILE = join(directory, 'state-artifacts.json');
  env.GITHUB_OUTPUT = join(directory, 'outputs');
  const artifact = {
    id: 123,
    name: 'WalletStoreState-chrome-1.17.7-testnet-80-1',
    expired: false,
    workflow_run: { id: 80 }
  };
  await writeFile(env.STATE_RUN_FILE, bytes(run('state')));
  await writeFile(env.STATE_ARTIFACTS_FILE, bytes({ total_count: 1, artifacts: [artifact] }));
  await main('state-run', env);
  assert.match(await readFile(env.GITHUB_OUTPUT, 'utf8'), /artifact_id=123/);
  await writeFile(
    env.STATE_ARTIFACTS_FILE,
    bytes({
      total_count: 2,
      artifacts: [artifact, { ...artifact, id: 124, name: 'WalletStoreState-chrome-1.17.6-testnet-80-1' }]
    })
  );
  await assert.rejects(main('state-run', env), /Exactly one/);
});

test('screenshot sync is a separate source-bound metadata action and Android requires the restored caller edit', () => {
  const ios = validatePublishRequest({ ...input, platform: 'ios', action: 'sync-screenshots', producerRunId: '' });
  assert.equal(ios.needsProducer, false);
  assert.equal(ios.needsState, false);
  assert.equal(ios.buildNumber, undefined);
  const android = validatePublishRequest({
    ...input,
    platform: 'android',
    action: 'sync-screenshots',
    producerRunId: '',
    stateRunId: '80',
    editId: 'edit-1'
  });
  assert.equal(android.needsState, true);
  assert.equal(android.versionCode, undefined);
  for (const extra of [{ stateRunId: '' }, { editId: '' }, { producerRunId: '42' }])
    assert.throws(() =>
      validatePublishRequest({
        ...input,
        platform: 'android',
        action: 'sync-screenshots',
        producerRunId: '',
        stateRunId: '80',
        editId: 'edit-1',
        ...extra
      })
    );
});

test('publishing workflow exposes explicit sync while pinning screenshot root to source checkout', () => {
  const text = readFileSync(new URL('../../.github/workflows/publish-stores.yml', import.meta.url), 'utf8');
  assert.match(text, /options:.*sync-screenshots/);
  assert.doesNotMatch(text, /^ {6}(screenshots_root|manifest_path):/m);
});

test('Android metadata sync restores only its edit without requiring a native build attestation', () => {
  const plan = validatePublishRequest({
    ...input,
    platform: 'android',
    action: 'sync-screenshots',
    producerRunId: '',
    stateRunId: '80',
    editId: 'edit-1'
  });
  const original = { ...plan, buildNumber: '19', versionCode: 11707019 };
  const edit = {
    packageName: 'com.miden.wallet',
    editId: 'edit-1',
    version: plan.version,
    sourceSha: sha,
    network: plan.network,
    expiryTimeSeconds: '2000000000'
  };
  const previous = snapshot(original, { edit });
  const restored = validateStateSnapshot(plan, previous, { run: run('state'), nowSeconds: 1700000010 });
  assert.deepEqual(Object.keys(restored), ['android-edit.json']);
  const editBytes = bytes(edit);
  const metadataState = {
    ...previous,
    files: { 'android-edit.json': editBytes },
    manifest: {
      ...previous.manifest,
      intent: { ...previous.manifest.intent, buildNumber: undefined },
      files: [{ name: 'android-edit.json', sha256: digest(editBytes) }]
    }
  };
  const upload = validatePublishRequest({
    ...input,
    platform: 'android',
    action: 'upload',
    buildNumber: '19',
    stateRunId: '80',
    editId: 'edit-1'
  });
  assert.equal(
    validateStateSnapshot(upload, metadataState, { run: run('state'), nowSeconds: 1700000010 })['android-edit.json']
      .editId,
    'edit-1'
  );
});

test('Android read-only edit status requires exact producer and prior state even after expiry', () => {
  const intent = {
    ...input,
    platform: 'android',
    action: 'status',
    buildNumber: '19',
    editId: 'edit-1',
    stateRunId: '80'
  };
  const plan = validatePublishRequest(intent);
  assert.equal(plan.needsProducer, true);
  assert.equal(plan.needsState, true);
  assert.throws(() => validatePublishRequest({ ...intent, producerRunId: '' }));
  assert.throws(() => validatePublishRequest({ ...intent, stateRunId: '' }));
  const edit = {
    packageName: 'com.miden.wallet',
    editId: 'edit-1',
    version: plan.version,
    network: plan.network,
    sourceSha: sha,
    expiryTimeSeconds: '1'
  };
  const previous = snapshot(plan, { edit, extraManifest: { outcome: 'failure' } });
  assert.equal(
    validateStateSnapshot(plan, previous, {
      run: run('state', { conclusion: 'failure' }),
      receipt: receipt({ platform: 'android', identity: 'com.miden.wallet', versionCode: plan.versionCode }),
      nowSeconds: 999
    })['android-edit.json'].editId,
    'edit-1'
  );
});

test('workflow persists only safe stage/status failure metadata before rejecting', async t => {
  const { env, root } = await workspace(t);
  await main('prepare', env);
  const failure = Object.assign(new Error('secret provider body'), {
    stage: 'play-submit-track-update',
    status: 403,
    apiStatus: 'PERMISSION_DENIED',
    apiReasons: ['forbidden', 'secret-body']
  });
  await assert.rejects(
    main('execute', env, {
      run: async () => {
        throw failure;
      }
    })
  );
  const result = JSON.parse(await readFile(join(root, 'result.json')));
  assert.deepEqual(result.failure, {
    stage: 'play-submit-track-update',
    httpStatus: 403,
    apiStatus: 'PERMISSION_DENIED',
    apiReasons: ['forbidden']
  });
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test('edit inspection execute/export retains exact bounded numeric version codes', async t => {
  const { env, root } = await workspace(t);
  await main('prepare', env);
  await main('execute', env, {
    run: async () => ({
      editInspection: {
        id: 'edit-1',
        expiryTimeSeconds: '1',
        releases: [{ name: '1.17.7', status: 'completed', versionCodes: ['11707019', 'secret-token', 11707020] }]
      }
    })
  });
  await main('export', { ...env, OPERATION_OUTCOME: 'success' });
  const result = JSON.parse(await readFile(join(root, 'export/result.json')));
  const manifest = JSON.parse(await readFile(join(root, 'export/manifest.json')));
  assert.deepEqual(result.editInspection.releases[0].versionCodes, ['11707019']);
  assert.deepEqual(manifest.result, result);
  assert.doesNotMatch(JSON.stringify(result), /secret-token/);
});

test('release notes are optional exact text for iOS submit only', () => {
  const request = {
    ...input,
    platform: 'ios',
    action: 'submit',
    producerRunId: '42',
    stateRunId: '80',
    buildNumber: '19'
  };
  assert.equal(validatePublishRequest({ ...request, releaseNotes: '' }).releaseNotes, 'Various Fixes & Improvements');
  const releaseNotes = 'Recovery improvements.\nBug fixes.';
  assert.equal(validatePublishRequest({ ...request, releaseNotes }).releaseNotes, releaseNotes);
  for (const change of [
    { platform: 'chrome', buildNumber: '' },
    { action: 'upload' },
    { releaseNotes: ' ' },
    { releaseNotes: 'x'.repeat(4001) },
    { releaseNotes: 'a\0b' }
  ]) {
    assert.throws(() => validatePublishRequest({ ...request, releaseNotes, ...change }), /release notes/i);
  }
});

test('workflow forwards iOS submit release notes as one exact argument', async t => {
  const { env } = await workspace(t);
  Object.assign(env, {
    PLATFORM: 'ios',
    STORE_ACTION: 'submit',
    STATE_RUN_ID: '80',
    BUILD_NUMBER: '19',
    RELEASE_NOTES: 'Guardian improvements.\nBug fixes.'
  });
  let args;
  await main('execute', env, {
    run: async value => {
      args = value;
      return { platform: 'ios', state: 'WAITING_FOR_REVIEW' };
    }
  });
  const index = args.indexOf('--release-notes');
  assert.ok(index >= 0);
  assert.equal(args[index + 1], env.RELEASE_NOTES);
});

test('the notes fallback is scoped to iOS submit and leaves other default actions untouched', () => {
  for (const change of [
    {},
    { action: 'status', producerRunId: '' },
    { platform: 'android', action: 'status', producerRunId: '' },
    { platform: 'ios', action: 'prepare', producerRunId: '' },
    { platform: 'ios', action: 'upload', buildNumber: '19' }
  ]) {
    const plan = validatePublishRequest({ ...input, ...change, releaseNotes: '' });
    assert.equal(plan.releaseNotes, undefined);
  }
});

test('iOS prepare and screenshot sync optionally restore an exact prior state run', () => {
  for (const action of ['prepare', 'sync-screenshots']) {
    const request = { ...input, platform: 'ios', action, producerRunId: '', stateRunId: '80' };
    assert.equal(validatePublishRequest(request).needsState, true);
    assert.equal(validatePublishRequest({ ...request, stateRunId: '' }).needsState, false);
  }
});

function iosScreenshotJournal(version = '1.17.7') {
  return {
    schemaVersion: 1,
    binding: {
      appId: '6789341854',
      bundleId: 'com.miden.bread',
      version,
      network: 'testnet',
      sourceSha: sha,
      manifestSha256: 'b'.repeat(64)
    },
    versionId: 'draft',
    pending: null,
    groups: [
      {
        locale: 'en-US',
        displayType: 'APP_IPHONE_67',
        localizationId: 'locale',
        setId: 'large',
        desired: ['d'.repeat(64)],
        original: [],
        images: [],
        owned: []
      }
    ]
  };
}
test('failed iOS screenshot state restores exact journal without fabricating binary upload evidence', () => {
  for (const action of ['prepare', 'sync-screenshots']) {
    const plan = validatePublishRequest({ ...input, platform: 'ios', action, producerRunId: '', stateRunId: '80' });
    const previous = snapshot(plan, { extraManifest: { action, outcome: 'failure' } });
    const name = 'ios-6789341854-1.17.7-screenshots.json';
    previous.files = { [name]: bytes(iosScreenshotJournal()) };
    previous.manifest.files = [{ name, sha256: digest(previous.files[name]) }];
    const context = { run: run('state', { conclusion: 'failure' }) };
    assert.deepEqual(validateStateSnapshot(plan, previous, context), { [name]: iosScreenshotJournal() });
    const submit = validatePublishRequest({
      ...input,
      platform: 'ios',
      action: 'submit',
      stateRunId: '80',
      buildNumber: '19'
    });
    assert.throws(() => validateStateSnapshot(submit, previous, context), /manifest|attestation|release/i);
    const bad = iosScreenshotJournal();
    bad.binding.sourceSha = 'f'.repeat(40);
    const data = bytes(bad);
    assert.throws(
      () =>
        validateStateSnapshot(
          plan,
          {
            ...previous,
            files: { [name]: data },
            manifest: { ...previous.manifest, files: [{ name, sha256: digest(data) }] }
          },
          context
        ),
      /journal/
    );
  }
});
test('failed iOS workflow exports only validated screenshot recovery evidence', async t => {
  const { env, root } = await workspace(t);
  await main('prepare', env);
  const iosEnv = {
    ...env,
    PLATFORM: 'ios',
    STORE_ACTION: 'prepare',
    PRODUCER_RUN_ID: '',
    OPERATION_OUTCOME: 'failure'
  };
  const name = 'ios-6789341854-1.17.7-screenshots.json';
  await writeFile(join(root, 'state', name), bytes(iosScreenshotJournal()));
  await writeFile(join(root, 'state', 'private-provider.log'), 'must-not-export');
  await main('export', iosEnv);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'export', name))), iosScreenshotJournal());
  const manifest = JSON.parse(await readFile(join(root, 'export', 'manifest.json')));
  assert.equal(manifest.outcome, 'failure');
  assert.deepEqual(manifest.files, [{ name, sha256: digest(await readFile(join(root, 'export', name))) }]);
  const invalid = iosScreenshotJournal();
  invalid.privateUploadUrl = 'https://blob.apple.com/private';
  await writeFile(join(root, 'state', name), bytes(invalid));
  await assert.rejects(main('export', iosEnv), /journal/);
});

test('iOS metadata recovery restores a submit journal across the absent build number boundary', () => {
  const submit = validatePublishRequest({
    ...input,
    platform: 'ios',
    action: 'submit',
    stateRunId: '80',
    buildNumber: '19'
  });
  const previous = snapshot(submit, { extraManifest: { action: 'submit', outcome: 'failure' } });
  const name = 'ios-6789341854-1.17.7-screenshots.json';
  previous.files[name] = bytes(iosScreenshotJournal());
  previous.manifest.files = Object.entries(previous.files).map(([name, value]) => ({ name, sha256: digest(value) }));
  const context = { run: run('state', { conclusion: 'failure' }) };
  for (const action of ['prepare', 'sync-screenshots']) {
    const metadata = validatePublishRequest({ ...input, platform: 'ios', action, producerRunId: '', stateRunId: '80' });
    assert.deepEqual(validateStateSnapshot(metadata, previous, context), { [name]: iosScreenshotJournal() });
    const wrongBuild = validatePublishRequest({ ...metadata, buildNumber: '20' });
    assert.throws(() => validateStateSnapshot(wrongBuild, previous, context), /manifest|artifact|release/);
    const invalid = structuredClone(previous);
    invalid.manifest.intent.buildNumber = '0';
    assert.throws(() => validateStateSnapshot(metadata, invalid, context), /build|manifest|release/);
  }
  const missingAttestation = structuredClone(previous);
  missingAttestation.files = { [name]: previous.files[name] };
  missingAttestation.manifest.files = [{ name, sha256: digest(previous.files[name]) }];
  assert.throws(() => validateStateSnapshot(submit, missingAttestation, context), /attestation/);
});

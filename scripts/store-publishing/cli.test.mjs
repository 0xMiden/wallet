import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as chromeOperations from './chrome.mjs';

let cli = {};
try {
  cli = await import('./cli.mjs');
} catch {}

const sha = '1'.repeat(40);
const bytes = new Uint8Array([1, 2, 3]);
const hash = createHash('sha256').update(bytes).digest('hex');
const item = 'coajhopfooegmaifelglfboehacldcbo';
const config = {
  apple: {
    appId: '6789341854',
    bundleId: 'com.miden.bread',
    keyId: 'APPLEKEY',
    issuerId: 'issuer',
    keyPath: '/private/apple.p8'
  },
  chrome: {
    publisherId: 'publisher',
    items: { testnet: item, devnet: 'eeghndabgeicdpkbcohgglidpfpiafnb' },
    oauthPath: '/private/chrome.json'
  },
  play: { packageName: 'com.miden.wallet', serviceAccountPath: '/private/play.json', developerId: '123456' }
};
const common = ['--version', '1.17.7', '--network', 'testnet', '--source-sha', sha];
const provenance = { version: '1.17.7', network: 'testnet', sourceSha: sha, mode: 'production' };

function context(platform = 'chrome', overrides = {}) {
  const calls = [];
  const identity = platform === 'chrome' ? item : platform === 'ios' ? config.apple.bundleId : config.play.packageName;
  const receipt = {
    platform,
    version: '1.17.7',
    network: 'testnet',
    sourceSha: sha,
    sha256: hash,
    identity,
    buildNumber: '19',
    versionCode: 11707001
  };
  const metadata =
    platform === 'chrome'
      ? { platform, name: 'Bread Wallet by Miden', version: '1.17.7', identity: null, provenance }
      : platform === 'ios'
        ? { platform, identity, version: '1.17.7', buildNumber: '19', deviceBuild: true, provenance }
        : { platform, provenance };
  const client = {
    request: async (...args) => {
      calls.push(['request', ...args]);
      return { id: 'edit-1', expiryTimeSeconds: '2000000000' };
    }
  };
  const attestation = {
    schemaVersion: 1,
    platform,
    identity,
    storeId: platform === 'ios' ? config.apple.appId : identity,
    version: '1.17.7',
    network: 'testnet',
    sourceSha: sha,
    sha256: hash,
    buildNumber: platform === 'ios' ? '19' : undefined,
    versionCode: platform === 'android' ? 11707001 : undefined,
    editId: platform === 'android' ? 'edit-1' : undefined,
    publisherId: platform === 'chrome' ? config.chrome.publisherId : undefined,
    uploaded: true
  };
  const deps = {
    readConfig: async () => structuredClone(config),
    verifyScreenshotSource: async () => {},
    loadScreenshotManifest: async () => ({
      schemaVersion: 1,
      sets: [
        {
          platform,
          storeId: platform === 'ios' ? config.apple.appId : identity,
          locale: 'en-US',
          displayType: 'fixture',
          images: [{ path: 'store-listing/fixture.png', sha256: hash, size: bytes.length, bytes }]
        }
      ]
    }),
    readArtifact: async () => bytes,
    readReceipt: async () => structuredClone(receipt),
    inspectArtifact: async (...args) => {
      calls.push(['inspect', ...args]);
      return structuredClone(metadata);
    },
    readPrivateKey: async () => {
      calls.push(['privateKey']);
      return Buffer.from('private-key');
    },
    auth: {
      loadPrivateJson: async path => {
        calls.push(['credentials', path]);
        return { refresh_token: 'private-refresh' };
      },
      createAppleToken: () => {
        calls.push(['appleToken']);
        return 'private-token';
      },
      googleAccessToken: async (...args) => {
        calls.push(['googleToken', ...args]);
        return 'private-token';
      },
      createApiClient: options => {
        calls.push(['client', options]);
        return client;
      }
    },
    withMutationLock: async (path, operation) => {
      calls.push(['lock', path]);
      return operation();
    },
    persistEdit: async (...args) => {
      calls.push(['persist', ...args]);
    },
    loadAttestation: async () => structuredClone(attestation),
    loadChromeUpload: async () => undefined,
    persistChromeUpload: async (...args) => {
      calls.push(['chromeUpload', ...args]);
    },
    nowSeconds: () => 1700000010,
    persistAttestation: async (...args) => {
      calls.push(['attestation', ...args]);
    },
    uploadIpa: async (...args) => {
      calls.push(['uploadIpa', ...args]);
    },
    operations: Object.fromEntries(
      ['chrome', 'ios', 'android'].map(name => [
        name,
        Object.fromEntries(
          ['status', 'upload', 'submit', 'release'].map(action => [
            action,
            async (client, options) => {
              calls.push(['operation', name, action, options]);
              if (name === 'ios' && action === 'upload') await client.uploadIpa(options);
              return { platform: name, action, accepted: true };
            }
          ])
        )
      ])
    )
  };
  return { calls, receipt, metadata, client, attestation, deps: { ...deps, ...overrides } };
}

const artifactArgs = ['--artifact', '/artifacts/wallet.zip', '--receipt', '/artifacts/receipt.json'];
const run = (...args) => {
  assert.equal(typeof cli.run, 'function', 'Publishing CLI must be implemented');
  if (
    args[0].includes('1.17.7') &&
    !args[0].includes('--preserve-legacy-screenshots') &&
    !args[0].includes('--screenshots-root')
  )
    args[0] = [...args[0], '--preserve-legacy-screenshots'];
  if (args[0].includes('1.17.8') && !args[0].includes('--screenshots-root'))
    args[0] = [...args[0], '--screenshots-root', '/release/source'];
  return cli.run(...args);
};

test('argument parsing rejects unknown flags, duplicate values and store identity overrides', () => {
  assert.equal(typeof cli.parseArgs, 'function', 'CLI argument parser must be implemented');
  for (const args of [
    ['chrome', 'upload', '--app-id', 'other'],
    ['ios', 'status', '--version', '1', '--version', '2'],
    ['chrome', 'upload', '--artifact']
  ]) {
    assert.throws(() => cli.parseArgs(args));
  }
});

test('status chooses only configured store identity and uses fixed origin and scope', async () => {
  const c = context();
  await run(['chrome', 'status', '--network', 'testnet'], c.deps);
  assert.equal(c.calls.find(call => call[0] === 'client')[1].origin, 'https://chromewebstore.googleapis.com');
  assert.equal(c.calls.find(call => call[0] === 'googleToken')[2], 'https://www.googleapis.com/auth/chromewebstore');
  assert.equal(c.calls.find(call => call[0] === 'operation')[3].itemId, item);
  assert.equal(c.calls.filter(call => call[0] === 'lock').length, 0);
});

test('dry run validates bytes, receipt and embedded provenance without auth, lock or store operations', async () => {
  const c = context();
  const result = await run(['chrome', 'upload', ...common, ...artifactArgs, '--dry-run'], c.deps);
  assert.equal(result.dryRun, true);
  assert.equal(result.sha256, hash);
  assert.equal(result.identity, item);
  assert.deepEqual(
    c.calls.map(call => call[0]),
    ['inspect']
  );
});

test('mutations require exact confirmation, stable version, network and full source revision before auth', async () => {
  for (const replacement of [
    [...common],
    [...common, '--confirm', '1.17.6'],
    ['--version', '1.17.7-rc.1', '--network', 'testnet', '--source-sha', sha, '--confirm', '1.17.7-rc.1'],
    ['--version', '1.17.7', '--source-sha', sha, '--confirm', '1.17.7'],
    ['--version', '1.17.7', '--network', 'testnet', '--source-sha', '1234567', '--confirm', '1.17.7']
  ]) {
    const c = context();
    await assert.rejects(() => run(['chrome', 'release', ...replacement], c.deps));
    assert.equal(c.calls.length, 0);
  }
});

test('Devnet mobile mutations are refused even with exact confirmation', async () => {
  const c = context('android');
  await assert.rejects(
    () =>
      run(
        [
          'android',
          'upload',
          '--version',
          '1.17.7',
          '--network',
          'devnet',
          '--source-sha',
          sha,
          '--version-code',
          '11707001',
          '--edit-id',
          'edit-1',
          '--confirm',
          '1.17.7',
          ...artifactArgs
        ],
        c.deps
      ),
    /Devnet/
  );
  assert.equal(c.calls.length, 0);
});

for (const field of ['platform', 'version', 'network', 'sourceSha', 'sha256', 'identity']) {
  test(`artifact receipt mismatch ${field} fails before authentication`, async () => {
    const c = context();
    c.deps.readReceipt = async () => ({ ...c.receipt, [field]: 'wrong' });
    await assert.rejects(
      () => run(['chrome', 'upload', ...common, '--confirm', '1.17.7', ...artifactArgs], c.deps),
      /receipt|checksum/
    );
    assert.ok(c.calls.every(call => call[0] === 'inspect'));
  });
}

for (const marker of [
  undefined,
  { ...provenance, sourceSha: '2'.repeat(40) },
  { ...provenance, network: 'devnet' },
  { ...provenance, mode: 'development' }
]) {
  test(`missing or mismatched embedded provenance is rejected ${JSON.stringify(marker)}`, async () => {
    const c = context();
    c.deps.inspectArtifact = async () => ({ ...c.metadata, provenance: marker });
    await assert.rejects(
      () => run(['chrome', 'upload', ...common, '--confirm', '1.17.7', ...artifactArgs], c.deps),
      /provenance/
    );
    assert.equal(c.calls.length, 0);
  });
}

test('actual Chrome package branding, version and optional public-key identity are verified', async () => {
  for (const extra of [{ name: 'Another extension' }, { version: '1.17.6' }, { identity: 'c'.repeat(32) }]) {
    const c = context();
    c.deps.inspectArtifact = async () => ({ ...c.metadata, ...extra });
    await assert.rejects(
      () => run(['chrome', 'upload', ...common, '--confirm', '1.17.7', ...artifactArgs], c.deps),
      /artifact/
    );
    assert.equal(c.calls.length, 0);
  }
});

test('Chrome submission requires the same artifact attestation as upload', async () => {
  const c = context();
  await assert.rejects(() => run(['chrome', 'submit', ...common, '--confirm', '1.17.7'], c.deps), /artifact|receipt/);
  await run(['chrome', 'submit', ...common, '--confirm', '1.17.7', ...artifactArgs], c.deps);
  assert.deepEqual(c.calls.find(call => call[0] === 'operation').slice(1, 3), ['chrome', 'submit']);
  assert.equal(c.calls.find(call => call[0] === 'operation')[3].artifact, bytes);
});

test('iOS binary identity, build, device platform and receipt build must agree', async () => {
  for (const extra of [{ identity: 'other.app' }, { buildNumber: '20' }, { deviceBuild: false }]) {
    const c = context('ios');
    c.deps.inspectArtifact = async () => ({ ...c.metadata, ...extra });
    await assert.rejects(
      () =>
        run(
          [
            'ios',
            'upload',
            ...common,
            '--build-number',
            '19',
            '--confirm',
            '1.17.7',
            '--artifact',
            '/artifacts/wallet.ipa',
            '--receipt',
            '/artifacts/receipt.json'
          ],
          c.deps
        ),
      /artifact/
    );
    assert.equal(c.calls.length, 0);
  }
});

test('Apple upload delegates only verified immutable bytes and configured key credentials', async () => {
  const c = context('ios');
  await run(
    [
      'ios',
      'upload',
      ...common,
      '--build-number',
      '19',
      '--confirm',
      '1.17.7',
      '--artifact',
      '/artifacts/wallet.ipa',
      '--receipt',
      '/artifacts/receipt.json'
    ],
    c.deps
  );
  const upload = c.calls.find(call => call[0] === 'uploadIpa')[1];
  assert.equal(upload.bytes, bytes);
  assert.equal(upload.apple.keyId, config.apple.keyId);
  assert.equal(upload.apple.issuerId, config.apple.issuerId);
  assert.equal(upload.key.toString(), 'private-key');
  assert.equal(c.calls.find(call => call[0] === 'client')[1].origin, 'https://api.appstoreconnect.apple.com');
});

test('Android draft upload keeps caller edit ID and exact code and verifies embedded source marker', async () => {
  const c = context('android');
  await run(
    [
      'android',
      'upload',
      ...common,
      '--version-code',
      '11707001',
      '--edit-id',
      'edit-1',
      '--confirm',
      '1.17.7',
      ...artifactArgs
    ],
    c.deps
  );
  const operation = c.calls.find(call => call[0] === 'operation')[3];
  assert.equal(operation.packageName, 'com.miden.wallet');
  assert.equal(operation.versionCode, 11707001);
  assert.equal(operation.editId, 'edit-1');
  assert.equal(operation.artifact, bytes);
});

test('Play begin-edit is separate, explicitly confirmed and persisted with source identity', async () => {
  const c = context('android');
  await assert.rejects(
    () => run(['android', 'begin-edit', ...common, '--confirm', '1.17.7'], c.deps),
    /confirm-new-edit/
  );
  assert.equal(c.calls.length, 0);
  const result = await run(['android', 'begin-edit', ...common, '--confirm', '1.17.7', '--confirm-new-edit'], c.deps);
  assert.equal(result.editId, 'edit-1');
  assert.equal(result.warning.includes('invalidates'), true);
  assert.equal(
    c.calls.find(call => call[0] === 'request')[2],
    '/androidpublisher/v3/applications/com.miden.wallet/edits'
  );
  const saved = c.calls.find(call => call[0] === 'persist')[2];
  assert.equal(saved.editId, 'edit-1');
  assert.equal(saved.sourceSha, sha);
  assert.equal(saved.packageName, config.play.packageName);
});

test('Play submit requires pending-change acknowledgement before authentication', async () => {
  const c = context('android');
  const args = [
    'android',
    'submit',
    ...common,
    '--version-code',
    '11707001',
    '--edit-id',
    'edit-1',
    '--confirm',
    '1.17.7'
  ];
  await assert.rejects(() => run(args, c.deps), /allow-pending-changes/);
  assert.equal(c.calls.length, 0);
  await run([...args, '--allow-pending-changes'], c.deps);
  assert.equal(c.calls.find(call => call[0] === 'operation')[3].allowPendingChanges, true);
});

test('unmapped mainnet Chrome and retired extension targets are never selected implicitly', async () => {
  const c = context();
  await assert.rejects(() => run(['chrome', 'status', '--network', 'mainnet'], c.deps), /configured/);
  c.deps.readConfig = async () => ({
    ...config,
    chrome: { ...config.chrome, items: { testnet: 'ablmompanofnodfdkgchkpmphailefpb' } }
  });
  await assert.rejects(() => run(['chrome', 'status', '--network', 'testnet'], c.deps), /retired|target/);
  assert.equal(c.calls.length, 0);
});

test('only the explicit Bread network allowlist can select a Chrome target', async () => {
  for (const [network, target] of [
    ['testnet', 'a'.repeat(32)],
    ['devnet', item],
    ['mainnet', item]
  ]) {
    const c = context();
    c.deps.readConfig = async () => ({ ...config, chrome: { ...config.chrome, items: { [network]: target } } });
    await assert.rejects(() => run(['chrome', 'status', '--network', network], c.deps), /target|configured/);
    assert.equal(c.calls.length, 0);
  }
});

test('dry-run release still requires matching earlier upload evidence without authenticating', async () => {
  const c = context('ios');
  c.deps.loadAttestation = async () => undefined;
  await assert.rejects(
    () => run(['ios', 'release', ...common, '--build-number', '19', '--dry-run'], c.deps),
    /attestation/
  );
  assert.equal(c.calls.length, 0);
});

test('submission and release require earlier upload evidence bound to the exact binary and source', async () => {
  for (const extra of [
    { sourceSha: '2'.repeat(40) },
    { network: 'mainnet' },
    { sha256: 'bad' },
    { identity: 'wrong' },
    { buildNumber: '20' },
    { uploaded: false }
  ]) {
    const c = context('ios');
    c.deps.loadAttestation = async () => ({ ...c.attestation, ...extra });
    await assert.rejects(
      () => run(['ios', 'release', ...common, '--build-number', '19', '--confirm', '1.17.7'], c.deps),
      /attestation/
    );
    assert.ok(c.calls.every(call => call[0] === 'lock'));
  }
  const c = context('ios');
  c.deps.loadAttestation = async () => undefined;
  await assert.rejects(
    () => run(['ios', 'submit', ...common, '--build-number', '19', '--confirm', '1.17.7'], c.deps),
    /attestation|upload/
  );
});

test('a verified upload persists nonsecret source-bound evidence for later release', async () => {
  const c = context('android');
  await run(
    [
      'android',
      'upload',
      ...common,
      '--version-code',
      '11707001',
      '--edit-id',
      'edit-1',
      '--confirm',
      '1.17.7',
      ...artifactArgs
    ],
    c.deps
  );
  const evidence = c.calls.find(call => call[0] === 'attestation')[2];
  assert.equal(evidence.sha256, hash);
  assert.equal(evidence.sourceSha, sha);
  assert.equal(evidence.versionCode, 11707001);
  assert.equal(evidence.uploaded, true);
  assert.doesNotMatch(JSON.stringify(evidence), /private-refresh|private-token|private-key/);
});

test('an accepted upload with a failed local attestation save reports the external effect and forbids blind retry', async () => {
  const c = context();
  c.deps.persistAttestation = async () => {
    throw new Error('private-token');
  };
  await assert.rejects(
    () => run(['chrome', 'upload', ...common, '--confirm', '1.17.7', ...artifactArgs], c.deps),
    error => {
      assert.match(error.message, /accepted|completed/);
      assert.match(error.message, /retry/);
      assert.doesNotMatch(error.message, /private-token/);
      return true;
    }
  );
  assert.equal(c.calls.filter(call => call[0] === 'operation').length, 1);
});

test('a new explicitly created Play edit can reupload identical evidence but cannot submit another edit upload', async () => {
  const c = context('android');
  c.deps.loadAttestation = async () => ({ ...c.attestation, editId: 'expired-edit' });
  const args = [...common, '--version-code', '11707001', '--edit-id', 'edit-1', '--confirm', '1.17.7'];
  await run(['android', 'upload', ...args, ...artifactArgs], c.deps);
  assert.equal(c.calls.find(call => call[0] === 'attestation')[2].editId, 'edit-1');
  await assert.rejects(
    () => run(['android', 'submit', ...args, '--allow-pending-changes'], c.deps),
    /attestation editId/
  );
});

test('Play uses a short-lived CI token without loading or creating a service-account key', async () => {
  const c = context('android');
  c.deps.readConfig = async () => ({ ...config, play: { ...config.play, serviceAccountPath: undefined } });
  c.deps.env = { WALLET_PLAY_ACCESS_TOKEN: 'private-short-lived-token' };
  c.deps.auth.loadPrivateJson = async () => assert.fail('No credential file may be loaded for a CI token');
  c.deps.auth.googleAccessToken = async () => assert.fail('No credential exchange is needed for a CI token');
  const result = await run(['android', 'status'], c.deps);
  const apiClient = c.calls.find(call => call[0] === 'client')[1];
  assert.equal(apiClient.origin, 'https://androidpublisher.googleapis.com');
  assert.equal(apiClient.token, 'private-short-lived-token');
  assert.doesNotMatch(JSON.stringify(result), /private-short-lived-token/);
});

test('iOS prepare dispatches the draft skeleton operation without a build or artifact', async () => {
  const c = context('ios');
  c.deps.operations.ios.prepare = async (client, options) => {
    c.calls.push(['prepare', options]);
    return { state: 'EXISTING_DRAFT_REUSED' };
  };
  const result = await run(['ios', 'prepare', ...common, '--confirm', '1.17.7'], c.deps);
  assert.equal(result.state, 'EXISTING_DRAFT_REUSED');
  assert.equal(c.calls.find(call => call[0] === 'prepare')[1].version, '1.17.7');
  assert.equal(c.calls.filter(call => call[0] === 'inspect').length, 0);
});

test('official uploader freezes the bytes and key privately and redacts process output from errors', async t => {
  assert.equal(typeof cli.uploadIpa, 'function', 'Official uploader must be implemented');
  const directory = await mkdtemp(join(tmpdir(), 'store-uploader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = Buffer.from('private-key');
  let staged;
  const runner = async (command, args) => {
    assert.equal(command, 'xcrun');
    assert.equal(args[0], 'altool');
    assert.ok(args.includes('--upload-app'));
    assert.ok(args.includes('--api-key'));
    assert.ok(args.includes('--api-issuer'));
    staged = args[args.indexOf('-f') + 1];
    assert.deepEqual(await readFile(staged), Buffer.from(bytes));
    const keyPath = args[args.indexOf('--p8-file-path') + 1];
    assert.deepEqual(await readFile(keyPath), key);
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
    throw Object.assign(new Error('private-token'), { stdout: 'private-token', stderr: 'ERROR upload failed' });
  };
  await assert.rejects(
    () => cli.uploadIpa({ bytes, key, apple: config.apple, stateDir: directory }, { runner }),
    error => {
      assert.doesNotMatch(error.message, /private-token/);
      assert.match(error.message, /private upload log/);
      return true;
    }
  );
  await assert.rejects(readFile(staged), /ENOENT/);
});

test('uploader error details are failures even when its process exits successfully', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'store-uploader-errors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const output of [
    { stdout: '{"product-errors":[{"message":"private-token"}]}', stderr: '' },
    { stdout: '{"errors":{"message":"private-token"}}', stderr: '' },
    { stdout: '{"success-message":"Uploaded"}', stderr: '2026-10-25 ERROR: private-token' }
  ]) {
    await assert.rejects(
      () =>
        cli.uploadIpa(
          { bytes, key: Buffer.from('key'), apple: config.apple, stateDir: directory },
          { runner: async () => output }
        ),
      error => {
        assert.match(error.message, /private upload log/);
        assert.doesNotMatch(error.message, /private-token/);
        return true;
      }
    );
  }
});

test('iOS submit preserves release policy by default and passes only explicit supported overrides', async () => {
  for (const releasePolicy of ['preserve-existing', 'manual', 'after-approval']) {
    const c = context('ios');
    const override = releasePolicy === 'preserve-existing' ? [] : ['--release-policy', releasePolicy];
    await run(['ios', 'submit', ...common, '--build-number', '19', '--confirm', '1.17.7', ...override], c.deps);
    assert.equal(c.calls.find(call => call[0] === 'operation')[3].releasePolicy, releasePolicy);
  }
});

test('release policy rejects unsupported values and actions before authentication', async () => {
  for (const [platform, action, policy] of [
    ['ios', 'submit', 'automatic'],
    ['ios', 'release', 'manual'],
    ['ios', 'upload', 'after-approval'],
    ['chrome', 'submit', 'manual'],
    ['android', 'status', 'preserve-existing']
  ]) {
    const c = context(platform);
    await assert.rejects(
      () =>
        run(
          [platform, action, ...common, '--build-number', '19', '--confirm', '1.17.7', '--release-policy', policy],
          c.deps
        ),
      /release policy/i
    );
    assert.equal(c.calls.length, 0);
  }
});

test('Chrome accepted asynchronous upload persists source-bound pending state for the next run', async () => {
  const c = context();
  c.deps.loadChromeUpload = async () => undefined;
  c.deps.persistChromeUpload = async (...value) => c.calls.push(['chromeUpload', ...value]);
  c.deps.operations.chrome.upload = async (client, options) => {
    assert.equal(typeof options.persistUploadSession, 'function');
    await options.persistUploadSession({ state: 'accepted-async', acceptedAt: 1700000000 });
    return { uploadState: 'IN_PROGRESS' };
  };
  await run(['chrome', 'upload', ...common, '--confirm', '1.17.7', ...artifactArgs], c.deps);
  const pending = c.calls.find(call => call[0] === 'chromeUpload')?.[2];
  assert.equal(pending.sourceSha, sha);
  assert.equal(pending.sha256, hash);
  assert.equal(pending.network, 'testnet');
  assert.equal(pending.identity, item);
  assert.equal(pending.publisherId, 'publisher');
  assert.equal(pending.uploaded, undefined);
  assert.equal(pending.state, 'accepted-async');
  assert.equal(
    c.calls.some(call => call[0] === 'attestation'),
    false
  );
});

test('Chrome submission restores only exact source-bound accepted asynchronous state', async () => {
  const c = context();
  c.deps.loadAttestation = async () => undefined;
  c.deps.loadChromeUpload = async () => ({
    ...c.attestation,
    uploaded: undefined,
    state: 'accepted-async',
    acceptedAt: 1700000000
  });
  c.deps.persistChromeUpload = async () => {};
  c.deps.operations.chrome.submit = async (client, options) => {
    assert.equal(options.uploadSession.state, 'accepted-async');
    assert.equal(options.uploadSession.sha256, hash);
    return { state: 'PENDING_REVIEW' };
  };
  await run(['chrome', 'submit', ...common, '--confirm', '1.17.7', ...artifactArgs], c.deps);
  for (const extra of [
    { sha256: 'f'.repeat(64) },
    { sourceSha: 'f'.repeat(40) },
    { identity: 'eeghndabgeicdpkbcohgglidpfpiafnb' },
    { publisherId: 'other' }
  ]) {
    c.deps.loadChromeUpload = async () => ({
      ...c.attestation,
      uploaded: undefined,
      state: 'accepted-async',
      acceptedAt: 1700000000,
      ...extra
    });
    await assert.rejects(
      run(['chrome', 'submit', ...common, '--confirm', '1.17.7', ...artifactArgs], c.deps),
      /upload|pending|session/
    );
  }
});

test('real Chrome async lifecycle persists pending evidence, resumes without media and verifies review revision', async () => {
  const c = context();
  const name = `publishers/publisher/items/${item}`;
  const response = extra => ({
    name,
    itemId: item,
    publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '1.17.6' }] },
    ...extra
  });
  const queue = [
    response(),
    { name, itemId: item, uploadState: 'IN_PROGRESS' },
    response({ lastAsyncUploadState: 'SUCCEEDED' }),
    { name, itemId: item, state: 'PENDING_REVIEW' },
    response({
      submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.17.7' }] }
    })
  ];
  const methods = [];
  c.client.request = async (method, path) => {
    methods.push([method, path]);
    assert.ok(queue.length);
    return queue.shift();
  };
  let journal;
  let attestation;
  c.deps.loadAttestation = async () => attestation;
  c.deps.loadChromeUpload = async () => journal;
  c.deps.persistChromeUpload = async (path, value) => {
    journal = structuredClone(value);
  };
  c.deps.persistAttestation = async (path, value) => {
    attestation = structuredClone(value);
  };
  c.deps.operations.chrome = chromeOperations;
  c.deps.wait = async () => {};
  assert.equal(
    (await run(['chrome', 'upload', ...common, '--confirm', '1.17.7', ...artifactArgs], c.deps)).uploadState,
    'IN_PROGRESS'
  );
  assert.equal(journal.state, 'accepted-async');
  assert.equal(attestation, undefined);
  const result = await run(['chrome', 'submit', ...common, '--confirm', '1.17.7', ...artifactArgs], c.deps);
  assert.equal(result.submittedRevisionVerified, true);
  assert.equal(journal.state, 'submitted');
  assert.equal(attestation.sha256, hash);
  assert.equal(attestation.completionEvidence, 'accepted-async-journal');
  assert.equal(methods.filter(([, path]) => path.includes('/upload/')).length, 1);
  assert.equal(methods.filter(([, path]) => path.endsWith(':publish')).length, 1);
});

test('persistent Chrome state rolls a published terminal journal into the next exact release without reusing old attestation', async () => {
  const c = context();
  let journal = {
    ...c.attestation,
    uploaded: undefined,
    state: 'submitted',
    acceptedAt: 1690000000,
    completedAt: 1690000005
  };
  const original = structuredClone(journal);
  const nextBytes = new Uint8Array([4, 5, 6]);
  const nextHash = createHash('sha256').update(nextBytes).digest('hex');
  c.receipt.version = '1.17.8';
  c.receipt.sourceSha = '2'.repeat(40);
  c.receipt.sha256 = nextHash;
  c.metadata.version = '1.17.8';
  c.metadata.provenance = { ...provenance, version: '1.17.8', sourceSha: '2'.repeat(40) };
  c.deps.readArtifact = async () => nextBytes;
  c.deps.loadAttestation = async () => undefined;
  c.deps.loadChromeUpload = async () => journal;
  c.deps.persistChromeUpload = async (path, value) => {
    journal = structuredClone(value);
  };
  let archive;
  c.deps.archiveChromeUpload = async (path, value) => {
    archive = structuredClone(value);
  };
  c.deps.operations.chrome = chromeOperations;
  const name = `publishers/publisher/items/${item}`;
  const queue = [
    {
      name,
      itemId: item,
      publishedItemRevisionStatus: {
        state: 'PUBLISHED',
        distributionChannels: [{ crxVersion: '1.17.7', deployPercentage: 100 }]
      }
    },
    { name, itemId: item, uploadState: 'SUCCEEDED', crxVersion: '1.17.8' }
  ];
  c.client.request = async method => {
    if (method === 'POST') assert.deepEqual(archive, original);
    return queue.shift();
  };
  await run(
    [
      'chrome',
      'upload',
      '--version',
      '1.17.8',
      '--source-sha',
      '2'.repeat(40),
      '--network',
      'testnet',
      '--confirm',
      '1.17.8',
      ...artifactArgs
    ],
    c.deps
  );
  assert.equal(journal.version, '1.17.8');
  assert.equal(journal.sha256, nextHash);
  assert.equal(journal.acceptedAt, undefined);
  assert.equal(journal.state, 'completed-sync');
  const attestation = c.calls.find(call => call[0] === 'attestation')[2];
  assert.equal(attestation.version, '1.17.8');
  assert.equal(attestation.sha256, nextHash);
});

test('Chrome rollover preserves an exclusive owner-private archive and refuses a conflicting archive without POST', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-rollover-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const c = context();
  const prior = {
    ...c.attestation,
    uploaded: undefined,
    state: 'submitted',
    acceptedAt: 1690000000,
    completedAt: 1690000005,
    retainedEvidence: 'complete prior record'
  };
  const journalPath = join(directory, `chrome-${item}-upload.json`);
  const archivePath = join(directory, `chrome-${item}-1.17.7-${hash}-submitted.json`);
  await writeFile(journalPath, JSON.stringify(prior), { mode: 0o600 });
  c.receipt.version = '1.17.8';
  c.metadata.version = '1.17.8';
  c.metadata.provenance = { ...provenance, version: '1.17.8' };
  c.deps.readConfig = async () => ({ ...config, stateDir: directory });
  c.deps.loadAttestation = async () => undefined;
  c.deps.loadChromeUpload = undefined;
  c.deps.persistChromeUpload = undefined;
  c.deps.archiveChromeUpload = undefined;
  c.deps.withMutationLock = undefined;
  c.deps.operations.chrome = chromeOperations;
  const name = `publishers/publisher/items/${item}`;
  const current = {
    name,
    itemId: item,
    publishedItemRevisionStatus: {
      state: 'PUBLISHED',
      distributionChannels: [{ crxVersion: '1.17.7', deployPercentage: 100 }]
    }
  };
  let posts = 0;
  c.client.request = async method => {
    if (method === 'POST') {
      posts++;
      return { name, itemId: item, uploadState: 'SUCCEEDED', crxVersion: '1.17.8' };
    }
    return current;
  };
  const args = [
    'chrome',
    'upload',
    '--version',
    '1.17.8',
    '--source-sha',
    sha,
    '--network',
    'testnet',
    '--confirm',
    '1.17.8',
    ...artifactArgs
  ];
  await run(args, c.deps);
  assert.deepEqual(JSON.parse(await readFile(archivePath)), JSON.parse(JSON.stringify(prior)));
  assert.equal((await stat(archivePath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(journalPath)).version, '1.17.8');
  assert.equal(posts, 1);
  await writeFile(journalPath, JSON.stringify(prior));
  await writeFile(archivePath, 'conflicting archive');
  posts = 0;
  await assert.rejects(run(args, c.deps), /archive/i);
  assert.equal(posts, 0);
  assert.equal(JSON.parse(await readFile(journalPath)).version, '1.17.7');
});

function screenshotContext(platform = 'ios') {
  const c = context(platform);
  c.attestation.version = '1.17.8';
  const storeId = platform === 'ios' ? config.apple.appId : platform === 'android' ? config.play.packageName : item;
  const manifest = {
    schemaVersion: 1,
    baselineVersion: '1.17.7',
    capturedAt: '2026-10-25T00:00:00Z',
    sets: [
      {
        platform,
        storeId,
        locale: 'en-US',
        displayType: platform === 'ios' ? 'APP_IPHONE_67' : 'phoneScreenshots',
        images: [{ path: 'store-listing/screenshots/image.png', sha256: hash, size: bytes.length, bytes }]
      }
    ]
  };
  c.deps.verifyScreenshotSource = async request => {
    c.calls.push(['screenshotSource', request]);
  };
  c.deps.loadScreenshotManifest = async request => {
    c.calls.push(['screenshotManifest', request]);
    return manifest;
  };
  c.deps.screenshotOperations = {
    inventoryScreenshots: async (client, options) => {
      c.calls.push(['screenshotInventory', options]);
      return { sets: [] };
    },
    verifyScreenshots: async (client, options) => {
      c.calls.push(['screenshotVerify', options]);
      return { matches: true };
    },
    syncScreenshots: async (client, options) => {
      c.calls.push(['screenshotSync', options]);
      return { matches: true, state: 'screenshots-matched' };
    }
  };
  c.deps.loadAndroidEdit = async () => ({
    packageName: 'com.miden.wallet',
    editId: 'edit-1',
    version: '1.17.8',
    sourceSha: sha,
    network: 'testnet',
    expiryTimeSeconds: '2000000000'
  });
  return { ...c, manifest };
}
const screenshotArgs = [
  '--version',
  '1.17.8',
  '--source-sha',
  sha,
  '--network',
  'testnet',
  '--confirm',
  '1.17.8',
  '--screenshots-root',
  '/release/source'
];

test('future iOS submission verifies canonical ordered screenshots before calling submit', async () => {
  const c = screenshotContext();
  await run(['ios', 'submit', ...screenshotArgs, '--build-number', '19'], c.deps);
  const verify = c.calls.findIndex(call => call[0] === 'screenshotVerify');
  const submit = c.calls.findIndex(call => call[0] === 'operation');
  assert.ok(verify >= 0 && verify < submit);
  assert.equal(c.calls[verify][1].sets[0].images[0].bytes, bytes);
  assert.equal(c.calls.find(call => call[0] === 'screenshotSource')[1].sourceSha, sha);
  assert.equal(c.calls.find(call => call[0] === 'operation')[3].releasePolicy, 'preserve-existing');
});

test('future screenshot absence or drift fails before the publishing mutation', async () => {
  const missing = screenshotContext();
  missing.deps.loadScreenshotManifest = async () => {
    throw Object.assign(new Error('manifest missing'), { code: 'SCREENSHOT_MANIFEST_MISSING' });
  };
  await assert.rejects(
    run(['ios', 'submit', ...screenshotArgs, '--build-number', '19'], missing.deps),
    /screenshot|manifest/i
  );
  assert.equal(
    missing.calls.some(call => ['operation', 'client', 'appleToken'].includes(call[0])),
    false
  );
  const drift = screenshotContext();
  drift.deps.screenshotOperations.verifyScreenshots = async () => ({
    matches: false,
    differences: [{ reason: 'ordered-assets-differ' }]
  });
  await assert.rejects(
    run(['ios', 'submit', ...screenshotArgs, '--build-number', '19'], drift.deps),
    /screenshot|sync/i
  );
  assert.equal(
    drift.calls.some(call => call[0] === 'operation'),
    false
  );
});

test('a glob manifest path is not satisfied by a tracked sibling', async t => {
  const root = await mkdtemp(join(tmpdir(), 'screenshot-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
      encoding: 'utf8'
    }).trim();
  await mkdir(join(root, 'public'));
  await mkdir(join(root, 'store-listing/screenshots'), { recursive: true });
  for (const name of ['package.json', 'public/manifest.json'])
    await writeFile(join(root, name), JSON.stringify({ version: '1.17.8' }));
  for (const name of ['screenshots.json', 'store-rules.json']) await writeFile(join(root, 'store-listing', name), '{}');
  await writeFile(join(root, 'store-listing/screenshots/01.png'), bytes);
  git('init', '-q');
  git('add', '.');
  const commit = git('commit-tree', '--no-gpg-sign', '-m', 'fixture', git('write-tree'));
  git('update-ref', 'HEAD', commit);
  const prepare = async path => {
    const c = screenshotContext();
    delete c.deps.verifyScreenshotSource;
    c.manifest.sets[0].images[0].path = path;
    return run(
      [
        'ios',
        'prepare',
        '--version',
        '1.17.8',
        '--source-sha',
        commit,
        '--network',
        'testnet',
        '--confirm',
        '1.17.8',
        '--screenshots-root',
        root,
        '--dry-run'
      ],
      c.deps
    );
  };
  assert.equal((await prepare('store-listing/screenshots/01.png')).dryRun, true);
  await assert.rejects(prepare('store-listing/screenshots/0*.png'), /exact release checkout/);
});

test('Android screenshot synchronization uses the exact existing edit without a build, upload, creation or commit', async () => {
  const c = screenshotContext('android');
  await run(['android', 'sync-screenshots', ...screenshotArgs, '--edit-id', 'edit-1'], c.deps);
  const sync = c.calls.find(call => call[0] === 'screenshotSync');
  assert.equal(sync[1].editId, 'edit-1');
  assert.equal(sync[1].allowWrites, true);
  assert.equal(
    c.calls.some(call => ['operation', 'persist', 'request', 'attestation'].includes(call[0])),
    false
  );
  c.deps.loadAndroidEdit = async () => ({
    packageName: 'com.miden.wallet',
    editId: 'other',
    version: '1.17.8',
    sourceSha: sha,
    network: 'testnet',
    expiryTimeSeconds: '2000000000'
  });
  await assert.rejects(run(['android', 'sync-screenshots', ...screenshotArgs, '--edit-id', 'edit-1'], c.deps), /edit/i);
});

test('the 1.17.7 preservation exception is explicit and cannot bypass malformed or future manifests', async () => {
  const c = context('ios');
  await assert.rejects(cli.run(['ios', 'prepare', ...common, '--confirm', '1.17.7'], c.deps), /screenshot|source/i);
  c.deps.operations.ios.prepare = async () => ({ state: 'preserved' });
  assert.equal(
    (await cli.run(['ios', 'prepare', ...common, '--confirm', '1.17.7', '--preserve-legacy-screenshots'], c.deps))
      .state,
    'preserved'
  );
  await assert.rejects(
    cli.run(['ios', 'prepare', ...screenshotArgs, '--preserve-legacy-screenshots'], screenshotContext().deps),
    /legacy|1.17.7/i
  );
});

test('Android submit verifies screenshots against the same edit and blocks mismatches before commit', async () => {
  const c = screenshotContext('android');
  c.deps.screenshotOperations.verifyScreenshots = async (client, options) => {
    assert.equal(options.editId, 'edit-1');
    return { matches: false };
  };
  await assert.rejects(
    run(
      [
        'android',
        'submit',
        ...screenshotArgs,
        '--edit-id',
        'edit-1',
        '--version-code',
        '11707001',
        '--allow-pending-changes'
      ],
      c.deps
    ),
    /screenshots/
  );
  assert.equal(
    c.calls.some(call => call[0] === 'operation'),
    false
  );
});

test('Chrome screenshot sync emits only console bundle metadata without credentials or API writes', async () => {
  const c = screenshotContext('chrome');
  c.deps.screenshotOperations.syncScreenshots = async (client, options) => {
    assert.equal(client, undefined);
    assert.equal(options.sets[0].storeId, item);
    return {
      consoleRequired: true,
      actionRequired: 'Use developer console screenshot editor',
      assets: [
        {
          locale: 'en-US',
          displayType: 'screenshot',
          path: 'store-listing/image.png',
          sha256: hash,
          bytes,
          url: 'https://provider.invalid/?token=secret'
        }
      ],
      privateToken: 'secret'
    };
  };
  const result = await run(['chrome', 'sync-screenshots', ...screenshotArgs], c.deps);
  assert.equal(result.consoleRequired, true);
  assert.equal(result.assets[0].sha256, hash);
  assert.doesNotMatch(JSON.stringify(result), /secret|provider|bytes/);
  assert.equal(
    c.calls.some(call => ['client', 'credentials', 'operation', 'request'].includes(call[0])),
    false
  );
});

test('source mismatch and invalid legacy manifest cannot reach credentials or store mutations', async () => {
  const mismatch = screenshotContext();
  mismatch.deps.verifyScreenshotSource = async () => {
    throw new Error('screenshot source mismatch');
  };
  await assert.rejects(
    run(['ios', 'submit', ...screenshotArgs, '--build-number', '19'], mismatch.deps),
    /source mismatch/
  );
  assert.equal(
    mismatch.calls.some(call => ['client', 'operation'].includes(call[0])),
    false
  );
  const invalid = screenshotContext();
  invalid.deps.loadScreenshotManifest = async () => {
    throw new Error('screenshot image hash mismatch');
  };
  await assert.rejects(
    cli.run(
      [
        'ios',
        'prepare',
        ...common,
        '--confirm',
        '1.17.7',
        '--screenshots-root',
        '/release/source',
        '--preserve-legacy-screenshots'
      ],
      invalid.deps
    ),
    /hash mismatch/
  );
  assert.equal(
    invalid.calls.some(call => ['client', 'operation'].includes(call[0])),
    false
  );
});

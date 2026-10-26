#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import * as apple from './apple.mjs';
import * as chrome from './chrome.mjs';
import * as play from './play.mjs';
import { screenshotJournalName, validateScreenshotJournal } from './screenshot-journal.mjs';
import { screenshotDeadlineClient } from './screenshots.mjs';

const origins = {
  chrome: 'https://chromewebstore.googleapis.com',
  ios: 'https://api.appstoreconnect.apple.com',
  android: 'https://androidpublisher.googleapis.com'
};
const scope = {
  chrome: 'https://www.googleapis.com/auth/chromewebstore',
  android: 'https://www.googleapis.com/auth/androidpublisher'
};
const defaultState = join(homedir(), '.config/wallet-publishing/state');
const defaults = { chrome, ios: apple, android: play };
const values = new Map(
  [
    'config',
    'version',
    'network',
    'source-sha',
    'artifact',
    'receipt',
    'build-number',
    'version-code',
    'edit-id',
    'release-policy',
    'screenshots-root',
    'screenshot-deadline-ms',
    'release-notes',
    'confirm'
  ].map(name => [name, name.replace(/-([a-z])/g, (_, char) => char.toUpperCase())])
);
const flags = new Map(
  ['allow-pending-changes', 'confirm-new-edit', 'dry-run', 'preserve-legacy-screenshots'].map(name => [
    name,
    name.replace(/-([a-z])/g, (_, char) => char.toUpperCase())
  ])
);
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const retiredItems = new Set(['ablmompanofnodfdkgchkpmphailefpb', 'dflkdeijmncafikdikmfoaddhieplbdb']);
const breadItems = { testnet: 'coajhopfooegmaifelglfboehacldcbo', devnet: 'eeghndabgeicdpkbcohgglidpfpiafnb' };
const expand = path => resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

export function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const [platform, action, ...rest] = argv;
  if (
    !Object.hasOwn(origins, platform) ||
    !['status', 'upload', 'submit', 'release', 'begin-edit', 'prepare', 'sync-screenshots'].includes(action)
  ) {
    throw new Error(
      'Usage: cli.mjs <chrome|ios|android> <status|upload|submit|release|begin-edit|prepare|sync-screenshots> [options]'
    );
  }
  const result = { platform, action, config: join(homedir(), '.config/wallet-publishing/config.json') };
  const seen = new Set();
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (!argument.startsWith('--')) throw new Error('Unexpected positional publishing argument');
    const name = argument.slice(2);
    if (seen.has(name)) throw new Error('Duplicate publishing option');
    seen.add(name);
    if (flags.has(name)) result[flags.get(name)] = true;
    else if (values.has(name)) {
      const value = rest[++index];
      if (value === undefined || (!value && name !== 'release-notes') || value.startsWith('--'))
        throw new Error('A publishing option is missing its value');
      result[values.get(name)] = value;
    } else throw new Error('Unknown publishing option; store identities can only come from private configuration');
  }
  return result;
}

function planFor(args, config) {
  const { platform, action } = args;
  const mutation = action !== 'status';
  if (
    args.screenshotDeadlineMs !== undefined &&
    (platform !== 'ios' ||
      !/^[1-9][0-9]*$/.test(args.screenshotDeadlineMs) ||
      !Number.isSafeInteger(Number(args.screenshotDeadlineMs)))
  )
    throw new Error('A valid absolute iOS screenshot deadline is required');
  const releaseNotes = apple.validateReleaseNotes(args.releaseNotes);
  if (releaseNotes !== undefined && (platform !== 'ios' || action !== 'submit'))
    throw new Error('Release notes are only supported for iOS submit');
  if (args.preserveLegacyScreenshots && (args.version !== '1.17.7' || action === 'sync-screenshots'))
    throw new Error('Legacy screenshot preservation applies only to existing 1.17.7 publishing, never synchronization');
  if ((action === 'begin-edit' && platform !== 'android') || (action === 'prepare' && platform !== 'ios')) {
    throw new Error('The selected platform does not support that publishing action');
  }
  if (
    args.releasePolicy !== undefined &&
    (platform !== 'ios' ||
      action !== 'submit' ||
      !['preserve-existing', 'manual', 'after-approval'].includes(args.releasePolicy))
  ) {
    throw new Error('Release policy is only supported for iOS submit with preserve-existing, manual or after-approval');
  }
  if (mutation || args.version !== undefined) {
    if (!stableVersion.test(args.version ?? ''))
      throw new Error('An explicit stable x.y.z release version is required');
  }
  if (mutation) {
    if (!/^[a-fA-F0-9]{40}$/.test(args.sourceSha ?? '')) throw new Error('A full 40-character source SHA is required');
    if (!args.dryRun && args.confirm !== args.version)
      throw new Error('--confirm must exactly equal the selected version');
    if (args.confirm !== undefined && args.confirm !== args.version)
      throw new Error('--confirm does not match the selected version');
  }
  if ((mutation || platform === 'chrome') && !args.network) throw new Error('An explicit release network is required');
  if (args.network && !['testnet', 'mainnet', 'devnet'].includes(args.network))
    throw new Error('Unsupported release network');
  if (platform !== 'chrome' && args.network === 'devnet' && mutation)
    throw new Error('Devnet mobile packages cannot be published to the production apps');
  if (action === 'begin-edit' && !args.dryRun && !args.confirmNewEdit)
    throw new Error(
      '--confirm-new-edit is required because a new Play edit invalidates the previous same-principal edit'
    );
  if (platform === 'android' && action === 'submit' && !args.allowPendingChanges)
    throw new Error('--allow-pending-changes is required after inspecting the full Play Publishing overview');
  const section = config[platform === 'ios' ? 'apple' : platform === 'android' ? 'play' : 'chrome'];
  if (!section || typeof section !== 'object' || Array.isArray(section))
    throw new Error('The selected store target is not configured');
  let identity;
  let storeId;
  const options = {};
  if (platform === 'chrome') {
    identity = section.items?.[args.network];
    if (typeof identity !== 'string' || !/^[a-p]{32}$/.test(identity))
      throw new Error('No Chrome item is configured for this explicit network');
    if (retiredItems.has(identity)) throw new Error('The configured Chrome target is retired');
    if (identity !== breadItems[args.network])
      throw new Error('The configured Chrome target is outside the explicit Bread network allowlist');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(section.publisherId ?? ''))
      throw new Error('A valid Chrome publisher target must be configured');
    Object.assign(options, { publisherId: section.publisherId, itemId: identity });
    storeId = identity;
  } else if (platform === 'ios') {
    if (section.appId !== '6789341854' || section.bundleId !== 'com.miden.bread')
      throw new Error('The exact Bread Apple app target must be configured');
    identity = section.bundleId;
    storeId = section.appId;
    Object.assign(options, { appId: section.appId, bundleId: identity });
    if (action === 'submit') {
      options.releasePolicy = args.releasePolicy ?? 'after-approval';
      options.releaseNotes = releaseNotes ?? apple.DEFAULT_RELEASE_NOTES;
    }
    if ((mutation && !['prepare', 'sync-screenshots'].includes(action)) || args.buildNumber !== undefined) {
      if (!/^\d+(?:\.\d+){0,2}$/.test(args.buildNumber ?? ''))
        throw new Error('An explicit Apple build number is required');
      options.buildNumber = args.buildNumber;
    }
  } else {
    if (section.packageName !== 'com.miden.wallet')
      throw new Error('The exact Bread Android package target must be configured');
    identity = section.packageName;
    storeId = identity;
    options.packageName = identity;
    if ((mutation && !['begin-edit', 'sync-screenshots'].includes(action)) || args.versionCode !== undefined) {
      if (!/^[1-9]\d*$/.test(args.versionCode ?? '') || !Number.isSafeInteger(Number(args.versionCode)))
        throw new Error('An explicit positive Android version code is required');
      options.versionCode = Number(args.versionCode);
    }
    if (
      ['upload', 'submit', 'sync-screenshots'].includes(action) ||
      (action === 'status' && args.editId !== undefined)
    ) {
      if (!/^[A-Za-z0-9_-]+$/.test(args.editId ?? ''))
        throw new Error('An explicit caller-owned Play edit ID is required');
      options.editId = args.editId;
      if (action === 'status') options.inspectEdit = true;
    }
    if (args.allowPendingChanges) options.allowPendingChanges = true;
  }
  if (args.version !== undefined) options.version = args.version;
  const needsArtifact = action === 'upload' || (platform === 'chrome' && action === 'submit');
  if (needsArtifact && (!args.artifact || !args.receipt))
    throw new Error('Both --artifact and --receipt are required for this action');
  const stateDir = expand(config.stateDir ?? defaultState);
  return {
    platform,
    action,
    mutation,
    needsArtifact,
    identity,
    storeId,
    options,
    section,
    stateDir,
    configPath: expand(args.config),
    version: args.version,
    network: args.network,
    sourceSha: args.sourceSha?.toLowerCase(),
    ...(args.screenshotDeadlineMs !== undefined ? { screenshotDeadlineMs: Number(args.screenshotDeadlineMs) } : {})
  };
}

async function regularFile(path, { privateFile = false, missingOkay = false, limit } = {}) {
  let handle;
  try {
    if (constants.O_NOFOLLOW === undefined) throw new Error('Safe publishing file access is unavailable');
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || (limit !== undefined && info.size > limit))
      throw new Error('Not a supported regular publishing file');
    if (
      privateFile &&
      ((info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid()))
    )
      throw new Error('Private publishing file permissions are required');
    return await handle.readFile();
  } catch (error) {
    if (missingOkay && error.code === 'ENOENT') return undefined;
    throw new Error('Unable to read a regular publishing file with the required permissions');
  } finally {
    await handle?.close();
  }
}

function document(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
    return value;
  } catch {
    throw new Error('Invalid publishing JSON document');
  }
}

async function inspectArtifact(platform, bytes) {
  const helper = fileURLToPath(new URL('./inspect-artifact.py', import.meta.url));
  return new Promise((resolveResult, reject) => {
    const child = spawn('python3', [helper, platform], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    let size = 0;
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill();
    }, 60000);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        failed = true;
        child.kill();
      } else output.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Artifact inspector could not be started'));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0)
        reject(new Error('Artifact inspection failed; verify archive metadata and embedded provenance'));
      else {
        try {
          resolveResult(document(Buffer.concat(output)));
        } catch (error) {
          reject(error);
        }
      }
    });
    child.stdin.end(bytes);
  });
}

function baseEvidence(plan, sha256) {
  return {
    schemaVersion: 1,
    platform: plan.platform,
    identity: plan.identity,
    storeId: plan.storeId,
    version: plan.version,
    network: plan.network,
    sourceSha: plan.sourceSha,
    sha256,
    ...(plan.options.buildNumber ? { buildNumber: plan.options.buildNumber } : {}),
    ...(plan.options.versionCode ? { versionCode: plan.options.versionCode } : {}),
    ...(plan.options.editId ? { editId: plan.options.editId } : {}),
    ...(plan.platform === 'chrome' ? { publisherId: plan.options.publisherId } : {})
  };
}

async function verifyArtifact(plan, args, dependencies) {
  const bytes = await (dependencies.readArtifact ?? regularFile)(expand(args.artifact));
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error('A nonempty artifact is required');
  const receipt = await (
    dependencies.readReceipt ?? (async path => document(await regularFile(path, { limit: 1024 * 1024 })))
  )(expand(args.receipt));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const expected = {
    platform: plan.platform,
    version: plan.version,
    network: plan.network,
    sourceSha: plan.sourceSha,
    identity: plan.identity
  };
  for (const [key, value] of Object.entries(expected))
    if (receipt[key] !== value) throw new Error(`Artifact receipt ${key} does not match the selected release`);
  if (receipt.sha256 !== sha256) throw new Error('Artifact checksum does not match its receipt');
  if (plan.platform === 'ios' && String(receipt.buildNumber) !== plan.options.buildNumber)
    throw new Error('Artifact receipt build number does not match');
  if (plan.platform === 'android' && receipt.versionCode !== plan.options.versionCode)
    throw new Error('Artifact receipt version code does not match');
  const metadata = await (dependencies.inspectArtifact ?? inspectArtifact)(plan.platform, bytes);
  if (metadata.platform !== plan.platform) throw new Error('The actual artifact platform does not match');
  const marker = metadata.provenance;
  if (
    !marker ||
    marker.version !== plan.version ||
    marker.network !== plan.network ||
    marker.sourceSha !== plan.sourceSha ||
    marker.mode !== 'production' ||
    (marker.platform !== undefined && marker.platform !== plan.platform)
  )
    throw new Error('Artifact provenance does not match the selected production source, version and network');
  if (plan.platform === 'chrome') {
    const name = plan.network === 'devnet' ? 'Bread Wallet by Miden (Devnet)' : 'Bread Wallet by Miden';
    if (
      metadata.name !== name ||
      metadata.version !== plan.version ||
      (metadata.identity !== null && metadata.identity !== plan.identity)
    )
      throw new Error('The actual Chrome artifact identity, branding or version does not match');
  } else if (
    plan.platform === 'ios' &&
    (metadata.identity !== plan.identity ||
      metadata.version !== plan.version ||
      metadata.buildNumber !== plan.options.buildNumber ||
      metadata.deviceBuild !== true)
  )
    throw new Error('The actual iOS artifact identity, version, build or device platform does not match');
  return { bytes, evidence: baseEvidence(plan, sha256) };
}

function recordPath(plan) {
  return join(
    plan.stateDir,
    `${plan.platform}-${plan.storeId}-${plan.version}-${plan.options.buildNumber ?? plan.options.versionCode ?? 'package'}.json`
  );
}

async function loadAttestation(path) {
  const bytes = await regularFile(path, { privateFile: true, missingOkay: true, limit: 1024 * 1024 });
  return bytes === undefined ? undefined : document(bytes);
}

function verifyAttestation(plan, existing, expected) {
  const base = baseEvidence(plan, expected?.sha256 ?? existing?.sha256);
  if (
    !existing ||
    existing.schemaVersion !== 1 ||
    existing.uploaded !== true ||
    !/^[a-f0-9]{64}$/.test(existing.sha256 ?? '')
  )
    throw new Error(
      'A verified upload attestation is required; upload through this command before submission or release'
    );
  for (const [key, value] of Object.entries(base)) {
    if (key === 'editId' && ['upload', 'release'].includes(plan.action)) continue;
    if (existing[key] !== value) throw new Error(`The upload attestation ${key} does not match this release`);
  }
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid())
  )
    throw new Error('Publishing state requires an owner-private directory');
}

async function persistJson(path, value) {
  await privateDirectory(dirname(path));
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function archiveChromeUpload(path, value) {
  await privateDirectory(dirname(path));
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  let file;
  try {
    file = await open(path, 'wx', 0o600);
    await file.writeFile(bytes);
    await file.sync();
  } catch (error) {
    if (error.code !== 'EEXIST') throw new Error('Unable to archive prior Chrome upload journal');
    const previous = await regularFile(path, { privateFile: true, limit: 1024 * 1024 });
    if (!bytes.equals(previous))
      throw new Error('An existing Chrome journal archive differs; no rollover was performed');
  } finally {
    await file?.close();
  }
}

async function withMutationLock(path, operation) {
  await privateDirectory(path);
  const lockPath = join(path, '.mutation.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch {
    throw new Error('Another publishing operation owns the state lock; verify its owner before removing a stale lock');
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    return await operation();
  } finally {
    const own = await lock.stat();
    await lock.close();
    // Do not unlink a replacement lock if an operator changed it mid-operation.
    const current = await lstat(lockPath).catch(() => undefined);
    if (current?.ino === own.ino && current.dev === own.dev) await unlink(lockPath);
  }
}

export async function uploadIpa({ bytes, key, apple, stateDir }, { runner = promisify(execFile) } = {}) {
  if (
    !/^[A-Za-z0-9]{1,64}$/.test(apple?.keyId ?? '') ||
    typeof apple?.issuerId !== 'string' ||
    !/^\S+$/.test(apple.issuerId)
  )
    throw new Error('Valid configured Apple API key identifiers are required');
  await privateDirectory(stateDir);
  const logPath = join(stateDir, `ios-upload-${Date.now()}-${randomUUID()}.log`);
  const temporary = await mkdtemp(join(tmpdir(), 'wallet-upload-'));
  await chmod(temporary, 0o700);
  const artifactPath = join(temporary, 'wallet.ipa');
  const keyPath = join(temporary, `AuthKey_${apple.keyId}.p8`);
  try {
    // Both files are frozen from the already verified descriptors, not reopened originals.
    await writeFile(artifactPath, bytes, { mode: 0o600, flag: 'wx' });
    await writeFile(keyPath, key, { mode: 0o600, flag: 'wx' });
    let output;
    let failed = false;
    try {
      output = await runner(
        'xcrun',
        [
          'altool',
          '--upload-app',
          '-f',
          artifactPath,
          '--api-key',
          apple.keyId,
          '--api-issuer',
          apple.issuerId,
          '--p8-file-path',
          keyPath,
          '--output-format',
          'json'
        ],
        { timeout: 600000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }
      );
    } catch (error) {
      output = error;
      failed = true;
    }
    const stdout = String(output?.stdout ?? '');
    const stderr = String(output?.stderr ?? '');
    await writeFile(logPath, `${stdout}\n${stderr}`, { mode: 0o600, flag: 'wx' });
    let structured;
    try {
      structured = JSON.parse(stdout);
    } catch {}
    const hasErrors = value =>
      value !== undefined &&
      value !== null &&
      value !== false &&
      (typeof value === 'object' ? Object.keys(value).length > 0 : String(value).trim().length > 0);
    if (
      failed ||
      /\bERROR\b/i.test(stderr) ||
      (!structured && /\bERROR\b/i.test(stdout)) ||
      hasErrors(structured?.['product-errors']) ||
      hasErrors(structured?.errors) ||
      hasErrors(structured?.error) ||
      structured?.success === false
    )
      throw new Error(`Apple uploader did not report success; inspect private upload log ${logPath} before any retry`);
    return { state: 'UPLOAD_ACCEPTED', logPath };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function authenticatedClient(plan, artifact, dependencies) {
  const auth = dependencies.auth ?? (await import('./auth.mjs'));
  let token;
  let key;
  if (plan.platform === 'ios') {
    if (typeof plan.section.keyPath !== 'string' || !plan.section.keyPath)
      throw new Error('A private Apple publishing key path is required');
    key = await (dependencies.readPrivateKey ?? (path => regularFile(path, { privateFile: true, limit: 1024 * 1024 })))(
      expand(plan.section.keyPath)
    );
    token = auth.createAppleToken({ keyId: plan.section.keyId, issuerId: plan.section.issuerId, key });
  } else {
    const environment = dependencies.env ?? process.env;
    const supplied = plan.platform === 'android' ? environment.WALLET_PLAY_ACCESS_TOKEN : undefined;
    if (supplied !== undefined) {
      if (typeof supplied !== 'string' || !/^\S+$/.test(supplied))
        throw new Error('A valid short-lived Play access token is required');
      token = supplied;
    } else {
      const path = plan.platform === 'chrome' ? plan.section.oauthPath : plan.section.serviceAccountPath;
      if (typeof path !== 'string' || !path)
        throw new Error('Configure publishing credentials or supply the short-lived Play CI token');
      const credentials = await auth.loadPrivateJson(expand(path));
      token = await auth.googleAccessToken(credentials, scope[plan.platform], {
        ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {})
      });
    }
  }
  const client = auth.createApiClient({
    origin: origins[plan.platform],
    token,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {})
  });
  if (plan.platform !== 'ios' || plan.action !== 'upload') return client;
  return {
    ...client,
    uploadIpa: () =>
      (dependencies.uploadIpa ?? uploadIpa)({
        bytes: artifact.bytes,
        key,
        apple: plan.section,
        stateDir: plan.stateDir
      })
  };
}

async function verifyScreenshotSource({ root, version, sourceSha, paths }) {
  try {
    const execute = promisify(execFile);
    const result = await execute('git', ['-C', root, 'rev-parse', '--show-toplevel', 'HEAD'], {
      timeout: 10000,
      maxBuffer: 1024 * 1024
    });
    const [top, revision] = result.stdout.trim().split('\n');
    if ((await realpath(top)) !== (await realpath(root)) || revision !== sourceSha) throw new Error('Source mismatch');
    const status = await execute(
      'git',
      [
        '-C',
        root,
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--',
        'store-listing',
        'package.json',
        'public/manifest.json'
      ],
      { timeout: 10000, maxBuffer: 1024 * 1024 }
    );
    if (status.stdout.trim()) throw new Error('Screenshot source has local changes');
    // Literal pathspecs stop a manifest path such as `0*.png` from matching a tracked sibling.
    if (paths.length)
      await execute('git', ['-C', root, '--literal-pathspecs', 'ls-files', '--error-unmatch', '--', ...paths], {
        timeout: 10000,
        maxBuffer: 1024 * 1024
      });
    for (const name of ['package.json', 'public/manifest.json'])
      if (document(await regularFile(join(root, name), { limit: 1024 * 1024 })).version !== version)
        throw new Error('Source version mismatch');
  } catch {
    throw new Error(
      'Screenshot source must be the exact release checkout with clean tracked canonical assets and matching package versions'
    );
  }
}

async function screenshotPlan(args, plan, dependencies) {
  if (!plan.mutation) return undefined;
  if (!args.screenshotsRoot) {
    if (args.preserveLegacyScreenshots && plan.version === '1.17.7' && plan.action !== 'sync-screenshots')
      return { legacyPreserved: true };
    throw new Error('An exact release --screenshots-root is required before publishing');
  }
  const root = expand(args.screenshotsRoot);
  const verifySource = dependencies.verifyScreenshotSource ?? verifyScreenshotSource;
  let manifest;
  try {
    const load =
      dependencies.loadScreenshotManifest ?? (await import('../store-listing/screenshots.mjs')).loadScreenshotManifest;
    manifest = await load({
      root,
      manifestPath: 'store-listing/screenshots.json',
      rulesPath: 'store-listing/store-rules.json'
    });
  } catch (error) {
    if (
      error.code === 'SCREENSHOT_MANIFEST_MISSING' &&
      args.preserveLegacyScreenshots &&
      plan.version === '1.17.7' &&
      plan.action !== 'sync-screenshots'
    ) {
      await verifySource({ root, version: plan.version, sourceSha: plan.sourceSha, paths: [] });
      return { legacyPreserved: true };
    }
    throw error;
  }
  await verifySource({
    root,
    version: plan.version,
    sourceSha: plan.sourceSha,
    paths: [
      'store-listing/screenshots.json',
      'store-listing/store-rules.json',
      ...new Set(manifest.sets.flatMap(set => set.images.map(image => image.path)))
    ]
  });
  const sets = manifest.sets.filter(set => set.platform === plan.platform && set.storeId === plan.storeId);
  if (!sets.length) throw new Error('Canonical screenshot manifest has no sets for the selected store target');
  return {
    root,
    sets,
    baselineSets: manifest.baselineSets?.filter(set => set.platform === plan.platform && set.storeId === plan.storeId),
    manifestSha256: manifest.manifestSha256,
    ...(args.preserveLegacyScreenshots && plan.version === '1.17.7' && plan.action !== 'sync-screenshots'
      ? { legacyPreserved: true }
      : {})
  };
}

async function verifyScreenshotEdit(plan, dependencies) {
  const edit = await (dependencies.loadAndroidEdit ?? loadAttestation)(join(plan.stateDir, 'android-edit.json'));
  const now = (dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  if (
    !edit ||
    edit.packageName !== plan.identity ||
    edit.editId !== plan.options.editId ||
    ['version', 'network', 'sourceSha'].some(key => edit[key] !== plan[key]) ||
    !/^[0-9]+$/.test(String(edit.expiryTimeSeconds ?? '')) ||
    Number(edit.expiryTimeSeconds) <= now
  )
    throw new Error('Screenshot synchronization requires the exact restored caller-owned unexpired Play edit');
}

function screenshotSummary(result, plan) {
  const summary = { platform: plan.platform, storeId: plan.storeId, version: plan.version };
  for (const key of ['changed', 'matches', 'consoleRequired', 'actionRequired', 'state'])
    if (['string', 'boolean'].includes(typeof result?.[key])) summary[key] = result[key];
  for (const key of ['updatedSets', 'assets'])
    if (Array.isArray(result?.[key]))
      summary[key] = result[key].map(value =>
        Object.fromEntries(
          ['locale', 'displayType', 'count', 'path', 'sha256']
            .filter(field => ['string', 'number'].includes(typeof value[field]))
            .map(field => [field, value[field]])
        )
      );
  return summary;
}

export async function run(argv, dependencies = {}) {
  const args = parseArgs(argv);
  if (args.help)
    return 'Usage: cli.mjs <chrome|ios|android> <status|upload|submit|release|begin-edit|prepare|sync-screenshots> [options]\nMutations require --version X.Y.Z --network NAME --source-sha SHA --confirm X.Y.Z. Uploads require --artifact FILE --receipt FILE. Use --dry-run before authorization.';
  const config = await (
    dependencies.readConfig ??
    (async path => document(await regularFile(path, { privateFile: true, limit: 1024 * 1024 })))
  )(expand(args.config));
  const plan = planFor(args, config);
  const artifact = plan.needsArtifact ? await verifyArtifact(plan, args, dependencies) : undefined;
  const screenshots = await screenshotPlan(args, plan, dependencies);
  const path =
    plan.mutation && !['begin-edit', 'prepare', 'sync-screenshots'].includes(plan.action)
      ? recordPath(plan)
      : undefined;
  let uploadSession;
  let rollover = false;
  const chromeSessionPath =
    plan.platform === 'chrome' && artifact ? join(plan.stateDir, `chrome-${plan.identity}-upload.json`) : undefined;
  const validateSession = value =>
    chrome.validateUploadSession(
      value,
      {
        ...plan.options,
        artifact: artifact.bytes,
        sourceSha: plan.sourceSha,
        network: plan.network
      },
      (dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))()
    );
  const restoreSession = async () => {
    if (!chromeSessionPath) return;
    uploadSession = await (dependencies.loadChromeUpload ?? loadAttestation)(chromeSessionPath);
    rollover = Boolean(uploadSession && uploadSession.version !== plan.version && plan.action === 'upload');
    if (rollover)
      chrome.validateRolloverSession(
        uploadSession,
        { ...plan.options, network: plan.network },
        (dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))()
      );
    else if (uploadSession) validateSession(uploadSession);
  };
  const verifyPreviousUpload = async () => {
    if (!path) return;
    const existing = await (dependencies.loadAttestation ?? loadAttestation)(path);
    if (existing) verifyAttestation(plan, existing, artifact?.evidence);
    else if (!artifact) verifyAttestation(plan, existing);
  };
  if (args.dryRun) {
    if (plan.platform === 'android' && plan.action === 'sync-screenshots')
      await verifyScreenshotEdit(plan, dependencies);
    await restoreSession();
    await verifyPreviousUpload();
    return {
      dryRun: true,
      platform: plan.platform,
      action: plan.action,
      identity: plan.identity,
      version: plan.version,
      network: plan.network,
      sourceSha: plan.sourceSha,
      ...(artifact ? { sha256: artifact.evidence.sha256 } : {}),
      requiresConfirmation: plan.mutation ? plan.version : false,
      ...(rollover ? { requiresRolloverVerification: true } : {}),
      ...(plan.action === 'begin-edit'
        ? { warning: 'Creating this edit invalidates a previous edit owned by the same principal' }
        : {})
    };
  }
  const operation = async () => {
    await restoreSession();
    await verifyPreviousUpload();
    if (plan.platform === 'android' && plan.action === 'sync-screenshots')
      await verifyScreenshotEdit(plan, dependencies);
    const screenshotOperations =
      plan.action === 'sync-screenshots' ||
      (plan.platform === 'ios' && plan.action === 'prepare' && !screenshots?.legacyPreserved) ||
      (plan.action === 'submit' && plan.platform !== 'chrome' && !screenshots?.legacyPreserved)
        ? (dependencies.screenshotOperations ?? (await import('./screenshots.mjs')))
        : undefined;
    const screenshotOptions = {
      platform: plan.platform,
      ...plan.options,
      ...screenshots,
      sourceSha: plan.sourceSha,
      network: plan.network,
      ...(plan.screenshotDeadlineMs !== undefined
        ? { deadlineMs: plan.screenshotDeadlineMs, now: dependencies.now ?? Date.now }
        : {})
    };
    if (plan.platform === 'ios' && screenshotOperations && !screenshots?.legacyPreserved) {
      const journalPath = join(plan.stateDir, screenshotJournalName(screenshotOptions));
      const binding = Object.fromEntries(
        ['appId', 'bundleId', 'version', 'network', 'sourceSha', 'manifestSha256'].map(key => [
          key,
          screenshotOptions[key]
        ])
      );
      const previous = await (dependencies.loadScreenshotJournal ?? loadAttestation)(journalPath);
      if (previous) screenshotOptions.screenshotJournal = validateScreenshotJournal(previous, binding);
      screenshotOptions.persistScreenshotJournal = async value => {
        await (dependencies.persistScreenshotJournal ?? persistJson)(
          journalPath,
          validateScreenshotJournal(value, binding)
        );
      };
    }
    if (plan.platform === 'chrome' && plan.action === 'sync-screenshots')
      return screenshotSummary(
        await screenshotOperations.syncScreenshots(undefined, { ...screenshotOptions, allowWrites: true }),
        plan
      );
    const rawClient = await authenticatedClient(plan, artifact, dependencies);
    const client =
      screenshotOperations && plan.screenshotDeadlineMs !== undefined
        ? screenshotDeadlineClient(rawClient, screenshotOptions)
        : rawClient;
    if (plan.action === 'sync-screenshots')
      return screenshotSummary(
        await screenshotOperations.syncScreenshots(client, { ...screenshotOptions, allowWrites: true }),
        plan
      );
    if (plan.action === 'submit' && plan.platform !== 'chrome' && !screenshots?.legacyPreserved) {
      if (plan.platform === 'ios')
        await screenshotOperations.syncScreenshots(client, { ...screenshotOptions, allowWrites: true });
      const verified = await screenshotOperations.verifyScreenshots(client, screenshotOptions);
      if (verified.matches !== true)
        throw new Error(
          'Remote screenshots do not match canonical release assets; inspect drift and use explicit sync-screenshots before submission'
        );
    }
    if (plan.action === 'begin-edit') {
      const result = await client.request(
        'POST',
        `/androidpublisher/v3/applications/${encodeURIComponent(plan.identity)}/edits`,
        { body: {} }
      );
      if (!/^[A-Za-z0-9_-]+$/.test(result?.id ?? ''))
        throw new Error('Play returned an invalid edit identity; inspect the store before retrying');
      const evidence = {
        packageName: plan.identity,
        editId: result.id,
        version: plan.version,
        sourceSha: plan.sourceSha,
        network: plan.network,
        expiryTimeSeconds: result.expiryTimeSeconds
      };
      try {
        await (dependencies.persistEdit ?? persistJson)(join(plan.stateDir, 'android-edit.json'), evidence);
      } catch {
        throw new Error(
          `Play edit ${result.id} was created but its private state could not be saved; do not create another edit before recovery`
        );
      }
      return {
        platform: 'android',
        ...evidence,
        warning: 'A new edit invalidates a previous edit owned by the same principal'
      };
    }
    const modules = dependencies.operations ?? defaults;
    const handler =
      plan.action === 'prepare'
        ? (modules.ios?.prepare ?? (await import('./apple-prepare.mjs')).prepare)
        : modules[plan.platform]?.[plan.action];
    if (typeof handler !== 'function') throw new Error('The selected publishing operation is unavailable');
    const options = {
      ...plan.options,
      ...(artifact ? { artifact: plan.platform === 'ios' ? expand(args.artifact) : artifact.bytes } : {}),
      ...(chromeSessionPath
        ? {
            uploadSession,
            sourceSha: plan.sourceSha,
            network: plan.network,
            ...(dependencies.nowSeconds ? { nowSeconds: dependencies.nowSeconds } : {}),
            ...(dependencies.wait ? { wait: dependencies.wait } : {}),
            archiveUploadSession: async prior => {
              const archivePath = join(
                plan.stateDir,
                `chrome-${plan.identity}-${prior.version}-${prior.sha256}-submitted.json`
              );
              await (dependencies.archiveChromeUpload ?? archiveChromeUpload)(archivePath, prior);
              uploadSession = undefined;
            },
            persistUploadSession: async patch => {
              const next = { ...artifact.evidence, ...uploadSession, ...patch };
              validateSession(next);
              try {
                await (dependencies.persistChromeUpload ?? persistJson)(chromeSessionPath, next);
              } catch {
                throw new Error(
                  'Chrome upload or submission journal could not be saved; do not retry a store mutation before recovery'
                );
              }
              uploadSession = next;
            }
          }
        : {})
    };
    const result = await handler(client, options);
    if (plan.platform === 'ios' && plan.action === 'prepare' && !screenshots?.legacyPreserved)
      await screenshotOperations.syncScreenshots(client, { ...screenshotOptions, allowWrites: true });
    if (artifact && result?.uploadState !== 'IN_PROGRESS') {
      try {
        await (dependencies.persistAttestation ?? persistJson)(path, {
          ...artifact.evidence,
          uploaded: true,
          ...(result?.completionEvidence ? { completionEvidence: result.completionEvidence } : {})
        });
      } catch {
        throw new Error(
          'The store operation was accepted, but its upload attestation could not be saved; preserve the verified receipt and inspect store state before any retry'
        );
      }
    }
    return result;
  };
  return plan.mutation ? (dependencies.withMutationLock ?? withMutationLock)(plan.stateDir, operation) : operation();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await run(process.argv.slice(2));
    process.stdout.write((typeof result === 'string' ? result : JSON.stringify(result, null, 2)) + '\n');
  } catch (error) {
    process.stderr.write(`Publishing command failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { launchEmulator, launchMarkerPath } = require('./android-emulator-launch.cjs');

const execFileAsync = promisify(execFile);
const AVD_NAME = 'Pixel_API_34';
const SERIAL = 'emulator-5554';
const PORT = 5554;
const SNAPSHOT_NAME = 'bridge-in-warm';
const CORES = 4;
const MEMORY_MB = 4096;
const GPU = 'host';
const FEATURES = '-Vulkan';
const SNAPSHOT_PROOF_PROPERTY = 'debug.miden.warm_avd_proof';
const IMAGE_PACKAGE = 'system-images;android-34;default;x86_64';
const IMAGE_PACKAGE_XML = path.join(
  process.env.ANDROID_HOME ?? '',
  'system-images/android-34/default/x86_64/package.xml'
);
const BOOT_TIMEOUT_MS = 240_000;
const RESTORE_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 1_000;
const adb = path.join(process.env.ANDROID_HOME ?? '', 'platform-tools', 'adb');
const emulator = path.join(process.env.ANDROID_HOME ?? '', 'emulator', 'emulator');
const avdHome = process.env.ANDROID_AVD_HOME ?? path.join(os.homedir(), '.android', 'avd');
const avdDir = path.join(avdHome, `${AVD_NAME}.avd`);
const avdIniPath = path.join(avdHome, `${AVD_NAME}.ini`);
const manifestPath = path.join(avdHome, '.wallet-warm-avd.json');

async function run(file, args, timeout = 30_000) {
  return execFileAsync(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 });
}

async function adbRun(args, timeout = 30_000) {
  return run(adb, args, timeout);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function directoryBytes(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const entryPath = path.join(directory, entry.name);
    return total + (entry.isDirectory() ? directoryBytes(entryPath) : fs.statSync(entryPath).size);
  }, 0);
}

function avdConfigSha256() {
  const hash = crypto.createHash('sha256');
  for (const file of [avdIniPath, path.join(avdDir, 'config.ini')]) {
    hash.update(path.basename(file));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForBoot(timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const { stdout } = await adbRun(['-s', SERIAL, 'shell', 'getprop', 'sys.boot_completed'], 10_000);
      if (stdout.trim() === '1') return Date.now() - startedAt;
    } catch {
      // ADB is expected to be unavailable briefly during guest startup.
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Visible ${AVD_NAME} did not reach sys.boot_completed within ${timeoutMs}ms.`);
}

async function stopEmulator() {
  try {
    await adbRun(['-s', SERIAL, 'emu', 'kill'], 10_000);
  } catch {
    // The emulator may already have exited after a failed boot.
  }
  const receiptPath = launchMarkerPath(PORT);
  let pid;
  try {
    pid = JSON.parse(fs.readFileSync(receiptPath, 'utf8')).pid;
  } catch {
    return;
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
        fs.rmSync(receiptPath, { force: true });
        return;
      }
      throw error;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Emulator process ${pid} did not exit after adb emu kill.`);
}

async function assertInstalledApk(apkPath, expectedSha256 = sha256(apkPath)) {
  const { stdout } = await adbRun(['-s', SERIAL, 'shell', 'pm', 'path', 'com.miden.wallet']);
  const installedPaths = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('package:'))
    .map(line => line.slice('package:'.length));
  if (installedPaths.length !== 1 || path.basename(installedPaths[0]) !== 'base.apk') {
    throw new Error(`Expected one installed wallet base.apk; Android reported ${installedPaths.length} paths.`);
  }

  const { stdout: hashOutput } = await adbRun(['-s', SERIAL, 'shell', 'sha256sum', installedPaths[0]], 30_000);
  const actualSha256 = hashOutput.trim().split(/\s+/)[0] ?? '';
  if (!/^[a-f0-9]{64}$/i.test(actualSha256) || actualSha256 !== expectedSha256) {
    throw new Error(`Installed wallet APK SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}.`);
  }
}

async function assertSnapshotProof(expectedProof) {
  const { stdout } = await adbRun(['-s', SERIAL, 'shell', 'getprop', SNAPSHOT_PROOF_PROPERTY], 10_000);
  if (stdout.trim() !== expectedProof) {
    throw new Error('The emulator booted without restoring the exact prepared warm AVD snapshot.');
  }
}

function launch(snapshotName) {
  const logPath = path.join(process.env.GITHUB_WORKSPACE ?? process.cwd(), 'test-results-android', 'emulator-logs',
    `${AVD_NAME}-${PORT}-warm-preparation.log`);
  const markerPath = launchMarkerPath(PORT);
  return launchEmulator({
    emulatorBin: emulator,
    avdName: AVD_NAME,
    port: PORT,
    visible: true,
    cores: CORES,
    logPath,
    markerPath,
    snapshotName
  });
}

async function listSnapshots() {
  const { stdout, stderr } = await run(emulator, ['-avd', AVD_NAME, '-snapshot-list'], 30_000);
  const output = `${stdout}\n${stderr}`;
  if (!new RegExp(`(?:^|\\s)${SNAPSHOT_NAME}(?:\\s|$)`, 'm').test(output)) {
    throw new Error(`The prepared AVD does not contain the required "${SNAPSHOT_NAME}" snapshot.`);
  }
  return output;
}

async function prepare() {
  const apkPath = path.join(process.env.GITHUB_WORKSPACE ?? process.cwd(),
    'android/app/build/outputs/apk/debug/app-debug.apk');
  if (!fs.statSync(apkPath).isFile()) throw new Error(`Prepared APK is missing: ${apkPath}`);
  if (!fs.statSync(path.join(avdDir, 'config.ini')).isFile()) throw new Error(`AVD configuration is missing: ${avdDir}`);

  const apkSha256 = sha256(apkPath);
  const snapshotProof = crypto.randomBytes(32).toString('hex');
  launch(null); // Cold boot with Quick Boot enabled so an explicit clean snapshot can be saved.
  try {
    await waitForBoot(BOOT_TIMEOUT_MS);
    await adbRun(['-s', SERIAL, 'install', '-r', '-t', apkPath], 180_000);
    await adbRun(['-s', SERIAL, 'shell', 'pm', 'grant', 'com.miden.wallet', 'android.permission.POST_NOTIFICATIONS'])
      .catch(() => {});
    await adbRun(['-s', SERIAL, 'shell', 'pm', 'clear', 'com.miden.wallet']);
    await assertInstalledApk(apkPath, apkSha256);
    await adbRun(['-s', SERIAL, 'shell', 'setprop', SNAPSHOT_PROOF_PROPERTY, snapshotProof]);
    await assertSnapshotProof(snapshotProof);
    await adbRun(['-s', SERIAL, 'emu', 'avd', 'snapshot', 'save', SNAPSHOT_NAME], 60_000);
  } finally {
    await stopEmulator();
  }

  await listSnapshots();
  const restoreMs = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    launch(SNAPSHOT_NAME);
    try {
      const elapsedMs = await waitForBoot(RESTORE_TIMEOUT_MS);
      await assertInstalledApk(apkPath, apkSha256);
      await assertSnapshotProof(snapshotProof);
      restoreMs.push(elapsedMs);
    } finally {
      await stopEmulator();
    }
  }

  if (restoreMs.length !== 2 || restoreMs.some(elapsedMs => elapsedMs > RESTORE_TIMEOUT_MS)) {
    throw new Error(`The exact AVD snapshot failed its two-restore startup gate: ${restoreMs.join(', ')}ms.`);
  }

  const configSha256 = avdConfigSha256();
  const manifest = {
    schemaVersion: 1,
    commit: process.env.GITHUB_SHA,
    workflowRunId: process.env.GITHUB_RUN_ID,
    cacheKey: process.env.WARM_AVD_CACHE_KEY,
    runnerOs: process.env.RUNNER_OS,
    runnerArch: process.env.RUNNER_ARCH,
    imageOs: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
    avdName: AVD_NAME,
    avdConfigSha256: configSha256,
    api: 34,
    abi: 'x86_64',
    imagePackage: IMAGE_PACKAGE,
    systemImagePackageXmlSha256: sha256(IMAGE_PACKAGE_XML),
    emulatorVersion: process.env.ANDROID_EMULATOR_VERSION,
    emulatorArchiveBuild: process.env.ANDROID_EMULATOR_ARCHIVE_BUILD,
    emulatorArchiveSha256: process.env.ANDROID_EMULATOR_ARCHIVE_SHA256,
    gpu: GPU,
    features: FEATURES,
    visible: true,
    cores: CORES,
    memoryMb: MEMORY_MB,
    snapshotName: SNAPSHOT_NAME,
    snapshotProof,
    apkSha256,
    avdBytes: directoryBytes(avdDir),
    restoreMs,
    preparedAt: new Date().toISOString()
  };
  for (const [key, value] of Object.entries(manifest)) {
    if (value === undefined) throw new Error(`Warm AVD provenance is missing ${key}.`);
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.copyFileSync(manifestPath, process.env.WARM_AVD_ARTIFACT_MANIFEST);
  console.log(
    `Verified visible ${SNAPSHOT_NAME} snapshot restores in ${restoreMs.join('ms, ')}ms; ` +
    `AVD data size is ${manifest.avdBytes} bytes.`
  );
}

function verifyCache() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const expected = {
    schemaVersion: 1,
    commit: process.env.GITHUB_SHA,
    workflowRunId: process.env.PREPARED_RUN_ID,
    cacheKey: process.env.WARM_AVD_CACHE_KEY,
    runnerOs: process.env.RUNNER_OS,
    runnerArch: process.env.RUNNER_ARCH,
    imageOs: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
    avdName: AVD_NAME,
    api: 34,
    abi: 'x86_64',
    imagePackage: IMAGE_PACKAGE,
    systemImagePackageXmlSha256: sha256(IMAGE_PACKAGE_XML),
    emulatorVersion: process.env.ANDROID_EMULATOR_VERSION,
    emulatorArchiveBuild: process.env.ANDROID_EMULATOR_ARCHIVE_BUILD,
    emulatorArchiveSha256: process.env.ANDROID_EMULATOR_ARCHIVE_SHA256,
    gpu: GPU,
    features: FEATURES,
    visible: true,
    cores: CORES,
    memoryMb: MEMORY_MB,
    snapshotName: SNAPSHOT_NAME
  };
  for (const [key, value] of Object.entries(expected)) {
    if (manifest[key] !== value) throw new Error(`Warm AVD cache provenance mismatch for ${key}.`);
  }
  if (!Array.isArray(manifest.restoreMs) || manifest.restoreMs.length !== 2 ||
      manifest.restoreMs.some(value => !Number.isSafeInteger(value) || value > RESTORE_TIMEOUT_MS)) {
    throw new Error('Warm AVD cache does not contain two successful bounded snapshot restore measurements.');
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.apkSha256) || !/^[a-f0-9]{64}$/.test(manifest.avdConfigSha256)) {
    throw new Error('Warm AVD cache provenance contains a malformed APK or AVD configuration digest.');
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.snapshotProof)) {
    throw new Error('Warm AVD cache provenance contains a malformed guest snapshot proof.');
  }
  if (!Number.isSafeInteger(manifest.avdBytes) || manifest.avdBytes <= 0 ||
      directoryBytes(avdDir) !== manifest.avdBytes) {
    throw new Error('Restored warm AVD data size does not match the verified preparation.');
  }
  if (!fs.statSync(avdIniPath).isFile() || !fs.statSync(path.join(avdDir, 'config.ini')).isFile() ||
      avdConfigSha256() !== manifest.avdConfigSha256) {
    throw new Error('Restored warm AVD configuration differs from the verified preparation.');
  }
  listSnapshotsSync();
  if (!process.env.GITHUB_ENV) throw new Error('GITHUB_ENV is required to pass the verified snapshot proof to the live test.');
  fs.appendFileSync(process.env.GITHUB_ENV, `E2E_ANDROID_WARM_AVD_PROOF=${manifest.snapshotProof}\n`);
  console.log(`Verified exact visible warm AVD cache for ${manifest.commit} from prep run ${manifest.workflowRunId}.`);
}

function listSnapshotsSync() {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(emulator, ['-avd', AVD_NAME, '-snapshot-list'], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`Could not list warm AVD snapshots: ${result.stderr || result.stdout}`);
  if (!new RegExp(`(?:^|\\s)${SNAPSHOT_NAME}(?:\\s|$)`, 'm').test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error(`The restored AVD is missing the required "${SNAPSHOT_NAME}" snapshot.`);
  }
}

async function main(mode) {
  if (!process.env.ANDROID_HOME) throw new Error('ANDROID_HOME must point to the pinned Android SDK.');
  if (!fs.statSync(avdHome, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Android AVD home is missing: ${avdHome}`);
  }
  if (mode === 'prepare') return prepare();
  if (mode === 'verify-cache') return verifyCache();
  throw new Error('Usage: node scripts/android-warm-avd.cjs <prepare|verify-cache>');
}

if (require.main === module) {
  main(process.argv[2]).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };

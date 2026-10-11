'use strict';

const { spawn } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BRIDGE_IN_AVD = 'Pixel_API_34';
const BRIDGE_IN_PORT = 5554;
const BRIDGE_IN_CORES = 4;
const BRIDGE_IN_GPU = 'host';

function buildEmulatorArgs({ avdName, port, visible, cores, snapshotName }) {
  const args = [
    '-avd',
    avdName,
    '-port',
    String(port),
    '-accel',
    'on',
    '-no-audio',
    // Hardware rendering keeps Quick Boot snapshots supported on the visible CI AVD.
    '-gpu',
    BRIDGE_IN_GPU,
    '-no-boot-anim',
    '-feature',
    '-Vulkan',
    ...(!visible ? ['-no-window'] : []),
    // Keep the measured guest memory ceiling for the visible wallet path.
    '-memory',
    '4096',
    '-cores',
    String(cores)
  ];

  if (snapshotName === undefined) {
    args.push('-no-snapshot');
  } else if (snapshotName === null) {
    args.push('-no-snapshot-load');
  } else if (snapshotName !== null) {
    args.push('-snapshot', snapshotName, '-no-snapshot-save');
  }
  return args;
}

function launchEmulator({ emulatorBin, avdName, port, visible, cores, logPath, markerPath, snapshotName }) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(
    emulatorBin,
    buildEmulatorArgs({ avdName, port, visible, cores, snapshotName }),
    { detached: true, stdio: ['ignore', logFd, logFd] }
  );
  child.unref();

  if (markerPath) {
    if (!child.pid) throw new Error(`The Android emulator process for ${avdName} did not expose a PID.`);
    const marker = {
      pid: child.pid,
      avdName,
      port,
      visible,
      snapshotName: snapshotName ?? null,
      startedAt: new Date().toISOString()
    };
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    const temporary = `${markerPath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`);
    fs.renameSync(temporary, markerPath);
  }
  return child;
}

function launchMarkerPath(port) {
  if (port === BRIDGE_IN_PORT && process.env.E2E_ANDROID_EMULATOR_START_MARKER) {
    return process.env.E2E_ANDROID_EMULATOR_START_MARKER;
  }
  const tempDir = process.env.RUNNER_TEMP ?? os.tmpdir();
  return path.join(tempDir, `miden-wallet-android-emulator-${port}.json`);
}

function getLiveLaunchReceipt(markerPath, avdName, port, requireVisible, expectedSnapshotName) {
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }

  if (marker.avdName !== avdName || marker.port !== port || !Number.isInteger(marker.pid) || marker.pid <= 0) {
    throw new Error(`Android emulator launch receipt ${markerPath} does not match ${avdName} on port ${port}.`);
  }
  if (requireVisible && marker.visible !== true) {
    throw new Error(`Emulator ${avdName} on port ${port} was not launched visibly.`);
  }
  if (expectedSnapshotName !== undefined && marker.snapshotName !== expectedSnapshotName) {
    throw new Error(
      `Emulator ${avdName} on port ${port} was not launched from snapshot "${expectedSnapshotName}".`
    );
  }

  try {
    process.kill(marker.pid, 0);
    return marker;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
      fs.rmSync(markerPath, { force: true });
      return null;
    }
    throw error;
  }
}

function launchBridgeInEmulatorFromEnvironment() {
  const rootDir = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const androidHome =
    process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? path.join(os.homedir(), 'Library/Android/sdk');
  const serial = `emulator-${BRIDGE_IN_PORT}`;
  const logPath = path.join(rootDir, 'test-results-android', 'emulator-logs', `${BRIDGE_IN_AVD}-${BRIDGE_IN_PORT}.log`);
  const snapshotName = process.env.E2E_ANDROID_WARM_AVD_SNAPSHOT_NAME;
  const snapshotMode = process.env.E2E_ANDROID_AVD_SNAPSHOT_MODE;
  if (snapshotMode === 'save' && snapshotName) {
    throw new Error('Snapshot preparation must boot without selecting a named snapshot.');
  }
  if (snapshotMode && snapshotMode !== 'save' && snapshotMode !== 'restore') {
    throw new Error(`Unsupported Android AVD snapshot mode: ${snapshotMode}`);
  }
  if (snapshotMode === 'restore' && !snapshotName) {
    throw new Error('Snapshot restore requires E2E_ANDROID_WARM_AVD_SNAPSHOT_NAME.');
  }
  const child = launchEmulator({
    emulatorBin: path.join(androidHome, 'emulator', 'emulator'),
    avdName: BRIDGE_IN_AVD,
    port: BRIDGE_IN_PORT,
    visible: true,
    cores: BRIDGE_IN_CORES,
    logPath,
    markerPath: launchMarkerPath(BRIDGE_IN_PORT),
    ...(snapshotMode === 'save'
      ? { snapshotName: null }
      : snapshotMode === 'restore'
        ? { snapshotName }
        : {})
  });
  console.log(`Visible Android emulator boot started on ${serial} (pid ${child.pid}).`);
}

module.exports = { buildEmulatorArgs, getLiveLaunchReceipt, launchEmulator, launchMarkerPath };

if (require.main === module) {
  try {
    launchBridgeInEmulatorFromEnvironment();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

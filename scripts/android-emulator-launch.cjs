'use strict';

const { spawn } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BRIDGE_IN_AVD = 'Pixel_API_34';
const BRIDGE_IN_PORT = 5554;
const BRIDGE_IN_CORES = 4;

function launchEmulator({ emulatorBin, avdName, port, visible, cores, logPath, markerPath }) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(
    emulatorBin,
    [
      '-avd',
      avdName,
      '-port',
      String(port),
      '-accel',
      'on',
      '-no-snapshot',
      '-no-audio',
      '-gpu',
      'swiftshader_indirect',
      '-no-boot-anim',
      ...(!visible ? ['-no-window'] : []),
      // Keep the measured guest memory ceiling; the visible wallet path uses
      // software rendering to avoid host-GPU memory spikes under HVF.
      '-memory',
      '4096',
      '-cores',
      String(cores)
    ],
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

function getLiveLaunchReceipt(markerPath, avdName, port, requireVisible) {
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
  const child = launchEmulator({
    emulatorBin: path.join(androidHome, 'emulator', 'emulator'),
    avdName: BRIDGE_IN_AVD,
    port: BRIDGE_IN_PORT,
    visible: true,
    cores: BRIDGE_IN_CORES,
    logPath,
    markerPath: launchMarkerPath(BRIDGE_IN_PORT)
  });
  console.log(`Visible Android emulator boot started on ${serial} (pid ${child.pid}).`);
}

module.exports = { getLiveLaunchReceipt, launchEmulator, launchMarkerPath };

if (require.main === module) {
  try {
    launchBridgeInEmulatorFromEnvironment();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

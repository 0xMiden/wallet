import { test as base } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getEnvironmentConfig } from '../../config/environments';
import { CLIRunner } from '../../harness/cli-runner';
import { buildFailureReport, saveFailureReport } from '../../harness/failure-report';
import { captureWalletSnapshot } from '../../harness/state-snapshot';
import { TestStepRunner } from '../../harness/test-step';
import { TimelineRecorder } from '../../harness/timeline-recorder';
import type {
  EnvironmentConfig,
  SerializedWalletState,
  SnapshotCaps,
} from '../../harness/types';
import { MidenCli, resolveCliPath } from '../../helpers/miden-cli';
import { AndroidWalletPage } from '../helpers/android-wallet-page';
import { CdpBridge, type CdpSession } from '../helpers/cdp-bridge';
import { EmulatorControl } from '../helpers/emulator-control';

// ── Constants ───────────────────────────────────────────────────────────────

const ROOT_DIR = path.resolve(__dirname, '../../../..');
const APK_PATH = path.join(ROOT_DIR, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const PACKAGE_NAME = 'com.miden.wallet';
const ACTIVITY_NAME = '.MainActivity';

// Forwarded host ports for each emulator's WebView devtools socket. Static
// per-wallet because re-using ports across launches is fine and avoids the
// race condition of two emulators picking the same random port.
const HOST_PORT_A = 9230;
const HOST_PORT_B = 9231;

// ── Types ───────────────────────────────────────────────────────────────────

type TwoEmulatorFixtures = {
  walletA: AndroidWalletPage;
  walletB: AndroidWalletPage;
  midenCli: MidenCli;
  timeline: TimelineRecorder;
  steps: TestStepRunner;
  envConfig: EnvironmentConfig;
  _emuPair: {
    instanceA: EmuWalletInstance;
    instanceB: EmuWalletInstance;
    emuA: EmulatorControl;
    emuB: EmulatorControl;
  };
};

interface EmuWalletInstance {
  walletPage: AndroidWalletPage;
  cdp: CdpSession;
  serial: string;
  packageName: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getRunOutputDir(testId: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(ROOT_DIR, 'test-results-android', `run-${timestamp}`, 'tests', testId);
}

// First-install tracking — same trick as iOS. First test installs the APK,
// subsequent tests just wipe app data (faster).
const installedSerials = new Set<string>();

async function launchEmuWalletInstance(
  emu: EmulatorControl,
  serial: string,
  envConfig: EnvironmentConfig,
  timeline: TimelineRecorder,
  label: 'A' | 'B',
  hostPort: number
): Promise<EmuWalletInstance> {
  const phaseStart = (): number => Date.now();
  const ms = (s: number): number => Date.now() - s;

  const tTerminate = phaseStart();
  await emu.terminate(serial, PACKAGE_NAME);
  const terminateMs = ms(tTerminate);

  const firstInstall = !installedSerials.has(serial);
  let uninstallMs = 0;
  let installMs = 0;
  let wipeMs = 0;
  if (firstInstall) {
    const tUninstall = phaseStart();
    await emu.uninstall(serial, PACKAGE_NAME);
    uninstallMs = ms(tUninstall);

    const tInstall = phaseStart();
    await emu.install(serial, APK_PATH);
    installMs = ms(tInstall);
    installedSerials.add(serial);
  } else {
    const tWipe = phaseStart();
    await emu.wipeAppState(serial, PACKAGE_NAME);
    wipeMs = ms(tWipe);
  }

  const tLaunch = phaseStart();
  // MIDEN_E2E_TEST + MIDEN_NETWORK are build-time baked on Android (vite
  // define) — the env arg here is a no-op kept for interface symmetry
  // with iOS's SIMCTL_CHILD_* env passing.
  await emu.launch(
    serial,
    PACKAGE_NAME,
    {
      MIDEN_E2E_TEST: 'true',
      MIDEN_NETWORK: envConfig.name,
    },
    ACTIVITY_NAME
  );
  const launchMs = ms(tLaunch);

  const tSleep = phaseStart();
  // WebView needs a few seconds to register with webview_devtools_remote
  // after a cold launch.
  await sleep(3_000);
  const sleepMs = ms(tSleep);

  const tCdp = phaseStart();
  const cdp = await CdpBridge.connect({
    serial,
    packageName: PACKAGE_NAME,
    hostPort,
  });
  const cdpConnectMs = ms(tCdp);

  cdp.onConsoleLog(entry => {
    // eslint-disable-next-line no-console
    console.log(`[wallet ${label} ${entry.level}] ${entry.text}`);
  });

  const walletPage = new AndroidWalletPage({ cdp, emulator: emu, serial, packageName: PACKAGE_NAME });

  timeline.emit({
    category: 'test_lifecycle',
    severity: 'info',
    wallet: label,
    message:
      `Wallet ${label} launched on serial ${serial} ` +
      `(terminate=${terminateMs}ms ${firstInstall ? `uninstall=${uninstallMs}ms install=${installMs}ms` : `wipe=${wipeMs}ms`} ` +
      `launch=${launchMs}ms sleep=${sleepMs}ms cdp=${cdpConnectMs}ms)`,
    data: {
      serial,
      packageName: PACKAGE_NAME,
      fixturePhases: {
        terminateMs,
        uninstallMs,
        installMs,
        wipeMs,
        launchMs,
        sleepMs,
        cdpConnectMs,
        firstInstall,
      },
    },
  });

  return { walletPage, cdp, serial, packageName: PACKAGE_NAME };
}

function buildAndroidSnapshotCaps(walletPage: AndroidWalletPage, runtimeVersion: string): SnapshotCaps {
  return {
    platform: 'ios', // SnapshotCaps' platform tag tells consumers "treat as mobile"; android == ios for those consumers
    runtimeVersion,
    readStore: () =>
      walletPage.evaluate((): SerializedWalletState | null => {
        const store = (window as { __TEST_STORE__?: { getState(): SerializedWalletState } }).__TEST_STORE__;
        if (!store) return null;
        const s = store.getState();
        return {
          status: s.status,
          accounts: s.accounts?.map(a => ({ publicKey: a.publicKey, name: a.name })),
          currentAccount: s.currentAccount
            ? { publicKey: s.currentAccount.publicKey, name: s.currentAccount.name }
            : null,
          balances: s.balances,
        };
      }),
    hasIntercom: () =>
      walletPage.evaluate(() => Boolean((window as { __TEST_INTERCOM__?: unknown }).__TEST_INTERCOM__)),
    currentUrl: () => walletPage.evaluate(() => window.location.href),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Fixture ─────────────────────────────────────────────────────────────────

let _devicePair: { serialA: string; serialB: string } | null = null;
async function devicePair(): Promise<{ serialA: string; serialB: string }> {
  if (_devicePair) return _devicePair;
  _devicePair = await EmulatorControl.reservePair();
  return _devicePair;
}

export const test = base.extend<TwoEmulatorFixtures>({
  envConfig: async ({}, use) => {
    await use(getEnvironmentConfig());
  },

  timeline: async ({}, use, testInfo) => {
    const outputDir = getRunOutputDir(testInfo.titlePath.join('-').replace(/\s+/g, '_'));
    const timeline = new TimelineRecorder(outputDir);

    timeline.emit({
      category: 'test_lifecycle',
      severity: 'info',
      message: `Test started: ${testInfo.title}`,
      data: { testFile: testInfo.file, testTitle: testInfo.title, platform: 'android' },
    });

    await use(timeline);

    timeline.emit({
      category: 'test_lifecycle',
      severity: testInfo.status === 'passed' ? 'info' : 'error',
      message: `Test ${testInfo.status}: ${testInfo.title}`,
      data: { status: testInfo.status, duration: testInfo.duration },
    });

    await timeline.close();
  },

  steps: async ({ timeline }, use) => {
    const outputDir = timeline.getOutputDir();
    const runner = new TestStepRunner(timeline, outputDir);
    await use(runner);
    runner.saveCheckpoints();
  },

  midenCli: async ({ envConfig, timeline }, use) => {
    const binaryPath = resolveCliPath();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miden-cli-android-'));
    const cliRunner = new CLIRunner(timeline);
    const cli = new MidenCli({ binaryPath, workDir, env: envConfig, cliRunner });

    timeline.emit({
      category: 'test_lifecycle',
      severity: 'info',
      message: `MidenCli initialized (workDir: ${workDir}, binary: ${binaryPath})`,
      data: { workDir, binaryPath, network: envConfig.name },
    });

    await use(cli);
    await cli.cleanup();
  },

  _emuPair: async ({ envConfig, timeline, steps }, use) => {
    const { serialA, serialB } = await devicePair();
    const emuA = new EmulatorControl();
    const emuB = new EmulatorControl();

    // Sequential install/launch — parallel adb operations against two
    // emulators can race on the shared adb server (observed flaky
    // "device not found" errors on cold runners). Wipe-only path is fast
    // enough that the parallelism savings aren't worth the flakiness.
    const instanceA = await launchEmuWalletInstance(emuA, serialA, envConfig, timeline, 'A', HOST_PORT_A);
    const instanceB = await launchEmuWalletInstance(emuB, serialB, envConfig, timeline, 'B', HOST_PORT_B);
    steps.registerSnapshotCaps('A', buildAndroidSnapshotCaps(instanceA.walletPage, ''));
    steps.registerSnapshotCaps('B', buildAndroidSnapshotCaps(instanceB.walletPage, ''));

    await use({ instanceA, instanceB, emuA, emuB });

    await Promise.allSettled([
      instanceA.cdp.close().catch(() => undefined),
      instanceB.cdp.close().catch(() => undefined),
    ]);
    await Promise.allSettled([
      emuA.terminate(serialA, PACKAGE_NAME).catch(() => undefined),
      emuB.terminate(serialB, PACKAGE_NAME).catch(() => undefined),
    ]);
  },

  walletA: async ({ _emuPair, timeline }, use) => {
    const instance = _emuPair.instanceA;
    await use(instance.walletPage);

    const stats = instance.walletPage.getStats();
    timeline.emit({
      category: 'test_lifecycle',
      severity: 'info',
      wallet: 'A',
      message:
        `Wallet A stats: ` +
        `eval=${stats.cdp.evalCount}×${Math.round(stats.cdp.evalMs)}ms ` +
        `async=${stats.cdp.evalAsyncCount}×${Math.round(stats.cdp.evalAsyncMs)}ms ` +
        `evaluate=${stats.cdp.evaluateCount}×${Math.round(stats.cdp.evaluateMs)}ms ` +
        `polls=${stats.polls.pollCount} iters=${stats.polls.pollIterations} ` +
        `pollWall=${Math.round(stats.polls.pollMs)}ms pollSleep=${stats.polls.pollSleepMs}ms`,
      data: stats,
    });
  },

  walletB: async ({ _emuPair, timeline, steps, midenCli: _midenCli }, use, testInfo) => {
    const instance = _emuPair.instanceB;
    await use(instance.walletPage);

    const statsB = instance.walletPage.getStats();
    timeline.emit({
      category: 'test_lifecycle',
      severity: 'info',
      wallet: 'B',
      message:
        `Wallet B stats: ` +
        `eval=${statsB.cdp.evalCount}×${Math.round(statsB.cdp.evalMs)}ms ` +
        `async=${statsB.cdp.evalAsyncCount}×${Math.round(statsB.cdp.evalAsyncMs)}ms ` +
        `evaluate=${statsB.cdp.evaluateCount}×${Math.round(statsB.cdp.evaluateMs)}ms ` +
        `polls=${statsB.polls.pollCount} iters=${statsB.polls.pollIterations} ` +
        `pollWall=${Math.round(statsB.polls.pollMs)}ms pollSleep=${statsB.polls.pollSleepMs}ms`,
      data: statsB,
    });

    if (testInfo.status !== 'passed' && testInfo.error) {
      try {
        const reportDir = timeline.getOutputDir();
        const capsA = steps.walletCaps.A;
        const capsB = steps.walletCaps.B;

        const stateA = capsA
          ? await captureWalletSnapshot(capsA, 'A', timeline.currentStep, 'failure').catch(() => undefined)
          : undefined;
        const stateB = capsB
          ? await captureWalletSnapshot(capsB, 'B', timeline.currentStep, 'failure').catch(() => undefined)
          : undefined;

        const err = new Error(testInfo.error.message ?? 'Unknown error');
        err.stack = testInfo.error.stack ?? '';

        const report = buildFailureReport({
          testName: testInfo.title,
          testFile: testInfo.file ?? '',
          error: err,
          timeline,
          steps,
          stateAtFailure: { walletA: stateA, walletB: stateB },
          testTimeoutMs: testInfo.timeout,
        });

        saveFailureReport(report, reportDir);
      } catch {
        // don't let report generation fail teardown
      }
    }
  },
});

export const expect = test.expect;

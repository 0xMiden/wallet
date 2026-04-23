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
import { CdpBridge, type CdpSession } from '../helpers/cdp-bridge';
import { IosWalletPage } from '../helpers/ios-wallet-page';
import { SimulatorControl } from '../helpers/simulator-control';

// ── Constants ───────────────────────────────────────────────────────────────

const ROOT_DIR = path.resolve(__dirname, '../../../..');
const APP_PATH = path.join(
  ROOT_DIR,
  'ios',
  'App',
  'build',
  'Build',
  'Products',
  'Debug-iphonesimulator',
  'App.app'
);
const BUNDLE_ID = 'com.miden.wallet';

// ── Types ───────────────────────────────────────────────────────────────────

type TwoSimulatorFixtures = {
  walletA: IosWalletPage;
  walletB: IosWalletPage;
  midenCli: MidenCli;
  timeline: TimelineRecorder;
  steps: TestStepRunner;
  envConfig: EnvironmentConfig;
};

interface SimWalletInstance {
  walletPage: IosWalletPage;
  cdp: CdpSession;
  udid: string;
  bundleId: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getRunOutputDir(testId: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(ROOT_DIR, 'test-results-ios', `run-${timestamp}`, 'tests', testId);
}

/**
 * Bring one simulator from "booted but app not running" to "app launched +
 * CDP connected + IosWalletPage ready". Per-test isolation: uninstall +
 * install wipes the IndexedDB / Preferences sandbox without touching boot
 * state (~5s instead of the ~30s `simctl erase` would cost).
 */
async function launchSimWalletInstance(
  sim: SimulatorControl,
  udid: string,
  envConfig: EnvironmentConfig,
  timeline: TimelineRecorder,
  label: 'A' | 'B'
): Promise<SimWalletInstance> {
  const phaseStart = (): number => Date.now();
  const ms = (s: number): number => Date.now() - s;

  const tTerminate = phaseStart();
  await sim.terminate(udid, BUNDLE_ID);
  const terminateMs = ms(tTerminate);

  const tUninstall = phaseStart();
  await sim.uninstall(udid, BUNDLE_ID);
  const uninstallMs = ms(tUninstall);

  const tInstall = phaseStart();
  await sim.install(udid, APP_PATH);
  const installMs = ms(tInstall);

  const tLaunch = phaseStart();
  await sim.launch(udid, BUNDLE_ID, {
    MIDEN_E2E_TEST: 'true',
    MIDEN_NETWORK: envConfig.name,
  });
  const launchMs = ms(tLaunch);

  const tSleep = phaseStart();
  // The WebView needs a couple seconds to register with webinspectord_sim.
  await sleep(3_000);
  const sleepMs = ms(tSleep);

  const tCdp = phaseStart();
  const cdp = await CdpBridge.connect({ udid, bundleId: BUNDLE_ID });
  const cdpConnectMs = ms(tCdp);

  const walletPage = new IosWalletPage({ cdp, sim, udid, bundleId: BUNDLE_ID });

  timeline.emit({
    category: 'test_lifecycle',
    severity: 'info',
    wallet: label,
    message:
      `Wallet ${label} launched on udid ${udid} ` +
      `(terminate=${terminateMs}ms uninstall=${uninstallMs}ms install=${installMs}ms ` +
      `launch=${launchMs}ms sleep=${sleepMs}ms cdp=${cdpConnectMs}ms)`,
    data: {
      udid,
      bundleId: BUNDLE_ID,
      fixturePhases: { terminateMs, uninstallMs, installMs, launchMs, sleepMs, cdpConnectMs },
    },
  });

  return { walletPage, cdp, udid, bundleId: BUNDLE_ID };
}

/**
 * Build platform-neutral SnapshotCaps for an iOS wallet. Mirrors
 * buildChromeSnapshotCaps in two-wallets.ts — the harness sees a uniform
 * surface.
 */
function buildIosSnapshotCaps(walletPage: IosWalletPage, runtimeVersion: string): SnapshotCaps {
  return {
    platform: 'ios',
    runtimeVersion,
    readStore: () =>
      walletPage.evaluate((): SerializedWalletState | null => {
        const store = (window as { __TEST_STORE__?: { getState(): SerializedWalletState } })
          .__TEST_STORE__;
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
      walletPage.evaluate(() =>
        Boolean((window as { __TEST_INTERCOM__?: unknown }).__TEST_INTERCOM__)
      ),
    // No serviceWorkerStatus — mobile has no SW.
    currentUrl: () => walletPage.evaluate(() => window.location.href),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Fixture ─────────────────────────────────────────────────────────────────

let _devicePair: { udidA: string; udidB: string } | null = null;
async function devicePair(): Promise<{ udidA: string; udidB: string }> {
  if (_devicePair) return _devicePair;
  _devicePair = await SimulatorControl.reservePair();
  return _devicePair;
}

export const test = base.extend<TwoSimulatorFixtures>({
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
      data: { testFile: testInfo.file, testTitle: testInfo.title, platform: 'ios' },
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
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miden-cli-'));
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

  walletA: async ({ envConfig, timeline, steps }, use) => {
    const { udidA } = await devicePair();
    const sim = new SimulatorControl();
    const instance = await launchSimWalletInstance(sim, udidA, envConfig, timeline, 'A');
    steps.registerSnapshotCaps('A', buildIosSnapshotCaps(instance.walletPage, ''));

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

    try {
      await instance.cdp.close();
    } catch {
      // ignore
    }
    try {
      await sim.terminate(udidA, BUNDLE_ID);
    } catch {
      // ignore
    }
  },

  walletB: async ({ envConfig, timeline, steps, walletA: _walletA, midenCli: _midenCli }, use, testInfo) => {
    const { udidB } = await devicePair();
    const sim = new SimulatorControl();
    const instance = await launchSimWalletInstance(sim, udidB, envConfig, timeline, 'B');
    steps.registerSnapshotCaps('B', buildIosSnapshotCaps(instance.walletPage, ''));

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
          ? await captureWalletSnapshot(capsA, 'A', timeline.currentStep, 'failure').catch(
              () => undefined
            )
          : undefined;
        const stateB = capsB
          ? await captureWalletSnapshot(capsB, 'B', timeline.currentStep, 'failure').catch(
              () => undefined
            )
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
        // Don't let report generation fail the test teardown
      }
    }

    try {
      await instance.cdp.close();
    } catch {
      // ignore
    }
    try {
      await sim.terminate(udidB, BUNDLE_ID);
    } catch {
      // ignore
    }
  },
});

export const expect = test.expect;

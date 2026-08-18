/* eslint-disable no-empty-pattern -- Playwright PARSES the fixture function's source to
   resolve its fixture dependencies, and rejects anything but a destructuring pattern in the
   first argument: `async (_, use)` fails at runtime with "First argument must use the object
   destructuring pattern". `async ({}, use)` is the required idiom, not a style choice. */
import { test as base } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getEnvironmentConfig } from '../../config/environments';
import { testArtifactDirName } from '../../harness/artifact-path';
import { CLIRunner } from '../../harness/cli-runner';
import { buildFailureReport, saveFailureReport } from '../../harness/failure-report';
import { startScreenPoll } from '../../harness/screen-capture';
import { captureWalletSnapshot } from '../../harness/state-snapshot';
import { TestStepRunner } from '../../harness/test-step';
import { TimelineRecorder } from '../../harness/timeline-recorder';
import type { EnvironmentConfig, SerializedWalletState, SnapshotCaps } from '../../harness/types';
import { MidenCli, resolveCliPath } from '../../helpers/miden-cli';
import { CdpBridge, type CdpSession, isCdpNoPagesError } from '../helpers/cdp-bridge';
import { IosWalletPage } from '../helpers/ios-wallet-page';
import { isSimctlTimeoutError, SimulatorControl } from '../helpers/simulator-control';
import { startNotificationAlertDismisser } from '../helpers/system-alerts';

// ── Constants ───────────────────────────────────────────────────────────────

const ROOT_DIR = path.resolve(__dirname, '../../../..');
const APP_PATH = path.join(ROOT_DIR, 'ios', 'App', 'build', 'Build', 'Products', 'Debug-iphonesimulator', 'App.app');
const BUNDLE_ID = 'com.miden.bread';

// ── Types ───────────────────────────────────────────────────────────────────

type TwoSimulatorFixtures = {
  walletA: IosWalletPage;
  walletB: IosWalletPage;
  midenCli: MidenCli;
  timeline: TimelineRecorder;
  steps: TestStepRunner;
  envConfig: EnvironmentConfig;
  /**
   * Internal fixture that brings up BOTH simulators in parallel. Exposed as
   * a dependency for `walletA` and `walletB` so Playwright only runs the
   * expensive launchSimWalletInstance work once per test (in parallel) and
   * tears both down together. Tests should never reference this directly.
   */
  _simPair: {
    instanceA: SimWalletInstance;
    instanceB: SimWalletInstance;
    simA: SimulatorControl;
    simB: SimulatorControl;
  };
};

interface SimWalletInstance {
  walletPage: IosWalletPage;
  cdp: CdpSession;
  udid: string;
  bundleId: string;
  /** Stops the background notification-permission-alert dismisser (see system-alerts.ts). */
  stopAlertDismisser: () => void;
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

  // Per-test isolation is uninstall + install, NOT a file-level sandbox
  // wipe. The wallet's persisted state (Capacitor Preferences → cfprefsd,
  // WebKit localStorage/IndexedDB → the per-device WebKit storage daemons)
  // is served through daemon caches — deleting the files behind those
  // daemons does not clear the data, and the relaunched app reads its old
  // vault right back (boots to unlock instead of onboarding, breaking
  // every test after the first). simctl uninstall purges through the OS,
  // which is the only reset that verifiably works.
  const tUninstall = phaseStart();
  await sim.uninstall(udid, BUNDLE_ID);
  const uninstallMs = ms(tUninstall);

  const tInstall = phaseStart();
  await sim.install(udid, APP_PATH);
  const installMs = ms(tInstall);

  const tLaunch = phaseStart();
  await sim.launch(udid, BUNDLE_ID, {
    MIDEN_E2E_TEST: 'true',
    MIDEN_NETWORK: envConfig.name
  });
  const launchMs = ms(tLaunch);

  const tSleep = phaseStart();
  // The WebView needs a couple seconds to register with webinspectord_sim.
  await sleep(3_000);
  const sleepMs = ms(tSleep);

  const tCdp = phaseStart();
  const cdp = await CdpBridge.connect({ udid, bundleId: BUNDLE_ID });
  const cdpConnectMs = ms(tCdp);

  // Forward WebView console + error output to the timeline so failures
  // surface what the wallet was actually doing (sync errors, prove timing,
  // unhandled rejections). Mirrors Chrome-side attachConsoleCapture.
  cdp.onConsoleLog(entry => {
    const sev =
      entry.level === 'error'
        ? 'error'
        : entry.level === 'warning'
          ? 'warn'
          : entry.level === 'debug' || entry.level === 'trace'
            ? 'debug'
            : 'info';
    timeline.emit({
      category: 'browser_console',
      severity: sev,
      wallet: label,
      message: `[${label}] ${entry.level}: ${entry.text}`,
      data: { level: entry.level, text: entry.text, source: entry.source, ts: entry.ts }
    });
  });

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
      fixturePhases: {
        terminateMs,
        uninstallMs,
        installMs,
        launchMs,
        sleepMs,
        cdpConnectMs
      }
    }
  });

  // Start the alert watcher as the last thing before returning, so nothing
  // between here and the return can throw and orphan it (setupBothWallets can
  // only stop a watcher it received on the returned instance). The authenticated
  // app shell mounts later in the test body and fires initNativeNotifications(),
  // which raises a native "…Would Like to Send You Notifications" SpringBoard
  // alert outside the WebView — CDP can't tap it and it covers every composited
  // screenshot until answered. The watcher taps "Allow" via idb the moment it
  // appears, then stops. Best-effort (no-op when idb is absent); stopped in
  // teardown and on the setup-error path.
  const stopAlertDismisser = startNotificationAlertDismisser(udid, {
    onLog: message => timeline.emit({ category: 'test_lifecycle', severity: 'info', wallet: label, message })
  });

  return { walletPage, cdp, udid, bundleId: BUNDLE_ID, stopAlertDismisser };
}

/**
 * Launch both wallet instances, recovering from a wedged CoreSimulatorService.
 * If a per-wallet `simctl` op blocks to its timeout (the macos-26 daemon-wedge
 * signature), restart the sim subsystem and retry the whole pair once — the
 * daemon restart drops both sims, so any partial state from this attempt is
 * discarded and both wallets are re-launched fresh.
 */
async function setupBothWallets(
  simA: SimulatorControl,
  udidA: string,
  simB: SimulatorControl,
  udidB: string,
  envConfig: EnvironmentConfig,
  timeline: TimelineRecorder
): Promise<{ instanceA: SimWalletInstance; instanceB: SimWalletInstance }> {
  // 3 attempts = up to 2 daemon-restart recoveries. The macos-26 wedge has been
  // observed to survive a single recovery, so give it one more shot before
  // failing the test (each wedged attempt fails fast at its simctl/CDP timeout,
  // not the full per-test timeout, so the extra attempt is cheap).
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let instanceA: SimWalletInstance | undefined;
    let instanceB: SimWalletInstance | undefined;
    try {
      // Sequential within an attempt: parallel simctl install/launch across two
      // sims can deadlock CoreSimulatorService on cold macos-26 runners.
      instanceA = await launchSimWalletInstance(simA, udidA, envConfig, timeline, 'A');
      instanceB = await launchSimWalletInstance(simB, udidB, envConfig, timeline, 'B');
      return { instanceA, instanceB };
    } catch (err) {
      // Drop any half-open CDP sockets + alert watchers from this attempt
      // before recovering.
      instanceA?.stopAlertDismisser();
      instanceB?.stopAlertDismisser();
      await instanceA?.cdp.close().catch(() => undefined);
      await instanceB?.cdp.close().catch(() => undefined);
      // Both signatures point at the same wedged macos-26 sim subsystem: a
      // hung `simctl` call, or webinspectord exposing no WebViews (CDP blind).
      // recoverSimSubsystem fixes both (restart CoreSimulatorService + relaunch
      // Simulator.app so webinspectord re-exposes WebViews + re-boot devices).
      if ((isSimctlTimeoutError(err) || isCdpNoPagesError(err)) && attempt < MAX_ATTEMPTS) {
        timeline.emit({
          category: 'test_lifecycle',
          severity: 'warn',
          message:
            `[sim-recovery] ${err.message} — sim subsystem looks wedged ` +
            `(simctl hang or no inspectable WebViews); restarting ` +
            `CoreSimulatorService + re-booting both devices, then retrying wallet ` +
            `setup (attempt ${attempt + 1}/${MAX_ATTEMPTS})`
        });
        await SimulatorControl.recoverSimSubsystem([udidA, udidB]);
        continue;
      }
      throw err;
    }
  }
  // The loop body always returns or throws; this satisfies the type checker.
  throw new Error('setupBothWallets: exhausted recovery attempts');
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
        const store = (window as { __TEST_STORE__?: { getState(): SerializedWalletState } }).__TEST_STORE__;
        if (!store) return null;
        const s = store.getState();
        return {
          status: s.status,
          accounts: s.accounts?.map(a => ({ publicKey: a.publicKey, name: a.name })),
          currentAccount: s.currentAccount
            ? { publicKey: s.currentAccount.publicKey, name: s.currentAccount.name }
            : null,
          balances: s.balances
        };
      }),
    hasIntercom: () =>
      walletPage.evaluate(() => Boolean((window as { __TEST_INTERCOM__?: unknown }).__TEST_INTERCOM__)),
    // No serviceWorkerStatus — mobile has no SW.
    currentUrl: () => walletPage.evaluate(() => window.location.href)
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// A healthy two-simulator setup (terminate→uninstall→install→launch→CDP for
// both, sims already booted by globalSetup) runs in ~2-3 min. A degraded
// macos-26 CoreSimulator stretches every simctl op (97 real CI samples: per-
// wallet setup p50 65s, p90 267s, max 401s → two sequential wallets up to
// ~13 min) yet still COMPLETES. The earlier 8-min cap killed those slow-but-
// completing setups that would have finished and passed; only a TRULY hung
// runner (observed: setup not done after 15 min) genuinely can't recover. So
// cap at 13 min — past the slowest observed completing setup — so degraded-but-
// completing runners get to finish, and only the hung ones fail fast (clearly
// attributed, leaving room within the 25-min test timeout for the retry).
const SETUP_DEADLINE_MS = 780_000;
// Upper bound for the on-timeout daemon restart so the recovery itself can't run
// into the test timeout — setupBothWallets does its own recovery on the retry.
const SETUP_RECOVERY_BUDGET_MS = 90_000;

/**
 * Run the `_simPair` setup with a hard deadline. On overrun, run `onTimeout`
 * (a best-effort, time-bounded sim-subsystem restart) so Playwright's retry
 * lands on a fresh daemon, then throw a named error instead of letting setup
 * silently eat the entire test timeout.
 */
async function withSetupDeadline<T>(
  fn: () => Promise<T>,
  deadlineMs: number,
  onTimeout: () => Promise<void>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`_simPair setup exceeded ${deadlineMs}ms (degraded CoreSimulator)`));
    }, deadlineMs);
  });
  try {
    return await Promise.race([fn(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) {
      await Promise.race([onTimeout(), sleep(SETUP_RECOVERY_BUDGET_MS)]).catch(() => undefined);
    }
  }
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
    const outputDir = getRunOutputDir(testArtifactDirName(testInfo.titlePath));
    const timeline = new TimelineRecorder(outputDir);

    timeline.emit({
      category: 'test_lifecycle',
      severity: 'info',
      message: `Test started: ${testInfo.title}`,
      data: { testFile: testInfo.file, testTitle: testInfo.title, platform: 'ios' }
    });

    await use(timeline);

    timeline.emit({
      category: 'test_lifecycle',
      severity: testInfo.status === 'passed' ? 'info' : 'error',
      message: `Test ${testInfo.status}: ${testInfo.title}`,
      data: { status: testInfo.status, duration: testInfo.duration }
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
      data: { workDir, binaryPath, network: envConfig.name }
    });

    await use(cli);
    await cli.cleanup();
  },

  _simPair: async ({ envConfig, timeline, steps }, use) => {
    const { udidA, udidB } = await devicePair();
    const simA = new SimulatorControl();
    const simB = new SimulatorControl();

    // Launch both wallets, recovering from a wedged CoreSimulatorService (the
    // macos-26 daemon-wedge that hangs simctl mid-suite) by restarting the sim
    // subsystem and retrying the pair. The shared `_simPair` fixture still
    // consolidates teardown.
    //
    // Cap the whole setup. On a degraded macos-26 CoreSimulator every simctl op
    // crawls (install/terminate observed at 30-180s vs. <5s healthy); slow-but-
    // completing ops never trip the per-op recovery, so the cumulative cost can
    // silently eat the entire per-test timeout "while setting up _simPair"
    // with no attribution and no room for Playwright's retry. A hard cap turns
    // that into a fast, named failure — and on overrun we restart the sim
    // subsystem first so the retry runs against a fresh daemon.
    const { instanceA, instanceB } = await withSetupDeadline(
      () => setupBothWallets(simA, udidA, simB, udidB, envConfig, timeline),
      SETUP_DEADLINE_MS,
      async () => {
        timeline.emit({
          category: 'test_lifecycle',
          severity: 'warn',
          message:
            `[sim-setup] _simPair setup exceeded ${SETUP_DEADLINE_MS}ms (degraded CoreSimulator); ` +
            `restarting the sim subsystem so the retry gets a fresh daemon`
        });
        await SimulatorControl.recoverSimSubsystem([udidA, udidB]).catch(() => undefined);
      }
    );
    steps.registerSnapshotCaps('A', buildIosSnapshotCaps(instanceA.walletPage, ''));
    steps.registerSnapshotCaps('B', buildIosSnapshotCaps(instanceB.walletPage, ''));

    // Reactive capture (Chrome's installScreenCapture) isn't available here —
    // Playwright doesn't own the WebView on iOS, so there's no page instance
    // to `exposeFunction` into. Poll the app's screen-key over CDP instead:
    // cheap, tiny reads (a single JSON string) sharing the same serial RWI
    // socket as the rest of the spec's traffic.
    const screensDir = path.join(steps.outputDir, 'screens');
    const screenPolls = [
      { label: 'A', walletPage: instanceA.walletPage, cdp: instanceA.cdp },
      { label: 'B', walletPage: instanceB.walletPage, cdp: instanceB.cdp }
    ].map(({ label, walletPage, cdp }) =>
      startScreenPoll({
        intervalMs: 250,
        read: async () => {
          // Sync `eval`, not `evalAsync` — the latter is broken on this iOS
          // RWI bridge (see CdpSession.evalAsync). A plain-object read of
          // window.__TEST_SCREEN__ touches no WASM, so it's safe from the
          // single-threaded client's lock contention.
          // Gate on paint: right after a launch the WebView is blank (React
          // hasn't rendered), and a grab then yields an empty white frame.
          // Report a screen only once the body has visible text, so the poll
          // skips blank frames until the app has painted.
          const raw = await cdp.eval<string>(
            'return JSON.stringify(document.body && document.body.innerText.trim().length > 0 ? (window.__TEST_SCREEN__ || null) : null);',
            { timeoutMs: 5_000 }
          );
          return raw ? (JSON.parse(raw) as { key: string; seq: number }) : null;
        },
        grab: p => walletPage.screenshot({ path: p }),
        dir: screensDir,
        label
      })
    );

    await use({ instanceA, instanceB, simA, simB });

    screenPolls.forEach(p => p.stop());
    instanceA.stopAlertDismisser();
    instanceB.stopAlertDismisser();

    // Parallel teardown is safe — close is a CDP socket close, terminate is
    // just `simctl terminate` which doesn't contend.
    await Promise.allSettled([
      instanceA.cdp.close().catch(() => undefined),
      instanceB.cdp.close().catch(() => undefined)
    ]);
    await Promise.allSettled([
      simA.terminate(udidA, BUNDLE_ID).catch(() => undefined),
      simB.terminate(udidB, BUNDLE_ID).catch(() => undefined)
    ]);
  },

  walletA: async ({ _simPair, timeline }, use) => {
    const instance = _simPair.instanceA;
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
      data: stats
    });
  },

  walletB: async ({ _simPair, timeline, steps, midenCli: _midenCli }, use, testInfo) => {
    const instance = _simPair.instanceB;
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
      data: statsB
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
          testTimeoutMs: testInfo.timeout
        });

        saveFailureReport(report, reportDir);
      } catch {
        // Don't let report generation fail the test teardown
      }
    }
  }
});

export const expect = test.expect;

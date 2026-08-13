import { chromium, test as base, type BrowserContext, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getEnvironmentConfig } from '../config/environments';
import { attachConsoleCapture } from '../harness/browser-capture';
import { CLIRunner } from '../harness/cli-runner';
import { assertExtensionNetworkMatches } from '../harness/extension-network';
import { buildFailureReport, saveFailureReport } from '../harness/failure-report';
import { installGuardianFaults, type GuardianFaultPolicy, type GuardianOrigins } from '../harness/guardian-fault';
import {
  SW_FETCH_LOG_PREFIX,
  attachNetworkCapture,
  attachPageWorkersCapture,
  attachServiceWorkerFetchCapture
} from '../harness/network-capture';
import { captureWalletSnapshot } from '../harness/state-snapshot';
import { TestStepRunner } from '../harness/test-step';
import { TimelineRecorder } from '../harness/timeline-recorder';
import type {
  DebugSession,
  EnvironmentConfig,
  SerializedWalletState,
  SnapshotCaps,
  WalletSnapshot
} from '../harness/types';
import { MidenCli, resolveCliPath } from '../helpers/miden-cli';
import { ChromeWalletPage, type ChromeWalletPageApi } from '../helpers/wallet-page';

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Test-only controls layered onto the wallet page object so specs can arm/
 * clear guardian HTTP faults (see harness/guardian-fault.ts) without reaching
 * into the BrowserContext directly.
 */
export interface GuardianFaultTestApi {
  armGuardianFault(policy: GuardianFaultPolicy): void;
  clearFaults(): void;
}

export type GuardianAwareWalletPage = ChromeWalletPageApi & GuardianFaultTestApi;

/**
 * Per-test drop box for the wallet state captured on failure. Each wallet
 * fixture fills its own slot during ITS teardown -- i.e. while its page is
 * still alive -- and the `failureReport` fixture (which tears down last)
 * reads whatever landed here. Wallets a spec never instantiated simply leave
 * their slot undefined.
 */
type FailureSnapshots = {
  walletA?: WalletSnapshot;
  walletB?: WalletSnapshot;
};

type TwoWalletFixtures = {
  walletA: GuardianAwareWalletPage;
  walletB: GuardianAwareWalletPage;
  midenCli: MidenCli;
  timeline: TimelineRecorder;
  steps: TestStepRunner;
  envConfig: EnvironmentConfig;
  failureSnapshots: FailureSnapshots;
  failureReport: void;
};

// ── Constants ───────────────────────────────────────────────────────────────

// The guardian operator origins fault injection keys on, for the active
// E2E_NETWORK: local containers on localhost, the real operators on
// devnet/testnet. Read at install time so faults match whichever guardians
// the wallet actually talks to on this network.
const guardianOrigins = (): GuardianOrigins => {
  const cfg = getEnvironmentConfig();
  return { a: cfg.guardianUrl, b: cfg.guardianUrlB };
};

const ROOT_DIR = path.resolve(__dirname, '../../..');
const DEFAULT_EXTENSION_PATH = path.join(ROOT_DIR, 'dist', 'chrome_unpacked');
const AGENTIC_TIMEOUT_MS = parseInt(process.env.E2E_AGENTIC_TIMEOUT ?? '600000', 10);

// ── Helpers ─────────────────────────────────────────────────────────────────

// Resolve the unpacked extension to load, refusing anything that isn't a build
// for THIS run's network. `MIDEN_NETWORK` is baked in at build time, so a
// leftover dist/ from an earlier build happily drives, say, a testnet wallet
// against the localhost harness -- the CLI mints on one chain, the wallet syncs
// another, and the suite reports product-shaped failures (or worse, passes
// while testing nothing). See harness/extension-network.ts for the signal.
function getExtensionPath(): string {
  const extensionPath = process.env.EXTENSION_DIST ?? DEFAULT_EXTENSION_PATH;
  const manifestPath = path.join(extensionPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Extension not found at ${extensionPath}. Run "yarn test:e2e:blockchain:build" first.`);
  }
  assertExtensionNetworkMatches(extensionPath, getEnvironmentConfig().name);
  return extensionPath;
}

function getRunOutputDir(testId: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(ROOT_DIR, 'test-results', `run-${timestamp}`, 'tests', testId);
}

/**
 * Build platform-neutral SnapshotCaps for a Chrome extension wallet.
 * Closes over the Page + BrowserContext + extensionId so test-step.ts can
 * stay runtime-agnostic.
 */
function buildChromeSnapshotCaps(page: Page, context: BrowserContext, extensionId: string): SnapshotCaps {
  return {
    platform: 'chrome',
    runtimeVersion: context.browser()?.version() ?? '',
    extensionId,
    readStore: () =>
      page.evaluate((): SerializedWalletState | null => {
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
    hasIntercom: () => page.evaluate(() => Boolean((window as { __TEST_INTERCOM__?: unknown }).__TEST_INTERCOM__)),
    serviceWorkerStatus: async () => {
      const workers = context.serviceWorkers();
      const extensionWorker = workers.find(w => new URL(w.url()).host === extensionId);
      return extensionWorker ? 'active' : 'inactive';
    },
    currentUrl: async () => page.url()
  };
}

// Chromium launch args, shared by the initial wallet launch and reopen()'s
// crash-recovery relaunch so the two can never drift.
function chromeLaunchArgs(extensionPath: string): string[] {
  return [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    // CI hardening for the guardian recovery specs. Peak RAM on the runner is
    // high: two persistent contexts (A + B) plus the full docker stack
    // (node/sequencer/prover/2 guardians/2 postgres). `--disable-dev-shm-usage`
    // moves Chromium's shared memory off the small /dev/shm tmpfs onto disk (the
    // standard CI fix for `Target.createTarget: Failed to open a new tab`);
    // `--disable-gpu` drops the unused GPU process under xvfb. Both are inert to
    // extension/SW behaviour. (They alone did NOT stop the intermittent browser
    // crash the recovery specs hit -- that is now recovered from in reopen() by
    // relaunching the context; see relaunchContext.)
    '--disable-dev-shm-usage',
    '--disable-gpu'
  ];
}

// Poll for the extension's service worker to register (extension loading under
// Playwright is flaky). Shared by the initial launch and the relaunch.
async function waitForExtensionServiceWorker(context: BrowserContext) {
  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    const SW_TIMEOUT = 60_000;
    const start = Date.now();
    while (Date.now() - start < SW_TIMEOUT) {
      serviceWorker = context.serviceWorkers()[0];
      if (serviceWorker) break;
      await new Promise(r => setTimeout(r, 500));
    }
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    }
  }
  return serviceWorker;
}

// Relaunch a wallet's persistent context on the SAME userDataDir after its
// Chromium process DIED mid-test (an intermittent browser crash -- not OOM,
// confirmed via CI dmesg/free -- that the guardian recovery specs hit at
// reopen()). Reusing the profile dir means the on-disk state (IndexedDB:
// accounts + pending tx rows) survives, so the wallet resumes from persisted
// state -- exactly the "browser crashed, user reopens the app, wallet resumes"
// recovery those specs assert on.
//
// Deliberately lighter than launchWalletInstance: it re-installs guardian fault
// injection (so armGuardianFault()/clearFaults() keep targeting the live
// context) and opens the extension page, but SKIPS the console/network
// observability re-attach (diagnostic-only, and this is a rare recovery path)
// and the fresh-onboarding wait -- reopen()'s own tail waits for the
// unlock/explore surface of the already-onboarded profile instead.
async function relaunchContext(userDataDir: string, extensionPath: string) {
  // A hard browser crash can leave Chromium's profile singleton lock behind,
  // which makes a relaunch on the same dir fail with "profile appears to be in
  // use". Clear the stale locks first.
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.rmSync(path.join(userDataDir, lock), { force: true });
    } catch {}
  }
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: chromeLaunchArgs(extensionPath),
    ignoreDefaultArgs: ['--disable-extensions']
  });
  const serviceWorker = await waitForExtensionServiceWorker(context);
  const extensionId = new URL(serviceWorker.url()).host;
  const fullpageUrl = `chrome-extension://${extensionId}/fullpage.html`;
  let page = context.pages().find(p => p.url().includes(extensionId));
  if (!page) {
    page = await context.newPage();
    await page.goto(fullpageUrl, { waitUntil: 'domcontentloaded' });
  }
  for (const p of context.pages()) {
    if (p !== page) await p.close().catch(() => {});
  }
  const faults = installGuardianFaults(context, guardianOrigins());
  return { context, page, faults };
}

async function launchWalletInstance(label: 'A' | 'B', extensionPath: string, timeline: TimelineRecorder) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `miden-wallet-${label}-`));

  // `let` (not `const`): reopen()'s relaunch swaps these in place after a
  // browser crash so teardown closes the LIVE context and the fault methods
  // target it.
  let context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: chromeLaunchArgs(extensionPath),
    ignoreDefaultArgs: ['--disable-extensions']
  });

  const serviceWorker = await waitForExtensionServiceWorker(context);
  const extensionId = new URL(serviceWorker.url()).host;

  // Attach observability
  attachConsoleCapture(context, label, timeline);

  // Capture service worker console (crucial for diagnosing WASM init).
  // Fetch-wrapper sentinel lines are demuxed by attachServiceWorkerFetchCapture
  // into the network_request category, so skip them here to avoid duplication.
  serviceWorker.on('console', (msg: any) => {
    const text = msg.text();
    if (text.startsWith(SW_FETCH_LOG_PREFIX)) return;
    timeline.emit({
      category: 'browser_console',
      severity: msg.type() === 'error' ? 'error' : msg.type() === 'warning' ? 'warn' : 'info',
      wallet: label,
      message: `[${label}-SW] ${msg.type()}: ${text}`,
      data: { source: 'service_worker', type: msg.type(), text }
    });
  });

  // Install unhandled error/rejection capture + check SW internals
  try {
    await serviceWorker.evaluate(() => {
      /* eslint-disable no-restricted-globals -- service-worker scope: `self` is the global, `window` is undefined here */
      (self as any).__e2e_errors = [];
      self.addEventListener('error', (e: any) => {
        (self as any).__e2e_errors.push('error: ' + (e.message || String(e)));
      });
      self.addEventListener('unhandledrejection', (e: any) => {
        (self as any).__e2e_errors.push(
          'rejection: ' + String(e.reason?.stack || e.reason?.message || e.reason || 'unknown')
        );
      });
      /* eslint-enable no-restricted-globals */
    });
  } catch {}

  // Instrument SW fetch for network_request capture (prover + SDK RPCs
  // originate here and are invisible to page- or context-level events).
  await attachServiceWorkerFetchCapture(serviceWorker, label, timeline);

  // MV3 suspends and resumes the SW unpredictably. The injected fetch
  // wrapper survives within a single SW lifetime but is lost on restart;
  // re-install on every new SW target for this context.
  context.on('serviceworker', async newWorker => {
    if (new URL(newWorker.url()).host !== extensionId) return;
    newWorker.on('console', (msg: any) => {
      const text = msg.text();
      if (text.startsWith(SW_FETCH_LOG_PREFIX)) return;
      timeline.emit({
        category: 'browser_console',
        severity: msg.type() === 'error' ? 'error' : msg.type() === 'warning' ? 'warn' : 'info',
        wallet: label,
        message: `[${label}-SW] ${msg.type()}: ${text}`,
        data: { source: 'service_worker', type: msg.type(), text }
      });
    });
    await attachServiceWorkerFetchCapture(newWorker, label, timeline);
  });

  // After a delay, probe the SW for errors and state
  const probeDelay = 15_000;
  setTimeout(async () => {
    try {
      const probe = await serviceWorker.evaluate(() => ({
        // eslint-disable-next-line no-restricted-globals -- service-worker scope, see above
        errors: (self as any).__e2e_errors?.slice(0, 10) || [],
        // eslint-disable-next-line no-restricted-globals -- service-worker scope, see above
        hasBackground: typeof (self as any).__background_started !== 'undefined'
      }));
      if (probe.errors.length > 0) {
        timeline.emit({
          category: 'error',
          severity: 'error',
          wallet: label,
          message: `[${label}-SW] Unhandled errors after ${probeDelay}ms: ${probe.errors.join(' | ')}`
        });
      }
    } catch {}
  }, probeDelay);

  const fullpageUrl = `chrome-extension://${extensionId}/fullpage.html`;

  // The onInstalled handler in sw.js auto-opens fullpage.html on fresh install.
  // Wait for it and reuse that page, or create our own if it doesn't appear.
  await new Promise(r => setTimeout(r, 3_000));

  // Typed `Page` (not `Page | undefined`): the return exposes this via a getter
  // (relaunch swaps it), and a getter body can't carry the control-flow
  // narrowing an inline `return` would, so the variable itself must be `Page`.
  const existingPage = context.pages().find(p => p.url().includes(extensionId));
  let page: Page;
  if (existingPage) {
    page = existingPage;
  } else {
    page = await context.newPage();
    await page.goto(fullpageUrl, { waitUntil: 'domcontentloaded' });
  }

  // Close any other pages (about:blank, etc.)
  for (const p of context.pages()) {
    if (p !== page) await p.close().catch(() => {});
  }

  attachNetworkCapture(context, label, timeline);
  // SDK spawns a web worker (web-client-methods-worker.js) that runs the WASM
  // prove/sync/submit RPCs; its fetches are invisible to page- and SW-scoped
  // capture. Instrument every current + future worker this page spawns.
  attachPageWorkersCapture(page, label, timeline);

  const earlyErrors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') earlyErrors.push(msg.text());
  });

  // The service worker loads a ~14MB WASM binary on first run. Until it finishes,
  // the frontend's useIntercomSync fetch times out and the app stays on the
  // loading screen. We reload to give the frontend a fresh retry window.
  const MAX_LOAD_ATTEMPTS = 3;
  const ATTEMPT_TIMEOUT = 90_000;

  for (let attempt = 1; attempt <= MAX_LOAD_ATTEMPTS; attempt++) {
    timeline.emit({
      category: 'test_lifecycle',
      severity: 'info',
      wallet: label,
      message: `Waiting for wallet ${label} to initialize (attempt ${attempt}/${MAX_LOAD_ATTEMPTS})...`
    });

    try {
      // Wait for either the onboarding welcome screen OR the main Explore page.
      await page
        .locator('[data-testid="onboarding-welcome"]')
        .or(page.locator('[data-testid="explore-page"]'))
        .first()
        .waitFor({ timeout: ATTEMPT_TIMEOUT });

      timeline.emit({
        category: 'test_lifecycle',
        severity: 'info',
        wallet: label,
        message: `Wallet ${label} initialized on attempt ${attempt}`
      });
      break;
    } catch {
      // Probe SW for unhandled errors before giving up or retrying
      try {
        const probe = await serviceWorker.evaluate(() => ({
          // eslint-disable-next-line no-restricted-globals -- service-worker scope, see above
          errors: ((self as any).__e2e_errors || []).slice(0, 10)
        }));
        if (probe.errors.length > 0) {
          timeline.emit({
            category: 'error',
            severity: 'error',
            wallet: label,
            message: `[${label}-SW] Errors captured: ${probe.errors.join(' | ')}`
          });
        }
      } catch {}

      if (attempt === MAX_LOAD_ATTEMPTS) {
        throw new Error(
          `Wallet ${label} failed to initialize after ${MAX_LOAD_ATTEMPTS} attempts ` +
            `(${(MAX_LOAD_ATTEMPTS * ATTEMPT_TIMEOUT) / 1000}s total). ` +
            `The service worker WASM init may be hanging. ` +
            `Console errors: ${earlyErrors.join('; ') || 'none'}`
        );
      }
      timeline.emit({
        category: 'test_lifecycle',
        severity: 'warn',
        wallet: label,
        message: `Wallet ${label} still loading on attempt ${attempt}, reloading...`,
        data: { earlyErrors: [...earlyErrors] }
      });
      earlyErrors.length = 0;
      // Wait before reload to give the service worker more time to finish WASM init
      await new Promise(resolve => setTimeout(resolve, 3_000));
      await page.reload({ waitUntil: 'load' });
      // Wait for React to at least mount something before checking again
      await page.waitForSelector('#root > *', { timeout: 15_000 }).catch(() => {});
    }
  }

  timeline.emit({
    category: 'test_lifecycle',
    severity: 'info',
    wallet: label,
    message: `Wallet ${label} launched (extension: ${extensionId})`,
    data: { extensionId, userDataDir }
  });

  // Guardian fault-injection: intercepts guardian HTTP calls (made from the
  // extension's service worker) by target/path, applying whatever
  // GuardianFaultPolicy the spec arms via the wallet page object below.
  // `let`: relaunch swaps in the new context's faults so armGuardianFault()/
  // clearFaults() (captured by reference below) keep targeting the live context.
  let faults = installGuardianFaults(context, guardianOrigins());

  // Passed to ChromeWalletPage.reopen(): when the browser PROCESS has died (not
  // just the page), relaunch a fresh context on this same userDataDir and swap
  // it in, so the wallet resumes from its on-disk profile. Reassigning the
  // captured context/page/faults keeps teardown and the fault methods pointed at
  // the live context.
  const relaunch = async (): Promise<Page> => {
    timeline.emit({
      category: 'test_lifecycle',
      severity: 'warn',
      wallet: label,
      message: `Wallet ${label} browser process died mid-test; relaunching from on-disk profile to resume`,
      data: { userDataDir }
    });
    const next = await relaunchContext(userDataDir, extensionPath);
    context = next.context;
    page = next.page;
    faults = next.faults;
    return page;
  };

  const walletPage: GuardianAwareWalletPage = Object.assign(
    new ChromeWalletPage(page, extensionId, userDataDir, relaunch),
    {
      armGuardianFault: (policy: GuardianFaultPolicy) => faults.arm(policy),
      clearFaults: () => faults.clear()
    }
  );

  // context/page via getters: relaunch reassigns them, and teardown
  // (instance.context.close()) must close the LIVE context, not the dead one.
  return {
    walletPage,
    get context() {
      return context;
    },
    extensionId,
    userDataDir,
    get page() {
      return page;
    }
  };
}

/**
 * Snapshot one wallet's live state for the failure report. Called from that
 * wallet's own teardown, BEFORE its context is closed (page.evaluate is what
 * reads the store). Purely diagnostic: any failure here yields `undefined`
 * rather than breaking teardown.
 */
async function captureFailureSnapshot(
  steps: TestStepRunner,
  timeline: TimelineRecorder,
  label: 'A' | 'B'
): Promise<WalletSnapshot | undefined> {
  const caps = steps.walletCaps[label];
  if (!caps) return undefined;
  return captureWalletSnapshot(caps, label, timeline.currentStep, 'failure').catch(() => undefined);
}

function writeDebugSession(
  testName: string,
  reportPath: string,
  instanceA: { extensionId: string; userDataDir: string },
  instanceB: { extensionId: string; userDataDir: string },
  midenCliWorkDir: string
): void {
  const session: DebugSession = {
    createdAt: new Date().toISOString(),
    testName,
    reportPath,
    wallets: {
      A: {
        extensionId: instanceA.extensionId,
        fullpageUrl: `chrome-extension://${instanceA.extensionId}/fullpage.html`,
        cdpUrl: '', // CDP URL not easily available from Playwright persistent context
        userDataDir: instanceA.userDataDir
      },
      B: {
        extensionId: instanceB.extensionId,
        fullpageUrl: `chrome-extension://${instanceB.extensionId}/fullpage.html`,
        cdpUrl: '',
        userDataDir: instanceB.userDataDir
      }
    },
    midenCliWorkDir,
    expiresAt: new Date(Date.now() + AGENTIC_TIMEOUT_MS).toISOString(),
    helpers: {
      reloadAndReopen: 'page.evaluate(() => chrome.runtime.reload())',
      rebuildCmd: 'yarn test:e2e:blockchain:build'
    }
  };

  const sessionPath = path.join(ROOT_DIR, 'test-results', 'debug-session.json');
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
}

/**
 * Kill any stale debug sessions from previous crashed runs.
 */
function cleanupStaleSessions(): void {
  const sessionPath = path.join(ROOT_DIR, 'test-results', 'debug-session.json');
  if (!fs.existsSync(sessionPath)) return;

  try {
    const session: DebugSession = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    if (new Date(session.expiresAt) < new Date()) {
      // Session expired -- clean up
      fs.unlinkSync(sessionPath);
      // Try to clean up user data dirs
      for (const wallet of [session.wallets.A, session.wallets.B]) {
        try {
          fs.rmSync(wallet.userDataDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // corrupt session file, remove it
    try {
      fs.unlinkSync(sessionPath);
    } catch {
      // ignore
    }
  }
}

// ── Fixture ─────────────────────────────────────────────────────────────────

export const test = base.extend<TwoWalletFixtures>({
  envConfig: async (_, use) => {
    const config = getEnvironmentConfig();
    await use(config);
  },

  timeline: async (_, use, testInfo) => {
    const outputDir = getRunOutputDir(testInfo.titlePath.join('-').replace(/\s+/g, '_'));
    const timeline = new TimelineRecorder(outputDir);

    timeline.emit({
      category: 'test_lifecycle',
      severity: 'info',
      message: `Test started: ${testInfo.title}`,
      data: { testFile: testInfo.file, testTitle: testInfo.title }
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

  failureSnapshots: async (_, use) => {
    await use({});
  },

  // `auto`, so EVERY spec gets a report.json -- including the ones that only
  // ever touch walletA (or no wallet at all). Playwright sets automatic
  // fixtures up before the test's own fixtures, so this one tears down AFTER
  // walletA/walletB: by the time it runs, both have already deposited their
  // state into `failureSnapshots` while their pages were still alive. It is
  // also the only writer of report.json, so two-wallet specs can't double-emit.
  failureReport: [
    async ({ failureSnapshots, timeline, steps }, use, testInfo) => {
      await use();

      if (testInfo.status === 'passed' || testInfo.status === 'skipped' || !testInfo.error) return;

      try {
        const err = new Error(testInfo.error.message ?? 'Unknown error');
        err.stack = testInfo.error.stack ?? '';

        const report = buildFailureReport({
          testName: testInfo.title,
          testFile: testInfo.file ?? '',
          error: err,
          timeline,
          steps,
          stateAtFailure: { walletA: failureSnapshots.walletA, walletB: failureSnapshots.walletB },
          testTimeoutMs: testInfo.timeout
        });

        saveFailureReport(report, timeline.getOutputDir());
      } catch {
        // Don't let report generation fail the test teardown
      }
    },
    { auto: true }
  ],

  midenCli: async ({ envConfig, timeline }, use) => {
    cleanupStaleSessions();

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

    if (process.env.E2E_AGENTIC !== 'true') {
      await cli.cleanup();
    }
  },

  walletA: async ({ timeline, steps, failureSnapshots }, use, testInfo) => {
    const extensionPath = getExtensionPath();
    const instance = await launchWalletInstance('A', extensionPath, timeline);
    steps.registerSnapshotCaps('A', buildChromeSnapshotCaps(instance.page, instance.context, instance.extensionId));

    await use(instance.walletPage);

    const isAgentic = process.env.E2E_AGENTIC === 'true';
    const failed = testInfo.status !== 'passed';

    // Snapshot for the failure report while the page is still open; the
    // `failureReport` fixture writes it out after this teardown returns.
    if (failed) {
      failureSnapshots.walletA = await captureFailureSnapshot(steps, timeline, 'A');
    }

    if (isAgentic && failed) {
      // Don't close -- browser stays open for agent inspection
      const timer = setTimeout(async () => {
        try {
          await instance.context.close();
        } catch {}
      }, AGENTIC_TIMEOUT_MS);
      timer.unref();
    } else if (failed) {
      // Keep the on-disk profile (IndexedDB/LevelDB) so the SDK state can be
      // recovered offline if the in-page forensic dump was incomplete (e.g. the
      // page died mid-dump under memory pressure). Only the context is closed.
      await instance.context.close();
      timeline.emit({
        category: 'test_lifecycle',
        severity: 'warn',
        wallet: 'A',
        message: `Retained wallet A profile for offline recovery: ${instance.userDataDir}`,
        data: { userDataDir: instance.userDataDir }
      });
    } else {
      await instance.context.close();
      fs.rmSync(instance.userDataDir, { recursive: true, force: true });
    }
  },

  walletB: async ({ timeline, steps, walletA, midenCli, failureSnapshots }, use, testInfo) => {
    const extensionPath = getExtensionPath();
    const instance = await launchWalletInstance('B', extensionPath, timeline);
    steps.registerSnapshotCaps('B', buildChromeSnapshotCaps(instance.page, instance.context, instance.extensionId));

    await use(instance.walletPage);

    const isAgentic = process.env.E2E_AGENTIC === 'true';
    const failed = testInfo.status !== 'passed';

    // Snapshot for the failure report BEFORE closing the context (so
    // page.evaluate still works); the `failureReport` fixture assembles and
    // writes report.json once both wallet teardowns have run.
    if (failed) {
      failureSnapshots.walletB = await captureFailureSnapshot(steps, timeline, 'B');
    }

    // Now handle context cleanup
    if (isAgentic && failed) {
      // Write debug session with both wallet details
      writeDebugSession(
        testInfo.title,
        path.join(timeline.getOutputDir(), 'report.json'),
        {
          extensionId: walletA.extensionId,
          userDataDir: walletA.userDataDir
        },
        {
          extensionId: instance.extensionId,
          userDataDir: instance.userDataDir
        },
        midenCli.getWorkDir()
      );

      // Schedule auto-cleanup with process exit safety net
      const cleanupTimer = setTimeout(async () => {
        try {
          await instance.context.close();
        } catch {
          // ignore
        }
      }, AGENTIC_TIMEOUT_MS);
      cleanupTimer.unref(); // Don't keep process alive just for this timer
    } else if (failed) {
      // Keep the on-disk profile (IndexedDB/LevelDB) for offline SDK-state
      // recovery when the in-page forensic dump may be incomplete.
      await instance.context.close();
      timeline.emit({
        category: 'test_lifecycle',
        severity: 'warn',
        wallet: 'B',
        message: `Retained wallet B profile for offline recovery: ${instance.userDataDir}`,
        data: { userDataDir: instance.userDataDir }
      });
    } else {
      await instance.context.close();
      fs.rmSync(instance.userDataDir, { recursive: true, force: true });
    }
  }
});

export const expect = test.expect;

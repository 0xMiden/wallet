import { chromium, test as base } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getEnvironmentConfig } from '../config/environments';
import { attachConsoleCapture } from '../harness/browser-capture';
import { CLIRunner } from '../harness/cli-runner';
import { buildFailureReport, saveFailureReport } from '../harness/failure-report';
import { attachNetworkCapture } from '../harness/network-capture';
import { captureWalletSnapshot } from '../harness/state-snapshot';
import { TestStepRunner } from '../harness/test-step';
import { TimelineRecorder } from '../harness/timeline-recorder';
import type { DebugSession, EnvironmentConfig } from '../harness/types';
import { MidenCli, resolveCliPath } from '../helpers/miden-cli';
import { WalletPage } from '../helpers/wallet-page';

// ── Types ───────────────────────────────────────────────────────────────────

type TwoWalletFixtures = {
  walletA: WalletPage;
  walletB: WalletPage;
  midenCli: MidenCli;
  timeline: TimelineRecorder;
  steps: TestStepRunner;
  envConfig: EnvironmentConfig;
};

// ── Constants ───────────────────────────────────────────────────────────────

const ROOT_DIR = path.resolve(__dirname, '../../..');
const DEFAULT_EXTENSION_PATH = path.join(ROOT_DIR, 'dist', 'chrome_unpacked');
const AGENTIC_TIMEOUT_MS = parseInt(process.env.E2E_AGENTIC_TIMEOUT ?? '600000', 10);

// ── Helpers ─────────────────────────────────────────────────────────────────

function getExtensionPath(): string {
  const extensionPath = process.env.EXTENSION_DIST ?? DEFAULT_EXTENSION_PATH;
  const manifestPath = path.join(extensionPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Extension not found at ${extensionPath}. Run "yarn test:e2e:blockchain:build" first.`
    );
  }
  return extensionPath;
}

function getRunOutputDir(testId: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(ROOT_DIR, 'test-results', `run-${timestamp}`, 'tests', testId);
}

async function launchWalletInstance(
  label: 'A' | 'B',
  extensionPath: string,
  timeline: TimelineRecorder
) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `miden-wallet-${label}-`));

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
    ignoreDefaultArgs: ['--disable-extensions'],
  });

  // Wait for the service worker to register.
  // Extension loading in Playwright can be flaky -- poll for the SW to appear.
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
      serviceWorker = await context.waitForEvent('serviceworker', {
        timeout: 30_000,
      });
    }
  }
  const extensionId = new URL(serviceWorker.url()).host;

  // Attach observability
  attachConsoleCapture(context, label, timeline);

  // Capture service worker console (crucial for diagnosing WASM init)
  serviceWorker.on('console', (msg: any) => {
    timeline.emit({
      category: 'browser_console',
      severity: msg.type() === 'error' ? 'error' : msg.type() === 'warning' ? 'warn' : 'info',
      wallet: label,
      message: `[${label}-SW] ${msg.type()}: ${msg.text()}`,
      data: { source: 'service_worker', type: msg.type(), text: msg.text() },
    });
  });

  // Install unhandled error/rejection capture + check SW internals
  try {
    await serviceWorker.evaluate(() => {
      (self as any).__e2e_errors = [];
      self.addEventListener('error', (e: any) => {
        (self as any).__e2e_errors.push('error: ' + (e.message || String(e)));
      });
      self.addEventListener('unhandledrejection', (e: any) => {
        (self as any).__e2e_errors.push('rejection: ' + String(e.reason?.stack || e.reason?.message || e.reason || 'unknown'));
      });
    });
  } catch {}

  // After a delay, probe the SW for errors and state
  const probeDelay = 15_000;
  setTimeout(async () => {
    try {
      const probe = await serviceWorker.evaluate(() => ({
        errors: (self as any).__e2e_errors?.slice(0, 10) || [],
        hasBackground: typeof (self as any).__background_started !== 'undefined',
      }));
      if (probe.errors.length > 0) {
        timeline.emit({
          category: 'error',
          severity: 'error',
          wallet: label,
          message: `[${label}-SW] Unhandled errors after ${probeDelay}ms: ${probe.errors.join(' | ')}`,
        });
      }
    } catch {}
  }, probeDelay);

  const fullpageUrl = `chrome-extension://${extensionId}/fullpage.html`;

  // The onInstalled handler in sw.js auto-opens fullpage.html on fresh install.
  // Wait for it and reuse that page, or create our own if it doesn't appear.
  await new Promise(r => setTimeout(r, 3_000));

  let page = context.pages().find(p => p.url().includes(extensionId));
  if (!page) {
    page = await context.newPage();
    await page.goto(fullpageUrl, { waitUntil: 'domcontentloaded' });
  }

  // Close any other pages (about:blank, etc.)
  for (const p of context.pages()) {
    if (p !== page) await p.close().catch(() => {});
  }

  attachNetworkCapture(page, label, timeline);

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
      message: `Waiting for wallet ${label} to initialize (attempt ${attempt}/${MAX_LOAD_ATTEMPTS})...`,
    });

    try {
      // Wait for either the onboarding welcome screen OR the main Explore page
      // (if wallet was previously set up). Both indicate successful init.
      await page.locator('[data-testid="onboarding-welcome"], [data-testid="receive-page"], text=Send')
        .first()
        .waitFor({ timeout: ATTEMPT_TIMEOUT });

      timeline.emit({
        category: 'test_lifecycle',
        severity: 'info',
        wallet: label,
        message: `Wallet ${label} initialized on attempt ${attempt}`,
      });
      break;
    } catch {
      // Probe SW for unhandled errors before giving up or retrying
      try {
        const probe = await serviceWorker.evaluate(() => ({
          errors: ((self as any).__e2e_errors || []).slice(0, 10),
        }));
        if (probe.errors.length > 0) {
          timeline.emit({
            category: 'error',
            severity: 'error',
            wallet: label,
            message: `[${label}-SW] Errors captured: ${probe.errors.join(' | ')}`,
          });
        }
      } catch {}

      if (attempt === MAX_LOAD_ATTEMPTS) {
        throw new Error(
          `Wallet ${label} failed to initialize after ${MAX_LOAD_ATTEMPTS} attempts ` +
            `(${MAX_LOAD_ATTEMPTS * ATTEMPT_TIMEOUT / 1000}s total). ` +
            `The service worker WASM init may be hanging. ` +
            `Console errors: ${earlyErrors.join('; ') || 'none'}`
        );
      }
      timeline.emit({
        category: 'test_lifecycle',
        severity: 'warn',
        wallet: label,
        message: `Wallet ${label} still loading on attempt ${attempt}, reloading...`,
        data: { earlyErrors: [...earlyErrors] },
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
    data: { extensionId, userDataDir },
  });

  const walletPage = new WalletPage(page, extensionId, userDataDir);

  return { walletPage, context, extensionId, userDataDir, page };
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
        userDataDir: instanceA.userDataDir,
      },
      B: {
        extensionId: instanceB.extensionId,
        fullpageUrl: `chrome-extension://${instanceB.extensionId}/fullpage.html`,
        cdpUrl: '',
        userDataDir: instanceB.userDataDir,
      },
    },
    midenCliWorkDir,
    expiresAt: new Date(Date.now() + AGENTIC_TIMEOUT_MS).toISOString(),
    helpers: {
      reloadAndReopen: 'page.evaluate(() => chrome.runtime.reload())',
      rebuildCmd: 'yarn test:e2e:blockchain:build',
    },
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
  envConfig: async ({}, use) => {
    const config = getEnvironmentConfig();
    await use(config);
  },

  timeline: async ({}, use, testInfo) => {
    const outputDir = getRunOutputDir(testInfo.titlePath.join('-').replace(/\s+/g, '_'));
    const timeline = new TimelineRecorder(outputDir);

    timeline.emit({
      category: 'test_lifecycle',
      severity: 'info',
      message: `Test started: ${testInfo.title}`,
      data: { testFile: testInfo.file, testTitle: testInfo.title },
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
    cleanupStaleSessions();

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

    if (process.env.E2E_AGENTIC !== 'true') {
      await cli.cleanup();
    }
  },

  walletA: async ({ timeline, steps }, use, testInfo) => {
    const extensionPath = getExtensionPath();
    const instance = await launchWalletInstance('A', extensionPath, timeline);
    steps.registerWalletContext('A', instance.context);

    await use(instance.walletPage);

    const isAgentic = process.env.E2E_AGENTIC === 'true';
    if (isAgentic && testInfo.status !== 'passed') {
      // Don't close -- browser stays open for agent inspection
      const timer = setTimeout(async () => {
        try { await instance.context.close(); } catch {}
      }, AGENTIC_TIMEOUT_MS);
      timer.unref();
    } else {
      await instance.context.close();
      fs.rmSync(instance.userDataDir, { recursive: true, force: true });
    }
  },

  walletB: async ({ timeline, steps, walletA, midenCli }, use, testInfo) => {
    const extensionPath = getExtensionPath();
    const instance = await launchWalletInstance('B', extensionPath, timeline);
    steps.registerWalletContext('B', instance.context);

    await use(instance.walletPage);

    // Generate failure report BEFORE closing contexts (so page.evaluate works)
    if (testInfo.status !== 'passed' && testInfo.error) {
      try {
        const reportDir = timeline.getOutputDir();
        const stateA = await captureWalletSnapshot(
          (walletA as any).page,
          'A',
          (walletA as any).extensionId ?? '',
          timeline.currentStep,
          'failure',
          (steps as any).walletContexts?.A
        ).catch(() => undefined);

        const stateB = await captureWalletSnapshot(
          instance.page,
          'B',
          instance.extensionId,
          timeline.currentStep,
          'failure',
          instance.context
        ).catch(() => undefined);

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

    // Now handle context cleanup
    const isAgentic = process.env.E2E_AGENTIC === 'true';
    if (isAgentic && testInfo.status !== 'passed') {
      // Write debug session with both wallet details
      writeDebugSession(
        testInfo.title,
        path.join(timeline.getOutputDir(), 'report.json'),
        {
          extensionId: walletA.extensionId,
          userDataDir: walletA.userDataDir,
        },
        {
          extensionId: instance.extensionId,
          userDataDir: instance.userDataDir,
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
    } else {
      await instance.context.close();
      fs.rmSync(instance.userDataDir, { recursive: true, force: true });
    }
  },
});

export const expect = test.expect;

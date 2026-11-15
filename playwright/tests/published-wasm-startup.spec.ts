import { chromium, expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { browserLaunchOptions } from '../e2e/fixtures/browser-launch-options';

const wasmPath = '/static/wasm/miden_client_web.BlnOkiek.wasm';
const wasmSha256 = '32daa906acbd38633af4ea4037500bea5f7450eb54a0c3b00c28628054ac963c';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ retries: 0, timeout: 60_000 });

type ProbeCase = 'cold-startup' | 'retry-reload';
type Outcome = 'setup_failed' | 'failed' | 'unsupported' | 'passed';
type Phase = 'setup' | 'observation' | 'startup' | 'fault' | 'error_screen' | 'reload' | 'recovery' | 'cleanup' | 'complete';
type ErrorFamily = 'none' | 'timeout' | 'protocol' | 'assertion' | 'other';
interface Result {
  schema: number;
  case: ProbeCase;
  outcome: Outcome;
  phase: Phase;
  error_family: ErrorFamily;
  resource: 'bundled_wasm';
  chromium_version: string;
  node_version: string;
  requests: number;
  completed: number;
  failed: number;
  fault_hits: number;
  reload_observed: boolean;
  error_screen: boolean;
  ready_surface: boolean;
  fresh_binary_completed: boolean;
}

function isolatedPaths(): { extension: string; output: string } {
  const extension = process.env.EXTENSION_DIST;
  const output = process.env.PROBE_RESULTS;
  expect(process.platform).toBe('linux');
  expect(process.getuid?.()).toBeGreaterThan(0);
  expect(process.env.PROBE_ORIGINAL_NETNS).toMatch(/^net:\[\d+\]$/);
  expect(readlinkSync('/proc/self/ns/net')).not.toBe(process.env.PROBE_ORIGINAL_NETNS);
  expect(readdirSync('/sys/class/net')).toEqual(['lo']);
  const status = readFileSync('/proc/self/status', 'utf8');
  expect(status).toMatch(/^NoNewPrivs:\s+1$/m);
  for (const capability of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
    expect(status).toMatch(new RegExp(`^${capability}:\\s+0+$`, 'm'));
  }
  if (!extension || !output || !isAbsolute(extension) || !isAbsolute(output)) throw new Error('invalid_probe_paths');
  expect(realpathSync(extension)).toBe(resolve(extension));
  expect(realpathSync(output)).toBe(resolve(output));
  expect(lstatSync(output).isDirectory()).toBe(true);
  expect(basename(output)).toBe('published-wasm-results');
  return { extension, output };
}

function errorFamily(error: unknown): ErrorFamily {
  if (!(error instanceof Error)) return 'other';
  if (error.name === 'TimeoutError') return 'timeout';
  if (error.name === 'AssertionError' || error.name === 'ExpectError') return 'assertion';
  return 'other';
}

async function readySurface(page: Page): Promise<void> {
  await expect(page.getByTestId('onboarding-welcome')).toBeVisible({ timeout: 12_000 });
  const action = page.getByTestId('onboarding-recover-account').or(page.getByTestId('onboarding-have-code'));
  await expect(action).toBeVisible({ timeout: 5_000 });
  await expect(action).toBeEnabled();
  await expect(page.getByRole('button', { name: /^try again$/i })).toHaveCount(0);
}

async function runProbe(caseName: ProbeCase): Promise<void> {
  const { extension, output } = isolatedPaths();
  const result: Result = {
    schema: 1,
    case: caseName,
    outcome: 'setup_failed',
    phase: 'setup',
    error_family: 'none',
    resource: 'bundled_wasm',
    chromium_version: 'unknown',
    node_version: process.versions.node,
    requests: 0,
    completed: 0,
    failed: 0,
    fault_hits: 0,
    reload_observed: false,
    error_screen: false,
    ready_surface: false,
    fresh_binary_completed: false
  };
  const save = () => writeFileSync(join(output, `${caseName}.json`), `${JSON.stringify(result)}\n`, { mode: 0o600 });
  save();
  let profile: string | undefined;
  let context: BrowserContext | undefined;
  let interceptionUnsupported = false;
  try {
    profile = mkdtempSync(join(dirname(extension), 'profile-'));
    context = await chromium.launchPersistentContext(profile, {
      ...browserLaunchOptions(extension, { E2E_HEADLESS: '1' }),
      locale: 'en-US',
      timeout: 10_000
    });
    const version = context.browser()?.version() ?? '';
    if (/^\d+\.\d+\.\d+\.\d+$/.test(version)) result.chromium_version = version;
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 8_000 }));
    const workerUrl = new URL(worker.url());
    expect(workerUrl.protocol).toBe('chrome-extension:');
    expect(workerUrl.hostname).toMatch(/^[a-p]{32}$/);
    const extensionOrigin = `${workerUrl.protocol}//${workerUrl.hostname}`;
    const target = `${extensionOrigin}${wasmPath}`;
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    const session = await context.newCDPSession(page);
    result.phase = 'observation';
    const requests = new Map<string, { loaderId: string; status: number; completed: boolean }>();
    let observationFailed = false;
    session.on('Network.requestWillBeSent', event => {
      if (event.request.url !== target) return;
      result.requests += 1;
      requests.set(event.requestId, { loaderId: event.loaderId, status: 0, completed: false });
    });
    session.on('Network.responseReceived', event => {
      const request = requests.get(event.requestId);
      if (request) request.status = event.response.status;
    });
    session.on('Network.loadingFailed', event => {
      if (requests.has(event.requestId)) result.failed += 1;
    });
    session.on('Network.loadingFinished', event => {
      const request = requests.get(event.requestId);
      if (!request) return;
      // A status alone is not completion: verify the body of the observed packaged response.
      void session.send('Network.getResponseBody', { requestId: event.requestId }).then(response => {
        if (!response.base64Encoded || request.status !== 200) throw new Error('invalid_binary_response');
        const bytes = Buffer.from(response.body, 'base64');
        if (bytes.length !== 36_425_774 || createHash('sha256').update(bytes).digest('hex') !== wasmSha256) {
          throw new Error('binary_response_mismatch');
        }
        request.completed = true;
        result.completed += 1;
      }).catch(() => {
        observationFailed = true;
      });
    });
    await session.send('Network.enable', { maxTotalBufferSize: 128 * 1024 * 1024, maxResourceBufferSize: 64 * 1024 * 1024 });
    await session.send('Network.setCacheDisabled', { cacheDisabled: true });
    await session.send('Page.enable');
    result.outcome = 'failed';
    if (caseName === 'retry-reload') {
      result.phase = 'fault';
      session.on('Fetch.requestPaused', event => {
        const fail = event.request.url === target && result.fault_hits === 0;
        if (fail) result.fault_hits += 1;
        const command = fail
          ? session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' })
          : session.send('Fetch.continueRequest', { requestId: event.requestId });
        void command.catch(() => { interceptionUnsupported = true; });
      });
      try {
        await session.send('Fetch.enable', { patterns: [{ urlPattern: target, requestStage: 'Request' }] });
      } catch {
        interceptionUnsupported = true;
        throw new Error('interception_unsupported');
      }
    }
    result.phase = 'startup';
    await page.goto(`${extensionOrigin}/fullpage.html`, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    if (caseName === 'retry-reload') {
      try {
        await expect.poll(() => result.fault_hits, { timeout: 8_000 }).toBe(1);
      } catch {
        interceptionUnsupported = result.requests > 0;
        throw new Error('interception_not_observed');
      }
      expect(interceptionUnsupported).toBe(false);
      result.phase = 'error_screen';
      await expect(page.getByRole('heading', { name: 'Oops!', exact: true })).toBeVisible({ timeout: 8_000 });
      const retry = page.getByRole('button', { name: /^try again$/i });
      await expect(retry).toBeVisible();
      await expect(page.getByTestId('onboarding-welcome')).toHaveCount(0);
      result.error_screen = true;
      expect(result.completed).toBe(0);
      expect(result.failed).toBe(1);
      await session.send('Fetch.disable');
      const before = (await session.send('Page.getFrameTree')).frameTree.frame;
      const previousRequests = result.requests;
      result.phase = 'reload';
      await Promise.all([
        page.waitForEvent('domcontentloaded', { timeout: 10_000 }),
        retry.click()
      ]);
      const after = (await session.send('Page.getFrameTree')).frameTree.frame;
      expect(after.id).toBe(before.id);
      expect(after.loaderId).not.toBe(before.loaderId);
      result.reload_observed = true;
      result.phase = 'recovery';
      await expect.poll(() => [...requests.values()].some(request => request.loaderId === after.loaderId && request.completed), {
        timeout: 12_000
      }).toBe(true);
      expect(result.requests).toBeGreaterThan(previousRequests);
      expect(result.fault_hits).toBe(1);
      result.fresh_binary_completed = true;
    } else {
      await expect.poll(() => result.completed, { timeout: 15_000 }).toBeGreaterThan(0);
    }
    await readySurface(page);
    result.ready_surface = true;
    expect(observationFailed).toBe(false);
    expect(interceptionUnsupported).toBe(false);
    expect(result.requests).toBeGreaterThan(0);
    result.phase = 'complete';
    result.outcome = 'passed';
  } catch (error: unknown) {
    if (interceptionUnsupported) {
      result.outcome = 'unsupported';
      result.error_family = 'protocol';
    } else {
      if (result.requests === 0) result.outcome = 'setup_failed';
      result.error_family = errorFamily(error);
    }
  } finally {
    try {
      await context?.close();
    } catch {
      result.outcome = 'failed';
      result.phase = 'cleanup';
      result.error_family = 'other';
    } finally {
      if (profile) rmSync(profile, { recursive: true, force: true });
      save();
    }
  }
  // Never hand a Playwright error carrying a generated extension origin to a reporter.
  expect(result.outcome, `published_wasm_${caseName}_${result.phase}`).toBe('passed');
}

test('published archive cold startup completes packaged WASM and reaches onboarding', async () => {
  await runProbe('cold-startup');
});

test('published archive binary fetch failure recovers only after Try Again reloads the document', async () => {
  await runProbe('retry-reload');
});

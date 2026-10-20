import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.versions.node.split('.')[0], '22');
const own = dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2];
const evidence = process.env.VISUAL_EVIDENCE;
const sourceRequire = createRequire(join(repo, 'package.json'));
const { chromium, expect } = sourceRequire('@playwright/test');
const request = JSON.parse(readFileSync(join(own, 'request.json')));
const identity = JSON.parse(readFileSync(join(evidence, 'identity.json')));
const sha = data => createHash('sha256').update(data).digest('hex');
const commands = [];
const captures = [];
const checks = [];
const blocked = [];
const errors = [];
const warnings = [];
const base = 'http://127.0.0.1:5191';
const fixturePath = 'playwright/visual/usdcx-minimum-proof/vite.config.mts';
const network = [];
const consoleEvents = [];
let activePage;
const shots = join(evidence, 'screenshots');
mkdirSync(shots, { recursive: true });
try {
  const vite = join(repo, 'node_modules/vite/bin/vite.js');
  const buildArgs = [vite, 'build', '--config', fixturePath];
  const build = spawnSync(process.execPath, buildArgs, {
    cwd: repo,
    env: process.env,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 16 * 1024 * 1024
  });
  const buildLog = `${build.stdout || ''}\n${build.stderr || ''}`;
  writeFileSync(join(evidence, 'build.log'), buildLog);
  commands.push({
    command: process.execPath,
    args: buildArgs,
    cwd: repo,
    exit: build.status,
    signal: build.signal,
    error: build.error?.message || null
  });
  writeFileSync(join(evidence, 'commands.json'), JSON.stringify(commands, null, 2) + '\n');
  assert.ifError(build.error);
  assert.equal(build.status, 0, buildLog);
  assert.ok(!/^.*(?:^|\s)(?:ERROR|Error:|error:).*$/m.test(buildLog), buildLog);
  assert.ok(!/compiled with[^\n]*\berrors?\b/i.test(buildLog), buildLog);
  assert.ok(existsSync(join(evidence, 'bundle/index.html')));
  const assets = readdirSync(join(evidence, 'bundle/assets'));
  assert.ok(assets.some(name => name.endsWith('.css')));
  assert.ok(assets.some(name => name.endsWith('.woff2')));
  assert.ok(assets.some(name => name.endsWith('.wasm')));
  writeFileSync(
    join(evidence, 'build-artifacts.json'),
    JSON.stringify(
      {
        html: sha(readFileSync(join(evidence, 'bundle/index.html'))),
        assets: Object.fromEntries(assets.map(name => [name, sha(readFileSync(join(evidence, 'bundle/assets', name)))]))
      },
      null,
      2
    ) + '\n'
  );
  const previewArgs = [vite, 'preview', '--config', fixturePath, '--host', '127.0.0.1', '--port', '5191', '--strictPort'];
  const previewLog = createWriteStream(join(evidence, 'preview.log'));
  const server = spawn(process.execPath, previewArgs, { cwd: repo, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.pipe(previewLog);
  server.stderr.pipe(previewLog);
  let browser;
  let success = false;
  const fonts = [];
  try {
    const deadline = Date.now() + 60000;
    while (true) {
      assert.equal(server.exitCode, null, 'Preview exited before readiness');
      try {
        if ((await fetch(base)).ok) break;
      } catch {}
      assert.ok(Date.now() < deadline, 'Preview did not become ready');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    browser = await chromium.launch({ headless: true });
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: 393, height: 1000 },
        deviceScaleFactor: 1,
        locale: 'en-US',
        colorScheme: theme,
        reducedMotion: 'reduce',
        serviceWorkers: 'block'
      });
      await context.route('**/*', async route => {
        const url = route.request().url();
        if (
          new URL(url).origin !== base ||
          new URL(url).pathname.includes('forbidden-rpc') ||
          route.request().method() !== 'GET'
        ) {
          blocked.push({ theme, url, method: route.request().method() });
          return route.abort('blockedbyclient');
        }
        return route.continue();
      });
      await context.routeWebSocket('**/*', socket => {
        blocked.push({ theme, url: socket.url(), method: 'WEBSOCKET' });
        socket.close();
      });
      await context.addInitScript(() => {
        window.__MINIMUM_SUBMIT_CLICKS__ = 0;
        document.addEventListener(
          'click',
          event => {
            if (event.target instanceof Element && event.target.closest('[data-testid="send-review-submit"]')) {
              window.__MINIMUM_SUBMIT_CLICKS__++;
              event.preventDefault();
              event.stopImmediatePropagation();
            }
          },
          true
        );
      });
      const page = await context.newPage();
      activePage = page;
      page.on('request', request => network.push({ theme, event: 'request', url: request.url(), method: request.method() }));
      page.on('response', response => network.push({ theme, event: 'response', url: response.url(), status: response.status() }));
      page.on('requestfailed', request => network.push({ theme, event: 'failed', url: request.url(), failure: request.failure() }));
      page.on('pageerror', error => errors.push({ theme, message: error.message }));
      page.on('console', message => {
        consoleEvents.push({ theme, type: message.type(), text: message.text() });
        if (message.type() === 'error') errors.push({ theme, message: message.text() });
        if (message.type() === 'warning') warnings.push({ theme, message: message.text() });
      });
      const href = (amount, mode = 'pending') =>
        `${base}/#/send/review?${new URLSearchParams({ amount, to: '0x1111111111111111111111111111111111111111', tokenId: '0x4cbdcaffe75f0a317482224dae6436', network: 'arc-testnet', route: 'usdcx', fixtureRead: mode, fixtureTheme: theme })}`;
      const snapshot = () =>
        page.evaluate(() => ({
          ...window.__MINIMUM_VISUAL__.snapshot(),
          submitClicks: window.__MINIMUM_SUBMIT_CLICKS__,
          sdkReady: window.__MINIMUM_SDK_READY__,
          documentTimeOrigin: performance.timeOrigin,
          path: location.hash.split('?')[0],
          dark: document.documentElement.classList.contains('dark')
        }));
      const navigateFresh = async target => {
        const previousTimeOrigin = await page.evaluate(() => performance.timeOrigin);
        await page.goto(target, { waitUntil: 'networkidle' });
        await page.reload({ waitUntil: 'networkidle' });
        const nextTimeOrigin = await page.evaluate(() => performance.timeOrigin);
        assert.notEqual(nextTimeOrigin, previousTimeOrigin, 'Fresh mount retained the previous document');
        commands.push({ operation: 'fresh_document_reload', target, previousTimeOrigin, nextTimeOrigin, verified: true });
      };
      const row = () => page.getByText('Minimum burn', { exact: true }).locator('..');
      const submit = () => page.getByTestId('send-review-submit');
      const assertState = async (name, minimum, error, states) => {
        await expect(row().getByText(`${minimum} USDCx`, { exact: true })).toBeVisible();
        await expect(submit()).toBeVisible();
        if (error) {
          await expect(page.getByTestId('review-error')).toHaveText(error);
          await expect(submit()).toBeDisabled();
        } else {
          await expect(page.getByTestId('review-error')).toHaveCount(0);
          await expect(submit()).toBeEnabled();
        }
        const state = await snapshot();
        assert.deepEqual(
          state.attempts.map(attempt => attempt.state),
          states
        );
        assert.ok(state.attempts.every(attempt => attempt.account === '0x4cbdcaffe75f0a317482224dae6436'));
        assert.deepEqual(state.forbiddenCalls, []);
        assert.equal(state.submitClicks, 0);
        assert.equal(state.sdkReady, true);
        assert.equal(state.path, '#/send/review');
        assert.equal(state.dark, theme === 'dark');
        if (minimum === 8) assert.deepEqual(state.slotReads, [request.minimum_slot]);
        else assert.deepEqual(state.slotReads, []);
        checks.push({ theme, name, minimum, error: error || null, submit_enabled: !error, reader: state });
        return state;
      };
      const capture = async (name, minimum, error, states) => {
        const before = await assertState(name, minimum, error, states);
        const filename = `${theme}-${name}.png`;
        const path = join(shots, filename);
        await page.screenshot({ path, fullPage: false, animations: 'disabled', scale: 'css' });
        const png = readFileSync(path);
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        const width = png.readUInt32BE(16);
        const height = png.readUInt32BE(20);
        assert.ok(width <= 1800 && height <= 1800, `Screenshot exceeds 1800: ${width}x${height}`);
        assert.equal(width, 393);
        assert.equal(height, 1000);
        const after = await snapshot();
        assert.deepEqual(after, before, 'Reader changed during screenshot');
        captures.push({
          filename,
          theme,
          state: name,
          width,
          height,
          sha256: sha(png),
          caption: `${theme}: real review, ${name}; minimum ${minimum} USDCx; submit ${error ? 'disabled' : 'enabled'}`,
          reader: after
        });
      };
      await page.goto(href('6'), { waitUntil: 'networkidle' });
      await page.waitForFunction(() => window.__MINIMUM_VISUAL__?.snapshot().attempts.length === 1);
      await page.evaluate(() => document.fonts.ready);
      const fontState = await page.evaluate(() => ({
        inter: [400, 500, 600].every(weight => document.fonts.check(`${weight} 12px "Inter"`)),
        nunito: [700, 800].every(weight => document.fonts.check(`${weight} 12px "Nunito"`)),
        body: getComputedStyle(document.body).fontFamily,
        loaded: [...document.fonts]
          .filter(font => font.status === 'loaded')
          .map(font => ({ family: font.family, weight: font.weight }))
      }));
      assert.equal(fontState.inter, true);
      assert.equal(fontState.nunito, true);
      assert.match(fontState.body, /Inter/);
      fonts.push({ theme, ...fontState });
      await capture('pending-floor', 5, undefined, ['pending']);
      const pendingTimeOrigin = captures.at(-1).reader.documentTimeOrigin;
      await page.evaluate(() => window.__MINIMUM_VISUAL__.resolveEight());
      await capture('resolved-minimum', 8, 'Send at least 8 USDCx.', ['resolved']);
      assert.equal(
        captures.at(-1).reader.documentTimeOrigin,
        pendingTimeOrigin,
        'Pending and resolved reads used different documents'
      );
      const warningsBeforeFallback = warnings.length;
      await navigateFresh(href('6', 'reject'));
      await page.waitForFunction(() => window.__MINIMUM_VISUAL__?.snapshot().attempts.length === 2);
      await expect.poll(() => warnings.length).toBe(warningsBeforeFallback + 1);
      await capture('rejected-fallback', 5, undefined, ['rejected', 'rejected']);
      await navigateFresh(href('4'));
      await page.waitForFunction(() => window.__MINIMUM_VISUAL__?.snapshot().attempts.length === 1);
      await assertState('below-wallet-floor', 5, 'Send at least 5 USDCx.', ['pending']);
      await context.close();
    }
    assert.equal(captures.length, 6);
    assert.deepEqual(blocked, []);
    assert.deepEqual(errors, []);
    assert.equal(warnings.length, 2);
    assert.ok(
      warnings.every(item => item.message.startsWith('USDCx minimum burn read failed, using the wallet minimum'))
    );
    for (const [name, expected] of Object.entries(identity.unchanged_protected_and_production_files)) {
      assert.equal(sha(readFileSync(join(repo, name))), expected, name);
    }
    const tree = spawnSync('git', ['write-tree'], { cwd: repo, encoding: 'utf8' });
    assert.equal(tree.status, 0);
    assert.equal(tree.stdout.trim(), identity.source_tree);
    const diff = spawnSync('git', ['diff', '--exit-code'], { cwd: repo, encoding: 'utf8' });
    assert.equal(diff.status, 0, diff.stdout + diff.stderr);
    success = true;
  } finally {
    if (activePage && !activePage.isClosed()) {
      try {
        checks.push({ final_browser_state: await activePage.evaluate(() => ({ reader: window.__MINIMUM_VISUAL__?.snapshot(), submitClicks: window.__MINIMUM_SUBMIT_CLICKS__ })) });
      } catch (error) {
        errors.push({ final_snapshot_error: error.message });
      }
    }
    await browser?.close();
    server.kill('SIGTERM');
    commands.push({
      command: process.execPath,
      args: previewArgs,
      cwd: repo,
      headless: true,
      preview_stopped_after_checks: true
    });
    writeFileSync(join(evidence, 'commands.json'), JSON.stringify(commands, null, 2) + '\n');
    writeFileSync(
      join(evidence, 'assertions.json'),
      JSON.stringify(
        {
          success,
          ...identity,
          captures,
          checks,
          fonts,
          blocked_network_calls: blocked,
          page_errors: errors,
          warnings,
          source_hashes_and_source_tree_unchanged: success,
          submit_or_transaction_or_funding_calls: success ? 0 : null,
          platform_scope: 'headless Chromium web viewport; no native device acceptance'
        },
        null,
        2
      ) + '\n'
    );
  }
  assert.equal(success, true);
  console.log(
    `Visual proof passed: ${captures.length} capped screenshots, ${checks.length} state checks, zero outgoing actions or requests.`
  );
} finally {
  writeFileSync(
    join(evidence, 'browser-events.json'),
    JSON.stringify(
      { network, console: consoleEvents, page_errors: errors, warnings, blocked_network_calls: blocked, captures, checks },
      null,
      2
    ) + '\n'
  );
  writeFileSync(join(evidence, 'commands.json'), JSON.stringify(commands, null, 2) + '\n');
}

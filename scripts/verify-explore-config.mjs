#!/usr/bin/env node
/**
 * Local, no-chain config → real extension → UI harness.
 * node scripts/verify-explore-config.mjs --config-repo ../wallet-config-explore
 * Uses a disposable E2E mock-wallet profile, not the user's wallet or simulator.
 * Catalog requests use a real loopback HTTP server; only wallet/account readiness
 * is seeded through the existing E2E store. No balances, signing or chain writes.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';
import { expect } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv.indexOf('--config-repo');
assert.ok(arg !== -1 && process.argv[arg + 1], 'Provide --config-repo pointing at the wallet-config worktree');
const configRoot = path.resolve(process.argv[arg + 1]);
const out = path.resolve(process.env.EXPLORE_HARNESS_OUTPUT || path.join(root, '../explore-harness-results'));
mkdirSync(out, { recursive: true });
const catalogs = Object.fromEntries(
  ['devnet', 'testnet'].map(network => [
    network,
    JSON.parse(readFileSync(path.join(configRoot, 'explore', network + '.json'), 'utf8'))
  ])
);
const validator = await import(pathToFileURL(path.join(configRoot, 'scripts/validate-explore.mjs')));
for (const network of Object.keys(catalogs)) {
  assert.deepEqual(validator.validateFile(`explore/${network}.json`, { root: configRoot }).errors, []);
  assert.ok(catalogs[network].items.every(item => ['finance', 'arcade', 'others'].includes(item.category)));
}

const requests = [];
let mode = 'published';
let fixture;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 'no-store');
  if (url.pathname === '/explore/testnet.json') {
    const status = mode === 'unavailable' ? 503 : 200;
    const body =
      mode === 'published' ? catalogs.testnet : mode === 'invalid' ? { ...fixture, network: 'devnet' } : fixture;
    requests.push({ path: url.pathname, mode, status, version: body.version });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  } else if (url.pathname === '/explore/devnet.json') {
    requests.push({ path: url.pathname, mode, status: 200, version: catalogs.devnet.version });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(catalogs.devnet));
  } else if (url.pathname.startsWith('/explore/icons/')) {
    const name = path.basename(url.pathname);
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(readFileSync(path.join(configRoot, 'explore/icons', name)));
  } else if (url.pathname.startsWith('/game/')) {
    requests.push({ path: url.pathname, mode, status: 200 });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<!doctype html><title>Arcade harness game</title><h1>Local fixture game</h1><p>No wallet connection or transaction requested.</p>'
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;
console.log(`Catalog server: ${base}/explore; output: ${out}`);

const build = () =>
  new Promise((resolve, reject) => {
    const child = spawn('yarn', ['build:chrome'], {
      cwd: root,
      env: {
        ...process.env,
        MIDEN_E2E_TEST: 'true',
        MIDEN_USE_MOCK_CLIENT: 'true',
        MIDEN_NETWORK: 'testnet',
        MODE_ENV: 'production',
        NODE_ENV: 'production',
        MIDEN_EXPLORE_CONFIG_URL: `${base}/explore`,
        APTABASE_APP_KEY: '',
        SENTRY_DSN: ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', data => {
      log += data;
    });
    child.stderr.on('data', data => {
      log += data;
    });
    child.on('error', reject);
    child.on('exit', code => {
      writeFileSync(path.join(out, 'build.log'), log);
      code === 0 ? resolve() : reject(new Error(`Harness build failed (${code}); see build.log`));
    });
  });

let context;
let page;
const errors = [];
const consoleErrors = [];
const blocked = [];
const checks = [];
const check = label => {
  checks.push(label);
  console.log('PASS ' + label);
};
try {
  await build();
  check('Dedicated E2E/mock build, real configured HTTP catalog source');
  const profile = mkdtempSync(path.join(tmpdir(), 'bread-explore-audit-'));
  const extension = path.join(root, 'dist/chrome_unpacked');
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 360, height: 600 },
    reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    ignoreDefaultArgs: ['--disable-extensions']
  });
  // Page/dApp traffic is loopback-only; no onboarding, Guardian registration, signing or transactions are driven.
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:' || url.origin === base || url.protocol === 'data:')
      return route.continue();
    blocked.push({ url: url.origin + url.pathname, method: route.request().method() });
    return route.abort();
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
  const id = new URL(worker.url()).host;
  await worker.evaluate(async () => {
    await chrome.storage.local.remove('fresh_install');
  });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.setDefaultTimeout(15_000);
  await page.addInitScript(() => {
    localStorage.setItem('locale', 'en');
    const getViews = chrome.extension.getViews.bind(chrome.extension);
    chrome.extension.getViews = options => (options?.type === 'popup' ? [window] : getViews(options));
  });
  const open = async (route = '/browser', surface = 'popup') => {
    await page.goto(`chrome-extension://${id}/${surface}.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Reflect.get(window, '__TEST_STORE__')?.getState().isInitialized === true);
    await page.evaluate(route => {
      const account = {
        publicKey: 'mtst1aqvpq8a9ytqhfvt9al20wzsrs56g83ec',
        name: 'Disposable catalog harness',
        isPublic: false,
        type: 'guardian',
        hdIndex: 0,
        authScheme: 1
      };
      Reflect.get(window, '__TEST_STORE__').setState({
        status: 2,
        accounts: [account],
        currentAccount: account,
        isInitialized: true,
        hasCompletedInitialSync: true,
        ownMnemonic: false,
        settings: { contacts: [] }
      });
      window.location.hash = route;
    }, route);
    await page.getByTestId('explore-chip-all').waitFor({ state: 'visible' });
  };
  await open();
  await page.getByTestId('explore-chip-arcade').click();
  await page.getByTestId('arcade-landing').waitFor();
  await page.getByText('Where Legends Grow', { exact: true }).first().waitFor();
  assert.ok(requests.some(r => r.path === '/explore/testnet.json' && r.mode === 'published'));
  assert.deepEqual(await page.locator('[data-testid^="explore-chip-"]').allTextContents(), [
    'All',
    'Finance',
    'Arcade',
    'Others'
  ]);
  await page.screenshot({ path: path.join(out, '01-published-arcade.png') });
  check('Actual migrated catalog fetched over HTTP; four native tabs; configured game rendered');
  await page.getByTestId('explore-chip-finance').click();
  await page.getByText('Forkchoice Faucet', { exact: true }).waitFor();
  assert.equal(await page.getByText('Where Legends Grow', { exact: true }).count(), 0);
  check('Finance includes configured faucets and excludes Arcade game');
  await page.getByTestId('explore-chip-others').click();
  await expect(page.getByTestId('explore-chip-others')).toHaveAttribute('aria-checked', 'true');
  assert.equal(await page.getByText('Where Legends Grow', { exact: true }).count(), 0);
  await page.screenshot({ path: path.join(out, '02-others-empty.png') });
  check('Others does not leak Finance or Arcade entries');

  const ageCache = () =>
    worker.evaluate(async () => {
      const key = 'explore_config_v1:testnet';
      const entry = (await chrome.storage.local.get(key))[key];
      if (!entry) throw new Error('The actual catalog fetch did not persist its validated response');
      await chrome.storage.local.set({ [key]: { ...entry, fetchedAt: 1 } });
    });
  const localItem = (id, category, name, gamePath) => ({
    id,
    category,
    name: { en: name },
    tagline: { en: 'Local harness fixture — not a published listing' },
    url: `${base}/game/${gamePath}`,
    isExchange: false
  });
  fixture = {
    network: 'testnet',
    version: 100,
    items: [
      localItem('fixture-finance', 'finance', 'Harness Finance', 'finance'),
      localItem('fixture-game', 'arcade', 'Harness Game One', 'one?source=config#start'),
      localItem('fixture-game-two', 'arcade', 'Harness Game Two', 'two'),
      localItem('fixture-others', 'others', 'Harness Learning', 'learning')
    ],
    sections: [
      {
        id: 'featured',
        kind: 'featured',
        title: { en: 'Harness featured' },
        itemIds: ['fixture-game', 'fixture-game-two']
      },
      {
        id: 'catalog',
        kind: 'list',
        title: { en: 'Harness catalog' },
        itemIds: ['fixture-finance', 'fixture-game', 'fixture-game-two', 'fixture-others']
      }
    ]
  };
  mode = 'fixture';
  await ageCache();
  await open();
  await page.getByText('Harness Learning', { exact: true }).waitFor();
  check('Higher-version server catalog replaces cached data in the actual wallet');
  await page.getByTestId('explore-chip-finance').click();
  await expect(page.getByText('Harness Finance', { exact: true })).toBeVisible();
  await expect(page.getByText('Harness Learning', { exact: true })).toHaveCount(0);
  await page.getByTestId('explore-chip-others').click();
  await expect(page.getByText('Harness Learning', { exact: true })).toBeVisible();
  await expect(page.getByText('Harness Finance', { exact: true })).toHaveCount(0);
  await page.getByTestId('explore-chip-arcade').click();
  await expect(page.getByTestId('arcade-featured-game')).toHaveCount(2);
  await expect(page.getByTestId('arcade-quick-actions').getByRole('button')).toHaveCount(3);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: path.join(out, '03-three-categories-popup.png') });
  check(
    'Direct categories isolate Finance, Arcade and Others; multi-game featured carousel and three shortcuts render'
  );

  await page.getByTestId('explore-search-toggle').click();
  await page.getByTestId('dapp-hero-search').fill('no matching game');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByTestId('home-arcade-banner').click();
  await expect(page.getByTestId('arcade-landing')).toBeVisible();
  await expect(page.getByTestId('dapp-hero-search')).toHaveCount(0);
  check('Home banner clears retained search and reveals the native Arcade landing');

  const destination = `${base}/game/one?source=config#start`;
  const launched = context.waitForEvent('page');
  await page.getByTestId('arcade-open-game').first().click();
  const game = await launched;
  await game.waitForURL(destination);
  await expect(game.getByText('Local fixture game', { exact: true })).toBeVisible();
  assert.equal(context.pages().filter(tab => tab.url().includes('/confirm.html')).length, 0);
  await game.screenshot({ path: path.join(out, '04-configured-game-launch.png') });
  await game.close();
  check('Open launches the server-configured URL including query/fragment, with no connection or approval popup');

  await page.getByTestId('arcade-quick-actions').getByRole('button', { name: 'Rankings', exact: true }).click();
  const ranking = page.getByTestId('arcade-rankings-page');
  await expect(ranking).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toHaveCount(0);
  const footer = ranking.locator('[data-slot="footer"]');
  await expect(footer.getByRole('button', { name: 'Update balance', exact: true })).toBeVisible();
  const footerBox = await footer.boundingBox();
  assert.ok(footerBox && footerBox.y + footerBox.height <= 600 && footerBox.y > 400);
  await page.screenshot({ path: path.join(out, '05-rankings-pinned-popup.png') });
  await footer.getByRole('button', { name: 'Update balance', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Submit balance', exact: true })).toBeDisabled();
  check('GC ranking actions are pinned on a short popup; real balance submission is disabled');
  await page.evaluate(() => {
    window.location.hash = '/arcade/rankings?preview=sample';
  });
  await expect(page.getByTestId('arcade-sample-hero')).toHaveCount(0);
  await expect(page.getByTestId('arcade-sample-leaderboard')).toHaveCount(0);
  check('Production-mode UI cannot enable fictional ranking data through a preview query');

  // Force normal foreground revalidation by aging only the timestamp, never bypassing parsing or the floor.
  mode = 'invalid';
  await ageCache();
  await open();
  await page.waitForFunction(() => Reflect.get(window, '__TEST_STORE__').getState().status === 2);
  await expect(page.getByText('Harness Learning', { exact: true })).toBeVisible();
  await expect.poll(() => requests.some(r => r.mode === 'invalid')).toBe(true);
  assert.equal(
    await worker.evaluate(
      async () => (await chrome.storage.local.get('explore_config_floor_v1')).explore_config_floor_v1.testnet
    ),
    100
  );
  check('Wrong-network response is rejected; validated cached catalog and version floor survive');

  mode = 'unavailable';
  await ageCache();
  await open();
  await expect(page.getByText('Harness Learning', { exact: true })).toBeVisible();
  await expect.poll(() => requests.some(r => r.mode === 'unavailable' && r.status === 503)).toBe(true);
  check('HTTP failure retains the last accepted catalog rather than blanking Explore');

  fixture = { ...fixture, version: 99, items: [], sections: [] };
  mode = 'rollback';
  await ageCache();
  await open();
  await expect(page.getByText('Harness Learning', { exact: true })).toBeVisible();
  await expect.poll(() => requests.some(r => r.mode === 'rollback')).toBe(true);
  check('Lower-version response cannot replace the accepted catalog');

  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      endpoint_overrides: {
        rpcUrl: '',
        proverUrl: '',
        noteTransportUrl: '',
        faucetUrl: '',
        faucetApiUrl: '',
        explorerUrl: '',
        guardianUrl: '',
        networkName: 'devnet',
        presetName: 'devnet',
        allowNoGuardian: false
      }
    });
  });
  await open();
  await expect.poll(() => requests.some(r => r.path === '/explore/devnet.json')).toBe(true);
  await expect(page.getByText('Faucet', { exact: true }).first()).toBeVisible();
  await page.getByTestId('explore-chip-arcade').click();
  await expect(page.getByText('Harness Game One', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: path.join(out, '06-devnet-isolation.png') });
  check('Devnet fetches its own document and never inherits testnet games or its version floor');
  await worker.evaluate(async () => {
    await chrome.storage.local.remove('endpoint_overrides');
  });
  await open();
  await page.getByTestId('explore-chip-arcade').click();
  await expect(page.getByTestId('arcade-featured-game')).toHaveCount(2);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByTestId('arcade-game-list').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, '07-arcade-dark-popup.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  // The existing full-page shell explicitly has min-width: 640px; narrower windows use popup/mobile surfaces.
  await page.setViewportSize({ width: 640, height: 800 });
  await open('/browser?category=arcade', 'fullpage');
  await expect(page.getByTestId('arcade-featured-game')).toHaveCount(2);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: path.join(out, '08-arcade-wide.png') });
  check('360px popup light/dark and 640px full-page layouts render without horizontal page overflow');
  assert.deepEqual(errors, []);
  writeFileSync(
    path.join(out, 'report.json'),
    JSON.stringify({ checks, requests, errors, consoleErrors, blocked }, null, 2)
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    writeFileSync(path.join(out, 'failure.html'), await page.content().catch(() => ''));
  }
  writeFileSync(
    path.join(out, 'report.json'),
    JSON.stringify({ checks, requests, errors, consoleErrors, blocked, failure: String(error) }, null, 2)
  );
  throw error;
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
}

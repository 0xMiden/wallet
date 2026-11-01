import { chromium, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { acknowledgeNetworkNotice } from '../e2e/helpers/network-notice';
import { passImportConfirmation } from '../e2e/helpers/onboarding-confirmation';
import { dismissTelemetryConsent } from '../e2e/helpers/telemetry-consent';

for (const theme of ['light', 'dark'] as const) {
  test(`native toolbar click toggles sidebar after full-page onboarding (${theme})`, async ({}, testInfo) => {
    const root = mkdtempSync(join(tmpdir(), 'bread-toolbar-'));
    const extension = join(root, 'extension');
    cpSync(resolve('dist/chrome_unpacked'), extension, { recursive: true });
    const manifestPath = join(extension, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.action.default_popup).toBeUndefined();
    const profile = join(root, 'profile');
    const launch = () =>
      chromium.launchPersistentContext(profile, {
        headless: false,
        colorScheme: theme,
        viewport: null,
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
          '--window-size=1400,1000',
          '--force-renderer-accessibility',
          '--remote-debugging-port=0'
        ],
        ignoreDefaultArgs: ['--disable-extensions']
      });
    let context = await launch();
    const capture = async (name: string) => {
      await new Promise(resolve =>
        setTimeout(resolve, name.includes('onboarding') || name.includes('closed') ? 250 : 7000)
      );
      const path = testInfo.outputPath(`${theme}-${name}.png`);
      execFileSync('import', ['-window', 'root', path]);
      execFileSync('convert', [path, '-resize', '1800x1800>', path]);
      await testInfo.attach(name, { path, contentType: 'image/png' });
    };
    type SidebarState = {
      at: number;
      hidden: boolean;
      rootFallback: boolean;
      routeFallback: boolean;
      rootEmpty: boolean;
      unlock: boolean;
      navigation: boolean;
    };
    type SidebarSummary = { timeOrigin: number; current: SidebarState; samples: SidebarState[] };
    const sidebarSnapshot = async (capturePath?: string) => {
      const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets: unknown = await response.json();
      if (!Array.isArray(targets)) throw new Error('Chrome target inventory unavailable');
      const target = targets.find(item => typeof item?.url === 'string' && item.url.includes('/sidepanel.html'));
      if (!target) return { present: false };
      if (typeof target.webSocketDebuggerUrl !== 'string') throw new Error('Sidebar debugging endpoint unavailable');
      let captured = false;
      const summary = await new Promise<SidebarSummary>((resolveSnapshot, reject) => {
        let diagnostic: SidebarSummary | undefined;
        const connection = new WebSocket(target.webSocketDebuggerUrl);
        const timeout = setTimeout(() => {
          connection.close();
          reject(new Error('Sidebar snapshot timed out'));
        }, 5000);
        connection.addEventListener('open', () => {
          connection.send(
            JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: {
                expression: `(() => {
              const inspect = () => ({
                at: performance.now(),
                hidden: document.hidden,
                rootFallback: Boolean(document.querySelector('.flex.items-center.justify-center.h-screen.bg-app-bg')),
                routeFallback: Boolean(document.querySelector('[data-testid="wallet-route-loading"]')),
                loadingText: /(?:^|\\n)Loading(?:\\.\\.\\.|…)?(?:$|\\n)/.test(document.body?.innerText ?? ''),
                rootEmpty: !document.getElementById('root')?.childElementCount,
                unlock: Boolean(document.querySelector('#unlock-password, [data-testid="unlock-passcode"]')),
                navigation: Boolean(document.querySelector('nav'))
              });
              if (!window.__sidebarReopenProbe) {
                const samples = [];
                const record = () => { samples.push(inspect()); if (samples.length > 600) samples.shift(); };
                const observer = new MutationObserver(record);
                observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
                document.addEventListener('visibilitychange', record);
                window.__sidebarReopenProbe = samples;
                record();
              }
              return { timeOrigin: performance.timeOrigin, current: inspect(), samples: window.__sidebarReopenProbe };
            })()`,
                returnByValue: true
              }
            })
          );
        });
        connection.addEventListener('message', event => {
          const message = JSON.parse(String(event.data));
          if (message.id !== 1 && message.id !== 2) return;
          if (message.error || message.result?.exceptionDetails) {
            clearTimeout(timeout);
            connection.close();
            reject(new Error('Sidebar evaluation failed'));
            return;
          }
          if (message.id === 1) {
            const value = message.result?.result?.value;
            if (!value || typeof value.timeOrigin !== 'number' || !Array.isArray(value.samples)) {
              clearTimeout(timeout);
              connection.close();
              reject(new Error('Sidebar diagnostic payload unavailable'));
              return;
            }
            diagnostic = value;
            if (capturePath && value.current.routeFallback) {
              connection.send(
                JSON.stringify({
                  id: 2,
                  method: 'Page.captureScreenshot',
                  params: { format: 'png', captureBeyondViewport: false }
                })
              );
              return;
            }
          } else if (capturePath && typeof message.result?.data === 'string') {
            writeFileSync(capturePath, Buffer.from(message.result.data, 'base64'));
            execFileSync('convert', [capturePath, '-resize', '1800x1800>', capturePath]);
            captured = true;
          }
          clearTimeout(timeout);
          connection.close();
          if (diagnostic) resolveSnapshot(diagnostic);
          else reject(new Error('Sidebar diagnostic missing after capture'));
        });
        connection.addEventListener('error', () => {
          clearTimeout(timeout);
          reject(new Error('Sidebar debugging connection failed'));
        });
      });
      return { present: true, targetId: target.id, summary, captured };
    };
    const persistDiagnostic = async (name: string, value: unknown) => {
      const path = testInfo.outputPath(`${theme}-${name}.json`);
      writeFileSync(path, JSON.stringify(value, null, 2));
      await testInfo.attach(name, { path, contentType: 'application/json' });
    };
    const captureEarlyReopen = async (name: string) => {
      const samples = [];
      for (let frame = 0; frame < 8; frame++) {
        samples.push({ frame, snapshot: await sidebarSnapshot() });
        const path = testInfo.outputPath(`${theme}-${name}-frame-${frame}.png`);
        execFileSync('import', ['-window', 'root', path]);
        execFileSync('convert', [path, '-resize', '1800x1800>', path]);
        await testInfo.attach(`${name}-frame-${frame}`, { path, contentType: 'image/png' });
      }
      await persistDiagnostic(`${name}-diagnostics`, samples);
    };
    const verifyWarmReopen = async () => {
      const samples = [];
      const path = testInfo.outputPath(`${theme}-warm-route-loading.png`);
      let captured = false;
      let readyFrames = 0;
      for (let frame = 0; frame < 600 && readyFrames < 3; frame++) {
        const snapshot = await sidebarSnapshot(captured ? undefined : path);
        if (snapshot.captured) captured = true;
        samples.push({ frame, snapshot });
        readyFrames = snapshot.summary?.current.navigation ? readyFrames + 1 : 0;
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      await persistDiagnostic('warm-reopen-regression', samples);
      if (captured) await testInfo.attach('warm-route-loading', { path, contentType: 'image/png' });
      expect(readyFrames).toBe(3);
      expect(samples.some(sample => sample.snapshot.summary?.samples.some(state => state.routeFallback))).toBe(false);
    };
    const activate = () => {
      const value: unknown = JSON.parse(
        execFileSync('/usr/bin/python3', [resolve('playwright/toolbar/native-bread-button.py')], {
          timeout: 15000
        }).toString()
      );
      if (!Array.isArray(value) || value.length !== 2 || !value.every(item => Number.isInteger(item)))
        throw new Error('Native toolbar bounds invalid');
      execFileSync('xdotool', ['mousemove', String(value[0]), String(value[1]), 'click', '1'], {
        timeout: 10000
      });
    };
    try {
      let worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      const observePanel = () =>
        worker.evaluate(() => {
          const state = { open: false, opened: 0, closed: 0 };
          Reflect.set(globalThis, '__toolbarPanelObservation', state);
          const events = [
            { name: 'onOpened', open: true },
            { name: 'onClosed', open: false }
          ];
          for (const { name, open } of events) {
            const event: unknown = Reflect.get(chrome.sidePanel, name);
            if (
              !event ||
              typeof event !== 'object' ||
              !('addListener' in event) ||
              typeof event.addListener !== 'function'
            )
              throw new Error('Native panel event unavailable');
            event.addListener(() => {
              state.open = open;
              if (open) state.opened++;
              else state.closed++;
            });
          }
        });
      const panelCount = () =>
        worker.evaluate(() => {
          const state: unknown = Reflect.get(globalThis, '__toolbarPanelObservation');
          return state && typeof state === 'object' && 'open' in state && state.open === true ? 1 : 0;
        });
      await observePanel();
      await expect.poll(() => context.pages().some(p => p.url().includes('/fullpage.html'))).toBe(true);
      let page = context.pages().find(p => p.url().includes('/fullpage.html'))!;
      await page.waitForSelector('[data-testid="onboarding-welcome"]', { timeout: 45000 });
      expect(context.pages().filter(p => p.url().includes('/fullpage.html'))).toHaveLength(1);
      await page.evaluate(value => {
        localStorage.setItem('theme_setting', value);
        localStorage.setItem('popup_mode', 'false');
      }, theme);
      await page.reload();
      await page.waitForSelector('[data-testid="onboarding-welcome"]');
      await page.bringToFront();
      await capture('fresh-install-fullpage-onboarding');
      const extensionId = new URL(worker.url()).host;
      await context.close();
      const preferencesPath = join(profile, 'Default', 'Preferences');
      const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'));
      preferences.extensions ??= {};
      preferences.extensions.pinned_extensions = [extensionId];
      writeFileSync(preferencesPath, JSON.stringify(preferences));
      context = await launch();
      worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      await observePanel();
      activate();
      await expect.poll(() => context.pages().some(p => p.url().includes('/fullpage.html'))).toBe(true);
      page = context.pages().find(p => p.url().includes('/fullpage.html'))!;
      await page.waitForSelector('[data-testid="onboarding-welcome"]');
      await capture('fullpage-onboarding');
      activate();
      await expect
        .poll(() =>
          worker.evaluate(() => {
            const state: unknown = Reflect.get(globalThis, '__toolbarPanelObservation');
            return (
              state &&
              typeof state === 'object' &&
              'opened' in state &&
              'closed' in state &&
              typeof state.opened === 'number' &&
              typeof state.closed === 'number' &&
              state.opened > 0 &&
              state.closed > 0
            );
          })
        )
        .toBe(true);
      await expect.poll(panelCount).toBe(0);
      await expect(page.getByTestId('onboarding-welcome')).toBeVisible();
      await capture('interrupted-onboarding-returned-to-fullpage');
      await page.locator('#import-link').click();
      await acknowledgeNetworkNotice(page, 15000);
      await page.getByTestId('import-type-seed-phrase').click();
      const words =
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'.split(' ');
      for (const [index, word] of words.entries()) await page.locator(`#seed-phrase-input-${index}`).fill(word);
      await page.getByRole('button', { name: /continue/i }).click();
      await page.locator('input[placeholder="Enter password"]').fill('FixturePassword123!');
      await page.locator('input[placeholder="Enter password again"]').fill('FixturePassword123!');
      await page.getByRole('button', { name: /continue/i }).click();
      await page.getByText(/import public account/i).click();
      await page.getByTestId('reused-phrase-acknowledge').click();
      await page.getByRole('button', { name: /continue/i }).click();
      await passImportConfirmation(page, 45000);
      await dismissTelemetryConsent(page, { nextSurface: '[data-testid="finish-side-panel"]', timeoutMs: 45000 });
      await page
        .getByTestId('finish-side-panel')
        .getByRole('button', { name: /open wallet/i })
        .click();
      await expect.poll(panelCount).toBe(1);
      await capture('ready-sidebar');
      await persistDiagnostic('ready-sidebar-diagnostic', await sidebarSnapshot());
      activate();
      await expect.poll(panelCount).toBe(0);
      await capture('native-action-closed');
      await persistDiagnostic('closed-sidebar-diagnostic', await sidebarSnapshot());
      activate();
      await captureEarlyReopen('initial-reopen');
      await expect.poll(panelCount).toBe(1);
      await capture('native-action-reopened');
      const readySidebar = await sidebarSnapshot();
      await persistDiagnostic('settled-warm-sidebar', readySidebar);
      expect(readySidebar).toMatchObject({
        present: true,
        summary: { current: { hidden: false, rootFallback: false, rootEmpty: false, navigation: true } }
      });
      activate();
      await expect.poll(panelCount).toBe(0);
      await persistDiagnostic('warm-sidebar-closed', await sidebarSnapshot());
      activate();
      await verifyWarmReopen();
      await expect.poll(panelCount).toBe(1);
      await capture('settled-warm-reopen');
      activate();
      await expect.poll(panelCount).toBe(0);
      await worker.evaluate(async () => {
        await chrome.storage.local.set({ sidepanel_mode: false });
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
        await chrome.action.setPopup({ popup: 'popup.html' });
      });
      activate();
      await expect.poll(() => worker.evaluate(() => chrome.action.getPopup({}))).toBe('');
      execFileSync('xdotool', ['key', 'Escape'], { timeout: 10000 });
      await expect
        .poll(() =>
          worker.evaluate(
            async () => (await chrome.runtime.getContexts({})).filter(item => item.contextType === 'POPUP').length
          )
        )
        .toBe(0);
      activate();
      await expect.poll(panelCount).toBe(1);
      await capture('legacy-popup-recovered-on-later-action');
      await worker.evaluate(async () => {
        await chrome.storage.local.set({ sidepanel_mode: false });
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
        await chrome.action.setPopup({ popup: 'popup.html' });
      });
      await context.close();
      context = await launch();
      worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      await observePanel();
      await expect.poll(() => worker.evaluate(() => chrome.action.getPopup({}))).toBe('');
      await expect
        .poll(() => worker.evaluate(() => chrome.sidePanel.getPanelBehavior()))
        .toEqual({ openPanelOnActionClick: true });
      const ordinary = context.pages()[0] ?? (await context.newPage());
      await ordinary.goto('about:blank');
      await ordinary.bringToFront();
      activate();
      await expect.poll(panelCount).toBe(1);
      await capture('old-popup-preference-recovered-after-restart');
      expect(context.pages().some(p => p.url().includes('/popup.html'))).toBe(false);
      activate();
      await expect.poll(panelCount).toBe(0);
      const id = new URL(worker.url()).host;
      for (const extensionPage of context.pages().filter(item => item.url().startsWith(`chrome-extension://${id}/`)))
        await extensionPage.close();
      const protocol = await context.newCDPSession(ordinary);
      await worker.evaluate(() => Reflect.set(globalThis, '__toolbarBeforeStop', true));
      let versionId = '';
      let runningStatus = '';
      let sawStopped = false;
      protocol.on('ServiceWorker.workerVersionUpdated', event => {
        for (const version of event.versions) {
          if (version.scriptURL === worker.url()) {
            if (!versionId && version.runningStatus === 'running') versionId = version.versionId;
            if (version.versionId === versionId) {
              runningStatus = version.runningStatus;
              if (runningStatus === 'stopped') sawStopped = true;
            }
          }
        }
      });
      await protocol.send('ServiceWorker.enable');
      await expect.poll(() => versionId).not.toBe('');
      sawStopped = false;
      await protocol.send('ServiceWorker.stopWorker', { versionId });
      await expect.poll(() => sawStopped).toBe(true);
      const control = await context.newPage();
      await control.goto(`chrome-extension://${id}/fullpage.html`);
      await expect.poll(() => runningStatus, { timeout: 30000 }).toBe('running');
      worker = context.serviceWorkers().find(item => new URL(item.url()).host === id)!;
      await expect
        .poll(() => worker.evaluate(() => Reflect.get(globalThis, '__toolbarBeforeStop')), { timeout: 30000 })
        .toBeUndefined();
      await observePanel();
      await expect.poll(() => worker.evaluate(() => chrome.action.getPopup({}))).toBe('');
      await expect
        .poll(() => worker.evaluate(() => chrome.sidePanel.getPanelBehavior()))
        .toEqual({ openPanelOnActionClick: true });
      await control.close();
      await ordinary.bringToFront();
      activate();
      await expect.poll(panelCount).toBe(1);
      await capture('native-action-after-worker-stop-and-wake');
    } catch (error) {
      await capture('failure-browser');
      throw error;
    } finally {
      await context.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

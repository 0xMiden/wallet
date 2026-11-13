import type { BrowserContext, CDPSession, Page, TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

import { completeSeedImportOnboarding } from '../e2e/helpers/dapp-confirm';
import { expect, test } from '../fixtures/extension';

// Only cleared Settings/Unlock screens are retained, never private inputs or ceremony results.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

// Runner-only observations survive page reloads and never enter artifacts or wallet state.
const prfObservations = new WeakMap<BrowserContext, { secrets: Set<string>; count: number }>();

function overrideOs() {
  const data: unknown = Reflect.get(navigator, 'userAgentData');
  if (!data || typeof data !== 'object') throw new Error('Browser UA-CH unavailable');
  const getValues: unknown = Reflect.get(data, 'getHighEntropyValues');
  if (typeof getValues !== 'function') throw new Error('Browser UA-CH versions unavailable');
  Reflect.set(globalThis, '__platformOriginalUaDataStable', Reflect.get(navigator, 'userAgentData') === data);
  Object.defineProperty(data, 'getHighEntropyValues', {
    configurable: true,
    value: async (hints: string[]) => {
      const original: unknown = await getValues.call(data, hints);
      if (!original || typeof original !== 'object') throw new Error('Invalid browser UA-CH evidence');
      // Preserve the real browser brand/version. Only OS evidence is simulated on Linux CI.
      return { ...original, platform: 'Windows', platformVersion: '13.0.0' };
    }
  });
  Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: data });
}

async function simulateEligibleOs(context: BrowserContext) {
  await context.addInitScript(overrideOs);
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await worker.evaluate(overrideOs);
  const observations = { secrets: new Set<string>(), count: 0 };
  prfObservations.set(context, observations);
  await context.exposeBinding('__platformCapturePrf', (_source, value: unknown) => {
    if (typeof value !== 'string' || value.length !== 44) throw new Error('Invalid private PRF observation');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== 32) throw new Error('Invalid private PRF observation');
    observations.count += 1;
    observations.secrets.add(value);
    observations.secrets.add(bytes.toString('base64url'));
    observations.secrets.add(bytes.toString('hex'));
    bytes.fill(0);
  });
  await context.addInitScript(() => {
    let ceremonies = 0;
    let settled = 0;
    const observe = async (credential: Credential | null) => {
      if (credential instanceof PublicKeyCredential) {
        const extensions: unknown = credential.getClientExtensionResults();
        const prf: unknown = extensions && typeof extensions === 'object' ? Reflect.get(extensions, 'prf') : null;
        const results: unknown = prf && typeof prf === 'object' ? Reflect.get(prf, 'results') : null;
        const first: unknown = results && typeof results === 'object' ? Reflect.get(results, 'first') : null;
        if (first instanceof ArrayBuffer) {
          const bytes = new Uint8Array(first);
          const base64 = btoa(String.fromCharCode(...bytes));
          const capture: unknown = Reflect.get(window, '__platformCapturePrf');
          if (typeof capture !== 'function') throw new Error('Private PRF observer unavailable');
          await capture(base64);
        }
      }
      return credential;
    };
    const create = navigator.credentials.create.bind(navigator.credentials);
    const get = navigator.credentials.get.bind(navigator.credentials);
    const invoke = async (ceremony: () => Promise<Credential | null>) => {
      const result = ceremony();
      ceremonies += 1;
      try {
        return await observe(await result);
      } finally {
        settled += 1;
      }
    };
    navigator.credentials.create = options => invoke(() => create(options));
    navigator.credentials.get = options => invoke(() => get(options));
    Reflect.set(window, '__platformCalls', () => ceremonies);
    Reflect.set(window, '__platformSettled', () => settled);
  });
}

async function request(
  page: Page,
  payload: { type: string; nonce?: string; command?: { action: 'state' } }
): Promise<unknown> {
  return page.evaluate(
    data =>
      new Promise<unknown>((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'INTERCOM' });
        const timeout = setTimeout(() => {
          port.disconnect();
          reject(new Error('Extension request timed out'));
        }, 30_000);
        port.onMessage.addListener((message: unknown) => {
          if (!message || typeof message !== 'object' || Reflect.get(message, 'reqId') !== 1) return;
          const type: unknown = Reflect.get(message, 'type');
          if (type !== 'INTERCOM_RESPONSE' && type !== 'INTERCOM_ERROR') return;
          clearTimeout(timeout);
          port.disconnect();
          if (type === 'INTERCOM_ERROR') reject(new Error('Extension request failed'));
          else resolve(Reflect.get(message, 'data'));
        });
        port.postMessage({ type: 'INTERCOM_REQUEST', reqId: 1, data });
      }),
    payload
  );
}

async function authenticator(page: Page, hasPrf = true, backupEligible = false) {
  const protocol = await page.context().newCDPSession(page);
  await protocol.send('WebAuthn.enable');
  const { authenticatorId } = await protocol.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      defaultBackupEligibility: backupEligible,
      hasPrf
    }
  });
  return { protocol, authenticatorId };
}

async function restartBackend(context: BrowserContext, protocol: CDPSession, page: Page) {
  const old = context.serviceWorkers()[0];
  if (!old) throw new Error('Extension worker unavailable');
  const scriptUrl = old.url();
  let versionId = '';
  let running = '';
  let stopped = false;
  protocol.on('ServiceWorker.workerVersionUpdated', event => {
    for (const version of event.versions) {
      if (version.scriptURL !== scriptUrl) continue;
      if (!versionId && version.runningStatus === 'running') versionId = version.versionId;
      if (version.versionId === versionId) {
        running = version.runningStatus;
        if (running === 'stopped') stopped = true;
      }
    }
  });
  await protocol.send('ServiceWorker.enable');
  await expect.poll(() => versionId).not.toBe('');
  await old.evaluate(() => Reflect.set(globalThis, '__platformBeforeStop', true));
  await protocol.send('ServiceWorker.stopWorker', { versionId });
  await expect.poll(() => stopped).toBe(true);
  await page.reload();
  await expect.poll(() => running).toBe('running');
  const worker = context.serviceWorkers().find(item => item.url() === scriptUrl);
  if (!worker) throw new Error('Replacement worker unavailable');
  await expect.poll(() => worker.evaluate(() => Reflect.get(globalThis, '__platformBeforeStop'))).toBeUndefined();
  await worker.evaluate(overrideOs);
  await page.reload();
}

async function privateInput(page: Page, value: string) {
  try {
    await page.getByLabel('Password', { exact: true }).fill(value);
  } catch {
    throw new Error('Could not fill the private acceptance input');
  }
}

async function snapshot(page: Page, info: TestInfo, name: string) {
  const file = info.outputPath(`profile-settings-passkey-${name}.png`);
  const png = await page.screenshot({ scale: 'css' });
  await writeFile(
    file,
    await sharp(png).resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).toBuffer()
  );
  await info.attach(name, { path: file, contentType: 'image/png' });
}

async function setup(context: BrowserContext, id: string) {
  await simulateEligibleOs(context);
  const onboarding = await context.newPage();
  try {
    await completeSeedImportOnboarding(onboarding, `chrome-extension://${id}/fullpage.html`, 60_000);
  } catch {
    throw new Error('Disposable Guardian acceptance wallet did not finish setup');
  }
  const page = await context.newPage();
  await page.setViewportSize({ width: 360, height: 800 });
  // Drive the real side-panel entry document in a test tab, not native Chrome sidebar chrome.
  await page.goto(`chrome-extension://${id}/sidepanel.html#/settings/passkey-unlock`);
  const evidence = async () => {
    const data: unknown = Reflect.get(navigator, 'userAgentData');
    const getValues: unknown = data && typeof data === 'object' ? Reflect.get(data, 'getHighEntropyValues') : null;
    const values: unknown = typeof getValues === 'function' ? await getValues.call(data, ['platformVersion']) : null;
    const stored = await chrome.storage.local.get('vault_key_password');
    return {
      brands: data && typeof data === 'object' ? Reflect.get(data, 'brands') : null,
      values,
      extensionRuntime: Boolean(chrome.runtime.id),
      scheme: location.protocol,
      protectionApi: typeof Reflect.get(chrome.storage.local, 'setAccessLevel'),
      originalUaDataStable: Reflect.get(globalThis, '__platformOriginalUaDataStable'),
      passwordPresent: typeof stored.vault_key_password === 'string' && stored.vault_key_password.length > 0
    };
  };
  const worker = context.serviceWorkers()[0];
  const response = await request(page, { type: 'PLATFORM_UNLOCK_REQUEST', command: { action: 'state' } });
  const result: unknown = response && typeof response === 'object' ? Reflect.get(response, 'result') : null;
  const state: unknown = result && typeof result === 'object' ? Reflect.get(result, 'state') : null;
  const diagnostic = JSON.stringify(
    {
      page: await page.evaluate(evidence),
      worker: worker ? await worker.evaluate(evidence) : null,
      state:
        state && typeof state === 'object'
          ? { available: Reflect.get(state, 'available'), hasPassword: Reflect.get(state, 'hasPassword') }
          : null
    },
    null,
    2
  );
  const diagnosticPath = test.info().outputPath('platform-boundaries.json');
  await writeFile(diagnosticPath, diagnostic);
  await test.info().attach('platform-boundaries', { contentType: 'application/json', path: diagnosticPath });
  await expect(page.getByTestId('passkey-unlock-settings')).toBeVisible({ timeout: 30_000 });
  return page;
}

async function privacy(page: Page, messages: string[]) {
  const observations = prfObservations.get(page.context());
  if (!observations) throw new Error('Private PRF observations unavailable');
  const persisted = await page.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  const containsPrf = (text: string) => [...observations.secrets].some(secret => text.includes(secret));
  expect(containsPrf(persisted) || messages.some(containsPrf), 'No PRF output may enter storage or logs').toBe(false);
  return containsPrf;
}

async function ceremonyCounts(page: Page) {
  return page.evaluate(() => {
    const calls: unknown = Reflect.get(window, '__platformCalls');
    const completed: unknown = Reflect.get(window, '__platformSettled');
    if (typeof calls !== 'function' || typeof completed !== 'function')
      throw new Error('Ceremony observer unavailable');
    const started: unknown = calls();
    const settled: unknown = completed();
    if (typeof started !== 'number' || typeof settled !== 'number') throw new Error('Invalid ceremony counts');
    return { started, settled };
  });
}

async function storedRecord(page: Page) {
  return page.evaluate(async () => {
    const values = await chrome.storage.local.get('vault_key_platform');
    const record: unknown = values.vault_key_platform;
    if (!record || typeof record !== 'object') return null;
    return {
      keys: Object.keys(record).sort(),
      version: Reflect.get(record, 'version'),
      credentialId: Reflect.get(record, 'credentialId'),
      wrappedKey: Reflect.get(record, 'wrappedKey')
    };
  });
}

test('real Chrome virtual PRF enrolls, unlocks after reload and preserves password fallback', async ({
  extensionContext,
  extensionId
}, info) => {
  test.setTimeout(360_000);
  const page = await setup(extensionContext, extensionId);
  const observations = prfObservations.get(extensionContext);
  if (!observations) throw new Error('Private PRF observer unavailable');
  const messages: string[] = [];
  page.on('console', message => messages.push(message.text()));
  const { protocol, authenticatorId } = await authenticator(page);
  let assertions = 0;
  protocol.on('WebAuthn.credentialAsserted', () => {
    assertions += 1;
  });
  const passwordBefore: unknown = await page.evaluate(
    async () => (await chrome.storage.local.get('vault_key_password')).vault_key_password
  );
  await privateInput(page, 'Password123!');
  await page.getByRole('button', { name: 'Enable passkey unlock', exact: true }).click();
  await expect(page.getByText('Passkey unlock is enabled for this wallet.')).toBeVisible({ timeout: 60_000 });
  expect(observations.count).toBe(1);
  const record = await storedRecord(page);
  expect(record?.keys).toEqual(['backupEligible', 'credentialId', 'prfSalt', 'version', 'wrappedKey']);
  expect(record?.version).toBe(1);
  expect(typeof record?.credentialId).toBe('string');
  expect(typeof record?.wrappedKey).toBe('string');
  expect(
    await page.evaluate(async () => (await chrome.storage.local.get('vault_key_password')).vault_key_password)
  ).toEqual(passwordBefore);
  for (const shell of ['popup.html', 'fullpage.html']) {
    const outside = await extensionContext.newPage();
    await outside.setViewportSize({ width: shell === 'popup.html' ? 360 : 640, height: 640 });
    if (shell === 'popup.html')
      await outside.addInitScript(() => {
        const getViews = chrome.extension.getViews.bind(chrome.extension);
        chrome.extension.getViews = (properties?: chrome.extension.FetchProperties) =>
          properties?.type === 'popup' ? [window] : getViews(properties);
      });
    await outside.goto(`chrome-extension://${extensionId}/${shell}#/settings/passkey-unlock`);
    await expect
      .poll(() => outside.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await expect(outside.getByText('Passkey unlock is enabled for this wallet.')).toBeVisible();
    await expect(outside.getByRole('button', { name: 'Open wallet', exact: true })).toBeVisible();
    await expect(outside.getByLabel('Password', { exact: true })).toHaveCount(0);
    expect(
      await outside.evaluate(() => {
        const calls: unknown = Reflect.get(window, '__platformCalls');
        return typeof calls === 'function' ? calls() : -1;
      })
    ).toBe(0);
    for (const theme of ['light', 'dark']) {
      await outside.emulateMedia({ colorScheme: theme === 'dark' ? 'dark' : 'light' });
      await expect
        .poll(() => outside.evaluate(() => document.documentElement.classList.contains('dark')))
        .toBe(theme === 'dark');
      await snapshot(outside, info, `readonly-${shell}-${theme}`);
    }
    await outside.close();
  }
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme === 'dark' ? 'dark' : 'light' });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(theme === 'dark');
    await snapshot(page, info, `enabled-sidebar-${theme}`);
  }
  await privacy(page, messages);
  await request(page, { type: 'LOCK_REQUEST' });
  await expect(page.getByTestId('unlock-password')).toBeVisible();
  const confirmation = await extensionContext.newPage();
  await confirmation.setViewportSize({ width: 420, height: 640 });
  await confirmation.goto(`chrome-extension://${extensionId}/confirm.html#?id=platform-acceptance`);
  await expect(confirmation.getByRole('button', { name: 'Unlock with passkey', exact: true })).toBeVisible();
  await expect(confirmation.getByLabel('Password', { exact: true })).toBeVisible();
  expect(
    await confirmation.evaluate(() => {
      const calls: unknown = Reflect.get(window, '__platformCalls');
      return typeof calls === 'function' ? calls() : -1;
    })
  ).toBe(0);
  await snapshot(confirmation, info, 'locked-confirmation');
  await confirmation.close();
  await restartBackend(extensionContext, protocol, page);
  const priorAssertions = assertions;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Unlock with passkey', exact: true })).toBeVisible();
  expect(assertions).toBe(priorAssertions);
  await snapshot(page, info, 'locked-sidebar-dark');
  const prfsBeforeUnlock = observations.count;
  await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
  await expect(page.getByTestId('unlock-password')).toHaveCount(0, { timeout: 30_000 });
  expect(assertions).toBe(priorAssertions + 1);
  expect(observations.count).toBe(prfsBeforeUnlock + 1);
  const containsPrf = await privacy(page, messages);
  const secret = observations.secrets.values().next().value;
  if (typeof secret !== 'string') throw new Error('Private PRF observation missing');
  expect(
    containsPrf(JSON.stringify({ privateReadProbe: secret })),
    'A memory-only leaked read must be detected after unlock reload'
  ).toBe(true);

  await request(page, { type: 'LOCK_REQUEST' });
  await protocol.send('WebAuthn.setResponseOverrideBits', { authenticatorId, isBadUV: true });
  await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 70_000 });
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await protocol.send('WebAuthn.setResponseOverrideBits', { authenticatorId });
  await privateInput(page, 'Password123!');
  await page.locator('#unlock-password').press('Enter');
  await expect(page.getByTestId('unlock-password')).toHaveCount(0, { timeout: 30_000 });
  await privacy(page, messages);

  await request(page, { type: 'LOCK_REQUEST' });
  await protocol.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false });
  const beforeCancellation = await ceremonyCounts(page);
  await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
  await expect.poll(async () => (await ceremonyCounts(page)).started).toBe(beforeCancellation.started + 1);
  expect((await ceremonyCounts(page)).settled).toBe(beforeCancellation.settled);
  await page.reload();
  await expect(page.getByTestId('unlock-password')).toBeVisible();
  await protocol.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true });
  await expect(page.getByTestId('unlock-password')).toBeVisible();
  await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
  await expect(page.getByTestId('unlock-password')).toHaveCount(0, { timeout: 30_000 });

  await page.evaluate(async () => {
    const values = await chrome.storage.local.get('vault_key_platform');
    const current: unknown = values.vault_key_platform;
    if (!current || typeof current !== 'object') throw new Error('Acceptance protector unavailable');
    await chrome.storage.local.set({ vault_key_platform: { ...current, wrappedKey: 'A'.repeat(80) } });
  });
  await request(page, { type: 'LOCK_REQUEST' });
  await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await privateInput(page, 'Password123!');
  await page.locator('#unlock-password').press('Enter');
  await expect(page.getByTestId('unlock-password')).toHaveCount(0, { timeout: 30_000 });

  await page.goto(`chrome-extension://${extensionId}/sidepanel.html#/settings/passkey-unlock`);
  await page.getByRole('button', { name: 'Replace passkey', exact: true }).click();
  await privateInput(page, 'Password123!');
  await page.getByRole('button', { name: 'Replace passkey', exact: true }).click();
  await expect
    .poll(
      async () => {
        const current = await storedRecord(page);
        return typeof current?.credentialId === 'string' && current.credentialId !== record?.credentialId;
      },
      { timeout: 60_000 }
    )
    .toBe(true);
  await expect(page.getByText('Your provider reports that this passkey cannot be backed up.')).toBeVisible();
  await page.getByRole('button', { name: 'Remove passkey unlock', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove passkey unlock', exact: true }).click();
  await expect.poll(() => storedRecord(page)).toBeNull();
  expect(
    await page.evaluate(async () => (await chrome.storage.local.get('vault_key_password')).vault_key_password)
  ).toEqual(passwordBefore);
  await privacy(page, messages);
});

test('browser capability true does not enroll a virtual provider without actual PRF', async ({
  extensionContext,
  extensionId
}) => {
  test.setTimeout(240_000);
  const page = await setup(extensionContext, extensionId);
  const messages: string[] = [];
  page.on('console', message => messages.push(message.text()));
  await authenticator(page, false);
  const browserPrf = await page.evaluate(async () => {
    const getCapabilities: unknown = Reflect.get(PublicKeyCredential, 'getClientCapabilities');
    if (typeof getCapabilities !== 'function') throw new Error('Browser capability API unavailable');
    const values: unknown = await getCapabilities.call(PublicKeyCredential);
    return values && typeof values === 'object' && Reflect.get(values, 'extension:prf') === true;
  });
  expect(browserPrf).toBe(true);
  await privateInput(page, 'Password123!');
  await page.getByRole('button', { name: 'Enable passkey unlock', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 70_000 });
  expect(await storedRecord(page)).toBeNull();
  expect(prfObservations.get(extensionContext)?.count).toBe(0);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await privacy(page, messages);
});

test('an authorized reset during a native ceremony cannot publish a new protector', async ({
  extensionContext,
  extensionId
}) => {
  test.setTimeout(240_000);
  const page = await setup(extensionContext, extensionId);
  const messages: string[] = [];
  page.on('console', message => messages.push(message.text()));
  await page.evaluate(() => {
    const intercom: unknown = Reflect.get(window, '__TEST_INTERCOM__');
    if (!intercom || typeof intercom !== 'object') throw new Error('Existing test intercom unavailable');
    const send: unknown = Reflect.get(intercom, 'request');
    if (typeof send !== 'function') throw new Error('Existing test request unavailable');
    let abandoned = 0;
    const observe = async (payload: unknown, ...options: unknown[]) => {
      const command: unknown = payload && typeof payload === 'object' ? Reflect.get(payload, 'command') : null;
      const isAbandon =
        payload &&
        typeof payload === 'object' &&
        Reflect.get(payload, 'type') === 'PLATFORM_UNLOCK_REQUEST' &&
        command &&
        typeof command === 'object' &&
        Reflect.get(command, 'action') === 'abandon';
      try {
        return await send.call(intercom, payload, ...options);
      } finally {
        if (isAbandon) abandoned += 1;
      }
    };
    if (!Reflect.set(intercom, 'request', observe)) throw new Error('Test request observer unavailable');
    Reflect.set(window, '__platformAbandoned', () => abandoned);
  });
  const { protocol, authenticatorId } = await authenticator(page);
  await protocol.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false });
  await privateInput(page, 'Password123!');
  const beforeReset = await ceremonyCounts(page);
  await page.getByRole('button', { name: 'Enable passkey unlock', exact: true }).click();
  await expect.poll(async () => (await ceremonyCounts(page)).started).toBe(beforeReset.started + 1);
  expect((await ceremonyCounts(page)).settled).toBe(beforeReset.settled);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const values = await chrome.storage.local.get('platform_credentials_to_signal');
        const ledger: unknown = values.platform_credentials_to_signal;
        const pending: unknown = ledger && typeof ledger === 'object' ? Reflect.get(ledger, 'pending') : null;
        return Array.isArray(pending) && pending.length === 1;
      })
    )
    .toBe(true);
  const nonce = await page.evaluate(async () => {
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const opened = indexedDB.open('miden-platform-unlock-reset');
    opened.onupgradeneeded = () => opened.result.createObjectStore('authorization', { keyPath: 'id' });
    await new Promise<void>((resolve, reject) => {
      opened.onerror = () => reject(new Error('Could not open reset authorization'));
      opened.onsuccess = () => {
        const db = opened.result;
        const tx = db.transaction('authorization', 'readwrite');
        tx.objectStore('authorization').put({
          id: 'reset',
          version: 1,
          phase: 'pending',
          nonce,
          options: { keepEndpointOverride: true }
        });
        tx.onerror = () => {
          db.close();
          reject(new Error('Could not authorize acceptance reset'));
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
    return nonce;
  });
  await request(page, { type: 'PLATFORM_RESET_REQUEST', nonce });
  await protocol.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true });
  await expect.poll(async () => (await ceremonyCounts(page)).settled).toBe(beforeReset.settled + 1);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const completed: unknown = Reflect.get(window, '__platformAbandoned');
        if (typeof completed !== 'function') throw new Error('Abandonment observer unavailable');
        return completed();
      })
    )
    .toBe(1);
  await expect.poll(() => storedRecord(page)).toBeNull();
  expect(
    await page.evaluate(
      async () => (await chrome.storage.local.get('vault_key_password')).vault_key_password === undefined
    )
  ).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const values = await chrome.storage.local.get('platform_credentials_to_signal');
        const ledger: unknown = values.platform_credentials_to_signal;
        const pending: unknown = ledger && typeof ledger === 'object' ? Reflect.get(ledger, 'pending') : null;
        return Array.isArray(pending) && pending.length === 0;
      })
    )
    .toBe(true);
  await privacy(page, messages);
});

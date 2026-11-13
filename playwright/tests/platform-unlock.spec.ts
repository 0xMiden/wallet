import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

import { completeSeedImportOnboarding } from '../e2e/helpers/dapp-confirm';
import { expect, test } from '../fixtures/extension';

// Only cleared Settings/Unlock screens are retained, never private inputs or ceremony results.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

async function simulateEligibleOs(context: BrowserContext) {
  const overrideOs = () => {
    const data: unknown = Reflect.get(navigator, 'userAgentData');
    if (!data || typeof data !== 'object') throw new Error('Browser UA-CH unavailable');
    const getValues: unknown = Reflect.get(data, 'getHighEntropyValues');
    if (typeof getValues !== 'function') throw new Error('Browser UA-CH versions unavailable');
    Object.defineProperty(data, 'getHighEntropyValues', {
      value: async (hints: string[]) => {
        const original: unknown = await getValues.call(data, hints);
        if (!original || typeof original !== 'object') throw new Error('Invalid browser UA-CH evidence');
        // Preserve the real browser brand/version. Only OS evidence is simulated on Linux CI.
        return { ...original, platform: 'Windows', platformVersion: '13.0.0' };
      }
    });
  };
  await context.addInitScript(overrideOs);
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(overrideOs);
  await context.addInitScript(() => {
    const secrets = new Set<string>();
    const observe = (credential: Credential | null) => {
      if (credential instanceof PublicKeyCredential) {
        const extensions: unknown = credential.getClientExtensionResults();
        const prf: unknown = extensions && typeof extensions === 'object' ? Reflect.get(extensions, 'prf') : null;
        const results: unknown = prf && typeof prf === 'object' ? Reflect.get(prf, 'results') : null;
        const first: unknown = results && typeof results === 'object' ? Reflect.get(results, 'first') : null;
        if (first instanceof ArrayBuffer) {
          const bytes = new Uint8Array(first);
          const base64 = btoa(String.fromCharCode(...bytes));
          secrets.add(base64);
          secrets.add(base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
          secrets.add(Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''));
        }
      }
      return credential;
    };
    const create = navigator.credentials.create.bind(navigator.credentials);
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.create = async options => observe(await create(options));
    navigator.credentials.get = async options => observe(await get(options));
    Reflect.set(window, '__platformLeaks', async (messages: string[]) => {
      const persisted = JSON.stringify(await chrome.storage.local.get(null));
      return [...secrets].some(
        secret => persisted.includes(secret) || messages.some(message => message.includes(secret))
      );
    });
  });
}

async function request(page: Page, payload: { type: string; nonce?: string }): Promise<void> {
  await page.evaluate(
    data =>
      new Promise<void>((resolve, reject) => {
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
          else resolve();
        });
        port.postMessage({ type: 'INTERCOM_REQUEST', reqId: 1, data });
      }),
    payload
  );
}

async function authenticator(page: Page, hasPrf = true) {
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
      hasPrf
    }
  });
  return { protocol, authenticatorId };
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
  await expect(page.getByTestId('passkey-unlock-settings')).toBeVisible({ timeout: 30_000 });
  return page;
}

async function privacy(page: Page, messages: string[]) {
  const leaks = await page.evaluate(async lines => {
    const check: unknown = Reflect.get(window, '__platformLeaks');
    if (typeof check !== 'function') throw new Error('Privacy instrumentation unavailable');
    return Boolean(await check(lines));
  }, messages);
  expect(leaks, 'No PRF output may enter durable storage or console messages').toBe(false);
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
  const record = await storedRecord(page);
  expect(record?.keys).toEqual(['backupEligible', 'credentialId', 'prfSalt', 'version', 'wrappedKey']);
  expect(record?.version).toBe(1);
  expect(typeof record?.credentialId).toBe('string');
  expect(typeof record?.wrappedKey).toBe('string');
  expect(
    await page.evaluate(async () => (await chrome.storage.local.get('vault_key_password')).vault_key_password)
  ).toEqual(passwordBefore);
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
  const priorAssertions = assertions;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Unlock with passkey', exact: true })).toBeVisible();
  expect(assertions).toBe(priorAssertions);
  await snapshot(page, info, 'locked-sidebar-dark');
  await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
  await expect(page.getByTestId('unlock-password')).toHaveCount(0, { timeout: 30_000 });
  expect(assertions).toBeGreaterThan(priorAssertions);
  await privacy(page, messages);

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
});

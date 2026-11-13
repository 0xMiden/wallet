import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { isRecord } from '../../../src/lib/update/guards';
import { TEST_CONSUME_AUTHORIZATION_KEY as KEY } from '../../../src/lib/miden/sdk/test-consume-authorization';
import { awaitMainnetLoopAuthorization } from './mainnet-loop-authorization';

export interface MainnetConsumeAuthority {
  nonce: string;
  sha256: string;
  canonicalSha256: string;
  requestCanonicalSha256?: string;
  expiresAt?: number;
}
export interface MainnetConsumeHandle {
  nonce: string;
  accountId: string;
  noteId: string;
  canonicalSha256: string;
}
export async function blockMainnetConsumeAuthorization(page: Pick<Page, 'evaluate'>): Promise<void> {
  await page.evaluate(async key => {
    const requiredKey = `${key}_required`;
    const stored = await chrome.storage.local.get([key, requiredKey]);
    const marker = stored[requiredKey];
    const blocked = marker && typeof marker === 'object' && !Array.isArray(marker) &&
      Object.keys(marker).length === 1 && marker.status === 'blocked';
    if (stored[key] !== undefined || (marker !== undefined && !blocked))
      throw new Error('Unresolved existing native authorization');
    await chrome.storage.local.set({ [requiredKey]: { status: 'blocked' } });
  }, KEY);
}

export async function armMainnetConsumeAuthorization(
  page: Pick<Page, 'evaluate'>,
  scope: Omit<MainnetConsumeHandle, 'nonce'>
): Promise<MainnetConsumeHandle> {
  if (
    !/^0x[0-9a-f]{30}$/.test(scope.accountId) ||
    !/^0x[0-9a-f]{64}$/.test(scope.noteId) ||
    !/^[0-9a-f]{64}$/.test(scope.canonicalSha256)
  )
    throw new Error('Invalid native consume authorization scope');
  const handle = { ...scope, nonce: randomUUID() };
  await page.evaluate(
    async ({ key, handle }) => {
      const requiredKey = `${key}_required`;
      const stored = await chrome.storage.local.get([key, requiredKey]);
      const marker = stored[requiredKey];
      const blocked = marker && typeof marker === 'object' && !Array.isArray(marker) &&
        Object.keys(marker).length === 1 && marker.status === 'blocked';
      if (stored[key] !== undefined || (marker !== undefined && !blocked))
        throw new Error('Unresolved existing native authorization');
      await chrome.storage.local.set({
        [key]: { ...handle, status: 'armed' },
        [requiredKey]: { accountId: handle.accountId, nonce: handle.nonce }
      });
    },
    { key: KEY, handle }
  );
  return handle;
}

function assertScope(value: unknown, handle: MainnetConsumeHandle): Record<string, unknown> {
  if (
    !isRecord(value) ||
    value.nonce !== handle.nonce ||
    value.accountId !== handle.accountId ||
    value.noteId !== handle.noteId ||
    value.canonicalSha256 !== handle.canonicalSha256
  )
    throw new Error('Native consume request authorization scope changed');
  return value;
}

export async function releaseMainnetConsumeAuthorization(
  page: Page,
  handle: MainnetConsumeHandle,
  options: {
    checkpointPath: string;
    gatePath: string;
    signal: AbortSignal;
    persist: (authority: MainnetConsumeAuthority) => Promise<void>;
  }
): Promise<void> {
  const expected = { ...handle };
  const read = () => page.evaluate(async key => (await chrome.storage.local.get(key))[key], KEY);
  let authority: MainnetConsumeAuthority | undefined;
  for (let poll = 0; poll < 480; poll++) {
    if (options.signal.aborted) throw new Error('Native consume authorization aborted');
    const value = assertScope(await read(), expected);
    if (value.status === 'waiting') {
      if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256))
        throw new Error('Invalid actual native request digest');
      authority = { nonce: expected.nonce, sha256: value.sha256, canonicalSha256: expected.canonicalSha256 };
      if (value.requestCanonicalSha256 !== undefined || value.expiresAt !== undefined) {
        if (
          typeof value.requestCanonicalSha256 !== 'string' ||
          !/^[0-9a-f]{64}$/.test(value.requestCanonicalSha256) ||
          typeof value.expiresAt !== 'number' ||
          !Number.isSafeInteger(value.expiresAt) ||
          Date.now() >= value.expiresAt
        )
          throw new Error('Invalid or expired final Guardian consume authority');
        authority.requestCanonicalSha256 = value.requestCanonicalSha256;
        authority.expiresAt = value.expiresAt;
      }
      break;
    }
    if (value.status !== 'armed') throw new Error('Native consume authorization is already used or blocked');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!authority) throw new Error('Actual native consume request timed out');
  await options.persist(authority);
  await awaitMainnetLoopAuthorization(options.checkpointPath, options.gatePath, options.signal);
  if (options.signal.aborted) throw new Error('Native consume authorization aborted during upload');
  await page.evaluate(
    async ({ key, expected }) => {
      const value = (await chrome.storage.local.get(key))[key];
      if (
        !value ||
        value.status !== 'waiting' ||
        Object.entries(expected).some(([name, entry]) => value[name] !== entry) ||
        (expected.expiresAt !== undefined && Date.now() >= expected.expiresAt)
      )
        throw new Error('Native consume authorization scope changed after upload');
      await chrome.storage.local.set({ [key]: { ...expected, status: 'released' } });
    },
    { key: KEY, expected: { ...expected, ...authority } }
  );
}

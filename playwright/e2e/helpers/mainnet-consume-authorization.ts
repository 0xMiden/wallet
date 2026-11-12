import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { isRecord } from '../../../src/lib/update/guards';
import { TEST_CONSUME_AUTHORIZATION_KEY as KEY } from '../../../src/lib/miden/sdk/test-consume-authorization';
import { awaitMainnetLoopAuthorization } from './mainnet-loop-authorization';

export interface MainnetConsumeAuthority {
  nonce: string;
  sha256: string;
  canonicalSha256: string;
}
export interface MainnetConsumeHandle {
  nonce: string;
  accountId: string;
  noteId: string;
  canonicalSha256: string;
}
export async function armMainnetConsumeAuthorization(
  page: Page,
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
      if ((await chrome.storage.local.get(key))[key] !== undefined)
        throw new Error('Unresolved existing native authorization');
      await chrome.storage.local.set({ [key]: { ...handle, status: 'armed' } });
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
        value.nonce !== expected.nonce ||
        value.accountId !== expected.accountId ||
        value.noteId !== expected.noteId ||
        value.canonicalSha256 !== expected.canonicalSha256 ||
        value.sha256 !== expected.sha256
      )
        throw new Error('Native consume authorization scope changed after upload');
      await chrome.storage.local.set({ [key]: { ...expected, status: 'released' } });
    },
    { key: KEY, expected: { ...expected, sha256: authority.sha256 } }
  );
}

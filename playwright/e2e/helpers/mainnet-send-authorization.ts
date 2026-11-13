import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { isRecord } from '../../../src/lib/update/guards';
import type { TestMainnetEpochScope, TestMainnetSendScope, TestMainnetSwapScope } from '../../../src/lib/miden/sdk/test-send-request';
import { TEST_SEND_AUTHORIZATION_KEY as KEY } from '../../../src/lib/miden/sdk/test-send-authorization';
import { awaitMainnetLoopAuthorization } from './mainnet-loop-authorization';

export type MainnetSendHandle = (TestMainnetSendScope | TestMainnetSwapScope | TestMainnetEpochScope) & {
  nonce: string;
  expiresAt: number;
};
export interface MainnetSendAuthority {
  nonce: string;
  noteId: string;
  sha256: string;
  canonicalSha256: string;
  orderId?: string;
}

export async function armMainnetSendAuthorization(
  page: Pick<Page, 'evaluate'>,
  scope: (TestMainnetSendScope | TestMainnetSwapScope | TestMainnetEpochScope) & { expiresAt: number }
): Promise<MainnetSendHandle> {
  if (
    ![scope.accountId, scope.faucetId].every(id => /^0x[0-9a-f]{30}$/.test(id)) ||
    ('kind' in scope
      ? scope.kind === 'epoch'
        ? !/^0x[0-9a-f]{64}$/.test(scope.noteId)
        : scope.kind !== 'swap' ||
          !/^0x[0-9a-f]{30}$/.test(scope.requestedFaucetId) ||
          scope.requestedFaucetId === scope.faucetId ||
          !/^[1-9]\d{0,18}$/.test(scope.requestedAmount)
      : !/^0x[0-9a-f]{30}$/.test(scope.recipientId) || scope.accountId === scope.recipientId) ||
    !/^[1-9]\d{0,18}$/.test(scope.amount) ||
    !Number.isSafeInteger(scope.expiresAt) ||
    scope.expiresAt <= Date.now() ||
    scope.expiresAt > Date.now() + 600_000
  )
    throw new Error('Invalid native send authorization scope');
  const handle = { ...scope, nonce: randomUUID() };
  await page.evaluate(
    async ({ key, handle }) => {
      const requiredKey = `${key}_required`;
      const stored = await chrome.storage.local.get([key, requiredKey]);
      if (stored[key] !== undefined || stored[requiredKey] !== undefined)
        throw new Error('Unresolved existing native send authority');
      await chrome.storage.local.set({
        [key]: { ...handle, status: 'armed' },
        [requiredKey]: { accountId: handle.accountId, nonce: handle.nonce }
      });
    },
    { key: KEY, handle }
  );
  return handle;
}

export async function releaseMainnetSendAuthorization(
  page: Pick<Page, 'evaluate'>,
  handle: MainnetSendHandle,
  options: {
    checkpointPath: string;
    gatePath: string;
    signal: AbortSignal;
    persist: (authority: MainnetSendAuthority) => Promise<void>;
  }
): Promise<MainnetSendAuthority> {
  const expected = { ...handle };
  let authority: MainnetSendAuthority | undefined;
  for (let poll = 0; poll < 480; poll++) {
    if (options.signal.aborted || Date.now() >= expected.expiresAt)
      throw new Error('Native send authorization aborted or expired');
    const value: unknown = await page.evaluate(async key => (await chrome.storage.local.get(key))[key], KEY);
    if (!isRecord(value) || Object.entries(expected).some(([key, entry]) => value[key] !== entry))
      throw new Error('Native send request scope changed');
    if (value.status === 'waiting') {
      if (
        typeof value.noteId !== 'string' ||
        !/^0x[0-9a-f]{64}$/.test(value.noteId) ||
        typeof value.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(value.sha256) ||
        typeof value.canonicalSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(value.canonicalSha256)
      )
        throw new Error('Invalid actual native send fingerprints');
      authority = {
        nonce: expected.nonce,
        noteId: value.noteId,
        sha256: value.sha256,
        canonicalSha256: value.canonicalSha256
      };
      if ('kind' in expected && expected.kind === 'swap') {
        if (typeof value.orderId !== 'string' || !/^\d{1,20}$/.test(value.orderId))
          throw new Error('Missing actual PSWAP order identity');
        authority.orderId = value.orderId;
      }
      break;
    }
    if (value.status !== 'armed') throw new Error('Native send authorization is already used or blocked');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!authority) throw new Error('Actual native send request timed out');
  await options.persist(authority);
  await awaitMainnetLoopAuthorization(options.checkpointPath, options.gatePath, options.signal);
  if (options.signal.aborted || Date.now() >= expected.expiresAt)
    throw new Error('Native send authorization aborted or expired during upload');
  await page.evaluate(
    async ({ key, expected }) => {
      const value = (await chrome.storage.local.get(key))[key];
      if (
        !value ||
        value.status !== 'waiting' ||
        Date.now() >= expected.expiresAt ||
        Object.entries(expected).some(([name, entry]) => value[name] !== entry)
      )
        throw new Error('Native send authority changed after its exact upload');
      await chrome.storage.local.set({ [key]: { ...expected, status: 'released' } });
    },
    { key: KEY, expected: { ...expected, ...authority } }
  );
  return authority;
}

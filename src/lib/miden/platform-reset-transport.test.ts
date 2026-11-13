/** @jest-environment node */
import Dexie from 'dexie';

import { PLATFORM_RESET_STORAGE_KEY } from 'lib/platform-auth/types';
import { WalletMessageType, type WalletRequest, type WalletResponse } from 'lib/shared/types';

import { requestExtensionReset } from './platform-reset';

const mockData = new Map<string, unknown>();
const mockRequest = jest.fn<Promise<WalletResponse>, [WalletRequest]>();
jest.mock('lib/miden/front/client', () => ({ request: (req: WalletRequest) => mockRequest(req) }));
jest.mock('lib/platform', () => ({ hasExtensionRuntime: () => true }));
jest.mock('lib/platform/storage-adapter', () => ({ getStorageProvider: () => ({
  set: async (values: Record<string, unknown>) => { for (const [key,value] of Object.entries(values)) mockData.set(key,value); }
}) }));

beforeEach(async () => {
  await Dexie.delete('miden-platform-unlock-reset');
  mockData.clear(); mockRequest.mockReset();
  Object.defineProperty(globalThis, 'location', { configurable: true,
    value: new URL('chrome-extension://test-extension-id/options.html') });
});
afterEach(async () => {
  jest.useRealTimers();
  await Dexie.delete('miden-platform-unlock-reset');
  Reflect.deleteProperty(globalThis, 'location');
});

it('sends only the protected nonce after persisting the complete reset intent', async () => {
  mockRequest.mockResolvedValueOnce({ type: WalletMessageType.PlatformResetResponse });
  await requestExtensionReset({ keepEndpointOverride: false });
  const sent = mockRequest.mock.calls[0]?.[0];
  expect(sent).toEqual({ type: WalletMessageType.PlatformResetRequest, nonce: expect.any(String) });
  if (sent?.type !== WalletMessageType.PlatformResetRequest) throw new Error('No reset request');
  expect(mockData.get(PLATFORM_RESET_STORAGE_KEY)).toEqual({ nonce: sent.nonce });
  const db = new Dexie('miden-platform-unlock-reset');
  try {
    await db.open();
    expect(await db.table('authorization').get('reset')).toMatchObject({ phase: 'pending',
      nonce: sent.nonce, options: { keepEndpointOverride: false } });
  } finally { db.close(); }
});
it('returns after a bounded unanswered worker while retaining restart authorization', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  let entered: () => void = () => undefined;
  const sent = new Promise<void>(resolve => { entered = resolve; });
  mockRequest.mockImplementationOnce(() => { entered(); return new Promise<WalletResponse>(() => undefined); });
  const resetting = requestExtensionReset({ keepEndpointOverride: true });
  await Promise.race([sent, resetting.catch(() => undefined)]);
  await jest.advanceTimersByTimeAsync(3000);
  await expect(resetting).resolves.toBeUndefined();
  expect(mockData.has(PLATFORM_RESET_STORAGE_KEY)).toBe(true);
});
it('cannot create the extension authorization from a website context', async () => {
  Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('https://example.com') });
  await expect(requestExtensionReset({ keepEndpointOverride: true })).rejects.toThrow();
  expect(await Dexie.exists('miden-platform-unlock-reset')).toBe(false);
  expect(mockRequest).not.toHaveBeenCalled();
});

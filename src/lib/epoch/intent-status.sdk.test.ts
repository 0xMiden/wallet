import { EpochIntentSDK } from '@epoch-protocol/epoch-intents-sdk';
import { createWalletClient, custom } from 'viem';
import { sepolia } from 'viem/chains';

import { EPOCH_INTENT_STATUS_TIMEOUT_MS, readEpochIntentStatus } from './intent-status';

const OWNER = '0x1111111111111111111111111111111111111111';
const API_BASE = 'https://allocator.test';
const originalFetch = globalThis.fetch;

afterEach(() => {
  jest.useRealTimers();
  Object.defineProperty(globalThis, 'fetch', { value: originalFetch, writable: true, configurable: true });
});

// The timeout helper's own tests mock the reader; this one runs the Epoch SDK with the patch that forwards the signal.
it('aborts the request the patched Epoch SDK sends when the status read times out', async () => {
  jest.useFakeTimers();
  const requests: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
  Object.defineProperty(globalThis, 'fetch', {
    value: jest.fn((url: string, init?: RequestInit) => {
      requests.push({ url, signal: init?.signal });
      return new Promise<Response>(() => {});
    }),
    writable: true,
    configurable: true
  });
  const sdk = new EpochIntentSDK({
    apiBaseUrl: API_BASE,
    walletClient: createWalletClient({ chain: sepolia, transport: custom({ request: async () => null }) })
  });

  const read = readEpochIntentStatus(sdk, OWNER, '7').catch((error: unknown) => error);
  await jest.advanceTimersByTimeAsync(0);
  expect(requests.map(request => request.url)).toEqual([`${API_BASE}/intentStatus/${OWNER}/7`]);
  expect(requests[0]?.signal?.aborted).toBe(false);

  await jest.advanceTimersByTimeAsync(EPOCH_INTENT_STATUS_TIMEOUT_MS);
  await read;
  expect(requests[0]?.signal?.aborted).toBe(true);
});

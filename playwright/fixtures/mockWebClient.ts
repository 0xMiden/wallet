import 'fake-indexeddb/auto';

import { test as base } from '@playwright/test';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

function ensureFileFetchSupport() {
  const originalFetch = globalThis.fetch;
  if (!originalFetch) {
    return;
  }

  const patched = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
    if (url.protocol === 'file:') {
      const buffer = await fs.readFile(fileURLToPath(url));
      return new Response(buffer, {
        headers: { 'Content-Type': 'application/wasm' }
      });
    }
    return originalFetch(input as any, init);
  };

  globalThis.fetch = patched as any;
}

type Fixtures = {
  sdk: Awaited<typeof import('@miden-sdk/miden-sdk')>;
  mockClient: any;
};

export const test = base.extend<Fixtures>({
  sdk: async ({}, use) => {
    ensureFileFetchSupport();
    const sdk = await import('@miden-sdk/miden-sdk');
    await use(sdk as any);
  },
  mockClient: async ({ sdk }: any, use: any) => {
    const client = await sdk.MidenClient.createMock();
    await use(client);
    client.terminate();
  }
});

export const expect = test.expect;

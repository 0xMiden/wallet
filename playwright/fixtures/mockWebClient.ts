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
  mockWebClient: any;
};

export const test = base.extend<Fixtures>({
  sdk: async ({}, use) => {
    ensureFileFetchSupport();
    const sdk = await import('@miden-sdk/miden-sdk');
    await use(sdk as any);
  },
  mockWebClient: async ({ sdk }: any, use: any) => {
    const client = await sdk.MockWebClient.createClient();
    await use(client);
    // 0.13.3 added a Proxy-based method classifier that throws on any
    // method not listed in SYNC / WRITE / READ sets — including the
    // wasm-bindgen destructor `free`. Reach for the underlying
    // wasmWebClient directly to bypass the classifier. Safe to no-op
    // if the field isn't there (non-Proxy builds or future SDKs).
    const inner = (client as any).wasmWebClient;
    if (inner && typeof inner.free === 'function') {
      inner.free();
    }
  }
});

export const expect = test.expect;

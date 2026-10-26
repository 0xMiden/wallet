/**
 * @jest-environment node
 */
import type { BrowserContext, Route } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { request } from 'playwright-core';

import { installTestDapp, type DappServer } from './test-dapp-server';

it.each([
  {
    pathname: '/client.wasm',
    status: 206,
    contentType: 'application/wasm',
    body: Buffer.alloc(32_768, 0xab)
  },
  {
    pathname: '/missing.js',
    status: 404,
    contentType: 'text/plain; charset=utf-8',
    body: Buffer.from('no such asset')
  }
])('serves $pathname without placing asset bytes in traced fulfilment parameters', async fixture => {
  const api = await request.newContext();
  const context = new EventEmitter();
  let handler: ((route: Route) => Promise<void>) | undefined;
  Object.assign(context, {
    request: api,
    route: async (_pattern: string, next: (route: Route) => Promise<void>) => {
      handler = next;
    }
  });
  const server: DappServer = {
    importMap: { imports: {} },
    serve: pathname => {
      expect(pathname).toBe(fixture.pathname);
      return { status: fixture.status, contentType: fixture.contentType, body: fixture.body };
    }
  };
  let inlineBytes = -1;
  let backingUrl: string | undefined;
  let delivered: { status: number; headers: Record<string, string>; body: Buffer } | undefined;
  const route = {
    request: () => ({ url: () => `http://localhost:4810${fixture.pathname}?v=1` }),
    fulfill: async (options: NonNullable<Parameters<Route['fulfill']>[0]>) => {
      inlineBytes = options.body === undefined ? 0 : Buffer.byteLength(options.body);
      if (options.response) {
        backingUrl = options.response.url();
        delivered = {
          status: options.status ?? options.response.status(),
          headers: options.headers ?? options.response.headers(),
          body: await options.response.body()
        };
      }
    }
  } as unknown as Route;
  try {
    await installTestDapp(context as unknown as BrowserContext, server, ['http://localhost:4810']);
    expect(handler).toBeDefined();
    await handler!(route);

    expect(inlineBytes).toBe(0);
    expect(delivered?.status).toBe(fixture.status);
    expect(delivered?.body).toEqual(fixture.body);
    expect(delivered?.headers).toEqual({
      'content-type': fixture.contentType,
      'content-length': String(fixture.body.length)
    });
    context.emit('close');
    await expect(api.get(backingUrl!, { timeout: 1000, maxRetries: 0 })).rejects.toThrow();
  } finally {
    context.emit('close');
    await api.dispose();
  }
});

/**
 * @jest-environment node
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { buildImportMap, createDappServer, resolvePackageRoots, serveTestDappOnLoopback } from './test-dapp-server';

const roots = resolvePackageRoots();

// A throwaway page directory, so the server is tested before the real page exists.
function pageFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-dapp-page-'));
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html><html><head><!-- test-dapp:import-map --></head><body></body></html>'
  );
  fs.writeFileSync(
    path.join(dir, 'sample.ts'),
    "import type { Outcome } from './protocol';\nexport const answer: number = 42;\nexport type Kept = Outcome<number>;\n"
  );
  return dir;
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });

const hold = (port: number, host: string): Promise<net.Server> =>
  new Promise((resolve, reject) => {
    const blocker = net.createServer();
    blocker.once('error', reject);
    blocker.listen(port, host, () => resolve(blocker));
  });

const release = (listener: net.Server): Promise<void> => new Promise(resolve => listener.close(() => resolve()));

describe('test dApp server', () => {
  it('resolves every served package, eventemitter3 from adapter-base itself', () => {
    for (const [name, root] of Object.entries(roots)) {
      const manifest: unknown = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      expect(typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'name') : undefined).toBe(name);
    }
    expect(fs.existsSync(path.join(roots.eventemitter3, 'dist', 'eventemitter3.esm.js'))).toBe(true);
  });

  it('maps every bare specifier to a file the server serves as JavaScript', () => {
    const server = createDappServer({ pageDir: pageFixture(), roots });
    const { imports } = buildImportMap(roots);
    expect(Object.keys(imports).sort()).toEqual([
      '@miden-sdk/miden-sdk',
      '@miden-sdk/miden-wallet-adapter-base',
      '@miden-sdk/miden-wallet-adapter-miden',
      'eventemitter3'
    ]);
    expect(imports['@miden-sdk/miden-sdk']).toBe('/npm/@miden-sdk/miden-sdk/dist/st/eager.js');
    expect(imports.eventemitter3).toBe('/npm/eventemitter3/dist/eventemitter3.esm.js');
    for (const url of Object.values(imports)) {
      const served = server.serve(url);
      expect({ url, status: served.status, type: served.contentType }).toEqual({
        url,
        status: 200,
        type: 'text/javascript; charset=utf-8'
      });
    }
  });

  it('injects the import map into the page shell', () => {
    const server = createDappServer({ pageDir: pageFixture(), roots });
    const html = server.serve('/').body.toString('utf8');
    expect(html).not.toContain('test-dapp:import-map');
    expect(html).toContain('<script type="importmap">');
    expect(html).toContain(
      '"@miden-sdk/miden-wallet-adapter-miden":"/npm/@miden-sdk/miden-wallet-adapter-miden/dist/index.js"'
    );
  });

  it('retries an extensionless import with .js, as the adapters need', () => {
    const server = createDappServer({ pageDir: pageFixture(), roots });
    const served = server.serve('/npm/@miden-sdk/miden-wallet-adapter-miden/dist/adapter');
    expect(served.status).toBe(200);
    expect(served.body.toString('utf8')).toContain('class MidenWalletAdapter');
  });

  it('serves the SDK wasm as application/wasm', () => {
    const server = createDappServer({ pageDir: pageFixture(), roots });
    const served = server.serve('/npm/@miden-sdk/miden-sdk/dist/st/assets/miden_client_web.wasm');
    expect(served.status).toBe(200);
    expect(served.contentType).toBe('application/wasm');
    expect(served.body.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x61, 0x73, 0x6d]));
  });

  it('refuses path traversal, raw or percent-encoded', () => {
    const server = createDappServer({ pageDir: pageFixture(), roots });
    expect(server.serve('/npm/@miden-sdk/miden-sdk/../../../package.json').status).toBe(400);
    expect(server.serve('/npm/@miden-sdk/miden-sdk/%2e%2e/%2e%2e/package.json').status).toBe(400);
  });

  it('answers 404 for an unknown package, file or route', () => {
    const server = createDappServer({ pageDir: pageFixture(), roots });
    expect(server.serve('/npm/left-pad/index.js').status).toBe(404);
    expect(server.serve('/npm/@miden-sdk/miden-sdk/dist/st/nope.js').status).toBe(404);
    expect(server.serve('/elsewhere/thing').status).toBe(404);
  });

  it('transpiles a page module per request and erases type-only imports', () => {
    const server = createDappServer({ pageDir: pageFixture(), roots });
    const served = server.serve('/sample.js');
    expect(served.status).toBe(200);
    const js = served.body.toString('utf8');
    expect(js).toContain('export const answer = 42;');
    expect(js).not.toContain('protocol');
  });

  it('serves the same bytes on a loopback listener', async () => {
    const server = createDappServer({ pageDir: pageFixture(), roots });
    const port = await freePort();
    const stop = await serveTestDappOnLoopback(server, port);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/npm/eventemitter3/dist/eventemitter3.esm.js`);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        server.serve('/npm/eventemitter3/dist/eventemitter3.esm.js').body
      );
    } finally {
      await stop();
    }
  });

  it.each(['::1', '127.0.0.1'])('closes the address it bound when %s is taken, so a retry binds', async taken => {
    const server = createDappServer({ pageDir: pageFixture(), roots });
    const port = await freePort();
    const blocker = await hold(port, taken);
    try {
      await expect(serveTestDappOnLoopback(server, port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await release(blocker);
    }
    // A listener left on the other address would fail this second bind with EADDRINUSE and keep Jest alive.
    const stop = await serveTestDappOnLoopback(server, port);
    await stop();
  });
});

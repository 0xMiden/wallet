/**
 * @jest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  assertWalletApiAllowsExtension,
  checkWalletApiCors,
  chromeExtensionId,
  d1DatabaseName,
  DEFAULT_WALLET_API_URL,
  extensionIdForDirectory,
  extensionOrigin,
  type FetchLike,
  isExternalWalletApi,
  type JsonValue,
  localListenAddress,
  localWorkerConfig,
  readDevServerState,
  readWranglerVersion,
  stripJsonComments,
  TEMP_DIR_PREFIX,
  unpackedExtensionId,
  WALLET_API_REQUESTS,
  walletApiBaseUrl,
  wranglerDevArgs,
  wranglerMigrateArgs
} from './wallet-api-dev-server';

const ROOT = path.resolve(__dirname, '../../..');
const SERVICE_DIR = path.join(ROOT, 'services', 'wallet-api');
const ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${ID}`;
const BASE = 'http://127.0.0.1:8787';

interface FakeWorker {
  allowedOrigins?: readonly string[];
  allowHeaders?: readonly string[];
  healthy?: boolean;
}

/** A fetch that answers as `services/wallet-api/src/index.ts` and `src/http.ts` do, for the parts the probe reads. */
function fakeWorker({
  allowedOrigins = [ORIGIN],
  allowHeaders = ['authorization', 'content-type', 'if-none-match'],
  healthy = true
}: FakeWorker = {}): FetchLike {
  return async (url, init) => {
    const headers = new Headers(init.headers);
    const origin = headers.get('Origin');
    if (origin !== null && !allowedOrigins.includes(origin)) {
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { Vary: 'Origin' } });
    }
    const cors: Record<string, string> = { Vary: 'Origin' };
    if (origin !== null) cors['Access-Control-Allow-Origin'] = origin;
    if (init.method === 'OPTIONS') {
      const requested = (headers.get('Access-Control-Request-Headers') ?? '')
        .split(',')
        .map(name => name.trim().toLowerCase())
        .filter(name => name.length > 0);
      if (requested.some(name => !allowHeaders.includes(name))) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
          'Access-Control-Allow-Headers': allowHeaders.join(', ')
        }
      });
    }
    if (new URL(url).pathname === '/healthz') {
      return new Response(JSON.stringify({ ok: healthy, revision: 'e2e-local' }), {
        status: healthy ? 200 : 503,
        headers: cors
      });
    }
    return new Response(null, { status: 404, headers: cors });
  };
}

describe('walletApiBaseUrl', () => {
  it('uses the loopback default that the extension build carries, else E2E_WALLET_API_URL', () => {
    expect(walletApiBaseUrl({})).toBe(DEFAULT_WALLET_API_URL);
    expect(walletApiBaseUrl({ E2E_WALLET_API_URL: 'http://localhost:9000' })).toBe('http://localhost:9000');
    expect(walletApiBaseUrl({ E2E_WALLET_API_URL: 'https://api.example/backup' })).toBe('https://api.example/backup');
  });

  it.each(['http://127.0.0.1:8787/', 'http://127.0.0.1:8787?x=1', 'ftp://127.0.0.1', 'http://u:p@127.0.0.1', 'nope'])(
    'refuses %s',
    raw => expect(() => walletApiBaseUrl({ E2E_WALLET_API_URL: raw })).toThrow(/E2E_WALLET_API_URL/)
  );

  it('uses an external Worker only for the exact value true', () => {
    expect(isExternalWalletApi({ E2E_WALLET_API_EXTERNAL: 'true' })).toBe(true);
    expect(isExternalWalletApi({ E2E_WALLET_API_EXTERNAL: '1' })).toBe(false);
    expect(isExternalWalletApi({})).toBe(false);
  });
});

describe('localListenAddress', () => {
  it('listens on the host and port of a loopback http URL', () => {
    expect(localListenAddress(DEFAULT_WALLET_API_URL)).toEqual({ host: '127.0.0.1', port: 8787 });
    expect(localListenAddress('http://localhost')).toEqual({ host: 'localhost', port: 80 });
  });

  it.each(['https://127.0.0.1:8787', 'http://10.0.0.2:8787', 'http://127.0.0.1:8787/api'])(
    'refuses to start a local Worker for %s and names the external switch',
    url => expect(() => localListenAddress(url)).toThrow(/E2E_WALLET_API_EXTERNAL=true/)
  );
});

describe('extension origin', () => {
  // SHA-256("test") starts 9f86d081884c7d659a2feaa0c55ad015. The letters a-p write the hex digits 0-f.
  it('writes the first 32 hex digits of the SHA-256 as the letters a-p', () => {
    expect(chromeExtensionId('test')).toBe('jpignaibiiemhngfjkcpokkamffknabf');
  });

  it('takes an absolute path only', () => {
    expect(() => unpackedExtensionId('dist/chrome_unpacked')).toThrow(/absolute path/);
    expect(unpackedExtensionId('/a/b')).toBe(chromeExtensionId('/a/b'));
  });

  it('reads the real path, as Chrome does, so a symbolic link gives the id of its target', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wallet-api-ext-'));
    try {
      const build = path.join(dir, 'build');
      mkdirSync(build);
      writeFileSync(path.join(build, 'manifest.json'), '{}');
      const link = path.join(dir, 'link');
      symlinkSync(build, link);
      const real = realpathSync(build);
      expect(extensionIdForDirectory(link)).toBe(unpackedExtensionId(real));
      expect(extensionIdForDirectory(build)).toBe(unpackedExtensionId(real));
      expect(() => extensionIdForDirectory(path.join(dir, 'missing'))).toThrow(/test:e2e:multi-device:build/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('makes the origin from a valid id only', () => {
    expect(extensionOrigin(ID)).toBe(ORIGIN);
    expect(() => extensionOrigin('xyz')).toThrow(/Not a Chrome extension id/);
  });
});

describe('the local Worker config', () => {
  const committedText = stripJsonComments(readFileSync(path.join(SERVICE_DIR, 'wrangler.jsonc'), 'utf8'));
  const committed: JsonValue = JSON.parse(committedText);

  it('removes comments but keeps a // inside a string', () => {
    const parsed: JsonValue = JSON.parse(stripJsonComments('{"a":"x // y", /* b */ "c":"\\"//"} // end'));
    expect(parsed).toEqual({ a: 'x // y', c: '"//' });
    expect(committedText).toMatch(/"\$schema": "https:\/\/unpkg\.com\//);
  });

  it('allows only the extension origin, takes absolute paths and keeps the committed bindings', () => {
    const config = localWorkerConfig(committed, { serviceDir: SERVICE_DIR, allowedOrigins: [ORIGIN], revision: 'r' });
    expect(config).not.toHaveProperty('$schema');
    expect(config.main).toBe(path.join(SERVICE_DIR, 'src', 'index.ts'));
    expect(config.vars).toEqual({ ALLOWED_ORIGINS: JSON.stringify([ORIGIN]), DEPLOYMENT_REVISION: 'r' });
    expect(config.d1_databases).toEqual([
      expect.objectContaining({ binding: 'DB', migrations_dir: path.join(SERVICE_DIR, 'migrations') })
    ]);
    expect(config.ratelimits).toEqual([
      expect.objectContaining({ name: 'AUTH_RATE_LIMIT' }),
      expect.objectContaining({ name: 'STORAGE_RATE_LIMIT' })
    ]);
    expect(d1DatabaseName(config)).toBe('miden-wallet-api');
  });

  it('refuses a config with no DB binding', () => {
    expect(() =>
      localWorkerConfig(
        { main: 'src/index.ts', d1_databases: [{ binding: 'OTHER' }] },
        {
          serviceDir: SERVICE_DIR,
          allowedOrigins: [ORIGIN],
          revision: 'r'
        }
      )
    ).toThrow(/DB/);
  });

  it('uses the one Wrangler version of the service scripts, which the service check workflow also uses', () => {
    const version = readWranglerVersion(readFileSync(path.join(SERVICE_DIR, 'package.json'), 'utf8'));
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readFileSync(path.join(ROOT, '.github/workflows/wallet-api.yml'), 'utf8')).toContain(`wrangler@${version}`);
    expect(() =>
      readWranglerVersion(JSON.stringify({ scripts: { a: 'npx wrangler@1.0.0 dev', b: 'npx wrangler@2.0.0 dev' } }))
    ).toThrow(/one Wrangler version/);
  });

  it('applies the migrations and runs the Worker on the local state of the run, with remote bindings off', () => {
    const run = { version: '4.0.0', configPath: '/t/wrangler.json', persistDir: '/t/state' };
    expect(wranglerMigrateArgs({ ...run, databaseName: 'db' })).toEqual([
      '--yes',
      'wrangler@4.0.0',
      'd1',
      'migrations',
      'apply',
      'db',
      '--local',
      '--config',
      '/t/wrangler.json',
      '--persist-to',
      '/t/state'
    ]);
    const dev = wranglerDevArgs({ ...run, host: '127.0.0.1', port: 8787 });
    expect(dev.slice(0, 3)).toEqual(['--yes', 'wrangler@4.0.0', 'dev']);
    expect(dev.join(' ')).toContain(
      '--config /t/wrangler.json --local --ip 127.0.0.1 --port 8787 --persist-to /t/state'
    );
  });
});

describe('the CORS contract', () => {
  it('covers each method and preflight header that the wallet client sends', () => {
    const client = readFileSync(path.join(ROOT, 'src/lib/backup/api-client.ts'), 'utf8');
    expect(WALLET_API_REQUESTS.map(request => request.method).sort()).toEqual(['DELETE', 'GET', 'POST', 'PUT']);
    for (const write of ['headers.Authorization =', "headers['Content-Type'] =", "headers['If-None-Match'] ="]) {
      expect(client).toContain(write);
    }
  });

  it('passes a Worker that allows the extension origin and refuses an unknown one', async () => {
    await expect(checkWalletApiCors({ baseUrl: BASE, origin: ORIGIN, fetchImpl: fakeWorker() })).resolves.toBe(
      undefined
    );
  });

  it('names the origin when the Worker allows another one', async () => {
    const fetchImpl = fakeWorker({ allowedOrigins: ['chrome-extension://other'] });
    await expect(checkWalletApiCors({ baseUrl: BASE, origin: ORIGIN, fetchImpl })).rejects.toThrow(
      /does not keep the CORS contract for chrome-extension:\/\/abcdefghijklmnopabcdefghijklmnop/
    );
  });

  it('names each preflight that refuses a header the wallet sends', async () => {
    const fetchImpl = fakeWorker({ allowHeaders: ['authorization', 'content-type'] });
    await expect(checkWalletApiCors({ baseUrl: BASE, origin: ORIGIN, fetchImpl })).rejects.toThrow(
      /The GET preflight answered 403/
    );
  });

  it('fails a Worker that allows every origin', async () => {
    const fetchImpl: FetchLike = (url, init) => {
      const headers = new Headers(init.headers);
      const origin = headers.get('Origin') ?? '';
      return fakeWorker({ allowedOrigins: [origin] })(url, init);
    };
    await expect(checkWalletApiCors({ baseUrl: BASE, origin: ORIGIN, fetchImpl })).rejects.toThrow(
      /from https:\/\/wallet-api-probe\.invalid answered 200, not 403/
    );
  });
});

describe('assertWalletApiAllowsExtension', () => {
  const env = { E2E_WALLET_API_LOG: '/logs/wallet-api.log' };

  it('passes when the running Worker allows the id of the launched wallet', async () => {
    await expect(assertWalletApiAllowsExtension(ID, { env, fetchImpl: fakeWorker() })).resolves.toBe(undefined);
  });

  it('names both ids when global setup allowed another id', async () => {
    const other = 'ponmlkjihgfedcbaponmlkjihgfedcba';
    const fetchImpl = fakeWorker({ allowedOrigins: [`chrome-extension://${other}`] });
    const error = assertWalletApiAllowsExtension(ID, {
      env: { ...env, E2E_WALLET_API_EXTENSION_ID: other },
      fetchImpl
    });
    await expect(error).rejects.toThrow(new RegExp(`allowed the extension id ${other}.*wallet runs as ${ID}`));
    await expect(error).rejects.toThrow(/Worker log: \/logs\/wallet-api\.log/);
  });

  it('says that the Worker can have stopped when it does not answer', async () => {
    await expect(
      assertWalletApiAllowsExtension(ID, { env, fetchImpl: fakeWorker({ healthy: false }) })
    ).rejects.toThrow(/not healthy.*can have stopped during the run/);
    const down: FetchLike = () => Promise.reject(new Error('ECONNREFUSED'));
    await expect(assertWalletApiAllowsExtension(ID, { env, fetchImpl: down })).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('readDevServerState', () => {
  const write = (dir: string, tempDir: string): string => {
    const file = path.join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({ pid: 1, tempDir, logPath: '/l', host: '127.0.0.1', port: 8787 }));
    return file;
  };

  it('reads the process data of a directory that the module made', () => {
    const dir = mkdtempSync(path.join(tmpdir(), TEMP_DIR_PREFIX));
    try {
      expect(readDevServerState(write(dir, dir))).toEqual({
        pid: 1,
        tempDir: dir,
        logPath: '/l',
        host: '127.0.0.1',
        port: 8787
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a directory that the module did not make, so a stop never removes it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'other-'));
    try {
      expect(() => readDevServerState(write(dir, dir))).toThrow(/did not make/);
      expect(() => readDevServerState(write(dir, ROOT))).toThrow(/did not make/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

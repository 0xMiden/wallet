import type { BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

/**
 * Serves the test dApp with the wallet's own copies of the SDK and the adapter, so the page runs the bytes the
 * wallet resolves. Plain ES modules plus an import map, no bundler; page modules are transpiled per request
 * (the repo compiles with `isolatedModules`, so per-file transpilation is sound).
 */

export const DAPP_PORT = Number(process.env.DAPP_E2E_PORT ?? '4810');
/**
 * Two hosts, so two dApps to the wallet: it keys sessions by the content script's origin (`src/contentScript.ts:79`),
 * and the content script injects on both hosts at any port (`public/manifest.json:94`).
 */
export const DAPP_ORIGINS = {
  one: `http://localhost:${DAPP_PORT}`,
  two: `http://127.0.0.1:${DAPP_PORT}`
} as const;
export type DappLabel = keyof typeof DAPP_ORIGINS;
/** The React page's own origin (spec section 4.1), so its sessions and storage never mix with dApps one and two. */
export const REACT_DAPP_PORT = DAPP_PORT + 1;
export const REACT_DAPP_ORIGIN = `http://localhost:${REACT_DAPP_PORT}`;

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PAGE_DIR = path.join(REPO_ROOT, 'playwright/e2e/test-dapp');
const IMPORT_MAP_MARKER = '<!-- test-dapp:import-map -->';
const JS = 'text/javascript; charset=utf-8';
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': JS,
  '.mjs': JS,
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm'
};

export interface PackageRoots {
  '@miden-sdk/miden-sdk': string;
  '@miden-sdk/miden-wallet-adapter-base': string;
  '@miden-sdk/miden-wallet-adapter-miden': string;
  eventemitter3: string;
}
type ServedPackage = keyof PackageRoots;

export interface ImportMap {
  imports: Record<string, string>;
}

export interface ServedFile {
  status: number;
  contentType: string;
  body: Buffer;
}

export interface DappServer {
  readonly importMap: ImportMap;
  /** `urlPath` is a URL pathname, still percent-encoded: `serve` decodes it once, before refusing `..`. */
  serve(urlPath: string): ServedFile;
}

const packageRoot = (requireFrom: NodeRequire, name: string): string =>
  path.dirname(requireFrom.resolve(`${name}/package.json`));

/** The package directories the wallet itself resolves from `repoRoot`, so page and extension load the same bytes. */
export function resolvePackageRoots(repoRoot: string = REPO_ROOT): PackageRoots {
  const fromRepo = createRequire(path.join(repoRoot, 'package.json'));
  const adapterBase = packageRoot(fromRepo, '@miden-sdk/miden-wallet-adapter-base');
  // yarn.lock carries eventemitter3 5.0.1 and 5.0.4 and hoisting decides which sits at the root, so resolve the
  // copy adapter-base itself loads.
  const fromAdapterBase = createRequire(path.join(adapterBase, 'package.json'));
  return {
    '@miden-sdk/miden-sdk': packageRoot(fromRepo, '@miden-sdk/miden-sdk'),
    '@miden-sdk/miden-wallet-adapter-base': adapterBase,
    '@miden-sdk/miden-wallet-adapter-miden': packageRoot(fromRepo, '@miden-sdk/miden-wallet-adapter-miden'),
    eventemitter3: packageRoot(fromAdapterBase, 'eventemitter3')
  };
}

function manifestField(root: string, keys: readonly string[]): string {
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const value = keys.reduce<unknown>(
    (node, key) => (typeof node === 'object' && node !== null ? Reflect.get(node, key) : undefined),
    manifest
  );
  if (typeof value !== 'string') throw new Error(`${root}/package.json has no ${keys.join('.')}`);
  return value.replace(/^\.\//, '');
}

/** Entry points come from each package's own manifest, so a release that moves one is followed, not hard-coded. */
export function buildImportMap(roots: PackageRoots): ImportMap {
  return {
    imports: {
      // The browser `import` entry, the single-threaded eager build: no COOP/COEP needed.
      '@miden-sdk/miden-sdk': `/npm/@miden-sdk/miden-sdk/${manifestField(roots['@miden-sdk/miden-sdk'], ['exports', '.', 'import', 'default'])}`,
      '@miden-sdk/miden-wallet-adapter-base': `/npm/@miden-sdk/miden-wallet-adapter-base/${manifestField(roots['@miden-sdk/miden-wallet-adapter-base'], ['module'])}`,
      '@miden-sdk/miden-wallet-adapter-miden': `/npm/@miden-sdk/miden-wallet-adapter-miden/${manifestField(roots['@miden-sdk/miden-wallet-adapter-miden'], ['module'])}`,
      // Not exports.import: index.mjs imports the CommonJS index.js, which only a bundler can load.
      eventemitter3: '/npm/eventemitter3/dist/eventemitter3.esm.js'
    }
  };
}

const isServedPackage = (name: string, roots: PackageRoots): name is ServedPackage => Object.hasOwn(roots, name);

export interface DappServerOptions {
  pageDir?: string;
  roots?: PackageRoots;
  /** The page shell `/` serves from `pageDir`. */
  shell?: string;
  importMap?: ImportMap;
  /** Generated modules, served at `/shims/<name>`. */
  shims?: ReadonlyMap<string, string>;
}

/**
 * Serves `/` (the page shell, with the import map injected at its marker so the map cannot drift from the resolver),
 * `/<name>.js` (the page's `<name>.ts`, transpiled), `/npm/<package>/<path>` (files under the package roots) and
 * `/shims/<name>` (generated modules). A traversal attempt answers 400, a page module that does not parse 500 and an
 * unknown path 404.
 */
export function createDappServer(options: DappServerOptions = {}): DappServer {
  const pageDir = options.pageDir ?? PAGE_DIR;
  const roots = options.roots ?? resolvePackageRoots();
  const importMap = options.importMap ?? buildImportMap(roots);
  const shell = options.shell ?? 'index.html';
  const shims = options.shims ?? new Map<string, string>();
  const cache = new Map<string, ServedFile>();
  const text = (status: number, why: string): ServedFile => ({
    status,
    contentType: 'text/plain; charset=utf-8',
    body: Buffer.from(why)
  });

  const servePackage = (segments: string[]): ServedFile => {
    const scoped = segments[0]?.startsWith('@') === true;
    const name = scoped ? `${segments[0]}/${segments[1] ?? ''}` : (segments[0] ?? '');
    if (!isServedPackage(name, roots)) return text(404, `package ${name} is not served`);
    const root = roots[name];
    const rest = segments.slice(scoped ? 2 : 1).join('/');
    // adapter-base's dist/index.js says `export * from "./adapter"`, an extensionless import only a bundler resolves.
    for (const candidate of [rest, `${rest}.js`]) {
      const file = path.join(root, candidate);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      return {
        status: 200,
        contentType: CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
        body: fs.readFileSync(file)
      };
    }
    return text(404, `${name}/${rest} does not exist`);
  };

  const servePage = (): ServedFile => {
    const html = fs.readFileSync(path.join(pageDir, shell), 'utf8');
    if (!html.includes(IMPORT_MAP_MARKER)) return text(500, `${shell} lacks ${IMPORT_MAP_MARKER}`);
    const tag = `<script type="importmap">${JSON.stringify(importMap)}</script>`;
    return {
      status: 200,
      contentType: CONTENT_TYPES['.html'] ?? JS,
      body: Buffer.from(html.replace(IMPORT_MAP_MARKER, tag))
    };
  };

  const servePageModule = (name: string): ServedFile => {
    const source = path.join(pageDir, `${name}.ts`);
    if (!fs.existsSync(source)) return text(404, `no page module ${name}.ts`);
    const { outputText, diagnostics = [] } = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
      fileName: source,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true }
    });
    // A module that does not parse, JSX in a `.ts` file among them, transpiles to broken code without a word unless
    // diagnostics are asked for (spec section 4.1): refusing it names the error instead of leaving a dead page.
    if (diagnostics.length > 0) {
      const why = diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
      return text(500, `${name}.ts does not parse: ${why.join('; ')}`);
    }
    return { status: 200, contentType: JS, body: Buffer.from(outputText) };
  };

  const route = (segments: string[]): ServedFile => {
    if (segments.length === 0 || (segments.length === 1 && segments[0] === shell)) return servePage();
    if (segments[0] === 'npm') return servePackage(segments.slice(1));
    if (segments[0] === 'shims' && segments.length === 2) {
      const shim = shims.get(segments[1] ?? '');
      if (shim === undefined) return text(404, `no shim ${segments[1] ?? ''}`);
      return { status: 200, contentType: JS, body: Buffer.from(shim) };
    }
    const page = segments.length === 1 ? /^([a-z][a-z0-9-]*)\.js$/.exec(segments[0] ?? '') : null;
    if (page?.[1] !== undefined) return servePageModule(page[1]);
    return text(404, `no route for /${segments.join('/')}`);
  };

  return {
    importMap,
    serve(urlPath) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(urlPath);
      } catch {
        return text(400, 'undecodable path');
      }
      const segments = decoded.split('/').filter(segment => segment.length > 0);
      // After decoding, so `%2e%2e` is caught too; a backslash is a path separator to `path.join` on Windows.
      if (segments.some(segment => segment === '..' || segment === '.' || segment.includes('\\'))) {
        return text(400, 'path traversal refused');
      }
      // The 20 MB wasm is read once per run; a miss is not cached, so a file created later is still found.
      const cached = cache.get(decoded);
      if (cached) return cached;
      const served = route(segments);
      if (served.status === 200) cache.set(decoded, served);
      return served;
    }
  };
}

/**
 * Route-served mode, for dApps one and two unless `origins` names others (the React page's). Playwright tries the
 * last-registered route first, so these win over the fixture's catch-all fault router
 * (`harness/network-faults.ts:339`); they always fulfil and never continue.
 */
export async function installTestDapp(
  context: BrowserContext,
  server: DappServer = createDappServer(),
  origins: readonly string[] = Object.values(DAPP_ORIGINS)
): Promise<void> {
  for (const origin of origins) {
    await context.route(`${origin}/**`, async route => {
      const served = server.serve(new URL(route.request().url()).pathname);
      await route.fulfill({ status: served.status, contentType: served.contentType, body: served.body });
    });
  }
}

/**
 * Loopback-listener mode, for when Chromium treats a route-fulfilled page as public and applies Local Network
 * Access to its node calls (the spike decides). `::1` is best effort: a host without IPv6 still serves 127.0.0.1.
 */
export async function serveTestDappOnLoopback(
  server: DappServer,
  port: number = DAPP_PORT
): Promise<() => Promise<void>> {
  const handler = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    const served = server.serve(new URL(request.url ?? '/', 'http://loopback').pathname);
    response.writeHead(served.status, { 'content-type': served.contentType });
    response.end(served.body);
  };
  const listen = (host: string): Promise<http.Server | null> =>
    new Promise((resolve, reject) => {
      const listener = http.createServer(handler);
      listener.once('error', (error: NodeJS.ErrnoException) =>
        host === '::1' && error.code === 'EADDRNOTAVAIL' ? resolve(null) : reject(error)
      );
      listener.listen(port, host, () => resolve(listener));
    });
  // allSettled, not all: when one address fails, the one that bound must be closed too, or it keeps the port and the
  // process alive.
  const settled = await Promise.allSettled([listen('127.0.0.1'), listen('::1')]);
  const listeners = settled.flatMap(result =>
    result.status === 'fulfilled' && result.value !== null ? [result.value] : []
  );
  const stop = async (): Promise<void> => {
    await Promise.all(listeners.map(listener => new Promise<void>(resolve => listener.close(() => resolve()))));
  };
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure !== undefined) {
    await stop();
    throw failure.reason;
  }
  return stop;
}

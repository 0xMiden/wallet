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

/** The packages the React page loads besides the base four (spec section 4.2). */
export interface ReactPackageRoots extends PackageRoots {
  react: string;
  'react-dom': string;
  '@miden-sdk/react': string;
  '@miden-sdk/miden-wallet-adapter-react': string;
  zustand: string;
}

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

/** The React packages the wallet resolves, zustand from `@miden-sdk/react`'s own directory as eventemitter3 above. */
export function resolveReactPackageRoots(repoRoot: string = REPO_ROOT): ReactPackageRoots {
  const fromRepo = createRequire(path.join(repoRoot, 'package.json'));
  const midenReact = packageRoot(fromRepo, '@miden-sdk/react');
  return {
    ...resolvePackageRoots(repoRoot),
    react: packageRoot(fromRepo, 'react'),
    'react-dom': packageRoot(fromRepo, 'react-dom'),
    '@miden-sdk/react': midenReact,
    '@miden-sdk/miden-wallet-adapter-react': packageRoot(fromRepo, '@miden-sdk/miden-wallet-adapter-react'),
    zustand: packageRoot(createRequire(path.join(midenReact, 'package.json')), 'zustand')
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

/** The base map plus React through its shims, the two React packages, and the three zustand specifiers they import. */
export function buildReactImportMap(roots: ReactPackageRoots): ImportMap {
  // The `./*` subpaths point at `.mjs` files, which the server's `.js` retry cannot reach from a bare subpath.
  const zustand = (subpath: string): string =>
    `/npm/zustand/${manifestField(roots.zustand, ['exports', './*', 'import', 'default']).replaceAll('*', subpath)}`;
  return {
    imports: {
      ...buildImportMap(roots).imports,
      react: '/shims/react.js',
      'react/jsx-runtime': '/shims/react-jsx-runtime.js',
      'react-dom/client': '/shims/react-dom-client.js',
      '@miden-sdk/react': `/npm/@miden-sdk/react/${manifestField(roots['@miden-sdk/react'], ['module'])}`,
      '@miden-sdk/miden-wallet-adapter-react': `/npm/@miden-sdk/miden-wallet-adapter-react/${manifestField(roots['@miden-sdk/miden-wallet-adapter-react'], ['module'])}`,
      zustand: `/npm/zustand/${manifestField(roots.zustand, ['exports', '.', 'import', 'default'])}`,
      'zustand/vanilla': zustand('vanilla'),
      'zustand/react': zustand('react')
    }
  };
}

// Development builds: their errors say what went wrong, which a failed cell's record keeps.
const REACT_UMD = { react: 'umd/react.development.js', 'react-dom': 'umd/react-dom.development.js' } as const;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** The names `require(specifier)` gives in Node from `root`: what an ES module face of it must export. */
function commonJsExports(root: string, specifier: string): string[] {
  const loaded: unknown = createRequire(path.join(root, 'package.json'))(specifier);
  if (typeof loaded !== 'object' || loaded === null) throw new Error(`${specifier} from ${root} exports no object`);
  const names = Object.keys(loaded);
  const unusable = names.filter(name => !IDENTIFIER.test(name) || name === 'default');
  if (unusable.length > 0)
    throw new Error(`${specifier} exports names a module cannot re-export: ${unusable.join(', ')}`);
  return names;
}

/**
 * ES module faces for React 18.2, which ships CommonJS and UMD only (spec section 4.2). Each loads the UMD build, which
 * sets `React` or `ReactDOM` on the global, and re-exports exactly the names `require` gives in Node when the server
 * starts, so a named import cannot go missing as React moves. `react/jsx-runtime` has no UMD build: its functions are
 * written over `createElement`, and a name it gains that has none here stops the server.
 */
export function buildReactShims(roots: ReactPackageRoots): ReadonlyMap<string, string> {
  for (const pkg of ['react', 'react-dom'] as const) {
    if (!fs.existsSync(path.join(roots[pkg], REACT_UMD[pkg]))) throw new Error(`${pkg} has no ${REACT_UMD[pkg]}`);
  }
  const react = commonJsExports(roots.react, 'react');
  const client = commonJsExports(roots['react-dom'], 'react-dom/client');
  const jsxRuntime = commonJsExports(roots.react, 'react/jsx-runtime');
  const jsxBodies: Record<string, string> = { Fragment: 'React.Fragment', jsx: 'element', jsxs: 'element' };
  const unshimmed = jsxRuntime.filter(name => !Object.hasOwn(jsxBodies, name));
  if (unshimmed.length > 0)
    throw new Error(`react/jsx-runtime exports ${unshimmed.join(', ')}, which no shim implements`);
  return new Map([
    [
      'react.js',
      [
        `import '/npm/react/${REACT_UMD.react}';`,
        'const React = globalThis.React;',
        'export default React;',
        `export const { ${react.join(', ')} } = React;`
      ].join('\n')
    ],
    [
      'react-jsx-runtime.js',
      [
        "import React from '/shims/react.js';",
        // The automatic runtime passes children inside props and the key apart; createElement takes both in its config.
        'const element = (type, props, key) => React.createElement(type, key === undefined ? props : { ...props, key });',
        ...jsxRuntime.map(name => `export const ${name} = ${jsxBodies[name]};`),
        `export default { ${jsxRuntime.join(', ')} };`
      ].join('\n')
    ],
    [
      'react-dom-client.js',
      [
        // React first: the react-dom UMD reads the global React as it loads.
        "import '/shims/react.js';",
        `import '/npm/react-dom/${REACT_UMD['react-dom']}';`,
        'const ReactDOM = globalThis.ReactDOM;',
        `export const { ${client.join(', ')} } = ReactDOM;`,
        `export default { ${client.join(', ')} };`
      ].join('\n')
    ]
  ]);
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

/** The React page's server (spec section 4): its own shell, the React import map and the generated shims. */
export function createReactDappServer(options: { pageDir?: string; roots?: ReactPackageRoots } = {}): DappServer {
  const roots = options.roots ?? resolveReactPackageRoots();
  return createDappServer({
    pageDir: options.pageDir,
    roots,
    shell: 'react-dapp.html',
    importMap: buildReactImportMap(roots),
    shims: buildReactShims(roots)
  });
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
  const listener = http.createServer(staticDappHandler(server));
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  listener.unref();
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('static dApp listener has no TCP address');
  const stop = (): void => {
    listener.close();
    listener.closeAllConnections();
  };
  context.once('close', stop);
  try {
    for (const origin of origins) {
      await context.route(`${origin}/**`, async route => {
        const pathname = new URL(route.request().url()).pathname;
        const response = await context.request.get(`http://127.0.0.1:${address.port}${pathname}`, {
          failOnStatusCode: false,
          maxRedirects: 0
        });
        try {
          const headers = Object.fromEntries(
            Object.entries(response.headers()).filter(
              ([name, value]) => name === 'content-type' || (name === 'content-length' && Number(value) > 0)
            )
          );
          // A same-connection response carries its body by reference; body/path would copy base64 into every trace.
          await route.fulfill({ response, headers });
        } finally {
          await response.dispose();
        }
      });
    }
  } catch (error) {
    context.off('close', stop);
    stop();
    throw error;
  }
}

/** A handler for the routes the static server does not own; it returns true when it answered the request. */
export type LoopbackRoutes = (request: http.IncomingMessage, response: http.ServerResponse) => boolean;
const PAGE_MODULE = /^\/[a-z][a-z0-9-]*\.js$/;

function staticDappHandler(server: DappServer, routes?: LoopbackRoutes): http.RequestListener {
  return (request, response) => {
    if (routes?.(request, response) === true) return;
    const pathname = new URL(request.url ?? '/', 'http://loopback').pathname;
    const served = server.serve(pathname);
    // The shell and the page modules come from the working tree, which a session edits between loads (spec 3.2).
    const noStore = served.contentType.startsWith('text/html') || PAGE_MODULE.test(pathname);
    response.writeHead(served.status, {
      'content-type': served.contentType,
      ...(noStore ? { 'cache-control': 'no-store' } : {})
    });
    response.end(served.body);
  };
}

/**
 * Loopback-listener mode, for when Chromium treats a route-fulfilled page as public and applies Local Network
 * Access to its node calls (the spike decides). `::1` is best effort: a host without IPv6 still serves 127.0.0.1.
 * A request `routes` answers (it returns true) never reaches the static server; the command channel's routes ride here
 * (spec 3.2).
 */
export async function serveTestDappOnLoopback(
  server: DappServer,
  port: number = DAPP_PORT,
  routes?: LoopbackRoutes
): Promise<() => Promise<void>> {
  const handler = staticDappHandler(server, routes);
  const listen = (host: string): Promise<http.Server | null> =>
    new Promise((resolve, reject) => {
      const listener = http.createServer(handler);
      // A host with IPv6 disabled refuses ::1 either way.
      listener.once('error', (error: NodeJS.ErrnoException) =>
        host === '::1' && (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT')
          ? resolve(null)
          : reject(error)
      );
      listener.listen(port, host, () => resolve(listener));
    });
  // allSettled, not all: when one address fails, the one that bound must be closed too, or it keeps the port and the
  // process alive.
  const settled = await Promise.allSettled([listen('127.0.0.1'), listen('::1')]);
  const listeners = settled.flatMap(result =>
    result.status === 'fulfilled' && result.value !== null ? [result.value] : []
  );
  // A held long-poll keeps its socket open, so close() alone would wait out its hold.
  const stop = async (): Promise<void> => {
    await Promise.all(
      listeners.map(
        listener =>
          new Promise<void>(resolve => {
            listener.close(() => resolve());
            listener.closeAllConnections();
          })
      )
    );
  };
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure !== undefined) {
    await stop();
    throw failure.reason;
  }
  return stop;
}

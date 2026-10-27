import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve } from 'node:path';

import { installMatrixProgress } from './progress';

let server: Server;
let origin: string;
const root = resolve(process.env.WALLET_MATRIX_BUILD_ROOT ?? resolve(import.meta.dirname, 'builds'));

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(`${root}/`) || request.method !== 'GET') {
      response.writeHead(403).end();
      return;
    }
    try {
      const types: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.wasm': 'application/wasm',
        '.json': 'application/json'
      };
      response.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FACTORY_SERVER_SETUP');
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done, reject) =>
    server.close(error => (error ? reject(new Error('FACTORY_SERVER_CLOSE')) : done()))
  );
});
const cases = [
  {
    id: 'st/module/normal-create',
    mode: 'st',
    workerMode: 'module',
    kind: 'normal-create',
    durability: 'strict'
  },
  {
    id: 'st/module/public-reader',
    mode: 'st',
    workerMode: 'module',
    kind: 'public-reader',
    durability: 'strict'
  },
  {
    id: 'st/module/late-commit-abort',
    mode: 'st',
    workerMode: 'module',
    kind: 'late-commit-abort',
    durability: 'strict'
  },
  {
    id: 'st/module/intentional-abort',
    mode: 'st',
    workerMode: 'module',
    kind: 'intentional-abort',
    durability: 'strict'
  },
  {
    id: 'st/classic/normal-create',
    mode: 'st',
    workerMode: 'classic',
    kind: 'normal-create',
    durability: 'strict'
  },
  {
    id: 'st/classic/public-reader',
    mode: 'st',
    workerMode: 'classic',
    kind: 'public-reader',
    durability: 'strict'
  },
  {
    id: 'st/classic/late-commit-abort',
    mode: 'st',
    workerMode: 'classic',
    kind: 'late-commit-abort',
    durability: 'strict'
  },
  {
    id: 'st/classic/intentional-abort',
    mode: 'st',
    workerMode: 'classic',
    kind: 'intentional-abort',
    durability: 'strict'
  },
  {
    id: 'mt/module/normal-create',
    mode: 'mt',
    workerMode: 'module',
    kind: 'normal-create',
    durability: 'strict'
  },
  {
    id: 'mt/module/public-reader',
    mode: 'mt',
    workerMode: 'module',
    kind: 'public-reader',
    durability: 'strict'
  },
  {
    id: 'mt/module/late-commit-abort',
    mode: 'mt',
    workerMode: 'module',
    kind: 'late-commit-abort',
    durability: 'strict'
  },
  {
    id: 'mt/module/intentional-abort',
    mode: 'mt',
    workerMode: 'module',
    kind: 'intentional-abort',
    durability: 'strict'
  },
  {
    id: 'mt/classic/normal-create',
    mode: 'mt',
    workerMode: 'classic',
    kind: 'normal-create',
    durability: 'strict'
  },
  {
    id: 'mt/classic/public-reader',
    mode: 'mt',
    workerMode: 'classic',
    kind: 'public-reader',
    durability: 'strict'
  },
  {
    id: 'mt/classic/late-commit-abort',
    mode: 'mt',
    workerMode: 'classic',
    kind: 'late-commit-abort',
    durability: 'strict'
  },
  {
    id: 'mt/classic/intentional-abort',
    mode: 'mt',
    workerMode: 'classic',
    kind: 'intentional-abort',
    durability: 'strict'
  },
  {
    id: 'st/durability/strict',
    mode: 'st',
    workerMode: 'module',
    kind: 'durability',
    durability: 'strict'
  },
  {
    id: 'st/durability/default',
    mode: 'st',
    workerMode: 'module',
    kind: 'durability',
    durability: 'default'
  },
  {
    id: 'mt/durability/strict',
    mode: 'mt',
    workerMode: 'module',
    kind: 'durability',
    durability: 'strict'
  },
  {
    id: 'mt/durability/default',
    mode: 'mt',
    workerMode: 'module',
    kind: 'durability',
    durability: 'default'
  }
];

const commonChecks = [
  'initiallyHealthy',
  'requestedWasmMode',
  'crossOriginIsolated',
  'realWorkerSelector',
  'distinctBootstrapNamespace',
  'actualSdkClass',
  'nativeNamespace',
  'actualMethodWorker',
  'selectedWorkerMode',
  'workerReady',
  'cleanupComplete'
];
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function safeReceipt(value: unknown, scenario: (typeof cases)[number]) {
  if (!isRecord(value)) return undefined;
  const fields = [
    'ok',
    'phase',
    'kind',
    'mode',
    'workerMode',
    'durability',
    'checks',
    'observations',
    'digests',
    'timings'
  ];
  if (Object.keys(value).sort().join() !== fields.sort().join()) return undefined;
  const phases = [
    'initializing',
    'bootstrap-native-mock',
    'bootstrap-supported-import',
    'normal-wallet-create',
    'public-wallet-reader',
    'native-request-success-then-abort',
    'bounded-durability-measurement',
    'cleanup',
    'complete'
  ];
  if (typeof value.ok !== 'boolean' || typeof value.phase !== 'string' || !phases.includes(value.phase))
    return undefined;
  if (
    value.kind !== scenario.kind ||
    value.mode !== scenario.mode ||
    value.workerMode !== scenario.workerMode ||
    value.durability !== scenario.durability
  )
    return undefined;
  const checks = [...commonChecks];
  if (scenario.kind !== 'durability') checks.push('actualWalletClass', 'normalNetwork', 'walletWritesStrict');
  if (scenario.kind !== 'late-commit-abort') checks.push('healthRemainsHealthy');
  if (scenario.kind === 'public-reader')
    checks.push(
      'guardedAccountPresent',
      'actualWalletHold',
      'emptyGenuineStore',
      'publicReaderSeparate',
      'publicReaderNoWorker'
    );
  if (scenario.kind.includes('abort'))
    checks.push(
      'requestActuallySucceeded',
      'sdkRefusedAcknowledgement',
      'nativeTransactionAborted',
      'abortHealthClassification'
    );
  if (scenario.kind === 'durability')
    checks.push('allMeasuredWritesCommitted', 'measuredDurability', 'finalReadbackMatches', 'finiteSamples');
  if (
    !isRecord(value.checks) ||
    Object.entries(value.checks).some(([key, entry]) => !checks.includes(key) || typeof entry !== 'boolean')
  )
    return undefined;
  if (
    value.ok &&
    (Object.keys(value.checks).length !== checks.length || Object.values(value.checks).some(entry => entry !== true))
  )
    return undefined;
  const observed = [
    'hardwareConcurrency',
    'isMultithreadedBuild',
    'readwriteCount',
    ...(scenario.kind.includes('abort') ? ['requestSuccessBeforeAbort', 'intentionalAbort'] : []),
    ...(scenario.kind === 'durability' ? ['samples', 'warmups', 'payloadBytes'] : [])
  ];
  if (
    !isRecord(value.observations) ||
    Object.entries(value.observations).some(
      ([key, entry]) =>
        !observed.includes(key) ||
        (typeof entry !== 'boolean' && (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0))
    )
  )
    return undefined;
  if (value.ok && Object.keys(value.observations).length !== observed.length) return undefined;
  if (
    !isRecord(value.digests) ||
    Object.entries(value.digests).some(
      ([key, entry]) => key !== 'bootstrap' || typeof entry !== 'string' || !/^[a-f0-9]{64}$/.test(entry)
    )
  )
    return undefined;
  if (
    !Array.isArray(value.timings) ||
    value.timings.length > 16 ||
    value.timings.some(entry => typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0)
  )
    return undefined;
  if (value.ok && value.timings.length !== (scenario.kind === 'durability' ? 16 : 0)) return undefined;
  return value;
}
for (const scenario of cases) {
  test(scenario.id, async ({ page, context }, testInfo) => {
    const diagnostic = await installMatrixProgress(page, scenario.id, root);
    try {
      let blockedNonAsset = false;
      let observedWorkerMode = '';
      let methodWorkerCount = 0;
      page.on('worker', worker => {
        const pathname = new URL(worker.url()).pathname;
        if (pathname.includes('web-client-methods-worker')) {
          methodWorkerCount++;
          observedWorkerMode = pathname.includes('.module') ? 'module' : 'classic';
        }
      });
      await context.route('**/*', route => {
        const request = route.request();
        const url = new URL(request.url());
        const local = url.origin === origin;
        const asset =
          request.method() === 'GET' &&
          /^\/(st|mt)\//.test(url.pathname) &&
          /(?:\.html|\.js|\.mjs|\.wasm|\.css|\.svg|\.png|\.woff2?|\.map)$/.test(url.pathname);
        if (!local || !asset) {
          blockedNonAsset = true;
          return route.abort();
        }
        return route.continue();
      });
      await page.goto(`${origin}/${scenario.mode}/index.html`);
      await page.waitForFunction(() => typeof Reflect.get(window, '__WALLET_WORKER_MATRIX__')?.run === 'function');
      const result: unknown = await page.evaluate(async args => {
        const fixture = Reflect.get(window, '__WALLET_WORKER_MATRIX__');
        return fixture.run(args.kind, args.workerMode, args.durability);
      }, scenario);
      const safe = safeReceipt(result, scenario);
      await testInfo.attach('worker-matrix-safe', {
        body: JSON.stringify({
          receipt: safe ?? { ok: false, phase: 'invalid-receipt' },
          blockedNonAsset,
          methodWorkerCount,
          selectedWorkerObserved: observedWorkerMode === scenario.workerMode
        }),
        contentType: 'application/json'
      });
      expect(safe !== undefined).toBe(true);
      expect(safe?.ok).toBe(true);
      expect(blockedNonAsset).toBe(false);
      expect(methodWorkerCount).toBe(1);
      expect(observedWorkerMode === scenario.workerMode).toBe(true);
    } finally {
      diagnostic.finish(testInfo.status);
    }
  });
}

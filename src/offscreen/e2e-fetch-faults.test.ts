/** @jest-environment node */
import { restoreOffscreenFetchFaults } from './e2e-fetch-faults';

const KEY = '__miden_e2e_offscreen_fetch_faults';
const URL_SYNC = 'http://localhost:57291/miden.node.v1.NodeService/SyncNotes';
const wire = [{ id: 'discovery', host: ':57291', path: 'NodeService/Sync', mode: 'hang' }];
const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;
const originalE2eFlag = process.env.MIDEN_E2E_TEST;
let get: jest.Mock<Promise<Record<string, unknown>>, []>;
let nativeFetch: jest.Mock<Promise<Response>, []>;
let changed: ((changes: Record<string, { newValue?: unknown }>, area: string) => void) | undefined;
let log: jest.SpyInstance;

beforeEach(() => {
  process.env.MIDEN_E2E_TEST = 'true';
  get = jest.fn().mockResolvedValue({});
  nativeFetch = jest.fn(async () => new Response('inert'));
  globalThis.fetch = nativeFetch;
  changed = undefined;
  Reflect.set(globalThis, 'chrome', {
    storage: {
      local: { get },
      onChanged: {
        addListener: (listener: typeof changed) => (changed = listener),
        removeListener: () => (changed = undefined)
      }
    }
  });
  log = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (originalE2eFlag === undefined) delete process.env.MIDEN_E2E_TEST;
  else process.env.MIDEN_E2E_TEST = originalE2eFlag;
  globalThis.fetch = originalFetch;
  Reflect.set(globalThis, 'chrome', originalChrome);
  for (const key of ['__e2e_fetch_wrapped', '__E2E_NET_FAULTS', '__E2E_NET_FAULT_HITS']) {
    Reflect.deleteProperty(globalThis, key);
  }
  log.mockRestore();
});

it('restores an empty policy in a runtime-only offscreen document', async () => {
  Reflect.set(globalThis, 'chrome', {
    runtime: {
      id: 'runtime-only',
      getURL: (path: string) => `chrome-extension://runtime-only/${path}`,
      getManifest: () => ({ background: { service_worker: 'background.js' } }),
      onMessage: { addListener: jest.fn(), removeListener: jest.fn() },
      sendMessage: async () => ({ ok: true, value: {} })
    }
  });
  const result = await restoreOffscreenFetchFaults().then(
    () => 'ready',
    () => 'startup failed'
  );
  expect(result).toBe('ready');
  expect(globalThis.fetch).toBe(nativeFetch);
});

it('leaves startup fetch untouched when no policy was persisted', async () => {
  await restoreOffscreenFetchFaults();
  expect(globalThis.fetch).toBe(nativeFetch);
  expect((await fetch(URL_SYNC)).status).toBe(200);
});

it('blocks the first matching request without a watcher and still passes unrelated requests', async () => {
  get.mockResolvedValue({ [KEY]: wire });
  await restoreOffscreenFetchFaults();
  let settled = false;
  void fetch(URL_SYNC).then(() => (settled = true));
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(nativeFetch).not.toHaveBeenCalled();
  expect(Reflect.get(globalThis, '__E2E_NET_FAULT_HITS')).toEqual({ discovery: 1 });
  expect((await fetch('http://localhost:57291/OtherService/Read')).status).toBe(200);
});

it('clears and rearms the same wrapper without resetting accumulated hits', async () => {
  get.mockResolvedValue({ [KEY]: wire });
  await restoreOffscreenFetchFaults();
  const wrapped = globalThis.fetch;
  void fetch(URL_SYNC);
  changed?.({ [KEY]: {} }, 'local');
  expect((await fetch(URL_SYNC)).status).toBe(200);
  changed?.({ [KEY]: { newValue: [{ ...wire[0], mode: 'status500' }] } }, 'local');
  expect((await fetch(URL_SYNC)).status).toBe(500);
  expect(globalThis.fetch).toBe(wrapped);
  expect(Reflect.get(globalThis, '__E2E_NET_FAULT_HITS')).toEqual({ discovery: 2 });
});

it('does not resurrect an old snapshot after a clear during the initial storage read', async () => {
  let resolveRead: ((value: Record<string, unknown>) => void) | undefined;
  get.mockReturnValue(new Promise(resolve => (resolveRead = resolve)));
  const ready = restoreOffscreenFetchFaults();
  changed?.({ [KEY]: {} }, 'local');
  resolveRead?.({ [KEY]: wire });
  await ready;
  expect((await fetch(URL_SYNC)).status).toBe(200);
});

it('keeps a newer rearm instead of the older startup snapshot', async () => {
  let resolveRead: ((value: Record<string, unknown>) => void) | undefined;
  get.mockReturnValue(new Promise(resolve => (resolveRead = resolve)));
  const ready = restoreOffscreenFetchFaults();
  changed?.({ [KEY]: { newValue: [{ ...wire[0], mode: 'status500' }] } }, 'local');
  resolveRead?.({ [KEY]: wire });
  await ready;
  expect((await fetch(URL_SYNC)).status).toBe(500);
});

it('ignores unrelated storage keys and storage areas', async () => {
  get.mockResolvedValue({ [KEY]: wire });
  await restoreOffscreenFetchFaults();
  changed?.({ other: {} }, 'local');
  changed?.({ [KEY]: {} }, 'sync');
  void fetch(URL_SYNC);
  expect(nativeFetch).not.toHaveBeenCalled();
  expect(Reflect.get(globalThis, '__E2E_NET_FAULT_HITS')).toEqual({ discovery: 1 });
});

it.each([
  ['null', null],
  ['object', {}],
  ['null entry', [null]],
  ['missing id', [{ host: ':57291', mode: 'hang' }]],
  ['empty host', [{ ...wire[0], host: '' }]],
  ['invalid mode', [{ ...wire[0], mode: 'unsupported' }]],
  ['non-string path', [{ ...wire[0], path: 1 }]],
  ['non-number count', [{ ...wire[0], count: '1' }]],
  ['NaN count', [{ ...wire[0], count: NaN }]],
  ['infinite delay', [{ ...wire[0], delayMs: Infinity }]],
  ['negative retry', [{ ...wire[0], retryAfterSec: -1 }]]
])('refuses malformed persisted policy: %s', async (_label, value) => {
  get.mockResolvedValue({ [KEY]: value });
  await expect(restoreOffscreenFetchFaults()).rejects.toThrow('Invalid persisted offscreen fetch faults');
  expect(globalThis.fetch).toBe(nativeFetch);
});

it('rejects an unreadable policy instead of starting unfaulted', async () => {
  get.mockRejectedValue(new Error('storage unavailable'));
  await expect(restoreOffscreenFetchFaults()).rejects.toThrow('storage unavailable');
  expect(globalThis.fetch).toBe(nativeFetch);
});

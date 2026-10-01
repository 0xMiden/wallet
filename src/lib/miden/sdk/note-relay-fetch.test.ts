/** @jest-environment node */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import { normalizeNoteRelayFetch } from './note-relay-fetch.mjs';

const sdkRoot = resolve(__dirname, '../../../../node_modules/@miden-sdk/miden-sdk');
// `--check` proves all six inlined copies byte for byte; this one runs both fetch bindings.
const seamBundle = 'dist/mt/workers/web-client-methods-worker.js';
const sendUrl = 'https://transport.miden.io/miden_note_transport.MidenNoteTransport/SendNote';
const duplicateMessage =
  'Failed to store note: ConstraintViolation("Unique constraint violation: UNIQUE constraint failed: notes.id")';

const repoRoot = resolve(__dirname, '../../../..');
const generator = 'scripts/generate-note-relay-patch.mjs';
const patchFile = 'patches/@miden-sdk+miden-sdk+0.16.1.patch';
// A linked web-sdk build (`Web SDK PR: #N`) swaps in a `file:` source build that carries no relay patch.
const linkedSdk = String(
  JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).dependencies['@miden-sdk/miden-sdk']
).startsWith('file:');
const withInstalledPatch = linkedSdk ? describe.skip : describe;

withInstalledPatch('generate-note-relay-patch --check', () => {
  it('verifies the installed patch and all six inlined copies against the canonical helper', () => {
    const script = resolve(repoRoot, generator);
    expect(execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8' })).toContain(
      'verified for 6 bundles'
    );
  });

  const sdkPath = 'node_modules/@miden-sdk/miden-sdk';
  const relayBundles: string[] = JSON.parse(readFileSync(resolve(repoRoot, 'scripts/note-relay-bundles.json'), 'utf8'));
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'note-relay-check-'));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /**
   * The script resolves the repository from its own location, so a copy of it runs against
   * this scratch root: the SDK is linked from node_modules, or copied so a test can edit it.
   */
  function scratchRepo(sdk: 'link' | 'copy'): void {
    const inputs = [generator, 'scripts/note-relay-bundles.json', 'src/lib/miden/sdk/note-relay-fetch.mjs'];
    for (const path of [...inputs, 'package.json', patchFile]) {
      mkdirSync(dirname(join(scratch, path)), { recursive: true });
      copyFileSync(resolve(repoRoot, path), join(scratch, path));
    }
    mkdirSync(dirname(join(scratch, sdkPath)), { recursive: true });
    if (sdk === 'link') {
      symlinkSync(resolve(repoRoot, sdkPath), join(scratch, sdkPath));
      return;
    }
    for (const path of ['package.json', ...relayBundles]) {
      mkdirSync(dirname(join(scratch, sdkPath, path)), { recursive: true });
      copyFileSync(resolve(repoRoot, sdkPath, path), join(scratch, sdkPath, path));
    }
  }

  const runScratch = (...args: string[]) =>
    execFileSync(process.execPath, [join(scratch, generator), ...args], { encoding: 'utf8', stdio: 'pipe' });

  function editJson(path: string, edit: (json: Record<string, Record<string, string>>) => void): void {
    const json = JSON.parse(readFileSync(join(scratch, path), 'utf8'));
    edit(json);
    writeFileSync(join(scratch, path), JSON.stringify(json, null, 2));
  }
  // What the linked-SDK action leaves behind: a `file:` dependency on a source build.
  const linkScratchSdk = () =>
    editJson('package.json', json => {
      json.dependencies!['@miden-sdk/miden-sdk'] = 'file:../web-sdk/crates/web-client';
    });
  const setScratchSdkVersion = (version: string) =>
    editJson(`${sdkPath}/package.json`, json => {
      Object.assign(json, { version });
    });
  const scratchBytes = () =>
    [patchFile, ...relayBundles.map(bundle => `${sdkPath}/${bundle}`)].map(path =>
      readFileSync(join(scratch, path), 'utf8')
    );

  it('never runs the host diff, whose output differs between GNU and BSD', () => {
    // A `diff` that always fails: check mode must not need one.
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'diff'), '#!/bin/sh\nexit 2\n');
    chmodSync(join(bin, 'diff'), 0o755);
    const output = execFileSync(process.execPath, [resolve(repoRoot, generator), '--check'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: bin }
    });
    expect(output).toContain('verified for 6 bundles');
  });

  it('rejects a committed patch that touches a file outside the six bundles', () => {
    scratchRepo('link');
    const extra = `${sdkPath}/dist/st/index.js`;
    writeFileSync(
      join(scratch, patchFile),
      `${readFileSync(resolve(repoRoot, patchFile), 'utf8')}diff --git a/${extra} b/${extra}\n--- a/${extra}\n+++ b/${extra}\n@@ -1 +1 @@\n-a\n+b\n`
    );
    expect(() => runScratch('--check')).toThrow(/unexpected file.*dist\/st\/index\.js/);
  });

  it('names both remedies when an installed bundle lacks the patch', () => {
    scratchRepo('copy');
    const bundle = join(scratch, sdkPath, relayBundles[0]!);
    writeFileSync(
      bundle,
      readFileSync(bundle, 'utf8').replace(
        'const ret = normalizeNoteRelayFetch(arg1, arg2, arg0.fetch(arg1, arg2));',
        'const ret = arg0.fetch(arg1, arg2);'
      )
    );
    expect(() => runScratch('--check')).toThrow(/npx patch-package.*generate-note-relay-patch\.mjs/s);
  });

  it('skips a linked SDK build, which carries no relay patch', () => {
    scratchRepo('copy');
    linkScratchSdk();
    setScratchSdkVersion('0.17.0-rc.1');
    expect(runScratch('--check')).toContain('Linked SDK build');
  });

  it('refuses to generate the patch against a linked SDK build, and writes nothing', () => {
    scratchRepo('copy');
    linkScratchSdk();
    const before = scratchBytes();
    expect(() => runScratch()).toThrow(/linked SDK build/);
    expect(scratchBytes()).toEqual(before);
  });

  it('still refuses a published SDK at another version', () => {
    scratchRepo('copy');
    setScratchSdkVersion('0.17.0-rc.1');
    expect(() => runScratch('--check')).toThrow(/requires SDK 0\.16\.1, found 0\.17\.0-rc\.1/);
  });

  it('still refuses a published SDK whose patch file is missing', () => {
    scratchRepo('link');
    rmSync(join(scratch, patchFile));
    expect(() => runScratch('--check')).toThrow(/miden-sdk\+0\.16\.1\.patch/);
  });

  it('runs on every build, after the yarn.lock integrity check', () => {
    const { scripts }: { scripts: Record<string, string> } = JSON.parse(
      readFileSync(resolve(repoRoot, 'package.json'), 'utf8')
    );
    expect(scripts['check:deps']).toBe(
      'yarn check --integrity --production=false && node scripts/generate-note-relay-patch.mjs --check'
    );
    for (const name of [
      'prebuild',
      'prebuild:bg',
      'prebuild:cs',
      'prebuild:ext',
      'prebuild:mobile',
      'prebuild:desktop'
    ]) {
      expect(scripts[name]).toContain('yarn -s check:deps');
    }
  });
});

// The deployed transport's `grpc-message` header for a SendNote it already stores, verbatim.
const deployedDuplicateHeader =
  'Failed%20to%20store%20note:%20ConstraintViolation(%22Unique%20constraint%20violation:%20UNIQUE%20constraint%20failed:%20notes.id%22)';

/** A trailers-only gRPC-web response, which is how tonic sends an error: status and message in the headers. */
function headersOnly(status: string, message: string | null, headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(), {
    headers: {
      'content-type': 'application/grpc-web+proto',
      'grpc-status': status,
      ...(message === null ? {} : { 'grpc-message': encodeURIComponent(message) }),
      ...headers
    }
  });
}

function trailer(status: number, message: string): Uint8Array<ArrayBuffer> {
  const content = new TextEncoder().encode(
    `grpc-status: ${status}\r\ngrpc-message: ${encodeURIComponent(message)}\r\n`
  );
  const frame = new Uint8Array(content.length + 5);
  frame[0] = 128;
  new DataView(frame.buffer).setUint32(1, content.length);
  frame.set(content, 5);
  return frame;
}

function sdkFetch(bundle: string, fetchImpl: typeof fetch, receiver: boolean) {
  const source = readFileSync(resolve(sdkRoot, bundle), 'utf8');
  const name = receiver ? '__wbg_fetch_c97461e1e8f610cd' : '__wbg_fetch_da370f859548acb0';
  const binding = source.match(new RegExp(`${name}: (function\\([^]*?\\n        })`))?.[1];
  if (!binding) throw new Error(`Missing SDK fetch binding: ${bundle}`);
  const helper = source.match(/\/\/ BEGIN note-relay-fetch\n([^]*?)\/\/ END note-relay-fetch/)?.[1] ?? '';
  const invoke: (
    input: Request | { fetch: typeof fetch },
    init: RequestInit | Request,
    options?: RequestInit
  ) => Promise<Response> = runInNewContext(`${helper}\n(${binding});`, {
    fetch: fetchImpl,
    Response,
    Headers,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    DataView,
    URL
  });
  return (request: Request, init: RequestInit) =>
    receiver ? invoke({ fetch: fetchImpl }, request, init) : invoke(request, init);
}

withInstalledPatch('SDK SendNote fetch boundary', () => {
  it.each([false, true])('turns the stored-note duplicate into a unary ACK (receiver fetch: %s)', async receiver => {
    const original = headersOnly('13', duplicateMessage);
    const request = new Request(sendUrl, { method: 'POST', body: new Uint8Array([0, 0, 0, 0, 0]) });
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const invoke = sdkFetch(
      seamBundle,
      async (input, init) => {
        expect(input).toBe(request);
        expect(init).toBe(options);
        return original;
      },
      receiver
    );
    const response = await invoke(request, options);
    expect(response.headers.get('grpc-status')).toBe('0');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.subarray(0, 5))).toEqual([0, 0, 0, 0, 0]);
    expect(new TextDecoder().decode(bytes)).toContain('grpc-status: 0');
  });
});

describe('normalizeNoteRelayFetch', () => {
  const post = { method: 'POST' };
  const inspected: Array<{ original: Response; clone: jest.SpyInstance }> = [];

  // Its log lines have their own suite below.
  beforeEach(() => {
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  // The helper never reads a body: tonic takes a header status without one.
  afterEach(() => {
    const read = inspected.splice(0).some(({ original, clone }) => clone.mock.calls.length > 0 || original.bodyUsed);
    jest.restoreAllMocks();
    if (read) throw new Error('The helper read a response body');
  });

  // Defaults to a POST to SendNote; an explicit `undefined` options argument is kept.
  async function normalize(
    original: Response,
    ...call: [request: RequestInfo | URL, options: RequestInit | undefined] | []
  ): Promise<Response> {
    const [request, options] = call.length === 0 ? [sendUrl, post] : call;
    inspected.push({ original, clone: jest.spyOn(original, 'clone') });
    return normalizeNoteRelayFetch(request, options, Promise.resolve(original));
  }

  it('acknowledges the duplicate exactly as the deployed transport sends it', async () => {
    const original = new Response(new Uint8Array(), {
      headers: {
        'content-type': 'application/grpc-web+proto',
        'grpc-status': '13',
        'grpc-message': deployedDuplicateHeader,
        'content-length': '0'
      }
    });
    const response = await normalize(original);
    expect(response).not.toBe(original);
    expect(response.headers.get('grpc-status')).toBe('0');
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
      0, 0, 0, 0, 0, 128, 0, 0, 0, 16, 103, 114, 112, 99, 45, 115, 116, 97, 116, 117, 115, 58, 32, 48, 13, 10
    ]);
  });

  it.each([
    ['13', duplicateMessage],
    ['13', 'Failed to store note: ConstraintViolation("UNIQUE constraint failed: notes.id")'],
    ['6', 'Note already exists'],
    ['6', 'Some entity that we attempted to create already exists'],
    ['6', ''],
    ['6', null]
  ])('acknowledges status %s with message %p', async (status, message) => {
    const response = await normalize(headersOnly(status, message));
    expect(response.headers.get('grpc-status')).toBe('0');
  });

  it('acknowledges a transport endpoint behind a path prefix', async () => {
    const prefixed = 'https://proxy.example/ntl/miden_note_transport.MidenNoteTransport/SendNote';
    const response = await normalize(headersOnly('13', duplicateMessage), prefixed, post);
    expect(response.headers.get('grpc-status')).toBe('0');
  });

  it('keeps trace metadata and drops the error and encoding headers from the synthesized ACK', async () => {
    const original = headersOnly('13', duplicateMessage, {
      'content-length': '0',
      'content-encoding': 'gzip',
      'grpc-encoding': 'gzip',
      'grpc-status-details-bin': 'AAAA',
      'x-request-id': 'trace'
    });
    const response = await normalize(original);
    expect(response.headers.get('x-request-id')).toBe('trace');
    for (const name of [
      'grpc-message',
      'content-length',
      'content-encoding',
      'grpc-encoding',
      'grpc-status-details-bin'
    ]) {
      expect(response.headers.has(name)).toBe(false);
    }
  });

  // Only a message naming `notes.id` proves the note is stored: `seq` is the table's
  // autoincrement key, and the service funnels every constraint kind through one
  // `ConstraintViolation` variant, so a NOT NULL or foreign-key failure on the same
  // column means nothing was stored.
  it.each([
    ['13', 'Failed to store note: ConstraintViolation(Unique constraint violation)'],
    ['13', 'Failed to store note: ConstraintViolation("Unique constraint violation")'],
    [
      '13',
      'Failed to store note: ConstraintViolation(Unique constraint violation: UNIQUE constraint failed: notes.id)'
    ],
    [
      '13',
      'Failed to store note: ConstraintViolation("Unique constraint violation: UNIQUE constraint failed: notes.id\')'
    ],
    [
      '13',
      'Failed to store note: ConstraintViolation("Unique constraint violation: UNIQUE constraint failed: notes.seq")'
    ],
    [
      '13',
      'Failed to store note: ConstraintViolation("Not null constraint violation: NOT NULL constraint failed: notes.id")'
    ],
    [
      '13',
      'Failed to store note: ConstraintViolation("Foreign key constraint violation: FOREIGN KEY constraint failed: notes.id")'
    ],
    [
      '13',
      'Failed to store note: ConstraintViolation("Unique constraint violation: UNIQUE constraint failed: tags.id")'
    ],
    ['13', `${duplicateMessage}, another error`],
    ['13', `${duplicateMessage}\n`],
    ['13', `Retry: ${duplicateMessage}`],
    ['13', 'ConstraintViolation("UNIQUE constraint failed: notes.seq")'],
    ['13', 'ConstraintViolation("NOT NULL constraint failed: notes.id")'],
    ['13', 'ConstraintViolation("FOREIGN KEY constraint failed: notes.id")'],
    ['13', 'Some entity that we attempted to create already exists'],
    ['13', 'account ID prefix already exists in the tree'],
    ['13', 'the non-fungible asset already exists in the asset vault'],
    ['13', 'ConstraintError: Key already exists in the object store'],
    ['13', 'ConstraintViolation'],
    ['13', 'retried after grpc-status: 6; actual grpc-status: 13 internal'],
    ['13', 'UNIQUE constraint failed: tags.id'],
    ['13', 'UNIQUE constraint failed: tags.id - while storing the row that carries notes.id and its metadata blob'],
    ['13', 'storage unavailable'],
    ['7', duplicateMessage],
    ['14', duplicateMessage],
    ['0', '']
  ])('preserves status %s with message %p', async (status, message) => {
    const original = headersOnly(status, message);
    expect(await normalize(original)).toBe(original);
  });

  it.each(['6', '13'])('preserves status %s with a grpc-message that cannot be percent-decoded', async status => {
    const original = new Response(new Uint8Array(), {
      headers: { 'content-type': 'application/grpc-web+proto', 'grpc-status': status, 'grpc-message': '%zz' }
    });
    expect(await normalize(original)).toBe(original);
  });

  it('leaves a status carried only in the body trailer untouched, unread', async () => {
    const original = new Response(trailer(13, duplicateMessage), {
      headers: { 'content-type': 'application/grpc-web+proto' }
    });
    expect(await normalize(original)).toBe(original);
  });

  it.each([
    ['another RPC', sendUrl.replace('/SendNote', '/FetchNotes'), post, 200, 'application/grpc-web+proto'],
    ['a suffix after SendNote', `${sendUrl}/extra`, post, 200, 'application/grpc-web+proto'],
    ['a longer final segment', `${sendUrl}s`, post, 200, 'application/grpc-web+proto'],
    [
      'a dotted prefix on the service',
      'https://transport.miden.io/x.miden_note_transport.MidenNoteTransport/SendNote',
      post,
      200,
      'application/grpc-web+proto'
    ],
    ['an invalid URL', '/miden_note_transport.MidenNoteTransport/SendNote', post, 200, 'application/grpc-web+proto'],
    ['a GET', sendUrl, { method: 'GET' }, 200, 'application/grpc-web+proto'],
    ['a default GET', sendUrl, undefined, 200, 'application/grpc-web+proto'],
    ['HTTP error', sendUrl, post, 503, 'application/grpc-web+proto'],
    ['another HTTP status', sendUrl, post, 206, 'application/grpc-web+proto'],
    ['JSON', sendUrl, post, 200, 'application/json'],
    ['empty content type', sendUrl, post, 200, ''],
    ['missing content type', sendUrl, post, 200, null],
    ['text gRPC', sendUrl, post, 200, 'application/grpc-web-text+proto']
  ])('leaves %s untouched without reading its body', async (_name, url, options, status, contentType) => {
    const headers: Record<string, string> = {
      'grpc-status': '13',
      'grpc-message': encodeURIComponent(duplicateMessage),
      ...(contentType === null ? {} : { 'content-type': contentType })
    };
    const original = new Response(new Uint8Array(), { status, headers });
    expect(await normalize(original, url, options)).toBe(original);
  });

  it('uses the Request method when options are absent', async () => {
    const response = await normalize(headersOnly('13', duplicateMessage), new Request(sendUrl, post), undefined);
    expect(response.headers.get('grpc-status')).toBe('0');
  });

  it('uses an explicit method override and accepts a URL object', async () => {
    const response = await normalize(headersOnly('13', duplicateMessage), new URL(sendUrl), { method: 'post' });
    expect(response.headers.get('grpc-status')).toBe('0');
    const other = headersOnly('13', duplicateMessage);
    expect(await normalize(other, new Request(sendUrl, post), { method: 'GET' })).toBe(other);
  });

  it('preserves the original fetch rejection', async () => {
    const aborted = new DOMException('Aborted', 'AbortError');
    await expect(normalizeNoteRelayFetch(sendUrl, post, Promise.reject(aborted))).rejects.toBe(aborted);
  });
});

describe('normalizeNoteRelayFetch logging', () => {
  const post = { method: 'POST' };
  let info: jest.SpyInstance;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['13', duplicateMessage],
    ['6', 'Note already exists']
  ])(
    'logs one info line naming status %s and the message when it acknowledges a duplicate',
    async (status, message) => {
      await normalizeNoteRelayFetch(sendUrl, post, Promise.resolve(headersOnly(status, message)));
      expect(info).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith('[noteRelay] SendNote duplicate acknowledged', { status, message });
      expect(warn).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['13', 'storage%20unavailable'],
    ['13', '%zz'],
    ['6', '%zz']
  ])('logs one warning with status %s and the raw message %p when it passes a rejection on', async (status, raw) => {
    const original = new Response(new Uint8Array(), {
      headers: { 'content-type': 'application/grpc-web+proto', 'grpc-status': status, 'grpc-message': raw }
    });
    expect(await normalizeNoteRelayFetch(sendUrl, post, Promise.resolve(original))).toBe(original);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[noteRelay] SendNote rejection left for the outbox to retry', {
      status,
      message: raw
    });
    expect(info).not.toHaveBeenCalled();
  });

  it.each([
    ['a FetchNotes rejection', sendUrl.replace('/SendNote', '/FetchNotes'), headersOnly('13', 'storage unavailable')],
    ['an unavailable SendNote', sendUrl, headersOnly('14', 'transport unavailable')],
    [
      'a SendNote success',
      sendUrl,
      new Response(trailer(0, ''), { headers: { 'content-type': 'application/grpc-web+proto' } })
    ]
  ])('stays silent for %s', async (_name, url, original) => {
    await normalizeNoteRelayFetch(url, post, Promise.resolve(original));
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

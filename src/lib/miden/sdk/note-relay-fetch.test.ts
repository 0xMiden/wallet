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
const bundles = [
  'dist/st/Cargo-aQznLgDn.js',
  'dist/st/workers/Cargo-aQznLgDn-C_gzj3-H.js',
  'dist/st/workers/web-client-methods-worker.js',
  'dist/mt/Cargo-B2P22_Kp.js',
  'dist/mt/workers/Cargo-B2P22_Kp-DiJZmkfy.js',
  'dist/mt/workers/web-client-methods-worker.js'
];
const sendUrl = 'https://transport.miden.io/miden_note_transport.MidenNoteTransport/SendNote';
const duplicateMessage =
  'Failed to store note: ConstraintViolation("Unique constraint violation: UNIQUE constraint failed: notes.id")';

const repoRoot = resolve(__dirname, '../../../..');
const generator = 'scripts/generate-note-relay-patch.mjs';
const patchFile = 'patches/@miden-sdk+miden-sdk+0.16.1.patch';

it('verifies the installed patch and all six inlined copies against the canonical helper', () => {
  const script = resolve(repoRoot, generator);
  expect(execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8' })).toContain('verified for 6 bundles');
});

describe('generate-note-relay-patch --check', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'note-relay-check-'));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

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
    // The script resolves the repository from its own location, so a copy of it runs
    // against a scratch root whose patch carries one extra file.
    for (const path of [generator, 'src/lib/miden/sdk/note-relay-fetch.mjs']) {
      mkdirSync(dirname(join(scratch, path)), { recursive: true });
      copyFileSync(resolve(repoRoot, path), join(scratch, path));
    }
    mkdirSync(join(scratch, 'node_modules/@miden-sdk'), { recursive: true });
    symlinkSync(
      resolve(repoRoot, 'node_modules/@miden-sdk/miden-sdk'),
      join(scratch, 'node_modules/@miden-sdk/miden-sdk')
    );
    const extra = 'node_modules/@miden-sdk/miden-sdk/dist/st/index.js';
    mkdirSync(join(scratch, 'patches'));
    writeFileSync(
      join(scratch, patchFile),
      `${readFileSync(resolve(repoRoot, patchFile), 'utf8')}diff --git a/${extra} b/${extra}\n--- a/${extra}\n+++ b/${extra}\n@@ -1 +1 @@\n-a\n+b\n`
    );
    expect(() =>
      execFileSync(process.execPath, [join(scratch, generator), '--check'], { encoding: 'utf8', stdio: 'pipe' })
    ).toThrow(/unexpected file.*dist\/st\/index\.js/);
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

describe.each(bundles)('SDK SendNote fetch boundary: %s', bundle => {
  it.each([false, true])('turns the stored-note duplicate into a unary ACK (receiver fetch: %s)', async receiver => {
    const original = headersOnly('13', duplicateMessage);
    const request = new Request(sendUrl, { method: 'POST', body: new Uint8Array([0, 0, 0, 0, 0]) });
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const invoke = sdkFetch(
      bundle,
      async (input, init) => {
        expect(input).toBe(request);
        expect(init).toBe(options);
        return original;
      },
      receiver
    );
    const response = await invoke(request, options);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toContain('grpc-status: 0');
    expect(Array.from(bytes.subarray(0, 5))).toEqual([0, 0, 0, 0, 0]);
    expect(response.headers.get('grpc-status')).toBe('0');
  });

  it('removes existing duplicate outbox entries after one sync while retaining a genuine failure', async () => {
    const outbox = new Set(['already-stored', 'consumed', 'unavailable']);
    const calls: string[] = [];
    const invoke = sdkFetch(
      bundle,
      async input => {
        if (!(input instanceof Request)) throw new Error('Expected SDK request');
        const noteId = await input.clone().text();
        calls.push(noteId);
        return headersOnly('13', noteId === 'unavailable' ? 'storage unavailable' : duplicateMessage);
      },
      true
    );
    const sync = async () => {
      for (const noteId of outbox) {
        const response = await invoke(new Request(sendUrl, { method: 'POST', body: noteId }), {});
        // Rust removes successes and persists every failure for the next sync.
        if (response.headers.get('grpc-status') === '0') outbox.delete(noteId);
      }
    };
    await sync();
    expect([...outbox]).toEqual(['unavailable']);
    await sync();
    expect(calls).toEqual(['already-stored', 'consumed', 'unavailable', 'unavailable']);
    expect([...outbox]).toEqual(['unavailable']);
  });
});

describe('normalizeNoteRelayFetch', () => {
  const post = { method: 'POST' };
  const inspected: Array<{ original: Response; clone: jest.SpyInstance }> = [];

  // The helper never reads a body: tonic takes a header status without one.
  afterEach(() => {
    for (const { original, clone } of inspected.splice(0)) {
      if (clone.mock.calls.length > 0 || original.bodyUsed) throw new Error('The helper read a response body');
    }
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

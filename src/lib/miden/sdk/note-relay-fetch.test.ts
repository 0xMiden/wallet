/** @jest-environment node */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const duplicateMessage = 'Failed to store note: ConstraintViolation(Unique constraint violation)';

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
    symlinkSync(resolve(repoRoot, 'node_modules/@miden-sdk/miden-sdk'), join(scratch, 'node_modules/@miden-sdk/miden-sdk'));
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

function trailer(status: number, message: string): Uint8Array<ArrayBuffer> {
  return trailerText(`grpc-status: ${status}\r\ngrpc-message: ${encodeURIComponent(message)}\r\n`);
}

function trailerText(text: string): Uint8Array<ArrayBuffer> {
  const content = new TextEncoder().encode(text);
  const frame = new Uint8Array(content.length + 5);
  frame[0] = 128;
  new DataView(frame.buffer).setUint32(1, content.length);
  frame.set(content, 5);
  return frame;
}

function joined(...frames: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(frames.reduce((length, frame) => length + frame.length, 0));
  let offset = 0;
  for (const frame of frames) {
    result.set(frame, offset);
    offset += frame.length;
  }
  return result;
}

function grpcResponse(body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}): Response {
  return new Response(body, { headers: { 'content-type': 'application/grpc-web+proto', ...headers } });
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
    const original = new Response(trailer(13, duplicateMessage), {
      headers: { 'content-type': 'application/grpc-web+proto' }
    });
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
        return grpcResponse(trailer(13, noteId === 'unavailable' ? 'storage unavailable' : duplicateMessage));
      },
      true
    );
    const sync = async () => {
      for (const noteId of outbox) {
        const response = await invoke(new Request(sendUrl, { method: 'POST', body: noteId }), {});
        const body = new TextDecoder().decode(await response.arrayBuffer());
        const status = /grpc-status: (\d+)\r\n/.exec(body)?.[1];
        // Rust removes successes and persists every failure for the next sync.
        if (status === '0') outbox.delete(noteId);
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

  it.each([
    [13, duplicateMessage],
    [13, 'Failed to store note: ConstraintViolation("Unique constraint violation")'],
    [13, "Failed to store note: ConstraintViolation('Unique constraint violation')"],
    [13, 'Failed to store note: ConstraintViolation(UNIQUE constraint failed: notes.id)'],
    [13, 'Failed to store note: ConstraintViolation("UNIQUE constraint failed: notes.id")'],
    [13, "Failed to store note: ConstraintViolation('UNIQUE constraint failed: notes.id')"],
    [6, 'Note already exists'],
    [6, 'note already exists.'],
    [6, 'Note already exists: 0xabcdef']
  ])('acknowledges only a stored-note rejection: status %s, %s', async (status, message) => {
    const original = grpcResponse(trailer(status, message));
    const response = await normalizeNoteRelayFetch(sendUrl, post, Promise.resolve(original));
    expect(response).not.toBe(original);
    expect(response.headers.get('grpc-status')).toBe('0');
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
      0, 0, 0, 0, 0, 128, 0, 0, 0, 16, 103, 114, 112, 99, 45, 115, 116, 97, 116, 117, 115, 58, 32, 48, 13, 10
    ]);
    expect(original.bodyUsed).toBe(false);
  });

  it.each(['headers', 'trailers', 'both'])('accepts duplicate metadata in %s', async location => {
    const headers: Record<string, string> =
      location === 'trailers' ? {} : { 'grpc-status': '13', 'grpc-message': encodeURIComponent(duplicateMessage) };
    const body = location === 'headers' ? new Uint8Array() : trailer(13, duplicateMessage);
    const response = await normalizeNoteRelayFetch(sendUrl, post, Promise.resolve(grpcResponse(body, headers)));
    expect(response.headers.get('grpc-status')).toBe('0');
  });

  it('accepts an empty response frame followed by the duplicate trailer', async () => {
    const response = await normalizeNoteRelayFetch(
      sendUrl,
      post,
      Promise.resolve(grpcResponse(joined(new Uint8Array(5), trailer(13, duplicateMessage))))
    );
    expect(response.headers.get('grpc-status')).toBe('0');
  });

  it('preserves trace metadata and removes encoding and error headers from the synthesized ACK', async () => {
    const original = grpcResponse(trailer(13, duplicateMessage), {
      'grpc-status': '13',
      'grpc-message': encodeURIComponent(duplicateMessage),
      'content-length': '100',
      'content-encoding': 'gzip',
      'grpc-encoding': 'gzip',
      'x-request-id': 'trace'
    });
    const response = await normalizeNoteRelayFetch(sendUrl, post, Promise.resolve(original));
    expect(response.headers.get('x-request-id')).toBe('trace');
    for (const name of ['grpc-message', 'content-length', 'content-encoding', 'grpc-encoding']) {
      expect(response.headers.has(name)).toBe(false);
    }
  });

  it.each([
    [13, 'Unique constraint violation'],
    [13, 'Failed to store note: ConstraintViolation(UNIQUE constraint failed: accounts.id)'],
    [13, 'Failed to store note: ConstraintViolation("Unique constraint violation\')'],
    [13, 'Failed to store note: ConstraintViolation(Unique constraint violation), another error'],
    [6, 'already exists'],
    [6, 'Account already exists'],
    [6, 'Account for note already exists'],
    [6, duplicateMessage],
    [13, 'Note already exists'],
    [13, `${duplicateMessage}\n`],
    [13, `${duplicateMessage}\r`],
    [6, 'Note already exists\n'],
    [6, 'Note already exists\r'],
    [7, duplicateMessage],
    [0, '']
  ])('preserves other statuses and messages: %s, %s', async (status, message) => {
    const body = trailer(status, message);
    const original = grpcResponse(body);
    expect(await normalizeNoteRelayFetch(sendUrl, post, Promise.resolve(original))).toBe(original);
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(body);
  });

  it.each([
    ['another RPC', sendUrl.replace('/SendNote', '/FetchNotes'), post, 200, 'application/grpc-web+proto'],
    ['a suffix after SendNote', `${sendUrl}/extra`, post, 200, 'application/grpc-web+proto'],
    ['an invalid URL', '/SendNote', post, 200, 'application/grpc-web+proto'],
    ['a GET', sendUrl, { method: 'GET' }, 200, 'application/grpc-web+proto'],
    ['a default GET', sendUrl, undefined, 200, 'application/grpc-web+proto'],
    ['HTTP error', sendUrl, post, 503, 'application/grpc-web+proto'],
    ['another HTTP status', sendUrl, post, 206, 'application/grpc-web+proto'],
    ['JSON', sendUrl, post, 200, 'application/json'],
    ['empty content type', sendUrl, post, 200, ''],
    ['missing content type', sendUrl, post, 200, null],
    ['text gRPC', sendUrl, post, 200, 'application/grpc-web-text+proto']
  ])('leaves %s untouched without reading its body', async (_name, url, options, status, contentType) => {
    const headers: Record<string, string> = contentType === null ? {} : { 'content-type': contentType };
    const original = new Response(trailer(13, duplicateMessage), { status, headers });
    const clone = jest.spyOn(original, 'clone');
    expect(await normalizeNoteRelayFetch(url, options, Promise.resolve(original))).toBe(original);
    expect(clone).not.toHaveBeenCalled();
    expect(original.bodyUsed).toBe(false);
  });

  it('uses the Request method when options are absent', async () => {
    const original = grpcResponse(trailer(13, duplicateMessage));
    const response = await normalizeNoteRelayFetch(new Request(sendUrl, post), undefined, Promise.resolve(original));
    expect(response.headers.get('grpc-status')).toBe('0');
  });

  it('uses an explicit method override and accepts a URL object', async () => {
    const original = grpcResponse(trailer(13, duplicateMessage));
    const response = await normalizeNoteRelayFetch(new URL(sendUrl), { method: 'post' }, Promise.resolve(original));
    expect(response.headers.get('grpc-status')).toBe('0');
    const other = grpcResponse(trailer(13, duplicateMessage));
    expect(await normalizeNoteRelayFetch(new Request(sendUrl, post), { method: 'GET' }, Promise.resolve(other))).toBe(
      other
    );
  });

  it.each(['0', '7', '13, 13', ''])('does not read a body with unrelated header status %s', async status => {
    const original = grpcResponse(trailer(13, duplicateMessage), { 'grpc-status': status });
    const clone = jest.spyOn(original, 'clone');
    expect(await normalizeNoteRelayFetch(sendUrl, post, Promise.resolve(original))).toBe(original);
    expect(clone).not.toHaveBeenCalled();
  });

  const contradictoryHeaders: Record<string, string>[] = [
    { 'grpc-status': '6' },
    { 'grpc-status': '13', 'grpc-message': 'another%20error' }
  ];
  it.each(contradictoryHeaders)('preserves contradictory header and trailer metadata: %s', async headers => {
    const original = grpcResponse(trailer(13, duplicateMessage), headers);
    expect(await normalizeNoteRelayFetch(sendUrl, post, Promise.resolve(original))).toBe(original);
  });

  it.each([
    ['truncated header', new Uint8Array([128, 0, 0, 0])],
    ['truncated trailer', trailer(13, duplicateMessage).slice(0, -1)],
    ['repeated trailer', joined(trailer(13, duplicateMessage), trailer(13, duplicateMessage))],
    ['data after trailer', joined(trailer(13, duplicateMessage), new Uint8Array(5))],
    ['compressed frame', joined(new Uint8Array([1, 0, 0, 0, 0]), trailer(13, duplicateMessage))],
    ['nonempty data frame', joined(new Uint8Array([0, 0, 0, 0, 1, 1]), trailer(13, duplicateMessage))],
    ['multiple unary frames', joined(new Uint8Array(10), trailer(13, duplicateMessage))],
    ['missing trailer', new Uint8Array(5)],
    ['missing status', trailerText(`grpc-message: ${encodeURIComponent(duplicateMessage)}\r\n`)],
    ['bad header syntax', trailerText('grpc-status: 13\r\ngrpc-message broken\r\n')],
    ['repeated status', trailerText('grpc-status: 13\r\ngrpc-status: 13\r\n')],
    ['unterminated trailer', trailerText(`grpc-status: 13\r\ngrpc-message: ${encodeURIComponent(duplicateMessage)}`)],
    ['invalid percent encoding', trailerText('grpc-status: 13\r\ngrpc-message: %zz\r\n')],
    [
      'UTF-8 BOM before trailer metadata',
      trailerText(`\ufeffgrpc-status: 13\r\ngrpc-message: ${encodeURIComponent(duplicateMessage)}\r\n`)
    ],
    [
      'NUL in metadata',
      trailerText(`grpc-status: 13\r\ngrpc-message: ${encodeURIComponent(duplicateMessage)}\r\nx-custom: x\u0000x\r\n`)
    ],
    [
      'DEL in metadata',
      trailerText(`grpc-status: 13\r\ngrpc-message: ${encodeURIComponent(duplicateMessage)}\r\nx-custom: x\u007fx\r\n`)
    ],
    [
      'bare CR in metadata',
      trailerText(`grpc-status: 13\r\ngrpc-message: ${encodeURIComponent(duplicateMessage)}\r\nx-custom: x\r\r\n`)
    ],
    [
      'noncanonical status',
      trailerText(`grpc-status: 013\r\ngrpc-message: ${encodeURIComponent(duplicateMessage)}\r\n`)
    ],
    ['invalid UTF-8', new Uint8Array([128, 0, 0, 0, 3, 255, 13, 10])]
  ])('preserves malformed gRPC-web responses: %s', async (_name, body) => {
    const original = grpcResponse(body);
    const response = await normalizeNoteRelayFetch(sendUrl, post, Promise.resolve(original));
    expect(response === original).toBe(true);
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(body);
  });

  it('preserves a trailer exceeding the Rust parser capacity of 64 headers', async () => {
    const metadata = Array.from({ length: 63 }, (_, index) => `x-${index}: value\r\n`).join('');
    const body = trailerText(`grpc-status: 13\r\ngrpc-message: ${encodeURIComponent(duplicateMessage)}\r\n${metadata}`);
    const original = grpcResponse(body);
    expect((await normalizeNoteRelayFetch(sendUrl, post, Promise.resolve(original))) === original).toBe(true);
  });

  it('allows 64 valid trailer headers', async () => {
    const metadata = Array.from({ length: 62 }, (_, index) => `x-${index}: value\r\n`).join('');
    const body = trailerText(`grpc-status: 13\r\ngrpc-message: ${encodeURIComponent(duplicateMessage)}\r\n${metadata}`);
    const response = await normalizeNoteRelayFetch(sendUrl, post, Promise.resolve(grpcResponse(body)));
    expect(response.headers.get('grpc-status')).toBe('0');
  });

  it.each(['headers', 'trailers'])('preserves binary status details in %s', async location => {
    const body =
      location === 'headers'
        ? trailer(13, duplicateMessage)
        : trailerText(
            `grpc-status: 13\r\ngrpc-message: ${encodeURIComponent(duplicateMessage)}\r\ngrpc-status-details-bin: %%%\r\n`
          );
    const headers: Record<string, string> = location === 'headers' ? { 'grpc-status-details-bin': '%%%' } : {};
    const original = grpcResponse(body, headers);
    expect((await normalizeNoteRelayFetch(sendUrl, post, Promise.resolve(original))) === original).toBe(true);
  });

  it('preserves the original fetch rejection', async () => {
    const aborted = new DOMException('Aborted', 'AbortError');
    await expect(normalizeNoteRelayFetch(sendUrl, post, Promise.reject(aborted))).rejects.toBe(aborted);
  });

  it('allows tabs in valid metadata values', async () => {
    const body = trailerText(
      `grpc-status:\t13\r\ngrpc-message: ${encodeURIComponent(duplicateMessage)}\r\nx-custom:\tx\tx\r\n`
    );
    const response = await normalizeNoteRelayFetch(sendUrl, post, Promise.resolve(grpcResponse(body)));
    expect(response.headers.get('grpc-status')).toBe('0');
  });

  it('preserves an unreadable body and its failure', async () => {
    const failure = new Error('body stream failed');
    const original = new Response(new ReadableStream({ start: controller => controller.error(failure) }), {
      headers: { 'content-type': 'application/grpc-web+proto' }
    });
    expect(await normalizeNoteRelayFetch(sendUrl, post, Promise.resolve(original))).toBe(original);
    await expect(original.arrayBuffer()).rejects.toBe(failure);
  });
});

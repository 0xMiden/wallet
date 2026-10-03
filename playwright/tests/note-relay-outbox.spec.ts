import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { resolve, sep } from 'node:path';

// The real SDK WASM, with the relay patch postinstall applied, against a transport that answers
// SDK 0.17's SendNoteWithProof with the old duplicate error. The 0.17 transport answers a
// duplicate OK, so this stands for one that still sends that error, which the patch acknowledges.
// The client's one RPC (the genesis header) is replayed from a recording, so nothing leaves the machine.
const sdkRoot = resolve(__dirname, '../../node_modules/@miden-sdk/miden-sdk');
const rpcFixture = resolve(__dirname, '../fixtures/note-relay-rpc.json');
// A linked web-sdk build (`Web SDK PR: #N`) swaps in a `file:` source build that carries no relay patch.
const linkedSdk = String(
  JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')).dependencies['@miden-sdk/miden-sdk']
).startsWith('file:');

// The pre-0.17 transport's `grpc-message` header for a SendNote it already stores, verbatim.
const DUPLICATE =
  'Failed%20to%20store%20note:%20ConstraintViolation(%22Unique%20constraint%20violation:%20UNIQUE%20constraint%20failed:%20notes.id%22)';
const GENUINE_FAILURE =
  'Failed%20to%20store%20note:%20ConstraintViolation(%22Not%20null%20constraint%20violation:%20NOT%20NULL%20constraint%20failed:%20notes.tag%22)';

// The SDK's outbox row holding this one private note and its mock proof, under the pinned SDK 0.17.0-rc.5.
const ONE_ENTRY_BYTES = 284;

type OutboxRun = { seeded: number; afterFirstSync: number; afterSecondSync: number; sendCalls: number };

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>relay outbox</title>');
      return;
    }
    const file = resolve(sdkRoot, path.slice('/sdk/'.length));
    if (!path.startsWith('/sdk/') || !file.startsWith(`${sdkRoot}${sep}`)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(file);
      response.setHeader('content-type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No server address');
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise(done => server.close(done));
});

async function runOutbox(page: Page, rejection: string): Promise<OutboxRun> {
  const recording: unknown = JSON.parse(await readFile(rpcFixture, 'utf8'));
  await page.goto(origin);
  return page.evaluate(
    async ({ recording, rejection }) => {
      const nativeFetch = globalThis.fetch.bind(globalThis);
      const rpc = new Map<string, string>();
      if (Array.isArray(recording)) {
        for (const entry of recording) rpc.set(String(entry.path), String(entry.body));
      }
      const transport = 'https://relay.example.invalid';
      const storeName = `relay-outbox-${Math.random()}`;
      let firstSend = true;
      let sendCalls = 0;
      // A trailers-only response with an empty, non-null body, as a network fetch returns it.
      const headersOnly = (status: string, message: string) =>
        new Response(new Uint8Array(), {
          headers: { 'content-type': 'application/grpc-web+proto', 'grpc-status': status, 'grpc-message': message }
        });
      globalThis.fetch = async (request, options) => {
        const url = new URL(typeof request === 'string' ? request : 'url' in request ? request.url : request.href);
        if (url.origin === window.location.origin) return nativeFetch(request, options);
        if (url.hostname === 'rpc.testnet.miden.io') {
          const body = rpc.get(url.pathname);
          if (body === undefined) throw new Error(`Unrecorded RPC ${url.pathname}`);
          const bytes = Uint8Array.from(atob(body), character => character.charCodeAt(0));
          return new Response(bytes, { headers: { 'content-type': 'application/grpc-web+proto' } });
        }
        if (url.origin !== transport) throw new Error(`Unexpected fetch ${url.href}`);
        if (url.pathname.endsWith('/FetchNotes')) {
          // A FetchNotesResponse with no notes, then an OK trailer. Its cursor (field 2) is present but
          // empty, so nonce and sequence are zero: SDK 0.17 refuses a page without one.
          const trailer = new TextEncoder().encode('grpc-status: 0\r\n');
          const body = new Uint8Array(12 + trailer.length);
          body.set([0, 0, 0, 0, 2, 0x12, 0x00], 0);
          body[7] = 128;
          new DataView(body.buffer).setUint32(8, trailer.length);
          body.set(trailer, 12);
          return new Response(body, { headers: { 'content-type': 'application/grpc-web+proto' } });
        }
        if (!url.pathname.endsWith('/SendNoteWithProof')) throw new Error(`Unexpected transport call ${url.pathname}`);
        sendCalls++;
        if (firstSend) {
          firstSend = false;
          return headersOnly('14', 'transport%20unavailable');
        }
        return headersOnly('13', rejection);
      };

      const specifier = '/sdk/dist/st/index.js';
      const sdk = await import(specifier);
      await sdk.getWasmOrThrow();
      const client = await sdk.MidenClient.create({
        rpcUrl: 'https://rpc.testnet.miden.io',
        noteTransportUrl: transport,
        storeName,
        useWorker: false,
        autoSync: false
      });
      const recipient = '0xbb0000000000cc110000dd000000ee';
      const note = sdk.createP2IDNote({
        from: '0xaa0000000000bb110000cc000000dd',
        to: recipient,
        assets: [{ token: '0xaa0000000000bc110000bc000000de', amount: BigInt(1) }],
        type: 'private'
      });
      const readOutbox = async (): Promise<number> => {
        const db = await new Promise<IDBDatabase>((done, fail) => {
          const opening = indexedDB.open(storeName);
          opening.onsuccess = () => done(opening.result);
          opening.onerror = () => fail(opening.error);
        });
        try {
          const row = await new Promise<{ value?: ArrayBuffer } | undefined>((done, fail) => {
            const reading = db.transaction('settings').objectStore('settings').get([0, 'note_transport_outbox']);
            reading.onsuccess = () => done(reading.result);
            reading.onerror = () => fail(reading.error);
          });
          return row?.value?.byteLength ?? 0;
        } finally {
          db.close();
        }
      };

      // A relay that fails puts the note in the SDK's durable outbox. The fake transport checks no
      // proof, so the SDK's mock proof at the genesis block stands in for one a node would issue.
      await client.notes
        .sendPrivate({ note, to: recipient, inclusionProof: sdk.NoteInclusionProof.mockAtBlock(0) })
        .catch(() => undefined);
      const seeded = await readOutbox();
      await client.syncNoteTransport();
      const afterFirstSync = await readOutbox();
      await client.syncNoteTransport();
      const afterSecondSync = await readOutbox();
      client.terminate();
      return { seeded, afterFirstSync, afterSecondSync, sendCalls };
    },
    { recording, rejection }
  );
}

test.describe('SDK relay outbox, real WASM', () => {
  test.skip(linkedSdk, 'A linked web-sdk build carries no relay patch');
  test.setTimeout(120_000);

  test("the transport's duplicate response retires the entry, so the next sync sends nothing", async ({ page }) => {
    const run = await runOutbox(page, DUPLICATE);
    expect(run.seeded).toBe(ONE_ENTRY_BYTES);
    expect(run.afterFirstSync).toBe(0);
    expect(run.afterSecondSync).toBe(0);
    expect(run.sendCalls).toBe(2);
  });

  test('a genuine storage failure stays in the outbox and is sent again', async ({ page }) => {
    const run = await runOutbox(page, GENUINE_FAILURE);
    expect(run.seeded).toBe(ONE_ENTRY_BYTES);
    expect(run.afterFirstSync).toBe(run.seeded);
    expect(run.afterSecondSync).toBe(run.seeded);
    expect(run.sendCalls).toBe(3);
  });
});

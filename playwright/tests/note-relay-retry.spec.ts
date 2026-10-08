import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { resolve, sep } from 'node:path';

import { classifyRelayFailure } from '../../src/lib/miden/transaction/relay-failure';

// The real SDK WASM against a note transport whose replies the test chooses. It pins what the delivery
// sweep relies on: a failed send is retried only inside the call, as often as the client allows, and
// never again by the SDK, and its error text classifies the way the sweep expects. The client's one
// RPC (the genesis header) is replayed from a recording, so nothing leaves the machine.
const sdkRoot = resolve(__dirname, '../../node_modules/@miden-sdk/miden-sdk');
const rpcFixture = resolve(__dirname, '../fixtures/note-relay-rpc.json');

type Reply = 'unavailable' | 'invalidArgument' | 'throw';
type Relay = {
  rejected: boolean;
  message: string;
  sendCalls: number;
  sendCallsAfterSync: number;
  unknownNoteMessage: string;
};

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>relay retry</title>');
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

/** One private note send against a transport that always gives `reply`, then a transport sync. */
async function relay(page: Page, reply: Reply, maxRetries?: number): Promise<Relay> {
  const recording: unknown = JSON.parse(await readFile(rpcFixture, 'utf8'));
  await page.goto(origin);
  return page.evaluate(
    async ({ recording, reply, maxRetries }) => {
      const nativeFetch = globalThis.fetch.bind(globalThis);
      const rpc = new Map<string, string>();
      if (Array.isArray(recording)) {
        for (const entry of recording) rpc.set(String(entry.path), String(entry.body));
      }
      const transport = 'https://relay.example.invalid';
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
        if (reply === 'throw') throw new TypeError('Failed to fetch');
        return reply === 'unavailable'
          ? headersOnly('14', 'transport%20unavailable')
          : headersOnly('3', 'note%20is%20invalid');
      };

      const specifier = '/sdk/dist/st/index.js';
      const sdk = await import(specifier);
      await sdk.getWasmOrThrow();
      const client = await sdk.MidenClient.create({
        rpcUrl: 'https://rpc.testnet.miden.io',
        noteTransportUrl: transport,
        ...(maxRetries === undefined ? {} : { noteTransportMaxRetries: maxRetries }),
        storeName: `relay-retry-${Math.random()}`,
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
      // Read before the send, which takes the note by value and leaves this handle empty.
      const noteId = note.id().toString();
      const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

      // The fake transport checks no proof, so the SDK's mock proof at the genesis block stands in for
      // one a node would issue.
      let rejected = false;
      let message = '';
      await client.notes
        .sendPrivate({ note, to: recipient, inclusionProof: sdk.NoteInclusionProof.mockAtBlock(0) })
        .then(
          () => undefined,
          (error: unknown) => {
            rejected = true;
            message = messageOf(error);
          }
        );
      const sentBeforeSync = sendCalls;
      await client.syncNoteTransport();
      const sendCallsAfterSync = sendCalls - sentBeforeSync;
      // This note was built here, never by a transaction, so the store holds no output note for its id.
      const unknownNoteMessage = await client.notes
        .sendPrivateOutput({ noteId, to: recipient })
        .then(() => '', messageOf);
      client.terminate();
      return { rejected, message, sendCalls: sentBeforeSync, sendCallsAfterSync, unknownNoteMessage };
    },
    { recording, reply, maxRetries }
  );
}

test.describe('note transport retries, real WASM', () => {
  test.setTimeout(120_000);

  test("with the wallet's zero retries an unavailable transport gets one send, and a sync sends nothing", async ({
    page
  }) => {
    const run = await relay(page, 'unavailable', 0);
    expect(run.rejected).toBe(true);
    expect(run.sendCalls).toBe(1);
    expect(run.sendCallsAfterSync).toBe(0);
    expect(classifyRelayFailure(new Error(run.message)), run.message).toBe('outage');
    expect(classifyRelayFailure(new Error(run.unknownNoteMessage)), run.unknownNoteMessage).toBe('storeLoss');
  });

  test("with the SDK's default the same reply gets four sends", async ({ page }) => {
    const run = await relay(page, 'unavailable');
    expect(run.rejected).toBe(true);
    expect(run.sendCalls).toBe(4);
    expect(run.sendCallsAfterSync).toBe(0);
  });

  test("a fetch that throws gets one send even at the SDK's default", async ({ page }) => {
    const run = await relay(page, 'throw');
    expect(run.rejected).toBe(true);
    expect(run.sendCalls).toBe(1);
    expect(run.sendCallsAfterSync).toBe(0);
    expect(classifyRelayFailure(new Error(run.message)), run.message).toBe('outage');
  });

  test('a rejected request reads as a fault of the note, not of the transport', async ({ page }) => {
    const run = await relay(page, 'invalidArgument', 0);
    expect(run.rejected).toBe(true);
    expect(run.sendCalls).toBe(1);
    expect(classifyRelayFailure(new Error(run.message)), run.message).toBe('noteLocal');
  });
});

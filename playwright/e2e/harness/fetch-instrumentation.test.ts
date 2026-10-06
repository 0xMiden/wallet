/**
 * @jest-environment node
 */
import { installFetchInstrumentation, SW_FETCH_LOG_PREFIX } from './network-capture';
import { decodeSendNoteBase64 } from './transport-wire';
import { RECORDED_SEND_NOTE_WITH_PROOF_BASE64, RECORDED_SENT_NOTE } from './transport-wire.fixture';

/**
 * Runs the fetch wrapper that `attachServiceWorkerFetchCapture` ships into the service
 * worker and the SDK's workers. It is shipped as source text, so it carries its own
 * inline copies of the transport patterns, and `network-capture.test.ts` cannot see
 * them drift: only running the wrapper can. The SDK's gRPC-web transport calls
 * `fetch(request, { signal })`, so the body rides on the Request, as it does here.
 */

const SERVICE = 'miden.note_transport.v1.NoteTransportService';

const recordedBody = () => Uint8Array.from(Buffer.from(RECORDED_SEND_NOTE_WITH_PROOF_BASE64, 'base64'));

const reqBodyOf = (line: unknown): string | undefined =>
  typeof line === 'object' && line !== null && 'reqBody' in line && typeof line.reqBody === 'string'
    ? line.reqBody
    : undefined;

describe('installFetchInstrumentation - SDK 0.17 note-transport traffic', () => {
  const realFetch = globalThis.fetch;
  let fetchSpy: jest.SpyInstance | undefined;
  let logSpy: jest.SpyInstance | undefined;
  /** What the wrapped fetch itself received, so capture is shown not to eat the body. */
  let forwarded: Uint8Array[];

  /** The capture lines the wrapper logged, parsed. */
  const capturedLines = (): unknown[] =>
    (logSpy?.mock.calls ?? [])
      .map(([text]) => String(text))
      .filter(text => text.startsWith(SW_FETCH_LOG_PREFIX))
      .map((text): unknown => JSON.parse(text.slice(SW_FETCH_LOG_PREFIX.length)));

  beforeEach(() => {
    forwarded = [];
    Reflect.deleteProperty(globalThis, '__e2e_fetch_wrapped');
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (input instanceof Request) forwarded.push(new Uint8Array(await input.arrayBuffer()));
      return new Response(new Uint8Array(), { status: 200, headers: { 'content-type': 'application/grpc-web+proto' } });
    });
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    installFetchInstrumentation(SW_FETCH_LOG_PREFIX);
  });

  afterEach(() => {
    logSpy?.mockRestore();
    fetchSpy?.mockRestore();
    globalThis.fetch = realFetch;
    Reflect.deleteProperty(globalThis, '__e2e_fetch_wrapped');
  });

  it.each([
    ['the localnet transport host', 'http://127.0.0.1:57292'],
    ['a host no pattern lists', 'http://127.0.0.1:9999']
  ])('captures a push to %s as transport, with the note it carried', async (_, origin) => {
    const url = `${origin}/${SERVICE}/SendNoteWithProof`;

    const response = await fetch(new Request(url, { method: 'POST', body: recordedBody() }));

    expect(response.status).toBe(200);
    const lines = capturedLines();
    expect(lines).toEqual([expect.objectContaining({ url, method: 'POST', status: 200, category: 'transport' })]);
    expect(decodeSendNoteBase64(reqBodyOf(lines[0]))).toEqual([RECORDED_SENT_NOTE]);
    expect(forwarded).toEqual([recordedBody()]);
  });

  it('captures a 0.17 FetchNotes as transport but carries no body for it', async () => {
    const url = `http://127.0.0.1:9999/${SERVICE}/FetchNotes`;

    await fetch(new Request(url, { method: 'POST', body: recordedBody() }));

    const lines = capturedLines();
    expect(lines).toEqual([expect.objectContaining({ url, category: 'transport' })]);
    expect(reqBodyOf(lines[0])).toBeUndefined();
  });
});

/**
 * Tests for network-request classification.
 *
 * These pin the behaviour the service-worker wrapper's inline copy of these
 * patterns must also satisfy — it runs as source text inside `evaluate()` and so
 * cannot import them, which makes drift between the two silent by construction.
 * `fetch-instrumentation.test.ts` runs that inline copy itself.
 */

import { classifyUrl, isMidenRelated } from './network-capture';

const SERVICE = 'miden.note_transport.v1.NoteTransportService';
const SEND_NOTE = `${SERVICE}/SendNoteWithProof`;
const FETCH_NOTES = `${SERVICE}/FetchNotes`;

describe('classifyUrl — transport', () => {
  it('classifies the deployed transport host', () => {
    expect(classifyUrl(`https://transport.miden.io/${SEND_NOTE}`)).toBe('transport');
  });

  it('classifies localnet transport on 127.0.0.1', () => {
    // The regression this guards: localnet transport is configured as
    // `http://127.0.0.1:57292`, but the pattern named only `localhost:57292`, so
    // every localnet transport request was classified `other` and dropped.
    expect(classifyUrl(`http://127.0.0.1:57292/${SEND_NOTE}`)).toBe('transport');
    expect(isMidenRelated(`http://127.0.0.1:57292/${SEND_NOTE}`)).toBe(true);
  });

  it('classifies transport on an arbitrary host and port', () => {
    // `MIDEN_NOTE_TRANSPORT_URL` is a build-time override, so the endpoint can be
    // anything — a recorder, a proxy, a colleague's box. The service path is what
    // makes that work; a host list never could.
    expect(classifyUrl(`http://127.0.0.1:57392/${SEND_NOTE}`)).toBe('transport');
    expect(classifyUrl(`https://transport.staging.example.com/${SEND_NOTE}`)).toBe('transport');
  });

  it('classifies every transport RPC, not just the push', () => {
    expect(classifyUrl(`http://127.0.0.1:9999/${FETCH_NOTES}`)).toBe('transport');
  });

  it('classifies the transport path as transport even on an rpc host', () => {
    // A node can serve the transport beside `rpc.Api` on one host; the path must
    // win, or the push decode (gated on `transport`) never runs.
    expect(classifyUrl(`http://localhost:57291/${SEND_NOTE}`)).toBe('transport');
    expect(classifyUrl(`https://rpc.testnet.miden.io/${SEND_NOTE}`)).toBe('transport');
    expect(classifyUrl(`https://rpc.testnet.miden.io/${FETCH_NOTES}`)).toBe('transport');
    expect(classifyUrl('https://rpc.testnet.miden.io/rpc.Api/SubmitProvenTransaction')).toBe('rpc');
  });

  it.each([
    ["the pre-0.17 node's service", 'http://127.0.0.1:9999/note_transport.Api/SendNote', 'other'],
    [
      'the retired standalone service',
      'http://127.0.0.1:9999/miden_note_transport.MidenNoteTransport/FetchNotes',
      'other'
    ],
    ["the pre-0.17 node's service on an rpc host", 'https://rpc.testnet.miden.io/note_transport.Api/SendNote', 'rpc'],
    ['a dotted prefix on the service', `http://127.0.0.1:9999/x.${SEND_NOTE}`, 'other']
  ])('no longer singles out %s', (_, url, expected) => {
    // SDK 0.17 speaks only `miden.note_transport.v1.NoteTransportService`, so the old
    // names are ordinary paths now, classified by host like any other.
    expect(classifyUrl(url)).toBe(expected);
  });
});

describe('classifyUrl — other categories keep working', () => {
  it.each([
    ['https://rpc.testnet.miden.io/rpc.Api/SyncState', 'rpc'],
    ['http://localhost:57291/rpc.Api/SyncState', 'rpc'],
    ['http://127.0.0.1:57291/rpc.Api/SyncState', 'rpc'],
    ['https://tx-prover.testnet.miden.io/prove', 'prover'],
    ['http://localhost:50052/prove', 'prover'],
    ['http://127.0.0.1:50052/prove', 'prover']
  ])('classifies %s as %s', (url, expected) => {
    expect(classifyUrl(url)).toBe(expected);
  });
});

describe('classifyUrl — non-Miden traffic is still excluded', () => {
  it.each([
    'https://example.com/anything',
    'https://guardian-testnet.kodax.com/api/sign',
    'chrome-extension://abcdef/background.js'
  ])('leaves %s as other', url => {
    expect(classifyUrl(url)).toBe('other');
    expect(isMidenRelated(url)).toBe(false);
  });
});

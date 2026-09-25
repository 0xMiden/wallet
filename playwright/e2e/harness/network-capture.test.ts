/**
 * Tests for network-request classification.
 *
 * These pin the behaviour the service-worker wrapper's inline copy of these
 * patterns must also satisfy — it runs as source text inside `evaluate()` and so
 * cannot import them, which makes drift between the two silent by construction.
 */

import { classifyUrl, isMidenRelated } from './network-capture';

const SEND_NOTE = 'note_transport.Api/SendNote';
const LEGACY_SEND_NOTE = 'miden_note_transport.MidenNoteTransport/SendNote';

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

  it('classifies every transport RPC, not just SendNote', () => {
    expect(classifyUrl('http://127.0.0.1:9999/note_transport.Api/FetchNotes')).toBe('transport');
    expect(classifyUrl('http://127.0.0.1:9999/miden_note_transport.MidenNoteTransport/FetchNotes')).toBe('transport');
    expect(classifyUrl('http://127.0.0.1:9999/miden_note_transport.MidenNoteTransport/Stats')).toBe('transport');
  });

  it('still classifies the retired standalone service path, which remote hosts may lag behind', () => {
    expect(classifyUrl(`http://127.0.0.1:9999/${LEGACY_SEND_NOTE}`)).toBe('transport');
  });

  it('classifies the transport path as transport even on an rpc host', () => {
    // The node serves `note_transport.Api`, so it can share a host with `rpc.Api`;
    // the path must win, or the SendNote decode (gated on `transport`) never runs.
    expect(classifyUrl(`http://localhost:57291/${SEND_NOTE}`)).toBe('transport');
    expect(classifyUrl(`https://rpc.testnet.miden.io/${SEND_NOTE}`)).toBe('transport');
    expect(classifyUrl('https://rpc.testnet.miden.io/rpc.Api/SubmitProvenTransaction')).toBe('rpc');
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

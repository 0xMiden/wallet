import { OperationAbortedError } from 'lib/miden/back/offscreen-codec';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';

import { classifyRelayFailure, type RelayFailureClass } from './relay-failure';

/** The text a 0.17.2 send failure reaches JS with, for the given gRPC code. */
const sendFailure = (code: string) =>
  new Error(
    'failed sending private output note: note transport error: note transport network error: ' +
      `Send note with proof failed: Status { code: ${code}, message: "transport said no", ` +
      'metadata: MetadataMap { headers: {"content-type": "application/grpc-web+proto"} }, source: None }'
  );

describe('classifyRelayFailure', () => {
  const OFFSCREEN = "Offscreen call 'relayPrivateNoteById' failed: ";
  const SEND = 'failed sending private output note: note transport error: ';

  it.each<[string, RelayFailureClass]>([
    ['No output note found for the given id', 'storeLoss'],
    ['output note has no details to relay (recipient unknown): the note record is missing its details', 'storeLoss'],
    ['output note has no inclusion proof; sync past the block that committed it', 'noteLocal'],
    [
      SEND + 'note transport is disabled; enable it in the client configuration to send or receive notes via P2P',
      'notConfigured'
    ],
    [sendFailure('Unavailable').message, 'outage'],
    [sendFailure('DeadlineExceeded').message, 'outage'],
    [sendFailure('ResourceExhausted').message, 'outage'],
    [sendFailure('Cancelled').message, 'outage'],
    [sendFailure('Internal').message, 'outage'],
    [
      SEND +
        'note transport network error: Send note with proof failed: ' +
        'Status { code: Unknown, message: "JS API error: TypeError: Failed to fetch", ' +
        'source: Some(JsError("TypeError: Failed to fetch")) }',
      'outage'
    ],
    [sendFailure('InvalidArgument').message, 'noteLocal'],
    [sendFailure('FailedPrecondition').message, 'noteLocal'],
    [SEND + 'connection error: transport error', 'outage'],
    ['nothing this sweep has seen before', 'outage']
  ])('reads %p as %s, with or without the offscreen prefix', (message, expected) => {
    expect(classifyRelayFailure(new Error(message))).toBe(expected);
    expect(classifyRelayFailure(new Error(OFFSCREEN + message))).toBe(expected);
  });

  it.each<[string, unknown]>([
    ['a lock eviction', new WasmClientPoisonedError('watchdog')],
    ['an offscreen kill', new OperationAbortedError('op-1', 'deadline')],
    ['a wrapped lock eviction', new Error('relay failed', { cause: new WasmClientPoisonedError('realm-error') })]
  ])('reads %s as interrupted', (_kind, error) => {
    expect(classifyRelayFailure(error)).toBe('interrupted');
  });

  it('reads a thrown string as an outage', () => {
    expect(classifyRelayFailure('fetch failed')).toBe('outage');
  });
});

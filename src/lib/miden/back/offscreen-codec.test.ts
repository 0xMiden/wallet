/**
 * Unit tests for the shared offscreen IPC codec (issue #260, slice 1).
 *
 * Pure functions, no chrome / SDK / WASM — just the wire-format contract that
 * both the SW-side proxy and the offscreen dispatch table depend on.
 */

import {
  OFFSCREEN_CALL,
  OFFSCREEN_TARGET,
  OperationAbortedError,
  b64ToBytes,
  bytesToB64,
  decodeArg,
  encodeArg,
  isOperationAbortedError,
  type OffscreenCallRequest
} from './offscreen-codec';

describe('offscreen-codec — base64 round-trip', () => {
  it('round-trips a small byte array', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    expect(Array.from(b64ToBytes(bytesToB64(bytes)))).toEqual([0, 1, 2, 254, 255]);
  });

  it('round-trips an empty array', () => {
    expect(bytesToB64(new Uint8Array([]))).toBe('');
    expect(b64ToBytes('').length).toBe(0);
  });

  it('chunk-encodes payloads larger than the 0x8000 chunk window', () => {
    const big = new Uint8Array(0x9000).fill(0x42);
    const decoded = b64ToBytes(bytesToB64(big));
    expect(decoded.length).toBe(0x9000);
    expect(decoded[0]).toBe(0x42);
    expect(decoded[0x9000 - 1]).toBe(0x42);
  });
});

describe('offscreen-codec — argument encoding', () => {
  it('encodes a string scalar as a JSON-tagged arg and decodes it back', () => {
    const encoded = encodeArg('mtst1qqaccountid');
    expect(encoded.startsWith('s:')).toBe(true);
    expect(decodeArg(encoded)).toBe('mtst1qqaccountid');
  });

  it('round-trips numbers, booleans, null and plain objects', () => {
    for (const v of [0, 42, -1, true, false, null, { a: 1, b: ['x'] }]) {
      expect(decodeArg(encodeArg(v))).toEqual(v);
    }
  });

  it('normalizes undefined to null (JSON has no undefined)', () => {
    expect(decodeArg(encodeArg(undefined))).toBeNull();
  });

  it('encodes a Uint8Array as a base64-tagged arg and decodes it back to bytes', () => {
    const encoded = encodeArg(new Uint8Array([9, 8, 7]));
    expect(encoded.startsWith('b:')).toBe(true);
    const decoded = decodeArg(encoded);
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded as Uint8Array)).toEqual([9, 8, 7]);
  });

  it('encodes an ArrayBuffer as bytes', () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    const decoded = decodeArg(encodeArg(buf));
    expect(Array.from(decoded as Uint8Array)).toEqual([1, 2, 3]);
  });

  it('throws on an untagged / unrecognized arg', () => {
    expect(() => decodeArg('x:garbage')).toThrow(/unrecognized argument tag/);
  });
});

describe('offscreen-codec — envelope + error', () => {
  it('exposes the stable discriminators', () => {
    expect(OFFSCREEN_TARGET).toBe('offscreen');
    expect(OFFSCREEN_CALL).toBe('OFFSCREEN_CALL');
  });

  it('an OffscreenCallRequest carries its op_id, method, args and deadline', () => {
    const req: OffscreenCallRequest = {
      target: OFFSCREEN_TARGET,
      type: OFFSCREEN_CALL,
      op_id: 'op-1',
      method: 'getAccount',
      argsB64: [encodeArg('acc')],
      deadline_ms: 15_000
    };
    expect(decodeArg(req.argsB64[0]!)).toBe('acc');
    expect(req.deadline_ms).toBe(15_000);
  });

  it('OperationAbortedError carries op_id + reason and is an Error', () => {
    const err = new OperationAbortedError('op-9', 'deadline');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('OperationAbortedError');
    expect(err.op_id).toBe('op-9');
    expect(err.reason).toBe('deadline');
    expect(err.message).toContain('op-9');
    expect(err.message).toContain('deadline');
  });

  it('isOperationAbortedError matches a real instance and a name-tagged shape, rejects everything else', () => {
    // Prototype match.
    expect(isOperationAbortedError(new OperationAbortedError('op-1', 'deadline'))).toBe(true);
    // Prototype lost but the name tag survives (e.g. re-thrown across a boundary).
    expect(isOperationAbortedError({ name: 'OperationAbortedError' })).toBe(true);
    // Non-matches: a plain error, a differently-named object, and non-objects.
    expect(isOperationAbortedError(new Error('nope'))).toBe(false);
    expect(isOperationAbortedError({ name: 'SomethingElse' })).toBe(false);
    expect(isOperationAbortedError(null)).toBe(false);
    expect(isOperationAbortedError('OperationAbortedError')).toBe(false);
    expect(isOperationAbortedError(undefined)).toBe(false);
  });
});

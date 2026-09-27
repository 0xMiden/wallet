/** The prove worker wire format and thread cap (#945). */
import { isProveRequestMessage, isProveWorkerMessage, proveThreadCount, transferable } from './prove-worker-protocol';

describe('proveThreadCount', () => {
  it.each([
    [2, 2],
    [6, 6],
    [10, 6],
    [undefined, 4]
  ])('gives %p cores a pool of %i threads', (cores, threads) => {
    expect(proveThreadCount(cores)).toBe(threads);
  });
});

describe('transferable', () => {
  it('transfers an array that owns its whole buffer as is', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const out = transferable(bytes);
    expect(out.bytes).toBe(bytes);
    expect(out.transfer).toEqual([bytes.buffer]);
  });

  it('copies a view into a larger buffer, so the caller keeps its memory', () => {
    const backing = new Uint8Array([9, 1, 2, 3, 9]);
    const view = backing.subarray(1, 4);
    const out = transferable(view);
    expect(out.bytes).not.toBe(view);
    expect(Array.from(out.bytes)).toEqual([1, 2, 3]);
    expect(out.transfer).toHaveLength(1);
    expect(out.transfer[0]).not.toBe(backing.buffer);
  });

  it('copies an array over a SharedArrayBuffer, which cannot be transferred', () => {
    const shared = new Uint8Array(new SharedArrayBuffer(3));
    shared.set([7, 8, 9]);
    const out = transferable(shared);
    expect(Array.from(out.bytes)).toEqual([7, 8, 9]);
    expect(out.transfer[0]).toBeInstanceOf(ArrayBuffer);
  });
});

describe('isProveRequestMessage', () => {
  const valid = { type: 'prove', id: 1, txResult: new Uint8Array([1]), proverDescriptor: 'local' };

  it('accepts a well-formed request', () => {
    expect(isProveRequestMessage(valid)).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'prove'],
    ['another type', { ...valid, type: 'ready' }],
    ['a string id', { ...valid, id: '1' }],
    ['a plain-array payload', { ...valid, txResult: [1] }],
    ['a missing descriptor', { type: 'prove', id: 1, txResult: new Uint8Array([1]) }]
  ])('rejects %s', (_label, data) => {
    expect(isProveRequestMessage(data)).toBe(false);
  });
});

describe('isProveWorkerMessage', () => {
  it.each([
    ['ready', { type: 'ready', threads: 6, crossOriginIsolated: true }],
    ['init-failed', { type: 'init-failed', reason: 'wasm-load', message: 'x' }],
    ['a success', { type: 'result', id: 1, ok: true, proven: new Uint8Array([1]), durationMs: 3 }],
    ['a failure', { type: 'result', id: 1, ok: false, message: 'x' }]
  ])('accepts %s', (_label, data) => {
    expect(isProveWorkerMessage(data)).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['no type', { threads: 6 }],
    ['an unknown type', { type: 'progress' }],
    ['ready without threads', { type: 'ready' }],
    ['init-failed without a message', { type: 'init-failed', reason: 'wasm-load' }],
    ['a result without an id', { type: 'result', ok: true }],
    ['a result without ok', { type: 'result', id: 1 }],
    ['a success without bytes', { type: 'result', id: 1, ok: true, durationMs: 3 }],
    ['a success without a duration', { type: 'result', id: 1, ok: true, proven: new Uint8Array([1]) }],
    ['a failure without a message', { type: 'result', id: 1, ok: false }],
    ['a non-boolean ok', { type: 'result', id: 1, ok: 'yes', message: 'x' }],
    ['ready with crossOriginIsolated false', { type: 'ready', threads: 6, crossOriginIsolated: false }],
    ['init-failed with an unknown reason', { type: 'init-failed', reason: 'unknown-reason', message: 'x' }]
  ])('rejects %s', (_label, data) => {
    expect(isProveWorkerMessage(data)).toBe(false);
  });
});

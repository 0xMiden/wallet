import {
  getLocalProveTransport,
  installLocalProveTransport,
  type LocalProveTransport,
  ProveWorkerError
} from './local-prove-transport';

const fakeTransport = (): LocalProveTransport => ({
  prove: jest.fn(async () => ({ proven: new Uint8Array([1]), durationMs: 1 })),
  prewarm: jest.fn()
});

afterEach(() => installLocalProveTransport(null));

describe('ProveWorkerError', () => {
  it('carries a closed message, its kind, and the worker text on detail only', () => {
    const error = new ProveWorkerError('crashed', 'RuntimeError: unreachable');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ProveWorkerError');
    expect(error.message).toBe('Local prove failed in the prove worker (crashed)');
    expect(error.kind).toBe('crashed');
    expect(error.detail).toBe('RuntimeError: unreachable');
  });
});

describe('the realm transport slot', () => {
  it('is empty until a realm installs one, and can be cleared again', () => {
    expect(getLocalProveTransport()).toBeNull();
    const transport = fakeTransport();
    installLocalProveTransport(transport);
    expect(getLocalProveTransport()).toBe(transport);
    installLocalProveTransport(null);
    expect(getLocalProveTransport()).toBeNull();
  });
});

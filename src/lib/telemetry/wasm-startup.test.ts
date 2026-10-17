import { wasmStartupEvidence } from './wasm-startup';

// Each replaced global goes back as it was, whether it was an own property or not.
const restores: Array<() => void> = [];
function replace(target: object, key: string, value: unknown): void {
  const own = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  restores.push(() => {
    if (own === undefined) Reflect.deleteProperty(target, key);
    else Object.defineProperty(target, key, own);
  });
}

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

const trap = () => new WebAssembly.RuntimeError('unreachable');
const growingMemory = () => jest.fn(() => ({ grow: () => 1 }));

function isolated(memory: unknown): void {
  replace(globalThis, 'crossOriginIsolated', true);
  replace(WebAssembly, 'Memory', memory);
}

function views(count: number): void {
  replace(chrome.extension, 'getViews', () => Array.from({ length: count }, () => globalThis));
}

describe('wasmStartupEvidence', () => {
  it('adds nothing for a failure that is not a WebAssembly trap', () => {
    const memory = growingMemory();
    isolated(memory);
    views(1);
    for (const failure of [
      new Error('unreachable'),
      new RangeError('Maximum memory size exceeded'),
      'unreachable',
      null
    ]) {
      expect(wasmStartupEvidence(failure)).toEqual({});
    }
    expect(memory).not.toHaveBeenCalled();
  });

  it("grows a fresh shared memory of the SDK's maximum by one page", () => {
    const grow = jest.fn(() => 1);
    const memory = jest.fn(() => ({ grow }));
    isolated(memory);
    views(1);
    expect(wasmStartupEvidence(trap())).toEqual({ sharedMemoryProbe: 'grew', extensionViews: '1' });
    expect(memory).toHaveBeenCalledWith({ initial: 1, maximum: 65536, shared: true });
    expect(grow).toHaveBeenCalledWith(1);
  });

  it('reports refused when the grow or the construction throws', () => {
    isolated(
      jest.fn(() => ({
        grow: () => {
          throw new RangeError('WebAssembly.Memory.grow(): Maximum memory size exceeded');
        }
      }))
    );
    views(1);
    expect(wasmStartupEvidence(trap()).sharedMemoryProbe).toBe('refused');
    replace(
      WebAssembly,
      'Memory',
      jest.fn(() => {
        throw new RangeError('WebAssembly.Memory(): could not allocate memory');
      })
    );
    expect(wasmStartupEvidence(trap()).sharedMemoryProbe).toBe('refused');
  });

  it('does not probe outside a cross-origin isolated realm', () => {
    const memory = growingMemory();
    replace(WebAssembly, 'Memory', memory);
    views(1);
    for (const isolation of [false, undefined]) {
      replace(globalThis, 'crossOriginIsolated', isolation);
      expect(wasmStartupEvidence(trap()).sharedMemoryProbe).toBe('unavailable');
    }
    expect(memory).not.toHaveBeenCalled();
  });

  it.each([
    [1, '1'],
    [2, '2-3'],
    [3, '2-3'],
    [4, '4+'],
    [9, '4+'],
    [0, 'unavailable']
  ])('buckets %i extension views as %s', (count, bucket) => {
    isolated(growingMemory());
    views(count);
    expect(wasmStartupEvidence(trap()).extensionViews).toBe(bucket);
  });

  it('reports the views as unavailable without the extension API, or when it throws', () => {
    isolated(growingMemory());
    replace(chrome.extension, 'getViews', () => {
      throw new Error('getViews is not available in this context');
    });
    expect(wasmStartupEvidence(trap()).extensionViews).toBe('unavailable');
    replace(chrome.extension, 'getViews', undefined);
    expect(wasmStartupEvidence(trap()).extensionViews).toBe('unavailable');
    replace(chrome, 'extension', undefined);
    expect(wasmStartupEvidence(trap()).extensionViews).toBe('unavailable');
    replace(globalThis, 'chrome', undefined);
    expect(wasmStartupEvidence(trap())).toEqual({ sharedMemoryProbe: 'grew', extensionViews: 'unavailable' });
  });

  it('probes once per failure, since the SDK hands every caller the same rejected start', () => {
    const memory = growingMemory();
    isolated(memory);
    views(2);
    const failure = trap();
    expect(wasmStartupEvidence(failure)).toEqual({ sharedMemoryProbe: 'grew', extensionViews: '2-3' });
    expect(wasmStartupEvidence(failure)).toEqual({});
    expect(memory).toHaveBeenCalledTimes(1);
  });

  it('cannot throw for a failure that rejects instanceof checks', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('hostile object');
        }
      }
    );
    expect(wasmStartupEvidence(hostile)).toEqual({});
  });
});

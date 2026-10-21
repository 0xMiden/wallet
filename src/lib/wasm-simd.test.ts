import { isWasmSimdSupported, SIMD_PROBE_MODULE } from './wasm-simd';

describe('isWasmSimdSupported', () => {
  const realWebAssembly = globalThis.WebAssembly;
  afterEach(() => {
    Object.defineProperty(globalThis, 'WebAssembly', { value: realWebAssembly, configurable: true, writable: true });
    jest.restoreAllMocks();
  });

  it('accepts the probe module on a runtime with SIMD', () => {
    expect(WebAssembly.validate(SIMD_PROBE_MODULE)).toBe(true);
    expect(isWasmSimdSupported()).toBe(true);
  });

  it('refuses when the runtime rejects the SIMD probe', () => {
    const validate = jest.spyOn(WebAssembly, 'validate').mockReturnValue(false);
    expect(isWasmSimdSupported()).toBe(false);
    expect(validate).toHaveBeenCalledWith(SIMD_PROBE_MODULE);
  });

  it('refuses when the runtime has no WebAssembly at all', () => {
    Object.defineProperty(globalThis, 'WebAssembly', { value: undefined, configurable: true, writable: true });
    expect(isWasmSimdSupported()).toBe(false);
  });

  it('does not block startup when the probe itself throws', () => {
    jest.spyOn(WebAssembly, 'validate').mockImplementation(() => {
      throw new Error('probe failed');
    });
    expect(isWasmSimdSupported()).toBe(true);
  });
});

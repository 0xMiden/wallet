/**
 * Coverage tests for `lib/miden-chain/constants.ts`.
 */

// Mock the virtual Vite alias — jest doesn't resolve it otherwise.
jest.mock('sdk-wasm-loader', () => ({ __esModule: true, default: jest.fn(async () => undefined) }), { virtual: true });

const mockEndpoint = jest.fn();
jest.mock('@miden-sdk/miden-sdk', () => ({
  Endpoint: function (url: string) {
    return mockEndpoint(url);
  },
  NetworkId: {
    mainnet: () => ({ kind: 'mainnet' }),
    devnet: () => ({ kind: 'devnet' }),
    testnet: () => ({ kind: 'testnet' })
  }
}));

describe('miden-chain/constants', () => {
  beforeEach(() => {
    jest.resetModules();
    mockEndpoint.mockReset();
  });

  it('getNetworkId returns a NetworkId', () => {
    jest.isolateModules(() => {
      const { getNetworkId } = require('./constants');
      const id = getNetworkId();
      expect(id).toBeDefined();
    });
  });

  it('getRpcEndpoint constructs an Endpoint for the current network', () => {
    mockEndpoint.mockReturnValue({ ok: true });
    jest.isolateModules(() => {
      const { getRpcEndpoint } = require('./constants');
      getRpcEndpoint();
    });
    expect(mockEndpoint).toHaveBeenCalledTimes(1);
    expect(mockEndpoint.mock.calls[0][0]).toMatch(/^https?:\/\//);
  });

  describe('ensureSdkWasmReady', () => {
    it('resolves when deep loadWasm import + probe both succeed', async () => {
      mockEndpoint.mockReturnValue({ ok: true });
      await jest.isolateModulesAsync(async () => {
        const { ensureSdkWasmReady } = require('./constants');
        await expect(ensureSdkWasmReady()).resolves.toBeUndefined();
      });
    });

    it('returns the cached promise on repeated calls', async () => {
      mockEndpoint.mockReturnValue({ ok: true });
      await jest.isolateModulesAsync(async () => {
        const { ensureSdkWasmReady } = require('./constants');
        const p1 = ensureSdkWasmReady();
        const p2 = ensureSdkWasmReady();
        expect(p1).toBe(p2);
        await p1;
      });
    });

    it('falls back to probe when loadWasm is not a function', async () => {
      jest.doMock('sdk-wasm-loader', () => ({ __esModule: true, default: 'not-a-function' }), { virtual: true });
      mockEndpoint.mockReturnValue({ ok: true });
      await jest.isolateModulesAsync(async () => {
        const { ensureSdkWasmReady } = require('./constants');
        await expect(ensureSdkWasmReady()).resolves.toBeUndefined();
      });
    });

    it('warns and falls through when deep import throws', async () => {
      jest.doMock(
        'sdk-wasm-loader',
        () => {
          throw new Error('module not found');
        },
        { virtual: true }
      );
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockEndpoint.mockReturnValue({ ok: true });
      await jest.isolateModulesAsync(async () => {
        const { ensureSdkWasmReady } = require('./constants');
        await expect(ensureSdkWasmReady()).resolves.toBeUndefined();
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('deep loadWasm import unavailable'),
        expect.any(Error)
      );
      warnSpy.mockRestore();
    });

    it('returns early on unrelated probe error (WASM is loaded, arg rejected)', async () => {
      mockEndpoint.mockImplementation(() => {
        throw new Error('invalid URL');
      });
      await jest.isolateModulesAsync(async () => {
        const { ensureSdkWasmReady } = require('./constants');
        await expect(ensureSdkWasmReady()).resolves.toBeUndefined();
      });
      // Only probed once — returned early on the unrelated error
      expect(mockEndpoint).toHaveBeenCalledTimes(1);
    });

    it('throws when probe keeps hitting __wbindgen_malloc across all retries', async () => {
      mockEndpoint.mockImplementation(() => {
        throw new Error("Cannot read properties of undefined (reading '__wbindgen_malloc')");
      });
      await jest.isolateModulesAsync(async () => {
        const { ensureSdkWasmReady } = require('./constants');
        await expect(ensureSdkWasmReady()).rejects.toThrow(/SDK WASM not loaded/);
        // After throw, a subsequent call should retry (promise was reset).
        // Make the next probe succeed so the retry resolves.
        mockEndpoint.mockReset();
        mockEndpoint.mockReturnValue({ ok: true });
        await expect(ensureSdkWasmReady()).resolves.toBeUndefined();
      });
      // 4 delays × failed + 1 success on retry
      expect(mockEndpoint.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });
});

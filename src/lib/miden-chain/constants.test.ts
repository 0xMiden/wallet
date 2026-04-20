/**
 * Coverage tests for `lib/miden-chain/constants.ts`.
 */

const mockEndpoint = jest.fn();
const mockMidenClientReady = jest.fn(() => Promise.resolve());

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  Endpoint: function (url: string) {
    return mockEndpoint(url);
  },
  NetworkId: {
    mainnet: () => ({ kind: 'mainnet' }),
    devnet: () => ({ kind: 'devnet' }),
    testnet: () => ({ kind: 'testnet' })
  },
  MidenClient: {
    ready: mockMidenClientReady
  }
}));

describe('miden-chain/constants', () => {
  beforeEach(() => {
    jest.resetModules();
    mockEndpoint.mockReset();
    mockMidenClientReady.mockReset();
    mockMidenClientReady.mockReturnValue(Promise.resolve());
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
    it('delegates to MidenClient.ready()', async () => {
      await jest.isolateModulesAsync(async () => {
        const { ensureSdkWasmReady } = require('./constants');
        await expect(ensureSdkWasmReady()).resolves.toBeUndefined();
      });
      expect(mockMidenClientReady).toHaveBeenCalledTimes(1);
    });

    it('propagates rejections from MidenClient.ready()', async () => {
      mockMidenClientReady.mockReturnValueOnce(Promise.reject(new Error('wasm boom')));
      await jest.isolateModulesAsync(async () => {
        const { ensureSdkWasmReady } = require('./constants');
        await expect(ensureSdkWasmReady()).rejects.toThrow(/wasm boom/);
      });
    });
  });
});

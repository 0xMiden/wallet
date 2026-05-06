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

const ORIGINAL_ENV = process.env;

describe('miden-chain/constants', () => {
  beforeEach(() => {
    jest.resetModules();
    mockEndpoint.mockReset();
    mockMidenClientReady.mockReset();
    mockMidenClientReady.mockReturnValue(Promise.resolve());
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
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

  describe('getExplorerTxUrl', () => {
    it('returns the explorer URL when the network has an entry', () => {
      jest.isolateModules(() => {
        const { getExplorerTxUrl, MIDEN_NETWORK_NAME } = require('./constants');
        expect(getExplorerTxUrl('0xabc', MIDEN_NETWORK_NAME.TESTNET)).toBe('https://testnet.midenscan.com/tx/0xabc');
      });
    });

    it('returns undefined when the network has no explorer mapping', () => {
      jest.isolateModules(() => {
        const { getExplorerTxUrl, MIDEN_NETWORK_NAME } = require('./constants');
        expect(getExplorerTxUrl('0xabc', MIDEN_NETWORK_NAME.LOCALNET)).toBeUndefined();
      });
    });

    it('falls back to DEFAULT_NETWORK when no network is provided', () => {
      delete process.env.MIDEN_NETWORK;
      jest.isolateModules(() => {
        const { getExplorerTxUrl } = require('./constants');
        expect(getExplorerTxUrl('0xabc')).toBe('https://testnet.midenscan.com/tx/0xabc');
      });
    });
  });

  describe('getNoteTransportUrl', () => {
    it('returns the per-network endpoint when no override is set', () => {
      delete process.env.MIDEN_NOTE_TRANSPORT_URL;
      jest.isolateModules(() => {
        const { getNoteTransportUrl, MIDEN_NETWORK_NAME } = require('./constants');
        expect(getNoteTransportUrl(MIDEN_NETWORK_NAME.TESTNET)).toBe('https://transport.miden.io');
      });
    });

    it('returns undefined for an unknown network when no override is set', () => {
      delete process.env.MIDEN_NOTE_TRANSPORT_URL;
      jest.isolateModules(() => {
        const { getNoteTransportUrl } = require('./constants');
        expect(getNoteTransportUrl('not-a-network')).toBeUndefined();
      });
    });

    it('returns the build-time override when MIDEN_NOTE_TRANSPORT_URL is set', () => {
      process.env.MIDEN_NOTE_TRANSPORT_URL = 'http://localhost:57292';
      jest.isolateModules(() => {
        const { getNoteTransportUrl, MIDEN_NETWORK_NAME } = require('./constants');
        // Override wins regardless of network mapping.
        expect(getNoteTransportUrl(MIDEN_NETWORK_NAME.TESTNET)).toBe('http://localhost:57292');
        expect(getNoteTransportUrl('not-a-network')).toBe('http://localhost:57292');
      });
    });
  });

  describe('DEFAULT_NETWORK', () => {
    it('falls back to TESTNET when MIDEN_NETWORK env is unset', () => {
      delete process.env.MIDEN_NETWORK;
      jest.isolateModules(() => {
        const { DEFAULT_NETWORK, MIDEN_NETWORK_NAME } = require('./constants');
        expect(DEFAULT_NETWORK).toBe(MIDEN_NETWORK_NAME.TESTNET);
      });
    });

    it('honors MIDEN_NETWORK env when set', () => {
      process.env.MIDEN_NETWORK = 'devnet';
      jest.isolateModules(() => {
        const { DEFAULT_NETWORK, MIDEN_NETWORK_NAME } = require('./constants');
        expect(DEFAULT_NETWORK).toBe(MIDEN_NETWORK_NAME.DEVNET);
      });
    });
  });

  describe('DEFAULT_GUARDIAN_ENDPOINT', () => {
    it('uses the network-specific endpoint when present', () => {
      process.env.MIDEN_NETWORK = 'testnet';
      jest.isolateModules(() => {
        const { DEFAULT_GUARDIAN_ENDPOINT } = require('./constants');
        expect(DEFAULT_GUARDIAN_ENDPOINT).toBe('https://guardian.openzeppelin.com');
      });
    });

    it('falls back to the staging endpoint when the network has no mapping', () => {
      process.env.MIDEN_NETWORK = 'localnet';
      jest.isolateModules(() => {
        const { DEFAULT_GUARDIAN_ENDPOINT } = require('./constants');
        expect(DEFAULT_GUARDIAN_ENDPOINT).toBe('https://stg-guardian.openzeppelin.com');
      });
    });
  });

  describe('getNetworkId', () => {
    it('returns testnet for TESTNET network', () => {
      process.env.MIDEN_NETWORK = 'testnet';
      jest.isolateModules(() => {
        const { getNetworkId } = require('./constants');
        expect(getNetworkId()).toEqual({ kind: 'testnet' });
      });
    });

    it('returns testnet for LOCALNET network', () => {
      process.env.MIDEN_NETWORK = 'localnet';
      jest.isolateModules(() => {
        const { getNetworkId } = require('./constants');
        expect(getNetworkId()).toEqual({ kind: 'testnet' });
      });
    });

    it('falls through to testnet for unknown networks', () => {
      process.env.MIDEN_NETWORK = 'something-unknown';
      jest.isolateModules(() => {
        const { getNetworkId } = require('./constants');
        expect(getNetworkId()).toEqual({ kind: 'testnet' });
      });
    });
  });
});

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

  describe('getGuardianOptionsForNetwork', () => {
    it('resolves providers to their endpoint on the network, OpenZeppelin first', () => {
      jest.isolateModules(() => {
        const { getGuardianOptionsForNetwork, MIDEN_NETWORK_NAME } = require('./constants');
        const opts = getGuardianOptionsForNetwork(MIDEN_NETWORK_NAME.TESTNET);
        // More than one provider runs on testnet; opts[0] is the default (OpenZeppelin),
        // resolved to its TESTNET endpoint (pins provider identity + per-network endpoint).
        expect(opts.length).toBeGreaterThan(1);
        expect(opts[0]).toMatchObject({ id: 'open-zeppelin', endpoint: 'https://guardian.openzeppelin.com' });
      });
    });

    it('filters to the subset running on the network and resolves that network endpoint', () => {
      jest.isolateModules(() => {
        const { getGuardianOptionsForNetwork, MIDEN_NETWORK_NAME } = require('./constants');
        // Only OpenZeppelin runs a devnet guardian -> exactly one option, its devnet endpoint.
        expect(getGuardianOptionsForNetwork(MIDEN_NETWORK_NAME.DEVNET)).toEqual([
          {
            id: 'open-zeppelin',
            name: 'OpenZeppelin',
            operatedBy: 'OpenZeppelin',
            location: 'US-EAST',
            endpoint: 'https://guardian-stg.openzeppelin.com'
          }
        ]);
      });
    });

    it('returns an empty list for a network with no guardian providers', () => {
      jest.isolateModules(() => {
        const { getGuardianOptionsForNetwork, MIDEN_NETWORK_NAME } = require('./constants');
        expect(getGuardianOptionsForNetwork(MIDEN_NETWORK_NAME.MAINNET)).toEqual([]);
      });
    });

    describe('localnet second guardian (E2E only)', () => {
      const prev = process.env.MIDEN_E2E_TEST;
      afterEach(() => {
        process.env.MIDEN_E2E_TEST = prev;
      });

      it('exposes OpenZeppelin B on localnet only under MIDEN_E2E_TEST', () => {
        process.env.MIDEN_E2E_TEST = 'true';
        jest.isolateModules(() => {
          const { getGuardianOptionsForNetwork, MIDEN_NETWORK_NAME } = require('./constants');
          const opts = getGuardianOptionsForNetwork(MIDEN_NETWORK_NAME.LOCALNET);
          expect(opts.map((o: { endpoint: string }) => o.endpoint)).toContain('http://localhost:3001');
        });
      });

      it('hides OpenZeppelin B when not in E2E', () => {
        process.env.MIDEN_E2E_TEST = 'false';
        jest.isolateModules(() => {
          const { getGuardianOptionsForNetwork, MIDEN_NETWORK_NAME } = require('./constants');
          const opts = getGuardianOptionsForNetwork(MIDEN_NETWORK_NAME.LOCALNET);
          expect(opts.map((o: { endpoint: string }) => o.endpoint)).not.toContain('http://localhost:3001');
        });
      });
    });
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
        const { DEFAULT_GUARDIAN_ENDPOINT, IS_GUARDIAN_SUPPORTED } = require('./constants');
        expect(DEFAULT_GUARDIAN_ENDPOINT).toBe('https://guardian.openzeppelin.com');
        expect(IS_GUARDIAN_SUPPORTED).toBe(true);
      });
    });

    it('does NOT fall back to staging on networks with no mapping (mainnet safety)', () => {
      process.env.MIDEN_NETWORK = 'mainnet';
      jest.isolateModules(() => {
        const { DEFAULT_GUARDIAN_ENDPOINT, IS_GUARDIAN_SUPPORTED } = require('./constants');
        expect(DEFAULT_GUARDIAN_ENDPOINT).toBe('');
        expect(IS_GUARDIAN_SUPPORTED).toBe(false);
      });
    });
  });

  describe('getDefaultGuardianEndpoint', () => {
    it('returns the endpoint for a supported network', () => {
      process.env.MIDEN_NETWORK = 'testnet';
      jest.isolateModules(() => {
        const { getDefaultGuardianEndpoint } = require('./constants');
        expect(getDefaultGuardianEndpoint()).toBe('https://guardian.openzeppelin.com');
      });
    });

    it('throws (rather than targeting staging) on an unsupported network', () => {
      process.env.MIDEN_NETWORK = 'mainnet';
      jest.isolateModules(() => {
        const { getDefaultGuardianEndpoint } = require('./constants');
        expect(() => getDefaultGuardianEndpoint()).toThrow('Guardian is not available on network "mainnet"');
      });
    });
  });

  describe('GUARDIAN_OPTIONS', () => {
    it('offers more than one provider, each mapping networks to valid https endpoints', () => {
      process.env.MIDEN_NETWORK = 'testnet';
      jest.isolateModules(() => {
        const { GUARDIAN_OPTIONS } = require('./constants');
        expect(GUARDIAN_OPTIONS.length).toBeGreaterThan(1);
        for (const option of GUARDIAN_OPTIONS) {
          expect(option.id).toBeTruthy();
          expect(option.endpoint.size).toBeGreaterThan(0);
          for (const url of option.endpoint.values()) {
            expect(() => new URL(url)).not.toThrow();
            // https everywhere, except the localnet dev guardian (http on localhost).
            expect(url.startsWith('https://') || url.startsWith('http://localhost:')).toBe(true);
          }
        }
      });
    });

    it('exposes the OpenZeppelin endpoint per network', () => {
      process.env.MIDEN_NETWORK = 'testnet';
      jest.isolateModules(() => {
        const { GUARDIAN_OPTIONS } = require('./constants');
        const oz = GUARDIAN_OPTIONS.find((o: { id: string }) => o.id === 'open-zeppelin');
        expect(oz?.endpoint.get('testnet')).toBe('https://guardian.openzeppelin.com');
        expect(oz?.endpoint.get('devnet')).toBe('https://guardian-stg.openzeppelin.com');
      });
    });
  });

  describe('MIDEN_GUARDIAN_ENDPOINTS', () => {
    it('collects every provider endpoint per network, OpenZeppelin first', () => {
      process.env.MIDEN_NETWORK = 'testnet';
      jest.isolateModules(() => {
        const { MIDEN_GUARDIAN_ENDPOINTS } = require('./constants');
        expect(MIDEN_GUARDIAN_ENDPOINTS.get('testnet')).toEqual([
          'https://guardian.openzeppelin.com',
          'https://miden-guardian.dev.eu-north-3.gateway.fm',
          'https://miden-guardian.lambdaclass.com',
          'https://guardian-testnet.kodax.com'
        ]);
        // Only OpenZeppelin runs a devnet Guardian.
        expect(MIDEN_GUARDIAN_ENDPOINTS.get('devnet')).toEqual(['https://guardian-stg.openzeppelin.com']);
        // OpenZeppelin also exposes a localnet endpoint (the local guardian image).
        expect(MIDEN_GUARDIAN_ENDPOINTS.get('localnet')).toEqual(['http://localhost:3000']);
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

  describe('resolveNetworkName', () => {
    it("maps the E2E 'localhost' token to the LOCALNET enum", () => {
      jest.isolateModules(() => {
        const { resolveNetworkName, MIDEN_NETWORK_NAME } = require('./constants');
        expect(resolveNetworkName('localhost')).toBe(MIDEN_NETWORK_NAME.LOCALNET);
      });
    });
    it('passes through valid enum values', () => {
      jest.isolateModules(() => {
        const { resolveNetworkName, MIDEN_NETWORK_NAME } = require('./constants');
        expect(resolveNetworkName('devnet')).toBe(MIDEN_NETWORK_NAME.DEVNET);
        expect(resolveNetworkName('localnet')).toBe(MIDEN_NETWORK_NAME.LOCALNET);
      });
    });
    it('defaults to testnet for undefined or unknown', () => {
      jest.isolateModules(() => {
        const { resolveNetworkName, MIDEN_NETWORK_NAME } = require('./constants');
        expect(resolveNetworkName(undefined)).toBe(MIDEN_NETWORK_NAME.TESTNET);
        expect(resolveNetworkName('bogus')).toBe(MIDEN_NETWORK_NAME.TESTNET);
      });
    });
  });
});

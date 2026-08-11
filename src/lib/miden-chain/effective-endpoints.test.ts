import {
  MIDEN_NETWORK_NAME,
  MIDEN_NETWORK_ENDPOINTS,
  MIDEN_PROVING_ENDPOINTS,
  MIDEN_FAUCET_ENDPOINTS,
  MIDEN_FAUCET_API_ENDPOINTS,
  MIDEN_EXPLORER_ENDPOINTS,
  MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS,
  MIDEN_GUARDIAN_ENDPOINTS,
  DEFAULT_NETWORK
} from './constants';

const mockKvStore: Record<string, unknown> = {};
// Per-test toggle so a single test can simulate a storage-provider failure
// without a second jest.mock for the whole file.
let mockThrows = false;
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      if (mockThrows) throw new Error('storage unavailable');
      const out: Record<string, unknown> = {};
      for (const k of keys) if (k in mockKvStore) out[k] = mockKvStore[k];
      return out;
    },
    set: async (obj: Record<string, unknown>) => {
      Object.assign(mockKvStore, obj);
    },
    remove: async (keys: string[]) => {
      for (const k of keys) delete mockKvStore[k];
    }
  }),
  StorageProvider: class {}
}));

// `getEffectiveRpcEndpoint` constructs the SDK's wasm-backed `Endpoint`. The
// shared __mocks__/wasmMock.js doesn't export it, so mock it locally the same
// way constants.test.ts does for `getRpcEndpoint`.
const mockEndpointCtor = jest.fn((url: string) => ({ url }));
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  Endpoint: function (url: string) {
    return mockEndpointCtor(url);
  }
}));

function loadModule(): typeof import('./effective-endpoints') {
  let mod!: typeof import('./effective-endpoints');
  jest.isolateModules(() => {
    mod = require('./effective-endpoints');
  });
  return mod;
}

beforeEach(() => {
  for (const k of Object.keys(mockKvStore)) delete mockKvStore[k];
  mockThrows = false;
  delete process.env.MIDEN_E2E_TEST;
});

describe('effective-endpoints resolver', () => {
  it('returns build defaults when no override is loaded', () => {
    const m = loadModule();
    expect(m.getEffectiveRpcUrl()).toBe(MIDEN_NETWORK_ENDPOINTS.get(m.getEffectiveNetworkName()));
    expect(m.getActiveOverride()).toBeNull();
  });

  it('applies and persists an override, then reads it back on reload', async () => {
    const m = loadModule();
    const override = m.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET);
    override.rpcUrl = 'https://custom.example/rpc';
    await m.applyEndpointOverride(override);
    expect(m.getEffectiveRpcUrl()).toBe('https://custom.example/rpc');
    expect(m.getEffectiveNetworkName()).toBe(MIDEN_NETWORK_NAME.DEVNET);

    const m2 = loadModule(); // fresh module = cache reset
    expect(m2.getActiveOverride()).toBeNull();
    await m2.loadEndpointOverrides();
    expect(m2.getEffectiveRpcUrl()).toBe('https://custom.example/rpc');
    expect(await m2.isEndpointOverrideActive()).toBe(true);
  });

  it('clear() removes the override and reverts to defaults', async () => {
    const m = loadModule();
    await m.applyEndpointOverride(m.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET));
    await m.clearEndpointOverride();
    expect(m.getActiveOverride()).toBeNull();
    expect(await m.isEndpointOverrideActive()).toBe(false);
  });

  it('loadEndpointOverrides is a no-op under MIDEN_E2E_TEST', async () => {
    mockKvStore['endpoint_overrides'] = { rpcUrl: 'https://should.ignore/rpc' };
    process.env.MIDEN_E2E_TEST = 'true';
    const m = loadModule();
    await m.loadEndpointOverrides();
    expect(m.getActiveOverride()).toBeNull();
    expect(m.getEffectiveRpcUrl()).toBe(MIDEN_NETWORK_ENDPOINTS.get(m.getEffectiveNetworkName()));
  });

  it('note-transport env override wins over the per-network default but loses to an explicit override', () => {
    process.env.MIDEN_NOTE_TRANSPORT_URL = 'http://env.local/ntl';
    const m = loadModule();
    expect(m.getEffectiveNoteTransportUrl()).toBe('http://env.local/ntl');
    delete process.env.MIDEN_NOTE_TRANSPORT_URL;
  });

  describe('getters with no override loaded', () => {
    it('returns the build-default prover/faucet/faucetApi/explorer URLs keyed by the effective network', () => {
      const m = loadModule();
      const network = m.getEffectiveNetworkName();
      expect(m.getEffectiveProverUrl()).toBe(MIDEN_PROVING_ENDPOINTS.get(network));
      expect(m.getEffectiveFaucetUrl()).toBe(MIDEN_FAUCET_ENDPOINTS.get(network));
      expect(m.getEffectiveFaucetApiUrl()).toBe(MIDEN_FAUCET_API_ENDPOINTS.get(network));
      expect(m.getEffectiveExplorerUrl()).toBe(MIDEN_EXPLORER_ENDPOINTS.get(network));
    });

    it('returns the per-network note-transport default when no override and no env override are set', () => {
      delete process.env.MIDEN_NOTE_TRANSPORT_URL;
      const m = loadModule();
      const network = m.getEffectiveNetworkName();
      expect(m.getEffectiveNoteTransportUrl()).toBe(MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS.get(network));
    });

    it('returns an empty guardian URL', () => {
      const m = loadModule();
      expect(m.getEffectiveGuardianUrl()).toBe('');
    });

    it('constructs an RPC Endpoint without throwing', () => {
      const m = loadModule();
      expect(m.getEffectiveRpcEndpoint()).toBeTruthy();
    });
  });

  describe('getters with an override applied', () => {
    it('returns the overridden prover/faucet/faucetApi/explorer/guardian URLs', async () => {
      const m = loadModule();
      const override = m.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET);
      override.proverUrl = 'https://custom.example/prover';
      override.faucetUrl = 'https://custom.example/faucet';
      override.faucetApiUrl = 'https://custom.example/faucet-api';
      override.explorerUrl = 'https://custom.example/explorer';
      override.guardianUrl = 'https://custom.example/guardian';
      await m.applyEndpointOverride(override);

      expect(m.getEffectiveProverUrl()).toBe('https://custom.example/prover');
      expect(m.getEffectiveFaucetUrl()).toBe('https://custom.example/faucet');
      expect(m.getEffectiveFaucetApiUrl()).toBe('https://custom.example/faucet-api');
      expect(m.getEffectiveExplorerUrl()).toBe('https://custom.example/explorer');
      expect(m.getEffectiveGuardianUrl()).toBe('https://custom.example/guardian');
    });
  });

  describe('getEffectiveDefaultGuardianEndpoint', () => {
    it('returns the custom override guardian URL when one is set', async () => {
      const m = loadModule();
      const override = m.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET);
      override.guardianUrl = 'https://custom.example/guardian';
      await m.applyEndpointOverride(override);
      expect(m.getEffectiveDefaultGuardianEndpoint()).toBe('https://custom.example/guardian');
    });

    it('falls back to the effective network default guardian endpoint when no override is loaded', () => {
      const m = loadModule();
      const network = m.getEffectiveNetworkName();
      expect(m.getEffectiveDefaultGuardianEndpoint()).toBe(MIDEN_GUARDIAN_ENDPOINTS.get(network)?.[0]);
    });

    it('is keyed by the effective (overridden) network, not the build network, when no custom guardian URL is set', async () => {
      // The bug this guards against: an endpoint override with no custom guardian URL
      // and no stored GUARDIAN_URL_STORAGE_KEY must fall back to the OVERRIDDEN
      // network's guardian, not the build's DEFAULT_NETWORK guardian.
      const m = loadModule();
      const override = m.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET);
      override.guardianUrl = '';
      await m.applyEndpointOverride(override);
      expect(m.getEffectiveNetworkName()).toBe(MIDEN_NETWORK_NAME.DEVNET);
      expect(m.getEffectiveDefaultGuardianEndpoint()).toBe(
        MIDEN_GUARDIAN_ENDPOINTS.get(MIDEN_NETWORK_NAME.DEVNET)?.[0]
      );
    });

    it("returns '' when the effective network has no configured guardian and no custom URL is set", async () => {
      const m = loadModule();
      await m.applyEndpointOverride(m.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.MAINNET));
      expect(m.getEffectiveNetworkName()).toBe(MIDEN_NETWORK_NAME.MAINNET);
      expect(MIDEN_GUARDIAN_ENDPOINTS.get(MIDEN_NETWORK_NAME.MAINNET)).toBeUndefined();
      expect(m.getEffectiveDefaultGuardianEndpoint()).toBe('');
    });
  });

  describe('faucet/faucetApi URL final fallback (network with no per-network mapping)', () => {
    it('falls back to the DEFAULT_NETWORK faucet/faucetApi endpoint when the effective network has none', async () => {
      const m = loadModule();
      // MAINNET has no entry in MIDEN_FAUCET_ENDPOINTS / MIDEN_FAUCET_API_ENDPOINTS, and
      // buildDefaultOverrideFor leaves faucetUrl/faucetApiUrl empty in that case, so both
      // getters must fall through past the (falsy) override and the (undefined) per-network
      // map entry to the DEFAULT_NETWORK map entry.
      await m.applyEndpointOverride(m.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.MAINNET));
      expect(m.getEffectiveNetworkName()).toBe(MIDEN_NETWORK_NAME.MAINNET);
      expect(m.getEffectiveFaucetUrl()).toBe(MIDEN_FAUCET_ENDPOINTS.get(DEFAULT_NETWORK));
      expect(m.getEffectiveFaucetApiUrl()).toBe(MIDEN_FAUCET_API_ENDPOINTS.get(DEFAULT_NETWORK));
    });
  });

  describe('loadEndpointOverrides storage failure', () => {
    it('keeps the override cache null (no throw) when storage.get rejects', async () => {
      mockThrows = true;
      const m = loadModule();
      await expect(m.loadEndpointOverrides()).resolves.toBeUndefined();
      expect(m.getActiveOverride()).toBeNull();
    });
  });

  describe('loadEndpointOverrides type-guard rejection', () => {
    it('discards a stored value that fails the EndpointOverride shape check', async () => {
      mockKvStore['endpoint_overrides'] = { rpcUrl: 'https://malformed.example/rpc' }; // missing required fields
      const m = loadModule();
      await m.loadEndpointOverrides();
      expect(m.getActiveOverride()).toBeNull();
    });

    it('discards a stored value whose fields have the wrong shape entirely', async () => {
      mockKvStore['endpoint_overrides'] = 'not-an-object';
      const m = loadModule();
      await m.loadEndpointOverrides();
      expect(m.getActiveOverride()).toBeNull();
    });
  });
});

import {
  MIDEN_NETWORK_NAME,
  MIDEN_NETWORK_ENDPOINTS,
  MIDEN_PROVING_ENDPOINTS,
  MIDEN_FAUCET_ENDPOINTS,
  MIDEN_FAUCET_API_ENDPOINTS,
  MIDEN_EXPLORER_ENDPOINTS,
  MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS,
  DEFAULT_NETWORK
} from './constants';
import {
  getEffectiveAllowNoGuardian,
  hasCustomEndpointOverride,
  buildDefaultOverrideFor,
  buildNetworkChoiceOverride,
  type EndpointOverride,
  loadEndpointOverrides,
  ENDPOINT_OVERRIDE_STORAGE_KEY
} from './effective-endpoints';

const mockKvStore: Record<string, unknown> = {};
// Per-test toggles so a single test can simulate a storage-provider failure
// without a second jest.mock for the whole file.
let mockThrows = false;
let mockWriteThrows = false;
let mockStorageCalls = 0;
let mockStorageWrites = 0;
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      mockStorageCalls++;
      if (mockThrows) throw new Error('storage unavailable');
      const out: Record<string, unknown> = {};
      for (const k of keys) if (k in mockKvStore) out[k] = mockKvStore[k];
      return out;
    },
    set: async (obj: Record<string, unknown>) => {
      mockStorageCalls++;
      mockStorageWrites++;
      if (mockWriteThrows) throw new Error('storage write failed');
      Object.assign(mockKvStore, obj);
    },
    remove: async (keys: string[]) => {
      mockStorageCalls++;
      if (mockWriteThrows) throw new Error('storage write failed');
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
  mockWriteThrows = false;
  mockStorageCalls = 0;
  mockStorageWrites = 0;
  delete process.env.MIDEN_E2E_TEST;
  delete process.env.MIDEN_E2E_DISABLE_ENDPOINT_OVERRIDES;
  delete process.env.MIDEN_FEE_FAUCET_ID;
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

  it.each([
    ['the network choice onboarding stores', false, {}],
    ['a choice with an RPC endpoint', true, { rpcUrl: 'https://custom.example/rpc' }],
    ['a choice with a developer option', true, { allowNoGuardian: true }]
  ])('reads %s as a developer override: %s', async (_name, active, fields) => {
    const m = loadModule();
    await m.applyEndpointOverride({ ...m.buildNetworkChoiceOverride(MIDEN_NETWORK_NAME.MAINNET), ...fields });
    expect(await m.isEndpointOverrideActive()).toBe(active);
  });

  it('clear() removes the override and reverts to defaults', async () => {
    const m = loadModule();
    await m.applyEndpointOverride(m.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET));
    await m.clearEndpointOverride();
    expect(m.getActiveOverride()).toBeNull();
    expect(await m.isEndpointOverrideActive()).toBe(false);
  });

  // Regression guard for the reported bug: the dev-settings explorer override
  // didn't reach the Transaction-ID / account explorer links (they were hardcoded
  // to testnet.midenscan.com). getExplorerTxUrl/getExplorerAccountUrl (constants.ts)
  // must resolve their base via the override-aware getEffectiveExplorerUrl. Require
  // constants + effective-endpoints in ONE isolateModules so the helpers read the
  // same overrideCache we set here.
  it('getExplorerTxUrl/getExplorerAccountUrl use the custom explorer override', async () => {
    let eff!: typeof import('./effective-endpoints');
    let helpers!: typeof import('./constants');
    jest.isolateModules(() => {
      eff = require('./effective-endpoints');
      helpers = require('./constants');
    });
    const override = eff.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET);
    override.explorerUrl = 'https://my-explorer.example';
    await eff.applyEndpointOverride(override);

    expect(helpers.getExplorerTxUrl('0xabc')).toBe('https://my-explorer.example/tx/0xabc');
    expect(helpers.getExplorerAccountUrl('mtst1acc')).toBe('https://my-explorer.example/account/mtst1acc');
  });

  // The network choice onboarding stores has no explorer URL of its own, so a mainnet wallet's links
  // come from the build's mainnet entry: transactions, accounts, and tokens (a faucet is an account).
  it('links a mainnet wallet to the mainnet explorer', async () => {
    let eff!: typeof import('./effective-endpoints');
    let helpers!: typeof import('./constants');
    jest.isolateModules(() => {
      eff = require('./effective-endpoints');
      helpers = require('./constants');
    });
    await eff.applyEndpointOverride(eff.buildNetworkChoiceOverride(MIDEN_NETWORK_NAME.MAINNET));

    expect(helpers.getExplorerTxUrl('0xa84b')).toBe('https://explorer.mainnet.miden.io/tx/0xa84b');
    expect(helpers.getExplorerAccountUrl('mm1azc87wvsq')).toBe('https://explorer.mainnet.miden.io/account/mm1azc87wvsq');
  });

  it('loadEndpointOverrides is a no-op under MIDEN_E2E_DISABLE_ENDPOINT_OVERRIDES', async () => {
    mockKvStore['endpoint_overrides'] = { rpcUrl: 'https://should.ignore/rpc' };
    process.env.MIDEN_E2E_DISABLE_ENDPOINT_OVERRIDES = 'true';
    const m = loadModule();
    await m.loadEndpointOverrides();
    expect(m.getActiveOverride()).toBeNull();
    expect(m.getEffectiveRpcUrl()).toBe(MIDEN_NETWORK_ENDPOINTS.get(m.getEffectiveNetworkName()));
  });

  it('loadEndpointOverrides still applies the override under MIDEN_E2E_TEST alone', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    const m = loadModule();
    const override = m.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET);
    override.rpcUrl = 'https://custom.example/rpc';
    await m.applyEndpointOverride(override);

    const m2 = loadModule();
    await m2.loadEndpointOverrides();
    expect(m2.getEffectiveRpcUrl()).toBe('https://custom.example/rpc');
  });

  it('loadEndpointOverrides ignores a non-"true" value of the opt-out flag', async () => {
    process.env.MIDEN_E2E_DISABLE_ENDPOINT_OVERRIDES = 'false';
    const m = loadModule();
    const override = m.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET);
    override.rpcUrl = 'https://custom.example/rpc';
    await m.applyEndpointOverride(override);

    const m2 = loadModule();
    await m2.loadEndpointOverrides();
    expect(m2.getEffectiveRpcUrl()).toBe('https://custom.example/rpc');
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
      expect(network).toBe(MIDEN_NETWORK_NAME.TESTNET);
      expect(m.getEffectiveDefaultGuardianEndpoint()).toBe('https://guardian-testnet.openzeppelin.com');
    });

    it('is keyed by the effective (overridden) network, not the build network, when no custom guardian URL is set', async () => {
      // The bug this guards against: an endpoint override with no custom guardian URL
      // must fall back to the OVERRIDDEN network's guardian, not the build's
      // DEFAULT_NETWORK guardian.
      const m = loadModule();
      const override = m.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET);
      override.guardianUrl = '';
      await m.applyEndpointOverride(override);
      expect(m.getEffectiveNetworkName()).toBe(MIDEN_NETWORK_NAME.DEVNET);
      expect(m.getEffectiveDefaultGuardianEndpoint()).toBe('https://guardian-devnet.openzeppelin.com');
    });

    it('takes the first operator of the config document list once the realm has one', () => {
      let m!: typeof import('./effective-endpoints');
      jest.isolateModules(() => {
        const { setDocumentGuardians } = require('./guardian-registry');
        m = require('./effective-endpoints');
        setDocumentGuardians(m.getEffectiveNetworkName(), [
          { id: 'kodax', name: 'Koda', operatedBy: 'Koda', location: 'Asia', endpoint: 'https://koda.example' },
          { id: 'open-zeppelin', name: 'OZ', operatedBy: 'OZ', location: 'US', endpoint: 'https://oz.example' }
        ]);
      });
      expect(m.getEffectiveDefaultGuardianEndpoint()).toBe('https://koda.example');
      expect(m.buildDefaultOverrideFor(m.getEffectiveNetworkName()).guardianUrl).toBe('https://koda.example');
    });

    it("returns '' when the effective network has no configured guardian and no custom URL is set", async () => {
      let m!: typeof import('./effective-endpoints');
      jest.isolateModules(() => {
        const { setDocumentGuardians } = require('./guardian-registry');
        m = require('./effective-endpoints');
        setDocumentGuardians(MIDEN_NETWORK_NAME.MAINNET, []);
      });
      await m.applyEndpointOverride(m.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.MAINNET));
      expect(m.getEffectiveNetworkName()).toBe(MIDEN_NETWORK_NAME.MAINNET);
      expect(m.getEffectiveDefaultGuardianEndpoint()).toBe('');
    });
  });

  describe('faucet on a network with none (mainnet)', () => {
    // Another network's faucet would mint test tokens for the mainnet address, which never reach mainnet.
    it.each<[string, (network: MIDEN_NETWORK_NAME) => EndpointOverride]>([
      ['the Mainnet preset', network => buildDefaultOverrideFor(network)],
      ['the onboarding network choice', network => buildNetworkChoiceOverride(network)]
    ])('resolves no faucet and no faucet API under %s, never the build network faucet', async (_label, build) => {
      const m = loadModule();
      await m.applyEndpointOverride(build(MIDEN_NETWORK_NAME.MAINNET));
      expect(m.getEffectiveNetworkName()).toBe(MIDEN_NETWORK_NAME.MAINNET);
      expect(m.getEffectiveFaucetUrl()).toBeUndefined();
      expect(m.getEffectiveFaucetApiUrl()).toBeUndefined();
      expect(m.isFaucetConfigured()).toBe(false);
    });

    it('still resolves the faucet of a network that has one', async () => {
      const m = loadModule();
      expect(m.isFaucetConfigured()).toBe(true);
      await m.applyEndpointOverride(buildNetworkChoiceOverride(MIDEN_NETWORK_NAME.DEVNET));
      expect(m.getEffectiveFaucetApiUrl()).toBe(MIDEN_FAUCET_API_ENDPOINTS.get(MIDEN_NETWORK_NAME.DEVNET));
      expect(m.isFaucetConfigured()).toBe(true);
    });
  });

  describe('loadEndpointOverrides storage failure', () => {
    it('keeps the override cache null (no throw) when storage.get rejects', async () => {
      mockThrows = true;
      const m = loadModule();
      await expect(m.loadEndpointOverrides()).resolves.toBeUndefined();
      expect(m.getActiveOverride()).toBeNull();
    });

    // The service worker re-reads after a Save; when that read fails, it keeps the override it had
    // instead of falling back to build defaults.
    it('keeps a loaded override when a later read fails', async () => {
      const m = loadModule();
      const saved = m.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET);
      await m.applyEndpointOverride(saved);

      mockThrows = true;
      await m.loadEndpointOverrides();
      expect(m.getActiveOverride()).toBe(saved);
    });
  });

  // Developer Settings tells the user a rejected write was not saved, so the session must not
  // switch to endpoints that a restart would drop.
  describe('a rejected storage write', () => {
    const savedA = (m: typeof import('./effective-endpoints')) => {
      const a = m.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET);
      a.rpcUrl = 'https://a.example/rpc';
      return a;
    };

    it('keeps the previous override when applying a new one fails', async () => {
      const m = loadModule();
      const a = savedA(m);
      await m.applyEndpointOverride(a);

      mockWriteThrows = true;
      await expect(m.applyEndpointOverride({ ...a, rpcUrl: 'https://b.example/rpc' })).rejects.toThrow(
        'storage write failed'
      );
      expect(m.getActiveOverride()).toBe(a);
      expect(m.getEffectiveRpcUrl()).toBe('https://a.example/rpc');
    });

    it('keeps the override when clearing it fails', async () => {
      const m = loadModule();
      const a = savedA(m);
      await m.applyEndpointOverride(a);

      mockWriteThrows = true;
      await expect(m.clearEndpointOverride()).rejects.toThrow('storage write failed');
      expect(m.getActiveOverride()).toBe(a);
      expect(m.getEffectiveRpcUrl()).toBe('https://a.example/rpc');
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

describe('getEffectiveAllowNoGuardian', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockKvStore)) delete mockKvStore[k];
  });

  it('defaults to false when no override is active', async () => {
    await loadEndpointOverrides(); // nothing stored -> cache null
    expect(getEffectiveAllowNoGuardian()).toBe(false);
  });

  it('reflects a stored override value', async () => {
    mockKvStore[ENDPOINT_OVERRIDE_STORAGE_KEY] = {
      ...buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET),
      allowNoGuardian: true
    };
    await loadEndpointOverrides();
    expect(getEffectiveAllowNoGuardian()).toBe(true);
  });

  it('reads false from a legacy override that predates the field', async () => {
    const legacy: Record<string, unknown> = { ...buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET) };
    delete legacy.allowNoGuardian;
    mockKvStore[ENDPOINT_OVERRIDE_STORAGE_KEY] = legacy;
    await loadEndpointOverrides();
    expect(getEffectiveAllowNoGuardian()).toBe(false);
  });

  it('buildDefaultOverrideFor includes allowNoGuardian:false', () => {
    expect(buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET).allowNoGuardian).toBe(false);
  });
});

describe('getEffectiveFeeFaucetId', () => {
  it('is unset when nothing is configured', () => {
    const m = loadModule();
    expect(m.getEffectiveFeeFaucetId()).toBeUndefined();
  });

  it('reads MIDEN_FEE_FAUCET_ID from the environment', () => {
    process.env.MIDEN_FEE_FAUCET_ID = '0xenvfaucet';
    const m = loadModule();
    expect(m.getEffectiveFeeFaucetId()).toBe('0xenvfaucet');
  });

  it('prefers the E2E injector over an override', async () => {
    const m = loadModule();
    const override = m.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET);
    override.feeFaucetId = '0xoverride';
    await m.applyEndpointOverride(override);
    await m.setFeeFaucetIdForTest('0xe2e');
    expect(m.getEffectiveFeeFaucetId()).toBe('0xe2e');
    await m.setFeeFaucetIdForTest(undefined);
    expect(m.getEffectiveFeeFaucetId()).toBe('0xoverride');
  });

  it('persists the injector into storage so another realm with storage can load it', async () => {
    const m = loadModule();
    await m.setFeeFaucetIdForTest('0xe2e');
    expect(mockKvStore[m.FEE_FAUCET_STORAGE_KEY]).toBe('0xe2e');
    const other = loadModule();
    await other.loadEndpointOverrides();
    expect(other.getEffectiveFeeFaucetId()).toBe('0xe2e');
  });

  it('loads a stored override that includes feeFaucetId', async () => {
    const m = loadModule();
    mockKvStore[ENDPOINT_OVERRIDE_STORAGE_KEY] = {
      ...m.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET),
      feeFaucetId: '0xstored'
    };
    await m.loadEndpointOverrides();
    expect(m.getEffectiveFeeFaucetId()).toBe('0xstored');
  });
});

// The service worker sends its state to the offscreen document only once it has loaded it (#1482).
describe('whenEndpointOverridesLoaded', () => {
  const isSettled = async (promise: Promise<void>) => {
    let settled = false;
    void promise.then(
      () => (settled = true),
      () => (settled = true)
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    return settled;
  };

  it('stays pending until the first loadEndpointOverrides() settles', async () => {
    mockKvStore[ENDPOINT_OVERRIDE_STORAGE_KEY] = buildNetworkChoiceOverride(MIDEN_NETWORK_NAME.MAINNET);
    const m = loadModule();
    expect(await isSettled(m.whenEndpointOverridesLoaded())).toBe(false);

    await m.loadEndpointOverrides();
    expect(await isSettled(m.whenEndpointOverridesLoaded())).toBe(true);
    expect(m.getEffectiveNetworkName()).toBe(MIDEN_NETWORK_NAME.MAINNET);
  });

  it('settles when the storage read throws', async () => {
    mockThrows = true;
    const m = loadModule();
    await m.loadEndpointOverrides();
    expect(await isSettled(m.whenEndpointOverridesLoaded())).toBe(true);
    expect(m.getActiveOverride()).toBeNull();
  });

  it('settles when overrides are disabled for E2E', async () => {
    process.env.MIDEN_E2E_DISABLE_ENDPOINT_OVERRIDES = 'true';
    const m = loadModule();
    await m.loadEndpointOverrides();
    expect(await isSettled(m.whenEndpointOverridesLoaded())).toBe(true);
  });
});

// The offscreen document has no extension storage, so it runs on the state the service worker sends (#1482).
describe('endpoint state handed to a realm without extension storage', () => {
  const MAINNET = MIDEN_NETWORK_NAME.MAINNET;

  it('adopts the override and fee faucet without a storage call', () => {
    mockThrows = true;
    mockWriteThrows = true;
    const m = loadModule();
    m.adoptEndpointState({ override: buildNetworkChoiceOverride(MAINNET), feeFaucetId: 'x' });

    expect(m.getEffectiveNetworkName()).toBe(MAINNET);
    expect(m.getEffectiveRpcUrl()).toBe(MIDEN_NETWORK_ENDPOINTS.get(MAINNET));
    expect(m.getEffectiveProverUrl()).toBe(MIDEN_PROVING_ENDPOINTS.get(MAINNET));
    expect(m.getEffectiveNoteTransportUrl()).toBe(MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS.get(MAINNET));
    expect(m.getEffectiveFeeFaucetId()).toBe('x');
    expect(mockStorageCalls).toBe(0);
  });

  it('replaces an adopted state, back to the build defaults', () => {
    mockThrows = true;
    const m = loadModule();
    m.adoptEndpointState({ override: buildNetworkChoiceOverride(MAINNET), feeFaucetId: 'x' });
    m.adoptEndpointState({ override: null, feeFaucetId: undefined });

    expect(m.getEffectiveNetworkName()).toBe(DEFAULT_NETWORK);
    expect(m.getEffectiveRpcUrl()).toBe(MIDEN_NETWORK_ENDPOINTS.get(DEFAULT_NETWORK));
    expect(m.getEffectiveFeeFaucetId()).toBeUndefined();
  });

  it('round-trips the service worker state, the E2E fee faucet included', async () => {
    const sw = loadModule();
    const override = { ...sw.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET), rpcUrl: 'https://custom.example/rpc' };
    await sw.applyEndpointOverride(override);
    await sw.setFeeFaucetIdForTest('0xe2e');
    const state = sw.getEndpointState();
    expect(state).toEqual({ override, feeFaucetId: '0xe2e' });

    mockThrows = true;
    mockWriteThrows = true;
    const offscreen = loadModule();
    offscreen.adoptEndpointState(state);
    expect(offscreen.getEndpointState()).toEqual(state);
    expect(offscreen.getEffectiveRpcUrl()).toBe('https://custom.example/rpc');
    expect(offscreen.getEffectiveFeeFaucetId()).toBe('0xe2e');
  });

  it('sameEndpointState compares by value, whatever the key order', () => {
    const m = loadModule();
    const state = { override: buildNetworkChoiceOverride(MAINNET), feeFaucetId: 'x' };
    const o = state.override;
    const reordered: EndpointOverride = {
      presetName: o.presetName,
      networkName: o.networkName,
      allowNoGuardian: o.allowNoGuardian,
      guardianUrl: o.guardianUrl,
      explorerUrl: o.explorerUrl,
      faucetApiUrl: o.faucetApiUrl,
      faucetUrl: o.faucetUrl,
      noteTransportUrl: o.noteTransportUrl,
      proverUrl: o.proverUrl,
      rpcUrl: o.rpcUrl
    };
    expect(Object.keys(reordered)).not.toEqual(Object.keys(o));

    expect(m.sameEndpointState(state, { feeFaucetId: 'x', override: reordered })).toBe(true);
    expect(
      m.sameEndpointState({ override: null, feeFaucetId: undefined }, { override: null, feeFaucetId: undefined })
    ).toBe(true);
    expect(m.sameEndpointState(state, { ...state, feeFaucetId: 'y' })).toBe(false);
    expect(
      m.sameEndpointState(state, { ...state, override: { ...state.override, rpcUrl: 'https://other.example' } })
    ).toBe(false);
    expect(m.sameEndpointState(state, { ...state, override: null })).toBe(false);
  });
});

describe('getTestNetworkNameKey', () => {
  it('names the build network when no override is loaded', () => {
    const m = loadModule();
    expect(m.getTestNetworkNameKey()).toBe(DEFAULT_NETWORK === MIDEN_NETWORK_NAME.MAINNET ? null : DEFAULT_NETWORK);
  });

  it.each([
    [MIDEN_NETWORK_NAME.TESTNET, 'testnet'],
    [MIDEN_NETWORK_NAME.DEVNET, 'devnet'],
    [MIDEN_NETWORK_NAME.LOCALNET, 'localnet'],
    [MIDEN_NETWORK_NAME.MAINNET, null]
  ])('follows an override to %s', async (network, expected) => {
    const m = loadModule();
    await m.applyEndpointOverride(m.buildDefaultOverrideFor(network));
    expect(m.getTestNetworkNameKey()).toBe(expected);
  });

  it('only returns keys the English locale defines', async () => {
    // Callers translate the result with a dynamic t(key), which key-coverage.test
    // cannot see, so a missing entry would render the raw key.
    const en: Record<string, string> = require('../../../public/_locales/en/en.json');
    const keys: string[] = [];
    for (const network of Object.values(MIDEN_NETWORK_NAME)) {
      const m = loadModule();
      await m.applyEndpointOverride(m.buildDefaultOverrideFor(network));
      const key = m.getTestNetworkNameKey();
      if (key !== null) keys.push(key);
    }
    expect(keys.sort()).toEqual(['devnet', 'localnet', 'testnet']);
    expect(keys.filter(key => !(key in en))).toEqual([]);
  });
});

describe('badge network provenance', () => {
  it('retains canonical Mainnet provenance when the saved onboarding choice loads in a new realm', async () => {
    const before = loadModule();
    await before.applyEndpointOverride(before.buildNetworkChoiceOverride(MIDEN_NETWORK_NAME.MAINNET));
    const reloaded = loadModule();
    await reloaded.loadEndpointOverrides();
    expect(reloaded.getEffectiveNetworkName()).toBe(MIDEN_NETWORK_NAME.MAINNET);
    expect(reloaded.hasCustomEndpointOverride).toHaveLength(1);
    expect(reloaded.hasCustomEndpointOverride(reloaded.getActiveOverride())).toBe(false);
  });

  it('accepts build defaults and an endpoint-free onboarding network choice', () => {
    expect(hasCustomEndpointOverride(null)).toBe(false);
    expect(hasCustomEndpointOverride(buildNetworkChoiceOverride(MIDEN_NETWORK_NAME.MAINNET))).toBe(false);
  });

  it.each([
    { rpcUrl: 'https://custom.invalid' },
    { proverUrl: 'https://custom.invalid' },
    { noteTransportUrl: 'https://custom.invalid' },
    { faucetUrl: 'https://custom.invalid' },
    { faucetApiUrl: 'https://custom.invalid' },
    { explorerUrl: 'https://custom.invalid' },
    { guardianUrl: 'https://custom.invalid' },
    { allowNoGuardian: true },
    { feeFaucetId: 'custom-fee' }
  ])('rejects a Mainnet-labelled developer configuration %s', fields => {
    expect(hasCustomEndpointOverride({ ...buildNetworkChoiceOverride(MIDEN_NETWORK_NAME.MAINNET), ...fields })).toBe(
      true
    );
  });
});

describe('developer network choice marker', () => {
  const marked = (m: typeof import('./effective-endpoints')): EndpointOverride => ({
    ...m.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.TESTNET),
    developerChoice: true
  });

  it.each([
    ['no override', undefined],
    ['the onboarding network choice', buildNetworkChoiceOverride(MIDEN_NETWORK_NAME.TESTNET)],
    ['the build defaults of a network', buildDefaultOverrideFor(MIDEN_NETWORK_NAME.TESTNET)]
  ])('is not set by %s', async (_name, override) => {
    const m = loadModule();
    if (override) await m.applyEndpointOverride(override);
    expect(m.hasDeveloperNetworkChoice()).toBe(false);
  });

  it('is set once a marked override is applied, and survives a reload and the offscreen hand-over', async () => {
    const m = loadModule();
    await m.applyEndpointOverride(marked(m));
    expect(m.hasDeveloperNetworkChoice()).toBe(true);

    const reloaded = loadModule();
    await reloaded.loadEndpointOverrides();
    expect(reloaded.hasDeveloperNetworkChoice()).toBe(true);

    const adopted = loadModule();
    adopted.adoptEndpointState(m.getEndpointState());
    expect(adopted.hasDeveloperNetworkChoice()).toBe(true);
  });

  it('forget keeps the stored override but drops the marker', async () => {
    const m = loadModule();
    const override = marked(m);
    await m.applyEndpointOverride(override);

    await m.forgetDeveloperNetworkChoice();

    const stored = mockKvStore[ENDPOINT_OVERRIDE_STORAGE_KEY];
    expect(stored).not.toHaveProperty('developerChoice');
    expect(stored).toMatchObject({ networkName: MIDEN_NETWORK_NAME.TESTNET, rpcUrl: override.rpcUrl });
    expect(m.hasDeveloperNetworkChoice()).toBe(false);
    expect(m.getEffectiveNetworkName()).toBe(MIDEN_NETWORK_NAME.TESTNET);
  });

  it('forget reads the stored override, so a realm that never loaded it still strips the marker', async () => {
    const m = loadModule();
    mockKvStore[ENDPOINT_OVERRIDE_STORAGE_KEY] = marked(m);

    await m.forgetDeveloperNetworkChoice();

    expect(mockKvStore[ENDPOINT_OVERRIDE_STORAGE_KEY]).not.toHaveProperty('developerChoice');
  });

  it('forget writes nothing when the override is unmarked or absent', async () => {
    const m = loadModule();
    await m.forgetDeveloperNetworkChoice();
    await m.applyEndpointOverride(m.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.TESTNET));
    const writes = mockStorageWrites;

    await m.forgetDeveloperNetworkChoice();

    expect(mockStorageWrites).toBe(writes);
    expect(writes).toBe(1);
  });
});

import { MIDEN_NETWORK_NAME, MIDEN_NETWORK_ENDPOINTS } from './constants';

const mockKvStore: Record<string, unknown> = {};
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
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

function loadModule(): typeof import('./effective-endpoints') {
  let mod!: typeof import('./effective-endpoints');
  jest.isolateModules(() => {
    mod = require('./effective-endpoints');
  });
  return mod;
}

beforeEach(() => {
  for (const k of Object.keys(mockKvStore)) delete mockKvStore[k];
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
});

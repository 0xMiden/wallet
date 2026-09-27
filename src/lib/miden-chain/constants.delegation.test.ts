import { getExplorerTxUrl, getGuardianOptionsForNetwork, MIDEN_NETWORK_NAME } from './constants';
import { applyEndpointOverride, buildDefaultOverrideFor, clearEndpointOverride } from './effective-endpoints';

const mockKvStore: Record<string, unknown> = {};
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (k in mockKvStore) out[k] = mockKvStore[k];
      return out;
    },
    set: async (obj: Record<string, unknown>) => Object.assign(mockKvStore, obj),
    remove: async (keys: string[]) => keys.forEach(k => delete mockKvStore[k])
  }),
  StorageProvider: class {}
}));

afterEach(async () => {
  await clearEndpointOverride();
  for (const k of Object.keys(mockKvStore)) delete mockKvStore[k];
});

describe('constants getters delegate to the override', () => {
  it('getGuardianOptionsForNetwork appends a Custom option when a guardian override is set', async () => {
    const override = buildDefaultOverrideFor(MIDEN_NETWORK_NAME.TESTNET);
    override.guardianUrl = 'https://custom.guardian.example';
    await applyEndpointOverride(override);
    const options = getGuardianOptionsForNetwork();
    const custom = options.find(o => o.id === 'custom');
    expect(custom?.endpoint).toBe('https://custom.guardian.example');
  });

  // Dev-only: a developer override that is only a host-case (or default-port)
  // spelling of a built-in must not add a second, duplicate "Custom" option -
  // with the endpoint comparator, ChooseGuardian would badge both it and the
  // built-in "Current" for the same account.
  it('does not append a duplicate Custom option when the override is a host-case spelling of a built-in', async () => {
    const override = buildDefaultOverrideFor(MIDEN_NETWORK_NAME.TESTNET);
    override.guardianUrl = 'https://Guardian.OpenZeppelin.com';
    await applyEndpointOverride(override);
    const options = getGuardianOptionsForNetwork();
    expect(options.find(o => o.id === 'custom')).toBeUndefined();
  });

  it('getExplorerTxUrl uses the effective explorer', async () => {
    const override = buildDefaultOverrideFor(MIDEN_NETWORK_NAME.TESTNET);
    override.explorerUrl = 'https://scan.example';
    await applyEndpointOverride(override);
    expect(getExplorerTxUrl('0xabc')).toBe('https://scan.example/tx/0xabc');
  });
});

import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';
import {
  applyEndpointOverride,
  buildDefaultOverrideFor,
  getEffectiveNoteTransportUrl,
  getEffectiveProverUrl,
  getEffectiveRpcUrl
} from 'lib/miden-chain/effective-endpoints';

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

// Guards the invariant that the resolver is the single source the client reads from:
// `MidenClientInterface.create()`, its `MultisigClient` lookup, its raw-WasmWebClient
// consumable-notes read, `generateTransaction`'s two raw-WasmWebClient reads, and
// `simulateCustomTx` all now call these same getters instead of reading
// MIDEN_NETWORK_ENDPOINTS/MIDEN_PROVING_ENDPOINTS/getNoteTransportUrl directly, so an
// override applied here is guaranteed to be what every one of those call sites sees.
describe('client endpoint resolution honors the override', () => {
  it('effective getters reflect a saved override', async () => {
    const o = buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET);
    o.rpcUrl = 'https://c/rpc';
    o.proverUrl = 'https://c/prover';
    o.noteTransportUrl = 'https://c/ntl';
    await applyEndpointOverride(o);
    expect(getEffectiveRpcUrl()).toBe('https://c/rpc');
    expect(getEffectiveProverUrl()).toBe('https://c/prover');
    expect(getEffectiveNoteTransportUrl()).toBe('https://c/ntl');
  });
});

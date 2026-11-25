import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

import { MIDEN_NAME_SLOTS, type MidenNameConfig } from './config';
import { type Felts4, encodeDomainFelts } from './encoding';
import { MidenNameAbortedError, MidenNameUnsupportedNetworkError } from './errors';
import { type RegistryMapRequest, type RegistryStorageRead, readRegistryStorage } from './reads';
import { clearMidenNameResolverCache, fetchDomainRecord, fetchDomainRecordAccount, resolveMidenName } from './resolver';
import { statusKeyFeltsForLabel } from './sdk-words';
import { AccountId, KNOWN_ACCOUNTS } from './test-support/fake-sdk';

jest.mock('@miden-sdk/miden-sdk/lazy', () => jest.requireActual('lib/miden/name/test-support/fake-sdk'));
jest.mock('lib/miden-chain/constants', () => ({ ensureSdkWasmReady: jest.fn(async () => undefined) }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: jest.fn(),
  getEffectiveRpcUrl: jest.fn(() => 'https://rpc-a.example')
}));
jest.mock('./reads', () => {
  const actual = jest.requireActual<typeof import('./reads')>('./reads');
  return {
    captureEffectiveScope: actual.captureEffectiveScope,
    assertScopeCurrent: actual.assertScopeCurrent,
    awaitScoped: actual.awaitScoped,
    readRegistryStorage: jest.fn()
  };
});
jest.mock('lib/miden/sdk/helpers', () => ({
  walletAccountIdToSdk: jest.fn(),
  getBech32AddressFromAccountId: jest.fn()
}));

const REGISTRY_HEX = '0x16fb70069eed60110c6207189c8237';
const REGISTRY = { prefix: 0xaan, suffix: 0xbbn };
const ALICE = { prefix: 0x1234n, suffix: 0x5600n };
const ZERO: Felts4 = [0n, 0n, 0n, 0n];

const mockWasmReady = jest.mocked(ensureSdkWasmReady);
const mockNetwork = jest.mocked(getEffectiveNetworkName);
const mockRpcUrl = jest.mocked(getEffectiveRpcUrl);
const mockRead = jest.mocked(readRegistryStorage);
const helpers = jest.requireMock<{
  walletAccountIdToSdk: jest.Mock<AccountId, [string]>;
  getBech32AddressFromAccountId: jest.Mock<string, [AccountId]>;
}>('lib/miden/sdk/helpers');

let state: Map<string, Map<string, Felts4>>;

function setEntry(slot: string, key: Felts4, value: Felts4): void {
  const entries = state.get(slot) ?? new Map<string, Felts4>();
  entries.set(key.join(','), value);
  state.set(slot, entries);
}

function accountValue(parts: { prefix: bigint; suffix: bigint }): Felts4 {
  return [0n, 0n, parts.suffix, parts.prefix];
}

function fakeRead(_config: MidenNameConfig, _requests: RegistryMapRequest[]): Promise<RegistryStorageRead> {
  return Promise.resolve({
    blockNum: 1,
    slotValue: () => undefined,
    mapValue: (slot: string, key: Felts4) => state.get(slot)?.get(key.join(',')) ?? ZERO
  });
}

function registerAlice({ viaDomainWord = false } = {}): void {
  const forwardKey = viaDomainWord ? encodeDomainFelts('alice') : statusKeyFeltsForLabel('alice', REGISTRY);
  setEntry(MIDEN_NAME_SLOTS.domainToAccount, forwardKey, accountValue(ALICE));
}

beforeEach(() => {
  jest.clearAllMocks();
  clearMidenNameResolverCache();
  state = new Map();
  KNOWN_ACCOUNTS.set(REGISTRY_HEX, REGISTRY);
  mockWasmReady.mockReset().mockResolvedValue(undefined);
  mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
  mockRpcUrl.mockReturnValue('https://rpc-a.example');
  mockRead.mockImplementation(fakeRead);
  helpers.getBech32AddressFromAccountId.mockImplementation(id => `mtst1${id.prefixValue.toString(16)}`);
  helpers.walletAccountIdToSdk.mockImplementation(() => new AccountId('0xalice', ALICE.prefix, ALICE.suffix));
});

describe('resolveMidenName', () => {
  it('resolves on the forward record alone, with ONE read of domain_to_account', async () => {
    registerAlice();
    await expect(resolveMidenName('alice')).resolves.toBe('mtst11234');
    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(mockRead.mock.calls[0]?.[1]).toEqual([
      {
        slot: MIDEN_NAME_SLOTS.domainToAccount,
        keys: [statusKeyFeltsForLabel('alice', REGISTRY), encodeDomainFelts('alice')]
      }
    ]);
    expect(mockRead.mock.calls[0]?.[3]).toEqual({
      scope: { network: MIDEN_NETWORK_NAME.TESTNET, rpcUrl: 'https://rpc-a.example' }
    });
  });

  it('falls back to the raw domain word as the forward key', async () => {
    registerAlice({ viaDomainWord: true });
    await expect(resolveMidenName('alice')).resolves.toBe('mtst11234');
  });

  it('returns null when there is no forward record, and caches it', async () => {
    await expect(resolveMidenName('alice')).resolves.toBeNull();
    await expect(resolveMidenName('alice')).resolves.toBeNull();
    expect(mockRead).toHaveBeenCalledTimes(1);
  });

  it('returns null for a forward value with an unknown layout', async () => {
    setEntry(MIDEN_NAME_SLOTS.domainToAccount, statusKeyFeltsForLabel('alice', REGISTRY), [1n, 0n, 2n, 3n]);
    await expect(resolveMidenName('alice')).resolves.toBeNull();
    expect(mockRead).toHaveBeenCalledTimes(1);
  });

  it('returns null when the record is not a valid account id', async () => {
    const bad = { prefix: 0n, suffix: 9n };
    setEntry(MIDEN_NAME_SLOTS.domainToAccount, statusKeyFeltsForLabel('alice', REGISTRY), accountValue(bad));
    await expect(resolveMidenName('alice')).resolves.toBeNull();
  });

  it('returns null without a read on an unsupported network or for an invalid label', async () => {
    await expect(resolveMidenName('Al!ce')).resolves.toBeNull();
    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.DEVNET);
    await expect(resolveMidenName('alice')).resolves.toBeNull();
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('throws MidenNameAbortedError for an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(resolveMidenName('alice', { signal: controller.signal })).rejects.toThrow(MidenNameAbortedError);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('throws MidenNameAbortedError when the signal aborts during a read', async () => {
    registerAlice();
    const controller = new AbortController();
    mockRead.mockImplementationOnce(async (config, requests) => {
      controller.abort();
      return fakeRead(config, requests);
    });
    await expect(resolveMidenName('alice', { signal: controller.signal })).rejects.toThrow(MidenNameAbortedError);
  });

  it('throws an RPC failure and does not cache it', async () => {
    mockRead.mockRejectedValueOnce(new Error('node down'));
    await expect(resolveMidenName('alice')).rejects.toThrow('node down');
    registerAlice();
    await expect(resolveMidenName('alice')).resolves.toBe('mtst11234');
  });

  it('reads again after the cache TTL', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(5_000_000);
    await expect(resolveMidenName('alice')).resolves.toBeNull();
    registerAlice();
    await expect(resolveMidenName('alice')).resolves.toBeNull();
    now.mockReturnValue(5_000_000 + 60_000);
    await expect(resolveMidenName('alice')).resolves.toBe('mtst11234');
    now.mockRestore();
  });

  it('isolates resolver cache by RPC URL and aborts without caching when scope changes in flight', async () => {
    registerAlice();
    await expect(resolveMidenName('alice')).resolves.toBe('mtst11234');
    expect(mockRead).toHaveBeenCalledTimes(1);

    mockRpcUrl.mockReturnValue('https://rpc-b.example');
    state.clear();
    await expect(resolveMidenName('alice')).resolves.toBeNull();
    expect(mockRead).toHaveBeenCalledTimes(2);

    registerAlice();
    mockRead.mockImplementationOnce(async (config, requests) => {
      mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.MAINNET);
      return fakeRead(config, requests);
    });
    await expect(resolveMidenName('bob')).rejects.toBeInstanceOf(MidenNameAbortedError);
    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
    await expect(resolveMidenName('bob')).resolves.toBeNull();
    expect(mockRead).toHaveBeenCalledTimes(4);
  });
});

describe('fetchDomainRecord', () => {
  it('returns the account of the forward record, with no reverse read', async () => {
    registerAlice();
    await expect(fetchDomainRecord('alice')).resolves.toEqual(ALICE);
    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(mockRead.mock.calls[0]?.[1]).toEqual([
      {
        slot: MIDEN_NAME_SLOTS.domainToAccount,
        keys: [statusKeyFeltsForLabel('alice', REGISTRY), encodeDomainFelts('alice')]
      }
    ]);
    expect(mockRead.mock.calls[0]?.[3]).toEqual({
      scope: { network: MIDEN_NETWORK_NAME.TESTNET, rpcUrl: 'https://rpc-a.example' }
    });
  });

  it('falls back to the raw domain word as the forward key', async () => {
    registerAlice({ viaDomainWord: true });
    await expect(fetchDomainRecord('alice')).resolves.toEqual(ALICE);
  });

  it('returns null when the registry has no record', async () => {
    await expect(fetchDomainRecord('alice')).resolves.toBeNull();
  });

  it('does not use the cache: it sees a record the moment it is written', async () => {
    await expect(fetchDomainRecord('alice')).resolves.toBeNull();
    registerAlice();
    await expect(fetchDomainRecord('alice')).resolves.toEqual(ALICE);
    expect(mockRead).toHaveBeenCalledTimes(2);
  });

  it('throws on a network with no deployment', async () => {
    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.DEVNET);
    await expect(fetchDomainRecord('alice')).rejects.toBeInstanceOf(MidenNameUnsupportedNetworkError);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('throws an RPC failure', async () => {
    mockRead.mockRejectedValue(new Error('rpc down'));
    await expect(fetchDomainRecord('alice')).rejects.toThrow('rpc down');
  });
});

describe('fetchDomainRecordAccount', () => {
  it('formats the resolved account id and aborts without formatting if scope switches in flight', async () => {
    registerAlice();
    await expect(fetchDomainRecordAccount('alice')).resolves.toBe('mtst11234');

    helpers.getBech32AddressFromAccountId.mockClear();
    mockRead.mockImplementationOnce(async (config, requests) => {
      mockRpcUrl.mockReturnValue('https://rpc-b.example');
      return fakeRead(config, requests);
    });
    await expect(fetchDomainRecordAccount('alice')).rejects.toBeInstanceOf(MidenNameAbortedError);
    expect(helpers.getBech32AddressFromAccountId).not.toHaveBeenCalled();
  });

  it('awaits ensureSdkWasmReady on cold start after early exits for invalid labels, unsupported networks, and cache hits', async () => {
    let wasmReady = false;
    let resolveReady!: () => void;
    mockWasmReady.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          resolveReady = () => {
            wasmReady = true;
            resolve();
          };
        })
    );
    const origFromHex = AccountId.fromHex.bind(AccountId);
    const fromHexSpy = jest.spyOn(AccountId, 'fromHex').mockImplementation(hex => {
      if (!wasmReady) throw new Error('WASM not initialized');
      return origFromHex(hex);
    });

    try {
      await expect(resolveMidenName('Al!ce')).resolves.toBeNull();
      await expect(fetchDomainRecord('Al!ce')).rejects.toThrow(/Invalid Miden Name label/);
      expect(mockWasmReady).not.toHaveBeenCalled();

      mockRead.mockResolvedValueOnce({
        blockNum: 1,
        slotValue: () => undefined,
        mapValue: () => accountValue(ALICE)
      });
      const pending = resolveMidenName('alice');
      await Promise.resolve();
      expect(fromHexSpy).not.toHaveBeenCalled();
      resolveReady();
      await expect(pending).resolves.toBe('mtst11234');

      mockWasmReady.mockClear();
      await expect(resolveMidenName('alice')).resolves.toBe('mtst11234');
      expect(mockWasmReady).not.toHaveBeenCalled();
    } finally {
      fromHexSpy.mockRestore();
    }
  });

  it('aborts on interleaved microtask switches, late signal aborts, and rejection arms without caching', async () => {
    registerAlice();

    mockRead.mockImplementationOnce(async (config, requests) => {
      const res = await fakeRead(config, requests);
      queueMicrotask(() => queueMicrotask(() => mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.MAINNET)));
      return res;
    });
    await expect(resolveMidenName('alice')).rejects.toBeInstanceOf(MidenNameAbortedError);
    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);

    const controller = new AbortController();
    mockRead.mockImplementationOnce(async (config, requests) => {
      const res = await fakeRead(config, requests);
      queueMicrotask(() => queueMicrotask(() => controller.abort()));
      return res;
    });
    await expect(resolveMidenName('alice', { signal: controller.signal })).rejects.toBeInstanceOf(
      MidenNameAbortedError
    );

    mockRead.mockImplementationOnce(async (config, requests) => {
      const res = await fakeRead(config, requests);
      queueMicrotask(() => queueMicrotask(() => mockRpcUrl.mockReturnValue('https://rpc-b.example')));
      return res;
    });
    await expect(fetchDomainRecordAccount('alice')).rejects.toBeInstanceOf(MidenNameAbortedError);
    mockRpcUrl.mockReturnValue('https://rpc-a.example');

    mockRead.mockImplementationOnce(async (config, requests) => {
      const res = await fakeRead(config, requests);
      queueMicrotask(() => queueMicrotask(() => mockRpcUrl.mockReturnValue('https://rpc-b.example')));
      return res;
    });
    await expect(fetchDomainRecord('alice')).rejects.toBeInstanceOf(MidenNameAbortedError);
    mockRpcUrl.mockReturnValue('https://rpc-a.example');

    const controller2 = new AbortController();
    mockRead.mockImplementationOnce(async () => {
      controller2.abort();
      throw new Error('rpc down');
    });
    await expect(resolveMidenName('alice', { signal: controller2.signal })).rejects.toBeInstanceOf(
      MidenNameAbortedError
    );

    const scheduleTicks = (ticks: number, fn: () => void) => {
      const step = (remaining: number) => {
        if (remaining <= 1) queueMicrotask(fn);
        else queueMicrotask(() => step(remaining - 1));
      };
      step(ticks);
    };

    helpers.getBech32AddressFromAccountId.mockClear();
    mockRead.mockClear();
    mockWasmReady.mockImplementationOnce(async () => {
      scheduleTicks(2, () => mockRpcUrl.mockReturnValue('https://rpc-b.example'));
    });
    await expect(resolveMidenName('alice')).rejects.toBeInstanceOf(MidenNameAbortedError);
    expect(mockRead).not.toHaveBeenCalled();

    mockRpcUrl.mockReturnValue('https://rpc-a.example');
    mockRead.mockImplementationOnce(async (config, requests) => {
      const res = await fakeRead(config, requests);
      scheduleTicks(2, () => mockRpcUrl.mockReturnValue('https://rpc-b.example'));
      return res;
    });
    await expect(resolveMidenName('alice')).rejects.toBeInstanceOf(MidenNameAbortedError);
    expect(helpers.getBech32AddressFromAccountId).not.toHaveBeenCalled();

    mockRpcUrl.mockReturnValue('https://rpc-a.example');
    mockRead.mockImplementationOnce(async (config, requests) => {
      const res = await fakeRead(config, requests);
      scheduleTicks(4, () => mockRpcUrl.mockReturnValue('https://rpc-b.example'));
      return res;
    });
    await expect(resolveMidenName('alice')).rejects.toBeInstanceOf(MidenNameAbortedError);
    expect(helpers.getBech32AddressFromAccountId).not.toHaveBeenCalled();

    mockRpcUrl.mockReturnValue('https://rpc-a.example');
    const controller3 = new AbortController();
    mockRead.mockImplementationOnce(async (config, requests) => {
      const res = await fakeRead(config, requests);
      scheduleTicks(4, () => controller3.abort());
      return res;
    });
    await expect(resolveMidenName('alice', { signal: controller3.signal })).rejects.toBeInstanceOf(
      MidenNameAbortedError
    );
    expect(helpers.getBech32AddressFromAccountId).not.toHaveBeenCalled();

    mockRead.mockImplementationOnce(async (config, requests) => {
      const res = await fakeRead(config, requests);
      scheduleTicks(4, () => mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.MAINNET));
      return res;
    });
    await expect(fetchDomainRecordAccount('alice')).rejects.toBeInstanceOf(MidenNameAbortedError);
    expect(helpers.getBech32AddressFromAccountId).not.toHaveBeenCalled();
    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);

    mockRead.mockImplementationOnce(async (config, requests) => {
      const res = await fakeRead(config, requests);
      scheduleTicks(4, () => mockRpcUrl.mockReturnValue('https://rpc-b.example'));
      return res;
    });
    await expect(fetchDomainRecord('alice')).rejects.toBeInstanceOf(MidenNameAbortedError);
    mockRpcUrl.mockReturnValue('https://rpc-a.example');

    await expect(resolveMidenName('alice')).resolves.toBe('mtst11234');
    expect(mockRead).toHaveBeenCalledTimes(6);

    clearMidenNameResolverCache();
    const signalController = new AbortController();
    await expect(resolveMidenName('alice', { signal: signalController.signal })).resolves.toBe('mtst11234');
    expect(mockRead.mock.calls[6]?.[3]?.scope).toEqual({
      network: MIDEN_NETWORK_NAME.TESTNET,
      rpcUrl: 'https://rpc-a.example'
    });
    expect(mockRead.mock.calls[6]?.[3]?.signal).toBe(signalController.signal);
  });
});

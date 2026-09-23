import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

import { MIDEN_NAME_SLOTS, type MidenNameConfig } from './config';
import { type Felts4, accountKeyFelts, encodeDomainFelts } from './encoding';
import { MidenNameAbortedError, MidenNameUnsupportedNetworkError } from './errors';
import { type RegistryMapRequest, type RegistryStorageRead, readRegistryStorage } from './reads';
import { clearMidenNameResolverCache, fetchDomainRecord, resolveMidenName, reverseResolveMidenName } from './resolver';
import { statusKeyFeltsForLabel } from './sdk-words';
import { AccountId, KNOWN_ACCOUNTS } from './test-support/fake-sdk';

jest.mock('@miden-sdk/miden-sdk/lazy', () => jest.requireActual('lib/miden/name/test-support/fake-sdk'));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: jest.fn() }));
jest.mock('./reads', () => ({ readRegistryStorage: jest.fn() }));
jest.mock('lib/miden/sdk/helpers', () => ({
  walletAccountIdToSdk: jest.fn(),
  getBech32AddressFromAccountId: jest.fn()
}));

const REGISTRY_HEX = '0xead81800958e7a112d45bdcf852fa6';
const REGISTRY = { prefix: 0xaan, suffix: 0xbbn };
const ALICE = { prefix: 0x1234n, suffix: 0x5600n };
const ZERO: Felts4 = [0n, 0n, 0n, 0n];

const mockNetwork = jest.mocked(getEffectiveNetworkName);
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
    mapValue: (slot: string, key: Felts4) => state.get(slot)?.get(key.join(',')) ?? ZERO
  });
}

function registerAlice({ viaDomainWord = false } = {}): void {
  const forwardKey = viaDomainWord ? encodeDomainFelts('alice') : statusKeyFeltsForLabel('alice', REGISTRY);
  setEntry(MIDEN_NAME_SLOTS.domainToAccount, forwardKey, accountValue(ALICE));
  setEntry(MIDEN_NAME_SLOTS.accountToDomain, accountKeyFelts(ALICE), encodeDomainFelts('alice'));
}

beforeEach(() => {
  jest.clearAllMocks();
  clearMidenNameResolverCache();
  state = new Map();
  KNOWN_ACCOUNTS.set(REGISTRY_HEX, REGISTRY);
  mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
  mockRead.mockImplementation(fakeRead);
  helpers.getBech32AddressFromAccountId.mockImplementation(id => `mtst1${id.prefixValue.toString(16)}`);
  helpers.walletAccountIdToSdk.mockImplementation(() => new AccountId('0xalice', ALICE.prefix, ALICE.suffix));
});

describe('resolveMidenName', () => {
  it('resolves when the forward and reverse records agree', async () => {
    registerAlice();
    await expect(resolveMidenName('alice')).resolves.toBe('mtst11234');
    expect(mockRead).toHaveBeenCalledTimes(2);
    const forwardRequest = mockRead.mock.calls[0]?.[1];
    expect(forwardRequest).toEqual([
      {
        slot: MIDEN_NAME_SLOTS.domainToAccount,
        keys: [statusKeyFeltsForLabel('alice', REGISTRY), encodeDomainFelts('alice')]
      }
    ]);
    expect(mockRead.mock.calls[1]?.[1]).toEqual([
      { slot: MIDEN_NAME_SLOTS.accountToDomain, keys: [accountKeyFelts(ALICE)] }
    ]);
  });

  it('falls back to the raw domain word as the forward key', async () => {
    registerAlice({ viaDomainWord: true });
    await expect(resolveMidenName('alice')).resolves.toBe('mtst11234');
  });

  it('accepts a reverse value that is the commitment key', async () => {
    registerAlice();
    setEntry(MIDEN_NAME_SLOTS.accountToDomain, accountKeyFelts(ALICE), statusKeyFeltsForLabel('alice', REGISTRY));
    await expect(resolveMidenName('alice')).resolves.toBe('mtst11234');
  });

  it('returns null when there is no forward record, and caches it', async () => {
    await expect(resolveMidenName('alice')).resolves.toBeNull();
    await expect(resolveMidenName('alice')).resolves.toBeNull();
    expect(mockRead).toHaveBeenCalledTimes(1);
  });

  it('returns null when the reverse record points to another name', async () => {
    registerAlice();
    setEntry(MIDEN_NAME_SLOTS.accountToDomain, accountKeyFelts(ALICE), encodeDomainFelts('bob'));
    await expect(resolveMidenName('alice')).resolves.toBeNull();
  });

  it('returns null when the reverse record is missing', async () => {
    registerAlice();
    state.delete(MIDEN_NAME_SLOTS.accountToDomain);
    await expect(resolveMidenName('alice')).resolves.toBeNull();
  });

  it('returns null for a forward value with an unknown layout', async () => {
    setEntry(MIDEN_NAME_SLOTS.domainToAccount, statusKeyFeltsForLabel('alice', REGISTRY), [1n, 0n, 2n, 3n]);
    await expect(resolveMidenName('alice')).resolves.toBeNull();
    expect(mockRead).toHaveBeenCalledTimes(1);
  });

  it('returns null when the record is not a valid account id', async () => {
    const bad = { prefix: 0n, suffix: 9n };
    setEntry(MIDEN_NAME_SLOTS.domainToAccount, statusKeyFeltsForLabel('alice', REGISTRY), accountValue(bad));
    setEntry(MIDEN_NAME_SLOTS.accountToDomain, accountKeyFelts(bad), encodeDomainFelts('alice'));
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

describe('reverseResolveMidenName', () => {
  it('returns the label when both records agree, and caches it', async () => {
    registerAlice();
    await expect(reverseResolveMidenName('mtst1alice')).resolves.toBe('alice');
    await expect(reverseResolveMidenName('mtst1alice')).resolves.toBe('alice');
    expect(mockRead).toHaveBeenCalledTimes(2);
    expect(helpers.walletAccountIdToSdk).toHaveBeenCalledWith('mtst1alice');
  });

  it('returns null when the forward record points to another account', async () => {
    registerAlice();
    setEntry(
      MIDEN_NAME_SLOTS.domainToAccount,
      statusKeyFeltsForLabel('alice', REGISTRY),
      accountValue({ prefix: 0x9999n, suffix: 0n })
    );
    await expect(reverseResolveMidenName('mtst1alice')).resolves.toBeNull();
  });

  it('returns null when the forward record is missing', async () => {
    setEntry(MIDEN_NAME_SLOTS.accountToDomain, accountKeyFelts(ALICE), encodeDomainFelts('alice'));
    await expect(reverseResolveMidenName('mtst1alice')).resolves.toBeNull();
  });

  it('returns null when the reverse value is not a domain word', async () => {
    registerAlice();
    setEntry(MIDEN_NAME_SLOTS.accountToDomain, accountKeyFelts(ALICE), statusKeyFeltsForLabel('alice', REGISTRY));
    await expect(reverseResolveMidenName('mtst1alice')).resolves.toBeNull();
    expect(mockRead).toHaveBeenCalledTimes(1);
  });

  it('returns null for an account id that does not parse', async () => {
    helpers.walletAccountIdToSdk.mockImplementation(() => {
      throw new Error('bad id');
    });
    await expect(reverseResolveMidenName('garbage')).resolves.toBeNull();
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('returns null on an unsupported network', async () => {
    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.DEVNET);
    await expect(reverseResolveMidenName('mtst1alice')).resolves.toBeNull();
    expect(mockRead).not.toHaveBeenCalled();
  });
});

import { getCurrentMidenBlock } from 'lib/epoch/chain';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

import { MIDEN_NAME_SLOTS } from './config';
import {
  type AccountIdParts,
  type Felts4,
  encodeDomainFelts,
  REGISTRY_NOTE_ACTION,
  registryNoteInputs
} from './encoding';
import {
  MidenNameAbortedError,
  MidenNameInvalidLabelError,
  MidenNameNotHeldError,
  MidenNameRegistryMismatchError,
  MidenNameUnsupportedNetworkError,
  isMidenNameAbortedError
} from './errors';
import {
  REGISTRY_CLEARING_SUPPORTED,
  REGISTRY_PUBLISHING_SUPPORTED,
  accountHoldsDomainNfa,
  buildPublishNameRecordRequest,
  listOwnedDomainLabels,
  publishRegistryRecord
} from './nfa';
import type { PublishNameRecordRequest } from './note';
import { type RegistryMapRequest, type RegistryStorageRead, readRegistryStorage } from './reads';
import { domainCommitment } from './sdk-words';
import {
  Account,
  AccountId,
  AssetVault,
  KNOWN_ACCOUNTS,
  NON_PUBLIC_ACCOUNTS,
  NOTE_BUILD_LOG,
  NonFungibleAsset,
  NoteType,
  TransactionRequestBuilder,
  Word
} from './test-support/fake-sdk';

jest.mock('@miden-sdk/miden-sdk/lazy', () => jest.requireActual('lib/miden/name/test-support/fake-sdk'));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: jest.fn() }));
jest.mock('lib/epoch/chain', () => ({ getCurrentMidenBlock: jest.fn() }));
jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: { getAccount: jest.fn() } }));
jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: jest.fn(),
  getBech32AddressFromAccountId: jest.fn(),
  randomFeeSalt: jest.fn()
}));
jest.mock('lib/miden/sdk/miden-client', () => ({
  withWasmClientLock: jest.fn(),
  assertWasmHoldCurrent: jest.fn()
}));
jest.mock('lib/miden/transaction/initiate', () => ({ initiatePublishNameRecordTransaction: jest.fn() }));
jest.mock('lib/settings/helpers', () => ({ isDelegateProofEnabled: jest.fn(() => true) }));
jest.mock('./reads', () => ({ readRegistryStorage: jest.fn() }));
jest.mock('./script', () => ({ loadRegistryNoteScript: jest.fn() }));

/** `findDomainNfa` takes SDK objects. The test gives it the fakes. */
interface FindDomainNfaModule {
  findDomainNfa: (
    account: Account,
    label: string,
    registry: AccountIdParts,
    registryHex: string
  ) => NonFungibleAsset | undefined;
}
const { findDomainNfa } = jest.requireActual<FindDomainNfaModule>('./nfa');

const REGISTRY_HEX = '0xead81800958e7a112d45bdcf852fa6';
const OTHER_FAUCET_HEX = '0xotherfaucet';
const SENDER_HEX = '0xsender';
const REGISTRY = { prefix: 0xaan, suffix: 0xbbn };
const SENDER = { prefix: 0x11n, suffix: 0x22n };

const HOLD = { hold: 'current' };
const SALT = new Word(BigUint64Array.from([5n, 6n, 7n, 8n]));

type LockOperation = (hold: object) => Promise<unknown>;

interface FakeScript {
  script: string;
  free: jest.Mock<void, []>;
}

const mockNetwork = jest.mocked(getEffectiveNetworkName);
const mockTip = jest.mocked(getCurrentMidenBlock);
const mockRead = jest.mocked(readRegistryStorage);
const mockGetAccount = jest.requireMock<{
  midenClientProxy: { getAccount: jest.Mock<Promise<Account | null>, [string]> };
}>('lib/miden/back/miden-client-proxy').midenClientProxy.getAccount;
const mockSalt = jest.requireMock<{ randomFeeSalt: jest.Mock<Word, []> }>('lib/miden/sdk/helpers').randomFeeSalt;
const lock = jest.requireMock<{
  withWasmClientLock: jest.Mock<Promise<unknown>, [LockOperation, object]>;
  assertWasmHoldCurrent: jest.Mock<void, [object, string]>;
}>('lib/miden/sdk/miden-client');
const mockLock = lock.withWasmClientLock;
const mockAssertHold = lock.assertWasmHoldCurrent;
const mockLoadScript = jest.requireMock<{ loadRegistryNoteScript: jest.Mock<Promise<FakeScript>, []> }>(
  './script'
).loadRegistryNoteScript;
const mockInitiate = jest.requireMock<{
  initiatePublishNameRecordTransaction: jest.Mock<
    Promise<string>,
    [{ accountId: string; label: string; request: PublishNameRecordRequest; delegateTransaction?: boolean }]
  >;
}>('lib/miden/transaction/initiate').initiatePublishNameRecordTransaction;
const mockDelegate = jest.requireMock<{ isDelegateProofEnabled: jest.Mock<boolean, []> }>(
  'lib/settings/helpers'
).isDelegateProofEnabled;

let script: FakeScript;

function registryId(): AccountId {
  return AccountId.fromHex(REGISTRY_HEX);
}

/** The vault key of the NFA of `label`: the first two commitment felts, then two free limbs. */
function nameKey(label: string, rest: [bigint, bigint] = [3n, 4n]): bigint[] {
  const commitment = domainCommitment(label, REGISTRY);
  return [commitment[0], commitment[1], ...rest];
}

function nameNfa(label: string, faucet: AccountId = registryId()): NonFungibleAsset {
  return new NonFungibleAsset(faucet, nameKey(label));
}

function accountWith(...nfas: NonFungibleAsset[]): Account {
  return new Account(new AssetVault(nfas));
}

/** A storage read that answers `token_to_domain` from a key → value table. */
function storageOf(values: Map<string, Felts4>): RegistryStorageRead {
  return {
    blockNum: 1,
    mapValue: (_slot: string, key: Felts4) => values.get(key.join(',')) ?? [0n, 0n, 0n, 0n]
  };
}

function mapKeyOf(label: string): string {
  const commitment = domainCommitment(label, REGISTRY);
  return [commitment[0], commitment[1], 0n, 0n].join(',');
}

function builtNote() {
  const builder = TransactionRequestBuilder.lastBuilt;
  const note = builder?.ownOutputNotes?.notes[0];
  if (!note) throw new Error('no note was built');
  return { builder, note };
}

beforeEach(() => {
  jest.clearAllMocks();
  NOTE_BUILD_LOG.length = 0;
  TransactionRequestBuilder.lastBuilt = undefined;
  NON_PUBLIC_ACCOUNTS.clear();
  KNOWN_ACCOUNTS.clear();
  KNOWN_ACCOUNTS.set(REGISTRY_HEX, REGISTRY);
  KNOWN_ACCOUNTS.set(OTHER_FAUCET_HEX, { prefix: 0x77n, suffix: 0x88n });
  KNOWN_ACCOUNTS.set(SENDER_HEX, SENDER);
  mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
  mockTip.mockResolvedValue(1000);
  mockSalt.mockReturnValue(SALT);
  mockLock.mockImplementation(async operation => operation(HOLD));
  script = { script: 'registry', free: jest.fn() };
  mockLoadScript.mockResolvedValue(script);
  mockGetAccount.mockResolvedValue(accountWith(nameNfa('alice')));
  mockDelegate.mockReturnValue(true);
});

describe('flags', () => {
  it('supports publishing and does not support clearing yet', () => {
    expect(REGISTRY_PUBLISHING_SUPPORTED).toBe(true);
    expect(REGISTRY_CLEARING_SUPPORTED).toBe(false);
  });
});

describe('findDomainNfa', () => {
  it('returns the NFA whose faucet is the registry and whose first two limbs are the commitment', () => {
    const other = nameNfa('bob');
    const alice = nameNfa('alice');
    const found = findDomainNfa(accountWith(other, alice), 'alice', REGISTRY, REGISTRY_HEX);

    expect(found).toBe(alice);
    expect(alice.freed).toBe(0);
    // Every NFA that is not returned is freed.
    expect(other.freed).toBe(1);
  });

  it('compares the faucet hex with no regard to case', () => {
    const alice = nameNfa('alice');
    expect(findDomainNfa(accountWith(alice), 'alice', REGISTRY, REGISTRY_HEX.toUpperCase().replace('0X', '0x'))).toBe(
      alice
    );
  });

  it('refuses an NFA of an other faucet with the same key', () => {
    const foreign = nameNfa('alice', AccountId.fromHex(OTHER_FAUCET_HEX));
    expect(findDomainNfa(accountWith(foreign), 'alice', REGISTRY, REGISTRY_HEX)).toBeUndefined();
    expect(foreign.freed).toBe(1);
  });

  it.each<[string, bigint, bigint]>([
    ['limb 0', 1n, 0n],
    ['limb 1', 0n, 1n]
  ])('refuses an NFA with a different %s', (_name, delta0, delta1) => {
    const commitment = domainCommitment('alice', REGISTRY);
    const nfa = new NonFungibleAsset(registryId(), [commitment[0] + delta0, commitment[1] + delta1, 3n, 4n]);
    expect(findDomainNfa(accountWith(nfa), 'alice', REGISTRY, REGISTRY_HEX)).toBeUndefined();
    expect(nfa.freed).toBe(1);
  });

  it('ignores limbs 2 and 3 of the vault key', () => {
    const nfa = new NonFungibleAsset(registryId(), nameKey('alice', [99n, 98n]));
    expect(findDomainNfa(accountWith(nfa), 'alice', REGISTRY, REGISTRY_HEX)).toBe(nfa);
  });

  it('returns the first match and frees a second match', () => {
    const first = nameNfa('alice');
    const second = nameNfa('alice');
    expect(findDomainNfa(accountWith(first, second), 'alice', REGISTRY, REGISTRY_HEX)).toBe(first);
    expect(first.freed).toBe(0);
    expect(second.freed).toBe(1);
  });

  it('returns undefined for an empty vault', () => {
    expect(findDomainNfa(accountWith(), 'alice', REGISTRY, REGISTRY_HEX)).toBeUndefined();
  });
});

describe('accountHoldsDomainNfa', () => {
  it('is held when the vault has the NFA, and frees the NFA', async () => {
    const alice = nameNfa('alice');
    mockGetAccount.mockResolvedValue(accountWith(alice));

    await expect(accountHoldsDomainNfa(SENDER_HEX, 'alice')).resolves.toBe('held');

    expect(alice.freed).toBe(1);
    expect(mockGetAccount).toHaveBeenCalledWith(SENDER_HEX);
    expect(mockLock).toHaveBeenCalledWith(expect.any(Function), { label: 'miden-name-nfa-read' });
    expect(mockAssertHold).toHaveBeenCalledWith(HOLD, expect.any(String));
  });

  it('is not held when the vault has no NFA of the label', async () => {
    mockGetAccount.mockResolvedValue(accountWith(nameNfa('bob')));
    await expect(accountHoldsDomainNfa(SENDER_HEX, 'alice')).resolves.toBe('not-held');
  });

  it('is not held when the account is not in the local store', async () => {
    mockGetAccount.mockResolvedValue(null);
    await expect(accountHoldsDomainNfa(SENDER_HEX, 'alice')).resolves.toBe('not-held');
  });

  it('throws on a network with no deployment', async () => {
    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.DEVNET);
    await expect(accountHoldsDomainNfa(SENDER_HEX, 'alice')).rejects.toBeInstanceOf(MidenNameUnsupportedNetworkError);
    expect(mockLock).not.toHaveBeenCalled();
  });
});

describe('listOwnedDomainLabels', () => {
  it('lists each label whose NFA is in the vault and whose commitment matches the key', async () => {
    const foreign = nameNfa('carol', AccountId.fromHex(OTHER_FAUCET_HEX));
    const alice = nameNfa('alice');
    const aliceAgain = new NonFungibleAsset(registryId(), nameKey('alice', [7n, 8n]));
    const bob = nameNfa('bob');
    const unknown = new NonFungibleAsset(registryId(), [1n, 2n, 3n, 4n]);
    const forged = new NonFungibleAsset(registryId(), [5n, 6n, 0n, 0n]);
    mockGetAccount.mockResolvedValue(accountWith(foreign, alice, aliceAgain, bob, unknown, forged));
    mockRead.mockResolvedValue(
      storageOf(
        new Map<string, Felts4>([
          [mapKeyOf('alice'), encodeDomainFelts('alice')],
          [mapKeyOf('bob'), encodeDomainFelts('bob')],
          // The map says "dave", but the commitment of "dave" is not [5, 6]: not listed.
          [[5n, 6n, 0n, 0n].join(','), encodeDomainFelts('dave')]
        ])
      )
    );

    await expect(listOwnedDomainLabels(SENDER_HEX)).resolves.toEqual(['alice', 'bob']);

    // Every NFA is freed: only plain felts leave the lock.
    for (const nfa of [foreign, alice, aliceAgain, bob, unknown, forged]) expect(nfa.freed).toBe(1);
    expect(mockLock).toHaveBeenCalledWith(expect.any(Function), { label: 'miden-name-nfa-list' });
    expect(mockAssertHold).toHaveBeenCalledWith(HOLD, expect.any(String));
    const requests: RegistryMapRequest[] | undefined = mockRead.mock.calls[0]?.[1];
    expect(requests).toEqual([
      {
        slot: MIDEN_NAME_SLOTS.tokenToDomain,
        keys: [alice, aliceAgain, bob, unknown, forged].map(nfa => [nfa.key[0], nfa.key[1], 0n, 0n])
      }
    ]);
    expect(mockRead.mock.calls[0]?.[2]).toBe('midenNameOwnedNames');
  });

  it('returns no labels and reads no storage when the vault has no registry NFA', async () => {
    mockGetAccount.mockResolvedValue(accountWith(nameNfa('alice', AccountId.fromHex(OTHER_FAUCET_HEX))));
    await expect(listOwnedDomainLabels(SENDER_HEX)).resolves.toEqual([]);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('returns no labels when the account is not in the local store', async () => {
    mockGetAccount.mockResolvedValue(null);
    await expect(listOwnedDomainLabels(SENDER_HEX)).resolves.toEqual([]);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('throws on a network with no deployment', async () => {
    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.DEVNET);
    await expect(listOwnedDomainLabels(SENDER_HEX)).rejects.toBeInstanceOf(MidenNameUnsupportedNetworkError);
  });
});

describe('buildPublishNameRecordRequest', () => {
  it('builds the registry note with the NFA and the storage inputs in the contract order', async () => {
    const alice = nameNfa('alice');
    mockGetAccount.mockResolvedValue(accountWith(alice));

    const request = await buildPublishNameRecordRequest({ accountId: SENDER_HEX, label: 'alice' });

    expect(request).toEqual({
      requestBytes: new Uint8Array([1, 2, 3]),
      registryNoteId: '0xregister-note',
      reclaimHeight: 1300,
      builtAtBlock: 1000,
      action: REGISTRY_NOTE_ACTION.updateRecords
    });
    const { builder, note } = builtNote();
    const felts = note.recipient.storage.felts.elements.map(felt => felt.value);
    // The registry consumes the note. The sender gets the record and the returned NFA.
    expect(felts).toEqual(registryNoteInputs(REGISTRY, encodeDomainFelts('alice'), 1300, 3n));
    expect(felts.slice(0, 2)).not.toEqual([SENDER.prefix, SENDER.suffix]);
    expect(felts).toHaveLength(8);
    expect(felts[7]).toBe(3n);
    expect(note.assets.assets).toEqual([alice]);
    expect(alice.freed).toBe(0);
    expect(note.metadata.noteType).toBe(NoteType.Public);
    expect(note.metadata.sender.toString()).toBe(SENDER_HEX);
    expect(note.metadata.tag.account.toString()).toBe(REGISTRY_HEX);
    expect(note.attachments.map(attachment => attachment.target.toString())).toEqual([REGISTRY_HEX]);
    expect(note.recipient.script).toBe(script);
    expect(builder.feeSalt).toBe(SALT);
    // The note owns the script now: the build does not free it.
    expect(script.free).not.toHaveBeenCalled();
  });

  it('reads the note id before the note moves into the NoteArray', async () => {
    await buildPublishNameRecordRequest({ accountId: SENDER_HEX, label: 'alice' });
    expect(NOTE_BUILD_LOG).toEqual(['Note.withAttachments', 'note.id', 'NoteArray']);
  });

  it('holds the WASM lock with a label and checks the hold after the account read', async () => {
    await buildPublishNameRecordRequest({ accountId: SENDER_HEX, label: 'alice' });
    expect(mockLock).toHaveBeenCalledWith(expect.any(Function), { label: 'miden-name-publish-build' });
    expect(mockAssertHold).toHaveBeenCalledWith(HOLD, expect.any(String));
    expect(mockGetAccount).toHaveBeenCalledWith(SENDER_HEX);
    const [loadOrder] = mockLoadScript.mock.invocationCallOrder;
    const [lockOrder] = mockLock.mock.invocationCallOrder;
    expect(loadOrder ?? Infinity).toBeLessThan(lockOrder ?? 0);
  });

  it('throws MidenNameNotHeldError and frees the script when the vault has no NFA of the label', async () => {
    const bob = nameNfa('bob');
    mockGetAccount.mockResolvedValue(accountWith(bob));

    await expect(buildPublishNameRecordRequest({ accountId: SENDER_HEX, label: 'alice' })).rejects.toBeInstanceOf(
      MidenNameNotHeldError
    );

    expect(script.free).toHaveBeenCalledTimes(1);
    expect(bob.freed).toBe(1);
    expect(TransactionRequestBuilder.lastBuilt).toBeUndefined();
  });

  it('throws MidenNameNotHeldError when the account is not in the local store', async () => {
    mockGetAccount.mockResolvedValue(null);
    await expect(buildPublishNameRecordRequest({ accountId: SENDER_HEX, label: 'alice' })).rejects.toBeInstanceOf(
      MidenNameNotHeldError
    );
    expect(script.free).toHaveBeenCalledTimes(1);
  });

  it('refuses a registry that is not public and frees the script', async () => {
    NON_PUBLIC_ACCOUNTS.add(REGISTRY_HEX);
    await expect(buildPublishNameRecordRequest({ accountId: SENDER_HEX, label: 'alice' })).rejects.toBeInstanceOf(
      MidenNameRegistryMismatchError
    );
    expect(script.free).toHaveBeenCalledTimes(1);
  });

  it('frees the script when the lock fails', async () => {
    mockLock.mockRejectedValueOnce(new Error('lock failed'));
    await expect(buildPublishNameRecordRequest({ accountId: SENDER_HEX, label: 'alice' })).rejects.toThrow(
      'lock failed'
    );
    expect(script.free).toHaveBeenCalledTimes(1);
  });

  it('does not free the script after the recipient took it', async () => {
    const build = jest.spyOn(TransactionRequestBuilder.prototype, 'build').mockImplementationOnce(() => {
      throw new Error('build failed');
    });
    await expect(buildPublishNameRecordRequest({ accountId: SENDER_HEX, label: 'alice' })).rejects.toThrow(
      'build failed'
    );
    expect(script.free).not.toHaveBeenCalled();
    build.mockRestore();
  });

  it('refuses a reclaim height that does not fit in a u32, before the script load', async () => {
    mockTip.mockResolvedValue(4_294_967_295 - 100);
    await expect(buildPublishNameRecordRequest({ accountId: SENDER_HEX, label: 'alice' })).rejects.toBeInstanceOf(
      RangeError
    );
    expect(mockLoadScript).not.toHaveBeenCalled();
    expect(mockLock).not.toHaveBeenCalled();
  });

  it('refuses an invalid label before any read', async () => {
    await expect(buildPublishNameRecordRequest({ accountId: SENDER_HEX, label: 'Alice!' })).rejects.toBeInstanceOf(
      MidenNameInvalidLabelError
    );
    expect(mockTip).not.toHaveBeenCalled();
  });

  it('refuses a network with no deployment', async () => {
    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.DEVNET);
    await expect(buildPublishNameRecordRequest({ accountId: SENDER_HEX, label: 'alice' })).rejects.toBeInstanceOf(
      MidenNameUnsupportedNetworkError
    );
    expect(mockTip).not.toHaveBeenCalled();
  });
});

describe('publishRegistryRecord', () => {
  it('builds the request and queues a publish row with the delegate setting', async () => {
    mockInitiate.mockResolvedValue('publish-1');
    mockDelegate.mockReturnValue(false);

    await expect(publishRegistryRecord(SENDER_HEX, 'alice')).resolves.toBe('publish-1');

    expect(mockInitiate).toHaveBeenCalledWith({
      accountId: SENDER_HEX,
      label: 'alice',
      request: expect.objectContaining({ registryNoteId: '0xregister-note', reclaimHeight: 1300, action: 3n }),
      delegateTransaction: false
    });
  });

  it('queues nothing when the build fails', async () => {
    mockGetAccount.mockResolvedValue(null);
    await expect(publishRegistryRecord(SENDER_HEX, 'alice')).rejects.toBeInstanceOf(MidenNameNotHeldError);
    expect(mockInitiate).not.toHaveBeenCalled();
  });
});

describe('isMidenNameAbortedError', () => {
  it('recognizes only the abort error', () => {
    expect(isMidenNameAbortedError(new MidenNameAbortedError())).toBe(true);
    expect(isMidenNameAbortedError(new Error('other'))).toBe(false);
  });
});

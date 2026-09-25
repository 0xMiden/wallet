import { getCurrentMidenBlock } from 'lib/epoch/chain';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

import { encodeDomainFelts, registerNoteInputs } from './encoding';
import { MidenNameInvalidLabelError, MidenNameRegistryMismatchError, MidenNameUnsupportedNetworkError } from './errors';
import { buildRegisterNameRequest, registerNameRowAccounts } from './note';
import {
  AccountId,
  KNOWN_ACCOUNTS,
  NON_PUBLIC_ACCOUNTS,
  NOTE_BUILD_LOG,
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
  getBech32AddressFromAccountId: jest.fn((id: { toString(): string }) => `bech32:${id.toString()}`),
  randomFeeSalt: jest.fn(),
  resolveHeldFungibleAsset: jest.fn()
}));
jest.mock('lib/miden/sdk/miden-client', () => ({
  withWasmClientLock: jest.fn(),
  assertWasmHoldCurrent: jest.fn()
}));
jest.mock('./script', () => ({
  loadRegisterDomainScript: jest.fn(async () => ({ script: 'register-domain', free: jest.fn() }))
}));

const REGISTRY_HEX = '0xead81800958e7a112d45bdcf852fa6';
const TOKEN_HEX = '0x18101fa522c174b165efd4f70a0385';
const SENDER_HEX = '0xsender';
const REGISTRY = { prefix: 0xaan, suffix: 0xbbn };

const HOLD = { hold: 'current' };
const SENDER_ACCOUNT = { account: 'sender' };
const HELD_ASSET = { asset: 'miden' };
const SALT = new Word(BigUint64Array.from([5n, 6n, 7n, 8n]));

type LockOperation = (hold: object) => Promise<object>;

const mockNetwork = jest.mocked(getEffectiveNetworkName);
const mockTip = jest.mocked(getCurrentMidenBlock);
const mockGetAccount = jest.requireMock<{ midenClientProxy: { getAccount: jest.Mock<Promise<object>, [string]> } }>(
  'lib/miden/back/miden-client-proxy'
).midenClientProxy.getAccount;
const helpers = jest.requireMock<{
  randomFeeSalt: jest.Mock<Word, []>;
  resolveHeldFungibleAsset: jest.Mock<object, [object, string, bigint]>;
}>('lib/miden/sdk/helpers');
const mockSalt = helpers.randomFeeSalt;
const mockResolveAsset = helpers.resolveHeldFungibleAsset;
const lock = jest.requireMock<{
  withWasmClientLock: jest.Mock<Promise<object>, [LockOperation, object]>;
  assertWasmHoldCurrent: jest.Mock<void, [object, string]>;
}>('lib/miden/sdk/miden-client');
const mockLock = lock.withWasmClientLock;
const mockAssertHold = lock.assertWasmHoldCurrent;

beforeEach(() => {
  jest.clearAllMocks();
  NOTE_BUILD_LOG.length = 0;
  TransactionRequestBuilder.lastBuilt = undefined;
  NON_PUBLIC_ACCOUNTS.clear();
  KNOWN_ACCOUNTS.clear();
  KNOWN_ACCOUNTS.set(REGISTRY_HEX, REGISTRY);
  KNOWN_ACCOUNTS.set(TOKEN_HEX, { prefix: 0xccn, suffix: 0xddn });
  KNOWN_ACCOUNTS.set(SENDER_HEX, { prefix: 0x11n, suffix: 0x22n });
  mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
  mockTip.mockResolvedValue(1000);
  mockGetAccount.mockResolvedValue(SENDER_ACCOUNT);
  mockSalt.mockReturnValue(SALT);
  mockResolveAsset.mockReturnValue(HELD_ASSET);
  mockLock.mockImplementation(async operation => operation(HOLD));
});

function builtNote() {
  const builder = TransactionRequestBuilder.lastBuilt;
  const note = builder?.ownOutputNotes?.notes[0];
  if (!note) throw new Error('no note was built');
  return { builder, note };
}

describe('buildRegisterNameRequest', () => {
  it('builds the register note with the storage inputs in the contract order', async () => {
    const request = await buildRegisterNameRequest({
      senderAccountId: SENDER_HEX,
      label: 'alice',
      priceBaseUnits: 20_000_000n
    });

    expect(request.builtAtBlock).toBe(1000);
    expect(request.reclaimHeight).toBe(1300);
    expect(request.registrationNoteId).toBe('0xregister-note');
    expect(request.requestBytes).toEqual(new Uint8Array([1, 2, 3]));

    const { note } = builtNote();
    const felts = note.recipient.storage.felts.elements.map(felt => felt.value);
    expect(felts).toEqual(registerNoteInputs(REGISTRY, encodeDomainFelts('alice'), 1300));
    // Prefix before suffix, then the domain word, then the reclaim height.
    expect(felts.slice(0, 2)).toEqual([REGISTRY.prefix, REGISTRY.suffix]);
    expect(felts[6]).toBe(1300n);
  });

  it('reads the note id before the note moves into the NoteArray', async () => {
    await buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n });
    expect(NOTE_BUILD_LOG).toEqual(['Note.withAttachments', 'note.id', 'NoteArray']);
  });

  it('sets the fee salt on the builder', async () => {
    await buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n });
    expect(builtNote().builder.feeSalt).toBe(SALT);
  });

  it('makes a public note to the registry network account that holds only the price', async () => {
    await buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 20_000_000n });
    const { note } = builtNote();

    expect(mockResolveAsset).toHaveBeenCalledWith(SENDER_ACCOUNT, TOKEN_HEX, 20_000_000n);
    expect(note.assets.assets).toEqual([HELD_ASSET]);
    expect(note.metadata.noteType).toBe(NoteType.Public);
    expect(note.metadata.sender.toString()).toBe(SENDER_HEX);
    expect(note.metadata.tag.account.toString()).toBe(REGISTRY_HEX);
    expect(note.attachments.map(attachment => attachment.target.toString())).toEqual([REGISTRY_HEX]);
    expect(note.recipient.script).toMatchObject({ script: 'register-domain' });
  });

  it('loads the script before the lock and frees it when the build fails under the lock', async () => {
    const mockLoadScript = jest.requireMock<{
      loadRegisterDomainScript: jest.Mock<Promise<{ script: string; free: jest.Mock }>, []>;
    }>('./script').loadRegisterDomainScript;
    const script = { script: 'register-domain', free: jest.fn() };
    mockLoadScript.mockResolvedValueOnce(script);
    mockLock.mockRejectedValueOnce(new Error('lock failed'));

    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n })
    ).rejects.toThrow('lock failed');

    const [loadOrder] = mockLoadScript.mock.invocationCallOrder;
    const [lockOrder] = mockLock.mock.invocationCallOrder;
    expect(loadOrder).toBeDefined();
    expect(lockOrder).toBeDefined();
    expect(loadOrder ?? Infinity).toBeLessThan(lockOrder ?? 0);
    expect(script.free).toHaveBeenCalledTimes(1);
  });

  it('holds the WASM lock with a label and checks the hold after the account read', async () => {
    await buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n });
    expect(mockLock).toHaveBeenCalledWith(expect.any(Function), { label: 'miden-name-register-build' });
    expect(mockAssertHold).toHaveBeenCalledWith(HOLD, expect.any(String));
    expect(mockGetAccount).toHaveBeenCalledWith(SENDER_HEX);
  });

  it('refuses a registry that is not public', async () => {
    NON_PUBLIC_ACCOUNTS.add(REGISTRY_HEX);
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n })
    ).rejects.toBeInstanceOf(MidenNameRegistryMismatchError);
    expect(TransactionRequestBuilder.lastBuilt).toBeUndefined();
  });

  it('refuses a reclaim height that does not fit in a u32', async () => {
    mockTip.mockResolvedValue(4_294_967_295 - 100);
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n })
    ).rejects.toBeInstanceOf(RangeError);
    expect(mockLock).not.toHaveBeenCalled();
  });

  it('refuses an invalid label before any read', async () => {
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'Alice!', priceBaseUnits: 1n })
    ).rejects.toBeInstanceOf(MidenNameInvalidLabelError);
    expect(mockTip).not.toHaveBeenCalled();
  });

  it('refuses a network with no deployment', async () => {
    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.DEVNET);
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n })
    ).rejects.toBeInstanceOf(MidenNameUnsupportedNetworkError);
  });
});

describe('registerNameRowAccounts', () => {
  it('returns the network and the bech32 ids of the payment faucet and the registry', () => {
    expect(registerNameRowAccounts()).toEqual({
      network: MIDEN_NETWORK_NAME.TESTNET,
      paymentFaucetId: `bech32:${AccountId.fromHex(TOKEN_HEX).toString()}`,
      registryAccountId: `bech32:${REGISTRY_HEX}`
    });
  });
});

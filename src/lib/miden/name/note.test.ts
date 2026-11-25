import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

import { encodeDomainFelts, registerNoteInputs, validateMidenLabel } from './encoding';
import {
  MidenNameAbortedError,
  MidenNameInvalidLabelError,
  MidenNameRegistryMismatchError,
  MidenNameUnsupportedNetworkError
} from './errors';
import { buildRegisterNameRequest, registerNameRowAccounts } from './note';
import { getChainTip } from './reads';
import {
  AccountId,
  KNOWN_ACCOUNTS,
  NON_PUBLIC_ACCOUNTS,
  NOTE_BUILD_LOG,
  NoteType,
  TransactionRequestBuilder,
  Word
} from './test-support/fake-sdk';

jest.mock('./encoding', () => {
  const actual = jest.requireActual<typeof import('./encoding')>('./encoding');
  return {
    ...actual,
    validateMidenLabel: jest.fn(actual.validateMidenLabel),
    encodeDomainFelts: jest.fn(actual.encodeDomainFelts)
  };
});
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
    getChainTip: jest.fn()
  };
});
jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: { getAccount: jest.fn() } }));
jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: jest.fn(),
  feeAwareRequestBuilder: jest.fn(),
  getBech32AddressFromAccountId: jest.fn((id: { toString(): string }) => `bech32:${id.toString()}`),
  randomFeeSalt: jest.fn(),
  resolveHeldFungibleAsset: jest.fn()
}));
jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: jest.fn(),
  withWasmClientLock: jest.fn(),
  assertWasmHoldCurrent: jest.fn()
}));
jest.mock('./script', () => ({
  loadRegisterDomainScript: jest.fn(async () => ({ script: 'register-domain', free: jest.fn() }))
}));

const REGISTRY_HEX = '0x16fb70069eed60110c6207189c8237';
const TOKEN_HEX = '0x4cbdcaffe75f0a317482224dae6436';
const SENDER_HEX = '0xsender';
const REGISTRY = { prefix: 0xaan, suffix: 0xbbn };

const HOLD = { hold: 'current' };
const FAKE_CLIENT = { client: 'miden-sdk-client' };
const SENDER_ACCOUNT = { account: 'sender' };
const HELD_ASSET = { asset: 'miden' };
const SALT = new Word(BigUint64Array.from([5n, 6n, 7n, 8n]));

type LockOperation = (hold: object) => Promise<object>;

const mockNetwork = jest.mocked(getEffectiveNetworkName);
const mockRpcUrl = jest.mocked(getEffectiveRpcUrl);
const mockTip = jest.mocked(getChainTip);
const mockGetAccount = jest.requireMock<{ midenClientProxy: { getAccount: jest.Mock<Promise<object>, [string]> } }>(
  'lib/miden/back/miden-client-proxy'
).midenClientProxy.getAccount;
const helpers = jest.requireMock<{
  feeAwareRequestBuilder: jest.Mock<Promise<TransactionRequestBuilder>, [object, string, Word]>;
  randomFeeSalt: jest.Mock<Word, []>;
  resolveHeldFungibleAsset: jest.Mock<object, [object, string, bigint]>;
}>('lib/miden/sdk/helpers');
const mockFeeAwareRequestBuilder = helpers.feeAwareRequestBuilder;
const mockSalt = helpers.randomFeeSalt;
const mockResolveAsset = helpers.resolveHeldFungibleAsset;
const lock = jest.requireMock<{
  getMidenClient: jest.Mock<Promise<{ client: object }>, []>;
  withWasmClientLock: jest.Mock<Promise<object>, [LockOperation, object]>;
  assertWasmHoldCurrent: jest.Mock<void, [object, string]>;
}>('lib/miden/sdk/miden-client');
const mockGetMidenClient = lock.getMidenClient;
const mockLock = lock.withWasmClientLock;
const mockAssertHold = lock.assertWasmHoldCurrent;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetMidenClient.mockReset().mockResolvedValue({ client: FAKE_CLIENT });
  mockFeeAwareRequestBuilder
    .mockReset()
    .mockImplementation(async (_client, _account, salt) => new TransactionRequestBuilder().withFeeConversionSalt(salt));
  mockAssertHold.mockReset();
  NOTE_BUILD_LOG.length = 0;
  TransactionRequestBuilder.lastBuilt = undefined;
  NON_PUBLIC_ACCOUNTS.clear();
  KNOWN_ACCOUNTS.clear();
  KNOWN_ACCOUNTS.set(REGISTRY_HEX, REGISTRY);
  KNOWN_ACCOUNTS.set(TOKEN_HEX, { prefix: 0xccn, suffix: 0xddn });
  KNOWN_ACCOUNTS.set(SENDER_HEX, { prefix: 0x11n, suffix: 0x22n });
  mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
  mockRpcUrl.mockReturnValue('https://rpc-a.example');
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

  it.each([0n, -1n])('refuses non-positive priceBaseUnits (%s) before any read or lock', async priceBaseUnits => {
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits })
    ).rejects.toThrow(RangeError);
    expect(mockTip).not.toHaveBeenCalled();
    expect(mockLock).not.toHaveBeenCalled();
    expect(mockResolveAsset).not.toHaveBeenCalled();
  });

  it('validates invalid label once and before network-config checks', async () => {
    const mockValidate = jest.mocked(validateMidenLabel);
    const mockEncode = jest.mocked(encodeDomainFelts);
    mockValidate.mockClear();
    mockEncode.mockClear();
    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.DEVNET);
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'Alice!', priceBaseUnits: 1n })
    ).rejects.toBeInstanceOf(MidenNameInvalidLabelError);
    expect(mockValidate).not.toHaveBeenCalled();
    expect(mockEncode).toHaveBeenCalledTimes(1);
    expect(mockTip).not.toHaveBeenCalled();
  });

  it('refuses a network with no deployment', async () => {
    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.DEVNET);
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n })
    ).rejects.toBeInstanceOf(MidenNameUnsupportedNetworkError);
  });

  it('aborts and frees owned script if network or RPC changes across async steps', async () => {
    const mockLoadScript = jest.requireMock<{
      loadRegisterDomainScript: jest.Mock<Promise<{ script: string; free: jest.Mock }>, []>;
    }>('./script').loadRegisterDomainScript;

    mockTip.mockImplementationOnce(async scope => {
      expect(scope).toEqual({ network: MIDEN_NETWORK_NAME.TESTNET, rpcUrl: 'https://rpc-a.example' });
      mockRpcUrl.mockReturnValue('https://rpc-b.example');
      return 1000;
    });
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n })
    ).rejects.toBeInstanceOf(MidenNameAbortedError);
    expect(mockLoadScript).not.toHaveBeenCalled();

    mockRpcUrl.mockReturnValue('https://rpc-a.example');
    const script1 = { script: 'register-domain', free: jest.fn() };
    mockLoadScript.mockImplementationOnce(async () => {
      mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.MAINNET);
      return script1;
    });
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n })
    ).rejects.toBeInstanceOf(MidenNameAbortedError);
    expect(script1.free).toHaveBeenCalledTimes(1);
    expect(mockLock).not.toHaveBeenCalled();

    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
    const script2 = { script: 'register-domain', free: jest.fn() };
    mockLoadScript.mockResolvedValueOnce(script2);
    mockLock.mockImplementationOnce(async operation => {
      mockRpcUrl.mockReturnValue('https://rpc-b.example');
      return operation(HOLD);
    });
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n })
    ).rejects.toBeInstanceOf(MidenNameAbortedError);
    expect(mockGetAccount).not.toHaveBeenCalled();
    expect(script2.free).toHaveBeenCalledTimes(1);
  });

  it('builds with feeAwareRequestBuilder inside the lock, rechecks hold and scope, and frees script on failure', async () => {
    const mockLoadScript = jest.requireMock<{
      loadRegisterDomainScript: jest.Mock<Promise<{ script: string; free: jest.Mock }>, []>;
    }>('./script').loadRegisterDomainScript;
    const customBuilder = new TransactionRequestBuilder().withFeeConversionSalt(SALT);
    mockFeeAwareRequestBuilder.mockResolvedValueOnce(customBuilder);

    await buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n });
    expect(mockFeeAwareRequestBuilder).toHaveBeenCalledWith(FAKE_CLIENT, SENDER_HEX, SALT);
    expect(mockAssertHold).toHaveBeenCalledTimes(3);
    expect(builtNote().builder).toBe(customBuilder);

    const evictedScript = { script: 'register-domain', free: jest.fn() };
    mockLoadScript.mockResolvedValueOnce(evictedScript);
    mockAssertHold
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('hold evicted during feeAwareRequestBuilder');
      });
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n })
    ).rejects.toThrow('hold evicted during feeAwareRequestBuilder');
    expect(evictedScript.free).toHaveBeenCalledTimes(1);

    const switchedScript = { script: 'register-domain', free: jest.fn() };
    mockLoadScript.mockResolvedValueOnce(switchedScript);
    mockFeeAwareRequestBuilder.mockImplementationOnce(async () => {
      mockRpcUrl.mockReturnValue('https://rpc-b.example');
      return new TransactionRequestBuilder().withFeeConversionSalt(SALT);
    });
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n })
    ).rejects.toBeInstanceOf(MidenNameAbortedError);
    expect(switchedScript.free).toHaveBeenCalledTimes(1);

    mockRpcUrl.mockReturnValue('https://rpc-a.example');
    mockLoadScript.mockImplementationOnce(async () => {
      mockRpcUrl.mockReturnValue('https://rpc-b.example');
      throw new Error('script fetch failed');
    });
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n })
    ).rejects.toBeInstanceOf(MidenNameAbortedError);

    mockRpcUrl.mockReturnValue('https://rpc-a.example');
    const clientSwitchScript = { script: 'register-domain', free: jest.fn() };
    mockLoadScript.mockResolvedValueOnce(clientSwitchScript);
    mockGetMidenClient.mockImplementationOnce(async () => {
      mockRpcUrl.mockReturnValue('https://rpc-b.example');
      throw new Error('client init failed');
    });
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n })
    ).rejects.toBeInstanceOf(MidenNameAbortedError);
    expect(clientSwitchScript.free).toHaveBeenCalledTimes(1);

    mockRpcUrl.mockReturnValue('https://rpc-a.example');
    const lockFailScript = { script: 'register-domain', free: jest.fn() };
    mockLoadScript.mockResolvedValueOnce(lockFailScript);
    mockLock.mockImplementationOnce(async () => {
      mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.MAINNET);
      throw new Error('lock failed');
    });
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n })
    ).rejects.toBeInstanceOf(MidenNameAbortedError);
    expect(lockFailScript.free).toHaveBeenCalledTimes(1);

    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
    mockTip.mockImplementationOnce(async () => {
      mockRpcUrl.mockReturnValue('https://rpc-b.example');
      throw new Error('tip failed');
    });
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n })
    ).rejects.toBeInstanceOf(MidenNameAbortedError);
  });

  it('rechecks lock hold after getMidenClient before invoking feeAwareRequestBuilder', async () => {
    const mockLoadScript = jest.requireMock<{
      loadRegisterDomainScript: jest.Mock<Promise<{ script: string; free: jest.Mock }>, []>;
    }>('./script').loadRegisterDomainScript;
    const script = { script: 'register-domain', free: jest.fn() };
    mockLoadScript.mockResolvedValueOnce(script);

    let resolveClient!: (value: { client: object }) => void;
    const clientPromise = new Promise<{ client: object }>(resolve => {
      resolveClient = resolve;
    });
    mockGetMidenClient.mockReturnValueOnce(clientPromise);
    mockAssertHold
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('hold evicted during getMidenClient');
      });

    const pendingBuild = buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n });
    resolveClient({ client: FAKE_CLIENT });

    await expect(pendingBuild).rejects.toThrow('hold evicted during getMidenClient');
    expect(mockFeeAwareRequestBuilder).not.toHaveBeenCalled();
    expect(script.free).toHaveBeenCalledTimes(1);
  });

  it('aborts on double-microtask continuation switches after awaited helpers and outer lock return', async () => {
    const mockLoadScript = jest.requireMock<{
      loadRegisterDomainScript: jest.Mock<Promise<{ script: string; free: jest.Mock }>, []>;
    }>('./script').loadRegisterDomainScript;

    mockTip.mockImplementationOnce(async () => {
      queueMicrotask(() => queueMicrotask(() => mockRpcUrl.mockReturnValue('https://rpc-b.example')));
      return 1000;
    });
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n })
    ).rejects.toBeInstanceOf(MidenNameAbortedError);
    expect(mockLoadScript).not.toHaveBeenCalled();

    mockRpcUrl.mockReturnValue('https://rpc-a.example');
    const script1 = { script: 'register-domain', free: jest.fn() };
    mockLoadScript.mockImplementationOnce(async () => {
      queueMicrotask(() =>
        queueMicrotask(() => queueMicrotask(() => mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.MAINNET)))
      );
      return script1;
    });
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n })
    ).rejects.toBeInstanceOf(MidenNameAbortedError);
    expect(script1.free).toHaveBeenCalledTimes(1);
    expect(mockLock).not.toHaveBeenCalled();

    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
    const scriptClient = { script: 'register-domain', free: jest.fn() };
    mockLoadScript.mockResolvedValueOnce(scriptClient);
    mockFeeAwareRequestBuilder.mockClear();
    mockGetMidenClient.mockImplementationOnce(async () => {
      queueMicrotask(() => queueMicrotask(() => mockRpcUrl.mockReturnValue('https://rpc-b.example')));
      return { client: FAKE_CLIENT };
    });
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n })
    ).rejects.toBeInstanceOf(MidenNameAbortedError);
    expect(mockFeeAwareRequestBuilder).not.toHaveBeenCalled();
    expect(scriptClient.free).toHaveBeenCalledTimes(1);

    mockRpcUrl.mockReturnValue('https://rpc-a.example');
    const scriptBuilder = { script: 'register-domain', free: jest.fn() };
    mockLoadScript.mockResolvedValueOnce(scriptBuilder);
    mockFeeAwareRequestBuilder.mockImplementationOnce(async () => {
      queueMicrotask(() => queueMicrotask(() => mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.MAINNET)));
      return new TransactionRequestBuilder().withFeeConversionSalt(SALT);
    });
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n })
    ).rejects.toBeInstanceOf(MidenNameAbortedError);
    expect(scriptBuilder.free).toHaveBeenCalledTimes(1);

    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
    const script2 = { script: 'register-domain', free: jest.fn() };
    mockLoadScript.mockResolvedValueOnce(script2);
    mockLock.mockImplementationOnce(async operation => {
      const value = await operation(HOLD);
      queueMicrotask(() => queueMicrotask(() => mockRpcUrl.mockReturnValue('https://rpc-b.example')));
      return value;
    });
    await expect(
      buildRegisterNameRequest({ senderAccountId: SENDER_HEX, label: 'alice', priceBaseUnits: 1n })
    ).rejects.toBeInstanceOf(MidenNameAbortedError);
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

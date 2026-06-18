/**
 * guardian/account — getSignerDetailsFromAccount reads the first signer
 * commitment out of the multisig storage slot; createGuardianAccount drives
 * MultisigClient.create + guardian registration + keystore insertion for
 * the 3-key (hot + cold + guardian) layout.
 *
 * All external collaborators are stubbed; we don't exec any real WASM.
 */

import { createGuardianAccount, getSignerDetailsFromAccount, MULTISIG_SLOT_NAMES } from './account';

const mockFetchFromStorage = jest.fn();
jest.mock('../front/storage', () => ({
  fetchFromStorage: (...args: unknown[]) => mockFetchFromStorage(...args)
}));

jest.mock('lib/miden-chain/constants', () => ({
  DEFAULT_GUARDIAN_ENDPOINT: 'https://default.guardian.test'
}));

jest.mock('lib/settings/constants', () => ({
  GUARDIAN_URL_STORAGE_KEY: 'guardian_url_setting'
}));

// AuthSecretKey.ecdsaWithRNG returns a deterministic stub keyed by the seed
// so we can distinguish hot vs cold material. Each call mints a new "key"
// object whose serialize/publicKey/etc are jest mocks the assertions can read.
type StubKey = {
  serialize: jest.Mock;
  publicKey: jest.Mock;
  __seedTag: string;
};
const stubKeyByTag: Record<string, StubKey> = {};
const buildStubKey = (tag: string): StubKey => {
  const key: StubKey = {
    __seedTag: tag,
    serialize: jest.fn(() => new Uint8Array([0xaa, ...Buffer.from(tag, 'utf-8')])),
    publicKey: jest.fn(() => ({
      serialize: jest.fn(() => new Uint8Array([0x01, ...Buffer.from(`pub-${tag}`, 'utf-8')])),
      toCommitment: jest.fn(() => ({ toHex: () => `0xcommit-${tag}` }))
    }))
  };
  stubKeyByTag[tag] = key;
  return key;
};
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const actual = jest.requireActual('../../../../__mocks__/wasmMock.js');
  return {
    ...actual,
    AuthSecretKey: {
      ecdsaWithRNG: jest.fn((seed: Uint8Array) => buildStubKey(`s${Array.from(seed).join('-')}`))
    }
  };
});
jest.mock('@miden-sdk/miden-sdk', () => {
  const actual = jest.requireActual('../../../../__mocks__/wasmMock.js');
  return {
    ...actual,
    AuthSecretKey: {
      ecdsaWithRNG: jest.fn((seed: Uint8Array) => buildStubKey(`s${Array.from(seed).join('-')}`))
    }
  };
});

// secure-hot-key facade — generateHotKey is the only entry createGuardianAccount uses.
const mockGenerateHotKey = jest.fn();
jest.mock('lib/secure-hot-key', () => ({
  generateHotKey: (...a: unknown[]) => mockGenerateHotKey(...a)
}));

// Guardian SDK stubs — keep per-test knobs for getPubkey + client.create.
const multisigClientConfig: {
  create: jest.Mock;
  getPubkey: jest.Mock;
} = {
  create: jest.fn(),
  getPubkey: jest.fn()
};
const ecdsaSignerCtor = jest.fn();

jest.mock('@openzeppelin/miden-multisig-client', () => ({
  MultisigClient: jest.fn().mockImplementation(() => ({
    create: (...a: unknown[]) => multisigClientConfig.create(...a),
    guardianClient: {
      getPubkey: (...a: unknown[]) => multisigClientConfig.getPubkey(...a)
    }
  })),
  EcdsaSigner: jest.fn().mockImplementation((sk: unknown) => {
    ecdsaSignerCtor(sk);
    return { sk };
  })
}));

describe('getSignerDetailsFromAccount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const makeAccount = (entries: unknown) => ({
    storage: () => ({ getMapEntries: jest.fn(() => entries) })
  });

  it("reads the first signer commitment from storage (the hot signer's slot)", async () => {
    const account = makeAccount([{ value: '0xcommit-first' }, { value: '0xcommit-second' }]);

    const result = await getSignerDetailsFromAccount(account as never);

    expect(result).toEqual({ commitment: 'commit-first' });
  });

  it('throws when the signer-public-keys slot is missing', async () => {
    const account = makeAccount(undefined);

    await expect(getSignerDetailsFromAccount(account as never)).rejects.toThrow(
      'No signer public keys found in account storage'
    );
  });

  it('throws when the slot is present but empty', async () => {
    const account = makeAccount([]);

    await expect(getSignerDetailsFromAccount(account as never)).rejects.toThrow(
      'No signer commitments found in account storage'
    );
  });

  it('throws when the stored value has no bytes after the 0x prefix', async () => {
    // `.slice(2)` on '0x' yields an empty string — the `if (!commitment)` guard
    // rejects instead of returning a malformed entry.
    const account = makeAccount([{ value: '0x' }]);

    await expect(getSignerDetailsFromAccount(account as never)).rejects.toThrow(
      'Commitment not found in account storage'
    );
  });

  it('exposes the multisig storage slot names', () => {
    expect(MULTISIG_SLOT_NAMES.SIGNER_PUBLIC_KEYS).toBe('openzeppelin::multisig::signer_public_keys');
  });
});

describe('createGuardianAccount', () => {
  const makeMultisig = () => ({
    account: { id: () => ({ toString: () => 'guardian-acc-id' }) },
    registerOnGuardian: jest.fn(async () => {})
  });

  const makeWebClient = () => ({
    sync: jest.fn(async () => {}),
    keystore: { insert: jest.fn(async () => {}) }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    multisigClientConfig.getPubkey.mockResolvedValue({ commitment: 'g-commit', pubkey: 'g-pubkey' });
    mockFetchFromStorage.mockResolvedValue(undefined);
    mockGenerateHotKey.mockResolvedValue({
      ciphertext: 'hot-ciphertext-hex',
      publicKeyHex: 'hot-pubkey-hex',
      commitmentHex: '0xhot-commit'
    });
  });

  it('creates a 2-of-N multisig with [hot, cold] commitments, registers, syncs, persists cold to keystore', async () => {
    const webClient = makeWebClient();
    const multisig = makeMultisig();
    multisigClientConfig.create.mockResolvedValueOnce(multisig);

    const seed = new Uint8Array([1, 2, 3, 4]);
    const result = await createGuardianAccount(webClient as never, seed);

    // Hot is generated via the secure-hot-key facade; cold is HD-derived from seed.
    expect(mockGenerateHotKey).toHaveBeenCalledTimes(1);
    expect(multisigClientConfig.create).toHaveBeenCalledWith(
      expect.objectContaining({
        threshold: 1,
        // Hot first, cold second — order is load-bearing for downstream role routing.
        signerCommitments: ['0xhot-commit', '0xcommit-s1-2-3-4'],
        guardianCommitment: 'g-commit',
        guardianPublicKey: 'g-pubkey',
        guardianEnabled: true,
        storageMode: 'private',
        signatureScheme: 'ecdsa',
        seed
      }),
      expect.anything()
    );
    // The deploy proposal is signed by cold (we hand the cold AuthSecretKey to EcdsaSigner).
    expect(ecdsaSignerCtor).toHaveBeenCalledWith(stubKeyByTag['s1-2-3-4']);
    expect(multisig.registerOnGuardian).toHaveBeenCalled();
    expect(webClient.sync).toHaveBeenCalled();
    // Only the cold key is inserted into the SDK keystore — hot lives outside.
    expect(webClient.keystore.insert).toHaveBeenCalledTimes(1);
    expect(webClient.keystore.insert).toHaveBeenCalledWith(expect.anything(), stubKeyByTag['s1-2-3-4']);

    // The rich return shape exposes everything vault.ts needs to persist.
    expect(result.account).toBe(multisig.account);
    expect(result.keys).toEqual({
      hotPublicKey: 'hot-pubkey-hex',
      coldPublicKey: expect.any(String),
      hotCiphertext: 'hot-ciphertext-hex',
      coldSecretKeyHex: expect.any(String)
    });
  });

  it('generates a random seed when none is provided', async () => {
    const webClient = makeWebClient();
    multisigClientConfig.create.mockResolvedValueOnce(makeMultisig());

    await createGuardianAccount(webClient as never);

    // ecdsaWithRNG was still called with a 32-byte Uint8Array (cold-seed fallback).
    const ecdsaCall = jest.requireMock('@miden-sdk/miden-sdk/lazy').AuthSecretKey.ecdsaWithRNG;
    const seedArg = ecdsaCall.mock.calls[0]?.[0];
    expect(seedArg).toBeInstanceOf(Uint8Array);
    expect((seedArg as Uint8Array).length).toBe(32);
  });

  it('skips guardian registration when skipRegistration=true (import path)', async () => {
    const webClient = makeWebClient();
    const multisig = makeMultisig();
    multisigClientConfig.create.mockResolvedValueOnce(multisig);

    await createGuardianAccount(webClient as never, new Uint8Array(32), true);

    expect(multisig.registerOnGuardian).not.toHaveBeenCalled();
  });

  it('uses the stored guardian URL when no override is supplied', async () => {
    mockFetchFromStorage.mockResolvedValueOnce('https://stored.guardian');
    const webClient = makeWebClient();
    multisigClientConfig.create.mockResolvedValueOnce(makeMultisig());

    await createGuardianAccount(webClient as never, new Uint8Array(32));

    // When storage yields a URL, create still succeeds — the URL propagation
    // goes through MultisigClient's constructor which we stubbed, so the
    // useful signal is that fetchFromStorage was consulted.
    expect(mockFetchFromStorage).toHaveBeenCalledWith('guardian_url_setting');
  });

  it('prefers the explicit override over storage and default', async () => {
    mockFetchFromStorage.mockResolvedValueOnce('https://stored.guardian');
    const webClient = makeWebClient();
    multisigClientConfig.create.mockResolvedValueOnce(makeMultisig());

    await createGuardianAccount(webClient as never, new Uint8Array(32), false, 'https://override.guardian');

    // Override short-circuits the storage lookup entirely.
    expect(mockFetchFromStorage).not.toHaveBeenCalled();
  });

  it('wraps underlying errors in a readable message', async () => {
    const webClient = makeWebClient();
    multisigClientConfig.create.mockRejectedValueOnce(new Error('wasm exploded'));

    await expect(createGuardianAccount(webClient as never, new Uint8Array(32))).rejects.toThrow(
      'Failed to create Guardian account'
    );
  });
});

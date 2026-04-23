/**
 * guardian/account — getSignerDetailsFromAccount reads the first signer
 * commitment out of the multisig storage slot; createGuardianAccount drives
 * MultisigClient.create + guardian registration + keystore insertion.
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

// AuthSecretKey.rpoFalconWithRNG + commitment calls need a predictable stub.
const mockAuthSecretKeyRpo = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const actual = jest.requireActual('../../../../__mocks__/wasmMock.js');
  return {
    ...actual,
    AuthSecretKey: { rpoFalconWithRNG: (seed: unknown) => mockAuthSecretKeyRpo(seed) }
  };
});
jest.mock('@miden-sdk/miden-sdk', () => {
  const actual = jest.requireActual('../../../../__mocks__/wasmMock.js');
  return {
    ...actual,
    AuthSecretKey: { rpoFalconWithRNG: (seed: unknown) => mockAuthSecretKeyRpo(seed) }
  };
});

// Guardian SDK stubs — keep per-test knobs for getPubkey + client.create.
const multisigClientConfig: {
  create: jest.Mock;
  getPubkey: jest.Mock;
} = {
  create: jest.fn(),
  getPubkey: jest.fn()
};

jest.mock('@openzeppelin/miden-multisig-client', () => ({
  MultisigClient: jest.fn().mockImplementation(() => ({
    create: (...a: unknown[]) => multisigClientConfig.create(...a),
    guardianClient: {
      getPubkey: (...a: unknown[]) => multisigClientConfig.getPubkey(...a)
    }
  })),
  FalconSigner: jest.fn().mockImplementation((sk: unknown) => ({ sk }))
}));

describe('getSignerDetailsFromAccount', () => {
  const getPublicKeyForCommitment = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    getPublicKeyForCommitment.mockResolvedValue('derived-pubkey');
  });

  const makeAccount = (entries: unknown) => ({
    storage: () => ({ getMapEntries: jest.fn(() => entries) })
  });

  it('reads the first signer commitment and resolves the matching public key', async () => {
    const account = makeAccount([{ value: '0xcommit-first' }, { value: '0xcommit-second' }]);

    const result = await getSignerDetailsFromAccount(account as never, getPublicKeyForCommitment);

    expect(result).toEqual({ commitment: 'commit-first', publicKey: 'derived-pubkey' });
    expect(getPublicKeyForCommitment).toHaveBeenCalledWith('commit-first');
  });

  it('throws when the signer-public-keys slot is missing', async () => {
    const account = makeAccount(undefined);

    await expect(getSignerDetailsFromAccount(account as never, getPublicKeyForCommitment)).rejects.toThrow(
      'No signer public keys found in account storage'
    );
  });

  it('throws when the slot is present but empty', async () => {
    const account = makeAccount([]);

    await expect(getSignerDetailsFromAccount(account as never, getPublicKeyForCommitment)).rejects.toThrow(
      'No signer commitments found in account storage'
    );
  });

  it('throws when the stored value has no bytes after the 0x prefix', async () => {
    // `.slice(2)` on '0x' yields an empty string — the `if (!commitment)` guard
    // rejects instead of handing an empty hash to getPublicKeyForCommitment.
    const account = makeAccount([{ value: '0x' }]);

    await expect(getSignerDetailsFromAccount(account as never, getPublicKeyForCommitment)).rejects.toThrow(
      'Commitment not found in account storage'
    );
    expect(getPublicKeyForCommitment).not.toHaveBeenCalled();
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
    mockAuthSecretKeyRpo.mockReturnValue({
      publicKey: () => ({ toCommitment: () => ({ toHex: () => '0xsigner-commit' }) })
    });
    multisigClientConfig.getPubkey.mockResolvedValue({ commitment: 'g-commit', pubkey: 'g-pubkey' });
    mockFetchFromStorage.mockResolvedValue(undefined);
  });

  it('creates a 1-of-1 multisig, registers with the guardian, syncs, and persists the signer key', async () => {
    const webClient = makeWebClient();
    const multisig = makeMultisig();
    multisigClientConfig.create.mockResolvedValueOnce(multisig);

    const seed = new Uint8Array([1, 2, 3, 4]);
    const account = await createGuardianAccount(webClient as never, seed);

    expect(mockAuthSecretKeyRpo).toHaveBeenCalledWith(seed);
    expect(multisigClientConfig.create).toHaveBeenCalledWith(
      expect.objectContaining({
        threshold: 1,
        signerCommitments: ['0xsigner-commit'],
        guardianCommitment: 'g-commit',
        guardianPublicKey: 'g-pubkey',
        guardianEnabled: true,
        storageMode: 'private',
        signatureScheme: 'falcon',
        seed
      }),
      expect.anything()
    );
    expect(multisig.registerOnGuardian).toHaveBeenCalled();
    expect(webClient.sync).toHaveBeenCalled();
    expect(webClient.keystore.insert).toHaveBeenCalled();
    expect(account).toBe(multisig.account);
  });

  it('generates a random seed when none is provided', async () => {
    const webClient = makeWebClient();
    multisigClientConfig.create.mockResolvedValueOnce(makeMultisig());

    await createGuardianAccount(webClient as never);

    // rpoFalconWithRNG was still called with a 32-byte Uint8Array.
    const seedArg = mockAuthSecretKeyRpo.mock.calls[0]?.[0];
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

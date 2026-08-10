/**
 * guardian/account — getSignerDetailsFromAccount reads the first signer
 * commitment out of the multisig storage slot; createGuardianAccount drives
 * MultisigClient.create + guardian registration + keystore insertion for
 * the 3-key (hot + cold + guardian) layout.
 *
 * All external collaborators are stubbed; we don't exec any real WASM.
 */

import {
  createGuardianAccount,
  getGuardianCommitmentFromAccount,
  getSignerDetailsFromAccount,
  GUARDIAN_SLOT_NAMES,
  guardianProviderFromEndpoint,
  MULTISIG_SLOT_NAMES,
  resolveGuardianEndpoint
} from './account';

const mockFetchFromStorage = jest.fn();
jest.mock('../front/storage', () => ({
  fetchFromStorage: (...args: unknown[]) => mockFetchFromStorage(...args)
}));

// Mirrors the shape (and a couple of real URLs) of the real GUARDIAN_OPTIONS
// in lib/miden-chain/constants, so guardianProviderFromEndpoint's reverse-map
// is exercised against realistic data, not a fabricated fixture.
jest.mock('lib/miden-chain/constants', () => ({
  DEFAULT_NETWORK: 'testnet',
  MIDEN_NETWORK_ENDPOINTS: new Map([['testnet', 'https://rpc.testnet.miden.io']]),
  GUARDIAN_OPTIONS: [
    {
      id: 'open-zeppelin',
      endpoint: new Map([
        ['testnet', 'https://guardian.openzeppelin.com'],
        ['devnet', 'https://guardian-stg.openzeppelin.com']
      ])
    },
    {
      id: 'gateway',
      endpoint: new Map([['testnet', 'https://miden-guardian.dev.eu-north-3.gateway.fm']])
    },
    {
      id: 'lambda-class',
      endpoint: new Map([['testnet', 'https://miden-guardian.lambdaclass.com']])
    },
    // Defensive-fallback fixture: an option whose id isn't in PROVIDER_ID_MAP,
    // so a URL match still falls through to 'custom' rather than a bogus id.
    {
      id: 'unmapped-provider',
      endpoint: new Map([['testnet', 'https://unmapped.guardian.test']])
    }
  ]
}));

// `getEffectiveDefaultGuardianEndpoint` is the effective-network-aware fallback
// (see lib/miden-chain/effective-endpoints.ts); stub it to a distinct sentinel
// (rather than the real per-network default) so the "falls back to default"
// assertions below are unambiguously about the fallback branch, not a
// coincidental match with a real provider URL. `getEffectiveRpcUrl` isn't
// asserted on anywhere in this file — any stable string is fine.
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveRpcUrl: () => 'https://rpc.testnet.miden.io',
  getEffectiveDefaultGuardianEndpoint: () => 'https://default.guardian.test'
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
    },
    // getSignerDetailsFromAccount builds `new Word(new BigUint64Array([i,0,0,0]))`
    // as the signer map key; expose the index so the getMapItem mock can resolve it.
    Word: class {
      idx: number;
      constructor(arr: BigUint64Array) {
        this.idx = Number(arr?.[0] ?? 0n);
      }
    }
  };
});
jest.mock('@miden-sdk/miden-sdk', () => {
  const actual = jest.requireActual('../../../../__mocks__/wasmMock.js');
  return {
    ...actual,
    AuthSecretKey: {
      ecdsaWithRNG: jest.fn((seed: Uint8Array) => buildStubKey(`s${Array.from(seed).join('-')}`))
    },
    // getSignerDetailsFromAccount builds `new Word(new BigUint64Array([i,0,0,0]))`
    // as the signer map key; expose the index so the getMapItem mock can resolve it.
    Word: class {
      idx: number;
      constructor(arr: BigUint64Array) {
        this.idx = Number(arr?.[0] ?? 0n);
      }
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

  // Mock account whose storage().getMapItem resolves a signer commitment by the
  // index encoded in the key word (the Word mock above sets `{ idx }`). This
  // mirrors the real by-key read; positional order is irrelevant.
  const makeAccount = (signersByIndex: Record<number, string>) => ({
    storage: () => ({
      getMapItem: jest.fn((_slot: string, key: { idx: number }) => {
        const hex = signersByIndex[key.idx];
        return hex === undefined ? undefined : { toHex: () => hex };
      })
    })
  });

  it('reads the hot signer commitment from index 0', async () => {
    const account = makeAccount({ 0: '0xcommit-hot', 1: '0xcommit-cold' });

    expect(await getSignerDetailsFromAccount(account as never)).toEqual({ commitment: 'commit-hot' });
  });

  it('reads the cold signer commitment from index 1 on a 3-key account', async () => {
    const account = makeAccount({ 0: '0xcommit-hot', 1: '0xcommit-cold' });

    expect(await getSignerDetailsFromAccount(account as never, true)).toEqual({ commitment: 'commit-cold' });
  });

  it('reads the cold signer commitment from index 0 on a legacy single-signer account', async () => {
    // Legacy Guardian accounts (feature #153) have a single on-chain signer —
    // the cold/HD key — at index 0. The cold lookup falls back to it (index 1 is
    // absent) rather than throwing, which would brick activation of a migrated
    // account.
    const account = makeAccount({ 0: '0xcommit-legacy-cold' });

    expect(await getSignerDetailsFromAccount(account as never, true)).toEqual({ commitment: 'commit-legacy-cold' });
  });

  it('reads commitments by signer-index key, independent of storage iteration order', async () => {
    // Regression guard for the SMT-order bug: getMapItem(signerMapKey(i)) resolves
    // hot=0 / cold=1 correctly regardless of getMapEntries iteration order. A
    // positional read would bind the wrong signer for ~half of accounts.
    const account = makeAccount({ 0: '0xhotC', 1: '0xcoldC' });

    expect(await getSignerDetailsFromAccount(account as never)).toEqual({ commitment: 'hotC' });
    expect(await getSignerDetailsFromAccount(account as never, true)).toEqual({ commitment: 'coldC' });
  });

  it('throws when there is no signer at index 0', async () => {
    const account = makeAccount({});

    await expect(getSignerDetailsFromAccount(account as never)).rejects.toThrow(
      'No signer commitment found in account storage'
    );
  });

  it('treats an empty-word entry (0x / all-zeros) as no signer', async () => {
    const account = makeAccount({ 0: '0x' });

    await expect(getSignerDetailsFromAccount(account as never)).rejects.toThrow(
      'No signer commitment found in account storage'
    );
  });

  it('accepts a commitment hex without a 0x prefix', async () => {
    const account = makeAccount({ 0: 'beefcafe' });

    expect(await getSignerDetailsFromAccount(account as never)).toEqual({ commitment: 'beefcafe' });
  });

  it('exposes the multisig storage slot names', () => {
    expect(MULTISIG_SLOT_NAMES.SIGNER_PUBLIC_KEYS).toBe('openzeppelin::multisig::signer_public_keys');
  });
});

describe('getGuardianCommitmentFromAccount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // The guardian public_key slot is a SEPARATE storage map from the multisig
  // signer slots read by getSignerDetailsFromAccount — the mock keys the fake
  // getMapItem by slot name so a cross-slot read would return the wrong (or
  // no) value.
  const makeAccount = (bySlot: Record<string, string | undefined>) => ({
    storage: () => ({
      getMapItem: jest.fn((slot: string) => {
        const hex = bySlot[slot];
        return hex === undefined ? undefined : { toHex: () => hex };
      })
    })
  });

  it('reads the guardian commitment from the guardian public_key slot', () => {
    const account = makeAccount({ [GUARDIAN_SLOT_NAMES.PUBLIC_KEY]: '0xdeadbeef' });

    expect(getGuardianCommitmentFromAccount(account as never)).toBe('deadbeef');
  });

  it('returns undefined when the guardian public_key slot has no entry', () => {
    const account = makeAccount({});

    expect(getGuardianCommitmentFromAccount(account as never)).toBeUndefined();
  });

  it('returns undefined for the empty (all-zero) word', () => {
    const account = makeAccount({ [GUARDIAN_SLOT_NAMES.PUBLIC_KEY]: '0x' + '0'.repeat(64) });

    expect(getGuardianCommitmentFromAccount(account as never)).toBeUndefined();
  });

  it('accepts a guardian commitment hex without a 0x prefix', () => {
    const account = makeAccount({ [GUARDIAN_SLOT_NAMES.PUBLIC_KEY]: 'deadbeef' });

    expect(getGuardianCommitmentFromAccount(account as never)).toBe('deadbeef');
  });

  it('does not read from the multisig signer_public_keys slot', () => {
    const account = makeAccount({ [MULTISIG_SLOT_NAMES.SIGNER_PUBLIC_KEYS]: '0xcommit-hot' });

    expect(getGuardianCommitmentFromAccount(account as never)).toBeUndefined();
  });

  it('exposes the guardian storage slot names', () => {
    expect(GUARDIAN_SLOT_NAMES.PUBLIC_KEY).toBe('openzeppelin::guardian::public_key');
    expect(GUARDIAN_SLOT_NAMES.SELECTOR).toBe('openzeppelin::guardian::selector');
    expect(GUARDIAN_SLOT_NAMES.SCHEME_ID).toBe('openzeppelin::guardian::scheme_id');
  });
});

describe('guardianProviderFromEndpoint', () => {
  it('maps a known OpenZeppelin endpoint to its provider id', () => {
    expect(guardianProviderFromEndpoint('https://guardian.openzeppelin.com')).toBe('open-zeppelin');
  });

  it('maps a known Gateway endpoint to its provider id', () => {
    expect(guardianProviderFromEndpoint('https://miden-guardian.dev.eu-north-3.gateway.fm')).toBe('gateway');
  });

  it('maps a known LambdaClass endpoint to its provider id', () => {
    expect(guardianProviderFromEndpoint('https://miden-guardian.lambdaclass.com')).toBe('lambda-class');
  });

  it('falls back to custom for an unrecognized endpoint', () => {
    expect(guardianProviderFromEndpoint('https://my-own.example.com')).toBe('custom');
  });

  it('falls back to custom for a matched option whose id has no PROVIDER_ID_MAP entry', () => {
    // Defensive branch: a GUARDIAN_OPTIONS entry could in principle carry an
    // id outside the known GuardianProvider union; the URL still matches, but
    // the map lookup misses, so it falls through to 'custom' rather than
    // returning an invalid provider id.
    expect(guardianProviderFromEndpoint('https://unmapped.guardian.test')).toBe('custom');
  });

  it('returns null for a null endpoint', () => {
    expect(guardianProviderFromEndpoint(null)).toBeNull();
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
    // Endpoint is returned so vault can persist it per-account. No stored URL
    // here (beforeEach stubs undefined), so it falls back to the default.
    expect(result.guardianEndpoint).toBe('https://default.guardian.test');
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

    const result = await createGuardianAccount(webClient as never, new Uint8Array(32));

    // When storage yields a URL, create still succeeds — the URL propagation
    // goes through MultisigClient's constructor which we stubbed, so the
    // useful signal is that fetchFromStorage was consulted.
    expect(mockFetchFromStorage).toHaveBeenCalledWith('guardian_url_setting');
    // And the stored URL is returned for per-account persistence.
    expect(result.guardianEndpoint).toBe('https://stored.guardian');
  });

  it('prefers the explicit override over storage and default', async () => {
    mockFetchFromStorage.mockResolvedValueOnce('https://stored.guardian');
    const webClient = makeWebClient();
    multisigClientConfig.create.mockResolvedValueOnce(makeMultisig());

    const result = await createGuardianAccount(
      webClient as never,
      new Uint8Array(32),
      false,
      'https://override.guardian'
    );

    // Override short-circuits the storage lookup entirely.
    expect(mockFetchFromStorage).not.toHaveBeenCalled();
    expect(result.guardianEndpoint).toBe('https://override.guardian');
  });

  it('wraps underlying errors in a readable message', async () => {
    const webClient = makeWebClient();
    multisigClientConfig.create.mockRejectedValueOnce(new Error('wasm exploded'));

    await expect(createGuardianAccount(webClient as never, new Uint8Array(32))).rejects.toThrow(
      'Failed to create Guardian account'
    );
  });
});

describe('resolveGuardianEndpoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('prefers the per-account guardianEndpoint when present', async () => {
    const endpoint = await resolveGuardianEndpoint({ guardianEndpoint: 'https://per-account.guardian' } as never);
    expect(endpoint).toBe('https://per-account.guardian');
    // The per-account field short-circuits the global-key lookup.
    expect(mockFetchFromStorage).not.toHaveBeenCalled();
  });

  it('falls back to the legacy global key when the account has no endpoint', async () => {
    mockFetchFromStorage.mockResolvedValueOnce('https://global.guardian');
    const endpoint = await resolveGuardianEndpoint({} as never);
    expect(mockFetchFromStorage).toHaveBeenCalledWith('guardian_url_setting');
    expect(endpoint).toBe('https://global.guardian');
  });

  it('falls back to DEFAULT_GUARDIAN_ENDPOINT when neither field nor global key is set', async () => {
    mockFetchFromStorage.mockResolvedValueOnce(undefined);
    const endpoint = await resolveGuardianEndpoint({} as never);
    expect(endpoint).toBe('https://default.guardian.test');
  });
});

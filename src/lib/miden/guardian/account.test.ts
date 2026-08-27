/**
 * guardian/account — getSignerDetailsFromAccount reads the first signer
 * commitment out of the multisig storage slot; createGuardianAccount drives
 * MultisigClient.create + guardian registration + keystore insertion for
 * the 3-key (hot + cold + guardian) layout.
 *
 * All external collaborators are stubbed; we don't exec any real WASM.
 */

import {
  assertGuardianKeyCommitment,
  createGuardianAccount,
  getGuardianCommitmentFromAccount,
  getSignerDetailsFromAccount,
  guardianProviderFromEndpoint,
  insertGuardianAccountMonotonically,
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

// The two account readers go through AccountInspector, the package's supported
// layout-insulated accessor — see the comment above them in ./account.
const mockGetSignerCommitments = jest.fn();
const mockGetGuardianCommitment = jest.fn();

jest.mock('@openzeppelin/miden-multisig-client', () => ({
  MultisigClient: jest.fn().mockImplementation(() => ({
    create: (...a: unknown[]) => multisigClientConfig.create(...a),
    guardianClient: {
      getPubkey: (...a: unknown[]) => multisigClientConfig.getPubkey(...a)
    }
  })),
  AccountInspector: {
    getSignerPublicKeyCommitments: (...a: unknown[]) => mockGetSignerCommitments(...a),
    getGuardianPublicKeyCommitment: (...a: unknown[]) => mockGetGuardianCommitment(...a)
  },
  EcdsaSigner: jest.fn().mockImplementation((sk: unknown) => {
    ecdsaSignerCtor(sk);
    return { sk };
  })
}));

describe('getSignerDetailsFromAccount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // The inspector returns commitments ordered by signer index.
  const withSigners = (commitments: string[]) => mockGetSignerCommitments.mockReturnValue(commitments);

  it('reads the hot signer commitment from index 0', async () => {
    withSigners(['0xcommit-hot', '0xcommit-cold']);

    expect(await getSignerDetailsFromAccount({} as never)).toEqual({ commitment: 'commit-hot' });
  });

  it('reads the cold signer commitment from index 1 on a 3-key account', async () => {
    withSigners(['0xcommit-hot', '0xcommit-cold']);

    expect(await getSignerDetailsFromAccount({} as never, true)).toEqual({ commitment: 'commit-cold' });
  });

  it('reads the cold signer commitment from index 0 on a legacy single-signer account', async () => {
    // Legacy Guardian accounts (feature #153) have a single on-chain signer —
    // the cold/HD key — at index 0. The cold lookup falls back to it (index 1 is
    // absent) rather than throwing, which would brick activation of a migrated
    // account.
    withSigners(['0xcommit-legacy-cold']);

    expect(await getSignerDetailsFromAccount({} as never, true)).toEqual({ commitment: 'commit-legacy-cold' });
  });

  it('resolves signers through AccountInspector rather than a hard-coded slot name', async () => {
    // Regression guard for the 0.17 breakage: the wallet re-declared the storage
    // slot names locally, the component moved namespace upstream, and every read
    // silently returned nothing. Going through the inspector is what keeps this
    // working across contract versions, so assert the delegation itself.
    withSigners(['0xhotC', '0xcoldC']);
    const account = { marker: 'account' };

    await getSignerDetailsFromAccount(account as never);

    expect(mockGetSignerCommitments).toHaveBeenCalledWith(account);
  });

  it('throws when the inspector reports no signers', async () => {
    withSigners([]);

    await expect(getSignerDetailsFromAccount({} as never)).rejects.toThrow(
      'No signer commitment found in account storage'
    );
  });

  it('throws when the inspector rejects the account (wrong contract version)', async () => {
    mockGetSignerCommitments.mockImplementation(() => {
      throw new Error('account has no threshold_config storage slot');
    });

    await expect(getSignerDetailsFromAccount({} as never)).rejects.toThrow(
      'No signer commitment found in account storage'
    );
  });

  it('treats an empty-word entry (0x / all-zeros) as no signer', async () => {
    withSigners(['0x']);

    await expect(getSignerDetailsFromAccount({} as never)).rejects.toThrow(
      'No signer commitment found in account storage'
    );
  });

  it('accepts a commitment hex without a 0x prefix', async () => {
    withSigners(['beefcafe']);

    expect(await getSignerDetailsFromAccount({} as never)).toEqual({ commitment: 'beefcafe' });
  });
});

describe('getGuardianCommitmentFromAccount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads the guardian commitment through the guardian accessor', () => {
    mockGetGuardianCommitment.mockReturnValue('0xdeadbeef');

    expect(getGuardianCommitmentFromAccount({} as never)).toBe('deadbeef');
  });

  it('returns undefined when the account has no guardian key entry', () => {
    // The inspector throws rather than returning empty; callers treat a
    // guardian-less account as "no commitment", not as an error.
    mockGetGuardianCommitment.mockImplementation(() => {
      throw new Error('guardian key entry is missing');
    });

    expect(getGuardianCommitmentFromAccount({} as never)).toBeUndefined();
  });

  it('returns undefined for the empty (all-zero) word', () => {
    mockGetGuardianCommitment.mockReturnValue('0x' + '0'.repeat(64));

    expect(getGuardianCommitmentFromAccount({} as never)).toBeUndefined();
  });

  it('accepts a guardian commitment hex without a 0x prefix', () => {
    mockGetGuardianCommitment.mockReturnValue('deadbeef');

    expect(getGuardianCommitmentFromAccount({} as never)).toBe('deadbeef');
  });

  it('does not read the multisig signer commitments', () => {
    // The guardian key lives in its own storage slot; reading the signer
    // accessor here would return a device key and silently mis-report the
    // account's guardian.
    mockGetGuardianCommitment.mockReturnValue('0xdeadbeef');

    getGuardianCommitmentFromAccount({} as never);

    expect(mockGetSignerCommitments).not.toHaveBeenCalled();
  });
});

// This is the trust boundary for the one guardian response that becomes code:
// the switch-guardian paths hand `GET /pubkey`'s commitment to
// `buildUpdateGuardianTransactionRequest`, which splices it into MASM source
// after a `normalizeHexWord` that validates neither charset nor length.
describe('assertGuardianKeyCommitment', () => {
  const word = 'ab'.repeat(32);

  it.each([
    ['a 0x-prefixed word', `0x${word}`],
    ['an unprefixed word', word],
    ['an uppercase word', `0x${word.toUpperCase()}`]
  ])('accepts %s and returns it 0x-prefixed and lowercased', (_label, commitment) => {
    expect(assertGuardianKeyCommitment(commitment, 'https://g.test')).toBe(`0x${word}`);
  });

  it.each([
    // The one that matters: `padStart(64, '0')` is a no-op on an over-long
    // string, so everything after the word survives into the script source.
    ['MASM appended after a valid word', `${'0'.repeat(64)}\ncall.0x${'1'.repeat(64)}\npush.0`],
    ['a truncated word', '0xdeadbeef'],
    ['an over-long word', `0x${word}ab`],
    ['non-hex characters', `0x${'z'.repeat(64)}`],
    ['an empty string', ''],
    ['only the prefix', '0x'],
    ['internal whitespace', `0x${word.slice(0, 60)} abc`],
    ['a number', 1234],
    ['null', null],
    ['undefined', undefined],
    ['an object', { commitment: word }]
  ])('rejects %s', (_label, commitment) => {
    expect(() => assertGuardianKeyCommitment(commitment, 'https://g.test')).toThrow('malformed key commitment');
  });

  it('names the endpoint that served the bad value', () => {
    expect(() => assertGuardianKeyCommitment('nope', 'https://rogue.test')).toThrow('https://rogue.test');
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
    // Endpoint is returned so vault can persist it per-account. No override was
    // supplied and the frozen global key is never consulted for a create, so it
    // resolves to the effective network default.
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

  it('falls back to the default (NOT the frozen global key) when no override is supplied', async () => {
    // #408 stage 3: a NEW account must never inherit the frozen global key.
    // createGuardianAccount no longer reads GUARDIAN_URL_STORAGE_KEY at all — the
    // assertion below proves storage is never consulted. With no override, the
    // endpoint is the effective network default.
    const webClient = makeWebClient();
    multisigClientConfig.create.mockResolvedValueOnce(makeMultisig());

    const result = await createGuardianAccount(webClient as never, new Uint8Array(32));

    // The global-key read is gone: storage is never consulted for a create.
    expect(mockFetchFromStorage).not.toHaveBeenCalled();
    expect(result.guardianEndpoint).toBe('https://default.guardian.test');
  });

  it('prefers the explicit override over the default', async () => {
    const webClient = makeWebClient();
    multisigClientConfig.create.mockResolvedValueOnce(makeMultisig());

    const result = await createGuardianAccount(
      webClient as never,
      new Uint8Array(32),
      false,
      'https://override.guardian'
    );

    // Override is used verbatim; storage is never consulted.
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

describe('insertGuardianAccountMonotonically', () => {
  const makeAccount = (nonce: bigint) => ({
    id: () => ({ toString: () => 'acc-1' }),
    nonce: () => ({ asInt: () => nonce })
  });

  const makeClient = (storedNonce?: bigint) => ({
    accounts: {
      insert: jest.fn(async () => {}),
      get: jest.fn(async () => (storedNonce === undefined ? null : makeAccount(storedNonce)))
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('inserts when the account is not present locally', async () => {
    const client = makeClient();
    const account = makeAccount(3n);

    await insertGuardianAccountMonotonically(client as never, account as never);

    expect(client.accounts.insert).toHaveBeenCalledWith({ account, overwrite: true });
  });

  it('inserts when the snapshot is newer than local state', async () => {
    const client = makeClient(1n);

    await insertGuardianAccountMonotonically(client as never, makeAccount(2n) as never);

    expect(client.accounts.insert).toHaveBeenCalledTimes(1);
  });

  it('still overwrites at an equal nonce, since the snapshot may carry more detail', async () => {
    const client = makeClient(2n);

    await insertGuardianAccountMonotonically(client as never, makeAccount(2n) as never);

    expect(client.accounts.insert).toHaveBeenCalledTimes(1);
  });

  it('refuses a staler snapshot instead of rolling local state backwards', async () => {
    const client = makeClient(2n);

    await insertGuardianAccountMonotonically(client as never, makeAccount(1n) as never);

    expect(client.accounts.insert).not.toHaveBeenCalled();
  });

  it('keeps the committed state when a creation-time snapshot arrives last', async () => {
    // The `guardian-recovery` flake exactly: one recovery adopts the same
    // account twice, and before this guard a nonce-0 snapshot landing second
    // left the account locally uncommitted, so the following hot-key rotation
    // was built as an account creation and the node rejected it with
    // "initial account commitment 0x0000…0000 does not match the current
    // commitment". Order must no longer decide the outcome.
    const stored: { nonce: bigint } = { nonce: 0n };
    const client = {
      accounts: {
        insert: jest.fn(async ({ account }: { account: { nonce: () => { asInt: () => bigint } } }) => {
          stored.nonce = account.nonce().asInt();
        }),
        get: jest.fn(async () => (stored.nonce === 0n ? null : makeAccount(stored.nonce)))
      }
    };

    await insertGuardianAccountMonotonically(client as never, makeAccount(1n) as never);
    await insertGuardianAccountMonotonically(client as never, makeAccount(0n) as never);

    expect(stored.nonce).toBe(1n);
    expect(client.accounts.insert).toHaveBeenCalledTimes(1);
  });
});

/**
 * guardian/account — getSignerDetailsFromAccount reads the first signer
 * commitment out of the multisig storage slot; fetchGuardianCreateKey fetches
 * the guardian's key, createGuardianAccount drives MultisigClient.create +
 * keystore insertion for the 3-key (hot + cold + guardian) layout, and
 * registerGuardianAccount registers the account on its guardian.
 *
 * All external collaborators are stubbed; we don't exec any real WASM.
 */

import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import { u8ToB64 } from 'lib/shared/helpers';

import {
  assertGuardianKeyCommitment,
  createGuardianAccount,
  fetchGuardianCreateKey,
  getGuardianCommitmentFromAccount,
  getSignerDetailsFromAccount,
  guardianProviderFromEndpoint,
  insertGuardianAccountMonotonically,
  registerGuardianAccount,
  resolveChosenGuardianEndpoint,
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

// Only isExtension is steered; the rest of the module (isMobile for the native
// HTTP origin) stays real.
const mockIsExtension = jest.fn(() => false);
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isExtension: () => mockIsExtension()
}));

const mockAlarmsCreate = jest.fn(async (_name: string, _info: { periodInMinutes?: number }) => {});
const mockAlarmsClear = jest.fn(async (_name: string) => true);
jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    alarms: {
      create: (name: string, info: { periodInMinutes?: number }) => mockAlarmsCreate(name, info),
      clear: (name: string) => mockAlarmsClear(name)
    }
  }
}));

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

jest.mock('@openzeppelin/guardian-client', () => ({
  GuardianHttpClient: jest.fn().mockImplementation(() => ({
    getPubkey: (...a: unknown[]) => multisigClientConfig.getPubkey(...a)
  }))
}));

jest.mock('@openzeppelin/miden-multisig-client', () => ({
  MultisigClient: jest.fn().mockImplementation(() => ({
    create: (...a: unknown[]) => multisigClientConfig.create(...a)
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

jest.mock('./native-http');
const { mockProbeVerdicts, registerGuardianOrigin, resetMockProbes } =
  jest.requireMock<typeof import('./__mocks__/native-http')>('./native-http');

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

  // The inspector's return value is not type-checked at runtime, and a slot that
  // yields a non-string does NOT throw inside the try above — so without the type
  // guard, `stripHexPrefix` calls `.startsWith` on it and a bare TypeError escapes
  // a function whose contract is `string | undefined`. Every caller reads
  // `undefined` as "no guardian key, do nothing"; a throw instead strands the
  // drift reconciler mid-status and can spend a self-heal attempt.
  it.each([[1234], [true], [null], [{ nested: 1 }], [undefined]])(
    'returns undefined rather than throwing for a %p commitment',
    raw => {
      mockGetGuardianCommitment.mockReturnValue(raw);

      expect(() => getGuardianCommitmentFromAccount({} as never)).not.toThrow();
      expect(getGuardianCommitmentFromAccount({} as never)).toBeUndefined();
    }
  );

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

  // The reported id reaches dApps as `guardianProvider` (dapp.ts), so a host-case
  // or default-port spelling of a built-in must still map to it rather than falling
  // through to 'custom'.
  it('maps a host-case spelling of a known endpoint to its provider id', () => {
    expect(guardianProviderFromEndpoint('https://Guardian.OpenZeppelin.com')).toBe('open-zeppelin');
  });
});

describe('createGuardianAccount', () => {
  const ACCOUNT_STATE = new Uint8Array([7, 8, 9]);
  const makeMultisig = () => ({
    account: {
      id: jest.fn(() => ({ toString: () => 'guardian-acc-id' })),
      serialize: jest.fn(() => ACCOUNT_STATE)
    },
    registerOnGuardian: jest.fn(async (_state?: string) => {})
  });

  const makeWebClient = () => ({
    sync: jest.fn(async () => {}),
    keystore: { insert: jest.fn(async () => {}) }
  });

  // Runs the three phases as production does: fetch the key, build the account,
  // then register outside the hold.
  const createAndRegister = async (
    webClient: ReturnType<typeof makeWebClient>,
    seed?: Uint8Array,
    override?: string,
    assertLive?: (step?: string) => void
  ) => {
    const createKey = await fetchGuardianCreateKey(override);
    const created = await createGuardianAccount(webClient as never, createKey, seed, assertLive);
    await registerGuardianAccount(created.registration);
    return created;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    resetMockProbes();
    mockIsExtension.mockReturnValue(false);
    multisigClientConfig.getPubkey.mockResolvedValue({ commitment: `0x${'ab'.repeat(32)}`, pubkey: 'g-pubkey' });
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
    const result = await createAndRegister(webClient, seed);

    // Hot is generated via the secure-hot-key facade; cold is HD-derived from seed.
    expect(mockGenerateHotKey).toHaveBeenCalledTimes(1);
    expect(multisigClientConfig.create).toHaveBeenCalledWith(
      expect.objectContaining({
        threshold: 1,
        // Hot first, cold second — order is load-bearing for downstream role routing.
        signerCommitments: ['0xhot-commit', '0xcommit-s1-2-3-4'],
        guardianCommitment: `0x${'ab'.repeat(32)}`,
        guardianPublicKey: 'g-pubkey',
        storageMode: 'private',
        signatureScheme: 'ecdsa',
        seed
      }),
      expect.anything()
    );
    // The deploy proposal is signed by cold (we hand the cold AuthSecretKey to EcdsaSigner).
    expect(ecdsaSignerCtor).toHaveBeenCalledWith(stubKeyByTag['s1-2-3-4']);
    expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(1);
    expect(multisigClientConfig.getPubkey).toHaveBeenCalledTimes(1);
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

  it('creates the account on the normalized commitment of an unprefixed uppercase Guardian key', async () => {
    multisigClientConfig.getPubkey.mockResolvedValueOnce({ commitment: 'AB'.repeat(32), pubkey: 'g-pubkey' });
    multisigClientConfig.create.mockResolvedValueOnce(makeMultisig());

    await createAndRegister(makeWebClient(), new Uint8Array(32));

    expect(multisigClientConfig.create).toHaveBeenCalledWith(
      expect.objectContaining({ guardianCommitment: `0x${'ab'.repeat(32)}` }),
      expect.anything()
    );
  });

  it('generates a random seed when none is provided', async () => {
    const webClient = makeWebClient();
    multisigClientConfig.create.mockResolvedValueOnce(makeMultisig());

    await createAndRegister(webClient);

    // ecdsaWithRNG was still called with a 32-byte Uint8Array (cold-seed fallback).
    const ecdsaCall = jest.requireMock('@miden-sdk/miden-sdk/lazy').AuthSecretKey.ecdsaWithRNG;
    const seedArg = ecdsaCall.mock.calls[0]?.[0];
    expect(seedArg).toBeInstanceOf(Uint8Array);
    expect((seedArg as Uint8Array).length).toBe(32);
  });

  it('falls back to the default (NOT the frozen global key) when no override is supplied', async () => {
    // #408 stage 3: a NEW account must never inherit the frozen global key.
    // The key fetch (fetchGuardianCreateKey) resolves the endpoint without reading
    // GUARDIAN_URL_STORAGE_KEY: the assertion below proves storage is never
    // consulted. With no override, the endpoint is the effective network default.
    const webClient = makeWebClient();
    multisigClientConfig.create.mockResolvedValueOnce(makeMultisig());

    const result = await createAndRegister(webClient, new Uint8Array(32));

    // The global-key read is gone: storage is never consulted for a create.
    expect(mockFetchFromStorage).not.toHaveBeenCalled();
    expect(result.guardianEndpoint).toBe('https://default.guardian.test');
  });

  it('prefers the explicit override over the default', async () => {
    const webClient = makeWebClient();
    multisigClientConfig.create.mockResolvedValueOnce(makeMultisig());

    const result = await createAndRegister(webClient, new Uint8Array(32), 'https://override.guardian');

    // Override is used verbatim; storage is never consulted.
    expect(mockFetchFromStorage).not.toHaveBeenCalled();
    expect(result.guardianEndpoint).toBe('https://override.guardian');
  });

  it('wraps underlying errors in a readable message', async () => {
    const webClient = makeWebClient();
    multisigClientConfig.create.mockRejectedValueOnce(new Error('wasm exploded'));

    await expect(createAndRegister(webClient, new Uint8Array(32))).rejects.toThrow('Failed to create Guardian account');
  });

  // Registration runs with no hold, so it may call nothing on the account the build left
  // borrowed from the client: it sends the state the build serialized, and nothing else.
  it('registers the state the build serialized, calling nothing on the multisig but registerOnGuardian', async () => {
    const webClient = makeWebClient();
    const multisig = makeMultisig();
    multisigClientConfig.create.mockResolvedValueOnce(multisig);

    const createKey = await fetchGuardianCreateKey('https://picked.guardian');
    expect(createKey).toEqual({
      guardianEndpoint: 'https://picked.guardian',
      guardianCommitment: `0x${'ab'.repeat(32)}`,
      guardianPubkey: 'g-pubkey',
      rateLimitBudgetLeftMs: expect.any(Number)
    });

    const created = await createGuardianAccount(webClient as never, createKey, new Uint8Array(32));
    expect(multisig.registerOnGuardian).not.toHaveBeenCalled();
    expect(multisig.account.serialize).toHaveBeenCalledTimes(1);
    const idCalls = multisig.account.id.mock.calls.length;

    await registerGuardianAccount(created.registration);
    expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(1);
    expect(multisig.registerOnGuardian).toHaveBeenCalledWith(Buffer.from([7, 8, 9]).toString('base64'));
    expect(multisig.account.serialize).toHaveBeenCalledTimes(1);
    expect(multisig.account.id.mock.calls.length - idCalls).toBe(0);
  });

  it('wraps a key fetch failure in the creation error, with the cause kept, without retrying it', async () => {
    const cause = new Error('unreachable');
    multisigClientConfig.getPubkey.mockRejectedValueOnce(cause);

    await expect(fetchGuardianCreateKey()).rejects.toMatchObject({
      message: 'Failed to create Guardian account',
      cause
    });
    expect(multisigClientConfig.getPubkey).toHaveBeenCalledTimes(1);
  });

  // A guardian that answers /pubkey with no `pubkey` field is a shape client.create
  // accepts (MultisigConfig.guardianPublicKey is optional), so GuardianCreateKey
  // carries the pubkey as optional and creation does not refuse its absence.
  it('resolves with no guardian pubkey when the guardian omits it, and passes that through to account creation', async () => {
    multisigClientConfig.getPubkey.mockResolvedValueOnce({ commitment: `0x${'ab'.repeat(32)}` });

    const createKey = await fetchGuardianCreateKey();
    expect(createKey.guardianPubkey).toBeUndefined();

    const webClient = makeWebClient();
    multisigClientConfig.create.mockResolvedValueOnce(makeMultisig());
    await createGuardianAccount(webClient as never, createKey, new Uint8Array(32));

    expect(multisigClientConfig.create).toHaveBeenCalledWith(
      expect.objectContaining({ guardianPublicKey: undefined }),
      expect.anything()
    );
  });

  // Not yet bound to an account, so on mobile the endpoint stays routed only once it serves a Guardian key.
  describe('a user-supplied endpoint', () => {
    const create = () => createAndRegister(makeWebClient(), new Uint8Array(32), 'https://override.guardian');

    it('stays routed once it serves a Guardian key, never registered ahead of the read', async () => {
      multisigClientConfig.getPubkey.mockResolvedValueOnce({ commitment: `0x${'ab'.repeat(32)}`, pubkey: 'g-pubkey' });
      multisigClientConfig.create.mockResolvedValueOnce(makeMultisig());

      await create();

      expect(mockProbeVerdicts).toEqual([['https://override.guardian', true]]);
      expect(registerGuardianOrigin).not.toHaveBeenCalled();
    });

    it('is released when its pubkey request fails, and no account is built', async () => {
      multisigClientConfig.getPubkey.mockRejectedValueOnce(new Error('HTTP 404'));

      await expect(create()).rejects.toThrow('Failed to create Guardian account');

      expect(mockProbeVerdicts).toEqual([['https://override.guardian', false]]);
      expect(registerGuardianOrigin).not.toHaveBeenCalled();
      expect(multisigClientConfig.create).not.toHaveBeenCalled();
    });

    it('is released when it serves a key that is not a Guardian key, and no account is built', async () => {
      multisigClientConfig.getPubkey.mockResolvedValueOnce({ commitment: '0xdeadbeef', pubkey: 'g-pubkey' });

      await expect(create()).rejects.toThrow('Failed to create Guardian account');

      expect(mockProbeVerdicts).toEqual([['https://override.guardian', false]]);
      expect(registerGuardianOrigin).not.toHaveBeenCalled();
      expect(multisigClientConfig.create).not.toHaveBeenCalled();
    });

    it('is released at its own deadline when its pubkey request never answers, and no account is built', async () => {
      multisigClientConfig.getPubkey.mockImplementationOnce(() => new Promise(() => {}));

      jest.useFakeTimers();
      try {
        let outcome: unknown = 'pending';
        void create().then(
          () => {
            outcome = 'resolved';
          },
          (error: unknown) => {
            outcome = error;
          }
        );
        await jest.advanceTimersByTimeAsync(29_999);
        expect(outcome).toBe('pending');
        await jest.advanceTimersByTimeAsync(1);

        expect(outcome).toMatchObject({ message: 'Failed to create Guardian account' });
      } finally {
        jest.useRealTimers();
      }
      expect(mockProbeVerdicts).toEqual([['https://override.guardian', false]]);
      expect(multisigClientConfig.create).not.toHaveBeenCalled();
    });
  });

  it('wraps a registration failure in the creation error, with the cause kept', async () => {
    const multisig = makeMultisig();
    const cause = Object.assign(new Error('GUARDIAN HTTP error 500'), { status: 500 });
    multisig.registerOnGuardian.mockRejectedValueOnce(cause);
    multisigClientConfig.create.mockResolvedValueOnce(multisig);
    const created = await createGuardianAccount(
      makeWebClient() as never,
      await fetchGuardianCreateKey(),
      new Uint8Array(32)
    );

    await expect(registerGuardianAccount(created.registration)).rejects.toMatchObject({
      message: 'Failed to create Guardian account',
      cause
    });
  });

  const rateLimited = (retryAfterSecs = 1) =>
    Object.assign(new Error('GUARDIAN HTTP error 429: Too Many Requests'), {
      status: 429,
      code: 'rate_limit_exceeded',
      meta: { retryable: true, retryAfterSecs }
    });

  describe('a guardian answering 429 (#906)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('waits out a 429 on registration and creates the account', async () => {
      const multisig = makeMultisig();
      multisig.registerOnGuardian.mockRejectedValueOnce(rateLimited());
      multisigClientConfig.create.mockResolvedValueOnce(multisig);

      const pending = createAndRegister(makeWebClient(), new Uint8Array(32));
      await jest.advanceTimersByTimeAsync(1000);

      await expect(pending).resolves.toMatchObject({ account: multisig.account });
      expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(2);
      // Serialized once, before the retry loop, and the same state goes out on each attempt.
      expect(multisig.account.serialize).toHaveBeenCalledTimes(1);
      expect(multisig.registerOnGuardian).toHaveBeenNthCalledWith(1, u8ToB64(ACCOUNT_STATE));
      expect(multisig.registerOnGuardian).toHaveBeenNthCalledWith(2, u8ToB64(ACCOUNT_STATE));
    });

    it('waits out a 429 on the guardian pubkey fetch and creates the account', async () => {
      multisigClientConfig.getPubkey.mockRejectedValueOnce(rateLimited());
      const multisig = makeMultisig();
      multisigClientConfig.create.mockResolvedValueOnce(multisig);

      const pending = createAndRegister(makeWebClient(), new Uint8Array(32));
      await jest.advanceTimersByTimeAsync(1000);

      await expect(pending).resolves.toMatchObject({ account: multisig.account });
      expect(multisigClientConfig.getPubkey).toHaveBeenCalledTimes(2);
      expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(1);
    });

    it('gives up after 8 registration calls with the 429 as the cause', async () => {
      const multisig = makeMultisig();
      const last = rateLimited();
      multisig.registerOnGuardian.mockRejectedValue(last);
      multisigClientConfig.create.mockResolvedValueOnce(multisig);

      await Promise.all([
        expect(createAndRegister(makeWebClient(), new Uint8Array(32))).rejects.toMatchObject({
          message: 'Failed to create Guardian account',
          cause: last
        }),
        jest.runAllTimersAsync()
      ]);
      expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(8);
    });

    // The registration wait is bounded by one deadline rather than by the attempt
    // count alone.
    it('gives up at the creation deadline instead of starting a wait that would pass it', async () => {
      const multisig = makeMultisig();
      const last = rateLimited(60);
      multisig.registerOnGuardian.mockRejectedValue(last);
      multisigClientConfig.create.mockResolvedValueOnce(multisig);
      const startedAt = performance.now();

      await Promise.all([
        expect(createAndRegister(makeWebClient(), new Uint8Array(32))).rejects.toMatchObject({
          message: 'Failed to create Guardian account',
          cause: last
        }),
        jest.runAllTimersAsync()
      ]);
      expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(2);
      expect(performance.now() - startedAt).toBe(60_000);
    });

    it('counts the pubkey wait against the same deadline as the registration', async () => {
      multisigClientConfig.getPubkey.mockRejectedValueOnce(rateLimited(60));
      const multisig = makeMultisig();
      const registrationLimited = rateLimited(60);
      multisig.registerOnGuardian.mockRejectedValue(registrationLimited);
      multisigClientConfig.create.mockResolvedValueOnce(multisig);
      const startedAt = performance.now();

      await Promise.all([
        expect(createAndRegister(makeWebClient(), new Uint8Array(32))).rejects.toMatchObject({
          message: 'Failed to create Guardian account',
          cause: registrationLimited
        }),
        jest.runAllTimersAsync()
      ]);
      expect(multisigClientConfig.getPubkey).toHaveBeenCalledTimes(2);
      expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(1);
      expect(performance.now() - startedAt).toBe(60_000);
    });

    // Phase 1 hands registration what it did NOT spend, not the full budget re-measured
    // from phase 1's own start: the wait for the WASM lock and the account build sit
    // between the two, are not guardian waits, and must not eat into registration's
    // 429 budget before its own deadline even starts.
    it('gives registration the budget phase 1 left, measured from when registration starts', async () => {
      const createKey = await fetchGuardianCreateKey();
      // Stands in for queueing for the WASM lock and building the account.
      await jest.advanceTimersByTimeAsync(120_000);

      const webClient = makeWebClient();
      const multisig = makeMultisig();
      multisig.registerOnGuardian.mockRejectedValueOnce(rateLimited(60));
      multisigClientConfig.create.mockResolvedValueOnce(multisig);
      const created = await createGuardianAccount(webClient as never, createKey, new Uint8Array(32));

      const pending = registerGuardianAccount(created.registration);
      await jest.advanceTimersByTimeAsync(60_000);

      await expect(pending).resolves.toBeUndefined();
      expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(2);
    });

    it('still fails at once on a registration error that is not a 429', async () => {
      const multisig = makeMultisig();
      multisig.registerOnGuardian.mockRejectedValueOnce(
        Object.assign(new Error('GUARDIAN HTTP error 500'), { status: 500 })
      );
      multisigClientConfig.create.mockResolvedValueOnce(multisig);

      await expect(createAndRegister(makeWebClient(), new Uint8Array(32))).rejects.toThrow(
        'Failed to create Guardian account'
      );
      expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(1);
    });

    // Chrome stops an idle MV3 service worker after ~30 s, so a minute's wait
    // there needs a keepalive alarm, as the transaction processor arms for its loop.
    it('keeps the extension service worker alive with an alarm for the length of a wait', async () => {
      mockIsExtension.mockReturnValue(true);
      const multisig = makeMultisig();
      multisig.registerOnGuardian.mockRejectedValueOnce(rateLimited(60));
      multisigClientConfig.create.mockResolvedValueOnce(multisig);

      const pending = createAndRegister(makeWebClient(), new Uint8Array(32));
      await jest.advanceTimersByTimeAsync(30_000);
      expect(mockAlarmsCreate).toHaveBeenCalledTimes(1);
      expect(mockAlarmsCreate).toHaveBeenCalledWith(expect.any(String), { periodInMinutes: 0.4 });
      const alarmName = mockAlarmsCreate.mock.calls[0]?.[0];
      expect(alarmName).not.toBe('miden-tx-processor');
      expect(mockAlarmsClear).not.toHaveBeenCalled();
      expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toMatchObject({ account: multisig.account });
      expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(2);
      expect(mockAlarmsClear).toHaveBeenCalledTimes(1);
      expect(mockAlarmsClear).toHaveBeenCalledWith(alarmName);
    });

    it('touches no alarm API off the extension and still waits', async () => {
      const multisig = makeMultisig();
      multisig.registerOnGuardian.mockRejectedValueOnce(rateLimited(60));
      multisigClientConfig.create.mockResolvedValueOnce(multisig);

      const pending = createAndRegister(makeWebClient(), new Uint8Array(32));
      await jest.advanceTimersByTimeAsync(59_999);
      expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ account: multisig.account });
      expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(2);
      expect(mockAlarmsCreate).not.toHaveBeenCalled();
      expect(mockAlarmsClear).not.toHaveBeenCalled();
    });

    // Each re-check guards the step after it: an eviction seen there must stop the
    // flow before that step runs, so every checkpoint is pinned on its own. No
    // guardian call runs inside the hold: registration is registerGuardianAccount's,
    // after it.
    it.each([
      ['before the account build', 'build'],
      ['before the account serialize', 'serialize'],
      ['before the sync', 'sync'],
      ['before the cold key insert', 'insert']
    ] as const)('stops %s once the hold is evicted, skipping the %s', async (checkpoint, step) => {
      const multisig = makeMultisig();
      if (step !== 'build') multisigClientConfig.create.mockResolvedValueOnce(multisig);
      const webClient = makeWebClient();
      const poison = new WasmClientPoisonedError('watchdog', new Error(`evicted ${checkpoint}`));
      const assertLive = (where?: string) => {
        if (where === checkpoint) throw poison;
      };
      const createKey = await fetchGuardianCreateKey();

      await expect(createGuardianAccount(webClient as never, createKey, new Uint8Array(32), assertLive)).rejects.toBe(
        poison
      );
      expect(multisigClientConfig.create).toHaveBeenCalledTimes(step === 'build' ? 0 : 1);
      expect(multisig.account.serialize).toHaveBeenCalledTimes(step === 'build' || step === 'serialize' ? 0 : 1);
      expect(webClient.sync).toHaveBeenCalledTimes(step === 'insert' ? 1 : 0);
      expect(webClient.keystore.insert).not.toHaveBeenCalled();
    });

    // A lock that lands during a 429 wait refuses the creation after that wait, as locked.
    it('ends the key fetch after a 429 wait with the caller refusal, unwrapped', async () => {
      multisigClientConfig.getPubkey.mockRejectedValueOnce(rateLimited());
      const refusal = Object.assign(new Error('Wallet is locked'), { reason: 'locked' });
      const assertLive = () => {
        throw refusal;
      };

      const outcome = fetchGuardianCreateKey(undefined, assertLive).then(
        () => 'resolved',
        (error: unknown) => error
      );
      await jest.advanceTimersByTimeAsync(1000);

      expect(multisigClientConfig.getPubkey).toHaveBeenCalledTimes(1);
      expect(await outcome).toBe(refusal);
    });

    it('keeps the extension service worker alive through a pubkey wait too', async () => {
      mockIsExtension.mockReturnValue(true);
      multisigClientConfig.getPubkey.mockRejectedValueOnce(rateLimited(60));

      const pending = fetchGuardianCreateKey();
      await jest.advanceTimersByTimeAsync(30_000);
      expect(mockAlarmsCreate).toHaveBeenCalledTimes(1);
      expect(mockAlarmsClear).not.toHaveBeenCalled();
      expect(multisigClientConfig.getPubkey).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toMatchObject({
        guardianCommitment: `0x${'ab'.repeat(32)}`,
        guardianPubkey: 'g-pubkey'
      });
      expect(mockAlarmsClear).toHaveBeenCalledWith(mockAlarmsCreate.mock.calls[0]?.[0]);
    });
  });

  // Out of the WASM hold, no watchdog bounds a guardian that accepts the connection and never
  // answers, and the unlock queue waits behind creation (#1207).
  describe('a guardian that never answers', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const track = (promise: Promise<unknown>) => {
      const state: { outcome: unknown } = { outcome: 'pending' };
      void promise.then(
        () => {
          state.outcome = 'resolved';
        },
        (error: unknown) => {
          state.outcome = error;
        }
      );
      return state;
    };
    const timedOut = {
      message: 'Failed to create Guardian account',
      cause: expect.objectContaining({ message: expect.stringContaining('timed out after 30000ms') })
    };

    it('fails the key fetch after 30 s, without retrying', async () => {
      multisigClientConfig.getPubkey.mockReturnValueOnce(new Promise(() => {}));

      const keyFetch = track(fetchGuardianCreateKey());
      await jest.advanceTimersByTimeAsync(29_999);
      expect(keyFetch.outcome).toBe('pending');
      await jest.advanceTimersByTimeAsync(1);

      expect(keyFetch.outcome).toMatchObject(timedOut);
      expect(multisigClientConfig.getPubkey).toHaveBeenCalledTimes(1);
    });

    // A timed-out /configure may still land, so registration retries the same state and
    // takes the guardian's account_already_exists as the earlier attempt having landed.
    const pendingRegistration = async (multisig: ReturnType<typeof makeMultisig>) => {
      multisigClientConfig.create.mockResolvedValueOnce(multisig);
      const createKey = await fetchGuardianCreateKey();
      return (await createGuardianAccount(makeWebClient() as never, createKey, new Uint8Array(32))).registration;
    };
    const state = Buffer.from([7, 8, 9]).toString('base64');
    const alreadyRegistered = () =>
      Object.assign(new Error('GUARDIAN HTTP error 409'), { status: 409, code: 'account_already_exists' });

    it.each([
      ['accepts account_already_exists', () => Promise.reject(alreadyRegistered())],
      ['resolves when the retry succeeds', () => Promise.resolve()]
    ])('retries a timed-out registration with the same state and %s', async (_label, retry) => {
      const multisig = makeMultisig();
      multisig.registerOnGuardian.mockReturnValueOnce(new Promise<void>(() => {})).mockImplementationOnce(retry);

      const registration = track(registerGuardianAccount(await pendingRegistration(multisig)));
      // The retry follows the 30 s timeout after the switch paths' 1 s backoff.
      await jest.advanceTimersByTimeAsync(30_999);
      expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(1);
      expect(registration.outcome).toBe('pending');
      await jest.advanceTimersByTimeAsync(1);

      expect(registration.outcome).toBe('resolved');
      expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(2);
      expect(multisig.registerOnGuardian).toHaveBeenNthCalledWith(1, state);
      expect(multisig.registerOnGuardian).toHaveBeenNthCalledWith(2, state);
    });

    // Timeouts at 30, 61 and 93 s, with backoffs of 1 s and 2 s between them and none after the last.
    it('fails the registration after three timed-out attempts, at 93 s, with the timeout as the cause', async () => {
      const multisig = makeMultisig();
      const callsAtMs: number[] = [];
      const pendingState = await pendingRegistration(multisig);
      const startedAt = performance.now();
      multisig.registerOnGuardian.mockImplementation(() => {
        callsAtMs.push(performance.now() - startedAt);
        return new Promise<void>(() => {});
      });

      const registration = track(registerGuardianAccount(pendingState));
      await jest.advanceTimersByTimeAsync(92_999);
      expect(registration.outcome).toBe('pending');
      expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(3);
      await jest.advanceTimersByTimeAsync(1);

      expect(registration.outcome).toMatchObject(timedOut);
      expect(callsAtMs).toEqual([0, 31_000, 63_000]);
    });

    // One 429 deadline spans every attempt: a hung attempt does not buy the next one a fresh budget.
    it('fails at 91 s on a 429 after a hung attempt and its backoff, all attempts sharing one deadline', async () => {
      const multisig = makeMultisig();
      const secondLimited = rateLimited(60);
      multisig.registerOnGuardian
        .mockRejectedValueOnce(rateLimited(60))
        .mockReturnValueOnce(new Promise<void>(() => {}))
        .mockRejectedValueOnce(secondLimited);

      const registration = track(registerGuardianAccount(await pendingRegistration(multisig)));
      await jest.advanceTimersByTimeAsync(90_999);
      expect(registration.outcome).toBe('pending');
      await jest.advanceTimersByTimeAsync(1);

      const outcome = registration.outcome;
      expect(outcome).toMatchObject({ message: 'Failed to create Guardian account' });
      expect(outcome instanceof Error && outcome.cause).toBe(secondLimited);
      expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(3);
    });

    it('keeps the extension service worker alive through the backoff before a registration retry', async () => {
      mockIsExtension.mockReturnValue(true);
      const multisig = makeMultisig();
      multisig.registerOnGuardian.mockReturnValueOnce(new Promise<void>(() => {}));

      const registration = track(registerGuardianAccount(await pendingRegistration(multisig)));
      await jest.advanceTimersByTimeAsync(30_000);
      expect(mockAlarmsCreate).toHaveBeenCalledTimes(1);
      expect(mockAlarmsCreate).toHaveBeenCalledWith(expect.any(String), { periodInMinutes: 0.4 });
      expect(mockAlarmsClear).not.toHaveBeenCalled();
      expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1000);
      expect(registration.outcome).toBe('resolved');
      expect(mockAlarmsClear).toHaveBeenCalledWith(mockAlarmsCreate.mock.calls[0]?.[0]);
      expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(2);
      // Cleared before the retry is sent, not left armed across it.
      expect(mockAlarmsClear.mock.invocationCallOrder[0]).toBeLessThan(
        multisig.registerOnGuardian.mock.invocationCallOrder[1] ?? 0
      );
    });
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

  it('propagates a failed storage read rather than answering with the default', async () => {
    // The default arm must be reachable ONLY by a proven-empty pointer. If a read
    // failure resolved to the default instead, every caller would be handed a
    // guessed operator dressed as the account's own choice.
    mockFetchFromStorage.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(resolveGuardianEndpoint({} as never)).rejects.toThrow('storage unavailable');
  });
});

describe('resolveChosenGuardianEndpoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('prefers the per-account guardianEndpoint without reading storage', async () => {
    const endpoint = await resolveChosenGuardianEndpoint({ guardianEndpoint: 'https://per-account.guardian' });
    expect(endpoint).toBe('https://per-account.guardian');
    expect(mockFetchFromStorage).not.toHaveBeenCalled();
  });

  it('falls back to the legacy global key, the only pointer a pre-per-account account has', async () => {
    mockFetchFromStorage.mockResolvedValueOnce('https://global.guardian');
    await expect(resolveChosenGuardianEndpoint({})).resolves.toBe('https://global.guardian');
    expect(mockFetchFromStorage).toHaveBeenCalledWith('guardian_url_setting');
  });

  it.each([
    ['unset', undefined],
    ['an empty string', '']
  ])('returns undefined rather than the network default when the global key is %s', async (_label, stored) => {
    // The distinguishing property against `resolveGuardianEndpoint`: callers that
    // POST private account state, or that accuse an account of naming no
    // operator, must be able to tell "chose nothing" from "was given a guess".
    mockFetchFromStorage.mockResolvedValueOnce(stored);
    await expect(resolveChosenGuardianEndpoint({})).resolves.toBeUndefined();
  });

  it('propagates a failed storage read instead of reporting no chosen endpoint', async () => {
    // `undefined` is a VERDICT here ("named no operator"). A swallowed read error
    // would forge that verdict out of a transient failure, which is what lets the
    // drift reconciler accuse a healthy account.
    mockFetchFromStorage.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(resolveChosenGuardianEndpoint({})).rejects.toThrow('storage unavailable');
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

import { OperationAbortedError } from 'lib/miden/back/offscreen-codec';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import type { WalletAccount } from 'lib/shared/types';

import {
  createDirectSwitchGuardianRequest,
  didDirectSwitchLand,
  finalizeDirectGuardianSwitch,
  isGuardianRegistrationPreflightError,
  isGuardianUnreachableError
} from './direct-switch';

// ---------------------------------------------------------------------------
// Mocks. `direct-switch` reaches the WASM SDK, the offscreen proxy, the vault
// signer and the guardian HTTP client; every one of those is stubbed so the
// classifier, the signer-distinctness guard, the anchor release and the
// registration retry loop can be exercised as plain logic.
//
// `@openzeppelin/miden-multisig-client` resolves to the manual mock adjacent to
// node_modules, whose `isLikelyNetworkError` is the package's REAL heuristic —
// which is the point here: the classifier below has to hold against the actual
// substring matcher, not a stub.
// ---------------------------------------------------------------------------

// Mocked by the SAME specifier the source imports them under — a `lib/...`
// path here would leave the real module in the graph.
const mockWithWasmClientLock = jest.fn(<T>(fn: () => Promise<T>) => fn());
const mockGetMidenClient = jest.fn();
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: () => mockGetMidenClient(),
  withWasmClientLock: <T>(fn: () => Promise<T>) => mockWithWasmClientLock(fn)
}));

const mockFreeChainAnchor = jest.fn();
jest.mock('../sdk/chain-anchor', () => ({
  freeChainAnchor: (...args: unknown[]) => mockFreeChainAnchor(...args)
}));

const mockProxySyncState = jest.fn(async () => {});
const mockProxyGetAccount = jest.fn();
const mockProxyGetTransactionCommitState = jest.fn();
jest.mock('../back/miden-client-proxy', () => ({
  midenClientProxy: {
    syncState: () => mockProxySyncState(),
    getAccount: (...args: unknown[]) => mockProxyGetAccount(...args),
    getTransactionCommitState: (...args: unknown[]) => mockProxyGetTransactionCommitState(...args)
  }
}));

const mockGetSignerDetails = jest.fn();
// `assertGuardianKeyCommitment` is kept REAL — it is pure string validation, and
// stubbing the guard that keeps wire data out of the transaction script would
// make these tests blind to exactly what it exists to stop.
jest.mock('./account', () => ({
  ...jest.requireActual('./account'),
  getSignerDetailsFromAccount: (...args: unknown[]) => mockGetSignerDetails(...args)
}));

jest.mock('./native-http', () => ({ registerGuardianOrigin: jest.fn() }));

// Only the key→commitment derivation is stubbed (it needs a real 33-byte secp256k1
// key, which these fixtures are not); `sameCommitment` stays REAL so the
// prefix/case normalization the allowlist check relies on is exercised rather
// than assumed. The stub mirrors production's shape: one commitment per key, so
// a different device's key derives a different commitment.
jest.mock('lib/secure-hot-key/commitment', () => ({
  ...jest.requireActual('lib/secure-hot-key/commitment'),
  commitmentFromPublicKeyHex: jest.fn(async (publicKeyHex: string) =>
    publicKeyHex === '0xhotpk' ? 'HOTCOMMITMENT' : `commitment-of-${publicKeyHex}`
  )
}));

// Zero backoff so the retry loop runs at test speed — but through a spy, not a
// constant. The schedule's own arithmetic is covered by `serialize`'s suite;
// what belongs here is that the loop CONSULTS it, with the error it just caught
// and the attempt it just spent. A loop that sleeps a fixed interval instead
// retries a 429 under the cooldown the guardian just asked for and earns
// another one — while the rotation it is finalizing has already committed.
const mockRegisterBackoffMs = jest.fn((_error: unknown, _attempt: number) => 0);
jest.mock('./serialize', () => ({
  guardianRegisterBackoffMs: (error: unknown, attempt: number) => mockRegisterBackoffMs(error, attempt)
}));

jest.mock('./signer', () => ({ WalletSigner: class {} }));

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveRpcUrl: () => 'https://rpc.test',
  getEffectiveNetworkName: () => 'devnet'
}));

// The advice map is the cryptographic payload of a direct switch — by the time
// the request is submitted it is the ONLY place the hot and cold signatures
// exist, and nothing downstream re-derives any of it. So `AdviceMap` stands in
// faithfully rather than as a tally of inserts: it is KEYED by word like the
// pinned `insert(key: Word, value: FeltArray): Felt[] | undefined`, so a second
// insert under the same key overwrites the first (and hands back what it
// displaced) instead of appending a second entry. A mock that only counted
// inserts would show two entries for a map that reaches the chain holding one
// signature against a threshold-2 procedure.
//
// `Poseidon2.hashElements` and `Word.fromHex` stay deterministic and injective
// over the hex fixtures here, so the tests recompute the key they EXPECT from
// this same identity instead of pinning an opaque digest — which is what keeps
// the preimage ORDER visible to an assertion.
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  AdviceMap: class {
    readonly entries = new Map<string, unknown[]>();
    insert(key: { hex: string }, value: { felts: unknown[] }): unknown[] | undefined {
      const previous = this.entries.get(key.hex);
      this.entries.set(key.hex, value.felts);
      return previous;
    }
  },
  FeltArray: class {
    constructor(readonly felts: unknown[]) {}
  },
  Poseidon2: { hashElements: (felts: { felts: string[] }) => ({ hex: felts.felts.join('|') }) },
  Signature: { deserialize: (bytes: Uint8Array) => ({ toPreparedSignature: () => [...bytes] }) },
  Word: { fromHex: (hex: string) => ({ hex, toFelts: () => [hex] }) }
}));

// A real `GET /pubkey` commitment is a 32-byte word. The switch paths validate
// that before it reaches the transaction script, so the fixture has to be a
// well-formed one.
const NEW_GUARDIAN_COMMITMENT = `0x${'ab'.repeat(32)}`;

const mockGuardianGetPubkey = jest.fn(async () => ({ commitment: NEW_GUARDIAN_COMMITMENT }));
const mockGuardianConfigure = jest.fn();
const mockGuardianSetSigner = jest.fn();
jest.mock('@openzeppelin/miden-multisig-client', () => {
  const actual = jest.requireActual('@openzeppelin/miden-multisig-client');
  return {
    ...actual,
    GuardianHttpClient: class {
      getPubkey = (...args: unknown[]) => mockGuardianGetPubkey(...(args as []));
      configure = (...args: unknown[]) => mockGuardianConfigure(...args);
      setSigner = (...args: unknown[]) => mockGuardianSetSigner(...args);
    }
  };
});

const mockedMultisigClient = jest.requireMock('@openzeppelin/miden-multisig-client');
const mockedSdk = jest.requireMock('@miden-sdk/miden-sdk/lazy');

// The multisig client's ECDSA auth-scheme prefix byte. `Signature.deserialize`
// dispatches on it, so it decides which curve the bytes behind it are read as.
const ECDSA_AUTH_SCHEME_ID = 1;

/** The advice map handed to the REBUILD — the one that would reach the chain. */
const submittedAdviceEntries = (): Map<string, number[]> =>
  mockedMultisigClient.buildUpdateGuardianTransactionRequest.mock.calls[1][2].signatureAdviceMap.entries;

/**
 * The key the source is supposed to derive for one signer, recomputed through
 * the mock's own hash identity: Poseidon2(signerCommitment ‖ txCommitment), in
 * that order. Recomputed rather than hard-coded so the ORDER is what is being
 * asserted — swap the two halves of the preimage and the transaction script
 * looks up a word the map does not hold, so both signatures are present and
 * neither is found.
 */
const expectedAdviceKey = (signerCommitmentHex: string, txCommitmentHex: string): string =>
  mockedSdk.Poseidon2.hashElements(
    new mockedSdk.FeltArray([
      ...mockedSdk.Word.fromHex(signerCommitmentHex).toFelts(),
      ...mockedSdk.Word.fromHex(txCommitmentHex).toFelts()
    ])
  ).hex;

const walletAccount = (overrides: Partial<WalletAccount> = {}): WalletAccount =>
  ({
    publicKey: '0xacct',
    hotPublicKey: '0xhotpk',
    coldPublicKey: '0xcoldpk',
    ...overrides
  }) as WalletAccount;

const sdkAccount = {
  id: () => ({ toString: () => '0xacct-id' }),
  serialize: () => new Uint8Array([1, 2, 3])
};

beforeEach(() => {
  jest.clearAllMocks();
  mockWithWasmClientLock.mockImplementation(<T>(fn: () => Promise<T>) => fn());
  mockGetMidenClient.mockResolvedValue({
    syncState: jest.fn(async () => {}),
    getAccount: jest.fn(async () => sdkAccount),
    client: { kind: 'web-client' }
  });
  mockProxyGetAccount.mockResolvedValue(sdkAccount);
  mockGetSignerDetails.mockImplementation(async (_account: unknown, getCold: boolean) => ({
    commitment: getCold ? 'coldcommitment' : 'hotcommitment'
  }));
  mockGuardianGetPubkey.mockResolvedValue({ commitment: NEW_GUARDIAN_COMMITMENT });
  mockedMultisigClient.AccountInspector.fromAccount.mockReturnValue({
    // `0x`-prefixed on purpose: storage hands back prefixed hex while
    // getSignerDetailsFromAccount hands back bare, and the hot-membership check
    // has to see through that.
    numSigners: 2,
    signerCommitments: ['0xhotcommitment', '0xcoldcommitment']
  });
  mockedMultisigClient.chainAnchorToBase64.mockReturnValue('chain-anchor-b64');
  mockedMultisigClient.executeForSummary.mockResolvedValue({
    summary: { toCommitment: () => ({ toHex: () => '0xtxcommitment' }) },
    anchor: { kind: 'anchor' }
  });
  mockedMultisigClient.buildUpdateGuardianTransactionRequest.mockResolvedValue({
    request: { kind: 'update-guardian-request' },
    salt: { toHex: () => '0xsalt' }
  });
});

describe('isGuardianUnreachableError', () => {
  it.each([
    ['a fetch failure', new Error('Failed to fetch')],
    ['a DNS failure', new Error('getaddrinfo ENOTFOUND guardian.test')],
    ['a refused connection', new Error('connect ECONNREFUSED 127.0.0.1:3000')],
    ['a timeout', new Error('request timed out')],
    ['a 502 from a proxy', Object.assign(new Error('Bad Gateway'), { status: 502 })],
    ['a 500 from the operator', Object.assign(new Error('Internal Server Error'), { status: 500 })],
    ['a 599 edge status', Object.assign(new Error('weird'), { status: 599 })]
  ])('treats %s as the guardian being unreachable', (_label, error) => {
    expect(isGuardianUnreachableError(error)).toBe(true);
  });

  it.each([
    ['a 401 auth rejection', Object.assign(new Error('Unauthorized'), { status: 401 })],
    ['a 409 pending conflict', Object.assign(new Error('ConflictPendingDelta'), { status: 409 })],
    ['a 404 route miss', Object.assign(new Error('Not Found'), { status: 404 })],
    ['a 600 out-of-range status', Object.assign(new Error('nope'), { status: 600 })],
    ['a string status', Object.assign(new Error('nope'), { status: '503' })],
    ['a plain semantic error', new Error('guardian rejected the delta')],
    ['a non-object throw', 'boom'],
    ['null', null]
  ])('does not treat %s as unreachable', (_label, error) => {
    expect(isGuardianUnreachableError(error)).toBe(false);
  });

  // The reason this predicate checks the kill errors FIRST. Both mean "torn down
  // from outside, outcome unknown"; routing either to the fallback would trade a
  // coordinated proposal against a healthy guardian for a fresh on-chain write.
  // `OperationAbortedError` is the live hazard — its message carries the bare
  // token "aborted", which the package's real `isLikelyNetworkError` matches.
  it('does not treat a local offscreen kill as the guardian being unreachable', () => {
    const aborted = new OperationAbortedError('op-1', 'deadline');

    expect(aborted.message).toContain('aborted');
    expect(mockedMultisigClient.isLikelyNetworkError(aborted)).toBe(true);
    expect(isGuardianUnreachableError(aborted)).toBe(false);
  });

  it('does not treat a WASM lock eviction as the guardian being unreachable', () => {
    expect(isGuardianUnreachableError(new WasmClientPoisonedError('watchdog'))).toBe(false);
    expect(isGuardianUnreachableError(new WasmClientPoisonedError('realm-error', new Error('unreachable')))).toBe(
      false
    );
  });

  // The status is checked BEFORE the message heuristic, and the message is never
  // consulted once a status is present. `GuardianHttpError`'s message
  // interpolates the HTTP reason phrase and the response body's `message`, both
  // of which the operator chooses — so a message-first order would let a
  // reachable guardian declare ITSELF unreachable and collect an on-chain
  // rotation the user never asked for.
  it.each([
    ['a reason phrase', Object.assign(new Error('GUARDIAN HTTP error 403: connection reset by peer'), { status: 403 })],
    [
      'a response body',
      Object.assign(new Error('GUARDIAN HTTP error 409: Conflict - dns lookup aborted'), { status: 409 })
    ]
  ])('ignores network-sounding text in %s when the guardian answered with a status', (_label, error) => {
    // The bare heuristic DOES match — the status check is the only thing
    // standing between this error and a fresh on-chain write.
    expect(mockedMultisigClient.isLikelyNetworkError(error)).toBe(true);
    expect(isGuardianUnreachableError(error)).toBe(false);
  });

  // A 5xx still wins on the status alone, even when the text says nothing.
  it('treats a 503 with no network-sounding text as unreachable', () => {
    const error = Object.assign(new Error('GUARDIAN HTTP error 503: Service Unavailable'), { status: 503 });

    expect(mockedMultisigClient.isLikelyNetworkError(error)).toBe(false);
    expect(isGuardianUnreachableError(error)).toBe(true);
  });

  // The other door the response body can come through: the client calls
  // `response.json()` on any 2xx, and V8 embeds the offending body prefix in the
  // `SyntaxError` message — which carries NO status, so the status guard above
  // does not apply and the text would reach the heuristic. It decides in both
  // directions, and the likelier direction is the damaging one: a captive-portal
  // or CDN interstitial (`<html>502…`) misses every token, so a genuinely dead
  // operator would read as reachable and the fallback would never fire.
  it.each([
    ['a CDN interstitial', new SyntaxError('Unexpected token \'<\', "<html><body>502 Bad Gateway" is not valid JSON')],
    ['an empty body', new SyntaxError('Unexpected end of JSON input')],
    ['a body chosen to match the heuristic', new SyntaxError('Unexpected token \'c\', "connection reset by peer"')]
  ])('treats a 2xx whose body is not JSON as unreachable (%s)', (_label, error) => {
    expect(isGuardianUnreachableError(error)).toBe(true);
  });

  it('classifies a non-JSON body structurally, not by what the body says', () => {
    // The interstitial case above is the one the heuristic gets WRONG, so pin
    // that the verdict does not come from the text.
    const interstitial = new SyntaxError('Unexpected token \'<\', "<html><body>502 Bad Gateway" is not valid JSON');
    expect(mockedMultisigClient.isLikelyNetworkError(interstitial)).toBe(false);
    expect(isGuardianUnreachableError(interstitial)).toBe(true);
  });
});

describe('createDirectSwitchGuardianRequest', () => {
  // Hot and cold sign DIFFERENT bytes, keyed by the pubkey the vault is asked to
  // sign with. One shared signature string would make the two advice values
  // byte-identical, and folding the hot signature in where the cold one belongs
  // — a map that satisfies neither signer nor the threshold — would then be
  // invisible to every assertion below. Even-length hex, because `hexToBytes`
  // rejects an odd-length signature outright.
  const HOT_SIGNATURE = '0xa1b2c3';
  const COLD_SIGNATURE = '0xd4e5f6';
  const signWord = jest.fn(async (pubkey: string) => (pubkey === 'coldpk' ? COLD_SIGNATURE : HOT_SIGNATURE));

  it('builds a request carrying the summary chain anchor', async () => {
    const { request, chainAnchorB64 } = await createDirectSwitchGuardianRequest(
      walletAccount(),
      'https://new.guardian.test',
      signWord
    );

    expect(chainAnchorB64).toBe('chain-anchor-b64');
    expect(request).toEqual({ kind: 'update-guardian-request' });
    // Rebuilt with the SAME salt as the executed-for-summary request, plus the
    // signature advice — that identity is what keeps the rebuilt request's
    // commitment equal to the one hot and cold signed.
    const rebuild = mockedMultisigClient.buildUpdateGuardianTransactionRequest.mock.calls[1];
    expect(rebuild[2].salt).toEqual({ hex: '0xsalt', toFelts: expect.any(Function) });
    expect(signWord).toHaveBeenCalledWith('hotpk', '0xtxcommitment');
    expect(signWord).toHaveBeenCalledWith('coldpk', '0xtxcommitment');
  });

  // `parseInt('zz', 16)` is `NaN`, and a `Uint8Array` store coerces that to `0`.
  // Without a charset check a malformed nibble anywhere in the signature would
  // silently become a zero byte, and the rotation would spend a real on-chain
  // write to earn an opaque authorization failure. Neither caller can emit
  // non-hex today, which is the reason this has to fail loudly if one starts to
  // rather than the reason not to check.
  it('refuses a signature carrying non-hex rather than zero-filling it', async () => {
    const bogus = jest.fn(async () => '0xzz');

    await expect(
      createDirectSwitchGuardianRequest(walletAccount(), 'https://new.guardian.test', bogus)
    ).rejects.toThrow('Invalid hex string');
  });

  it('still refuses an odd-length signature', async () => {
    const bogus = jest.fn(async () => '0xabc');

    await expect(
      createDirectSwitchGuardianRequest(walletAccount(), 'https://new.guardian.test', bogus)
    ).rejects.toThrow('Invalid hex string length');
  });

  // Everything that decides whether the rotation is AUTHORIZED lives in the
  // advice map, and nothing downstream checks any of it: the transaction is
  // proved and submitted with whatever words are in there. One entry per
  // on-chain signer, each keyed by Poseidon2(signerCommitment ‖ txCommitment) —
  // get either half of that preimage, or its order, wrong and the
  // `update_guardian` script looks up a word the map does not hold, so the
  // threshold-2 authorization fails on chain with both signatures sitting right
  // there.
  it('folds one advice entry per signer, keyed by Poseidon2(signerCommitment ‖ txCommitment)', async () => {
    await createDirectSwitchGuardianRequest(walletAccount(), 'https://new.guardian.test', signWord);

    const hotKey = expectedAdviceKey('0xhotcommitment', '0xtxcommitment');
    const coldKey = expectedAdviceKey('0xcoldcommitment', '0xtxcommitment');
    expect(hotKey).not.toBe(coldKey);
    expect([...submittedAdviceEntries().keys()]).toEqual([hotKey, coldKey]);
    // Two entries because the two keys are DISTINCT, not because two inserts
    // ran: the map is keyed by word, so a cold entry keyed by the hot
    // commitment collapses onto it and a threshold-2 transaction is submitted
    // holding one signature.
    expect(submittedAdviceEntries().size).toBe(2);
  });

  // The values are the signatures themselves, each prefixed with the auth-scheme
  // byte `Signature.deserialize` dispatches on — announce the wrong scheme and
  // the bytes behind it are decoded against a different curve. And each has to
  // sit under ITS OWN signer's key: a map carrying the hot signature twice
  // satisfies neither signer, however well-formed it looks.
  it("stores each signer's own ECDSA-prefixed signature under that signer's key", async () => {
    await createDirectSwitchGuardianRequest(walletAccount(), 'https://new.guardian.test', signWord);

    const entries = submittedAdviceEntries();
    expect(entries.get(expectedAdviceKey('0xhotcommitment', '0xtxcommitment'))).toEqual([
      ECDSA_AUTH_SCHEME_ID,
      0xa1,
      0xb2,
      0xc3
    ]);
    expect(entries.get(expectedAdviceKey('0xcoldcommitment', '0xtxcommitment'))).toEqual([
      ECDSA_AUTH_SCHEME_ID,
      0xd4,
      0xe5,
      0xf6
    ]);
  });

  // `getPubkey()` with no argument omits the `?scheme=` query entirely, and the
  // guardian answers with its DEFAULT scheme's key — which this flow then
  // installs on-chain as the account's guardian. The rotation commits, the new
  // operator registers happily, and the account only discovers it holds a key
  // its guardian cannot co-sign with on the next transaction.
  it('asks the new guardian for its ECDSA key specifically', async () => {
    await createDirectSwitchGuardianRequest(walletAccount(), 'https://new.guardian.test', signWord);

    expect(mockGuardianGetPubkey).toHaveBeenCalledWith('ecdsa');
  });

  // Both builds have to agree, and both have to be the EFFECTIVE endpoint. The
  // summary the two device keys sign comes from the first call and the request
  // that is submitted from the second, so a scheme or endpoint that differs
  // between them yields a request whose commitment nothing signed — and a
  // build-baked endpoint winning over a developer override builds the whole
  // rotation against the wrong network.
  it('builds the summary and the rebuild alike against the effective RPC endpoint, as ECDSA', async () => {
    await createDirectSwitchGuardianRequest(walletAccount(), 'https://new.guardian.test', signWord);

    const [summaryBuild, rebuild] = mockedMultisigClient.buildUpdateGuardianTransactionRequest.mock.calls;
    expect(summaryBuild[2]).toEqual({ signatureScheme: 'ecdsa', midenRpcEndpoint: 'https://rpc.test' });
    expect(rebuild[2]).toEqual({
      salt: { hex: '0xsalt', toFelts: expect.any(Function) },
      signatureAdviceMap: expect.anything(),
      signatureScheme: 'ecdsa',
      midenRpcEndpoint: 'https://rpc.test'
    });
    expect(mockedMultisigClient.executeForSummary).toHaveBeenCalledWith(
      expect.anything(),
      '0xacct-id',
      expect.anything(),
      'https://rpc.test'
    );
  });

  it('releases the chain anchor through freeChainAnchor', async () => {
    await createDirectSwitchGuardianRequest(walletAccount(), 'https://new.guardian.test', signWord);

    expect(mockFreeChainAnchor).toHaveBeenCalledWith({ kind: 'anchor' });
  });

  // The anchor carries a partial blockchain, so it must not leak when the
  // serialization after it throws — that is why the release sits in a `finally`.
  it('still releases the chain anchor when serializing it throws', async () => {
    mockedMultisigClient.chainAnchorToBase64.mockImplementation(() => {
      throw new Error('anchor serialize blew up');
    });

    await expect(
      createDirectSwitchGuardianRequest(walletAccount(), 'https://new.guardian.test', signWord)
    ).rejects.toThrow('anchor serialize blew up');
    expect(mockFreeChainAnchor).toHaveBeenCalledWith({ kind: 'anchor' });
  });

  // Cold resolves as `commitments[1] ?? commitments[0]`, so a single-signer
  // account hands back the hot commitment twice. Both advice entries would then
  // collide on one Poseidon2 key and the map would hold ONE signature, failing
  // the threshold-2 `update_guardian` on-chain instead of here.
  it('refuses to build when hot and cold resolve to the same signer commitment', async () => {
    mockGetSignerDetails.mockResolvedValue({ commitment: 'the-only-signer' });

    await expect(
      createDirectSwitchGuardianRequest(walletAccount(), 'https://new.guardian.test', signWord)
    ).rejects.toThrow('same on-chain signer commitment for hot and cold');
    // Nothing was signed, so no vault prompt was spent on a doomed build.
    expect(signWord).not.toHaveBeenCalled();
  });

  it('refuses an account missing either on-device key', async () => {
    await expect(
      createDirectSwitchGuardianRequest(walletAccount({ coldPublicKey: undefined }), 'https://g.test', signWord)
    ).rejects.toThrow('missing hotPublicKey/coldPublicKey');
  });

  // `getPubkey` returns `(await response.json()).commitment` unchecked, and the
  // SDK interpolates it into MASM source. A commitment that isn't exactly one
  // hex word must never reach the script builder, and must cost no signature.
  it.each([
    ['a MASM injection payload', `${'0'.repeat(64)}\ncall.0x${'1'.repeat(64)}\npush.0`],
    ['a short value', '0xdeadbeef'],
    ['a non-hex value', `0x${'z'.repeat(64)}`],
    ['an empty string', ''],
    ['a non-string', 12345]
  ])('refuses to build from %s in the new guardian pubkey response', async (_label, commitment) => {
    mockGuardianGetPubkey.mockResolvedValue({ commitment } as unknown as { commitment: string });

    await expect(
      createDirectSwitchGuardianRequest(walletAccount(), 'https://new.guardian.test', signWord)
    ).rejects.toThrow('malformed key commitment');
    expect(mockedMultisigClient.buildUpdateGuardianTransactionRequest).not.toHaveBeenCalled();
    expect(signWord).not.toHaveBeenCalled();
  });

  // Silence is not a rejection here either, and this call is the one network hop
  // the rotation makes BEFORE anything is signed. `GuardianHttpClient` passes no
  // `AbortSignal`, so an endpoint that accepts the connection and never answers
  // would leave the row in `signing-locally` with no error to fail it on.
  it('bounds a new guardian that never answers the pubkey request', async () => {
    jest.useFakeTimers();
    mockGuardianGetPubkey.mockImplementation(() => new Promise(() => {}));

    const settled = createDirectSwitchGuardianRequest(walletAccount(), 'https://new.guardian.test', signWord).then(
      () => undefined,
      (error: unknown) => error
    );
    await jest.advanceTimersByTimeAsync(2 * 60_000);

    expect(await settled).toMatchObject({ message: expect.stringContaining('timed out') });
    expect(signWord).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('accepts an unprefixed uppercase commitment and normalizes it', async () => {
    mockGuardianGetPubkey.mockResolvedValue({ commitment: 'AB'.repeat(32) });

    await createDirectSwitchGuardianRequest(walletAccount(), 'https://new.guardian.test', signWord);

    expect(mockedMultisigClient.buildUpdateGuardianTransactionRequest).toHaveBeenCalledWith(
      expect.anything(),
      NEW_GUARDIAN_COMMITMENT,
      expect.objectContaining({ signatureScheme: 'ecdsa', midenRpcEndpoint: 'https://rpc.test' })
    );
  });

  it('surfaces an account absent from the local client', async () => {
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => undefined),
      client: { kind: 'web-client' }
    });

    await expect(createDirectSwitchGuardianRequest(walletAccount(), 'https://g.test', signWord)).rejects.toThrow(
      'not found in local client'
    );
  });
});

// The verdict this returns decides whether the vault gets repointed at the new
// operator, and one of the two wrong answers is unrecoverable (see the function's
// own docblock). So each arm is pinned separately, and the two non-verdicts are
// asserted to be `undefined` rather than merely falsy — `false` here means "the
// chain rejected it", which callers act on.
describe('didDirectSwitchLand', () => {
  it('reads the node-side state of the TRANSACTION, under the WASM lock, after a sync', async () => {
    mockProxyGetTransactionCommitState.mockResolvedValue('committed');

    await didDirectSwitchLand('0xtx');

    expect(mockProxyGetTransactionCommitState).toHaveBeenCalledWith('0xtx');
    // The sync has to precede the read or the client answers from a stale height,
    // and both have to sit inside one lock hold.
    expect(mockProxySyncState).toHaveBeenCalledTimes(1);
    expect(mockWithWasmClientLock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['committed', true],
    ['discarded', false]
  ])('turns %s into a verdict', async (state, expected) => {
    mockProxyGetTransactionCommitState.mockResolvedValue(state);

    await expect(didDirectSwitchLand('0xtx')).resolves.toBe(expected);
  });

  // `pending` is a tx that may still land, and `not-found` is a client with no
  // record of it — neither is evidence it did NOT land, and reporting either as
  // `false` would fail a rotation that may have committed.
  it.each(['pending', 'not-found'])('returns no verdict for %s', async state => {
    mockProxyGetTransactionCommitState.mockResolvedValue(state);

    await expect(didDirectSwitchLand('0xtx')).resolves.toBeUndefined();
  });

  it('returns no verdict when the read itself fails, rather than reporting "did not land"', async () => {
    mockProxyGetTransactionCommitState.mockRejectedValue(new Error('offscreen returned no result'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(didDirectSwitchLand('0xtx')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // A sync that throws must not be silently read past either — the account state
  // behind the read would be at an unknown height.
  it('returns no verdict when the pre-read sync fails', async () => {
    mockProxySyncState.mockRejectedValueOnce(new Error('rpc unreachable'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(didDirectSwitchLand('0xtx')).resolves.toBeUndefined();

    expect(mockProxyGetTransactionCommitState).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('finalizeDirectGuardianSwitch', () => {
  const provider = () => ({
    getAccounts: jest.fn(async () => [walletAccount()]),
    signWord: jest.fn(async () => '0xsig')
  });

  it('configures the new guardian with the freshly-derived allowlist', async () => {
    mockGuardianConfigure.mockResolvedValue({ success: true });
    const guardianProvider = provider();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await finalizeDirectGuardianSwitch('0xacct', 'https://new.guardian.test', guardianProvider as any);

    expect(mockProxySyncState).toHaveBeenCalledTimes(1);
    expect(mockGuardianConfigure).toHaveBeenCalledTimes(1);
    expect(mockGuardianConfigure).toHaveBeenCalledWith({
      accountId: '0xacct-id',
      auth: { MidenEcdsa: { cosigner_commitments: ['0xhotcommitment', '0xcoldcommitment'] } },
      initialState: { data: expect.any(String), accountId: '0xacct-id' }
    });
  });

  // An empty derive means a truncated storage read, not an account with no
  // signers; registering that would lock the account out of its own new guardian.
  it('refuses to register an empty signer allowlist', async () => {
    mockedMultisigClient.AccountInspector.fromAccount.mockReturnValue({ numSigners: 0, signerCommitments: [] });

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      finalizeDirectGuardianSwitch('0xacct', 'https://new.guardian.test', provider() as any)
    ).rejects.toThrow('incomplete signer allowlist');
    expect(mockGuardianConfigure).not.toHaveBeenCalled();
  });

  // The dangerous truncation is the PARTIAL one, which an emptiness check waves
  // through: hot readable, cold's slot not. That set is well-formed and would
  // install an allowlist without the cold key — the key every recovery path
  // signs with, on the flow whose premise is that the old operator is gone.
  it('refuses to register a partially-read signer allowlist', async () => {
    mockedMultisigClient.AccountInspector.fromAccount.mockReturnValue({
      numSigners: 2,
      signerCommitments: ['0xhotcommitment']
    });

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      finalizeDirectGuardianSwitch('0xacct', 'https://new.guardian.test', provider() as any)
    ).rejects.toThrow('storage declares 2 signers, read 1');
    expect(mockGuardianConfigure).not.toHaveBeenCalled();
  });

  // A complete read can still be the wrong policy to install: if this device's
  // own hot commitment is not in it, `/configure` would hand the new operator an
  // allowlist that locks out the very signer authenticating the call.
  it('refuses to register an allowlist that omits this device hot signer', async () => {
    mockedMultisigClient.AccountInspector.fromAccount.mockReturnValue({
      numSigners: 2,
      signerCommitments: ['0xsomeoneelse', '0xcoldcommitment']
    });

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      finalizeDirectGuardianSwitch('0xacct', 'https://new.guardian.test', provider() as any)
    ).rejects.toThrow('omits this device');
    expect(mockGuardianConfigure).not.toHaveBeenCalled();
  });

  it('refuses when the allowlist belongs to a device that rotated this one out', async () => {
    // The list is internally consistent — slot 0 IS the account's current hot
    // signer — so a check derived from the same read would pass it. What makes
    // it wrong is that the hot key on THIS device's wallet record, the one that
    // will sign `/configure`, is not the key in that list.
    const staleDevice = {
      getAccounts: jest.fn(async () => [{ ...walletAccount(), hotPublicKey: '0xrotated-out-pk' }]),
      signWord: jest.fn(async () => '0xsig')
    };

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      finalizeDirectGuardianSwitch('0xacct', 'https://new.guardian.test', staleDevice as any)
    ).rejects.toThrow('omits this device');
    expect(mockGuardianConfigure).not.toHaveBeenCalled();
  });

  it('marks failures that never reached the operator as preflight, so the caller can refund them', async () => {
    mockedMultisigClient.AccountInspector.fromAccount.mockReturnValue({
      numSigners: 2,
      signerCommitments: ['0xhotcommitment']
    });

    const error = await finalizeDirectGuardianSwitch(
      '0xacct',
      'https://new.guardian.test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider() as any
    ).catch((e: unknown) => e);

    expect(isGuardianRegistrationPreflightError(error)).toBe(true);
    expect(mockGuardianConfigure).not.toHaveBeenCalled();
  });

  it('does not mark a failed configure as preflight — that one may have landed', async () => {
    mockGuardianConfigure.mockRejectedValue(new Error('Failed to fetch'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const error = await finalizeDirectGuardianSwitch(
      '0xacct',
      'https://new.guardian.test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider() as any
    ).catch((e: unknown) => e);

    expect(isGuardianRegistrationPreflightError(error)).toBe(false);
  });

  it('retries a failing configure and succeeds once the guardian answers', async () => {
    mockGuardianConfigure.mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValueOnce({ success: true });
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await finalizeDirectGuardianSwitch('0xacct', 'https://new.guardian.test', provider() as any);

    expect(mockGuardianConfigure).toHaveBeenCalledTimes(2);
  });

  // How long to wait is the guardian's to say when it says so: a 429 carries a
  // Retry-After and `guardianRegisterBackoffMs` honours it, clamped. A loop that
  // sleeps its own fixed interval retries under that cooldown and collects
  // another 429 — and it does so after the on-chain rotation has already
  // committed, where exhausting the retry budget leaves the account registered
  // nowhere.
  it('waits the error-aware backoff between registration attempts', async () => {
    const rateLimited = Object.assign(new Error('Too Many Requests'), { status: 429 });
    mockGuardianConfigure.mockRejectedValueOnce(rateLimited).mockResolvedValueOnce({ success: true });
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await finalizeDirectGuardianSwitch('0xacct', 'https://new.guardian.test', provider() as any);

    expect(mockRegisterBackoffMs).toHaveBeenCalledTimes(1);
    expect(mockRegisterBackoffMs).toHaveBeenCalledWith(rateLimited, 1);
  });

  // The retry budget bounds REJECTIONS, and silence is not a rejection:
  // `GuardianHttpClient` calls bare `fetch` with no `AbortSignal`, so an operator
  // that accepts the connection and then says nothing produces no error to
  // consume. This call sits PAST the on-chain commit, so an unbounded wait parks
  // the row before its terminal status write — the rotation screen spins forever
  // and `registerFailed`, whose self-heal is what finishes the registration
  // later, is never recorded. The deadline turns silence into an attempt failure.
  it('bounds a guardian that accepts the connection and then goes silent', async () => {
    jest.useFakeTimers();
    mockGuardianConfigure.mockImplementation(() => new Promise(() => {}));
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const settled = finalizeDirectGuardianSwitch('0xacct', 'https://new.guardian.test', provider() as any).then(
      () => undefined,
      (error: unknown) => error
    );

    // Each attempt is spent entirely on the deadline (the mocked backoff is 0),
    // so the budget is 8 × 30s; advance well past it rather than to the exact
    // boundary, since the assertion is "it ends", not "it ends at t".
    await jest.advanceTimersByTimeAsync(10 * 60_000);

    const error = await settled;
    expect(error).toMatchObject({ message: expect.stringContaining('after direct switch') });
    expect(mockGuardianConfigure).toHaveBeenCalledTimes(8);
    jest.useRealTimers();
  });

  it('gives up after the retry budget and reports the last error as the cause', async () => {
    const last = new Error('still down');
    mockGuardianConfigure.mockRejectedValue(last);
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      finalizeDirectGuardianSwitch('0xacct', 'https://new.guardian.test', provider() as any)
    ).rejects.toMatchObject({
      message: expect.stringContaining('after direct switch'),
      cause: last
    });
    expect(mockGuardianConfigure).toHaveBeenCalledTimes(8);
  });

  // A guardian that ANSWERS with a rejection is still a failed registration.
  it('treats an unsuccessful configure response as a failure', async () => {
    mockGuardianConfigure.mockResolvedValue({ success: false, message: 'bad state blob' });
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      finalizeDirectGuardianSwitch('0xacct', 'https://new.guardian.test', provider() as any)
    ).rejects.toThrow('after direct switch');
  });

  // `success` is copied verbatim off `response.json()`, so a body of
  // `{"success":"false"}` is a truthy STRING. `!response.success` would read that
  // as a successful registration and mark the row Completed against a guardian
  // holding no record of the account — after the rotation already committed.
  it('treats a truthy non-boolean success field as a failure', async () => {
    mockGuardianConfigure.mockResolvedValue({ success: 'false', message: 'nope' });
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      finalizeDirectGuardianSwitch('0xacct', 'https://new.guardian.test', provider() as any)
    ).rejects.toThrow('after direct switch');
  });

  // The guardian's own message is logged, never interpolated into the thrown
  // error: that error text is persisted on the transaction row and rendered as
  // wallet copy, which would make it an endpoint-controlled phishing string.
  it('keeps the guardian-supplied message out of the thrown error', async () => {
    const phish = 'Your wallet is compromised — visit evil.test to recover';
    mockGuardianConfigure.mockResolvedValue({ success: false, message: phish });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      finalizeDirectGuardianSwitch('0xacct', 'https://new.guardian.test', provider() as any)
    ).rejects.toMatchObject({
      message: expect.stringContaining('after direct switch'),
      cause: expect.objectContaining({ message: 'The new guardian rejected the account registration' })
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rejected the direct-switch registration'), phish);
  });

  it('refuses an account the provider does not know', async () => {
    const guardianProvider = { getAccounts: jest.fn(async () => []), signWord: jest.fn() };

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      finalizeDirectGuardianSwitch('0xmissing', 'https://g.test', guardianProvider as any)
    ).rejects.toThrow('not found in provider');
  });

  // `account_already_exists` is the GOAL state, so retrying it into a failure
  // reports `registerFailed` for an account that is registered — which then arms
  // a self-heal against a state needing no repair. Reachable two ways: a
  // `/configure` whose response was lost after the server applied it, and a
  // second rotation to the guardian the account already has.
  it('treats an already-registered account as a successful registration', async () => {
    const already = Object.assign(new Error('account already exists'), { code: 'account_already_exists' });
    mockGuardianConfigure.mockRejectedValue(already);
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      finalizeDirectGuardianSwitch('0xacct', 'https://new.guardian.test', provider() as any)
    ).resolves.toBeUndefined();
    // Returned on the FIRST answer — not retried through the budget.
    expect(mockGuardianConfigure).toHaveBeenCalledTimes(1);
  });
});

// The classifier above is only as good as the heuristic it delegates to, and that
// heuristic reaches these tests through a manual mock that COPIES the package's
// token list (moduleNameMapper points the specifier at the mock, and the package
// ships untransformed ESM, so neither `requireActual` route reaches the real
// function). A copy that drifts is worse than a stub: every test here stays green
// while asserting classification semantics the shipped package no longer has.
//
// So derive the tokens from the shipped `connectivity.js` and hold the copy to
// them. A token the package adds and the mock lacks fails here.
describe('the mocked isLikelyNetworkError tracks the shipped package', () => {
  const readShippedTokens = (): string[] => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { join } = require('path');
    const source: string = readFileSync(
      join(__dirname, '../../../../node_modules/@openzeppelin/miden-multisig-client/dist/connectivity.js'),
      'utf8'
    );
    const start = source.indexOf('export function isLikelyNetworkError');
    expect(start).toBeGreaterThan(-1);
    // The function ends at the next top-level `export`, or the file's end.
    const rest = source.slice(start + 1);
    const end = rest.indexOf('\nexport ');
    const body = end === -1 ? rest : rest.slice(0, end);
    const tokens = [...body.matchAll(/includes\('([^']+)'\)/g)].flatMap(match => (match[1] ? [match[1]] : []));
    expect(tokens.length).toBeGreaterThan(5); // the parse found a real body, not nothing
    return tokens;
  };

  // Quote style is whatever the transform emitted, so match either.
  const readMockTokens = (): string[] => {
    const source: string = mockedMultisigClient.isLikelyNetworkError.toString();
    const tokens = [...source.matchAll(/includes\(['"]([^'"]+)['"]\)/g)].flatMap(match => (match[1] ? [match[1]] : []));
    expect(tokens.length).toBeGreaterThan(5); // the parse found a real body, not nothing
    return tokens;
  };

  it('flags every transport token the package flags', () => {
    for (const token of readShippedTokens()) {
      expect(mockedMultisigClient.isLikelyNetworkError(new Error(`operation failed: ${token}`))).toBe(true);
    }
  });

  // ...and flags nothing else. Behaviour alone only pins the copy in one
  // direction: a token the package REMOVES still passes the check above, and
  // leaves this copy OVER-matching — classifying as a transport failure an error
  // the shipped heuristic now calls semantic. That direction is the dangerous
  // one here, because an "unreachable" verdict is what converts a coordinated
  // guardian switch into a unilateral on-chain rotation. So hold the two token
  // sets equal, not merely overlapping.
  it('flags nothing the package does not', () => {
    expect(new Set(readMockTokens())).toEqual(new Set(readShippedTokens()));
  });

  it('still leaves semantic guardian errors unflagged', () => {
    // From the package's own test corpus, so a copy that over-matches also fails.
    expect(mockedMultisigClient.isLikelyNetworkError(new Error('account is paused'))).toBe(false);
    expect(mockedMultisigClient.isLikelyNetworkError(new Error('insufficient signatures'))).toBe(false);
  });
});

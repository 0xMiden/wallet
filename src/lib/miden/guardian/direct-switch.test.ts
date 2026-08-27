import { OperationAbortedError } from 'lib/miden/back/offscreen-codec';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import type { WalletAccount } from 'lib/shared/types';

import {
  createDirectSwitchGuardianRequest,
  finalizeDirectGuardianSwitch,
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
jest.mock('../back/miden-client-proxy', () => ({
  midenClientProxy: {
    syncState: () => mockProxySyncState(),
    getAccount: (...args: unknown[]) => mockProxyGetAccount(...args)
  }
}));

const mockGetSignerDetails = jest.fn();
jest.mock('./account', () => ({
  getSignerDetailsFromAccount: (...args: unknown[]) => mockGetSignerDetails(...args)
}));

jest.mock('./native-http', () => ({ registerGuardianOrigin: jest.fn() }));

// Zero backoff so the retry loop runs at test speed; the schedule itself is
// covered by `serialize`'s own suite.
jest.mock('./serialize', () => ({ guardianRegisterBackoffMs: () => 0 }));

jest.mock('./signer', () => ({ WalletSigner: class {} }));

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveRpcUrl: () => 'https://rpc.test',
  getEffectiveNetworkName: () => 'devnet'
}));

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  AdviceMap: class {
    readonly entries: string[] = [];
    insert(key: { hex: string }) {
      this.entries.push(key.hex);
    }
  },
  FeltArray: class {
    constructor(readonly felts: unknown[]) {}
  },
  Poseidon2: { hashElements: (felts: { felts: string[] }) => ({ hex: felts.felts.join('|') }) },
  Signature: { deserialize: (bytes: Uint8Array) => ({ toPreparedSignature: () => [...bytes] }) },
  Word: { fromHex: (hex: string) => ({ hex, toFelts: () => [hex] }) }
}));

const mockGuardianGetPubkey = jest.fn(async () => ({ commitment: '0xnew-guardian' }));
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
  mockGuardianGetPubkey.mockResolvedValue({ commitment: '0xnew-guardian' });
  mockedMultisigClient.AccountInspector.fromAccount.mockReturnValue({
    signerCommitments: ['0xhot', '0xcold']
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
});

describe('createDirectSwitchGuardianRequest', () => {
  // Even-length hex: `hexToBytes` rejects an odd-length signature outright.
  const signWord = jest.fn(async () => '0xabcd12');

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
      auth: { MidenEcdsa: { cosigner_commitments: ['0xhot', '0xcold'] } },
      initialState: { data: expect.any(String), accountId: '0xacct-id' }
    });
  });

  // An empty derive means a truncated storage read, not an account with no
  // signers; registering that would lock the account out of its own new guardian.
  it('refuses to register an empty signer allowlist', async () => {
    mockedMultisigClient.AccountInspector.fromAccount.mockReturnValue({ signerCommitments: [] });

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      finalizeDirectGuardianSwitch('0xacct', 'https://new.guardian.test', provider() as any)
    ).rejects.toThrow('empty signer allowlist');
    expect(mockGuardianConfigure).not.toHaveBeenCalled();
  });

  it('retries a failing configure and succeeds once the guardian answers', async () => {
    mockGuardianConfigure.mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValueOnce({ success: true });
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await finalizeDirectGuardianSwitch('0xacct', 'https://new.guardian.test', provider() as any);

    expect(mockGuardianConfigure).toHaveBeenCalledTimes(2);
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

  it('refuses an account the provider does not know', async () => {
    const guardianProvider = { getAccounts: jest.fn(async () => []), signWord: jest.fn() };

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      finalizeDirectGuardianSwitch('0xmissing', 'https://g.test', guardianProvider as any)
    ).rejects.toThrow('not found in provider');
  });
});

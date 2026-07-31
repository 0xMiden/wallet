/**
 * Guardian auto-detection probe (issue #418).
 *
 * The behaviour that matters here is the ranking rule: after a guardian switch
 * BOTH the old and the new operator answer the lookup, and only the account
 * nonce distinguishes the current state from the stale one. Picking the wrong
 * one silently recovers a wallet against an operator that will never co-sign
 * again, so "nonce 3 vs nonce 9 → 9 wins" is the core assertion below.
 *
 * `@openzeppelin/guardian-client`, `@openzeppelin/miden-multisig-client` and
 * the WASM SDK are replaced with explicit `jest.mock` factories (same style as
 * `operator-map.test.ts`) so each test can script per-endpoint responses.
 * `jest.mock` calls are hoisted above the imports by the transform, so
 * declaring them after the import block keeps `import/first` happy; the
 * `mock`-prefixed module-scope names are what the hoister allows factories to
 * close over.
 */
import { registerGuardianOrigin } from 'lib/miden/guardian/native-http';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';

import {
  classifyProbeError,
  compareMatches,
  decodeMaxNonce,
  discoverGuardianForSeed,
  GuardianProbeTimeoutError,
  selectBest,
  withTimeout,
  type GuardianProbeMatch
} from './discover';

const OZ = 'https://guardian.openzeppelin.com';
const GATEWAY = 'https://miden-guardian.dev.eu-north-3.gateway.fm';
const LAMBDA = 'https://miden-guardian.lambdaclass.com';

/**
 * Scripted guardian backend, keyed by endpoint. `accounts` answers the lookup
 * at HD index 0; `accountsByIndex` scripts deeper indices. `nonces`/`updatedAt`
 * drive the fake state objects, `failWith` makes the endpoint reject and
 * `delayMs` makes it slow.
 */
interface FakeOperator {
  accounts?: string[];
  accountsByIndex?: Record<number, string[]>;
  nonces?: Record<string, bigint>;
  updatedAt?: Record<string, string>;
  failWith?: Error;
  /** Makes getState reject while the lookup still succeeds. */
  stateFailWith?: Error;
  /** Makes getState reject the first N calls, then succeed — exercises the retry. */
  stateFailFirst?: number;
  delayMs?: number;
  /** Internal: how many times getState has been called on this operator. */
  stateCalls?: number;
}

const mockBackend = new Map<string, FakeOperator>();
/** Every AuthSecretKey / EcdsaSigner instance a probe created (aliasing guard). */
const mockSecretKeys: object[] = [];
const mockSigners: object[] = [];
/** Cold-seed HD indices the probe asked for, in order. */
const mockSeedsRequested: number[] = [];
const mockDeserialize = jest.fn();

jest.mock('lib/miden/guardian/native-http', () => ({
  registerGuardianOrigin: jest.fn()
}));

jest.mock('@openzeppelin/miden-multisig-client', () => ({
  EcdsaSigner: class {
    readonly commitment: string;
    constructor(secretKey: { commitmentHex: string }) {
      this.commitment = secretKey.commitmentHex;
      mockSigners.push(this);
    }
  }
}));

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  AuthSecretKey: {
    // The fake cold seed encodes the HD index in byte 0, so the commitment
    // carries it through to the lookup call.
    ecdsaWithRNG: (seed: Uint8Array) => {
      const key = { commitmentHex: `commitment-${seed[0]}`, free: jest.fn() };
      mockSecretKeys.push(key);
      return key;
    }
  },
  // Indirection, not a direct reference: the factory runs before the module
  // body initializes `mockDeserialize`.
  Account: { deserialize: (bytes: Uint8Array) => mockDeserialize(bytes) }
}));

jest.mock('@openzeppelin/guardian-client', () => ({
  GuardianHttpClient: class {
    constructor(public readonly url: string) {}
    setSigner(_signer: { commitment: string }) {}
    async lookupAccountByKeyCommitment(commitmentHex: string) {
      const operator = mockBackend.get(this.url);
      if (!operator) return { accounts: [] };
      if (operator.failWith) throw operator.failWith;
      if (operator.delayMs) await new Promise(resolve => setTimeout(resolve, operator.delayMs));
      const hdIndex = Number(commitmentHex.replace('commitment-', ''));
      const ids = operator.accountsByIndex
        ? (operator.accountsByIndex[hdIndex] ?? [])
        : hdIndex === 0
          ? (operator.accounts ?? [])
          : [];
      return { accounts: ids.map(accountId => ({ accountId })) };
    }
    async getState(accountId: string) {
      const operator = mockBackend.get(this.url)!;
      operator.stateCalls = (operator.stateCalls ?? 0) + 1;
      if (operator.stateFailWith) throw operator.stateFailWith;
      if (operator.stateFailFirst && operator.stateCalls <= operator.stateFailFirst) {
        throw new Error('transient state failure');
      }
      return {
        accountId,
        commitment: `state-${accountId}`,
        // `data` carries the account id so the Account.deserialize stub can
        // look the scripted nonce back up.
        stateJson: { data: Buffer.from(accountId).toString('base64') },
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: operator.updatedAt?.[accountId] ?? '2024-01-01T00:00:00.000Z'
      };
    }
  }
}));

/** Cold-seed deriver whose first byte is the HD index — the fakes key off it. */
const fakeDeriveSeed = (hdIndex: number): Uint8Array => {
  mockSeedsRequested.push(hdIndex);
  return new Uint8Array([hdIndex, 1, 2, 3]);
};

/** Resolve the scripted nonce for whatever account a state blob names. */
function scriptNonces() {
  mockDeserialize.mockImplementation((bytes: Uint8Array) => {
    const accountId = Buffer.from(bytes).toString('utf8');
    let nonce = 0n;
    for (const operator of mockBackend.values()) {
      const scripted = operator.nonces?.[accountId];
      if (scripted !== undefined) nonce = scripted;
    }
    return { nonce: () => ({ asInt: () => nonce }), free: jest.fn() };
  });
}

const testnet = { network: MIDEN_NETWORK_NAME.TESTNET };

beforeEach(() => {
  mockBackend.clear();
  mockSecretKeys.length = 0;
  mockSigners.length = 0;
  mockSeedsRequested.length = 0;
  jest.clearAllMocks();
  scriptNonces();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('discoverGuardianForSeed', () => {
  it('picks the operator holding the highest nonce when several answer', async () => {
    mockBackend.set(OZ, { accounts: ['acct-old'], nonces: { 'acct-old': 3n } });
    mockBackend.set(GATEWAY, { accounts: ['acct-new'], nonces: { 'acct-new': 9n } });

    const result = await discoverGuardianForSeed(fakeDeriveSeed, testnet);

    expect(result.best?.endpoint).toBe(GATEWAY);
    expect(result.best?.nonce).toBe(9n);
    expect(result.best?.option?.id).toBe('gateway');
    expect(result.matches.map(match => match.endpoint)).toEqual([GATEWAY, OZ]);
    expect(result.failures).toEqual([]);
  });

  it('returns the single operator that answers, with its account ids', async () => {
    mockBackend.set(LAMBDA, { accounts: ['acct-1', 'acct-2'], nonces: { 'acct-1': 4n, 'acct-2': 7n } });

    const result = await discoverGuardianForSeed(fakeDeriveSeed, testnet);

    expect(result.best?.endpoint).toBe(LAMBDA);
    expect(result.best?.accountIds).toEqual(['acct-1', 'acct-2']);
    expect(result.best?.nonce).toBe(7n);
    expect(result.matches).toHaveLength(1);
  });

  it('breaks an exact nonce tie on the newest updatedAt', async () => {
    mockBackend.set(OZ, {
      accounts: ['acct-a'],
      nonces: { 'acct-a': 5n },
      updatedAt: { 'acct-a': '2024-01-01T00:00:00.000Z' }
    });
    mockBackend.set(GATEWAY, {
      accounts: ['acct-b'],
      nonces: { 'acct-b': 5n },
      updatedAt: { 'acct-b': '2024-06-01T00:00:00.000Z' }
    });

    const result = await discoverGuardianForSeed(fakeDeriveSeed, testnet);

    expect(result.best?.endpoint).toBe(GATEWAY);
  });

  it('falls back to GUARDIAN_OPTIONS order when nonce and updatedAt are identical', async () => {
    const updatedAt = { 'acct-a': '2024-06-01T00:00:00.000Z', 'acct-b': '2024-06-01T00:00:00.000Z' };
    mockBackend.set(GATEWAY, { accounts: ['acct-b'], nonces: { 'acct-b': 5n }, updatedAt });
    mockBackend.set(OZ, { accounts: ['acct-a'], nonces: { 'acct-a': 5n }, updatedAt });

    const result = await discoverGuardianForSeed(fakeDeriveSeed, testnet);

    // OpenZeppelin is first in GUARDIAN_OPTIONS, so it wins a total tie.
    expect(result.best?.endpoint).toBe(OZ);
  });

  it('still detects a guardian when another operator is unreachable, and records the failure', async () => {
    mockBackend.set(OZ, { failWith: new Error('network unreachable') });
    mockBackend.set(LAMBDA, { accounts: ['acct-1'], nonces: { 'acct-1': 2n } });

    const result = await discoverGuardianForSeed(fakeDeriveSeed, testnet);

    expect(result.best?.endpoint).toBe(LAMBDA);
    expect(result.failures).toEqual([{ endpoint: OZ, reason: 'network', message: 'network unreachable' }]);
  });

  it('records one failure per endpoint, not one per HD index', async () => {
    mockBackend.set(OZ, { failWith: new Error('boom') });

    const result = await discoverGuardianForSeed(fakeDeriveSeed, testnet);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toBe('unknown');
  });

  it('resolves with no best and does not throw when no operator holds the account', async () => {
    const result = await discoverGuardianForSeed(fakeDeriveSeed, testnet);

    expect(result.best).toBeUndefined();
    expect(result.matches).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.probedEndpoints.length).toBeGreaterThan(1);
  });

  it('finds an account at a deeper HD index when maxHdIndex is raised', async () => {
    mockBackend.set(GATEWAY, { accountsByIndex: { 2: ['acct-deep'] }, nonces: { 'acct-deep': 1n } });

    const result = await discoverGuardianForSeed(fakeDeriveSeed, { ...testnet, maxHdIndex: 3 });

    expect(result.best?.endpoint).toBe(GATEWAY);
    expect(result.best?.hdIndices).toEqual([2]);
  });

  it('probes only HD index 0 by default and honours maxHdIndex', async () => {
    await discoverGuardianForSeed(fakeDeriveSeed, { ...testnet, endpoints: [OZ] });
    expect(mockSeedsRequested).toEqual([0]);

    mockSeedsRequested.length = 0;
    await discoverGuardianForSeed(fakeDeriveSeed, { ...testnet, endpoints: [OZ], maxHdIndex: 3 });
    expect(mockSeedsRequested).toEqual([0, 1, 2]);
  });

  it('keeps a lone lookup match even when the follow-up getState fails, with an unknown nonce', async () => {
    mockBackend.set(OZ, { accounts: ['acct-1'], stateFailWith: new Error('state endpoint down') });

    const result = await discoverGuardianForSeed(fakeDeriveSeed, testnet);

    // The lookup proved OZ holds the account and nothing competes with it, so it
    // is still selected — losing the state only leaves the nonce unknown (not 0n).
    expect(result.best?.endpoint).toBe(OZ);
    expect(result.best?.accountIds).toEqual(['acct-1']);
    expect(result.best?.nonce).toBeUndefined();
    expect(result.best?.updatedAt).toBeUndefined();
  });

  it('retries getState once, so a transient state failure still yields the real nonce', async () => {
    // Fails the first getState, succeeds on the retry.
    mockBackend.set(OZ, { accounts: ['acct-1'], nonces: { 'acct-1': 6n }, stateFailFirst: 1 });

    const result = await discoverGuardianForSeed(fakeDeriveSeed, testnet);

    expect(result.best?.endpoint).toBe(OZ);
    expect(result.best?.nonce).toBe(6n);
    expect(mockBackend.get(OZ)?.stateCalls).toBe(2);
  });

  it('does NOT pick a stale operator over the current one when the current getState keeps failing', async () => {
    // Post-switch: stale OZ answers getState (nonce 3); current GATEWAY holds the
    // higher state but its getState never loads. A 0n-for-unknown ranking would
    // silently pick the stale OZ — instead detection refuses (best undefined) and
    // the UI falls back to the manual picker.
    mockBackend.set(OZ, { accounts: ['acct-old'], nonces: { 'acct-old': 3n } });
    mockBackend.set(GATEWAY, { accounts: ['acct-new'], stateFailWith: new Error('state endpoint down') });

    const result = await discoverGuardianForSeed(fakeDeriveSeed, testnet);

    expect(result.best).toBeUndefined();
    expect(result.matches.map(match => match.endpoint).sort()).toEqual([GATEWAY, OZ].sort());
    // The retry was actually attempted before giving up.
    expect(mockBackend.get(GATEWAY)?.stateCalls).toBe(2);
  });

  it('treats an undecodable account state as an unknown nonce, still detecting a lone operator', async () => {
    mockBackend.set(OZ, { accounts: ['acct-broken'] });
    mockDeserialize.mockImplementation(() => {
      throw new Error('bad state blob');
    });

    const result = await discoverGuardianForSeed(fakeDeriveSeed, testnet);

    expect(result.best?.endpoint).toBe(OZ);
    expect(result.best?.nonce).toBeUndefined();
  });

  it('returns no matches when aborted mid-probe', async () => {
    mockBackend.set(OZ, { accounts: ['acct-1'], nonces: { 'acct-1': 5n } });
    const controller = new AbortController();
    controller.abort();

    const result = await discoverGuardianForSeed(fakeDeriveSeed, { ...testnet, signal: controller.signal });

    expect(result.best).toBeUndefined();
    expect(result.matches).toEqual([]);
  });

  it('uses a distinct signer per task — never shares a WASM handle across concurrent lookups', async () => {
    mockBackend.set(OZ, { accounts: ['acct-1'], nonces: { 'acct-1': 1n } });

    await discoverGuardianForSeed(fakeDeriveSeed, { ...testnet, endpoints: [OZ, GATEWAY], maxHdIndex: 3 });

    // 2 endpoints × 3 HD indices = 6 independent AuthSecretKey/EcdsaSigner pairs.
    expect(mockSecretKeys).toHaveLength(6);
    expect(new Set(mockSecretKeys).size).toBe(6);
    expect(mockSigners).toHaveLength(6);
    expect(new Set(mockSigners).size).toBe(6);
  });

  it('frees every cold secret key it derives', async () => {
    await discoverGuardianForSeed(fakeDeriveSeed, { ...testnet, endpoints: [OZ], maxHdIndex: 3 });

    expect(mockSecretKeys).toHaveLength(3);
    for (const key of mockSecretKeys) {
      expect(jest.mocked(Reflect.get(key, 'free'))).toHaveBeenCalled();
    }
  });

  it('registers every probed origin for the mobile CORS bypass', async () => {
    await discoverGuardianForSeed(fakeDeriveSeed, { ...testnet, endpoints: [`${OZ}/`] });

    // Trailing slash stripped before registering / probing.
    expect(jest.mocked(registerGuardianOrigin)).toHaveBeenCalledWith(OZ);
  });

  it('probes only the single configured operator on devnet', async () => {
    const result = await discoverGuardianForSeed(fakeDeriveSeed, { network: MIDEN_NETWORK_NAME.DEVNET });

    expect(result.probedEndpoints).toEqual(['https://guardian-stg.openzeppelin.com']);
  });

  it('resolves a custom endpoint to its built-in operator when it is one', async () => {
    mockBackend.set(LAMBDA, { accounts: ['acct-1'], nonces: { 'acct-1': 1n } });

    const known = await discoverGuardianForSeed(fakeDeriveSeed, { ...testnet, endpoints: [LAMBDA] });
    expect(known.best?.option?.id).toBe('lambda-class');

    mockBackend.set('https://guardian.example.com', { accounts: ['acct-2'], nonces: { 'acct-2': 1n } });
    const custom = await discoverGuardianForSeed(fakeDeriveSeed, {
      ...testnet,
      endpoints: ['https://guardian.example.com']
    });
    expect(custom.best?.option).toBeUndefined();
  });

  it('classifies a slow operator as a timeout without failing the probe', async () => {
    mockBackend.set(OZ, { accounts: ['acct-slow'], delayMs: 60 });
    mockBackend.set(GATEWAY, { accounts: ['acct-fast'], nonces: { 'acct-fast': 1n } });

    const result = await discoverGuardianForSeed(fakeDeriveSeed, { ...testnet, timeoutMs: 5 });

    expect(result.failures[0]).toMatchObject({ endpoint: OZ, reason: 'timeout' });
    expect(result.best?.endpoint).toBe(GATEWAY);
  });
});

describe('withTimeout', () => {
  it('resolves when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'label')).resolves.toBe('ok');
  });

  it('propagates the original rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('nope')), 1000, 'label')).rejects.toThrow('nope');
  });

  it('rejects with GuardianProbeTimeoutError past the deadline', async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 5, 'guardian lookup')).rejects.toBeInstanceOf(GuardianProbeTimeoutError);
  });
});

describe('classifyProbeError', () => {
  it('classifies timeouts', () => {
    expect(classifyProbeError(new GuardianProbeTimeoutError('slow')).reason).toBe('timeout');
  });

  it('classifies 401/403 as auth', () => {
    expect(classifyProbeError(Object.assign(new Error('denied'), { status: 401 })).reason).toBe('auth');
    expect(classifyProbeError(Object.assign(new Error('denied'), { status: 403 })).reason).toBe('auth');
  });

  it('classifies network-ish messages', () => {
    expect(classifyProbeError(new Error('Failed to fetch')).reason).toBe('network');
    expect(classifyProbeError(new Error('CORS policy blocked')).reason).toBe('network');
  });

  it('falls back to unknown, including for non-Error throwables', () => {
    expect(classifyProbeError(new Error('teapot')).reason).toBe('unknown');
    expect(classifyProbeError('plain string')).toEqual({ reason: 'unknown', message: 'plain string' });
    expect(classifyProbeError(Object.assign(new Error('x'), { status: '500' })).reason).toBe('unknown');
    expect(classifyProbeError(null).reason).toBe('unknown');
  });
});

describe('decodeMaxNonce', () => {
  const state = (accountId: string, updatedAt = '2024-01-01T00:00:00.000Z') => ({
    accountId,
    commitment: 'c',
    stateJson: { data: Buffer.from(accountId).toString('base64') },
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt
  });

  it('returns the maximum nonce across states', () => {
    mockBackend.set(OZ, { nonces: { a: 2n, b: 11n } });
    scriptNonces();

    expect(decodeMaxNonce([state('a'), state('b')])).toBe(11n);
  });

  it('returns undefined (unknown) for an empty list', () => {
    expect(decodeMaxNonce([])).toBeUndefined();
  });

  it('survives a free() that throws', () => {
    mockDeserialize.mockImplementation(() => ({
      nonce: () => ({ asInt: () => 4n }),
      free: () => {
        throw new Error('already freed');
      }
    }));

    expect(decodeMaxNonce([state('a')])).toBe(4n);
  });
});

describe('compareMatches', () => {
  const match = (over: Partial<GuardianProbeMatch>): GuardianProbeMatch => ({
    endpoint: OZ,
    accountIds: [],
    hdIndices: [],
    nonce: 0n,
    ...over
  });

  it('ranks higher nonces first', () => {
    expect(compareMatches(match({ nonce: 9n }), match({ nonce: 3n }), [OZ])).toBeLessThan(0);
    expect(compareMatches(match({ nonce: 1n }), match({ nonce: 3n }), [OZ])).toBeGreaterThan(0);
  });

  it('ranks a match with a parseable updatedAt above one without', () => {
    const withDate = match({ endpoint: GATEWAY, updatedAt: '2024-01-01T00:00:00.000Z' });
    const withoutDate = match({ endpoint: OZ });

    expect(compareMatches(withDate, withoutDate, [OZ, GATEWAY])).toBeLessThan(0);
    expect(compareMatches(withoutDate, withDate, [OZ, GATEWAY])).toBeGreaterThan(0);
  });

  it('ignores unparseable updatedAt values and falls through to operator order', () => {
    const a = match({ endpoint: OZ, updatedAt: 'not-a-date' });
    const b = match({ endpoint: GATEWAY, updatedAt: 'also-not-a-date' });

    expect(compareMatches(a, b, [OZ, GATEWAY])).toBeLessThan(0);
  });

  it('ranks a known nonce above an unknown one, even a low known nonce', () => {
    const known = match({ endpoint: GATEWAY, nonce: 0n });
    const unknown = match({ endpoint: OZ, nonce: undefined });

    expect(compareMatches(known, unknown, [OZ, GATEWAY])).toBeLessThan(0);
    expect(compareMatches(unknown, known, [OZ, GATEWAY])).toBeGreaterThan(0);
  });
});

describe('selectBest', () => {
  const match = (over: Partial<GuardianProbeMatch>): GuardianProbeMatch => ({
    endpoint: OZ,
    accountIds: [],
    hdIndices: [],
    nonce: 0n,
    ...over
  });

  it('returns undefined for no matches', () => {
    expect(selectBest([])).toBeUndefined();
  });

  it('picks a lone match regardless of its nonce being unknown', () => {
    const only = match({ endpoint: LAMBDA, nonce: undefined });
    expect(selectBest([only])).toBe(only);
  });

  it('picks the top match when every competing nonce is known', () => {
    const top = match({ endpoint: GATEWAY, nonce: 9n });
    const other = match({ endpoint: OZ, nonce: 3n });
    expect(selectBest([top, other])).toBe(top);
  });

  it('refuses to auto-pick when several matches compete and any nonce is unknown', () => {
    const known = match({ endpoint: OZ, nonce: 3n });
    const unknown = match({ endpoint: GATEWAY, nonce: undefined });
    expect(selectBest([known, unknown])).toBeUndefined();
    expect(selectBest([unknown, known])).toBeUndefined();
  });
});

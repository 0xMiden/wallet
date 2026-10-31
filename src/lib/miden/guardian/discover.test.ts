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
import { MIDEN_NETWORK_ENDPOINTS, MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';
import { _resetGuardianRegistryForTest, setDocumentGuardians } from 'lib/miden-chain/guardian-registry';
import { __resetBackgroundTimeForTest, initBackgroundTimeTracking } from 'lib/mobile/background-time';
import { installHiddenDocument, type HiddenDocument } from 'lib/mobile/testing/hidden-document';

import {
  classifyProbeError,
  compareMatches,
  decodeMaxNonce,
  decodeStates,
  discoverGuardianForHotKey,
  discoverGuardianForSeed,
  GuardianProbeTimeoutError,
  holdsCurrentState,
  selectBest,
  withTimeout,
  type GuardianDiscoveryResult,
  type GuardianProbeMatch
} from './discover';

const OZ = 'https://guardian-testnet.openzeppelin.com';
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
  /** Commitment of the state this operator serves per account; defaults to `state-<accountId>`, the chain's default too. */
  stateCommitments?: Record<string, string>;
  updatedAt?: Record<string, string>;
  failWith?: Error;
  /** Makes getState reject while the lookup still succeeds. */
  stateFailWith?: Error;
  /** Makes getState reject the first N calls, then succeed — exercises the retry. */
  stateFailFirst?: number;
  /** Makes the lookup reject the first N calls, then succeed — exercises the lookup retry. */
  lookupFailFirst?: number;
  delayMs?: number;
  /** Internal: how many times getState has been called on this operator. */
  stateCalls?: number;
  /** Internal: how many times the lookup has been called on this operator. */
  lookupCalls?: number;
}

const mockBackend = new Map<string, FakeOperator>();
/** Every AuthSecretKey / EcdsaSigner instance a probe created (aliasing guard). */
const mockSecretKeys: object[] = [];
const mockSigners: object[] = [];
/** Cold-seed HD indices the probe asked for, in order. */
const mockSeedsRequested: number[] = [];
const mockDeserialize = jest.fn();
const mockAuthDeserialize = jest.fn();
/** The chain's tip commitment per account id; an account absent here is at `state-<accountId>`, the operators' default. */
const mockChainCommitments = new Map<string, string>();
/** Makes every chain read reject (a node that cannot be reached). */
let mockChainFailWith: Error | undefined;
/** Account ids the chain was asked about, in order. */
const mockChainReads: string[] = [];
/** The node URL each chain-read RpcClient was built on, in order. */
const mockRpcUrls: string[] = [];

// The chain comparison builds one standalone RpcClient; the SDK's WASM start is not under test.
jest.mock('lib/miden-chain/constants', () => ({
  ...jest.requireActual('lib/miden-chain/constants'),
  ensureSdkWasmReady: async () => {}
}));

// A release build's own network is testnet or devnet; mainnet is a stored choice.
let mockEffectiveNetwork: MIDEN_NETWORK_NAME = MIDEN_NETWORK_NAME.TESTNET;
/** The effective network's RPC URL, a custom override included. */
let mockEffectiveRpcUrl = 'https://rpc.custom.example';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveNetworkName: () => mockEffectiveNetwork,
  getEffectiveRpcUrl: () => mockEffectiveRpcUrl
}));

// The shared native-HTTP double records the probe each endpoint takes and its verdict.
jest.mock('lib/miden/guardian/native-http');
const { mockProbedEndpoints, mockProbeVerdicts, resetMockProbes } = jest.requireMock<
  typeof import('lib/miden/guardian/__mocks__/native-http')
>('lib/miden/guardian/native-http');

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
    },
    // Hot-key probe path (indirection: the factory runs before the module
    // body initializes `mockAuthDeserialize`).
    deserialize: (bytes: Uint8Array) => mockAuthDeserialize(bytes)
  },
  // Indirection, not a direct reference: the factory runs before the module
  // body initializes `mockDeserialize`.
  Account: { deserialize: (bytes: Uint8Array) => mockDeserialize(bytes) },
  // The probe prints an account id and parses it back for the chain read; the fakes keep it a plain string.
  AccountId: { fromHex: (hex: string) => hex },
  Endpoint: class {
    constructor(readonly url: string) {}
  },
  RpcClient: class {
    constructor(endpoint: { url: string }) {
      mockRpcUrls.push(endpoint.url);
    }
    async getAccountProof(accountId: string) {
      mockChainReads.push(accountId);
      if (mockChainFailWith) throw mockChainFailWith;
      const commitment = mockChainCommitments.get(accountId) ?? `state-${accountId}`;
      return { accountCommitment: () => ({ toHex: () => commitment }) };
    }
  }
}));

jest.mock('@openzeppelin/guardian-client', () => ({
  GuardianHttpClient: class {
    constructor(public readonly url: string) {}
    setSigner(_signer: { commitment: string }) {}
    async lookupAccountByKeyCommitment(commitmentHex: string) {
      const operator = mockBackend.get(this.url);
      if (!operator) return { accounts: [] };
      operator.lookupCalls = (operator.lookupCalls ?? 0) + 1;
      if (operator.failWith) throw operator.failWith;
      if (operator.lookupFailFirst && operator.lookupCalls <= operator.lookupFailFirst) {
        throw new Error('transient lookup failure');
      }
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
        // `data` carries the operator and the account id so the Account.deserialize
        // stub can look the scripted nonce and state commitment back up.
        stateJson: { data: Buffer.from(`${this.url}|${accountId}`).toString('base64') },
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: operator.updatedAt?.[accountId] ?? '2024-01-01T00:00:00.000Z'
      };
    }
  }
}));

/** Cold-seed deriver whose first byte is the HD index - the fakes key off it. */
const fakeDeriveSeed = (hdIndex: number): Uint8Array => {
  mockSeedsRequested.push(hdIndex);
  return new Uint8Array([hdIndex, 1, 2, 3]);
};

/**
 * Resolve the scripted nonce and state commitment for whatever account a state
 * blob names. A blob from the fake guardian names its operator too (`<url>|<id>`),
 * so two operators can serve different states of one account; a bare id (the
 * decode unit tests) reads every operator's script.
 */
function scriptNonces() {
  mockDeserialize.mockImplementation((bytes: Uint8Array) => {
    const [first, second] = Buffer.from(bytes).toString('utf8').split('|');
    const accountId = second ?? first!;
    const operators = second === undefined ? Array.from(mockBackend.values()) : [mockBackend.get(first!)];
    let nonce = 0n;
    let commitment = `state-${accountId}`;
    for (const operator of operators) {
      const scriptedNonce = operator?.nonces?.[accountId];
      if (scriptedNonce !== undefined) nonce = scriptedNonce;
      const scriptedCommitment = operator?.stateCommitments?.[accountId];
      if (scriptedCommitment !== undefined) commitment = scriptedCommitment;
    }
    return {
      nonce: () => ({ asInt: () => nonce }),
      id: () => ({ toString: () => accountId }),
      to_commitment: () => ({ toHex: () => commitment }),
      free: jest.fn()
    };
  });
}

const testnet = { network: MIDEN_NETWORK_NAME.TESTNET };

beforeEach(() => {
  mockBackend.clear();
  mockSecretKeys.length = 0;
  mockSigners.length = 0;
  mockSeedsRequested.length = 0;
  resetMockProbes();
  mockChainCommitments.clear();
  mockChainFailWith = undefined;
  mockChainReads.length = 0;
  mockRpcUrls.length = 0;
  jest.clearAllMocks();
  scriptNonces();
  mockEffectiveNetwork = MIDEN_NETWORK_NAME.TESTNET;
  mockEffectiveRpcUrl = 'https://rpc.custom.example';
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  _resetGuardianRegistryForTest();
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

  it('retries the lookup once, so a transient lookup blip on the current operator still detects it', async () => {
    // Post-switch: OZ is stale (nonce 3), GATEWAY is current (nonce 9) but its
    // lookup fails once before succeeding. Without the lookup retry GATEWAY would
    // land in `failures`, leaving stale OZ as a lone match that gets auto-picked;
    // with it, both match and the higher nonce wins.
    mockBackend.set(OZ, { accounts: ['acct-old'], nonces: { 'acct-old': 3n } });
    mockBackend.set(GATEWAY, { accounts: ['acct-new'], nonces: { 'acct-new': 9n }, lookupFailFirst: 1 });

    const result = await discoverGuardianForSeed(fakeDeriveSeed, testnet);

    expect(result.best?.endpoint).toBe(GATEWAY);
    expect(result.best?.nonce).toBe(9n);
    expect(result.failures).toEqual([]);
    expect(mockBackend.get(GATEWAY)?.lookupCalls).toBe(2);
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

  // #1648: the account moved to a guardian that is not in the list, so the one it
  // left is the only listed operator that answers, with the state it had.
  it('does not pick a lone operator whose state the chain has moved past, and marks it', async () => {
    mockBackend.set(LAMBDA, { accounts: ['acct-1'], nonces: { 'acct-1': 4n } });
    mockChainCommitments.set('acct-1', 'chain-after-the-switch');

    const result = await discoverGuardianForSeed(fakeDeriveSeed, testnet);

    expect(result.best).toBeUndefined();
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ endpoint: LAMBDA, holdsCurrentState: false });
    expect(mockChainReads).toEqual(['acct-1']);
  });

  it('picks the operator serving the chain state over the one the account left, even with its nonce unknown', async () => {
    mockBackend.set(OZ, { accounts: ['acct-1'], nonces: { 'acct-1': 9n }, stateCommitments: { 'acct-1': 'old' } });
    mockBackend.set(GATEWAY, {
      accounts: ['acct-1'],
      stateCommitments: { 'acct-1': 'current' },
      stateFailWith: new Error('state unavailable')
    });
    mockChainCommitments.set('acct-1', 'current');

    const result = await discoverGuardianForSeed(fakeDeriveSeed, testnet);

    // Without the chain verdict two matches with an unknown nonce would refuse to auto-pick;
    // the stale one is out of the running, so the lone current operator is picked.
    expect(result.best?.endpoint).toBe(GATEWAY);
    expect(result.matches.map(match => [match.endpoint, match.holdsCurrentState])).toEqual([
      [GATEWAY, undefined],
      [OZ, false]
    ]);
  });

  it('keeps a lone match, with the verdict unknown, when the node cannot be read', async () => {
    mockBackend.set(LAMBDA, { accounts: ['acct-1'], nonces: { 'acct-1': 4n } });
    mockChainFailWith = new Error('node unreachable');

    const result = await discoverGuardianForSeed(fakeDeriveSeed, testnet);

    expect(mockChainReads).toEqual(['acct-1']);
    expect(result.best?.endpoint).toBe(LAMBDA);
    expect(result.best?.holdsCurrentState).toBeUndefined();
  });

  it('treats an account the chain holds no commitment for (not deployed yet) as uncompared', async () => {
    mockBackend.set(LAMBDA, { accounts: ['acct-1'], nonces: { 'acct-1': 0n } });
    mockChainCommitments.set('acct-1', `0x${'0'.repeat(64)}`);

    const result = await discoverGuardianForSeed(fakeDeriveSeed, testnet);

    expect(mockChainReads).toEqual(['acct-1']);
    expect(result.best?.endpoint).toBe(LAMBDA);
    expect(result.best?.holdsCurrentState).toBeUndefined();
  });

  it('confirms an operator whose state is the chain state', async () => {
    mockBackend.set(LAMBDA, { accounts: ['acct-1'], nonces: { 'acct-1': 4n } });

    const result = await discoverGuardianForSeed(fakeDeriveSeed, testnet);

    expect(result.best).toMatchObject({ endpoint: LAMBDA, holdsCurrentState: true });
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

    // 2 endpoints x 3 HD indices = 6 independent AuthSecretKey/EcdsaSigner pairs.
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

  it('takes a native-HTTP probe of every endpoint, spelled without its trailing slash', async () => {
    await discoverGuardianForSeed(fakeDeriveSeed, { ...testnet, endpoints: [`${OZ}/`] });

    expect(mockProbedEndpoints).toEqual([OZ]);
  });

  // On mobile an endpoint stays routed through native HTTP only when it answered with the account.
  it('keeps the origin of an operator that holds the account and releases the others', async () => {
    mockBackend.set(OZ, { accounts: ['acct-1'], nonces: { 'acct-1': 5n } });

    await discoverGuardianForSeed(fakeDeriveSeed, { ...testnet, endpoints: [OZ, GATEWAY] });

    expect(mockProbeVerdicts).toEqual([
      [OZ, true],
      [GATEWAY, false]
    ]);
  });

  it('releases every probed origin when the probe is aborted', async () => {
    mockBackend.set(OZ, { accounts: ['acct-1'], nonces: { 'acct-1': 5n } });
    const controller = new AbortController();
    controller.abort();

    await discoverGuardianForSeed(fakeDeriveSeed, { ...testnet, endpoints: [OZ, GATEWAY], signal: controller.signal });

    expect(mockProbeVerdicts).toEqual([
      [OZ, false],
      [GATEWAY, false]
    ]);
  });

  it('releases every probed origin when the probe throws', async () => {
    const signal = new AbortController().signal;
    // An unreadable signal is the one input that makes the probe body itself throw.
    Object.defineProperty(signal, 'aborted', {
      get: () => {
        throw new Error('signal unreadable');
      }
    });

    await expect(
      discoverGuardianForSeed(fakeDeriveSeed, { ...testnet, endpoints: [OZ, GATEWAY], signal })
    ).rejects.toThrow('signal unreadable');
    expect(mockProbeVerdicts).toEqual([
      [OZ, false],
      [GATEWAY, false]
    ]);
  });

  it('probes only the single configured operator on devnet', async () => {
    const result = await discoverGuardianForSeed(fakeDeriveSeed, { network: MIDEN_NETWORK_NAME.DEVNET });

    expect(result.probedEndpoints).toEqual(['https://guardian-devnet.openzeppelin.com']);
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

  it('resolves a host-case spelling of a known operator to it', async () => {
    const hostCase = LAMBDA.toUpperCase();
    mockBackend.set(hostCase, { accounts: ['acct-1'], nonces: { 'acct-1': 1n } });

    const known = await discoverGuardianForSeed(fakeDeriveSeed, { ...testnet, endpoints: [hostCase] });
    expect(known.best?.option?.id).toBe('lambda-class');
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

describe('withTimeout across a freeze (#2060)', () => {
  const TIMEOUT_MS = 30_000;
  const FROZEN_MS = 80_000;
  // The running clock keeps one 5 s pulse of a measured freeze, so that much of the budget is spent.
  const LEFT_AFTER_FREEZE_MS = TIMEOUT_MS - 5_000;

  let doc: HiddenDocument;

  const settledWith = (promise: Promise<string>) => {
    const outcome: { value?: string; error?: unknown } = {};
    void promise.then(
      value => {
        outcome.value = value;
      },
      error => {
        outcome.error = error;
      }
    );
    return outcome;
  };

  const freeze = async () => {
    doc.setHidden(true);
    doc.freezeFor(FROZEN_MS);
    await jest.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    jest.useFakeTimers();
    doc = installHiddenDocument();
    initBackgroundTimeTracking();
  });

  afterEach(() => {
    __resetBackgroundTimeForTest();
    doc.restore();
    jest.useRealTimers();
  });

  it('takes the answer the native layer delivers on resume, ahead of which an overdue timer runs', async () => {
    let answer: (value: string) => void = () => undefined;
    const outcome = settledWith(
      withTimeout(
        new Promise<string>(resolve => {
          answer = resolve;
        }),
        TIMEOUT_MS,
        'pubkey'
      )
    );

    await freeze();
    doc.setHidden(false);
    await jest.advanceTimersByTimeAsync(0);
    expect(outcome.error).toBeUndefined();

    answer('ok');
    await jest.advanceTimersByTimeAsync(0);
    expect(outcome.value).toBe('ok');
    // The timer the fire re-armed goes with the answer.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('gives up once its running time is spent', async () => {
    const outcome = settledWith(withTimeout(new Promise<string>(() => {}), TIMEOUT_MS, 'pubkey'));

    await freeze();
    doc.setHidden(false);
    await jest.advanceTimersByTimeAsync(LEFT_AFTER_FREEZE_MS - 1);
    expect(outcome.error).toBeUndefined();

    await jest.advanceTimersByTimeAsync(1);
    expect(outcome.error).toBeInstanceOf(GuardianProbeTimeoutError);
  });

  it('still gives up on time while hidden JS keeps running', async () => {
    const outcome = settledWith(withTimeout(new Promise<string>(() => {}), TIMEOUT_MS, 'pubkey'));

    doc.setHidden(true);
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(outcome.error).toBeUndefined();

    await jest.advanceTimersByTimeAsync(1);
    expect(outcome.error).toBeInstanceOf(GuardianProbeTimeoutError);
  });

  it('counts a freeze as elapsed where tracking never started', async () => {
    __resetBackgroundTimeForTest();
    const outcome = settledWith(withTimeout(new Promise<string>(() => {}), TIMEOUT_MS, 'pubkey'));

    await freeze();

    expect(outcome.error).toBeInstanceOf(GuardianProbeTimeoutError);
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

describe('decodeStates', () => {
  const state = (accountId: string) => ({
    accountId,
    commitment: 'c',
    stateJson: { data: Buffer.from(accountId).toString('base64') },
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z'
  });

  it('reads each account state commitment next to the maximum nonce', () => {
    mockBackend.set(OZ, { nonces: { a: 2n, b: 11n }, stateCommitments: { a: 'A1', b: 'B2' } });
    scriptNonces();

    const decoded = decodeStates([state('a'), state('b')]);

    expect(decoded.nonce).toBe(11n);
    expect(Array.from(decoded.commitments)).toEqual([
      ['a', 'a1'],
      ['b', 'b2']
    ]);
  });

  it('lowercases the commitments it compares', () => {
    mockBackend.set(OZ, { stateCommitments: { a: '0xABC' } });
    scriptNonces();

    expect(decodeStates([state('a')]).commitments.get('a')).toBe('0xabc');
  });
});

describe('holdsCurrentState', () => {
  it('is true as soon as one served state is the chain state', () => {
    const served = new Map([
      ['a', 'old'],
      ['b', 'same']
    ]);
    const chain = new Map([
      ['a', 'new'],
      ['b', 'same']
    ]);
    expect(holdsCurrentState(served, chain)).toBe(true);
  });

  it('is false when every compared state is behind the chain', () => {
    expect(holdsCurrentState(new Map([['a', 'old']]), new Map([['a', 'new']]))).toBe(false);
  });

  it('is unknown when nothing could be compared', () => {
    expect(holdsCurrentState(new Map([['a', 'old']]), new Map())).toBeUndefined();
    expect(holdsCurrentState(new Map(), new Map([['a', 'new']]))).toBeUndefined();
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

  it('ranks a match whose state the chain moved past last, whatever its nonce', () => {
    const behind = match({ endpoint: OZ, nonce: 9n, holdsCurrentState: false });
    const unknownNonce = match({ endpoint: GATEWAY, nonce: undefined });

    expect(compareMatches(unknownNonce, behind, [OZ, GATEWAY])).toBeLessThan(0);
    expect(compareMatches(behind, unknownNonce, [OZ, GATEWAY])).toBeGreaterThan(0);
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

  it('never picks a match whose state the chain moved past, and ranks the rest without it', () => {
    const behind = match({ endpoint: OZ, nonce: 9n, holdsCurrentState: false });
    expect(selectBest([behind])).toBeUndefined();

    const current = match({ endpoint: GATEWAY, nonce: undefined });
    expect(selectBest([current, behind])).toBe(current);
  });
});

/**
 * The hot-key probe rides the same body as the seed probe (the refactor's
 * whole point — the seed suites above must pass unmodified), so only what
 * DIFFERS is asserted here: the key comes from `AuthSecretKey.deserialize`
 * rather than seed derivation, and there is no HD walk — exactly one key per
 * operator, whatever maxHdIndex a caller tries to pass.
 */
describe('discoverGuardianForHotKey', () => {
  // Full serialized form (tag byte + scalar), so deserialization never needs
  // the tag probe — `ecdsaWithRNG` in this file's factory has no `serialize`.
  const HOT_KEY_HEX = `01${'ab'.repeat(32)}`;

  beforeEach(() => {
    mockAuthDeserialize.mockImplementation((bytes: Uint8Array) => {
      // Same shape the seed path's keys have; commitment-0 makes the fake
      // operators answer with their index-0 accounts.
      const key = { commitmentHex: 'commitment-0', free: jest.fn(), bytes };
      mockSecretKeys.push(key);
      return key;
    });
  });

  it('finds the operator holding the account for the pasted key', async () => {
    mockBackend.set(GATEWAY, { accounts: ['acct-hot'], nonces: { 'acct-hot': 5n } });

    const result = await discoverGuardianForHotKey(HOT_KEY_HEX, testnet);

    expect(result.best?.endpoint).toBe(GATEWAY);
    expect(result.best?.accountIds).toEqual(['acct-hot']);
    // The pasted hex reached the SDK, tag byte intact.
    const bytes = mockAuthDeserialize.mock.calls[0]![0] as Uint8Array;
    expect(Buffer.from(bytes).toString('hex')).toBe(HOT_KEY_HEX);
  });

  it('resolves with no best match when no operator knows the key — never throws', async () => {
    const result = await discoverGuardianForHotKey(HOT_KEY_HEX, testnet);

    expect(result.best).toBeUndefined();
    expect(result.matches).toEqual([]);
  });

  it('builds exactly one key per operator: a single key has no HD walk', async () => {
    mockBackend.set(OZ, { accounts: ['acct-hot'] });

    const result = await discoverGuardianForHotKey(HOT_KEY_HEX, { ...testnet, maxHdIndex: 5 });

    expect(mockSecretKeys).toHaveLength(result.probedEndpoints.length);
    expect(result.best?.hdIndices).toEqual([0]);
    // Every per-task WASM handle is released after its probe settles.
    for (const key of mockSecretKeys) {
      expect((key as { free: jest.Mock }).free).toHaveBeenCalled();
    }
  });
});

/**
 * A release build's own network is testnet or devnet, and mainnet is a stored choice: with no network named,
 * discovery asks the operators of the network the wallet is on, never the build's.
 */
describe('the operators discovery asks when no network is named', () => {
  const HOT_KEY_HEX = `01${'ab'.repeat(32)}`;
  const MAINNET_OPERATOR = {
    id: 'mainnet-operator',
    name: 'Mainnet Operator',
    operatedBy: 'Operator Co',
    location: 'EU',
    endpoint: 'https://guardian-mainnet.example'
  };
  const flows: Array<[string, () => Promise<GuardianDiscoveryResult>]> = [
    ['a seed', () => discoverGuardianForSeed(fakeDeriveSeed)],
    ['a hot key', () => discoverGuardianForHotKey(HOT_KEY_HEX)]
  ];

  beforeEach(() => {
    mockAuthDeserialize.mockImplementation(() => {
      const key = { commitmentHex: 'commitment-0', free: jest.fn() };
      mockSecretKeys.push(key);
      return key;
    });
    // Holds an account for every key, so a probe that reached it would detect it.
    mockBackend.set(OZ, { accounts: ['acct-testnet'], nonces: { 'acct-testnet': 2n } });
  });

  it.each(flows)('asks no operator for %s on a network whose document lists none', async (_flow, discover) => {
    mockEffectiveNetwork = MIDEN_NETWORK_NAME.MAINNET;
    setDocumentGuardians(MIDEN_NETWORK_NAME.MAINNET, []);

    const result = await discover();

    expect(result.probedEndpoints).toEqual([]);
    expect(result.best).toBeUndefined();
    expect(mockProbedEndpoints).toEqual([]);
    expect(mockBackend.get(OZ)?.lookupCalls).toBeUndefined();
  });

  it.each(flows)('asks only the mainnet operator for %s once mainnet lists one', async (_flow, discover) => {
    mockEffectiveNetwork = MIDEN_NETWORK_NAME.MAINNET;
    setDocumentGuardians(MIDEN_NETWORK_NAME.MAINNET, [MAINNET_OPERATOR]);
    mockBackend.set(MAINNET_OPERATOR.endpoint, { accounts: ['acct-mainnet'], nonces: { 'acct-mainnet': 1n } });

    const result = await discover();

    expect(result.probedEndpoints).toEqual([MAINNET_OPERATOR.endpoint]);
    expect(result.best?.option?.id).toBe(MAINNET_OPERATOR.id);
    expect(mockBackend.get(OZ)?.lookupCalls).toBeUndefined();
  });

  it.each(flows)('asks the testnet operators for %s on testnet', async (_flow, discover) => {
    const result = await discover();

    expect(result.probedEndpoints).toContain(OZ);
    expect(result.best?.endpoint).toBe(OZ);
  });

  // #1648: a recover-only reset probes mainnet before the wallet switches there, so the chain verdict
  // comes from mainnet's node; the effective network's node knows nothing of the mainnet state.
  it.each([
    ['a seed', () => discoverGuardianForSeed(fakeDeriveSeed, { network: MIDEN_NETWORK_NAME.MAINNET })],
    ['a hot key', () => discoverGuardianForHotKey(HOT_KEY_HEX, { network: MIDEN_NETWORK_NAME.MAINNET })]
  ] as Array<[string, () => Promise<GuardianDiscoveryResult>]>)(
    'reads the chain of the network it probes for %s, not the effective one',
    async (_flow, discover) => {
      setDocumentGuardians(MIDEN_NETWORK_NAME.MAINNET, [MAINNET_OPERATOR]);
      mockBackend.set(MAINNET_OPERATOR.endpoint, { accounts: ['acct-mainnet'], nonces: { 'acct-mainnet': 1n } });
      mockChainCommitments.set('acct-mainnet', 'chain-after-the-switch');

      const result = await discover();

      expect(mockRpcUrls).toEqual([MIDEN_NETWORK_ENDPOINTS.get(MIDEN_NETWORK_NAME.MAINNET)]);
      expect(result.matches[0]).toMatchObject({ endpoint: MAINNET_OPERATOR.endpoint, holdsCurrentState: false });
      expect(result.best).toBeUndefined();
    }
  );

  it.each(flows)('reads the chain of the effective network for %s through its custom RPC', async (_flow, discover) => {
    mockEffectiveRpcUrl = 'https://rpc.own-node.example';

    const result = await discover();

    expect(mockRpcUrls).toEqual(['https://rpc.own-node.example']);
    expect(result.best).toMatchObject({ endpoint: OZ, holdsCurrentState: true });
  });
});

/**
 * MultisigService — wraps MultisigClient/Multisig/GuardianHttpClient into a
 * narrower surface used by the wallet. These tests cover:
 *   - constructor / accountId getter
 *   - proposal builders (send, consume, custom)
 *   - signAndExecute / signAndCreateTransactionRequest
 *   - sync retry on "nonce too low", including exhaustion
 *   - importAccountFromGuardian happy + error path
 *   - createSwitchGuardianProposal + finalizeGuardianSwitch
 *
 * All external collaborators are stubbed to keep tests hermetic.
 */

import { Account } from '@miden-sdk/miden-sdk/lazy';
import { GuardianHttpClient } from '@openzeppelin/miden-multisig-client';

import { OUTGOING_GUARDIAN_DEADLINE_MS } from './discover';
import {
  GuardianReRegisterRefusedError,
  isGuardianAuthRejection,
  MultisigService,
  POST_COMMIT_GUARDIAN_TIMEOUT_MS
} from './index';
import { GUARDIAN_REGISTER_RETRY_MAX_DELAY_MS, NEW_GUARDIAN_PUBKEY_TIMEOUT_MS } from './serialize';
import { WASM_LOCK_SYNC_WATCHDOG_MS, WasmClientPoisonedError } from '../sdk/wasm-client-poison';

/**
 * Fire retry BACKOFFS immediately without disabling request DEADLINES.
 *
 * These tests replaced `setTimeout` with an immediate-invoke stub so they would
 * not sit on real backoff timers. That also fires the `withTimeout` deadlines the
 * guardian calls are wrapped in, so every bounded request "timed out" on its
 * first tick — the stub silently rewrote what was under test. Bounded by the cap
 * on the delays being skipped (`GUARDIAN_REGISTER_RETRY_MAX_DELAY_MS`, and the
 * shorter sync retry wait below it), so anything longer — i.e. a deadline — keeps
 * a real timer and never fires before the promise it guards settles.
 */
const skipRetryBackoffs = () => {
  const original = global.setTimeout;
  (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms?: number) => {
    if ((ms ?? 0) <= GUARDIAN_REGISTER_RETRY_MAX_DELAY_MS) {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return original(fn, ms);
  }) as typeof setTimeout;
  return () => {
    (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = original;
  };
};

const mockFetchFromStorage = jest.fn();
jest.mock('../front/storage', () => ({
  fetchFromStorage: (...args: unknown[]) => mockFetchFromStorage(...args)
}));

jest.mock('lib/settings/constants', () => ({
  GUARDIAN_URL_STORAGE_KEY: 'guardian_url_setting'
}));

jest.mock('lib/shared/helpers', () => ({
  u8ToB64: jest.fn(() => 'base64-bytes'),
  b64ToU8: jest.fn(() => new Uint8Array([1, 2, 3]))
}));

// Keep the id parser simple — we only assert it was called with the inputs we
// passed; the real implementation parses bech32/hex, which needs WASM.
const mockAccountRefToSdk = jest.fn((ref: string) => ({ toString: () => `sdk(${ref})` }));
jest.mock('../sdk/helpers', () => ({
  accountRefToSdk: (...args: unknown[]) => mockAccountRefToSdk(...(args as [string]))
}));

const mockGetAccount = jest.fn();
const mockAccountInspectorFromAccount = jest.fn();
const mockSyncState = jest.fn(async () => {});
const mockRawWebClient = { kind: 'raw-web-client' };
const mockMidenClient = {
  getAccount: (...args: unknown[]) => mockGetAccount(...args),
  syncState: () => mockSyncState(),
  client: mockRawWebClient
};
// The slice-2 offscreen client proxy reads getAccount through the `lib/...` alias
// of miden-client, which jest mocks separately from the relative specifier below;
// delegate the alias to the same mock so the proxy's flag-off passthrough hits it.
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
// `wasmLockOptionsSeen` records every hold's options: with a pass-through lock a
// hold on the 5-minute backstop and one on the sync ceiling are otherwise
// indistinguishable, and the guardian sync is the wallet's DEFAULT account type's
// idle sync (#777).
let currentWasmHold: object | null = null;
// Set by the one test that needs the watchdog to land mid-build.
let evictDuringClientBuild = false;
// Runs before a hold begins: the time a caller spends queued for the mutex.
let beforeWasmHold: (() => void) | undefined;
const wasmLockOptionsSeen: unknown[] = [];
jest.mock('../sdk/miden-client', () => {
  // The real error class, so the code under test's poison classifiers see the
  // same shape production throws.
  const { WasmClientPoisonedError: PoisonError } = jest.requireActual('../sdk/wasm-client-poison');
  return {
    getMidenClient: async () => {
      if (evictDuringClientBuild) currentWasmHold = null;
      return mockMidenClient;
    },
    // Models hold OWNERSHIP: the code under test re-checks it after the client build, so a
    // pass-through mock with no hold makes that guard both unreachable and a TypeError.
    getCurrentWasmLockHold: () => currentWasmHold,
    // The shared post-await re-check (#788 follow-up). Re-implements the
    // comparison against THIS mock's current hold — a no-op stub here would make
    // every eviction test below vacuously green.
    assertWasmHoldCurrent: (hold: object | null, where: string) => {
      if (hold !== null && currentWasmHold === hold) return;
      throw new PoisonError('watchdog', new Error(`operation abandoned ${where}`));
    },
    withWasmClientLock: async <T>(fn: (hold: object) => Promise<T>, options?: unknown) => {
      wasmLockOptionsSeen.push(options);
      beforeWasmHold?.();
      const hold = {};
      currentWasmHold = hold;
      try {
        return await fn(hold);
      } finally {
        if (currentWasmHold === hold) currentWasmHold = null;
      }
    }
  };
});

const mockInterfaceClient = { accounts: { insert: jest.fn(async () => {}) } };
jest.mock('../sdk/miden-client-interface', () => ({
  MidenClientInterface: {
    create: jest.fn(async () => ({ client: mockInterfaceClient }))
  }
}));

// Guardian SDK stubs — each constructor pulls from a per-test config so the
// same `new GuardianHttpClient(...)` call can return different behavior per
// test without juggling prototypes.
const guardianConfig: {
  getPubkey: jest.Mock;
  getState: jest.Mock;
  setSigner: jest.Mock;
  getDeltaProposal: jest.Mock;
  pushDelta: jest.Mock;
} = {
  getPubkey: jest.fn(),
  getState: jest.fn(),
  setSigner: jest.fn(),
  getDeltaProposal: jest.fn(),
  pushDelta: jest.fn()
};
const multisigClientConfig: { load: jest.Mock } = {
  load: jest.fn()
};

const mockBuildUpdateSignersTransactionRequest = jest.fn(async (..._args: unknown[]) => ({
  request: { kind: 'request' },
  salt: { toHex: () => 'salt-hex' }
}));
// `free` on the default anchor so the ordinary cases exercise a successful
// release rather than `freeChainAnchor`'s swallow-and-warn branch.
const mockExecuteForSummary = jest.fn(async (..._args: unknown[]) => ({
  summary: { serialize: () => new Uint8Array([0xab]) },
  anchor: { kind: 'anchor', free: jest.fn() }
}));
const mockChainAnchorToBase64 = jest.fn((_anchor: unknown) => 'anchor-b64');

jest.mock('@openzeppelin/miden-multisig-client', () => ({
  GuardianHttpClient: jest.fn().mockImplementation(() => ({
    getPubkey: (...a: unknown[]) => guardianConfig.getPubkey(...a),
    getState: (...a: unknown[]) => guardianConfig.getState(...a),
    setSigner: (...a: unknown[]) => guardianConfig.setSigner(...a),
    getDeltaProposal: guardianConfig.getDeltaProposal,
    pushDelta: guardianConfig.pushDelta
  })),
  MultisigClient: jest.fn().mockImplementation(() => ({
    load: (...a: unknown[]) => multisigClientConfig.load(...a)
  })),
  buildUpdateSignersTransactionRequest: (...a: unknown[]) => mockBuildUpdateSignersTransactionRequest(...a),
  executeForSummary: (...a: unknown[]) => mockExecuteForSummary(...a),
  chainAnchorToBase64: (a: unknown) => mockChainAnchorToBase64(a),
  AccountInspector: { fromAccount: (...a: unknown[]) => mockAccountInspectorFromAccount(...a) }
}));

const mockGetSignerDetailsFromAccount = jest.fn();
// The staleness guard itself is a collaborator here, covered against real
// nonces in account.test.ts; these tests only assert that the import path
// routes its write THROUGH it rather than calling accounts.insert directly.
const mockInsertGuardianAccountMonotonically = jest.fn();
jest.mock('./account', () => ({
  // Kept REAL: it is pure string validation, and it is the guard that keeps a
  // guardian's wire response out of the transaction script source.
  assertGuardianKeyCommitment: jest.requireActual('./account').assertGuardianKeyCommitment,
  getSignerDetailsFromAccount: (...a: unknown[]) => mockGetSignerDetailsFromAccount(...a),
  insertGuardianAccountMonotonically: (...a: unknown[]) => mockInsertGuardianAccountMonotonically(...a),
  // Resolve to the per-account endpoint, falling back to the stored value the
  // fetchFromStorage mock returns — mirrors the real resolveGuardianEndpoint.
  resolveGuardianEndpoint: async (acc: { guardianEndpoint?: string }) =>
    acc.guardianEndpoint ?? 'https://stored.guardian.test'
}));

// The shared native-HTTP double records each probe's verdict.
jest.mock('./native-http');
// A pubkey-check deadline no other deadline shares, so a test can tell which one a call reads.
jest.mock('./serialize', () => ({ ...jest.requireActual('./serialize'), NEW_GUARDIAN_PUBKEY_TIMEOUT_MS: 45_000 }));
const { mockProbeVerdicts, resetMockProbes } =
  jest.requireMock<typeof import('./__mocks__/native-http')>('./native-http');

// atob is globally available on Node 16+ but jsdom stubs can vary — provide
// a deterministic polyfill for these tests.
if (typeof global.atob === 'undefined') {
  global.atob = (str: string) => Buffer.from(str, 'base64').toString('binary');
}

// Augment the existing wasmMock with the one bit we need: Account.deserialize.
const mockAccountDeserialize = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const actual = jest.requireActual('../../../../__mocks__/wasmMock.js');
  return {
    ...actual,
    Account: {
      ...(actual.Account ?? {}),
      deserialize: (...args: unknown[]) => mockAccountDeserialize(...args)
    }
  };
});
jest.mock('@miden-sdk/miden-sdk', () => {
  const actual = jest.requireActual('../../../../__mocks__/wasmMock.js');
  return {
    ...actual,
    Account: {
      ...(actual.Account ?? {}),
      deserialize: (...args: unknown[]) => mockAccountDeserialize(...args)
    }
  };
});

const makeMultisig = (overrides: Partial<Record<string, unknown>> = {}) => ({
  accountId: 'acc-id',
  account: {
    nonce: () => ({ asInt: () => 5n })
  },
  threshold: 1,
  getEffectiveThreshold: jest.fn(() => 1),
  createP2idProposal: jest.fn(async () => ({ kind: 'p2id' })),
  createConsumeNotesProposal: jest.fn(async () => ({ kind: 'consume' })),
  createProposal: jest.fn(async () => ({ kind: 'custom', id: 'proposal-id' })),
  createTransactionProposalRequest: jest.fn(async () => 'tx-req'),
  signProposal: jest.fn(async () => ({ signatures: [] })),
  abandonCandidate: jest.fn(async () => ({ state: 'pending' })),
  executeProposal: jest.fn(async () => {}),
  syncState: jest.fn(async () => {}),
  // Local IS the on-chain state unless a test says otherwise: the re-register's guard (#1233).
  verifyStateCommitment: jest.fn(async () => ({
    accountId: 'acc-id',
    localCommitment: '0xc0',
    onChainCommitment: '0xc0'
  })),
  getConsumableNotes: jest.fn(async () => ['note-a']),
  createSwitchGuardianProposal: jest.fn(async () => ({
    nonce: 7,
    txSummary: 'txs-b64',
    metadata: { proposalType: 'switch-guardian' }
  })),
  setGuardianClient: jest.fn(),
  registerOnGuardian: jest.fn(async () => {}),
  guardianPublicKey: 'old-pubkey',
  ...overrides
});

// The gate that decides whether the sync loop may cold-re-register — i.e.
// whether this device may POST `/configure`, an account-wide write. Every test
// that drives that path lives in guardian-sync.test.ts, which stubs this module,
// so the real classifier had no test of its own: it could have been inverted or
// deleted with the suite staying green. `isGuardianUnreachableError` already has
// a table like this one; this closes the matching gap for the 401.
describe('isGuardianAuthRejection', () => {
  it.each([
    ['an HTTP 401', { status: 401 }],
    ['the authentication_failed code', { code: 'authentication_failed' }],
    ['the signer_not_authorized code', { code: 'signer_not_authorized' }],
    ['a 401 carrying an unrelated code', { status: 401, code: 'something_else' }]
  ])('recognizes %s', (_label, err) => {
    expect(isGuardianAuthRejection(err)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'unauthorized'],
    ['a plain Error', new Error('unauthorized')],
    // The neighbours it must not swallow: each one routes somewhere else in the
    // sync loop, and misreading any of them as a 401 would spend the cold
    // re-register budget on a condition it cannot repair.
    ['a 429', { status: 429 }],
    ['a 500', { status: 500 }],
    ['an unknown-account verdict', { code: 'account_not_found' }],
    ['a data_unavailable verdict', { code: 'data_unavailable' }],
    ['a stringly-typed status', { status: '401' }]
  ])('does not recognize %s', (_label, err) => {
    expect(isGuardianAuthRejection(err)).toBe(false);
  });
});

describe('MultisigService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // A leaked hold/eviction flag from a prior test would flip an unrelated
    // test's ownership re-checks.
    currentWasmHold = null;
    evictDuringClientBuild = false;
    mockFetchFromStorage.mockResolvedValue('https://stored.guardian.test');
    // Default: AccountInspector reads an empty signer set unless a test overrides it.
    mockAccountInspectorFromAccount.mockReturnValue({ signerCommitments: [] });
  });

  describe('constructor + getters', () => {
    it('accountId delegates to the wrapped Multisig', () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      expect(service.accountId).toBe('acc-id');
      expect(service.guardianEndpoint).toBe('https://x');
    });

    it('getAuthInfo reports threshold, signer set, and procedure thresholds', () => {
      const multisig = makeMultisig({
        threshold: 1,
        signerCommitments: ['0xhot', '0xcold'],
        procedureThresholds: new Map<string, number>([['update_guardian', 2]])
      });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const auth = service.getAuthInfo();
      expect(auth.threshold).toBe(1);
      expect(auth.signerCommitments).toEqual(['0xhot', '0xcold']);
      expect(auth.procedureThresholds).toEqual({ update_guardian: 2 });
    });

    it('getAuthInfo degrades gracefully when the multisig lacks fields', () => {
      const multisig = makeMultisig(); // no signerCommitments / procedureThresholds
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const auth = service.getAuthInfo();
      expect(auth.signerCommitments).toEqual([]);
      expect(auth.procedureThresholds).toEqual({});
    });

    it('getProcedureThreshold reads the procedure map', () => {
      const multisig = makeMultisig({ procedureThresholds: new Map<string, number>([['update_guardian', 2]]) });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      expect(service.getProcedureThreshold('update_guardian')).toBe(2);
      expect(service.getProcedureThreshold('nope')).toBeUndefined();
    });
  });

  describe('proposal builders', () => {
    // Through `accountRefToSdk`, not the bech32-only parser: faucet ids reach
    // the wallet in both hex and bech32 form, and the sibling recallable-send
    // path already accepts both — a hex id it sends fine must not throw here.
    it('createSendProposal normalizes recipient+faucet ids through accountRefToSdk', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      const proposal = await service.createSendProposal('rec', 'fauc', 1000n, 'Private' as never);

      expect(mockAccountRefToSdk).toHaveBeenCalledWith('rec');
      expect(mockAccountRefToSdk).toHaveBeenCalledWith('fauc');
      // Options are the 4th argument since multisig-client 0.17 — they used to
      // sit behind a `nonce` slot that no longer exists.
      expect(multisig.createP2idProposal).toHaveBeenCalledWith('sdk(rec)', 'sdk(fauc)', 1000n, {
        noteType: 'Private'
      });
      expect(proposal).toEqual({ kind: 'p2id' });
    });

    // Was hardcoded Private, so a Public guardian send emitted a private note
    // the recipient was never handed — the row said 'public', so the relay in
    // completeSendTransaction was skipped too.
    it('createSendProposal forwards the caller-resolved note type', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      await service.createSendProposal('rec', 'fauc', 1000n, 'Public' as never);

      expect(multisig.createP2idProposal).toHaveBeenCalledWith('sdk(rec)', 'sdk(fauc)', 1000n, {
        noteType: 'Public'
      });
    });

    it('createConsumeNotesProposal forwards note ids untouched', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      const proposal = await service.createConsumeNotesProposal(['n1', 'n2']);

      expect(multisig.createConsumeNotesProposal).toHaveBeenCalledWith(['n1', 'n2']);
      expect(proposal).toEqual({ kind: 'consume' });
    });

    it('createUpdateProcedureThresholdProposal forwards the procedure and threshold', async () => {
      const createUpdateFn = jest.fn(async () => ({ kind: 'update-threshold' }));
      const multisig = makeMultisig({ createUpdateProcedureThresholdProposal: createUpdateFn });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      const proposal = await service.createUpdateProcedureThresholdProposal('update_guardian', 2);

      expect(createUpdateFn).toHaveBeenCalledWith('update_guardian', 2);
      expect(proposal).toEqual({ kind: 'update-threshold' });
    });

    it('createCustomProposal forwards request bytes and proposal type', async () => {
      const createCustomFn = jest.fn(async () => ({ kind: 'custom' }));
      const multisig = makeMultisig({ createCustomProposal: createCustomFn });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const bytes = new Uint8Array([1, 2, 3]);

      const proposal = await service.createCustomProposal(bytes, 'my-type');

      expect(createCustomFn).toHaveBeenCalledWith(bytes, 'my-type');
      expect(proposal).toEqual({ kind: 'custom' });
    });
  });

  describe('signing helpers', () => {
    it('signAndExecuteProposal signs then executes a given proposal', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      await service.signAndExecuteProposal('p-1');

      expect(multisig.signProposal).toHaveBeenCalledWith('p-1');
      expect(multisig.executeProposal).toHaveBeenCalledWith('p-1');
    });

    it('signAndCreateTransactionRequest signs then returns the request payload', async () => {
      // Non-custom proposal → the normal createTransactionProposalRequest path.
      const multisig = makeMultisig({
        signProposal: jest.fn(async () => ({ metadata: { proposalType: 'send' } }))
      });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      const tx = await service.signAndCreateTransactionRequest('p-2');

      expect(multisig.signProposal).toHaveBeenCalledWith('p-2');
      expect(multisig.createTransactionProposalRequest).toHaveBeenCalledWith('p-2');
      expect(tx).toBe('tx-req');
    });

    it('requires custom request bytes and holds the client lock during preparation', async () => {
      const preparationError = new Error('preparation failed');
      const prepareCustomExecution = jest.fn(async () => {
        expect(currentWasmHold).not.toBeNull();
        throw preparationError;
      });
      const multisig = makeMultisig({
        signProposal: jest.fn(async () => ({ metadata: { proposalType: 'custom' } })),
        prepareCustomExecution
      });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      await expect(service.signAndCreateTransactionRequest('p-custom')).rejects.toThrow(
        'Request Bytes are required for custom execution'
      );
      expect(prepareCustomExecution).not.toHaveBeenCalled();

      const bytes = new Uint8Array([1, 2, 3]);
      await expect(service.signAndCreateTransactionRequest('p-custom', bytes)).rejects.toBe(preparationError);
      expect(prepareCustomExecution).toHaveBeenCalledWith('p-custom', bytes);
      expect(currentWasmHold).toBeNull();
    });

    it('abandonCandidate forwards the candidate nonce to the Guardian SDK', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      await service.abandonCandidate(7);

      expect(multisig.abandonCandidate).toHaveBeenCalledWith(7);
    });

    it('getConsumableNotes forwards to the wrapped Multisig', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      await expect(service.getConsumableNotes()).resolves.toEqual(['note-a']);
    });
  });

  describe('pushSwitchDelta (#1233)', () => {
    it('pushes the executed switch delta to the guardian the service loaded from, with its summary as the payload', async () => {
      const txSummary = { data: 'txs-b64' };
      const delta = {
        accountId: 'acc-id',
        nonce: 7,
        prevCommitment: '0xprev',
        newCommitment: '0xnew',
        deltaPayload: { txSummary, signatures: [] },
        status: { status: 'pending' }
      };
      const getDeltaProposal = jest.fn(async () => delta);
      const pushDelta = jest.fn(async () => ({ accountId: 'acc-id', nonce: 7 }));
      const service = new MultisigService(
        makeMultisig() as never,
        { guardianClient: { getDeltaProposal, pushDelta } } as never,
        'https://old.guardian'
      );

      await service.pushSwitchDelta('0xprop');

      expect(getDeltaProposal).toHaveBeenCalledWith('acc-id', '0xprop');
      expect(pushDelta).toHaveBeenCalledWith({ ...delta, deltaPayload: txSummary });
    });

    it('surfaces a failed fetch to its caller, which treats the push as best-effort', async () => {
      const pushDelta = jest.fn();
      const service = new MultisigService(
        makeMultisig() as never,
        {
          guardianClient: {
            getDeltaProposal: jest.fn(async () => {
              throw new Error('proposal not found');
            }),
            pushDelta
          }
        } as never,
        'https://old.guardian'
      );

      await expect(service.pushSwitchDelta('0xprop')).rejects.toThrow('proposal not found');
      expect(pushDelta).not.toHaveBeenCalled();
    });

    const boundedPush = (pushDelta: () => Promise<unknown>) =>
      new MultisigService(
        makeMultisig() as never,
        {
          guardianClient: {
            getDeltaProposal: jest.fn(async () => ({ deltaPayload: { txSummary: {} } })),
            pushDelta: jest.fn(pushDelta)
          }
        } as never,
        'https://old.guardian'
      );

    it('pushSwitchDeltaBounded reads a push that lands in time as pushed, outside the WASM lock', async () => {
      wasmLockOptionsSeen.length = 0;

      await expect(boundedPush(async () => ({})).pushSwitchDeltaBounded('0xprop')).resolves.toBe('pushed');
      expect(wasmLockOptionsSeen).toHaveLength(0);
    });

    it('pushSwitchDeltaBounded reads an outgoing guardian that stays silent past the budget as silent', async () => {
      jest.useFakeTimers();
      try {
        const outcome = boundedPush(() => new Promise(() => {})).pushSwitchDeltaBounded('0xprop');
        await jest.advanceTimersByTimeAsync(OUTGOING_GUARDIAN_DEADLINE_MS);
        await expect(outcome).resolves.toBe('silent');
      } finally {
        jest.useRealTimers();
      }
    });

    // Only a timeout is silent: an unreachable answer came back at once, so it holds nothing next lap.
    it('pushSwitchDeltaBounded reads an unreachable guardian and any other answer as refused', async () => {
      const unreachable = Object.assign(new Error('Service Unavailable'), { status: 503 });
      const conflict = Object.assign(new Error('a pending delta exists'), { status: 409 });

      await expect(
        boundedPush(async () => {
          throw unreachable;
        }).pushSwitchDeltaBounded('0xprop')
      ).resolves.toBe('refused');
      await expect(
        boundedPush(async () => {
          throw conflict;
        }).pushSwitchDeltaBounded('0xprop')
      ).resolves.toBe('refused');
    });
  });

  describe('probeGuardianState (#1233)', () => {
    it('probeGuardianState reads the state over guardian HTTP and never takes the WASM lock', async () => {
      wasmLockOptionsSeen.length = 0;
      const getState = jest.fn(async () => ({ accountId: 'acc-id' }));
      const service = new MultisigService(
        makeMultisig() as never,
        { guardianClient: { getState } } as never,
        'https://old.guardian'
      );

      await service.probeGuardianState();

      expect(getState).toHaveBeenCalledTimes(1);
      expect(getState).toHaveBeenCalledWith('acc-id');
      expect(wasmLockOptionsSeen).toHaveLength(0);
    });
  });

  describe('sync retry logic', () => {
    it('resets retry count after a successful sync', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      service.syncRetryCount = 4;

      await service.sync();

      expect(service.syncRetryCount).toBe(0);
    });

    it('bounds adoptGuardianStateOnce too, not just the retrying sync (#777)', async () => {
      // The read-half adopt takes its own hold, and it is the one a cold restore
      // and the stale-allowlist check go through — an unbounded hold there is the
      // same five-minute app-wide WASM freeze as the retrying sync's.
      wasmLockOptionsSeen.length = 0;
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      await service.adoptGuardianStateOnce();

      expect(wasmLockOptionsSeen).toEqual([{ watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'guardian-adopt' }]);
    });

    it('reports how long adoptGuardianStateOnce held its lock, from acquisition, even when it fails', async () => {
      let now = 0;
      const perfSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);
      beforeWasmHold = () => {
        now += 4_000;
      };
      const multisig = makeMultisig({
        syncState: jest.fn(async () => {
          now += 7_000;
          throw new Error('504 Gateway Timeout');
        })
      });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const onHeld = jest.fn();

      try {
        await expect(service.adoptGuardianStateOnce(onHeld)).rejects.toThrow('504 Gateway Timeout');
      } finally {
        beforeWasmHold = undefined;
        perfSpy.mockRestore();
      }

      expect(onHeld).toHaveBeenCalledWith(7_000);
    });

    it('holds the WASM lock on the bounded sync ceiling (#777)', async () => {
      // A guardian sync is a pure-sync hold whose RPC carries no transport
      // deadline on wasm32, and guardian is the wallet's default account type — on
      // the five-minute backstop one parked guardian sync froze every send, claim
      // and balance read in the app for five minutes at a time.
      wasmLockOptionsSeen.length = 0;
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      await service.sync();

      expect(wasmLockOptionsSeen).toEqual([{ watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'guardian-sync' }]);
    });

    it('rethrows immediately for non-nonce errors', async () => {
      const multisig = makeMultisig({ syncState: jest.fn(async () => Promise.reject(new Error('network down'))) });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      await expect(service.sync()).rejects.toThrow('network down');
    });

    it('throws "Max sync retries reached" after MAX_SYNC_RETRIES consecutive nonce-too-low failures', async () => {
      const restoreTimers = skipRetryBackoffs();

      const nonceErr = new Error('nonce is too low');
      const syncState = jest.fn(async () => {
        throw nonceErr;
      });
      const multisig = makeMultisig({ syncState });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      try {
        await expect(service.sync()).rejects.toThrow('Max sync retries reached');
        // 30 retries + the initial attempt = 31 calls.
        expect(syncState).toHaveBeenCalledTimes(31);
      } finally {
        restoreTimers();
      }
    });

    it('increments the retry counter on a nonce-too-low error', async () => {
      // Short-circuit the wait between retries so the test doesn't sit on a real 3s timer.
      const restoreTimers = skipRetryBackoffs();

      const multisig = makeMultisig({
        syncState: jest.fn().mockRejectedValueOnce(new Error('nonce is too low')).mockResolvedValueOnce(undefined)
      });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      try {
        await service.sync();
        // After the retry succeeds, the counter resets to 0 again.
        expect(service.syncRetryCount).toBe(0);
        expect(multisig.syncState).toHaveBeenCalledTimes(2);
      } finally {
        restoreTimers();
      }
    });

    it('waits out a canonicalizing guardian without re-registering, then the retried sync succeeds', async () => {
      // "Refusing to overwrite local state" means the guardian is mid-canonicalization
      // (its blob briefly lags on-chain). It's transient, so we WAIT and retry — we must
      // NOT re-register on the first sign (that re-`configure`s the old guardian after a
      // switch and strands the account).
      const restoreTimers = skipRetryBackoffs();

      const syncState = jest
        .fn()
        .mockRejectedValueOnce(
          new Error('Refusing to overwrite local state: incoming commitment does not match on-chain commitment')
        )
        .mockResolvedValueOnce(undefined);
      const registerOnGuardian = jest.fn(async () => {});
      const multisig = makeMultisig({ syncState, registerOnGuardian });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      mockGetAccount.mockResolvedValue({ serialize: () => new Uint8Array([1, 2, 3]) });

      try {
        await service.sync();
        expect(registerOnGuardian).not.toHaveBeenCalled(); // waited, did not re-register
        expect(syncState).toHaveBeenCalledTimes(2); // initial + one retry
      } finally {
        restoreTimers();
      }
    });

    it('re-registers once as a last resort after the canonicalization window, then the retried sync succeeds', async () => {
      // Only after the bounded wait is exhausted do we treat the lag as a genuine
      // divergence and re-register the current on-chain state once, then retry.
      const restoreTimers = skipRetryBackoffs();

      // 30 waited retries, then the 31st failure exhausts the window and
      // re-registers; the 32nd attempt succeeds.
      let calls = 0;
      const syncState = jest.fn(async () => {
        calls++;
        if (calls <= 31) {
          throw new Error('Refusing to overwrite local state');
        }
      });
      const registerOnGuardian = jest.fn(async () => {});
      const multisig = makeMultisig({ syncState, registerOnGuardian });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      mockGetAccount.mockResolvedValue({ serialize: () => new Uint8Array([1, 2, 3]) });
      wasmLockOptionsSeen.length = 0;

      try {
        await service.sync();
        expect(multisig.verifyStateCommitment).toHaveBeenCalledTimes(1);
        expect(registerOnGuardian).toHaveBeenCalledTimes(1); // last-resort re-register, once
        expect(syncState).toHaveBeenCalledTimes(32); // 31 lag failures + 1 success after re-register
        // The idle loop reaches this re-register, so its hold is bounded and labelled like the sync's.
        expect(
          wasmLockOptionsSeen.filter(options => (options as { label?: string } | undefined)?.label !== 'guardian-sync')
        ).toEqual([{ watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'guardian-sync-realign' }]);
      } finally {
        restoreTimers();
      }
    });

    // #1233: Stage 2 pushes local state only when it IS the chain's. Each refusal below persists
    // against a local copy that is not the on-chain state, or a chain that cannot be read, so
    // nothing is pushed and the run ends on the original refusal: form 2 is the common real trigger
    // (another device's newer state that the guardian is still canonicalizing), and form 1 with the
    // guardian matching the chain would push a phantom.
    const FORM_2 =
      'Refusing to overwrite local state: incoming commitment does not match on-chain commitment for account acc-id';
    const FORM_1 =
      'Refusing to overwrite local state: incoming nonce 4 equals local nonce 4 but commitments differ for account acc-id';
    const LOCAL_NOT_CHAIN = 'Local account commitment does not match on-chain commitment for account acc-id';
    it.each([
      ['form 2, a guardian ahead of a stale local copy', FORM_2, LOCAL_NOT_CHAIN],
      ['form 1, a guardian that matches the chain', FORM_1, LOCAL_NOT_CHAIN],
      ['form 2 with a chain that cannot be read', FORM_2, 'On-chain account details not found for account acc-id']
    ])('does not push local state at Stage 2 on %s (#1233)', async (_label, refusal, verifyFailure) => {
      const restoreTimers = skipRetryBackoffs();
      const syncState = jest.fn(async () => {
        throw new Error(refusal);
      });
      const registerOnGuardian = jest.fn(async () => {});
      const verifyStateCommitment = jest.fn(async () => {
        throw new Error(verifyFailure);
      });
      const multisig = makeMultisig({ syncState, registerOnGuardian, verifyStateCommitment });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      mockGetAccount.mockResolvedValue({ serialize: () => new Uint8Array([1, 2, 3]) });

      try {
        await expect(service.sync()).rejects.toThrow(refusal);
        expect(verifyStateCommitment).toHaveBeenCalledTimes(1);
        expect(mockGetAccount).not.toHaveBeenCalled();
        expect(registerOnGuardian).not.toHaveBeenCalled();
        // The initial attempt and the thirty waited retries; the last-resort push was refused.
        expect(syncState).toHaveBeenCalledTimes(31);
      } finally {
        restoreTimers();
      }
    });

    it('rethrows a sync error that only mentions a commitment mismatch at once (#1233)', async () => {
      const restoreTimers = skipRetryBackoffs();
      const syncState = jest.fn(async () => {
        throw new Error('GUARDIAN public key commitment mismatch');
      });
      const registerOnGuardian = jest.fn(async () => {});
      const multisig = makeMultisig({ syncState, registerOnGuardian });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      mockGetAccount.mockResolvedValue({ serialize: () => new Uint8Array([1]) });

      try {
        await expect(service.sync()).rejects.toThrow('GUARDIAN public key commitment mismatch');
        // Not a canonicalizing guardian: no wait, and never the last-resort push.
        expect(syncState).toHaveBeenCalledTimes(1);
        expect(registerOnGuardian).not.toHaveBeenCalled();
      } finally {
        restoreTimers();
      }
    });
  });

  describe('reRegisterCurrentStateOnGuardian', () => {
    it('syncs, serializes the current account, and re-registers it on the guardian', async () => {
      const registerOnGuardian = jest.fn(async () => {});
      const multisig = makeMultisig({ registerOnGuardian });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      mockGetAccount.mockResolvedValue({ serialize: () => new Uint8Array([0xaa, 0xbb]) });

      await service.reRegisterCurrentStateOnGuardian();

      expect(mockSyncState).toHaveBeenCalled();
      expect(multisig.verifyStateCommitment).toHaveBeenCalledTimes(1);
      expect(registerOnGuardian).toHaveBeenCalledTimes(1);
    });

    it('throws when the account is missing from the local client', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      mockGetAccount.mockResolvedValue(null);
      const onPushStart = jest.fn();

      await expect(service.reRegisterCurrentStateOnGuardian(undefined, onPushStart)).rejects.toThrow(
        'missing from local client'
      );
      expect(onPushStart).not.toHaveBeenCalled();
    });

    it('fails a state sync before the push starts, and registers nothing', async () => {
      const syncError = new Error('node unreachable');
      mockSyncState.mockRejectedValueOnce(syncError);
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const onPushStart = jest.fn();

      await expect(service.reRegisterCurrentStateOnGuardian(undefined, onPushStart)).rejects.toBe(syncError);
      expect(onPushStart).not.toHaveBeenCalled();
      expect(multisig.verifyStateCommitment).not.toHaveBeenCalled();
      expect(mockGetAccount).not.toHaveBeenCalled();
      expect(multisig.registerOnGuardian).not.toHaveBeenCalled();
    });

    it('fails a watchdog rejection of the hold itself before the push starts', async () => {
      const evicted = new WasmClientPoisonedError('watchdog');
      beforeWasmHold = () => {
        throw evicted;
      };
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const onPushStart = jest.fn();

      try {
        await expect(service.reRegisterCurrentStateOnGuardian(undefined, onPushStart)).rejects.toBe(evicted);
      } finally {
        beforeWasmHold = undefined;
      }
      expect(onPushStart).not.toHaveBeenCalled();
      expect(mockSyncState).not.toHaveBeenCalled();
      expect(multisig.registerOnGuardian).not.toHaveBeenCalled();
    });

    it('starts the push once, before the first registration attempt, when the push fails', async () => {
      const restoreTimers = skipRetryBackoffs();
      const registerOnGuardian = jest.fn(async () => {
        throw new Error('guardian down');
      });
      const multisig = makeMultisig({ registerOnGuardian });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      mockGetAccount.mockResolvedValue({ serialize: () => new Uint8Array([0xaa, 0xbb]) });
      const onPushStart = jest.fn();

      let error: unknown;
      try {
        error = await service
          .reRegisterCurrentStateOnGuardian(undefined, onPushStart)
          .catch((caught: unknown) => caught);
      } finally {
        restoreTimers();
      }

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(GuardianReRegisterRefusedError);
      expect(registerOnGuardian).toHaveBeenCalledTimes(8);
      expect(onPushStart).toHaveBeenCalledTimes(1);
      expect(onPushStart.mock.invocationCallOrder[0]).toBeLessThan(registerOnGuardian.mock.invocationCallOrder[0]!);
    });

    it('hands the push-start callback the signer set it derived from the chain-verified account (#1233)', async () => {
      const service = new MultisigService(makeMultisig() as never, {} as never, 'https://x');
      mockGetAccount.mockResolvedValue({ serialize: () => new Uint8Array([0xaa, 0xbb]) });
      mockAccountInspectorFromAccount.mockReturnValue({ signerCommitments: ['0xnewhot', '0xcold'] });
      const onPushStart = jest.fn();

      await service.reRegisterCurrentStateOnGuardian(undefined, onPushStart);

      expect(onPushStart).toHaveBeenCalledTimes(1);
      expect(onPushStart).toHaveBeenCalledWith(['0xnewhot', '0xcold']);
    });

    it('holds its lock on the options a caller passes, and on the default hold otherwise', async () => {
      const service = new MultisigService(makeMultisig() as never, {} as never, 'https://x');
      mockGetAccount.mockResolvedValue({ serialize: () => new Uint8Array([0xaa, 0xbb]) });
      const options = { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'guardian-self-heal-reregister' };
      wasmLockOptionsSeen.length = 0;

      await service.reRegisterCurrentStateOnGuardian(options);
      await service.reRegisterCurrentStateOnGuardian();

      expect(wasmLockOptionsSeen).toEqual([options, undefined]);
    });

    it('re-derives the guardian allowlist from the fresh on-chain account before registering (#619 gap 3)', async () => {
      // The multisig was loaded from a possibly-stale guardian blob, so its
      // cached signerCommitments still hold the PRE-rotation [old-hot, cold].
      let commitmentsAtRegisterTime: string[] | undefined;
      const registerOnGuardian = jest.fn(async () => {
        commitmentsAtRegisterTime = [...(multisig as unknown as { signerCommitments: string[] }).signerCommitments];
      });
      const multisig = makeMultisig({
        registerOnGuardian,
        signerCommitments: ['0xoldhot', '0xcold']
      });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const freshAccount = { serialize: () => new Uint8Array([1, 2, 3]) };
      mockGetAccount.mockResolvedValue(freshAccount);
      // The freshly-synced on-chain account resolves to the POST-rotation set.
      mockAccountInspectorFromAccount.mockReturnValue({ signerCommitments: ['0xnewhot', '0xcold'] });

      await service.reRegisterCurrentStateOnGuardian();

      // The allowlist is refreshed from the fresh account (byte-identical to the
      // vendored client.load derivation) AND is in place BEFORE registering, so
      // the guardian gets [new-hot, cold], not the stale [old-hot, cold] that
      // would re-trigger the permanent-401.
      expect(mockAccountInspectorFromAccount).toHaveBeenCalledWith(freshAccount);
      expect((multisig as unknown as { signerCommitments: string[] }).signerCommitments).toEqual([
        '0xnewhot',
        '0xcold'
      ]);
      expect(commitmentsAtRegisterTime).toEqual(['0xnewhot', '0xcold']);
    });

    // #788 follow-up: this method is reachable from the BACKGROUND runSync
    // stage-2 last resort, i.e. exactly the unattended loop whose failure mode is
    // a client parked on a node that never answers — the population the watchdog
    // eviction exists for. Pre-registration throughout, so stopping is safe.
    it('stops before the account read when the hold is evicted during the sync (#788)', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      mockSyncState.mockImplementationOnce(async () => {
        currentWasmHold = null;
      });
      const onPushStart = jest.fn();

      await expect(service.reRegisterCurrentStateOnGuardian(undefined, onPushStart)).rejects.toMatchObject({
        name: 'WasmClientPoisonedError'
      });
      expect(onPushStart).not.toHaveBeenCalled();
      expect(mockGetAccount).not.toHaveBeenCalled();
      expect(multisig.registerOnGuardian).not.toHaveBeenCalled();
    });

    it('stops before the allowlist derive when the hold is evicted during the account read (#788)', async () => {
      const multisig = makeMultisig({ signerCommitments: ['0xhot', '0xcold'] });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const serialize = jest.fn(() => new Uint8Array([1]));
      mockGetAccount.mockImplementationOnce(async () => {
        currentWasmHold = null;
        return { serialize };
      });
      const onPushStart = jest.fn();

      await expect(service.reRegisterCurrentStateOnGuardian(undefined, onPushStart)).rejects.toMatchObject({
        name: 'WasmClientPoisonedError'
      });
      expect(onPushStart).not.toHaveBeenCalled();
      // Both post-read touches are borrows: the inspector walks account storage
      // and serialize() reads through the same RefCell.
      expect(mockAccountInspectorFromAccount).not.toHaveBeenCalled();
      expect(serialize).not.toHaveBeenCalled();
      // The cached allowlist survives an abandoned read untouched.
      expect((multisig as unknown as { signerCommitments: string[] }).signerCommitments).toEqual(['0xhot', '0xcold']);
      expect(multisig.registerOnGuardian).not.toHaveBeenCalled();
    });

    it('keeps the cached allowlist (does NOT overwrite with empty) when the fresh account reads back no signers', async () => {
      // A truncated storage read yields an empty set from AccountInspector;
      // overwriting a good allowlist with [] would re-arm the 401 this prevents.
      const registerOnGuardian = jest.fn(async () => {});
      const multisig = makeMultisig({ registerOnGuardian, signerCommitments: ['0xhot', '0xcold'] });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      mockGetAccount.mockResolvedValue({ serialize: () => new Uint8Array([1]) });
      mockAccountInspectorFromAccount.mockReturnValue({ signerCommitments: [] });

      await service.reRegisterCurrentStateOnGuardian();

      // cached set preserved, and the state blob is still pushed (best-effort).
      expect((multisig as unknown as { signerCommitments: string[] }).signerCommitments).toEqual(['0xhot', '0xcold']);
      expect(registerOnGuardian).toHaveBeenCalledTimes(1);
    });

    it('refuses a local copy that is not the on-chain state, writing nothing (#1233)', async () => {
      const mismatch = new Error('Local account commitment does not match on-chain commitment for account acc-id');
      const registerOnGuardian = jest.fn(async () => {});
      const multisig = makeMultisig({
        registerOnGuardian,
        verifyStateCommitment: jest.fn(async () => {
          throw mismatch;
        })
      });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      const error = await service.reRegisterCurrentStateOnGuardian().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(GuardianReRegisterRefusedError);
      expect(error).toHaveProperty('cause', mismatch);
      expect(mockGetAccount).not.toHaveBeenCalled();
      expect(registerOnGuardian).not.toHaveBeenCalled();
    });

    it('does not push when the chain commitment cannot be read (#1233)', async () => {
      const registerOnGuardian = jest.fn(async () => {});
      const multisig = makeMultisig({
        registerOnGuardian,
        verifyStateCommitment: jest.fn(async () => {
          throw new Error('On-chain account details not found for account acc-id');
        })
      });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      await expect(service.reRegisterCurrentStateOnGuardian()).rejects.toBeInstanceOf(GuardianReRegisterRefusedError);
      expect(registerOnGuardian).not.toHaveBeenCalled();
    });

    it('stops before the account read when the hold is evicted during the chain check (#1233)', async () => {
      const multisig = makeMultisig({
        verifyStateCommitment: jest.fn(async () => {
          currentWasmHold = null;
          return { accountId: 'acc-id', localCommitment: '0xc0', onChainCommitment: '0xc0' };
        })
      });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const onPushStart = jest.fn();

      await expect(service.reRegisterCurrentStateOnGuardian(undefined, onPushStart)).rejects.toMatchObject({
        name: 'WasmClientPoisonedError'
      });
      expect(onPushStart).not.toHaveBeenCalled();
      expect(mockGetAccount).not.toHaveBeenCalled();
      expect(multisig.registerOnGuardian).not.toHaveBeenCalled();
    });
  });

  describe('importAccountFromGuardian', () => {
    const signWordFn = jest.fn(async () => 'sig');

    beforeEach(() => {
      guardianConfig.setSigner.mockReset();
      guardianConfig.getState.mockReset();
    });

    it('fetches state, base64-decodes into Account, and adopts it through the staleness guard', async () => {
      const webClient = {
        accounts: { insert: jest.fn(async () => {}) }
      };
      const stateBase64 = Buffer.from('hello').toString('base64');
      guardianConfig.getState.mockResolvedValueOnce({ stateJson: { data: stateBase64 } });
      const fakeAccount = { id: () => ({ toString: () => 'acc-id' }) };
      mockAccountDeserialize.mockReturnValueOnce(fakeAccount);

      await MultisigService.importAccountFromGuardian('pub', 'commit', signWordFn, 'acc-id', webClient as never);

      expect(guardianConfig.setSigner).toHaveBeenCalled();
      expect(mockAccountDeserialize).toHaveBeenCalled();
      // Routed through the guard, never straight to accounts.insert — an
      // unguarded overwrite here is what let a stale snapshot win.
      expect(mockInsertGuardianAccountMonotonically).toHaveBeenCalledWith(webClient, fakeAccount);
      expect(webClient.accounts.insert).not.toHaveBeenCalled();
    });

    it('rejects (and does not insert) when the guardian returns a mismatched account id', async () => {
      const webClient = { accounts: { insert: jest.fn(async () => {}) } };
      const stateBase64 = Buffer.from('evil').toString('base64');
      guardianConfig.getState.mockResolvedValueOnce({ stateJson: { data: stateBase64 } });
      mockAccountDeserialize.mockReturnValueOnce({ id: () => ({ toString: () => 'attacker-acc' }) });

      await expect(
        MultisigService.importAccountFromGuardian('pub', 'commit', signWordFn, 'acc-id', webClient as never)
      ).rejects.toThrow('Guardian returned account attacker-acc but acc-id was requested');
      expect(webClient.accounts.insert).not.toHaveBeenCalled();
    });

    it('re-throws when the guardian state fetch fails', async () => {
      const webClient = { accounts: { insert: jest.fn() } };
      guardianConfig.getState.mockRejectedValueOnce(new Error('404'));

      await expect(
        MultisigService.importAccountFromGuardian('pub', 'commit', signWordFn, 'acc-id', webClient as never)
      ).rejects.toThrow('404');
      expect(webClient.accounts.insert).not.toHaveBeenCalled();
    });

    it('binds to the network default WITHOUT reading the frozen global key', async () => {
      // #408 stage 3: importAccountFromGuardian no longer reads
      // GUARDIAN_URL_STORAGE_KEY — it binds to the effective network default.
      // (No production callers today; a future non-default import must thread a
      // per-account endpoint rather than reintroduce a global-key read.)
      const webClient = { accounts: { insert: jest.fn(async () => {}) } };
      const stateBase64 = Buffer.from('hi').toString('base64');
      guardianConfig.getState.mockResolvedValueOnce({ stateJson: { data: stateBase64 } });
      mockAccountDeserialize.mockReturnValueOnce({ id: () => ({ toString: () => 'acc-id' }) });

      await MultisigService.importAccountFromGuardian('pub', 'commit', signWordFn, 'acc-id', webClient as never);

      // Reached the adoption step, i.e. the import ran to completion.
      expect(mockInsertGuardianAccountMonotonically).toHaveBeenCalled();
      // The global-key read is gone: storage is never consulted for the import.
      expect(mockFetchFromStorage).not.toHaveBeenCalled();
    });
  });

  describe('init', () => {
    it('loads the Multisig for an existing account and binds the passed endpoint', async () => {
      const account = { id: () => ({ toString: () => 'acc-id' }) } as never;
      const loaded = makeMultisig();
      multisigClientConfig.load.mockResolvedValueOnce(loaded);

      const svc = await MultisigService.init(account, 'pub', 'commit', async () => 'sig', 'https://acct.guardian');

      expect(svc).toBeInstanceOf(MultisigService);
      expect(svc.multisig).toBe(loaded);
      // Endpoint is supplied by the caller (per-account), not read from storage.
      expect(svc.guardianEndpoint).toBe('https://acct.guardian');
    });

    it('stops before load() when the hold was evicted during the client build (#777)', async () => {
      // Reachable from the unattended guardian sync loop, whose failure mode is exactly a
      // client that parks on a node that never answers. Past the eviction the mutex is
      // somebody else's, and `load()` is a WASM call on the client it now owns.
      const account = { id: () => ({ toString: () => 'acc-id' }) } as never;
      multisigClientConfig.load.mockClear();
      evictDuringClientBuild = true;

      await expect(
        MultisigService.init(account, 'pub', 'commit', async () => 'sig', 'https://acct.guardian')
      ).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
      expect(multisigClientConfig.load).not.toHaveBeenCalled();

      // Falsifier: with the hold intact the same init loads as before.
      evictDuringClientBuild = false;
      await MultisigService.init(account, 'pub', 'commit', async () => 'sig', 'https://acct.guardian');
      expect(multisigClientConfig.load).toHaveBeenCalledTimes(1);
    });

    it('re-throws when MultisigClient.load rejects', async () => {
      const account = { id: () => ({ toString: () => 'acc-id' }) } as never;
      multisigClientConfig.load.mockRejectedValueOnce(new Error('load failed'));

      await expect(
        MultisigService.init(account, 'pub', 'commit', async () => 'sig', 'https://acct.guardian')
      ).rejects.toThrow('load failed');
    });

    it('holds its lock on the options a caller passes, and on the default hold otherwise', async () => {
      const account = { id: () => ({ toString: () => 'acc-id' }) } as never;
      const options = { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'guardian-adopt-init' };
      wasmLockOptionsSeen.length = 0;

      await MultisigService.init(account, 'pub', 'commit', async () => 'sig', 'https://acct.guardian', options);
      await MultisigService.init(account, 'pub', 'commit', async () => 'sig', 'https://acct.guardian');

      expect(wasmLockOptionsSeen).toEqual([options, undefined]);
    });

    it('reports how long it held its lock, from acquisition, even when load fails', async () => {
      const account = { id: () => ({ toString: () => 'acc-id' }) } as never;
      let now = 0;
      const perfSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);
      beforeWasmHold = () => {
        now += 4_000;
      };
      multisigClientConfig.load.mockImplementationOnce(async () => {
        now += 7_000;
        throw new Error('load failed');
      });
      const onHeld = jest.fn();

      try {
        await expect(
          MultisigService.init(account, 'pub', 'commit', async () => 'sig', 'https://acct.guardian', undefined, onHeld)
        ).rejects.toThrow('load failed');
      } finally {
        beforeWasmHold = undefined;
        perfSpy.mockRestore();
      }

      expect(onHeld).toHaveBeenCalledWith(7_000);
    });
  });

  describe('guardian switch', () => {
    // A real `GET /pubkey` commitment is a 32-byte word, and the switch path now
    // refuses anything else before it reaches the transaction script.
    const NEW_GUARDIAN_COMMITMENT = `0x${'ab'.repeat(32)}`;

    beforeEach(() => {
      resetMockProbes();
    });

    it('createSwitchGuardianProposal builds the proposal from the new guardian commitment and keeps its origin', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://old');
      guardianConfig.getPubkey.mockResolvedValueOnce({ commitment: NEW_GUARDIAN_COMMITMENT, pubkey: 'new-pubkey' });

      const { newEndpoint } = await service.createSwitchGuardianProposal('https://new');

      expect(newEndpoint).toBe('https://new');
      expect(multisig.createSwitchGuardianProposal).toHaveBeenCalledWith('https://new', NEW_GUARDIAN_COMMITMENT);
      // `createSwitchGuardianProposal` already creates the proposal — it must NOT
      // be re-created via the generic `createProposal` (that would duplicate it).
      expect(multisig.createProposal).not.toHaveBeenCalled();
      // On mobile the new endpoint stays routed through native HTTP once its key checks out.
      expect(mockProbeVerdicts).toEqual([['https://new', true]]);
    });

    it('createSwitchGuardianProposal re-throws when the new guardian fetch fails and releases its origin', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://old');
      guardianConfig.getPubkey.mockRejectedValueOnce(new Error('unreachable'));

      await expect(service.createSwitchGuardianProposal('https://new')).rejects.toThrow('unreachable');
      expect(mockProbeVerdicts).toEqual([['https://new', false]]);
    });

    // The SDK interpolates this value into MASM source after a `normalizeHexWord`
    // that only lowercases and left-pads to 64, so an over-long response passes
    // through with whatever followed it — including newlines. The coordinated path
    // has the same sink as the direct one and gets the same guard.
    it('createSwitchGuardianProposal refuses a malformed commitment and releases the new origin', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://old');
      guardianConfig.getPubkey.mockResolvedValueOnce({
        commitment: `${'0'.repeat(64)}\ncall.0x${'1'.repeat(64)}`,
        pubkey: 'new-pubkey'
      });

      await expect(service.createSwitchGuardianProposal('https://new')).rejects.toThrow('malformed key commitment');
      expect(multisig.createSwitchGuardianProposal).not.toHaveBeenCalled();
      expect(mockProbeVerdicts).toEqual([['https://new', false]]);
    });

    // The probe settles only when its check does, so a new guardian that never answers would hold
    // its origin routed for the session unless the check carries its own deadline.
    it('createSwitchGuardianProposal gives up on a new guardian whose pubkey never answers and releases its origin', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://old');
      guardianConfig.getPubkey.mockImplementationOnce(() => new Promise(() => {}));

      jest.useFakeTimers();
      try {
        let outcome: string | undefined;
        void service.createSwitchGuardianProposal('https://new').then(
          () => {
            outcome = 'resolved';
          },
          (err: Error) => {
            outcome = err.message;
          }
        );
        // The check runs before the commit, so the post-commit deadline must not end it.
        await jest.advanceTimersByTimeAsync(POST_COMMIT_GUARDIAN_TIMEOUT_MS + 1);
        expect(outcome).toBeUndefined();
        await jest.advanceTimersByTimeAsync(NEW_GUARDIAN_PUBKEY_TIMEOUT_MS - POST_COMMIT_GUARDIAN_TIMEOUT_MS);
        expect(outcome).toMatch(/pubkey fetch timed out/);
      } finally {
        jest.useRealTimers();
      }
      expect(multisig.createSwitchGuardianProposal).not.toHaveBeenCalled();
      expect(mockProbeVerdicts).toEqual([['https://new', false]]);
    });

    // A service that has signed a switch proposal, ready to finalize it; the history read answers with `delta`.
    const setUpSignedSwitch = async () => {
      const multisig = makeMultisig({
        signProposal: jest.fn(async () => ({ metadata: { proposalType: 'switch_guardian' } }))
      });
      multisigClientConfig.load.mockResolvedValueOnce(multisig);
      mockAccountDeserialize.mockReturnValueOnce({ id: () => ({ toString: () => 'acc-id' }) });
      const account = Account.deserialize(new Uint8Array());
      const service = await MultisigService.init(account, 'key', 'commitment', jest.fn(), 'https://old');
      const delta = {
        accountId: 'acc-id',
        nonce: 5,
        prevCommitment: 'previous',
        deltaPayload: { txSummary: { data: 'summary' }, signatures: [] }
      };
      guardianConfig.getDeltaProposal.mockResolvedValueOnce(delta);
      await service.signAndCreateTransactionRequest('proposal-id');
      return { multisig, service, delta };
    };
    const queueFinalize = () => {
      mockGetAccount.mockResolvedValueOnce({ serialize: () => new Uint8Array([1]) });
      guardianConfig.getPubkey.mockResolvedValueOnce({ commitment: NEW_GUARDIAN_COMMITMENT });
    };
    const flushPush = () => new Promise(resolve => setTimeout(resolve, 0));

    it.each([false, true])(
      'records switch history on the old operator without holding up registration (old source fails: %s)',
      async fails => {
        const { multisig, service, delta } = await setUpSignedSwitch();
        guardianConfig.pushDelta.mockImplementationOnce(async () => {
          if (fails) throw new Error('Old Guardian is unavailable');
        });
        queueFinalize();

        expect(guardianConfig.pushDelta).not.toHaveBeenCalled();
        await service.finalizeGuardianSwitch('https://new');
        await flushPush();

        expect(guardianConfig.getDeltaProposal).toHaveBeenCalledWith('acc-id', 'proposal-id');
        expect(guardianConfig.pushDelta).toHaveBeenCalledWith({ ...delta, deltaPayload: { data: 'summary' } });
        expect(multisig.registerOnGuardian).toHaveBeenCalledWith('base64-bytes');
        const constructed = jest.mocked(GuardianHttpClient).mock;
        const pushedOn = constructed.results.findIndex(
          result => result.value === guardianConfig.pushDelta.mock.contexts[0]
        );
        expect(constructed.calls[pushedOn]?.[0]).toBe('https://old');
      }
    );

    it('registers on the new Guardian while the old operator never answers, and returns once the history read times out', async () => {
      const { multisig, service } = await setUpSignedSwitch();
      guardianConfig.getDeltaProposal.mockReset();
      guardianConfig.getDeltaProposal.mockImplementationOnce(() => new Promise(() => {}));
      queueFinalize();

      jest.useFakeTimers();
      try {
        let settled = false;
        void service.finalizeGuardianSwitch('https://new').then(() => {
          settled = true;
        });
        await jest.advanceTimersByTimeAsync(POST_COMMIT_GUARDIAN_TIMEOUT_MS - 1);
        expect(multisig.registerOnGuardian).toHaveBeenCalledWith('base64-bytes');
        expect(settled).toBe(false);

        await jest.advanceTimersByTimeAsync(2);
        expect(settled).toBe(true);
      } finally {
        jest.useRealTimers();
        // A finalize left waiting on the push would leave its queued results to the next test.
        mockGetAccount.mockReset();
        guardianConfig.getPubkey.mockReset();
      }
    });

    it('returns only after the history push, so the push signs inside the switch', async () => {
      const { multisig, service, delta } = await setUpSignedSwitch();
      let answerHistory: (value: typeof delta) => void = () => {};
      guardianConfig.getDeltaProposal.mockReset();
      guardianConfig.getDeltaProposal.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            answerHistory = resolve;
          })
      );
      queueFinalize();

      let settled = false;
      const finalized = service.finalizeGuardianSwitch('https://new').then(() => {
        settled = true;
      });
      // A macrotask at a time: finalize would resolve a few microtasks after registration if it did not wait.
      while (!multisig.registerOnGuardian.mock.calls.length) await flushPush();
      await flushPush();
      expect(settled).toBe(false);
      expect(guardianConfig.pushDelta).not.toHaveBeenCalled();

      answerHistory(delta);
      await finalized;
      expect(guardianConfig.pushDelta).toHaveBeenCalledWith({ ...delta, deltaPayload: { data: 'summary' } });
    });

    it("pushes a switch's history at most once, even after a failed push", async () => {
      const { multisig, service } = await setUpSignedSwitch();
      guardianConfig.pushDelta.mockRejectedValueOnce(new Error('Old Guardian is unavailable'));
      queueFinalize();
      queueFinalize();

      await service.finalizeGuardianSwitch('https://new');
      await flushPush();
      await service.finalizeGuardianSwitch('https://new');
      await flushPush();

      expect(guardianConfig.getDeltaProposal).toHaveBeenCalledTimes(1);
      expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(2);
    });

    it('finalizeGuardianSwitch serializes post-switch state and re-registers with the new guardian', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://old');
      mockGetAccount.mockResolvedValueOnce({ serialize: () => new Uint8Array([1]) });
      guardianConfig.getPubkey.mockResolvedValueOnce({ commitment: NEW_GUARDIAN_COMMITMENT, pubkey: 'new-pubkey' });

      await service.finalizeGuardianSwitch('https://new');

      expect(mockSyncState).toHaveBeenCalled();
      expect(multisig.setGuardianClient).toHaveBeenCalled();
      expect(multisig.guardianPublicKey).toBe(NEW_GUARDIAN_COMMITMENT);
      expect(service.guardianEndpoint).toBe('https://new');
      expect(multisig.registerOnGuardian).toHaveBeenCalledWith('base64-bytes');
    });

    // The post-commit sibling of the proposal-path guard above, and it needed its
    // own case: every other `finalizeGuardianSwitch` test feeds a well-formed
    // 32-byte word, so the validation could be deleted with all of them still
    // green. `commitment` becomes `multisig.guardianPublicKey`, which is what the
    // co-signing config is built from, so a non-commitment stored here surfaces
    // later as an opaque authorization failure rather than a named refusal.
    it.each([
      ['an over-long body with MASM appended', `${'0'.repeat(64)}\ncall.0x${'1'.repeat(64)}`],
      ['a non-string body', 1234]
    ])('finalizeGuardianSwitch refuses %s from the new guardian', async (_label, commitment) => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://old');
      mockGetAccount.mockResolvedValueOnce({ serialize: () => new Uint8Array([1]) });
      guardianConfig.getPubkey.mockResolvedValueOnce({ commitment, pubkey: 'new-pubkey' });

      await expect(service.finalizeGuardianSwitch('https://new')).rejects.toThrow('malformed key commitment');
      // Throwing before any of the three writes is the point: a half-configured
      // service pointed at the new operator with an unusable key is worse than a
      // refusal the caller books as `registerFailed` and the self-heal retries.
      expect(multisig.setGuardianClient).not.toHaveBeenCalled();
      expect(multisig.registerOnGuardian).not.toHaveBeenCalled();
    });

    it('finalizeGuardianSwitch throws when the SDK has no record of the switched account', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://old');
      mockGetAccount.mockResolvedValueOnce(null);

      await expect(service.finalizeGuardianSwitch('https://new')).rejects.toThrow(
        `Updated account acc-id is missing from local client`
      );
      expect(multisig.registerOnGuardian).not.toHaveBeenCalled();
    });

    // #788 follow-up: syncState is the canonical parking await (a node that never
    // answers), and both the account read and its serialize() are borrows of the
    // client's RefCell. Everything in this hold is pre-registration, so stopping
    // an abandoned finalize is strictly cheaper than the double borrow.
    it('finalizeGuardianSwitch stops before the account read when the hold is evicted during the sync', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://old');
      mockSyncState.mockImplementationOnce(async () => {
        currentWasmHold = null;
      });

      await expect(service.finalizeGuardianSwitch('https://new')).rejects.toMatchObject({
        name: 'WasmClientPoisonedError'
      });
      expect(mockGetAccount).not.toHaveBeenCalled();
      expect(multisig.setGuardianClient).not.toHaveBeenCalled();
      expect(multisig.registerOnGuardian).not.toHaveBeenCalled();
    });

    it('finalizeGuardianSwitch stops before serializing when the hold is evicted during the account read', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://old');
      const serialize = jest.fn(() => new Uint8Array([1]));
      mockGetAccount.mockImplementationOnce(async () => {
        currentWasmHold = null;
        return { serialize };
      });

      await expect(service.finalizeGuardianSwitch('https://new')).rejects.toMatchObject({
        name: 'WasmClientPoisonedError'
      });
      expect(serialize).not.toHaveBeenCalled();
      expect(multisig.setGuardianClient).not.toHaveBeenCalled();
      expect(multisig.registerOnGuardian).not.toHaveBeenCalled();
    });

    it('finalizeGuardianSwitch retries a transient registration failure then succeeds', async () => {
      const restoreTimers = skipRetryBackoffs();

      const multisig = makeMultisig({
        registerOnGuardian: jest.fn().mockRejectedValueOnce(new Error('guardian down')).mockResolvedValueOnce(undefined)
      });
      const service = new MultisigService(multisig as never, {} as never, 'https://old');
      mockGetAccount.mockResolvedValueOnce({ serialize: () => new Uint8Array([1]) });
      guardianConfig.getPubkey.mockResolvedValueOnce({ commitment: NEW_GUARDIAN_COMMITMENT, pubkey: 'new-pubkey' });

      try {
        await service.finalizeGuardianSwitch('https://new');
        expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(2);
      } finally {
        restoreTimers();
      }
    });

    // Both calls this makes to the NEW guardian sit PAST the on-chain commit, and
    // `GuardianHttpClient` uses bare `fetch` with no `AbortSignal` — so an operator
    // that accepts the connection and then goes silent produces no error at all.
    // The retry budget bounds REJECTIONS and never advances on silence, so an
    // unbounded wait here parks `completeSwitchGuardianTransaction` before its
    // terminal status write: a committed rotation stuck at GeneratingTransaction,
    // with `registerFailed` — the flag whose self-heal would finish the job —
    // never written. F-144 bounded the endpoint persist beside it and left these.
    it('finalizeGuardianSwitch gives up on a new guardian whose /pubkey never answers', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://old');
      mockGetAccount.mockResolvedValueOnce({ serialize: () => new Uint8Array([1]) });
      guardianConfig.getPubkey.mockImplementationOnce(() => new Promise(() => {}));

      jest.useFakeTimers();
      try {
        // Reduced to a value BEFORE advancing: the rejection has to have a handler
        // attached while the timers move, or it lands as an unhandled rejection.
        const outcome = service.finalizeGuardianSwitch('https://new').then(
          () => 'resolved',
          (err: Error) => err.message
        );
        await jest.advanceTimersByTimeAsync(POST_COMMIT_GUARDIAN_TIMEOUT_MS + 1);
        expect(await outcome).toMatch(/timed out/);
      } finally {
        jest.useRealTimers();
      }
      expect(multisig.registerOnGuardian).not.toHaveBeenCalled();
    });

    it('finalizeGuardianSwitch gives up on a new guardian whose registration never answers', async () => {
      const multisig = makeMultisig({ registerOnGuardian: jest.fn(() => new Promise(() => {})) });
      const service = new MultisigService(multisig as never, {} as never, 'https://old');
      mockGetAccount.mockResolvedValueOnce({ serialize: () => new Uint8Array([1]) });
      guardianConfig.getPubkey.mockResolvedValueOnce({ commitment: NEW_GUARDIAN_COMMITMENT, pubkey: 'new-pubkey' });

      jest.useFakeTimers();
      try {
        const outcome = service.finalizeGuardianSwitch('https://new').then(
          () => 'resolved',
          (err: Error) => err.message
        );
        // Every attempt has to expire on its own deadline, so the whole budget is
        // what bounds the silence — and it terminates.
        await jest.advanceTimersByTimeAsync(POST_COMMIT_GUARDIAN_TIMEOUT_MS * 10 + 60_000 * 10);
        expect(await outcome).toMatch('Failed to register account on the new guardian');
      } finally {
        jest.useRealTimers();
      }
    });

    // Newly reachable now that an attempt can TIME OUT: a `/configure` the server
    // applied but answered too late leaves the account registered, and the next
    // attempt says so. Retrying that into a failure would report `registerFailed`
    // for a state that needs no healing, arming a self-heal against nothing.
    it('finalizeGuardianSwitch treats "already registered" as the goal state', async () => {
      const alreadyThere = Object.assign(new Error('nope'), { code: 'account_already_exists' });
      const multisig = makeMultisig({ registerOnGuardian: jest.fn(async () => Promise.reject(alreadyThere)) });
      const service = new MultisigService(multisig as never, {} as never, 'https://old');
      mockGetAccount.mockResolvedValueOnce({ serialize: () => new Uint8Array([1]) });
      guardianConfig.getPubkey.mockResolvedValueOnce({ commitment: NEW_GUARDIAN_COMMITMENT, pubkey: 'new-pubkey' });

      await expect(service.finalizeGuardianSwitch('https://new')).resolves.toBeUndefined();
      // Not retried into the budget — one look is enough.
      expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(1);
    });

    it('finalizeGuardianSwitch throws after exhausting registration retries', async () => {
      const restoreTimers = skipRetryBackoffs();

      const multisig = makeMultisig({
        registerOnGuardian: jest.fn(async () => Promise.reject(new Error('guardian down')))
      });
      const service = new MultisigService(multisig as never, {} as never, 'https://old');
      mockGetAccount.mockResolvedValueOnce({ serialize: () => new Uint8Array([1]) });
      guardianConfig.getPubkey.mockResolvedValueOnce({ commitment: NEW_GUARDIAN_COMMITMENT, pubkey: 'new-pubkey' });

      try {
        await expect(service.finalizeGuardianSwitch('https://new')).rejects.toThrow(
          'Failed to register account on the new guardian after switching'
        );
        // GUARDIAN_RETRY_MAX_ATTEMPTS attempts.
        expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(8);
      } finally {
        restoreTimers();
      }
    });
  });

  describe('signProposal pass-through', () => {
    it('forwards signProposal to the wrapped Multisig and does not finalize the proposal', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      await service.signProposal('p-3');

      expect(multisig.signProposal).toHaveBeenCalledWith('p-3');
      expect(multisig.executeProposal).not.toHaveBeenCalled();
      expect(multisig.createTransactionProposalRequest).not.toHaveBeenCalled();
    });
  });

  describe('buildColdMultisigService', () => {
    it('reads the cold commitment from on-chain via getSignerDetailsFromAccount(_, true) and inits a service with cold pubkey', async () => {
      const account = { id: () => ({ toString: () => 'acc-id' }) } as never;
      const walletAccount = { publicKey: 'acc-id', coldPublicKey: 'cold-pub' } as never;
      const loaded = makeMultisig();
      multisigClientConfig.load.mockResolvedValueOnce(loaded);
      mockGetSignerDetailsFromAccount.mockResolvedValueOnce({ commitment: 'cold-commit-no-prefix' });

      const signWordFn = jest.fn(async () => 'sig');
      const svc = await MultisigService.buildColdMultisigService(account, walletAccount, signWordFn);

      expect(mockGetSignerDetailsFromAccount).toHaveBeenCalledWith(account, true);
      expect(svc).toBeInstanceOf(MultisigService);
      // The service initialized via init forwards the COLD pubkey/commitment
      // (each prefixed with 0x) to the WalletSigner. We can't introspect that
      // directly here, so we assert load was called — proving init proceeded.
      expect(multisigClientConfig.load).toHaveBeenCalledWith('acc-id', expect.anything());
      // Endpoint is resolved per-account (here falling back to the stored value).
      expect(svc.guardianEndpoint).toBe('https://stored.guardian.test');
    });

    it('throws when the WalletAccount has no coldPublicKey', async () => {
      const account = { id: () => ({ toString: () => 'acc-id' }) } as never;
      const walletAccount = { publicKey: 'acc-id' } as never; // missing coldPublicKey
      const signWordFn = jest.fn(async () => 'sig');

      await expect(MultisigService.buildColdMultisigService(account, walletAccount, signWordFn)).rejects.toThrow(
        /missing coldPublicKey/
      );
      expect(multisigClientConfig.load).not.toHaveBeenCalled();
    });

    it('holds its init on the options a caller passes, and on the default hold otherwise', async () => {
      const account = { id: () => ({ toString: () => 'acc-id' }) } as never;
      const walletAccount = { publicKey: 'acc-id', coldPublicKey: 'cold-pub' } as never;
      const options = { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'guardian-self-heal-init' };
      mockGetSignerDetailsFromAccount.mockResolvedValue({ commitment: 'cold-commit-no-prefix' });
      wasmLockOptionsSeen.length = 0;

      await MultisigService.buildColdMultisigService(account, walletAccount, async () => 'sig', options);
      await MultisigService.buildColdMultisigService(account, walletAccount, async () => 'sig');

      expect(wasmLockOptionsSeen).toEqual([options, undefined]);
    });
  });

  describe('createReplaceHotKeyProposal', () => {
    it('builds a single-proposal swap with target list [newHot, cold] from the commitment it is given', async () => {
      const multisig = makeMultisig({ threshold: 1 });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const account = { id: () => ({ toString: () => 'acc-id' }) } as never;

      mockGetSignerDetailsFromAccount.mockResolvedValueOnce({ commitment: 'coldcommitnoprefix' });

      const result = await service.createReplaceHotKeyProposal(account, '0xnewhotcommit');

      expect(mockGetSignerDetailsFromAccount).toHaveBeenCalledWith(account, true);
      // Order preservation: newHot at index 0, cold at index 1.
      expect(mockBuildUpdateSignersTransactionRequest).toHaveBeenCalledWith(
        expect.anything(),
        1,
        ['0xnewhotcommit', '0xcoldcommitnoprefix'],
        // `feeFaucetId` pinned, not ignored: without it the builder commits no fee
        // conversion info and the rotation aborts in `fee::pay_fee` on any chain whose
        // verification_base_fee is non-zero.
        {
          signatureScheme: 'ecdsa',
          midenRpcEndpoint: expect.any(String)
        }
      );
      expect(mockExecuteForSummary).toHaveBeenCalledWith(
        expect.anything(),
        'acc-id',
        { kind: 'request' },
        expect.any(String)
      );
      // The anchor from execution has to be serialized onto the proposal: the
      // multisig client refuses to execute a proposal whose metadata carries no
      // chainAnchor, so dropping it strands the proposal permanently.
      expect(mockChainAnchorToBase64).toHaveBeenCalledWith(expect.objectContaining({ kind: 'anchor' }));
      // Proposal label is cosmetic; on-chain effect is dictated by targetSignerCommitments.
      expect(multisig.createProposal).toHaveBeenCalledWith(
        expect.any(Number),
        'base64-bytes',
        expect.objectContaining({
          proposalType: 'add_signer',
          targetThreshold: 1,
          targetSignerCommitments: ['0xnewhotcommit', '0xcoldcommitnoprefix'],
          saltHex: 'salt-hex',
          chainAnchor: 'anchor-b64'
        })
      );
      expect(result).toEqual({ kind: 'custom', id: 'proposal-id' });
    });

    // #784 follow-up: the captured anchor is a WASM object holding a partial
    // blockchain. Its only job here is to be serialized onto the proposal —
    // once `chainAnchorToBase64` has the wire form, the live object must be
    // released, like every SDK-side producer does.
    //
    // The stub models the ONE way that release can go wrong: wasm-bindgen's
    // `free()` zeroes `__wbg_ptr`, so a later `serialize()` hands a null pointer
    // to rust. Asserting only "free was called" would hold just as well for a
    // free that ran FIRST, i.e. for a use-after-free on every hot-key rotation.
    //
    // `freeThrows` models the other half: wasm-bindgen's generated `free()` has
    // no null-pointer guard, so a disposed module (a #775 lock eviction) makes
    // it throw for real. That throw lands in a `finally`, so only
    // `freeChainAnchor`'s swallow keeps it from replacing whatever the block
    // was already carrying — a successful rotation included.
    const makeTrackedAnchor = (freeThrows = false): { kind: string; freed: boolean; free: jest.Mock } => {
      const anchor = {
        kind: 'anchor',
        freed: false,
        free: jest.fn(() => {
          anchor.freed = true;
          if (freeThrows) throw new Error('null pointer passed to rust');
        })
      };
      return anchor;
    };
    const rejectSerializingAFreedAnchor = (): void => {
      mockChainAnchorToBase64.mockImplementationOnce(a => {
        if ((a as { freed?: boolean }).freed) throw new Error('null pointer passed to rust');
        return 'anchor-b64';
      });
    };

    it('frees the captured chain anchor only AFTER it is serialized onto the proposal', async () => {
      const multisig = makeMultisig({ threshold: 1 });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const account = { id: () => ({ toString: () => 'acc-id' }) } as never;

      const anchor = makeTrackedAnchor();
      rejectSerializingAFreedAnchor();
      mockExecuteForSummary.mockResolvedValueOnce({
        summary: { serialize: () => new Uint8Array([0xab]) },
        anchor
      });
      mockGetSignerDetailsFromAccount.mockResolvedValueOnce({ commitment: 'coldcommit' });

      await service.createReplaceHotKeyProposal(account, '0xnewhotcommit');

      expect(mockChainAnchorToBase64).toHaveBeenCalledWith(anchor);
      expect(anchor.free).toHaveBeenCalledTimes(1);
      // What proves the ordering is the ABSENCE of the stub's null-pointer
      // throw above; this is belt-and-braces that the wire form still lands on
      // the proposal (also covered by the main creation test).
      expect(multisig.createProposal).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(String),
        expect.objectContaining({ chainAnchor: 'anchor-b64' })
      );
    });

    // The `finally` half. Upstream's plainer serialize-then-free would leak here,
    // which is the whole reason this call site does not copy it. The anchor's
    // `free()` throws too, so the assertion below is load-bearing for the
    // swallow: a raw `anchor.free()` here would surface the null-pointer error
    // in place of the real one.
    it('frees the captured chain anchor even when building the wire payload throws', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const multisig = makeMultisig({ threshold: 1 });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const account = { id: () => ({ toString: () => 'acc-id' }) } as never;

      const anchor = makeTrackedAnchor(true);
      mockExecuteForSummary.mockResolvedValueOnce({
        summary: {
          serialize: () => {
            throw new Error('summary serialize failed');
          }
        },
        anchor
      });
      mockGetSignerDetailsFromAccount.mockResolvedValueOnce({ commitment: 'coldcommit' });

      // Releasing the anchor must not replace the reason the proposal failed.
      await expect(service.createReplaceHotKeyProposal(account, '0xnewhotcommit')).rejects.toThrow(
        'summary serialize failed'
      );

      expect(anchor.free).toHaveBeenCalledTimes(1);
      expect(multisig.createProposal).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    // The expensive direction of the same guard: here there is no in-flight
    // error for the free to replace, so an unswallowed throw would INVENT one
    // and fail a rotation that had already succeeded - after the caller minted
    // a Secure Enclave / StrongBox key for it. Reclaiming a few hundred
    // kilobytes is not worth that.
    it('completes the rotation even when releasing the anchor fails', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const multisig = makeMultisig({ threshold: 1 });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const account = { id: () => ({ toString: () => 'acc-id' }) } as never;

      const anchor = makeTrackedAnchor(true);
      mockExecuteForSummary.mockResolvedValueOnce({
        summary: { serialize: () => new Uint8Array([0xab]) },
        anchor
      });
      mockGetSignerDetailsFromAccount.mockResolvedValueOnce({ commitment: 'coldcommit' });

      const result = await service.createReplaceHotKeyProposal(account, '0xnewhotcommit');

      expect(anchor.free).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ kind: 'custom', id: 'proposal-id' });
      expect(multisig.createProposal).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(String),
        expect.objectContaining({ chainAnchor: 'anchor-b64' })
      );
      warn.mockRestore();
    });

    // #788 follow-up: an eviction ABANDONS this flow rather than cancelling it —
    // the mutex belongs to a successor the instant the watchdog fires, so every
    // WASM call after a parking await would be a second borrow of a client
    // somebody else is inside. All three transitions here are pre-sign/pre-submit,
    // so stopping costs a user-visible retry and nothing else.
    const seedReplaceHotKeyCollaborators = () => {
      mockGetSignerDetailsFromAccount.mockResolvedValueOnce({ commitment: 'coldcommit' });
    };

    it('stops before the request build when the hold is evicted during the client build', async () => {
      const multisig = makeMultisig({ threshold: 1 });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const account = { id: () => ({ toString: () => 'acc-id' }) } as never;
      seedReplaceHotKeyCollaborators();
      evictDuringClientBuild = true;

      await expect(service.createReplaceHotKeyProposal(account, '0xnewhotcommit')).rejects.toMatchObject({
        name: 'WasmClientPoisonedError'
      });
      expect(mockBuildUpdateSignersTransactionRequest).not.toHaveBeenCalled();
      expect(mockExecuteForSummary).not.toHaveBeenCalled();
      expect(multisig.createProposal).not.toHaveBeenCalled();

      // Falsifier: with the hold intact the same rotation goes through.
      evictDuringClientBuild = false;
      seedReplaceHotKeyCollaborators();
      await service.createReplaceHotKeyProposal(account, '0xnewhotcommit');
      expect(multisig.createProposal).toHaveBeenCalledTimes(1);
    });

    it('stops before the summary execution when the hold is evicted during the request build', async () => {
      const multisig = makeMultisig({ threshold: 1 });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const account = { id: () => ({ toString: () => 'acc-id' }) } as never;
      seedReplaceHotKeyCollaborators();
      mockBuildUpdateSignersTransactionRequest.mockImplementationOnce(async () => {
        currentWasmHold = null;
        return { request: { kind: 'request' }, salt: { toHex: () => 'salt-hex' } };
      });

      await expect(service.createReplaceHotKeyProposal(account, '0xnewhotcommit')).rejects.toMatchObject({
        name: 'WasmClientPoisonedError'
      });
      expect(mockExecuteForSummary).not.toHaveBeenCalled();
      expect(multisig.createProposal).not.toHaveBeenCalled();
    });

    it('stops before serializing — but still frees the anchor — when the hold is evicted during execution', async () => {
      const multisig = makeMultisig({ threshold: 1 });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const account = { id: () => ({ toString: () => 'acc-id' }) } as never;
      seedReplaceHotKeyCollaborators();
      const summarySerialize = jest.fn(() => new Uint8Array([0xab]));
      const anchor = { kind: 'anchor', free: jest.fn() };
      mockExecuteForSummary.mockImplementationOnce(async () => {
        currentWasmHold = null;
        return { summary: { serialize: summarySerialize }, anchor };
      });

      await expect(service.createReplaceHotKeyProposal(account, '0xnewhotcommit')).rejects.toMatchObject({
        name: 'WasmClientPoisonedError'
      });
      // The summary, salt, and anchor are borrows of the client a successor now
      // owns — none of them may be touched past the eviction...
      expect(summarySerialize).not.toHaveBeenCalled();
      expect(mockChainAnchorToBase64).not.toHaveBeenCalled();
      // ...but the release still runs (freeChainAnchor swallows a disposed-object
      // throw), so the anchor's partial blockchain is not left to the finalizer.
      expect(anchor.free).toHaveBeenCalledTimes(1);
      expect(multisig.createProposal).not.toHaveBeenCalled();
    });

    it('adds the 0x prefix to a commitment given without one', async () => {
      // Defensive: not all commitment producers may prefix. We normalize.
      const multisig = makeMultisig({ threshold: 1 });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const account = { id: () => 'acc-id' } as never;

      mockGetSignerDetailsFromAccount.mockResolvedValueOnce({ commitment: 'coldnoprefix' });

      await service.createReplaceHotKeyProposal(account, 'newhotnoprefix');

      expect(mockBuildUpdateSignersTransactionRequest).toHaveBeenCalledWith(
        expect.anything(),
        1,
        ['0xnewhotnoprefix', '0xcoldnoprefix'],
        // `feeFaucetId` pinned, not ignored: without it the builder commits no fee
        // conversion info and the rotation aborts in `fee::pay_fee` on any chain whose
        // verification_base_fee is non-zero.
        {
          signatureScheme: 'ecdsa',
          midenRpcEndpoint: expect.any(String)
        }
      );
    });

    // Built through `init` so the #904 cases need no casts: `Account.deserialize` and
    // `MultisigClient.load` are this file's stubs.
    const initRotationService = async (multisig: ReturnType<typeof makeMultisig>) => {
      mockAccountDeserialize.mockReturnValueOnce({ id: () => ({ toString: () => 'acc-id' }) });
      const account = Account.deserialize(new Uint8Array());
      multisigClientConfig.load.mockResolvedValueOnce(multisig);
      const service = await MultisigService.init(account, '0xcold-pub', '0xcoldcommit', async () => 'sig', 'https://x');
      return { service, account };
    };

    it('syncs the chain and adopts the guardian state before it builds, and reads the threshold after (#904)', async () => {
      const multisig = makeMultisig({ threshold: 1 });
      // The adopt refreshes the loaded config from the adopted account.
      multisig.syncState.mockImplementationOnce(async () => {
        multisig.threshold = 2;
      });
      const { service, account } = await initRotationService(multisig);
      mockGetSignerDetailsFromAccount.mockResolvedValueOnce({ commitment: 'coldcommit' });
      wasmLockOptionsSeen.length = 0;

      await service.createReplaceHotKeyProposal(account, '0xnewhotcommit');

      expect(mockSyncState).toHaveBeenCalledTimes(1);
      expect(multisig.syncState).toHaveBeenCalledTimes(1);
      const chainSyncedAt = mockSyncState.mock.invocationCallOrder[0]!;
      const adoptedAt = multisig.syncState.mock.invocationCallOrder[0]!;
      const builtAt = mockBuildUpdateSignersTransactionRequest.mock.invocationCallOrder[0]!;
      expect(chainSyncedAt).toBeLessThan(adoptedAt);
      expect(adoptedAt).toBeLessThan(builtAt);
      // Both refresh holds are pure-sync holds on the sync ceiling (#777); the build
      // hold that follows names itself but stays on the default watchdog ceiling,
      // since it continues past the sync into a build and an execute.
      expect(wasmLockOptionsSeen.slice(0, 3)).toEqual([
        { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'replace-hot-key-sync' },
        { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'guardian-adopt' },
        { label: 'replace-hot-key-build' }
      ]);
      expect(mockBuildUpdateSignersTransactionRequest).toHaveBeenCalledWith(
        expect.anything(),
        2,
        ['0xnewhotcommit', '0xcoldcommit'],
        expect.anything()
      );
    });

    it('builds on local state when the guardian refuses to import its state (#904)', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const multisig = makeMultisig({ threshold: 1 });
      multisig.syncState.mockRejectedValueOnce(
        new Error(
          'Refusing to overwrite local state: incoming nonce 4 equals local nonce 4 but commitments differ for account 0xabc'
        )
      );
      const { service, account } = await initRotationService(multisig);
      mockGetSignerDetailsFromAccount.mockResolvedValueOnce({ commitment: 'coldcommit' });

      await service.createReplaceHotKeyProposal(account, '0xnewhotcommit');

      expect(multisig.syncState).toHaveBeenCalledTimes(1);
      expect(multisig.createProposal).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('does not build when reading the guardian state fails for another reason (#904)', async () => {
      const multisig = makeMultisig({ threshold: 1 });
      const unreachable = Object.assign(new Error('GUARDIAN HTTP error 503: Service Unavailable'), { status: 503 });
      multisig.syncState.mockRejectedValueOnce(unreachable);
      const { service, account } = await initRotationService(multisig);

      await expect(service.createReplaceHotKeyProposal(account, '0xnewhotcommit')).rejects.toBe(unreachable);

      expect(mockBuildUpdateSignersTransactionRequest).not.toHaveBeenCalled();
      expect(multisig.createProposal).not.toHaveBeenCalled();
    });
  });

  describe('sync de-duplication', () => {
    it('coalesces overlapping sync() calls onto a single in-flight run', async () => {
      let resolveSync: () => void = () => {};
      const syncState = jest.fn(
        () =>
          new Promise<void>(resolve => {
            resolveSync = resolve;
          })
      );
      const multisig = makeMultisig({ syncState });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      const first = service.sync();
      const second = service.sync();
      expect(first).toBe(second); // second tick reuses the in-flight promise

      resolveSync();
      await first;
      expect(syncState).toHaveBeenCalledTimes(1);

      // After settling, a fresh call starts a new run.
      const third = service.sync();
      expect(third).not.toBe(first);
      resolveSync();
      await third;
      expect(syncState).toHaveBeenCalledTimes(2);
    });
  });
});

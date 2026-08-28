/**
 * Guardian-specific paths through lib/miden/transaction:
 *   - initiateSwitchGuardianTransaction — rejects non-Guardian accounts,
 *     otherwise enqueues a SwitchGuardianTransaction row.
 *   - completeSwitchGuardianTransaction — registers the post-switch state
 *     with the new guardian, flips the stored URL, evicts the cached
 *     MultisigService, and marks the tx Completed. Failure path marks
 *     Failed without touching storage.
 *   - generateTransaction — routes a Guardian-typed account through the
 *     Guardian flow (createSendProposal → signAndCreateTransactionRequest
 *     → submit → completeSendTransaction).
 */

import { TransactionProver } from '@miden-sdk/miden-sdk/lazy';

import { WalletType } from 'screens/onboarding/types';

import {
  completeReplaceHotKeyTransaction,
  completeSwitchGuardianTransaction,
  ENDPOINT_PERSIST_TIMEOUT_MS,
  TERMINAL_STATUS_WRITE_BACKOFF_MS,
  completeUpdateProcedureThresholdTransaction,
  ensureGuardianProcedureThresholds,
  generateTransaction,
  initiateReplaceHotKeyTransaction,
  initiateSwitchGuardianTransaction
} from './index';
import {
  ITransactionStatus,
  ReplaceHotKeyTransaction,
  SwitchGuardianTransaction,
  Transaction,
  UpdateProcedureThresholdTransaction
} from '../db/types';

/**
 * The verbatim `Display` text miden-client produces for
 * `ClientError::ApplyTransactionAfterSubmitFailed`, confirmed present in the
 * shipped `@miden-sdk/miden-sdk@0.16.0-rc.3` wasm. That SDK attaches NO code
 * property for this variant, so this string is the ONLY signal the wallet's
 * classifier has. Building the fixture from the real message — instead of
 * hand-setting an `errorCode` the SDK never sets — is what makes these tests
 * fail if the classifier stops recognising what the SDK actually throws.
 */
const APPLY_AFTER_SUBMIT_ERROR_MESSAGE =
  "Transaction 0xdeadbeef was accepted into the node's mempool at block 42 but the local store update failed. " +
  'The pending update is attached to this error as `pending_update`; you can re-apply it later via ' +
  '`Client::apply_transaction_update`. Do NOT resubmit the same transaction.';

const txStore: Array<Record<string, unknown>> = [];
const putToStorage = jest.fn(async (..._args: unknown[]) => {});

jest.mock('lib/miden/repo', () => ({
  db: { transaction: async (_mode: string, _t: unknown, cb: () => unknown) => cb() },
  transactions: {
    add: jest.fn(async (tx: Record<string, unknown>) => {
      txStore.push({ ...tx });
    }),
    where: jest.fn((query: { id: string }) => ({
      modify: jest.fn(async (fn: (tx: Record<string, unknown>) => void) => {
        const row = txStore.find(r => r.id === query.id);
        if (row) fn(row);
      }),
      first: jest.fn(async () => txStore.find(r => r.id === query.id))
    })),
    // Applies the predicate against `txStore` for real. A stub returning `[]`
    // would silently pass any dedup/queue-scan check that reads through here.
    filter: jest.fn((predicate: (row: Record<string, unknown>) => boolean) => ({
      toArray: jest.fn(async () => txStore.filter(predicate))
    }))
  }
}));

// transactions.ts imports putToStorage from '../front' (the barrel), not directly from './storage'.
jest.mock('../front', () => ({
  putToStorage: (...a: unknown[]) => putToStorage(...a),
  fetchFromStorage: jest.fn(),
  onStorageChanged: jest.fn()
}));

jest.mock('lib/settings/constants', () => ({
  GUARDIAN_URL_STORAGE_KEY: 'guardian_url_setting'
}));

const mockIsGuardianAccount = jest.fn();
const mockGetOrCreateMultisigService = jest.fn();
const mockClearGuardianServiceFor = jest.fn();
// transactions.ts imports via 'lib/miden/front/guardian-manager' (aliased).
jest.mock('lib/miden/front/guardian-manager', () => ({
  isGuardianAccount: (...a: unknown[]) => mockIsGuardianAccount(...a),
  getOrCreateMultisigService: (...a: unknown[]) => mockGetOrCreateMultisigService(...a),
  clearGuardianServiceFor: (...a: unknown[]) => mockClearGuardianServiceFor(...a)
}));

const mockBuildColdMultisigService = jest.fn();
jest.mock('lib/miden/guardian', () => ({
  MultisigService: {
    buildColdMultisigService: (...a: unknown[]) => mockBuildColdMultisigService(...a)
  }
}));

// Direct on-chain switch fallback (old guardian unreachable). The classifier
// keeps its REAL implementation (its unreachable-vs-semantic routing is what
// these tests exercise); only the request builder + finalizer are stubbed.
const mockCreateDirectSwitchRequest = jest.fn();
const mockFinalizeDirectSwitch = jest.fn();
// Defaults to `undefined` — "the chain could not be read" — which is the branch
// that preserves the pre-existing finalize-anyway behaviour, so every test that
// does not care about the commit verdict is unaffected by it.
const mockDidDirectSwitchLand = jest.fn(async (): Promise<boolean | undefined> => undefined);
jest.mock('lib/miden/guardian/direct-switch', () => ({
  ...jest.requireActual('lib/miden/guardian/direct-switch'),
  createDirectSwitchGuardianRequest: (...a: unknown[]) => mockCreateDirectSwitchRequest(...a),
  finalizeDirectGuardianSwitch: (...a: unknown[]) => mockFinalizeDirectSwitch(...a),
  didDirectSwitchLand: (...a: unknown[]) => mockDidDirectSwitchLand(...(a as []))
}));

const mockWithWasmClientLock = jest.fn(async (fn: () => Promise<unknown>) => fn());
const mockWithWasmLockWatchdogPaused = jest.fn(async (fn: () => Promise<unknown>) => fn());
const mockGetMidenClient = jest.fn();
const mockCreateWasmWebClient = jest.fn();
// Match the relative path used by transactions.ts so the mock intercepts.
// The slice-2 offscreen client proxy reads getAccount through the `lib/...` alias
// of miden-client, which jest mocks separately from the relative specifier below;
// delegate the alias to the same mock so the proxy's flag-off passthrough hits it.
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
jest.mock('../sdk/miden-client', () => ({
  withWasmClientLock: (...a: unknown[]) => mockWithWasmClientLock(...(a as [() => Promise<unknown>])),
  withWasmLockWatchdogPaused: (...a: unknown[]) => mockWithWasmLockWatchdogPaused(...(a as [() => Promise<unknown>])),
  getMidenClient: (...a: unknown[]) => mockGetMidenClient(...a)
}));

jest.mock('lib/intercom', () => ({
  getIntercom: () => ({ broadcast: jest.fn(), request: jest.fn() })
}));

jest.mock('lib/store', () => ({
  useWalletStore: { getState: () => ({ accounts: [], setLastCompletedTxHash: jest.fn() }) }
}));

// Every send path builds its request through the shared
// `buildSendTransactionRequest` (lib/miden/sdk/helpers); tests set its
// serialized bytes per-case via mockReturnValue.
// eslint-disable-next-line no-var
var mockBuildSendTransactionRequest = jest.fn((): { serialize: () => Uint8Array } => ({
  serialize: () => new Uint8Array()
}));
// The PSWAP create request goes through its own builder, for the same reason and
// against the same vault read — see `buildPswapCreateRequest`.
// eslint-disable-next-line no-var
var mockBuildPswapCreateRequest = jest.fn((): { serialize: () => Uint8Array } => ({
  serialize: () => new Uint8Array()
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
  accountRefToSdk: (ref: string) => ({ toString: () => `sdk-${ref}` }),
  // Mirrors the real helper: strips the composite `<address>_<suffix>` form.
  walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id.split('_')[0] ?? id}` }),
  canonicalWalletAccountId: (id: string) => id.split('_')[0] ?? id,
  sameWalletAccountId: (a: string, b: string) => (a.split('_')[0] ?? a) === (b.split('_')[0] ?? b),
  buildSendTransactionRequest: (...args: unknown[]) => mockBuildSendTransactionRequest(...(args as [])),
  buildPswapCreateRequest: (...args: unknown[]) => mockBuildPswapCreateRequest(...(args as []))
}));
// #784: the guardian leaf decodes the proposal's base64 chain anchor back into
// a WASM ChainAnchor before pinning executeRequest to it.
// eslint-disable-next-line no-var
var mockChainAnchorDeserialize = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const actual = jest.requireActual('../../../../__mocks__/wasmMock.js');
  return {
    ...actual,
    TransactionProver: {
      newLocalProver: jest.fn(() => 'local-prover'),
      newCallbackProver: jest.fn(() => 'callback-prover')
    },
    WasmWebClient: {
      createClient: (endpoint: string) => mockCreateWasmWebClient(endpoint)
    },
    ChainAnchor: {
      deserialize: (...a: unknown[]) => mockChainAnchorDeserialize(...a)
    }
  };
});

jest.mock('../sdk/native-prover-mobile', () => ({
  buildNativeProverCallback: jest.fn(() => async () => new Uint8Array())
}));

// isMobile is toggled per-test (default false = the desktop/extension env the
// rest of the suite assumes). Only `isMobile` is overridden; every other
// platform predicate keeps its real (jsdom = false) behavior. It must be a
// hoisted `var`: some modules call isMobile() at load time (e.g. cancel.ts), so
// the holder has to be defined (falsy) before the suite body runs — a const/let
// would be in the temporal dead zone at that point.
// eslint-disable-next-line no-var
var mockPlatformIsMobile = false;
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isMobile: () => mockPlatformIsMobile
}));

jest.mock('shared/logger', () => ({
  logger: { warning: jest.fn(), error: jest.fn(), info: jest.fn() }
}));

const makeResult = () => ({
  executedTransaction: () => ({
    id: () => ({ toHex: () => 'exec-tx-hash' }),
    outputNotes: () => ({ notes: () => [] }),
    inputNotes: () => ({ notes: () => [] })
  }),
  serialize: () => new Uint8Array([9, 9, 9])
});

const makeTransactionsApi = (result: ReturnType<typeof makeResult>, apply = jest.fn(async () => {})) => {
  const prove = jest.fn(async (..._args: unknown[]) => ({ proved: true }));
  const submitProven = jest.fn(async (_proven?: unknown, _executed?: unknown) => ({ blockNumber: 1 }));
  const executeRequest = jest.fn(async () => ({
    id: result.executedTransaction().id(),
    result,
    prove: async (options?: unknown) => {
      const proof = await prove(result, options);
      return {
        proof,
        result,
        submit: async () => {
          const submission = await submitProven(proof, result);
          return {
            ...submission,
            result,
            apply
          };
        }
      };
    }
  }));
  return { executeRequest, prove, submitProven, apply };
};

const makeClientApi = (result: ReturnType<typeof makeResult>, apply = jest.fn(async () => {})) => {
  const transactions = makeTransactionsApi(result, apply);
  return {
    transactions,
    _withInnerWebClient: jest.fn(async (fn: (inner: object) => Promise<unknown>) =>
      fn({
        executeTransaction: transactions.executeRequest,
        proveTransaction: transactions.prove,
        submitProvenTransaction: async (proven: unknown, executed: unknown) =>
          (await transactions.submitProven(proven, executed)).blockNumber,
        applyTransaction: transactions.apply
      })
    )
  };
};

const makeGuardianProvider = (isGuardian: boolean) => {
  mockIsGuardianAccount.mockResolvedValue(isGuardian);
  return {
    getAccounts: async () =>
      isGuardian
        ? [
            {
              publicKey: 'acc-1',
              name: 'Guardian account',
              isPublic: true,
              type: WalletType.Guardian,
              hdIndex: 0,
              guardianEndpoint: 'https://old.guardian'
            }
          ]
        : [],
    getPublicKeyForCommitment: async () => 'pk',
    signWord: async () => 'sig'
  };
};

describe('initiateSwitchGuardianTransaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    txStore.length = 0;
  });

  it('queues a SwitchGuardianTransaction row when the account is Guardian', async () => {
    const provider = makeGuardianProvider(true);

    const id = await initiateSwitchGuardianTransaction('acc-1', 'https://new.guardian', false, provider);

    expect(id).toBeDefined();
    expect(txStore).toHaveLength(1);
    const row = txStore[0] as Record<string, unknown>;
    expect(row.accountId).toBe('acc-1');
    expect(row.type).toBe('switch-guardian');
    const extra = row.extraInputs as Record<string, unknown>;
    expect(extra.previousGuardianEndpoint).toBe('https://old.guardian');
    expect(extra.newGuardianEndpoint).toBe('https://new.guardian');
  });

  it('throws when the target account is not a Guardian account', async () => {
    const provider = makeGuardianProvider(false);

    await expect(initiateSwitchGuardianTransaction('acc-public', 'https://new', false, provider)).rejects.toThrow(
      'Switch guardian is only supported for Guardian accounts'
    );
    expect(txStore).toHaveLength(0);
  });

  // A second row is not merely redundant. Rotations are serialized per account,
  // so it runs only AFTER the first committed and persisted the new endpoint, and
  // then performs a whole second on-chain `update_guardian` to the guardian the
  // account already has.
  it.each([
    ['Queued', ITransactionStatus.Queued],
    ['GeneratingTransaction', ITransactionStatus.GeneratingTransaction]
  ])('returns the in-flight row instead of queueing a second one (%s)', async (_label, status) => {
    const provider = makeGuardianProvider(true);
    const first = await initiateSwitchGuardianTransaction('acc-1', 'https://new.guardian', false, provider);
    const row = txStore.find(r => r.id === first)!;
    row.status = status;

    // The SAME target: this is one rotation asked for twice, which is the only
    // case where handing back the live id is honest.
    const second = await initiateSwitchGuardianTransaction('acc-1', 'https://new.guardian', false, provider);

    expect(second).toBe(first);
    expect(txStore).toHaveLength(1);
  });

  // Trailing-slash difference only — still the same operator, so still a duplicate.
  it('treats a trailing-slash variant of the in-flight target as the same rotation', async () => {
    const provider = makeGuardianProvider(true);
    const first = await initiateSwitchGuardianTransaction('acc-1', 'https://new.guardian', false, provider);
    txStore.find(r => r.id === first)!.status = ITransactionStatus.GeneratingTransaction;

    const second = await initiateSwitchGuardianTransaction('acc-1', 'https://new.guardian/', false, provider);

    expect(second).toBe(first);
    expect(txStore).toHaveLength(1);
  });

  // Returning the in-flight id here would navigate the user to a rotation toward
  // an endpoint they did not choose and report it as the one they asked for —
  // nothing downstream ever corrects that, since the in-progress screen renders
  // no summary for `switch-guardian`.
  it('refuses rather than redirecting when the in-flight rotation targets a different guardian', async () => {
    const provider = makeGuardianProvider(true);
    const first = await initiateSwitchGuardianTransaction('acc-1', 'https://new.guardian', false, provider);
    txStore.find(r => r.id === first)!.status = ITransactionStatus.GeneratingTransaction;

    await expect(initiateSwitchGuardianTransaction('acc-1', 'https://other.guardian', false, provider)).rejects.toThrow(
      'A guardian rotation to https://new.guardian is already in progress'
    );
    // And it must not have queued a competing row on the way out.
    expect(txStore).toHaveLength(1);
  });

  it('still queues when the only other rotation for the account is terminal', async () => {
    const provider = makeGuardianProvider(true);
    const first = await initiateSwitchGuardianTransaction('acc-1', 'https://new.guardian', false, provider);
    // A finished rotation must never block the next one, and a FAILED rotation is
    // the case the user most needs to re-run: `switch-guardian` has no Retry.
    txStore.find(r => r.id === first)!.status = ITransactionStatus.Failed;

    const second = await initiateSwitchGuardianTransaction('acc-1', 'https://other.guardian', false, provider);

    expect(second).not.toBe(first);
    expect(txStore).toHaveLength(2);
  });

  it('does not dedupe against a rotation in flight for a DIFFERENT account', async () => {
    const provider = makeGuardianProvider(true);
    // Seeded directly: the shared provider fixture only knows `acc-1`, and the
    // point here is the accountId comparison, not the provider lookup.
    txStore.push({
      id: 'other-account-rotation',
      type: 'switch-guardian',
      accountId: 'acc-2',
      status: ITransactionStatus.GeneratingTransaction,
      extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
    });

    const mine = await initiateSwitchGuardianTransaction('acc-1', 'https://new.guardian', false, provider);

    expect(mine).not.toBe('other-account-rotation');
    expect(txStore).toHaveLength(2);
  });
});

describe('completeSwitchGuardianTransaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    txStore.length = 0;
  });

  it('registers state with the new guardian, persists the per-account endpoint, and marks the row Completed', async () => {
    const tx = new SwitchGuardianTransaction('acc-1', 'https://new.guardian', false);
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    const multisigService = {
      finalizeGuardianSwitch: jest.fn(async () => {})
    };
    const setGuardianEndpoint = jest.fn(async () => {});
    const provider = { ...makeGuardianProvider(true), setGuardianEndpoint };

    await completeSwitchGuardianTransaction(tx, makeResult() as never, multisigService as never, provider as never);

    expect(multisigService.finalizeGuardianSwitch).toHaveBeenCalledWith('https://new.guardian');
    // Per-account endpoint write, NOT the legacy global key.
    expect(setGuardianEndpoint).toHaveBeenCalledWith('acc-1', 'https://new.guardian');
    expect(putToStorage).not.toHaveBeenCalled();
    expect(mockClearGuardianServiceFor).toHaveBeenCalledWith('acc-1');

    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
    // #618: completion stamps the terminal stage through the real complete* layer.
    expect(row.stage).toBe('complete');
    expect(row.displayMessage).toBe('Guardian switched');
  });

  // By the time this runs, `update_guardian` has COMMITTED — the account's
  // guardian IS the new operator, so a vault still naming the old one is wrong,
  // and the row is terminal either way (`switch-guardian` is in no requeue set
  // and is excluded from user Retry, so "storage stays untouched so the user can
  // retry" was never true). Registration is therefore best-effort, exactly like
  // `replace-hot-key`'s post-rotation re-register: persist the pointer, record
  // the miss, and let the guardian-sync 401 self-heal land the registration.
  it('persists the endpoint and records registerFailed when registration throws', async () => {
    const tx = new SwitchGuardianTransaction('acc-1', 'https://new.guardian', false);
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    const multisigService = {
      finalizeGuardianSwitch: jest.fn(async () => {
        throw new Error('register failed');
      })
    };
    const setGuardianEndpoint = jest.fn(async () => {});
    const provider = { ...makeGuardianProvider(true), setGuardianEndpoint };
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await completeSwitchGuardianTransaction(tx, makeResult() as never, multisigService as never, provider as never);

    // The pointer moves regardless: leaving it on the old operator is what blocks
    // every recovery path, since `syncGuardianAccounts` builds its service from
    // the STORED endpoint and throws before `checkGuardianDrift` is reached.
    expect(setGuardianEndpoint).toHaveBeenCalledWith('acc-1', 'https://new.guardian');
    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.displayMessage).toBe('Guardian switched');
    expect(row.extraInputs).toMatchObject({ newGuardianEndpoint: 'https://new.guardian', registerFailed: true });
  });

  // A HANG is worse than a rejection here, and until this was bounded nothing
  // covered it. On the frontend this provider method is an intercom request, and
  // `request()` has no timeout while its `onDisconnect` reconnects the port
  // WITHOUT settling anything in flight — so an MV3 worker recycle at this exact
  // moment strands the await. Every other step in the post-commit sequence
  // records its outcome and moves on so the row always reaches a terminal status;
  // an unbounded await defeats that from the inside, parking a rotation that is
  // already a fact on chain at GeneratingTransaction forever, with the audit
  // flags never written because the status write is never reached.
  it('completes the committed switch even if the endpoint write never settles', async () => {
    const tx = new SwitchGuardianTransaction('acc-1', 'https://new.guardian', false);
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    const multisigService = { finalizeGuardianSwitch: jest.fn(async () => {}) };
    // Never settles, in either direction.
    const setGuardianEndpoint = jest.fn(() => new Promise<void>(() => {}));
    const provider = { ...makeGuardianProvider(true), setGuardianEndpoint };
    jest.spyOn(console, 'error').mockImplementation(() => {});

    jest.useFakeTimers();
    try {
      const completion = completeSwitchGuardianTransaction(
        tx,
        makeResult() as never,
        multisigService as never,
        provider as never
      );
      // Nothing but the timeout can move this forward.
      await jest.advanceTimersByTimeAsync(ENDPOINT_PERSIST_TIMEOUT_MS + 1);
      await completion;
    } finally {
      jest.useRealTimers();
    }

    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
    // A timeout is not evidence the write did not land, so it books the same flag
    // a rejection does: "may not have persisted, reconcile it". Drift
    // reconciliation is the repair path either way, and if the write did land the
    // flag is a harmless false positive.
    expect(row.extraInputs).toMatchObject({ endpointPersistFailed: true });
    // And the steps AFTER it still ran — the timeout must not swallow the rest of
    // the post-commit sequence.
    expect(multisigService.finalizeGuardianSwitch).toHaveBeenCalledWith('https://new.guardian');
    expect(row.extraInputs).toMatchObject({ registerFailed: false });
  });

  // The terminal write is what makes a committed rotation stop spinning, and it
  // used to get exactly ONE immediate retry — so the honest status depended on two
  // consecutive IndexedDB writes, and the failure worth surviving here (a
  // transaction abort under contention) is precisely the kind that recurs at once
  // and then clears. What happens when the retry also fails is not "the row is
  // left alone": it stays at GeneratingTransaction and the stuck reaper writes
  // FAILED, which for a rotation that is already a fact on chain is the lie the
  // whole block exists to refuse.
  it('keeps retrying the terminal status when the write fails more than twice', async () => {
    const tx = new SwitchGuardianTransaction('acc-1', 'https://new.guardian', false);
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    const multisigService = { finalizeGuardianSwitch: jest.fn(async () => {}) };
    const provider = { ...makeGuardianProvider(true), setGuardianEndpoint: jest.fn(async () => {}) };
    jest.spyOn(console, 'error').mockImplementation(() => {});

    // The primary write plus the first TWO retries fail; the third lands. Three
    // is the number that distinguishes this from the single-retry behaviour it
    // replaces: the primary write consumes one failure by itself, so a test that
    // only needed two would pass with a budget of one retry.
    const repo = jest.requireMock('lib/miden/repo') as {
      transactions: { where: jest.Mock };
    };
    const realWhere = repo.transactions.where.getMockImplementation()!;
    let failures = 0;
    repo.transactions.where.mockImplementation((query: { id: string }) => ({
      ...realWhere(query),
      modify: async (fn: (row: Record<string, unknown>) => void) => {
        // Fail ONLY the terminal status write. The post-commit sequence makes
        // other `modify` calls (stage stamps), and letting those consume the
        // budget made this pass with a single retry — the very behaviour it is
        // supposed to distinguish. Probed rather than counted, so the test does
        // not depend on how many unrelated writes precede it.
        const probe: Record<string, unknown> = { extraInputs: {} };
        let targetsCompleted = false;
        try {
          fn(probe);
          targetsCompleted = probe.status === ITransactionStatus.Completed;
        } catch {
          targetsCompleted = false;
        }
        if (targetsCompleted && failures < 3) {
          failures++;
          throw new Error('IndexedDB transaction aborted');
        }
        return realWhere(query).modify(fn);
      }
    }));

    jest.useFakeTimers();
    try {
      const completion = completeSwitchGuardianTransaction(
        tx,
        makeResult() as never,
        multisigService as never,
        provider as never
      );
      // The attempts are SPACED — a single immediate retry is what this replaces.
      await jest.advanceTimersByTimeAsync(TERMINAL_STATUS_WRITE_BACKOFF_MS * 4);
      await completion;
    } finally {
      jest.useRealTimers();
      repo.transactions.where.mockImplementation(realWhere);
    }

    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(failures).toBe(3);
  });

  it('records registerFailed=false on a clean switch', async () => {
    const tx = new SwitchGuardianTransaction('acc-1', 'https://new.guardian', false);
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    const multisigService = { finalizeGuardianSwitch: jest.fn(async () => {}) };
    const provider = { ...makeGuardianProvider(true), setGuardianEndpoint: jest.fn(async () => {}) };

    await completeSwitchGuardianTransaction(tx, makeResult() as never, multisigService as never, provider as never);

    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.extraInputs).toMatchObject({ registerFailed: false });
  });

  // The DIRECT path has no MultisigService; the same best-effort contract has to
  // hold there, because that path's premise is that the OLD operator is dead —
  // so a vault left pointing at it is unrecoverable rather than merely untidy.
  it('persists the endpoint when the DIRECT registration exhausts its retries', async () => {
    const tx = new SwitchGuardianTransaction('acc-1', 'https://new.guardian', false);
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    mockFinalizeDirectSwitch.mockRejectedValueOnce(new Error('new guardian never answered'));
    const setGuardianEndpoint = jest.fn(async () => {});
    const provider = { ...makeGuardianProvider(true), setGuardianEndpoint };
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await completeSwitchGuardianTransaction(tx, makeResult() as never, undefined, provider as never);

    expect(setGuardianEndpoint).toHaveBeenCalledWith('acc-1', 'https://new.guardian');
    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.extraInputs).toMatchObject({ registerFailed: true });
  });

  // The endpoint write is the load-bearing anti-stranding step, and it is the
  // one call here that can fail for a reason unrelated to the guardian: this
  // runs minutes after the user authorized, so an auto-lock in between makes
  // `setGuardianEndpoint` throw `Wallet is locked`. Unguarded, that threw out of
  // a COMMITTED rotation and the outer handler marked the row Failed — with the
  // dead operator still stored, which is the exact state this ordering exists to
  // prevent.
  it('completes and records endpointPersistFailed when the endpoint write throws', async () => {
    const tx = new SwitchGuardianTransaction('acc-1', 'https://new.guardian', false);
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    const multisigService = { finalizeGuardianSwitch: jest.fn(async () => {}) };
    const setGuardianEndpoint = jest.fn(async () => {
      throw new Error('Wallet is locked');
    });
    const provider = { ...makeGuardianProvider(true), setGuardianEndpoint };
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await completeSwitchGuardianTransaction(tx, makeResult() as never, multisigService as never, provider as never);

    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.extraInputs).toMatchObject({ endpointPersistFailed: true, registerFailed: false });
    // A failed pointer write must not cost the registration too — it is the step
    // that makes the new operator able to serve the account at all.
    expect(multisigService.finalizeGuardianSwitch).toHaveBeenCalledWith('https://new.guardian');
  });

  it('records endpointPersistFailed=false on a clean switch', async () => {
    const tx = new SwitchGuardianTransaction('acc-1', 'https://new.guardian', false);
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    const multisigService = { finalizeGuardianSwitch: jest.fn(async () => {}) };
    const provider = { ...makeGuardianProvider(true), setGuardianEndpoint: jest.fn(async () => {}) };

    await completeSwitchGuardianTransaction(tx, makeResult() as never, multisigService as never, provider as never);

    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.extraInputs).toMatchObject({ endpointPersistFailed: false });
  });

  // Past the commit, the rotation is a fact on chain and the only honest terminal
  // status is Completed. These two calls are incidental — a progress stamp and a
  // cache eviction — and while they were unguarded either one could reproduce the
  // whole stranded-and-Failed state the ordering above exists to prevent, through
  // a purely cosmetic failure. The stage write is the worse of the two: it runs
  // BEFORE the endpoint is persisted.
  it('completes the switch when the progress-stage write fails', async () => {
    const tx = new SwitchGuardianTransaction('acc-1', 'https://new.guardian', false);
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    const repo = jest.requireMock('lib/miden/repo') as {
      transactions: { where: jest.Mock };
    };
    const realWhere = repo.transactions.where.getMockImplementation()!;
    let modifyCalls = 0;
    repo.transactions.where.mockImplementation((query: { id: string }) => {
      const handle = realWhere(query) as { modify: (fn: unknown) => Promise<void>; first: () => Promise<unknown> };
      return {
        ...handle,
        modify: async (fn: unknown) => {
          modifyCalls += 1;
          // Only the first write — the stage stamp — fails.
          if (modifyCalls === 1) throw new Error('QuotaExceededError');
          return handle.modify(fn);
        }
      };
    });

    const multisigService = { finalizeGuardianSwitch: jest.fn(async () => {}) };
    const setGuardianEndpoint = jest.fn(async () => {});
    const provider = { ...makeGuardianProvider(true), setGuardianEndpoint };
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await completeSwitchGuardianTransaction(tx, makeResult() as never, multisigService as never, provider as never);
    } finally {
      repo.transactions.where.mockImplementation(realWhere);
    }

    expect(setGuardianEndpoint).toHaveBeenCalledWith('acc-1', 'https://new.guardian');
    expect(multisigService.finalizeGuardianSwitch).toHaveBeenCalledWith('https://new.guardian');
    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.extraInputs).toMatchObject({ registerFailed: false, endpointPersistFailed: false });
  });

  // The terminal write itself can fail (Dexie quota, a closed database on
  // teardown), and the retry in the catch is the row's last chance at a status.
  // What it must not do is retry a DIFFERENT row: the two audit flags are the
  // only record that a post-commit step did not land, and `GuardianSwitchSuccess`
  // renders its "setup incomplete" warning off exactly them. A fallback that
  // dropped them reported the worst outcome — committed rotation, dead operator
  // still stored — as a clean switch.
  it('carries the audit flags into the fallback status write when the first one fails', async () => {
    const tx = new SwitchGuardianTransaction('acc-1', 'https://new.guardian', false);
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    const repo = jest.requireMock('lib/miden/repo') as { transactions: { where: jest.Mock } };
    const realWhere = repo.transactions.where.getMockImplementation()!;
    let modifyCalls = 0;
    repo.transactions.where.mockImplementation((query: { id: string }) => {
      const handle = realWhere(query) as { modify: (fn: unknown) => Promise<void>; first: () => Promise<unknown> };
      return {
        ...handle,
        modify: async (fn: unknown) => {
          modifyCalls += 1;
          // #1 is the `registering-guardian` stage stamp; #2 is the Completed
          // write this test wants to lose.
          if (modifyCalls === 2) throw new Error('QuotaExceededError');
          return handle.modify(fn);
        }
      };
    });

    // Both post-commit steps miss, so both flags are true and both must survive.
    const multisigService = {
      finalizeGuardianSwitch: jest.fn(async () => {
        throw new Error('new guardian never answered');
      })
    };
    const provider = {
      ...makeGuardianProvider(true),
      setGuardianEndpoint: jest.fn(async () => {
        throw new Error('Wallet is locked');
      })
    };
    jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await completeSwitchGuardianTransaction(tx, makeResult() as never, multisigService as never, provider as never);
    } finally {
      repo.transactions.where.mockImplementation(realWhere);
    }

    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.extraInputs).toMatchObject({ endpointPersistFailed: true, registerFailed: true });
  });

  it('completes the switch when evicting the cached guardian service throws', async () => {
    const tx = new SwitchGuardianTransaction('acc-1', 'https://new.guardian', false);
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    const multisigService = { finalizeGuardianSwitch: jest.fn(async () => {}) };
    const provider = { ...makeGuardianProvider(true), setGuardianEndpoint: jest.fn(async () => {}) };
    mockClearGuardianServiceFor.mockImplementationOnce(() => {
      throw new Error('cache blew up');
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    await completeSwitchGuardianTransaction(tx, makeResult() as never, multisigService as never, provider as never);

    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.displayMessage).toBe('Guardian switched');
  });

  // Ordering, not just outcomes: the idempotent anti-stranding write goes first,
  // ahead of the step that is allowed to fail.
  it('persists the endpoint BEFORE attempting registration', async () => {
    const tx = new SwitchGuardianTransaction('acc-1', 'https://new.guardian', false);
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    const calls: string[] = [];
    const multisigService = {
      finalizeGuardianSwitch: jest.fn(async () => {
        calls.push('register');
      })
    };
    const provider = {
      ...makeGuardianProvider(true),
      setGuardianEndpoint: jest.fn(async () => {
        calls.push('persist');
      })
    };

    await completeSwitchGuardianTransaction(tx, makeResult() as never, multisigService as never, provider as never);

    expect(calls).toEqual(['persist', 'register']);
  });
});

describe('generateTransaction — Guardian routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateWasmWebClient.mockReset();
    mockBuildSendTransactionRequest.mockReset();
    mockBuildPswapCreateRequest.mockReset();
    // #784: `clearAllMocks` clears CALLS but keeps implementations, so reset
    // this one and give it an echoing default. Without a default, a test that
    // sets `metadata.chainAnchor` but forgets `mockReturnValue` would decode to
    // `undefined`, silently take the UNANCHORED path, and still pass. The reset
    // also stops a per-test throwing implementation leaking into the rest of
    // the file.
    mockChainAnchorDeserialize.mockReset();
    mockChainAnchorDeserialize.mockImplementation((bytes: Uint8Array) => ({
      __anchorFromBytes: Array.from(bytes),
      free: jest.fn()
    }));
    txStore.length = 0;
  });

  it('Guardian send: builds a proposal, signs it, submits the request, and completes the row', async () => {
    const txId = 'send-guardian-1';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      displayMessage: 'Queued',
      displayIcon: 'DEFAULT',
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000',
      delegateTransaction: false,
      initiatedAt: Math.floor(Date.now() / 1000)
    });

    const multisigService = {
      createSendProposal: jest.fn(async () => ({ id: 'prop-1' })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    // The pre-guardian sync call uses midenClient.syncState() directly; the
    // proposal then follows the execute/prove/submit/apply transaction pipeline.
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: makeClientApi(result)
    });

    const provider = makeGuardianProvider(true);
    const signCallback = jest.fn(async () => new Uint8Array([2]));

    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: false
      } as never,
      signCallback,
      false,
      provider
    );

    expect(multisigService.createSendProposal).toHaveBeenCalledWith('recipient', 'faucet', 1000n, 'Public');
    expect(multisigService.signAndCreateTransactionRequest).toHaveBeenCalledWith('prop-1', undefined);
    expect(multisigService.sync).toHaveBeenCalled();
  });

  // #784: a guardian co-signature is bound to a TransactionSummary that (since
  // protocol 0.16) pins the reference block commitment. Executing at the current
  // sync height instead of the proposal's anchored block makes the kernel reject
  // the transaction as unauthorized whenever the chain advanced during the
  // guardian round-trip — so the leaf must pin executeRequest to the proposal's
  // chain anchor.
  it('Guardian send: pins executeRequest to the proposal chain anchor and frees the decoded anchor (#784)', async () => {
    const txId = 'send-guardian-anchored';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      displayMessage: 'Queued',
      displayIcon: 'DEFAULT',
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000',
      delegateTransaction: false,
      initiatedAt: Math.floor(Date.now() / 1000)
    });

    // 'BwcH' is base64 for the bytes [7, 7, 7] — distinctive enough to assert
    // the decode consumed exactly the proposal's wire-form anchor.
    const anchor = { free: jest.fn(), blockNum: () => 42 };
    mockChainAnchorDeserialize.mockReturnValue(anchor);
    const multisigService = {
      createSendProposal: jest.fn(async () => ({
        id: 'prop-anchored',
        metadata: { proposalType: 'p2id', description: 'send', chainAnchor: 'BwcH' }
      })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    const clientApi = makeClientApi(result);
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: clientApi
    });

    const provider = makeGuardianProvider(true);

    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([2])),
      false,
      provider
    );

    // The base64 anchor from the proposal metadata was decoded in-realm...
    expect(mockChainAnchorDeserialize).toHaveBeenCalledTimes(1);
    expect(Array.from(mockChainAnchorDeserialize.mock.calls[0][0] as Uint8Array)).toEqual([7, 7, 7]);
    // ...execution was pinned to it...
    expect(clientApi.transactions.executeRequest).toHaveBeenCalledTimes(1);
    const anchoredExecuteArgs = clientApi.transactions.executeRequest.mock.calls[0] as unknown[];
    expect(anchoredExecuteArgs[2]).toEqual({ anchor });
    // ...and the decoded WASM object was released once the pipeline finished.
    expect(anchor.free).toHaveBeenCalledTimes(1);
    // ORDER, not just occurrence. `executeRequest` BORROWS the anchor — the
    // generated glue reads `anchor.__wbg_ptr` synchronously as it is invoked —
    // so a free that ran first would hand rust a null pointer on every anchored
    // guardian write, and `_assertClass` would not catch it because a freed
    // instance still passes. "free was called once" holds just as well for that
    // use-after-free, which is why the ordering is asserted explicitly.
    const executeOrder = clientApi.transactions.executeRequest.mock.invocationCallOrder[0] ?? 0;
    const freeOrder = anchor.free.mock.invocationCallOrder[0] ?? 0;
    expect(executeOrder).toBeGreaterThan(0);
    expect(freeOrder).toBeGreaterThan(executeOrder);
  });

  it('Guardian send: executes unanchored when the proposal metadata has no chain anchor (#784)', async () => {
    const txId = 'send-guardian-unanchored';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      displayMessage: 'Queued',
      displayIcon: 'DEFAULT',
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000',
      delegateTransaction: false,
      initiatedAt: Math.floor(Date.now() / 1000)
    });

    const multisigService = {
      createSendProposal: jest.fn(async () => ({ id: 'prop-plain' })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const clientApi = makeClientApi(result);
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: clientApi
    });

    const provider = makeGuardianProvider(true);

    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([2])),
      false,
      provider
    );

    expect(mockChainAnchorDeserialize).not.toHaveBeenCalled();
    expect(clientApi.transactions.executeRequest).toHaveBeenCalledTimes(1);
    const unanchoredExecuteArgs = clientApi.transactions.executeRequest.mock.calls[0] as unknown[];
    expect(unanchoredExecuteArgs[2]).toBeUndefined();
    // This branch is unreachable in production (signing throws on an anchorless
    // proposal), so the warning IS the diagnostic — it has to name the row and
    // the proposal or it cannot be traced back to anything.
    const anchorWarn = warn.mock.calls.find(call => String(call[0]).includes('no chain anchor'));
    expect(anchorWarn?.[1]).toEqual({ transactionId: txId, proposalId: 'prop-plain' });
    warn.mockRestore();
  });

  // The free lives in a `finally` so a FAILED execute still releases the
  // anchor's partial blockchain. Without this, moving the free after the await
  // would leak one anchor per failed guardian write and stay green.
  it('Guardian send: frees the decoded chain anchor even when executeRequest fails (#784)', async () => {
    const txId = 'send-guardian-anchor-execute-fails';
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000',
      delegateTransaction: false,
      initiatedAt: Math.floor(Date.now() / 1000)
    });

    const anchor = { free: jest.fn(), blockNum: () => 42 };
    mockChainAnchorDeserialize.mockReturnValue(anchor);
    const abandonCandidate = jest.fn(async () => {});
    mockGetOrCreateMultisigService.mockResolvedValue({
      createSendProposal: jest.fn(async () => ({
        id: 'prop-anchored-fail',
        nonce: 21,
        metadata: { proposalType: 'p2id', description: 'send', chainAnchor: 'BwcH' }
      })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      abandonCandidate,
      sync: jest.fn(async () => {})
    });

    const clientApi = makeClientApi(makeResult());
    clientApi.transactions.executeRequest.mockRejectedValueOnce(new Error('execution failed: unauthorized'));
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: clientApi
    });

    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    expect(anchor.free).toHaveBeenCalledTimes(1);
    expect(abandonCandidate).toHaveBeenCalledWith(21);
    expect(txStore.find(row => row.id === txId)?.status).toBe(ITransactionStatus.Failed);
  });

  // A skewed or truncated anchor throws in `deserialize`, BEFORE execution.
  // That must fail the write outright — never fall back to the unanchored
  // execute this issue exists to eliminate — and still abandon the candidate.
  it('Guardian send: a malformed chain anchor fails the write without executing unanchored (#784)', async () => {
    const txId = 'send-guardian-anchor-malformed';
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000',
      delegateTransaction: false,
      initiatedAt: Math.floor(Date.now() / 1000)
    });

    mockChainAnchorDeserialize.mockImplementation(() => {
      throw new Error('ChainAnchor deserialization failed');
    });
    const abandonCandidate = jest.fn(async () => {});
    mockGetOrCreateMultisigService.mockResolvedValue({
      createSendProposal: jest.fn(async () => ({
        id: 'prop-anchored-malformed',
        nonce: 23,
        metadata: { proposalType: 'p2id', description: 'send', chainAnchor: 'BwcH' }
      })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      abandonCandidate,
      sync: jest.fn(async () => {})
    });

    const clientApi = makeClientApi(makeResult());
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: clientApi
    });

    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    expect(clientApi.transactions.executeRequest).not.toHaveBeenCalled();
    expect(abandonCandidate).toHaveBeenCalledWith(23);
    expect(txStore.find(row => row.id === txId)?.status).toBe(ITransactionStatus.Failed);
  });

  // Why `freeChainAnchor` exists rather than a bare `anchor.free()` in the
  // `finally`, pinned on the pipeline mobile and desktop actually run. A throw
  // from the free REPLACES the in-flight error, and the error IDENTITY is what
  // the guardian catch branches on: an eviction reaching that catch as a
  // free() error loses `isWasmClientPoisonedError` and retracts a co-signature
  // for a transaction the abandoned pipeline may still land (#775). Both
  // failures coincide precisely here — a disposed module is what makes
  // wasm-bindgen's unguarded `free()` throw in the first place.
  it('Guardian send: a failing anchor free never masks a lock-recovery eviction, so the candidate is not abandoned (#784 × #775)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { WasmClientPoisonedError } = require('../sdk/wasm-client-poison');
    const txId = 'send-guardian-anchor-free-throws-on-eviction';
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000',
      delegateTransaction: false,
      initiatedAt: Math.floor(Date.now() / 1000)
    });

    const anchor = {
      free: jest.fn(() => {
        throw new Error('null pointer passed to rust');
      }),
      blockNum: () => 42
    };
    mockChainAnchorDeserialize.mockReturnValue(anchor);
    const abandonCandidate = jest.fn(async () => {});
    mockGetOrCreateMultisigService.mockResolvedValue({
      createSendProposal: jest.fn(async () => ({
        id: 'prop-anchored-evicted',
        nonce: 25,
        metadata: { proposalType: 'p2id', description: 'send', chainAnchor: 'BwcH' }
      })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      abandonCandidate,
      sync: jest.fn(async () => {})
    });

    const clientApi = makeClientApi(makeResult());
    clientApi.transactions.executeRequest.mockRejectedValueOnce(new WasmClientPoisonedError('watchdog'));
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: clientApi
    });

    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    ).catch(() => {});

    expect(anchor.free).toHaveBeenCalledTimes(1);
    expect(abandonCandidate).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // The note type used to be hardcoded Private here regardless of the row, so a
  // Public guardian send emitted a private note — and since the ROW still said
  // 'public', `completeSendTransaction` skipped the relay, leaving the
  // recipient with a note they were never sent and no reclaim window for the
  // sender. Both directions are asserted so a re-hardcoding of either fails.
  it.each([
    ['private', 'Private'],
    ['public', 'Public']
  ])('Guardian plain send: proposes a %p note, matching the row the user approved', async (rowType, expected) => {
    const txId = `send-guardian-notetype-${rowType}`;
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      displayMessage: 'Queued',
      displayIcon: 'DEFAULT',
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      noteType: rowType,
      amount: '1000',
      delegateTransaction: false,
      initiatedAt: Math.floor(Date.now() / 1000)
    });

    const multisigService = {
      createSendProposal: jest.fn(async () => ({ id: 'prop-nt' })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      createCustomProposal: jest.fn(),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: makeClientApi(result)
    });

    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        noteType: rowType,
        amount: '1000',
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    expect(multisigService.createSendProposal).toHaveBeenCalledWith('recipient', 'faucet', 1000n, expected);
  });

  it.each([
    ['public', 'Public'],
    ['private', 'Private']
  ])(
    'Guardian recallable %s send builds one P2IDE request with an absolute reclaim height',
    async (noteType, expectedSdkNoteType) => {
      const txId = `recallable-${noteType}`;
      const result = makeResult();
      const requestBytes = new Uint8Array([7, 8, 9]);
      const transaction = Object.assign(new Transaction('guardian-acc', new Uint8Array()), {
        id: txId,
        type: 'send',
        amount: 1000n,
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        noteType,
        requestBytes: undefined,
        extraInputs: { recallBlocks: 25 },
        delegateTransaction: false
      });
      txStore.push({
        ...transaction,
        status: ITransactionStatus.Queued
      });

      mockBuildSendTransactionRequest.mockReturnValue({ serialize: () => requestBytes });

      const multisigService = {
        createCustomProposal: jest.fn(async () => ({ id: 'recall-proposal' })),
        createSendProposal: jest.fn(),
        signAndCreateTransactionRequest: jest.fn(async () => ({
          serialize: () => new Uint8Array([1]),
          authArg: () => undefined
        })),
        sync: jest.fn(async () => {})
      };
      mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

      const client = Object.assign(makeClientApi(result), {
        getSyncHeight: jest.fn(async () => 100)
      });
      mockGetMidenClient.mockResolvedValue({
        getAccount: jest.fn(async () => undefined),
        syncState: jest.fn(async () => {}),
        client
      });

      await generateTransaction(
        transaction,
        jest.fn(async () => new Uint8Array([2])),
        false,
        makeGuardianProvider(true)
      );

      expect(mockCreateWasmWebClient).not.toHaveBeenCalled();
      expect(mockBuildSendTransactionRequest).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ toString: expect.any(Function) }),
        expect.objectContaining({ toString: expect.any(Function) }),
        'faucet',
        1000n,
        expectedSdkNoteType,
        125
      );
      expect(multisigService.createCustomProposal).toHaveBeenCalledWith(requestBytes, 'recallable_send');
      expect(multisigService.createSendProposal).not.toHaveBeenCalled();
      expect(multisigService.signAndCreateTransactionRequest).toHaveBeenCalledWith('recall-proposal', requestBytes);
      expect(txStore.find(row => row.id === txId)?.requestBytes).toBe(requestBytes);
    }
  );

  // The sibling cases above all resolve `getAccount` to undefined, exercising
  // only the no-vault fallback. The account is what supplies the outgoing
  // asset's vault key (callback flag included), so a guardian send that dropped
  // it would silently rebuild the asset with the default Disabled flag and abort
  // in the kernel — the very bug this path was changed to fix.
  it('Guardian recallable send passes the sender account through as the vault-key source', async () => {
    const txId = 'recallable-vault-key';
    const result = makeResult();
    const requestBytes = new Uint8Array([7, 8, 9]);
    const transaction = Object.assign(new Transaction('guardian-acc', new Uint8Array()), {
      id: txId,
      type: 'send',
      amount: 1000n,
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      noteType: 'public',
      requestBytes: undefined,
      extraInputs: { recallBlocks: 25 },
      delegateTransaction: false
    });
    txStore.push({ ...transaction, status: ITransactionStatus.Queued });

    mockBuildSendTransactionRequest.mockReturnValue({ serialize: () => requestBytes });
    const senderAccount = { vault: jest.fn() };
    const getAccount = jest.fn(async () => senderAccount);

    const multisigService = {
      createCustomProposal: jest.fn(async () => ({ id: 'recall-proposal' })),
      createSendProposal: jest.fn(),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    const client = Object.assign(makeClientApi(result), { getSyncHeight: jest.fn(async () => 100) });
    mockGetMidenClient.mockResolvedValue({ getAccount, syncState: jest.fn(async () => {}), client });

    await generateTransaction(
      transaction,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    // Read through the client proxy by the SENDER's canonical id, and handed to
    // the builder verbatim. No transient WasmWebClient is spun up for it.
    expect(getAccount).toHaveBeenCalledWith('sdk-guardian-acc');
    expect(mockCreateWasmWebClient).not.toHaveBeenCalled();
    expect(mockBuildSendTransactionRequest).toHaveBeenCalledWith(
      senderAccount,
      expect.anything(),
      expect.anything(),
      'faucet',
      1000n,
      'Public',
      125
    );
  });

  /**
   * A PSWAP create removes the offered asset from the creator's vault, so it is
   * subject to the same callback-flag rule as every send: the flag is part of the
   * vault key. The PSWAP builder takes a faucet id and an amount, not an asset,
   * and always produces the Disabled variant — so this path re-emits the note it
   * builds against the creator's actual slot before the bytes are frozen.
   */
  it('Guardian swap re-emits the PSWAP note against the creator vault before freezing the bytes', async () => {
    const txId = 'guardian-swap-vault-key';
    const result = makeResult();
    const rebuiltBytes = new Uint8Array([11, 12, 13]);
    const transaction = Object.assign(new Transaction('guardian-acc', new Uint8Array()), {
      id: txId,
      type: 'swap',
      amount: 1000n,
      faucetId: 'offered-faucet',
      requestBytes: undefined,
      extraInputs: { requestedFaucetId: 'requested-faucet', requestedAmount: 500n },
      delegateTransaction: false
    });
    txStore.push({ ...transaction, status: ITransactionStatus.Queued });

    mockBuildPswapCreateRequest.mockReturnValue({ serialize: () => rebuiltBytes });
    const creatorAccount = { vault: jest.fn() };
    const getAccount = jest.fn(async () => creatorAccount);

    // The reference request the SDK builder returns, to be rewritten.
    const reference = { kind: 'reference-request', serialize: () => new Uint8Array([99]) };
    const newPswapCreateTransactionRequest = jest.fn(async () => reference);
    const terminate = jest.fn();
    mockCreateWasmWebClient.mockResolvedValue({ newPswapCreateTransactionRequest, terminate });

    const multisigService = {
      createCustomProposal: jest.fn(async () => ({ id: 'swap-proposal' })),
      createSendProposal: jest.fn(),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    const client = Object.assign(makeClientApi(result), { getSyncHeight: jest.fn(async () => 100) });
    mockGetMidenClient.mockResolvedValue({ getAccount, syncState: jest.fn(async () => {}), client });

    await generateTransaction(
      transaction,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    // The creator's vault, by canonical id, handed to the rewrite verbatim.
    expect(getAccount).toHaveBeenCalledWith('sdk-guardian-acc');
    expect(mockBuildPswapCreateRequest).toHaveBeenCalledWith(creatorAccount, reference, 'offered-faucet', 1000n);
    // One builder call: each draws a fresh serial number, which IS the order id,
    // so building one request to inspect and another to propose would register a
    // different order than the one the wallet tracks.
    expect(newPswapCreateTransactionRequest).toHaveBeenCalledTimes(1);
    // And the REWRITTEN bytes are what get frozen and proposed — the whole point,
    // since these same bytes are replayed for signAndCreateTransactionRequest.
    expect(txStore.find(row => row.id === txId)?.requestBytes).toBe(rebuiltBytes);
    expect(multisigService.createCustomProposal).toHaveBeenCalledWith(rebuiltBytes, 'swap');
    expect(multisigService.signAndCreateTransactionRequest).toHaveBeenCalledWith('swap-proposal', rebuiltBytes);
    // The transient client is always torn down, rewrite or not.
    expect(terminate).toHaveBeenCalled();
  });

  it('Guardian Epoch bridged-send builds a public recallable P2IDE custom proposal (the allocator rejects a plain P2ID)', async () => {
    const txId = 'guardian-bridged-send';
    const result = makeResult();
    const requestBytes = new Uint8Array([4, 5, 6]);
    const transaction = Object.assign(new Transaction('guardian-acc', new Uint8Array()), {
      id: txId,
      type: 'bridged-send',
      amount: 1000n,
      secondaryAccountId: 'allocator',
      faucetId: 'faucet',
      noteType: 'public',
      requestBytes: undefined,
      // provider 'epoch' + recallBlocks select the P2IDE Epoch branch; the Agglayer
      // path carries pre-built requestBytes with provider 'agglayer'.
      extraInputs: { provider: 'epoch', recallBlocks: 30 },
      delegateTransaction: false
    });
    txStore.push({ ...transaction, status: ITransactionStatus.Queued });

    mockBuildSendTransactionRequest.mockReturnValue({ serialize: () => requestBytes });

    const multisigService = {
      createSendProposal: jest.fn(),
      createCustomProposal: jest.fn(async () => ({ id: 'bridge-proposal' })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    // freshSync: the bridged-send helper (like earn-deposit) measures the reclaim
    // height against a fresh chain head, so mock client.sync().blockNum().
    const client = Object.assign(makeClientApi(result), { sync: jest.fn(async () => ({ blockNum: () => 200 })) });
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client
    });

    await generateTransaction(
      transaction,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    // A plain P2ID (createSendProposal) is rejected by the allocator; the note must
    // be a PUBLIC recallable P2IDE built from the row's recallBlocks (absolute
    // reclaim height = fresh syncHeight 200 + recallBlocks 30 = 230).
    expect(mockBuildSendTransactionRequest).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ toString: expect.any(Function) }),
      expect.objectContaining({ toString: expect.any(Function) }),
      'faucet',
      1000n,
      'Public',
      230
    );
    expect(multisigService.createCustomProposal).toHaveBeenCalledWith(requestBytes, 'bridged_send');
    expect(multisigService.createSendProposal).not.toHaveBeenCalled();
    expect(txStore.find(row => row.id === txId)?.requestBytes).toBe(requestBytes);
  });

  it('Guardian earn-deposit builds a P2IDE collateral note to the allocator via a custom proposal', async () => {
    const txId = 'earn-guardian';
    const result = makeResult();
    const requestBytes = new Uint8Array([11, 12, 13]);
    const transaction = Object.assign(new Transaction('guardian-acc', new Uint8Array()), {
      id: txId,
      type: 'earn-deposit',
      amount: 1000n,
      secondaryAccountId: 'allocator',
      faucetId: 'faucet',
      // Row says 'private', but earn collateral is always minted PUBLIC — the 4th-arg
      // assertion ('Public') below only holds if the source ignores the row's noteType.
      noteType: 'private',
      requestBytes: undefined,
      extraInputs: { recallBlocks: 25 },
      delegateTransaction: true
    });
    txStore.push({ ...transaction, status: ITransactionStatus.Queued });

    mockBuildSendTransactionRequest.mockReturnValue({ serialize: () => requestBytes });

    const multisigService = {
      createCustomProposal: jest.fn(async () => ({ id: 'earn-proposal' })),
      createSendProposal: jest.fn(),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    const client = Object.assign(makeClientApi(result), {
      sync: jest.fn(async () => ({ blockNum: () => 100 }))
    });
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client
    });

    await generateTransaction(
      transaction,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    // P2IDE collateral note to the allocator with an absolute reclaim height
    // (syncHeight 100 + recallBlocks 25 = 125), proposed as a custom proposal —
    // never a plain P2ID send proposal.
    expect(mockBuildSendTransactionRequest).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ toString: expect.any(Function) }),
      expect.objectContaining({ toString: expect.any(Function) }),
      'faucet',
      1000n,
      'Public',
      125
    );
    expect(multisigService.createCustomProposal).toHaveBeenCalledWith(requestBytes, 'earn_deposit');
    expect(multisigService.createSendProposal).not.toHaveBeenCalled();
    expect(multisigService.signAndCreateTransactionRequest).toHaveBeenCalledWith('earn-proposal', requestBytes);
    expect(txStore.find(row => row.id === txId)?.requestBytes).toBe(requestBytes);

    // Completion must route to completeEarnDepositTransaction, NOT the generic custom-tx
    // completion — otherwise the row finishes without the collateral note id that
    // createEarnP2IDENote reads back for the Epoch handoff (stranding the deposit).
    // 'Deposited to lending' is set only by completeEarnDepositTransaction, so it pins
    // the routing: deleting the completion case fails this assertion.
    const completed = txStore.find(row => row.id === txId);
    expect(completed?.status).toBe(ITransactionStatus.Completed);
    expect(completed?.displayMessage).toBe('Deposited to lending');
  });

  it('Guardian earn-deposit: falls back to the last-synced height when the fresh sync fails', async () => {
    // A transient network sync failure must NOT fail an otherwise-submittable deposit —
    // the note build falls back to the cached getSyncHeight() (the recall buffer absorbs
    // mild lag), keeping the guardian path no more network-fragile than before.
    const txId = 'earn-guardian-syncfail';
    const requestBytes = new Uint8Array([51, 52, 53]);
    const transaction = Object.assign(new Transaction('guardian-acc', new Uint8Array()), {
      id: txId,
      type: 'earn-deposit',
      amount: 1000n,
      secondaryAccountId: 'allocator',
      faucetId: 'faucet',
      noteType: 'public',
      requestBytes: undefined,
      extraInputs: { recallBlocks: 25 },
      delegateTransaction: true
    });
    txStore.push({ ...transaction, status: ITransactionStatus.Queued });

    mockBuildSendTransactionRequest.mockReturnValue({ serialize: () => requestBytes });

    const multisigService = {
      createCustomProposal: jest.fn(async () => ({ id: 'earn-syncfail-proposal' })),
      createSendProposal: jest.fn(),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    // Fresh sync throws; getSyncHeight (the fallback) returns 200.
    const client = Object.assign(makeClientApi(makeResult()), {
      sync: jest.fn(async () => {
        throw new Error('sync timed out');
      }),
      getSyncHeight: jest.fn(async () => 200)
    });
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client
    });

    await generateTransaction(
      transaction,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    // Built with the fallback height (200 + 25 = 225) and proceeded to a custom proposal.
    expect(mockBuildSendTransactionRequest).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ toString: expect.any(Function) }),
      expect.objectContaining({ toString: expect.any(Function) }),
      'faucet',
      1000n,
      'Public',
      225
    );
    expect(multisigService.createCustomProposal).toHaveBeenCalledWith(requestBytes, 'earn_deposit');
  });

  it('Guardian earn-deposit reuses persisted request bytes after a retry', async () => {
    const txId = 'earn-guardian-retry';
    const result = makeResult();
    const requestBytes = new Uint8Array([7, 8, 9]);
    const transaction = Object.assign(new Transaction('guardian-acc', requestBytes), {
      id: txId,
      type: 'earn-deposit',
      amount: 1000n,
      secondaryAccountId: 'allocator',
      faucetId: 'faucet',
      noteType: 'public',
      extraInputs: { recallBlocks: 25 },
      delegateTransaction: true
    });
    txStore.push({ ...transaction, status: ITransactionStatus.Queued });

    const multisigService = {
      createCustomProposal: jest.fn(async () => ({ id: 'earn-retry-proposal' })),
      createSendProposal: jest.fn(),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: makeClientApi(result)
    });

    await generateTransaction(
      transaction,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    // Persisted bytes are reused verbatim — no fresh P2IDE request is built.
    expect(mockCreateWasmWebClient).not.toHaveBeenCalled();
    expect(multisigService.createCustomProposal).toHaveBeenCalledWith(requestBytes, 'earn_deposit');
    expect(multisigService.signAndCreateTransactionRequest).toHaveBeenCalledWith('earn-retry-proposal', requestBytes);
  });

  it('Guardian earn-deposit refuses to build a non-recallable note when recallBlocks is missing', async () => {
    const txId = 'earn-guardian-norecall';
    const transaction = Object.assign(new Transaction('guardian-acc', new Uint8Array()), {
      id: txId,
      type: 'earn-deposit',
      amount: 1000n,
      secondaryAccountId: 'allocator',
      faucetId: 'faucet',
      noteType: 'public',
      requestBytes: undefined,
      extraInputs: {}, // no recallBlocks — a P2ID note would lock the collateral with no reclaim path
      delegateTransaction: true
    });
    txStore.push({ ...transaction, status: ITransactionStatus.Queued });

    const multisigService = {
      createCustomProposal: jest.fn(),
      createSendProposal: jest.fn(),
      signAndCreateTransactionRequest: jest.fn(),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: makeClientApi(makeResult())
    });

    await generateTransaction(
      transaction,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    // The row fails fast; no P2IDE request or proposal is built.
    expect(mockCreateWasmWebClient).not.toHaveBeenCalled();
    expect(multisigService.createCustomProposal).not.toHaveBeenCalled();
    expect(txStore.find(row => row.id === txId)?.status).toBe(ITransactionStatus.Failed);
  });

  it('Guardian earn-deposit refuses to build a note when the allocator (secondaryAccountId) is missing', async () => {
    const txId = 'earn-guardian-noalloc';
    const transaction = Object.assign(new Transaction('guardian-acc', new Uint8Array()), {
      id: txId,
      type: 'earn-deposit',
      amount: 1000n,
      secondaryAccountId: undefined, // no allocator to send the collateral to
      faucetId: 'faucet',
      noteType: 'public',
      requestBytes: undefined,
      extraInputs: { recallBlocks: 25 }, // recallBlocks present — only the allocator is missing
      delegateTransaction: true
    });
    txStore.push({ ...transaction, status: ITransactionStatus.Queued });

    const multisigService = {
      createCustomProposal: jest.fn(),
      createSendProposal: jest.fn(),
      signAndCreateTransactionRequest: jest.fn(),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: makeClientApi(makeResult())
    });

    await generateTransaction(
      transaction,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    // Same fail-fast as the missing-recallBlocks case — the other half of the guard.
    expect(mockCreateWasmWebClient).not.toHaveBeenCalled();
    expect(multisigService.createCustomProposal).not.toHaveBeenCalled();
    expect(txStore.find(row => row.id === txId)?.status).toBe(ITransactionStatus.Failed);
  });

  it('Guardian earn-deposit: refuses to submit once the caller abandoned the deposit (epochStatus=failed)', async () => {
    // openEarnPosition marks epochStatus 'failed' when it gives up (its 5-min wait timed
    // out / the Epoch intent was aborted). A guardian requeue can outlive that wait, so
    // the loop must NOT then build+submit an orphan collateral note (no live intent) —
    // it fails the row instead.
    const txId = 'earn-guardian-abandoned';
    const transaction = Object.assign(new Transaction('guardian-acc', new Uint8Array()), {
      id: txId,
      type: 'earn-deposit',
      amount: 1000n,
      secondaryAccountId: 'allocator',
      faucetId: 'faucet',
      noteType: 'public',
      requestBytes: undefined,
      extraInputs: { recallBlocks: 25, epochStatus: 'failed' },
      delegateTransaction: true
    });
    txStore.push({ ...transaction, status: ITransactionStatus.Queued });

    const multisigService = {
      createCustomProposal: jest.fn(),
      createSendProposal: jest.fn(),
      signAndCreateTransactionRequest: jest.fn(),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: makeClientApi(makeResult())
    });

    await generateTransaction(
      transaction,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    // No note built or proposed; the row is Failed (terminal), never Completed.
    expect(mockCreateWasmWebClient).not.toHaveBeenCalled();
    expect(multisigService.createCustomProposal).not.toHaveBeenCalled();
    expect(txStore.find(row => row.id === txId)?.status).toBe(ITransactionStatus.Failed);
  });

  it('Guardian earn-deposit: a still-pending 409 requeues AND drops the frozen requestBytes so the next cycle rebuilds a fresh reclaim height', async () => {
    // An earn-deposit builds requestBytes (with an absolute reclaim height) BEFORE the
    // custom proposal. If the proposal keeps hitting a transient pending-delta 409, the
    // row is requeued — but the frozen bytes must be dropped, or a delayed re-submit
    // would land a collateral note whose remaining reclaim window is below the Epoch
    // allocator's minimum (stranding the collateral). Assert the drop.
    jest.useFakeTimers();
    try {
      const txId = 'earn-pending-conflict';
      const requestBytes = new Uint8Array([21, 22, 23]);
      txStore.push({
        id: txId,
        type: 'earn-deposit',
        accountId: 'guardian-acc',
        status: ITransactionStatus.Queued,
        secondaryAccountId: 'allocator',
        faucetId: 'faucet',
        amount: 1000n,
        noteType: 'public',
        extraInputs: { recallBlocks: 25 },
        delegateTransaction: true,
        initiatedAt: Math.floor(Date.now() / 1000),
        // Seeded on the ROW — see the recallable-send case below. Asserting
        // "undefined after the requeue" against a row that never carried bytes
        // pins nothing.
        requestBytes: new Uint8Array([81, 82, 83])
      });

      mockBuildSendTransactionRequest.mockReturnValue({ serialize: () => requestBytes });

      const conflict = { status: 409, body: 'ConflictPendingDelta' };
      const multisigService = {
        createCustomProposal: jest.fn(async () => {
          throw conflict;
        }),
        createSendProposal: jest.fn(),
        signAndCreateTransactionRequest: jest.fn(),
        sync: jest.fn(async () => {})
      };
      mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
      const client = Object.assign(makeClientApi(makeResult()), {
        sync: jest.fn(async () => ({ blockNum: () => 100 }))
      });
      mockGetMidenClient.mockResolvedValue({
        getAccount: jest.fn(async () => undefined),
        syncState: jest.fn(async () => {}),
        client
      });

      const pending = generateTransaction(
        Object.assign(new Transaction('guardian-acc', new Uint8Array()), {
          id: txId,
          type: 'earn-deposit',
          amount: 1000n,
          secondaryAccountId: 'allocator',
          faucetId: 'faucet',
          noteType: 'public',
          extraInputs: { recallBlocks: 25 },
          delegateTransaction: true
        }),
        jest.fn(async () => new Uint8Array([2])),
        false,
        makeGuardianProvider(true)
      );
      // Fast-forward withGuardianConflictRetry's backoff so the retry budget exhausts.
      await jest.runAllTimersAsync();
      await pending;

      const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
      // Requeued (transient lock), not terminally Failed...
      expect(row.status).toBe(ITransactionStatus.Queued);
      // ...and the frozen absolute-height request was dropped so the next cycle rebuilds
      // the note against a fresh sync height (swap keeps its bytes — the PSWAP flow
      // requires byte-identical reuse; earn-deposit and send must not).
      expect(row.requestBytes).toBeUndefined();
      expect(multisigService.signAndCreateTransactionRequest).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('Guardian recallable send: a still-pending 409 requeues AND drops the frozen requestBytes', async () => {
    // Same rule as the earn-deposit case above, for the other type that freezes a
    // request before proposing it. A recallable send's bytes pin an absolute reclaim
    // height AND the outgoing asset as first built — so a wrong callback flag there
    // would fail the kernel's remove-asset assertion on every requeue cycle for as
    // long as the bytes survive. Nothing reached the chain on a pre-submit requeue,
    // so dropping them is safe.
    jest.useFakeTimers();
    try {
      const txId = 'send-pending-conflict';
      const requestBytes = new Uint8Array([41, 42, 43]);
      txStore.push({
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        status: ITransactionStatus.Queued,
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: 1000n,
        noteType: 'public',
        extraInputs: { recallBlocks: 25 },
        delegateTransaction: false,
        initiatedAt: Math.floor(Date.now() / 1000),
        // Seeded on the ROW, which is what the clear acts on. Without this the
        // assertion below ("no bytes after the requeue") is true because the
        // pipeline never persisted any, so deleting the whole clear leaves this
        // test green — it would pin nothing.
        requestBytes: new Uint8Array([91, 92, 93])
      });

      mockBuildSendTransactionRequest.mockReturnValue({ serialize: () => requestBytes });

      const conflict = { status: 409, body: 'ConflictPendingDelta' };
      const multisigService = {
        createCustomProposal: jest.fn(async () => {
          throw conflict;
        }),
        createSendProposal: jest.fn(),
        signAndCreateTransactionRequest: jest.fn(),
        sync: jest.fn(async () => {})
      };
      mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
      const client = Object.assign(makeClientApi(makeResult()), {
        getSyncHeight: jest.fn(async () => 100)
      });
      mockGetMidenClient.mockResolvedValue({
        getAccount: jest.fn(async () => undefined),
        syncState: jest.fn(async () => {}),
        client
      });

      const pending = generateTransaction(
        Object.assign(new Transaction('guardian-acc', new Uint8Array()), {
          id: txId,
          type: 'send',
          amount: 1000n,
          secondaryAccountId: 'recipient',
          faucetId: 'faucet',
          noteType: 'public',
          extraInputs: { recallBlocks: 25 },
          delegateTransaction: false
        }),
        jest.fn(async () => new Uint8Array([2])),
        false,
        makeGuardianProvider(true)
      );
      await jest.runAllTimersAsync();
      await pending;

      const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
      expect(row.status).toBe(ITransactionStatus.Queued);
      expect(row.requestBytes).toBeUndefined();
      expect(multisigService.signAndCreateTransactionRequest).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('Guardian recallable send: a 409 requeue KEEPS the bytes once the row is flagged mayHaveSubmitted', async () => {
    // The "nothing reached the chain on a pre-submit requeue" argument above is
    // about the attempt running right now, not about the row. A user Retry of a
    // send that died post-submit keeps its bytes and stamps `mayHaveSubmitted`;
    // the fresh attempt can then hit a 409 here. Clearing on the strength of
    // THIS attempt's stage would draw a new note serial for a transfer that may
    // already have landed — the double-send the flag exists to prevent.
    jest.useFakeTimers();
    try {
      const txId = 'send-pending-conflict-flagged';
      const frozen = new Uint8Array([61, 62, 63]);
      txStore.push({
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        status: ITransactionStatus.Queued,
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: 1000n,
        noteType: 'public',
        requestBytes: frozen,
        mayHaveSubmitted: true,
        extraInputs: { recallBlocks: 25 },
        delegateTransaction: false,
        initiatedAt: Math.floor(Date.now() / 1000)
      });

      mockBuildSendTransactionRequest.mockReturnValue({ serialize: () => frozen });

      const conflict = { status: 409, body: 'ConflictPendingDelta' };
      const multisigService = {
        createCustomProposal: jest.fn(async () => {
          throw conflict;
        }),
        createSendProposal: jest.fn(),
        signAndCreateTransactionRequest: jest.fn(),
        sync: jest.fn(async () => {})
      };
      mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
      const client = Object.assign(makeClientApi(makeResult()), {
        getSyncHeight: jest.fn(async () => 100)
      });
      mockGetMidenClient.mockResolvedValue({
        getAccount: jest.fn(async () => undefined),
        syncState: jest.fn(async () => {}),
        client
      });

      const pending = generateTransaction(
        Object.assign(new Transaction('guardian-acc', frozen), {
          id: txId,
          type: 'send',
          amount: 1000n,
          secondaryAccountId: 'recipient',
          faucetId: 'faucet',
          noteType: 'public',
          requestBytes: frozen,
          mayHaveSubmitted: true,
          extraInputs: { recallBlocks: 25 },
          delegateTransaction: false
        }),
        jest.fn(async () => new Uint8Array([2])),
        false,
        makeGuardianProvider(true)
      );
      await jest.runAllTimersAsync();
      await pending;

      const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
      expect(row.status).toBe(ITransactionStatus.Queued);
      expect(row.requestBytes).toBe(frozen);
    } finally {
      jest.useRealTimers();
    }
  });

  it('Guardian earn-deposit: submit lands but local apply fails — row is marked Failed (not Completed) so the awaiting caller stops waiting', async () => {
    // A Completed earn-deposit row without resultBytes would hang createEarnP2IDENote's
    // waitForTransactionCompletion (TransactionResult.deserialize(undefined) throws after
    // cleanup(), so the wait promise never settles and openEarnPosition hangs forever).
    // A post-submit apply failure must therefore Fail the row, NOT Complete it — unlike
    // send/consume/swap/execute, which mark Completed and let the next sync reconcile.
    const txId = 'earn-guardian-applyfail';
    const requestBytes = new Uint8Array([31, 32, 33]);
    const transaction = Object.assign(new Transaction('guardian-acc', new Uint8Array()), {
      id: txId,
      type: 'earn-deposit',
      amount: 1000n,
      secondaryAccountId: 'allocator',
      faucetId: 'faucet',
      noteType: 'public',
      requestBytes: undefined,
      extraInputs: { recallBlocks: 25 },
      delegateTransaction: true
    });
    txStore.push({ ...transaction, status: ITransactionStatus.Queued });

    mockBuildSendTransactionRequest.mockReturnValue({ serialize: () => requestBytes });

    const multisigService = {
      createCustomProposal: jest.fn(async () => ({ id: 'earn-applyfail-proposal', nonce: 5 })),
      createSendProposal: jest.fn(),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      abandonCandidate: jest.fn(async () => {}),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    // Submit lands on-chain but the LOCAL apply throws ApplyTransactionAfterSubmitFailed.
    const applyErr = new Error(APPLY_AFTER_SUBMIT_ERROR_MESSAGE);
    const applyFn = jest.fn(async () => {
      throw applyErr;
    });
    const client = Object.assign(makeClientApi(makeResult(), applyFn), {
      sync: jest.fn(async () => ({ blockNum: () => 100 }))
    });
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client
    });

    await generateTransaction(
      transaction,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    // The failure is specifically POST-submit — the proposal was signed and the tx
    // submitted (apply runs only after submit lands), so the generic value-moving path
    // would have marked it Completed. This pins the earn-deposit exception to the guard,
    // distinguishing it from both a pre-submit early throw and the Completed fallback.
    expect(multisigService.signAndCreateTransactionRequest).toHaveBeenCalled();
    expect(applyFn).toHaveBeenCalled();
    const row = txStore.find(r => r.id === txId);
    expect(row?.status).toBe(ITransactionStatus.Failed);
    // Never a Completed-branch success message.
    expect(row?.displayMessage).not.toBe('Deposited to lending');
    expect(row?.displayMessage).not.toBe('Sent');
  });

  it('Guardian earn-deposit: a canonicalization race after submit also marks the row Failed (not Completed)', async () => {
    // The other arm of the same guard: a canonicalization nonce-lag error would mark
    // any other guardian tx Completed, but for earn-deposit that Completed-without-
    // resultBytes state hangs the caller, so it must Fail here too.
    const txId = 'earn-guardian-canon';
    const requestBytes = new Uint8Array([41, 42, 43]);
    const transaction = Object.assign(new Transaction('guardian-acc', new Uint8Array()), {
      id: txId,
      type: 'earn-deposit',
      amount: 1000n,
      secondaryAccountId: 'allocator',
      faucetId: 'faucet',
      noteType: 'public',
      requestBytes: undefined,
      extraInputs: { recallBlocks: 25 },
      delegateTransaction: true
    });
    txStore.push({ ...transaction, status: ITransactionStatus.Queued });

    mockBuildSendTransactionRequest.mockReturnValue({ serialize: () => requestBytes });

    const multisigService = {
      createCustomProposal: jest.fn(async () => ({ id: 'earn-canon-proposal', nonce: 6 })),
      createSendProposal: jest.fn(),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      abandonCandidate: jest.fn(async () => {}),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    const canonErr = new Error('Refusing to overwrite local state: incoming nonce 5 is not greater than local nonce 7');
    const client = Object.assign(
      makeClientApi(
        makeResult(),
        jest.fn(async () => {
          throw canonErr;
        })
      ),
      { sync: jest.fn(async () => ({ blockNum: () => 100 })) }
    );
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client
    });

    await generateTransaction(
      transaction,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    expect(txStore.find(r => r.id === txId)?.status).toBe(ITransactionStatus.Failed);
  });

  it('Guardian bridged-send: submit lands but local apply fails — row is marked Failed (not Completed)', async () => {
    // Same hazard as earn-deposit: `createBridgeP2IDNote` blocks on
    // waitForTransactionCompletion and reads `outputNoteIds` off the finished row.
    // A Completed row with no resultBytes hangs that wait forever (the Epoch intent
    // is never submitted) while the activity view reads "Bridged to EVM".
    const txId = 'bridge-guardian-applyfail';
    const requestBytes = new Uint8Array([51, 52, 53]);
    const transaction = Object.assign(new Transaction('guardian-acc', new Uint8Array()), {
      id: txId,
      type: 'bridged-send',
      amount: 1000n,
      secondaryAccountId: 'allocator',
      faucetId: 'faucet',
      noteType: 'public',
      requestBytes: undefined,
      extraInputs: {
        provider: 'epoch',
        destinationAddress: '0xevm',
        destinationNetwork: 8453,
        sourceFaucetId: 'faucet',
        claimStatus: 'not-applicable',
        recallBlocks: 1200
      },
      delegateTransaction: true
    });
    txStore.push({ ...transaction, status: ITransactionStatus.Queued });

    // Built through the shared helper against the sender's vault, not a transient
    // raw client — see `ensureGuardianRecallableSendRequestBytes`.
    mockBuildSendTransactionRequest.mockReturnValue({ serialize: () => requestBytes });

    const multisigService = {
      createCustomProposal: jest.fn(async () => ({ id: 'bridge-applyfail-proposal', nonce: 8 })),
      createSendProposal: jest.fn(),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      abandonCandidate: jest.fn(async () => {}),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    const applyFn = jest.fn(async () => {
      throw new Error(APPLY_AFTER_SUBMIT_ERROR_MESSAGE);
    });
    const client = Object.assign(makeClientApi(makeResult(), applyFn), {
      sync: jest.fn(async () => ({ blockNum: () => 100 }))
    });
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client
    });

    await generateTransaction(
      transaction,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    // POST-submit: the proposal was signed and submitted before apply threw, so the
    // generic value-moving arm would have marked this Completed / 'Sent'.
    expect(multisigService.signAndCreateTransactionRequest).toHaveBeenCalled();
    expect(applyFn).toHaveBeenCalled();
    const row = txStore.find(r => r.id === txId);
    expect(row?.status).toBe(ITransactionStatus.Failed);
    expect(row?.displayMessage).not.toBe('Sent');
  });

  it('Guardian AGGLAYER bridged-send: submit lands but local apply fails — row is marked Completed (not Failed)', async () => {
    // Route-specific, unlike the Epoch case above. An Agglayer (Slow) row is queued
    // by `initiateB2AggBridge`, which never awaits the row, so there is no waiter to
    // strand — and its B2AGG note IS on chain. Failing it would hide the L1 claim UI
    // (`BridgeClaimSection` gates the whole Connect-wallet / Claim-Asset block on
    // `status !== Failed`) on funds that already left the account.
    const txId = 'bridge-guardian-agglayer-applyfail';
    const requestBytes = new Uint8Array([71, 72, 73]);
    const transaction = Object.assign(new Transaction('guardian-acc', new Uint8Array()), {
      id: txId,
      type: 'bridged-send',
      amount: 1000n,
      faucetId: 'faucet',
      requestBytes,
      extraInputs: {
        provider: 'agglayer',
        destinationAddress: '0xevm',
        destinationNetwork: 0,
        sourceFaucetId: 'faucet',
        claimStatus: 'pending'
      },
      delegateTransaction: true
    });
    txStore.push({ ...transaction, status: ITransactionStatus.Queued });

    const multisigService = {
      createCustomProposal: jest.fn(async () => ({ id: 'bridge-agglayer-proposal', nonce: 10 })),
      createSendProposal: jest.fn(),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      abandonCandidate: jest.fn(async () => {}),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    const applyFn = jest.fn(async () => {
      throw new Error(APPLY_AFTER_SUBMIT_ERROR_MESSAGE);
    });
    const client = Object.assign(makeClientApi(makeResult(), applyFn), {
      sync: jest.fn(async () => ({ blockNum: () => 100 }))
    });
    mockGetMidenClient.mockResolvedValue({ syncState: jest.fn(async () => {}), client });

    await generateTransaction(
      transaction,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    expect(applyFn).toHaveBeenCalled();
    const row = txStore.find(r => r.id === txId);
    expect(row?.status).toBe(ITransactionStatus.Completed);
    // The label matches what `completeBridgedSendTransaction` writes on the happy path.
    expect(row?.displayMessage).toBe('Bridged to EVM');
  });

  it('Guardian bridged-send: a canonicalization race after submit also marks the row Failed (not Completed)', async () => {
    // The canonicalization arm has no type filter at all, so before the fix a
    // guardian bridged-send — the wallet's default account type — took the
    // type-agnostic Completed path and hung `createBridgeP2IDNote`.
    const txId = 'bridge-guardian-canon';
    const requestBytes = new Uint8Array([61, 62, 63]);
    const transaction = Object.assign(new Transaction('guardian-acc', new Uint8Array()), {
      id: txId,
      type: 'bridged-send',
      amount: 1000n,
      secondaryAccountId: 'allocator',
      faucetId: 'faucet',
      noteType: 'public',
      requestBytes: undefined,
      extraInputs: {
        provider: 'epoch',
        destinationAddress: '0xevm',
        destinationNetwork: 8453,
        sourceFaucetId: 'faucet',
        claimStatus: 'not-applicable',
        recallBlocks: 1200
      },
      delegateTransaction: true
    });
    txStore.push({ ...transaction, status: ITransactionStatus.Queued });

    const newSendTransactionRequest = jest.fn(async () => ({ serialize: () => requestBytes }));
    mockCreateWasmWebClient.mockResolvedValue({ newSendTransactionRequest, terminate: jest.fn() });

    const multisigService = {
      createCustomProposal: jest.fn(async () => ({ id: 'bridge-canon-proposal', nonce: 9 })),
      createSendProposal: jest.fn(),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      abandonCandidate: jest.fn(async () => {}),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    const canonErr = new Error('Refusing to overwrite local state: incoming nonce 5 is not greater than local nonce 7');
    const client = Object.assign(
      makeClientApi(
        makeResult(),
        jest.fn(async () => {
          throw canonErr;
        })
      ),
      { sync: jest.fn(async () => ({ blockNum: () => 100 })) }
    );
    mockGetMidenClient.mockResolvedValue({ syncState: jest.fn(async () => {}), client });

    await generateTransaction(
      transaction,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    const row = txStore.find(r => r.id === txId);
    expect(row?.status).toBe(ITransactionStatus.Failed);
    expect(row?.displayMessage).not.toBe('Sent');
  });

  it('Guardian recallable send reuses persisted request bytes after a retry', async () => {
    const txId = 'recallable-retry';
    const result = makeResult();
    const requestBytes = new Uint8Array([4, 5, 6]);
    const transaction = Object.assign(new Transaction('guardian-acc', requestBytes), {
      id: txId,
      type: 'send',
      amount: 1000n,
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      noteType: 'private',
      extraInputs: { recallBlocks: 25 },
      delegateTransaction: false
    });
    txStore.push({
      ...transaction,
      status: ITransactionStatus.Queued
    });

    const multisigService = {
      createCustomProposal: jest.fn(async () => ({ id: 'retry-proposal' })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: makeClientApi(result)
    });

    await generateTransaction(
      transaction,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    expect(mockCreateWasmWebClient).not.toHaveBeenCalled();
    expect(multisigService.createCustomProposal).toHaveBeenCalledWith(requestBytes, 'recallable_send');
    expect(multisigService.signAndCreateTransactionRequest).toHaveBeenCalledWith('retry-proposal', requestBytes);
  });

  it('Guardian send (delegated): a remote-prover timeout falls back to the local prover and completes', async () => {
    // The guardian pipeline delegates proving to the remote prover, which has a
    // ~10s gRPC deadline. A heavyweight guardian multisig proof under load can
    // exceed it ("Deadline expired"). Unlike the non-guardian path, the guardian
    // pipeline used to have no fallback, so a single timeout killed the co-signed
    // tx (→ 409 canonicalize-conflict loop → claim timeout). It must now re-prove
    // the SAME executed tx locally and still complete, without abandoning the
    // guardian candidate.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const txId = 'send-guardian-delegated';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000',
      delegateTransaction: true,
      initiatedAt: Math.floor(Date.now() / 1000)
    });

    const abandonCandidate = jest.fn(async () => {});
    const multisigService = {
      createSendProposal: jest.fn(async () => ({ id: 'prop-1', nonce: 5 })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      abandonCandidate,
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    const client = makeClientApi(result);
    // First (delegated/remote) prove times out; the local re-prove succeeds.
    client.transactions.prove.mockRejectedValueOnce(
      new Error('failed to prove transaction: Deadline expired before operation could complete')
    );
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client
    });

    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: true
      } as never,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    // Proved twice: once delegated (no explicit prover), then locally on retry
    // with the desktop/extension WASM local prover (the test env is non-mobile).
    expect(client.transactions.prove).toHaveBeenCalledTimes(2);
    expect(client.transactions.prove).toHaveBeenNthCalledWith(1, result, {});
    expect(client.transactions.prove).toHaveBeenNthCalledWith(2, result, { prover: 'local-prover' });
    expect(TransactionProver.newLocalProver).toHaveBeenCalledTimes(1);
    expect(TransactionProver.newCallbackProver).not.toHaveBeenCalled();
    // The local fallback prove is unbounded by design, so it must run under a
    // lock-watchdog pause (#775).
    expect(mockWithWasmLockWatchdogPaused).toHaveBeenCalledTimes(1);
    // The fallback recovered the tx, so the candidate is NOT abandoned and the
    // row lands Completed rather than Failed.
    expect(abandonCandidate).not.toHaveBeenCalled();
    expect(txStore.find(row => row.id === txId)?.status).toBe(ITransactionStatus.Completed);
    warnSpy.mockRestore();
  });

  it('Guardian send: a lock-recovery eviction does NOT abandon the candidate — the abandoned pipeline may still land it (#775)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { WasmClientPoisonedError } = require('../sdk/wasm-client-poison');
    const txId = 'send-guardian-poisoned';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000',
      delegateTransaction: false,
      initiatedAt: Math.floor(Date.now() / 1000)
    });

    const abandonCandidate = jest.fn(async () => {});
    const multisigService = {
      createSendProposal: jest.fn(async () => ({ id: 'prop-1', nonce: 5 })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      abandonCandidate,
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    const client = makeClientApi(result);
    client.transactions.prove.mockRejectedValue(new WasmClientPoisonedError('watchdog'));
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client
    });

    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    ).catch(() => {});

    // Abandoning retracts a candidate whose transaction may still land — the
    // eviction abandoned the pipeline, it did not stop it. The next cycle's 409
    // pending-conflict path reconciles instead.
    expect(abandonCandidate).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('Guardian send (delegated): a remote prover that never answers falls back on the client-side deadline (#718)', async () => {
    // The rejection case above is the FRIENDLY failure: the prover says no, and the
    // catch runs. The stall is the one that hung the wallet — the local E2E prover
    // aborts a proof past its own `--timeout` and stops responding, so the delegated
    // `prove` never settles at all. There is no gRPC deadline on that await, so the
    // pipeline parked forever holding the WASM client lock and every later write
    // queued behind it. `withDelegatedProveTimeout` has to convert that silence into
    // the same local re-prove the rejection takes.
    jest.useFakeTimers();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const txId = 'send-guardian-delegated-stall';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000',
      delegateTransaction: true,
      initiatedAt: Math.floor(Date.now() / 1000)
    });

    const abandonCandidate = jest.fn(async () => {});
    mockGetOrCreateMultisigService.mockResolvedValue({
      createSendProposal: jest.fn(async () => ({ id: 'prop-1', nonce: 5 })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      abandonCandidate,
      sync: jest.fn(async () => {})
    });

    const client = makeClientApi(result);
    // The delegated prove NEVER settles — the defining difference from a rejection.
    client.transactions.prove.mockImplementationOnce(() => new Promise(() => {}));
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client
    });

    const pending = generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: true
      } as never,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    // Let the pipeline reach the delegated prove, then expire the client-side
    // deadline. Without it this await would never resolve.
    await jest.advanceTimersByTimeAsync(120_000);
    await pending;

    expect(client.transactions.prove).toHaveBeenCalledTimes(2);
    expect(client.transactions.prove).toHaveBeenNthCalledWith(1, result, {});
    expect(client.transactions.prove).toHaveBeenNthCalledWith(2, result, { prover: 'local-prover' });
    expect(abandonCandidate).not.toHaveBeenCalled();
    expect(txStore.find(row => row.id === txId)?.status).toBe(ITransactionStatus.Completed);
    warnSpy.mockRestore();
    jest.useRealTimers();
  });

  it('Guardian send (delegated): a prover outage the local fallback cannot rescue REQUEUES instead of terminal-failing (#419)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const txId = 'send-guardian-prover-outage';
    const result = makeResult();
    const originalInitiatedAt = Math.floor(Date.now() / 1000) - 42;
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000',
      delegateTransaction: true,
      initiatedAt: originalInitiatedAt
    });

    const multisigService = {
      createSendProposal: jest.fn(async () => ({ id: 'prop-1', nonce: 5 })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      abandonCandidate: jest.fn(async () => {}),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    const client = makeClientApi(result);
    // BOTH the delegated (remote) prove AND the local fallback fail — a prover
    // outage the fallback can't rescue. The failure is at the 'proving' stage,
    // which runs BEFORE submit, so nothing reached the chain.
    client.transactions.prove.mockRejectedValue(
      new Error('failed to prove transaction: transport error: connection refused')
    );
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client
    });

    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: true
      } as never,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    // Remote prove + local fallback both attempted, both failed.
    expect(client.transactions.prove).toHaveBeenCalledTimes(2);
    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    // Requeued with a backoff — NOT terminal-failed — so the transfer completes
    // once the prover recovers; stage reset so the next cycle rebuilds from the top.
    expect(row.status).toBe(ITransactionStatus.Queued);
    expect(row.nextEligibleAt).toEqual(expect.any(Number));
    expect(row.stage).toBe('creating-proposal');
    // initiatedAt must be preserved: cancelStaleQueuedTransactions measures the
    // MAX_QUEUED_AGE terminal cap from original creation, so resetting it would
    // make a persistent outage requeue forever.
    expect(row.initiatedAt).toBe(originalInitiatedAt);
    warnSpy.mockRestore();
  });

  it('Guardian send (delegated): a lock-recovery eviction at the prove stage is NOT requeued (#775)', async () => {
    // Same stage and same transaction type as the prover-outage requeue above,
    // and that is the point: the requeue's safety argument is "'proving' runs
    // before submit, so nothing reached the chain". That holds for an error that
    // STOPPED the pipeline. An eviction does not stop it — it rejects the caller
    // while the abandoned pipeline runs on and can still stamp 'submitting' and
    // submit. A delegated prove is deliberately not watchdog-paused, so it sits
    // squarely in the window an eviction lands in; requeueing here would
    // broadcast the same transfer a second time.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { WasmClientPoisonedError } = require('../sdk/wasm-client-poison');
    const txId = 'send-guardian-poisoned-prove';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000',
      delegateTransaction: true,
      initiatedAt: Math.floor(Date.now() / 1000)
    });

    const multisigService = {
      createSendProposal: jest.fn(async () => ({ id: 'prop-1', nonce: 5 })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      abandonCandidate: jest.fn(async () => {}),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    const client = makeClientApi(result);
    client.transactions.prove.mockRejectedValue(new WasmClientPoisonedError('watchdog'));
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client
    });

    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: true
      } as never,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    // Terminal, and never returned to the queue.
    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(row.nextEligibleAt).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('Guardian send (delegated): a SUBMIT-stage network failure is NOT requeued — only pre-submit prove failures requeue (#419)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const txId = 'send-guardian-submit-fail';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000',
      delegateTransaction: true,
      initiatedAt: Math.floor(Date.now() / 1000)
    });

    const multisigService = {
      createSendProposal: jest.fn(async () => ({ id: 'prop-1', nonce: 5 })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      abandonCandidate: jest.fn(async () => {}),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    const client = makeClientApi(result);
    // Prove SUCCEEDS; submit fails with the SAME transport error. The failure is
    // at the 'submitting' stage — the tx may already be on chain — so it must
    // terminal-fail rather than requeue (requeuing would risk a double-submit).
    client.transactions.submitProven.mockRejectedValue(
      new Error('failed to submit proven transaction: transport error: connection refused')
    );
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client
    });

    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: true
      } as never,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    // Same transport error, but at the submit stage — terminal-failed, never requeued.
    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(row.nextEligibleAt).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('Guardian send (local proving on mobile): routes to the native callback prover, never main-thread WASM', async () => {
    // Regression: the guardian pipeline drives the raw client directly, whose
    // default local prover is the single-threaded WASM one — on iOS WKWebView
    // that runs on the main thread and freezes the UI for the whole multi-second
    // prove. The non-delegated (local) guardian prove must route to the native
    // Rust prover (newCallbackProver), mirroring proveWithFallback's
    // localProverFactory and the delegated fallback above. isMobile is flipped
    // inside an isolated module registry so the flag doesn't leak to other tests.
    const txId = 'send-guardian-mobile-local';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000',
      delegateTransaction: false,
      initiatedAt: Math.floor(Date.now() / 1000)
    });

    const multisigService = {
      createSendProposal: jest.fn(async () => ({ id: 'prop-1' })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: makeClientApi(result)
    });

    const provider = makeGuardianProvider(true);
    const signCallback = jest.fn(async () => new Uint8Array([2]));

    mockPlatformIsMobile = true;
    try {
      await generateTransaction(
        {
          id: txId,
          type: 'send',
          accountId: 'guardian-acc',
          secondaryAccountId: 'recipient',
          faucetId: 'faucet',
          amount: '1000',
          delegateTransaction: false
        } as never,
        signCallback,
        false,
        provider
      );
    } finally {
      mockPlatformIsMobile = false;
    }

    // The local guardian prove picked the native callback prover, not the
    // main-thread WASM local prover.
    expect(TransactionProver.newCallbackProver).toHaveBeenCalledTimes(1);
    expect(TransactionProver.newLocalProver).not.toHaveBeenCalled();
  });

  it('Guardian send: a still-pending 409 (delta not yet canonicalized) requeues instead of failing', async () => {
    // The guardian holds a single-delta lock; a proposal issued while a prior
    // delta is still canonicalizing returns 409 ConflictPendingDelta. If it
    // never clears within withGuardianConflictRetry's budget, the tx must be
    // returned to the queue (transient lock) — NOT terminally Failed.
    jest.useFakeTimers();
    try {
      const txId = 'send-pending-conflict';
      txStore.push({
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        status: ITransactionStatus.Queued,
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: false,
        initiatedAt: Math.floor(Date.now() / 1000)
      });

      const conflict = { status: 409, body: 'ConflictPendingDelta' };
      const multisigService = {
        createSendProposal: jest.fn(async () => {
          throw conflict;
        }),
        signAndCreateTransactionRequest: jest.fn(),
        sync: jest.fn(async () => {})
      };
      mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
      mockGetMidenClient.mockResolvedValue({
        getAccount: jest.fn(async () => undefined),
        syncState: jest.fn(async () => {}),
        client: makeClientApi(makeResult())
      });

      const provider = makeGuardianProvider(true);

      const pending = generateTransaction(
        {
          id: txId,
          type: 'send',
          accountId: 'guardian-acc',
          secondaryAccountId: 'recipient',
          faucetId: 'faucet',
          amount: '1000',
          delegateTransaction: false
        } as never,
        jest.fn(async () => new Uint8Array([2])),
        false,
        provider
      );
      // Fast-forward the withGuardianConflictRetry backoff sleeps so the retry
      // budget exhausts synchronously instead of burning ~60s of real time.
      await jest.runAllTimersAsync();
      await pending;

      // The proposal kept conflicting, so the tx is back in the queue — the next
      // generateTransactionsLoop cycle will retry it — and never signs/submits.
      const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
      expect(row.status).toBe(ITransactionStatus.Queued);
      expect(row.processingStartedAt).toBeUndefined();
      // Backoff: the requeue stamps a future nextEligibleAt so the loop skips this
      // tx for a cycle instead of re-picking it (as the oldest row) and starving
      // another account's queued tx.
      expect(typeof row.nextEligibleAt).toBe('number');
      expect(row.nextEligibleAt as number).toBeGreaterThan(row.initiatedAt as number);
      expect(multisigService.signAndCreateTransactionRequest).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('Guardian send: a paused-account 409 fails fast (not a transient lock)', async () => {
    const txId = 'send-paused-conflict';
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000',
      delegateTransaction: false,
      initiatedAt: Math.floor(Date.now() / 1000)
    });

    const paused = { status: 409, body: 'GUARDIAN_ACCOUNT_PAUSED' };
    const multisigService = {
      createSendProposal: jest.fn(async () => {
        throw paused;
      }),
      signAndCreateTransactionRequest: jest.fn(),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: makeClientApi(makeResult())
    });

    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    // A paused account is not a transient lock — retrying just delays the
    // inevitable, so it stays terminally Failed rather than being requeued.
    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Failed);
  });

  it('Guardian consume: a still-pending 409 requeues instead of failing (value-moving op)', async () => {
    // consume is a value-moving op whose proposal creator is side-effect-free, so
    // a transient pending-delta 409 that outlasts the retry budget must return the
    // tx to the queue — mirroring the send behavior from #335.
    jest.useFakeTimers();
    try {
      const txId = 'consume-pending-conflict';
      txStore.push({
        id: txId,
        type: 'consume',
        accountId: 'guardian-acc',
        status: ITransactionStatus.Queued,
        noteId: 'note-xyz'
      });

      const conflict = { status: 409, body: 'ConflictPendingDelta' };
      const multisigService = {
        createConsumeNotesProposal: jest.fn(async () => {
          throw conflict;
        }),
        signAndCreateTransactionRequest: jest.fn(),
        sync: jest.fn(async () => {})
      };
      mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
      mockGetMidenClient.mockResolvedValue({
        getAccount: jest.fn(async () => undefined),
        syncState: jest.fn(async () => {}),
        client: makeClientApi(makeResult())
      });

      const pending = generateTransaction(
        {
          id: txId,
          type: 'consume',
          accountId: 'guardian-acc',
          noteId: 'note-xyz',
          delegateTransaction: false
        } as never,
        jest.fn(async () => new Uint8Array([1])),
        false,
        makeGuardianProvider(true)
      );
      await jest.runAllTimersAsync();
      await pending;

      const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
      expect(row.status).toBe(ITransactionStatus.Queued);
      expect(row.processingStartedAt).toBeUndefined();
      expect(multisigService.signAndCreateTransactionRequest).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('Guardian consume: a 429 at creating-proposal requeues with the server-supplied retry_after (#617)', async () => {
    // The guardian declares rate-limit rejections retryable and hands back a
    // cooldown. Terminal-failing here would lose a value-moving consume to a
    // transient limit; the row must go back to Queued, backed off by the
    // server's own figure rather than our default.
    jest.useFakeTimers();
    try {
      const txId = 'consume-rate-limited';
      txStore.push({
        id: txId,
        type: 'consume',
        accountId: 'guardian-acc',
        status: ITransactionStatus.Queued,
        noteId: 'note-429'
      });

      const rateLimited = {
        status: 429,
        code: 'rate_limit_exceeded',
        meta: { retryable: true, retryAfterSecs: 45 }
      };
      const multisigService = {
        createConsumeNotesProposal: jest.fn(async () => {
          throw rateLimited;
        }),
        signAndCreateTransactionRequest: jest.fn(),
        sync: jest.fn(async () => {})
      };
      mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
      mockGetMidenClient.mockResolvedValue({
        getAccount: jest.fn(async () => undefined),
        syncState: jest.fn(async () => {}),
        client: makeClientApi(makeResult())
      });

      const before = Math.floor(Date.now() / 1000);
      const pending = generateTransaction(
        {
          id: txId,
          type: 'consume',
          accountId: 'guardian-acc',
          noteId: 'note-429',
          delegateTransaction: false
        } as never,
        jest.fn(async () => new Uint8Array([1])),
        false,
        makeGuardianProvider(true)
      );
      await jest.runAllTimersAsync();
      await pending;

      const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
      expect(row.status).toBe(ITransactionStatus.Queued);
      expect(row.processingStartedAt).toBeUndefined();
      // Backed off by the guardian's 45s, not our 30s default. Bounded on BOTH
      // sides: a one-sided >= would stay green if the value were ever multiplied
      // into milliseconds (row parks 12.5h out, never retried, reaped by MAX_QUEUED_AGE).
      expect(Number(row.nextEligibleAt)).toBeGreaterThanOrEqual(before + 45);
      expect(Number(row.nextEligibleAt)).toBeLessThan(before + 60);
      expect(multisigService.signAndCreateTransactionRequest).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a 429 cooldown does not eat the unauthorized-retry budget it parks on top of', async () => {
    // The unauthorized budget is a wall clock, so any backoff for an unrelated
    // reason spends it. That matters here more than anywhere: a rate limit and an
    // unauthorized race come from the SAME overloaded guardian, so the row that
    // raced is exactly the row likely to be rate-limited next — and a 429 can
    // park it for 300s against a 180s budget, leaving nothing for the retry the
    // budget exists to fund. The deadline moves with the delay.
    jest.useFakeTimers();
    try {
      const txId = 'consume-rate-limited-budget';
      const deadline = Math.floor(Date.now() / 1000) + 120;
      txStore.push({
        id: txId,
        type: 'consume',
        accountId: 'guardian-acc',
        status: ITransactionStatus.Queued,
        noteId: 'note-429-budget',
        unauthorizedRetryUntil: deadline
      });

      const rateLimited = { status: 429, code: 'rate_limit_exceeded', meta: { retryable: true, retryAfterSecs: 45 } };
      const multisigService = {
        createConsumeNotesProposal: jest.fn(async () => {
          throw rateLimited;
        }),
        signAndCreateTransactionRequest: jest.fn(),
        sync: jest.fn(async () => {})
      };
      mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
      mockGetMidenClient.mockResolvedValue({
        getAccount: jest.fn(async () => undefined),
        syncState: jest.fn(async () => {}),
        client: makeClientApi(makeResult())
      });

      const pending = generateTransaction(
        {
          id: txId,
          type: 'consume',
          accountId: 'guardian-acc',
          noteId: 'note-429-budget',
          delegateTransaction: false
        } as never,
        jest.fn(async () => new Uint8Array([1])),
        false,
        makeGuardianProvider(true)
      );
      await jest.runAllTimersAsync();
      await pending;

      const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
      expect(row.status).toBe(ITransactionStatus.Queued);
      // Pushed out by exactly the cooldown this requeue imposes — not left where
      // it was, and not reset to a fresh window either.
      expect(Number(row.unauthorizedRetryUntil)).toBe(deadline + 45);
    } finally {
      jest.useRealTimers();
    }
  });

  it('Guardian replace-hot-key: a 429 is NOT requeued — structural ops must not re-mint a hot key (#617)', async () => {
    // Same exclusion as the 409 case: requeueing a structural op re-runs its
    // proposal creator, which has already minted a hardware hot key.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const txId = 'replace-hot-rate-limited';
    txStore.push({
      id: txId,
      type: 'replace-hot-key',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: {}
    });

    const rateLimited = { status: 429, code: 'rate_limit_exceeded', meta: { retryable: true, retryAfterSecs: 10 } };
    const coldService = {
      // Rejects AFTER the (elided) mint, modeling the real mint-before-POST order.
      createReplaceHotKeyProposal: jest.fn(async () => {
        throw rateLimited;
      }),
      signAndCreateTransactionRequest: jest.fn()
    };
    mockBuildColdMultisigService.mockResolvedValue(coldService);
    mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(async () => {}) });

    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'old-hot' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: async () => 'sig',
      persistNewHotKey: jest.fn(async () => {}),
      swapHotKey: jest.fn(async () => {})
    };
    mockIsGuardianAccount.mockResolvedValue(true);
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      client: makeClientApi(makeResult())
    });

    const txArg = { id: txId, type: 'replace-hot-key', accountId: 'guardian-acc', delegateTransaction: false };

    // Three loop cycles: a correctly-failed structural op is terminal and runs
    // once. Under a requeue-everything bug this would re-mint every cycle.
    for (let cycle = 0; cycle < 3; cycle++) {
      const current = txStore.find(r => r.id === txId) as Record<string, unknown>;
      if (current.status !== ITransactionStatus.Queued) break;
      await generateTransaction(
        txArg as never,
        jest.fn(async () => new Uint8Array([1])),
        false,
        provider as never
      );
    }

    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(row.nextEligibleAt).toBeUndefined();
    expect(coldService.createReplaceHotKeyProposal).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('Guardian send (delegated): a 429 at the SUBMIT stage is NOT requeued — double-submit risk (#617)', async () => {
    // The stage gate is the safety property. Pre-submit 429s requeue; a 429 at or
    // after 'sending' may correspond to a transaction already on chain, so it must
    // terminal-fail exactly like the transport-error case above.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const txId = 'send-429-at-submit';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000',
      delegateTransaction: true,
      initiatedAt: Math.floor(Date.now() / 1000)
    });

    const multisigService = {
      createSendProposal: jest.fn(async () => ({ id: 'prop-1', nonce: 5 })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      abandonCandidate: jest.fn(async () => {}),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    const client = makeClientApi(result);
    client.transactions.submitProven.mockRejectedValue({
      status: 429,
      code: 'rate_limit_exceeded',
      meta: { retryable: true, retryAfterSecs: 5 }
    });
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client
    });

    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: true
      } as never,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    // Prove submit was actually REACHED — without these the test passes for any
    // pre-submit crash (e.g. a renamed mock method), silently becoming a no-op.
    expect(client.transactions.submitProven).toHaveBeenCalled();
    expect(row.stage).toBe('submitting');
    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(row.nextEligibleAt).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('Guardian send: an "unauthorized" execution failure requeues instead of failing', async () => {
    // The guardian co-signs a TransactionSummary bound to the account state and
    // block commitment it saw. If that state moves before the local
    // executeRequest recomputes the summary, execution rejects the signature:
    // "transaction is unauthorized". Execution is where it dies — before prove
    // and submit — so nothing reached the chain and a fresh proposal against
    // fresh state succeeds. Terminal-failing loses a recoverable transfer to a
    // transient race that gets likelier as guardian round-trips slow down.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const txId = 'send-unauthorized-at-execute';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000',
      delegateTransaction: true,
      initiatedAt: Math.floor(Date.now() / 1000)
    });

    const multisigService = {
      createSendProposal: jest.fn(async () => ({ id: 'prop-1', nonce: 5 })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      abandonCandidate: jest.fn(async () => {}),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    const client = makeClientApi(result);
    client.transactions.executeRequest.mockRejectedValue(
      new Error(
        'failed to execute transaction: transaction execution failed: ' +
          'transaction is unauthorized with summary TransactionSummary { nonce_delta: 1 }'
      )
    );
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client
    });

    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: true
      } as never,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    // Prove execution was actually REACHED and that nothing was submitted —
    // without these the test would pass for any earlier crash.
    expect(client.transactions.executeRequest).toHaveBeenCalled();
    expect(client.transactions.submitProven).not.toHaveBeenCalled();
    expect(row.status).toBe(ITransactionStatus.Queued);
    expect(row.processingStartedAt).toBeUndefined();
    expect(typeof row.nextEligibleAt).toBe('number');
    warnSpy.mockRestore();
  });

  it('Guardian send: a 429 at signing-proposal requeues on the DEFAULT cooldown and abandons the candidate (#617)', async () => {
    // Covers the second gate arm and the 30s fallback — both were mutation-dead:
    // dropping the 'signing-proposal' arm and changing the fallback to `?? 0` left
    // the whole transaction folder green.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const txId = 'send-429-at-signing';
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000',
      delegateTransaction: false,
      initiatedAt: Math.floor(Date.now() / 1000)
    });

    // No meta.retryAfterSecs → the local default must apply.
    const rateLimited = { status: 429, code: 'rate_limit_exceeded', meta: { retryable: true } };
    const multisigService = {
      createSendProposal: jest.fn(async () => ({ id: 'prop-1', nonce: 7 })),
      signAndCreateTransactionRequest: jest.fn(async () => {
        throw rateLimited;
      }),
      abandonCandidate: jest.fn(async () => {}),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: makeClientApi(makeResult())
    });

    const before = Math.floor(Date.now() / 1000);
    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      makeGuardianProvider(true)
    );

    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    expect(multisigService.signAndCreateTransactionRequest).toHaveBeenCalled();
    expect(row.status).toBe(ITransactionStatus.Queued);
    expect(row.stage).toBe('creating-proposal');
    expect(Number(row.nextEligibleAt)).toBeGreaterThanOrEqual(before + 30);
    expect(Number(row.nextEligibleAt)).toBeLessThan(before + 30 + 15);
    // The gate's comment leans on this cleanup having been attempted.
    expect(multisigService.abandonCandidate).toHaveBeenCalledWith(7);
    warnSpy.mockRestore();
  });

  it('Guardian consume: a tiny server retry_after is floored so the requeue cannot starve the loop (#617)', async () => {
    // retry_after_secs: 0 would make nextEligibleAt === now; the row is still the
    // oldest by initiatedAt, so the FIFO loop re-picks it every cycle and head-of-line
    // blocks every other account.
    jest.useFakeTimers();
    try {
      const txId = 'consume-429-zero-retry-after';
      txStore.push({
        id: txId,
        type: 'consume',
        accountId: 'guardian-acc',
        status: ITransactionStatus.Queued,
        noteId: 'note-0'
      });

      const rateLimited = { status: 429, code: 'rate_limit_exceeded', meta: { retryable: true, retryAfterSecs: 0 } };
      const multisigService = {
        createConsumeNotesProposal: jest.fn(async () => {
          throw rateLimited;
        }),
        signAndCreateTransactionRequest: jest.fn(),
        sync: jest.fn(async () => {})
      };
      mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
      mockGetMidenClient.mockResolvedValue({
        getAccount: jest.fn(async () => undefined),
        syncState: jest.fn(async () => {}),
        client: makeClientApi(makeResult())
      });

      const before = Math.floor(Date.now() / 1000);
      const pending = generateTransaction(
        { id: txId, type: 'consume', accountId: 'guardian-acc', noteId: 'note-0', delegateTransaction: false } as never,
        jest.fn(async () => new Uint8Array([1])),
        false,
        makeGuardianProvider(true)
      );
      await jest.runAllTimersAsync();
      await pending;

      const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
      expect(row.status).toBe(ITransactionStatus.Queued);
      expect(Number(row.nextEligibleAt)).toBeGreaterThanOrEqual(before + 15);
    } finally {
      jest.useRealTimers();
    }
  });

  it('Guardian consume: an absurd server retry_after is capped so the row still gets retries (#617)', async () => {
    // Anything past the remaining MAX_QUEUED_AGE budget means zero retries and a
    // generic "expired" failure 30 minutes later — worse than failing immediately.
    jest.useFakeTimers();
    try {
      const txId = 'consume-429-huge-retry-after';
      txStore.push({
        id: txId,
        type: 'consume',
        accountId: 'guardian-acc',
        status: ITransactionStatus.Queued,
        noteId: 'note-big'
      });

      const rateLimited = {
        status: 429,
        code: 'rate_limit_exceeded',
        meta: { retryable: true, retryAfterSecs: 86_400 }
      };
      const multisigService = {
        createConsumeNotesProposal: jest.fn(async () => {
          throw rateLimited;
        }),
        signAndCreateTransactionRequest: jest.fn(),
        sync: jest.fn(async () => {})
      };
      mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
      mockGetMidenClient.mockResolvedValue({
        getAccount: jest.fn(async () => undefined),
        syncState: jest.fn(async () => {}),
        client: makeClientApi(makeResult())
      });

      const before = Math.floor(Date.now() / 1000);
      const pending = generateTransaction(
        {
          id: txId,
          type: 'consume',
          accountId: 'guardian-acc',
          noteId: 'note-big',
          delegateTransaction: false
        } as never,
        jest.fn(async () => new Uint8Array([1])),
        false,
        makeGuardianProvider(true)
      );
      await jest.runAllTimersAsync();
      await pending;

      const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
      expect(row.status).toBe(ITransactionStatus.Queued);
      expect(Number(row.nextEligibleAt)).toBeLessThanOrEqual(before + 300);
    } finally {
      jest.useRealTimers();
    }
  });

  it('Guardian replace-hot-key: a still-pending 409 is NOT requeued — it fails and the hot-key mint is not repeated', async () => {
    // createReplaceHotKeyProposal MINTS a fresh hardware hot key BEFORE its
    // proposal POST (guardian/index.ts). If that POST returns a pending-delta 409,
    // requeueing would re-run the creator every generateTransactionsLoop cycle and
    // orphan another unpersisted hardware key. Structural ops must fall through to
    // cancelTransaction (Failed) — the user re-initiates.
    const txId = 'replace-hot-pending-conflict';
    txStore.push({
      id: txId,
      type: 'replace-hot-key',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: {}
    });

    const conflict = { status: 409, body: 'ConflictPendingDelta' };
    const coldService = {
      // Rejects AFTER the (elided) mint, modeling the real mint-before-POST order.
      createReplaceHotKeyProposal: jest.fn(async () => {
        throw conflict;
      }),
      signAndCreateTransactionRequest: jest.fn()
    };
    mockBuildColdMultisigService.mockResolvedValue(coldService);
    mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(async () => {}) });

    const persistNewHotKey = jest.fn(async () => {});
    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'old-hot' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: async () => 'sig',
      persistNewHotKey,
      swapHotKey: jest.fn(async () => {})
    };
    mockIsGuardianAccount.mockResolvedValue(true);
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      client: makeClientApi(makeResult())
    });

    const txArg = { id: txId, type: 'replace-hot-key', accountId: 'guardian-acc', delegateTransaction: false };

    // Simulate up to 3 generateTransactionsLoop cycles. The loop only re-picks rows
    // still Queued; a Failed row is terminal, so a correctly-failed tx runs once.
    // On the buggy (requeue-all) behavior this would re-mint every cycle.
    for (let cycle = 0; cycle < 3; cycle++) {
      const current = txStore.find(r => r.id === txId) as Record<string, unknown>;
      if (current.status !== ITransactionStatus.Queued) break;
      await generateTransaction(
        txArg as never,
        jest.fn(async () => new Uint8Array([1])),
        false,
        provider as never
      );
    }

    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    // Terminally Failed — NOT requeued back to Queued.
    expect(row.status).toBe(ITransactionStatus.Failed);
    // The hot key was minted exactly once — no re-mint across cycles.
    expect(coldService.createReplaceHotKeyProposal).toHaveBeenCalledTimes(1);
    // The POST failed before persistence, so no orphaned ciphertext was written.
    expect(persistNewHotKey).not.toHaveBeenCalled();
  });

  it('Guardian switch-guardian: a still-pending 409 is NOT requeued — it fails (structural op excluded from the gate)', async () => {
    // switch-guardian creates a proposal AND cold co-signs; a requeued re-run can
    // register a duplicate delta and push the commitment past the guardian's
    // expected single delta. It is deliberately excluded from
    // REQUEUEABLE_ON_PENDING_CONFLICT, so a pending-delta 409 that outlasts the
    // retry budget must fall through to cancelTransaction (terminal Failed) — the
    // user re-initiates — rather than being reset to Queued.
    jest.useFakeTimers();
    try {
      const txId = 'switch-guardian-pending-conflict';
      txStore.push({
        id: txId,
        type: 'switch-guardian',
        accountId: 'guardian-acc',
        status: ITransactionStatus.Queued,
        extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
      });

      const conflict = { status: 409, body: 'ConflictPendingDelta' };
      const multisigService = {
        createSwitchGuardianProposal: jest.fn(async () => {
          throw conflict;
        }),
        signAndCreateTransactionRequest: jest.fn(),
        sync: jest.fn(async () => {})
      };
      mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
      mockGetMidenClient.mockResolvedValue({
        getAccount: jest.fn(async () => undefined),
        syncState: jest.fn(async () => {}),
        client: makeClientApi(makeResult())
      });

      const pending = generateTransaction(
        {
          id: txId,
          type: 'switch-guardian',
          accountId: 'guardian-acc',
          extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
        } as never,
        jest.fn(async () => new Uint8Array([2])),
        false,
        makeGuardianProvider(true)
      );
      // Exhaust withGuardianConflictRetry's backoff sleeps synchronously.
      await jest.runAllTimersAsync();
      await pending;

      const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
      // Terminally Failed — NOT requeued (structural ops are gated out).
      expect(row.status).toBe(ITransactionStatus.Failed);
      expect(row.processingStartedAt).toBeDefined(); // never cleared for a requeue
      expect(multisigService.signAndCreateTransactionRequest).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('Guardian update-procedure-threshold: a still-pending 409 is NOT requeued — it fails (structural op excluded from the gate)', async () => {
    // update-procedure-threshold is a cold-signed structural change; re-running it
    // can register a duplicate delta, so like switch-guardian / replace-hot-key it
    // is excluded from REQUEUEABLE_ON_PENDING_CONFLICT. A pending-delta 409 that
    // outlasts the retry budget must stay terminally Failed, not be requeued.
    jest.useFakeTimers();
    try {
      const txId = 'update-threshold-pending-conflict';
      txStore.push({
        id: txId,
        type: 'update-procedure-threshold',
        accountId: 'guardian-acc',
        status: ITransactionStatus.Queued,
        extraInputs: { procedure: 'update_guardian', threshold: 2 }
      });

      const conflict = { status: 409, body: 'ConflictPendingDelta' };
      const coldService = {
        createUpdateProcedureThresholdProposal: jest.fn(async () => {
          throw conflict;
        }),
        signAndCreateTransactionRequest: jest.fn()
      };
      mockBuildColdMultisigService.mockResolvedValue(coldService);
      // getOrCreateMultisigService is not used on this cold-routed path, but the
      // initial guardian-account gate still resolves a service; stub it harmlessly.
      mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(async () => {}) });

      const provider = {
        getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'hot' }],
        getPublicKeyForCommitment: async () => 'pk',
        signWord: async () => 'sig'
      };
      mockIsGuardianAccount.mockResolvedValue(true);
      mockGetMidenClient.mockResolvedValue({
        syncState: jest.fn(async () => {}),
        getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
        client: makeClientApi(makeResult())
      });

      const pending = generateTransaction(
        {
          id: txId,
          type: 'update-procedure-threshold',
          accountId: 'guardian-acc',
          extraInputs: { procedure: 'update_guardian', threshold: 2 }
        } as never,
        jest.fn(async () => new Uint8Array([1])),
        false,
        provider as never
      );
      await jest.runAllTimersAsync();
      await pending;

      const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
      // Terminally Failed — NOT requeued (structural ops are gated out).
      expect(row.status).toBe(ITransactionStatus.Failed);
      expect(row.processingStartedAt).toBeDefined(); // never cleared for a requeue
      expect(coldService.signAndCreateTransactionRequest).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('Guardian send: requests candidate abandonment when transaction execution fails', async () => {
    const txId = 'send-guardian-failed';
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000',
      delegateTransaction: false,
      initiatedAt: Math.floor(Date.now() / 1000)
    });

    const abandonCandidate = jest.fn(async () => {});
    const multisigService = {
      createSendProposal: jest.fn(async () => ({ id: 'prop-failed', nonce: 17 })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      abandonCandidate,
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    const client = makeClientApi(makeResult());
    client.transactions.executeRequest.mockRejectedValueOnce(new Error('execution failed'));
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client
    });

    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    expect(abandonCandidate).toHaveBeenCalledWith(17);
    expect(txStore.find(row => row.id === txId)?.status).toBe(ITransactionStatus.Failed);
  });

  it('Guardian consume: builds a consume-notes proposal off the noteId', async () => {
    const txId = 'consume-guardian-1';
    const result = makeResult();
    const multisigService = {
      createConsumeNotesProposal: jest.fn(async () => ({ id: 'prop-consume' })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: makeClientApi(result)
    });
    txStore.push({
      id: txId,
      type: 'consume',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      noteId: 'note-xyz'
    });

    await generateTransaction(
      {
        id: txId,
        type: 'consume',
        accountId: 'guardian-acc',
        noteId: 'note-xyz',
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      makeGuardianProvider(true)
    );

    expect(multisigService.createConsumeNotesProposal).toHaveBeenCalledWith(['note-xyz']);
    // Every consume is hot-bound — no cold service built. The former
    // background→cold-key routing existed only to dodge the iOS `.userPresence`
    // Face ID gate on the hot key, which has since been removed.
    expect(mockBuildColdMultisigService).not.toHaveBeenCalled();

    const batchTxId = 'consume-guardian-batch';
    txStore.push({
      id: batchTxId,
      type: 'consume',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      noteId: 'note-a',
      noteIds: ['note-a', 'note-b']
    });

    await generateTransaction(
      {
        id: batchTxId,
        type: 'consume',
        accountId: 'guardian-acc',
        noteId: 'note-a',
        noteIds: ['note-a', 'note-b'],
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      makeGuardianProvider(true)
    );

    expect(multisigService.createConsumeNotesProposal).toHaveBeenLastCalledWith(['note-a', 'note-b']);
  });

  it('Guardian switch-guardian: cold co-signs before hot, waits for chain inclusion, finalizes switch', async () => {
    const txId = 'switch-guardian-1';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'switch-guardian',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
    });

    const multisigService = {
      createSwitchGuardianProposal: jest.fn(async () => ({
        proposal: {
          id: 'prop-switch',
          // 'cHJvcG9zYWwtYW5jaG9y' = base64 of 'proposal-anchor' — the fixture
          // must be REAL base64: the leaf decodes it with b64ToU8 (atob), which
          // throws on the bare token this used to be.
          metadata: { proposalType: 'switch_guardian', chainAnchor: 'cHJvcG9zYWwtYW5jaG9y' }
        },
        newEndpoint: 'https://new.guardian'
      })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      finalizeGuardianSwitch: jest.fn(async () => {}),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    const coldService = { signProposal: jest.fn(async () => {}) };
    mockBuildColdMultisigService.mockResolvedValue(coldService);

    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'hot-pub' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: async () => 'sig'
    };
    mockIsGuardianAccount.mockResolvedValue(true);

    const waitForTransactionCommit = jest.fn(async () => {});
    const clientApi = makeClientApi(result);
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      waitForTransactionCommit,
      client: clientApi
    });

    await generateTransaction(
      {
        id: txId,
        type: 'switch-guardian',
        accountId: 'guardian-acc',
        extraInputs: { newGuardianEndpoint: 'https://new.guardian' },
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    // The switch-guardian path must build the proposal, cold co-signs first
    // (threshold-2 satisfied on-chain), then hot signs + creates the request,
    // then waits for inclusion and finalizes.
    expect(multisigService.createSwitchGuardianProposal).toHaveBeenCalledWith('https://new.guardian');
    expect(mockBuildColdMultisigService).toHaveBeenCalled();
    expect(coldService.signProposal).toHaveBeenCalledWith('prop-switch');
    // After the multisigService/signingService consolidation, the hot service IS
    // the only service for non-replace-hot-key types — it drives the final
    // signAndCreateTransactionRequest.
    expect(multisigService.signAndCreateTransactionRequest).toHaveBeenCalledWith('prop-switch', undefined);
    expect(waitForTransactionCommit).toHaveBeenCalledWith('exec-tx-hash');
    expect(multisigService.finalizeGuardianSwitch).toHaveBeenCalledWith('https://new.guardian');
    // Protocol 0.16: execution is pinned to the proposal's ChainAnchor — the
    // signed summary binds the reference block commitment, so an unanchored
    // execute at a later sync height fails "transaction is unauthorized". The
    // leaf decodes the wire-form base64 with the SDK's ChainAnchor.deserialize
    // (in-realm), so that spy — not the multisig client's chainAnchorFromBase64
    // — is the decode seam to assert.
    expect(mockChainAnchorDeserialize).toHaveBeenCalledTimes(1);
    expect(Buffer.from(mockChainAnchorDeserialize.mock.calls[0][0] as Uint8Array).toString()).toBe('proposal-anchor');
    expect(clientApi.transactions.executeRequest).toHaveBeenCalledWith(
      'guardian-acc',
      expect.anything(),
      expect.objectContaining({ anchor: expect.anything() })
    );
  });

  it('Guardian switch-guardian: OLD guardian unreachable at service init → direct on-chain switch fallback', async () => {
    const txId = 'switch-guardian-direct-1';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'switch-guardian',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
    });

    // Service load round-trips through the OLD guardian — down operator.
    mockGetOrCreateMultisigService.mockRejectedValue(new Error('Failed to fetch'));
    mockCreateDirectSwitchRequest.mockResolvedValue({
      request: { serialize: () => new Uint8Array([2]) },
      // 'Y2hhaW4tYW5jaG9y' = base64 of 'chain-anchor' — must be REAL base64;
      // the leaf decodes it with b64ToU8 (atob), which throws on a bare token.
      chainAnchorB64: 'Y2hhaW4tYW5jaG9y'
    });
    mockFinalizeDirectSwitch.mockResolvedValue(undefined);

    const signWord = jest.fn(async () => 'sig');
    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'hot-pub' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord
    };
    mockIsGuardianAccount.mockResolvedValue(true);

    const waitForTransactionCommit = jest.fn(async () => {});
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      waitForTransactionCommit,
      client: makeClientApi(result)
    });

    await generateTransaction(
      {
        id: txId,
        type: 'switch-guardian',
        accountId: 'guardian-acc',
        extraInputs: { newGuardianEndpoint: 'https://new.guardian' },
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    // The direct request is built locally (hot + cold advice-map signatures) —
    // no proposal machinery, no cold service.
    expect(mockCreateDirectSwitchRequest).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: 'guardian-acc' }),
      'https://new.guardian',
      signWord
    );
    expect(mockBuildColdMultisigService).not.toHaveBeenCalled();
    // Same leaf + commit-wait as the proposal path, pinned to the ChainAnchor
    // the direct build signed at (protocol 0.16). The leaf decodes the
    // wire-form base64 in-realm with the SDK's ChainAnchor.deserialize.
    expect(mockChainAnchorDeserialize).toHaveBeenCalledTimes(1);
    expect(Buffer.from(mockChainAnchorDeserialize.mock.calls[0][0] as Uint8Array).toString()).toBe('chain-anchor');
    expect(waitForTransactionCommit).toHaveBeenCalledWith('exec-tx-hash');
    // Completion registers on the NEW guardian standalone (undefined service).
    expect(mockFinalizeDirectSwitch).toHaveBeenCalledWith('guardian-acc', 'https://new.guardian', provider);
    const row = txStore.find(r => r.id === txId)!;
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.displayMessage).toBe('Guardian switched');
  });

  it('Guardian switch-guardian: OLD guardian unreachable at cold co-sign → direct fallback (proposal already pushed)', async () => {
    const txId = 'switch-guardian-direct-2';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'switch-guardian',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
    });

    // Proposal push succeeded, then connectivity to the old guardian dropped:
    // the cold service load (guardian getState) fails.
    const multisigService = {
      createSwitchGuardianProposal: jest.fn(async () => ({
        proposal: { id: 'prop-switch', nonce: 31 },
        newEndpoint: 'https://new.guardian'
      })),
      signAndCreateTransactionRequest: jest.fn(),
      abandonCandidate: jest.fn(async () => {}),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
    mockBuildColdMultisigService.mockRejectedValue(new Error('NetworkError when attempting to fetch resource'));
    mockCreateDirectSwitchRequest.mockResolvedValue({
      request: { serialize: () => new Uint8Array([2]) },
      // Real base64 ('chain-anchor') — the leaf's b64ToU8 (atob) throws on a bare token.
      chainAnchorB64: 'Y2hhaW4tYW5jaG9y'
    });
    mockFinalizeDirectSwitch.mockResolvedValue(undefined);

    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'hot-pub' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: jest.fn(async () => 'sig')
    };
    mockIsGuardianAccount.mockResolvedValue(true);

    const waitForTransactionCommit = jest.fn(async () => {});
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      waitForTransactionCommit,
      client: makeClientApi(result)
    });

    await generateTransaction(
      {
        id: txId,
        type: 'switch-guardian',
        accountId: 'guardian-acc',
        extraInputs: { newGuardianEndpoint: 'https://new.guardian' },
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    // The proposal path was abandoned mid-flight; the hot sign never ran.
    expect(multisigService.signAndCreateTransactionRequest).not.toHaveBeenCalled();
    // The delta pushed a moment ago is retracted before the direct switch takes
    // over. `switch-guardian` is in neither the requeue-on-409 set nor the Retry
    // set, so a delta left pending on a recovered operator cancels the NEXT
    // coordinated switch outright — leaving it is not harmless.
    expect(multisigService.abandonCandidate).toHaveBeenCalledWith(31);
    expect(mockCreateDirectSwitchRequest).toHaveBeenCalled();
    expect(mockFinalizeDirectSwitch).toHaveBeenCalledWith('guardian-acc', 'https://new.guardian', provider);
    const row = txStore.find(r => r.id === txId)!;
    expect(row.status).toBe(ITransactionStatus.Completed);
  });

  // The retraction needs the operator that was just unreachable, so it usually
  // fails. That must stay non-fatal: the direct switch is the recovery path and
  // cannot be gated on the dead guardian answering.
  it('Guardian switch-guardian: a failing delta retraction does not block the direct fallback', async () => {
    const txId = 'switch-guardian-direct-abandon-fails';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'switch-guardian',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
    });

    const multisigService = {
      createSwitchGuardianProposal: jest.fn(async () => ({
        proposal: { id: 'prop-switch', nonce: 33 },
        newEndpoint: 'https://new.guardian'
      })),
      signAndCreateTransactionRequest: jest.fn(),
      abandonCandidate: jest.fn(async () => {
        throw new Error('Failed to fetch');
      }),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
    mockBuildColdMultisigService.mockRejectedValue(new Error('NetworkError when attempting to fetch resource'));
    mockCreateDirectSwitchRequest.mockResolvedValue({
      request: { serialize: () => new Uint8Array([2]) },
      chainAnchorB64: 'Y2hhaW4tYW5jaG9y'
    });
    mockFinalizeDirectSwitch.mockResolvedValue(undefined);

    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'hot-pub' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: jest.fn(async () => 'sig')
    };
    mockIsGuardianAccount.mockResolvedValue(true);
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      waitForTransactionCommit: jest.fn(async () => {}),
      client: makeClientApi(result)
    });

    await generateTransaction(
      {
        id: txId,
        type: 'switch-guardian',
        accountId: 'guardian-acc',
        extraInputs: { newGuardianEndpoint: 'https://new.guardian' },
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    expect(multisigService.abandonCandidate).toHaveBeenCalledWith(33);
    expect(mockCreateDirectSwitchRequest).toHaveBeenCalled();
    expect(txStore.find(r => r.id === txId)!.status).toBe(ITransactionStatus.Completed);
  });

  // A commit wait that fails without a verdict is resolved by ASKING THE CHAIN
  // (`didDirectSwitchLand`). This case is the last resort: the chain could not be
  // read either, so there is no evidence in either direction. Completing is the
  // lesser harm, because the direct switch is only reached when the OLD guardian
  // is already unreachable and `switch-guardian` is excluded from requeue and
  // from Retry — skipping completion would leave the vault naming an operator it
  // cannot talk to, with nothing left to retry.
  it('Guardian switch-guardian: an unverifiable commit wait still persists the new endpoint (direct path)', async () => {
    const txId = 'switch-guardian-direct-waitfail';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'switch-guardian',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
    });

    mockGetOrCreateMultisigService.mockRejectedValue(new Error('Failed to fetch'));
    mockCreateDirectSwitchRequest.mockResolvedValue({
      request: { serialize: () => new Uint8Array([2]) },
      chainAnchorB64: 'Y2hhaW4tYW5jaG9y'
    });
    mockFinalizeDirectSwitch.mockResolvedValue(undefined);

    const setGuardianEndpoint = jest.fn(async () => {});
    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'hot-pub' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: jest.fn(async () => 'sig'),
      setGuardianEndpoint
    };
    mockIsGuardianAccount.mockResolvedValue(true);
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      waitForTransactionCommit: jest.fn(async () => {
        throw new Error('Deadline expired before operation could complete');
      }),
      client: makeClientApi(result)
    });

    await generateTransaction(
      {
        id: txId,
        type: 'switch-guardian',
        accountId: 'guardian-acc',
        extraInputs: { newGuardianEndpoint: 'https://new.guardian' },
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    expect(mockDidDirectSwitchLand).toHaveBeenCalled();
    expect(setGuardianEndpoint).toHaveBeenCalledWith('guardian-acc', 'https://new.guardian');
    expect(mockFinalizeDirectSwitch).toHaveBeenCalledWith('guardian-acc', 'https://new.guardian', provider);
    const row = txStore.find(r => r.id === txId)!;
    expect(row.status).toBe(ITransactionStatus.Completed);
  });

  // The state this guards is the worst one the direct path can reach and the one
  // with NO self-repair: the vault naming an operator the chain never installed.
  // Drift cannot find it (its baseline and the on-chain commitment agree — both
  // still name the old operator, so it returns in-sync without ever looking at
  // the stored endpoint) and post-commit registration SUCCEEDS against the new
  // operator, so every later sync is healthy right up until a transaction needs a
  // co-signature the chain will not accept.
  it('Guardian switch-guardian: a commit wait the chain contradicts fails the row and leaves the endpoint alone', async () => {
    const txId = 'switch-guardian-direct-didnt-land';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'switch-guardian',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
    });

    mockGetOrCreateMultisigService.mockRejectedValue(new Error('Failed to fetch'));
    mockCreateDirectSwitchRequest.mockResolvedValue({
      request: { serialize: () => new Uint8Array([2]) },
      chainAnchorB64: 'Y2hhaW4tYW5jaG9y',
      newGuardianPubkey: `0x${'ab'.repeat(32)}`
    });
    mockFinalizeDirectSwitch.mockResolvedValue(undefined);
    // The chain says the rotation is NOT there.
    mockDidDirectSwitchLand.mockResolvedValue(false);

    const setGuardianEndpoint = jest.fn(async () => {});
    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'hot-pub' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: jest.fn(async () => 'sig'),
      setGuardianEndpoint
    };
    mockIsGuardianAccount.mockResolvedValue(true);
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      waitForTransactionCommit: jest.fn(async () => {
        throw new Error('Deadline expired before operation could complete');
      }),
      client: makeClientApi(result)
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await generateTransaction(
      {
        id: txId,
        type: 'switch-guardian',
        accountId: 'guardian-acc',
        extraInputs: { newGuardianEndpoint: 'https://new.guardian' },
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    // Asked about the TRANSACTION, by its id — not about the account, whose local
    // guardian slot `apply()` has already overwritten with this very rotation.
    expect(mockDidDirectSwitchLand).toHaveBeenCalledWith('exec-tx-hash');
    // Neither half of completion may run: the vault must keep naming the guardian
    // that still holds the account.
    expect(setGuardianEndpoint).not.toHaveBeenCalled();
    expect(mockFinalizeDirectSwitch).not.toHaveBeenCalled();
    expect(txStore.find(r => r.id === txId)!.status).toBe(ITransactionStatus.Failed);
  });

  it('Guardian switch-guardian: a commit wait the chain confirms finalizes normally', async () => {
    const txId = 'switch-guardian-direct-did-land';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'switch-guardian',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
    });

    mockGetOrCreateMultisigService.mockRejectedValue(new Error('Failed to fetch'));
    mockCreateDirectSwitchRequest.mockResolvedValue({
      request: { serialize: () => new Uint8Array([2]) },
      chainAnchorB64: 'Y2hhaW4tYW5jaG9y',
      newGuardianPubkey: `0x${'cd'.repeat(32)}`
    });
    mockFinalizeDirectSwitch.mockResolvedValue(undefined);
    // The wait timed out, but the rotation IS on chain.
    mockDidDirectSwitchLand.mockResolvedValue(true);

    const setGuardianEndpoint = jest.fn(async () => {});
    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'hot-pub' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: jest.fn(async () => 'sig'),
      setGuardianEndpoint
    };
    mockIsGuardianAccount.mockResolvedValue(true);
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      waitForTransactionCommit: jest.fn(async () => {
        throw new Error('Deadline expired before operation could complete');
      }),
      client: makeClientApi(result)
    });

    await generateTransaction(
      {
        id: txId,
        type: 'switch-guardian',
        accountId: 'guardian-acc',
        extraInputs: { newGuardianEndpoint: 'https://new.guardian' },
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    expect(setGuardianEndpoint).toHaveBeenCalledWith('guardian-acc', 'https://new.guardian');
    expect(txStore.find(r => r.id === txId)!.status).toBe(ITransactionStatus.Completed);
  });

  it('Guardian switch-guardian: a SEMANTIC old-guardian error (401) does NOT trigger the direct fallback', async () => {
    const txId = 'switch-guardian-no-fallback';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'switch-guardian',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
    });

    // Reachable guardian, semantic rejection — the fallback must not swallow it
    // (a 401 means a registration/allowlist problem, not a dead operator).
    const authError = Object.assign(new Error('signer not authorized'), { status: 401 });
    mockGetOrCreateMultisigService.mockRejectedValue(authError);

    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'hot-pub' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: jest.fn(async () => 'sig')
    };
    mockIsGuardianAccount.mockResolvedValue(true);
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      waitForTransactionCommit: jest.fn(async () => {}),
      client: makeClientApi(result)
    });

    await generateTransaction(
      {
        id: txId,
        type: 'switch-guardian',
        accountId: 'guardian-acc',
        extraInputs: { newGuardianEndpoint: 'https://new.guardian' },
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    expect(mockCreateDirectSwitchRequest).not.toHaveBeenCalled();
    expect(mockFinalizeDirectSwitch).not.toHaveBeenCalled();
    const row = txStore.find(r => r.id === txId)!;
    expect(row.status).toBe(ITransactionStatus.Failed);
  });

  it('Guardian replace-hot-key: cold-signs the in-place swap, persists new ciphertext pre-submit, waits for inclusion', async () => {
    const txId = 'replace-hot-1';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'replace-hot-key',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: {}
    });

    const multisigService = {
      // Hot service unused in replace-hot-key; signingService flips to cold.
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    const coldService = {
      createReplaceHotKeyProposal: jest.fn(async () => ({
        proposal: { id: 'prop-replace' },
        newHot: { ciphertext: 'new-cx', publicKeyHex: 'new-hot-pub', commitmentHex: '0xnewcommit' }
      })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      }))
    };
    mockBuildColdMultisigService.mockResolvedValue(coldService);

    const persistNewHotKey = jest.fn(async () => {});
    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'old-hot' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: async () => 'sig',
      persistNewHotKey,
      swapHotKey: jest.fn(async () => {})
    };
    mockIsGuardianAccount.mockResolvedValue(true);

    const waitForTransactionCommit = jest.fn(async () => {});
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      waitForTransactionCommit,
      client: makeClientApi(result)
    });

    const submittedRow = txStore.find(r => r.id === txId)!;

    await generateTransaction(
      { id: txId, type: 'replace-hot-key', accountId: 'guardian-acc', delegateTransaction: false } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    expect(coldService.createReplaceHotKeyProposal).toHaveBeenCalled();
    // Persist BEFORE submit so the new ciphertext is durable on crash.
    expect(persistNewHotKey).toHaveBeenCalledWith('new-hot-pub', 'new-cx');
    // Cold (signingService) drives signAndCreateTransactionRequest, NOT hot.
    expect(coldService.signAndCreateTransactionRequest).toHaveBeenCalledWith('prop-replace', undefined);
    // Persist newHotPublicKey on the transaction row so complete can find it.
    expect((submittedRow.extraInputs as { newHotPublicKey?: string }).newHotPublicKey).toBe('new-hot-pub');
    // Replace-hot-key shares the confirming wait with switch-guardian.
    expect(waitForTransactionCommit).toHaveBeenCalledWith('exec-tx-hash');
  });

  it('Guardian update-procedure-threshold: cold-signs the threshold update', async () => {
    const txId = 'upt-1';
    const result = makeResult();
    const coldService = {
      createUpdateProcedureThresholdProposal: jest.fn(async () => ({ id: 'prop-upt' })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(async () => {}) });
    mockBuildColdMultisigService.mockResolvedValue(coldService);
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      client: makeClientApi(result)
    });
    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'hot-pub' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: async () => 'sig'
    };
    mockIsGuardianAccount.mockResolvedValue(true);
    txStore.push({
      id: txId,
      type: 'update-procedure-threshold',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: { procedure: 'update_guardian', threshold: 2 }
    });

    await generateTransaction(
      {
        id: txId,
        type: 'update-procedure-threshold',
        accountId: 'guardian-acc',
        extraInputs: { procedure: 'update_guardian', threshold: 2 },
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    expect(mockBuildColdMultisigService).toHaveBeenCalled();
    expect(coldService.createUpdateProcedureThresholdProposal).toHaveBeenCalledWith('update_guardian', 2);
  });

  it('Guardian: unsupported transaction type cancels the transaction', async () => {
    const txId = 'unsupported-guardian';
    txStore.push({
      id: txId,
      type: 'execute',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued
    });
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: makeClientApi(makeResult())
    });
    mockGetOrCreateMultisigService.mockResolvedValue({});

    // generateGuardianTransaction throws on 'execute'; generateTransaction
    // swallows it via cancelTransaction and marks the row Failed.
    await generateTransaction(
      { id: txId, type: 'execute', accountId: 'guardian-acc', delegateTransaction: false } as never,
      jest.fn(),
      false,
      makeGuardianProvider(true)
    );

    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Failed);
  });

  it('replace-hot-key apply-after-submit-failure reconciles the hot pointer instead of cancelling', async () => {
    const txId = 'replace-apply-fail';
    const coldService = {
      createReplaceHotKeyProposal: jest.fn(async () => ({
        proposal: { id: 'prop-replace' },
        newHot: { ciphertext: 'new-cx', publicKeyHex: 'new-hot-pub', commitmentHex: '0xnewcommit' }
      })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      }))
    };
    mockBuildColdMultisigService.mockResolvedValue(coldService);
    // ensureGuardianProcedureThresholds (run inside completeReplaceHotKeyTransaction)
    // re-reads via getOrCreateMultisigService; stub it already-hardened so it no-ops.
    mockGetOrCreateMultisigService.mockResolvedValue({ getProcedureThreshold: () => 2 });

    const swapHotKey = jest.fn(async () => {});
    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'old-hot' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: async () => 'sig',
      persistNewHotKey: jest.fn(async () => {}),
      swapHotKey
    };
    mockIsGuardianAccount.mockResolvedValue(true);

    // The submit lands on chain but the LOCAL apply throws — the rotation is real.
    const applyErr = new Error(APPLY_AFTER_SUBMIT_ERROR_MESSAGE);
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      waitForTransactionCommit: jest.fn(async () => {}),
      client: makeClientApi(
        makeResult(),
        jest.fn(async () => {
          throw applyErr;
        })
      )
    });

    txStore.push({ id: txId, type: 'replace-hot-key', accountId: 'guardian-acc', status: ITransactionStatus.Queued });

    await generateTransaction(
      { id: txId, type: 'replace-hot-key', accountId: 'guardian-acc', delegateTransaction: false } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    // The reconcile swapped the hot pointer; the tx is Completed, not cancelled/Failed.
    expect(swapHotKey).toHaveBeenCalledWith('guardian-acc', 'new-hot-pub');
    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
    // #618: completion stamps the terminal stage through the real complete* layer.
    expect(row.stage).toBe('complete');
  });

  // #619 gap (1): a failed best-effort re-register is recorded (observable-only)
  // but never fails the on-chain-successful rotation.
  const runReplaceHotKeyReRegister = async (txId: string, reRegister: () => Promise<void>) => {
    const coldService = {
      createReplaceHotKeyProposal: jest.fn(async () => ({
        proposal: { id: 'prop-replace' },
        newHot: { ciphertext: 'new-cx', publicKeyHex: 'new-hot-pub', commitmentHex: '0xnewcommit' }
      })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      reRegisterCurrentStateOnGuardian: jest.fn(reRegister)
    };
    mockBuildColdMultisigService.mockResolvedValue(coldService);
    mockGetOrCreateMultisigService.mockResolvedValue({ getProcedureThreshold: () => 2 });
    mockIsGuardianAccount.mockResolvedValue(true);
    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'old-hot' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: async () => 'sig',
      persistNewHotKey: jest.fn(async () => {}),
      swapHotKey: jest.fn(async () => {})
    };
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      waitForTransactionCommit: jest.fn(async () => {}),
      client: makeClientApi(makeResult())
    });
    txStore.push({
      id: txId,
      type: 'replace-hot-key',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: {}
    });
    await generateTransaction(
      { id: txId, type: 'replace-hot-key', accountId: 'guardian-acc', delegateTransaction: false } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );
    return { coldService, row: txStore.find(r => r.id === txId) as Record<string, any> };
  };

  it('Guardian replace-hot-key: records reRegisterFailed=true when the re-register fails but the rotation is on chain (#619 gap 1)', async () => {
    const { coldService, row } = await runReplaceHotKeyReRegister('replace-reregister-fail', async () => {
      throw new Error('guardian 500');
    });

    expect(coldService.reRegisterCurrentStateOnGuardian).toHaveBeenCalled();
    // On-chain rotation still succeeds; the miss is recorded, not failed.
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.extraInputs.reRegisterFailed).toBe(true);
    // newHotPublicKey is preserved through the completion write.
    expect(row.extraInputs.newHotPublicKey).toBe('new-hot-pub');
  });

  it('Guardian replace-hot-key: records reRegisterFailed=false on a clean re-register (#619 gap 1)', async () => {
    const { row } = await runReplaceHotKeyReRegister('replace-reregister-ok', async () => {});

    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.extraInputs.reRegisterFailed).toBe(false);
    expect(row.extraInputs.newHotPublicKey).toBe('new-hot-pub');
  });

  it('switch-guardian apply-after-submit-failure re-registers + persists the endpoint instead of cancelling', async () => {
    const txId = 'switch-apply-fail';
    const finalizeGuardianSwitch = jest.fn(async () => {});
    const service = {
      createSwitchGuardianProposal: jest.fn(async () => ({
        proposal: { id: 'prop-switch' },
        newEndpoint: 'https://new.guardian'
      })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      finalizeGuardianSwitch,
      sync: jest.fn(async () => {})
    };
    // Used for both the main proposal AND rebuilt in the reconcile for completion.
    mockGetOrCreateMultisigService.mockResolvedValue(service);
    // switch-guardian's cold co-sign uses a transient cold service.
    mockBuildColdMultisigService.mockResolvedValue({ signProposal: jest.fn(async () => {}) });

    const setGuardianEndpoint = jest.fn(async () => {});
    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'hot-pub' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: async () => 'sig',
      setGuardianEndpoint
    };
    mockIsGuardianAccount.mockResolvedValue(true);

    const applyErr = new Error(APPLY_AFTER_SUBMIT_ERROR_MESSAGE);
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      waitForTransactionCommit: jest.fn(async () => {}),
      client: makeClientApi(
        makeResult(),
        jest.fn(async () => {
          throw applyErr;
        })
      )
    });

    txStore.push({
      id: txId,
      type: 'switch-guardian',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
    });

    await generateTransaction(
      {
        id: txId,
        type: 'switch-guardian',
        accountId: 'guardian-acc',
        extraInputs: { newGuardianEndpoint: 'https://new.guardian' },
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    // The reconcile re-registered on the new guardian and persisted the per-account endpoint.
    expect(finalizeGuardianSwitch).toHaveBeenCalledWith('https://new.guardian');
    expect(setGuardianEndpoint).toHaveBeenCalledWith('guardian-acc', 'https://new.guardian');
    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
  });

  // A row that already took the DIRECT path must not have its reconcile ask the
  // outgoing operator for anything. That operator was found unreachable minutes
  // ago; the request can only fail, and letting it try is not free — the shape
  // that produces the unreachable verdict is usually a silent socket, so the
  // rebuild would hold the WASM lock to the 5-minute watchdog and come back as
  // `WasmClientPoisonedError`, which is deliberately NOT an unreachable verdict.
  // It would rethrow, the caller would cancel, and a rotation that IS on chain
  // would end Failed with the vault still naming the dead operator.
  it('reconciles a direct-path switch without rebuilding the outgoing guardian service', async () => {
    const txId = 'switch-direct-apply-fail';
    // Unreachable on the first ask — this is what routes the row to the direct
    // path and stamps `switchedDirectly` on it.
    mockGetOrCreateMultisigService.mockRejectedValue(new Error('Failed to fetch'));
    mockCreateDirectSwitchRequest.mockResolvedValue({
      request: { serialize: () => new Uint8Array([2]) },
      chainAnchorB64: 'Y2hhaW4tYW5jaG9y'
    });
    mockFinalizeDirectSwitch.mockResolvedValue(undefined);

    const setGuardianEndpoint = jest.fn(async () => {});
    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'hot-pub' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: jest.fn(async () => 'sig'),
      setGuardianEndpoint
    };
    mockIsGuardianAccount.mockResolvedValue(true);

    const applyErr = new Error(APPLY_AFTER_SUBMIT_ERROR_MESSAGE);
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      waitForTransactionCommit: jest.fn(async () => {}),
      client: makeClientApi(
        makeResult(),
        jest.fn(async () => {
          throw applyErr;
        })
      )
    });

    txStore.push({
      id: txId,
      type: 'switch-guardian',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    await generateTransaction(
      {
        id: txId,
        type: 'switch-guardian',
        accountId: 'guardian-acc',
        extraInputs: { newGuardianEndpoint: 'https://new.guardian' },
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    // Once, for the initial attempt that produced the unreachable verdict — the
    // reconcile reads the row's own marker instead of asking again.
    expect(mockGetOrCreateMultisigService).toHaveBeenCalledTimes(1);
    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    expect((row.extraInputs as Record<string, unknown>).switchedDirectly).toBe(true);
    expect(mockFinalizeDirectSwitch).toHaveBeenCalledWith('guardian-acc', 'https://new.guardian', provider);
    expect(setGuardianEndpoint).toHaveBeenCalledWith('guardian-acc', 'https://new.guardian');
    expect(row.status).toBe(ITransactionStatus.Completed);
  });

  it('cancels the tx when the structural apply-failure reconcile itself throws', async () => {
    const txId = 'switch-reconcile-throws';
    const service = {
      createSwitchGuardianProposal: jest.fn(async () => ({
        proposal: { id: 'prop-switch' },
        newEndpoint: 'https://new.guardian'
      })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      sync: jest.fn(async () => {})
    };
    // First call serves the main proposal; the reconcile's rebuild rejects.
    mockGetOrCreateMultisigService.mockResolvedValueOnce(service).mockRejectedValueOnce(new Error('rebuild failed'));
    mockBuildColdMultisigService.mockResolvedValue({ signProposal: jest.fn(async () => {}) });

    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'hot-pub' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: async () => 'sig',
      setGuardianEndpoint: jest.fn(async () => {})
    };
    mockIsGuardianAccount.mockResolvedValue(true);

    const applyErr = new Error(APPLY_AFTER_SUBMIT_ERROR_MESSAGE);
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      waitForTransactionCommit: jest.fn(async () => {}),
      client: makeClientApi(
        makeResult(),
        jest.fn(async () => {
          throw applyErr;
        })
      )
    });

    txStore.push({
      id: txId,
      type: 'switch-guardian',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
    });

    await generateTransaction(
      {
        id: txId,
        type: 'switch-guardian',
        accountId: 'guardian-acc',
        extraInputs: { newGuardianEndpoint: 'https://new.guardian' },
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    // Reconcile failed → fall through to cancelTransaction → row Failed.
    expect(provider.setGuardianEndpoint).not.toHaveBeenCalled();
    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Failed);
  });

  it('Guardian consume apply-after-submit-failure marks Completed (sync reconciles) instead of cancelling', async () => {
    const txId = 'consume-apply-fail';
    const multisigService = {
      createConsumeNotesProposal: jest.fn(async () => ({ id: 'prop-consume' })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    // Submit lands on chain but the LOCAL apply throws — the note IS consumed.
    const applyErr = new Error(APPLY_AFTER_SUBMIT_ERROR_MESSAGE);
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: makeClientApi(
        makeResult(),
        jest.fn(async () => {
          throw applyErr;
        })
      )
    });

    txStore.push({
      id: txId,
      type: 'consume',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      noteId: 'note-xyz'
    });

    await generateTransaction(
      { id: txId, type: 'consume', accountId: 'guardian-acc', noteId: 'note-xyz', delegateTransaction: false } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      makeGuardianProvider(true)
    );

    // The note is consumed on chain — the tx is Completed (next sync reconciles the
    // note state via ConsumedExternal), NOT cancelled/Failed.
    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.displayMessage).toBe('Claimed');
  });

  it('Guardian send apply-after-submit-failure marks Completed instead of cancelling', async () => {
    const txId = 'send-apply-fail';
    const multisigService = {
      createSendProposal: jest.fn(async () => ({ id: 'prop-1' })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    const applyErr = new Error(APPLY_AFTER_SUBMIT_ERROR_MESSAGE);
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: makeClientApi(
        makeResult(),
        jest.fn(async () => {
          throw applyErr;
        })
      )
    });

    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000'
    });

    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([2])),
      false,
      makeGuardianProvider(true)
    );

    // Submit reached chain — mark Completed, not Failed.
    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.displayMessage).toBe('Sent');
  });

  it('Guardian send: blocked while guardianSyncStatus is out of sync — fails fast without building a proposal', async () => {
    const txId = 'send-out-of-sync';
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000'
    });
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: { transactions: { submit: jest.fn() } }
    });
    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', guardianSyncStatus: 'needs-user-input' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: async () => 'sig'
    };
    mockIsGuardianAccount.mockResolvedValue(true);

    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    // Blocked before any guardian service was ever built or a proposal created.
    expect(mockGetOrCreateMultisigService).not.toHaveBeenCalled();
    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(row.error).toBe('Error: guardian out of sync');
  });

  it('Guardian consume: blocked while guardianSyncStatus is resolving', async () => {
    const txId = 'consume-resolving';
    txStore.push({
      id: txId,
      type: 'consume',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      noteId: 'note-xyz'
    });
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: { transactions: { submit: jest.fn() } }
    });
    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', guardianSyncStatus: 'resolving' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: async () => 'sig'
    };
    mockIsGuardianAccount.mockResolvedValue(true);

    await generateTransaction(
      { id: txId, type: 'consume', accountId: 'guardian-acc', noteId: 'note-xyz', delegateTransaction: false } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    expect(mockGetOrCreateMultisigService).not.toHaveBeenCalled();
    expect(mockBuildColdMultisigService).not.toHaveBeenCalled();
    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(row.error).toBe('Error: guardian out of sync');
  });

  it('Guardian send: proceeds normally when guardianSyncStatus is in-sync', async () => {
    const txId = 'send-in-sync';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000'
    });
    const multisigService = {
      createSendProposal: jest.fn(async () => ({ id: 'prop-1' })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
    // The full execute/prove/submit/apply pipeline (see the "Guardian send:
    // builds a proposal..." happy-path test above) — an old-style
    // `client.transactions.submit` stub doesn't expose `_withInnerWebClient`,
    // which the guardian pipeline requires, and the tx would fail downstream.
    mockGetMidenClient.mockResolvedValue({
      getAccount: jest.fn(async () => undefined),
      syncState: jest.fn(async () => {}),
      client: makeClientApi(result)
    });
    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', guardianSyncStatus: 'in-sync' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: async () => 'sig'
    };
    mockIsGuardianAccount.mockResolvedValue(true);

    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    expect(multisigService.createSendProposal).toHaveBeenCalledWith('recipient', 'faucet', 1000n, 'Public');
    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    expect(row.status).not.toBe(ITransactionStatus.Failed);
  });

  it('Guardian switch-guardian: NOT blocked while guardianSyncStatus is needs-user-input — recovery path stays open', async () => {
    const txId = 'switch-out-of-sync';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'switch-guardian',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
    });

    const multisigService = {
      createSwitchGuardianProposal: jest.fn(async () => ({
        proposal: { id: 'prop-switch' },
        newEndpoint: 'https://new.guardian'
      })),
      signAndCreateTransactionRequest: jest.fn(async () => ({
        serialize: () => new Uint8Array([1]),
        authArg: () => undefined
      })),
      finalizeGuardianSwitch: jest.fn(async () => {}),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
    mockBuildColdMultisigService.mockResolvedValue({ signProposal: jest.fn(async () => {}) });

    const provider = {
      getAccounts: async () => [
        {
          publicKey: 'guardian-acc',
          coldPublicKey: 'cold-pub',
          hotPublicKey: 'hot-pub',
          guardianSyncStatus: 'needs-user-input'
        }
      ],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: async () => 'sig'
    };
    mockIsGuardianAccount.mockResolvedValue(true);

    // The full execute/prove/submit/apply pipeline (see the "switch-guardian:
    // cold co-signs before hot..." happy-path test above) — an old-style
    // `client.transactions.submit` stub doesn't expose `_withInnerWebClient`,
    // which the guardian pipeline requires, so the tx never reaches
    // completeSwitchGuardianTransaction / finalizeGuardianSwitch.
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      waitForTransactionCommit: jest.fn(async () => {}),
      client: makeClientApi(result)
    });

    await generateTransaction(
      {
        id: txId,
        type: 'switch-guardian',
        accountId: 'guardian-acc',
        extraInputs: { newGuardianEndpoint: 'https://new.guardian' },
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    // The deliberate switch-guardian flow is exempt from the sync gate — it's a
    // manual recovery path and must not be blocked by the very drift it resolves.
    expect(multisigService.createSwitchGuardianProposal).toHaveBeenCalledWith('https://new.guardian');
    expect(multisigService.finalizeGuardianSwitch).toHaveBeenCalledWith('https://new.guardian');
    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
  });
});

describe('initiateReplaceHotKeyTransaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    txStore.length = 0;
  });

  it('queues a ReplaceHotKeyTransaction row when the account is Guardian', async () => {
    const provider = makeGuardianProvider(true);
    const id = await initiateReplaceHotKeyTransaction('acc-1', false, provider);

    expect(id).toBeDefined();
    expect(txStore).toHaveLength(1);
    const row = txStore[0] as Record<string, unknown>;
    expect(row.accountId).toBe('acc-1');
    expect(row.type).toBe('replace-hot-key');
    // extraInputs starts empty; populated during generateGuardianTransaction.
    expect(row.extraInputs).toEqual({});
  });

  it('throws when the target account is not a Guardian account', async () => {
    const provider = makeGuardianProvider(false);
    await expect(initiateReplaceHotKeyTransaction('acc-public', false, provider)).rejects.toThrow(
      'Replace hot key is only supported for Guardian accounts'
    );
    expect(txStore).toHaveLength(0);
  });
});

describe('completeReplaceHotKeyTransaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    txStore.length = 0;
    // `clearAllMocks` resets this to return undefined, which made the
    // post-rotation re-register throw a TypeError in every test that did not
    // override it. That went unnoticed while the re-register was best-effort:
    // the tests asserted the rotation completed, and it did — with the guardian
    // allowlist never written, which is the permanent-401 bug in miniature.
    // Default to a working cold service so the happy paths exercise the real one.
    mockBuildColdMultisigService.mockResolvedValue({
      reRegisterCurrentStateOnGuardian: jest.fn(async () => {})
    });
  });

  it('calls swapHotKey with the new hot pubkey, drops the cached service, and marks the row Completed', async () => {
    const tx = new ReplaceHotKeyTransaction('acc-1', false);
    tx.extraInputs = { newHotPublicKey: 'new-hot-pub' };
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    const swapHotKey = jest.fn(async () => {});
    const provider = {
      getAccounts: async () => [{ publicKey: 'acc-1', hotPublicKey: 'old-hot-pub', coldPublicKey: 'cold' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: async () => 'sig',
      swapHotKey
    };

    await completeReplaceHotKeyTransaction(tx, makeResult() as never, provider as never);

    // The vault resolves the previous hot from the persisted WalletAccount —
    // the caller passes only newHotPubKey. Vault.swapHotKey handles the
    // idempotent case (old === new) internally.
    expect(swapHotKey).toHaveBeenCalledWith('acc-1', 'new-hot-pub');
    expect(mockClearGuardianServiceFor).toHaveBeenCalledWith('acc-1');

    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.displayMessage).toBe('Device key rotated');
  });

  it('re-registers via a FRESH cold service (post-rotation allowlist) BEFORE swapping the hot pointer', async () => {
    // The guardian's request-auth allowlist is written only by /configure and
    // registerOnGuardian derives it from the service's in-memory signer set —
    // so completion must rebuild the cold service from the freshly-synced
    // post-rotation account (NOT reuse the pre-rotation one that drove the tx,
    // which pushed the old allowlist and left the new hot key 401ing forever).
    const tx = new ReplaceHotKeyTransaction('acc-1', false);
    tx.extraInputs = { newHotPublicKey: 'new-hot-pub' };
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    const order: string[] = [];
    const reRegisterCurrentStateOnGuardian = jest.fn(async () => {
      order.push('reregister');
    });
    mockBuildColdMultisigService.mockResolvedValue({ reRegisterCurrentStateOnGuardian });
    const syncState = jest.fn(async () => {});
    const freshSdkAccount = { id: () => ({ toString: () => 'acc-1' }) };
    mockGetMidenClient.mockResolvedValue({ syncState, getAccount: async () => freshSdkAccount });

    const swapHotKey = jest.fn(async () => {
      order.push('swap');
    });
    const provider = {
      ...makeGuardianProvider(true),
      getAccounts: async () => [{ publicKey: 'acc-1', hotPublicKey: 'old-hot-pub', coldPublicKey: 'cold' }],
      swapHotKey
    };

    await completeReplaceHotKeyTransaction(tx, makeResult() as never, provider as never);

    // The cold service is built from the freshly-synced account, not a stale one.
    expect(syncState).toHaveBeenCalledTimes(1);
    expect(mockBuildColdMultisigService).toHaveBeenCalledTimes(1);
    expect(mockBuildColdMultisigService.mock.calls[0]![0]).toBe(freshSdkAccount);
    expect(reRegisterCurrentStateOnGuardian).toHaveBeenCalledTimes(1);
    expect(swapHotKey).toHaveBeenCalledWith('acc-1', 'new-hot-pub');
    expect(order).toEqual(['reregister', 'swap']);
  });

  it('still completes the rotation (best-effort) when the guardian re-registration fails', async () => {
    const tx = new ReplaceHotKeyTransaction('acc-1', false);
    tx.extraInputs = { newHotPublicKey: 'new-hot-pub' };
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    const reRegisterCurrentStateOnGuardian = jest.fn(async () => {
      throw new Error('guardian down');
    });
    mockBuildColdMultisigService.mockResolvedValue({ reRegisterCurrentStateOnGuardian });
    mockGetMidenClient.mockResolvedValue({
      syncState: async () => {},
      getAccount: async () => ({ id: () => ({ toString: () => 'acc-1' }) })
    });

    const swapHotKey = jest.fn(async () => {});
    const provider = {
      ...makeGuardianProvider(true),
      getAccounts: async () => [{ publicKey: 'acc-1', hotPublicKey: 'old-hot-pub', coldPublicKey: 'cold' }],
      swapHotKey
    };

    await completeReplaceHotKeyTransaction(tx, makeResult() as never, provider as never);

    // Every attempt is spent before giving up. Without this the retry could be
    // deleted and the suite would stay green.
    expect(reRegisterCurrentStateOnGuardian).toHaveBeenCalledTimes(3);
    expect(swapHotKey).toHaveBeenCalledWith('acc-1', 'new-hot-pub');
    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect((row.extraInputs as Record<string, unknown>).reRegisterFailed).toBe(true);
  });

  it('recovers a transient re-register failure instead of leaving the new hot key unauthorized', async () => {
    // The regression this guards: a guardian recovery run rotated the key, the
    // single re-register attempt failed, and every consume afterwards died with
    // "GUARDIAN HTTP error 401: Unauthorized - Your session has expired".
    // The whole block is retried, not just its final push, because the reads
    // that feed it (provider accounts, syncState, getAccount, cold service) are
    // exactly what fails while the rotation is still settling.
    const tx = new ReplaceHotKeyTransaction('acc-1', false);
    tx.extraInputs = { newHotPublicKey: 'new-hot-pub' };
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    let calls = 0;
    const reRegisterCurrentStateOnGuardian = jest.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('guardian still settling the rotation');
    });
    mockBuildColdMultisigService.mockResolvedValue({ reRegisterCurrentStateOnGuardian });
    mockGetMidenClient.mockResolvedValue({
      syncState: async () => {},
      getAccount: async () => ({ id: () => ({ toString: () => 'acc-1' }) })
    });

    const swapHotKey = jest.fn(async () => {});
    const provider = {
      ...makeGuardianProvider(true),
      getAccounts: async () => [{ publicKey: 'acc-1', hotPublicKey: 'old-hot-pub', coldPublicKey: 'cold' }],
      swapHotKey
    };

    await completeReplaceHotKeyTransaction(tx, makeResult() as never, provider as never);

    expect(reRegisterCurrentStateOnGuardian).toHaveBeenCalledTimes(2);
    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
    // The allowlist DID land on the second attempt, so the row must not claim
    // otherwise — a stale `true` here would send the self-heal chasing a
    // problem that no longer exists.
    expect((row.extraInputs as Record<string, unknown>).reRegisterFailed).toBe(false);
  });

  it('marks the row Failed when the provider does not implement swapHotKey', async () => {
    const tx = new ReplaceHotKeyTransaction('acc-1', false);
    tx.extraInputs = { newHotPublicKey: 'new-hot-pub' };
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    // A provider without swapHotKey (e.g. the frontend zustand provider) cannot
    // finalize a rotation — it must fail loudly rather than half-complete.
    const provider = makeGuardianProvider(true);

    await completeReplaceHotKeyTransaction(tx, makeResult() as never, provider as never);

    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(row.error).toContain('swapHotKey not implemented');
  });

  it('enqueues a procedure-threshold hardening tx after rotation when update_guardian is unhardened', async () => {
    const tx = new ReplaceHotKeyTransaction('acc-1', false);
    tx.extraInputs = { newHotPublicKey: 'new-hot-pub' };
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    mockIsGuardianAccount.mockResolvedValue(true);
    // Post-rotation service reports no update_guardian threshold → needs hardening.
    mockGetOrCreateMultisigService.mockResolvedValue({
      getProcedureThreshold: jest.fn(() => undefined),
      sync: jest.fn(async () => {})
    });
    const provider = {
      getAccounts: async () => [{ publicKey: 'acc-1', coldPublicKey: 'cold', hotPublicKey: 'old-hot-pub' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: async () => 'sig',
      swapHotKey: jest.fn(async () => {})
    };

    await completeReplaceHotKeyTransaction(tx, makeResult() as never, provider as never);

    const upt = txStore.find(r => r.type === 'update-procedure-threshold') as Record<string, unknown>;
    expect(upt).toBeDefined();
    expect(upt.extraInputs).toEqual({ procedure: 'update_guardian', threshold: 2 });
  });

  it('does NOT enqueue hardening when update_guardian is already at threshold 2 (recovered/fresh account)', async () => {
    const tx = new ReplaceHotKeyTransaction('acc-1', false);
    tx.extraInputs = { newHotPublicKey: 'new-hot-pub' };
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    mockIsGuardianAccount.mockResolvedValue(true);
    mockGetOrCreateMultisigService.mockResolvedValue({
      getProcedureThreshold: jest.fn(() => 2),
      sync: jest.fn(async () => {})
    });
    const provider = {
      getAccounts: async () => [{ publicKey: 'acc-1', coldPublicKey: 'cold', hotPublicKey: 'old-hot-pub' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: async () => 'sig',
      swapHotKey: jest.fn(async () => {})
    };

    await completeReplaceHotKeyTransaction(tx, makeResult() as never, provider as never);

    expect(txStore.find(r => r.type === 'update-procedure-threshold')).toBeUndefined();
  });

  it('still calls swapHotKey even when the row already reflects new hot (vault handles idempotency)', async () => {
    const tx = new ReplaceHotKeyTransaction('acc-1', false);
    tx.extraInputs = { newHotPublicKey: 'already-rotated' };
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    const swapHotKey = jest.fn(async () => {});
    const provider = {
      getAccounts: async () => [{ publicKey: 'acc-1', hotPublicKey: 'already-rotated', coldPublicKey: 'cold' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: async () => 'sig',
      swapHotKey
    };

    await completeReplaceHotKeyTransaction(tx, makeResult() as never, provider as never);

    // Idempotency moved into Vault.swapHotKey — the caller always invokes it.
    expect(swapHotKey).toHaveBeenCalledWith('acc-1', 'already-rotated');
    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
  });

  it('marks the row Failed when extraInputs.newHotPublicKey is missing', async () => {
    const tx = new ReplaceHotKeyTransaction('acc-1', false);
    // intentionally leave extraInputs empty to simulate a corrupt/incomplete row
    tx.extraInputs = {};
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    const provider = {
      getAccounts: async () => [{ publicKey: 'acc-1', hotPublicKey: 'old-hot-pub', coldPublicKey: 'cold' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: async () => 'sig',
      swapHotKey: jest.fn()
    };

    await completeReplaceHotKeyTransaction(tx, makeResult() as never, provider as never);

    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(row.displayMessage).toBe('Failed to rotate device key');
  });
});

describe('completeUpdateProcedureThresholdTransaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    txStore.length = 0;
  });

  it('marks Completed, drops the cached service, and re-registers the new state on the guardian', async () => {
    const tx = new UpdateProcedureThresholdTransaction('acc-1', 'update_guardian', 2, false);
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    const reRegisterCurrentStateOnGuardian = jest.fn(async () => {});

    await completeUpdateProcedureThresholdTransaction(
      tx,
      makeResult() as never,
      {
        reRegisterCurrentStateOnGuardian
      } as never
    );

    expect(reRegisterCurrentStateOnGuardian).toHaveBeenCalledTimes(1);
    expect(mockClearGuardianServiceFor).toHaveBeenCalledWith('acc-1');
    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.displayMessage).toBe('Account secured');
  });

  it('still completes (best-effort) when the guardian re-registration fails', async () => {
    const tx = new UpdateProcedureThresholdTransaction('acc-1', 'update_guardian', 2, false);
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    await completeUpdateProcedureThresholdTransaction(
      tx,
      makeResult() as never,
      {
        reRegisterCurrentStateOnGuardian: jest.fn(async () => {
          throw new Error('guardian down');
        })
      } as never
    );

    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
  });
});

describe('ensureGuardianProcedureThresholds', () => {
  beforeEach(() => {
    txStore.length = 0;
    mockIsGuardianAccount.mockResolvedValue(true);
  });

  it('returns the queued txId so an off-extension caller can drive the FIFO loop', async () => {
    // The only nudge inside this function is `requestSWTransactionProcessing()`,
    // which is a no-op off-extension. The id is the caller's cue to start the
    // background processor itself (see `syncGuardianAccounts`); returning nothing
    // left the row Queued for the rest of the session on mobile/desktop.
    mockGetOrCreateMultisigService.mockResolvedValue({ getProcedureThreshold: () => 1 });

    const txId = await ensureGuardianProcedureThresholds('guardian-acc', false, {} as never);

    expect(typeof txId).toBe('string');
    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    expect(row.type).toBe('update-procedure-threshold');
    expect(row.status).toBe(ITransactionStatus.Queued);
  });

  it('returns undefined when the account is already hardened (nothing was enqueued)', async () => {
    mockGetOrCreateMultisigService.mockResolvedValue({ getProcedureThreshold: () => 2 });

    await expect(ensureGuardianProcedureThresholds('guardian-acc', false, {} as never)).resolves.toBeUndefined();
    expect(txStore).toHaveLength(0);
  });

  it('returns undefined (never throws) when the threshold check itself fails', async () => {
    mockGetOrCreateMultisigService.mockRejectedValue(new Error('guardian down'));

    await expect(ensureGuardianProcedureThresholds('guardian-acc', false, {} as never)).resolves.toBeUndefined();
    expect(txStore).toHaveLength(0);
  });
});

// The one commit-wait failure where "finalize anyway" inverts. A timeout leaves
// the rotation possibly on chain, so persisting the new endpoint is the safer
// guess; a DISCARD is the node ruling that it provably is not, and persisting
// then would report "Guardian switched" for a switch that never happened AND
// point the vault at an operator with no on-chain authority over the account.
describe('generateTransaction — direct switch, discarded transaction', () => {
  it('fails the row and leaves the endpoint alone when the node discards the direct switch', async () => {
    const txId = 'switch-guardian-direct-discarded';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'switch-guardian',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
    });

    mockGetOrCreateMultisigService.mockRejectedValue(new Error('Failed to fetch'));
    mockCreateDirectSwitchRequest.mockResolvedValue({
      request: { serialize: () => new Uint8Array([2]) },
      chainAnchorB64: 'Y2hhaW4tYW5jaG9y'
    });
    mockFinalizeDirectSwitch.mockResolvedValue(undefined);

    const setGuardianEndpoint = jest.fn(async () => {});
    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'hot-pub' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: jest.fn(async () => 'sig'),
      setGuardianEndpoint
    };
    mockIsGuardianAccount.mockResolvedValue(true);
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      // Verbatim the text both the SDK's `waitFor` and the offscreen poll loop
      // raise from their `isDiscarded()` branch.
      waitForTransactionCommit: jest.fn(async () => {
        throw new Error('Transaction rejected: exec-tx-hash');
      }),
      client: makeClientApi(result)
    });

    await generateTransaction(
      {
        id: txId,
        type: 'switch-guardian',
        accountId: 'guardian-acc',
        extraInputs: { newGuardianEndpoint: 'https://new.guardian' },
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    // The discard reaches generateTransaction's generic handler, which cancels the
    // row. What matters is that completion never ran: no new endpoint in the
    // vault, no registration on an operator with no authority over the account.
    const row = txStore.find(r => r.id === txId)!;
    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(setGuardianEndpoint).not.toHaveBeenCalled();
    expect(mockFinalizeDirectSwitch).not.toHaveBeenCalled();
  });
});

// The two switch paths leave different states behind on a partial failure, and
// the direct one acts on a VERDICT that can be wrong — so a support log needs to
// be able to tell which path a row took and why. Written before the leaf executes
// so the marker survives a row that then fails.
describe('generateTransaction — direct switch audit marker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    txStore.length = 0;
  });

  const setup = (txId: string) => {
    txStore.push({
      id: txId,
      type: 'switch-guardian',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
    });
    mockCreateDirectSwitchRequest.mockResolvedValue({
      request: { serialize: () => new Uint8Array([2]) },
      chainAnchorB64: 'Y2hhaW4tYW5jaG9y'
    });
    mockFinalizeDirectSwitch.mockResolvedValue(undefined);
    mockIsGuardianAccount.mockResolvedValue(true);
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      waitForTransactionCommit: jest.fn(async () => {}),
      client: makeClientApi(makeResult())
    });
    return {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'hot-pub' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: jest.fn(async () => 'sig'),
      setGuardianEndpoint: jest.fn(async () => {})
    };
  };

  const run = (txId: string, provider: unknown) =>
    generateTransaction(
      {
        id: txId,
        type: 'switch-guardian',
        accountId: 'guardian-acc',
        extraInputs: { newGuardianEndpoint: 'https://new.guardian' },
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

  /** The row's audit fields, narrowed — `txStore` rows are `Record<string, unknown>`. */
  const markerExtraInputs = (txId: string): { switchedDirectly?: boolean; directSwitchReason?: string } =>
    (txStore.find(r => r.id === txId)?.extraInputs ?? {}) as {
      switchedDirectly?: boolean;
      directSwitchReason?: string;
    };

  it('records the direct path and the classified reason, with the HTTP status that decided it', async () => {
    const txId = 'switch-guardian-marker-service-load';
    const provider = setup(txId);
    mockGetOrCreateMultisigService.mockRejectedValue(Object.assign(new Error('Service Unavailable'), { status: 503 }));

    await run(txId, provider);

    const extra = markerExtraInputs(txId);
    expect(extra).toMatchObject({ switchedDirectly: true });
    expect(extra.directSwitchReason).toContain('before the proposal was pushed');
    expect(extra.directSwitchReason).toContain('HTTP 503');
    // The service load reaches ONLY the outgoing operator, so the attribution
    // can be exact here — and must not widen, or the precise case loses its
    // precision to the imprecise one.
    expect(extra.directSwitchReason).toContain('outgoing guardian unreachable');
    expect(extra.directSwitchReason).not.toContain('outgoing or new');
  });

  // `createSwitchGuardianProposal` fetches the NEW guardian's pubkey before it
  // posts anything to the outgoing one, so a typo'd or down NEW endpoint fails
  // inside this arm. Attributing that to the outgoing guardian blamed the wrong
  // operator on the one path whose whole job is saying which one is down.
  it('does not blame the outgoing guardian for a failure that may be the new endpoint', async () => {
    const txId = 'switch-guardian-marker-proposal-push';
    const provider = setup(txId);
    mockGetOrCreateMultisigService.mockResolvedValue({
      createSwitchGuardianProposal: jest.fn(async () => {
        throw new Error('Failed to fetch');
      }),
      abandonCandidate: jest.fn(async () => {})
    });

    await run(txId, provider);

    const extra = markerExtraInputs(txId);
    expect(extra).toMatchObject({ switchedDirectly: true });
    expect(extra.directSwitchReason).toContain('outgoing or new guardian unreachable');
  });

  // The escape route for the users who need it most. A rotation whose registration
  // never landed leaves the chain naming an operator that holds NOTHING for this
  // account; three exhausted self-heal attempts then mark it `unrepairable`, and
  // Settings offers exactly one action — Rotate Guardian. That action used to die at
  // the first step, because loading the outgoing service calls the guardian's
  // `getState`, which answers `account_not_found`: not a 5xx, so the fallback did
  // not fire and the row failed terminally with the user's only offered recovery
  // unable to run. An operator with no record cannot co-sign a proposal for the
  // account, and the direct path needs nothing from it.
  it.each([
    ['account_not_found', 'account_not_found'],
    ['state_not_found', 'state_not_found'],
    ['data_unavailable', 'data_unavailable']
  ])('escapes an outgoing guardian that answers %s', async (_label, code) => {
    const txId = `switch-guardian-marker-unknown-${code}`;
    const provider = setup(txId);
    mockGetOrCreateMultisigService.mockRejectedValue(Object.assign(new Error('no such account'), { code }));

    await run(txId, provider);

    const extra = markerExtraInputs(txId);
    expect(extra).toMatchObject({ switchedDirectly: true });
    // Attributed to the outgoing operator whichever phase threw: the new guardian
    // is only asked for its `/pubkey`, which is not account-scoped and so cannot
    // answer "no record of this account".
    expect(extra.directSwitchReason).toContain('outgoing guardian has no record of this account');
    expect(extra.directSwitchReason).not.toContain('unreachable');
  });

  // And the two classes stay distinct in the audit trail, since the row is the only
  // record of which verdict routed it.
  it('keeps a semantic guardian rejection on the normal path', async () => {
    const txId = 'switch-guardian-marker-semantic-rejection';
    const provider = setup(txId);
    mockGetOrCreateMultisigService.mockRejectedValue(Object.assign(new Error('Conflict'), { status: 409 }));

    await run(txId, provider);

    expect(markerExtraInputs(txId).switchedDirectly).toBeUndefined();
  });

  it('distinguishes the post-proposal cold-co-sign fallback in the recorded reason', async () => {
    const txId = 'switch-guardian-marker-cold-cosign';
    const provider = setup(txId);
    mockGetOrCreateMultisigService.mockResolvedValue({
      createSwitchGuardianProposal: jest.fn(async () => ({ proposal: { id: 'prop-1', nonce: 7 } })),
      abandonCandidate: jest.fn(async () => {})
    });
    mockBuildColdMultisigService.mockRejectedValue(new Error('Failed to fetch'));

    await run(txId, provider);

    const extra = markerExtraInputs(txId);
    expect(extra).toMatchObject({ switchedDirectly: true });
    expect(extra.directSwitchReason).toContain('at cold co-sign');
  });

  // The stage the user reads while this runs. NOT `signing-proposal`, whose copy
  // says the guardian is signing — on this path no operator is contacted at all,
  // and the reason the path is running is that one could not be reached. Sampled
  // where the signing actually happens rather than off the finished row, whose
  // stage is `complete` by the time the call returns.
  it('stamps signing-locally while the hot and cold keys sign the direct switch', async () => {
    const txId = 'switch-guardian-stage-signing-locally';
    const provider = setup(txId);
    mockGetOrCreateMultisigService.mockRejectedValue(new Error('Failed to fetch'));

    let stageAtSigning: unknown;
    mockCreateDirectSwitchRequest.mockImplementation(async () => {
      stageAtSigning = txStore.find(r => r.id === txId)?.stage;
      return { request: { serialize: () => new Uint8Array([2]) }, chainAnchorB64: 'Y2hhaW4tYW5jaG9y' };
    });

    await run(txId, provider);

    expect(stageAtSigning).toBe('signing-locally');
  });

  it('leaves the marker on a row whose direct switch then fails', async () => {
    const txId = 'switch-guardian-marker-then-fails';
    const provider = setup(txId);
    mockGetOrCreateMultisigService.mockRejectedValue(new Error('Failed to fetch'));
    mockCreateDirectSwitchRequest.mockRejectedValue(new Error('cold key unavailable'));

    await run(txId, provider).catch(() => {});

    expect(markerExtraInputs(txId)).toMatchObject({ switchedDirectly: true });
  });

  it('does not mark a coordinated switch as direct', async () => {
    const txId = 'switch-guardian-marker-coordinated';
    const provider = setup(txId);
    const createSwitchGuardianProposal = jest.fn(async () => ({ proposal: { id: 'prop-1', nonce: 7 } }));
    const signProposal = jest.fn(async () => {});
    mockGetOrCreateMultisigService.mockResolvedValue({
      createSwitchGuardianProposal,
      finalizeGuardianSwitch: jest.fn(async () => {}),
      abandonCandidate: jest.fn(async () => {})
    });
    mockBuildColdMultisigService.mockResolvedValue({ signProposal });

    await run(txId, provider).catch(() => {});

    // Pin that the coordinated path was actually walked — otherwise an early
    // throw for an unrelated reason would satisfy the assertion below.
    expect(createSwitchGuardianProposal).toHaveBeenCalledWith('https://new.guardian');
    expect(signProposal).toHaveBeenCalledWith('prop-1');
    expect(mockCreateDirectSwitchRequest).not.toHaveBeenCalled();

    expect(markerExtraInputs(txId).switchedDirectly).toBeUndefined();
  });
});

// A guardian that accepts the connection and then never answers is the outage
// most in need of the direct switch, and it was the one shape that could not
// reach it: the service load sits inside `withWasmClientLock`, the guardian
// transport has no abort, so the hold ran out the 5-minute watchdog and the
// eviction arrived as `WasmClientPoisonedError` — deliberately NOT classified
// unreachable, so the fallback never fired and the terminal row had no retry.
describe('generateTransaction — direct switch, wedged outgoing guardian', () => {
  it('gives up on a silent outgoing guardian and takes the direct path', async () => {
    jest.useFakeTimers();
    const txId = 'switch-guardian-wedged-operator';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'switch-guardian',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
    });

    // Never settles — the operator accepted the connection and went quiet.
    mockGetOrCreateMultisigService.mockReturnValue(new Promise(() => {}));
    mockCreateDirectSwitchRequest.mockResolvedValue({
      request: { serialize: () => new Uint8Array([2]) },
      chainAnchorB64: 'Y2hhaW4tYW5jaG9y'
    });
    mockFinalizeDirectSwitch.mockResolvedValue(undefined);

    const setGuardianEndpoint = jest.fn(async () => {});
    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'hot-pub' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: jest.fn(async () => 'sig'),
      setGuardianEndpoint
    };
    mockIsGuardianAccount.mockResolvedValue(true);
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      waitForTransactionCommit: jest.fn(async () => {}),
      client: makeClientApi(result)
    });

    const run = generateTransaction(
      {
        id: txId,
        type: 'switch-guardian',
        accountId: 'guardian-acc',
        extraInputs: { newGuardianEndpoint: 'https://new.guardian' },
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    await jest.advanceTimersByTimeAsync(30_000);
    await run;

    expect(mockCreateDirectSwitchRequest).toHaveBeenCalled();
    expect(setGuardianEndpoint).toHaveBeenCalledWith('guardian-acc', 'https://new.guardian');
    const row = txStore.find(r => r.id === txId)!;
    expect(row.status).toBe(ITransactionStatus.Completed);
    jest.useRealTimers();
  });

  // The deadline above created this one. Reaching the fallback via a cold-sign
  // deadline means the proposal was already pushed, so the cleanup
  // `abandonCandidate` runs first — against the SAME operator whose silence is
  // the reason we are here. Unbounded, that best-effort cleanup does not delay
  // the fallback, it replaces it: the row sits at `signing-proposal` forever,
  // and `switch-guardian` has neither a requeue nor a user-facing Retry.
  it('does not let a silent candidate-abandon block the direct switch', async () => {
    jest.useFakeTimers();
    const txId = 'switch-guardian-wedged-abandon';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'switch-guardian',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
    });

    // The proposal lands, then the operator goes quiet for the cold co-sign —
    // and stays quiet for the abandon that follows.
    const abandonCandidate = jest.fn(() => new Promise(() => {}));
    mockGetOrCreateMultisigService.mockResolvedValue({
      createSwitchGuardianProposal: jest.fn(async () => ({ proposal: { id: 'prop-1', nonce: 7 } })),
      abandonCandidate
    });
    mockBuildColdMultisigService.mockReturnValue(new Promise(() => {}));
    mockCreateDirectSwitchRequest.mockResolvedValue({
      request: { serialize: () => new Uint8Array([2]) },
      chainAnchorB64: 'Y2hhaW4tYW5jaG9y'
    });
    mockFinalizeDirectSwitch.mockResolvedValue(undefined);

    const setGuardianEndpoint = jest.fn(async () => {});
    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'hot-pub' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: jest.fn(async () => 'sig'),
      setGuardianEndpoint
    };
    mockIsGuardianAccount.mockResolvedValue(true);
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      getAccount: jest.fn(async () => ({ id: () => ({ toString: () => 'guardian-acc' }) })),
      waitForTransactionCommit: jest.fn(async () => {}),
      client: makeClientApi(result)
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const run = generateTransaction(
      {
        id: txId,
        type: 'switch-guardian',
        accountId: 'guardian-acc',
        extraInputs: { newGuardianEndpoint: 'https://new.guardian' },
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      provider as never
    );

    // One deadline for the cold co-sign, a second for the abandon.
    await jest.advanceTimersByTimeAsync(30_000);
    await jest.advanceTimersByTimeAsync(30_000);
    await run;

    expect(abandonCandidate).toHaveBeenCalledWith(7);
    expect(mockCreateDirectSwitchRequest).toHaveBeenCalled();
    const row = txStore.find(r => r.id === txId)!;
    expect(row.status).toBe(ITransactionStatus.Completed);
    jest.useRealTimers();
  });
});

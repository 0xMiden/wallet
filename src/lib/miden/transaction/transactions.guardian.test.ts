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

import {
  completeReplaceHotKeyTransaction,
  completeSwitchGuardianTransaction,
  completeUpdateProcedureThresholdTransaction,
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
    filter: jest.fn(() => ({ toArray: jest.fn(async () => []) }))
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

const mockWithWasmClientLock = jest.fn(async (fn: () => Promise<unknown>) => fn());
const mockGetMidenClient = jest.fn();
const mockCreateWasmWebClient = jest.fn();
// Match the relative path used by transactions.ts so the mock intercepts.
jest.mock('../sdk/miden-client', () => ({
  withWasmClientLock: (...a: unknown[]) => mockWithWasmClientLock(...(a as [() => Promise<unknown>])),
  getMidenClient: (...a: unknown[]) => mockGetMidenClient(...a)
}));

jest.mock('lib/intercom', () => ({
  getIntercom: () => ({ broadcast: jest.fn(), request: jest.fn() })
}));

jest.mock('lib/store', () => ({
  useWalletStore: { getState: () => ({ accounts: [], setLastCompletedTxHash: jest.fn() }) }
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
  canonicalWalletAccountId: (id: string) => id.split('_')[0] ?? id,
  sameWalletAccountId: (a: string, b: string) => (a.split('_')[0] ?? a) === (b.split('_')[0] ?? b)
}));

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
    getAccounts: async () => [],
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
    expect(extra.newGuardianEndpoint).toBe('https://new.guardian');
  });

  it('throws when the target account is not a Guardian account', async () => {
    const provider = makeGuardianProvider(false);

    await expect(initiateSwitchGuardianTransaction('acc-public', 'https://new', false, provider)).rejects.toThrow(
      'Switch guardian is only supported for Guardian accounts'
    );
    expect(txStore).toHaveLength(0);
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
    expect(row.displayMessage).toBe('Guardian switched');
  });

  it('marks the row Failed and skips the endpoint write when registration throws', async () => {
    const tx = new SwitchGuardianTransaction('acc-1', 'https://new.guardian', false);
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    const multisigService = {
      finalizeGuardianSwitch: jest.fn(async () => {
        throw new Error('register failed');
      })
    };
    const setGuardianEndpoint = jest.fn(async () => {});
    const provider = { ...makeGuardianProvider(true), setGuardianEndpoint };

    await completeSwitchGuardianTransaction(tx, makeResult() as never, multisigService as never, provider as never);

    // The endpoint was NOT persisted because the guardian rejected the new state.
    expect(setGuardianEndpoint).not.toHaveBeenCalled();
    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(row.displayMessage).toBe('Failed to switch guardian');
    expect(row.error).toBe('register failed');
  });
});

describe('generateTransaction — Guardian routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateWasmWebClient.mockReset();
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

    expect(multisigService.createSendProposal).toHaveBeenCalledWith('recipient', 'faucet', 1000n);
    expect(multisigService.signAndCreateTransactionRequest).toHaveBeenCalledWith('prop-1', undefined);
    expect(multisigService.sync).toHaveBeenCalled();
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

      const newSendTransactionRequest = jest.fn(async () => ({
        serialize: () => requestBytes
      }));
      const terminate = jest.fn();
      mockCreateWasmWebClient.mockResolvedValue({ newSendTransactionRequest, terminate });

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
        syncState: jest.fn(async () => {}),
        client
      });

      await generateTransaction(
        transaction,
        jest.fn(async () => new Uint8Array([2])),
        false,
        makeGuardianProvider(true)
      );

      expect(mockCreateWasmWebClient).toHaveBeenCalledWith(expect.any(String));
      expect(newSendTransactionRequest).toHaveBeenCalledWith(
        expect.objectContaining({ toString: expect.any(Function) }),
        expect.objectContaining({ toString: expect.any(Function) }),
        expect.objectContaining({ toString: expect.any(Function) }),
        expectedSdkNoteType,
        1000n,
        125,
        null
      );
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(multisigService.createCustomProposal).toHaveBeenCalledWith(requestBytes, 'recallable_send');
      expect(multisigService.createSendProposal).not.toHaveBeenCalled();
      expect(multisigService.signAndCreateTransactionRequest).toHaveBeenCalledWith('recall-proposal', requestBytes);
      expect(txStore.find(row => row.id === txId)?.requestBytes).toBe(requestBytes);
    }
  );

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
    // The fallback recovered the tx, so the candidate is NOT abandoned and the
    // row lands Completed rather than Failed.
    expect(abandonCandidate).not.toHaveBeenCalled();
    expect(txStore.find(row => row.id === txId)?.status).toBe(ITransactionStatus.Completed);
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

    const coldService = { signProposal: jest.fn(async () => {}) };
    mockBuildColdMultisigService.mockResolvedValue(coldService);

    const provider = {
      getAccounts: async () => [{ publicKey: 'guardian-acc', coldPublicKey: 'cold-pub', hotPublicKey: 'hot-pub' }],
      getPublicKeyForCommitment: async () => 'pk',
      signWord: async () => 'sig'
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
    const applyErr: Error & { errorCode?: string } = new Error('apply failed');
    applyErr.errorCode = 'ApplyTransactionAfterSubmitFailed';
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

    const applyErr: Error & { errorCode?: string } = new Error('apply failed');
    applyErr.errorCode = 'ApplyTransactionAfterSubmitFailed';
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

    const applyErr: Error & { errorCode?: string } = new Error('apply failed');
    applyErr.errorCode = 'ApplyTransactionAfterSubmitFailed';
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
    const applyErr: Error & { errorCode?: string } = new Error('apply failed');
    applyErr.errorCode = 'ApplyTransactionAfterSubmitFailed';
    mockGetMidenClient.mockResolvedValue({
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

    const applyErr: Error & { errorCode?: string } = new Error('apply failed');
    applyErr.errorCode = 'ApplyTransactionAfterSubmitFailed';
    mockGetMidenClient.mockResolvedValue({
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

    expect(multisigService.createSendProposal).toHaveBeenCalledWith('recipient', 'faucet', 1000n);
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

    mockBuildColdMultisigService.mockResolvedValue({
      reRegisterCurrentStateOnGuardian: jest.fn(async () => {
        throw new Error('guardian down');
      })
    });
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

    expect(swapHotKey).toHaveBeenCalledWith('acc-1', 'new-hot-pub');
    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
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

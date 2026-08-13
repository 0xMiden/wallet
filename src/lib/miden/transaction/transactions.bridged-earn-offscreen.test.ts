/**
 * Non-guardian `bridged-send` / `earn-deposit` LEAF WRITE → offscreen routing
 * (issue #260, slice 7b).
 *
 * These value-moving writes used to run INLINE on the SW client
 * (`withWasmClientLock(() => getMidenClient(options).sendTransaction/newTransaction)`).
 * Slice 7b routes their LEAF write through `midenClientProxy` — exactly like the
 * send/execute cases moved in slice 5b — so it can run WHOLE-OP offscreen when
 * MIDEN_USE_OFFSCREEN_CLIENT is on. The proxy's own flag routing (flag-off →
 * byte-identical inline SW client; flag-on → offscreen dispatch) is proven in
 * `miden-client-proxy.test.ts`; these tests pin the DELEGATION seam — that the
 * non-guardian `generateTransaction` switch hands each leaf to the proxy with the
 * exact args the former inline block passed, and NEVER touches the inline
 * `getMidenClient(...)` leaf anymore.
 *
 * Routing:
 *   - Epoch bridged-send + earn-deposit → send-style recallable P2IDE note →
 *     `midenClientProxy.sendTransaction(tx, signCallback)`.
 *   - Agglayer bridged-send (pre-built request) →
 *     `midenClientProxy.newTransaction(accountId, requestBytes, delegate, signCallback)`.
 *
 * Funds-safety (analysed, not re-proven here — inherited from the shared proxy +
 * loop machinery): a wedge-kill → OperationAbortedError → the
 * `generateTransactionsLoop` catch → cancelTransaction → Failed with NO auto-requeue
 * (earn-deposit is excluded from REQUEUEABLE_TYPES; bridged-send is user-retry-only,
 * identical to the already-moved send/execute), and a round-tripped
 * `ApplyTransactionAfterSubmitFailed` reaches that same type-agnostic classifier.
 */

import { generateTransaction } from './index';
import { ITransactionStatus } from '../db/types';

const txStore: Array<Record<string, unknown>> = [];

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

jest.mock('../front', () => ({
  putToStorage: jest.fn(async () => {}),
  fetchFromStorage: jest.fn(),
  onStorageChanged: jest.fn()
}));

jest.mock('lib/settings/constants', () => ({ GUARDIAN_URL_STORAGE_KEY: 'guardian_url_setting' }));

// Non-guardian throughout: the standard signCallback dispatch path.
const mockIsGuardianAccount = jest.fn(async (..._a: unknown[]) => false);
jest.mock('lib/miden/front/guardian-manager', () => ({
  isGuardianAccount: (...a: unknown[]) => mockIsGuardianAccount(...a),
  getOrCreateMultisigService: jest.fn(),
  clearGuardianServiceFor: jest.fn()
}));

jest.mock('lib/miden/guardian', () => ({
  MultisigService: { buildColdMultisigService: jest.fn() }
}));

// The inline SW client leaf (`getMidenClient(...)`). After slice 7b nothing on the
// non-guardian bridged/earn path may touch it — assert its send/newTransaction spies
// stay untouched.
const mockInlineSendTransaction = jest.fn(async () => makeResult());
const mockInlineNewTransaction = jest.fn(async () => makeResult());
const mockGetMidenClient = jest.fn(async () => ({
  sendTransaction: (...a: unknown[]) => mockInlineSendTransaction(...(a as [])),
  newTransaction: (...a: unknown[]) => mockInlineNewTransaction(...(a as []))
}));
const mockWithWasmClientLock = jest.fn(async (fn: () => Promise<unknown>) => fn());
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
jest.mock('../sdk/miden-client', () => ({
  withWasmClientLock: (...a: unknown[]) => mockWithWasmClientLock(...(a as [() => Promise<unknown>])),
  getMidenClient: (...a: unknown[]) => mockGetMidenClient(...(a as []))
}));

// The routing seam under test: the leaf writes are controllable spies. `syncState`
// is the pre-tx sync (no-op here).
const mockProxySendTransaction = jest.fn(async (..._a: unknown[]) => makeResult());
const mockProxyNewTransaction = jest.fn(async (..._a: unknown[]) => makeResult());
jest.mock('../back/miden-client-proxy', () => ({
  dispatchGuardianPipeline: jest.fn(),
  midenClientProxy: {
    syncState: jest.fn(async () => {}),
    getAccount: jest.fn(async () => null),
    waitForTransactionCommit: jest.fn(async () => {}),
    consumeNoteId: jest.fn(async () => makeResult()),
    swapTransaction: jest.fn(async () => makeResult()),
    sendTransaction: (...a: unknown[]) => mockProxySendTransaction(...a),
    newTransaction: (...a: unknown[]) => mockProxyNewTransaction(...a)
  }
}));

// Offscreen API present, so the FLAG alone decides the route (inside the proxy).
jest.mock('../back/offscreen-prover', () => ({ isOffscreenAvailable: () => true }));

// Completion handlers as spies so we can assert which one finalizes the row and with
// which result, without touching the real completion graph.
const mockComplete = {
  bridged: jest.fn(async (..._a: unknown[]) => {}),
  earn: jest.fn(async (..._a: unknown[]) => {})
};
jest.mock('./complete', () => ({
  completeSendTransaction: jest.fn(async () => {}),
  completeConsumeTransaction: jest.fn(async () => {}),
  completeSwapTransaction: jest.fn(async () => {}),
  completeCustomTransaction: jest.fn(async () => {}),
  completeBridgedSendTransaction: (...a: unknown[]) => mockComplete.bridged(...a),
  completeEarnDepositTransaction: (...a: unknown[]) => mockComplete.earn(...a),
  completeSwitchGuardianTransaction: jest.fn(async () => {}),
  completeReplaceHotKeyTransaction: jest.fn(async () => {}),
  completeUpdateProcedureThresholdTransaction: jest.fn(async () => {})
}));

jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const actual = jest.requireActual('../../../../__mocks__/wasmMock.js');
  return {
    ...actual,
    TransactionProver: {
      newLocalProver: jest.fn(() => 'local-prover'),
      newCallbackProver: jest.fn(() => 'callback-prover')
    },
    WasmWebClient: { createClient: jest.fn() }
  };
});

jest.mock('../sdk/native-prover-mobile', () => ({
  buildNativeProverCallback: jest.fn(() => async () => new Uint8Array())
}));

jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isMobile: () => false
}));

jest.mock('shared/logger', () => ({
  logger: { warning: jest.fn(), error: jest.fn(), info: jest.fn() }
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
  canonicalWalletAccountId: (id: string) => id,
  sameWalletAccountId: (a: string, b: string) => a === b
}));

jest.mock('lib/intercom', () => ({ getIntercom: () => ({ broadcast: jest.fn(), request: jest.fn() }) }));
jest.mock('lib/store', () => ({
  useWalletStore: { getState: () => ({ accounts: [], setLastCompletedTxHash: jest.fn() }) }
}));

// A TransactionResult-like whose serialize() + executedTransaction() are stable.
function makeResult(bytes: number[] = [7, 7, 7]) {
  return {
    executedTransaction: () => ({
      id: () => ({ toHex: () => 'exec-tx-hash' }),
      outputNotes: () => ({ notes: () => [] }),
      inputNotes: () => ({ notes: () => [] })
    }),
    serialize: () => new Uint8Array(bytes)
  };
}

const buildTx = (id: string, extra: Record<string, unknown>) => ({
  id,
  accountId: 'acc-1',
  status: ITransactionStatus.Queued,
  displayMessage: 'Queued',
  displayIcon: 'DEFAULT',
  delegateTransaction: false,
  initiatedAt: Math.floor(Date.now() / 1000),
  ...extra
});

const signCallback = jest.fn(async () => new Uint8Array([2]));
const provider = {
  getAccounts: async () => [] as unknown[],
  getPublicKeyForCommitment: async () => 'pk',
  signWord: async () => 'sig'
};

async function run(id: string, extra: Record<string, unknown>) {
  const tx = buildTx(id, extra);
  txStore.push({ ...tx });
  await generateTransaction(tx as never, signCallback, false, provider as never);
  return tx;
}

beforeEach(() => {
  jest.clearAllMocks();
  txStore.length = 0;
  delete process.env.MIDEN_USE_OFFSCREEN_CLIENT;
});

afterEach(() => {
  delete process.env.MIDEN_USE_OFFSCREEN_CLIENT;
});

describe('non-guardian bridged-send / earn-deposit leaf → proxy delegation (slice 7b)', () => {
  it('Epoch bridged-send (no requestBytes) → midenClientProxy.sendTransaction(tx, signCallback); never the inline SW leaf', async () => {
    const tx = await run('tx-bs-epoch', {
      type: 'bridged-send',
      secondaryAccountId: 'mtst1qallocator',
      faucetId: 'faucet',
      amount: 1000n,
      noteType: 'public',
      extraInputs: { provider: 'epoch', recallBlocks: 10 }
    });

    // Leaf routed through the proxy send with the FULL tx row + the raw signCallback.
    expect(mockProxySendTransaction).toHaveBeenCalledTimes(1);
    expect(mockProxySendTransaction).toHaveBeenCalledWith(tx, signCallback);
    expect(mockProxyNewTransaction).not.toHaveBeenCalled();
    // The inline SW client leaf is entirely gone.
    expect(mockGetMidenClient).not.toHaveBeenCalled();
    expect(mockInlineSendTransaction).not.toHaveBeenCalled();
    // Finalized via the bridged-send completion with the proxy's result.
    expect(mockComplete.bridged).toHaveBeenCalledTimes(1);
    expect(mockComplete.earn).not.toHaveBeenCalled();
  });

  it('Agglayer bridged-send (pre-built requestBytes) → midenClientProxy.newTransaction(accountId, requestBytes, delegate, signCallback)', async () => {
    const requestBytes = new Uint8Array([0xa9, 0x1a]);
    const tx = await run('tx-bs-agg', {
      type: 'bridged-send',
      requestBytes,
      faucetId: 'faucet',
      amount: 2000n,
      delegateTransaction: true,
      extraInputs: { provider: 'agglayer' }
    });

    expect(mockProxyNewTransaction).toHaveBeenCalledTimes(1);
    expect(mockProxyNewTransaction).toHaveBeenCalledWith('acc-1', requestBytes, true, signCallback);
    expect(mockProxySendTransaction).not.toHaveBeenCalled();
    expect(mockGetMidenClient).not.toHaveBeenCalled();
    expect(mockInlineNewTransaction).not.toHaveBeenCalled();
    expect(mockComplete.bridged).toHaveBeenCalledTimes(1);
    void tx;
  });

  it('earn-deposit (always send-style) → midenClientProxy.sendTransaction(tx, signCallback); never newTransaction, never the inline SW leaf', async () => {
    const tx = await run('tx-earn', {
      type: 'earn-deposit',
      secondaryAccountId: 'mtst1qallocator',
      faucetId: 'faucet',
      amount: 500n,
      noteType: 'public',
      extraInputs: { recallBlocks: 10, epochStatus: 'pending' }
    });

    expect(mockProxySendTransaction).toHaveBeenCalledTimes(1);
    expect(mockProxySendTransaction).toHaveBeenCalledWith(tx, signCallback);
    expect(mockProxyNewTransaction).not.toHaveBeenCalled();
    expect(mockGetMidenClient).not.toHaveBeenCalled();
    expect(mockInlineSendTransaction).not.toHaveBeenCalled();
    // Finalized via the earn-deposit completion (NOT the generic custom-tx path).
    expect(mockComplete.earn).toHaveBeenCalledTimes(1);
    expect(mockComplete.bridged).not.toHaveBeenCalled();
  });

  it('flag ON changes nothing at THIS seam — the switch still delegates to the proxy leaf (the proxy owns the offscreen route)', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    const tx = await run('tx-earn-flagon', {
      type: 'earn-deposit',
      secondaryAccountId: 'mtst1qallocator',
      faucetId: 'faucet',
      amount: 500n,
      noteType: 'public',
      extraInputs: { recallBlocks: 10, epochStatus: 'pending' }
    });

    expect(mockProxySendTransaction).toHaveBeenCalledWith(tx, signCallback);
    // The proxy is the ONLY leaf — the switch never forks on the flag itself.
    expect(mockGetMidenClient).not.toHaveBeenCalled();
  });
});

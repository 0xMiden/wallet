/**
 * Non-guardian `bridged-send` / `earn-deposit` LEAF WRITE → offscreen routing
 * (issue #260, slice 7b).
 *
 * These value-moving writes used to run INLINE on the SW client
 * (`withWasmClientLock(() => getMidenClient(options).sendTransaction/newTransaction)`).
 * Slice 7b routes their LEAF write through `midenClientProxy` - exactly like the
 * send/execute cases moved in slice 5b - so it can run WHOLE-OP offscreen when
 * MIDEN_USE_OFFSCREEN_CLIENT is on. The proxy's own flag routing (flag-off →
 * byte-identical inline SW client; flag-on → offscreen dispatch) is proven in
 * `miden-client-proxy.test.ts`; these tests pin the DELEGATION seam - that the
 * non-guardian `generateTransaction` switch hands each leaf to the proxy with the
 * exact args the former inline block passed, and NEVER touches the inline
 * `getMidenClient(...)` leaf anymore.
 *
 * Routing:
 *   - earn-deposit and every bridged send →
 *     `midenClientProxy.newTransaction(accountId, requestBytes, delegate, signer)`, where `signer` is the write's
 *     effect-checked signer. An earn-deposit without its bytes, or without its one recorded note, is refused before
 *     it mints. A bridged send without its own request bytes, or without the one note those bytes recorded, is
 *     refused before the leaf.
 *
 * Funds-safety (analysed, not re-proven here - inherited from the shared proxy +
 * loop machinery): a wedge-kill → OperationAbortedError → the
 * `generateTransactionsLoop` catch → cancelTransaction → Failed with NO auto-requeue
 * (earn-deposit is excluded from REQUEUEABLE_TYPES; bridged-send is user-retry-only,
 * identical to the already-moved send/execute), and a round-tripped
 * `ApplyTransactionAfterSubmitFailed` reaches that same type-agnostic classifier.
 */

import { now } from 'lib/bridge/testing/fixtures';
import { ownedNativeBridgeRow } from 'lib/bridge/testing/operation-fixtures';
import { getMessage } from 'lib/i18n/core';
import type { GuardianAccountProvider } from 'lib/miden/front/guardian-manager';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

import { ProposalEffectRefusedError, ProposalFeeUnknownError } from './constants';
import {
  cancelTransactionAfterPipelineStopped,
  EPOCH_BRIDGE_ABANDONED_ERROR,
  generateTransaction,
  isUnconfirmedFailure
} from './index';
import { bridgeProviderOf, isRequeueableTransaction } from './retry';
import { BridgedSendTransaction, ITransaction, ITransactionStatus } from '../db/types';

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

jest.mock('lib/settings/constants', () => ({}));
jest.mock('lib/miden-chain/effective-endpoints', () => {
  const actual = jest.requireActual<typeof import('lib/miden-chain/effective-endpoints')>(
    'lib/miden-chain/effective-endpoints'
  );
  return {
    ...actual,
    getEffectiveNetworkName: jest.fn(actual.getEffectiveNetworkName),
    getEffectiveRpcUrl: jest.fn(actual.getEffectiveRpcUrl)
  };
});

const mockGetVerificationBaseFee = jest.fn(async (): Promise<number | null> => 0);
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual('lib/miden-chain/native-asset'),
  getVerificationBaseFee: () => mockGetVerificationBaseFee(),
  refreshVerificationBaseFee: () => mockGetVerificationBaseFee(),
  getVerificationBaseFeeSync: () => 0,
  isVerificationBaseFeeKnownAbsent: () => false
}));

// Non-guardian throughout: the standard signCallback dispatch path.
const mockIsGuardianAccount = jest.fn(async (..._a: unknown[]) => false);
jest.mock('lib/miden/front/guardian-manager', () => ({
  isGuardianAccount: (...a: unknown[]) => mockIsGuardianAccount(...a),
  getOrCreateMultisigService: jest.fn(),
  clearGuardianServiceFor: jest.fn()
}));

jest.mock('lib/miden/guardian', () => {
  const actual = jest.requireActual<typeof import('lib/miden/guardian')>('lib/miden/guardian');
  return {
    GUARDIAN_CANDIDATE_HOLD_MS: actual.GUARDIAN_CANDIDATE_HOLD_MS,
    PRIOR_CANDIDATE_CHECK_TIMEOUT_MS: actual.PRIOR_CANDIDATE_CHECK_TIMEOUT_MS,
    MultisigService: { buildColdMultisigService: jest.fn() }
  };
});

// The inline SW client leaf (`getMidenClient(...)`). After slice 7b nothing on the
// non-guardian bridged/earn path may touch it - assert its send/newTransaction spies
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
    WasmWebClient: { createClient: jest.fn() },
    SigningInputs: { deserialize: (...a: unknown[]) => mockDeserializeSigningInputs(...a) },
    SigningInputsType: { TransactionSummary: 0 }
  };
});
// What the write's signer is asked to sign, read as `SigningInputs.deserialize` would.
const mockDeserializeSigningInputs = jest.fn();

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
  // Stub ids are already the bech32 the summary decoder would spell.
  getBech32AddressFromAccountId: (id: unknown) => String(id),
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
  // clearAllMocks keeps a queued *Once, so a one-shot a test never reached would leak into the next.
  mockIsGuardianAccount.mockReset().mockImplementation(async () => false);
  mockProxyNewTransaction.mockReset().mockImplementation(async () => makeResult());
  mockGetVerificationBaseFee.mockReset().mockResolvedValue(0);
  txStore.length = 0;
  delete process.env.MIDEN_USE_OFFSCREEN_CLIENT;
});

const epochBridge = (id: string) =>
  buildTx(id, {
    type: 'bridged-send',
    requestBytes: new Uint8Array([0xb1, 0x1d]),
    secondaryAccountId: 'mtst1qallocator',
    faucetId: 'faucet',
    amount: 1000n,
    noteType: 'public',
    approvedOutputNoteIds: ['note:epoch'],
    extraInputs: { provider: 'epoch', recallBlocks: 10, claimStatus: 'not-applicable', epochStatus: 'pending' }
  });

describe('owned native bridge scope on the existing single-key pipeline', () => {
  const ownedProvider: GuardianAccountProvider = { ...provider, getAccounts: async () => [] };
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(now);
    jest.mocked(getEffectiveNetworkName).mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
    jest.mocked(getEffectiveRpcUrl).mockReturnValue('fixture-rpc');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    const actual = jest.requireActual<typeof import('lib/miden-chain/effective-endpoints')>(
      'lib/miden-chain/effective-endpoints'
    );
    jest.mocked(getEffectiveNetworkName).mockImplementation(actual.getEffectiveNetworkName);
    jest.mocked(getEffectiveRpcUrl).mockImplementation(actual.getEffectiveRpcUrl);
  });

  it('runs a valid recorded native source exactly once without adding a second outbound claim', async () => {
    const tx = ownedNativeBridgeRow();
    txStore.push({ ...tx });
    await generateTransaction(tx, signCallback, false, ownedProvider);
    expect(mockProxyNewTransaction).toHaveBeenCalledTimes(1);
    expect(mockProxyNewTransaction.mock.calls[0]?.slice(0, 3)).toEqual([tx.accountId, tx.requestBytes, false]);
    expect(tx.extraInputs.bridgeOperation?.sourceAttempt).toBeUndefined();
  });

  it('refuses a queued same-network RPC change before recovery authorization or source generation', async () => {
    const tx = ownedNativeBridgeRow();
    txStore.push({ ...tx });
    jest.mocked(getEffectiveRpcUrl).mockReturnValue('different-rpc');
    const prepareRecoveryTransaction = jest.fn(async () => ({ ready: true }));
    await generateTransaction(tx, signCallback, false, { ...ownedProvider, prepareRecoveryTransaction }).catch(
      () => undefined
    );
    expect(prepareRecoveryTransaction).not.toHaveBeenCalled();
    expect(mockProxyNewTransaction).not.toHaveBeenCalled();
    expect(tx.requestBytes).toEqual(new Uint8Array([81, 82, 83]));
  });

  it('rechecks scope after asynchronous service selection, before entering the source leaf', async () => {
    const tx = ownedNativeBridgeRow();
    txStore.push({ ...tx });
    mockIsGuardianAccount.mockImplementationOnce(async () => {
      jest.mocked(getEffectiveRpcUrl).mockReturnValue('different-rpc');
      return false;
    });
    await generateTransaction(tx, signCallback, false, ownedProvider).catch(() => undefined);
    expect(mockProxyNewTransaction).not.toHaveBeenCalled();
    expect(signCallback).not.toHaveBeenCalled();
  });

  it('the single-key post-proof gate stamps its original crossing before refusing a changed RPC', async () => {
    const tx = ownedNativeBridgeRow();
    txStore.push({ ...tx });
    const proved = jest.fn();
    const sourceSubmit = jest.fn();
    mockProxyNewTransaction.mockImplementation(async (...args: unknown[]) => {
      proved();
      jest.mocked(getEffectiveRpcUrl).mockReturnValue('changed-after-single-key-prove');
      const gate = args[5];
      if (typeof gate === 'function') {
        const allowed: unknown = await Reflect.apply(gate, undefined, []);
        if (allowed !== true) throw new Error('Native source gate refused');
      } else {
        const stamp = args[4];
        if (typeof stamp === 'function') await Reflect.apply(stamp, undefined, ['submitting']);
      }
      sourceSubmit();
      return makeResult();
    });
    await generateTransaction(tx, signCallback, false, ownedProvider).catch(() => undefined);
    expect(proved).toHaveBeenCalledTimes(1);
    expect(sourceSubmit).not.toHaveBeenCalled();
    expect(txStore[0]?.mayHaveSubmitted).toBe(true);
  });

  it.each([null, {}, { version: 2, owner: 'wallet' }])(
    'tagged malformed metadata is not legacy source permission case %#',
    async metadata => {
      const tx = ownedNativeBridgeRow();
      Reflect.set(tx.extraInputs, 'bridgeOperation', metadata);
      txStore.push({ ...tx });
      await generateTransaction(tx, signCallback, false, ownedProvider).catch(() => undefined);
      expect(mockProxyNewTransaction).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, { network: 'testnet', rpcUrl: '' }, { network: 'mainnet', rpcUrl: 'fixture-rpc' }])(
    'missing or mismatched native admission scope cannot fall through to a new source case %#',
    async scope => {
      const tx = ownedNativeBridgeRow();
      const operation = tx.extraInputs.bridgeOperation;
      if (!operation) throw new Error('Missing owned native fixture');
      Reflect.set(operation, 'walletScope', scope);
      txStore.push({ ...tx });
      await generateTransaction(tx, signCallback, false, ownedProvider).catch(() => undefined);
      expect(mockProxyNewTransaction).not.toHaveBeenCalled();
    }
  );

  it('a stored review cannot authorize another native amount or account', async () => {
    const tx = ownedNativeBridgeRow();
    tx.amount += 1n;
    tx.accountId = 'another-account';
    txStore.push({ ...tx });
    await generateTransaction(tx, signCallback, false, ownedProvider).catch(() => undefined);
    expect(mockProxyNewTransaction).not.toHaveBeenCalled();
  });

  it('same-scope canonical pre-submit-end evidence retains a safe native retry, not another durable claim', async () => {
    const tx = Object.assign(ownedNativeBridgeRow(), {
      mayHaveSubmitted: true,
      attemptId: 'safe-old-attempt',
      submitEvidence: [
        { attemptId: 'safe-old-attempt', capturedAt: now / 1000, source: 'stage', preSubmitEnd: true }
      ] satisfies import('../db/types').ISubmitEvidence[]
    });
    txStore.push({ ...tx });
    await generateTransaction(tx, signCallback, false, ownedProvider);
    expect(mockProxyNewTransaction).toHaveBeenCalledTimes(1);
    expect(tx.extraInputs.bridgeOperation?.sourceAttempt).toBeUndefined();
  });

  it('a previous uncertain crossing is retained rather than generating a second native source', async () => {
    const tx = Object.assign(ownedNativeBridgeRow(), {
      mayHaveSubmitted: true,
      attemptId: 'original-attempt',
      submitEvidence: [
        { attemptId: 'original-attempt', capturedAt: now / 1000, source: 'stage' }
      ] satisfies import('../db/types').ISubmitEvidence[]
    });
    txStore.push({ ...tx });
    await generateTransaction(tx, signCallback, false, ownedProvider).catch(() => undefined);
    expect(mockProxyNewTransaction).not.toHaveBeenCalled();
    expect(txStore[0]?.submitEvidence).toEqual(tx.submitEvidence);
    expect(txStore[0]?.attemptId).toBe('original-attempt');
  });
});

describe('reviewed compact Epoch source on the existing single-key pipeline', () => {
  const compactProvider: GuardianAccountProvider = { ...provider, getAccounts: async () => [] };
  function reviewedEpochRow() {
    const tx = new BridgedSendTransaction(
      'acc-1',
      1000n,
      '0x1111111111111111111111111111111111111111',
      11155111,
      'epoch',
      'faucet',
      new Uint8Array([0xb1, 0x1d]),
      false,
      { recipientId: 'mtst1qallocator', noteType: 'public', recallBlocks: 10, reclaimNoteId: 'note:epoch' }
    );
    tx.approvedOutputNoteIds = ['note:epoch'];
    tx.extraInputs.epochReviewedOutput = {
      minimumOutputBaseUnits: '250',
      outputTokenAddress: '0x2222222222222222222222222222222222222222',
      outputTokenDecimals: 6,
      validity: { kind: 'time', expiresAt: now + 60000 }
    };
    return tx;
  }
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(now));
  afterEach(() => jest.restoreAllMocks());

  it('still executes valid compact reviewed collateral through the native leaf', async () => {
    const tx = reviewedEpochRow();
    txStore.push({ ...tx });
    await generateTransaction(tx, signCallback, false, compactProvider);
    expect(mockProxyNewTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not start expired compact collateral', async () => {
    const tx = reviewedEpochRow();
    txStore.push({ ...tx });
    jest.spyOn(Date, 'now').mockReturnValue(now + 60000);
    await generateTransaction(tx, signCallback, false, compactProvider).catch(() => undefined);
    expect(mockProxyNewTransaction).not.toHaveBeenCalled();
  });

  it('refuses expired compact collateral after proof at the actual awaited submit gate', async () => {
    const tx = reviewedEpochRow();
    txStore.push({ ...tx });
    const sourceSubmit = jest.fn();
    mockProxyNewTransaction.mockImplementationOnce(async (...args: unknown[]) => {
      jest.spyOn(Date, 'now').mockReturnValue(now + 60000);
      const gate = args[5];
      if (typeof gate === 'function') {
        const allowed: unknown = await Reflect.apply(gate, undefined, []);
        if (allowed !== true) throw new Error('Native source gate refused');
      }
      sourceSubmit();
      return makeResult();
    });
    await generateTransaction(tx, signCallback, false, compactProvider).catch(() => undefined);
    expect(mockProxyNewTransaction).toHaveBeenCalledTimes(1);
    expect(sourceSubmit).not.toHaveBeenCalled();
    expect(txStore[0]?.mayHaveSubmitted).toBe(true);
  });
});

// markBridgedSendFailed's write, landing after the loop picked the row up and before its leaf runs.
const abandonAfterPickup = (id: string) =>
  mockIsGuardianAccount.mockImplementationOnce(async () => {
    const row = txStore.find(r => r.id === id)!;
    row.status = ITransactionStatus.Failed;
    row.extraInputs = { ...(row.extraInputs as Record<string, unknown>), claimStatus: 'failed', epochStatus: 'failed' };
    return false;
  });

afterEach(() => {
  delete process.env.MIDEN_USE_OFFSCREEN_CLIENT;
});

describe('non-guardian bridged-send / earn-deposit leaf → proxy delegation (slice 7b)', () => {
  it('Epoch bridged-send with no request bytes is refused before any leaf', async () => {
    await expect(
      run('tx-bs-epoch', {
        type: 'bridged-send',
        secondaryAccountId: 'mtst1qallocator',
        faucetId: 'faucet',
        amount: 1000n,
        noteType: 'public',
        extraInputs: { provider: 'epoch', recallBlocks: 10 }
      })
    ).rejects.toThrow('the transaction has no request bytes of its own');

    expect(mockProxySendTransaction).not.toHaveBeenCalled();
    expect(mockProxyNewTransaction).not.toHaveBeenCalled();
    expect(mockGetMidenClient).not.toHaveBeenCalled();
    expect(mockInlineSendTransaction).not.toHaveBeenCalled();
    expect(mockComplete.bridged).not.toHaveBeenCalled();
  });

  it.each(['agglayer', 'usdcx'])(
    '%s pre-built bridged-send delegates the exact request bytes to the proxy with a guarded signer',
    async provider => {
      const requestBytes = new Uint8Array([0xa9, 0x1a]);
      const tx = await run('tx-bs-agg', {
        type: 'bridged-send',
        requestBytes,
        faucetId: 'faucet',
        amount: 2000n,
        delegateTransaction: true,
        approvedOutputNoteIds: ['note:bridge'],
        extraInputs: { provider }
      });

      expect(mockProxyNewTransaction).toHaveBeenCalledTimes(1);
      // Both bridges await the node's verdict, so both carry a stage stamp (#1081).
      const [account, bytes, delegate, callback, stamp] = mockProxyNewTransaction.mock.calls[0] ?? [];
      expect([account, bytes, delegate]).toEqual(['acc-1', requestBytes, true]);
      expect(typeof callback).toBe('function');
      expect(callback).not.toBe(signCallback);
      expect(typeof stamp).toBe('function');
      expect(mockProxySendTransaction).not.toHaveBeenCalled();
      expect(mockGetMidenClient).not.toHaveBeenCalled();
      expect(mockInlineNewTransaction).not.toHaveBeenCalled();
      expect(mockComplete.bridged).toHaveBeenCalledTimes(1);
      void tx;
    }
  );

  it('earn-deposit delegates its collateral request with a guarded signer', async () => {
    const requestBytes = new Uint8Array([0xea, 0x51]);
    await run('tx-earn', {
      type: 'earn-deposit',
      requestBytes,
      secondaryAccountId: 'mtst1qallocator',
      faucetId: 'faucet',
      amount: 500n,
      noteType: 'public',
      approvedOutputNoteIds: ['note:recorded'],
      extraInputs: { recallBlocks: 10, epochStatus: 'pending' }
    });

    expect(mockProxyNewTransaction).toHaveBeenCalledTimes(1);
    expect(mockProxyNewTransaction).toHaveBeenCalledWith('acc-1', requestBytes, false, expect.any(Function), undefined);
    expect(mockProxyNewTransaction.mock.calls[0]?.[3]).not.toBe(signCallback);
    expect(mockProxySendTransaction).not.toHaveBeenCalled();
    expect(mockGetMidenClient).not.toHaveBeenCalled();
    expect(mockInlineNewTransaction).not.toHaveBeenCalled();
    // Finalized via the earn-deposit completion (NOT the generic custom-tx path).
    expect(mockComplete.earn).toHaveBeenCalledTimes(1);
    expect(mockComplete.bridged).not.toHaveBeenCalled();
  });

  // Regression: only the GUARDIAN leaf refused an abandoned earn deposit. The
  // non-Guardian leaf shares a `case 'bridged-send': case 'earn-deposit':` block
  // and had no such check, so after `openEarnPosition` gave up (its 5-min wait
  // timed out → `updateEarnDepositStatus(..., 'failed')`, which patches
  // extraInputs ONLY and leaves the row Queued) the FIFO loop still submitted the
  // P2IDE collateral note - stranding the funds until the reclaim height while the
  // activity row read "Deposited to lending".
  it('earn-deposit refuses to submit once the caller abandoned the Epoch intent', async () => {
    mockGetVerificationBaseFee.mockResolvedValue(null);
    const tx = buildTx('tx-earn-abandoned', {
      type: 'earn-deposit',
      secondaryAccountId: 'mtst1qallocator',
      faucetId: 'faucet',
      amount: 500n,
      noteType: 'public',
      // The in-memory copy is the one the loop picked up minutes ago …
      extraInputs: { recallBlocks: 10, epochStatus: 'pending' }
    });
    // … while the row in the DB has since been marked abandoned.
    txStore.push({ ...tx, extraInputs: { recallBlocks: 10, epochStatus: 'failed' } });

    await expect(generateTransaction(tx as never, signCallback, false, provider as never)).rejects.toThrow(
      /refusing to submit an orphan collateral note/
    );

    // No collateral note was built, submitted, or marked deposited.
    expect(mockProxySendTransaction).not.toHaveBeenCalled();
    expect(mockProxyNewTransaction).not.toHaveBeenCalled();
    expect(mockComplete.earn).not.toHaveBeenCalled();
    expect(mockGetVerificationBaseFee).not.toHaveBeenCalled();
    expect(txStore[0]).toBeDefined();
    expect(txStore[0]?.nextEligibleAt).toBeUndefined();
  });

  it.each<[string, number | null]>([
    ['known', 0],
    ['unknown', null]
  ])('refuses an Earn deposit abandoned during %s fee discovery', async (_state, fee) => {
    const id = 'tx-earn-fee-abandoned';
    mockGetVerificationBaseFee.mockImplementationOnce(async () => {
      const persisted = txStore.find(row => row.id === id)!;
      persisted.extraInputs = { recallBlocks: 10, epochStatus: 'failed' };
      return fee;
    });

    await expect(
      run(id, {
        type: 'earn-deposit',
        requestBytes: new Uint8Array([0xea, 0x51]),
        secondaryAccountId: 'mtst1qallocator',
        faucetId: 'faucet',
        amount: 500n,
        noteType: 'public',
        approvedOutputNoteIds: ['note:recorded'],
        extraInputs: { recallBlocks: 10, epochStatus: 'pending' }
      })
    ).rejects.toThrow(/refusing to submit an orphan collateral note/);

    expect(mockGetVerificationBaseFee).toHaveBeenCalledTimes(1);
    expect(mockProxyNewTransaction).not.toHaveBeenCalled();
    expect(mockProxySendTransaction).not.toHaveBeenCalled();
    expect(signCallback).not.toHaveBeenCalled();
    expect(mockComplete.earn).not.toHaveBeenCalled();
    expect(txStore.find(row => row.id === id)?.nextEligibleAt).toBeUndefined();
  });

  it('requeues a live Earn deposit with request bytes when its fee is unknown', async () => {
    mockGetVerificationBaseFee.mockResolvedValue(null);
    const tx = await run('tx-earn-fee-unknown', {
      type: 'earn-deposit',
      requestBytes: new Uint8Array([0xea, 0x51]),
      secondaryAccountId: 'mtst1qallocator',
      faucetId: 'faucet',
      amount: 500n,
      noteType: 'public',
      approvedOutputNoteIds: ['note:recorded'],
      extraInputs: { recallBlocks: 10, epochStatus: 'pending' }
    });

    const persisted = txStore.find(row => row.id === tx.id);
    expect(persisted?.nextEligibleAt).toEqual(expect.any(Number));
    expect(persisted?.requeueStreak).toEqual({ arm: 'chain-fee-unknown', count: 1 });
    expect(mockProxyNewTransaction).not.toHaveBeenCalled();
    expect(mockProxySendTransaction).not.toHaveBeenCalled();
    expect(signCallback).not.toHaveBeenCalled();
    expect(mockComplete.earn).not.toHaveBeenCalled();
  });

  it('an Epoch bridged-send abandoned before its submit claim never reaches newTransaction (#1250)', async () => {
    const tx = epochBridge('tx-bs-epoch-abandoned');
    txStore.push({ ...tx });
    abandonAfterPickup(tx.id);

    await expect(generateTransaction(tx as never, signCallback, false, provider as never)).rejects.toThrow(
      EPOCH_BRIDGE_ABANDONED_ERROR
    );

    expect(mockProxyNewTransaction).not.toHaveBeenCalled();
    expect(mockProxySendTransaction).not.toHaveBeenCalled();
    expect(mockComplete.bridged).not.toHaveBeenCalled();
    const row = txStore.find(r => r.id === tx.id)!;
    expect((row.extraInputs as Record<string, unknown>).submitClaimed).toBeUndefined();
  });

  it('an Epoch bridged-send claims its submit before newTransaction (#1250)', async () => {
    const tx = epochBridge('tx-bs-epoch-claim');
    txStore.push({ ...tx });
    let claimedAtSubmit: unknown;
    mockProxyNewTransaction.mockImplementationOnce(async () => {
      const row = txStore.find(r => r.id === tx.id)!;
      claimedAtSubmit = (row.extraInputs as Record<string, unknown>).submitClaimed;
      return makeResult();
    });

    await generateTransaction(tx as never, signCallback, false, provider as never);

    expect(mockProxyNewTransaction).toHaveBeenCalledTimes(1);
    expect(claimedAtSubmit).toBe(true);
    expect(mockComplete.bridged).toHaveBeenCalledTimes(1);
  });

  it('a definite execute failure after the claim stays a confirmed failure (#1250)', async () => {
    const tx = epochBridge('tx-bs-epoch-execute-failed');
    txStore.push({ ...tx });
    const executeError = new Error('failed to execute transaction: transaction execution failed: assertion failed');
    mockProxyNewTransaction.mockRejectedValueOnce(executeError);

    await expect(generateTransaction(tx as never, signCallback, false, provider as never)).rejects.toThrow(
      executeError.message
    );
    // The loop's catch, failing the row its stopped pipeline left in flight.
    await cancelTransactionAfterPipelineStopped(txStore.find(r => r.id === tx.id)! as never, executeError);

    const row = txStore.find(r => r.id === tx.id)!;
    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(row.mayHaveSubmitted).not.toBe(true);
    expect(isUnconfirmedFailure(row as never)).toBe(false);
  });

  it('earn-deposit with no request bytes is refused before it mints: no send-style fallback for Earn', async () => {
    mockGetVerificationBaseFee.mockResolvedValue(null);
    // The fallback would mint a P2IDE with no mandate binding, which the allocator refuses to bind.
    const tx = buildTx('tx-earn-no-bytes', {
      type: 'earn-deposit',
      requestBytes: undefined,
      secondaryAccountId: 'mtst1qallocator',
      faucetId: 'faucet',
      amount: 500n,
      noteType: 'public',
      extraInputs: { recallBlocks: 10, epochStatus: 'pending' }
    });
    txStore.push({ ...tx });

    await expect(generateTransaction(tx as never, signCallback, false, provider as never)).rejects.toThrow(
      'Earn deposit has no collateral request with its mandate binding, so it was not sent.'
    );

    expect(mockProxySendTransaction).not.toHaveBeenCalled();
    expect(mockProxyNewTransaction).not.toHaveBeenCalled();
    expect(mockComplete.earn).not.toHaveBeenCalled();
    expect(mockGetVerificationBaseFee).not.toHaveBeenCalled();
    expect(txStore[0]).toBeDefined();
    expect(txStore[0]?.nextEligibleAt).toBeUndefined();
  });

  it('flag ON keeps Earn delegation on the proxy with a guarded signer', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    const requestBytes = new Uint8Array([0xea, 0x52]);
    await run('tx-earn-flagon', {
      type: 'earn-deposit',
      requestBytes,
      secondaryAccountId: 'mtst1qallocator',
      faucetId: 'faucet',
      amount: 500n,
      noteType: 'public',
      approvedOutputNoteIds: ['note:recorded'],
      extraInputs: { recallBlocks: 10, epochStatus: 'pending' }
    });

    expect(mockProxyNewTransaction).toHaveBeenCalledWith('acc-1', requestBytes, false, expect.any(Function), undefined);
    expect(mockProxyNewTransaction.mock.calls[0]?.[3]).not.toBe(signCallback);
    // The proxy is the ONLY leaf - the switch never forks on the flag itself.
    expect(mockGetMidenClient).not.toHaveBeenCalled();
  });
});

// The SDK asks the write's signer for its signature while it executes, before it proves or submits; a refused sign
// fails the execute.
const mockSubmit = jest.fn();
const signsThenSubmits = async (...a: unknown[]) => {
  const signer = a[3] as (publicKey: string, signingInputs: string) => Promise<Uint8Array>;
  try {
    await signer('0a', 'aa');
  } catch (error) {
    throw new Error(`failed to execute transaction: ${error instanceof Error ? error.message : String(error)}`);
  }
  mockSubmit();
  return makeResult();
};

type Asset = { faucetId: () => string; amount: () => bigint };
const fa = (faucet: string, amount: bigint): Asset => ({ faucetId: () => faucet, amount: () => amount });
/** The signing inputs of a summary in which `acc-1` sends `amount` of `faucet` out in one note. */
const sendsOut = (amount: bigint) => ({
  variantType: 0,
  transactionSummaryPayload: () => ({
    accountDelta: () => ({
      id: () => 'acc-1',
      vault: () => ({
        removedFungibleAssets: () => [fa('faucet', amount)],
        addedFungibleAssets: () => [],
        numAssets: () => 1
      }),
      storage: () => ({ isEmpty: () => true })
    }),
    inputNotes: () => ({ numNotes: () => 0, notes: () => [] }),
    outputNotes: () => ({
      numNotes: () => 1,
      notes: () => [
        {
          id: () => ({ toString: () => `note:${amount}` }),
          assets: () => ({ fungibleAssets: () => [fa('faucet', amount)], nonFungibleAssets: () => [] })
        }
      ]
    })
  })
});

// Each provider's row, reviewed to bridge 1000 of `faucet`, with the pre-built request every current row carries and
// the one note its build recorded: the note `sendsOut(1000n)` creates.
const builtNote = { approvedOutputNoteIds: ['note:1000'] };
const bridgeRows: Array<[string, Record<string, unknown>]> = [
  [
    'agglayer',
    {
      requestBytes: new Uint8Array([0xa9]),
      extraInputs: { provider: 'agglayer', claimStatus: 'pending' },
      ...builtNote
    }
  ],
  [
    'usdcx',
    {
      requestBytes: new Uint8Array([0xb5]),
      noteType: 'public',
      extraInputs: { provider: 'usdcx', usdcxBurn: { noteId: 'burn-note', destinationDomain: 0, phase: 'pending' } },
      ...builtNote
    }
  ],
  [
    'epoch',
    {
      requestBytes: new Uint8Array([0xb1, 0x1d]),
      secondaryAccountId: 'mtst1qallocator',
      noteType: 'public',
      extraInputs: { provider: 'epoch', recallBlocks: 10, claimStatus: 'not-applicable', epochStatus: 'pending' },
      ...builtNote
    }
  ]
];

describe.each([
  ['inline', undefined],
  ['offscreen', 'true']
])('a single-key bridged send signs no more than its reviewed amount (%s)', (_realm, flag) => {
  beforeEach(() => {
    if (flag === undefined) delete process.env.MIDEN_USE_OFFSCREEN_CLIENT;
    else process.env.MIDEN_USE_OFFSCREEN_CLIENT = flag;
    mockProxyNewTransaction.mockImplementation(signsThenSubmits);
  });

  /** Run the row to the end the loop gives it: completed, or failed through the loop's own catch. */
  const settle = async (id: string, fields: Record<string, unknown>) => {
    const tx = buildTx(id, { type: 'bridged-send', faucetId: 'faucet', amount: 1000n, ...fields });
    txStore.push({ ...tx });
    let failure: unknown;
    try {
      await generateTransaction(tx as never, signCallback, false, provider as never);
    } catch (error) {
      failure = error;
      await cancelTransactionAfterPipelineStopped(txStore.find(r => r.id === id)! as never, error);
    }
    return { failure, row: txStore.find(r => r.id === id) as unknown as ITransaction };
  };

  it.each(bridgeRows)('refuses a %s bridged send moving one unit more, before it submits', async (provider, fields) => {
    mockDeserializeSigningInputs.mockReturnValue(sendsOut(1001n));

    const { failure, row } = await settle(`bs-over-${provider}`, fields);

    expect(failure).toBeInstanceOf(ProposalEffectRefusedError);
    // A note carrying another amount is another note, so it is not the one the row was built with either.
    expect(failure instanceof Error ? failure.message : undefined).toBe(
      'Refused to sign this bridged-send transaction: 1001 of faucet leaves (approved 1000); ' +
        'creates a note that was not approved (note:1001)'
    );
    expect(mockProxyNewTransaction).toHaveBeenCalledTimes(1);
    expect(signCallback).not.toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockComplete.bridged).not.toHaveBeenCalled();
    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(row.proposalEffectRefused).toBe(true);
  });

  it.each(bridgeRows)(
    'refuses a %s bridged send whose summary creates another note than the one it was built with, before it submits',
    async (provider, fields) => {
      mockDeserializeSigningInputs.mockReturnValue(sendsOut(1000n));

      const { failure, row } = await settle(`bs-other-note-${provider}`, {
        ...fields,
        approvedOutputNoteIds: ['note:built']
      });

      expect(failure).toBeInstanceOf(ProposalEffectRefusedError);
      expect(failure instanceof Error ? failure.message : undefined).toBe(
        'Refused to sign this bridged-send transaction: creates a note that was not approved (note:1000)'
      );
      expect(signCallback).not.toHaveBeenCalled();
      expect(mockSubmit).not.toHaveBeenCalled();
      expect(mockComplete.bridged).not.toHaveBeenCalled();
      expect(row.status).toBe(ITransactionStatus.Failed);
      expect(row.proposalEffectRefused).toBe(true);
    }
  );

  it.each(bridgeRows)('signs and submits a %s bridged send moving its reviewed amount', async (provider, fields) => {
    mockDeserializeSigningInputs.mockReturnValue(sendsOut(1000n));

    const { failure } = await settle(`bs-exact-${provider}`, fields);

    expect(failure).toBeUndefined();
    expect(signCallback).toHaveBeenCalledTimes(1);
    expect(signCallback).toHaveBeenCalledWith('0a', 'aa');
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockComplete.bridged).toHaveBeenCalledTimes(1);
  });

  // A row queued before its build recorded a note: it fails unsigned, and Retry would be refused the same way.
  it('fails a legacy bridged send that recorded no note of its own, unsigned and unsent, without offering Retry', async () => {
    mockDeserializeSigningInputs.mockReturnValue(sendsOut(1000n));

    const { failure, row } = await settle('bs-legacy', {
      requestBytes: new Uint8Array([0xa9]),
      extraInputs: { provider: 'agglayer', claimStatus: 'pending' }
    });

    expect(failure).toBeInstanceOf(ProposalEffectRefusedError);
    expect(failure instanceof Error ? failure.message : undefined).toBe(
      'Refused to sign this bridged-send transaction: the transaction has no recorded note of its own'
    );
    expect(mockProxyNewTransaction).not.toHaveBeenCalled();
    expect(signCallback).not.toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockComplete.bridged).not.toHaveBeenCalled();
    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(row.proposalEffectRefused).toBe(true);
    expect(isRequeueableTransaction({ ...row, bridgeProvider: bridgeProviderOf(row) })).toBe(false);
  });

  // Checked before the chain fee is read, so an unknown fee cannot turn the refusal into a failure that offers Retry.
  it('refuses a legacy bridged send before it reads the chain fee, even while that fee is unknown', async () => {
    mockGetVerificationBaseFee.mockResolvedValue(null);

    const { failure, row } = await settle('bs-legacy-fee', {
      requestBytes: new Uint8Array([0xa9]),
      extraInputs: { provider: 'agglayer', claimStatus: 'pending' }
    });

    expect(failure).toBeInstanceOf(ProposalEffectRefusedError);
    expect(mockGetVerificationBaseFee).not.toHaveBeenCalled();
    expect(mockProxyNewTransaction).not.toHaveBeenCalled();
    expect(row.proposalEffectRefused).toBe(true);
    expect(isRequeueableTransaction({ ...row, bridgeProvider: bridgeProviderOf(row) })).toBe(false);
  });

  // Missing ids, an empty record, and two ids are the same refusal: the row has no one note of its own.
  it.each<[string, Record<string, unknown>]>([
    ['missing ids', {}],
    ['[]', { approvedOutputNoteIds: [] }],
    ['two ids', { approvedOutputNoteIds: ['note:one', 'note:two'] }]
  ])(
    'fails a legacy Earn deposit that recorded no note of its own (%s), unsigned and unsent, without offering Retry',
    async (shape, noteFields) => {
      const { failure, row } = await settle(`earn-legacy-${shape}`, {
        type: 'earn-deposit',
        requestBytes: new Uint8Array([0xea, 0x51]),
        secondaryAccountId: 'mtst1qallocator',
        noteType: 'public',
        extraInputs: { recallBlocks: 10, epochStatus: 'pending' },
        ...noteFields
      });

      expect(failure).toBeInstanceOf(ProposalEffectRefusedError);
      expect(failure instanceof Error ? failure.message : undefined).toBe(
        'Refused to sign this earn-deposit transaction: the transaction has no recorded note of its own'
      );
      expect(mockProxyNewTransaction).not.toHaveBeenCalled();
      expect(row.proposalEffectRefused).toBe(true);
      expect(isRequeueableTransaction({ ...row, bridgeProvider: bridgeProviderOf(row) })).toBe(false);
    }
  );

  // Checked before the chain fee is read, so an unknown fee cannot turn the refusal into a requeue.
  it('refuses a legacy Earn deposit with no recorded note before it reads the chain fee, even while that fee is unknown', async () => {
    mockGetVerificationBaseFee.mockResolvedValue(null);

    const { failure, row } = await settle('earn-legacy-fee', {
      type: 'earn-deposit',
      requestBytes: new Uint8Array([0xea, 0x51]),
      secondaryAccountId: 'mtst1qallocator',
      noteType: 'public',
      extraInputs: { recallBlocks: 10, epochStatus: 'pending' }
    });

    expect(failure).toBeInstanceOf(ProposalEffectRefusedError);
    expect(failure instanceof Error ? failure.message : undefined).toBe(
      'Refused to sign this earn-deposit transaction: the transaction has no recorded note of its own'
    );
    expect(mockGetVerificationBaseFee).not.toHaveBeenCalled();
    expect(mockProxyNewTransaction).not.toHaveBeenCalled();
    expect(row.proposalEffectRefused).toBe(true);
    expect(isRequeueableTransaction({ ...row, bridgeProvider: bridgeProviderOf(row) })).toBe(false);
  });

  // Not requeued, unlike an Earn deposit: the row fails, unsigned and unsent, and the user retries it, an Epoch bridge
  // from the bridge flow, since its intent is gone.
  it.each<[string, Record<string, unknown>, boolean]>(bridgeRows.map(([p, f]) => [p, f, p !== 'epoch']))(
    'fails a %s bridged send while the chain fee is unknown, unsigned and unsent',
    async (provider, fields, retryOffered) => {
      mockGetVerificationBaseFee.mockResolvedValue(null);

      const { failure, row } = await settle(`bs-fee-${provider}`, fields);

      expect(failure).toBeInstanceOf(ProposalFeeUnknownError);
      expect(mockProxyNewTransaction).not.toHaveBeenCalled();
      expect(mockProxySendTransaction).not.toHaveBeenCalled();
      expect(signCallback).not.toHaveBeenCalled();
      expect(row.status).toBe(ITransactionStatus.Failed);
      expect(row.error).toBe(getMessage('chainFeeUnknown'));
      expect(row.nextEligibleAt).toBeUndefined();
      expect(row.proposalEffectRefused).toBeUndefined();
      expect(isRequeueableTransaction({ ...row, bridgeProvider: bridgeProviderOf(row) })).toBe(retryOffered);
    }
  );
});

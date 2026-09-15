import type { ExecuteActionOptions } from '@epoch-protocol/epoch-intents-sdk';

import type { initiateEarnWithdrawTransaction, updateEarnWithdrawPhase } from 'lib/miden/activity';
import type { PendingBridgeInIntent } from 'lib/miden/activity/bridge-in';
import {
  EarnWithdrawTransaction,
  ITransactionStatus,
  type IBridgeInInfo,
  type ITransaction,
  type IEarnWithdrawExtraInputs
} from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { clearEarnSubmissionLocksForTests, createEarnSubmissionLocks } from './earn-submission-lock';
import {
  gaslessEarnWithdrawalToMiden,
  pollEarnWithdrawDelivery,
  reconcileEarnWithdrawals,
  resubmitEarnWithdrawal,
  resumeEarnWithdrawal
} from './earn-withdraw';
import {
  earnWithdrawalRetryKind,
  earnWithdrawExecutionIdentity,
  selectEarnWithdrawPreparedExecution
} from './earn-withdraw-policy';
import { matchesEarnWithdrawIntent } from './intent-key';
import { clearPollRegistryForTests, createIntentPollCoordinator } from './poll-registry';
import { deferred, SharedEarnLocks } from './testing/earn-locks';
import { preparedExecution, PREPARED_FAUCET, PREPARED_RECIPIENT } from './testing/earn-prepared';

jest.mock('@epoch-protocol/epoch-intents-sdk', () => ({
  ...jest.requireActual('@epoch-protocol/epoch-intents-sdk'),
  EpochIntentSDK: class {},
  TaskType: { ProtocolInteraction: 'ProtocolInteraction' },
  ActionType: { Withdraw: 'Withdraw' },
  EVM_ZERO_ADDRESS: '0x0000000000000000000000000000000000000000'
}));
jest.mock('@miden-sdk/miden-sdk', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk'),
  AccountId: {
    fromHex: (value: string) => {
      if (!/^0x[0-9a-f]{28,32}$/.test(value)) throw new Error('invalid account');
      return { toString: () => value };
    }
  }
}));
jest.mock('./bridge', () => ({ normalizeMidenIdToHex: (v: string) => v }));
jest.mock('./bridgeable-token', () => ({ BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS: 6 }));
jest.mock('./config', () => ({ EPOCH_ALLOCATOR_URL: 'http://alloc', MIDEN_DESTINATION_CHAIN_ID: 999999999 }));
interface MockLeg {
  chainId?: number;
  status?: string;
  transactionHash?: string;
}
jest.mock('./earn', () => {
  const DONE = new Set(['completed']);
  const FAILED = new Set(['failed']);
  return {
    EARN_PROTOCOL_HASH: '0xhash',
    EARN_UNDERLYING: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
    EARN_DONE_STATUSES: DONE,
    EARN_FAILED_STATUSES: FAILED,
    // Mirrors the real destination-gated helper, which is unit-tested in earn.test.ts.
    resolveEarnIntentOutcome: (results: MockLeg[], destinationChainId: number) => {
      const destination = results.find(entry => entry.chainId === destinationChainId);
      const source = results.find(entry => entry.chainId !== destinationChainId);
      const status = (destination?.status ?? '').toLowerCase();
      if (DONE.has(status)) return { outcome: 'done', destination, source };
      if (FAILED.has(status)) return { outcome: 'failed', destination, source };
      if (results.some(entry => FAILED.has((entry.status ?? '').toLowerCase()))) {
        return { outcome: 'failed', destination, source };
      }
      return { outcome: 'pending', destination, source };
    }
  };
});
jest.mock('./evm-account', () => ({ buildVaultEvmWalletClient: jest.fn(() => ({})) }));
jest.mock('./sdk', () => ({ getEpochReadOnlySdk: jest.fn(), ensureEpochSmartAccount: jest.fn() }));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: jest.fn().mockResolvedValue('0xabcdef1234567890abcdef12345678')
}));
jest.mock('lib/miden/activity', () => ({
  initiateEarnWithdrawTransaction: jest.fn(),
  registerPendingBridgeIn: jest.fn(),
  resolveBridgeInNoteId: jest.fn(),
  updateEarnWithdrawPhase: jest.fn(),
  get prepareEarnWithdrawExecution() {
    return jest.requireActual<typeof import('lib/miden/transaction/complete')>('lib/miden/transaction/complete')
      .prepareEarnWithdrawExecution;
  },
  get markEarnWithdrawNotSent() {
    return jest.requireActual<typeof import('lib/miden/transaction/complete')>('lib/miden/transaction/complete')
      .markEarnWithdrawNotSent;
  },
  get markEarnWithdrawAccepted() {
    return jest.requireActual<typeof import('lib/miden/transaction/complete')>('lib/miden/transaction/complete')
      .markEarnWithdrawAccepted;
  },
  findPendingBridgeInByEarnWithdrawTxId: jest.fn()
}));
jest.mock('lib/miden/repo', () => ({ transactions: { where: jest.fn(), filter: jest.fn() } }));

const EVM_OWNER = '0x1111111111111111111111111111111111111111';
const UNDERLYING = '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';
const MARKET_UID = `DUMMY_LENDING:11155111:${UNDERLYING}`;

const validArgs = () => ({
  midenAccountPublicKey: PREPARED_RECIPIENT,
  evmAddress: EVM_OWNER,
  marketUid: MARKET_UID,
  underlyingAddress: UNDERLYING,
  amount: '10',
  underlyingDecimals: 6
});

function fakeSdk(executeActions: jest.Mock) {
  return {
    getWalletGaslessStatus: jest.fn().mockResolvedValue({ is7702Capable: true, needsSetup: false }),
    convertToSmartAccount: jest.fn().mockResolvedValue({ ok: true }),
    helpers: {
      executeActions: async (options: ExecuteActionOptions) => {
        await options.onBeforeExecute?.(preparedExecution());
        return executeActions(options);
      }
    }
  };
}

function wireWithdrawal(row: ITransaction | undefined) {
  const modify = jest.fn(async (mutate: (tx: ITransaction) => void) => {
    if (!row) return 0;
    mutate(row);
    return 1;
  });
  jest.mocked(Repo.transactions.where).mockImplementation(
    jest.fn().mockReturnValue({
      first: jest.fn(async () => (row ? { ...row, extraInputs: { ...row.extraInputs } } : undefined)),
      modify
    })
  );
  return modify;
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  const writers = jest.requireActual<typeof import('lib/miden/transaction/complete')>('lib/miden/transaction/complete');
  return {
    ensureSmartAccount: jest.fn().mockResolvedValue(undefined),
    registerBridgeIn: jest.fn().mockResolvedValue(undefined),
    initiateRow: jest.fn(async (...args: ConstructorParameters<typeof EarnWithdrawTransaction>) => {
      const row = new EarnWithdrawTransaction(...args);
      row.id = 'TX1';
      wireWithdrawal(row);
      return row.id;
    }),
    prepareExecution: jest.fn(writers.prepareEarnWithdrawExecution),
    markNotSent: jest.fn(writers.markEarnWithdrawNotSent),
    markAccepted: jest.fn(writers.markEarnWithdrawAccepted),
    updatePhase: jest.fn().mockResolvedValue(undefined),
    startDeliveryPoll: jest.fn(),
    findBridgeIn: jest.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe('gaslessEarnWithdrawalToMiden', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a redeeming row, submits the intent, and returns its txId + nonce', async () => {
    const executeActions = jest.fn().mockResolvedValue({ nonce: 'NONCE1' });
    const deps = baseDeps({ sdk: fakeSdk(executeActions) });

    const result = await gaslessEarnWithdrawalToMiden(validArgs(), deps);

    expect(result).toEqual({ txId: 'TX1', nonce: '22', gaslessUsed: true });
    // Row created up front with the parsed atomic amount + destination faucet.
    expect(deps.initiateRow).toHaveBeenCalledWith(
      PREPARED_RECIPIENT,
      10_000_000n,
      EVM_OWNER,
      MARKET_UID,
      PREPARED_FAUCET,
      '10',
      'USDC',
      expect.any(String),
      expect.any(Number)
    );
    const row = await Repo.transactions.where({ id: 'TX1' }).first();
    expect(row?.extraInputs).toMatchObject({
      submissionState: 'accepted',
      withdrawIntentNonce: '22',
      preparedExecution: { allocations: preparedExecution().allocations, delivery: { allocationIndex: 1, nonce: '22' } }
    });
    expect(deps.prepareExecution.mock.invocationCallOrder[0]!).toBeLessThan(
      executeActions.mock.invocationCallOrder[0]!
    );
    expect(deps.updatePhase).not.toHaveBeenCalled();
    expect(deps.startDeliveryPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        txId: 'TX1',
        nonce: '22',
        bridgeInfo: expect.objectContaining({ provider: 'epoch', earnWithdrawTxId: 'TX1', intentNonce: '22' })
      })
    );
  });

  it('rejects validation failures before creating any row', async () => {
    const deps = baseDeps({ sdk: fakeSdk(jest.fn()) });

    await expect(
      gaslessEarnWithdrawalToMiden({ ...validArgs(), evmAddress: 'not-an-address' }, deps)
    ).rejects.toThrow();
    expect(deps.initiateRow).not.toHaveBeenCalled();
  });

  it('fires onRowCreated with the row id before the intent work', async () => {
    const executeActions = jest.fn().mockResolvedValue({ nonce: 'NONCE1' });
    const onRowCreated = jest.fn();
    const deps = baseDeps({ sdk: fakeSdk(executeActions) });

    await gaslessEarnWithdrawalToMiden({ ...validArgs(), onRowCreated }, deps);

    expect(onRowCreated).toHaveBeenCalledWith('TX1');
    // The handoff happens before the smart-account/intent work runs.
    expect(onRowCreated.mock.invocationCallOrder[0]!).toBeLessThan(executeActions.mock.invocationCallOrder[0]!);
  });

  it('still fires onRowCreated when the intent submission later throws', async () => {
    const executeActions = jest.fn().mockRejectedValue(new Error('solve boom'));
    const onRowCreated = jest.fn();
    const deps = baseDeps({ sdk: fakeSdk(executeActions) });

    await expect(gaslessEarnWithdrawalToMiden({ ...validArgs(), onRowCreated }, deps)).rejects.toThrow('solve boom');
    expect(onRowCreated).toHaveBeenCalledWith('TX1');
  });

  it('keeps the saved execution protected and polling when submission throws after permission', async () => {
    const executeActions = jest.fn().mockRejectedValue(new Error('solve boom'));
    const deps = baseDeps({ sdk: fakeSdk(executeActions) });

    await expect(gaslessEarnWithdrawalToMiden(validArgs(), deps)).rejects.toThrow('solve boom');
    expect(deps.initiateRow).toHaveBeenCalled();
    const row = await Repo.transactions.where({ id: 'TX1' }).first();
    expect(row?.extraInputs).toMatchObject({
      phase: 'redeeming',
      submissionState: 'prepared',
      withdrawIntentNonce: '22'
    });
    expect(earnWithdrawalRetryKind(row)).toBeUndefined();
    expect(deps.markNotSent).not.toHaveBeenCalled();
    expect(deps.startDeliveryPoll).toHaveBeenCalledWith(expect.objectContaining({ nonce: '22' }));
  });
});

describe('resumeEarnWithdrawal', () => {
  beforeEach(() => jest.clearAllMocks());

  it('re-registers the bridge-in and restarts polling for a submitted redeeming row', async () => {
    jest.mocked(Repo.transactions.where).mockImplementation(
      jest.fn().mockReturnValue({
        first: jest.fn().mockResolvedValue({
          id: 'TX1',
          type: 'earn-withdraw',
          extraInputs: {
            phase: 'redeeming',
            evmOwner: EVM_OWNER,
            withdrawIntentNonce: 'NONCE1',
            sourceAmount: '10',
            sourceSymbol: 'USDC'
          }
        })
      })
    );
    const deps = baseDeps();

    await resumeEarnWithdrawal('TX1', deps);

    expect(deps.registerBridgeIn).not.toHaveBeenCalled();
    expect(deps.startDeliveryPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        immediate: true,
        attemptId: 'TX1',
        bridgeInfo: expect.objectContaining({ earnWithdrawTxId: 'TX1', earnWithdrawAttemptId: 'TX1' })
      })
    );
    expect(deps.startDeliveryPoll).toHaveBeenCalled();
    expect(deps.updatePhase).not.toHaveBeenCalled();
  });

  it('recovers a submitted row that lost its nonce from the bridge-in registry instead of failing it', async () => {
    // Row is non-terminal `redeeming` with NO withdrawIntentNonce (torn down between the
    // two post-submit writes). The registry still holds the nonce → resume must recover +
    // re-persist it and re-arm delivery, never mark the (live) withdrawal `failed`.
    jest.mocked(Repo.transactions.where).mockImplementation(
      jest.fn().mockReturnValue({
        first: jest.fn().mockResolvedValue({
          id: 'TX3',
          type: 'earn-withdraw',
          extraInputs: { phase: 'redeeming', evmOwner: EVM_OWNER, sourceAmount: '10', sourceSymbol: 'USDC' }
        })
      })
    );
    const deps = baseDeps({
      findBridgeIn: jest.fn().mockResolvedValue({ intentNonce: 'RECOVERED', userAddress: EVM_OWNER })
    });

    await resumeEarnWithdrawal('TX3', deps);

    expect(deps.findBridgeIn).toHaveBeenCalledWith('TX3', 'TX3');
    // Re-persists the recovered nonce onto the row (not a `failed` write).
    expect(deps.updatePhase).toHaveBeenCalledWith('TX3', 'redeeming', { withdrawIntentNonce: 'RECOVERED' }, undefined, {
      owner: EVM_OWNER,
      nonce: 'RECOVERED',
      attemptId: 'TX3'
    });
    expect(deps.updatePhase).not.toHaveBeenCalledWith('TX3', 'failed', expect.anything());
    expect(deps.registerBridgeIn).not.toHaveBeenCalled();
    expect(deps.startDeliveryPoll).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: 'RECOVERED', immediate: true, attemptId: 'TX3' })
    );
    expect(deps.startDeliveryPoll).toHaveBeenCalled();
  });

  it('fails a row that was interrupted before the intent was submitted', async () => {
    jest.mocked(Repo.transactions.where).mockImplementation(
      jest.fn().mockReturnValue({
        first: jest.fn().mockResolvedValue({
          id: 'TX2',
          type: 'earn-withdraw',
          extraInputs: { phase: 'redeeming', evmOwner: EVM_OWNER, sourceAmount: '10', sourceSymbol: 'USDC' }
        })
      })
    );
    // Legacy absence is shown as interrupted, but does not prove source Retry is safe.
    const deps = baseDeps();

    await resumeEarnWithdrawal('TX2', deps);

    expect(deps.updatePhase).toHaveBeenCalledWith(
      'TX2',
      'failed',
      expect.objectContaining({ error: expect.any(String) }),
      undefined,
      expect.objectContaining({ owner: EVM_OWNER, attemptId: expect.any(String) })
    );
    expect(deps.startDeliveryPoll).not.toHaveBeenCalled();
  });
});

describe('reconcileEarnWithdrawals', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fails rows older than the TTL without resuming them', async () => {
    const old = liveWithdrawal('OLD');
    old.initiatedAt = 0;
    wireWithdrawal(old);
    jest.mocked(Repo.transactions.filter).mockImplementation(
      jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          {
            id: 'OLD',
            type: 'earn-withdraw',
            initiatedAt: 0,
            extraInputs: { phase: 'redeeming', evmOwner: EVM_OWNER }
          }
        ])
      })
    );
    const deps = baseDeps();

    await reconcileEarnWithdrawals(deps);

    expect(deps.updatePhase).toHaveBeenCalledWith(
      'OLD',
      'failed',
      expect.objectContaining({ error: expect.any(String) }),
      undefined,
      expect.objectContaining({ owner: EVM_OWNER, attemptId: expect.any(String) })
    );
    expect(deps.startDeliveryPoll).not.toHaveBeenCalled();
  });

  // A restored row's `evmOwner` comes from whoever authored the backup, and this
  // runs on unlock with no user action - so it must not be resumed. It must not
  // simply be skipped either: these rows are born Completed with their lifecycle
  // in `extraInputs.phase`, and the phase's other writers are driven by a
  // registry that does not travel in the dump, so a skipped row would read
  // "Redeeming" forever and keep suppressing its linked consume row.
  it('terminalizes a restored row instead of resuming it, even inside the TTL', async () => {
    const restored = liveWithdrawal('RESTORED');
    restored.restoredFromBackup = true;
    wireWithdrawal(restored);
    jest.mocked(Repo.transactions.filter).mockImplementation(
      jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          {
            id: 'RESTORED',
            type: 'earn-withdraw',
            initiatedAt: Math.floor(Date.now() / 1000),
            restoredFromBackup: true,
            extraInputs: { phase: 'redeeming', evmOwner: EVM_OWNER }
          }
        ])
      })
    );
    const deps = baseDeps();

    await reconcileEarnWithdrawals(deps);

    expect(deps.updatePhase).toHaveBeenCalledWith(
      'RESTORED',
      'failed',
      expect.objectContaining({ error: expect.any(String) }),
      undefined,
      undefined
    );
    expect(deps.startDeliveryPoll).not.toHaveBeenCalled();
  });
});

// The configured destination matches the prepared Miden delivery fixture.
const MIDEN_CHAIN_ID = 999999999;
const SEPOLIA_CHAIN_ID = 11155111;

describe('pollEarnWithdrawDelivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    clearPollRegistryForTests();
    jest.mocked(Repo.transactions.where).mockImplementation(
      jest.fn().mockReturnValue({
        first: jest.fn().mockResolvedValue({
          id: 'TX1',
          type: 'earn-withdraw',
          status: ITransactionStatus.Completed,
          extraInputs: { phase: 'redeeming', evmOwner: EVM_OWNER, withdrawIntentNonce: 'NONCE1' }
        })
      })
    );
  });
  afterEach(() => {
    clearPollRegistryForTests();
    jest.useRealTimers();
  });

  const runTick = async (results: unknown[]) => {
    const deps = {
      getSdk: jest.fn().mockResolvedValue({ getIntentStatus: jest.fn().mockResolvedValue(results) }),
      updatePhase: jest.fn().mockResolvedValue(undefined),
      resolveNoteId: jest.fn().mockResolvedValue(undefined)
    };
    pollEarnWithdrawDelivery({ sponsorAddress: EVM_OWNER, nonce: 'NONCE1', txId: 'TX1', intervalMs: 10, deps });
    await jest.advanceTimersByTimeAsync(10);
    return deps;
  };

  it('keeps polling when only the Sepolia source leg completed', async () => {
    // The bug this guards: the redeem leg settles long before the bridged note
    // reaches Miden, and treating it as terminal stopped the poll early.
    const deps = await runTick([
      { chainId: SEPOLIA_CHAIN_ID, status: 'completed', transactionHash: '0xsource' },
      { chainId: MIDEN_CHAIN_ID, status: 'pending', transactionHash: '' }
    ]);
    expect(deps.updatePhase).not.toHaveBeenCalled();
  });

  it('advances to delivering once the Miden destination leg completes', async () => {
    const deps = await runTick([
      { chainId: SEPOLIA_CHAIN_ID, status: 'pending', transactionHash: '0xsource' },
      { chainId: MIDEN_CHAIN_ID, status: 'completed', transactionHash: '0xdest' }
    ]);
    // The EVM-side hash comes off the source leg, not the Miden leg.
    expect(deps.updatePhase).toHaveBeenCalledWith('TX1', 'delivering', { evmTxHash: '0xsource' }, undefined, {
      owner: EVM_OWNER,
      nonce: 'NONCE1',
      attemptId: 'TX1'
    });
  });

  it('fails on a Miden destination-leg failure', async () => {
    const deps = await runTick([
      { chainId: SEPOLIA_CHAIN_ID, status: 'completed' },
      { chainId: MIDEN_CHAIN_ID, status: 'failed' }
    ]);
    expect(deps.updatePhase).toHaveBeenCalledWith(
      'TX1',
      'failed',
      expect.objectContaining({ error: expect.any(String) }),
      undefined,
      expect.objectContaining({ owner: EVM_OWNER, attemptId: expect.any(String) })
    );
  });

  it('resolves the bridged note id AFTER the delivery-phase patch', async () => {
    const deps = await runTick([
      { chainId: SEPOLIA_CHAIN_ID, status: 'pending' },
      { chainId: MIDEN_CHAIN_ID, status: 'completed', midenNoteId: '0xnote' }
    ]);
    expect(deps.resolveNoteId).toHaveBeenCalledWith(EVM_OWNER, 'NONCE1', '0xnote');
    // Ordering is what keeps a `received` flip from being downgraded to `delivering`.
    expect(deps.updatePhase.mock.invocationCallOrder[0]!).toBeLessThan(deps.resolveNoteId.mock.invocationCallOrder[0]!);
  });

  /** Advance one interval and drain the tick's microtasks (mirrors `runTick`). */
  const stepTick = async () => {
    await jest.advanceTimersByTimeAsync(10);
  };

  it('backs off after maxAttempts then resumes without terminalizing the pending row', async () => {
    const getIntentStatus = jest.fn().mockResolvedValue([
      { chainId: SEPOLIA_CHAIN_ID, status: 'pending' },
      { chainId: MIDEN_CHAIN_ID, status: 'pending' }
    ]);
    const deps = {
      getSdk: jest.fn().mockResolvedValue({ getIntentStatus }),
      updatePhase: jest.fn().mockResolvedValue(undefined),
      resolveNoteId: jest.fn().mockResolvedValue(undefined)
    };
    const maxAttempts = 3;
    pollEarnWithdrawDelivery({
      sponsorAddress: EVM_OWNER,
      nonce: 'NONCE1',
      txId: 'TX1',
      intervalMs: 10,
      maxAttempts,
      deps
    });

    for (let t = 0; t < maxAttempts; t += 1) await stepTick();
    expect(getIntentStatus).toHaveBeenCalledTimes(maxAttempts);

    // A short retry burst yields to the bounded backoff without dropping ownership.
    await stepTick();
    expect(getIntentStatus).toHaveBeenCalledTimes(maxAttempts);
    await jest.advanceTimersByTimeAsync(29_989);
    expect(getIntentStatus).toHaveBeenCalledTimes(maxAttempts);
    await jest.advanceTimersByTimeAsync(1);
    expect(getIntentStatus).toHaveBeenCalledTimes(maxAttempts + 1);
    expect(deps.updatePhase).not.toHaveBeenCalled();
  });

  it('survives a transient getIntentStatus error and completes on a later tick', async () => {
    // The per-tick try/catch must swallow a flaky RPC/SDK reject and keep the
    // interval alive - a thrown error must NOT clear the poll or fail the row.
    const getIntentStatus = jest
      .fn()
      .mockRejectedValueOnce(new Error('rpc flake'))
      .mockResolvedValueOnce([
        { chainId: SEPOLIA_CHAIN_ID, status: 'completed', transactionHash: '0xsource' },
        { chainId: MIDEN_CHAIN_ID, status: 'completed', transactionHash: '0xdest' }
      ]);
    const deps = {
      getSdk: jest.fn().mockResolvedValue({ getIntentStatus }),
      updatePhase: jest.fn().mockResolvedValue(undefined),
      resolveNoteId: jest.fn().mockResolvedValue(undefined)
    };
    pollEarnWithdrawDelivery({ sponsorAddress: EVM_OWNER, nonce: 'NONCE1', txId: 'TX1', intervalMs: 10, deps });

    // First tick rejects; the error is swallowed and nothing terminal is written.
    await stepTick();
    expect(deps.updatePhase).not.toHaveBeenCalled();

    // Second tick sees a terminal result - proving the interval was never cleared.
    await stepTick();
    expect(getIntentStatus).toHaveBeenCalledTimes(2);
    expect(deps.updatePhase).toHaveBeenCalledWith('TX1', 'delivering', { evmTxHash: '0xsource' }, undefined, {
      owner: EVM_OWNER,
      nonce: 'NONCE1',
      attemptId: 'TX1'
    });
  });

  it('is a no-op when a poll for the same nonce is already live', async () => {
    const getIntentStatus = jest.fn().mockResolvedValue([{ chainId: MIDEN_CHAIN_ID, status: 'pending' }]);
    const deps = {
      getSdk: jest.fn().mockResolvedValue({ getIntentStatus }),
      updatePhase: jest.fn().mockResolvedValue(undefined),
      resolveNoteId: jest.fn().mockResolvedValue(undefined)
    };
    pollEarnWithdrawDelivery({ sponsorAddress: EVM_OWNER, nonce: 'NONCE1', txId: 'TX1', intervalMs: 10, deps });
    pollEarnWithdrawDelivery({ sponsorAddress: EVM_OWNER, nonce: 'NONCE1', txId: 'TX1', intervalMs: 10, deps });
    await stepTick();
    expect(getIntentStatus).toHaveBeenCalledTimes(1);
  });

  it('releases the nonce key on a terminal outcome so a later kick can restart', async () => {
    await runTick([{ chainId: MIDEN_CHAIN_ID, status: 'completed', transactionHash: '0xdest' }]);
    const deps = await runTick([{ chainId: MIDEN_CHAIN_ID, status: 'pending' }]);
    expect(deps.getSdk).toHaveBeenCalledTimes(1);
  });
});

describe('resubmitEarnWithdrawal', () => {
  beforeEach(() => jest.clearAllMocks());

  const failedRow = (extraInputs: Partial<IEarnWithdrawExtraInputs> = {}) =>
    liveWithdrawal('TX1', {
      phase: 'failed',
      submissionState: 'preparing',
      error: 'Withdrawal setup failed before execution.',
      ...extraInputs
    });

  /** Mock `Repo.transactions.where` for both the read and the phase reset. */
  const mockRow = wireWithdrawal;

  // `phase: 'failed'` is this function's precondition AND exactly the state
  // import forces a restored row into, so the two coincide perfectly. Everything
  // past this point signs with the row's own `evmOwner`, `marketUid` and
  // `sourceAmount`, all of which came from whoever wrote the dump. Guarded in
  // here rather than only in the caller so a future caller inherits it.
  it('claims a failed row atomically so two concurrent retries submit only once', async () => {
    const row = failedRow();
    const modify = mockRow(row);
    jest.mocked(Repo.transactions.where).mockImplementation(
      jest.fn().mockReturnValue({
        first: jest.fn().mockImplementation(async () => ({ ...row, extraInputs: { ...row.extraInputs } })),
        modify
      })
    );
    const executeActions = jest.fn().mockResolvedValue({ nonce: 'FRESH_NONCE' });
    const deps = baseDeps({ sdk: fakeSdk(executeActions) });
    await Promise.allSettled([resubmitEarnWithdrawal('TX1', deps), resubmitEarnWithdrawal('TX1', deps)]);
    expect(executeActions).toHaveBeenCalledTimes(1);
  });

  it('refuses a row restored from a backup', async () => {
    const executeActions = jest.fn();
    // The flag lives on the row itself, not inside `extraInputs`.
    const row = { ...failedRow(), restoredFromBackup: true };
    mockRow(row);

    await expect(resubmitEarnWithdrawal('TX1', baseDeps({ sdk: fakeSdk(executeActions) }))).rejects.toThrow(
      /restored from a backup/i
    );
    expect(executeActions).not.toHaveBeenCalled();
    // It must refuse, not quietly reset the row and leave it resubmittable.
    expect(row.extraInputs.phase).toBe('failed');
  });

  it('submits a brand new intent on the same row', async () => {
    const row = failedRow();
    const modify = mockRow(row);
    const executeActions = jest.fn().mockResolvedValue({ nonce: 'FRESH_NONCE' });
    const deps = baseDeps({ sdk: fakeSdk(executeActions) });
    // The row is reused, so no new row is created.

    await resubmitEarnWithdrawal('TX1', deps);

    // Terminal state cleared before the flow re-runs.
    expect(modify).toHaveBeenCalled();
    expect(row.extraInputs.phase).toBe('redeeming');
    expect(row.extraInputs.withdrawIntentNonce).toBe('22');
    expect(row.extraInputs.error).toBeUndefined();
    expect(executeActions).toHaveBeenCalledTimes(1);
    expect(deps.initiateRow).not.toHaveBeenCalled();
    expect(row.extraInputs.submissionState).toBe('accepted');
    expect(row.extraInputs.preparedExecution?.allocations).toEqual(preparedExecution().allocations);
    expect(deps.startDeliveryPoll).toHaveBeenCalledWith(expect.objectContaining({ txId: 'TX1', nonce: '22' }));
  });

  it('resubmits a row that never reached Epoch (no nonce recorded)', async () => {
    const row = failedRow({ withdrawIntentNonce: undefined });
    mockRow(row);
    const executeActions = jest.fn().mockResolvedValue({ nonce: 'FRESH_NONCE' });
    const deps = baseDeps({ sdk: fakeSdk(executeActions) });

    await resubmitEarnWithdrawal('TX1', deps);

    expect(executeActions).toHaveBeenCalled();
  });

  it('is a no-op on a non-failed row', async () => {
    mockRow(failedRow({ phase: 'delivering' }));
    const executeActions = jest.fn();
    const deps = baseDeps({ sdk: fakeSdk(executeActions) });

    await resubmitEarnWithdrawal('TX1', deps);

    expect(executeActions).not.toHaveBeenCalled();
  });

  it.each(['legacy', 'known-nonce', 'prepared', 'accepted'])(
    'never resubmits the source for a %s failed row',
    async state => {
      const row = failedRow();
      if (state === 'legacy') row.extraInputs.submissionState = undefined;
      else row.extraInputs.withdrawIntentNonce = '22';
      if (state === 'prepared' || state === 'accepted') {
        const identity = earnWithdrawExecutionIdentity(row);
        if (!identity) throw new Error('missing fixture identity');
        row.extraInputs.preparedExecution = selectEarnWithdrawPreparedExecution(preparedExecution(), identity);
        row.extraInputs.submissionState = state;
      }
      expect(Boolean(row.extraInputs.preparedExecution)).toBe(state === 'prepared' || state === 'accepted');
      const before = { ...row, extraInputs: { ...row.extraInputs } };
      mockRow(row);
      const executeActions = jest.fn();
      await resubmitEarnWithdrawal('TX1', baseDeps({ sdk: fakeSdk(executeActions) }));
      expect(executeActions).not.toHaveBeenCalled();
      expect(row).toEqual(before);
    }
  );

  it('refuses a row missing the market details needed to rebuild the request', async () => {
    const row = failedRow({ marketUid: '' });
    mockRow(row);
    const executeActions = jest.fn();
    const deps = baseDeps({ sdk: fakeSdk(executeActions) });

    await resubmitEarnWithdrawal('TX1', deps);
    expect(executeActions).not.toHaveBeenCalled();
    expect(row.extraInputs.phase).toBe('failed');
  });

  it('re-marks the row failed when the new attempt fails before execution permission', async () => {
    const row = failedRow();
    mockRow(row);
    const executeActions = jest.fn();
    const deps = baseDeps({
      sdk: fakeSdk(executeActions),
      ensureSmartAccount: jest.fn().mockRejectedValue(new Error('still broke'))
    });

    await expect(resubmitEarnWithdrawal('TX1', deps)).rejects.toThrow('still broke');
    expect(row.extraInputs).toMatchObject({ phase: 'failed', submissionState: 'preparing', error: 'still broke' });
    expect(row.extraInputs.withdrawIntentNonce).toBeUndefined();
    expect(earnWithdrawalRetryKind(row)).toBe('source');
    expect(executeActions).not.toHaveBeenCalled();
  });
});

interface LiveWithdrawal extends ITransaction {
  type: 'earn-withdraw';
  extraInputs: IEarnWithdrawExtraInputs;
}

function liveWithdrawal(id: string, inputs: Partial<IEarnWithdrawExtraInputs> = {}): LiveWithdrawal {
  return {
    id,
    type: 'earn-withdraw',
    accountId: PREPARED_RECIPIENT,
    status: ITransactionStatus.Completed,
    initiatedAt: Math.floor(Date.now() / 1000),
    completedAt: Math.floor(Date.now() / 1000),
    displayIcon: 'DEFAULT',
    extraInputs: {
      phase: 'redeeming',
      evmOwner: EVM_OWNER,
      marketUid: MARKET_UID,
      destinationFaucetId: PREPARED_FAUCET,
      sourceAmount: '10',
      sourceSymbol: 'USDC',
      ...inputs
    }
  };
}

function memoryWithdrawals() {
  const rows = new Map<string, LiveWithdrawal>();
  const registry: PendingBridgeInIntent[] = [];
  const clone = (row: LiveWithdrawal): LiveWithdrawal => ({ ...row, extraInputs: { ...row.extraInputs } });
  jest.mocked(Repo.transactions.where).mockImplementation(
    jest.fn().mockImplementation(({ id }: { id: string }) => ({
      first: jest.fn().mockImplementation(async () => {
        const row = rows.get(id);
        return row ? clone(row) : undefined;
      }),
      modify: jest.fn().mockImplementation(async (modify: (row: LiveWithdrawal) => void) => {
        const row = rows.get(id);
        if (!row) return 0;
        modify(row);
        return 1;
      })
    }))
  );
  jest.mocked(Repo.transactions.filter).mockImplementation(
    jest.fn().mockImplementation((predicate: (row: LiveWithdrawal) => boolean) => ({
      toArray: jest.fn().mockImplementation(async () => [...rows.values()].filter(predicate).map(clone))
    }))
  );
  const initiateRow = jest.fn(async (...args: Parameters<typeof initiateEarnWithdrawTransaction>) => {
    const [accountId, amount, owner, market, faucet, sourceAmount, symbol, attemptId, startedAt] = args;
    const row = liveWithdrawal('TX1', {
      evmOwner: owner,
      marketUid: market,
      destinationFaucetId: faucet,
      sourceAmount,
      sourceSymbol: symbol ?? 'USDC',
      submissionState: 'preparing',
      submissionAttemptId: attemptId,
      attemptStartedAt: startedAt
    });
    row.accountId = accountId;
    row.amount = amount;
    rows.set(row.id, row);
    return row.id;
  });
  const updatePhase = jest.fn(async (...args: Parameters<typeof updateEarnWithdrawPhase>) => {
    const [id, phase, patch, amount, expected] = args;
    const row = rows.get(id);
    if (!row || (expected && !matchesEarnWithdrawIntent(row, expected))) return;
    if (row.extraInputs.phase === 'received' || row.extraInputs.phase === 'failed') return;
    row.extraInputs = { ...row.extraInputs, ...patch, phase };
    if (amount !== undefined) row.amount = amount;
  });
  const registerBridgeIn = jest.fn(async (owner: string, nonce: string, info: IBridgeInInfo) => {
    if (!registry.some(entry => entry.userAddress === owner && entry.intentNonce === nonce)) {
      registry.push({ userAddress: owner, intentNonce: nonce, info, registeredAt: Date.now() });
    }
  });
  const findBridgeIn = jest.fn(async (id: string, attemptId: string) =>
    registry.find(entry => entry.info.earnWithdrawTxId === id && (entry.info.earnWithdrawAttemptId ?? id) === attemptId)
  );
  return { rows, registry, initiateRow, updatePhase, registerBridgeIn, findBridgeIn };
}

describe('withdrawal ownership across independent document factories', () => {
  const disposers: Array<() => void> = [];
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    clearPollRegistryForTests();
    clearEarnSubmissionLocksForTests();
    jest.spyOn(console, 'warn').mockImplementation();
  });
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    clearPollRegistryForTests();
    clearEarnSubmissionLocksForTests();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function documents() {
    const locks = new SharedEarnLocks();
    const submissionA = createEarnSubmissionLocks({ getLocks: () => locks });
    const submissionB = createEarnSubmissionLocks({ getLocks: () => locks });
    const pollA = createIntentPollCoordinator({ getLocks: () => locks });
    const pollB = createIntentPollCoordinator({ getLocks: () => locks });
    disposers.push(submissionA.dispose, submissionB.dispose, pollA.dispose, pollB.dispose);
    return { locks, submissionA, submissionB, pollA, pollB };
  }

  it('fails a missing-owner row locally instead of leaving it permanently pending', async () => {
    const h = memoryWithdrawals();
    const d = documents();
    const row = liveWithdrawal('TX1');
    Reflect.deleteProperty(row.extraInputs, 'evmOwner');
    h.rows.set('TX1', row);
    const getSdk = jest.fn();
    await resumeEarnWithdrawal('TX1', { ...h, getSdk, tryWithSubmissionLock: d.submissionB.tryWithEarnSubmissionLock });
    expect(row.extraInputs.phase).toBe('failed');
    expect(getSdk).not.toHaveBeenCalled();
    expect(h.findBridgeIn).not.toHaveBeenCalled();
  });

  it('does not declare an attempt interrupted when its registry lookup fails', async () => {
    const h = memoryWithdrawals();
    const d = documents();
    const row = liveWithdrawal('TX1');
    h.rows.set('TX1', row);
    await expect(
      resumeEarnWithdrawal('TX1', {
        ...h,
        findBridgeIn: jest.fn().mockRejectedValue(new Error('storage unavailable')),
        tryWithSubmissionLock: d.submissionB.tryWithEarnSubmissionLock
      })
    ).rejects.toThrow('storage unavailable');
    expect(row.extraInputs.phase).toBe('redeeming');
    expect(h.updatePhase).not.toHaveBeenCalled();
  });

  it('keeps a parked initial submission live while another document reconciles unrelated rows', async () => {
    const h = memoryWithdrawals();
    const d = documents();
    const execution = deferred<{ nonce: string }>();
    const executeActions = jest.fn().mockReturnValue(execution.promise);
    const getIntentStatus = jest.fn().mockResolvedValue([{ chainId: MIDEN_CHAIN_ID, status: 'pending' }]);
    const pollDeps = {
      getSdk: jest.fn().mockResolvedValue({ getIntentStatus }),
      updatePhase: h.updatePhase,
      registerBridgeIn: h.registerBridgeIn
    };
    const submission = gaslessEarnWithdrawalToMiden(
      validArgs(),
      baseDeps({
        ...h,
        sdk: fakeSdk(executeActions),
        withSubmissionLock: d.submissionA.withEarnSubmissionLock,
        startDeliveryPoll: (args: Parameters<typeof pollEarnWithdrawDelivery>[0]) =>
          pollEarnWithdrawDelivery({
            ...args,
            deps: { ...pollDeps, startPoll: d.pollA.startIntentPoll }
          })
      })
    );
    await jest.advanceTimersByTimeAsync(0);
    void submission.catch(() => undefined);
    h.rows.set('UNRELATED', liveWithdrawal('UNRELATED'));
    const recovery = {
      ...h,
      ...pollDeps,
      startPoll: d.pollB.startIntentPoll,
      tryWithSubmissionLock: d.submissionB.tryWithEarnSubmissionLock
    };
    await reconcileEarnWithdrawals(recovery);
    expect(h.rows.get('TX1')?.extraInputs.phase).toBe('redeeming');
    expect(h.rows.get('UNRELATED')?.extraInputs.phase).toBe('failed');
    expect(h.findBridgeIn).not.toHaveBeenCalledWith('TX1', expect.anything());
    expect(getIntentStatus).not.toHaveBeenCalled();

    execution.resolve({ nonce: 'LIVE' });
    await submission;
    await reconcileEarnWithdrawals(recovery);
    await jest.advanceTimersByTimeAsync(0);
    expect(executeActions).toHaveBeenCalledTimes(1);
    expect(getIntentStatus).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2999);
    expect(getIntentStatus).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(getIntentStatus).toHaveBeenCalledTimes(2);
    const inputs = h.rows.get('TX1')?.extraInputs;
    expect(inputs?.withdrawIntentNonce).toBe('22');
    expect(h.registry[0]?.info.earnWithdrawAttemptId).toBe(inputs?.submissionAttemptId);
  });

  it('does not recover an old registry nonce during retry and preserves history timestamps', async () => {
    const h = memoryWithdrawals();
    const d = documents();
    const old = liveWithdrawal('TX1', {
      phase: 'failed',
      submissionState: 'preparing',
      submissionAttemptId: 'UNSENT-ATTEMPT',
      error: 'failed'
    });
    old.initiatedAt = 1;
    old.completedAt = 2;
    h.rows.set('TX1', old);
    h.registry.push({
      userAddress: EVM_OWNER,
      intentNonce: 'OLD',
      registeredAt: Date.now(),
      info: { provider: 'epoch', earnWithdrawTxId: 'TX1', earnWithdrawAttemptId: 'OLD-ATTEMPT' }
    });
    const execution = deferred<{ nonce: string }>();
    const retry = resubmitEarnWithdrawal(
      'TX1',
      baseDeps({
        ...h,
        sdk: fakeSdk(jest.fn().mockReturnValue(execution.promise)),
        withSubmissionLock: d.submissionA.withEarnSubmissionLock
      })
    );
    await jest.advanceTimersByTimeAsync(0);
    await reconcileEarnWithdrawals({
      ...h,
      tryWithSubmissionLock: d.submissionB.tryWithEarnSubmissionLock,
      startDeliveryPoll: jest.fn()
    });
    expect(old.extraInputs.phase).toBe('redeeming');
    expect(old.extraInputs.withdrawIntentNonce).toBe('22');
    expect(old.extraInputs.midenNoteId).toBeUndefined();
    expect(old.extraInputs.evmTxHash).toBeUndefined();
    expect(old.extraInputs.outputAmount).toBeUndefined();
    expect(old.extraInputs.outputSymbol).toBeUndefined();
    expect(old.extraInputs.error).toBeUndefined();
    expect(old.initiatedAt).toBe(1);
    expect(old.completedAt).toBe(2);
    expect(old.extraInputs.attemptStartedAt).toBe(Math.floor(Date.now() / 1000));
    expect(h.findBridgeIn).not.toHaveBeenCalled();
    execution.resolve({ nonce: 'NEW' });
    await retry;
    expect(old.extraInputs.withdrawIntentNonce).toBe('22');
    expect(old.extraInputs.submissionAttemptId).not.toBe('UNSENT-ATTEMPT');
  });

  it('recovers the durable preparation when the submitting document disappears during acceptance persistence', async () => {
    const h = memoryWithdrawals();
    const d = documents();
    const writingAcceptance = deferred<boolean>();
    const markAccepted = jest.fn().mockReturnValue(writingAcceptance.promise);
    const executeActions = jest.fn().mockResolvedValue({ nonce: '11' });
    const submission = gaslessEarnWithdrawalToMiden(
      validArgs(),
      baseDeps({
        ...h,
        sdk: fakeSdk(executeActions),
        markAccepted,
        withSubmissionLock: d.submissionA.withEarnSubmissionLock
      })
    );
    const result = submission.catch(error => error);
    await jest.advanceTimersByTimeAsync(0);
    expect(h.registry).toHaveLength(0);
    expect(h.rows.get('TX1')?.extraInputs).toMatchObject({ submissionState: 'prepared', withdrawIntentNonce: '22' });
    const getIntentStatus = jest
      .fn()
      .mockResolvedValue([{ chainId: MIDEN_CHAIN_ID, status: 'pending', transactionHash: '' }]);
    const recovery = {
      ...h,
      getSdk: jest.fn().mockResolvedValue({ getIntentStatus }),
      startPoll: d.pollB.startIntentPoll,
      tryWithSubmissionLock: d.submissionB.tryWithEarnSubmissionLock
    };
    await reconcileEarnWithdrawals(recovery);
    expect(getIntentStatus).not.toHaveBeenCalled();
    d.submissionA.dispose();
    expect(await result).toBeInstanceOf(Error);
    await jest.advanceTimersByTimeAsync(0);
    await reconcileEarnWithdrawals(recovery);
    await jest.advanceTimersByTimeAsync(0);
    expect(h.rows.get('TX1')?.extraInputs).toMatchObject({
      phase: 'redeeming',
      submissionState: 'accepted',
      withdrawIntentNonce: '22'
    });
    expect(getIntentStatus).toHaveBeenCalledWith(EVM_OWNER, '11');
    expect(getIntentStatus).toHaveBeenCalledWith(EVM_OWNER, '22');
    expect(h.registerBridgeIn).toHaveBeenCalledTimes(1);
    writingAcceptance.resolve(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(executeActions).toHaveBeenCalledTimes(1);
    expect(getIntentStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps a permitted attempt recoverable after owner teardown and ignores its late submission callback', async () => {
    const h = memoryWithdrawals();
    const d = documents();
    const execution = deferred<{ nonce: string }>();
    const executeActions = jest.fn().mockReturnValue(execution.promise);
    const startDeliveryPoll = jest.fn();
    const submission = gaslessEarnWithdrawalToMiden(
      validArgs(),
      baseDeps({
        ...h,
        sdk: fakeSdk(executeActions),
        startDeliveryPoll,
        withSubmissionLock: d.submissionA.withEarnSubmissionLock
      })
    );
    const result = submission.catch(error => error);
    await jest.advanceTimersByTimeAsync(0);
    d.submissionA.dispose();
    expect(await result).toBeInstanceOf(Error);
    await jest.advanceTimersByTimeAsync(0);
    const recoveredPoll = jest.fn();
    await reconcileEarnWithdrawals({
      ...h,
      startDeliveryPoll: recoveredPoll,
      tryWithSubmissionLock: d.submissionB.tryWithEarnSubmissionLock
    });
    expect(h.rows.get('TX1')?.extraInputs).toMatchObject({
      phase: 'redeeming',
      submissionState: 'prepared',
      withdrawIntentNonce: '22'
    });
    expect(recoveredPoll).toHaveBeenCalledWith(expect.objectContaining({ nonce: '22' }));
    await resubmitEarnWithdrawal('TX1', baseDeps({ ...h, sdk: fakeSdk(executeActions) }));
    expect(executeActions).toHaveBeenCalledTimes(1);
    execution.resolve({ nonce: 'LATE' });
    await jest.advanceTimersByTimeAsync(0);
    expect(h.registry).toHaveLength(0);
    expect(h.rows.get('TX1')?.extraInputs.withdrawIntentNonce).toBe('22');
    expect(startDeliveryPoll).not.toHaveBeenCalled();
  });

  it.each(['registry', 'acceptance'])('recovers a submitted intent when its %s persistence failed', async failure => {
    const h = memoryWithdrawals();
    const d = documents();
    const executeActions = jest.fn().mockResolvedValue({ nonce: '11' });
    const deps = baseDeps({
      ...h,
      sdk: fakeSdk(executeActions),
      withSubmissionLock: d.submissionA.withEarnSubmissionLock
    });
    if (failure === 'registry') h.registerBridgeIn.mockRejectedValueOnce(new Error('registry write failed'));
    else deps.markAccepted.mockRejectedValueOnce(new Error('acceptance write failed'));
    await gaslessEarnWithdrawalToMiden(validArgs(), deps);
    expect(h.rows.get('TX1')?.extraInputs.withdrawIntentNonce).toBe('22');
    expect(h.rows.get('TX1')?.extraInputs.preparedExecution?.allocations).toEqual(preparedExecution().allocations);
    const getIntentStatus = jest
      .fn()
      .mockResolvedValue([{ chainId: MIDEN_CHAIN_ID, status: 'pending', transactionHash: '' }]);
    await resumeEarnWithdrawal('TX1', {
      ...h,
      getSdk: jest.fn().mockResolvedValue({ getIntentStatus }),
      startPoll: d.pollB.startIntentPoll,
      tryWithSubmissionLock: d.submissionB.tryWithEarnSubmissionLock
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(getIntentStatus).toHaveBeenCalledWith(EVM_OWNER, '22');
    expect(h.rows.get('TX1')?.extraInputs.phase).toBe('redeeming');
    expect(h.registry).toHaveLength(failure === 'registry' ? 0 : 1);
    if (failure === 'registry') {
      await jest.advanceTimersByTimeAsync(30_000);
    }
    expect(h.registry).toHaveLength(1);
    expect(h.rows.get('TX1')?.extraInputs.submissionState).toBe('accepted');
    await resubmitEarnWithdrawal('TX1', deps);
    expect(executeActions).toHaveBeenCalledTimes(1);
  });

  it('does not fail or poll an existing row when recovery lock acquisition rejects', async () => {
    const h = memoryWithdrawals();
    const row = liveWithdrawal('TX1');
    h.rows.set(row.id, row);
    const locks = { request: jest.fn().mockRejectedValue(new Error('lock rejected')) };
    const recovery = createEarnSubmissionLocks({ getLocks: () => locks });
    disposers.push(recovery.dispose);
    const getSdk = jest.fn();
    await reconcileEarnWithdrawals({ ...h, getSdk, tryWithSubmissionLock: recovery.tryWithEarnSubmissionLock });
    expect(row.extraInputs.phase).toBe('redeeming');
    expect(h.updatePhase).not.toHaveBeenCalled();
    expect(h.findBridgeIn).not.toHaveBeenCalled();
    expect(getSdk).not.toHaveBeenCalled();
  });

  it('refuses submission when the available lock service rejects', async () => {
    const h = memoryWithdrawals();
    const locks = { request: jest.fn().mockRejectedValue(new Error('locks unavailable')) };
    const owner = createEarnSubmissionLocks({ getLocks: () => locks });
    disposers.push(owner.dispose);
    const executeActions = jest.fn();
    await expect(
      gaslessEarnWithdrawalToMiden(
        validArgs(),
        baseDeps({
          ...h,
          sdk: fakeSdk(executeActions),
          withSubmissionLock: owner.withEarnSubmissionLock
        })
      )
    ).rejects.toThrow('locks unavailable');
    expect(h.rows.size).toBe(0);
    expect(executeActions).not.toHaveBeenCalled();
  });

  it('resolves an old response note after an attempt replacement without changing the new primary', async () => {
    const h = memoryWithdrawals();
    const d = documents();
    const row = liveWithdrawal('TX1', { withdrawIntentNonce: 'OLD', submissionAttemptId: 'OLD-ATTEMPT' });
    h.rows.set('TX1', row);
    const response = deferred<unknown[]>();
    const getIntentStatus = jest.fn().mockReturnValue(response.promise);
    const resolveNoteId = jest.fn().mockResolvedValue(undefined);
    pollEarnWithdrawDelivery({
      sponsorAddress: EVM_OWNER,
      nonce: 'OLD',
      txId: 'TX1',
      attemptId: 'OLD-ATTEMPT',
      immediate: true,
      deps: {
        getSdk: jest.fn().mockResolvedValue({ getIntentStatus }),
        updatePhase: h.updatePhase,
        resolveNoteId,
        startPoll: d.pollA.startIntentPoll
      }
    });
    await jest.advanceTimersByTimeAsync(0);
    row.extraInputs = {
      ...row.extraInputs,
      phase: 'redeeming',
      submissionAttemptId: 'NEW-ATTEMPT',
      withdrawIntentNonce: 'NEW'
    };
    response.resolve([{ chainId: MIDEN_CHAIN_ID, status: 'completed', midenNoteId: '0xold-note' }]);
    await jest.advanceTimersByTimeAsync(0);
    expect(resolveNoteId).toHaveBeenCalledWith(EVM_OWNER, 'OLD', '0xold-note');
    expect(h.updatePhase).not.toHaveBeenCalled();
    expect(row.extraInputs).toMatchObject({
      phase: 'redeeming',
      withdrawIntentNonce: 'NEW',
      submissionAttemptId: 'NEW-ATTEMPT'
    });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(getIntentStatus).toHaveBeenCalledTimes(1);
  });

  it('keeps equal nonces for different owners independent and deduplicates owner case variants', async () => {
    const h = memoryWithdrawals();
    const d = documents();
    const ownerA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const ownerACase = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const ownerB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    h.rows.set('A', liveWithdrawal('A', { evmOwner: ownerA, withdrawIntentNonce: 'SAME' }));
    h.rows.set('B', liveWithdrawal('B', { evmOwner: ownerB, withdrawIntentNonce: 'SAME' }));
    const getIntentStatus = jest.fn().mockResolvedValue([{ chainId: MIDEN_CHAIN_ID, status: 'pending' }]);
    const deps = { getSdk: jest.fn().mockResolvedValue({ getIntentStatus }), updatePhase: h.updatePhase };
    pollEarnWithdrawDelivery({
      sponsorAddress: ownerA,
      nonce: 'SAME',
      txId: 'A',
      immediate: true,
      deps: { ...deps, startPoll: d.pollA.startIntentPoll }
    });
    pollEarnWithdrawDelivery({
      sponsorAddress: ownerACase,
      nonce: 'SAME',
      txId: 'A',
      immediate: true,
      deps: { ...deps, startPoll: d.pollB.startIntentPoll }
    });
    pollEarnWithdrawDelivery({
      sponsorAddress: ownerB,
      nonce: 'SAME',
      txId: 'B',
      immediate: true,
      deps: { ...deps, startPoll: d.pollB.startIntentPoll }
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(getIntentStatus).toHaveBeenCalledTimes(2);
    expect(getIntentStatus).toHaveBeenCalledWith(ownerA, 'SAME');
    expect(getIntentStatus).toHaveBeenCalledWith(ownerB, 'SAME');
  });

  it.each(['received', 'restored', 'deleted', 'owner', 'nonce', 'attempt'])(
    'stops stale withdrawal status writes after a %s replacement',
    async replacement => {
      const h = memoryWithdrawals();
      const d = documents();
      const row = liveWithdrawal('TX1', { withdrawIntentNonce: 'LIVE', submissionAttemptId: 'CURRENT' });
      h.rows.set(row.id, row);
      const response = deferred<unknown[]>();
      const getIntentStatus = jest.fn().mockReturnValue(response.promise);
      const resolveNoteId = jest.fn();
      pollEarnWithdrawDelivery({
        sponsorAddress: EVM_OWNER,
        nonce: 'LIVE',
        txId: 'TX1',
        attemptId: 'CURRENT',
        immediate: true,
        deps: {
          getSdk: jest.fn().mockResolvedValue({ getIntentStatus }),
          updatePhase: h.updatePhase,
          resolveNoteId,
          startPoll: d.pollA.startIntentPoll
        }
      });
      await jest.advanceTimersByTimeAsync(0);
      if (replacement === 'received') row.extraInputs.phase = 'received';
      if (replacement === 'restored') row.restoredFromBackup = true;
      if (replacement === 'deleted') h.rows.delete(row.id);
      if (replacement === 'owner') row.extraInputs.evmOwner = '0x2222222222222222222222222222222222222222';
      if (replacement === 'nonce') row.extraInputs.withdrawIntentNonce = 'OTHER';
      if (replacement === 'attempt') row.extraInputs.submissionAttemptId = 'SUCCESSOR';
      response.resolve([{ chainId: MIDEN_CHAIN_ID, status: 'completed' }]);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(h.updatePhase).not.toHaveBeenCalled();
      expect(getIntentStatus).toHaveBeenCalledTimes(1);
    }
  );

  it('holds polling ownership through phase and note writes, without overlapping SDK calls', async () => {
    const h = memoryWithdrawals();
    const d = documents();
    h.rows.set('TX1', liveWithdrawal('TX1', { withdrawIntentNonce: 'LIVE' }));
    const status = deferred<unknown[]>();
    const phase = deferred<void>();
    const note = deferred<void>();
    const getIntentStatus = jest.fn().mockReturnValue(status.promise);
    const updatePhase = jest.fn().mockReturnValue(phase.promise);
    const resolveNoteId = jest.fn().mockReturnValue(note.promise);
    const deps = { getSdk: jest.fn().mockResolvedValue({ getIntentStatus }), updatePhase, resolveNoteId };
    const args: Parameters<typeof pollEarnWithdrawDelivery>[0] = {
      sponsorAddress: EVM_OWNER,
      nonce: 'LIVE',
      txId: 'TX1',
      immediate: true
    };
    pollEarnWithdrawDelivery({ ...args, deps: { ...deps, startPoll: d.pollA.startIntentPoll } });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(getIntentStatus).toHaveBeenCalledTimes(1);
    status.resolve([{ chainId: MIDEN_CHAIN_ID, status: 'completed', midenNoteId: '0xnote' }]);
    await jest.advanceTimersByTimeAsync(0);
    pollEarnWithdrawDelivery({ ...args, deps: { ...deps, startPoll: d.pollB.startIntentPoll } });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(getIntentStatus).toHaveBeenCalledTimes(1);
    expect(resolveNoteId).not.toHaveBeenCalled();
    phase.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(resolveNoteId).toHaveBeenCalledWith(EVM_OWNER, 'LIVE', '0xnote');
    pollEarnWithdrawDelivery({ ...args, deps: { ...deps, startPoll: d.pollB.startIntentPoll } });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(getIntentStatus).toHaveBeenCalledTimes(1);
    note.resolve();
    await jest.advanceTimersByTimeAsync(0);
    pollEarnWithdrawDelivery({ ...args, deps: { ...deps, startPoll: d.pollB.startIntentPoll } });
    await jest.advanceTimersByTimeAsync(0);
    expect(getIntentStatus).toHaveBeenCalledTimes(2);
  });

  it('registers recovered bridge metadata before the immediate owned status request', async () => {
    const h = memoryWithdrawals();
    const d = documents();
    h.rows.set('TX1', liveWithdrawal('TX1', { withdrawIntentNonce: 'LIVE', submissionAttemptId: 'CURRENT' }));
    const getIntentStatus = jest.fn().mockResolvedValue([{ chainId: MIDEN_CHAIN_ID, status: 'pending' }]);
    const deps = {
      ...h,
      getSdk: jest.fn().mockResolvedValue({ getIntentStatus }),
      startPoll: d.pollB.startIntentPoll,
      tryWithSubmissionLock: d.submissionB.tryWithEarnSubmissionLock
    };
    await resumeEarnWithdrawal('TX1', deps);
    await jest.advanceTimersByTimeAsync(0);
    expect(h.registry[0]?.info.earnWithdrawAttemptId).toBe('CURRENT');
    expect(getIntentStatus).toHaveBeenCalledTimes(1);
    expect(h.registerBridgeIn.mock.invocationCallOrder[0]!).toBeLessThan(getIntentStatus.mock.invocationCallOrder[0]!);
  });

  it('backs off failed registration independently while owned status checks continue', async () => {
    const h = memoryWithdrawals();
    const d = documents();
    h.rows.set('TX1', liveWithdrawal('TX1', { withdrawIntentNonce: 'LIVE' }));
    const getIntentStatus = jest.fn().mockResolvedValue([{ chainId: MIDEN_CHAIN_ID, status: 'pending' }]);
    const registerBridgeIn = jest.fn().mockRejectedValue(new Error('storage offline'));
    const deps = {
      ...h,
      registerBridgeIn,
      getSdk: jest.fn().mockResolvedValue({ getIntentStatus }),
      startPoll: d.pollB.startIntentPoll,
      tryWithSubmissionLock: d.submissionB.tryWithEarnSubmissionLock,
      startDeliveryPoll: (args: Parameters<typeof pollEarnWithdrawDelivery>[0]) =>
        pollEarnWithdrawDelivery({ ...args, intervalMs: 10, maxAttempts: 2 })
    };
    await resumeEarnWithdrawal('TX1', deps);
    await jest.advanceTimersByTimeAsync(10);
    expect(registerBridgeIn).toHaveBeenCalledTimes(1);
    await resumeEarnWithdrawal('TX1', deps);
    await jest.advanceTimersByTimeAsync(29_999);
    expect(registerBridgeIn).toHaveBeenCalledTimes(1);
    expect(getIntentStatus).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(registerBridgeIn).toHaveBeenCalledTimes(2);
    expect(getIntentStatus).toHaveBeenCalledTimes(3);
  });
});

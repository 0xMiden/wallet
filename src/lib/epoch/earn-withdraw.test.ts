import * as Repo from 'lib/miden/repo';

import {
  gaslessEarnWithdrawalToMiden,
  pollEarnWithdrawDelivery,
  reconcileEarnWithdrawals,
  resubmitEarnWithdrawal,
  resumeEarnWithdrawal
} from './earn-withdraw';

jest.mock('@epoch-protocol/epoch-intents-sdk', () => ({
  EpochIntentSDK: class {},
  TaskType: { ProtocolInteraction: 'ProtocolInteraction' },
  ActionType: { Withdraw: 'Withdraw' },
  EVM_ZERO_ADDRESS: '0x0000000000000000000000000000000000000000'
}));
jest.mock('./bridge', () => ({ normalizeMidenIdToHex: (v: string) => v }));
jest.mock('./bridgeable-token', () => ({ BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS: 6 }));
jest.mock('./config', () => ({ EPOCH_ALLOCATOR_URL: 'http://alloc', MIDEN_DESTINATION_CHAIN_ID: 999 }));
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
jest.mock('lib/miden-chain/native-asset', () => ({ getNativeAssetId: jest.fn().mockResolvedValue('mtst1native') }));
jest.mock('lib/miden/activity', () => ({
  initiateEarnWithdrawTransaction: jest.fn(),
  registerPendingBridgeIn: jest.fn(),
  resolveBridgeInNoteId: jest.fn(),
  updateEarnWithdrawPhase: jest.fn()
}));
jest.mock('lib/miden/repo', () => ({ transactions: { where: jest.fn(), filter: jest.fn() } }));

const EVM_OWNER = '0x1111111111111111111111111111111111111111';
const UNDERLYING = '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';
const MARKET_UID = `DUMMY_LENDING:11155111:${UNDERLYING}`;

const validArgs = () => ({
  midenAccountPublicKey: 'mtst1recipient',
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
    helpers: { executeActions }
  };
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    ensureSmartAccount: jest.fn().mockResolvedValue(undefined),
    registerBridgeIn: jest.fn().mockResolvedValue(undefined),
    initiateRow: jest.fn().mockResolvedValue('TX1'),
    updatePhase: jest.fn().mockResolvedValue(undefined),
    startDeliveryPoll: jest.fn(),
    ...overrides
  };
}

describe('gaslessEarnWithdrawalToMiden', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a redeeming row, submits the intent, and returns its txId + nonce', async () => {
    const executeActions = jest.fn().mockResolvedValue({ nonce: 'NONCE1' });
    const deps = baseDeps({ sdk: fakeSdk(executeActions) });

    const result = await gaslessEarnWithdrawalToMiden(validArgs(), deps);

    expect(result).toEqual({ txId: 'TX1', nonce: 'NONCE1', gaslessUsed: true });
    // Row created up front with the parsed atomic amount + destination faucet.
    expect(deps.initiateRow).toHaveBeenCalledWith(
      'mtst1recipient',
      10_000_000n,
      EVM_OWNER,
      MARKET_UID,
      'mtst1native',
      '10',
      'USDC'
    );
    expect(deps.updatePhase).toHaveBeenCalledWith('TX1', 'redeeming', { withdrawIntentNonce: 'NONCE1' });
    expect(deps.registerBridgeIn).toHaveBeenCalledWith(
      EVM_OWNER,
      'NONCE1',
      expect.objectContaining({ provider: 'epoch', earnWithdrawTxId: 'TX1', intentNonce: 'NONCE1' })
    );
    expect(deps.startDeliveryPoll).toHaveBeenCalledWith(expect.objectContaining({ txId: 'TX1', nonce: 'NONCE1' }));
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

  it('marks the row failed when the intent submission throws', async () => {
    const executeActions = jest.fn().mockRejectedValue(new Error('solve boom'));
    const deps = baseDeps({ sdk: fakeSdk(executeActions) });

    await expect(gaslessEarnWithdrawalToMiden(validArgs(), deps)).rejects.toThrow('solve boom');
    expect(deps.initiateRow).toHaveBeenCalled();
    expect(deps.updatePhase).toHaveBeenCalledWith('TX1', 'failed', { error: 'solve boom' });
  });
});

describe('resumeEarnWithdrawal', () => {
  beforeEach(() => jest.clearAllMocks());

  it('re-registers the bridge-in and restarts polling for a submitted redeeming row', async () => {
    (Repo.transactions.where as jest.Mock).mockReturnValue({
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
    });
    const deps = baseDeps();

    await resumeEarnWithdrawal('TX1', deps);

    expect(deps.registerBridgeIn).toHaveBeenCalledWith(
      EVM_OWNER,
      'NONCE1',
      expect.objectContaining({ earnWithdrawTxId: 'TX1' })
    );
    expect(deps.startDeliveryPoll).toHaveBeenCalled();
    expect(deps.updatePhase).not.toHaveBeenCalled();
  });

  it('fails a row that was interrupted before the intent was submitted', async () => {
    (Repo.transactions.where as jest.Mock).mockReturnValue({
      first: jest.fn().mockResolvedValue({
        id: 'TX2',
        type: 'earn-withdraw',
        extraInputs: { phase: 'redeeming', evmOwner: EVM_OWNER, sourceAmount: '10', sourceSymbol: 'USDC' }
      })
    });
    const deps = baseDeps();

    await resumeEarnWithdrawal('TX2', deps);

    expect(deps.updatePhase).toHaveBeenCalledWith(
      'TX2',
      'failed',
      expect.objectContaining({ error: expect.any(String) })
    );
    expect(deps.startDeliveryPoll).not.toHaveBeenCalled();
  });
});

describe('reconcileEarnWithdrawals', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fails rows older than the TTL without resuming them', async () => {
    (Repo.transactions.filter as jest.Mock).mockReturnValue({
      toArray: jest
        .fn()
        .mockResolvedValue([
          { id: 'OLD', type: 'earn-withdraw', initiatedAt: 0, extraInputs: { phase: 'redeeming', evmOwner: EVM_OWNER } }
        ])
    });
    const deps = baseDeps();

    await reconcileEarnWithdrawals(deps);

    expect(deps.updatePhase).toHaveBeenCalledWith(
      'OLD',
      'failed',
      expect.objectContaining({ error: expect.any(String) })
    );
    expect(deps.startDeliveryPoll).not.toHaveBeenCalled();
  });
});

// `./config` is mocked with MIDEN_DESTINATION_CHAIN_ID = 999.
const MIDEN_CHAIN_ID = 999;
const SEPOLIA_CHAIN_ID = 11155111;

describe('pollEarnWithdrawDelivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  const runTick = async (results: unknown[]) => {
    const deps = {
      getSdk: jest.fn().mockResolvedValue({ getIntentStatus: jest.fn().mockResolvedValue(results) }),
      updatePhase: jest.fn().mockResolvedValue(undefined),
      resolveNoteId: jest.fn().mockResolvedValue(undefined)
    };
    pollEarnWithdrawDelivery({ sponsorAddress: EVM_OWNER, nonce: 'NONCE1', txId: 'TX1', intervalMs: 10, deps });
    jest.advanceTimersByTime(10);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
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
    expect(deps.updatePhase).toHaveBeenCalledWith('TX1', 'delivering', { evmTxHash: '0xsource' });
  });

  it('fails on a Miden destination-leg failure', async () => {
    const deps = await runTick([
      { chainId: SEPOLIA_CHAIN_ID, status: 'completed' },
      { chainId: MIDEN_CHAIN_ID, status: 'failed' }
    ]);
    expect(deps.updatePhase).toHaveBeenCalledWith(
      'TX1',
      'failed',
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  it('resolves the bridged note id AFTER the delivery-phase patch', async () => {
    const deps = await runTick([
      { chainId: SEPOLIA_CHAIN_ID, status: 'pending' },
      { chainId: MIDEN_CHAIN_ID, status: 'completed', midenNoteId: '0xnote' }
    ]);
    expect(deps.resolveNoteId).toHaveBeenCalledWith('NONCE1', '0xnote');
    // Ordering is what keeps a `received` flip from being downgraded to `delivering`.
    expect(deps.updatePhase.mock.invocationCallOrder[0]!).toBeLessThan(deps.resolveNoteId.mock.invocationCallOrder[0]!);
  });

  /** Advance one interval and drain the tick's microtasks (mirrors `runTick`). */
  const stepTick = async () => {
    jest.advanceTimersByTime(10);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  };

  it('stops polling after maxAttempts and leaves the row non-terminal for the reconciler', async () => {
    // A withdrawal that never delivers must NOT loop forever, and the give-up is
    // intentionally silent: the row stays `redeeming` so the session reconciler
    // (or the 7-day TTL) owns the terminal decision, not this poller.
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

    // Interval is cleared on the maxAttempts-th tick: more time does not poll again.
    await stepTick();
    expect(getIntentStatus).toHaveBeenCalledTimes(maxAttempts);
    // No terminal phase was written on timeout — the row is deliberately left for the reconciler.
    expect(deps.updatePhase).not.toHaveBeenCalled();
  });

  it('survives a transient getIntentStatus error and completes on a later tick', async () => {
    // The per-tick try/catch must swallow a flaky RPC/SDK reject and keep the
    // interval alive — a thrown error must NOT clear the poll or fail the row.
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

    // Second tick sees a terminal result — proving the interval was never cleared.
    await stepTick();
    expect(getIntentStatus).toHaveBeenCalledTimes(2);
    expect(deps.updatePhase).toHaveBeenCalledWith('TX1', 'delivering', { evmTxHash: '0xsource' });
  });
});

describe('resubmitEarnWithdrawal', () => {
  beforeEach(() => jest.clearAllMocks());

  const failedRow = (extraInputs: Record<string, unknown> = {}) => ({
    id: 'TX1',
    type: 'earn-withdraw',
    accountId: 'mtst1recipient',
    extraInputs: {
      phase: 'failed',
      evmOwner: EVM_OWNER,
      marketUid: MARKET_UID,
      sourceAmount: '10',
      sourceSymbol: 'USDC',
      withdrawIntentNonce: 'DEAD_NONCE',
      error: 'The withdrawal intent failed on Epoch.',
      ...extraInputs
    }
  });

  /** Mock `Repo.transactions.where` for both the read and the phase reset. */
  const mockRow = (row: unknown) => {
    const modify = jest.fn(async (fn: (tx: { extraInputs: Record<string, unknown>; error?: string }) => void) => {
      fn(row as { extraInputs: Record<string, unknown>; error?: string });
      return 1;
    });
    (Repo.transactions.where as jest.Mock).mockReturnValue({ first: jest.fn().mockResolvedValue(row), modify });
    return modify;
  };

  it('submits a brand new intent on the same row', async () => {
    const row = failedRow();
    const modify = mockRow(row);
    const executeActions = jest.fn().mockResolvedValue({ nonce: 'FRESH_NONCE' });
    const deps = baseDeps({ sdk: fakeSdk(executeActions) });
    // The row is reused, so no new row is created.
    delete (deps as { initiateRow?: unknown }).initiateRow;

    await resubmitEarnWithdrawal('TX1', deps);

    // Terminal state cleared before the flow re-runs.
    expect(modify).toHaveBeenCalled();
    expect(row.extraInputs.phase).toBe('redeeming');
    expect(row.extraInputs.withdrawIntentNonce).toBeUndefined();
    expect(row.extraInputs.error).toBeUndefined();
    // A genuinely new intent, and the row keeps its id.
    expect(executeActions).toHaveBeenCalled();
    expect(deps.updatePhase).toHaveBeenCalledWith('TX1', 'redeeming', { withdrawIntentNonce: 'FRESH_NONCE' });
    expect(deps.registerBridgeIn).toHaveBeenCalledWith(
      EVM_OWNER,
      'FRESH_NONCE',
      expect.objectContaining({ earnWithdrawTxId: 'TX1' })
    );
  });

  it('resubmits a row that never reached Epoch (no nonce recorded)', async () => {
    const row = failedRow({ withdrawIntentNonce: undefined });
    mockRow(row);
    const executeActions = jest.fn().mockResolvedValue({ nonce: 'FRESH_NONCE' });
    const deps = baseDeps({ sdk: fakeSdk(executeActions) });
    delete (deps as { initiateRow?: unknown }).initiateRow;

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

  it('refuses a row missing the market details needed to rebuild the request', async () => {
    mockRow(failedRow({ marketUid: '' }));
    const deps = baseDeps({ sdk: fakeSdk(jest.fn()) });

    await expect(resubmitEarnWithdrawal('TX1', deps)).rejects.toThrow(/market details/);
  });

  it('re-marks the row failed when the fresh intent also fails', async () => {
    const row = failedRow();
    mockRow(row);
    const executeActions = jest.fn().mockRejectedValue(new Error('still broke'));
    const deps = baseDeps({ sdk: fakeSdk(executeActions) });
    delete (deps as { initiateRow?: unknown }).initiateRow;

    await expect(resubmitEarnWithdrawal('TX1', deps)).rejects.toThrow('still broke');
    expect(deps.updatePhase).toHaveBeenCalledWith('TX1', 'failed', { error: 'still broke' });
  });
});

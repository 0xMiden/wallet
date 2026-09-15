import {
  EpochIntentSDK,
  type ExecuteActionOptions,
  type IntentTransactionStatus,
  type CompactRequest,
  type CompactResponse
} from '@epoch-protocol/epoch-intents-sdk';
import { createWalletClient, http } from 'viem';

import type {
  initiateEarnWithdrawTransaction,
  markEarnWithdrawAccepted,
  markEarnWithdrawNotSent,
  prepareEarnWithdrawExecution,
  updateEarnWithdrawPhase
} from 'lib/miden/activity';
import { ITransactionStatus, type ITransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { createEarnSubmissionLocks } from './earn-submission-lock';
import {
  gaslessEarnWithdrawalToMiden,
  pollEarnWithdrawDelivery,
  resumeEarnWithdrawal,
  retryEarnWithdrawal,
  resubmitEarnWithdrawal
} from './earn-withdraw';
import {
  earnWithdrawalRetryKind,
  earnWithdrawExecutionIdentity,
  selectEarnWithdrawPreparedExecution
} from './earn-withdraw-policy';
import { EPOCH_INTENT_STATUS_TIMEOUT_MS } from './intent-status';
import { createIntentPollCoordinator, type IntentPollOptions } from './poll-registry';
import { deferred, SharedEarnLocks } from './testing/earn-locks';
import { preparedExecution, PREPARED_FAUCET, PREPARED_OWNER, PREPARED_RECIPIENT } from './testing/earn-prepared';

jest.mock('@epoch-protocol/epoch-intents-sdk', () => ({
  ...jest.requireActual('@epoch-protocol/epoch-intents-sdk'),
  EpochIntentSDK: class {}
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
  findPendingBridgeInByEarnWithdrawTxId: jest.fn(),
  prepareEarnWithdrawExecution: jest.fn(),
  markEarnWithdrawNotSent: jest.fn(),
  markEarnWithdrawAccepted: jest.fn(),
  updateEarnDepositStatus: jest.fn()
}));
jest.mock('lib/miden/repo', () => ({ transactions: { where: jest.fn(), filter: jest.fn() } }));

const args = {
  midenAccountPublicKey: PREPARED_RECIPIENT,
  evmAddress: PREPARED_OWNER,
  marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
  underlyingAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
  amount: '10',
  underlyingDecimals: 18
};

function harness() {
  const row: ITransaction = {
    id: 'row-1',
    type: 'earn-withdraw',
    accountId: PREPARED_RECIPIENT,
    status: ITransactionStatus.Completed,
    initiatedAt: 1,
    displayIcon: 'DEFAULT',
    extraInputs: {
      evmOwner: PREPARED_OWNER,
      marketUid: args.marketUid,
      sourceAmount: '10',
      sourceSymbol: 'USDC',
      destinationFaucetId: PREPARED_FAUCET,
      phase: 'redeeming',
      submissionState: 'preparing',
      submissionAttemptId: 'attempt-1'
    }
  };
  const first = jest.fn(async () => ({ ...row, extraInputs: { ...row.extraInputs } }));
  const modify = jest.fn(async (change: (current: ITransaction) => void) => {
    change(row);
    return 1;
  });
  jest.mocked(Repo.transactions.where).mockImplementation(jest.fn().mockReturnValue({ first, modify }));
  jest.mocked(Repo.transactions.filter).mockImplementation(jest.fn().mockReturnValue({ toArray: async () => [row] }));
  const sharedLocks = new SharedEarnLocks();
  const locks = createEarnSubmissionLocks({ getLocks: () => sharedLocks });
  const initiateRow: typeof initiateEarnWithdrawTransaction = async (
    _a,
    _b,
    _c,
    _d,
    _e,
    _f,
    _g,
    attemptId,
    startedAt
  ) => {
    row.extraInputs.submissionAttemptId = attemptId;
    row.extraInputs.attemptStartedAt = startedAt;
    return row.id;
  };
  const prepareExecution: typeof prepareEarnWithdrawExecution = async (_id, execution, expected, isCurrent) => {
    if (!isCurrent() || expected.attemptId !== row.extraInputs.submissionAttemptId) return false;
    row.extraInputs.preparedExecution = execution;
    row.extraInputs.withdrawIntentNonce = execution.delivery.nonce;
    row.extraInputs.submissionState = 'prepared';
    return true;
  };
  const markNotSent: typeof markEarnWithdrawNotSent = async (_id, error, _expected, _execution, mayConfirm) => {
    if (!mayConfirm()) return false;
    row.extraInputs = {
      ...row.extraInputs,
      submissionState: 'preparing',
      preparedExecution: undefined,
      withdrawIntentNonce: undefined,
      phase: 'failed',
      error
    };
    return true;
  };
  const markAccepted: typeof markEarnWithdrawAccepted = async (_id, _expected, isCurrent) => {
    if (!isCurrent()) return false;
    row.extraInputs.submissionState = 'accepted';
    return true;
  };
  const updatePhase: typeof updateEarnWithdrawPhase = async (_id, phase, extra) => {
    row.extraInputs = { ...row.extraInputs, ...extra, phase };
  };
  const relay = jest.fn();
  const executeActions = jest.fn(async (options: ExecuteActionOptions) => {
    await options.onBeforeExecute?.(preparedExecution());
    relay();
    return { nonce: '11', hash: 'hash', signature: 'signature', digest: 'digest' };
  });
  const getIntentStatus = jest.fn<Promise<IntentTransactionStatus[]>, [string, string, AbortSignal?]>(async () => []);
  const retryIntentSolve = jest.fn<Promise<CompactResponse>, [CompactRequest]>(async () => ({
    hash: 'hash',
    signature: 'sig',
    digest: 'digest'
  }));
  const sdk = Object.assign(
    new EpochIntentSDK({
      apiBaseUrl: 'http://local.test',
      walletClient: createWalletClient({ transport: http('http://local.test') })
    }),
    {
      getWalletGaslessStatus: jest.fn().mockResolvedValue({ is7702Capable: true, needsSetup: false }),
      helpers: { executeActions },
      getIntentStatus,
      retryIntentSolve
    }
  );
  const deps = {
    sdk,
    initiateRow,
    prepareExecution,
    markNotSent,
    markAccepted,
    updatePhase,
    ensureSmartAccount: jest.fn().mockResolvedValue(undefined),
    registerBridgeIn: jest.fn().mockResolvedValue(undefined),
    startDeliveryPoll: jest.fn(),
    withSubmissionLock: locks.withEarnSubmissionLock
  };
  return { row, first, locks, sharedLocks, relay, executeActions, deps, sdk, getIntentStatus, retryIntentSolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it('durably prepares all allocations before source execution and selects the second nonce', async () => {
  const h = harness();
  h.relay.mockImplementation(() => {
    expect(h.row.extraInputs.submissionState).toBe('prepared');
    expect(h.row.extraInputs.withdrawIntentNonce).toBe('22');
    expect(h.row.extraInputs.preparedExecution.allocations).toEqual(preparedExecution().allocations);
  });
  await expect(gaslessEarnWithdrawalToMiden(args, h.deps)).resolves.toMatchObject({ nonce: '22' });
  expect(h.row.extraInputs.submissionState).toBe('accepted');
  expect(h.deps.startDeliveryPoll).toHaveBeenCalledWith(
    expect.objectContaining({ nonce: '22', bridgeInfo: expect.any(Object) })
  );
  h.locks.dispose();
});

it('keeps a post-permission SDK rejection protected and polling', async () => {
  const h = harness();
  h.executeActions.mockImplementation(async options => {
    await options.onBeforeExecute?.(preparedExecution());
    h.relay();
    throw new Error('allocation delivery failed');
  });
  await expect(gaslessEarnWithdrawalToMiden(args, h.deps)).rejects.toThrow('allocation delivery failed');
  expect(h.row.extraInputs.submissionState).toBe('prepared');
  expect(h.row.extraInputs.phase).toBe('redeeming');
  expect(earnWithdrawalRetryKind(h.row)).toBeUndefined();
  expect(h.deps.startDeliveryPoll).toHaveBeenCalledTimes(1);
  h.locks.dispose();
});

it.each([true, false])(
  'only successful known-not-sent cleanup allows source retry after readback fails: %s',
  async cleanup => {
    const h = harness();
    h.first.mockRejectedValueOnce(new Error('readback failed'));
    const markNotSent = cleanup ? h.deps.markNotSent : async () => false;
    await expect(gaslessEarnWithdrawalToMiden(args, { ...h.deps, markNotSent })).rejects.toThrow('readback failed');
    expect(h.relay).not.toHaveBeenCalled();
    expect(earnWithdrawalRetryKind(h.row)).toBe(cleanup ? 'source' : undefined);
    expect(h.row.extraInputs.submissionState).toBe(cleanup ? 'preparing' : 'prepared');
    h.locks.dispose();
  }
);

it('survives owner disposal after acceptance without authorizing a second source execution', async () => {
  const h = harness();
  const response = deferred<void>();
  h.executeActions.mockImplementation(async options => {
    await options.onBeforeExecute?.(preparedExecution());
    h.relay();
    await response.promise;
    return { nonce: '11', hash: 'hash', signature: 'signature', digest: 'digest' };
  });
  const submission = gaslessEarnWithdrawalToMiden(args, h.deps);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(h.relay).toHaveBeenCalledTimes(1);
  h.locks.dispose();
  response.resolve();
  await expect(submission).rejects.toThrow('disposed');
  expect(earnWithdrawalRetryKind(h.row)).toBeUndefined();
  const startDeliveryPoll = jest.fn();
  await resumeEarnWithdrawal(h.row.id, {
    startDeliveryPoll,
    tryWithSubmissionLock: createEarnSubmissionLocks().tryWithEarnSubmissionLock
  });
  expect(startDeliveryPoll).toHaveBeenCalledWith(expect.objectContaining({ nonce: '22' }));
});

function preparedHarness(overrides: Parameters<typeof pollEarnWithdrawDelivery>[0]['deps'] = {}) {
  const h = harness();
  const identity = earnWithdrawExecutionIdentity(h.row);
  if (!identity) throw new Error('fixture identity');
  h.row.extraInputs.preparedExecution = selectEarnWithdrawPreparedExecution(preparedExecution(), identity);
  h.row.extraInputs.withdrawIntentNonce = '22';
  h.row.extraInputs.submissionState = 'prepared';
  let options: IntentPollOptions | undefined;
  pollEarnWithdrawDelivery({
    sponsorAddress: PREPARED_OWNER,
    nonce: '22',
    txId: h.row.id,
    attemptId: 'attempt-1',
    deps: {
      getSdk: async () => h.sdk,
      updatePhase: h.deps.updatePhase,
      markAccepted: h.deps.markAccepted,
      startPoll: value => {
        options = value;
      },
      registerBridgeIn: h.deps.registerBridgeIn,
      tryWithSubmissionLock: h.locks.tryWithEarnSubmissionLock,
      ...overrides
    }
  });
  const context = { isCurrent: () => true, markTerminal: jest.fn() };
  const tick = async () => {
    if (!options) throw new Error('poll missing');
    await options.tick(context);
    for (let i = 0; i < 60; i++) await Promise.resolve();
  };
  return { ...h, tick, context };
}

it('continues independent sibling repair after selected receipt is durable', async () => {
  const h = preparedHarness();
  h.row.extraInputs.phase = 'received';
  h.row.extraInputs.midenNoteId = 'note';
  await h.tick();
  expect(h.retryIntentSolve).toHaveBeenCalledWith(JSON.parse(preparedExecution().allocations[0]!.requestJson));
  expect(h.getIntentStatus.mock.calls.map(([owner, nonce]) => [owner, nonce])).not.toContainEqual([
    PREPARED_OWNER,
    '22'
  ]);
  expect(h.row.extraInputs.phase).toBe('received');
  expect(h.row.extraInputs.submissionState).toBe('accepted');
});

it('does not let a hung sibling block selected status or the selected allocation repair', async () => {
  const h = preparedHarness();
  const pending = deferred<never>();
  h.getIntentStatus.mockImplementation((_owner, nonce) => (nonce === '11' ? pending.promise : Promise.resolve([])));
  await h.tick();
  expect(h.getIntentStatus).toHaveBeenCalledWith(PREPARED_OWNER, '22', expect.any(AbortSignal));
  expect(h.retryIntentSolve).toHaveBeenCalledWith(JSON.parse(preparedExecution().allocations[1]!.requestJson));
  expect(h.row.extraInputs.submissionState).toBe('prepared');
});

it('repairs a sibling whose status request never answers once that request times out', async () => {
  jest.useFakeTimers();
  try {
    const h = preparedHarness();
    const pending = deferred<never>();
    h.getIntentStatus.mockImplementation((_owner, nonce) => (nonce === '11' ? pending.promise : Promise.resolve([])));
    const sibling = JSON.parse(preparedExecution().allocations[0]!.requestJson);
    await h.tick();
    expect(h.retryIntentSolve).not.toHaveBeenCalledWith(sibling);
    await jest.advanceTimersByTimeAsync(EPOCH_INTENT_STATUS_TIMEOUT_MS);
    for (let i = 0; i < 60; i++) await Promise.resolve();
    expect(h.retryIntentSolve).toHaveBeenCalledWith(sibling);
  } finally {
    jest.useRealTimers();
  }
});

it('repairs a sibling independently while the selected status request is hung', async () => {
  const h = preparedHarness();
  const pending = deferred<never>();
  h.getIntentStatus.mockImplementation((_owner, nonce) => (nonce === '22' ? pending.promise : Promise.resolve([])));
  await h.tick();
  expect(h.retryIntentSolve).toHaveBeenCalledWith(JSON.parse(preparedExecution().allocations[0]!.requestJson));
  expect(h.row.extraInputs.submissionState).toBe('prepared');
});

it('revalidates the exact prepared payload after status before allocating', async () => {
  const h = preparedHarness();
  const pending = deferred<IntentTransactionStatus[]>();
  h.getIntentStatus.mockImplementation(() => pending.promise);
  await h.tick();
  h.row.extraInputs.preparedExecution = undefined;
  pending.resolve([]);
  for (let i = 0; i < 60; i++) await Promise.resolve();
  expect(h.retryIntentSolve).not.toHaveBeenCalled();
});

it('rejects expired preparation before source execution while allowing known-not-sent cleanup', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(2_000_000_000_000);
  const h = harness();
  await expect(gaslessEarnWithdrawalToMiden(args, h.deps)).rejects.toThrow('expired before execution');
  expect(h.relay).not.toHaveBeenCalled();
  expect(earnWithdrawalRetryKind(h.row)).toBe('source');
  h.locks.dispose();
  jest.useRealTimers();
});

it('refuses execution when the current row destination changes during preparation readback', async () => {
  const h = harness();
  h.first.mockImplementation(async () => ({
    ...h.row,
    accountId: PREPARED_FAUCET,
    extraInputs: { ...h.row.extraInputs }
  }));
  await expect(gaslessEarnWithdrawalToMiden(args, h.deps)).rejects.toThrow('could not be verified');
  expect(h.relay).not.toHaveBeenCalled();
  h.locks.dispose();
});

it('does not duplicate an explicit allocation retry while automatic recovery is already active', async () => {
  const h = preparedHarness();
  const response = deferred<{ hash: string; signature: string; digest: string }>();
  h.row.extraInputs.phase = 'failed';
  h.retryIntentSolve.mockImplementation(() => response.promise);
  const retry = retryEarnWithdrawal(h.row.id, { ...h.deps, getSdk: async () => h.sdk });
  for (let i = 0; i < 60; i++) await Promise.resolve();
  await h.tick();
  expect(h.retryIntentSolve.mock.calls.filter(call => call[0]?.compact.nonce === '22')).toHaveLength(1);
  response.resolve({ hash: 'hash', signature: 'sig', digest: 'digest' });
  await retry;
  h.locks.dispose();
});

it.each(['11', '22'])(
  'repairs response loss for allocation %s independently and only acknowledges positive status',
  async lostNonce => {
    const h = preparedHarness();
    h.getIntentStatus.mockImplementation(async (_owner, nonce) =>
      nonce === lostNonce
        ? []
        : [{ chainId: nonce === '22' ? 999999999 : 11155111, status: 'pending', transactionHash: '' }]
    );
    await h.tick();
    const original = preparedExecution().allocations.find(item => item.nonce === lostNonce);
    expect(h.retryIntentSolve).toHaveBeenCalledTimes(1);
    expect(h.retryIntentSolve).toHaveBeenCalledWith(JSON.parse(original!.requestJson));
    expect(h.row.extraInputs.submissionState).toBe('accepted');
    await h.tick();
    await h.tick();
    expect(h.retryIntentSolve).toHaveBeenCalledTimes(1);
  }
);

it.each(['11', '22'])(
  'keeps the accepted sibling when allocation %s rejects and backs off from completion',
  async failedNonce => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const h = preparedHarness();
    const firstResponse = deferred<never>();
    h.getIntentStatus.mockImplementation(async (_owner, nonce) =>
      nonce === failedNonce
        ? []
        : [{ chainId: nonce === '22' ? 999999999 : 11155111, status: 'pending', transactionHash: '' }]
    );
    h.retryIntentSolve.mockImplementationOnce(() => firstResponse.promise).mockRejectedValue(new Error('offline'));
    await h.tick();
    jest.setSystemTime(7_000);
    firstResponse.reject(new Error('offline'));
    for (let i = 0; i < 60; i++) await Promise.resolve();
    let due = 7_000;
    for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      const calls = h.retryIntentSolve.mock.calls.length;
      due += delay;
      jest.setSystemTime(due - 1);
      await h.tick();
      expect(h.retryIntentSolve).toHaveBeenCalledTimes(calls);
      jest.setSystemTime(due);
      await h.tick();
      expect(h.retryIntentSolve).toHaveBeenCalledTimes(calls + 1);
    }
    expect(h.row.extraInputs.submissionState).toBe('prepared');
    jest.useRealTimers();
  }
);

it('polls the selected status while metadata repair rejects', async () => {
  const h = harness();
  let options: IntentPollOptions | undefined;
  const registration = jest.fn().mockRejectedValue(new Error('storage offline'));
  pollEarnWithdrawDelivery({
    sponsorAddress: PREPARED_OWNER,
    nonce: '22',
    txId: h.row.id,
    attemptId: 'attempt-1',
    bridgeInfo: { provider: 'epoch' },
    deps: {
      getSdk: async () => h.sdk,
      registerBridgeIn: registration,
      updatePhase: h.deps.updatePhase,
      startPoll: value => {
        options = value;
      }
    }
  });
  if (!options) throw new Error('poll missing');
  await options.tick({ isCurrent: () => true, markTerminal: jest.fn() });
  expect(registration).toHaveBeenCalledTimes(1);
  expect(h.getIntentStatus).toHaveBeenCalledWith(PREPARED_OWNER, '22', expect.any(AbortSignal));
});

it('preserves a terminal phase write rejection when note resolution also rejects', async () => {
  const h = harness();
  let options: IntentPollOptions | undefined;
  const delivered = [{ chainId: 999999999, status: 'completed', transactionHash: 'hash', midenNoteId: 'note' }];
  h.getIntentStatus.mockResolvedValue(delivered);
  const phaseError = new Error('phase write');
  const resolveNoteId = jest.fn().mockRejectedValue(new Error('note write'));
  pollEarnWithdrawDelivery({
    sponsorAddress: PREPARED_OWNER,
    nonce: '22',
    txId: h.row.id,
    attemptId: 'attempt-1',
    deps: {
      getSdk: async () => h.sdk,
      updatePhase: async () => {
        throw phaseError;
      },
      resolveNoteId,
      startPoll: value => {
        options = value;
      }
    }
  });
  if (!options) throw new Error('poll missing');
  await expect(options.tick({ isCurrent: () => true, markTerminal: jest.fn() })).rejects.toBe(phaseError);
  expect(resolveNoteId).toHaveBeenCalledWith(PREPARED_OWNER, '22', 'note');
});

it.each(['reject', 'refuse'])('a successor repairs aggregate acceptance after its writer %s', async outcome => {
  const markAccepted = jest.fn(async () => {
    if (outcome === 'reject') throw new Error('storage');
    return false;
  });
  const h = preparedHarness({ markAccepted });
  await h.tick();
  expect(h.row.extraInputs.submissionState).toBe('prepared');
  let options: IntentPollOptions | undefined;
  h.getIntentStatus.mockImplementation(async (_owner, nonce) => [
    { chainId: nonce === '22' ? 999999999 : 11155111, status: 'pending', transactionHash: '' }
  ]);
  pollEarnWithdrawDelivery({
    sponsorAddress: PREPARED_OWNER,
    nonce: '22',
    txId: h.row.id,
    attemptId: 'attempt-1',
    deps: {
      getSdk: async () => h.sdk,
      markAccepted: h.deps.markAccepted,
      startPoll: value => {
        options = value;
      }
    }
  });
  if (!options) throw new Error('poll missing');
  await options.tick({ isCurrent: () => true, markTerminal: jest.fn() });
  for (let i = 0; i < 60; i++) await Promise.resolve();
  expect(h.row.extraInputs.submissionState).toBe('accepted');
  expect(h.retryIntentSolve).toHaveBeenCalledTimes(2);
});

it('retries only the selected prepared request and direct source resubmission stays unavailable', async () => {
  const h = preparedHarness();
  h.row.extraInputs.phase = 'failed';
  h.row.extraInputs.submissionState = 'accepted';
  const before = { ...h.row.extraInputs };
  const initiatedAt = h.row.initiatedAt;
  await resubmitEarnWithdrawal(h.row.id, h.deps);
  expect(h.executeActions).not.toHaveBeenCalled();
  await retryEarnWithdrawal(h.row.id, { ...h.deps, getSdk: async () => h.sdk });
  await retryEarnWithdrawal(h.row.id, { ...h.deps, getSdk: async () => h.sdk });
  expect(h.retryIntentSolve).toHaveBeenCalledTimes(1);
  expect(h.retryIntentSolve).toHaveBeenCalledWith(JSON.parse(preparedExecution().allocations[1]!.requestJson));
  expect(h.row.extraInputs).toEqual({ ...before, phase: 'redeeming', error: undefined });
  expect(h.row.initiatedAt).toBe(initiatedAt);
  expect(h.executeActions).not.toHaveBeenCalled();
});

it('a second realm recovers the parked prepared execution after its owner closes with one source execution', async () => {
  const h = harness();
  const relayResponse = deferred<void>();
  const secondSubmission = createEarnSubmissionLocks({ getLocks: () => h.sharedLocks });
  const secondPoll = createIntentPollCoordinator({ getLocks: () => h.sharedLocks });
  h.executeActions.mockImplementation(async options => {
    await options.onBeforeExecute?.(preparedExecution());
    h.relay();
    await relayResponse.promise;
    return { nonce: '11', hash: 'hash', signature: 'signature', digest: 'digest' };
  });
  const source = gaslessEarnWithdrawalToMiden(args, h.deps);
  for (let i = 0; i < 60; i++) await Promise.resolve();
  const deps = {
    getSdk: async () => h.sdk,
    markAccepted: h.deps.markAccepted,
    updatePhase: h.deps.updatePhase,
    registerBridgeIn: h.deps.registerBridgeIn,
    tryWithSubmissionLock: secondSubmission.tryWithEarnSubmissionLock,
    startPoll: secondPoll.startIntentPoll
  };
  await resumeEarnWithdrawal(h.row.id, deps);
  expect(h.getIntentStatus).not.toHaveBeenCalled();
  h.locks.dispose();
  await expect(source).rejects.toThrow('disposed');
  await resumeEarnWithdrawal(h.row.id, deps);
  for (let i = 0; i < 50; i++) await Promise.resolve();
  expect(h.retryIntentSolve).toHaveBeenCalledTimes(2);
  expect(h.row.extraInputs.submissionState).toBe('accepted');
  expect(h.relay).toHaveBeenCalledTimes(1);
  expect(h.executeActions).toHaveBeenCalledTimes(1);
  secondPoll.dispose();
  secondSubmission.dispose();
  relayResponse.resolve();
});

import { updateEarnDepositStatus } from 'lib/miden/activity';
import * as Repo from 'lib/miden/repo';

import { getCurrentMidenBlock } from './chain';
import {
  EARN_DESTINATION_CHAIN_ID,
  openEarnPosition,
  pollEarnIntentStatus,
  reconcileEarnDeposits,
  resolveEarnIntentOutcome
} from './earn';
import { clearPollRegistryForTests, createIntentPollCoordinator } from './poll-registry';
import { getEpochReadOnlySdk } from './sdk';
import { deferred, SharedEarnLocks } from './testing/earn-locks';

jest.mock('@epoch-protocol/epoch-intents-sdk', () => ({
  CollateralType: { Miden: 'Miden' },
  EpochIntentSDK: class {},
  TaskType: { ProtocolInteraction: 'ProtocolInteraction' }
}));
jest.mock('./bridge', () => ({ normalizeMidenIdToHex: (v: string) => v }));
jest.mock('./chain', () => ({
  getCurrentMidenBlock: jest.fn(),
  MIDEN_MIN_RECLAIM_BLOCKS: 100,
  MIDEN_RECLAIM_BUFFER_BLOCKS: 10
}));
jest.mock('./earn-note', () => ({ createEarnP2IDENote: jest.fn() }));
jest.mock('./sdk', () => ({ getEpochReadOnlySdk: jest.fn() }));
jest.mock('lib/miden/activity', () => ({ updateEarnDepositStatus: jest.fn() }));
jest.mock('lib/miden/repo', () => ({ transactions: { filter: jest.fn(), where: jest.fn() } }));

const SEPOLIA = EARN_DESTINATION_CHAIN_ID;
const MIDEN_CHAIN = 999;
const SPONSOR = '0x1111111111111111111111111111111111111111';

/**
 * The gating is asymmetric on purpose: only the DESTINATION leg can declare
 * success, because a completed SOURCE leg just means the collateral was picked
 * up — the leg it pays for may still be pending, or may yet fail.
 */
describe('resolveEarnIntentOutcome', () => {
  it('is done only when the destination leg reports terminal success', () => {
    const { outcome, destination } = resolveEarnIntentOutcome(
      [
        { chainId: MIDEN_CHAIN, status: 'pending' },
        { chainId: SEPOLIA, status: 'completed', transactionHash: '0xdest' }
      ],
      SEPOLIA
    );
    expect(outcome).toBe('done');
    expect(destination?.transactionHash).toBe('0xdest');
  });

  it('stays pending when only the source leg completed (no last-entry fallback)', () => {
    // The old code read "any leg done ⇒ done", which settled the row on the
    // source leg alone. The destination entry here is the LAST entry too, so a
    // last-entry fallback would also have been wrong.
    const { outcome } = resolveEarnIntentOutcome(
      [
        { chainId: MIDEN_CHAIN, status: 'completed' },
        { chainId: SEPOLIA, status: 'pending' }
      ],
      SEPOLIA
    );
    expect(outcome).toBe('pending');
  });

  it('stays pending when the destination leg has not appeared yet', () => {
    const { outcome, destination } = resolveEarnIntentOutcome([{ chainId: MIDEN_CHAIN, status: 'completed' }], SEPOLIA);
    expect(outcome).toBe('pending');
    expect(destination).toBeUndefined();
  });

  it('fails on a destination-leg failure', () => {
    const { outcome } = resolveEarnIntentOutcome(
      [
        { chainId: MIDEN_CHAIN, status: 'completed' },
        { chainId: SEPOLIA, status: 'reverted' }
      ],
      SEPOLIA
    );
    expect(outcome).toBe('failed');
  });

  it('fails on a terminal failure of ANY leg — a reverted source can never be filled', () => {
    const { outcome } = resolveEarnIntentOutcome(
      [
        { chainId: MIDEN_CHAIN, status: 'failed' },
        { chainId: SEPOLIA, status: 'pending' }
      ],
      SEPOLIA
    );
    expect(outcome).toBe('failed');
  });

  it('matches statuses case-insensitively and treats an empty result set as pending', () => {
    expect(resolveEarnIntentOutcome([{ chainId: SEPOLIA, status: 'COMPLETED' }], SEPOLIA).outcome).toBe('done');
    expect(resolveEarnIntentOutcome([], SEPOLIA).outcome).toBe('pending');
  });

  it('picks the first non-destination entry as the source leg', () => {
    const { source } = resolveEarnIntentOutcome(
      [
        { chainId: MIDEN_CHAIN, status: 'completed', transactionHash: '0xsource' },
        { chainId: SEPOLIA, status: 'completed' }
      ],
      SEPOLIA
    );
    expect(source?.transactionHash).toBe('0xsource');
  });
});

const mockGetSdk = getEpochReadOnlySdk as jest.MockedFunction<typeof getEpochReadOnlySdk>;
const mockUpdateStatus = updateEarnDepositStatus as jest.MockedFunction<typeof updateEarnDepositStatus>;

function sdkReturning(results: unknown[]) {
  const getIntentStatus = jest.fn().mockResolvedValue(results);
  mockGetSdk.mockResolvedValue({ getIntentStatus } as never);
  return getIntentStatus;
}

describe('pollEarnIntentStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    clearPollRegistryForTests();
    wireRows([depositRow()]);
  });
  afterEach(() => {
    clearPollRegistryForTests();
    jest.useRealTimers();
  });

  const runTick = async (results: unknown[]) => {
    sdkReturning(results);
    pollEarnIntentStatus({ sponsorAddress: SPONSOR, nonce: 'N1', txId: 'TX1', intervalMs: 10 });
    await jest.advanceTimersByTimeAsync(10);
  };

  it('does not query an intent whose persisted row became restored before the first tick', async () => {
    wireRows([depositRow({ restoredFromBackup: true })]);
    const status = sdkReturning([{ chainId: SEPOLIA, status: 'completed' }]);
    pollEarnIntentStatus({ sponsorAddress: SPONSOR, nonce: 'N1', txId: 'TX1', intervalMs: 10 });
    await jest.advanceTimersByTimeAsync(10);
    expect(status).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it('does not settle the row while only the Miden source leg completed', async () => {
    await runTick([
      { chainId: MIDEN_CHAIN, status: 'completed' },
      { chainId: SEPOLIA, status: 'pending' }
    ]);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it('confirms with the destination hash once the Sepolia leg settles', async () => {
    await runTick([
      { chainId: MIDEN_CHAIN, status: 'completed', transactionHash: '0xsource' },
      { chainId: SEPOLIA, status: 'completed', transactionHash: '0xdest' }
    ]);
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      'TX1',
      'confirmed',
      { evmTxHash: '0xdest' },
      { owner: SPONSOR, nonce: 'N1' }
    );
  });

  it('falls back to the source hash on a source-side failure', async () => {
    await runTick([{ chainId: MIDEN_CHAIN, status: 'failed', transactionHash: '0xsource' }]);
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      'TX1',
      'failed',
      { evmTxHash: '0xsource' },
      { owner: SPONSOR, nonce: 'N1' }
    );
  });

  it('is a no-op when a poll for the same nonce is already live', async () => {
    const getIntentStatus = sdkReturning([{ chainId: SEPOLIA, status: 'pending' }]);
    pollEarnIntentStatus({ sponsorAddress: SPONSOR, nonce: 'N1', txId: 'TX1', intervalMs: 10 });
    pollEarnIntentStatus({ sponsorAddress: SPONSOR, nonce: 'N1', txId: 'TX1', intervalMs: 10 });
    await jest.advanceTimersByTimeAsync(10);
    expect(getIntentStatus).toHaveBeenCalledTimes(1);
  });

  it('releases the nonce key on a terminal outcome so a later kick can restart', async () => {
    await runTick([{ chainId: SEPOLIA, status: 'completed', transactionHash: '0xdest' }]);
    const getIntentStatus = sdkReturning([{ chainId: SEPOLIA, status: 'pending' }]);
    pollEarnIntentStatus({ sponsorAddress: SPONSOR, nonce: 'N1', txId: 'TX1', intervalMs: 10 });
    await jest.advanceTimersByTimeAsync(10);
    expect(getIntentStatus).toHaveBeenCalledTimes(1);
  });

  it('keeps ownership through the cooldown after a bounded burst', async () => {
    const getIntentStatus = sdkReturning([{ chainId: SEPOLIA, status: 'pending' }]);
    pollEarnIntentStatus({ sponsorAddress: SPONSOR, nonce: 'N1', txId: 'TX1', intervalMs: 10, maxAttempts: 1 });
    await jest.advanceTimersByTimeAsync(10);
    expect(getIntentStatus).toHaveBeenCalledTimes(1);
    pollEarnIntentStatus({ sponsorAddress: SPONSOR, nonce: 'N1', txId: 'TX1', intervalMs: 10 });
    await jest.advanceTimersByTimeAsync(29_999);
    expect(getIntentStatus).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(getIntentStatus).toHaveBeenCalledTimes(2);
  });

  const staleRows: Array<[string, () => DepositRow[]]> = [
    [
      'terminal',
      () => [depositRow({ extraInputs: { epochStatus: 'confirmed', evmRecipient: SPONSOR, intentNonce: 'N1' } })]
    ],
    ['restored', () => [depositRow({ restoredFromBackup: true })]],
    ['deleted', () => []],
    ['wrong type', () => [depositRow({ type: 'send' })]],
    [
      'owner changed',
      () => [
        depositRow({
          extraInputs: {
            epochStatus: 'pending',
            evmRecipient: '0x2222222222222222222222222222222222222222',
            intentNonce: 'N1'
          }
        })
      ]
    ],
    [
      'nonce changed',
      () => [depositRow({ extraInputs: { epochStatus: 'pending', evmRecipient: SPONSOR, intentNonce: 'N2' } })]
    ]
  ];

  it.each(staleRows)('does not query a %s row before a request', async (_kind, replacement) => {
    wireRows(replacement());
    const getIntentStatus = sdkReturning([{ chainId: SEPOLIA, status: 'completed' }]);
    pollEarnIntentStatus({ sponsorAddress: SPONSOR, nonce: 'N1', txId: 'TX1', intervalMs: 10 });
    await jest.advanceTimersByTimeAsync(10);
    expect(getIntentStatus).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it.each(staleRows)('discards a status response after the row becomes %s', async (_kind, replacement) => {
    const response = deferred<unknown[]>();
    const getIntentStatus = sdkReturning([]);
    getIntentStatus.mockReturnValue(response.promise);
    pollEarnIntentStatus({ sponsorAddress: SPONSOR, nonce: 'N1', txId: 'TX1', intervalMs: 10 });
    await jest.advanceTimersByTimeAsync(10);
    expect(getIntentStatus).toHaveBeenCalledTimes(1);
    wireRows(replacement());
    response.resolve([{ chainId: SEPOLIA, status: 'completed' }]);
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(getIntentStatus).toHaveBeenCalledTimes(1);
  });

  it('finishes a txId-free poll without a database write', async () => {
    const getIntentStatus = sdkReturning([{ chainId: SEPOLIA, status: 'completed' }]);
    pollEarnIntentStatus({ sponsorAddress: SPONSOR, nonce: 'N1', intervalMs: 10 });
    await jest.advanceTimersByTimeAsync(100);
    expect(getIntentStatus).toHaveBeenCalledTimes(1);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it('keeps terminal ownership until the writer settles and releases it after rejection', async () => {
    const write = deferred<void>();
    mockUpdateStatus.mockReturnValueOnce(write.promise);
    const getIntentStatus = sdkReturning([{ chainId: SEPOLIA, status: 'completed' }]);
    pollEarnIntentStatus({ sponsorAddress: SPONSOR, nonce: 'N1', txId: 'TX1', intervalMs: 10 });
    await jest.advanceTimersByTimeAsync(10);
    pollEarnIntentStatus({ sponsorAddress: SPONSOR, nonce: 'N1', txId: 'TX1', intervalMs: 10 });
    await jest.advanceTimersByTimeAsync(100);
    expect(getIntentStatus).toHaveBeenCalledTimes(1);
    const warning = jest.spyOn(console, 'warn').mockImplementation();
    write.reject(new Error('write unavailable'));
    await jest.advanceTimersByTimeAsync(0);
    pollEarnIntentStatus({ sponsorAddress: SPONSOR, nonce: 'N1', txId: 'TX1', intervalMs: 10 });
    await jest.advanceTimersByTimeAsync(10);
    expect(getIntentStatus).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });
});

interface DepositRow {
  id: string;
  type: string;
  status: number;
  extraInputs?: Record<string, unknown>;
  restoredFromBackup?: boolean;
}

function wireRows(rows: DepositRow[]) {
  jest.mocked(Repo.transactions.where).mockImplementation(
    jest.fn().mockImplementation(({ id }: { id: string }) => ({
      first: jest.fn().mockImplementation(async () => rows.find(row => row.id === id))
    }))
  );
  (Repo.transactions.filter as jest.Mock).mockImplementation((predicate: (tx: DepositRow) => boolean) => ({
    toArray: jest.fn().mockResolvedValue(rows.filter(predicate))
  }));
}

const COMPLETED = 2;

const depositRow = (overrides: Partial<DepositRow> = {}): DepositRow => ({
  id: 'TX1',
  type: 'earn-deposit',
  status: COMPLETED,
  extraInputs: { epochStatus: 'pending', intentNonce: 'N1', evmRecipient: SPONSOR },
  ...overrides
});

describe('reconcileEarnDeposits', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    clearPollRegistryForTests();
  });
  afterEach(() => {
    clearPollRegistryForTests();
    jest.useRealTimers();
  });

  const deps = () => ({ getSdk: jest.fn(), updateStatus: jest.fn().mockResolvedValue(undefined) });
  const withStatus = (d: ReturnType<typeof deps>, results: unknown[]) => {
    d.getSdk.mockResolvedValue({ getIntentStatus: jest.fn().mockResolvedValue(results) });
    return d;
  };

  it('settles a stranded row through its immediate owned first request', async () => {
    wireRows([depositRow()]);
    const d = withStatus(deps(), [
      { chainId: MIDEN_CHAIN, status: 'completed', transactionHash: '0xsource' },
      { chainId: SEPOLIA, status: 'completed', transactionHash: '0xdest' }
    ]);
    await reconcileEarnDeposits(d);
    await jest.advanceTimersByTimeAsync(0);
    expect(d.updateStatus).toHaveBeenCalledWith(
      'TX1',
      'confirmed',
      { evmTxHash: '0xdest' },
      { owner: SPONSOR, nonce: 'N1' }
    );
  });

  it('keeps pending destination status live after the owned initial request', async () => {
    wireRows([depositRow()]);
    const getIntentStatus = jest.fn().mockResolvedValue([{ chainId: MIDEN_CHAIN, status: 'completed' }]);
    const d = { ...deps(), getSdk: jest.fn().mockResolvedValue({ getIntentStatus }) };
    await reconcileEarnDeposits(d);
    await jest.advanceTimersByTimeAsync(0);
    expect(getIntentStatus).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(3000);
    expect(getIntentStatus).toHaveBeenCalledTimes(2);
    expect(d.updateStatus).not.toHaveBeenCalled();
  });

  it('marks a row failed when the intent terminally failed', async () => {
    wireRows([depositRow()]);
    const d = withStatus(deps(), [{ chainId: SEPOLIA, status: 'failed' }]);
    await reconcileEarnDeposits(d);
    await jest.advanceTimersByTimeAsync(0);
    expect(d.updateStatus).toHaveBeenCalledWith('TX1', 'failed', undefined, { owner: SPONSOR, nonce: 'N1' });
  });

  it('skips restored, non-deposit, incomplete, terminal and malformed rows', async () => {
    wireRows([
      depositRow({ id: 'RESTORED', restoredFromBackup: true }),
      depositRow({ id: 'OTHER', type: 'send' }),
      depositRow({ id: 'QUEUED', status: 0 }),
      depositRow({ id: 'DONE', extraInputs: { epochStatus: 'confirmed', intentNonce: 'N1', evmRecipient: SPONSOR } }),
      depositRow({ id: 'DEAD', extraInputs: { epochStatus: 'failed', intentNonce: 'N1', evmRecipient: SPONSOR } }),
      depositRow({ id: 'NONONCE', extraInputs: { epochStatus: 'pending', evmRecipient: SPONSOR } }),
      depositRow({ id: 'BADADDR', extraInputs: { epochStatus: 'pending', intentNonce: 'N1', evmRecipient: 'nope' } }),
      depositRow({ id: 'NOEXTRA', extraInputs: undefined })
    ]);
    const d = withStatus(deps(), [{ chainId: SEPOLIA, status: 'completed' }]);
    await reconcileEarnDeposits(d);
    await jest.advanceTimersByTimeAsync(0);
    expect(d.getSdk).not.toHaveBeenCalled();
  });

  it('starts another identity while the first status request never resolves', async () => {
    wireRows([
      depositRow({ id: 'PARKED' }),
      depositRow({ id: 'OK', extraInputs: { epochStatus: 'pending', evmRecipient: SPONSOR, intentNonce: 'N2' } })
    ]);
    const parked = deferred<unknown[]>();
    const getIntentStatus = jest
      .fn()
      .mockReturnValueOnce(parked.promise)
      .mockResolvedValue([{ chainId: SEPOLIA, status: 'completed' }]);
    const d = { ...deps(), getSdk: jest.fn().mockResolvedValue({ getIntentStatus }) };
    await reconcileEarnDeposits(d);
    await jest.advanceTimersByTimeAsync(0);
    expect(getIntentStatus).toHaveBeenCalledTimes(2);
    expect(d.updateStatus).toHaveBeenCalledWith('OK', 'confirmed', undefined, { owner: SPONSOR, nonce: 'N2' });
  });

  it('keeps two realms on one SDK stream through exhausted bursts and owner teardown', async () => {
    wireRows([depositRow()]);
    const locks = new SharedEarnLocks();
    const first = createIntentPollCoordinator({ getLocks: () => locks });
    const second = createIntentPollCoordinator({ getLocks: () => locks });
    const getIntentStatus = jest.fn().mockRejectedValue(new Error('offline'));
    const warning = jest.spyOn(console, 'warn').mockImplementation();
    const d = { ...deps(), getSdk: jest.fn().mockResolvedValue({ getIntentStatus }) };
    const startIn = (coordinator: typeof first) =>
      reconcileEarnDeposits({
        ...d,
        startStatusPoll: args =>
          pollEarnIntentStatus({
            ...args,
            intervalMs: 10,
            maxAttempts: 1,
            deps: { ...d, startPoll: coordinator.startIntentPoll }
          })
      });
    await Promise.all([startIn(first), startIn(second)]);
    await jest.advanceTimersByTimeAsync(0);
    expect(getIntentStatus).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(15_000);
    await startIn(second);
    await jest.advanceTimersByTimeAsync(14_999);
    expect(getIntentStatus).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(getIntentStatus).toHaveBeenCalledTimes(2);
    await startIn(second);
    await jest.advanceTimersByTimeAsync(59_999);
    expect(getIntentStatus).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(getIntentStatus).toHaveBeenCalledTimes(3);
    first.dispose();
    await jest.advanceTimersByTimeAsync(0);
    await startIn(second);
    await jest.advanceTimersByTimeAsync(0);
    expect(getIntentStatus).toHaveBeenCalledTimes(4);
    second.dispose();
    warning.mockRestore();
  });
});

const mockGetBlock = getCurrentMidenBlock as jest.MockedFunction<typeof getCurrentMidenBlock>;

/**
 * The amount/address validation is the wallet's only guard against minting a
 * collateral note for a zero/invalid deposit — a regression that dropped either
 * would strand user funds, so each guard gets an explicit test that fails if the
 * guard is removed. (Guardian accounts are supported: the collateral note is a
 * recallable P2IDE built as a custom proposal in `generateTransaction` — covered
 * by transactions.guardian.test.ts, not here.)
 */
describe('openEarnPosition guards', () => {
  const baseArgs = () => ({
    amount: 1_000_000n,
    evmAddress: SPONSOR,
    senderPublicKey: 'mtst1sender',
    deps: { signTransaction: jest.fn(), guardianProvider: {} } as never,
    onRowCreated: jest.fn()
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetBlock.mockResolvedValue(1000);
  });

  it('rejects a non-positive deposit amount before any SDK work', async () => {
    await expect(openEarnPosition({ ...baseArgs(), amount: 0n })).rejects.toThrow(
      'Deposit amount must be greater than zero.'
    );

    expect(mockGetSdk).not.toHaveBeenCalled();
  });

  it('rejects an invalid EVM address before any SDK work', async () => {
    await expect(openEarnPosition({ ...baseArgs(), evmAddress: 'not-an-address' })).rejects.toThrow(
      'valid EVM address'
    );

    expect(mockGetSdk).not.toHaveBeenCalled();
  });

  it('lets a valid deposit past the guards and into SDK setup', async () => {
    const args = baseArgs();
    // Fail at the first SDK call so the assertion is only that the guards were cleared.
    mockGetSdk.mockResolvedValue({ getTaskData: jest.fn().mockRejectedValue(new Error('stop')) } as never);

    await expect(openEarnPosition(args)).rejects.toThrow('stop');

    expect(mockGetSdk).toHaveBeenCalledWith(SPONSOR);
  });
});

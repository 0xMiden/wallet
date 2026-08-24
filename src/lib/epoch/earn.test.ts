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
import { getEpochReadOnlySdk } from './sdk';

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
  });
  afterEach(() => jest.useRealTimers());

  const runTick = async (results: unknown[]) => {
    sdkReturning(results);
    pollEarnIntentStatus({ sponsorAddress: SPONSOR, nonce: 'N1', txId: 'TX1', intervalMs: 10 });
    jest.advanceTimersByTime(10);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  };

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
    expect(mockUpdateStatus).toHaveBeenCalledWith('TX1', 'confirmed', { evmTxHash: '0xdest' });
  });

  it('falls back to the source hash on a source-side failure', async () => {
    await runTick([{ chainId: MIDEN_CHAIN, status: 'failed', transactionHash: '0xsource' }]);
    expect(mockUpdateStatus).toHaveBeenCalledWith('TX1', 'failed', { evmTxHash: '0xsource' });
  });
});

interface DepositRow {
  id: string;
  type: string;
  status: number;
  extraInputs?: Record<string, unknown>;
}

function wireRows(rows: DepositRow[]) {
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
  beforeEach(() => jest.clearAllMocks());

  const deps = () => ({
    getSdk: jest.fn(),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    startStatusPoll: jest.fn()
  });

  const withStatus = (d: ReturnType<typeof deps>, results: unknown[]) => {
    d.getSdk.mockResolvedValue({ getIntentStatus: jest.fn().mockResolvedValue(results) });
    return d;
  };

  it('settles a stranded row whose destination leg has since completed', async () => {
    wireRows([depositRow()]);
    const d = withStatus(deps(), [
      { chainId: MIDEN_CHAIN, status: 'completed', transactionHash: '0xsource' },
      { chainId: SEPOLIA, status: 'completed', transactionHash: '0xdest' }
    ]);

    await reconcileEarnDeposits(d);

    expect(d.updateStatus).toHaveBeenCalledWith('TX1', 'confirmed', { evmTxHash: '0xdest' });
    expect(d.startStatusPoll).not.toHaveBeenCalled();
  });

  it('restarts the background poll for a row still genuinely in flight', async () => {
    wireRows([depositRow()]);
    const d = withStatus(deps(), [{ chainId: MIDEN_CHAIN, status: 'completed' }]);

    await reconcileEarnDeposits(d);

    expect(d.startStatusPoll).toHaveBeenCalledWith({ sponsorAddress: SPONSOR, nonce: 'N1', txId: 'TX1' });
    expect(d.updateStatus).not.toHaveBeenCalled();
  });

  it('marks a row failed when the intent terminally failed', async () => {
    wireRows([depositRow()]);
    const d = withStatus(deps(), [{ chainId: SEPOLIA, status: 'failed' }]);

    await reconcileEarnDeposits(d);

    expect(d.updateStatus).toHaveBeenCalledWith('TX1', 'failed', undefined);
  });

  it('skips rows that are not earn-deposits, not Completed, or already settled', async () => {
    wireRows([
      depositRow({ id: 'OTHER', type: 'send' }),
      depositRow({ id: 'QUEUED', status: 0 }),
      depositRow({ id: 'DONE', extraInputs: { epochStatus: 'confirmed', intentNonce: 'N1', evmRecipient: SPONSOR } }),
      depositRow({ id: 'DEAD', extraInputs: { epochStatus: 'failed', intentNonce: 'N1', evmRecipient: SPONSOR } })
    ]);
    const d = withStatus(deps(), [{ chainId: SEPOLIA, status: 'completed' }]);

    await reconcileEarnDeposits(d);

    expect(d.getSdk).not.toHaveBeenCalled();
  });

  it('skips rows missing an intent nonce or with an unusable EVM recipient', async () => {
    wireRows([
      depositRow({ id: 'NONONCE', extraInputs: { epochStatus: 'pending', evmRecipient: SPONSOR } }),
      depositRow({ id: 'BADADDR', extraInputs: { epochStatus: 'pending', intentNonce: 'N1', evmRecipient: 'nope' } }),
      depositRow({ id: 'NOEXTRA', extraInputs: undefined })
    ]);
    const d = withStatus(deps(), [{ chainId: SEPOLIA, status: 'completed' }]);

    await reconcileEarnDeposits(d);

    expect(d.getSdk).not.toHaveBeenCalled();
  });

  it('isolates a failing row so the rest still reconcile', async () => {
    wireRows([depositRow({ id: 'BOOM' }), depositRow({ id: 'OK' })]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const d = deps();
    d.getSdk.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce({
      getIntentStatus: jest.fn().mockResolvedValue([{ chainId: SEPOLIA, status: 'completed' }])
    });

    await reconcileEarnDeposits(d);

    expect(warn).toHaveBeenCalled();
    expect(d.updateStatus).toHaveBeenCalledWith('OK', 'confirmed', undefined);
    warn.mockRestore();
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

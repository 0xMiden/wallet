import { BridgedReceiveTransaction, IOneClickTrackingData } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { fetchOneClickStatus } from 'lib/one-click/client';

import {
  claimOneClickEvmDepositAttempt,
  OneClickEvmDepositAlreadyAttemptedError,
  reconcileOneClickSwaps,
  recordOneClickOriginTransactionHash,
  retireOneClickEvmPreflightFailure
} from './tracking';
import type { OneClickStatusResponse } from './types';

jest.mock('lib/miden/recovery/receipt-writer', () => ({ checkpointProviderReceipt: jest.fn(async () => {}) }));

jest.mock('lib/one-click/client', () => ({
  ...jest.requireActual('lib/one-click/client'),
  fetchOneClickStatus: jest.fn()
}));

function makeInboundRow(id: string, overrides: Partial<IOneClickTrackingData> = {}): BridgedReceiveTransaction {
  const originAsset = {
    assetId: `eth:token-${id}`,
    blockchain: 'eth',
    symbol: 'ETH',
    decimals: 18,
    chainId: 1
  };
  const destinationAsset = {
    assetId: `miden:token-${id}`,
    blockchain: 'miden',
    symbol: 'MIDEN',
    decimals: 6,
    faucetId: 'miden:faucet'
  };
  const request = {
    amount: '1000000',
    originAsset,
    destinationAsset,
    refundTo: `0x${'1'.repeat(40)}`,
    recipient: 'miden:account',
    deadline: '2099-01-01T00:00:00.000Z',
    slippageTolerance: 100
  };
  const quote = {
    correlationId: `quote-${id}`,
    timestamp: '2026-10-22T00:00:00.000Z',
    signature: 'signed-test-quote',
    quoteRequest: {
      dry: false,
      swapType: 'EXACT_INPUT' as const,
      slippageTolerance: 100,
      originAsset: originAsset.assetId,
      depositType: 'ORIGIN_CHAIN' as const,
      destinationAsset: destinationAsset.assetId,
      amount: '1000000',
      refundTo: request.refundTo,
      refundType: 'ORIGIN_CHAIN' as const,
      recipient: request.recipient,
      recipientType: 'DESTINATION_CHAIN' as const,
      deadline: request.deadline
    },
    quote: {
      amountIn: '1000000',
      amountInFormatted: '0.001 ETH',
      amountInUsd: '1',
      minAmountIn: '1000000',
      amountOut: '1000000',
      amountOutFormatted: '1 MIDEN',
      amountOutUsd: '1',
      minAmountOut: '900000',
      timeEstimate: 60,
      depositAddress: `0x${'8'.repeat(40)}`,
      depositMemo: 'same-memo'
    }
  };
  const row = new BridgedReceiveTransaction(
    'miden:account',
    1_000_000n,
    'miden:faucet',
    'near-intents',
    request.refundTo,
    '0.001 ETH',
    'ETH',
    '1 MIDEN',
    'MIDEN'
  );
  row.id = id;
  row.extraInputs.oneClick = {
    direction: 'evm-to-miden',
    request,
    quote,
    config: { serviceUrl: 'https://quotes.example', midenAssets: [] },
    network: 'mainnet',
    accountId: 'miden:account',
    accountAddress: 'miden:account',
    originAsset,
    destinationAsset,
    faucetId: 'miden:faucet',
    amount: '1000000',
    phase: 'depositing',
    depositAddress: `0x${'8'.repeat(40)}`,
    depositMemo: 'same-memo',
    evmSubmission: 'not-started',
    ...overrides
  };
  return row;
}

function statusResponse(
  row: BridgedReceiveTransaction,
  status: OneClickStatusResponse['status']
): OneClickStatusResponse {
  return {
    correlationId: 'status-correlation',
    quoteResponse: row.extraInputs.oneClick!.quote,
    status,
    updatedAt: new Date().toISOString(),
    swapDetails: {
      intentHashes: [],
      nearTxHashes: [],
      originChainTxHashes: [],
      destinationChainTxHashes: [],
      ...(status === 'FAILED' ? { refundReason: 'provider reported failure' } : {})
    }
  };
}

const blockingTerminalCases: ReadonlyArray<{ label: string; state: Partial<IOneClickTrackingData> }> = [
  { label: 'known submission marker', state: { phase: 'failed', evmSubmission: 'known' } },
  {
    label: 'persisted origin hash',
    state: { phase: 'failed', evmSubmission: 'not-started', originTransactionHash: '0xabc' }
  }
];

describe('persisted EVM deposit claims', () => {
  beforeEach(async () => {
    await Repo.transactions.clear();
    jest.clearAllMocks();
    jest.mocked(fetchOneClickStatus).mockReset();
  });

  afterAll(async () => {
    await Repo.transactions.clear();
  });

  it('allows exactly one of two concurrent fresh rows with the same deposit reference', async () => {
    const first = makeInboundRow('claim-first');
    const second = makeInboundRow('claim-second', {
      accountId: 'different-account',
      accountAddress: 'different-account',
      amount: '2000000',
      originAsset: { ...first.extraInputs.oneClick!.originAsset, assetId: 'another-asset' }
    });
    await Repo.transactions.bulkAdd([first, second]);

    const results = await Promise.allSettled([
      claimOneClickEvmDepositAttempt(first.id),
      claimOneClickEvmDepositAttempt(second.id)
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const savedRows = await Repo.transactions.bulkGet([first.id, second.id]);
    expect(savedRows.map(row => row?.extraInputs.oneClick?.evmSubmission).sort()).toEqual(['attempted', 'not-started']);
  });

  it('allows concurrent claims for distinct deposit references', async () => {
    const first = makeInboundRow('claim-distinct-first');
    const second = makeInboundRow('claim-distinct-second', {
      depositMemo: 'different-memo'
    });
    await Repo.transactions.bulkAdd([first, second]);

    await expect(
      Promise.all([claimOneClickEvmDepositAttempt(first.id), claimOneClickEvmDepositAttempt(second.id)])
    ).resolves.toEqual([undefined, undefined]);
    const savedRows = await Repo.transactions.bulkGet([first.id, second.id]);
    expect(savedRows.map(row => row?.extraInputs.oneClick?.evmSubmission)).toEqual(['attempted', 'attempted']);
  });

  it('blocks a same-reference legacy row without a submission marker', async () => {
    const attempted = makeInboundRow('claim-legacy', { evmSubmission: undefined });
    const candidate = makeInboundRow('claim-legacy-candidate');
    await Repo.transactions.bulkAdd([attempted, candidate]);

    await expect(claimOneClickEvmDepositAttempt(candidate.id)).rejects.toBeInstanceOf(
      OneClickEvmDepositAlreadyAttemptedError
    );
    await expect(Repo.transactions.get(candidate.id)).resolves.toMatchObject({
      extraInputs: { oneClick: { evmSubmission: 'not-started' } }
    });
  });

  it('blocks a same-reference failed legacy row without a submission marker', async () => {
    const prior = makeInboundRow('claim-terminal-legacy', { phase: 'failed', evmSubmission: undefined });
    const next = makeInboundRow('claim-terminal-legacy-next');
    await Repo.transactions.bulkAdd([prior, next]);

    await expect(claimOneClickEvmDepositAttempt(next.id)).rejects.toBeInstanceOf(
      OneClickEvmDepositAlreadyAttemptedError
    );
    await expect(Repo.transactions.get(next.id)).resolves.toMatchObject({
      extraInputs: { oneClick: { evmSubmission: 'not-started' } }
    });
  });

  it.each(blockingTerminalCases)(
    'keeps a same-reference $label blocking after terminal failure',
    async ({ label, state }) => {
      const prior = makeInboundRow(`claim-terminal-${label}`, state);
      const candidate = makeInboundRow(`claim-terminal-${label}-candidate`);
      await Repo.transactions.bulkAdd([prior, candidate]);

      await expect(claimOneClickEvmDepositAttempt(candidate.id)).rejects.toBeInstanceOf(
        OneClickEvmDepositAlreadyAttemptedError
      );
      await expect(Repo.transactions.get(candidate.id)).resolves.toMatchObject({
        extraInputs: { oneClick: { evmSubmission: 'not-started' } }
      });
    }
  );

  it('allows a terminal failed pre-request row to retire before a new claim for the same reference', async () => {
    const prior = makeInboundRow('claim-terminal-prior', { phase: 'failed', evmSubmission: 'not-started' });
    const next = makeInboundRow('claim-terminal-next');
    await Repo.transactions.bulkAdd([prior, next]);

    await expect(claimOneClickEvmDepositAttempt(next.id)).resolves.toBeUndefined();
    await expect(Repo.transactions.get(next.id)).resolves.toMatchObject({
      extraInputs: { oneClick: { evmSubmission: 'attempted' } }
    });
  });

  it('keeps a same-reference attempted row blocking after provider failure', async () => {
    const prior = makeInboundRow('claim-failed-attempted-prior', {
      phase: 'pending-deposit',
      evmSubmission: 'attempted'
    });
    const candidate = makeInboundRow('claim-failed-attempted-candidate');
    await Repo.transactions.add(prior);
    jest.mocked(fetchOneClickStatus).mockResolvedValueOnce(statusResponse(prior, 'FAILED'));

    await reconcileOneClickSwaps();

    await expect(Repo.transactions.get(prior.id)).resolves.toMatchObject({
      extraInputs: { oneClick: { phase: 'failed', evmSubmission: 'attempted' } }
    });
    await Repo.transactions.add(candidate);
    await expect(claimOneClickEvmDepositAttempt(candidate.id)).rejects.toBeInstanceOf(
      OneClickEvmDepositAlreadyAttemptedError
    );
    await expect(Repo.transactions.get(candidate.id)).resolves.toMatchObject({
      extraInputs: { oneClick: { evmSubmission: 'not-started' } }
    });
  });

  it('preserves a concurrent attempted claim when a deferred provider failure is reconciled', async () => {
    const row = makeInboundRow('claim-deferred-attempted');
    await Repo.transactions.add(row);
    let resolveStatus!: (response: OneClickStatusResponse) => void;
    let markStatusRequested!: () => void;
    const statusRequested = new Promise<void>(resolve => {
      markStatusRequested = resolve;
    });
    const pendingStatus = new Promise<OneClickStatusResponse>(resolve => {
      resolveStatus = resolve;
    });
    jest.mocked(fetchOneClickStatus).mockImplementationOnce(async () => {
      markStatusRequested();
      return pendingStatus;
    });

    const reconciliation = reconcileOneClickSwaps();
    await statusRequested;
    await claimOneClickEvmDepositAttempt(row.id);
    resolveStatus(statusResponse(row, 'FAILED'));
    await reconciliation;

    await expect(Repo.transactions.get(row.id)).resolves.toMatchObject({
      extraInputs: { oneClick: { phase: 'failed', evmSubmission: 'attempted' } }
    });
  });

  it('preserves a concurrent known origin hash when a deferred provider failure is reconciled', async () => {
    const row = makeInboundRow('claim-deferred-known-hash');
    await Repo.transactions.add(row);
    let resolveStatus!: (response: OneClickStatusResponse) => void;
    let markStatusRequested!: () => void;
    const statusRequested = new Promise<void>(resolve => {
      markStatusRequested = resolve;
    });
    const pendingStatus = new Promise<OneClickStatusResponse>(resolve => {
      resolveStatus = resolve;
    });
    jest.mocked(fetchOneClickStatus).mockImplementationOnce(async () => {
      markStatusRequested();
      return pendingStatus;
    });

    const reconciliation = reconcileOneClickSwaps();
    await statusRequested;
    await claimOneClickEvmDepositAttempt(row.id);
    const originHash = `0x${'b'.repeat(64)}`;
    await recordOneClickOriginTransactionHash(row.id, originHash);
    resolveStatus(statusResponse(row, 'FAILED'));
    await reconciliation;

    await expect(Repo.transactions.get(row.id)).resolves.toMatchObject({
      extraInputs: {
        evmTxHash: originHash,
        oneClick: { phase: 'failed', evmSubmission: 'known', originTransactionHash: originHash }
      }
    });
  });

  it('does not let the same persisted row be claimed twice', async () => {
    const row = makeInboundRow('claim-same-row');
    await Repo.transactions.add(row);

    await expect(claimOneClickEvmDepositAttempt(row.id)).resolves.toBeUndefined();
    await expect(claimOneClickEvmDepositAttempt(row.id)).rejects.toBeInstanceOf(
      OneClickEvmDepositAlreadyAttemptedError
    );
    await expect(Repo.transactions.get(row.id)).resolves.toMatchObject({
      extraInputs: { oneClick: { evmSubmission: 'attempted' } }
    });
  });

  it('does not let a competing caller retire another caller’s attempted claim', async () => {
    const row = makeInboundRow('claim-owned-row');
    await Repo.transactions.add(row);
    await claimOneClickEvmDepositAttempt(row.id);
    const claimedRow = await Repo.transactions.get(row.id);
    expect(claimedRow).toMatchObject({
      extraInputs: { phase: 'delivering', oneClick: { evmSubmission: 'attempted' } }
    });

    await retireOneClickEvmPreflightFailure(row.id, false);

    await expect(Repo.transactions.get(row.id)).resolves.toEqual(claimedRow);
  });

  it('fails closed and rolls back the attempted marker when the claim write fails', async () => {
    const row = makeInboundRow('claim-storage-failure');
    await Repo.transactions.add(row);
    const update = jest.spyOn(Repo.transactions, 'update').mockRejectedValueOnce(new Error('storage unavailable'));
    try {
      await expect(claimOneClickEvmDepositAttempt(row.id)).rejects.toThrow('storage unavailable');
    } finally {
      update.mockRestore();
    }
    await expect(Repo.transactions.get(row.id)).resolves.toMatchObject({
      extraInputs: { oneClick: { evmSubmission: 'not-started' } }
    });
  });
});

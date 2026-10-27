import { HistoryEntryType } from 'app/templates/history/IHistoryEntry';
import { bridgeStatusOf } from 'app/templates/history/transactionUtils';
import { ITransactionStatus } from 'lib/miden/db/types';

import {
  initiateOneClickMidenDeposit,
  persistOneClickTrackingRow,
  phaseForProviderStatus,
  reconcileOneClickSwaps,
  updateOneClickTrackingPhase
} from './tracking';
import { OneClickAsset, OneClickConfig, OneClickQuoteRequest, OneClickQuoteResponse } from './types';

const addTransaction = jest.fn();
const initiateSend = jest.fn();
const storedRows: any[] = [];
const fetchStatus = jest.fn();
const submitDeposit = jest.fn();

jest.mock('lib/miden/repo', () => ({
  transactions: {
    add: (...args: unknown[]) => addTransaction(...args),
    where: (field: string) => ({
      equals: (value: unknown) => ({
        toArray: async () => storedRows.filter(row => row[field] === value),
        modify: async (mutator: (row: any) => unknown) => {
          for (const row of storedRows.filter(candidate => candidate[field] === value)) mutator(row);
        }
      })
    })
  }
}));
jest.mock('lib/miden/sdk/helpers', () => ({ sameWalletAccountId: (left: string, right: string) => left === right }));
jest.mock('lib/one-click/client', () => ({
  ONE_CLICK_EVM_CHAIN_IDS: { eth: 1 },
  assertOneClickQuoteBinding: jest.fn(),
  fetchOneClickStatus: (...args: unknown[]) => fetchStatus(...args),
  resolveOneClickDestinationReceipts: jest.fn(),
  submitOneClickDeposit: (...args: unknown[]) => submitDeposit(...args)
}));
jest.mock('lib/miden/activity', () => ({ initiateSendTransaction: (...args: unknown[]) => initiateSend(...args) }));

const originAsset: OneClickAsset = { assetId: 'miden-asset', blockchain: 'miden', symbol: 'MID', decimals: 6 };
const destinationAsset: OneClickAsset = { assetId: 'eth-asset', blockchain: 'eth', symbol: 'ETH', decimals: 18 };
const config: OneClickConfig = {
  serviceUrl: 'https://1click.test/api',
  midenAssets: [{ assetId: originAsset.assetId, faucetId: 'miden-faucet', decimals: 6 }]
};
const requestDeadline = new Date(Date.now() + 60 * 60_000).toISOString();
const quoteDeadline = new Date(Date.now() + 30 * 60_000).toISOString();
const request: OneClickQuoteRequest = {
  amount: '1000000',
  originAsset,
  destinationAsset,
  refundTo: 'miden-account',
  recipient: '0x0000000000000000000000000000000000000001',
  deadline: requestDeadline,
  slippageTolerance: 100
};
const quote: OneClickQuoteResponse = {
  correlationId: 'correlation',
  timestamp: '2026-10-22T12:00:00Z',
  signature: 'signature',
  quoteRequest: {
    dry: false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: originAsset.assetId,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: destinationAsset.assetId,
    amount: request.amount,
    refundTo: request.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: request.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: request.deadline
  },
  quote: {
    amountIn: '1000000',
    amountInFormatted: '1',
    amountInUsd: '1',
    minAmountIn: '1000000',
    amountOut: '2000000000000000000',
    amountOutFormatted: '2',
    amountOutUsd: '2',
    minAmountOut: '1900000000000000000',
    timeEstimate: 10,
    depositAddress: 'miden-deposit-address',
    deadline: quoteDeadline
  }
};

const input = {
  request,
  quote,
  config,
  network: 'mainnet',
  accountId: 'miden-account-id',
  accountAddress: 'miden-account',
  originAsset,
  destinationAsset,
  faucetId: 'miden-faucet'
};
const inboundInput = {
  ...input,
  request: {
    ...request,
    originAsset: destinationAsset,
    destinationAsset: originAsset,
    refundTo: '0x0000000000000000000000000000000000000001',
    recipient: 'miden-account'
  },
  quote: {
    ...quote,
    quoteRequest: {
      ...quote.quoteRequest,
      originAsset: destinationAsset.assetId,
      destinationAsset: originAsset.assetId,
      refundTo: '0x0000000000000000000000000000000000000001',
      recipient: 'miden-account'
    }
  },
  originAsset: destinationAsset,
  destinationAsset: originAsset
};

const activityBridgeStatus = (phase: string | undefined) => {
  const bridgeInPhase = phase === 'delivering' || phase === 'failed' ? phase : undefined;
  return bridgeStatusOf({
    key: 'refunded-inbound-row',
    address: 'miden-account-id',
    timestamp: Date.now(),
    message: '1Click deposit',
    type: HistoryEntryType.CompletedTransaction,
    txType: 'bridged-receive',
    bridgeInPhase
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  storedRows.length = 0;
  addTransaction.mockResolvedValue('row-id');
  initiateSend.mockResolvedValue('send-row-id');
  fetchStatus.mockResolvedValue({ status: 'PENDING_DEPOSIT', swapDetails: {} });
  submitDeposit.mockResolvedValue({ status: 'PENDING_DEPOSIT', swapDetails: {} });
});

describe('1Click durable tracking', () => {
  it('persists the signed inbound quote and account route before returning a row id', async () => {
    const rowId = await persistOneClickTrackingRow(inboundInput);

    expect(addTransaction).toHaveBeenCalledTimes(1);
    const [row] = addTransaction.mock.calls[0];
    expect(rowId).toBe(row.id);
    expect(row).toMatchObject({
      type: 'bridged-receive',
      accountId: 'miden-account-id',
      status: ITransactionStatus.Completed,
      displayMessage: 'Swapping through 1Click',
      extraInputs: {
        provider: 'near-intents',
        phase: 'submitting',
        oneClick: {
          direction: 'evm-to-miden',
          quote: inboundInput.quote,
          request: inboundInput.request,
          config,
          network: 'mainnet',
          accountId: 'miden-account-id',
          accountAddress: 'miden-account',
          depositAddress: 'miden-deposit-address'
        }
      }
    });
  });

  it('persists EVM submission state on inbound rows', async () => {
    await persistOneClickTrackingRow(inboundInput);

    const [row] = addTransaction.mock.calls[0];
    expect(row.extraInputs.oneClick).toMatchObject({ evmSubmission: 'not-started' });
  });

  it.each([
    ['request cutoff first', 20, 40],
    ['provider expiry first', 40, 20]
  ])(
    'persists the earlier %s separately from the signed deadlines',
    async (_label, requestMinutes, providerMinutes) => {
      const signedRequestDeadline = new Date(Date.now() + requestMinutes * 60_000).toISOString();
      const providerExpiry = new Date(Date.now() + providerMinutes * 60_000).toISOString();
      const signedRequest = { ...inboundInput.request, deadline: signedRequestDeadline };
      const signedQuote: OneClickQuoteResponse = {
        ...inboundInput.quote,
        quoteRequest: { ...inboundInput.quote.quoteRequest, deadline: signedRequestDeadline },
        quote: { ...inboundInput.quote.quote, deadline: providerExpiry }
      };

      await persistOneClickTrackingRow({ ...inboundInput, request: signedRequest, quote: signedQuote });

      const [row] = addTransaction.mock.calls[0];
      expect(row.extraInputs?.oneClick).toMatchObject({
        fundingDeadline: new Date(
          Date.parse(signedRequestDeadline) < Date.parse(providerExpiry) ? signedRequestDeadline : providerExpiry
        ).toISOString(),
        request: expect.objectContaining({ deadline: signedRequestDeadline }),
        quote: {
          quoteRequest: { deadline: signedRequestDeadline },
          quote: { deadline: providerExpiry }
        }
      });
      expect(row.extraInputs?.oneClick?.request).toEqual(signedRequest);
      expect(row.extraInputs?.oneClick?.quote).toEqual(signedQuote);
    }
  );

  it('refuses to persist a quote whose Miden destination is another account', async () => {
    await expect(persistOneClickTrackingRow({ ...inboundInput, accountAddress: 'different-account' })).rejects.toThrow(
      'not bound to the selected Miden account'
    );
    expect(addTransaction).not.toHaveBeenCalled();
  });

  it('skips pre-request failed rows and polls attempted rows after restart', async () => {
    const makeReceive = (id: string, phase: string, evmSubmission?: string) => ({
      id,
      type: 'bridged-receive',
      accountId: 'miden-account-id',
      initiatedAt: Date.now(),
      status: ITransactionStatus.Completed,
      extraInputs: {
        phase,
        oneClick: {
          direction: 'evm-to-miden',
          request: inboundInput.request,
          quote: inboundInput.quote,
          config,
          network: 'mainnet',
          accountId: 'miden-account-id',
          accountAddress: 'miden-account',
          originAsset: destinationAsset,
          destinationAsset: originAsset,
          faucetId: 'miden-faucet',
          amount: inboundInput.request.amount,
          phase,
          depositAddress: 'miden-deposit-address',
          ...(evmSubmission ? { evmSubmission } : {})
        }
      }
    });
    storedRows.push(makeReceive('failed-row', 'failed'), makeReceive('attempted-row', 'pending-deposit', 'attempted'));

    await reconcileOneClickSwaps();

    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(fetchStatus).toHaveBeenCalledWith(config, 'miden-deposit-address', undefined, inboundInput.quote);
  });

  it('terminalizes refunded inbound rows in Activity and stops polling', async () => {
    const originTransactionHash = `0x${'a'.repeat(64)}`;
    const inboundRow = {
      id: 'refunded-inbound-row',
      type: 'bridged-receive',
      accountId: 'miden-account-id',
      initiatedAt: Date.now(),
      status: ITransactionStatus.Completed,
      extraInputs: {
        phase: 'delivering',
        evmTxHash: originTransactionHash,
        oneClick: {
          direction: 'evm-to-miden',
          request: inboundInput.request,
          quote: inboundInput.quote,
          config,
          network: 'mainnet',
          accountId: 'miden-account-id',
          accountAddress: 'miden-account',
          originAsset: destinationAsset,
          destinationAsset: originAsset,
          faucetId: 'miden-faucet',
          amount: inboundInput.request.amount,
          phase: 'known-deposit-tx',
          depositAddress: 'miden-deposit-address',
          originTransactionHash,
          evmSubmission: 'known',
          providerSubmitted: true
        }
      }
    };
    storedRows.push(inboundRow);
    fetchStatus.mockResolvedValue({ status: 'REFUNDED', swapDetails: { refundReason: 'Refunded by provider' } });

    await reconcileOneClickSwaps();

    expect(inboundRow.extraInputs.oneClick.phase).toBe('refunded');
    expect(inboundRow.extraInputs.phase).toBe('failed');
    expect(activityBridgeStatus(inboundRow.extraInputs.phase)).toBe('failed');
    expect(inboundRow.extraInputs.evmTxHash).toBe(originTransactionHash);
    expect(inboundRow.extraInputs.oneClick).toMatchObject({ evmSubmission: 'known', originTransactionHash });

    await reconcileOneClickSwaps();

    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(submitDeposit).not.toHaveBeenCalled();
  });

  it('maps explicit refunded phases to a terminal Activity state', async () => {
    const originTransactionHash = `0x${'b'.repeat(64)}`;
    const inboundRow = {
      id: 'explicit-refunded-inbound-row',
      type: 'bridged-receive',
      accountId: 'miden-account-id',
      initiatedAt: Date.now(),
      status: ITransactionStatus.Completed,
      extraInputs: {
        phase: 'delivering',
        evmTxHash: originTransactionHash,
        oneClick: {
          direction: 'evm-to-miden',
          request: inboundInput.request,
          quote: inboundInput.quote,
          config,
          network: 'mainnet',
          accountId: 'miden-account-id',
          accountAddress: 'miden-account',
          originAsset: destinationAsset,
          destinationAsset: originAsset,
          faucetId: 'miden-faucet',
          amount: inboundInput.request.amount,
          phase: 'known-deposit-tx',
          depositAddress: 'miden-deposit-address',
          originTransactionHash,
          evmSubmission: 'known',
          providerSubmitted: true
        }
      }
    };
    storedRows.push(inboundRow);

    await updateOneClickTrackingPhase(inboundRow.id, 'refunded');

    expect(inboundRow.extraInputs.oneClick).toMatchObject({
      phase: 'refunded',
      evmSubmission: 'known',
      originTransactionHash
    });
    expect(inboundRow.extraInputs.phase).toBe('failed');
    expect(activityBridgeStatus(inboundRow.extraInputs.phase)).toBe('failed');
  });

  it('stops polling an outbound swap after the provider reports success', async () => {
    const outboundRow = {
      id: 'outbound-success-row',
      type: 'send',
      accountId: 'miden-account-id',
      initiatedAt: Date.now(),
      status: ITransactionStatus.Completed,
      transactionId: 'miden-send-hash',
      extraInputs: {
        oneClick: {
          direction: 'miden-to-evm',
          request,
          quote,
          config,
          network: 'mainnet',
          accountId: 'miden-account-id',
          accountAddress: 'miden-account',
          originAsset,
          destinationAsset,
          faucetId: 'miden-faucet',
          amount: request.amount,
          phase: 'processing',
          depositAddress: 'miden-deposit-address',
          providerSubmitted: true
        }
      }
    };
    storedRows.push(outboundRow);
    fetchStatus.mockResolvedValue({ status: 'SUCCESS', swapDetails: {} });

    await reconcileOneClickSwaps();
    await reconcileOneClickSwaps();

    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(outboundRow.extraInputs.oneClick.phase).toBe('delivered');
  });

  it('stops after an outbound deposit submission reports success', async () => {
    const outboundRow = {
      id: 'outbound-submit-success-row',
      type: 'send',
      accountId: 'miden-account-id',
      initiatedAt: Date.now(),
      status: ITransactionStatus.Completed,
      transactionId: 'miden-send-hash',
      extraInputs: {
        oneClick: {
          direction: 'miden-to-evm',
          request,
          quote,
          config,
          network: 'mainnet',
          accountId: 'miden-account-id',
          accountAddress: 'miden-account',
          originAsset,
          destinationAsset,
          faucetId: 'miden-faucet',
          amount: request.amount,
          phase: 'processing',
          depositAddress: 'miden-deposit-address',
          providerSubmitted: false
        }
      }
    };
    storedRows.push(outboundRow);
    submitDeposit.mockResolvedValue({ status: 'SUCCESS', swapDetails: {} });
    fetchStatus.mockRejectedValue(new Error('status must not be fetched after terminal submit success'));

    await reconcileOneClickSwaps();
    await reconcileOneClickSwaps();

    expect(submitDeposit).toHaveBeenCalledTimes(1);
    expect(fetchStatus).not.toHaveBeenCalled();
    expect(outboundRow.extraInputs.oneClick.phase).toBe('delivered');
  });

  it('sends the selected Miden account-bound amount to the signed deposit address', async () => {
    await initiateOneClickMidenDeposit(input);

    expect(initiateSend).toHaveBeenCalledWith(
      'miden-account-id',
      'miden-deposit-address',
      'miden-faucet',
      expect.anything(),
      1000000n,
      undefined,
      undefined,
      undefined,
      undefined,
      expect.objectContaining({ direction: 'miden-to-evm', quote: expect.any(Object) })
    );
  });

  it('refuses funding when the signed request cutoff has passed even if provider expiry remains live', async () => {
    const expiredDeadline = new Date(Date.now() - 1_000).toISOString();
    const liveProviderExpiry = new Date(Date.now() + 60_000).toISOString();
    const signedRequest = { ...request, deadline: expiredDeadline };
    const signedQuote: OneClickQuoteResponse = {
      ...quote,
      quoteRequest: { ...quote.quoteRequest, deadline: expiredDeadline },
      quote: { ...quote.quote, deadline: liveProviderExpiry }
    };

    await expect(
      initiateOneClickMidenDeposit({ ...input, request: signedRequest, quote: signedQuote })
    ).rejects.toThrow(/expired/i);
    expect(initiateSend).not.toHaveBeenCalled();
  });

  it.each([
    ['request cutoff first', 20, 40],
    ['provider expiry first', 40, 20]
  ])(
    'passes the earlier %s as funding metadata without changing the quote',
    async (_label, requestMinutes, providerMinutes) => {
      const signedRequestDeadline = new Date(Date.now() + requestMinutes * 60_000).toISOString();
      const providerExpiry = new Date(Date.now() + providerMinutes * 60_000).toISOString();
      const signedRequest = { ...request, deadline: signedRequestDeadline };
      const signedQuote: OneClickQuoteResponse = {
        ...quote,
        quoteRequest: { ...quote.quoteRequest, deadline: signedRequestDeadline },
        quote: { ...quote.quote, deadline: providerExpiry }
      };

      await initiateOneClickMidenDeposit({ ...input, request: signedRequest, quote: signedQuote });

      expect(initiateSend).toHaveBeenCalledWith(
        'miden-account-id',
        'miden-deposit-address',
        'miden-faucet',
        expect.anything(),
        1000000n,
        undefined,
        undefined,
        undefined,
        undefined,
        expect.objectContaining({
          fundingDeadline: new Date(
            Date.parse(signedRequestDeadline) < Date.parse(providerExpiry) ? signedRequestDeadline : providerExpiry
          ).toISOString(),
          request: expect.objectContaining({ deadline: signedRequestDeadline }),
          quote: signedQuote
        })
      );
      const tracking = initiateSend.mock.calls[0]?.[9];
      expect(tracking?.request).toEqual(signedRequest);
      expect(tracking?.quote).toEqual(signedQuote);
    }
  );

  it.each([
    ['KNOWN_DEPOSIT_TX', 'known-deposit-tx'],
    ['PENDING_DEPOSIT', 'pending-deposit'],
    ['INCOMPLETE_DEPOSIT', 'incomplete-deposit'],
    ['PROCESSING', 'processing'],
    ['SUCCESS', 'arriving'],
    ['REFUNDED', 'refunded'],
    ['FAILED', 'failed']
  ] as const)('surfaces %s as its own tracking phase', (status, phase) => {
    expect(phaseForProviderStatus(status)).toBe(phase);
  });
});

jest.mock('lib/miden/recovery/receipt-writer', () => ({ checkpointProviderReceipt: async () => {} }));

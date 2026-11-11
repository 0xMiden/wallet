import { HistoryEntryType } from 'app/templates/history/IHistoryEntry';
import { bridgeStatusOf } from 'app/templates/history/transactionUtils';
import { ITransactionStatus, type IOneClickTrackingData } from 'lib/miden/db/types';

import { OneClickHttpError } from './client';
import {
  NEAR_INTENTS_DEPOSIT_EXPIRED_ERROR,
  NEAR_INTENTS_DEPOSIT_EXPIRY_GRACE_MS,
  NEAR_INTENTS_UNKNOWN_DEPOSIT_EXPIRY_MS,
  initiateOneClickMidenDeposit,
  isNearIntentsDepositExpired,
  persistNearIntentsDeposit,
  phaseForProviderStatus,
  reconcileOneClickSwaps
} from './tracking';
import { NearIntentsConfig, OneClickAsset, OneClickQuoteRequest, OneClickQuoteResponse } from './types';

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
  OneClickHttpError:
    jest.requireActual<typeof import('lib/one-click/client')>('lib/one-click/client').OneClickHttpError,
  assertOneClickQuoteBinding: jest.fn(),
  fetchOneClickStatus: (...args: unknown[]) => fetchStatus(...args),
  resolveOneClickDestinationReceipts: jest.fn(),
  submitOneClickDeposit: (...args: unknown[]) => submitDeposit(...args)
}));
jest.mock('lib/miden/activity', () => ({
  initiateNearIntentsSendTransaction: (...args: unknown[]) => initiateSend(...args)
}));

const originAsset: OneClickAsset = { assetId: 'miden-asset', blockchain: 'miden', symbol: 'MID', decimals: 6 };
const destinationAsset: OneClickAsset = { assetId: 'eth-asset', blockchain: 'eth', symbol: 'ETH', decimals: 18 };
const config: NearIntentsConfig = {
  serviceUrl: 'https://1click.test/api',
  chains: [
    {
      id: 'eth',
      name: 'Ethereum',
      addressKind: 'evm',
      tokens: [{ symbol: 'ETH', assetId: destinationAsset.assetId, decimals: 18, miden: ['mid'] }]
    }
  ],
  midenAssets: [{ id: 'mid', assetId: originAsset.assetId, faucetId: 'miden-faucet', decimals: 6 }]
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

function inboundTracking(overrides: Partial<IOneClickTrackingData> = {}): IOneClickTrackingData {
  return {
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
    phase: 'depositing',
    depositAddress: 'miden-deposit-address',
    ...overrides
  };
}

function inboundRow(id: string, overrides: Partial<IOneClickTrackingData> = {}) {
  return {
    id,
    type: 'bridged-receive',
    accountId: 'miden-account-id',
    initiatedAt: Date.now(),
    status: ITransactionStatus.Completed,
    extraInputs: { phase: 'submitting', oneClick: inboundTracking(overrides) }
  };
}

const pastGrace = () => new Date(Date.now() - NEAR_INTENTS_DEPOSIT_EXPIRY_GRACE_MS - 60_000).toISOString();
const withinGrace = () => new Date(Date.now() - NEAR_INTENTS_DEPOSIT_EXPIRY_GRACE_MS + 60_000).toISOString();
// A deadline more than one day and the grace in the past: the point where a missing record expires a row.
const pastUnknownDay = () =>
  new Date(
    Date.now() - NEAR_INTENTS_UNKNOWN_DEPOSIT_EXPIRY_MS - NEAR_INTENTS_DEPOSIT_EXPIRY_GRACE_MS - 60_000
  ).toISOString();

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
    const rowId = await persistNearIntentsDeposit(inboundInput);

    expect(addTransaction).toHaveBeenCalledTimes(1);
    const [row] = addTransaction.mock.calls[0];
    expect(rowId).toBe(row.id);
    expect(row).toMatchObject({
      type: 'bridged-receive',
      accountId: 'miden-account-id',
      status: ITransactionStatus.Completed,
      displayMessage: 'Receiving through NEAR Intents',
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

  it('writes no EVM submission state or origin hash on a deposit row', async () => {
    await persistNearIntentsDeposit(inboundInput);

    const [row] = addTransaction.mock.calls[0];
    expect(row.extraInputs.oneClick).not.toHaveProperty('evmSubmission');
    expect(row.extraInputs.oneClick).not.toHaveProperty('originTransactionHash');
    expect(row.extraInputs).not.toHaveProperty('evmTxHash');
  });

  it('refuses a deposit row whose origin is on Miden', async () => {
    await expect(persistNearIntentsDeposit(input)).rejects.toThrow('from another chain into Miden');
    expect(addTransaction).not.toHaveBeenCalled();
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

      await persistNearIntentsDeposit({ ...inboundInput, request: signedRequest, quote: signedQuote });

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
    await expect(persistNearIntentsDeposit({ ...inboundInput, accountAddress: 'different-account' })).rejects.toThrow(
      'not bound to the selected Miden account'
    );
    expect(addTransaction).not.toHaveBeenCalled();
  });

  it('skips terminal rows and polls open deposit rows by deposit address without a deposit submission', async () => {
    storedRows.push(
      inboundRow('failed-row', { phase: 'failed' }),
      inboundRow('expired-row', { phase: 'expired' }),
      inboundRow('open-row', { phase: 'pending-deposit' })
    );

    await reconcileOneClickSwaps();

    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(fetchStatus).toHaveBeenCalledWith(config, 'miden-deposit-address', undefined, inboundInput.quote);
    expect(submitDeposit).not.toHaveBeenCalled();
  });

  it('terminalizes refunded inbound rows in Activity and stops polling', async () => {
    const originTransactionHash = `0x${'a'.repeat(64)}`;
    const row = inboundRow('refunded-inbound-row', {
      phase: 'known-deposit-tx',
      originTransactionHash,
      providerSubmitted: true
    });
    storedRows.push(row);
    fetchStatus.mockResolvedValue({ status: 'REFUNDED', swapDetails: { refundReason: 'Refunded by provider' } });

    await reconcileOneClickSwaps();

    expect(row.extraInputs.oneClick.phase).toBe('refunded');
    expect(row.extraInputs.phase).toBe('failed');
    expect(activityBridgeStatus(row.extraInputs.phase)).toBe('failed');
    expect(row.extraInputs.oneClick).toMatchObject({ originTransactionHash });

    await reconcileOneClickSwaps();

    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(submitDeposit).not.toHaveBeenCalled();
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

  const bridgedSendRow = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    type: 'bridged-send',
    accountId: 'miden-account-id',
    initiatedAt: Date.now(),
    status: ITransactionStatus.Completed,
    transactionId: `0x${'ef'.repeat(32)}`,
    secondaryAccountId: 'miden-deposit-address',
    ...overrides,
    extraInputs: {
      provider: 'near-intents',
      destinationAddress: request.recipient,
      destinationNetwork: 1,
      sourceFaucetId: 'miden-faucet',
      claimStatus: 'not-applicable',
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
        phase: 'depositing',
        depositAddress: 'miden-deposit-address',
        providerSubmitted: false
      }
    }
  });

  it('submits the Miden transaction id of a NEAR Intents bridged-send and follows it to delivery', async () => {
    const row = bridgedSendRow('bridged-send-delivered');
    storedRows.push(row);
    submitDeposit.mockResolvedValue({ status: 'PROCESSING', swapDetails: {} });
    fetchStatus.mockResolvedValue({ status: 'SUCCESS', swapDetails: {} });

    await reconcileOneClickSwaps();
    await reconcileOneClickSwaps();

    expect(submitDeposit).toHaveBeenCalledTimes(1);
    expect(submitDeposit).toHaveBeenCalledWith(
      config,
      'miden-deposit-address',
      row.transactionId,
      undefined,
      quote
    );
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(row.extraInputs.oneClick).toMatchObject({ phase: 'delivered', providerSubmitted: true });
    // Only a bridged-receive row carries a row-level phase.
    expect(row.extraInputs).not.toHaveProperty('phase');
  });

  it('ends a NEAR Intents bridged-send as refunded', async () => {
    const row = bridgedSendRow('bridged-send-refunded');
    storedRows.push(row);
    submitDeposit.mockResolvedValue({ status: 'REFUNDED', swapDetails: {} });

    await reconcileOneClickSwaps();
    await reconcileOneClickSwaps();

    expect(submitDeposit).toHaveBeenCalledTimes(1);
    expect(row.extraInputs.oneClick.phase).toBe('refunded');
  });

  it.each([
    ['queued', { status: ITransactionStatus.Queued, transactionId: undefined }],
    ['in progress', { status: ITransactionStatus.GeneratingTransaction, transactionId: undefined }],
    ['unconfirmed', { status: ITransactionStatus.Unconfirmed, transactionId: undefined }],
    ['failed', { status: ITransactionStatus.Failed }],
    ['restored from a backup', { restoredFromBackup: true }]
  ])('does not submit or poll a NEAR Intents bridged-send that is %s', async (_label, overrides) => {
    storedRows.push(bridgedSendRow('bridged-send-waiting', overrides));

    await reconcileOneClickSwaps();

    expect(submitDeposit).not.toHaveBeenCalled();
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it('never reads an Epoch or Agglayer bridged-send row', async () => {
    storedRows.push({
      id: 'epoch-row',
      type: 'bridged-send',
      accountId: 'miden-account-id',
      initiatedAt: Date.now(),
      status: ITransactionStatus.Completed,
      transactionId: `0x${'aa'.repeat(32)}`,
      extraInputs: { provider: 'epoch', destinationAddress: '0x1', destinationNetwork: 1, claimStatus: 'not-applicable' }
    });

    await reconcileOneClickSwaps();

    expect(submitDeposit).not.toHaveBeenCalled();
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it('submits the Miden transaction id of a send to Solana and ends the row as refunded', async () => {
    const solanaAsset: OneClickAsset = { assetId: 'sol-asset', blockchain: 'sol', symbol: 'SOL', decimals: 9 };
    const solanaRecipient = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
    const midenDepositAddress = 'mm1arwrrznxhwfzky2feqrnvalc9qvzc7f6_qr7qqq9wr6w';
    const midenTransactionId = `0x${'ab'.repeat(32)}`;
    const outboundRow = {
      id: 'outbound-solana-refund-row',
      type: 'send',
      accountId: 'miden-account-id',
      initiatedAt: Date.now(),
      status: ITransactionStatus.Completed,
      transactionId: midenTransactionId,
      extraInputs: {
        oneClick: {
          direction: 'miden-to-evm',
          request: { ...request, destinationAsset: solanaAsset, recipient: solanaRecipient },
          quote: { ...quote, quote: { ...quote.quote, depositAddress: midenDepositAddress } },
          config,
          network: 'mainnet',
          accountId: 'miden-account-id',
          accountAddress: 'miden-account',
          originAsset,
          destinationAsset: solanaAsset,
          faucetId: 'miden-faucet',
          amount: request.amount,
          phase: 'depositing',
          depositAddress: midenDepositAddress,
          providerSubmitted: false
        }
      }
    };
    storedRows.push(outboundRow);
    submitDeposit.mockResolvedValue({ status: 'PROCESSING', swapDetails: {} });
    fetchStatus.mockResolvedValue({ status: 'REFUNDED', swapDetails: { refundReason: 'price moved' } });

    await reconcileOneClickSwaps();
    await reconcileOneClickSwaps();

    expect(submitDeposit).toHaveBeenCalledTimes(1);
    expect(submitDeposit).toHaveBeenCalledWith(
      config,
      midenDepositAddress,
      midenTransactionId,
      undefined,
      outboundRow.extraInputs.oneClick.quote
    );
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(outboundRow.extraInputs.oneClick).toMatchObject({
      phase: 'refunded',
      providerStatus: 'REFUNDED',
      providerSubmitted: true
    });
  });

  it('ends a Miden send as refunded when the deposit submission reports the refund', async () => {
    const outboundRow = {
      id: 'outbound-submit-refund-row',
      type: 'send',
      accountId: 'miden-account-id',
      initiatedAt: Date.now(),
      status: ITransactionStatus.Completed,
      transactionId: `0x${'cd'.repeat(32)}`,
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
          phase: 'depositing',
          depositAddress: 'miden-deposit-address',
          providerSubmitted: false
        }
      }
    };
    storedRows.push(outboundRow);
    submitDeposit.mockResolvedValue({ status: 'REFUNDED', swapDetails: {} });
    fetchStatus.mockResolvedValue({ status: 'REFUNDED', swapDetails: {} });

    await reconcileOneClickSwaps();
    await reconcileOneClickSwaps();

    expect(submitDeposit).toHaveBeenCalledTimes(1);
    expect(outboundRow.extraInputs.oneClick.phase).toBe('refunded');
  });

  it('queues a NEAR Intents bridged-send of the account-bound amount to the signed deposit address', async () => {
    const authorization = {
      kind: 'unpriced' as const,
      id: 'authorization',
      accountId: 'miden-account-id',
      spendsDigest: 'digest',
      revision: '1',
      issuedAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER
    };
    await expect(initiateOneClickMidenDeposit(input, authorization)).resolves.toBe('send-row-id');

    expect(initiateSend).toHaveBeenCalledWith(
      {
        senderAccountId: 'miden-account-id',
        depositAddress: 'miden-deposit-address',
        faucetId: 'miden-faucet',
        amount: 1000000n
      },
      expect.objectContaining({ direction: 'miden-to-evm', quote: expect.any(Object), phase: 'depositing' }),
      authorization
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
        expect.objectContaining({ depositAddress: 'miden-deposit-address', amount: 1000000n }),
        expect.objectContaining({
          fundingDeadline: new Date(
            Date.parse(signedRequestDeadline) < Date.parse(providerExpiry) ? signedRequestDeadline : providerExpiry
          ).toISOString(),
          request: expect.objectContaining({ deadline: signedRequestDeadline }),
          quote: signedQuote
        }),
        undefined
      );
      const tracking = initiateSend.mock.calls[0]?.[1];
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

describe('NEAR Intents deposit expiry', () => {
  it('expires a deposit that 1Click still waits for after the funding deadline and the grace time', async () => {
    const row = inboundRow('unpaid-row', { phase: 'pending-deposit', fundingDeadline: pastGrace() });
    storedRows.push(row);

    await reconcileOneClickSwaps();

    expect(row.extraInputs.oneClick).toMatchObject({
      phase: 'expired',
      providerStatus: 'PENDING_DEPOSIT',
      error: NEAR_INTENTS_DEPOSIT_EXPIRED_ERROR
    });
    expect(row.extraInputs.phase).toBe('failed');
    expect(activityBridgeStatus(row.extraInputs.phase)).toBe('failed');

    await reconcileOneClickSwaps();
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('keeps a pending deposit open inside the grace time', async () => {
    const row = inboundRow('grace-row', { phase: 'pending-deposit', fundingDeadline: withinGrace() });
    storedRows.push(row);

    await reconcileOneClickSwaps();

    expect(row.extraInputs.oneClick.phase).toBe('pending-deposit');
    expect(row.extraInputs.phase).toBe('delivering');
  });

  it('reads the funding deadline from the signed quote when the row stored none', async () => {
    const expired = pastGrace();
    const tracking = inboundTracking({
      request: { ...inboundInput.request, deadline: expired },
      quote: { ...inboundInput.quote, quote: { ...inboundInput.quote.quote, deadline: expired } }
    });

    expect(isNearIntentsDepositExpired(tracking)).toBe(true);
    expect(isNearIntentsDepositExpired(tracking, Date.parse(expired))).toBe(false);
  });

  it.each(['KNOWN_DEPOSIT_TX', 'PROCESSING', 'INCOMPLETE_DEPOSIT'] as const)(
    'never expires a deposit that 1Click reports as %s',
    async status => {
      const row = inboundRow(`seen-${status}`, { phase: 'pending-deposit', fundingDeadline: pastGrace() });
      storedRows.push(row);
      fetchStatus.mockResolvedValue({ status, swapDetails: {} });

      await reconcileOneClickSwaps();

      expect(row.extraInputs.oneClick.phase).toBe(phaseForProviderStatus(status));
      expect(row.extraInputs.phase).toBe('delivering');
    }
  );

  it('expires an unpaid deposit one day after its deadline when 1Click has no record of its address', async () => {
    const row = inboundRow('unknown-row', { fundingDeadline: pastUnknownDay() });
    storedRows.push(row);
    fetchStatus.mockRejectedValue(new OneClickHttpError(404));

    await reconcileOneClickSwaps();

    expect(row.extraInputs.oneClick).toMatchObject({ phase: 'expired', error: NEAR_INTENTS_DEPOSIT_EXPIRED_ERROR });
    expect(row.extraInputs.phase).toBe('failed');
  });

  it('keeps the row open in the first day of a missing record', async () => {
    const row = inboundRow('unknown-recent-row', { fundingDeadline: pastGrace() });
    storedRows.push(row);
    fetchStatus.mockRejectedValue(new OneClickHttpError(404));

    await reconcileOneClickSwaps();

    expect(row.extraInputs.oneClick.phase).toBe('depositing');
  });

  it('keeps the row open when the status read fails for another reason', async () => {
    const row = inboundRow('offline-row', { fundingDeadline: pastGrace() });
    storedRows.push(row);
    fetchStatus.mockRejectedValue(new Error('network down'));

    await reconcileOneClickSwaps();

    expect(row.extraInputs.oneClick.phase).toBe('depositing');
    expect(row.extraInputs.phase).toBe('submitting');
  });

  it('does not expire on a missing record after 1Click saw the deposit', async () => {
    const row = inboundRow('seen-row', {
      phase: 'processing',
      providerStatus: 'PROCESSING',
      fundingDeadline: pastUnknownDay()
    });
    storedRows.push(row);
    fetchStatus.mockRejectedValue(new OneClickHttpError(404));

    await reconcileOneClickSwaps();

    expect(row.extraInputs.oneClick.phase).toBe('processing');
  });

  it('never expires an outbound Miden send or a row with a known origin transaction', () => {
    const deadline = pastGrace();
    expect(isNearIntentsDepositExpired(inboundTracking({ direction: 'miden-to-evm', fundingDeadline: deadline }))).toBe(
      false
    );
    expect(
      isNearIntentsDepositExpired(inboundTracking({ originTransactionHash: '0xhash', fundingDeadline: deadline }))
    ).toBe(false);
    expect(isNearIntentsDepositExpired(inboundTracking({ fundingDeadline: deadline }))).toBe(true);
  });
});

import { ITransactionStatus } from 'lib/miden/db/types';

import { initiateOneClickMidenDeposit, persistOneClickTrackingRow, phaseForProviderStatus } from './tracking';
import { OneClickAsset, OneClickConfig, OneClickQuoteRequest, OneClickQuoteResponse } from './types';

const addTransaction = jest.fn();
const initiateSend = jest.fn();

jest.mock('lib/miden/repo', () => ({
  transactions: {
    add: (...args: unknown[]) => addTransaction(...args)
  }
}));
jest.mock('lib/miden/sdk/helpers', () => ({ sameWalletAccountId: (left: string, right: string) => left === right }));
jest.mock('lib/one-click/client', () => ({
  assertOneClickQuoteBinding: jest.fn(),
  fetchOneClickStatus: jest.fn(),
  resolveOneClickDestinationReceipts: jest.fn(),
  submitOneClickDeposit: jest.fn()
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

beforeEach(() => {
  jest.clearAllMocks();
  addTransaction.mockResolvedValue('row-id');
  initiateSend.mockResolvedValue('send-row-id');
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
        request: { deadline: signedRequestDeadline },
        quote: {
          quoteRequest: { deadline: signedRequestDeadline },
          quote: { deadline: providerExpiry }
        }
      });
    }
  );

  it('refuses to persist a quote whose Miden destination is another account', async () => {
    await expect(persistOneClickTrackingRow({ ...inboundInput, accountAddress: 'different-account' })).rejects.toThrow(
      'not bound to the selected Miden account'
    );
    expect(addTransaction).not.toHaveBeenCalled();
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

    await expect(initiateOneClickMidenDeposit({ ...input, request: signedRequest, quote: signedQuote })).rejects.toThrow(
      /expired/i
    );
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
          request: { deadline: signedRequestDeadline },
          quote: signedQuote
        })
      );
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

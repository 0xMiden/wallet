import {
  preparedExecution,
  PREPARED_OWNER,
  PREPARED_RECIPIENT,
  PREPARED_FAUCET
} from 'lib/epoch/testing/earn-prepared';
import type { IOneClickTrackingData, ITransaction } from 'lib/miden/db/types';
import { ITransactionStatus } from 'lib/miden/db/types';

export function oneClickReceiptRow(): ITransaction {
  const originAsset = { assetId: 'eth-usdc', blockchain: 'eth', symbol: 'USDC', decimals: 6, chainId: 1 };
  const destinationAsset = {
    assetId: 'miden-usdc',
    blockchain: 'miden',
    symbol: 'USDCx',
    decimals: 6,
    faucetId: PREPARED_FAUCET
  };
  const request = {
    amount: '1000000',
    originAsset,
    destinationAsset,
    refundTo: PREPARED_OWNER,
    recipient: PREPARED_RECIPIENT,
    deadline: '2020-01-01T00:00:00Z',
    slippageTolerance: 100
  };
  const quote: IOneClickTrackingData['quote'] = {
    correlationId: 'receipt-correlation',
    timestamp: '2019-12-31T23:59:00Z',
    signature: 'provider-signature',
    quoteRequest: {
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: originAsset.assetId,
      destinationAsset: destinationAsset.assetId,
      depositType: 'ORIGIN_CHAIN',
      amount: '1000000',
      refundTo: PREPARED_OWNER,
      refundType: 'ORIGIN_CHAIN',
      recipient: PREPARED_RECIPIENT,
      recipientType: 'DESTINATION_CHAIN',
      deadline: request.deadline
    },
    quote: {
      depositAddress: PREPARED_OWNER,
      depositMemo: 'receipt-memo',
      amountIn: '1000000',
      amountInFormatted: '1',
      amountInUsd: '1',
      minAmountIn: '1000000',
      amountOut: '990000',
      amountOutFormatted: '0.99',
      amountOutUsd: '0.99',
      minAmountOut: '980000',
      deadline: request.deadline,
      timeEstimate: 10
    }
  };
  const oneClick: IOneClickTrackingData = {
    direction: 'evm-to-miden',
    request,
    quote,
    config: {
      serviceUrl: 'https://oneclick.example/api',
      midenAssets: [{ assetId: destinationAsset.assetId, faucetId: PREPARED_FAUCET, decimals: 6 }]
    },
    network: 'testnet:node',
    accountId: PREPARED_RECIPIENT,
    accountAddress: PREPARED_RECIPIENT,
    originAsset,
    destinationAsset,
    faucetId: PREPARED_FAUCET,
    amount: '990000',
    phase: 'processing',
    depositAddress: PREPARED_OWNER,
    depositMemo: 'receipt-memo',
    fundingDeadline: request.deadline,
    evmSubmission: 'known',
    originTransactionHash: `0x${'1'.repeat(64)}`,
    providerStatus: 'PROCESSING',
    statusResponse: {
      correlationId: quote.correlationId,
      quoteResponse: quote,
      status: 'PROCESSING',
      updatedAt: '2020-01-01T00:01:00Z',
      swapDetails: {
        intentHashes: ['intent-1'],
        nearTxHashes: [],
        originChainTxHashes: [{ hash: `0x${'1'.repeat(64)}`, explorerUrl: 'https://explorer.example/tx/1' }],
        destinationChainTxHashes: []
      }
    }
  };
  return {
    id: 'receipt-oneclick',
    accountId: PREPARED_RECIPIENT,
    type: 'bridged-receive',
    status: ITransactionStatus.Completed,
    initiatedAt: 1,
    displayIcon: 'RECEIVE',
    amount: 990000n,
    faucetId: PREPARED_FAUCET,
    extraInputs: {
      provider: 'near-intents',
      phase: 'delivering',
      sourceAddress: PREPARED_OWNER,
      sourceAmount: '1',
      sourceSymbol: 'USDC',
      oneClick
    }
  };
}

export function earnReceiptRow(): ITransaction {
  return {
    id: 'receipt-earn',
    accountId: PREPARED_RECIPIENT,
    type: 'earn-withdraw',
    status: ITransactionStatus.Completed,
    initiatedAt: 1,
    displayIcon: 'RECEIVE',
    extraInputs: {
      evmOwner: PREPARED_OWNER,
      marketUid: 'DUMMY_LENDING:11155111:token',
      destinationFaucetId: PREPARED_FAUCET,
      sourceAmount: '10',
      sourceSymbol: 'USDC',
      sourceDecimals: 6,
      phase: 'delivering',
      epochAllocatorUrl: 'https://allocator.example',
      underlyingAddress: PREPARED_OWNER,
      reviewedMinimumReceivedAtomic: '9900000',
      submissionAttemptId: 'attempt-1',
      attemptStartedAt: 1,
      submissionState: 'prepared',
      withdrawIntentNonce: '22',
      preparedExecution: {
        ...preparedExecution(),
        attemptId: 'attempt-1',
        delivery: {
          allocationIndex: 1,
          owner: PREPARED_OWNER,
          nonce: '22',
          destinationChainId: 999999999,
          recipientAccountId: PREPARED_RECIPIENT,
          destinationFaucetId: PREPARED_FAUCET
        }
      }
    }
  };
}

export function receiptSnapshot(row = oneClickReceiptRow()) {
  return {
    version: 1,
    sequence: 1,
    scope: { network: 'testnet:node', walletGeneration: 'wallet-1', sdkGeneration: 'sdk-1' },
    accounts: [{ accountId: row.accountId, nonce: '3', commitment: 'commitment-3' }],
    entries: [{ kind: 'receipt', id: row.id, accountId: row.accountId, row }]
  };
}

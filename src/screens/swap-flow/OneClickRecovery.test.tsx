import React from 'react';

import { render, screen, waitFor } from '@testing-library/react';

import { IOneClickTrackingData } from 'lib/miden/db/types';
import { fetchOneClickAssets } from 'lib/one-click/client';
import { OneClickAsset, OneClickConfig } from 'lib/one-click/types';

import { OneClickRecovery } from './OneClickRecovery';

let mockAccount = { publicKey: 'miden-account' };
let mockNetwork = 'mainnet';
let mockConfig: OneClickConfig | null = { serviceUrl: 'https://quotes.example', midenAssets: [] };
let mockCatalog: OneClickAsset[] = [];

jest.mock('lib/miden/front', () => ({ useAccount: () => mockAccount }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: () => mockNetwork,
  getEffectiveRpcUrl: () => 'https://rpc.example'
}));
jest.mock('lib/remote-config/derive', () => ({ readMidenFaucetMetadata: jest.fn() }));
jest.mock('lib/one-click/config', () => ({ useOneClickConfig: () => mockConfig }));
jest.mock('lib/one-click/client', () => ({
  createMidenAssetMetadataResolver: jest.fn(() => jest.fn()),
  fetchOneClickAssets: jest.fn(async () => mockCatalog)
}));
jest.mock('./OneClickFlow', () => ({
  OneClickFlow: ({ initialRecovery }: { initialRecovery?: IOneClickTrackingData }) => (
    <div data-testid="restored-flow" data-destination={initialRecovery?.destinationAsset.blockchain} />
  )
}));

const config: OneClickConfig = { serviceUrl: 'https://quotes.example', midenAssets: [] };
const origin: OneClickAsset = {
  assetId: 'miden:token',
  blockchain: 'miden',
  symbol: 'MIDEN',
  decimals: 6,
  faucetId: '0x111111111111111111111111111111'
};
const destination: OneClickAsset = {
  assetId: 'sol:token',
  blockchain: 'sol',
  symbol: 'SOL',
  decimals: 9,
  contractAddress: 'sol-contract'
};
const evmOrigin: OneClickAsset = {
  assetId: 'eth:token',
  blockchain: 'eth',
  symbol: 'USDC',
  decimals: 6,
  contractAddress: '0x5555555555555555555555555555555555555555',
  chainId: 1
};
const tracking: IOneClickTrackingData = {
  direction: 'miden-to-evm',
  request: {
    amount: '1000000',
    originAsset: origin,
    destinationAsset: destination,
    refundTo: 'miden-account',
    recipient: 'sol-recipient',
    deadline: '2000-01-01T00:00:00.000Z',
    slippageTolerance: 100
  },
  quote: {
    correlationId: 'correlation',
    timestamp: '2026-10-22T00:00:00.000Z',
    signature: 'signature',
    quoteRequest: {
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: origin.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: destination.assetId,
      amount: '1000000',
      refundTo: 'miden-account',
      refundType: 'ORIGIN_CHAIN',
      recipient: 'sol-recipient',
      recipientType: 'DESTINATION_CHAIN',
      deadline: '2000-01-01T00:00:00.000Z'
    },
    quote: {
      depositAddress: 'deposit-address',
      amountIn: '1000000',
      amountInFormatted: '1 MIDEN',
      amountInUsd: '1',
      minAmountIn: '1000000',
      amountOut: '1000000000',
      amountOutFormatted: '1 SOL',
      amountOutUsd: '1',
      minAmountOut: '900000000',
      timeEstimate: 120
    }
  },
  config,
  network: 'mainnet',
  accountId: 'miden-account',
  accountAddress: 'miden-account',
  originAsset: origin,
  destinationAsset: destination,
  faucetId: '0x111111111111111111111111111111',
  amount: '1000000',
  phase: 'failed'
};

beforeEach(() => {
  mockAccount = { publicKey: 'miden-account' };
  mockNetwork = 'mainnet';
  mockConfig = config;
  mockCatalog = [origin, destination];
  jest.clearAllMocks();
});

describe('OneClickRecovery', () => {
  it('restores a validated route from surviving mappings in a partial catalog', async () => {
    mockConfig = {
      ...config,
      midenAssets: [
        { assetId: 'miden:token', faucetId: '0x111111111111111111111111111111', decimals: 6 },
        { assetId: 'miden:other', faucetId: '0x222222222222222222222222222222', decimals: 6 }
      ]
    };
    render(<OneClickRecovery tracking={tracking} transactionAccountId="miden-account" onBack={jest.fn()} />);

    expect(await screen.findByTestId('restored-flow')).toHaveAttribute('data-destination', 'sol');
    expect(fetchOneClickAssets).toHaveBeenCalledTimes(1);
  });

  it('restores an ambiguous inbound attempt without offering another funding submit', async () => {
    const inbound = Object.assign(
      {
        ...tracking,
        direction: 'evm-to-miden' as const,
        request: {
          ...tracking.request,
          originAsset: evmOrigin,
          destinationAsset: origin,
          refundTo: '0x7777777777777777777777777777777777777777',
          recipient: 'miden-account'
        },
        quote: {
          ...tracking.quote,
          quoteRequest: {
            ...tracking.quote.quoteRequest,
            originAsset: evmOrigin.assetId,
            destinationAsset: origin.assetId,
            refundTo: '0x7777777777777777777777777777777777777777',
            recipient: 'miden-account'
          },
          quote: { ...tracking.quote.quote, depositAddress: '0x8888888888888888888888888888888888888888' }
        },
        originAsset: evmOrigin,
        destinationAsset: origin,
        faucetId: origin.faucetId,
        phase: 'pending-deposit' as const,
        accountAddress: 'miden-account'
      },
      { evmSubmission: 'attempted' as const }
    );
    mockConfig = {
      ...config,
      midenAssets: [{ assetId: origin.assetId, faucetId: origin.faucetId!, decimals: origin.decimals }]
    };
    mockCatalog = [evmOrigin, origin];
    render(<OneClickRecovery tracking={inbound} transactionAccountId="miden-account" onBack={jest.fn()} />);

    expect(await screen.findByTestId('restored-flow')).toBeInTheDocument();
  });

  it.each([
    [
      'different connected account',
      () => {
        mockAccount = { publicKey: 'another-account' };
      }
    ],
    [
      'different network',
      () => {
        mockNetwork = 'testnet';
      }
    ],
    [
      'changed destination mapping',
      () => {
        mockCatalog = [origin, { ...destination, contractAddress: 'changed' }];
      }
    ]
  ])('rejects recovery for %s', async (_label, change) => {
    change();
    render(<OneClickRecovery tracking={tracking} transactionAccountId="miden-account" onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('oneClickRecoveryUnavailableBody')).toBeInTheDocument());
    expect(screen.queryByTestId('restored-flow')).not.toBeInTheDocument();
  });
});

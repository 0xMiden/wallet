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
  it('restores a validated Miden to non-EVM route for fresh review', async () => {
    render(<OneClickRecovery tracking={tracking} transactionAccountId="miden-account" onBack={jest.fn()} />);

    expect(await screen.findByTestId('restored-flow')).toHaveAttribute('data-destination', 'sol');
    expect(fetchOneClickAssets).toHaveBeenCalledTimes(1);
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

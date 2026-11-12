import type { IOneClickTrackingData } from 'lib/miden/db/types';
import type { OneClickAsset } from 'lib/one-click/types';

export const PAYMENT_NOW = Date.parse('2026-11-10T14:27:08Z');
const DEADLINE = '2026-11-10T14:32:00Z';

const usdc: OneClickAsset = { assetId: 'nep141:eth-usdc', blockchain: 'eth', symbol: 'USDC', decimals: 6 };
const usdcx: OneClickAsset = {
  assetId: 'miden:usdcx',
  blockchain: 'miden',
  symbol: 'USDCx',
  decimals: 6,
  faucetId: 'mm1faucet'
};

export function paymentTracking(overrides: Partial<IOneClickTrackingData> = {}): IOneClickTrackingData {
  return {
    direction: 'evm-to-miden',
    request: {
      amount: '46000000',
      originAsset: usdc,
      destinationAsset: usdcx,
      refundTo: '0x91b2000000000000000000000000000000007f0a',
      recipient: 'mm1account',
      deadline: DEADLINE,
      slippageTolerance: 100
    },
    quote: {
      correlationId: 'c',
      timestamp: '2026-11-10T14:27:00Z',
      signature: 's',
      quoteRequest: {
        dry: false,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: usdc.assetId,
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: usdcx.assetId,
        amount: '46000000',
        refundTo: '0x91b2000000000000000000000000000000007f0a',
        refundType: 'ORIGIN_CHAIN',
        recipient: 'mm1account',
        recipientType: 'DESTINATION_CHAIN',
        deadline: DEADLINE
      },
      quote: {
        depositAddress: '0x7a3f09d1000000000000000000000000c91e2b4a',
        amountIn: '46000000',
        amountInFormatted: '46',
        amountInUsd: '45.99',
        minAmountIn: '46000000',
        amountOut: '45910000',
        amountOutFormatted: '45.91',
        amountOutUsd: '45.91',
        minAmountOut: '45000000',
        deadline: DEADLINE,
        timeEstimate: 120
      }
    },
    fundingDeadline: DEADLINE,
    config: {
      serviceUrl: 'https://1click.example',
      midenAssets: [],
      chains: [{ id: 'eth', name: 'Ethereum', addressKind: 'evm', tokens: [] }]
    },
    network: 'mainnet',
    accountId: 'mm1account',
    accountAddress: 'mm1account',
    originAsset: usdc,
    destinationAsset: usdcx,
    faucetId: 'mm1faucet',
    amount: '45910000',
    phase: 'depositing',
    depositAddress: '0x7a3f09d1000000000000000000000000c91e2b4a',
    ...overrides
  };
}

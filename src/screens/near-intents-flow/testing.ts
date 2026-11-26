/**
 * Test data only: a NEAR Intents deposit into Miden (46 USDC on Ethereum for 45.91 USDCx), as the deposit page, the
 * Home row and the arrival notice read it. Production code does not import this module.
 */
import { ITransactionStatus, type IOneClickTrackingData, type ITransaction } from 'lib/miden/db/types';
import type { OneClickAsset } from 'lib/one-click/types';

export const NEAR_TEST_DEADLINE = '2026-11-10T14:32:00Z';
export const NEAR_TEST_DEPOSIT_ADDRESS = '0x7a3f09d1000000000000000000000000c91e2b4a';
export const NEAR_TEST_REFUND_TO = '0x91b2000000000000000000000000000000007f0a';

const usdc: OneClickAsset = { assetId: 'nep141:eth-usdc', blockchain: 'eth', symbol: 'USDC', decimals: 6 };
const usdcx: OneClickAsset = {
  assetId: 'miden:usdcx',
  blockchain: 'miden',
  symbol: 'USDCx',
  decimals: 6,
  faucetId: 'mm1faucet'
};

export function nearTrackingFixture(overrides: Partial<IOneClickTrackingData> = {}): IOneClickTrackingData {
  return {
    direction: 'evm-to-miden',
    request: {
      amount: '46000000',
      originAsset: usdc,
      destinationAsset: usdcx,
      refundTo: NEAR_TEST_REFUND_TO,
      recipient: 'mm1account',
      deadline: NEAR_TEST_DEADLINE,
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
        refundTo: NEAR_TEST_REFUND_TO,
        refundType: 'ORIGIN_CHAIN',
        recipient: 'mm1account',
        recipientType: 'DESTINATION_CHAIN',
        deadline: NEAR_TEST_DEADLINE
      },
      quote: {
        depositAddress: NEAR_TEST_DEPOSIT_ADDRESS,
        amountIn: '46000000',
        amountInFormatted: '46',
        amountInUsd: '45.99',
        minAmountIn: '46000000',
        amountOut: '45910000',
        amountOutFormatted: '45.91',
        amountOutUsd: '45.91',
        minAmountOut: '45000000',
        deadline: NEAR_TEST_DEADLINE,
        timeEstimate: 120
      }
    },
    fundingDeadline: NEAR_TEST_DEADLINE,
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
    depositAddress: NEAR_TEST_DEPOSIT_ADDRESS,
    ...overrides
  };
}

/** A `bridged-receive` row of the account `mm1account` that carries `oneClick` (no tracking when undefined). */
export function nearRowFixture(
  oneClick: IOneClickTrackingData | undefined,
  overrides: Partial<ITransaction> = {}
): ITransaction {
  return {
    id: 'row-1',
    type: 'bridged-receive',
    accountId: 'mm1account',
    status: ITransactionStatus.Queued,
    initiatedAt: Math.floor(Date.parse('2026-11-10T14:27:00Z') / 1000),
    displayIcon: 'RECEIVE',
    extraInputs: oneClick ? { oneClick } : {},
    ...overrides
  };
}

/**
 * The reclaim window is validated at the choke point every send funnels
 * through, not only at the dApp boundary.
 *
 * `recallBlocks` is stored on chain as a 32-bit block height and a value that
 * does not fit is TRUNCATED rather than refused, so a window just past the
 * limit wraps to zero: the note becomes reclaimable the moment it lands while
 * the screen that asked for consent says years, and a recipient who does not
 * claim in time loses the funds to the sender's reclaim. A negative window
 * wraps the other way and puts the sender's own recall out of reach.
 *
 * The wallet's own review screen reaches this by `parseInt`ing a date the user
 * picked from a calendar, so an out-of-range window is a couple of taps away
 * and needs no hostile page at all — which is why the guard cannot live only in
 * the dApp request handler.
 */
import type { OneClickAsset, OneClickConfig } from 'lib/one-click/types';

import type { IOneClickTrackingData, SendTransaction } from '../db/types';
import { MAX_RECALL_BLOCKS } from '../helpers';
import { NoteTypeEnum } from '../types';
import { initiateSendTransaction } from './initiate';

const mockAdd = jest.fn(async (_transaction: SendTransaction) => undefined);
jest.mock('lib/miden/repo', () => ({
  get transactions() {
    return { add: mockAdd };
  }
}));
jest.mock('../spending-limits/queue', () => ({
  spendsOf: (transaction: { faucetId: string; amount: bigint }) => [
    { faucetId: transaction.faucetId, amount: transaction.amount }
  ],
  queueOutgoingTransaction: jest.fn(async transaction => {
    const repo = jest.requireMock('lib/miden/repo');
    await repo.transactions.add(transaction);
  })
}));

jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: jest.fn() }));
jest.mock('../back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('../sdk/miden-client', () => ({ withWasmClientLock: async (fn: () => unknown) => fn() }));
jest.mock('../activity/notes', () => ({ queueNoteImport: jest.fn() }));
jest.mock('lib/store', () => ({ getIntercom: jest.fn() }));
jest.mock('lib/platform', () => ({ isExtension: () => true }));
jest.mock('lib/one-click/client', () => ({ assertOneClickQuoteBinding: jest.fn() }));

const sender = 'mtst1sender';
const recipient = 'mtst1recipient';
const faucetId = 'mtst1faucet';
const deadline = new Date(Date.now() + 60 * 60_000).toISOString();
const depositDeadline = new Date(Date.now() + 30 * 60_000).toISOString();
const midenAsset: OneClickAsset = { assetId: 'miden-usdc', blockchain: 'miden', symbol: 'USDC', decimals: 6 };
const evmAsset: OneClickAsset = {
  assetId: 'eth-usdc',
  blockchain: 'eth' as const,
  symbol: 'USDC',
  decimals: 6,
  contractAddress: '0x1111111111111111111111111111111111111111',
  chainId: 1
};
const oneClickConfig: OneClickConfig = {
  serviceUrl: 'https://one-click.example',
  midenAssets: [{ assetId: midenAsset.assetId, faucetId, decimals: midenAsset.decimals }]
};
const oneClickMetadata: IOneClickTrackingData = {
  direction: 'miden-to-evm',
  request: {
    amount: '1000',
    originAsset: midenAsset,
    destinationAsset: evmAsset,
    refundTo: sender,
    recipient,
    deadline,
    slippageTolerance: 100
  },
  quote: {
    correlationId: 'test-correlation',
    timestamp: new Date().toISOString(),
    signature: 'fixture-signature',
    quoteRequest: {
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: midenAsset.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: evmAsset.assetId,
      amount: '1000',
      refundTo: sender,
      refundType: 'ORIGIN_CHAIN',
      recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline
    },
    quote: {
      depositAddress: recipient,
      amountIn: '1000',
      amountInFormatted: '0.001',
      amountInUsd: '0.001',
      minAmountIn: '1000',
      amountOut: '1000',
      amountOutFormatted: '0.001',
      amountOutUsd: '0.001',
      minAmountOut: '990',
      deadline: depositDeadline,
      timeEstimate: 60
    }
  },
  config: oneClickConfig,
  network: 'testnet',
  accountId: sender,
  accountAddress: sender,
  originAsset: midenAsset,
  destinationAsset: evmAsset,
  faucetId,
  amount: '1000',
  phase: 'depositing'
};

const send = (recallBlocks?: number) =>
  initiateSendTransaction('mtst1sender', 'mtst1recipient', 'mtst1faucet', NoteTypeEnum.Private, 1000n, recallBlocks);

beforeEach(() => jest.clearAllMocks());

describe('initiateSendTransaction - reclaim window bounds', () => {
  it.each([
    ['request cutoff first', 20, 40],
    ['provider expiry first', 40, 20]
  ])('persists the earlier %s separately on the ordinary send row', async (_label, requestMinutes, providerMinutes) => {
    const signedRequestDeadline = new Date(Date.now() + requestMinutes * 60_000).toISOString();
    const providerExpiry = new Date(Date.now() + providerMinutes * 60_000).toISOString();
    const expectedFundingDeadline = new Date(
      Math.min(Date.parse(signedRequestDeadline), Date.parse(providerExpiry))
    ).toISOString();
    const tracking = {
      ...oneClickMetadata,
      request: { ...oneClickMetadata.request, deadline: signedRequestDeadline },
      quote: {
        ...oneClickMetadata.quote,
        quoteRequest: { ...oneClickMetadata.quote.quoteRequest, deadline: signedRequestDeadline },
        quote: { ...oneClickMetadata.quote.quote, deadline: providerExpiry }
      }
    };
    expect(tracking).not.toHaveProperty('fundingDeadline');
    await Reflect.apply(initiateSendTransaction, undefined, [
      sender,
      recipient,
      faucetId,
      NoteTypeEnum.Public,
      1000n,
      undefined,
      undefined,
      undefined,
      undefined,
      tracking
    ]);

    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'send',
        secondaryAccountId: recipient,
        extraInputs: expect.objectContaining({
          oneClick: expect.objectContaining({ ...tracking, fundingDeadline: expectedFundingDeadline })
        })
      })
    );
    const row = mockAdd.mock.calls.at(0)?.[0];
    if (row === undefined) throw new Error('Expected the ordinary send row to be persisted');
    expect(row.extraInputs?.oneClick).toMatchObject({
      fundingDeadline: expectedFundingDeadline,
      request: { deadline: signedRequestDeadline },
      quote: {
        quoteRequest: { deadline: signedRequestDeadline },
        quote: { deadline: providerExpiry }
      }
    });
  });

  it.each([
    ['the selected sender account', { accountAddress: 'another-account' }],
    [
      'the signed deposit recipient',
      {
        quote: {
          ...oneClickMetadata.quote,
          quote: { ...oneClickMetadata.quote.quote, depositAddress: 'another-recipient' }
        }
      }
    ],
    ['the selected faucet mapping', { config: { ...oneClickConfig, midenAssets: [] } }]
  ])('rejects metadata that changes %s before queueing', async (_label, patch) => {
    await expect(
      Reflect.apply(initiateSendTransaction, undefined, [
        sender,
        recipient,
        faucetId,
        NoteTypeEnum.Public,
        1000n,
        undefined,
        undefined,
        undefined,
        undefined,
        { ...oneClickMetadata, ...patch }
      ])
    ).rejects.toThrow('The 1Click send does not match the signed Miden route.');
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it.each([
    ['one past the u32 ceiling', MAX_RECALL_BLOCKS + 1],
    ['a full u32 wraparound', 2 ** 32],
    ['negative', -1],
    ['fractional', 1.5],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY]
  ])('refuses %s, queueing nothing', async (_label, blocks) => {
    await expect(send(blocks)).rejects.toThrow(/recallBlocks/);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it.each([
    ['a week of blocks', 2016],
    ['exactly the ceiling', MAX_RECALL_BLOCKS],
    ['zero', 0],
    ['omitted — a plain P2ID with no reclaim height', undefined]
  ])('accepts %s', async (_label, blocks) => {
    await expect(send(blocks)).resolves.toEqual(expect.any(String));
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });
});

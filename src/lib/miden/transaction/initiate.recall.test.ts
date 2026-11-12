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
import type { NearIntentsConfig, OneClickAsset } from 'lib/one-click/types';

import { type IOneClickTrackingData, type ITransaction, NEAR_INTENTS_NO_EVM_CHAIN_ID } from '../db/types';
import { MAX_RECALL_BLOCKS } from '../helpers';
import { initiateNearIntentsSendTransaction, initiateSendTransaction } from './initiate';
import type { SpendingLimitAuthorization } from '../spending-limits/types';
import { NoteTypeEnum } from '../types';

const mockAdd = jest.fn(async (_transaction: ITransaction) => undefined);
const mockQueue = jest.fn();
const mockAssertBinding = jest.fn();
jest.mock('lib/miden/repo', () => ({
  get transactions() {
    return { add: mockAdd };
  }
}));
jest.mock('../spending-limits/queue', () => ({
  spendsOf: (transaction: { faucetId: string; amount: bigint }) => [
    { faucetId: transaction.faucetId, amount: transaction.amount }
  ],
  queueOutgoingTransaction: jest.fn(async (transaction, spends, authorization) => {
    mockQueue(transaction, spends, authorization);
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
jest.mock('lib/one-click/client', () => ({
  assertOneClickQuoteBinding: (...args: unknown[]) => mockAssertBinding(...args)
}));

const sender = 'mtst1sender';
const recipient = 'mtst1recipient';
const evmRecipient = '0x2222222222222222222222222222222222222222';
const faucetId = 'mtst1faucet';
const deadline = new Date(Date.now() + 60 * 60_000).toISOString();
const depositDeadline = new Date(Date.now() + 30 * 60_000).toISOString();
const midenAsset: OneClickAsset = { assetId: 'miden-usdc', blockchain: 'miden', symbol: 'USDC', decimals: 6 };
const evmAsset: OneClickAsset = {
  assetId: 'eth-usdc',
  blockchain: 'eth' as const,
  symbol: 'USDC',
  decimals: 6,
  contractAddress: '0x1111111111111111111111111111111111111111'
};
const oneClickConfig: NearIntentsConfig = {
  serviceUrl: 'https://one-click.example',
  chains: [
    {
      id: 'eth',
      name: 'Ethereum',
      addressKind: 'evm',
      tokens: [
        {
          symbol: 'USDC',
          assetId: evmAsset.assetId,
          decimals: evmAsset.decimals,
          contractAddress: evmAsset.contractAddress,
          miden: ['usdc']
        }
      ]
    }
  ],
  midenAssets: [{ id: 'usdc', assetId: midenAsset.assetId, faucetId, decimals: midenAsset.decimals }]
};
const oneClickMetadata: IOneClickTrackingData = {
  direction: 'miden-to-evm',
  request: {
    amount: '1000',
    originAsset: midenAsset,
    destinationAsset: evmAsset,
    refundTo: sender,
    recipient: evmRecipient,
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
      recipient: evmRecipient,
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

const nearIntentsSend = { senderAccountId: sender, depositAddress: recipient, faucetId, amount: 1000n };

describe('initiateNearIntentsSendTransaction', () => {
  it.each([
    ['request cutoff first', 20, 40],
    ['provider expiry first', 40, 20]
  ])('persists the earlier %s on a near-intents bridged-send row', async (_label, requestMinutes, providerMinutes) => {
    const signedRequestDeadline = new Date(Date.now() + requestMinutes * 60_000).toISOString();
    const providerExpiry = new Date(Date.now() + providerMinutes * 60_000).toISOString();
    const expectedFundingDeadline = new Date(
      Math.min(Date.parse(signedRequestDeadline), Date.parse(providerExpiry))
    ).toISOString();
    const tracking: IOneClickTrackingData = {
      ...oneClickMetadata,
      request: { ...oneClickMetadata.request, deadline: signedRequestDeadline },
      quote: {
        ...oneClickMetadata.quote,
        quoteRequest: { ...oneClickMetadata.quote.quoteRequest, deadline: signedRequestDeadline },
        quote: { ...oneClickMetadata.quote.quote, deadline: providerExpiry }
      }
    };
    expect(tracking).not.toHaveProperty('fundingDeadline');
    await initiateNearIntentsSendTransaction(nearIntentsSend, tracking);

    const row = mockAdd.mock.calls.at(0)?.[0];
    if (row === undefined) throw new Error('Expected the bridged-send row to be persisted');
    expect(row.extraInputs?.oneClick).toMatchObject({
      fundingDeadline: expectedFundingDeadline,
      request: { deadline: signedRequestDeadline },
      quote: {
        quoteRequest: { deadline: signedRequestDeadline },
        quote: { deadline: providerExpiry }
      }
    });
  });

  it('queues a public, non-recallable bridged-send row to the deposit address with the real recipient', async () => {
    const authorization: SpendingLimitAuthorization = {
      kind: 'unpriced',
      id: 'authorization',
      accountId: sender,
      spendsDigest: 'digest',
      revision: '1',
      issuedAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER
    };
    const id = await initiateNearIntentsSendTransaction(nearIntentsSend, oneClickMetadata, authorization);

    expect(mockQueue).toHaveBeenCalledWith(
      expect.objectContaining({ id }),
      [{ faucetId, amount: 1000n }],
      authorization
    );
    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        id,
        type: 'bridged-send',
        accountId: sender,
        amount: 1000n,
        faucetId,
        secondaryAccountId: recipient,
        noteType: NoteTypeEnum.Public,
        extraInputs: expect.objectContaining({
          provider: 'near-intents',
          destinationAddress: evmRecipient,
          destinationNetwork: 1,
          destinationChain: { id: 'eth', name: 'Ethereum' },
          sourceFaucetId: faucetId,
          claimStatus: 'not-applicable',
          recallBlocks: undefined,
          outputAmount: '0.001',
          outputSymbol: 'USDC',
          oneClick: expect.objectContaining({ direction: 'miden-to-evm', phase: 'depositing' })
        })
      })
    );
  });

  it('names a chain with no EVM chain id with the config name and a network no chain has', async () => {
    const solAsset: OneClickAsset = { assetId: 'sol-usdc', blockchain: 'sol', symbol: 'USDC', decimals: 6 };
    const solana = 'So1anaRecipient11111111111111111111111111111';
    await initiateNearIntentsSendTransaction(nearIntentsSend, {
      ...oneClickMetadata,
      request: { ...oneClickMetadata.request, destinationAsset: solAsset, recipient: solana },
      destinationAsset: solAsset,
      config: {
        ...oneClickConfig,
        chains: [
          ...oneClickConfig.chains,
          {
            id: 'sol',
            name: 'Solana',
            addressKind: 'solana',
            tokens: [{ symbol: 'USDC', assetId: solAsset.assetId, decimals: 6, miden: ['usdc'] }]
          }
        ]
      }
    });

    expect(mockAdd.mock.calls.at(0)?.[0]?.extraInputs).toMatchObject({
      destinationAddress: solana,
      destinationNetwork: NEAR_INTENTS_NO_EVM_CHAIN_ID,
      destinationChain: { id: 'sol', name: 'Solana' }
    });
  });

  it.each([
    ['the sender account', { accountId: 'another-account' }],
    ['the selected sender address', { accountAddress: 'another-account' }],
    ['the refund address', { request: { ...oneClickMetadata.request, refundTo: 'another-account' } }],
    [
      'the signed deposit recipient',
      {
        quote: {
          ...oneClickMetadata.quote,
          quote: { ...oneClickMetadata.quote.quote, depositAddress: 'another-recipient' }
        }
      }
    ],
    [
      'the signed amount',
      { quote: { ...oneClickMetadata.quote, quote: { ...oneClickMetadata.quote.quote, amountIn: '999' } } }
    ],
    ['the tracked faucet', { faucetId: 'mtst1otherfaucet' }],
    ['the selected faucet mapping', { config: { ...oneClickConfig, midenAssets: [] } }],
    ['the direction', { direction: 'evm-to-miden' as const }],
    ['the Miden origin', { originAsset: { ...midenAsset, blockchain: 'eth' } }],
    ['the destination chain', { destinationAsset: { ...evmAsset, blockchain: 'miden' } }],
    ['the stored funding deadline', { fundingDeadline: new Date(Date.now() + 5 * 60_000).toISOString() }]
  ])('rejects metadata that changes %s before queueing', async (_label, patch) => {
    await expect(
      initiateNearIntentsSendTransaction(nearIntentsSend, { ...oneClickMetadata, ...patch })
    ).rejects.toThrow();
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('rejects a quote whose signature or binding fails', async () => {
    mockAssertBinding.mockImplementationOnce(() => {
      throw new Error('1Click quote signature is invalid');
    });
    await expect(initiateNearIntentsSendTransaction(nearIntentsSend, oneClickMetadata)).rejects.toThrow(
      '1Click quote signature is invalid'
    );
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('rejects an expired quote', async () => {
    const past = new Date(Date.now() - 1_000).toISOString();
    await expect(
      initiateNearIntentsSendTransaction(nearIntentsSend, {
        ...oneClickMetadata,
        request: { ...oneClickMetadata.request, deadline: past }
      })
    ).rejects.toThrow(/expired/i);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('rejects a send that differs from the quote', async () => {
    for (const send of [
      { ...nearIntentsSend, depositAddress: 'another-recipient' },
      { ...nearIntentsSend, amount: 999n },
      { ...nearIntentsSend, faucetId: 'mtst1otherfaucet' },
      { ...nearIntentsSend, senderAccountId: 'another-account' }
    ]) {
      await expect(initiateNearIntentsSendTransaction(send, oneClickMetadata)).rejects.toThrow(
        'The 1Click send does not match the signed Miden route.'
      );
    }
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

describe('initiateSendTransaction - reclaim window bounds', () => {
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

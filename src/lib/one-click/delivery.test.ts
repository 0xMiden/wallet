import { InputNoteState } from '@miden-sdk/miden-sdk/lazy';

import { ITransactionStatus, type IOneClickTrackingData, type ITransaction } from 'lib/miden/db/types';
import type { ConsumableNoteDto } from 'lib/miden/sdk/consumable-notes';

import { hasOneClickDeliveryArrived, oneClickActualOutputAmount } from './delivery';

const consumable = (
  noteId: string,
  faucetId = 'faucet',
  amount = '250',
  state = InputNoteState.Committed
): ConsumableNoteDto => ({
  noteId,
  nullifier: 'nullifier',
  noteType: undefined,
  senderAccountId: 'sender',
  state,
  assets: [{ faucetId, amount }],
  swapAttachment: null
});

const consume = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'consume-row',
  type: 'consume',
  accountId: 'target-account',
  status: ITransactionStatus.Completed,
  initiatedAt: 1,
  completedAt: 2,
  displayIcon: 'RECEIVE',
  consumedNotes: [{ id: 'mapped-note', senderAddress: 'sender', faucetId: 'faucet', amount: 250n }],
  ...overrides
});

const arrived = (
  args: {
    consumableNotes?: ConsumableNoteDto[];
    transactions?: ITransaction[];
    targetAccountId?: string;
  } = {}
): boolean =>
  hasOneClickDeliveryArrived({
    targetAccountId: args.targetAccountId ?? 'target-account',
    faucetId: 'faucet',
    amount: 250n,
    noteIds: ['mapped-note'],
    consumableNotes: args.consumableNotes ?? [],
    transactions: args.transactions ?? []
  });

describe('1Click destination delivery matching', () => {
  const tracking = {
    direction: 'evm-to-miden',
    request: {
      amount: '250',
      originAsset: { assetId: 'evm', blockchain: 'eth', symbol: 'ETH', decimals: 18 },
      destinationAsset: { assetId: 'miden', blockchain: 'miden', symbol: 'MID', decimals: 0 },
      refundTo: 'refund',
      recipient: 'target-account',
      deadline: '2026-10-22T12:00:00Z',
      slippageTolerance: 100
    },
    quote: {
      correlationId: 'id',
      timestamp: '2026-10-22T11:00:00Z',
      signature: 'signature',
      quoteRequest: {
        dry: false,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: 'evm',
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: 'miden',
        amount: '250',
        refundTo: 'refund',
        refundType: 'ORIGIN_CHAIN',
        recipient: 'target-account',
        recipientType: 'DESTINATION_CHAIN',
        deadline: '2026-10-22T12:00:00Z'
      },
      quote: {
        amountIn: '250',
        amountInFormatted: '250',
        amountInUsd: '250',
        minAmountIn: '250',
        amountOut: '250',
        amountOutFormatted: '250',
        amountOutUsd: '250',
        minAmountOut: '240',
        timeEstimate: 1,
        depositAddress: 'deposit',
        deadline: '2026-10-22T12:00:00Z'
      }
    },
    config: { serviceUrl: 'https://1click.test', midenAssets: [{ assetId: 'miden', faucetId: 'faucet', decimals: 0 }] },
    network: 'mainnet',
    accountId: 'target-account',
    accountAddress: 'target-account',
    originAsset: { assetId: 'evm', blockchain: 'eth', symbol: 'ETH', decimals: 18 },
    destinationAsset: { assetId: 'miden', blockchain: 'miden', symbol: 'MID', decimals: 0 },
    faucetId: 'faucet',
    amount: '250',
    phase: 'arriving'
  } satisfies IOneClickTrackingData;

  it('uses actual provider output within the signed minimum instead of the indicative quote', () => {
    const actual = oneClickActualOutputAmount(tracking, '245');
    expect(actual).toBe(245n);
    expect(
      hasOneClickDeliveryArrived({
        targetAccountId: 'target-account',
        faucetId: 'faucet',
        amount: actual ?? 0n,
        noteIds: ['mapped-note'],
        consumableNotes: [consumable('mapped-note', 'faucet', '245')],
        transactions: []
      })
    ).toBe(true);
    expect(
      hasOneClickDeliveryArrived({
        targetAccountId: 'target-account',
        faucetId: 'faucet',
        amount: actual ?? 0n,
        noteIds: ['different-note'],
        consumableNotes: [consumable('unrelated-note', 'faucet', '245')],
        transactions: []
      })
    ).toBe(false);
    expect(oneClickActualOutputAmount(tracking, '239')).toBeUndefined();
    expect(oneClickActualOutputAmount(tracking, undefined)).toBeUndefined();
  });

  it('matches only a provider-linked local note with the exact faucet and amount', () => {
    expect(arrived({ consumableNotes: [consumable('MAPPED-NOTE')] })).toBe(true);
    expect(arrived({ consumableNotes: [consumable('unrelated-note')] })).toBe(false);
    expect(arrived({ consumableNotes: [consumable('mapped-note', 'other-faucet')] })).toBe(false);
    expect(arrived({ consumableNotes: [consumable('mapped-note', 'faucet', '251')] })).toBe(false);
    expect(arrived({ consumableNotes: [consumable('mapped-note', 'faucet', '250', InputNoteState.Expected)] })).toBe(
      false
    );
    expect(arrived({ consumableNotes: [consumable('mapped-note', 'faucet', '250', InputNoteState.Unverified)] })).toBe(
      false
    );
  });

  it('accepts a completed local consume of the exact note for the target account', () => {
    expect(arrived({ transactions: [consume()] })).toBe(true);
    expect(arrived({ transactions: [consume({ accountId: 'other-account' })] })).toBe(false);
    expect(arrived({ transactions: [consume({ restoredFromBackup: true })] })).toBe(false);
  });

  it('does not infer delivery from an unrelated same-amount consume', () => {
    const row = consume({
      consumedNotes: [{ id: 'different-note', senderAddress: 'sender', faucetId: 'faucet', amount: 250n }]
    });
    expect(arrived({ transactions: [row] })).toBe(false);
  });

  it('sums distinct provider-linked notes when the payout is split', () => {
    expect(
      hasOneClickDeliveryArrived({
        targetAccountId: 'target-account',
        faucetId: 'faucet',
        amount: 250n,
        noteIds: ['mapped-note-a', 'mapped-note-b'],
        consumableNotes: [consumable('mapped-note-a', 'faucet', '100'), consumable('mapped-note-b', 'faucet', '150')],
        transactions: []
      })
    ).toBe(true);
  });
});

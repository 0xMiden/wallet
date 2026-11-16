import { NoteScript, NoteType, type TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import { type ITransaction, ITransactionStatus, SendTransaction, SwapTransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { installLandedTrapRetirement } from 'lib/miden/sdk/landed-trap-retirement';

import {
  completeConsumeTransaction,
  completeCustomTransaction,
  completeSendTransaction,
  completeSwapTransaction,
  landedSwapOrder
} from './complete';
import { waitForTransactionCompletion } from './helper';
import { NoteTypeEnum } from '../types';

jest.mock('../activity/bridge-in', () => ({
  adoptBridgeDeliveries: jest.fn(async () => undefined)
}));
jest.mock('../sdk/helpers', () => ({
  ...jest.requireActual('../sdk/helpers'),
  getBech32AddressFromAccountId: (id: string) => id
}));
// A chain that charges, so the split would run every fee check if the header read had not trapped.
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual('lib/miden-chain/native-asset'),
  getNativeAssetIdSync: () => 'native',
  getVerificationBaseFeeSync: () => 10000
}));

// A landed row that failed here would offer a Retry that pays twice, so the split answers the trap with no fee note and,
// since no lock sees it past submit, retires the client first, once per wallet row however many readers trap on it.
function landedWithTrappingHeader(outputNote: object | undefined, inputNote?: object): TransactionResult {
  const result: TransactionResult = Object.create(null);
  Object.assign(result, {
    executedTransaction: () => ({
      id: () => ({ toHex: () => 'chain-tx' }),
      blockHeader: () => {
        throw new WebAssembly.RuntimeError('unreachable');
      },
      inputNotes: () => ({ notes: () => (inputNote ? [inputNote] : []) }),
      outputNotes: () => ({ notes: () => (outputNote ? [outputNote] : []) })
    }),
    serialize: () => new Uint8Array([1])
  });
  return result;
}

// The leaf's state is module scope and shared by every test here, so each test completes a row of its own.
let retire: jest.Mock;
let restore: () => void;

beforeEach(async () => {
  await Repo.transactions.clear();
  retire = jest.fn();
  restore = installLandedTrapRetirement(retire);
});

afterEach(() => restore());

/**
 * A dApp's wait on the row decodes its stored result again, and that decode traps in the same fee-rate read. The
 * completion already retired for this row, so the wait retires nothing more.
 */
async function expectWaitRetiresNothingMore(rowId: string): Promise<void> {
  const sdk = require('@miden-sdk/miden-sdk/lazy');
  const original = sdk.TransactionResult.deserialize;
  sdk.TransactionResult.deserialize = jest.fn(() => landedWithTrappingHeader(undefined));
  try {
    await expect(waitForTransactionCompletion(rowId)).resolves.toEqual({ txHash: 'chain-tx', outputNotes: [] });
  } finally {
    sdk.TransactionResult.deserialize = original;
  }
  expect(retire).toHaveBeenCalledTimes(1);
}

it('completes a landed swap whose fee-rate read traps, recording its order note', async () => {
  const swap = new SwapTransaction('account', 'offer', 70n, 'requested', 30n);
  swap.status = ITransactionStatus.GeneratingTransaction;
  await Repo.transactions.add(swap);
  const orderNote = {
    id: () => ({ toString: () => 'order-note' }),
    metadata: () => ({ noteType: () => NoteType.Public }),
    intoFull: () => ({
      recipient: () => ({
        script: () => ({ root: () => NoteScript.pswap().root() }),
        serialNum: () => ({ toFelts: () => [0n, 42n, 0n, 0n].map(value => ({ asInt: () => value })) })
      })
    })
  };

  await completeSwapTransaction(swap, landedWithTrappingHeader(orderNote));

  expect(await Repo.transactions.get(swap.id)).toMatchObject({
    status: ITransactionStatus.Completed,
    outputNoteIds: ['order-note']
  });
  expect(retire.mock.calls).toEqual([[expect.any(WebAssembly.RuntimeError), swap.id]]);
  await expectWaitRetiresNothingMore(swap.id);
});

it('completes a landed custom transaction whose fee-rate read traps', async () => {
  const custom: ITransaction = {
    id: 'custom',
    type: 'execute',
    accountId: 'account',
    status: ITransactionStatus.GeneratingTransaction,
    displayIcon: 'DEFAULT',
    initiatedAt: 1
  };
  await Repo.transactions.add(custom);
  const userNote = {
    id: () => ({ toString: () => 'user-note' }),
    metadata: () => ({ noteType: () => NoteType.Public }),
    assets: () => ({ fungibleAssets: () => [], nonFungibleAssets: () => [] })
  };

  await completeCustomTransaction(custom, landedWithTrappingHeader(userNote));

  const row = await Repo.transactions.get('custom');
  expect(row?.status).toBe(ITransactionStatus.Completed);
  expect(row?.outputNoteIds).toEqual(['user-note']);
  // Read through the split, interpretTransactionResult and the fee fields, each trapping anew: one retire for the row.
  expect(retire.mock.calls).toEqual([[expect.any(WebAssembly.RuntimeError), 'custom']]);
  await expectWaitRetiresNothingMore('custom');
});

it('completes a landed public send whose fee-rate read traps', async () => {
  const send = new SendTransaction('account', 5n, 'recipient', 'faucet', NoteTypeEnum.Public);
  send.status = ITransactionStatus.GeneratingTransaction;
  await Repo.transactions.add(send);
  const sentNote = {
    intoFull: () => ({
      id: () => ({ toString: () => 'sent-note' }),
      metadata: () => ({ noteType: () => NoteType.Public })
    })
  };

  await completeSendTransaction(send, landedWithTrappingHeader(sentNote));

  expect(await Repo.transactions.get(send.id)).toMatchObject({
    status: ITransactionStatus.Completed,
    outputNoteIds: ['sent-note']
  });
  // Read through the split in extractFullNote and the fee fields: one retire for the row.
  expect(retire.mock.calls).toEqual([[expect.any(WebAssembly.RuntimeError), send.id]]);
  await expectWaitRetiresNothingMore(send.id);
});

it('completes a landed consume whose fee-rate read traps', async () => {
  const consume: ITransaction = {
    id: 'consume-row',
    type: 'consume',
    accountId: 'account',
    status: ITransactionStatus.GeneratingTransaction,
    displayIcon: 'RECEIVE',
    initiatedAt: 1
  };
  await Repo.transactions.add(consume);
  const consumed = {
    note: () => ({
      id: () => ({ toString: () => 'consumed-note' }),
      metadata: () => ({ sender: () => 'sender', noteType: () => NoteType.Public }),
      assets: () => ({ fungibleAssets: () => [{ faucetId: () => 'faucet', amount: () => 5n }] })
    })
  };

  await completeConsumeTransaction('consume-row', landedWithTrappingHeader(undefined, consumed));

  expect(await Repo.transactions.get('consume-row')).toMatchObject({
    status: ITransactionStatus.Completed,
    transactionId: 'chain-tx',
    amount: 5n
  });
  expect(retire.mock.calls).toEqual([[expect.any(WebAssembly.RuntimeError), 'consume-row']]);
  await expectWaitRetiresNothingMore('consume-row');
});

describe('landedSwapOrder', () => {
  const pswapNote = (id: string) => ({
    id: () => ({ toString: () => id }),
    metadata: () => ({ noteType: () => NoteType.Public }),
    assets: () => ({ fungibleAssets: () => [], nonFungibleAssets: () => [] }),
    intoFull: () => ({
      recipient: () => ({
        script: () => ({ root: () => NoteScript.pswap().root() }),
        serialNum: () => ({ toFelts: () => [0n, 42n, 0n, 0n].map(value => ({ asInt: () => value })) })
      })
    })
  });

  const landedWithNotes = (notes: object[]): TransactionResult => {
    const result: TransactionResult = Object.create(null);
    Object.assign(result, {
      executedTransaction: () => ({
        id: () => ({ toHex: () => 'chain-tx' }),
        outputNotes: () => ({ notes: () => notes })
      })
    });
    return result;
  };

  it('names the order note beside the lineage id it read', () => {
    expect(landedSwapOrder('swap-row', landedWithNotes([pswapNote('order-note')]))).toEqual({
      orderId: '42',
      orderNoteId: 'order-note'
    });
  });

  // The chain charges, so with no note taken for the fee the first of two can be the fee note.
  it('names no order when no note was set aside as the fee and there are two', () => {
    expect(landedSwapOrder('swap-row', landedWithNotes([pswapNote('order-note'), pswapNote('other')]))).toEqual({});
    expect(retire).not.toHaveBeenCalled();
  });
});

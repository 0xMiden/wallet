import { NoteType, type TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import { type ITransaction, ITransactionStatus, SwapTransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { completeCustomTransaction, completeSwapTransaction } from './complete';

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

// No lock can retire past submit, so a landed row that failed here would offer a Retry that pays twice.
function landedWithTrappingHeader(outputNote: object): TransactionResult {
  const result: TransactionResult = Object.create(null);
  Object.assign(result, {
    executedTransaction: () => ({
      id: () => ({ toHex: () => 'chain-tx' }),
      blockHeader: () => {
        throw new WebAssembly.RuntimeError('unreachable');
      },
      inputNotes: () => ({ notes: () => [] }),
      outputNotes: () => ({ notes: () => [outputNote] })
    }),
    serialize: () => new Uint8Array([1])
  });
  return result;
}

beforeEach(async () => {
  await Repo.transactions.clear();
});

it('completes a landed swap whose fee-rate read traps, recording its order note', async () => {
  const swap = new SwapTransaction('account', 'offer', 70n, 'requested', 30n);
  swap.status = ITransactionStatus.GeneratingTransaction;
  await Repo.transactions.add(swap);
  const orderNote = {
    id: () => ({ toString: () => 'order-note' }),
    intoFull: () => ({
      recipient: () => ({
        serialNum: () => ({ toFelts: () => [0n, 42n, 0n, 0n].map(value => ({ asInt: () => value })) })
      })
    })
  };

  await completeSwapTransaction(swap, landedWithTrappingHeader(orderNote));

  expect(await Repo.transactions.get(swap.id)).toMatchObject({
    status: ITransactionStatus.Completed,
    outputNoteIds: ['order-note']
  });
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
});

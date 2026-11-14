import { NoteType, type TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import { type ITransaction, ITransactionStatus, SwapTransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { installAnsweredTrapRetirement } from 'lib/miden/sdk/caught-trap-retirement';

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

// A landed row that failed here would offer a Retry that pays twice, so the split answers the trap with no fee note and,
// since no lock sees it past submit, retires the client itself, once for the result however many readers trap on it.
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

const retire = jest.fn();
let restore: () => void = () => undefined;

beforeEach(async () => {
  await Repo.transactions.clear();
  retire.mockClear();
  restore = installAnsweredTrapRetirement(retire);
});

afterEach(() => restore());

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
  expect(retire).toHaveBeenCalledTimes(1);
  expect(retire.mock.calls[0][0]).toBeInstanceOf(WebAssembly.RuntimeError);
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
  // Read through the split, interpretTransactionResult and the fee fields, and retired once.
  expect(retire).toHaveBeenCalledTimes(1);
  expect(retire.mock.calls[0][0]).toBeInstanceOf(WebAssembly.RuntimeError);
});

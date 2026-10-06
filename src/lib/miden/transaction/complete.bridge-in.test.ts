import type { TransactionResult } from '@miden-sdk/miden-sdk/lazy';

// The registry's native-ETH faucet sends every bridge delivery.
import { TEST_NATIVE_ETH_FAUCET as DELIVERY_SENDER } from 'lib/epoch/testing/bridge-config';
import { ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { completeConsumeTransaction } from './complete';
import { takeAgglayerBridgeInInfo } from '../activity/bridge-in';

jest.mock('../activity/bridge-in', () => ({
  applyBridgeInInfoForNotes: async () => false,
  applyBridgeInToConsumeRow: jest.fn(),
  takeAgglayerBridgeInInfo: jest.fn(async () => undefined)
}));
jest.mock('../sdk/helpers', () => ({
  ...jest.requireActual('../sdk/helpers'),
  getBech32AddressFromAccountId: (id: string) => id
}));

const mockedTake = jest.mocked(takeAgglayerBridgeInInfo);

const bridgeNote = (id: string, amount: bigint) => ({
  note: () => ({
    id: () => ({ toString: () => id }),
    metadata: () => ({ sender: () => DELIVERY_SENDER, noteType: () => 0 }),
    assets: () => ({ fungibleAssets: () => [{ faucetId: () => 'eth-faucet', amount: () => amount }] })
  })
});

function consumeOf(notes: ReturnType<typeof bridgeNote>[]): TransactionResult {
  const result: TransactionResult = Object.create(null);
  Object.assign(result, {
    executedTransaction: () => ({
      id: () => ({ toHex: () => 'chain-tx' }),
      inputNotes: () => ({ notes: () => notes })
    }),
    serialize: () => new Uint8Array([1])
  });
  return result;
}

beforeEach(async () => {
  mockedTake.mockClear();
  await Repo.transactions.clear();
  await Repo.transactions.add({
    id: 'consume',
    type: 'consume',
    accountId: 'account',
    status: ITransactionStatus.GeneratingTransaction,
    displayIcon: 'RECEIVE',
    initiatedAt: 1
  });
});

it('never pairs a consume of two bridge deliveries with a tracker by their summed amount', async () => {
  await completeConsumeTransaction('consume', consumeOf([bridgeNote('note-1', 1n), bridgeNote('note-2', 2n)]));

  expect((await Repo.transactions.get('consume'))?.status).toBe(ITransactionStatus.Completed);
  expect(takeAgglayerBridgeInInfo).not.toHaveBeenCalled();
});

it("pairs a single-delivery consume by that note's sender and amount", async () => {
  await completeConsumeTransaction('consume', consumeOf([bridgeNote('note-1', 2n)]));

  expect(takeAgglayerBridgeInInfo).toHaveBeenCalledTimes(1);
  expect(takeAgglayerBridgeInInfo).toHaveBeenCalledWith({
    accountId: 'account',
    senderAccountId: DELIVERY_SENDER,
    amount: 2n
  });
});

import type { TransactionResult } from '@miden-sdk/miden-sdk/lazy';

// The registry's native-ETH faucet sends every bridge delivery.
import { TEST_NATIVE_ETH_FAUCET as DELIVERY_SENDER } from 'lib/epoch/testing/bridge-config';
import { ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { completeConsumeTransaction } from './complete';
import { applyBridgeInToConsumeRow, takeAgglayerBridgeInInfo, takeUsdcxBridgeInInfo } from '../activity/bridge-in';

jest.mock('../activity/bridge-in', () => ({
  applyBridgeInInfoForNotes: async () => false,
  applyBridgeInToConsumeRow: jest.fn(),
  takeAgglayerBridgeInInfo: jest.fn(async () => undefined),
  takeUsdcxBridgeInInfo: jest.fn(async () => undefined)
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
  jest.mocked(takeUsdcxBridgeInInfo).mockClear();
  jest.mocked(applyBridgeInToConsumeRow).mockClear();
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
  expect(takeAgglayerBridgeInInfo).not.toHaveBeenCalledWith(expect.objectContaining({ amount: 3n }));
  expect(takeUsdcxBridgeInInfo).not.toHaveBeenCalledWith(expect.objectContaining({ amount: 3n }));
});

// USDCx is the native asset and native notes are auto-claimed together, so a batch pairs each note by its own sender,
// faucet and amount, one at a time, and moves each matched tracking row to received; the batch row keeps its label.
it('pairs each note of a batch claim by its own amount and moves each tracking row to received', async () => {
  for (const id of ['row-a', 'row-b']) {
    await Repo.transactions.add({
      id,
      type: 'bridged-receive',
      accountId: 'account',
      status: ITransactionStatus.Completed,
      displayIcon: 'RECEIVE',
      initiatedAt: 1,
      extraInputs: {
        provider: 'usdcx',
        phase: 'ready',
        sourceAddress: '0xsource',
        sourceAmount: '1',
        sourceSymbol: 'USDC'
      }
    });
  }
  jest
    .mocked(takeUsdcxBridgeInInfo)
    .mockResolvedValueOnce({ provider: 'usdcx', sourceAmount: '1', sourceSymbol: 'USDC', bridgeReceiveTxId: 'row-a' })
    .mockResolvedValueOnce({ provider: 'usdcx', sourceAmount: '2', sourceSymbol: 'USDC', bridgeReceiveTxId: 'row-b' });

  await completeConsumeTransaction('consume', consumeOf([bridgeNote('note-1', 1n), bridgeNote('note-2', 2n)]));

  expect(jest.mocked(takeUsdcxBridgeInInfo).mock.calls.map(([args]) => args.amount)).toEqual([1n, 2n]);
  const [a, b] = [await Repo.transactions.get('row-a'), await Repo.transactions.get('row-b')];
  expect(a?.extraInputs).toMatchObject({ phase: 'received', midenNoteId: 'note-1' });
  expect(a?.amount).toBe(1n);
  expect(b?.extraInputs).toMatchObject({ phase: 'received', midenNoteId: 'note-2' });
  expect(b?.amount).toBe(2n);
  expect(b?.transactionId).toBe('chain-tx');
  expect(applyBridgeInToConsumeRow).not.toHaveBeenCalled();
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

it('offers a single-note consume no AggLayer tracker took to the USDCx trackers', async () => {
  await completeConsumeTransaction('consume', consumeOf([bridgeNote('note-1', 2n)]));

  expect(takeUsdcxBridgeInInfo).toHaveBeenCalledWith({
    accountId: 'account',
    senderAccountId: DELIVERY_SENDER,
    faucetId: 'eth-faucet',
    amount: 2n
  });
});

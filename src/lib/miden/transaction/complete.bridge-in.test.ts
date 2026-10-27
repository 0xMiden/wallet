import type { TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import { ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { completeConsumeTransaction } from './complete';
import { adoptBridgeDeliveries } from '../activity/bridge-in';

// The pairing itself runs against the real matchers in bridge-in.adopt.test.ts; here the consume only hands it over.
jest.mock('../activity/bridge-in', () => ({
  adoptBridgeDeliveries: jest.fn(async () => undefined)
}));
jest.mock('../sdk/helpers', () => ({
  ...jest.requireActual('../sdk/helpers'),
  getBech32AddressFromAccountId: (id: string) => id
}));

const executedNote = (id: string, sender: string, assets: Array<[string, bigint]>) => ({
  note: () => ({
    id: () => ({ toString: () => id }),
    metadata: () => ({ sender: () => sender, noteType: () => 0 }),
    assets: () => ({
      fungibleAssets: () => assets.map(([faucetId, amount]) => ({ faucetId: () => faucetId, amount: () => amount }))
    })
  })
});

function consumeOf(notes: readonly object[]): TransactionResult {
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
  jest.mocked(adoptBridgeDeliveries).mockClear();
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

// A batch's per-faucet total is no single delivery's amount: each note goes over by its own first asset.
it('hands the adopter each executed note by its own sender, faucet and amount, once the row is Completed', async () => {
  let statusAtAdoption: ITransactionStatus | undefined;
  jest.mocked(adoptBridgeDeliveries).mockImplementationOnce(async id => {
    statusAtAdoption = (await Repo.transactions.get(id))?.status;
  });

  await completeConsumeTransaction(
    'consume',
    consumeOf([
      executedNote('note-1', 'usdcx-faucet', [['usdcx-faucet', 1n]]),
      executedNote('note-2', 'wallet', [
        ['usdcx-faucet', 2n],
        ['other-faucet', 9n]
      ])
    ])
  );

  expect(adoptBridgeDeliveries).toHaveBeenCalledTimes(1);
  expect(adoptBridgeDeliveries).toHaveBeenCalledWith('consume', [
    { id: 'note-1', senderAddress: 'usdcx-faucet', faucetId: 'usdcx-faucet', amount: 1n },
    { id: 'note-2', senderAddress: 'wallet', faucetId: 'usdcx-faucet', amount: 2n }
  ]);
  expect(statusAtAdoption).toBe(ITransactionStatus.Completed);
});

it('offers a note with no fungible asset to the registry pass alone', async () => {
  await completeConsumeTransaction(
    'consume',
    consumeOf([executedNote('note-1', 'usdcx-faucet', [['usdcx-faucet', 1n]]), executedNote('note-2', 'wallet', [])])
  );

  expect(adoptBridgeDeliveries).toHaveBeenCalledWith('consume', [
    { id: 'note-1', senderAddress: 'usdcx-faucet', faucetId: 'usdcx-faucet', amount: 1n },
    { id: 'note-2', senderAddress: '', faucetId: '' }
  ]);
});

it('completes the consume even when a note cannot be read for adoption', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const withoutId = {
    metadata: () => ({ sender: () => 'usdcx-faucet', noteType: () => 0 }),
    assets: () => ({ fungibleAssets: () => [{ faucetId: () => 'usdcx-faucet', amount: () => 1n }] })
  };

  await completeConsumeTransaction('consume', consumeOf([{ note: () => withoutId }]));

  expect((await Repo.transactions.get('consume'))?.status).toBe(ITransactionStatus.Completed);
  expect(adoptBridgeDeliveries).not.toHaveBeenCalled();
  warn.mockRestore();
});

jest.mock('lib/miden/recovery/receipt-writer', () => ({ checkpointProviderReceipt: async () => {} }));

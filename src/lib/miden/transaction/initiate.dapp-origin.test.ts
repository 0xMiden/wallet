/**
 * Only an origin a row lists may wait on its result (#1416), so each dApp creation path writes the origin in the write
 * that creates the row, and the wallet's own paths write none.
 */
import { NoteTypeEnum } from '../types';
import { initiateSendTransaction, requestCustomTransaction } from './initiate';

const mockAdd = jest.fn(async (_row: unknown) => undefined);
jest.mock('lib/miden/repo', () => ({
  get transactions() {
    return { add: mockAdd };
  }
}));
// The chokepoint inserts through the same `add`, so a row that went either way is read from one place.
jest.mock('../spending-limits/queue', () => ({
  spendsOf: (transaction: { faucetId: string; amount: bigint }) => [
    { faucetId: transaction.faucetId, amount: transaction.amount }
  ],
  queueOutgoingTransaction: jest.fn(async (transaction: unknown) => {
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

const ORIGIN = 'https://dapp.example';
const REQUEST_BYTES = Buffer.from('custom-request').toString('base64');
const SPENT = [{ faucetId: 'faucet-a', amount: 1n }];
const listsNoOrigin = () => expect.not.objectContaining({ dappOrigins: expect.anything() });
const insertedRow = () => mockAdd.mock.calls[0]?.[0];

const send = (dappOrigin?: string) =>
  initiateSendTransaction(
    'mtst1sender',
    'mtst1recipient',
    'mtst1faucet',
    NoteTypeEnum.Public,
    1000n,
    undefined,
    undefined,
    undefined,
    dappOrigin
  );

const custom = (spent?: typeof SPENT, dappOrigin?: string) =>
  requestCustomTransaction(
    'account-a',
    REQUEST_BYTES,
    undefined,
    undefined,
    undefined,
    undefined,
    spent,
    undefined,
    dappOrigin
  );

beforeEach(() => jest.clearAllMocks());

describe('the origin a dApp row is created for', () => {
  it('is on a dApp send from its insert', async () => {
    await send(ORIGIN);
    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect(insertedRow()).toEqual(expect.objectContaining({ type: 'send', dappOrigins: [ORIGIN] }));
  });

  it("is absent from the wallet's own send", async () => {
    await send();
    expect(insertedRow()).toEqual(listsNoOrigin());
  });

  it('is on a dApp custom request that moves nothing, inserted directly', async () => {
    await custom(undefined, ORIGIN);
    expect(insertedRow()).toEqual(expect.objectContaining({ type: 'execute', dappOrigins: [ORIGIN] }));
  });

  it('is on a dApp custom request that moves value, inserted through the spending-limit chokepoint', async () => {
    await custom(SPENT, ORIGIN);
    expect(insertedRow()).toEqual(
      expect.objectContaining({ type: 'execute', spentAssetTotals: SPENT, dappOrigins: [ORIGIN] })
    );
  });

  it('is absent from a custom row created without one', async () => {
    await custom();
    expect(insertedRow()).toEqual(listsNoOrigin());
  });
});

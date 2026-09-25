/* eslint-disable import/first */
/**
 * `requestCustomTransaction` must reach the spending-limit chokepoint.
 *
 * The policy tests prove an execute row is countable and the queue tests prove the chokepoint
 * enforces, but neither pins the WIRING: with the branch below replaced by a plain
 * `transactions.add`, every one of those suites stayed green while a connected dApp could again
 * move value out of a limited account by sending a custom request. That gap is what this file
 * closes, so it asserts which path the insert took and nothing else.
 */

const mockQueueOutgoing = jest.fn((..._args: unknown[]) => Promise.resolve(undefined));
const mockAdd = jest.fn((..._args: unknown[]) => Promise.resolve(undefined));
const mockQueueNoteImport = jest.fn((..._args: unknown[]) => Promise.resolve(undefined));

jest.mock('../spending-limits/queue', () => ({
  queueOutgoingTransaction: (...args: unknown[]) => mockQueueOutgoing(...args),
  spendsOf: (transaction: { faucetId: string; amount: bigint }) => [
    { faucetId: transaction.faucetId, amount: transaction.amount }
  ]
}));

jest.mock('../repo', () => ({
  transactions: {
    add: (...args: unknown[]) => mockAdd(...args)
  }
}));

jest.mock('../activity', () => ({
  queueNoteImport: (...args: unknown[]) => mockQueueNoteImport(...args)
}));

jest.mock('../sdk/miden-client', () => ({
  withWasmClientLock: async <T>(fn: () => Promise<T>) => fn(),
  getMidenClient: async () => ({})
}));

import { requestCustomTransaction } from './initiate';

const REQUEST_BYTES = Buffer.from('custom-request').toString('base64');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('requestCustomTransaction', () => {
  it('routes a value-moving custom request through the spending-limit chokepoint', async () => {
    const totals = [{ faucetId: 'faucet-a', amount: 101n }];
    const authorization = { id: 'authorization-1' };

    await requestCustomTransaction(
      'account-a',
      REQUEST_BYTES,
      undefined,
      undefined,
      undefined,
      undefined,
      totals,
      authorization as never
    );

    expect(mockAdd).not.toHaveBeenCalled();
    // The spend list is passed as its own argument AND recorded on the row: the policy reads the
    // row's totals for later windows, the chokepoint assesses the argument for this one.
    expect(mockQueueOutgoing).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'execute', accountId: 'account-a', spentAssetTotals: totals }),
      totals,
      authorization
    );
  });

  it('inserts directly when the request moves no value', async () => {
    await requestCustomTransaction('account-a', REQUEST_BYTES);

    expect(mockQueueOutgoing).not.toHaveBeenCalled();
    expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({ type: 'execute' }));
  });

  it('inserts directly when the dry run found an empty outgoing set', async () => {
    // An empty list is a dry run that succeeded and saw no value leave, which is different from
    // the undefined the dApp layer refuses on. Nothing to assess, so nothing to gate.
    await requestCustomTransaction('account-a', REQUEST_BYTES, undefined, undefined, undefined, undefined, []);

    expect(mockQueueOutgoing).not.toHaveBeenCalled();
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });
});

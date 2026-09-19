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

const mockQueueOutgoingCustomTransaction = jest.fn((..._args: unknown[]) => Promise.resolve(undefined));
const mockAdd = jest.fn((..._args: unknown[]) => Promise.resolve(undefined));
const mockQueueNoteImport = jest.fn((..._args: unknown[]) => Promise.resolve(undefined));

jest.mock('../spending-limits/queue', () => ({
  queueOutgoingCustomTransaction: (...args: unknown[]) => mockQueueOutgoingCustomTransaction(...args),
  queueOutgoingTransaction: jest.fn(async () => undefined)
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
    expect(mockQueueOutgoingCustomTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'execute', accountId: 'account-a', spentAssetTotals: totals }),
      authorization
    );
  });

  it('inserts directly when the request moves no value', async () => {
    await requestCustomTransaction('account-a', REQUEST_BYTES);

    expect(mockQueueOutgoingCustomTransaction).not.toHaveBeenCalled();
    expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({ type: 'execute' }));
  });

  it('inserts directly when the dry run found an empty outgoing set', async () => {
    // An empty list is a dry run that succeeded and saw no value leave, which is different from
    // the undefined the dApp layer refuses on. Nothing to assess, so nothing to gate.
    await requestCustomTransaction('account-a', REQUEST_BYTES, undefined, undefined, undefined, undefined, []);

    expect(mockQueueOutgoingCustomTransaction).not.toHaveBeenCalled();
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });
});

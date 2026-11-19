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
const mockQueueUnattributableCustomTransaction = jest.fn((..._args: unknown[]) => Promise.resolve(undefined));
const mockAdd = jest.fn((..._args: unknown[]) => Promise.resolve(undefined));
const mockQueueNoteImport = jest.fn((..._args: unknown[]) => Promise.resolve(undefined));

/** What the locked recheck reads. Unset is no spending limit. */
let spendingLimitPolicy: unknown;

jest.mock('../spending-limits/queue', () => {
  const actual = jest.requireActual('../spending-limits/queue');
  return {
    queueOutgoingTransaction: (...args: unknown[]) => mockQueueOutgoing(...args),
    queueUnattributableCustomTransaction: (transaction: unknown, authorization: unknown) => {
      mockQueueUnattributableCustomTransaction(transaction, authorization);
      return actual.queueUnattributableCustomTransaction(transaction, authorization);
    },
    spendsOf: (transaction: { faucetId: string; amount: bigint }) => [
      { faucetId: transaction.faucetId, amount: transaction.amount }
    ],
    UnattributableCustomSpendError: actual.UnattributableCustomSpendError
  };
});

jest.mock('../repo', () => ({
  db: {
    transaction: async (...args: unknown[]) => {
      const callback = args[args.length - 1];
      if (typeof callback !== 'function') throw new Error('db.transaction mock expected a callback');
      return callback();
    }
  },
  spendingLimits: {
    get: async () => spendingLimitPolicy
  },
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
import type { IApprovedCustomEffects } from '../db/types';
import { UnattributableCustomSpendError } from '../spending-limits/queue';

const REQUEST_BYTES = Buffer.from('custom-request').toString('base64');

beforeEach(() => {
  spendingLimitPolicy = undefined;
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

  it('rechecks policy when the caller omits the spend', async () => {
    await requestCustomTransaction('account-a', REQUEST_BYTES);

    expect(mockQueueOutgoing).not.toHaveBeenCalled();
    expect(mockQueueUnattributableCustomTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'execute', accountId: 'account-a', spentAssetTotals: undefined }),
      undefined
    );
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });

  it('routes an unattributable custom request through the locked policy recheck', async () => {
    await requestCustomTransaction('account-a', REQUEST_BYTES, undefined, undefined, undefined, undefined, undefined);

    expect(mockQueueUnattributableCustomTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'execute', accountId: 'account-a', spentAssetTotals: undefined }),
      undefined
    );
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });

  it('refuses an unattributable custom request when a spending limit exists at insert', async () => {
    spendingLimitPolicy = { accountId: 'account-a' };

    await expect(
      requestCustomTransaction('account-a', REQUEST_BYTES, undefined, undefined, undefined, undefined, undefined)
    ).rejects.toBeInstanceOf(UnattributableCustomSpendError);

    expect(mockQueueOutgoing).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('records the approved effects on the queued row, on both insert paths', async () => {
    const approvedEffects: IApprovedCustomEffects = {
      shape: 'summary',
      outgoing: [{ faucetId: 'faucet-a', amount: 101n }],
      incoming: [],
      outgoingNfts: [],
      incomingNfts: [],
      unlistedAssets: 0,
      recipients: ['0xr1'],
      inputNotesConsumed: 0,
      outputNotesCreated: 1,
      storageChanged: false,
      introducedNoteIds: [],
      approvedOutputNoteIds: ['0xsent']
    };
    const totals = [{ faucetId: 'faucet-a', amount: 101n }];

    await requestCustomTransaction(
      'account-a',
      REQUEST_BYTES,
      undefined,
      undefined,
      undefined,
      undefined,
      totals,
      undefined,
      undefined,
      undefined,
      undefined,
      approvedEffects
    );
    await requestCustomTransaction(
      'account-a',
      REQUEST_BYTES,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      approvedEffects
    );

    await requestCustomTransaction(
      'account-a',
      REQUEST_BYTES,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      approvedEffects
    );

    expect(mockQueueOutgoing).toHaveBeenCalledWith(expect.objectContaining({ approvedEffects }), totals, undefined);
    expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({ approvedEffects }));
    expect(mockQueueUnattributableCustomTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ approvedEffects, spentAssetTotals: undefined }),
      undefined
    );
  });

  it('inserts directly when the dry run found an empty outgoing set', async () => {
    // An empty list is a dry run that succeeded and saw no value leave, which is different from
    // the undefined the dApp layer refuses on. Nothing to assess, so nothing to gate, even when
    // a limit is present: the list is measured, so it is not the locked recheck.
    spendingLimitPolicy = { accountId: 'account-a' };
    await requestCustomTransaction('account-a', REQUEST_BYTES, undefined, undefined, undefined, undefined, []);

    expect(mockQueueOutgoing).not.toHaveBeenCalled();
    expect(mockQueueUnattributableCustomTransaction).not.toHaveBeenCalled();
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });
});

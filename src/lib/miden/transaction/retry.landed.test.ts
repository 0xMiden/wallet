/**
 * Retry's "already landed" reconcile, against the REAL Dexie row store and the
 * REAL `updateTransactionStatus`.
 *
 * The sibling `retry.test.ts` `jest.mock`s `./helper`, which is precisely why the
 * defect this file pins was invisible: `updateTransactionStatus` refuses to touch
 * a row that is already Failed or Completed, and `requeueFailedTransaction` only
 * ever runs on a Failed row — so routing the reconcile through it threw
 * `Transaction already in a finalized state` on every execution, the Retry button
 * surfaced "Something went wrong", and a send that HAD left the account stayed
 * Failed forever. Only `./cancel` is mocked here (to control the node verdict).
 */
/* eslint-disable import/first */
import * as Repo from 'lib/miden/repo';

const mockVerifySendLanded = jest.fn();
jest.mock('./cancel', () => ({
  ...jest.requireActual('./cancel'),
  verifySendLanded: (...args: unknown[]) => mockVerifySendLanded(...args)
}));

// Imported after the mock declaration; `jest.mock` is hoisted, so the real module
// graph below (`./helper`, `lib/miden/repo`) is untouched.
import { TRANSACTION_RETRY_UNSAFE_ERROR } from './constants';
import { updateTransactionStatus } from './helper';
import { requeueFailedTransaction } from './retry';
import { INoteDeliveryState, ITransaction, ITransactionStatus } from '../db/types';
import { NoteTypeEnum } from '../types';

const failedSend = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'tx-landed',
  type: 'send',
  accountId: 'acct-1',
  status: ITransactionStatus.Failed,
  initiatedAt: 1000,
  processingStartedAt: 1100,
  transactionId: '0xlanded',
  error: 'extractFullNote returned undefined',
  rawError: 'Error: extractFullNote returned undefined',
  displayMessage: 'Failed',
  displayIcon: 'FAILED',
  ...overrides
});

const UNDELIVERED = 'Sent - the private note could not be delivered';

// Only `completeSendTransaction` relays a private send's note, so a landed row with no delivery
// recorded never had it relayed; a recorded outcome is the relay's own and must survive (#1233).
const DELIVERY_CASES: [string, Partial<ITransaction>, INoteDeliveryState | undefined, string][] = [
  ['a private send with no delivery recorded', { noteType: NoteTypeEnum.Private }, 'undelivered', UNDELIVERED],
  ['a public send', { noteType: NoteTypeEnum.Public }, undefined, 'Sent'],
  [
    'a private send whose relay was recorded',
    { noteType: NoteTypeEnum.Private, noteDelivery: 'relayed' },
    'relayed',
    'Sent'
  ],
  [
    'a private send whose relay was recorded as pending',
    { noteType: NoteTypeEnum.Private, noteDelivery: 'pending' },
    'pending',
    'Sent'
  ],
  [
    'a private send whose delivery was recorded as confirmed',
    { noteType: NoteTypeEnum.Private, noteDelivery: 'confirmed' },
    'confirmed',
    'Sent'
  ],
  [
    'a private send whose relay was recorded as failed',
    { noteType: NoteTypeEnum.Private, noteDelivery: 'undelivered' },
    'undelivered',
    UNDELIVERED
  ]
];

// Retry's landed row reads as the landed catches write one: the label the type's normal completion
// writes (#1233).
const LABEL_CASES: [string, Partial<ITransaction>, string][] = [
  ['swap', { type: 'swap' }, 'Swapped'],
  ['execute', { type: 'execute' }, 'Executed'],
  ['Agglayer bridged-send', { type: 'bridged-send', extraInputs: { provider: 'agglayer' } }, 'Bridged to EVM']
];

beforeEach(async () => {
  jest.clearAllMocks();
  await Repo.transactions.clear();
});

afterAll(async () => {
  await Repo.transactions.clear();
});

describe('requeueFailedTransaction — landed reconcile against the real row store', () => {
  it('completes a Failed row whose send provably landed, without throwing', async () => {
    await Repo.transactions.put(failedSend());
    mockVerifySendLanded.mockResolvedValue('landed');

    await expect(requeueFailedTransaction('tx-landed')).resolves.toBeUndefined();

    const row = await Repo.transactions.where({ id: 'tx-landed' }).first();
    expect(row?.status).toBe(ITransactionStatus.Completed);
    expect(row?.displayMessage).toBe('Sent');
    expect(row?.completedAt).toEqual(expect.any(Number));
    // The stale failure text must not survive onto a Completed row.
    expect(row?.error).toBeUndefined();
    expect(row?.rawError).toBeUndefined();
  });

  it.each(DELIVERY_CASES)(
    'completes %s with the matching delivery state (#1233)',
    async (_label, overrides, delivery, message) => {
      await Repo.transactions.put(failedSend({ id: 'tx-landed-delivery', ...overrides }));
      mockVerifySendLanded.mockResolvedValue('landed');

      await requeueFailedTransaction('tx-landed-delivery');

      const row = await Repo.transactions.where({ id: 'tx-landed-delivery' }).first();
      expect(row?.status).toBe(ITransactionStatus.Completed);
      expect(row?.noteDelivery).toBe(delivery);
      expect(row?.displayMessage).toBe(message);
    }
  );

  // The node check is a network round trip, and the sweep or a cancelled pipeline can record a relay
  // outcome while it runs; the write judges the row it finds, not the one read before (#1233).
  it.each<INoteDeliveryState>(['relayed', 'confirmed'])(
    'keeps a relay outcome recorded as %s during the landed check (#1233)',
    async recorded => {
      await Repo.transactions.put(failedSend({ id: 'tx-landed-race', noteType: NoteTypeEnum.Private }));
      mockVerifySendLanded.mockImplementationOnce(async () => {
        await Repo.transactions.where({ id: 'tx-landed-race' }).modify(tx => {
          tx.noteDelivery = recorded;
        });
        return 'landed';
      });

      await requeueFailedTransaction('tx-landed-race');

      const row = await Repo.transactions.where({ id: 'tx-landed-race' }).first();
      expect(row?.status).toBe(ITransactionStatus.Completed);
      expect(row?.noteDelivery).toBe(recorded);
      expect(row?.displayMessage).toBe('Sent');
    }
  );

  it.each(LABEL_CASES)(
    'completes a landed %s under its completion label (#1233)',
    async (_label, overrides, message) => {
      await Repo.transactions.put(failedSend({ id: 'tx-landed-label', ...overrides }));
      mockVerifySendLanded.mockResolvedValue('landed');

      await requeueFailedTransaction('tx-landed-label');

      const row = await Repo.transactions.where({ id: 'tx-landed-label' }).first();
      expect(row?.status).toBe(ITransactionStatus.Completed);
      expect(row?.displayMessage).toBe(message);
      expect(row?.noteDelivery).toBeUndefined();
    }
  );

  it('refuses, and leaves the real row Failed, when the node cannot confirm the send landed', async () => {
    // 'unknown' is "we could not confirm", not "it did not land": the node may
    // simply not have this id yet. Replaying a rebuilt send request on that would
    // broadcast a second transfer.
    await Repo.transactions.put(failedSend({ id: 'tx-unknown' }));
    mockVerifySendLanded.mockResolvedValue('unknown');

    await expect(requeueFailedTransaction('tx-unknown')).rejects.toThrow(TRANSACTION_RETRY_UNSAFE_ERROR);

    const row = await Repo.transactions.where({ id: 'tx-unknown' }).first();
    expect(row?.status).toBe(ITransactionStatus.Failed);
  });

  it('requeues a send that never left the queue', async () => {
    // No `processingStartedAt` → the row never executed, so nothing could have
    // been submitted and the rebuilt request is safe to replay.
    await Repo.transactions.put(failedSend({ id: 'tx-queued', processingStartedAt: undefined }));
    mockVerifySendLanded.mockResolvedValue('unknown');

    await requeueFailedTransaction('tx-queued');

    const row = await Repo.transactions.where({ id: 'tx-queued' }).first();
    expect(row?.status).toBe(ITransactionStatus.Queued);
  });

  it('documents WHY the reconcile cannot go through updateTransactionStatus', async () => {
    await Repo.transactions.put(failedSend({ id: 'tx-guarded' }));

    await expect(
      updateTransactionStatus('tx-guarded', ITransactionStatus.Completed, { displayMessage: 'Completed' })
    ).rejects.toThrow('Transaction already in a finalized state');
  });
});

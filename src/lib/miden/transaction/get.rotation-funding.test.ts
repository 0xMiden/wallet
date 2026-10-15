import * as Repo from 'lib/miden/repo';

import { TRANSACTION_VAULT_SHORTFALL_ERROR } from './constants';
import { isRotationAwaitingFunding } from './get';
import { findAdoptableShortfallRow } from './rotation-funding';
import { ITransaction, ITransactionStatus } from '../db/types';

const ACCOUNT = 'mtst1acct';

const rotation = (id: string, overrides: Partial<ITransaction> = {}): ITransaction => ({
  id,
  type: 'replace-hot-key',
  accountId: ACCOUNT,
  status: ITransactionStatus.Failed,
  error: TRANSACTION_VAULT_SHORTFALL_ERROR,
  initiatedAt: 1000,
  completedAt: 1010,
  displayIcon: 'SEND',
  ...overrides
});

const claim = (id: string, overrides: Partial<ITransaction> = {}): ITransaction => ({
  id,
  type: 'consume',
  accountId: ACCOUNT,
  status: ITransactionStatus.Completed,
  rotationFunding: true,
  initiatedAt: 1020,
  completedAt: 1030,
  displayIcon: 'RECEIVE',
  ...overrides
});

beforeEach(async () => {
  await Repo.transactions.clear();
});

const adoptedId = async () => (await findAdoptableShortfallRow(ACCOUNT))?.id;

describe('findAdoptableShortfallRow and isRotationAwaitingFunding (#805)', () => {
  it('is true when the newest rotation failed for want of its fee', async () => {
    await Repo.transactions.bulkPut([rotation('r1')]);
    await expect(adoptedId()).resolves.toBe('r1');
    await expect(isRotationAwaitingFunding(ACCOUNT)).resolves.toBe(true);
  });

  it('is false without a rotation row, or when the newest rotation failed for another reason', async () => {
    await expect(adoptedId()).resolves.toBeUndefined();
    await expect(isRotationAwaitingFunding(ACCOUNT)).resolves.toBe(false);

    await Repo.transactions.bulkPut([
      rotation('old-shortfall', { initiatedAt: 900, completedAt: 910 }),
      rotation('newer-other', { error: 'Guardian unreachable' })
    ]);
    await expect(adoptedId()).resolves.toBeUndefined();
    await expect(isRotationAwaitingFunding(ACCOUNT)).resolves.toBe(false);
  });

  it('is false while a newer rotation is queued', async () => {
    await Repo.transactions.bulkPut([
      rotation('r1'),
      rotation('r2', { status: ITransactionStatus.Queued, error: undefined, initiatedAt: 1000, queuedSeq: 1 })
    ]);
    await expect(adoptedId()).resolves.toBeUndefined();
    await expect(isRotationAwaitingFunding(ACCOUNT)).resolves.toBe(false);
  });

  it('keeps the shortfall row that won a same-second tie on the queue sequence, though it is read first', async () => {
    await Repo.transactions.bulkPut([
      rotation('a-shortfall', { queuedSeq: 2 }),
      rotation('b-other', { error: 'Guardian unreachable', queuedSeq: 1 })
    ]);
    await expect(adoptedId()).resolves.toBe('a-shortfall');
    await expect(isRotationAwaitingFunding(ACCOUNT)).resolves.toBe(true);
  });

  it('is false once a funding claim completed after the shortfall, since the rotation runs next', async () => {
    await Repo.transactions.bulkPut([rotation('r1'), claim('c1')]);
    await expect(adoptedId()).resolves.toBeUndefined();
    await expect(isRotationAwaitingFunding(ACCOUNT)).resolves.toBe(false);
  });

  it('ignores a claim that completed before the shortfall, a failed claim, and rows of other accounts', async () => {
    await Repo.transactions.bulkPut([
      rotation('r1'),
      claim('before', { initiatedAt: 990, completedAt: 1000 }),
      claim('failed', { status: ITransactionStatus.Failed }),
      claim('other-account', { accountId: 'mtst1other' }),
      rotation('other-rotation', { accountId: 'mtst1other', status: ITransactionStatus.Completed, error: undefined })
    ]);
    await expect(adoptedId()).resolves.toBe('r1');
    await expect(isRotationAwaitingFunding(ACCOUNT)).resolves.toBe(true);
  });
});

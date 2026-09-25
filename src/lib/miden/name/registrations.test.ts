import { act, renderHook, waitFor } from '@testing-library/react';

import {
  ITransaction,
  ITransactionStatus,
  MidenNamePhase,
  MidenNamePublishPhase,
  PublishNameRecordTransaction,
  RegisterNameTransaction
} from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import {
  isLivePublishRow,
  listMidenNamePublishes,
  listMidenNameRegistrations,
  phaseOf,
  publishingLabelsOf,
  publishNameInputsOf,
  publishPhaseOf,
  uiStateOf,
  useMidenNamePublishes,
  useMidenNameRegistrations,
  useOwnedMidenName
} from './registrations';

let mockNetwork = 'testnet';
let mockSupported = true;
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: () => mockNetwork
}));
jest.mock('./config', () => ({
  isMidenNameSupported: () => mockSupported
}));

const ACCOUNT = 'mtst1account';

let seq = 0;
function registerRow(
  label: string,
  {
    phase = 'requested',
    status = ITransactionStatus.Queued,
    network = 'testnet',
    accountId = ACCOUNT,
    restoredFromBackup
  }: {
    phase?: MidenNamePhase;
    status?: ITransactionStatus;
    network?: string;
    accountId?: string;
    restoredFromBackup?: boolean;
  } = {}
): ITransaction {
  const row: ITransaction = new RegisterNameTransaction({
    accountId,
    label,
    network,
    paymentFaucetId: 'mtst1miden',
    registryAccountId: 'mtst1registry',
    priceBaseUnits: 20_000_000n,
    networkFeeBaseUnits: 210n,
    requestBytes: new Uint8Array([1]),
    registrationNoteId: `0xnote-${label}`,
    reclaimHeight: 1300,
    builtAtBlock: 1000
  });
  row.extraInputs = { ...row.extraInputs, phase };
  row.status = status;
  row.initiatedAt = 1000 + seq;
  seq += 1;
  if (restoredFromBackup) row.restoredFromBackup = true;
  return row;
}

function row(overrides: Partial<ITransaction>): ITransaction {
  return {
    id: 'x',
    type: 'register-name',
    accountId: ACCOUNT,
    status: ITransactionStatus.Queued,
    initiatedAt: 1,
    displayIcon: 'SEND',
    ...overrides
  };
}

function publishRow(
  label: string,
  {
    phase = 'requested',
    status = ITransactionStatus.Queued,
    network = 'testnet',
    accountId = ACCOUNT,
    restoredFromBackup
  }: {
    phase?: MidenNamePublishPhase;
    status?: ITransactionStatus;
    network?: string;
    accountId?: string;
    restoredFromBackup?: boolean;
  } = {}
): ITransaction {
  const row: ITransaction = new PublishNameRecordTransaction({
    accountId,
    label,
    network,
    registryAccountId: 'mtst1registry',
    nfaFaucetId: 'mtst1registry',
    requestBytes: new Uint8Array([1]),
    registryNoteId: `0xpublish-${label}`,
    reclaimHeight: 1300,
    builtAtBlock: 1000,
    action: 3n
  });
  row.extraInputs = { ...row.extraInputs, phase };
  row.status = status;
  row.initiatedAt = 1000 + seq;
  seq += 1;
  if (restoredFromBackup) row.restoredFromBackup = true;
  return row;
}

beforeEach(async () => {
  mockNetwork = 'testnet';
  mockSupported = true;
  await Repo.transactions.clear();
});

describe('phaseOf', () => {
  it.each<[MidenNamePhase, ITransactionStatus, MidenNamePhase]>([
    ['requested', ITransactionStatus.Queued, 'requested'],
    ['requested', ITransactionStatus.GeneratingTransaction, 'requested'],
    ['requested', ITransactionStatus.Completed, 'submitted'],
    ['requested', ITransactionStatus.Failed, 'failed'],
    ['submitted', ITransactionStatus.Completed, 'submitted'],
    ['issued', ITransactionStatus.Completed, 'issued'],
    ['claiming', ITransactionStatus.Completed, 'claiming'],
    ['owned', ITransactionStatus.Completed, 'owned'],
    ['failed', ITransactionStatus.Completed, 'failed'],
    ['owned', ITransactionStatus.Failed, 'owned']
  ])('phase %s with status %s is %s', (phase, status, expected) => {
    expect(phaseOf(registerRow('alice', { phase, status }))).toBe(expected);
  });

  it('gives requested for a row with no extraInputs', () => {
    expect(phaseOf(row({}))).toBe('requested');
  });
});

describe('uiStateOf', () => {
  it.each<[MidenNamePhase, string]>([
    ['requested', 'claiming'],
    ['submitted', 'claiming'],
    ['issued', 'claiming'],
    ['claiming', 'claiming'],
    ['owned', 'owned'],
    ['failed', 'failed']
  ])('%s → %s', (phase, expected) => {
    expect(uiStateOf(phase)).toBe(expected);
  });
});

describe('listMidenNameRegistrations', () => {
  it('lists only live rows of the account on the effective network, newest first', async () => {
    const older = registerRow('older');
    const newer = registerRow('newer');
    await Repo.transactions.bulkAdd([
      older,
      newer,
      registerRow('devnet', { network: 'devnet' }),
      registerRow('backup', { restoredFromBackup: true }),
      registerRow('other', { accountId: 'mtst1other' }),
      row({ id: 'send-1', type: 'send' })
    ]);

    const rows = await listMidenNameRegistrations(ACCOUNT);
    expect(rows.map(r => r.id)).toEqual([newer.id, older.id]);
  });

  it('matches a composite account id', async () => {
    const r = registerRow('alice');
    await Repo.transactions.add(r);
    const rows = await listMidenNameRegistrations(`${ACCOUNT}_suffix`);
    expect(rows.map(x => x.id)).toEqual([r.id]);
  });
});

describe('useMidenNameRegistrations / useOwnedMidenName', () => {
  it('updates live when a row changes', async () => {
    const r = registerRow('alice', { phase: 'claiming', status: ITransactionStatus.Completed });
    await Repo.transactions.add(r);

    const { result, unmount } = renderHook(() => ({
      list: useMidenNameRegistrations(ACCOUNT),
      owned: useOwnedMidenName(ACCOUNT)
    }));
    await waitFor(() => expect(result.current.list.loaded).toBe(true));
    expect(result.current.list.rows).toHaveLength(1);
    expect(result.current.owned).toBeUndefined();

    await act(async () => {
      await Repo.transactions.where({ id: r.id }).modify(tx => {
        tx.extraInputs = { ...tx.extraInputs, phase: 'owned' };
      });
    });
    await waitFor(() => expect(result.current.owned).toBe('alice'));
    unmount();
  });

  it('gives the newest owned label', async () => {
    await Repo.transactions.bulkAdd([
      registerRow('first', { phase: 'owned', status: ITransactionStatus.Completed }),
      registerRow('second', { phase: 'owned', status: ITransactionStatus.Completed }),
      registerRow('third', { phase: 'failed', status: ITransactionStatus.Completed })
    ]);
    const { result, unmount } = renderHook(() => useOwnedMidenName(ACCOUNT));
    await waitFor(() => expect(result.current).toBe('second'));
    unmount();
  });

  it('gives no owned label when the network is not supported', async () => {
    mockSupported = false;
    await Repo.transactions.add(registerRow('alice', { phase: 'owned', status: ITransactionStatus.Completed }));
    const { result, unmount } = renderHook(() => ({
      list: useMidenNameRegistrations(ACCOUNT),
      owned: useOwnedMidenName(ACCOUNT)
    }));
    await waitFor(() => expect(result.current.list.loaded).toBe(true));
    expect(result.current.owned).toBeUndefined();
    unmount();
  });

  it('is loaded and empty with no account', async () => {
    const { result, unmount } = renderHook(() => useMidenNameRegistrations(undefined));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.rows).toEqual([]);
    unmount();
  });
});

describe('publishNameInputsOf', () => {
  it('gives the extraInputs of a publish row only', () => {
    expect(publishNameInputsOf(publishRow('alice'))).toMatchObject({ label: 'alice', action: '3' });
    expect(publishNameInputsOf(registerRow('alice'))).toBeUndefined();
  });
});

describe('publishPhaseOf', () => {
  it.each<[MidenNamePublishPhase, ITransactionStatus, MidenNamePublishPhase]>([
    ['requested', ITransactionStatus.Queued, 'requested'],
    ['requested', ITransactionStatus.GeneratingTransaction, 'requested'],
    ['requested', ITransactionStatus.Completed, 'submitted'],
    ['requested', ITransactionStatus.Failed, 'failed'],
    ['submitted', ITransactionStatus.Completed, 'submitted'],
    ['recorded', ITransactionStatus.Completed, 'recorded'],
    ['returning', ITransactionStatus.Completed, 'returning'],
    ['returning', ITransactionStatus.Failed, 'failed'],
    ['done', ITransactionStatus.Completed, 'done'],
    ['done', ITransactionStatus.Failed, 'done'],
    ['failed', ITransactionStatus.Completed, 'failed']
  ])('phase %s with status %s is %s', (phase, status, expected) => {
    expect(publishPhaseOf(publishRow('alice', { phase, status }))).toBe(expected);
  });

  it('gives requested for a row of an other type', () => {
    expect(publishPhaseOf(row({ type: 'send' }))).toBe('requested');
  });
});

describe('isLivePublishRow', () => {
  it('is true for a publish row of the effective network', () => {
    expect(isLivePublishRow(publishRow('alice'))).toBe(true);
    expect(isLivePublishRow(publishRow('alice', { network: 'devnet' }), 'devnet')).toBe(true);
  });

  it('is false for a row of an other network, a backup row, or a row of an other type', () => {
    expect(isLivePublishRow(publishRow('alice', { network: 'devnet' }))).toBe(false);
    expect(isLivePublishRow(publishRow('alice', { restoredFromBackup: true }))).toBe(false);
    expect(isLivePublishRow(registerRow('alice'))).toBe(false);
  });
});

describe('listMidenNamePublishes', () => {
  it('lists only live publish rows of the account on the effective network, newest first', async () => {
    const older = publishRow('older');
    const newer = publishRow('newer');
    await Repo.transactions.bulkAdd([
      older,
      newer,
      publishRow('devnet', { network: 'devnet' }),
      publishRow('backup', { restoredFromBackup: true }),
      publishRow('other', { accountId: 'mtst1other' }),
      registerRow('registration')
    ]);

    const rows = await listMidenNamePublishes(ACCOUNT);
    expect(rows.map(r => r.id)).toEqual([newer.id, older.id]);
  });

  it('matches a composite account id', async () => {
    const r = publishRow('alice');
    await Repo.transactions.add(r);
    const rows = await listMidenNamePublishes(`${ACCOUNT}_suffix`);
    expect(rows.map(x => x.id)).toEqual([r.id]);
  });
});

describe('useMidenNamePublishes', () => {
  it('updates live when a publish row is added', async () => {
    const first = publishRow('alice');
    await Repo.transactions.add(first);

    const { result, unmount } = renderHook(() => useMidenNamePublishes(ACCOUNT));
    await waitFor(() => expect(result.current.map(r => r.id)).toEqual([first.id]));

    const second = publishRow('bob');
    await act(async () => {
      await Repo.transactions.add(second);
    });
    await waitFor(() => expect(result.current.map(r => r.id)).toEqual([second.id, first.id]));
    unmount();
  });

  it('is empty with no account', async () => {
    await Repo.transactions.add(publishRow('alice'));
    const { result, unmount } = renderHook(() => useMidenNamePublishes(undefined));
    expect(result.current).toEqual([]);
    unmount();
  });

  it('logs a failed read and stays empty', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const where = jest.spyOn(Repo.transactions, 'where').mockImplementation(() => {
      throw new Error('db closed');
    });

    const { result, unmount } = renderHook(() => useMidenNamePublishes(ACCOUNT));
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith('[miden-name] Failed to read publishes:', expect.any(Error))
    );
    expect(result.current).toEqual([]);

    unmount();
    where.mockRestore();
    error.mockRestore();
  });
});

describe('publishingLabelsOf', () => {
  it('gives the labels of the publishes that are not done and not failed', () => {
    const labels = publishingLabelsOf([
      publishRow('queued'),
      publishRow('submitted', { phase: 'submitted', status: ITransactionStatus.Completed }),
      publishRow('recorded', { phase: 'recorded', status: ITransactionStatus.Completed }),
      publishRow('returning', { phase: 'returning', status: ITransactionStatus.Completed }),
      publishRow('done', { phase: 'done', status: ITransactionStatus.Completed }),
      publishRow('failed', { phase: 'failed', status: ITransactionStatus.Completed }),
      // A Failed row still at `requested` is failed: it is not in flight.
      publishRow('tx-failed', { status: ITransactionStatus.Failed }),
      registerRow('registration')
    ]);
    expect([...labels].sort()).toEqual(['queued', 'recorded', 'returning', 'submitted']);
  });

  it('is empty for no rows', () => {
    expect(publishingLabelsOf([]).size).toBe(0);
  });
});

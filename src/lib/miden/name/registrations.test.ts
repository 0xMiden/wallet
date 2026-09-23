import { act, renderHook, waitFor } from '@testing-library/react';

import { ITransaction, ITransactionStatus, MidenNamePhase, RegisterNameTransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import {
  listMidenNameRegistrations,
  phaseOf,
  uiStateOf,
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

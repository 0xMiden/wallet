import { act, renderHook, waitFor } from '@testing-library/react';

import { subscribeToLiveQuery } from 'lib/dexie-live-query';
import { ITransaction, ITransactionStatus, MidenNamePhase, RegisterNameTransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import {
  listMidenNameRegistrations,
  phaseOf,
  uiStateOf,
  useMidenNameRegistrations,
  useOwnedMidenName
} from './registrations';

jest.mock('lib/dexie-live-query', () => {
  const actual = jest.requireActual<typeof import('lib/dexie-live-query')>('lib/dexie-live-query');
  return {
    ...actual,
    subscribeToLiveQuery: jest.fn(actual.subscribeToLiveQuery)
  };
});

let mockNetwork = 'testnet';
let mockSupported = true;
const endpointListeners = new Set<() => void>();
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: () => mockNetwork,
  subscribeEffectiveEndpoints: (listener: () => void) => {
    endpointListeners.add(listener);
    return () => {
      endpointListeners.delete(listener);
    };
  }
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

  it('keeps a Failed row awaiting verdict non-terminal instead of mapping to failed', () => {
    const pendingVerdict = registerRow('alice', { phase: 'requested', status: ITransactionStatus.Failed });
    pendingVerdict.submitEvidence = [
      {
        attemptId: 'a1',
        capturedAt: 1,
        source: 'stage',
        transactionId: '0x1',
        initialCommitment: '0x2',
        finalCommitment: '0x3',
        initialNonce: '4',
        outputNoteIds: ['0xnote-alice'],
        nullifiers: [],
        refBlock: 100,
        refBlockCommitment: '0x4'
      }
    ];
    expect(phaseOf(pendingVerdict)).toBe('requested');

    const submittedVerdict = registerRow('alice', { phase: 'submitted', status: ITransactionStatus.Failed });
    submittedVerdict.submitEvidence = pendingVerdict.submitEvidence;
    expect(phaseOf(submittedVerdict)).toBe('submitted');

    const provenDead = registerRow('alice', { phase: 'requested', status: ITransactionStatus.Failed });
    provenDead.submitEvidence = pendingVerdict.submitEvidence;
    provenDead.neverCommittedAt = 100;
    expect(phaseOf(provenDead)).toBe('failed');
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
    jest.mocked(subscribeToLiveQuery).mockClear();
    await Repo.transactions.add(registerRow('alice', { phase: 'owned', status: ITransactionStatus.Completed }));
    const { result, unmount } = renderHook(() => ({
      list: useMidenNameRegistrations(ACCOUNT),
      owned: useOwnedMidenName(ACCOUNT)
    }));
    await waitFor(() => expect(result.current.list.loaded).toBe(true));
    expect(result.current.owned).toBeUndefined();
    expect(subscribeToLiveQuery).not.toHaveBeenCalled();
    unmount();
  });

  it('is loaded and empty with no account', async () => {
    const { result, unmount } = renderHook(() => useMidenNameRegistrations(undefined));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.rows).toEqual([]);
    unmount();
  });

  it('synchronously resets rows and owned name on the transition render frame when accountId changes', async () => {
    await Repo.transactions.add(registerRow('alice', { phase: 'owned', status: ITransactionStatus.Completed }));
    const frames: { accountId: string | undefined; rowsLen: number; loaded: boolean; owned: string | undefined }[] = [];

    const { rerender, unmount } = renderHook(
      ({ accountId }: { accountId: string | undefined }) => {
        const list = useMidenNameRegistrations(accountId);
        const owned = useOwnedMidenName(accountId);
        frames.push({ accountId, rowsLen: list.rows.length, loaded: list.loaded, owned });
        return { list, owned };
      },
      { initialProps: { accountId: ACCOUNT as string | undefined } }
    );

    await waitFor(() =>
      expect(frames.at(-1)).toEqual({ accountId: ACCOUNT, rowsLen: 1, loaded: true, owned: 'alice' })
    );

    frames.length = 0;
    rerender({ accountId: 'mtst1other' });
    // First render frame for the new account must not expose the previous account's rows or owned name.
    expect(frames[0]).toEqual({ accountId: 'mtst1other', rowsLen: 0, loaded: false, owned: undefined });

    await waitFor(() =>
      expect(frames.at(-1)).toEqual({ accountId: 'mtst1other', rowsLen: 0, loaded: true, owned: undefined })
    );
    unmount();
  });

  it('reacts to endpoint-support toggles without remounting and clears state on the transition frame', async () => {
    mockSupported = false;
    await Repo.transactions.add(registerRow('alice', { phase: 'owned', status: ITransactionStatus.Completed }));
    const frames: { rowsLen: number; loaded: boolean; owned: string | undefined }[] = [];

    const { result, unmount } = renderHook(() => {
      const list = useMidenNameRegistrations(ACCOUNT);
      const owned = useOwnedMidenName(ACCOUNT);
      frames.push({ rowsLen: list.rows.length, loaded: list.loaded, owned });
      return { list, owned };
    });

    await waitFor(() => expect(result.current.list.loaded).toBe(true));
    expect(result.current.list.rows).toHaveLength(0);
    expect(result.current.owned).toBeUndefined();

    frames.length = 0;
    mockSupported = true;
    await act(async () => {
      for (const listener of endpointListeners) listener();
    });
    expect(frames[0]).toEqual({ rowsLen: 0, loaded: false, owned: undefined });
    await waitFor(() => expect(result.current.owned).toBe('alice'));
    expect(result.current.list.rows).toHaveLength(1);

    frames.length = 0;
    mockSupported = false;
    await act(async () => {
      for (const listener of endpointListeners) listener();
    });
    expect(frames[0]).toEqual({ rowsLen: 0, loaded: true, owned: undefined });
    expect(result.current.list.loaded).toBe(true);
    expect(result.current.owned).toBeUndefined();
    unmount();
  });

  it('clears rows and owned name on the transition frame when the network changes while support stays true', async () => {
    await Repo.transactions.bulkAdd([
      registerRow('alice', { phase: 'owned', status: ITransactionStatus.Completed }),
      registerRow('bob', { phase: 'owned', status: ITransactionStatus.Completed, network: 'devnet' })
    ]);
    const frames: { rowsLen: number; loaded: boolean; owned: string | undefined }[] = [];

    const { result, unmount } = renderHook(() => {
      const list = useMidenNameRegistrations(ACCOUNT);
      const owned = useOwnedMidenName(ACCOUNT);
      frames.push({ rowsLen: list.rows.length, loaded: list.loaded, owned });
      return { list, owned };
    });
    await waitFor(() => expect(result.current.owned).toBe('alice'));

    frames.length = 0;
    mockNetwork = 'devnet';
    await act(async () => {
      for (const listener of endpointListeners) listener();
    });
    expect(frames[0]).toEqual({ rowsLen: 0, loaded: false, owned: undefined });
    expect(frames.map(frame => frame.owned)).not.toContain('alice');
    await waitFor(() => expect(result.current.owned).toBe('bob'));
    expect(result.current.list.rows).toHaveLength(1);
    unmount();
  });

  it('does not show the pre-drop rows again when support returns after the rows changed', async () => {
    await Repo.transactions.add(registerRow('alice', { phase: 'owned', status: ITransactionStatus.Completed }));
    const frames: { rowsLen: number; loaded: boolean; owned: string | undefined }[] = [];

    const { result, unmount } = renderHook(() => {
      const list = useMidenNameRegistrations(ACCOUNT);
      const owned = useOwnedMidenName(ACCOUNT);
      frames.push({ rowsLen: list.rows.length, loaded: list.loaded, owned });
      return { list, owned };
    });
    await waitFor(() => expect(result.current.owned).toBe('alice'));

    mockSupported = false;
    await act(async () => {
      for (const listener of endpointListeners) listener();
    });
    expect(result.current.owned).toBeUndefined();

    await Repo.transactions.clear();
    frames.length = 0;
    mockSupported = true;
    await act(async () => {
      for (const listener of endpointListeners) listener();
    });
    expect(frames[0]).toEqual({ rowsLen: 0, loaded: false, owned: undefined });
    expect(frames.map(frame => frame.owned)).not.toContain('alice');
    await waitFor(() => expect(result.current.list.loaded).toBe(true));
    expect(result.current.list.rows).toHaveLength(0);
    expect(result.current.owned).toBeUndefined();
    unmount();
  });
});

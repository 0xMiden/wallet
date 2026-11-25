import {
  IConsumeMidenNameExtraInputs,
  IRegisterNameExtraInputs,
  ITransaction,
  ITransactionStatus,
  MidenNamePhase,
  RegisterNameTransaction
} from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import type { RegistrationNoteState, RegistryDeliveryScan } from './reads';
import { reconcileMidenNameRegistrations } from './tracker';

let mockNetwork = 'testnet';
let mockSupported = true;
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: () => mockNetwork
}));
jest.mock('./config', () => ({
  isMidenNameSupported: () => mockSupported
}));
jest.mock('lib/settings/helpers', () => ({
  isDelegateProofEnabled: () => true
}));

const mockFetchState = jest.fn<Promise<RegistrationNoteState>, [string]>();
const mockFetchIssued = jest.fn<Promise<boolean>, [string]>();
const mockFindDelivery = jest.fn<
  Promise<RegistryDeliveryScan>,
  [{ accountId: string; fromBlock: number; label: string }]
>();
const mockChainTip = jest.fn<Promise<number>, []>();
jest.mock('./reads', () => ({
  fetchRegistrationNoteState: (noteId: string) => mockFetchState(noteId),
  fetchMidenNameIssued: (label: string) => mockFetchIssued(label),
  findRegistryDeliveryNoteIds: (args: { accountId: string; fromBlock: number; label: string }) =>
    mockFindDelivery(args),
  getChainTip: () => mockChainTip()
}));

const TERMINAL: MidenNamePhase[] = ['owned', 'failed'];

// A small copy of the monotonic patch in complete.ts, on the real (fake-indexeddb) Dexie.
jest.mock('lib/miden/transaction/complete', () => ({
  patchRegisterNameExtraInputs: async (
    id: string,
    patch: Partial<IRegisterNameExtraInputs>,
    options: { expectPhase?: MidenNamePhase } = {}
  ): Promise<boolean> => {
    let written = false;
    await Repo.transactions.where({ id }).modify(tx => {
      const inputs: IRegisterNameExtraInputs | undefined = tx.extraInputs;
      if (tx.type !== 'register-name' || tx.restoredFromBackup || !inputs) return;
      if (options.expectPhase !== undefined && inputs.phase !== options.expectPhase) return;
      const next = patch.phase ?? inputs.phase;
      if (next !== inputs.phase && TERMINAL.includes(inputs.phase)) return;
      tx.extraInputs = { ...inputs, ...patch, phase: next };
      written = true;
    });
    return written;
  }
}));

const mockInitiateFromId = jest.fn<Promise<string>, [string, string, boolean | undefined, boolean | undefined]>();
jest.mock('lib/miden/transaction/initiate', () => ({
  initiateConsumeTransactionFromId: (
    accountId: string,
    noteId: string,
    delegate: boolean | undefined,
    manualRetry: boolean | undefined
  ) => mockInitiateFromId(accountId, noteId, delegate, manualRetry),
  tagConsumeAsMidenNameClaim: async (txId: string, label: string, registerTxId: string) => {
    const claim: IConsumeMidenNameExtraInputs = { midenNameClaim: { label, registerTxId } };
    await Repo.transactions.where({ id: txId }).modify(tx => {
      tx.extraInputs = { ...(tx.extraInputs ?? {}), ...claim };
    });
  }
}));

const ACCOUNT = 'mtst1account';
const startProcessing = jest.fn();

function registerRow(
  label: string,
  phase: MidenNamePhase,
  status: ITransactionStatus = ITransactionStatus.Completed,
  extra: Partial<IRegisterNameExtraInputs> = {}
): ITransaction {
  const row: ITransaction = new RegisterNameTransaction({
    accountId: ACCOUNT,
    label,
    network: 'testnet',
    paymentFaucetId: 'mtst1miden',
    registryAccountId: 'mtst1registry',
    priceBaseUnits: 20_000_000n,
    networkFeeBaseUnits: 210n,
    requestBytes: new Uint8Array([1]),
    registrationNoteId: `0xnote-${label}`,
    reclaimHeight: 1300,
    builtAtBlock: 1000
  });
  row.status = status;
  row.extraInputs = { ...row.extraInputs, phase, ...extra };
  return row;
}

function consumeRow(id: string, noteId: string, status: ITransactionStatus, extraInputs?: object): ITransaction {
  return {
    id,
    type: 'consume',
    accountId: ACCOUNT,
    noteId,
    noteIds: [noteId],
    status,
    initiatedAt: 1,
    displayIcon: 'RECEIVE',
    ...(extraInputs ? { extraInputs } : {})
  };
}

async function inputsOf(id: string): Promise<IRegisterNameExtraInputs> {
  const row = await Repo.transactions.where({ id }).first();
  const inputs: IRegisterNameExtraInputs | undefined = row?.extraInputs;
  if (!inputs) throw new Error(`no row ${id}`);
  return inputs;
}

async function add(...rows: ITransaction[]): Promise<void> {
  await Repo.transactions.bulkAdd(rows);
}

const pass = () => reconcileMidenNameRegistrations({ startProcessing });

let consumeSeq = 0;
beforeEach(async () => {
  jest.clearAllMocks();
  mockNetwork = 'testnet';
  mockSupported = true;
  consumeSeq = 0;
  await Repo.transactions.clear();
  mockChainTip.mockResolvedValue(1100);
  mockFetchIssued.mockResolvedValue(false);
  mockFetchState.mockResolvedValue({ status: 'pending', attemptCount: 0 });
  mockFindDelivery.mockImplementation(async ({ fromBlock }) => ({ noteIds: [], scannedTo: Math.max(fromBlock, 1200) }));
  mockInitiateFromId.mockImplementation(async (_accountId, noteId) => {
    consumeSeq += 1;
    const id = `consume-${consumeSeq}`;
    await Repo.transactions.add(consumeRow(id, noteId, ITransactionStatus.Queued));
    return id;
  });
});

describe('transition 1: register row Failed', () => {
  it('marks the registration failed / tx-failed with the row error', async () => {
    const row = registerRow('alice', 'requested', ITransactionStatus.Failed);
    row.error = 'boom';
    await add(row);
    await pass();
    expect(await inputsOf(row.id)).toMatchObject({ phase: 'failed', failure: 'tx-failed', lastError: 'boom' });
    expect(mockFetchState).not.toHaveBeenCalled();
  });

  it('does nothing for a Queued row', async () => {
    const row = registerRow('alice', 'requested', ITransactionStatus.Queued);
    await add(row);
    await pass();
    expect((await inputsOf(row.id)).phase).toBe('requested');
    expect(mockFetchState).not.toHaveBeenCalled();
  });
});

describe('transition 2: register note state', () => {
  it.each<MidenNamePhase>(['submitted', 'requested'])(
    'consumed and issued → issued (from %s on a Completed row)',
    async phase => {
      const row = registerRow('alice', phase);
      await add(row);
      mockFetchState.mockResolvedValue({ status: 'consumed', attemptCount: 1 });
      mockFetchIssued.mockResolvedValue(true);
      await pass();
      expect(mockFetchState).toHaveBeenCalledWith('0xnote-alice');
      expect((await inputsOf(row.id)).phase).toBe('issued');
    }
  );

  it('consumed but not issued yet → waits', async () => {
    const row = registerRow('alice', 'submitted');
    await add(row);
    mockFetchState.mockResolvedValue({ status: 'consumed', attemptCount: 1 });
    mockFetchIssued.mockResolvedValue(false);
    await pass();
    expect((await inputsOf(row.id)).phase).toBe('submitted');
  });

  it('discarded and issued → failed / taken', async () => {
    const row = registerRow('alice', 'submitted');
    await add(row);
    mockFetchState.mockResolvedValue({ status: 'discarded', attemptCount: 3, lastError: 'already issued' });
    mockFetchIssued.mockResolvedValue(true);
    await pass();
    expect(await inputsOf(row.id)).toMatchObject({ phase: 'failed', failure: 'taken', lastError: 'already issued' });
  });

  it('discarded and not issued → failed / discarded', async () => {
    const row = registerRow('alice', 'submitted');
    await add(row);
    mockFetchState.mockResolvedValue({ status: 'discarded', attemptCount: 3, lastError: 'bad note' });
    await pass();
    expect(await inputsOf(row.id)).toMatchObject({ phase: 'failed', failure: 'discarded', lastError: 'bad note' });
  });

  it.each(['pending', 'inflight', 'unknown'] as const)(
    '%s after the reclaim height → failed / expired',
    async status => {
      const row = registerRow('alice', 'submitted');
      await add(row);
      mockFetchState.mockResolvedValue({ status, attemptCount: 0 });
      mockChainTip.mockResolvedValue(1301);
      await pass();
      expect(await inputsOf(row.id)).toMatchObject({ phase: 'failed', failure: 'expired' });
    }
  );

  it('pending at the reclaim height → waits', async () => {
    const row = registerRow('alice', 'submitted');
    await add(row);
    mockChainTip.mockResolvedValue(1300);
    await pass();
    expect((await inputsOf(row.id)).phase).toBe('submitted');
  });

  it('reads the chain tip one time per pass', async () => {
    await add(registerRow('alice', 'submitted'), registerRow('bob', 'submitted'));
    await pass();
    expect(mockChainTip).toHaveBeenCalledTimes(1);
  });

  it('reads the chain tip again for the next row after a failed read', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const first = registerRow('alice', 'submitted');
    const second = registerRow('bob', 'submitted');
    await add(first, second);
    mockChainTip.mockRejectedValueOnce(new Error('rpc down')).mockResolvedValueOnce(1301);
    await pass();
    expect(mockChainTip).toHaveBeenCalledTimes(2);
    const phases = [(await inputsOf(first.id)).phase, (await inputsOf(second.id)).phase];
    expect(phases.sort()).toEqual(['failed', 'submitted']);
    warn.mockRestore();
  });
});

describe('transition 3: issued → claiming', () => {
  it('queues one consume of the delivery note, tags it and starts processing', async () => {
    const row = registerRow('alice', 'issued');
    await add(row);
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xdelivery'], scannedTo: 1200 });

    await pass();

    expect(mockFindDelivery).toHaveBeenCalledWith({ accountId: ACCOUNT, fromBlock: 1000, label: 'alice' });
    expect(mockInitiateFromId).toHaveBeenCalledWith(ACCOUNT, '0xdelivery', true, false);
    const inputs = await inputsOf(row.id);
    expect(inputs).toMatchObject({ phase: 'claiming', deliveryNoteId: '0xdelivery', claimTxId: 'consume-1' });
    // The scan cursor does not move past a note that the tracker claims.
    expect(inputs.deliveryScanFrom).toBeUndefined();
    const claim = await Repo.transactions.where({ id: 'consume-1' }).first();
    expect(claim?.extraInputs).toEqual({ midenNameClaim: { label: 'alice', registerTxId: row.id } });
    expect(startProcessing).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: two passes queue one consume', async () => {
    const row = registerRow('alice', 'issued');
    await add(row);
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xdelivery'], scannedTo: 1200 });
    await pass();
    await pass();
    expect(mockInitiateFromId).toHaveBeenCalledTimes(1);
    expect((await Repo.transactions.toArray()).filter(tx => tx.type === 'consume')).toHaveLength(1);
  });

  it('retries next pass when the note is not in the local store yet', async () => {
    const row = registerRow('alice', 'issued');
    await add(row);
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xdelivery'], scannedTo: 1200 });
    mockInitiateFromId.mockRejectedValueOnce(new Error('Note with id 0xdelivery not found'));

    await pass();
    const afterFirst = await inputsOf(row.id);
    expect(afterFirst.phase).toBe('issued');
    expect(afterFirst.deliveryScanFrom).toBeUndefined();
    expect(startProcessing).not.toHaveBeenCalled();

    await pass();
    expect(mockFindDelivery).toHaveBeenLastCalledWith({ accountId: ACCOUNT, fromBlock: 1000, label: 'alice' });
    expect((await inputsOf(row.id)).phase).toBe('claiming');
  });

  it('advances the scan cursor when the scan finds no delivery note', async () => {
    const row = registerRow('alice', 'issued');
    await add(row);
    mockFindDelivery.mockResolvedValue({ noteIds: [], scannedTo: 1200 });
    await pass();
    expect((await inputsOf(row.id)).deliveryScanFrom).toBe(1201);
    await pass();
    expect(mockFindDelivery).toHaveBeenLastCalledWith({ accountId: ACCOUNT, fromBlock: 1201, label: 'alice' });
  });

  it('skips a note that a consume row of an other register row has', async () => {
    const row = registerRow('alice', 'issued');
    await add(
      row,
      consumeRow('done', '0xold', ITransactionStatus.Completed, {
        midenNameClaim: { label: 'alice', registerTxId: 'r-old' }
      }),
      consumeRow('theirs', '0xbob', ITransactionStatus.Queued, { midenNameClaim: { label: 'bob', registerTxId: 'r2' } })
    );
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xold', '0xbob', '0xnew'], scannedTo: 1200 });
    await pass();
    expect(mockInitiateFromId).toHaveBeenCalledTimes(1);
    expect(mockInitiateFromId).toHaveBeenCalledWith(ACCOUNT, '0xnew', true, false);
  });

  it('does not count a Failed consume row as a claim', async () => {
    const row = registerRow('alice', 'issued');
    await add(row, consumeRow('failed-1', '0xdelivery', ITransactionStatus.Failed));
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xdelivery'], scannedTo: 1200 });
    await pass();
    expect(mockInitiateFromId).toHaveBeenCalledWith(ACCOUNT, '0xdelivery', true, false);
    expect((await inputsOf(row.id)).claimTxId).toBe('consume-1');
  });

  it('does not link a Failed row that the retry backoff gives back', async () => {
    const row = registerRow('alice', 'issued');
    await add(row, consumeRow('failed-1', '0xdelivery', ITransactionStatus.Failed));
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xdelivery'], scannedTo: 1200 });
    mockInitiateFromId.mockResolvedValueOnce('failed-1');
    await pass();
    expect((await inputsOf(row.id)).phase).toBe('issued');
    expect(startProcessing).not.toHaveBeenCalled();
  });

  it('adopts a live consume row that is already tagged for this registration', async () => {
    const row = registerRow('alice', 'issued');
    await add(
      row,
      consumeRow('mine', '0xdelivery', ITransactionStatus.Queued, {
        midenNameClaim: { label: 'alice', registerTxId: row.id }
      })
    );
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xdelivery'], scannedTo: 1200 });
    await pass();
    expect(mockInitiateFromId).not.toHaveBeenCalled();
    expect(await inputsOf(row.id)).toMatchObject({ phase: 'claiming', claimTxId: 'mine' });
  });

  it('asks the scan for the notes of its own label, so two registrations get their own notes', async () => {
    const alice = registerRow('alice', 'issued');
    const bob = registerRow('bob', 'issued');
    await add(alice, bob);
    // The registry delivered bob's note first. The scan matches notes by label.
    mockFindDelivery.mockImplementation(async ({ label }) => ({
      noteIds: [label === 'alice' ? '0xd-alice' : '0xd-bob'],
      scannedTo: 1200
    }));
    await pass();
    expect(mockFindDelivery).toHaveBeenCalledWith({ accountId: ACCOUNT, fromBlock: 1000, label: 'alice' });
    expect(mockFindDelivery).toHaveBeenCalledWith({ accountId: ACCOUNT, fromBlock: 1000, label: 'bob' });
    expect((await inputsOf(alice.id)).deliveryNoteId).toBe('0xd-alice');
    expect((await inputsOf(bob.id)).deliveryNoteId).toBe('0xd-bob');
  });

  it('adopts a live untagged consume of the name note (the tag write was lost)', async () => {
    const row = registerRow('alice', 'issued');
    await add(row, consumeRow('manual', '0xdelivery', ITransactionStatus.GeneratingTransaction));
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xdelivery'], scannedTo: 1200 });
    await pass();
    expect(mockInitiateFromId).not.toHaveBeenCalled();
    expect(await inputsOf(row.id)).toMatchObject({
      phase: 'claiming',
      deliveryNoteId: '0xdelivery',
      claimTxId: 'manual'
    });
    const claim = await Repo.transactions.where({ id: 'manual' }).first();
    expect(claim?.extraInputs).toEqual({ midenNameClaim: { label: 'alice', registerTxId: row.id } });
    expect(startProcessing).toHaveBeenCalledTimes(1);
  });

  it('adopts a Completed untagged consume of the name note: owned, no new consume', async () => {
    const row = registerRow('alice', 'issued');
    await add(row, consumeRow('lost-tag', '0xdelivery', ITransactionStatus.Completed));
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xdelivery'], scannedTo: 1200 });
    await pass();
    expect(mockInitiateFromId).not.toHaveBeenCalled();
    expect(startProcessing).not.toHaveBeenCalled();
    expect(await inputsOf(row.id)).toMatchObject({
      phase: 'owned',
      deliveryNoteId: '0xdelivery',
      claimTxId: 'lost-tag'
    });
    const claim = await Repo.transactions.where({ id: 'lost-tag' }).first();
    expect(claim?.extraInputs).toEqual({ midenNameClaim: { label: 'alice', registerTxId: row.id } });
  });

  it('prefers the Completed untagged consume over a live one of the same note', async () => {
    const row = registerRow('alice', 'issued');
    await add(
      row,
      consumeRow('retry', '0xdelivery', ITransactionStatus.Queued),
      consumeRow('lost-tag', '0xdelivery', ITransactionStatus.Completed)
    );
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xdelivery'], scannedTo: 1200 });
    await pass();
    expect(await inputsOf(row.id)).toMatchObject({ phase: 'owned', claimTxId: 'lost-tag' });
  });
});

describe('transition 3: waits and errors', () => {
  it('logs an other queue error and stays issued', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const row = registerRow('alice', 'issued');
    await add(row);
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xdelivery'], scannedTo: 1200 });
    mockInitiateFromId.mockRejectedValueOnce(new Error('locked'));
    await pass();
    expect((await inputsOf(row.id)).phase).toBe('issued');
    expect(warn).toHaveBeenCalledWith(
      '[miden-name] could not queue the claim',
      expect.objectContaining({ txId: row.id, noteId: '0xdelivery' })
    );
    warn.mockRestore();
  });

  it('claiming with no claim row → issued with a missing-row error', async () => {
    const row = registerRow('alice', 'claiming');
    await add(row);
    await pass();
    expect(await inputsOf(row.id)).toMatchObject({ phase: 'issued', lastError: 'The claim transaction is missing' });
  });
});

describe('transition 4: claiming', () => {
  it('claim row Completed → owned', async () => {
    const row = registerRow('alice', 'claiming', ITransactionStatus.Completed, { claimTxId: 'c1' });
    await add(row, consumeRow('c1', '0xdelivery', ITransactionStatus.Completed));
    await pass();
    expect((await inputsOf(row.id)).phase).toBe('owned');
  });

  it('claim row Failed → issued with lastError', async () => {
    const row = registerRow('alice', 'claiming', ITransactionStatus.Completed, { claimTxId: 'c1' });
    const claim = consumeRow('c1', '0xdelivery', ITransactionStatus.Failed);
    claim.error = 'prover down';
    await add(row, claim);
    await pass();
    expect(await inputsOf(row.id)).toMatchObject({ phase: 'issued', lastError: 'prover down' });
  });

  it('claim row in progress → waits', async () => {
    const row = registerRow('alice', 'claiming', ITransactionStatus.Completed, { claimTxId: 'c1' });
    await add(row, consumeRow('c1', '0xdelivery', ITransactionStatus.GeneratingTransaction));
    await pass();
    expect((await inputsOf(row.id)).phase).toBe('claiming');
  });
});

describe('row selection and isolation', () => {
  it('ignores backup, wrong-network and terminal rows', async () => {
    const backup = registerRow('backup', 'submitted');
    backup.restoredFromBackup = true;
    const devnet = registerRow('devnet', 'submitted', ITransactionStatus.Completed, { network: 'devnet' });
    await add(backup, devnet, registerRow('owned', 'owned'), registerRow('failed', 'failed'));
    await pass();
    expect(mockFetchState).not.toHaveBeenCalled();
    expect(mockFindDelivery).not.toHaveBeenCalled();
  });

  it('does nothing when the network is not supported', async () => {
    mockSupported = false;
    await add(registerRow('alice', 'submitted'));
    await pass();
    expect(mockFetchState).not.toHaveBeenCalled();
  });

  it('continues with the next row when one row throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = registerRow('bad', 'submitted');
    const good = registerRow('good', 'submitted');
    await add(bad, good);
    mockFetchState.mockImplementation(async noteId => {
      if (noteId === '0xnote-bad') throw new Error('rpc down');
      return { status: 'consumed', attemptCount: 1 };
    });
    mockFetchIssued.mockResolvedValue(true);

    await pass();

    expect((await inputsOf(bad.id)).phase).toBe('submitted');
    expect((await inputsOf(good.id)).phase).toBe('issued');
    expect(warn).toHaveBeenCalledWith('[miden-name] tracker step failed', expect.objectContaining({ txId: bad.id }));
    warn.mockRestore();
  });
});

import {
  IConsumeMidenNameExtraInputs,
  IConsumeMidenNameReturnExtraInputs,
  IPublishNameRecordExtraInputs,
  IRegisterNameExtraInputs,
  ITransaction,
  ITransactionStatus,
  MidenNamePhase,
  MidenNamePublishPhase,
  PublishNameRecordTransaction,
  RegisterNameTransaction
} from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import type { AccountIdParts } from './encoding';
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

const mockFetchRecord = jest.fn<Promise<AccountIdParts | null>, [string]>();
jest.mock('./resolver', () => ({
  fetchDomainRecord: (label: string) => mockFetchRecord(label)
}));

// The record `{ prefix: 1n }` is the account of the rows; every other record is an other account.
jest.mock('./sdk-words', () => ({
  accountIdFromParts: (parts: AccountIdParts) => ({
    toString: () => (parts.prefix === 1n ? 'mtst1account' : `mtst1other${parts.prefix}`)
  })
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  getBech32AddressFromAccountId: (id: { toString(): string }) => id.toString()
}));

const TERMINAL: MidenNamePhase[] = ['owned', 'failed'];
const PUBLISH_TERMINAL: MidenNamePublishPhase[] = ['done', 'failed'];

// A small copy of the monotonic patch in complete.ts, on the real (fake-indexeddb) Dexie.
jest.mock('lib/miden/transaction/complete', () => ({
  patchPublishNameRecordExtraInputs: async (
    id: string,
    patch: Partial<IPublishNameRecordExtraInputs>,
    options: { expectPhase?: MidenNamePublishPhase } = {}
  ): Promise<boolean> => {
    let written = false;
    await Repo.transactions.where({ id }).modify(tx => {
      const inputs: IPublishNameRecordExtraInputs | undefined = tx.extraInputs;
      if (tx.type !== 'publish-name-record' || tx.restoredFromBackup || !inputs) return;
      if (options.expectPhase !== undefined && inputs.phase !== options.expectPhase) return;
      const next = patch.phase ?? inputs.phase;
      if (next !== inputs.phase && PUBLISH_TERMINAL.includes(inputs.phase)) return;
      tx.extraInputs = { ...inputs, ...patch, phase: next };
      written = true;
    });
    return written;
  },
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
  },
  tagConsumeAsMidenNameReturn: async (txId: string, label: string, publishTxId: string) => {
    const tag: IConsumeMidenNameReturnExtraInputs = { midenNameReturn: { label, publishTxId } };
    await Repo.transactions.where({ id: txId }).modify(tx => {
      tx.extraInputs = { ...(tx.extraInputs ?? {}), ...tag };
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
  mockFetchRecord.mockResolvedValue(null);
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

// ---- Registry-record publishes ----

const HERE: AccountIdParts = { prefix: 1n, suffix: 2n };
const ELSEWHERE: AccountIdParts = { prefix: 9n, suffix: 2n };

function publishRow(
  label: string,
  phase: MidenNamePublishPhase,
  status: ITransactionStatus = ITransactionStatus.Completed,
  extra: Partial<IPublishNameRecordExtraInputs> = {}
): ITransaction {
  const row: ITransaction = new PublishNameRecordTransaction({
    accountId: ACCOUNT,
    label,
    network: 'testnet',
    registryAccountId: 'mtst1registry',
    nfaFaucetId: 'mtst1registry',
    requestBytes: new Uint8Array([1]),
    registryNoteId: `0xregistry-${label}`,
    reclaimHeight: 1300,
    builtAtBlock: 1000,
    action: 3n
  });
  row.status = status;
  row.extraInputs = { ...row.extraInputs, phase, ...extra };
  return row;
}

async function publishInputsOf(id: string): Promise<IPublishNameRecordExtraInputs> {
  const row = await Repo.transactions.where({ id }).first();
  const inputs: IPublishNameRecordExtraInputs | undefined = row?.extraInputs;
  if (!inputs) throw new Error(`no row ${id}`);
  return inputs;
}

describe('publish step 1: publish row Failed', () => {
  it('marks the publish failed / tx-failed with the row error', async () => {
    const row = publishRow('alice', 'requested', ITransactionStatus.Failed);
    row.error = 'boom';
    await add(row);
    await pass();
    expect(await publishInputsOf(row.id)).toMatchObject({ phase: 'failed', failure: 'tx-failed', lastError: 'boom' });
    expect(mockFetchState).not.toHaveBeenCalled();
  });

  it('writes no lastError when the row has no error', async () => {
    const row = publishRow('alice', 'submitted', ITransactionStatus.Failed);
    await add(row);
    await pass();
    const inputs = await publishInputsOf(row.id);
    expect(inputs).toMatchObject({ phase: 'failed', failure: 'tx-failed' });
    expect(inputs.lastError).toBeUndefined();
  });

  it('does nothing for a Queued row', async () => {
    const row = publishRow('alice', 'requested', ITransactionStatus.Queued);
    await add(row);
    await pass();
    expect((await publishInputsOf(row.id)).phase).toBe('requested');
    expect(mockFetchState).not.toHaveBeenCalled();
  });
});

describe('publish step 2: registry note state', () => {
  it.each<MidenNamePublishPhase>(['submitted', 'requested'])(
    'consumed and the record points here → recorded (from %s on a Completed row)',
    async phase => {
      const row = publishRow('alice', phase);
      await add(row);
      mockFetchState.mockResolvedValue({ status: 'consumed', attemptCount: 1 });
      mockFetchRecord.mockResolvedValue(HERE);
      await pass();
      expect(mockFetchState).toHaveBeenCalledWith('0xregistry-alice');
      expect(mockFetchRecord).toHaveBeenCalledWith('alice');
      expect((await publishInputsOf(row.id)).phase).toBe('recorded');
    }
  );

  it('consumed but no record yet → waits', async () => {
    const row = publishRow('alice', 'submitted');
    await add(row);
    mockFetchState.mockResolvedValue({ status: 'consumed', attemptCount: 1 });
    await pass();
    expect((await publishInputsOf(row.id)).phase).toBe('submitted');
  });

  it('consumed but the record points to an other account → waits', async () => {
    const row = publishRow('alice', 'submitted');
    await add(row);
    mockFetchState.mockResolvedValue({ status: 'consumed', attemptCount: 1 });
    mockFetchRecord.mockResolvedValue(ELSEWHERE);
    await pass();
    expect((await publishInputsOf(row.id)).phase).toBe('submitted');
  });

  it('discarded → failed / discarded with the last error', async () => {
    const row = publishRow('alice', 'submitted');
    await add(row);
    mockFetchState.mockResolvedValue({ status: 'discarded', attemptCount: 3, lastError: 'not the owner' });
    await pass();
    expect(await publishInputsOf(row.id)).toMatchObject({
      phase: 'failed',
      failure: 'discarded',
      lastError: 'not the owner'
    });
    // A discarded publish reads no record.
    expect(mockFetchRecord).not.toHaveBeenCalled();
  });

  it('discarded with no last error → failed / discarded', async () => {
    const row = publishRow('alice', 'submitted');
    await add(row);
    mockFetchState.mockResolvedValue({ status: 'discarded', attemptCount: 3 });
    await pass();
    const inputs = await publishInputsOf(row.id);
    expect(inputs).toMatchObject({ phase: 'failed', failure: 'discarded' });
    expect(inputs.lastError).toBeUndefined();
  });

  it.each(['pending', 'inflight', 'unknown'] as const)(
    '%s after the reclaim height → failed / expired',
    async status => {
      const row = publishRow('alice', 'submitted');
      await add(row);
      mockFetchState.mockResolvedValue({ status, attemptCount: 0, lastError: 'slow' });
      mockChainTip.mockResolvedValue(1301);
      await pass();
      expect(await publishInputsOf(row.id)).toMatchObject({ phase: 'failed', failure: 'expired', lastError: 'slow' });
    }
  );

  it('expired with no last error has no lastError', async () => {
    const row = publishRow('alice', 'submitted');
    await add(row);
    mockChainTip.mockResolvedValue(1301);
    await pass();
    const inputs = await publishInputsOf(row.id);
    expect(inputs).toMatchObject({ phase: 'failed', failure: 'expired' });
    expect(inputs.lastError).toBeUndefined();
  });

  it('pending at the reclaim height → waits', async () => {
    const row = publishRow('alice', 'submitted');
    await add(row);
    mockChainTip.mockResolvedValue(1300);
    await pass();
    expect((await publishInputsOf(row.id)).phase).toBe('submitted');
  });

  it('shares one chain-tip read with the registrations of the pass', async () => {
    await add(registerRow('alice', 'submitted'), publishRow('bob', 'submitted'));
    await pass();
    expect(mockChainTip).toHaveBeenCalledTimes(1);
  });

  it('reads the chain tip again for the next row after a failed read', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const first = publishRow('alice', 'submitted');
    const second = publishRow('bob', 'submitted');
    await add(first, second);
    mockChainTip.mockRejectedValueOnce(new Error('rpc down')).mockResolvedValueOnce(1301);
    await pass();
    expect(mockChainTip).toHaveBeenCalledTimes(2);
    const phases = [(await publishInputsOf(first.id)).phase, (await publishInputsOf(second.id)).phase];
    expect(phases.sort()).toEqual(['failed', 'submitted']);
    warn.mockRestore();
  });
});

describe('publish step 3: recorded → returning', () => {
  it('queues one consume of the return note, tags it and starts processing', async () => {
    const row = publishRow('alice', 'recorded');
    await add(row);
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xreturn'], scannedTo: 1200 });

    await pass();

    expect(mockFindDelivery).toHaveBeenCalledWith({ accountId: ACCOUNT, fromBlock: 1000, label: 'alice' });
    expect(mockInitiateFromId).toHaveBeenCalledWith(ACCOUNT, '0xreturn', true, false);
    const inputs = await publishInputsOf(row.id);
    expect(inputs).toMatchObject({ phase: 'returning', returnNoteId: '0xreturn', returnTxId: 'consume-1' });
    expect(inputs.returnScanFrom).toBeUndefined();
    const returnRow = await Repo.transactions.where({ id: 'consume-1' }).first();
    expect(returnRow?.extraInputs).toEqual({ midenNameReturn: { label: 'alice', publishTxId: row.id } });
    expect(startProcessing).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: two passes queue one consume', async () => {
    const row = publishRow('alice', 'recorded');
    await add(row);
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xreturn'], scannedTo: 1200 });
    await pass();
    await pass();
    expect(mockInitiateFromId).toHaveBeenCalledTimes(1);
  });

  it('retries next pass when the note is not in the local store yet', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const row = publishRow('alice', 'recorded');
    await add(row);
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xreturn'], scannedTo: 1200 });
    mockInitiateFromId.mockRejectedValueOnce(new Error('Note with id 0xreturn not found'));

    await pass();
    const afterFirst = await publishInputsOf(row.id);
    expect(afterFirst.phase).toBe('recorded');
    expect(afterFirst.returnScanFrom).toBeUndefined();
    expect(info).toHaveBeenCalledWith('[miden-name] return note is not in the local store yet', {
      txId: row.id,
      noteId: '0xreturn'
    });

    await pass();
    expect((await publishInputsOf(row.id)).phase).toBe('returning');
    info.mockRestore();
  });

  it('logs an other queue error and stays recorded', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const row = publishRow('alice', 'recorded');
    await add(row);
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xreturn'], scannedTo: 1200 });
    mockInitiateFromId.mockRejectedValueOnce('locked');

    await pass();

    expect((await publishInputsOf(row.id)).phase).toBe('recorded');
    expect(warn).toHaveBeenCalledWith(
      '[miden-name] could not queue the return consume',
      expect.objectContaining({ txId: row.id, noteId: '0xreturn', error: 'locked' })
    );
    warn.mockRestore();
  });

  it('advances the scan cursor when the scan finds no return note, and scans from it next pass', async () => {
    const row = publishRow('alice', 'recorded');
    await add(row);
    mockFindDelivery.mockResolvedValue({ noteIds: [], scannedTo: 1200 });
    await pass();
    expect((await publishInputsOf(row.id)).returnScanFrom).toBe(1201);
    await pass();
    expect(mockFindDelivery).toHaveBeenLastCalledWith({ accountId: ACCOUNT, fromBlock: 1201, label: 'alice' });
  });

  it('does not move the cursor back when the scan covered no new block', async () => {
    const row = publishRow('alice', 'recorded', ITransactionStatus.Completed, { returnScanFrom: 1201 });
    await add(row);
    mockFindDelivery.mockResolvedValue({ noteIds: [], scannedTo: 1200 });
    await pass();
    expect((await publishInputsOf(row.id)).returnScanFrom).toBe(1201);
  });

  it('skips settled notes: a consume of an other publish, a live name claim and a live return of an other publish', async () => {
    const row = publishRow('alice', 'recorded');
    await add(
      row,
      consumeRow('done', '0xold', ITransactionStatus.Completed, {
        midenNameReturn: { label: 'alice', publishTxId: 'pub-old' }
      }),
      consumeRow('claim', '0xclaim', ITransactionStatus.Queued, {
        midenNameClaim: { label: 'bob', registerTxId: 'reg-bob' }
      }),
      consumeRow('theirs', '0xtheirs', ITransactionStatus.Queued, {
        midenNameReturn: { label: 'bob', publishTxId: 'pub-bob' }
      })
    );
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xold', '0xclaim', '0xtheirs', '0xnew'], scannedTo: 1200 });
    await pass();
    expect(mockInitiateFromId).toHaveBeenCalledTimes(1);
    expect(mockInitiateFromId).toHaveBeenCalledWith(ACCOUNT, '0xnew', true, false);
    expect((await publishInputsOf(row.id)).returnTxId).toBe('consume-1');
  });

  it('advances the cursor past notes that are all settled', async () => {
    const row = publishRow('alice', 'recorded');
    await add(
      row,
      consumeRow('done', '0xold', ITransactionStatus.Completed, {
        midenNameReturn: { label: 'alice', publishTxId: 'pub-old' }
      })
    );
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xold'], scannedTo: 1200 });
    await pass();
    expect(mockInitiateFromId).not.toHaveBeenCalled();
    expect((await publishInputsOf(row.id)).returnScanFrom).toBe(1201);
  });

  it('adopts a live untagged consume of the return note (the tag write was lost)', async () => {
    const row = publishRow('alice', 'recorded');
    await add(row, consumeRow('manual', '0xreturn', ITransactionStatus.GeneratingTransaction));
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xreturn'], scannedTo: 1200 });
    await pass();
    expect(mockInitiateFromId).not.toHaveBeenCalled();
    expect(await publishInputsOf(row.id)).toMatchObject({
      phase: 'returning',
      returnNoteId: '0xreturn',
      returnTxId: 'manual'
    });
    const returnRow = await Repo.transactions.where({ id: 'manual' }).first();
    expect(returnRow?.extraInputs).toEqual({ midenNameReturn: { label: 'alice', publishTxId: row.id } });
    expect(startProcessing).toHaveBeenCalledTimes(1);
  });

  it('adopts a Completed untagged consume of the return note: done, no new consume', async () => {
    const row = publishRow('alice', 'recorded');
    await add(row, consumeRow('lost-tag', '0xreturn', ITransactionStatus.Completed));
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xreturn'], scannedTo: 1200 });
    await pass();
    expect(mockInitiateFromId).not.toHaveBeenCalled();
    expect(startProcessing).not.toHaveBeenCalled();
    expect(await publishInputsOf(row.id)).toMatchObject({
      phase: 'done',
      returnNoteId: '0xreturn',
      returnTxId: 'lost-tag'
    });
  });

  it('adopts a live consume row that is already tagged for this publish', async () => {
    const row = publishRow('alice', 'recorded');
    await add(
      row,
      consumeRow('mine', '0xreturn', ITransactionStatus.Queued, {
        midenNameReturn: { label: 'alice', publishTxId: row.id }
      })
    );
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xreturn'], scannedTo: 1200 });
    await pass();
    expect(mockInitiateFromId).not.toHaveBeenCalled();
    expect(await publishInputsOf(row.id)).toMatchObject({ phase: 'returning', returnTxId: 'mine' });
    expect(startProcessing).toHaveBeenCalledTimes(1);
  });

  it('does not link a Failed row that the retry backoff gives back', async () => {
    const row = publishRow('alice', 'recorded');
    await add(row, consumeRow('failed-1', '0xreturn', ITransactionStatus.Failed));
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xreturn'], scannedTo: 1200 });
    mockInitiateFromId.mockResolvedValueOnce('failed-1');
    await pass();
    expect((await publishInputsOf(row.id)).phase).toBe('recorded');
    expect(startProcessing).not.toHaveBeenCalled();
  });

  it('does not link a row that the queue gives back when it does not exist', async () => {
    const row = publishRow('alice', 'recorded');
    await add(row);
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xreturn'], scannedTo: 1200 });
    mockInitiateFromId.mockResolvedValueOnce('missing');
    await pass();
    expect((await publishInputsOf(row.id)).phase).toBe('recorded');
  });

  it.each<[string, object]>([
    ['a claim of a registration', { midenNameClaim: { label: 'bob', registerTxId: 'reg-bob' } }],
    ['a return of an other publish', { midenNameReturn: { label: 'bob', publishTxId: 'pub-bob' } }]
  ])('does not take over a queued row that is %s', async (_name, extraInputs) => {
    const row = publishRow('alice', 'recorded');
    // The row is Failed for the note scan (so the note is free), but the queue
    // gives back an other live row that is linked to an other name row.
    await add(row, consumeRow('linked', '0xother-note', ITransactionStatus.Queued, extraInputs));
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xreturn'], scannedTo: 1200 });
    mockInitiateFromId.mockResolvedValueOnce('linked');
    await pass();
    expect((await publishInputsOf(row.id)).phase).toBe('recorded');
    expect(startProcessing).not.toHaveBeenCalled();
  });

  it('keeps the tag of a queued row that is already linked to this publish', async () => {
    const row = publishRow('alice', 'recorded');
    await add(
      row,
      consumeRow('mine', '0xother-note', ITransactionStatus.Queued, {
        midenNameReturn: { label: 'alice', publishTxId: row.id }
      })
    );
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xreturn'], scannedTo: 1200 });
    mockInitiateFromId.mockResolvedValueOnce('mine');
    await pass();
    expect(await publishInputsOf(row.id)).toMatchObject({ phase: 'returning', returnTxId: 'mine' });
  });

  it('a registration does not claim a note that a publish return has', async () => {
    const registration = registerRow('bob', 'issued');
    await add(
      registration,
      consumeRow('return', '0xreturn', ITransactionStatus.Queued, {
        midenNameReturn: { label: 'alice', publishTxId: 'pub-alice' }
      })
    );
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xreturn'], scannedTo: 1200 });
    await pass();
    expect(mockInitiateFromId).not.toHaveBeenCalled();
    expect((await inputsOf(registration.id)).phase).toBe('issued');
  });

  it('gives an issued registration and a recorded publish the notes of their own labels', async () => {
    const registration = registerRow('bob', 'issued');
    const publish = publishRow('alice', 'recorded');
    await add(registration, publish);
    mockFindDelivery.mockImplementation(async ({ label }) => ({
      noteIds: [label === 'bob' ? '0xd-bob' : '0xr-alice'],
      scannedTo: 1200
    }));
    await pass();
    expect((await inputsOf(registration.id)).deliveryNoteId).toBe('0xd-bob');
    expect((await publishInputsOf(publish.id)).returnNoteId).toBe('0xr-alice');
  });
});

describe('publish step 4: returning', () => {
  it('return row Completed → done', async () => {
    const row = publishRow('alice', 'returning', ITransactionStatus.Completed, { returnTxId: 'r1' });
    await add(row, consumeRow('r1', '0xreturn', ITransactionStatus.Completed));
    await pass();
    expect((await publishInputsOf(row.id)).phase).toBe('done');
  });

  it('return row Failed → back to recorded with lastError', async () => {
    const row = publishRow('alice', 'returning', ITransactionStatus.Completed, { returnTxId: 'r1' });
    const returnRow = consumeRow('r1', '0xreturn', ITransactionStatus.Failed);
    returnRow.error = 'prover down';
    await add(row, returnRow);
    await pass();
    expect(await publishInputsOf(row.id)).toMatchObject({ phase: 'recorded', lastError: 'prover down' });
  });

  it('return row Failed with no error → recorded with a default lastError', async () => {
    const row = publishRow('alice', 'returning', ITransactionStatus.Completed, { returnTxId: 'r1' });
    await add(row, consumeRow('r1', '0xreturn', ITransactionStatus.Failed));
    await pass();
    expect(await publishInputsOf(row.id)).toMatchObject({
      phase: 'recorded',
      lastError: 'The return transaction failed'
    });
  });

  it('queues a new return consume after a failed one', async () => {
    const row = publishRow('alice', 'returning', ITransactionStatus.Completed, {
      returnTxId: 'r1',
      returnNoteId: '0xreturn'
    });
    await add(row, consumeRow('r1', '0xreturn', ITransactionStatus.Failed));
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xreturn'], scannedTo: 1200 });

    await pass();
    expect((await publishInputsOf(row.id)).phase).toBe('recorded');

    await pass();
    expect(mockInitiateFromId).toHaveBeenCalledWith(ACCOUNT, '0xreturn', true, false);
    expect(await publishInputsOf(row.id)).toMatchObject({ phase: 'returning', returnTxId: 'consume-1' });
  });

  it('return row in progress → waits', async () => {
    const row = publishRow('alice', 'returning', ITransactionStatus.Completed, { returnTxId: 'r1' });
    await add(row, consumeRow('r1', '0xreturn', ITransactionStatus.GeneratingTransaction));
    await pass();
    expect((await publishInputsOf(row.id)).phase).toBe('returning');
  });

  it.each<[string, Partial<IPublishNameRecordExtraInputs>]>([
    ['no return row id', {}],
    ['a return row id with no row', { returnTxId: 'gone' }]
  ])('%s → recorded with a missing-row error', async (_name, extra) => {
    const row = publishRow('alice', 'returning', ITransactionStatus.Completed, extra);
    await add(row);
    await pass();
    expect(await publishInputsOf(row.id)).toMatchObject({
      phase: 'recorded',
      lastError: 'The return transaction is missing'
    });
  });
});

describe('publish row selection', () => {
  it('ignores backup, wrong-network and terminal publish rows', async () => {
    const backup = publishRow('backup', 'submitted');
    backup.restoredFromBackup = true;
    const devnet = publishRow('devnet', 'submitted', ITransactionStatus.Completed, { network: 'devnet' });
    await add(backup, devnet, publishRow('done', 'done'), publishRow('failed', 'failed'));
    await pass();
    expect(mockFetchState).not.toHaveBeenCalled();
    expect(mockFindDelivery).not.toHaveBeenCalled();
  });

  it('continues with the next row when a publish step throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = publishRow('bad', 'submitted');
    const good = registerRow('good', 'submitted');
    await add(bad, good);
    mockFetchState.mockImplementation(async noteId => {
      if (noteId === '0xregistry-bad') throw new Error('rpc down');
      return { status: 'consumed', attemptCount: 1 };
    });
    mockFetchIssued.mockResolvedValue(true);

    await pass();

    expect((await publishInputsOf(bad.id)).phase).toBe('submitted');
    expect((await inputsOf(good.id)).phase).toBe('issued');
    expect(warn).toHaveBeenCalledWith('[miden-name] tracker step failed', expect.objectContaining({ txId: bad.id }));
    warn.mockRestore();
  });
});

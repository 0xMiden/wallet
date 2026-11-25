import {
  IConsumeMidenNameExtraInputs,
  IMidenNameClaimLink,
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

const mockFetchDomainRecordAccount = jest.fn<Promise<string | null>, [string]>();
jest.mock('./resolver', () => ({
  fetchDomainRecordAccount: (label: string) => mockFetchDomainRecordAccount(label)
}));

const TERMINAL: MidenNamePhase[] = ['owned', 'failed'];

// Small copies of the monotonic helpers in complete.ts, on the real (fake-indexeddb) Dexie.
jest.mock('lib/miden/transaction/complete', () => ({
  patchRegisterNameExtraInputs: async (
    id: string,
    patch: Partial<IRegisterNameExtraInputs>,
    options: { expectPhase?: MidenNamePhase } = {}
  ): Promise<boolean> => {
    let written = false;
    await Repo.transactions.where({ id }).modify(tx => {
      const inputs: IRegisterNameExtraInputs | undefined = tx.extraInputs;
      if (tx.type !== 'register-name' || tx.restoredFromBackup || !inputs) return false;
      if (options.expectPhase !== undefined && inputs.phase !== options.expectPhase) return false;
      const next = patch.phase ?? inputs.phase;
      if (next !== inputs.phase && TERMINAL.includes(inputs.phase)) return false;
      tx.extraInputs = { ...inputs, ...patch, phase: next };
      written = true;
      return undefined;
    });
    return written;
  },
  promoteLandedRegisterNameRow: async (
    id: string,
    patch: Partial<IRegisterNameExtraInputs> = {},
    options: { expectPhase?: MidenNamePhase } = {}
  ): Promise<IRegisterNameExtraInputs | undefined> => {
    let written: IRegisterNameExtraInputs | undefined;
    await Repo.transactions.where({ id }).modify(tx => {
      const inputs: IRegisterNameExtraInputs | undefined = tx.extraInputs;
      if (tx.type !== 'register-name' || tx.restoredFromBackup || tx.status !== ITransactionStatus.Failed || !inputs) {
        return false;
      }
      if (options.expectPhase !== undefined && inputs.phase !== options.expectPhase) return false;
      const defaultPhase: MidenNamePhase = inputs.phase === 'requested' ? 'submitted' : inputs.phase;
      const next = patch.phase ?? defaultPhase;
      if (next !== inputs.phase && TERMINAL.includes(inputs.phase)) return false;
      const updated: IRegisterNameExtraInputs = { ...inputs, ...patch, phase: next };
      tx.extraInputs = updated;
      tx.status = ITransactionStatus.Completed;
      tx.stage = 'complete';
      tx.error = undefined;
      tx.rawError = undefined;
      tx.displayIcon = 'SEND';
      tx.displayMessage = 'Name requested';
      written = updated;
      return undefined;
    });
    return written;
  }
}));

const mockInitiateFromId = jest.fn<
  Promise<string>,
  [
    string,
    string,
    boolean | undefined,
    boolean | undefined,
    string | undefined,
    string | undefined,
    IMidenNameClaimLink | undefined
  ]
>();
jest.mock('lib/miden/transaction/initiate', () => ({
  initiateConsumeTransactionFromId: (
    accountId: string,
    noteId: string,
    delegate: boolean | undefined,
    manualRetry: boolean | undefined,
    dappOrigin?: string,
    entryPoint?: string,
    midenNameClaim?: IMidenNameClaimLink
  ) => mockInitiateFromId(accountId, noteId, delegate, manualRetry, dappOrigin, entryPoint, midenNameClaim),
  tagConsumeAsMidenNameClaim: async (
    txId: string,
    label: string,
    registerTxId: string,
    noteId?: string
  ): Promise<boolean> => {
    const link: IMidenNameClaimLink = { label, registerTxId };
    let tagged = false;
    await Repo.transactions.where({ id: txId }).modify(tx => {
      if (tx.type !== 'consume' || tx.restoredFromBackup) return false;
      const current: Partial<IConsumeMidenNameExtraInputs> & Record<string, unknown> = tx.extraInputs ?? {};
      if (noteId === undefined) {
        tx.extraInputs = { ...current, midenNameClaim: link };
        tagged = true;
        return undefined;
      }
      const normalized = noteId.toLowerCase();
      const existingClaims = current.midenNameClaims ?? {};
      if (existingClaims[normalized] && existingClaims[normalized]!.registerTxId !== registerTxId) return false;
      const isBatch = (tx.noteIds?.length ?? 0) > 1;
      if (isBatch) {
        tx.extraInputs = { ...current, midenNameClaims: { ...existingClaims, [normalized]: link } };
      } else {
        tx.extraInputs = {
          ...current,
          midenNameClaim: link,
          midenNameClaims: { ...existingClaims, [normalized]: link }
        };
      }
      tagged = true;
      return undefined;
    });
    return tagged;
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
  mockFetchDomainRecordAccount.mockResolvedValue(null);
  mockFindDelivery.mockImplementation(async ({ fromBlock }) => ({ noteIds: [], scannedTo: Math.max(fromBlock, 1200) }));
  mockInitiateFromId.mockImplementation(
    async (_accountId, noteId, _delegate, _manualRetry, _dappOrigin, _entryPoint, midenNameClaim) => {
      consumeSeq += 1;
      const id = `consume-${consumeSeq}`;
      const extraInputs = midenNameClaim
        ? { midenNameClaim, midenNameClaims: { [noteId.toLowerCase()]: midenNameClaim } }
        : undefined;
      await Repo.transactions.add(consumeRow(id, noteId, ITransactionStatus.Queued, extraInputs));
      return id;
    }
  );
});

describe('transition 1: register row Failed', () => {
  it('marks the registration failed / tx-failed with the row error after verifying unknown on chain', async () => {
    const row = registerRow('alice', 'requested', ITransactionStatus.Failed);
    row.mayHaveSubmitted = true;
    row.error = 'boom';
    await add(row);
    mockFetchState.mockResolvedValue({ status: 'unknown', attemptCount: 0 });
    await pass();
    expect(mockFetchState).toHaveBeenCalledWith('0xnote-alice');
    expect(mockFetchIssued).not.toHaveBeenCalled();
    expect(await inputsOf(row.id)).toMatchObject({ phase: 'failed', failure: 'tx-failed', lastError: 'boom' });
  });

  it('defers while the row is still awaiting a verdict', async () => {
    const row = registerRow('alice', 'requested', ITransactionStatus.Failed);
    row.error = 'offscreen abort';
    row.submitEvidence = [
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
    await add(row);
    await pass();
    expect(mockFetchState).not.toHaveBeenCalled();
    expect((await inputsOf(row.id)).phase).toBe('requested');
  });

  it('seals tx-failed immediately when neverCommittedAt is set', async () => {
    const row = registerRow('alice', 'requested', ITransactionStatus.Failed);
    row.error = 'never landed';
    row.neverCommittedAt = 1234;
    await add(row);
    await pass();
    expect(mockFetchState).not.toHaveBeenCalled();
    expect(await inputsOf(row.id)).toMatchObject({ phase: 'failed', failure: 'tx-failed', lastError: 'never landed' });
  });

  it('does nothing for a Queued row', async () => {
    const row = registerRow('alice', 'requested', ITransactionStatus.Queued);
    await add(row);
    await pass();
    expect((await inputsOf(row.id)).phase).toBe('requested');
    expect(mockFetchState).not.toHaveBeenCalled();
  });

  it('promotes a Failed row whose registration note was consumed and issued on chain', async () => {
    const row = registerRow('alice', 'requested', ITransactionStatus.Failed);
    row.mayHaveSubmitted = true;
    row.error = 'offscreen abort';
    await add(row);
    mockFetchState.mockResolvedValue({ status: 'consumed', attemptCount: 1 });
    mockFetchIssued.mockResolvedValue(true);
    await pass();
    expect(mockFetchState).toHaveBeenCalledTimes(1);
    expect((await inputsOf(row.id)).phase).toBe('issued');
    expect((await Repo.transactions.where({ id: row.id }).first())?.status).toBe(ITransactionStatus.Completed);
  });

  it('promotes a Failed row whose registration note is pending on chain to Completed + submitted', async () => {
    const row = registerRow('alice', 'requested', ITransactionStatus.Failed);
    row.mayHaveSubmitted = true;
    row.error = 'offscreen abort';
    await add(row);
    mockFetchState.mockResolvedValue({ status: 'pending', attemptCount: 0 });
    mockChainTip.mockResolvedValue(1200);
    await pass();
    expect(mockFetchState).toHaveBeenCalledTimes(1);
    expect((await inputsOf(row.id)).phase).toBe('submitted');
    const stored = await Repo.transactions.where({ id: row.id }).first();
    expect(stored?.status).toBe(ITransactionStatus.Completed);
    expect(stored?.error).toBeUndefined();
  });

  it('seals failed / taken for a Failed row whose note is inflight past reclaimHeight even if already owned', async () => {
    const row = registerRow('alice', 'requested', ITransactionStatus.Failed);
    row.mayHaveSubmitted = true;
    await add(row);
    mockFetchState.mockResolvedValue({ status: 'inflight', attemptCount: 1 });
    mockChainTip.mockResolvedValue(1301);
    mockFetchIssued.mockResolvedValue(true);
    mockFetchDomainRecordAccount.mockResolvedValue(ACCOUNT);
    await pass();
    expect(await inputsOf(row.id)).toMatchObject({ phase: 'failed', failure: 'taken' });
    expect((await Repo.transactions.where({ id: row.id }).first())?.status).toBe(ITransactionStatus.Completed);
  });

  it('seals discarded or taken on a Failed row with discarded note when not owned', async () => {
    const discarded = registerRow('alice', 'requested', ITransactionStatus.Failed);
    const taken = registerRow('bob', 'requested', ITransactionStatus.Failed);
    discarded.mayHaveSubmitted = true;
    taken.mayHaveSubmitted = true;
    await add(discarded, taken);
    mockFetchState.mockResolvedValue({ status: 'discarded', attemptCount: 2, lastError: 'bad' });
    mockFetchIssued.mockImplementation(async label => label === 'bob');
    mockFetchDomainRecordAccount.mockResolvedValue('mtst1someoneelse');
    await pass();
    expect(await inputsOf(discarded.id)).toMatchObject({ phase: 'failed', failure: 'discarded', lastError: 'bad' });
    expect(await inputsOf(taken.id)).toMatchObject({ phase: 'failed', failure: 'taken', lastError: 'bad' });
  });

  it('never promotes a Failed row when note is discarded or unknown even if the name is delivered or owned', async () => {
    const byOwner = registerRow('alice', 'requested', ITransactionStatus.Failed);
    const byDelivery = registerRow('bob', 'requested', ITransactionStatus.Failed);
    byOwner.mayHaveSubmitted = true;
    byDelivery.mayHaveSubmitted = true;
    byDelivery.error = 'unknown note';
    await add(byOwner, byDelivery);
    mockFetchState.mockImplementation(async noteId =>
      noteId === '0xnote-alice' ? { status: 'discarded', attemptCount: 1 } : { status: 'unknown', attemptCount: 0 }
    );
    mockFetchIssued.mockResolvedValue(true);
    mockFetchDomainRecordAccount.mockResolvedValue(ACCOUNT);
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xdelivery-bob'], scannedTo: 1200 });
    await pass();
    expect(await inputsOf(byOwner.id)).toMatchObject({ phase: 'failed', failure: 'taken' });
    expect(await inputsOf(byDelivery.id)).toMatchObject({
      phase: 'failed',
      failure: 'tx-failed',
      lastError: 'unknown note'
    });
    expect(mockFindDelivery).not.toHaveBeenCalled();
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

  it.each(['pending', 'inflight'] as const)(
    '%s after the reclaim height and not issued → failed / expired',
    async status => {
      const row = registerRow('alice', 'submitted');
      await add(row);
      mockFetchState.mockResolvedValue({ status, attemptCount: 0 });
      mockChainTip.mockResolvedValue(1301);
      await pass();
      expect(await inputsOf(row.id)).toMatchObject({ phase: 'failed', failure: 'expired' });
    }
  );

  it.each(['pending', 'inflight'] as const)(
    '%s after the reclaim height and issued to another → failed / taken',
    async status => {
      const row = registerRow('alice', 'submitted');
      await add(row);
      mockFetchState.mockResolvedValue({ status, attemptCount: 0 });
      mockChainTip.mockResolvedValue(1301);
      mockFetchIssued.mockResolvedValue(true);
      mockFetchDomainRecordAccount.mockResolvedValue('mtst1other');
      await pass();
      expect(await inputsOf(row.id)).toMatchObject({ phase: 'failed', failure: 'taken' });
    }
  );

  it.each(['pending', 'inflight'] as const)(
    '%s after the reclaim height and issued seals failed / taken even if delivered to this account',
    async status => {
      const row = registerRow('alice', 'submitted');
      await add(row);
      mockFetchState.mockResolvedValue({ status, attemptCount: 0 });
      mockChainTip.mockResolvedValue(1301);
      mockFetchIssued.mockResolvedValue(true);
      mockFindDelivery.mockResolvedValue({ noteIds: ['0xdelivery'], scannedTo: 1200 });
      await pass();
      expect(await inputsOf(row.id)).toMatchObject({ phase: 'failed', failure: 'taken' });
      expect(mockFindDelivery).not.toHaveBeenCalled();
    }
  );

  it('unknown after the reclaim height never expires and waits when not issued', async () => {
    const row = registerRow('alice', 'submitted');
    await add(row);
    mockFetchState.mockResolvedValue({ status: 'unknown', attemptCount: 0 });
    mockChainTip.mockResolvedValue(1301);
    await pass();
    expect((await inputsOf(row.id)).phase).toBe('submitted');
    expect(mockChainTip).not.toHaveBeenCalled();
  });

  it('unknown never promotes via ownership or delivery scan', async () => {
    const byOwner = registerRow('alice', 'submitted');
    const byDelivery = registerRow('bob', 'submitted');
    await add(byOwner, byDelivery);
    mockFetchState.mockResolvedValue({ status: 'unknown', attemptCount: 0 });
    mockFetchIssued.mockResolvedValue(true);
    mockFetchDomainRecordAccount.mockResolvedValue(ACCOUNT);
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xdelivery-bob'], scannedTo: 1200 });
    await pass();
    expect((await inputsOf(byOwner.id)).phase).toBe('submitted');
    expect((await inputsOf(byDelivery.id)).phase).toBe('submitted');
    expect(mockFetchIssued).not.toHaveBeenCalled();
    expect(mockFetchDomainRecordAccount).not.toHaveBeenCalled();
    expect(mockFindDelivery).not.toHaveBeenCalled();
  });

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
    expect(mockInitiateFromId).toHaveBeenCalledWith(ACCOUNT, '0xdelivery', true, false, undefined, undefined, {
      label: 'alice',
      registerTxId: row.id
    });
    const inputs = await inputsOf(row.id);
    expect(inputs).toMatchObject({ phase: 'claiming', deliveryNoteId: '0xdelivery', claimTxId: 'consume-1' });
    // The scan cursor does not move past a note that the tracker claims.
    expect(inputs.deliveryScanFrom).toBeUndefined();
    const claim = await Repo.transactions.where({ id: 'consume-1' }).first();
    expect(claim?.extraInputs).toEqual({
      midenNameClaim: { label: 'alice', registerTxId: row.id },
      midenNameClaims: { '0xdelivery': { label: 'alice', registerTxId: row.id } }
    });
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
    expect(mockInitiateFromId).toHaveBeenCalledWith(ACCOUNT, '0xnew', true, false, undefined, undefined, {
      label: 'alice',
      registerTxId: row.id
    });
  });

  it('does not count a Failed consume row as a claim', async () => {
    const row = registerRow('alice', 'issued');
    await add(row, consumeRow('failed-1', '0xdelivery', ITransactionStatus.Failed));
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xdelivery'], scannedTo: 1200 });
    await pass();
    expect(mockInitiateFromId).toHaveBeenCalledWith(ACCOUNT, '0xdelivery', true, false, undefined, undefined, {
      label: 'alice',
      registerTxId: row.id
    });
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

  it('adopts a Completed consume row already tagged for this registration straight to owned', async () => {
    const row = registerRow('alice', 'issued');
    await add(
      row,
      consumeRow('mine-done', '0xdelivery', ITransactionStatus.Completed, {
        midenNameClaim: { label: 'alice', registerTxId: row.id }
      })
    );
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xdelivery'], scannedTo: 1200 });
    await pass();
    expect(mockInitiateFromId).not.toHaveBeenCalled();
    expect(startProcessing).not.toHaveBeenCalled();
    expect(await inputsOf(row.id)).toMatchObject({
      phase: 'owned',
      deliveryNoteId: '0xdelivery',
      claimTxId: 'mine-done'
    });
  });

  it('prefers the Completed tagged consume over a live one of the same note', async () => {
    const row = registerRow('alice', 'issued');
    await add(
      row,
      consumeRow('mine-queued', '0xdelivery', ITransactionStatus.Queued, {
        midenNameClaim: { label: 'alice', registerTxId: row.id }
      }),
      consumeRow('mine-done', '0xdelivery', ITransactionStatus.Completed, {
        midenNameClaim: { label: 'alice', registerTxId: row.id }
      })
    );
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xdelivery'], scannedTo: 1200 });
    await pass();
    expect(mockInitiateFromId).not.toHaveBeenCalled();
    expect(startProcessing).not.toHaveBeenCalled();
    expect(await inputsOf(row.id)).toMatchObject({
      phase: 'owned',
      deliveryNoteId: '0xdelivery',
      claimTxId: 'mine-done'
    });
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
    expect(claim?.extraInputs).toEqual({
      midenNameClaim: { label: 'alice', registerTxId: row.id },
      midenNameClaims: { '0xdelivery': { label: 'alice', registerTxId: row.id } }
    });
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
    expect(claim?.extraInputs).toEqual({
      midenNameClaim: { label: 'alice', registerTxId: row.id },
      midenNameClaims: { '0xdelivery': { label: 'alice', registerTxId: row.id } }
    });
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
  it('queries Repo.transactions via the type index and ignores unrelated send rows', async () => {
    const sendRow: ITransaction = {
      id: 'send-1',
      type: 'send',
      accountId: ACCOUNT,
      status: ITransactionStatus.Completed,
      initiatedAt: 1,
      displayIcon: 'SEND'
    };
    const regRow = registerRow('alice', 'submitted');
    await add(sendRow, regRow);
    mockFetchState.mockResolvedValue({ status: 'consumed', attemptCount: 1 });
    mockFetchIssued.mockResolvedValue(true);

    const whereSpy = jest.spyOn(Repo.transactions, 'where');
    const filterSpy = jest.spyOn(Repo.transactions, 'filter');
    try {
      await pass();
      expect(whereSpy).toHaveBeenCalledWith('type');
      expect(filterSpy).not.toHaveBeenCalled();
    } finally {
      whereSpy.mockRestore();
      filterSpy.mockRestore();
    }

    expect(mockFetchState).toHaveBeenCalledTimes(1);
    expect(mockFetchState).toHaveBeenCalledWith('0xnote-alice');
    expect((await inputsOf(regRow.id)).phase).toBe('issued');
    expect((await Repo.transactions.where({ id: 'send-1' }).first())?.type).toBe('send');
  });

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

describe('C-2 regression guards', () => {
  it('seals a pre-submit Failed row as tx-failed without querying chain state or promoting', async () => {
    const row = registerRow('alice', 'requested', ITransactionStatus.Failed);
    row.error = 'MidenNameTakenError';
    await add(row);
    mockFetchState.mockResolvedValue({ status: 'unknown', attemptCount: 0 });
    mockFetchIssued.mockResolvedValue(true);
    mockFetchDomainRecordAccount.mockResolvedValue(ACCOUNT);
    await pass();
    expect(mockFetchState).not.toHaveBeenCalled();
    expect(await inputsOf(row.id)).toMatchObject({
      phase: 'failed',
      failure: 'tx-failed',
      lastError: 'MidenNameTakenError'
    });
  });

  it('never promotes a discarded or expired registration even when the account owns the name', async () => {
    const discarded = registerRow('alice', 'submitted');
    const expired = registerRow('bob', 'submitted');
    await add(discarded, expired);
    mockFetchState.mockImplementation(async noteId =>
      noteId === '0xnote-alice' ? { status: 'discarded', attemptCount: 1 } : { status: 'pending', attemptCount: 0 }
    );
    mockChainTip.mockResolvedValue(1301);
    mockFetchIssued.mockResolvedValue(true);
    mockFetchDomainRecordAccount.mockResolvedValue(ACCOUNT);
    await pass();
    expect(await inputsOf(discarded.id)).toMatchObject({ phase: 'failed', failure: 'taken' });
    expect(await inputsOf(expired.id)).toMatchObject({ phase: 'failed', failure: 'taken' });
  });

  it('checkRegisterNote consumed fails taken on foreign owner and expired when unissued past reclaimHeight', async () => {
    const taken = registerRow('alice', 'submitted');
    const expired = registerRow('bob', 'submitted');
    await add(taken, expired);
    mockFetchState.mockResolvedValue({ status: 'consumed', attemptCount: 1 });
    mockFetchIssued.mockImplementation(async label => label === 'alice');
    mockFetchDomainRecordAccount.mockResolvedValue('mtst1someoneelse');
    mockChainTip.mockResolvedValue(1301);
    await pass();
    expect(await inputsOf(taken.id)).toMatchObject({ phase: 'failed', failure: 'taken' });
    expect(await inputsOf(expired.id)).toMatchObject({ phase: 'failed', failure: 'expired' });
  });

  it('defers claiming while a Failed consume row is still awaiting a node verdict', async () => {
    const row = registerRow('alice', 'claiming', ITransactionStatus.Completed, {
      deliveryNoteId: '0xdelivery',
      claimTxId: 'c-verdict'
    });
    const claim = consumeRow('c-verdict', '0xdelivery', ITransactionStatus.Failed);
    claim.submitEvidence = [
      {
        attemptId: 'a1',
        capturedAt: 1,
        source: 'stage',
        transactionId: '0x1',
        initialCommitment: '0x2',
        finalCommitment: '0x3',
        initialNonce: '4',
        outputNoteIds: [],
        nullifiers: [],
        refBlock: 100,
        refBlockCommitment: '0x4'
      }
    ];
    await add(row, claim);
    await pass();
    expect((await inputsOf(row.id)).phase).toBe('claiming');
  });

  it('caps repeated claim failures and settles to failed / claim-failed', async () => {
    const row = registerRow('alice', 'claiming', ITransactionStatus.Completed, {
      deliveryNoteId: '0xdelivery',
      claimTxId: 'c1'
    });
    const c1 = consumeRow('c1', '0xdelivery', ITransactionStatus.Failed);
    c1.error = 'prover down';
    await add(row, c1);
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xdelivery'], scannedTo: 1200 });

    await pass();
    expect((await inputsOf(row.id)).phase).toBe('issued');

    await pass();
    expect((await inputsOf(row.id)).phase).toBe('claiming');
    await Repo.transactions.where({ id: 'consume-1' }).modify(tx => {
      tx.status = ITransactionStatus.Failed;
      tx.error = 'prover down 2';
    });
    await pass();
    await pass();
    await Repo.transactions.where({ id: 'consume-2' }).modify(tx => {
      tx.status = ITransactionStatus.Failed;
      tx.error = 'prover down 3';
    });
    await pass();
    expect(await inputsOf(row.id)).toMatchObject({
      phase: 'failed',
      failure: 'claim-failed',
      claimAttempts: 3,
      lastError: 'prover down 3'
    });
  });

  it('seals consumed registration as failed / taken when a sibling row already owns or claims the label', async () => {
    const sibling = registerRow('alice', 'claiming');
    const duplicate = registerRow('alice', 'submitted');
    await add(sibling, duplicate);
    mockFetchState.mockResolvedValue({ status: 'consumed', attemptCount: 1 });
    mockFetchIssued.mockResolvedValue(true);
    mockFetchDomainRecordAccount.mockResolvedValue(ACCOUNT);
    await pass();
    expect(await inputsOf(duplicate.id)).toMatchObject({ phase: 'failed', failure: 'taken' });
  });

  it('adopts multiple delivery notes inside one batch consume row via midenNameClaims', async () => {
    const alice = registerRow('alice', 'issued');
    const bob = registerRow('bob', 'issued');
    const batch: ITransaction = {
      id: 'batch-1',
      type: 'consume',
      accountId: ACCOUNT,
      noteId: '0xD-Alice',
      noteIds: ['0xD-Alice', '0xD-Bob'],
      status: ITransactionStatus.Completed,
      initiatedAt: 1,
      displayIcon: 'RECEIVE'
    };
    await add(alice, bob, batch);
    mockFindDelivery.mockImplementation(async ({ label }) => ({
      noteIds: [label === 'alice' ? '0xD-Alice' : '0xD-Bob'],
      scannedTo: 1200
    }));
    await pass();
    expect(mockInitiateFromId).not.toHaveBeenCalled();
    expect(await inputsOf(alice.id)).toMatchObject({
      phase: 'owned',
      deliveryNoteId: '0xD-Alice',
      claimTxId: 'batch-1'
    });
    expect(await inputsOf(bob.id)).toMatchObject({
      phase: 'owned',
      deliveryNoteId: '0xD-Bob',
      claimTxId: 'batch-1'
    });
    const storedBatch = await Repo.transactions.where({ id: 'batch-1' }).first();
    expect(storedBatch?.extraInputs).toEqual({
      midenNameClaims: {
        '0xd-alice': { label: 'alice', registerTxId: alice.id },
        '0xd-bob': { label: 'bob', registerTxId: bob.id }
      }
    });
  });

  it('shortcuts straight to owned when startClaim encounters an already-Completed consume row', async () => {
    const row = registerRow('alice', 'issued');
    await add(row);
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xdelivery'], scannedTo: 1200 });
    mockInitiateFromId.mockImplementationOnce(async (_acc, noteId, _del, _manual, _origin, _ep, claim) => {
      await Repo.transactions.add(
        consumeRow('done-claim', noteId, ITransactionStatus.Completed, {
          midenNameClaim: claim,
          midenNameClaims: { [noteId.toLowerCase()]: claim }
        })
      );
      return 'done-claim';
    });
    await pass();
    expect(startProcessing).not.toHaveBeenCalled();
    expect(await inputsOf(row.id)).toMatchObject({
      phase: 'owned',
      deliveryNoteId: '0xdelivery',
      claimTxId: 'done-claim'
    });
  });

  it('treats a Failed consume row awaiting verdict as live in deliveryNoteState', async () => {
    const row = registerRow('alice', 'issued');
    const claim = consumeRow('c-verdict', '0xdelivery', ITransactionStatus.Failed);
    claim.submitEvidence = [
      {
        attemptId: 'a1',
        capturedAt: 1,
        source: 'stage',
        transactionId: '0x1',
        initialCommitment: '0x2',
        finalCommitment: '0x3',
        initialNonce: '4',
        outputNoteIds: [],
        nullifiers: [],
        refBlock: 100,
        refBlockCommitment: '0x4'
      }
    ];
    await add(row, claim);
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xdelivery'], scannedTo: 1200 });
    await pass();
    expect(mockInitiateFromId).not.toHaveBeenCalled();
    expect(await inputsOf(row.id)).toMatchObject({
      phase: 'claiming',
      deliveryNoteId: '0xdelivery',
      claimTxId: 'c-verdict'
    });
  });

  it('reuses persisted deliveryNoteId without rescanning and falls back to scan if settled by another row', async () => {
    const reused = registerRow('alice', 'issued', ITransactionStatus.Completed, {
      deliveryNoteId: '0xknown-delivery'
    });
    await add(reused);
    await pass();
    expect(mockFindDelivery).not.toHaveBeenCalled();
    expect(mockInitiateFromId).toHaveBeenCalledWith(ACCOUNT, '0xknown-delivery', true, false, undefined, undefined, {
      label: 'alice',
      registerTxId: reused.id
    });

    const settledRow = registerRow('bob', 'issued', ITransactionStatus.Completed, {
      deliveryNoteId: '0xsettled-note'
    });
    await add(
      settledRow,
      consumeRow('other-claim', '0xsettled-note', ITransactionStatus.Queued, {
        midenNameClaim: { label: 'bob', registerTxId: 'other-reg' }
      })
    );
    mockFindDelivery.mockResolvedValue({ noteIds: ['0xsettled-note', '0xfresh-bob'], scannedTo: 1200 });
    await pass();
    expect(mockFindDelivery).toHaveBeenCalledWith({ accountId: ACCOUNT, fromBlock: 1000, label: 'bob' });
    expect(await inputsOf(settledRow.id)).toMatchObject({
      phase: 'claiming',
      deliveryNoteId: '0xfresh-bob'
    });
  });
});

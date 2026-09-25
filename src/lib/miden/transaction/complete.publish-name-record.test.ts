import { TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import {
  canMoveMidenNamePublishPhase,
  completePublishNameRecordTransaction,
  patchPublishNameRecordExtraInputs
} from './complete';
import { ITransaction, ITransactionStatus, MidenNamePublishPhase, PublishNameRecordTransaction } from '../db/types';
import { WasmClientPoisonedError } from '../sdk/wasm-client-poison';

const txStore: ITransaction[] = [];

jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: ({ id }: { id: string }) => ({
      modify: async (fn: (row: ITransaction) => void | false) => {
        const row = txStore.find(candidate => candidate.id === id);
        if (row) fn(row);
      },
      first: async () => txStore.find(candidate => candidate.id === id)
    })
  }
}));

jest.mock('../activity/fee', () => ({
  feeFieldsFromResult: () => ({}),
  splitExecutedOutputNotes: jest.fn()
}));

const mockSplit = jest.requireMock<{
  splitExecutedOutputNotes: jest.Mock<{ userNotes: { id: () => { toString: () => string } }[] }, [object]>;
}>('../activity/fee').splitExecutedOutputNotes;

jest.mock('@miden-sdk/miden-sdk/lazy', () => jest.requireActual('../../../../__mocks__/wasmMock.js'));

function publishRow(phase: MidenNamePublishPhase = 'requested'): PublishNameRecordTransaction {
  const row = new PublishNameRecordTransaction({
    accountId: 'acc-1',
    label: 'alice',
    network: 'testnet',
    registryAccountId: 'mtst1registry',
    nfaFaucetId: 'mtst1registry',
    requestBytes: new Uint8Array([1]),
    registryNoteId: '0xregistry-note',
    reclaimHeight: 1300,
    builtAtBlock: 1000,
    action: 3n
  });
  row.extraInputs.phase = phase;
  row.extraInputs.phaseUpdatedAt = 1;
  txStore.push(row);
  return row;
}

function storedRow(id: string): ITransaction | undefined {
  return txStore.find(row => row.id === id);
}

function storedPhase(id: string): MidenNamePublishPhase | undefined {
  const inputs: { phase?: MidenNamePublishPhase } | undefined = storedRow(id)?.extraInputs;
  return inputs?.phase;
}

const noteId = (id: string) => ({ id: () => ({ toString: () => id }) });

// A result shape that the completion reads. `TransactionResult` is a WASM
// class, so the test builds it through the mocked module's prototype.
function makeResult(): TransactionResult {
  return Object.assign(Object.create(TransactionResult), {
    executedTransaction: () => ({ id: () => ({ toHex: () => '0xtx' }) }),
    serialize: () => new Uint8Array([9])
  });
}

let warn: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  txStore.length = 0;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe('canMoveMidenNamePublishPhase', () => {
  it.each<[MidenNamePublishPhase, MidenNamePublishPhase, boolean]>([
    ['requested', 'submitted', true],
    ['submitted', 'recorded', true],
    ['recorded', 'returning', true],
    ['returning', 'done', true],
    ['requested', 'done', true],
    ['submitted', 'requested', false],
    ['recorded', 'submitted', false],
    ['returning', 'submitted', false],
    ['done', 'returning', false],
    ['done', 'failed', false],
    ['failed', 'submitted', false],
    ['failed', 'done', false],
    ['requested', 'failed', true],
    ['returning', 'failed', true],
    // The one move back: a failed return consume gets a new one.
    ['returning', 'recorded', true],
    ['recorded', 'recorded', true],
    ['done', 'done', true],
    ['failed', 'failed', true]
  ])('%s → %s is %s', (current, next, expected) => {
    expect(canMoveMidenNamePublishPhase(current, next)).toBe(expected);
  });
});

describe('patchPublishNameRecordExtraInputs', () => {
  it('moves the phase forward and stamps phaseUpdatedAt', async () => {
    const row = publishRow('submitted');
    await expect(patchPublishNameRecordExtraInputs(row.id, { phase: 'recorded' })).resolves.toBe(true);
    expect(storedPhase(row.id)).toBe('recorded');
    expect(row.extraInputs.phaseUpdatedAt).toBeGreaterThan(1);
  });

  it('moves returning back to recorded', async () => {
    const row = publishRow('returning');
    await expect(
      patchPublishNameRecordExtraInputs(row.id, { phase: 'recorded', lastError: 'x' }, { expectPhase: 'returning' })
    ).resolves.toBe(true);
    expect(row.extraInputs).toMatchObject({ phase: 'recorded', lastError: 'x' });
  });

  it('refuses to move the phase back', async () => {
    const row = publishRow('recorded');
    await expect(patchPublishNameRecordExtraInputs(row.id, { phase: 'submitted' })).resolves.toBe(false);
    expect(storedPhase(row.id)).toBe('recorded');
  });

  it.each<MidenNamePublishPhase>(['done', 'failed'])('keeps %s terminal', async phase => {
    const row = publishRow(phase);
    await expect(patchPublishNameRecordExtraInputs(row.id, { phase: 'returning' })).resolves.toBe(false);
    expect(storedPhase(row.id)).toBe(phase);
  });

  it('refuses when expectPhase does not match', async () => {
    const row = publishRow('submitted');
    await expect(
      patchPublishNameRecordExtraInputs(row.id, { phase: 'recorded' }, { expectPhase: 'requested' })
    ).resolves.toBe(false);
    expect(storedPhase(row.id)).toBe('submitted');
  });

  it('refuses a row restored from a backup', async () => {
    const row = publishRow('submitted');
    txStore[0] = { ...row, restoredFromBackup: true };
    await expect(patchPublishNameRecordExtraInputs(row.id, { phase: 'recorded' })).resolves.toBe(false);
    expect(storedPhase(row.id)).toBe('submitted');
  });

  it('refuses a row of an other type', async () => {
    txStore.push({
      id: 'reg-1',
      type: 'register-name',
      accountId: 'acc-1',
      status: ITransactionStatus.Completed,
      initiatedAt: 1,
      displayIcon: 'SEND',
      extraInputs: { phase: 'submitted' }
    });
    await expect(patchPublishNameRecordExtraInputs('reg-1', { phase: 'recorded' })).resolves.toBe(false);
  });

  it('refuses a publish row with no extraInputs', async () => {
    txStore.push({
      id: 'pub-bare',
      type: 'publish-name-record',
      accountId: 'acc-1',
      status: ITransactionStatus.Completed,
      initiatedAt: 1,
      displayIcon: 'SEND'
    });
    await expect(patchPublishNameRecordExtraInputs('pub-bare', { phase: 'recorded' })).resolves.toBe(false);
  });

  it('refuses a missing row', async () => {
    await expect(patchPublishNameRecordExtraInputs('missing', { phase: 'recorded' })).resolves.toBe(false);
  });

  it('adds fields with no phase change and keeps phaseUpdatedAt', async () => {
    const row = publishRow('recorded');
    await expect(patchPublishNameRecordExtraInputs(row.id, { returnScanFrom: 1200 })).resolves.toBe(true);
    expect(row.extraInputs.returnScanFrom).toBe(1200);
    expect(row.extraInputs.phaseUpdatedAt).toBe(1);
  });
});

describe('completePublishNameRecordTransaction', () => {
  it('completes the row, puts the registry note id first and moves the phase to submitted', async () => {
    const row = publishRow('requested');
    row.status = ITransactionStatus.GeneratingTransaction;
    mockSplit.mockReturnValue({ userNotes: [noteId('0xsponsor'), noteId('0xregistry-note')] });

    await completePublishNameRecordTransaction(row, makeResult());

    const stored = storedRow(row.id);
    expect(stored?.status).toBe(ITransactionStatus.Completed);
    expect(stored?.displayMessage).toBe('Name published');
    expect(stored?.transactionId).toBe('0xtx');
    expect(stored?.outputNoteIds).toEqual(['0xregistry-note', '0xsponsor']);
    expect(stored?.resultBytes).toEqual(new Uint8Array([9]));
    expect(storedPhase(row.id)).toBe('submitted');
    expect(stored?.requestBytes).toEqual(new Uint8Array([1]));
    expect(warn).not.toHaveBeenCalled();
  });

  it('still completes when the output notes cannot be read', async () => {
    const row = publishRow('requested');
    mockSplit.mockImplementation(() => {
      throw new Error('no output notes');
    });

    await completePublishNameRecordTransaction(row, makeResult());

    const stored = storedRow(row.id);
    expect(stored?.status).toBe(ITransactionStatus.Completed);
    expect(stored?.outputNoteIds).toEqual([]);
    expect(storedPhase(row.id)).toBe('submitted');
    expect(warn).toHaveBeenCalledWith(
      '[miden-name] could not read the output notes of the publish transaction',
      expect.any(Error)
    );
  });

  it('throws an eviction and does not complete the row', async () => {
    const row = publishRow('requested');
    row.status = ITransactionStatus.GeneratingTransaction;
    mockSplit.mockImplementation(() => {
      throw new WasmClientPoisonedError('watchdog');
    });

    await expect(completePublishNameRecordTransaction(row, makeResult())).rejects.toBeInstanceOf(
      WasmClientPoisonedError
    );
    expect(storedRow(row.id)?.status).toBe(ITransactionStatus.GeneratingTransaction);
  });

  it('warns and keeps the order when no output note has the registry note id', async () => {
    const row = publishRow('requested');
    mockSplit.mockReturnValue({ userNotes: [noteId('0xa'), noteId('0xb')] });

    await completePublishNameRecordTransaction(row, makeResult());

    expect(storedRow(row.id)?.outputNoteIds).toEqual(['0xa', '0xb']);
    expect(warn).toHaveBeenCalledWith(
      '[miden-name] the executed transaction has no output note with the registry note id',
      expect.objectContaining({ txId: row.id, expectedNoteId: '0xregistry-note' })
    );
  });

  it('warns when the row has no registry note id', async () => {
    const bare: ITransaction = {
      id: 'pub-bare',
      type: 'publish-name-record',
      accountId: 'acc-1',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 1,
      displayIcon: 'SEND'
    };
    txStore.push(bare);
    mockSplit.mockReturnValue({ userNotes: [noteId('0xa')] });

    await completePublishNameRecordTransaction(bare, makeResult());

    const stored = storedRow('pub-bare');
    expect(stored?.status).toBe(ITransactionStatus.Completed);
    expect(stored?.outputNoteIds).toEqual(['0xa']);
    expect(stored?.extraInputs).toBeUndefined();
  });

  it('keeps a phase that the tracker already moved past submitted', async () => {
    const row = publishRow('recorded');
    mockSplit.mockReturnValue({ userNotes: [noteId('0xregistry-note')] });

    await completePublishNameRecordTransaction(row, makeResult());

    expect(storedRow(row.id)?.status).toBe(ITransactionStatus.Completed);
    expect(storedPhase(row.id)).toBe('recorded');
  });

  it('does not move the phase of a row restored from a backup', async () => {
    const row = publishRow('requested');
    txStore[0] = { ...row, restoredFromBackup: true };
    mockSplit.mockReturnValue({ userNotes: [noteId('0xregistry-note')] });

    await completePublishNameRecordTransaction(row, makeResult());

    expect(storedPhase(row.id)).toBe('requested');
  });
});

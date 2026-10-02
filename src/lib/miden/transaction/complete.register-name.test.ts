import { TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import { canMoveMidenNamePhase, completeRegisterNameTransaction, patchRegisterNameExtraInputs } from './complete';
import { ITransaction, ITransactionStatus, MidenNamePhase, RegisterNameTransaction } from '../db/types';

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

function registerRow(phase: MidenNamePhase = 'requested'): RegisterNameTransaction {
  const row = new RegisterNameTransaction({
    accountId: 'acc-1',
    label: 'alice',
    network: 'testnet',
    paymentFaucetId: 'mtst1miden',
    registryAccountId: 'mtst1registry',
    priceBaseUnits: 20_000_000n,
    networkFeeBaseUnits: 210n,
    requestBytes: new Uint8Array([1]),
    registrationNoteId: '0xnote',
    reclaimHeight: 1300,
    builtAtBlock: 1000
  });
  row.extraInputs.phase = phase;
  row.extraInputs.phaseUpdatedAt = 1;
  txStore.push(row);
  return row;
}

function storedPhase(id: string): MidenNamePhase | undefined {
  const inputs: { phase?: MidenNamePhase } | undefined = txStore.find(row => row.id === id)?.extraInputs;
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

beforeEach(() => {
  jest.clearAllMocks();
  txStore.length = 0;
});

describe('canMoveMidenNamePhase', () => {
  it.each<[MidenNamePhase, MidenNamePhase, boolean]>([
    ['requested', 'submitted', true],
    ['submitted', 'issued', true],
    ['issued', 'claiming', true],
    ['claiming', 'owned', true],
    ['requested', 'owned', true],
    ['submitted', 'requested', false],
    ['issued', 'submitted', false],
    ['owned', 'claiming', false],
    ['owned', 'failed', false],
    ['failed', 'submitted', false],
    ['failed', 'owned', false],
    ['requested', 'failed', true],
    ['claiming', 'failed', true],
    ['claiming', 'issued', true],
    ['issued', 'issued', true],
    ['failed', 'failed', true]
  ])('%s → %s is %s', (current, next, expected) => {
    expect(canMoveMidenNamePhase(current, next)).toBe(expected);
  });
});

describe('patchRegisterNameExtraInputs', () => {
  it('moves the phase forward and stamps phaseUpdatedAt', async () => {
    const row = registerRow('submitted');
    await expect(patchRegisterNameExtraInputs(row.id, { phase: 'issued' })).resolves.toBe(true);
    expect(storedPhase(row.id)).toBe('issued');
    expect(row.extraInputs.phaseUpdatedAt).toBeGreaterThan(1);
  });

  it('refuses to move the phase back', async () => {
    const row = registerRow('issued');
    await expect(patchRegisterNameExtraInputs(row.id, { phase: 'submitted' })).resolves.toBe(false);
    expect(storedPhase(row.id)).toBe('issued');
  });

  it('keeps failed terminal', async () => {
    const row = registerRow('failed');
    await expect(patchRegisterNameExtraInputs(row.id, { phase: 'owned' })).resolves.toBe(false);
    expect(storedPhase(row.id)).toBe('failed');
  });

  it('refuses when expectPhase does not match', async () => {
    const row = registerRow('submitted');
    await expect(patchRegisterNameExtraInputs(row.id, { phase: 'issued' }, { expectPhase: 'requested' })).resolves.toBe(
      false
    );
    expect(storedPhase(row.id)).toBe('submitted');
  });

  it('refuses a row restored from a backup', async () => {
    const row = registerRow('submitted');
    txStore[0] = { ...row, restoredFromBackup: true };
    await expect(patchRegisterNameExtraInputs(row.id, { phase: 'issued' })).resolves.toBe(false);
    expect(storedPhase(row.id)).toBe('submitted');
  });

  it('refuses a row of an other type', async () => {
    txStore.push({
      id: 'consume-1',
      type: 'consume',
      accountId: 'acc-1',
      status: ITransactionStatus.Completed,
      initiatedAt: 1,
      displayIcon: 'RECEIVE',
      extraInputs: { phase: 'submitted' }
    });
    await expect(patchRegisterNameExtraInputs('consume-1', { phase: 'issued' })).resolves.toBe(false);
  });

  it('adds fields with no phase change and keeps phaseUpdatedAt', async () => {
    const row = registerRow('issued');
    await expect(patchRegisterNameExtraInputs(row.id, { deliveryScanFrom: 1200 })).resolves.toBe(true);
    expect(row.extraInputs.deliveryScanFrom).toBe(1200);
    expect(row.extraInputs.phaseUpdatedAt).toBe(1);
  });
});

describe('completeRegisterNameTransaction', () => {
  it('completes the row, puts the registration note id first and moves the phase to submitted', async () => {
    const row = registerRow('requested');
    row.status = ITransactionStatus.GeneratingTransaction;
    mockSplit.mockReturnValue({ userNotes: [noteId('0xsponsor'), noteId('0xnote')] });

    await completeRegisterNameTransaction(row, makeResult());

    const stored = txStore.find(candidate => candidate.id === row.id);
    expect(stored?.status).toBe(ITransactionStatus.Completed);
    expect(stored?.displayMessage).toBe('Name requested');
    expect(stored?.transactionId).toBe('0xtx');
    expect(stored?.outputNoteIds).toEqual(['0xnote', '0xsponsor']);
    expect(storedPhase(row.id)).toBe('submitted');
    // The bytes stay on the row.
    expect(stored?.requestBytes).toEqual(new Uint8Array([1]));
  });

  it('still completes when the output notes cannot be read', async () => {
    const row = registerRow('requested');
    row.status = ITransactionStatus.GeneratingTransaction;
    mockSplit.mockImplementation(() => {
      throw new Error('no output notes');
    });

    await completeRegisterNameTransaction(row, makeResult());

    const stored = txStore.find(candidate => candidate.id === row.id);
    expect(stored?.status).toBe(ITransactionStatus.Completed);
    expect(stored?.outputNoteIds).toEqual([]);
    expect(storedPhase(row.id)).toBe('submitted');
  });
});

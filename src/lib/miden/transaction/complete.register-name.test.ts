import { TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import { signalTransactionCompleted } from 'lib/backup/adopt-signal';
import { reportOperation } from 'lib/telemetry/report-operation';

import {
  canMoveMidenNamePhase,
  completeRegisterNameTransaction,
  patchRegisterNameExtraInputs,
  promoteLandedRegisterNameRow
} from './complete';
import { forgetLandedCompletion, readLandedCompletion } from './landed-completion-reads';
import { TX_FEE_NOTE_TAG } from '../activity/fee-notes';
import { ITransaction, ITransactionStatus, MidenNamePhase, RegisterNameTransaction } from '../db/types';
import { canonicalFeeSponsorshipNoteId } from '../sdk/fee-sponsorship';

jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn() }));
jest.mock('lib/backup/adopt-signal', () => ({ signalTransactionCompleted: jest.fn() }));

const txStore: ITransaction[] = [];
let modifyPutCount = 0;

jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: ({ id }: { id: string }) => ({
      modify: async (fn: (row: ITransaction) => void | false) => {
        const idx = txStore.findIndex(candidate => candidate.id === id);
        if (idx < 0) return;
        const clone = { ...txStore[idx]! };
        if (fn(clone) !== false) {
          modifyPutCount += 1;
          txStore[idx] = clone;
        }
      },
      first: async () => txStore.find(candidate => candidate.id === id)
    })
  }
}));

jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => 'mtst1native',
  getSdkSyncedNativeAssetIdSync: () => 'mtst1native',
  cacheScope: () => 'rpc|testnet',
  getVerificationBaseFeeSync: () => 7
}));

jest.mock('../sdk/helpers', () => ({
  getBech32AddressFromAccountId: (id: unknown) => String(id),
  canonicalWalletAccountId: (id: string) => id
}));

jest.mock('../sdk/fee-sponsorship', () => ({
  canonicalFeeSponsorshipNoteId: jest.fn(() => '0xsponsor')
}));

jest.mock('../activity/fee-notes', () => ({
  ...jest.requireActual('../activity/fee-notes'),
  splitLandedOutputNotes: jest.fn()
}));

type MockSplitNote = {
  id: () => { toString: () => string };
  metadata: () => { tag: () => { asU32: () => number }; noteType: () => number };
  assets: () => {
    fungibleAssets: () => { faucetId: () => string; amount: () => bigint }[];
    nonFungibleAssets: () => unknown[];
  };
};

const mockSplit = jest.requireMock<{
  splitLandedOutputNotes: jest.Mock<
    { feeNote?: MockSplitNote; userNotes: MockSplitNote[]; verificationFeeKnown: boolean },
    [object, string?]
  >;
}>('../activity/fee-notes').splitLandedOutputNotes;

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

const makeNote = (id: string, amount = 0n, faucetId = 'mtst1native', tag = 0): MockSplitNote => ({
  id: () => ({ toString: () => id }),
  metadata: () => ({ tag: () => ({ asU32: () => tag }), noteType: () => 0 }),
  assets: () => ({
    fungibleAssets: () => [{ faucetId: () => faucetId, amount: () => amount }],
    nonFungibleAssets: () => []
  })
});

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
  jest.mocked(canonicalFeeSponsorshipNoteId).mockReturnValue('0xsponsor');
  txStore.length = 0;
  modifyPutCount = 0;
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
    expect(txStore.find(candidate => candidate.id === row.id)?.extraInputs.phaseUpdatedAt).toBeGreaterThan(1);
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
    const stored = txStore.find(candidate => candidate.id === row.id);
    expect(stored?.extraInputs.deliveryScanFrom).toBe(1200);
    expect(stored?.extraInputs.phaseUpdatedAt).toBe(1);
  });

  it('returns false from .modify() on declined branches so Dexie skips re-putting', async () => {
    const issued = registerRow('issued');
    await expect(patchRegisterNameExtraInputs(issued.id, { phase: 'submitted' })).resolves.toBe(false);
    await expect(
      patchRegisterNameExtraInputs(issued.id, { phase: 'claiming' }, { expectPhase: 'submitted' })
    ).resolves.toBe(false);
    const backup: ITransaction = registerRow('submitted');
    backup.restoredFromBackup = true;
    await expect(patchRegisterNameExtraInputs(backup.id, { phase: 'issued' })).resolves.toBe(false);
    txStore.push({
      id: 'other-type',
      type: 'send',
      accountId: 'acc-1',
      status: ITransactionStatus.Completed,
      initiatedAt: 1,
      displayIcon: 'SEND'
    });
    await expect(patchRegisterNameExtraInputs('other-type', { phase: 'issued' })).resolves.toBe(false);
    const noInputs = registerRow('submitted');
    delete (noInputs as { extraInputs?: unknown }).extraInputs;
    await expect(patchRegisterNameExtraInputs(noInputs.id, { phase: 'issued' })).resolves.toBe(false);
    expect(modifyPutCount).toBe(0);
  });
});

describe('completeRegisterNameTransaction', () => {
  it('completes the row, puts the registration note id first, records companion feeAmount and moves the phase to submitted', async () => {
    const row = registerRow('requested');
    row.status = ITransactionStatus.GeneratingTransaction;
    mockSplit.mockReturnValue({
      feeNote: makeNote('0xfee', 119n, 'mtst1native', TX_FEE_NOTE_TAG),
      userNotes: [makeNote('0xsponsor', 210n, 'mtst1native'), makeNote('0xnote', 20_000_000n, 'mtst1miden')],
      verificationFeeKnown: true
    });
    const result = makeResult();
    readLandedCompletion(row, result);
    try {
      await completeRegisterNameTransaction(row, result);
    } finally {
      forgetLandedCompletion(result);
    }

    const stored = txStore.find(candidate => candidate.id === row.id);
    expect(stored?.status).toBe(ITransactionStatus.Completed);
    expect(stored?.displayMessage).toBe('Name requested');
    expect(stored?.transactionId).toBe('0xtx');
    expect(stored?.outputNoteIds).toEqual(['0xnote', '0xsponsor']);
    expect(stored?.feeAmount).toBe(329n);
    expect(stored?.feeFaucetId).toBe('mtst1native');
    expect(storedPhase(row.id)).toBe('submitted');
    // The bytes stay on the row.
    expect(stored?.requestBytes).toEqual(new Uint8Array([1]));
  });

  it('records the companion fee when completeRegisterNameTransaction runs without a prior tail read', async () => {
    const row = registerRow('requested');
    row.status = ITransactionStatus.GeneratingTransaction;
    mockSplit.mockReturnValue({
      feeNote: makeNote('0xfee', 119n, 'mtst1native', TX_FEE_NOTE_TAG),
      userNotes: [makeNote('0xsponsor', 210n, 'mtst1native'), makeNote('0xnote', 20_000_000n, 'mtst1miden')],
      verificationFeeKnown: true
    });

    await completeRegisterNameTransaction(row, makeResult());

    const stored = txStore.find(candidate => candidate.id === row.id);
    expect(stored?.feeAmount).toBe(329n);
    expect(stored?.feeFaucetId).toBe('mtst1native');
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

describe('promoteLandedRegisterNameRow', () => {
  it('atomically promotes a Failed row to Completed, advances requested → submitted, clears errors and reports landing', async () => {
    const row: ITransaction = registerRow('requested');
    row.status = ITransactionStatus.Failed;
    row.displayIcon = 'FAILED';
    row.error = 'offscreen abort';
    row.rawError = 'raw';

    const promoted = await promoteLandedRegisterNameRow(row.id);

    expect(promoted?.phase).toBe('submitted');
    expect(promoted?.phaseUpdatedAt).toBeGreaterThan(1);
    const stored = txStore.find(candidate => candidate.id === row.id);
    expect(stored?.status).toBe(ITransactionStatus.Completed);
    expect(stored?.stage).toBe('complete');
    expect(stored?.displayIcon).toBe('SEND');
    expect(stored?.displayMessage).toBe('Name requested');
    expect(stored?.error).toBeUndefined();
    expect(stored?.rawError).toBeUndefined();
    expect(stored?.completedAt).toBeGreaterThan(0);
    expect(storedPhase(row.id)).toBe('submitted');
    expect(reportOperation).toHaveBeenCalledWith({ operation: 'tx_other', result: 'completed' });
    expect(signalTransactionCompleted).toHaveBeenCalledTimes(1);
  });

  it('promotes an Unconfirmed row whose note landed to Completed and advances requested to submitted', async () => {
    const row: ITransaction = registerRow('requested');
    row.status = ITransactionStatus.Unconfirmed;

    const promoted = await promoteLandedRegisterNameRow(row.id);

    expect(promoted?.phase).toBe('submitted');
    expect(txStore.find(candidate => candidate.id === row.id)?.status).toBe(ITransactionStatus.Completed);
    expect(storedPhase(row.id)).toBe('submitted');
  });

  it('applies an explicit target phase in patch and preserves submitted phase when patch is empty', async () => {
    const requested = registerRow('requested');
    requested.status = ITransactionStatus.Failed;
    const issued = await promoteLandedRegisterNameRow(requested.id, { phase: 'issued' });
    expect(issued?.phase).toBe('issued');
    expect(storedPhase(requested.id)).toBe('issued');

    const submitted = registerRow('submitted');
    submitted.status = ITransactionStatus.Failed;
    const kept = await promoteLandedRegisterNameRow(submitted.id);
    expect(kept?.phase).toBe('submitted');
    expect(kept?.phaseUpdatedAt).toBe(1);
  });

  it('refuses Completed rows, mismatched expectPhase, backups, and other types without reporting', async () => {
    const completed = registerRow('submitted');
    completed.status = ITransactionStatus.Completed;
    await expect(promoteLandedRegisterNameRow(completed.id)).resolves.toBeUndefined();

    const wrongPhase = registerRow('requested');
    wrongPhase.status = ITransactionStatus.Failed;
    await expect(
      promoteLandedRegisterNameRow(wrongPhase.id, {}, { expectPhase: 'submitted' })
    ).resolves.toBeUndefined();

    const backup: ITransaction = registerRow('requested');
    backup.status = ITransactionStatus.Failed;
    backup.restoredFromBackup = true;
    await expect(promoteLandedRegisterNameRow(backup.id)).resolves.toBeUndefined();

    txStore.push({
      id: 'send-1',
      type: 'send',
      accountId: 'acc-1',
      status: ITransactionStatus.Failed,
      initiatedAt: 1,
      displayIcon: 'FAILED',
      extraInputs: { phase: 'requested' }
    });
    await expect(promoteLandedRegisterNameRow('send-1')).resolves.toBeUndefined();

    expect(reportOperation).not.toHaveBeenCalled();
    expect(signalTransactionCompleted).not.toHaveBeenCalled();
  });
});

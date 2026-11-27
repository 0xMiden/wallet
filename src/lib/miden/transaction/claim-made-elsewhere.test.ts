import { InputNoteState } from '@miden-sdk/miden-sdk/lazy';

import * as Repo from 'lib/miden/repo';
import { CONSUME_ENTRY_POINTS, type ConsumeEntryPoint } from 'lib/telemetry/transaction-failure';

import {
  claimNoteIdsOf,
  isRemovableClaim,
  notesConsumedOutsideClient,
  removeClaimMadeElsewhere
} from './claim-made-elsewhere';
import { type ISubmitEvidence, type ITransaction, ITransactionStatus } from '../db/types';

const mockGetInputNoteDetails = jest.fn();
jest.mock('../back/miden-client-proxy', () => ({
  midenClientProxy: {
    getInputNoteDetails: (...args: unknown[]) => mockGetInputNoteDetails(...args)
  }
}));

const mockLockOptions = jest.fn();
jest.mock('../sdk/miden-client', () => ({
  assertWasmHoldCurrent: jest.fn(),
  withWasmClientLock: async (run: (hold: object) => Promise<unknown>, options: unknown) => {
    mockLockOptions(options);
    return run({});
  }
}));

const evidence = (attemptId: string, extra: Partial<ISubmitEvidence> = {}): ISubmitEvidence => ({
  attemptId,
  capturedAt: 100,
  source: 'stage',
  ...extra
});

const claim = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'claim-1',
  type: 'consume',
  accountId: 'account-1',
  status: ITransactionStatus.GeneratingTransaction,
  initiatedAt: 100,
  displayIcon: 'RECEIVE',
  noteId: 'note-1',
  noteIds: ['note-1'],
  attemptId: 'attempt-1',
  consumeEntryPoint: 'auto_consume',
  ...overrides
});

beforeEach(async () => {
  jest.clearAllMocks();
  await Repo.transactions.clear();
});

const REMOVABLE: ConsumeEntryPoint[] = ['auto_consume', 'claim', 'claim_all', 'swap_settlement'];
const KEPT: ConsumeEntryPoint[] = ['dapp', 'bridge_reclaim', 'rotation_funding', 'arcade_gc_purchase'];

describe('isRemovableClaim', () => {
  it.each(REMOVABLE)('allows a %s claim', entryPoint => {
    expect(isRemovableClaim(claim({ consumeEntryPoint: entryPoint }))).toBe(true);
  });

  it.each(KEPT)('refuses a %s claim, whose caller reads the row after it ends', entryPoint => {
    expect(isRemovableClaim(claim({ consumeEntryPoint: entryPoint }))).toBe(false);
  });

  it('decides every entry point', () => {
    expect([...REMOVABLE, ...KEPT].sort()).toEqual([...CONSUME_ENTRY_POINTS].sort());
  });

  it('treats a row with no entry point as a claim', () => {
    expect(isRemovableClaim(claim({ consumeEntryPoint: undefined }))).toBe(true);
  });

  it('refuses another type, a rotation funding claim and a restored row', () => {
    expect(isRemovableClaim(claim({ type: 'send' }))).toBe(false);
    expect(isRemovableClaim(claim({ rotationFunding: true }))).toBe(false);
    expect(isRemovableClaim(claim({ restoredFromBackup: true }))).toBe(false);
  });
});

describe('claimNoteIdsOf', () => {
  it('reads the batch list, else the single note, else nothing', () => {
    expect(claimNoteIdsOf({ noteId: 'a', noteIds: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(claimNoteIdsOf({ noteId: 'a', noteIds: [] })).toEqual(['a']);
    expect(claimNoteIdsOf({ noteId: undefined, noteIds: undefined })).toEqual([]);
  });
});

describe('notesConsumedOutsideClient', () => {
  it('returns only the notes that a transaction outside this client consumed, in a bounded labelled hold', async () => {
    mockGetInputNoteDetails.mockResolvedValue([
      { noteId: 'external', state: InputNoteState.ConsumedExternal },
      { noteId: 'open', state: InputNoteState.Committed },
      { noteId: 'local', state: InputNoteState.ConsumedAuthenticatedLocal }
    ]);

    await expect(notesConsumedOutsideClient(['external', 'open', 'local'])).resolves.toEqual(['external']);
    expect(mockGetInputNoteDetails).toHaveBeenCalledWith({ ids: ['external', 'open', 'local'] }, expect.any(Function));
    expect(mockLockOptions).toHaveBeenCalledWith({ label: 'claim-made-elsewhere-notes', watchdogMs: 120_000 });
  });

  it('takes no hold for a row that names no note', async () => {
    await expect(notesConsumedOutsideClient([])).resolves.toEqual([]);
    expect(mockLockOptions).not.toHaveBeenCalled();
  });
});

describe('removeClaimMadeElsewhere', () => {
  it('removes the row of the attempt that runs it', async () => {
    await Repo.transactions.add(claim());

    await expect(removeClaimMadeElsewhere('claim-1', 'attempt-1')).resolves.toBe(true);
    expect(await Repo.transactions.get('claim-1')).toBeUndefined();
  });

  it.each<[string, Partial<ITransaction>]>([
    ['another attempt runs the row now', { attemptId: 'attempt-2' }],
    ['the row went back to the queue', { status: ITransactionStatus.Queued }],
    ['the row already ended', { status: ITransactionStatus.Completed }],
    ['the row may have submitted', { mayHaveSubmitted: true }],
    ['an earlier attempt of the row is not proven dead', { submitEvidence: [evidence('attempt-0')] }],
    ['a dApp waits for the row', { consumeEntryPoint: 'dapp' }]
  ])('keeps the row when %s', async (_name, overrides) => {
    const row = claim(overrides);
    await Repo.transactions.add(row);

    await expect(removeClaimMadeElsewhere('claim-1', 'attempt-1')).resolves.toBe(false);
    expect(await Repo.transactions.get('claim-1')).toEqual(row);
  });

  it('removes a row whose earlier attempts are all proven dead', async () => {
    await Repo.transactions.add(
      claim({
        submitEvidence: [
          evidence('attempt-0', { verdict: 'never-committed' }),
          evidence('attempt-00', { preSubmitEnd: true })
        ]
      })
    );

    await expect(removeClaimMadeElsewhere('claim-1', 'attempt-1')).resolves.toBe(true);
  });

  it('answers false for a row that is not there', async () => {
    await expect(removeClaimMadeElsewhere('missing', 'attempt-1')).resolves.toBe(false);
  });
});

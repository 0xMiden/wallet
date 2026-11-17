/**
 * Retry's landing on the transaction the node verified, for a dApp execute whose tail recorded nothing: the private
 * notes the verified transaction's stamp read are owed to the row's recipient, as at the reconciler's landing. Real
 * Dexie, the real producers, the reaper, Retry and the delivery sweep; only the node reads, the client's sync and
 * commit-state read, and the relay are faked.
 */
import { NoteType } from '@miden-sdk/miden-sdk/lazy';

import { __resetSyncFuseStateForTests } from 'lib/miden/front/sync-fuse';
import * as Repo from 'lib/miden/repo';

import { cancelStuckTransactions, MAX_WAIT_BEFORE_CANCEL } from './cancel';
import { TRANSACTION_STUCK_ERROR } from './constants';
import { noteDeliveryWriteCount, recordSubmitCrossing, setTransactionStage } from './helper';
import { __resetNoteDeliverySweepForTests, sweepNoteDeliveries } from './note-delivery-sweep';
import { AccountRead, NodeReads } from './reconcile-reads';
import { requeueFailedTransaction } from './retry';
import { ISubmitEvidence, ITransaction, ITransactionStatus } from '../db/types';
import type { TransactionCommitState } from '../sdk/miden-client-interface';
import { readSubmitEvidence } from '../sdk/submit-evidence';

const mockCreateReads = jest.fn();
jest.mock('./reconcile-reads', () => ({
  ...jest.requireActual('./reconcile-reads'),
  createNodeReads: () => mockCreateReads()
}));
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn() }));
jest.mock('lib/telemetry/transaction-failure', () => ({
  ...jest.requireActual('lib/telemetry/transaction-failure'),
  reportTransactionFailure: jest.fn()
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  isNoteTransportConfigured: () => true
}));
const mockSyncState = jest.fn<Promise<void>, []>();
const mockCommitState = jest.fn<Promise<TransactionCommitState>, [string]>();
const mockIsConsumed = jest.fn<Promise<boolean>, [string]>();
const mockRelayById = jest.fn<Promise<void>, [string, string]>();
jest.mock('../back/miden-client-proxy', () => ({
  ...jest.requireActual('../back/miden-client-proxy'),
  midenClientProxy: {
    syncState: () => mockSyncState(),
    getTransactionCommitState: (txId: string) => mockCommitState(txId),
    isOutputNoteConsumed: (noteId: string) => mockIsConsumed(noteId),
    relayPrivateNoteById: (noteId: string, to: string) => mockRelayById(noteId, to)
  }
}));

const NOW = Math.floor(Date.now() / 1000);
const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const HEADER = hex(1);
const LANDED_TX = hex(2);
const OTHER_TX = hex(3);
const INITIAL = hex(10);
const FINAL = hex(11);
const OWED = hex(0xabc20);
const PUBLIC_NOTE = hex(0xabc21);
const SIBLING_NOTE = hex(0xabc22);
const RECIPIENT = 'mtst1recipient';
/** The reaper fails a row once it ran this long; Retry is tapped a minute after. */
const REAPED_AT = NOW + MAX_WAIT_BEFORE_CANCEL + 60;
const TAP_AT = REAPED_AT + 60;

// The judgement's first read, the reference block's commitment, fails, so the tap-time check reads nothing; the
// client's commit-state read then names the transaction committed.
const blockCommitment = jest.fn(async (): Promise<string | undefined> => undefined);
const noteInclusions = jest.fn(async (): Promise<ReadonlyMap<string, number> | undefined> => undefined);
const account = jest.fn(async (): Promise<AccountRead> => ({ ok: false, pruned: false, timedOut: false }));
const nullifierHeight = jest.fn(async (): Promise<number | null | undefined> => undefined);
const NODE: NodeReads = { blockCommitment, account, noteInclusions, nullifierHeight };

const entry = (overrides: Partial<ISubmitEvidence> = {}): ISubmitEvidence => ({
  attemptId: 'a1',
  capturedAt: NOW - 60,
  source: 'stage',
  fromExecute: true,
  transactionId: LANDED_TX,
  initialCommitment: INITIAL,
  finalCommitment: FINAL,
  initialNonce: '5',
  outputNoteIds: [PUBLIC_NOTE, OWED],
  privateOutputNoteIds: [OWED],
  nullifiers: [],
  refBlock: 100,
  refBlockCommitment: HEADER,
  expirationBlock: 700,
  endedBy: 'out-of-band',
  endedAt: REAPED_AT,
  ...overrides
});

/**
 * A dApp execute to the recipient as attempt a1's pipeline left it after a landed tail failure: the landed record holds
 * the transaction id, and the Completed write after it never landed, so the row is still in progress.
 */
const landedInProgress = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'tx-1',
  type: 'execute',
  accountId: 'mtst1acct',
  secondaryAccountId: RECIPIENT,
  status: ITransactionStatus.GeneratingTransaction,
  initiatedAt: NOW - 120,
  processingStartedAt: NOW - 110,
  attemptId: 'a1',
  stage: 'proving',
  displayIcon: 'DEFAULT',
  requestBytes: new Uint8Array([0xca, 0xfe]),
  transactionId: LANDED_TX,
  ...overrides
});

/** The row the reaper failed, holding attempt a1's stamp. */
const reapedExecute = (overrides: Partial<ITransaction> = {}): ITransaction =>
  landedInProgress({
    status: ITransactionStatus.Failed,
    stage: 'submitting',
    error: TRANSACTION_STUCK_ERROR,
    displayMessage: 'Failed',
    displayIcon: 'FAILED',
    completedAt: REAPED_AT,
    submitEvidence: [entry()],
    ...overrides
  });

/** The executed transaction attempt a1's leaf read just before its submit: notes `outputs`, the private ones as such. */
const executed = (outputs: string[], privateNotes: string[]) => ({
  executedTransaction: () => ({
    id: () => ({ toHex: () => LANDED_TX }),
    initialAccountHeader: () => ({
      to_commitment: () => ({ toHex: () => INITIAL }),
      nonce: () => ({ asInt: () => 5n })
    }),
    finalAccountHeader: () => ({ to_commitment: () => ({ toHex: () => FINAL }), nonce: () => ({ asInt: () => 6n }) }),
    userOutputNotes: () =>
      outputs.map(noteId => ({
        id: () => ({ toString: () => noteId }),
        metadata: () => ({ noteType: () => (privateNotes.includes(noteId) ? NoteType.Private : NoteType.Public) })
      }))
  })
});
const proof = {
  nullifiers: () => [],
  refBlockNumber: () => 100,
  refBlockCommitment: () => ({ toHex: () => HEADER }),
  expirationBlockNumber: () => 700
};

const read = () => Repo.transactions.where({ id: 'tx-1' }).first();
const retryAt = async (atSeconds: number) => {
  jest.spyOn(Date, 'now').mockReturnValue(atSeconds * 1000);
  await requeueFailedTransaction('tx-1');
};

/** Two sweep passes from the stored rows alone, the second past the wait the first arms: the pushes they made. */
const pushesAfterTheFirstWait = async (from: number) => {
  __resetNoteDeliverySweepForTests();
  jest.spyOn(Date, 'now').mockReturnValue(from * 1000);
  await sweepNoteDeliveries();
  jest.spyOn(Date, 'now').mockReturnValue((from + 10 * 60) * 1000);
  await sweepNoteDeliveries();
  return mockRelayById.mock.calls;
};

beforeEach(async () => {
  jest.clearAllMocks();
  mockCreateReads.mockImplementation(async () => NODE);
  mockSyncState.mockResolvedValue(undefined);
  mockCommitState.mockResolvedValue('committed');
  mockIsConsumed.mockResolvedValue(false);
  mockRelayById.mockResolvedValue(undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  __resetNoteDeliverySweepForTests();
  __resetSyncFuseStateForTests();
  await Repo.transactions.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await Repo.transactions.clear();
});

describe("Retry's landing on the verified transaction of an execute whose tail recorded nothing", () => {
  // The landed record named the transaction, and the Completed write spent its budget, so the reaper failed the row.
  // The tap-time check reads nothing this tap; the client then names the transaction committed.
  it("owes the recipient its stamp's private notes, and the sweep pushes exactly those from the stored row", async () => {
    await Repo.transactions.put(landedInProgress());
    await recordSubmitCrossing(
      'tx-1',
      readSubmitEvidence(executed([PUBLIC_NOTE, OWED], [OWED]), proof, () => true),
      {
        attemptId: 'a1',
        fromExecute: true
      }
    );
    await setTransactionStage('tx-1', 'submitting');
    jest.spyOn(Date, 'now').mockReturnValue(REAPED_AT * 1000);
    await cancelStuckTransactions();
    const reaped = await read();
    expect(reaped).toMatchObject({
      status: ITransactionStatus.Failed,
      error: TRANSACTION_STUCK_ERROR,
      transactionId: LANDED_TX
    });
    expect(reaped?.relayNoteIds).toBeUndefined();
    expect(reaped?.noteDelivery).toBeUndefined();
    const writes = noteDeliveryWriteCount();

    await retryAt(TAP_AT);

    const row = await read();
    expect(row).toMatchObject({
      status: ITransactionStatus.Completed,
      transactionId: LANDED_TX,
      relayNoteIds: [OWED],
      relayRecipientId: RECIPIENT,
      noteDelivery: 'undelivered',
      displayMessage: 'Executed - a private note could not be delivered',
      completedAt: TAP_AT
    });
    expect(row?.error).toBeUndefined();
    expect(row?.outputNoteIds).toBeUndefined();
    expect(noteDeliveryWriteCount()).toBe(writes + 1);
    // The judgement stops at its first read; the verdict is the client's commit state after its sync.
    expect(blockCommitment).toHaveBeenCalledTimes(1);
    expect(noteInclusions).not.toHaveBeenCalled();
    expect(account).not.toHaveBeenCalled();
    expect(mockSyncState).toHaveBeenCalledTimes(1);
    expect(mockCommitState.mock.calls).toEqual([[LANDED_TX]]);

    expect(await pushesAfterTheFirstWait(TAP_AT)).toEqual([[OWED, RECIPIENT]]);
    expect(await read()).toMatchObject({ noteDelivery: 'relayed', relayAckedNoteIds: [OWED] });
  });

  // Read from the row as the write found it: the landed fields label an execute with a recipient as undelivered.
  it('a verified stamp that proves only public notes lands under the clean label and owes nothing', async () => {
    await Repo.transactions.put(
      reapedExecute({ submitEvidence: [entry({ outputNoteIds: [PUBLIC_NOTE], privateOutputNoteIds: [] })] })
    );
    const writes = noteDeliveryWriteCount();

    await retryAt(TAP_AT);

    const row = await read();
    expect(row).toMatchObject({ status: ITransactionStatus.Completed, displayMessage: 'Executed' });
    expect(row?.noteDelivery).toBeUndefined();
    expect(row?.relayNoteIds).toBeUndefined();
    expect(row?.relayRecipientId).toBeUndefined();
    expect(noteDeliveryWriteCount()).toBe(writes);
    expect(await pushesAfterTheFirstWait(TAP_AT)).toEqual([]);
  });

  // Attempt a2 replayed the request; only one of the two stamps names the transaction the node verified.
  it.each<[string, (other: ISubmitEvidence, verified: ISubmitEvidence) => ISubmitEvidence[]]>([
    ['a later', (other, verified) => [verified, other]],
    ['an earlier', (other, verified) => [other, verified]]
  ])('owes only the private notes of the verified transaction`s stamp, not %s attempt`s', async (_t, order) => {
    const stamps = order(
      entry({
        attemptId: 'other',
        transactionId: OTHER_TX,
        outputNoteIds: [SIBLING_NOTE],
        privateOutputNoteIds: [SIBLING_NOTE]
      }),
      entry({ attemptId: 'verified' })
    );
    await Repo.transactions.put(reapedExecute({ attemptId: stamps[1]?.attemptId, submitEvidence: stamps }));

    await retryAt(TAP_AT);

    expect(await read()).toMatchObject({
      status: ITransactionStatus.Completed,
      relayNoteIds: [OWED],
      relayRecipientId: RECIPIENT
    });
    expect(await pushesAfterTheFirstWait(TAP_AT)).toEqual([[OWED, RECIPIENT]]);
  });

  // An id stored in another case still names the same transaction.
  it('binds the stamp to the verified transaction however the row spells its id', async () => {
    await Repo.transactions.put(reapedExecute({ transactionId: `0x${LANDED_TX.slice(2).toUpperCase()}` }));

    await retryAt(TAP_AT);

    expect(await read()).toMatchObject({ status: ITransactionStatus.Completed, relayNoteIds: [OWED] });
  });

  it('owes nothing when no stamp names the verified transaction, and the row stays inert', async () => {
    await Repo.transactions.put(reapedExecute({ submitEvidence: [entry({ transactionId: OTHER_TX })] }));
    const writes = noteDeliveryWriteCount();

    await retryAt(TAP_AT);

    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Completed);
    expect(row?.relayNoteIds).toBeUndefined();
    expect(noteDeliveryWriteCount()).toBe(writes);
    expect(await pushesAfterTheFirstWait(TAP_AT)).toEqual([]);
  });

  it('a stamp that read no private list owes none of its notes, and the row stays inert', async () => {
    await Repo.transactions.put(reapedExecute({ submitEvidence: [entry({ privateOutputNoteIds: undefined })] }));
    const writes = noteDeliveryWriteCount();

    await retryAt(TAP_AT);

    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Completed);
    expect(row?.relayNoteIds).toBeUndefined();
    expect(row?.outputNoteIds).toBeUndefined();
    expect(noteDeliveryWriteCount()).toBe(writes);
    expect(await pushesAfterTheFirstWait(TAP_AT)).toEqual([]);
  });

  // A tail or a cancelled pipeline that recorded which notes it owes is the record the sweep reads.
  it('a row that already records the notes it owes keeps them, and the sweep pushes only those', async () => {
    await Repo.transactions.put(
      reapedExecute({ relayNoteIds: [SIBLING_NOTE], relayRecipientId: RECIPIENT, noteDelivery: 'undelivered' })
    );
    const writes = noteDeliveryWriteCount();

    await retryAt(TAP_AT);

    expect(await read()).toMatchObject({
      status: ITransactionStatus.Completed,
      relayNoteIds: [SIBLING_NOTE],
      noteDelivery: 'undelivered'
    });
    expect(noteDeliveryWriteCount()).toBe(writes);
    expect(await pushesAfterTheFirstWait(TAP_AT)).toEqual([[SIBLING_NOTE, RECIPIENT]]);
  });
});

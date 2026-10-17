// Real Dexie and the real sweep: the landed write and the sweep's selection meet only in the stored row (#1473).
import type { TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import { __resetSyncFuseStateForTests } from 'lib/miden/front/sync-fuse';
import * as Repo from 'lib/miden/repo';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import { NoteTypeEnum } from 'lib/miden/types';

import { completeSendTransaction } from './complete';
import { __resetNoteDeliverySweepForTests, MAX_RELAY_ATTEMPTS, sweepNoteDeliveries } from './note-delivery-sweep';
import { NodeReads } from './reconcile-reads';
import { judgeAndWrite } from './reconcile-unconfirmed';
import { ISubmitEvidence, ITransaction, ITransactionStatus, SendTransaction } from '../db/types';

jest.mock('../sdk/helpers', () => ({
  ...jest.requireActual('../sdk/helpers'),
  sameWalletAccountId: (a: string, b: string) => a.split('_')[0] === b.split('_')[0]
}));
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn() }));
jest.mock('lib/telemetry/transaction-failure', () => ({ reportTransactionFailure: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  isNoteTransportConfigured: () => true
}));

const mockIsConsumed = jest.fn<Promise<boolean>, [string]>();
const mockRelayById = jest.fn<Promise<void>, [string, string]>();
const mockSendPrivateNote = jest.fn<Promise<void>, [unknown, string]>();

jest.mock('../back/miden-client-proxy', () => ({
  ...jest.requireActual('../back/miden-client-proxy'),
  midenClientProxy: {
    isOutputNoteConsumed: (noteId: string) => mockIsConsumed(noteId),
    relayPrivateNoteById: (noteId: string, to: string) => mockRelayById(noteId, to),
    waitForTransactionCommit: async () => undefined,
    sendPrivateNote: (note: unknown, to: string) => mockSendPrivateNote(note, to)
  }
}));

const NOW = Math.floor(Date.now() / 1000);
const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const HEADER = hex(1);
const INITIAL = hex(10);
const FINAL = hex(11);
const TIP = hex(12);
const NULLIFIER = hex(30);
const NOTE = hex(0xabc20);
const OTHER_NOTE = hex(0xabc21);
const SIBLING_NOTE = hex(0xabc22);
const RECIPIENT = 'mtst1recipient';
const UNDELIVERED_SEND = 'Sent - the private note could not be delivered';
const TRANSPORT_DISABLED =
  'failed sending private output note: note transport error: note transport is disabled; ' +
  'enable it in the client configuration to send or receive notes via P2P';

const entry = (overrides: Partial<ISubmitEvidence> = {}): ISubmitEvidence => ({
  attemptId: 'a1',
  capturedAt: NOW - 60,
  source: 'stage',
  transactionId: hex(2),
  initialCommitment: INITIAL,
  finalCommitment: FINAL,
  initialNonce: '5',
  outputNoteIds: [NOTE],
  nullifiers: [],
  refBlock: 100,
  refBlockCommitment: HEADER,
  expirationBlock: 700,
  ...overrides
});

/** What the Guardian catch records for an attempt it keeps for the node's verdict. */
const KEPT: Partial<ISubmitEvidence> = { source: 'kill', candidateKept: true, guardianProposalNonce: 7 };

/** A Guardian private send the catch left Unconfirmed: its note id is only in the kept attempt's evidence. */
const keptSend = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'tx-1',
  type: 'send',
  accountId: 'mtst1acct_s',
  secondaryAccountId: RECIPIENT,
  status: ITransactionStatus.Unconfirmed,
  initiatedAt: NOW - 120,
  completedAt: NOW - 100,
  error: 'sdk said no definite outcome',
  mayHaveSubmitted: true,
  noteType: NoteTypeEnum.Private,
  displayIcon: 'SEND',
  submitEvidence: [entry(KEPT)],
  ...overrides
});

/**
 * A retried send: the earlier attempt's completion recorded its note at the root before its relay, the node proved
 * that attempt dead, and the retry's attempt is the kept one.
 */
const retriedSend = (overrides: Partial<ITransaction> = {}): ITransaction =>
  keptSend({
    noteDelivery: 'undelivered',
    outputNoteIds: [OTHER_NOTE],
    submitEvidence: [
      entry({ outputNoteIds: [OTHER_NOTE], verdict: 'never-committed' }),
      entry({ ...KEPT, attemptId: 'a2', capturedAt: NOW - 30, transactionId: hex(3) })
    ],
    ...overrides
  });

/** The note is on chain in the attempt's window and no other row names it. */
const noteOnChain: NodeReads = {
  blockCommitment: async () => HEADER,
  account: async () => ({ ok: true, state: { blockNum: 150, commitment: TIP } }),
  noteInclusions: async ids => new Map(ids.filter(id => id === NOTE).map((id): [string, number] => [id, 140])),
  nullifierHeight: async () => null
};

/** The input note is spent at 150, where the account reads the attempts' final commitment; no output note is seen. */
const spentAtFinal: NodeReads = {
  blockCommitment: async () => HEADER,
  account: async (_id, atBlock) => ({
    ok: true,
    state: atBlock === 150 ? { blockNum: 150, commitment: FINAL } : { blockNum: 160, commitment: TIP }
  }),
  noteInclusions: async () => new Map(),
  nullifierHeight: async () => 150
};

const land = (reads: NodeReads) => judgeAndWrite('tx-1', { node: reads, nowSec: NOW, cadenceMs: 3_000 });
const read = () => Repo.transactions.where({ id: 'tx-1' }).first();

/** Two sweep passes, the second past the wait the first arms: the pushes the sweep made. */
const pushesAfterTheFirstWait = async () => {
  await sweepNoteDeliveries();
  jest.spyOn(Date, 'now').mockReturnValue((NOW + 10 * 60) * 1000);
  await sweepNoteDeliveries();
  return mockRelayById.mock.calls;
};

interface Held<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/** A promise the test settles. Marked handled, so one rejected on a path that never awaited it stays quiet. */
const held = <T>(): Held<T> => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
};

/** Land the row while `running` waits at `reached`, then let it go on with `release` and finish. */
const landWhileWaiting = async (running: Promise<unknown>, reached: Promise<void>, release: () => void) => {
  try {
    await Promise.race([reached, running]);
    expect((await land(noteOnChain)).kind).toBe('landed');
  } finally {
    release();
    await running;
  }
};

/** Land the row while a sweep pass waits at `reached`, then let the pass go on with `release` and finish. */
const landWhileTheSweepWaits = (reached: Promise<void>, release: () => void) =>
  landWhileWaiting(sweepNoteDeliveries(), reached, release);

/** The row as the pipeline of a send to the recipient holds it. */
const sendOf = (row: ITransaction): SendTransaction => ({
  ...row,
  amount: 1n,
  faucetId: 'mtst1faucet',
  secondaryAccountId: RECIPIENT,
  noteType: NoteTypeEnum.Private,
  extraInputs: {}
});

/** What the SDK hands the completion of attempt a1 (`hex(2)`) when it sent the private note `noteId`. */
const sentNote = (noteId: string): TransactionResult => {
  const note = { id: () => ({ toString: () => noteId }) };
  const result: TransactionResult = Object.create(null);
  Object.assign(result, {
    executedTransaction: () => ({
      id: () => ({ toHex: () => hex(2) }),
      outputNotes: () => ({ notes: () => [{ intoFull: () => note }] })
    }),
    serialize: () => new Uint8Array([1])
  });
  return result;
};

/** Run attempt a1's completion of `row` for `noteId` and land the row while its relay waits, then resolve the relay. */
const landWhileTheRelayWaits = async (row: ITransaction, noteId: string) => {
  const reached = held<void>();
  const relay = held<void>();
  mockSendPrivateNote.mockImplementation(async () => {
    reached.resolve();
    await relay.promise;
  });
  await landWhileWaiting(completeSendTransaction(sendOf(row), sentNote(noteId)), reached.promise, () =>
    relay.resolve()
  );
};

beforeEach(async () => {
  jest.clearAllMocks();
  mockIsConsumed.mockResolvedValue(false);
  mockRelayById.mockResolvedValue(undefined);
  mockSendPrivateNote.mockResolvedValue(undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  __resetNoteDeliverySweepForTests();
  __resetSyncFuseStateForTests();
  await Repo.transactions.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('a send landed from its submit evidence owes the sweep its note (#1473)', () => {
  it('a Guardian private send landed from its kept candidate records the note at the root, and the sweep pushes it', async () => {
    await Repo.transactions.put(keptSend());

    expect((await land(noteOnChain)).kind).toBe('landed');
    expect(await read()).toMatchObject({
      status: ITransactionStatus.Completed,
      noteDelivery: 'undelivered',
      displayMessage: UNDELIVERED_SEND,
      outputNoteIds: [NOTE]
    });

    expect(await pushesAfterTheFirstWait()).toEqual([[NOTE, RECIPIENT]]);
    expect(await read()).toMatchObject({ noteDelivery: 'relayed', relayAckedNoteIds: [NOTE], displayMessage: 'Sent' });
  });

  // With nothing owed the sweep makes no query for up to an hour, unless a delivery write lands meanwhile.
  it('the landing wakes an idle sweep: its next call arms the note, and a call after the first wait pushes it', async () => {
    await sweepNoteDeliveries();
    await Repo.transactions.put(keptSend());

    expect((await land(noteOnChain)).kind).toBe('landed');
    await sweepNoteDeliveries();
    expect((await read())?.nextRelayAt).toBeDefined();
    expect(mockRelayById).not.toHaveBeenCalled();

    jest.spyOn(Date, 'now').mockReturnValue((NOW + 10 * 60) * 1000);
    await sweepNoteDeliveries();
    expect(mockRelayById.mock.calls).toEqual([[NOTE, RECIPIENT]]);
  });

  it('a retried attempt that lands replaces the note an earlier attempt left at the root, and that is the one pushed', async () => {
    await Repo.transactions.put(retriedSend());

    expect((await land(noteOnChain)).kind).toBe('landed');
    expect(await read()).toMatchObject({ transactionId: hex(3), outputNoteIds: [NOTE] });
    expect(await pushesAfterTheFirstWait()).toEqual([[NOTE, RECIPIENT]]);
  });

  it('the landed note does not inherit the spent attempts and stopped mark of the note it replaces', async () => {
    await Repo.transactions.put(
      retriedSend({ relayAttempts: MAX_RELAY_ATTEMPTS, nextRelayAt: NOW + 30 * 60, relayRetriesStopped: true })
    );

    expect((await land(noteOnChain)).kind).toBe('landed');
    expect((await read())?.relayRetriesStopped).toBeUndefined();
    expect(await pushesAfterTheFirstWait()).toEqual([[NOTE, RECIPIENT]]);
    expect((await read())?.relayRetriesStopped).toBeUndefined();
  });

  it('the landed note does not inherit the outcome, acknowledgements, dead notes, verification count or outage mark of the note it replaces', async () => {
    await Repo.transactions.put(
      retriedSend({
        noteDelivery: 'confirmed',
        displayMessage: 'Sent',
        relayAckedNoteIds: [OTHER_NOTE],
        relayDeadNoteIds: [OTHER_NOTE],
        relayVerifyPushes: 2,
        relayOutageDeferred: true
      })
    );

    expect((await land(noteOnChain)).kind).toBe('landed');
    const row = await read();
    expect(row).toMatchObject({ noteDelivery: 'undelivered', displayMessage: UNDELIVERED_SEND, outputNoteIds: [NOTE] });
    expect(row?.relayAckedNoteIds).toBeUndefined();
    expect(row?.relayDeadNoteIds).toBeUndefined();
    expect(row?.relayVerifyPushes).toBeUndefined();
    expect(row?.relayOutageDeferred).toBeUndefined();

    expect(await pushesAfterTheFirstWait()).toEqual([[NOTE, RECIPIENT]]);
    expect((await read())?.relayAckedNoteIds).toEqual([NOTE]);

    // The acknowledgement arms the first verification push 5 minutes on; the replaced note's count would skip it.
    jest.spyOn(Date, 'now').mockReturnValue((NOW + 20 * 60) * 1000);
    await sweepNoteDeliveries();
    expect(mockRelayById.mock.calls).toEqual([
      [NOTE, RECIPIENT],
      [NOTE, RECIPIENT]
    ]);
    expect((await read())?.relayVerifyPushes).toBe(1);
  });

  // An outage mark makes a row due as soon as a push earlier in the same pass succeeds.
  it("the replaced note's outage mark does not pull the landed note forward when another row's push succeeds", async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
    await Repo.transactions.put(retriedSend({ relayOutageDeferred: true }));
    await Repo.transactions.put({
      id: 'tx-2',
      type: 'send',
      accountId: 'mtst1sibling_s',
      secondaryAccountId: RECIPIENT,
      status: ITransactionStatus.Completed,
      initiatedAt: NOW - 320,
      completedAt: NOW - 300,
      noteType: NoteTypeEnum.Private,
      noteDelivery: 'undelivered',
      outputNoteIds: [SIBLING_NOTE],
      relayAttempts: 1,
      nextRelayAt: NOW + 60,
      displayMessage: UNDELIVERED_SEND,
      displayIcon: 'SEND'
    });

    expect((await land(noteOnChain)).kind).toBe('landed');
    expect((await read())?.relayOutageDeferred).toBeUndefined();
    await sweepNoteDeliveries();
    expect((await read())?.nextRelayAt).toBe(NOW + 5 * 60);

    jest.spyOn(Date, 'now').mockReturnValue((NOW + 2 * 60) * 1000);
    await sweepNoteDeliveries();
    expect(mockRelayById.mock.calls).toEqual([[SIBLING_NOTE, RECIPIENT]]);
    expect((await read())?.nextRelayAt).toBe(NOW + 5 * 60);
  });

  it('a landing that keeps the note at the root keeps its relayed outcome, acknowledgements and marks', async () => {
    await Repo.transactions.put(
      keptSend({
        noteDelivery: 'relayed',
        displayMessage: 'Sent',
        outputNoteIds: [NOTE],
        relayAckedNoteIds: [NOTE],
        relayVerifyPushes: 1,
        relayOutageDeferred: true
      })
    );

    expect((await land(noteOnChain)).kind).toBe('landed');
    expect(await read()).toMatchObject({
      status: ITransactionStatus.Completed,
      noteDelivery: 'relayed',
      displayMessage: 'Sent',
      outputNoteIds: [NOTE],
      relayAckedNoteIds: [NOTE],
      relayVerifyPushes: 1,
      relayOutageDeferred: true,
      completedAt: NOW - 100
    });
  });

  // A cancelled pipeline runs on and relays (#1233): on an empty root what it recorded is the relay's own.
  it('a landing that records its note on an empty root keeps the recorded outcome, label and acknowledgements', async () => {
    await Repo.transactions.put(
      keptSend({
        noteDelivery: 'relayed',
        displayMessage: 'Sent',
        relayAckedNoteIds: [NOTE],
        relayVerifyPushes: 1,
        relayOutageDeferred: true,
        relayAttempts: MAX_RELAY_ATTEMPTS,
        nextRelayAt: NOW + 30 * 60,
        relayRetriesStopped: true
      })
    );

    expect((await land(noteOnChain)).kind).toBe('landed');
    const row = await read();
    expect(row).toMatchObject({
      status: ITransactionStatus.Completed,
      outputNoteIds: [NOTE],
      noteDelivery: 'relayed',
      displayMessage: 'Sent',
      relayAckedNoteIds: [NOTE],
      relayVerifyPushes: 1,
      relayOutageDeferred: true
    });
    expect(row?.relayAttempts).toBeUndefined();
    expect(row?.nextRelayAt).toBeUndefined();
    expect(row?.relayRetriesStopped).toBeUndefined();
  });

  // A custom transaction read as a send keeps its relay's own target in relayNoteIds, which the sweep reads first.
  it('a row whose relay recorded the notes it owes keeps them, and its delivery state, when another note lands', async () => {
    await Repo.transactions.put(
      keptSend({
        noteDelivery: 'relayed',
        displayMessage: 'Sent',
        outputNoteIds: [OTHER_NOTE],
        relayNoteIds: [OTHER_NOTE],
        relayRecipientId: RECIPIENT,
        relayAckedNoteIds: [OTHER_NOTE]
      })
    );

    expect((await land(noteOnChain)).kind).toBe('landed');
    expect(await read()).toMatchObject({
      status: ITransactionStatus.Completed,
      outputNoteIds: [OTHER_NOTE],
      noteDelivery: 'relayed',
      displayMessage: 'Sent',
      relayAckedNoteIds: [OTHER_NOTE]
    });
    expect(await pushesAfterTheFirstWait()).toEqual([[OTHER_NOTE, RECIPIENT]]);
  });

  // The sweep ages its 72 h retry window from completedAt, which the Unconfirmed write stamped.
  it('a send that lands three days after it left the queue gets its delivery window from the landing', async () => {
    const leftQueue = NOW - 73 * 60 * 60;
    await Repo.transactions.put(
      keptSend({
        initiatedAt: leftQueue - 20,
        completedAt: leftQueue,
        submitEvidence: [entry({ ...KEPT, capturedAt: leftQueue - 10 })]
      })
    );
    jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);

    expect((await land(noteOnChain)).kind).toBe('landed');
    expect((await read())?.completedAt).toBe(NOW);
    expect(await pushesAfterTheFirstWait()).toEqual([[NOTE, RECIPIENT]]);
    expect((await read())?.relayRetriesStopped).toBeUndefined();
  });

  it('two attempts that replayed one request name the same note: the landing binds neither and records that note', async () => {
    await Repo.transactions.put(
      keptSend({
        submitEvidence: [entry(KEPT), entry({ attemptId: 'a2', capturedAt: NOW - 30, transactionId: hex(3) })]
      })
    );

    expect((await land(noteOnChain)).kind).toBe('landed');
    const row = await read();
    expect(row?.transactionId).toBeUndefined();
    expect(row?.outputNoteIds).toEqual([NOTE]);
  });

  it('a public send owes no delivery: nothing is recorded for the sweep and nothing is pushed', async () => {
    await Repo.transactions.put(keptSend({ noteType: NoteTypeEnum.Public }));

    expect((await land(noteOnChain)).kind).toBe('landed');
    const row = await read();
    expect(row).toMatchObject({ status: ITransactionStatus.Completed, displayMessage: 'Sent' });
    expect(row?.noteDelivery).toBeUndefined();
    expect(row?.outputNoteIds).toBeUndefined();
    expect(await pushesAfterTheFirstWait()).toEqual([]);
  });

  // Its evidence lists public and private notes alike, and its recipient field can hold a consumed note's sender.
  it('an execute gets no note from its evidence, so the sweep pushes none of its notes', async () => {
    await Repo.transactions.put(
      keptSend({ type: 'execute', displayIcon: 'DEFAULT', submitEvidence: [entry({ ...KEPT, fromExecute: true })] })
    );

    expect((await land(noteOnChain)).kind).toBe('landed');
    const row = await read();
    expect(row?.noteDelivery).toBe('undelivered');
    expect(row?.outputNoteIds).toBeUndefined();
    expect(row?.relayNoteIds).toBeUndefined();
    expect(await pushesAfterTheFirstWait()).toEqual([]);
  });

  it('a spend that two attempts with different notes share cannot say which landed: no note is recorded', async () => {
    const spending = { nullifiers: [NULLIFIER] };
    await Repo.transactions.put(
      keptSend({
        submitEvidence: [
          entry({ ...KEPT, ...spending }),
          entry({
            ...spending,
            attemptId: 'a2',
            capturedAt: NOW - 30,
            transactionId: hex(3),
            outputNoteIds: [OTHER_NOTE]
          })
        ]
      })
    );

    expect((await land(spentAtFinal)).kind).toBe('landed');
    const row = await read();
    expect(row?.noteDelivery).toBe('undelivered');
    expect(row?.outputNoteIds).toBeUndefined();
  });

  // `completeSendTransaction` records its note before its relay; a cancelled pipeline runs on and does so.
  it('a note the normal completion already recorded stays as it wrote it, and is the one the sweep pushes', async () => {
    const recorded = `0x${NOTE.slice(2).toUpperCase()}`;
    await Repo.transactions.put(
      keptSend({
        status: ITransactionStatus.Failed,
        noteDelivery: 'undelivered',
        outputNoteIds: [recorded],
        submitEvidence: [entry({ source: 'out-of-band', endedBy: 'out-of-band', endedAt: NOW - 90 })]
      })
    );

    expect((await land(noteOnChain)).kind).toBe('landed');
    expect(await read()).toMatchObject({
      status: ITransactionStatus.Completed,
      outputNoteIds: [recorded],
      completedAt: NOW - 100
    });
    expect(await pushesAfterTheFirstWait()).toEqual([[recorded, RECIPIENT]]);
  });

  // The sweep reads the row before its push: the push's outcome is the replaced note's, not the landed one's.
  it.each<[string, (push: Held<void>) => void]>([
    ['is acknowledged', push => push.resolve()],
    ['is interrupted', push => push.reject(new WasmClientPoisonedError('watchdog', new Error('push parked')))],
    ['finds the transport disabled', push => push.reject(new Error(TRANSPORT_DISABLED))]
  ])(
    'a push of the replaced note that %s while the send lands writes nothing onto the landed note',
    async (_outcome, end) => {
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      await Repo.transactions.put(retriedSend({ relayAttempts: MAX_RELAY_ATTEMPTS - 1, nextRelayAt: NOW - 1 }));
      const reached = held<void>();
      const push = held<void>();
      mockRelayById.mockImplementation(async noteId => {
        if (noteId !== OTHER_NOTE) return;
        reached.resolve();
        await push.promise;
      });

      await landWhileTheSweepWaits(reached.promise, () => end(push));

      expect(mockRelayById.mock.calls).toEqual([[OTHER_NOTE, RECIPIENT]]);
      const row = await read();
      expect(row).toMatchObject({ outputNoteIds: [NOTE], noteDelivery: 'undelivered' });
      expect(row?.relayAttempts).toBeUndefined();
      expect(row?.nextRelayAt).toBeUndefined();
      expect(row?.relayRetriesStopped).toBeUndefined();
      expect(row?.relayAckedNoteIds).toBeUndefined();

      mockRelayById.mockClear();
      expect(await pushesAfterTheFirstWait()).toEqual([[NOTE, RECIPIENT]]);
    }
  );

  it('a receipt of the replaced note that reads consumed while the send lands does not confirm the landed note', async () => {
    await Repo.transactions.put(retriedSend({ nextRelayAt: NOW - 1 }));
    const reached = held<void>();
    const receipt = held<boolean>();
    mockIsConsumed.mockImplementation(async noteId => {
      if (noteId !== OTHER_NOTE) return false;
      reached.resolve();
      return receipt.promise;
    });

    await landWhileTheSweepWaits(reached.promise, () => receipt.resolve(true));

    expect(mockIsConsumed).toHaveBeenCalledWith(OTHER_NOTE);
    expect((await read())?.noteDelivery).toBe('undelivered');
    expect(await pushesAfterTheFirstWait()).toEqual([[NOTE, RECIPIENT]]);
  });

  // A completion past its liveness window relays on (#1233); once the send lands, only its write after the relay lands.
  it("a completion's relay of the replaced note that is acknowledged after the send lands writes nothing onto the landed note", async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const row = retriedSend();
    await Repo.transactions.put(row);

    await landWhileTheRelayWaits(row, OTHER_NOTE);

    expect(mockSendPrivateNote).toHaveBeenCalledTimes(1);
    const landed = await read();
    expect(landed).toMatchObject({
      status: ITransactionStatus.Completed,
      outputNoteIds: [NOTE],
      noteDelivery: 'undelivered',
      displayMessage: UNDELIVERED_SEND
    });
    expect(landed?.relayAckedNoteIds).toBeUndefined();
    expect(await pushesAfterTheFirstWait()).toEqual([[NOTE, RECIPIENT]]);
  });

  it("a completion's relay of the note the send lands with records it relayed and acknowledged after the landing", async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const row = keptSend();
    await Repo.transactions.put(row);

    await landWhileTheRelayWaits(row, NOTE);

    expect(mockSendPrivateNote).toHaveBeenCalledTimes(1);
    expect(await read()).toMatchObject({
      status: ITransactionStatus.Completed,
      outputNoteIds: [NOTE],
      noteDelivery: 'relayed',
      displayMessage: 'Sent',
      relayAckedNoteIds: [NOTE]
    });
  });
});

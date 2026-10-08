/**
 * Tests for the private-note delivery sweep: when it pushes again, when it stops,
 * and how it reads each outcome.
 *
 * A relay acknowledgement may insert a missing note or acknowledge an existing one.
 * Neither outcome proves receipt by the recipient. So the row must be neither condemned
 * as `undelivered` nor promoted to `confirmed`. `note-delivery-sweep.ts` has the why.
 */

import { OperationAbortedError } from 'lib/miden/back/offscreen-codec';
import {
  __resetSyncFuseStateForTests,
  clearSyncFuseForEndpointChange,
  isSyncFused,
  noteSyncWatchdogEviction
} from 'lib/miden/front/sync-fuse';
import * as Repo from 'lib/miden/repo';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import {
  FUSED_SYNC_PROBE_INTERVAL_MS,
  MAX_CONSECUTIVE_ABANDONED_PROBES,
  MAX_CONSECUTIVE_WATCHDOG_EVICTIONS
} from 'lib/miden/sync-backoff';

import { INoteDeliveryState, ITransaction, ITransactionStatus, ITransactionType } from '../db/types';
import { NoteTypeEnum } from '../types';
import { __resetNoteDeliverySweepForTests, MAX_RELAY_ATTEMPTS, sweepNoteDeliveries } from './note-delivery-sweep';

const NOW = 1_800_000_000;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The text a 0.17.2 send failure reaches JS with, for the given gRPC code. */
const sendFailure = (code: string) =>
  new Error(
    'failed sending private output note: note transport error: note transport network error: ' +
      `Send note with proof failed: Status { code: ${code}, message: "transport said no", ` +
      'metadata: MetadataMap { headers: {"content-type": "application/grpc-web+proto"} }, source: None }'
  );

const rows: ITransaction[] = [];

jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: jest.fn((arg: string | { id: string }) => {
      if (typeof arg === 'string') {
        return {
          anyOf: (states: string[]) => ({
            // Copies, deliberately. Dexie hands back deserialized records and `modify`
            // later writes the STORED row in its own transaction, so the sweep never
            // sees its own writes reflected in the array it is looping over. A fake
            // that returned the live objects would alias the two and could hide a
            // missing `continue` - it did, until this was fixed.
            toArray: async () => rows.filter(row => states.includes(String(row.noteDelivery))).map(row => ({ ...row }))
          })
        };
      }
      return {
        modify: async (fn: (tx: ITransaction) => void) => {
          rows.filter(row => row.id === arg.id).forEach(fn);
        }
      };
    })
  }
}));

const mockIsConsumed = jest.fn<Promise<boolean>, [string]>();
const mockRelayById = jest.fn<Promise<void>, [string, string]>();

jest.mock('../back/miden-client-proxy', () => ({
  midenClientProxy: {
    isOutputNoteConsumed: (noteId: string) => mockIsConsumed(noteId),
    relayPrivateNoteById: (noteId: string, to: string) => mockRelayById(noteId, to)
  }
}));

const mockTransportConfigured = jest.fn<boolean, []>();

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  isNoteTransportConfigured: () => mockTransportConfigured()
}));

type DeliveryEvidence = Parameters<typeof import('./helper').recordNoteDelivery>[2];

const mockRecord = jest.fn<Promise<void>, [string, INoteDeliveryState, DeliveryEvidence?]>();

jest.mock('./helper', () => ({
  ...jest.requireActual<typeof import('./helper')>('./helper'),
  recordNoteDelivery: (...args: [string, INoteDeliveryState, DeliveryEvidence?]) => mockRecord(...args)
}));

/** A landed private send that owes a delivery, overridable per case. */
const row = (overrides: Partial<ITransaction> = {}): ITransaction =>
  ({
    id: 'tx-1',
    accountId: 'acct-1',
    type: 'send' as ITransactionType,
    status: ITransactionStatus.Completed,
    initiatedAt: NOW - 120,
    transactionId: '0xland',
    outputNoteIds: ['0xnote'],
    secondaryAccountId: 'mtst1recipient',
    noteType: NoteTypeEnum.Private,
    noteDelivery: 'relayed',
    relayAttempts: 1,
    nextRelayAt: NOW - 1,
    ...overrides
  }) as ITransaction;

/** How many passes queried candidate rows; a row write is `where({ id })` and stringifies to `[object Object]`. */
const queries = () =>
  jest.mocked(Repo.transactions.where).mock.calls.filter(([arg]) => String(arg) === 'noteDelivery').length;

beforeEach(() => {
  rows.length = 0;
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  mockIsConsumed.mockResolvedValue(false);
  mockRelayById.mockResolvedValue(undefined);
  mockRecord.mockResolvedValue(undefined);
  mockTransportConfigured.mockReturnValue(true);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  // What the last pass learned about when work is next due is module state, like the sweep's realm.
  __resetNoteDeliverySweepForTests();
  __resetSyncFuseStateForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('sweepNoteDeliveries', () => {
  it('retires the row as confirmed once the note is consumed on chain, without re-pushing', async () => {
    rows.push(row());
    mockIsConsumed.mockResolvedValue(true);

    await sweepNoteDeliveries();

    // Consumption is the only proof of delivery available to a sender, so it ends
    // the sweep for this row rather than merely pausing it.
    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'confirmed');
    expect(mockRelayById).not.toHaveBeenCalled();
  });

  it('clears a stale undelivered warning when the note turns out to have been consumed', async () => {
    rows.push(row({ noteDelivery: 'undelivered' }));
    mockIsConsumed.mockResolvedValue(true);

    await sweepNoteDeliveries();

    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'confirmed');
  });

  it('pushes an unconsumed note and schedules the next attempt', async () => {
    rows.push(row());

    await sweepNoteDeliveries();

    expect(mockRelayById).toHaveBeenCalledWith('0xnote', 'mtst1recipient');
    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'relayed', { ackedNoteIds: ['0xnote'] });
    expect(rows[0]!.relayAttempts).toBe(2);
    expect(rows[0]!.nextRelayAt).toBeGreaterThan(NOW);
  });

  it('re-pushes a custom row read as a consume to the recipient its relay used', async () => {
    // Reading the result as a consume puts the input note's sender in `secondaryAccountId`.
    rows.push(
      row({
        type: 'consume',
        secondaryAccountId: 'mtst1sender',
        relayRecipientId: 'mtst1recipient',
        relayNoteIds: ['0xnote']
      })
    );

    await sweepNoteDeliveries();

    expect(mockRelayById).toHaveBeenCalledWith('0xnote', 'mtst1recipient');
  });

  it('arms the schedule on first sighting rather than pushing straight away', async () => {
    // A row whose original relay just happened has no schedule yet. Pushing again
    // in the same breath would spend an attempt under identical conditions.
    rows.push(row({ nextRelayAt: undefined, relayAttempts: undefined }));

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(mockIsConsumed).not.toHaveBeenCalled();
    expect(rows[0]!.relayAttempts).toBe(1);
    expect(rows[0]!.nextRelayAt).toBeGreaterThan(NOW);
  });

  it('arms an old row from its original relay, so a late first sighting is due at once', async () => {
    // The wait exists because the original relay just happened - which is false for a
    // row first seen hours later (wallet closed, or first sync since the send). Arming
    // another full wait from now would push its only attempts toward the far end of
    // the sweep window, or past it, leaving a genuinely lost note never re-pushed.
    rows.push(row({ nextRelayAt: undefined, initiatedAt: NOW - 3 * 60 * 60, completedAt: NOW - 3 * 60 * 60 }));

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(rows[0]!.nextRelayAt).toBeLessThanOrEqual(NOW);
  });

  it('still makes a slow send serve the wait, measuring it from the relay and not the queue', async () => {
    // `initiatedAt` is stamped when the transaction is QUEUED, so a send that waited
    // in the FIFO and then proved and submitted can be many minutes older than its
    // relay. Anchoring on that would arm the row due-now and re-push it while the
    // original relay may still be in flight - an attempt spent against the identical
    // conditions the wait exists to avoid.
    rows.push(row({ nextRelayAt: undefined, initiatedAt: NOW - 40 * 60, completedAt: NOW - 5 }));

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(rows[0]!.nextRelayAt).toBeGreaterThan(NOW);
  });

  it('waits from now when the send has not reached its terminal write', async () => {
    // No `completedAt` means the relay is still in flight, so the wait starts now
    // however old the row's queue timestamp is.
    rows.push(row({ nextRelayAt: undefined, initiatedAt: NOW - 40 * 60, completedAt: undefined }));

    await sweepNoteDeliveries();

    expect(rows[0]!.nextRelayAt).toBeGreaterThan(NOW);
  });

  it('cannot be parked in the future by a clock that moved backwards', async () => {
    // A row written before an NTP correction (or a user changing the clock) carries a
    // future timestamp. Its negative age passes the window filter, so without the
    // clamp it would sit as a candidate, armed for a date it may never reach.
    rows.push(
      row({ nextRelayAt: undefined, initiatedAt: NOW + 365 * 24 * 60 * 60, completedAt: NOW + 365 * 24 * 60 * 60 })
    );

    await sweepNoteDeliveries();

    expect(rows[0]!.nextRelayAt).toBeLessThanOrEqual(NOW + 300);
  });

  // `importDb` fills this store from a user-supplied backup file, and this counter is
  // the only thing bounding how often a private note body goes back on the wire. A
  // value that never reaches the cap would re-push on every backoff step for the whole
  // window.
  it.each([[0], [-1]])('counts up from a nonsensical relayAttempts of %p so the row still retires', async attempts => {
    rows.push(row({ relayAttempts: attempts }));

    await sweepNoteDeliveries();

    expect(rows[0]!.relayAttempts).toBe(2);
  });

  it.each([[Number.NEGATIVE_INFINITY], [Number.NaN]])(
    'treats a non-finite relayAttempts of %p as spent',
    async attempts => {
      rows.push(row({ noteDelivery: 'pending', relayAttempts: attempts }));

      await sweepNoteDeliveries();

      expect(mockRelayById).not.toHaveBeenCalled();
      expect(mockRecord).not.toHaveBeenCalled();
    }
  );

  it('leaves a row alone until its scheduled time', async () => {
    rows.push(row({ nextRelayAt: NOW + 60 }));

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(mockIsConsumed).not.toHaveBeenCalled();
  });

  it('stops pushing once the attempt cap is reached, but still checks the receipt', async () => {
    rows.push(row({ noteDelivery: 'pending', relayAttempts: MAX_RELAY_ATTEMPTS }));

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockIsConsumed).toHaveBeenCalledWith('0xnote');
    expect(rows[0]!.relayRetriesStopped).toBe(true);
  });

  it('stops pushing a never-acknowledged note 72 hours after the send, but still checks its receipt', async () => {
    rows.push(row({ noteDelivery: 'pending', initiatedAt: NOW - 73 * HOUR, completedAt: NOW - 73 * HOUR }));

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(mockIsConsumed).toHaveBeenCalledWith('0xnote');
    expect(rows[0]!.relayRetriesStopped).toBe(true);
    expect(rows[0]!.nextRelayAt).toBe(NOW + HOUR);
  });

  it('ignores sends older than the receipt window', async () => {
    rows.push(row({ noteDelivery: 'pending', initiatedAt: NOW - 8 * DAY }));

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(mockIsConsumed).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('measures the window from the relay, so a send that waited in the queue is still pushed', async () => {
    // `initiatedAt` is stamped at queue time; a send that sat queued for days (the app
    // was closed) relays when it completes, and its delivery is due from then.
    rows.push(row({ noteDelivery: 'pending', initiatedAt: NOW - 80 * HOUR, completedAt: NOW - 600 }));

    await sweepNoteDeliveries();

    expect(mockRelayById).toHaveBeenCalledTimes(1);
  });

  it('still ignores a send relayed before the receipt window', async () => {
    rows.push(row({ noteDelivery: 'pending', initiatedAt: NOW - 9 * DAY, completedAt: NOW - 8 * DAY }));

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('keeps an ACKed row reading relayed when a re-push fails', async () => {
    rows.push(row({ noteDelivery: 'relayed' }));
    mockRelayById.mockRejectedValue(new Error('transport unreachable'));

    await sweepNoteDeliveries();

    // A failed re-push is no evidence against the original ACK. Downgrading here
    // would warn the user about a note that may well be in flight.
    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'relayed', { ackedNoteIds: ['0xnote'] });
    expect(rows[0]!.relayAttempts).toBe(2);
  });

  it('reads a rejection it does not recognize as an outage', async () => {
    // A transport that is down fails every push the same way, and text the sweep cannot
    // place is no reason to spend an attempt on every other row too.
    rows.push(row({ noteDelivery: 'pending' }));
    mockRelayById.mockRejectedValue(new Error('Failed to store note: something new'));

    await sweepNoteDeliveries();

    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'undelivered', { ackedNoteIds: [] });
    expect(rows[0]!.relayAttempts).toBe(2);
    expect(rows[0]!.relayOutageDeferred).toBe(true);
  });

  it.each([['pending'], ['undelivered'], ['relayed']] as const)(
    'records an accepted re-push as relayed from a %s prior',
    async priorState => {
      // An ACK may be a stored note's duplicate that sits below the recipient's cursor
      // (note-transport-service#77), so it is never `confirmed`: only the nullifier is.
      rows.push(row({ noteDelivery: priorState }));
      mockRelayById.mockResolvedValue(undefined);

      await sweepNoteDeliveries();

      expect(mockRecord).toHaveBeenCalledWith('tx-1', 'relayed', { ackedNoteIds: ['0xnote'] });
      expect(mockRecord).not.toHaveBeenCalledWith('tx-1', 'undelivered');
      expect(mockRecord).not.toHaveBeenCalledWith('tx-1', 'confirmed');
      expect(rows[0]!.relayAttempts).toBe(2);
    }
  );

  it('does not report an idempotent relay acknowledgement as a lost note', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    rows.push(row({ id: 'acked', noteDelivery: 'relayed', initiatedAt: NOW - 600 }));
    rows.push(row({ id: 'never-acked', noteDelivery: 'pending', initiatedAt: NOW - 60 }));

    await sweepNoteDeliveries();

    expect(mockRelayById).toHaveBeenCalledTimes(2);
    expect(mockRecord).toHaveBeenCalledWith('acked', 'relayed', { ackedNoteIds: ['0xnote'] });
    expect(mockRecord).toHaveBeenCalledWith('never-acked', 'relayed', { ackedNoteIds: ['0xnote'] });
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('says so once when a row spends its last attempt without a receipt', async () => {
    // Pushes are over for good while receipt checks go on, and `relayRetriesStopped`
    // is what the history card reads. One line says where the row stopped.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    rows.push(row({ noteDelivery: 'pending', relayAttempts: MAX_RELAY_ATTEMPTS - 1 }));
    mockRelayById.mockRejectedValue(sendFailure('Unavailable'));

    await sweepNoteDeliveries();
    jest.spyOn(Date, 'now').mockReturnValue((rows[0]!.nextRelayAt! + 1) * 1000);
    await sweepNoteDeliveries();

    expect(rows[0]!.relayRetriesStopped).toBe(true);
    expect(warn.mock.calls.filter(call => String(call[0]).includes('pushes stopped'))).toHaveLength(1);
  });

  it('does not announce a stop for a row the nullifier just retired', async () => {
    // The receipt check comes before the push, so a row confirmed on its last
    // eligible cycle has not stopped anything - it succeeded.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    rows.push(row({ noteDelivery: 'pending', relayAttempts: MAX_RELAY_ATTEMPTS - 1 }));
    mockIsConsumed.mockResolvedValue(true);

    await sweepNoteDeliveries();

    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'confirmed');
    expect(warn.mock.calls.map(call => String(call[0]))).not.toContainEqual(expect.stringContaining('pushes stopped'));
  });

  it('does not announce a stop while attempts remain', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    rows.push(row({ noteDelivery: 'pending', relayAttempts: 1 }));

    await sweepNoteDeliveries();

    expect(mockRelayById).toHaveBeenCalledTimes(1);
    expect(rows[0]!.relayAttempts).toBe(2);
    expect(rows[0]!.relayRetriesStopped).toBeUndefined();
    expect(warn.mock.calls.map(call => String(call[0]))).not.toContainEqual(expect.stringContaining('pushes stopped'));
  });

  it('marks a never-ACKed row undelivered when the re-push fails', async () => {
    rows.push(row({ noteDelivery: 'pending' }));
    mockRelayById.mockRejectedValue(new Error('transport unreachable'));

    await sweepNoteDeliveries();

    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'undelivered', { ackedNoteIds: [] });
  });

  it('re-pushes anyway when the delivery receipt cannot be read', async () => {
    rows.push(row());
    mockIsConsumed.mockRejectedValue(new Error('client unavailable'));

    await sweepNoteDeliveries();

    // An extra push for an already-delivered note costs the recipient nothing;
    // skipping one for an undelivered note is the failure this sweep prevents.
    expect(mockRelayById).toHaveBeenCalledWith('0xnote', 'mtst1recipient');
  });

  it('burns no attempt on a row with nothing to re-push', async () => {
    rows.push(row({ outputNoteIds: [] }));

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(rows[0]!.relayAttempts).toBe(1);
  });

  // Each writer that leaves a row with no note the sweep can push: such a row is inert.
  it.each<[string, Partial<ITransaction>]>([
    ['a row landed by verdict, with no stored output note', { outputNoteIds: undefined, noteDelivery: 'undelivered' }],
    [
      'a Failed private send with no output note',
      { status: ITransactionStatus.Failed, outputNoteIds: [], noteDelivery: 'undelivered' }
    ],
    [
      'a custom row whose dApp named no recipient',
      { type: 'execute', relayNoteIds: ['0xnote'], relayRecipientId: undefined, noteDelivery: 'undelivered' }
    ]
  ])('leaves %s inert: no push, no receipt, no attempt', async (_kind, overrides) => {
    rows.push(row(overrides));

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(mockIsConsumed).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(rows[0]!.relayAttempts).toBe(1);
    expect(rows[0]!.relayRetriesStopped).toBe(true);
  });

  // No push can carry a dead note, but its receipt can still be read.
  it('never pushes a row whose every owed note is dead, and still reads its receipt', async () => {
    rows.push(
      row({
        type: 'execute',
        relayNoteIds: ['0xnote'],
        relayRecipientId: 'mtst1recipient',
        relayDeadNoteIds: ['0xnote'],
        noteDelivery: 'undelivered'
      })
    );

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(mockIsConsumed).toHaveBeenCalledWith('0xnote');
    expect(rows[0]).toMatchObject({ relayAttempts: 1, relayRetriesStopped: true });
  });

  it('never touches a confirmed row again', async () => {
    rows.push(row({ noteDelivery: 'confirmed' }));

    await sweepNoteDeliveries();

    expect(mockIsConsumed).not.toHaveBeenCalled();
    expect(mockRelayById).not.toHaveBeenCalled();
  });

  it('leaves public sends out of the sweep entirely', async () => {
    rows.push(row({ noteDelivery: undefined, noteType: NoteTypeEnum.Public }));

    await sweepNoteDeliveries();

    expect(mockIsConsumed).not.toHaveBeenCalled();
    expect(mockRelayById).not.toHaveBeenCalled();
  });

  it('never schedules the next attempt in the past, however long the sweep ran', async () => {
    // Every relay carries a 45-second deadline, so a sweep with several slow rows can
    // outlive a whole backoff step. A schedule derived from the sweep's START would
    // then be stamped in the past and the row re-pushed on the very next cycle,
    // burning the attempt budget back to back - which is what these delays exist to
    // prevent. Stamping from the clock at write time keeps the spread intact.
    rows.push(row());
    let clock = NOW;
    jest.spyOn(Date, 'now').mockImplementation(() => clock * 1000);
    mockRelayById.mockImplementation(async () => {
      clock += 2 * 60 * 60;
    });

    await sweepNoteDeliveries();

    expect(rows[0]!.nextRelayAt).toBeGreaterThan(clock);
  });

  it('drains a backlog oldest-send-first', async () => {
    rows.push(row({ id: 'newer', initiatedAt: NOW - 60, outputNoteIds: ['0xnewer'] }));
    rows.push(row({ id: 'older', initiatedAt: NOW - 600, outputNoteIds: ['0xolder'] }));

    await sweepNoteDeliveries();

    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xolder', '0xnewer']);
  });

  it('orders the backlog by relay time, not queue time', async () => {
    rows.push(row({ id: 'queued-first', initiatedAt: NOW - 600, completedAt: NOW - 60, outputNoteIds: ['0xlate'] }));
    rows.push(row({ id: 'relayed-first', initiatedAt: NOW - 300, completedAt: NOW - 200, outputNoteIds: ['0xearly'] }));

    await sweepNoteDeliveries();

    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xearly', '0xlate']);
  });
});

// History renders `displayMessage`, not `noteDelivery`, so a note proven delivered has to
// take the undelivered wording off the label as well. These run the real `recordNoteDelivery`.
describe('the undelivered label', () => {
  const { recordNoteDelivery } = jest.requireActual<typeof import('./helper')>('./helper');
  const UNDELIVERED_SEND = 'Sent - the private note could not be delivered';
  const UNDELIVERED_CUSTOM = 'Completed - a private note could not be delivered';
  // 1.16.2 and earlier joined the wording with an em dash.
  const EM = ' \u2014 ';
  const LEGACY_UNDELIVERED_SEND = 'Sent' + EM + 'the private note could not be delivered';

  beforeEach(() => {
    mockRecord.mockImplementation(recordNoteDelivery);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('drops when the sweep re-pushes an undelivered private send', async () => {
    rows.push(row({ noteDelivery: 'undelivered', displayMessage: UNDELIVERED_SEND }));

    await sweepNoteDeliveries();

    expect(rows[0]!.noteDelivery).toBe('relayed');
    expect(rows[0]!.displayMessage).toBe('Sent');
  });

  it('records the note the transport acknowledged on a re-push', async () => {
    rows.push(row({ noteDelivery: 'undelivered', displayMessage: UNDELIVERED_SEND }));

    await sweepNoteDeliveries();

    expect(rows[0]!.relayAckedNoteIds).toEqual(['0xnote']);
  });

  it('drops when the sweep finds the note consumed', async () => {
    rows.push(row({ noteDelivery: 'undelivered', displayMessage: UNDELIVERED_SEND }));
    mockIsConsumed.mockResolvedValue(true);

    await sweepNoteDeliveries();

    expect(rows[0]!.noteDelivery).toBe('confirmed');
    expect(rows[0]!.displayMessage).toBe('Sent');
  });

  it('drops from a single-note custom row once it is relayed', async () => {
    rows.push(
      row({
        type: 'execute',
        noteDelivery: 'undelivered',
        displayMessage: 'Completed - a private note could not be delivered'
      })
    );

    await recordNoteDelivery('tx-1', 'relayed');

    expect(rows[0]!.displayMessage).toBe('Completed');
  });

  it.each<[ITransactionType, string, string]>([
    ['send', LEGACY_UNDELIVERED_SEND, 'Sent'],
    ['execute', 'Completed' + EM + 'a private note could not be delivered', 'Completed'],
    ['execute', 'Completed' + EM + 'the private note could not be delivered', 'Completed']
  ])('drops the wording 1.16.2 wrote from a %s row labelled %p once relayed (#1233)', async (type, label, base) => {
    rows.push(row({ type, noteDelivery: 'undelivered', displayMessage: label }));

    await recordNoteDelivery('tx-1', 'relayed');

    expect(rows[0]!.displayMessage).toBe(base);
  });

  it('drops the legacy wording when the sweep re-pushes an older private send (#1233)', async () => {
    rows.push(row({ noteDelivery: 'undelivered', displayMessage: LEGACY_UNDELIVERED_SEND }));

    await sweepNoteDeliveries();

    expect(rows[0]!.noteDelivery).toBe('relayed');
    expect(rows[0]!.displayMessage).toBe('Sent');
  });

  // The label counts the owed notes the transport has not acknowledged, whatever count it carried before.
  const twoNoteRow = (displayMessage: string) =>
    row({
      type: 'execute',
      outputNoteIds: ['0xnote', '0xnote2'],
      relayNoteIds: ['0xnote', '0xnote2'],
      relayRecipientId: 'mtst1recipient',
      noteDelivery: 'undelivered',
      displayMessage
    });

  it.each([
    ['Completed - the private note could not be delivered'],
    ['Completed - 2 private notes could not be delivered'],
    ['Completed' + EM + '2 private notes could not be delivered']
  ])('counts the one unacknowledged note of a two-note row labelled %p', async displayMessage => {
    rows.push(twoNoteRow(displayMessage));

    await recordNoteDelivery('tx-1', 'undelivered', { ackedNoteIds: ['0xnote'] });

    expect(rows[0]!.displayMessage).toBe('Completed - a private note could not be delivered');
  });

  it('drops from a two-note row once both notes are acknowledged', async () => {
    rows.push(twoNoteRow('Completed - 2 private notes could not be delivered'));

    await recordNoteDelivery('tx-1', 'undelivered', { ackedNoteIds: ['0xnote'] });
    await recordNoteDelivery('tx-1', 'relayed', { ackedNoteIds: ['0xnote2'] });

    expect(rows[0]!.relayAckedNoteIds).toEqual(['0xnote', '0xnote2']);
    expect(rows[0]!.displayMessage).toBe('Completed');
  });

  // With no acknowledgement on record the label's own count is all there is to go on.
  it('keeps the count of a two-note row with no acknowledgement on record', async () => {
    rows.push(twoNoteRow('Completed - a private note could not be delivered'));

    await recordNoteDelivery('tx-1', 'undelivered');

    expect(rows[0]!.displayMessage).toBe('Completed - a private note could not be delivered');
  });

  // Rows written before `relayNoteIds` fall back to `outputNoteIds`.
  it('re-pushes an older single-note custom row with no relayNoteIds by its output note', async () => {
    rows.push(row({ type: 'execute', noteDelivery: 'undelivered', displayMessage: UNDELIVERED_CUSTOM }));

    await sweepNoteDeliveries();

    expect(mockRelayById).toHaveBeenCalledWith('0xnote', 'mtst1recipient');
    expect(rows[0]!.displayMessage).toBe('Completed');
  });

  // Its label counted the one note of two the original relay could not deliver; which one is not on record.
  it('pushes each note of an older two-note row with no relayNoteIds, and keeps counting', async () => {
    rows.push(
      row({
        type: 'execute',
        outputNoteIds: ['0xnote', '0xnote2'],
        noteDelivery: 'undelivered',
        displayMessage: UNDELIVERED_CUSTOM
      })
    );
    mockRelayById.mockResolvedValueOnce(undefined).mockRejectedValueOnce(sendFailure('InvalidArgument'));

    await sweepNoteDeliveries();

    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xnote', '0xnote2']);
    expect(rows[0]).toMatchObject({
      noteDelivery: 'undelivered',
      relayAckedNoteIds: ['0xnote'],
      displayMessage: UNDELIVERED_CUSTOM
    });
  });

  // A public note beside the one private note is not owed a relay, whatever its place in `outputNoteIds`.
  const mixedRow = () =>
    row({
      type: 'execute',
      outputNoteIds: ['0xpublic', '0xprivate'],
      relayNoteIds: ['0xprivate'],
      relayRecipientId: 'mtst1recipient',
      noteDelivery: 'undelivered',
      displayMessage: UNDELIVERED_CUSTOM
    });

  it('re-pushes a mixed row by its one private note, and the label drops', async () => {
    rows.push(mixedRow());

    await sweepNoteDeliveries();

    expect(mockIsConsumed).toHaveBeenCalledWith('0xprivate');
    expect(mockRelayById).toHaveBeenCalledWith('0xprivate', 'mtst1recipient');
    expect(rows[0]!.noteDelivery).toBe('relayed');
    expect(rows[0]!.displayMessage).toBe('Completed');
  });

  it('confirms a mixed row by its one private note', async () => {
    rows.push(mixedRow());
    mockIsConsumed.mockResolvedValue(true);

    await sweepNoteDeliveries();

    expect(mockIsConsumed).toHaveBeenCalledWith('0xprivate');
    expect(mockRelayById).not.toHaveBeenCalled();
    expect(rows[0]!.noteDelivery).toBe('confirmed');
    expect(rows[0]!.displayMessage).toBe('Completed');
  });

  it('pushes each private note of a row owing two, and the label drops once both are acknowledged', async () => {
    rows.push(
      row({
        type: 'execute',
        outputNoteIds: ['0xprivate1', '0xprivate2', '0xpublic'],
        relayNoteIds: ['0xprivate1', '0xprivate2'],
        relayRecipientId: 'mtst1recipient',
        noteDelivery: 'undelivered',
        displayMessage: 'Completed - 2 private notes could not be delivered'
      })
    );

    await sweepNoteDeliveries();

    expect(mockIsConsumed).toHaveBeenCalledWith('0xprivate1');
    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xprivate1', '0xprivate2']);
    expect(rows[0]).toMatchObject({
      noteDelivery: 'relayed',
      relayAckedNoteIds: ['0xprivate1', '0xprivate2'],
      relayAttempts: 2,
      displayMessage: 'Completed'
    });
  });

  it('confirms a two-note row only once both notes are consumed', async () => {
    rows.push(
      row({
        type: 'execute',
        relayNoteIds: ['0xprivate1', '0xprivate2'],
        relayRecipientId: 'mtst1recipient',
        noteDelivery: 'relayed'
      })
    );
    mockIsConsumed.mockImplementation(async noteId => noteId === '0xprivate1');

    await sweepNoteDeliveries();
    expect(rows[0]!.noteDelivery).toBe('relayed');

    mockIsConsumed.mockResolvedValue(true);
    jest.spyOn(Date, 'now').mockReturnValue((rows[0]!.nextRelayAt! + 1) * 1000);
    await sweepNoteDeliveries();
    expect(rows[0]!.noteDelivery).toBe('confirmed');
  });

  // Its `secondaryAccountId` is the consumed note's sender, a third party the note was never for.
  it('stays on a custom row whose dApp named no recipient, which the sweep neither re-pushes nor records', async () => {
    rows.push(
      row({
        type: 'consume',
        secondaryAccountId: 'mtst1sender',
        relayNoteIds: ['0xnote'],
        noteDelivery: 'undelivered',
        displayMessage: UNDELIVERED_CUSTOM
      })
    );

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({
      noteDelivery: 'undelivered',
      relayAttempts: 1,
      displayMessage: UNDELIVERED_CUSTOM
    });
  });

  it('stays on an undelivered send whose re-push fails again', async () => {
    rows.push(row({ noteDelivery: 'undelivered', displayMessage: UNDELIVERED_SEND }));
    mockRelayById.mockRejectedValue(new Error('transport unreachable'));

    await sweepNoteDeliveries();

    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'undelivered', { ackedNoteIds: [] });
    expect(rows[0]!.displayMessage).toBe(UNDELIVERED_SEND);
  });

  it('stays off a clean send the sweep records undelivered', async () => {
    rows.push(row({ noteDelivery: 'pending', displayMessage: 'Sent' }));
    mockRelayById.mockRejectedValue(new Error('transport unreachable'));

    await sweepNoteDeliveries();

    expect(rows[0]!.noteDelivery).toBe('undelivered');
    expect(rows[0]!.displayMessage).toBe('Sent');
  });

  it('stays while the delivery is only pending', async () => {
    rows.push(row({ noteDelivery: 'undelivered', displayMessage: UNDELIVERED_SEND }));

    await recordNoteDelivery('tx-1', 'pending');

    expect(rows[0]!.displayMessage).toBe(UNDELIVERED_SEND);
  });

  // Only wording the shared definition built is removed, so a near miss keeps its text.
  it.each([
    ['Completed - 1 private notes could not be delivered'],
    ['Completed - 02 private notes could not be delivered'],
    ['Sent - the private note could not be delivered yet'],
    ['Sent - a note could not be delivered'],
    ['Sent' + EM + 'a note could not be delivered'],
    ['Completed' + EM + '02 private notes could not be delivered']
  ])('leaves %p alone', async displayMessage => {
    rows.push(row({ noteDelivery: 'undelivered', displayMessage }));

    await recordNoteDelivery('tx-1', 'confirmed');

    expect(rows[0]!.displayMessage).toBe(displayMessage);
  });
});

// The schedule across many passes, with the real `recordNoteDelivery` so each pass sees what the last one wrote.
describe('the delivery schedule', () => {
  const { recordNoteDelivery } = jest.requireActual<typeof import('./helper')>('./helper');
  let clock = NOW;
  let pushTimes: number[] = [];
  let receiptTimes: number[] = [];

  beforeEach(() => {
    clock = NOW;
    pushTimes = [];
    receiptTimes = [];
    mockRecord.mockImplementation(recordNoteDelivery);
    jest.spyOn(Date, 'now').mockImplementation(() => clock * 1000);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockRelayById.mockImplementation(async () => {
      pushTimes.push(clock);
    });
    mockIsConsumed.mockImplementation(async () => {
      receiptTimes.push(clock);
      return false;
    });
  });

  let restoreWhere: (() => void) | undefined;
  afterEach(() => {
    restoreWhere?.();
    restoreWhere = undefined;
  });

  /** Make every write to row `id` reject, until the test ends. */
  const failWritesTo = (id: string) => {
    const where = jest.mocked(Repo.transactions.where);
    const real = where.getMockImplementation()!;
    where.mockImplementation(arg =>
      typeof arg !== 'string' && arg.id === id
        ? ({
            modify: async () => {
              throw new Error('store closed');
            }
          } as never)
        : real(arg)
    );
    restoreWhere = () => where.mockImplementation(real);
  };

  /** Run a pass at each time the row asks to be looked at again, until `until`. */
  const drive = async (until: number) => {
    for (;;) {
      await sweepNoteDeliveries();
      const next = rows[0]!.nextRelayAt;
      if (next === undefined || next <= clock || next > until) return;
      clock = next;
    }
  };

  const minutesAfter = (start: number, times: number[]) => times.map(time => (time - start) / MINUTE);

  const fresh = (overrides: Partial<ITransaction> = {}) =>
    row({ initiatedAt: NOW, completedAt: NOW, relayAttempts: undefined, nextRelayAt: undefined, ...overrides });

  // (a) Every step of the retry schedule, then the 72-hour stop, then receipts alone.
  it('pushes a never-acknowledged note at each step until 72 hours after the send, then only checks receipts', async () => {
    rows.push(fresh({ noteDelivery: 'pending' }));
    mockRelayById.mockImplementation(async () => {
      pushTimes.push(clock);
      throw sendFailure('Unavailable');
    });

    await drive(NOW + 8 * DAY);

    expect(minutesAfter(NOW, pushTimes)).toEqual([
      5, 20, 50, 110, 230, 470, 830, 1190, 1550, 1910, 2270, 2630, 2990, 3350, 3710, 4070
    ]);
    expect(rows[0]).toMatchObject({ relayAttempts: 17, relayRetriesStopped: true, noteDelivery: 'undelivered' });
    const afterStop = receiptTimes.filter(time => time > pushTimes[pushTimes.length - 1]!);
    expect(afterStop[0]! - NOW).toBeGreaterThan(72 * HOUR);
    expect(afterStop.slice(1).map((time, at) => time - afterStop[at]!)).toEqual(Array(afterStop.length - 1).fill(HOUR));
    expect(afterStop[afterStop.length - 1]! - NOW).toBeLessThanOrEqual(7 * DAY);
    expect(afterStop[afterStop.length - 1]! - NOW).toBeGreaterThan(7 * DAY - HOUR);
  });

  // (b) An acknowledged note gets two verification pushes and no more.
  it.each<[string, Partial<ITransaction>]>([
    ['an acknowledged row', { noteDelivery: 'relayed', relayAckedNoteIds: ['0xnote'] }],
    ['a relayed row from before acknowledgements were recorded', { noteDelivery: 'relayed' }]
  ])('pushes %s exactly twice, at 5 and 35 minutes', async (_kind, overrides) => {
    rows.push(fresh(overrides));

    await drive(NOW + 8 * DAY);

    expect(minutesAfter(NOW, pushTimes)).toEqual([5, 35]);
    expect(rows[0]).toMatchObject({ noteDelivery: 'relayed', relayVerifyPushes: 2 });
    expect(rows[0]!.relayRetriesStopped).toBeUndefined();
  });

  it('times the verification pushes from the acknowledgement a retry got', async () => {
    rows.push(fresh({ noteDelivery: 'pending' }));
    mockRelayById
      .mockImplementationOnce(async () => {
        pushTimes.push(clock);
        throw sendFailure('Unavailable');
      })
      .mockImplementation(async () => {
        pushTimes.push(clock);
      });

    await drive(NOW + 8 * DAY);

    // A failed push at 5, the acknowledgement at 20, then 20 + 5 and 20 + 35.
    expect(minutesAfter(NOW, pushTimes)).toEqual([5, 20, 25, 55]);
  });

  // (c)
  it('keeps checking receipts after pushes stop, and retires the row once the note is consumed', async () => {
    rows.push(row({ noteDelivery: 'pending', initiatedAt: NOW - 73 * HOUR, completedAt: NOW - 73 * HOUR }));

    await sweepNoteDeliveries();
    expect(rows[0]!.relayRetriesStopped).toBe(true);

    mockIsConsumed.mockResolvedValue(true);
    clock = rows[0]!.nextRelayAt!;
    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(rows[0]!.noteDelivery).toBe('confirmed');
  });

  const due = (id: string, completedAt: number, overrides: Partial<ITransaction> = {}) =>
    row({
      id,
      noteDelivery: 'pending',
      initiatedAt: completedAt,
      completedAt,
      outputNoteIds: [`0x${id}`],
      nextRelayAt: NOW - 1,
      ...overrides
    });

  /** A row whose one note the transport acknowledged, due its first verification push. */
  const verifying = (completedAt: number, overrides: Partial<ITransaction> = {}) =>
    due('verify', completedAt, {
      noteDelivery: 'relayed',
      relayAckedNoteIds: ['0xverify'],
      relayVerifyPushes: 0,
      ...overrides
    });

  // A push that failed gave the note no second chance, so the step it was is still owed.
  it('serves a verification step again after its push fails, and counts it once a push lands', async () => {
    rows.push(verifying(NOW - 1000));
    mockRelayById.mockImplementationOnce(async () => {
      pushTimes.push(clock);
      throw sendFailure('Unavailable');
    });

    await sweepNoteDeliveries();

    expect(rows[0]!.relayVerifyPushes).toBe(0);
    // retryDelayFor(2): the push was made, so the row serves the step after it.
    expect(rows[0]).toMatchObject({ relayAttempts: 2, nextRelayAt: NOW + 15 * MINUTE, relayOutageDeferred: true });

    clock = rows[0]!.nextRelayAt!;
    await drive(NOW + 8 * DAY);

    expect(minutesAfter(NOW, pushTimes)).toEqual([0, 15, 45]);
    expect(rows[0]).toMatchObject({ noteDelivery: 'relayed', relayVerifyPushes: 2 });
  });

  // Bounded as retries are, so a transport that keeps failing cannot hold a row in verification for good.
  it('counts a failed verification step as done on a row whose push spent its last attempt', async () => {
    rows.push(verifying(NOW - 1000, { relayAttempts: MAX_RELAY_ATTEMPTS - 1 }));
    mockRelayById.mockRejectedValueOnce(sendFailure('Unavailable'));

    await sweepNoteDeliveries();

    expect(rows[0]).toMatchObject({ relayVerifyPushes: 1, nextRelayAt: NOW + 30 * MINUTE });
  });

  // No push of any kind goes past the retry bounds; such a row serves receipts only.
  it.each<[string, number, number]>([
    ['sent more than 72 hours ago', NOW - 73 * HOUR, 1],
    ['whose attempts are spent', NOW - 1000, MAX_RELAY_ATTEMPTS]
  ])('makes no verification push on a row %s', async (_kind, completedAt, relayAttempts) => {
    rows.push(verifying(completedAt, { relayAttempts }));

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ relayVerifyPushes: 0, nextRelayAt: NOW + HOUR });
  });

  it('makes no verification push past 72 hours on a row whose push was evicted before them', async () => {
    rows.push(verifying(NOW - 71 * HOUR, { relayAttempts: 5 }));
    mockRelayById.mockRejectedValueOnce(new WasmClientPoisonedError('watchdog', new Error('push parked')));

    await sweepNoteDeliveries();
    // retryDelayFor(5): the evicted step's backoff carries the row past the 72-hour mark.
    expect(rows[0]!.nextRelayAt).toBe(NOW + 2 * HOUR);
    clock = rows[0]!.nextRelayAt!;
    await sweepNoteDeliveries();

    expect(mockRelayById).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ relayAttempts: 5, relayVerifyPushes: 0, nextRelayAt: NOW + 3 * HOUR });
  });

  // No push can carry a dead note, so finding one dead is as much as its step can do.
  it('counts a verification step whose failed note was found dead', async () => {
    rows.push(
      verifying(NOW - 1000, {
        type: 'execute',
        relayNoteIds: ['0xlost', '0xkept'],
        relayRecipientId: 'mtst1recipient',
        relayAckedNoteIds: ['0xlost', '0xkept']
      })
    );
    mockRelayById.mockRejectedValueOnce(new Error('No output note found for the given id'));

    await sweepNoteDeliveries();

    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xlost', '0xkept']);
    expect(rows[0]).toMatchObject({
      relayVerifyPushes: 1,
      relayDeadNoteIds: ['0xlost'],
      nextRelayAt: NOW + 30 * MINUTE
    });
  });

  // (d)
  it('stops pushing for the pass after an outage: the next due row spends no attempt and is left as it was', async () => {
    rows.push(due('first', NOW - 2000), due('second', NOW - 1000));
    mockRelayById.mockRejectedValue(sendFailure('Unavailable'));

    await sweepNoteDeliveries();

    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xfirst']);
    expect(rows[0]).toMatchObject({ relayAttempts: 2, relayOutageDeferred: true });
    // Still due, so the next pass pushes it whatever the mark says; only the row whose own push failed is marked.
    expect(rows[1]).toMatchObject({ relayAttempts: 1, nextRelayAt: NOW - 1 });
    expect(rows[1]!.relayOutageDeferred).toBeUndefined();
  });

  // An early exit must not lose what the row's earlier notes already got from the transport.
  it.each([
    ['a lock eviction', () => new WasmClientPoisonedError('watchdog', new Error('push parked'))],
    [
      'a transport the client reports disabled',
      () =>
        new Error(
          'failed sending private output note: note transport error: note transport is disabled; ' +
            'enable it in the client configuration to send or receive notes via P2P'
        )
    ]
  ])("keeps the first note's acknowledgement when the second push ends the row on %s", async (_kind, makeError) => {
    rows.push(
      due('pair', NOW - 1000, {
        type: 'execute',
        relayNoteIds: ['0xa', '0xb'],
        relayRecipientId: 'mtst1recipient',
        noteDelivery: 'undelivered'
      })
    );
    mockRelayById.mockResolvedValueOnce(undefined).mockRejectedValueOnce(makeError());

    await sweepNoteDeliveries();

    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xa', '0xb']);
    expect(rows[0]!.relayAckedNoteIds).toEqual(['0xa']);
  });

  // (d2)
  it('goes on after a failure of the note itself', async () => {
    rows.push(due('first', NOW - 2000), due('second', NOW - 1000));
    mockRelayById
      .mockRejectedValueOnce(new Error('output note has no inclusion proof; sync past the block that committed it'))
      .mockResolvedValue(undefined);

    await sweepNoteDeliveries();

    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xfirst', '0xsecond']);
    expect(rows[0]).toMatchObject({ relayAttempts: 2, noteDelivery: 'undelivered' });
    expect(rows[0]!.relayOutageDeferred).toBeUndefined();
  });

  // (d3)
  it('still confirms a row the outage kept it from pushing', async () => {
    rows.push(due('first', NOW - 2000), due('second', NOW - 1000));
    mockRelayById.mockRejectedValue(sendFailure('Unavailable'));
    mockIsConsumed.mockImplementation(async noteId => noteId === '0xsecond');

    await sweepNoteDeliveries();

    expect(rows[1]!.noteDelivery).toBe('confirmed');
  });

  // (e)
  it('pushes a row an outage deferred in the same pass as the first success, and no row that is not due', async () => {
    rows.push(
      due('deferred', NOW - 3000, { nextRelayAt: NOW + 600, relayOutageDeferred: true }),
      due('due', NOW - 2000),
      due('waiting', NOW - 1000, { nextRelayAt: NOW + 600 })
    );

    await sweepNoteDeliveries();

    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xdue', '0xdeferred']);
    expect(rows[0]!.relayOutageDeferred).toBeUndefined();
    expect(rows[2]!.relayAttempts).toBe(1);
  });

  it('keeps a deferred row waiting while nothing succeeds', async () => {
    rows.push(due('deferred', NOW - 3000, { nextRelayAt: NOW + 600, relayOutageDeferred: true }));

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(rows[0]!.relayOutageDeferred).toBe(true);
  });

  // (f)
  it('records a note missing from the store dead and goes on with its sibling', async () => {
    rows.push(
      due('pair', NOW - 1000, {
        type: 'execute',
        relayNoteIds: ['0xlost', '0xkept'],
        relayRecipientId: 'mtst1recipient',
        noteDelivery: 'undelivered'
      })
    );
    mockRelayById
      .mockRejectedValueOnce(
        new Error("Offscreen call 'relayPrivateNoteById' failed: No output note found for the given id")
      )
      .mockResolvedValue(undefined);

    await sweepNoteDeliveries();
    expect(rows[0]).toMatchObject({
      relayDeadNoteIds: ['0xlost'],
      relayAckedNoteIds: ['0xkept'],
      noteDelivery: 'undelivered',
      relayRetriesStopped: true
    });

    mockRelayById.mockClear();
    clock = rows[0]!.nextRelayAt!;
    await sweepNoteDeliveries();
    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xkept']);
  });

  it('still confirms a row whose only owed note is dead once that note is consumed', async () => {
    rows.push(
      due('dead', NOW - 1000, {
        type: 'execute',
        relayNoteIds: ['0xdead'],
        relayRecipientId: 'mtst1recipient',
        relayDeadNoteIds: ['0xdead'],
        noteDelivery: 'undelivered'
      })
    );
    mockIsConsumed.mockResolvedValue(true);

    await sweepNoteDeliveries();

    expect(mockIsConsumed).toHaveBeenCalledWith('0xdead');
    expect(mockRelayById).not.toHaveBeenCalled();
    expect(rows[0]!.noteDelivery).toBe('confirmed');
  });

  // (g)
  it.each<[INoteDeliveryState, boolean | undefined]>([
    ['pending', true],
    ['relayed', undefined]
  ])('only checks receipts for a %s row restored from a backup', async (noteDelivery, stopped) => {
    rows.push(due('restored', NOW - 1000, { restoredFromBackup: true, noteDelivery }));

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(mockIsConsumed).toHaveBeenCalledWith('0xrestored');
    expect(rows[0]!.relayAttempts).toBe(1);
    expect(rows[0]!.relayRetriesStopped).toBe(stopped);
  });

  // (h)
  it('spends nothing while the network has no transport, and still checks receipts', async () => {
    rows.push(due('first', NOW - 1000));
    mockTransportConfigured.mockReturnValue(false);

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(mockIsConsumed).toHaveBeenCalledWith('0xfirst');
    expect(rows[0]).toMatchObject({ relayAttempts: 1, noteDelivery: 'pending' });
  });

  it('spends nothing when the client reports its transport disabled', async () => {
    rows.push(due('first', NOW - 2000), due('second', NOW - 1000));
    mockRelayById.mockRejectedValue(
      new Error(
        'failed sending private output note: note transport error: note transport is disabled; ' +
          'enable it in the client configuration to send or receive notes via P2P'
      )
    );

    await sweepNoteDeliveries();

    expect(mockRelayById).toHaveBeenCalledTimes(1);
    expect(rows.map(tx => tx.relayAttempts)).toEqual([1, 1]);
    expect(rows.map(tx => tx.noteDelivery)).toEqual(['pending', 'pending']);
  });

  // (i)
  it.each([
    ['a lock eviction', () => new WasmClientPoisonedError('watchdog')],
    ['an offscreen kill', () => new OperationAbortedError('op-1', 'deadline')]
  ])('stops the pass and spends nothing on %s, only moving that row to its next step', async (_kind, makeError) => {
    rows.push(due('first', NOW - 2000), due('second', NOW - 1000));
    const before = rows.map(tx => ({ ...tx }));
    mockRelayById.mockRejectedValue(makeError());

    await sweepNoteDeliveries();

    expect(mockRelayById).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([{ ...before[0], nextRelayAt: NOW + 5 * MINUTE }, before[1]]);

    // The row the pass never reached is still due, so the next lap pushes it.
    await sweepNoteDeliveries();
    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xfirst', '0xsecond']);
  });

  // An evicted push is still parked somewhere: the next lap must not walk back into the same hold.
  it('backs a row off after its push is evicted, spending nothing, so the next lap does not push it again', async () => {
    rows.push(due('first', NOW - 1000));
    mockRelayById.mockRejectedValue(new WasmClientPoisonedError('watchdog', new Error('push parked')));

    await sweepNoteDeliveries();
    await sweepNoteDeliveries();

    expect(mockRelayById).toHaveBeenCalledTimes(1);
    // retryDelayFor(1): the step after the row's one attempt.
    expect(rows[0]).toMatchObject({ relayAttempts: 1, noteDelivery: 'pending', nextRelayAt: NOW + 5 * MINUTE });
    // The pass still left its idle gate, so the second lap did not even query.
    expect(queries()).toBe(1);
  });

  it('withdraws the push fuse evidence only on a push that resolved', async () => {
    for (let eviction = 1; eviction < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; eviction++) {
      noteSyncWatchdogEviction('note-delivery');
    }
    rows.push(due('first', NOW - 1000));

    await sweepNoteDeliveries();
    noteSyncWatchdogEviction('note-delivery');

    expect(mockRelayById).toHaveBeenCalledTimes(1);
    expect(isSyncFused('note-delivery')).toBe(false);
  });

  // A catch-up push is owed for an outage, never for an eviction: the evicted push may still be parked.
  it('never lets a later catch-up pull an evicted row forward before its cooldown', async () => {
    rows.push(due('a', NOW - 2000, { relayOutageDeferred: true }), due('b', NOW - 1000));
    mockRelayById.mockRejectedValueOnce(new WasmClientPoisonedError('watchdog', new Error('push parked')));

    await sweepNoteDeliveries();
    mockRelayById.mockClear();
    await sweepNoteDeliveries();

    expect(mockRelayById).toHaveBeenCalledWith('0xb', 'mtst1recipient');
    expect(mockRelayById).not.toHaveBeenCalledWith('0xa', 'mtst1recipient');
    expect(rows[0]).toMatchObject({ relayAttempts: 1, nextRelayAt: NOW + 5 * MINUTE });
  });

  // A trap abandons the push without learning anything about the transport.
  it('books a realm-error push as an abandoned probe, so it never erases eviction evidence', async () => {
    for (let eviction = 1; eviction < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; eviction++) {
      noteSyncWatchdogEviction('note-delivery');
    }
    rows.push(due('first', NOW - 1000));
    mockRelayById.mockRejectedValueOnce(new WasmClientPoisonedError('realm-error', new Error('trap')));

    await sweepNoteDeliveries();
    noteSyncWatchdogEviction('note-delivery');

    expect(isSyncFused('note-delivery')).toBe(true);
  });

  it('lights the note-delivery fuse once enough pushes were abandoned', async () => {
    rows.push(due('first', NOW - 1000));
    mockRelayById.mockRejectedValue(new WasmClientPoisonedError('realm-error', new Error('trap')));

    for (let pass = 0; pass < MAX_CONSECUTIVE_ABANDONED_PROBES; pass++) {
      await sweepNoteDeliveries();
      clock = rows[0]!.nextRelayAt!;
    }

    expect(mockRelayById).toHaveBeenCalledTimes(MAX_CONSECUTIVE_ABANDONED_PROBES);
    expect(isSyncFused('note-delivery')).toBe(true);
  });

  // The sweep books what it classified: an eviction it found down the cause chain is an eviction.
  it('books a wrapped eviction as an eviction', async () => {
    for (let eviction = 1; eviction < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; eviction++) {
      noteSyncWatchdogEviction('note-delivery');
    }
    rows.push(due('first', NOW - 1000));
    mockRelayById.mockRejectedValueOnce(
      new Error('relay failed', { cause: new WasmClientPoisonedError('watchdog', new Error('push parked')) })
    );

    await sweepNoteDeliveries();

    expect(isSyncFused('note-delivery')).toBe(true);
  });

  // A note missing from this client's store never reached the transport.
  it('books a store loss as neither evidence nor its withdrawal', async () => {
    for (let eviction = 1; eviction < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; eviction++) {
      noteSyncWatchdogEviction('note-delivery');
    }
    rows.push(due('first', NOW - 1000));
    mockRelayById.mockRejectedValueOnce(new Error('No output note found for the given id'));

    await sweepNoteDeliveries();
    noteSyncWatchdogEviction('note-delivery');

    expect(isSyncFused('note-delivery')).toBe(true);
  });

  // The transport answered, so the push did not park: a run of evictions is broken.
  it('books a transport rejection of the request as an answer from the node', async () => {
    for (let eviction = 1; eviction < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; eviction++) {
      noteSyncWatchdogEviction('note-delivery');
    }
    rows.push(due('first', NOW - 1000));
    mockRelayById.mockRejectedValueOnce(sendFailure('InvalidArgument'));

    await sweepNoteDeliveries();
    noteSyncWatchdogEviction('note-delivery');

    expect(isSyncFused('note-delivery')).toBe(false);
  });

  it('re-arms a lapsed fuse when the push it granted fails locally, so the next pass pushes nothing', async () => {
    let monotonic = 1_000;
    jest.spyOn(performance, 'now').mockImplementation(() => monotonic);
    for (let eviction = 0; eviction < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; eviction++) {
      noteSyncWatchdogEviction('note-delivery');
    }
    monotonic += FUSED_SYNC_PROBE_INTERVAL_MS + 1_000;
    rows.push(due('lost', NOW - 2000), due('later', NOW - 1000, { nextRelayAt: NOW + 600 }));
    mockRelayById.mockRejectedValueOnce(new Error('No output note found for the given id'));

    await sweepNoteDeliveries();
    expect(isSyncFused('note-delivery')).toBe(true);

    clock = NOW + 600;
    await sweepNoteDeliveries();

    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xlost']);
  });

  /**
   * Light the 'note-delivery' fuse and let its window lapse, so the next push is the one probe it
   * grants. Resolves to a way to move the fuse's clock on by `ms`.
   */
  const lapseFuse = () => {
    let monotonic = 1_000;
    jest.spyOn(performance, 'now').mockImplementation(() => monotonic);
    for (let eviction = 0; eviction < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; eviction++) {
      noteSyncWatchdogEviction('note-delivery');
    }
    monotonic += FUSED_SYNC_PROBE_INTERVAL_MS + 1_000;
    return (ms: number) => {
      monotonic += ms;
    };
  };

  // The window a failed granted push re-arms binds the rest of its own pass, not only the next one.
  it('pushes no other row in the pass once the push the lapsed fuse granted fails', async () => {
    lapseFuse();
    rows.push(due('lost', NOW - 2000), due('next', NOW - 1000));
    mockRelayById.mockRejectedValueOnce(new Error('No output note found for the given id'));

    await sweepNoteDeliveries();

    expect(mockRelayById).toHaveBeenCalledTimes(1);
    expect(rows[1]).toMatchObject({ relayAttempts: 1, nextRelayAt: NOW - 1 });
  });

  it("stops a row between its notes once the fuse re-arms, keeping the first note's outcome", async () => {
    lapseFuse();
    rows.push(
      due('pair', NOW - 1000, {
        type: 'execute',
        relayNoteIds: ['0xlost', '0xkept'],
        relayRecipientId: 'mtst1recipient',
        noteDelivery: 'undelivered'
      })
    );
    mockRelayById.mockRejectedValueOnce(new Error('No output note found for the given id'));

    await sweepNoteDeliveries();

    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xlost']);
    // retryDelayFor(2): the row's push was made, so it serves the step after it.
    expect(rows[0]).toMatchObject({ relayAttempts: 2, relayDeadNoteIds: ['0xlost'], nextRelayAt: NOW + 15 * MINUTE });
    expect(rows[0]!.relayOutageDeferred).toBeUndefined();
  });

  // The note the fuse kept the step from reaching is still owed its verification push.
  it('serves a verification step again once the fuse stops it between its notes', async () => {
    const advanceFuseClock = lapseFuse();
    rows.push(
      due('pair', NOW - 1000, {
        type: 'execute',
        relayNoteIds: ['0xlost', '0xkept'],
        relayRecipientId: 'mtst1recipient',
        noteDelivery: 'relayed',
        relayAckedNoteIds: ['0xlost', '0xkept'],
        relayVerifyPushes: 1
      })
    );
    mockRelayById.mockRejectedValueOnce(new Error('No output note found for the given id'));

    await sweepNoteDeliveries();

    expect(rows[0]!.relayVerifyPushes).toBe(1);
    expect(rows[0]).toMatchObject({ relayDeadNoteIds: ['0xlost'], nextRelayAt: NOW + 15 * MINUTE });

    // The next pass after the window the failed push re-armed.
    clock = NOW + 31 * MINUTE;
    advanceFuseClock(31 * MINUTE * 1000);
    await sweepNoteDeliveries();

    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xlost', '0xkept']);
    expect(rows[0]!.relayVerifyPushes).toBe(2);
  });

  it('lets the next row push in the same pass once the push the lapsed fuse granted succeeds', async () => {
    lapseFuse();
    rows.push(due('first', NOW - 2000), due('second', NOW - 1000));

    await sweepNoteDeliveries();

    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xfirst', '0xsecond']);
    expect(isSyncFused('note-delivery')).toBe(false);
  });

  // No probe ran: the client refused before any transport call.
  it('books nothing for a push the disabled transport refused', async () => {
    for (let eviction = 1; eviction < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; eviction++) {
      noteSyncWatchdogEviction('note-delivery');
    }
    rows.push(due('first', NOW - 1000));
    mockRelayById.mockRejectedValueOnce(
      new Error(
        'failed sending private output note: note transport error: note transport is disabled; ' +
          'enable it in the client configuration to send or receive notes via P2P'
      )
    );

    await sweepNoteDeliveries();
    noteSyncWatchdogEviction('note-delivery');

    expect(isSyncFused('note-delivery')).toBe(true);
  });

  it('pushes nothing while the note-delivery fuse is lit, and still reads the receipt', async () => {
    for (let eviction = 0; eviction < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; eviction++) {
      noteSyncWatchdogEviction('note-delivery');
    }
    rows.push(due('first', NOW - 1000));

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(mockIsConsumed).toHaveBeenCalledWith('0xfirst');
  });

  // The eviction ends the pass even when the row's own cooldown cannot be written.
  it.each([
    ['a lock eviction', () => new WasmClientPoisonedError('watchdog', new Error('push parked'))],
    ['an offscreen kill', () => new OperationAbortedError('op-1', 'deadline')]
  ])('ends the pass at %s whose cooldown write fails', async (_kind, makeError) => {
    rows.push(due('first', NOW - 2000), due('second', NOW - 1000));
    mockRelayById.mockRejectedValueOnce(makeError());
    failWritesTo('first');

    await sweepNoteDeliveries();

    expect(mockRelayById).toHaveBeenCalledTimes(1);
  });

  it('pushes nothing more after an eviction whose cooldown write fails, catch-up included', async () => {
    rows.push(
      due('deferred', NOW - 3000, { nextRelayAt: NOW + 600, relayOutageDeferred: true }),
      due('pushed', NOW - 2000),
      due('evicted', NOW - 1000),
      due('after', NOW - 500)
    );
    mockRelayById
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new WasmClientPoisonedError('watchdog', new Error('push parked')));
    failWritesTo('evicted');

    await sweepNoteDeliveries();

    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xpushed', '0xevicted']);
  });

  // An evicted receipt read leaves the realm's client parked as surely as an evicted push.
  it('ends the pass at an evicted receipt read, before any push', async () => {
    rows.push(due('first', NOW - 2000), due('second', NOW - 1000));
    mockIsConsumed.mockRejectedValueOnce(new WasmClientPoisonedError('watchdog', new Error('read parked')));

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(mockIsConsumed).toHaveBeenCalledTimes(1);
  });

  // Left due, the row would open every later pass on the same killed read and starve the rows behind it.
  it.each([
    ['a lock eviction', () => new WasmClientPoisonedError('realm-error', new Error('trap'))],
    ['an offscreen kill', () => new OperationAbortedError('op-1', 'deadline')]
  ])(
    'moves a row whose receipt read was killed by %s, so the next pass reaches the rows behind it',
    async (_kind, makeError) => {
      rows.push(due('first', NOW - 2000), due('second', NOW - 1000));
      mockIsConsumed.mockImplementation(async noteId => {
        if (noteId === '0xfirst') throw makeError();
        return false;
      });

      await sweepNoteDeliveries();
      // retryDelayFor(1), as for an evicted push: nothing spent, nothing recorded.
      expect(rows[0]).toMatchObject({ relayAttempts: 1, noteDelivery: 'pending', nextRelayAt: NOW + 5 * MINUTE });

      await sweepNoteDeliveries();
      expect(mockRelayById).toHaveBeenCalledWith('0xsecond', 'mtst1recipient');
      expect(mockRelayById).not.toHaveBeenCalledWith('0xfirst', 'mtst1recipient');
    }
  );

  // The killed read spent nothing, so the step the row moves to is the one it was already serving.
  it.each<[string, Partial<ITransaction>, number]>([
    [
      'whose retries are over',
      { relayAttempts: MAX_RELAY_ATTEMPTS, initiatedAt: NOW - 4 * DAY, completedAt: NOW - 4 * DAY },
      HOUR
    ],
    ['restored from a backup', { restoredFromBackup: true }, HOUR],
    [
      'between its verification pushes',
      { noteDelivery: 'relayed', relayAckedNoteIds: ['0xfirst'], relayVerifyPushes: 1 },
      30 * MINUTE
    ],
    // retryDelayFor(3).
    ['with retries left', { relayAttempts: 3 }, 30 * MINUTE]
  ])('moves a row %s whose receipt read was killed to its own next step', async (_kind, overrides, delay) => {
    rows.push(due('first', NOW - 1000, overrides));
    const before = { ...rows[0]! };
    mockIsConsumed.mockRejectedValueOnce(new WasmClientPoisonedError('watchdog', new Error('read parked')));

    await sweepNoteDeliveries();

    expect(rows[0]!.nextRelayAt).toBe(NOW + delay);
    expect(rows[0]).toEqual({ ...before, nextRelayAt: NOW + delay });
    expect(mockRelayById).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('lights the receipt fuse on evicted receipt reads, then pushes a due row without reading its receipt', async () => {
    rows.push(due('first', NOW - 1000));
    mockIsConsumed.mockRejectedValue(new WasmClientPoisonedError('watchdog', new Error('read parked')));

    for (let pass = 0; pass < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; pass++) {
      await sweepNoteDeliveries();
      clock = rows[0]!.nextRelayAt!;
    }
    expect(isSyncFused('note-delivery-receipt')).toBe(true);
    expect(isSyncFused('note-delivery')).toBe(false);

    await sweepNoteDeliveries();

    expect(mockIsConsumed).toHaveBeenCalledTimes(MAX_CONSECUTIVE_WATCHDOG_EVICTIONS);
    expect(mockRelayById).toHaveBeenCalledWith('0xfirst', 'mtst1recipient');
  });

  // Only that read lost its race against a write; the realm and its client are intact.
  it('goes on with the pass when an offscreen receipt read is failed without a kill', async () => {
    rows.push(due('first', NOW - 2000), due('second', NOW - 1000));
    mockIsConsumed.mockRejectedValueOnce(new OperationAbortedError('op', 'deadline-no-kill'));

    await sweepNoteDeliveries();

    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xfirst', '0xsecond']);
  });

  it('never fuses the receipt read on offscreen reads failed without a kill', async () => {
    rows.push(due('first', NOW - 1000));
    mockIsConsumed.mockRejectedValue(new OperationAbortedError('op', 'deadline-no-kill'));

    const passes = 2 * MAX_CONSECUTIVE_ABANDONED_PROBES;
    for (let pass = 0; pass < passes; pass++) {
      await sweepNoteDeliveries();
      clock = rows[0]!.nextRelayAt!;
    }

    expect(isSyncFused('note-delivery-receipt')).toBe(false);
    expect(mockIsConsumed).toHaveBeenCalledTimes(passes);
  });

  it.each<[string, Record<string, boolean>, string]>([
    ['every note consumed', { '0xa': true, '0xb': true }, '0xb'],
    ['an early not-consumed answer', { '0xa': false, '0xb': true }, '0xa']
  ])('books a receipt success only once the last read it made answered: %s', async (_kind, consumed, lastRead) => {
    for (let eviction = 1; eviction < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; eviction++) {
      noteSyncWatchdogEviction('note-delivery-receipt');
    }
    rows.push(
      due('pair', NOW - 1000, { type: 'execute', relayNoteIds: ['0xa', '0xb'], relayRecipientId: 'mtst1recipient' })
    );
    let litAtLastRead: boolean | undefined;
    mockIsConsumed.mockImplementation(async noteId => {
      if (noteId === lastRead) {
        // Completes the evidence, unless a success booked after an earlier read withdrew it.
        noteSyncWatchdogEviction('note-delivery-receipt');
        litAtLastRead = isSyncFused('note-delivery-receipt');
      }
      return consumed[noteId]!;
    });

    await sweepNoteDeliveries();

    expect(litAtLastRead).toBe(true);
    expect(isSyncFused('note-delivery-receipt')).toBe(false);
  });

  it('ends the pass at an eviction, before any catch-up push', async () => {
    rows.push(
      due('deferred', NOW - 3000, { nextRelayAt: NOW + 600, relayOutageDeferred: true }),
      due('pushed', NOW - 2000),
      due('evicted', NOW - 1000)
    );
    mockRelayById
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new WasmClientPoisonedError('watchdog', new Error('push parked')));

    await sweepNoteDeliveries();

    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xpushed', '0xevicted']);
  });

  // A backup file can carry anything in these fields, and one such row must not starve the rest.
  it('still pushes the next row when one row stores a relay id list that is not a list', async () => {
    const bad = due('bad', NOW - 2000);
    Object.assign(bad, { relayDeadNoteIds: 5 });
    rows.push(bad, due('good', NOW - 1000));

    await sweepNoteDeliveries();

    expect(mockRelayById).toHaveBeenCalledWith('0xgood', 'mtst1recipient');
    // Read as no dead notes, so the row itself is pushed and serves its cooldown.
    await sweepNoteDeliveries();
    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xbad', '0xgood']);
    expect(rows[0]!.nextRelayAt).toBeGreaterThan(NOW);
  });

  it('owes only the string ids of a stored relayNoteIds list', async () => {
    const mixed = due('mixed', NOW - 1000, { type: 'execute', relayRecipientId: 'mtst1recipient' });
    Object.assign(mixed, { relayNoteIds: ['0xa', 7, null] });
    rows.push(mixed);

    await sweepNoteDeliveries();

    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xa']);
  });

  it('persists the acknowledgement and cooldown of a row whose stored acknowledgements are not a list', async () => {
    const malformed = due('malformed', NOW - 1000);
    Object.assign(malformed, { relayAckedNoteIds: 5 });
    rows.push(malformed);

    await sweepNoteDeliveries();
    await sweepNoteDeliveries();

    expect(mockRelayById).toHaveBeenCalledTimes(1);
    expect(rows[0]!.relayAckedNoteIds).toEqual(['0xmalformed']);
    expect(rows[0]!.nextRelayAt).toBeGreaterThan(NOW);
  });

  it('goes on with the next row when one row fails', async () => {
    rows.push(due('failing', NOW - 2000), due('next', NOW - 1000));
    mockRecord.mockRejectedValueOnce(new Error('store closed'));

    await sweepNoteDeliveries();

    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xfailing', '0xnext']);
  });

  // An endpoint change clears the ledger, and the sweep must not go on sitting out a window that no longer exists.
  it('pushes again as soon as the note-delivery fuse goes out, inside the window it had', async () => {
    for (let eviction = 0; eviction < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; eviction++) {
      noteSyncWatchdogEviction('note-delivery');
    }
    rows.push(due('first', NOW - 1000));

    await sweepNoteDeliveries();
    expect(mockRelayById).not.toHaveBeenCalled();

    clearSyncFuseForEndpointChange();
    clock = NOW + 60;
    await sweepNoteDeliveries();

    expect(mockRelayById).toHaveBeenCalledTimes(1);
  });

  // The receipt is a local read: its health says nothing about whether the push parks.
  it('lights the note-delivery fuse on evicted pushes despite healthy receipts, and no receipt clears it', async () => {
    rows.push(due('first', NOW - 1000));
    mockRelayById.mockRejectedValue(new WasmClientPoisonedError('watchdog', new Error('push parked')));

    for (let pass = 0; pass < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; pass++) {
      await sweepNoteDeliveries();
      clock = rows[0]!.nextRelayAt!;
    }
    expect(isSyncFused('note-delivery')).toBe(true);

    await sweepNoteDeliveries();

    expect(mockRelayById).toHaveBeenCalledTimes(MAX_CONSECUTIVE_WATCHDOG_EVICTIONS);
    expect(receiptTimes).toHaveLength(MAX_CONSECUTIVE_WATCHDOG_EVICTIONS + 1);
    expect(isSyncFused('note-delivery')).toBe(true);
  });
});

// Hosted on every sync lap of every platform, so a call must cost nothing when nothing is due and
// never start a second pass beside a running one.
describe('when a pass runs', () => {
  const { recordNoteDelivery } = jest.requireActual<typeof import('./helper')>('./helper');

  it('runs one pass for two calls that overlap', async () => {
    rows.push(row({ noteDelivery: 'pending' }));
    let release: () => void = () => {};
    mockRelayById.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        })
    );

    const first = sweepNoteDeliveries();
    const second = sweepNoteDeliveries();
    for (let turn = 0; turn < 50 && mockRelayById.mock.calls.length === 0; turn++) await Promise.resolve();
    release();
    await Promise.all([first, second]);

    expect(mockRelayById).toHaveBeenCalledTimes(1);
    expect(queries()).toBe(1);
  });

  it('does not query when nothing is due', async () => {
    rows.push(row({ nextRelayAt: NOW + 600 }));

    await sweepNoteDeliveries();
    await sweepNoteDeliveries();

    expect(queries()).toBe(1);
  });

  it('queries again once the earliest row is due', async () => {
    rows.push(row({ nextRelayAt: NOW + 600 }));

    await sweepNoteDeliveries();
    jest.spyOn(Date, 'now').mockReturnValue((NOW + 600) * 1000);
    await sweepNoteDeliveries();

    expect(queries()).toBe(2);
    expect(mockRelayById).toHaveBeenCalledTimes(1);
  });

  it('queries again after a delivery write, however far off the next row is', async () => {
    rows.push(row({ nextRelayAt: NOW + 600 }));

    await sweepNoteDeliveries();
    await recordNoteDelivery('tx-1', 'pending');
    await sweepNoteDeliveries();

    expect(queries()).toBe(2);
  });

  it('queries at least hourly while idle, for rows no delivery write announced', async () => {
    rows.push(row({ nextRelayAt: NOW + 3 * HOUR }));

    await sweepNoteDeliveries();
    jest.spyOn(Date, 'now').mockReturnValue((NOW + HOUR) * 1000);
    await sweepNoteDeliveries();

    expect(queries()).toBe(2);
  });

  it('never rejects, so a caller may fire it and forget it', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.mocked(Repo.transactions.where).mockImplementationOnce(() => {
      throw new Error('store closed');
    });

    await expect(sweepNoteDeliveries()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

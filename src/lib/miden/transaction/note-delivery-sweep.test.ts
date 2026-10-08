/**
 * Tests for the private-note delivery sweep: when it pushes again, when it stops,
 * and how it reads each outcome.
 *
 * A relay acknowledgement may insert a missing note or acknowledge an existing one.
 * Neither outcome proves receipt by the recipient. So the row must be neither condemned
 * as `undelivered` nor promoted to `confirmed`. `note-delivery-sweep.ts` has the why.
 */

import { OperationAbortedError } from 'lib/miden/back/offscreen-codec';
import * as Repo from 'lib/miden/repo';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';

import { INoteDeliveryState, ITransaction, ITransactionStatus, ITransactionType } from '../db/types';
import { NoteTypeEnum } from '../types';
import {
  __resetNoteDeliverySweepForTests,
  classifyRelayFailure,
  MAX_RELAY_ATTEMPTS,
  RelayFailureClass,
  sweepNoteDeliveries
} from './note-delivery-sweep';

const NOW = 1_800_000_000;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The text a 0.17.2 send failure reaches JS with, for the given gRPC code. */
const sendFailure = (code: string) =>
  new Error(
    'failed sending private output note: note transport error: note transport network error: ' +
      `Send note with proof failed: Status { code: ${code}, message: "transport said no", source: None }`
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
    ],
    [
      'a custom row whose one note could not be converted for relay',
      {
        type: 'execute',
        relayNoteIds: ['0xnote'],
        relayRecipientId: 'mtst1recipient',
        relayDeadNoteIds: ['0xnote'],
        noteDelivery: 'undelivered'
      }
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
  ])('stops the pass and changes nothing on %s', async (_kind, makeError) => {
    rows.push(due('first', NOW - 2000), due('second', NOW - 1000));
    const before = rows.map(tx => ({ ...tx }));
    mockRelayById.mockRejectedValue(makeError());

    await sweepNoteDeliveries();

    expect(mockRelayById).toHaveBeenCalledTimes(1);
    expect(rows).toEqual(before);
  });
});

describe('classifyRelayFailure', () => {
  const OFFSCREEN = "Offscreen call 'relayPrivateNoteById' failed: ";
  const SEND = 'failed sending private output note: note transport error: ';

  it.each<[string, RelayFailureClass]>([
    ['No output note found for the given id', 'storeLoss'],
    ['output note has no details to relay (recipient unknown): the note record is missing its details', 'storeLoss'],
    ['output note has no inclusion proof; sync past the block that committed it', 'noteLocal'],
    [
      SEND + 'note transport is disabled; enable it in the client configuration to send or receive notes via P2P',
      'notConfigured'
    ],
    [sendFailure('Unavailable').message, 'outage'],
    [sendFailure('DeadlineExceeded').message, 'outage'],
    [sendFailure('ResourceExhausted').message, 'outage'],
    [sendFailure('Cancelled').message, 'outage'],
    [sendFailure('Internal').message, 'outage'],
    [
      SEND +
        'note transport network error: Send note with proof failed: ' +
        'Status { code: Unknown, message: "JS API error: TypeError: Failed to fetch", source: None }',
      'outage'
    ],
    [sendFailure('InvalidArgument').message, 'noteLocal'],
    [sendFailure('FailedPrecondition').message, 'noteLocal'],
    [SEND + 'connection error: transport error', 'outage'],
    ['nothing this sweep has seen before', 'outage']
  ])('reads %p as %s, with or without the offscreen prefix', (message, expected) => {
    expect(classifyRelayFailure(new Error(message))).toBe(expected);
    expect(classifyRelayFailure(new Error(OFFSCREEN + message))).toBe(expected);
  });

  it.each<[string, unknown]>([
    ['a lock eviction', new WasmClientPoisonedError('watchdog')],
    ['an offscreen kill', new OperationAbortedError('op-1', 'deadline')],
    ['a wrapped lock eviction', new Error('relay failed', { cause: new WasmClientPoisonedError('realm-error') })]
  ])('reads %s as interrupted', (_kind, error) => {
    expect(classifyRelayFailure(error)).toBe('interrupted');
  });

  it('reads a thrown string as an outage', () => {
    expect(classifyRelayFailure('fetch failed')).toBe('outage');
  });
});

// Hosted on every sync lap of every platform, so a call must cost nothing when nothing is due and
// never start a second pass beside a running one.
describe('when a pass runs', () => {
  const { recordNoteDelivery } = jest.requireActual<typeof import('./helper')>('./helper');
  const queries = () =>
    jest.mocked(Repo.transactions.where).mock.calls.filter(([arg]) => arg === 'noteDelivery').length;

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

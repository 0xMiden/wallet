/**
 * Tests for the private-note delivery sweep: when it pushes again, when it stops,
 * and how it reads each outcome.
 *
 * A relay acknowledgement may insert a missing note or acknowledge an existing one.
 * Neither outcome proves receipt by the recipient. So the row must be neither condemned
 * as `undelivered` nor promoted to `confirmed`. `note-delivery-sweep.ts` has the why.
 */

import { INoteDeliveryState, ITransaction, ITransactionStatus, ITransactionType } from '../db/types';
import { NoteTypeEnum } from '../types';
import { MAX_RELAY_ATTEMPTS, sweepNoteDeliveries } from './note-delivery-sweep';

const NOW = 1_800_000_000;

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

  it('re-pushes an unconsumed note and schedules the next attempt', async () => {
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
      rows.push(row({ relayAttempts: attempts }));

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

  it('stops pushing once the attempt cap is reached', async () => {
    rows.push(row({ relayAttempts: MAX_RELAY_ATTEMPTS }));

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('ignores sends older than the sweep window', async () => {
    // Beyond the window this client may no longer track the output note at all, so
    // a re-push could only fail - and would light up a warning on an old, fine send.
    rows.push(row({ initiatedAt: NOW - 7 * 60 * 60 }));

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('measures the window from the relay, so a send that waited in the queue is still swept', async () => {
    // `initiatedAt` is stamped at queue time; a send that sat queued for hours (the app
    // was closed) relays when it completes, and its delivery is due from then.
    rows.push(row({ initiatedAt: NOW - 7 * 60 * 60, completedAt: NOW - 600 }));

    await sweepNoteDeliveries();

    expect(mockRelayById).toHaveBeenCalledTimes(1);
  });

  it('still ignores a send relayed before the window', async () => {
    rows.push(row({ initiatedAt: NOW - 8 * 60 * 60, completedAt: NOW - 7 * 60 * 60 }));

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
    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'relayed');
    expect(rows[0]!.relayAttempts).toBe(2);
  });

  it('reads a rejection carrying the transport duplicate text as a failed re-push', async () => {
    // The SDK fetch boundary (`note-relay-fetch.mjs`) turns a stored note's duplicate into
    // an ACK before the sweep sees it. One that still arrives as a rejection was not
    // recognized there, so its outbox entry is stuck, and the row must not hide that.
    rows.push(row({ noteDelivery: 'pending' }));
    mockRelayById.mockRejectedValue(
      new Error(
        "Offscreen call 'relayPrivateNoteById' failed: Failed to store note: " +
          'ConstraintViolation("Unique constraint violation: UNIQUE constraint failed: notes.id")'
      )
    );

    await sweepNoteDeliveries();

    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'undelivered');
    expect(rows[0]!.relayAttempts).toBe(2);
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

  it('says so once when a row exhausts its attempts without a receipt', async () => {
    // At the cap the row leaves the candidate set for good - no further push, and no
    // further nullifier check either - while `relayed` renders as nothing at all in
    // history. Without this line, giving up leaves no trace anywhere.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    rows.push(row({ relayAttempts: MAX_RELAY_ATTEMPTS - 1 }));

    await sweepNoteDeliveries();

    expect(warn.mock.calls.filter(call => String(call[0]).includes('attempts exhausted'))).toHaveLength(1);
  });

  it('does not announce exhaustion for a row the nullifier just retired', async () => {
    // The receipt check exits before the attempt is even counted, so a row confirmed
    // on its last eligible cycle has not exhausted anything - it succeeded.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    rows.push(row({ relayAttempts: MAX_RELAY_ATTEMPTS - 1 }));
    mockIsConsumed.mockResolvedValue(true);

    await sweepNoteDeliveries();

    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'confirmed');
    expect(warn.mock.calls.map(call => String(call[0]))).not.toContainEqual(
      expect.stringContaining('attempts exhausted')
    );
  });

  it('does not announce exhaustion while attempts remain', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    rows.push(row({ relayAttempts: 1 }));

    await sweepNoteDeliveries();

    expect(mockRelayById).toHaveBeenCalledTimes(1);
    expect(rows[0]!.relayAttempts).toBe(2);
    expect(warn.mock.calls.map(call => String(call[0]))).not.toContainEqual(
      expect.stringContaining('attempts exhausted')
    );
  });

  it('marks a never-ACKed row undelivered when the re-push fails', async () => {
    rows.push(row({ noteDelivery: 'pending' }));
    mockRelayById.mockRejectedValue(new Error('transport unreachable'));

    await sweepNoteDeliveries();

    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'undelivered');
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

  it('stays on an older two-note row with no relayNoteIds, which the sweep neither re-pushes nor records', async () => {
    const displayMessage = UNDELIVERED_CUSTOM;
    rows.push(
      row({ type: 'execute', outputNoteIds: ['0xnote', '0xnote2'], noteDelivery: 'undelivered', displayMessage })
    );

    await sweepNoteDeliveries();

    expect(mockIsConsumed).not.toHaveBeenCalled();
    expect(mockRelayById).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({
      noteDelivery: 'undelivered',
      relayAttempts: 1,
      nextRelayAt: NOW - 1,
      displayMessage
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

  it('stays on a row owing two private notes, which the sweep neither re-pushes nor records', async () => {
    rows.push(
      row({
        type: 'execute',
        outputNoteIds: ['0xprivate1', '0xprivate2', '0xpublic'],
        relayNoteIds: ['0xprivate1', '0xprivate2'],
        noteDelivery: 'undelivered',
        displayMessage: UNDELIVERED_CUSTOM
      })
    );

    await sweepNoteDeliveries();

    expect(mockIsConsumed).not.toHaveBeenCalled();
    expect(mockRelayById).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({
      noteDelivery: 'undelivered',
      relayAttempts: 1,
      displayMessage: UNDELIVERED_CUSTOM
    });
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

    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'undelivered');
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

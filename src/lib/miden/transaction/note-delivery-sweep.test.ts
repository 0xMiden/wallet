/**
 * Tests for the private-note delivery sweep: when it pushes again, when it stops,
 * and how it reads each outcome.
 *
 * The distinction most of them pin down is that an ACCEPTED re-push both detects and
 * repairs a silently-lost note, whereas one REJECTED as a duplicate repairs nothing
 * — it only proves the original relay arrived. So the row must be neither condemned
 * as `undelivered` nor promoted to `confirmed`. `note-delivery-sweep.ts` has the why.
 */

import { ITransaction, ITransactionStatus, ITransactionType } from '../db/types';
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
            // missing `continue` — it did, until this was fixed.
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

const mockRecord = jest.fn<Promise<void>, [string, string]>();

jest.mock('./helper', () => ({
  recordNoteDelivery: (id: string, state: string) => mockRecord(id, state)
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
    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'relayed');
    expect(rows[0]!.relayAttempts).toBe(2);
    expect(rows[0]!.nextRelayAt).toBeGreaterThan(NOW);
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

  it('arms an old row from its send time, so a late first sighting is due at once', async () => {
    // The wait exists because the original relay just happened — which is false for a
    // row first seen hours later (wallet closed, or first sync since the send). Arming
    // another full wait from now would push its only attempts toward the far end of
    // the sweep window, or past it, leaving a genuinely lost note never re-pushed.
    rows.push(row({ nextRelayAt: undefined, initiatedAt: NOW - 3 * 60 * 60 }));

    await sweepNoteDeliveries();

    expect(mockRelayById).not.toHaveBeenCalled();
    expect(rows[0]!.nextRelayAt).toBeLessThanOrEqual(NOW);
  });

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
    // a re-push could only fail — and would light up a warning on an old, fine send.
    rows.push(row({ initiatedAt: NOW - 7 * 60 * 60 }));

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

  it('does not condemn a never-ACKed row when the re-push is rejected as a duplicate', async () => {
    rows.push(row({ noteDelivery: 'pending' }));
    // A duplicate rejection proves the original relay reached the transport, so the
    // row must not be downgraded on the strength of it.
    mockRelayById.mockRejectedValue(
      new Error('Failed to store note: ConstraintViolation("UNIQUE constraint failed: notes.id")')
    );

    await sweepNoteDeliveries();

    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'relayed');
    expect(mockRecord).not.toHaveBeenCalledWith('tx-1', 'undelivered');
  });

  it('does NOT claim delivery on a duplicate rejection — the note may be stored yet unreachable', async () => {
    // The whole point of the sweep (note-transport-service#77) is that a stored note
    // can sit below the recipient's cursor and be unreachable forever. A duplicate
    // rejection says the bytes are stored, which is exactly that state — so it must
    // never be promoted to `confirmed`, whose UI copy asserts the recipient spent it.
    // The row also has to stay sweepable so the nullifier check can still confirm it.
    rows.push(row({ noteDelivery: 'undelivered' }));
    mockRelayById.mockRejectedValue(
      new Error('Failed to store note: ConstraintViolation("UNIQUE constraint failed: notes.id")')
    );

    await sweepNoteDeliveries();

    expect(mockRecord).not.toHaveBeenCalledWith('tx-1', 'confirmed');
    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'relayed');
  });

  it('counts the attempt on a duplicate rejection so the row still retires', async () => {
    // Without this the row would be re-pushed on every sweep cycle for the whole
    // relay window, and each push is rejected again — pure traffic. The counter is
    // what bounds it.
    rows.push(row({ noteDelivery: 'pending' }));
    mockRelayById.mockRejectedValue(
      new Error('Failed to store note: ConstraintViolation("UNIQUE constraint failed: notes.id")')
    );

    await sweepNoteDeliveries();

    expect(rows[0]!.relayAttempts).toBe(2);
    expect(rows[0]!.nextRelayAt).toBeGreaterThan(NOW);
  });

  it.each([
    ['the Display spelling', 'grpc error: status: AlreadyExists, message: "note stored"'],
    ['the Debug spelling', 'Status { code: AlreadyExists, message: "note stored" }'],
    ['a gRPC-web trailer', 'unexpected trailer: grpc-status: 6, grpc-message: note already stored'],
    ['the numeric code', 'rpc failed: code: 6, message: the note already exists']
  ])('reads a proper AlreadyExists status the same way — %s', async (_label, message) => {
    // So a service that starts returning a distinguishable status keeps working
    // without a wallet change.
    rows.push(row({ noteDelivery: 'pending' }));
    mockRelayById.mockRejectedValue(new Error(message));

    await sweepNoteDeliveries();

    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'relayed');
    expect(mockRecord).not.toHaveBeenCalledWith('tx-1', 'undelivered');
  });

  it('reads the duplicate rejection through the offscreen wrapper, which is what the SW sees', async () => {
    // With the offscreen client on — the extension default — the sweep never sees
    // the raw rejection. `dispatchOp` rebuilds it as this shape, so that is the only
    // string the classifier is actually handed on the primary platform.
    rows.push(row({ noteDelivery: 'pending' }));
    mockRelayById.mockRejectedValue(
      new Error(
        "Offscreen call 'relayPrivateNoteById' failed: Failed to store note: " +
          'ConstraintViolation("UNIQUE constraint failed: notes.id")'
      )
    );

    await sweepNoteDeliveries();

    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'relayed');
    expect(mockRecord).not.toHaveBeenCalledWith('tx-1', 'undelivered');
  });

  it('does not read an unrelated transport error as a duplicate', async () => {
    rows.push(row({ noteDelivery: 'pending' }));
    mockRelayById.mockRejectedValue(new Error('503 service unavailable'));

    await sweepNoteDeliveries();

    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'undelivered');
  });

  // The classifier matches on message TEXT, and a match suppresses the delivery
  // warning — so an over-broad pattern hides the very failure this sweep surfaces.
  // These are the near-miss strings the same call path can genuinely produce.
  it.each([
    ['a UNIQUE violation on a different column', 'ConstraintViolation("UNIQUE constraint failed: notes.seq")'],
    // The service funnels every constraint kind through one `ConstraintViolation`
    // variant, so these read almost identically to a duplicate while meaning the
    // opposite: the row was never stored.
    ['a NOT NULL failure on the same column', 'ConstraintViolation("NOT NULL constraint failed: notes.id")'],
    ['a foreign-key failure on the same column', 'ConstraintViolation("FOREIGN KEY constraint failed: notes.id")'],
    ["tonic's stock AlreadyExists blurb", 'Some entity that we attempted to create already exists'],
    ['an SDK account-tree collision', 'account ID prefix already exists in the tree'],
    ['an SDK asset-vault collision', 'the non-fungible asset already exists in the asset vault'],
    ['a Dexie/IndexedDB constraint error', 'ConstraintError: Key already exists in the object store'],
    ['a bare constraint violation', 'ConstraintViolation']
  ])('still reports undelivered for %s', async (_label, message) => {
    rows.push(row({ noteDelivery: 'pending' }));
    mockRelayById.mockRejectedValue(new Error(message));

    await sweepNoteDeliveries();

    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'undelivered');
  });

  it.each([['pending'], ['undelivered'], ['relayed']] as const)(
    'records an accepted re-push as relayed from a %s prior',
    async priorState => {
      // Acceptance is the silent-loss case whatever the row said before: the note was
      // not on the transport and now is, at a fresh `seq`.
      rows.push(row({ noteDelivery: priorState }));
      mockRelayById.mockResolvedValue(undefined);

      await sweepNoteDeliveries();

      expect(mockRecord).toHaveBeenCalledWith('tx-1', 'relayed');
      expect(mockRecord).not.toHaveBeenCalledWith('tx-1', 'undelivered');
      expect(rows[0]!.relayAttempts).toBe(2);
    }
  );

  it('reports an accepted re-push at error level only when the row already held an ACK', async () => {
    // This one line is the incident signal the whole feature is for: an ACK that did
    // not produce a stored note means the ACK was worthless. From `pending` the same
    // acceptance is just the sweep working, and crying wolf there would bury it.
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    rows.push(row({ id: 'acked', noteDelivery: 'relayed', initiatedAt: NOW - 600 }));
    rows.push(row({ id: 'never-acked', noteDelivery: 'pending', initiatedAt: NOW - 60 }));

    await sweepNoteDeliveries();

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![1]).toMatchObject({ txId: 'acked' });
    expect(warn.mock.calls.map(call => call[1])).toContainEqual(expect.objectContaining({ txId: 'never-acked' }));
  });

  it('says so once when a row exhausts its attempts without a receipt', async () => {
    // At the cap the row leaves the candidate set for good — no further push, and no
    // further nullifier check either — while `relayed` renders as nothing at all in
    // history. Without this line, giving up leaves no trace anywhere.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    rows.push(row({ relayAttempts: MAX_RELAY_ATTEMPTS - 1 }));

    await sweepNoteDeliveries();

    expect(warn.mock.calls.map(call => String(call[0]))).toContainEqual(expect.stringContaining('attempts exhausted'));
  });

  it('does not announce exhaustion while attempts remain', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    rows.push(row({ relayAttempts: 1 }));

    await sweepNoteDeliveries();

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
    // burning the attempt budget back to back — which is what these delays exist to
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
});

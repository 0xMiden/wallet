/**
 * Tests for the private-note delivery sweep.
 *
 * The sweep exists because a transport ACK is not a delivery: the recipient reaches
 * a private note only through a paginated fetch whose cursor, once advanced past a
 * stored note, never comes back to it (note-transport-service#77). A re-push lands
 * a fresh cursor position and escapes that, so these tests pin down when the sweep
 * pushes again, when it stops, and — just as importantly — when it must NOT invent
 * a delivery problem.
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
            toArray: async () => rows.filter(row => states.includes(String(row.noteDelivery)))
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
    // The transport inserts against `notes.id BLOB PRIMARY KEY` with no `ON
    // CONFLICT`, so re-pushing a note it already holds is rejected. That proves the
    // original relay reached the transport, so the row must not be downgraded.
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

  it('reads a proper AlreadyExists status the same way', async () => {
    // So a service that starts returning a distinguishable status keeps working
    // without a wallet change.
    rows.push(row({ noteDelivery: 'pending' }));
    mockRelayById.mockRejectedValue(new Error('grpc error: status: AlreadyExists, message: "note stored"'));

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

  it('keeps an accepted re-push as relayed — acceptance means the note was missing', async () => {
    rows.push(row({ noteDelivery: 'relayed' }));
    mockRelayById.mockResolvedValue(undefined);

    await sweepNoteDeliveries();

    // Acceptance is the silent-loss case: the note was not on the transport and now
    // is, on a fresh cursor position. It stays `relayed` until a nullifier proves
    // the recipient actually consumed it.
    expect(mockRecord).toHaveBeenCalledWith('tx-1', 'relayed');
    expect(rows[0]!.relayAttempts).toBe(2);
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

  it('drains a backlog oldest-send-first', async () => {
    rows.push(row({ id: 'newer', initiatedAt: NOW - 60, outputNoteIds: ['0xnewer'] }));
    rows.push(row({ id: 'older', initiatedAt: NOW - 600, outputNoteIds: ['0xolder'] }));

    await sweepNoteDeliveries();

    expect(mockRelayById.mock.calls.map(([noteId]) => noteId)).toEqual(['0xolder', '0xnewer']);
  });
});

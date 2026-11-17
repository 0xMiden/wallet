import { NoteType } from '@miden-sdk/miden-sdk/lazy';

import {
  normalizeHex,
  parseSubmitEvidence,
  privateOutputNoteIdsOf,
  readSubmitEvidence,
  type EvidenceProof,
  type EvidenceResult
} from './submit-evidence';

const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
/** `count` distinct well-formed ids, none of them a fixture's. */
const ids = (count: number, from = 0x10000) => Array.from({ length: count }, (_, i) => hex(from + i));
const word = (value: string) => ({ toHex: () => value });
const note = (id: string, noteType: NoteType = NoteType.Public) => ({
  id: () => ({ toString: () => id }),
  metadata: () => ({ noteType: () => noteType })
});
const header = (commitment: string, nonce: bigint) => ({
  to_commitment: () => word(commitment),
  nonce: () => ({ asInt: () => nonce })
});

const result = (overrides: Partial<ReturnType<EvidenceResult['executedTransaction']>> = {}): EvidenceResult => ({
  executedTransaction: () => ({
    id: () => word(hex(1)),
    initialAccountHeader: () => header(hex(2), 4n),
    finalAccountHeader: () => header(hex(3), 5n),
    userOutputNotes: () => [note(hex(9))],
    ...overrides
  })
});

const proof = (overrides: Partial<EvidenceProof> = {}): EvidenceProof => ({
  nullifiers: () => [word(hex(7))],
  refBlockNumber: () => 100,
  refBlockCommitment: () => word(hex(6)),
  expirationBlockNumber: () => 700,
  ...overrides
});

describe('readSubmitEvidence (#1081)', () => {
  it('reads every field', () => {
    expect(readSubmitEvidence(result(), proof(), () => true)).toEqual({
      transactionId: hex(1),
      initialCommitment: hex(2),
      finalCommitment: hex(3),
      initialNonce: '4',
      outputNoteIds: [hex(9)],
      privateOutputNoteIds: [],
      nullifiers: [hex(7)],
      refBlock: 100,
      refBlockCommitment: hex(6),
      expirationBlock: 700
    });
  });

  it('reads each field on its own: one that throws is left out, the rest survive', () => {
    const evidence = readSubmitEvidence(
      result({
        finalAccountHeader: () => {
          throw new Error('freed');
        }
      }),
      proof({
        nullifiers: () => {
          throw new Error('freed');
        }
      }),
      () => true
    );
    expect(evidence.finalCommitment).toBeUndefined();
    expect(evidence.nullifiers).toBeUndefined();
    expect(evidence.initialCommitment).toBe(hex(2));
    expect(evidence.refBlock).toBe(100);
  });

  it.each([
    {
      field: "the result's final account header",
      arrange: (trap: WebAssembly.RuntimeError) => {
        const userOutputNotes = jest.fn(() => [note(hex(9))]);
        const nullifiers = jest.fn(() => [word(hex(7))]);
        return {
          result: result({
            finalAccountHeader: () => {
              throw trap;
            },
            userOutputNotes
          }),
          proof: proof({ nullifiers }),
          later: [userOutputNotes, nullifiers]
        };
      }
    },
    {
      field: "the proof's reference block commitment",
      arrange: (trap: WebAssembly.RuntimeError) => {
        const expirationBlockNumber = jest.fn(() => 700);
        return {
          result: result(),
          proof: proof({
            refBlockCommitment: () => {
              throw trap;
            },
            expirationBlockNumber
          }),
          later: [expirationBlockNumber]
        };
      }
    }
  ])('a trap in $field leaves as itself and no later field is read', ({ arrange }) => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    const { result: trapping, proof: proven, later } = arrange(trap);

    let caught: unknown;
    try {
      readSubmitEvidence(trapping, proven, () => true);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(trap);
    for (const read of later) expect(read).not.toHaveBeenCalled();
  });

  it('tells a known-empty note list from an unreadable one', () => {
    expect(readSubmitEvidence(result({ userOutputNotes: () => [] }), proof(), () => true).outputNoteIds).toEqual([]);
    const unreadable = readSubmitEvidence(
      result({
        userOutputNotes: () => {
          throw new Error('x');
        }
      }),
      proof(),
      () => true
    );
    expect(unreadable.outputNoteIds).toBeUndefined();
  });

  // A landed execute that kept no read of its result owes these to its recipient, so they come off the same notes.
  it('records the private user output notes apart from outputNoteIds, from one read of the notes', () => {
    const userOutputNotes = jest.fn(() => [note(hex(0xa1)), note(hex(0xa2), NoteType.Private), note(hex(0xa3))]);

    const evidence = readSubmitEvidence(result({ userOutputNotes }), proof(), () => true);

    expect(evidence.outputNoteIds).toEqual([hex(0xa1), hex(0xa2), hex(0xa3)]);
    expect(evidence.privateOutputNoteIds).toEqual([hex(0xa2)]);
    expect(userOutputNotes).toHaveBeenCalledTimes(1);
  });

  it("leaves the private notes out, keeping outputNoteIds, when any note's type does not read, never a shorter list", () => {
    const unreadable = {
      ...note(hex(0xa2), NoteType.Private),
      metadata: () => {
        throw new Error('freed');
      }
    };
    const evidence = readSubmitEvidence(
      result({ userOutputNotes: () => [note(hex(0xa1), NoteType.Private), unreadable, note(hex(0xa3))] }),
      proof(),
      () => true
    );

    expect(evidence.outputNoteIds).toEqual([hex(0xa1), hex(0xa2), hex(0xa3)]);
    expect(evidence).not.toHaveProperty('privateOutputNoteIds');
    // Unknown, not none: an unreadable list is never recorded as an empty one either.
    expect(
      readSubmitEvidence(
        result({
          userOutputNotes: () => {
            throw new Error('freed');
          }
        }),
        proof(),
        () => true
      )
    ).not.toHaveProperty('privateOutputNoteIds');
  });

  // The fee note is created by the kernel, and only `outputNotes` lists it; it must never reach the counterparty.
  it('reads the private notes off the user output notes only, never the list that holds the fee note', () => {
    const outputNotes = jest.fn(() => ({ notes: () => [note(hex(0xfe), NoteType.Private)] }));
    const executed = { ...result().executedTransaction(), outputNotes };

    const evidence = readSubmitEvidence({ executedTransaction: () => executed }, proof(), () => true);

    expect(evidence.privateOutputNoteIds).toEqual([]);
    expect(outputNotes).not.toHaveBeenCalled();
  });

  it("lets a trap reading a note's type leave as itself, before any proof field is read", () => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    const nullifiers = jest.fn(() => [word(hex(7))]);
    const trapping = {
      ...note(hex(0xa2)),
      metadata: () => {
        throw trap;
      }
    };

    let caught: unknown;
    try {
      readSubmitEvidence(result({ userOutputNotes: () => [trapping] }), proof({ nullifiers }), () => true);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(trap);
    expect(nullifiers).not.toHaveBeenCalled();
  });

  it('keeps an expiration only inside the range a delta can produce', () => {
    expect(
      readSubmitEvidence(result(), proof({ expirationBlockNumber: () => 100 }), () => true).expirationBlock
    ).toBeUndefined();
    expect(
      readSubmitEvidence(result(), proof({ expirationBlockNumber: () => 100 + 65535 }), () => true).expirationBlock
    ).toBe(65635);
    expect(
      readSubmitEvidence(result(), proof({ expirationBlockNumber: () => 0xffffffff }), () => true).expirationBlock
    ).toBeUndefined();
  });

  it('reads nothing once the hold is no longer current', () => {
    expect(readSubmitEvidence(result(), proof(), () => false)).toEqual({});
  });

  // Review Focus 1: a case mismatch with node reads would make row 5 prove a landed attempt dead.
  it('lower-cases every id, commitment and nullifier', () => {
    // Values with hex letters: hex(1)..hex(9) are digits only, so upper-casing them would leave nothing to lower.
    const upper = (n: number) => hex(n).toUpperCase().replace('0X', '0x');
    expect(upper(0xa1)).not.toBe(hex(0xa1));
    const evidence = readSubmitEvidence(
      result({
        id: () => word(upper(0xa1)),
        initialAccountHeader: () => header(upper(0xa2), 4n),
        finalAccountHeader: () => header(upper(0xa3), 5n),
        userOutputNotes: () => [note(upper(0xb9), NoteType.Private)]
      }),
      proof({ nullifiers: () => [word(upper(0xc7))], refBlockCommitment: () => word(upper(0xd6)) }),
      () => true
    );
    expect(evidence.transactionId).toBe(hex(0xa1));
    expect(evidence.initialCommitment).toBe(hex(0xa2));
    expect(evidence.finalCommitment).toBe(hex(0xa3));
    expect(evidence.outputNoteIds).toEqual([hex(0xb9)]);
    expect(evidence.privateOutputNoteIds).toEqual([hex(0xb9)]);
    expect(evidence.nullifiers).toEqual([hex(0xc7)]);
    expect(evidence.refBlockCommitment).toBe(hex(0xd6));
  });
});

describe('parseSubmitEvidence (#1081)', () => {
  const valid = {
    transactionId: hex(1),
    initialCommitment: hex(2),
    finalCommitment: hex(3),
    initialNonce: '4',
    outputNoteIds: [hex(9)],
    nullifiers: [],
    refBlock: 100,
    refBlockCommitment: hex(6),
    expirationBlock: 700
  };

  it('accepts well-formed evidence and drops unknown keys', () => {
    expect(parseSubmitEvidence({ ...valid, attemptId: 'smuggled', extra: 1 })).toEqual(valid);
  });

  it('lower-cases what it accepts', () => {
    expect(
      parseSubmitEvidence({ ...valid, transactionId: hex(0xab).toUpperCase().replace('0X', '0x') })?.transactionId
    ).toBe(hex(0xab));
  });

  it.each<[string, Record<string, unknown>]>([
    ['a short id', { transactionId: '0x12' }],
    ['a non-hex commitment', { initialCommitment: `0x${'g'.repeat(64)}` }],
    ['a negative block', { refBlock: -1 }],
    ['a fractional block', { refBlock: 1.5 }],
    ['an unsafe block', { expirationBlock: Number.MAX_SAFE_INTEGER + 1 }],
    ['a hex nonce', { initialNonce: '0x4' }],
    ['a list that is not an array', { nullifiers: hex(7) }],
    ['a list with a bad member', { outputNoteIds: [hex(9), 'nope'] }],
    ['a note list over 1024 distinct entries', { outputNoteIds: ids(1025), privateOutputNoteIds: ids(1) }],
    ['a nullifier list over 1024 distinct entries', { nullifiers: ids(1025) }]
  ])('rejects %s', (_label, bad) => {
    expect(parseSubmitEvidence({ ...valid, ...bad })).toBeUndefined();
  });

  // A transaction creates up to 1024 notes and consumes up to 1024, so a list that long is evidence, not a malformed one.
  it.each([300, 1024])('keeps %i distinct note ids and nullifiers, with a private subset', count => {
    const outputNoteIds = ids(count);
    const evidence = {
      ...valid,
      outputNoteIds,
      privateOutputNoteIds: [outputNoteIds[0], outputNoteIds[count - 1]],
      nullifiers: ids(count, 0x20000)
    };
    expect(parseSubmitEvidence(evidence)).toEqual(evidence);
  });

  it('answers undefined for anything that is not an object, and never throws', () => {
    expect(parseSubmitEvidence(undefined)).toBeUndefined();
    expect(parseSubmitEvidence('evidence')).toBeUndefined();
    expect(parseSubmitEvidence([valid])).toBeUndefined();
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('trap');
        }
      }
    );
    expect(parseSubmitEvidence(hostile)).toBeUndefined();
  });

  it('accepts partial evidence: an absent field is an unreadable one', () => {
    expect(parseSubmitEvidence({ refBlock: 3 })).toEqual({ refBlock: 3 });
  });

  // A single-key swap's leaf names its order on the stamp, the only record of it that crosses before the submit.
  it('keeps a swap order that crossed as a well-formed pair, its note id lower-cased', () => {
    const orderNoteId = hex(0xab).toUpperCase().replace('0X', '0x');
    expect(parseSubmitEvidence({ ...valid, orderId: '42', orderNoteId })).toEqual({
      ...valid,
      orderId: '42',
      orderNoteId: hex(0xab)
    });
  });

  // The order is a landed fact, not verdict evidence, so one that is not a whole pair costs only itself.
  it.each<[string, Record<string, unknown>]>([
    ['an order with no note', { orderId: '42' }],
    ['a note with no order', { orderNoteId: hex(0xab) }],
    ['a hex order id', { orderId: '0x2a', orderNoteId: hex(0xab) }],
    ['an order id past the field', { orderId: '18446744069414584321', orderNoteId: hex(0xab) }],
    ['a short note id', { orderId: '42', orderNoteId: '0x12' }]
  ])('drops %s and keeps the rest of the evidence', (_label, order) => {
    expect(parseSubmitEvidence({ ...valid, ...order })).toEqual(valid);
  });

  // Read with outputNoteIds off the same notes, so a list that is not part of them is not that read.
  it('keeps privateOutputNoteIds that are part of outputNoteIds, lower-cased, and a known empty one', () => {
    const outputNoteIds = [hex(9), hex(0xab)];
    const privateNote = hex(0xab).toUpperCase().replace('0X', '0x');
    expect(parseSubmitEvidence({ ...valid, outputNoteIds, privateOutputNoteIds: [privateNote] })).toEqual({
      ...valid,
      outputNoteIds,
      privateOutputNoteIds: [hex(0xab)]
    });
    expect(parseSubmitEvidence({ ...valid, privateOutputNoteIds: [] })).toEqual({ ...valid, privateOutputNoteIds: [] });
  });

  // A whole list or none: a parser that kept the well-formed part would owe the recipient a shorter list.
  it.each<[string, Record<string, unknown>]>([
    ['a list that is not an array', { privateOutputNoteIds: hex(9) }],
    ['a list with a malformed member after a valid one', { privateOutputNoteIds: [hex(9), 'nope'] }],
    ['a list that repeats a note', { privateOutputNoteIds: [hex(9), hex(9)] }],
    ['a note outputNoteIds does not name', { privateOutputNoteIds: [hex(9), hex(0xab)] }],
    ['a list that crossed without outputNoteIds', { outputNoteIds: undefined, privateOutputNoteIds: [hex(9)] }],
    // A private list this long is part of no root the parser keeps, so the root's own row above isolates the cap.
    ['a list over 1024 distinct entries', { privateOutputNoteIds: ids(1025) }]
  ])('drops only the private notes for %s', (_label, bad) => {
    // `toEqual` reads an undefined field as an absent one.
    expect(parseSubmitEvidence({ ...valid, ...bad })).toEqual({ ...valid, ...bad, privateOutputNoteIds: undefined });
  });

  it('normalizeHex lower-cases', () => {
    expect(normalizeHex('0xABcd')).toBe('0xabcd');
  });
});

describe('privateOutputNoteIdsOf', () => {
  it.each([300, 1024])('answers a private subset of a root of %i distinct notes', count => {
    const root = ids(count);
    expect(privateOutputNoteIdsOf(root, [root[count - 1]])).toEqual([root[count - 1]]);
  });

  // A whole list or none: a root no transaction can have is not one read, and its first 1024 ids would owe a part.
  it('answers nothing for a root over 1024 distinct notes, its private note first', () => {
    const root = ids(1025);
    expect(privateOutputNoteIdsOf(root, [root[0]])).toBeUndefined();
  });
});

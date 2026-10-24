import {
  normalizeHex,
  parseSubmitEvidence,
  readSubmitEvidence,
  type EvidenceProof,
  type EvidenceResult
} from './submit-evidence';

const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const word = (value: string) => ({ toHex: () => value });
const header = (commitment: string, nonce: bigint) => ({
  to_commitment: () => word(commitment),
  nonce: () => ({ asInt: () => nonce })
});

const result = (overrides: Partial<ReturnType<EvidenceResult['executedTransaction']>> = {}): EvidenceResult => ({
  executedTransaction: () => ({
    id: () => word(hex(1)),
    initialAccountHeader: () => header(hex(2), 4n),
    finalAccountHeader: () => header(hex(3), 5n),
    userOutputNotes: () => [{ id: () => ({ toString: () => hex(9) }) }],
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
        userOutputNotes: () => [{ id: () => ({ toString: () => upper(0xb9) }) }]
      }),
      proof({ nullifiers: () => [word(upper(0xc7))], refBlockCommitment: () => word(upper(0xd6)) }),
      () => true
    );
    expect(evidence.transactionId).toBe(hex(0xa1));
    expect(evidence.initialCommitment).toBe(hex(0xa2));
    expect(evidence.finalCommitment).toBe(hex(0xa3));
    expect(evidence.outputNoteIds).toEqual([hex(0xb9)]);
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
    ['a list over 256 entries', { nullifiers: Array.from({ length: 257 }, (_, i) => hex(i)) }]
  ])('rejects %s', (_label, bad) => {
    expect(parseSubmitEvidence({ ...valid, ...bad })).toBeUndefined();
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

  it('normalizeHex lower-cases', () => {
    expect(normalizeHex('0xABcd')).toBe('0xabcd');
  });
});

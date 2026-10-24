import { AccountId, InputNoteRecord, NoteType } from '@miden-sdk/miden-sdk/lazy';

import {
  ESTIMATED_MS_PER_BLOCK,
  EXPIRATION_DELTA_BLOCKS,
  expirationDeltaBlocks,
  GUARDIAN_EXPIRATION_DELTA_BLOCKS,
  MAX_RECALL_BLOCKS,
  assertValidRecallBlocks,
  getNoteRecallableAtMs,
  isAddressValid,
  isPrivateNoteType,
  mayConsume,
  noteConsumeRestriction,
  reclaimDisabledP2ideTarget,
  standardPaymentScriptRoots,
  toNoteTypeString
} from './helpers';
import { NoteTypeEnum } from './types';

const P2ID_ROOT = '0xp2id';
const P2IDE_ROOT = '0xp2ide';
const SPONSORSHIP_ROOT = '0xsponsorship';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  // The REAL numeric values, not string stand-ins: `Private` is 0, so a stub
  // that made it truthy would hide the falsy-enum case `isPrivateNoteType` has
  // to get right.
  NoteType: { Private: 0, Public: 1 },
  NoteScript: {
    p2id: () => ({ root: () => ({ toHex: () => '0xp2id' }) }),
    p2ide: () => ({ root: () => ({ toHex: () => '0xp2ide' }) }),
    feeSponsorship: () => ({ root: () => ({ toHex: () => '0xsponsorship' }) })
  },
  Address: {
    fromBech32: jest.fn((addr: string) => {
      if (addr === 'valid-bech32') return {};
      throw new Error('Invalid');
    })
  }
}));

/**
 * Builds a note whose recipient exposes the given script root and raw storage
 * felts, matching the shape `getNoteRecallableAtMs` reads off the SDK.
 */
const makeNote = (scriptRoot: string, storageItems: bigint[]): InputNoteRecord =>
  ({
    details: () => ({
      recipient: () => ({
        script: () => ({ root: () => ({ toHex: () => scriptRoot }) }),
        storage: () => ({ items: () => storageItems.map(v => ({ asInt: () => v })) })
      })
    })
  }) as unknown as InputNoteRecord;

/**
 * A realistic Miden 0.16 P2IDE storage array:
 * [reclaimer.suffix, reclaimer.prefix, target.suffix, target.prefix, reclaim, timelock].
 * The suffix/prefix felts are deliberately far larger than any block height, so a
 * read at the pre-0.16 index (2) is rejected by the range check and yields undefined.
 */
const p2ideStorage = (reclaimHeight: bigint, timelock = 0n): bigint[] => [
  0x2f1a3b4c5d6e0000n, // reclaimer.suffix
  0x00000000abcdef01n, // reclaimer.prefix
  0x7c9d1e2f3a4b0000n, // target.suffix
  0x00000000feedbeefn, // target.prefix
  reclaimHeight,
  timelock
];

describe('miden helpers', () => {
  it('validates addresses using Address.fromBech32', () => {
    expect(isAddressValid('valid-bech32')).toBe(true);
    expect(isAddressValid('anything')).toBe(false);
  });

  it('converts note type enum to string', () => {
    expect(toNoteTypeString(NoteType.Public as any)).toBe(NoteTypeEnum.Public);
    expect(toNoteTypeString(NoteType.Private as any)).toBe(NoteTypeEnum.Private);
  });

  // A send row's noteType is DECLARED as the numeric SDK enum but PERSISTED as
  // the 'public'/'private' string, so both shapes reach the request builders.
  describe('isPrivateNoteType', () => {
    it('accepts both the persisted string and the declared numeric enum', () => {
      expect(isPrivateNoteType('private')).toBe(true);
      expect(isPrivateNoteType('public')).toBe(false);
      // Private is 0 — falsy, so a truthiness test here would answer "public".
      expect(isPrivateNoteType(NoteType.Private as any)).toBe(true);
      expect(isPrivateNoteType(NoteType.Public as any)).toBe(false);
    });

    it('treats a missing note type as public, like the SDK', () => {
      expect(isPrivateNoteType(undefined)).toBe(false);
      expect(isPrivateNoteType(null)).toBe(false);
    });

    // The wallet used to hand the raw value to `client.send()`, which threw on
    // an unknown type. Building the note locally must not turn that into a
    // silent downgrade of a user-approved Private note to a public one.
    it.each(['Private', 'PRIVATE', 'priv', '', 'unknown', 2])('rejects the unrecognized value %p', value => {
      expect(() => isPrivateNoteType(value as any)).toThrow('Unknown note type');
    });
  });

  describe('standardPaymentScriptRoots', () => {
    it('is exactly the P2ID and P2IDE roots (#805)', () => {
      expect(standardPaymentScriptRoots()).toEqual(new Set([P2ID_ROOT, P2IDE_ROOT]));
    });
  });

  // The offset is added to the sync height and handed to the SDK as a u32 block
  // height, which wasm-bindgen truncates rather than rejects — so every value
  // below is honored as SOME window, just not the one the caller asked for and
  // the approval sheet displayed.
  describe('assertValidRecallBlocks', () => {
    it('accepts a plain window, and the two ways of saying "not recallable"', () => {
      expect(() => assertValidRecallBlocks(2016)).not.toThrow();
      expect(() => assertValidRecallBlocks(0)).not.toThrow();
      expect(() => assertValidRecallBlocks(undefined)).not.toThrow();
      expect(() => assertValidRecallBlocks(MAX_RECALL_BLOCKS)).not.toThrow();
    });

    // 2**32 truncates to 0: the sheet promises four billion blocks, the chain
    // lets the sender reclaim immediately and the recipient can lose the funds.
    it('rejects an offset that wraps the u32 to an instant recall', () => {
      expect(() => assertValidRecallBlocks(2 ** 32)).toThrow('recallBlocks');
      expect(() => assertValidRecallBlocks(MAX_RECALL_BLOCKS + 1)).toThrow('recallBlocks');
    });

    // Wraps the other way once the sum goes below zero — the sender's recall is
    // stranded for ~4 billion blocks.
    it('rejects a negative offset', () => {
      expect(() => assertValidRecallBlocks(-1)).toThrow('recallBlocks');
      expect(() => assertValidRecallBlocks(-(2 ** 20))).toThrow('recallBlocks');
    });

    // Truncated toward zero, so the note becomes recallable before the sheet said.
    it('rejects a fractional offset', () => {
      expect(() => assertValidRecallBlocks(100.5)).toThrow('recallBlocks');
      expect(() => assertValidRecallBlocks(0.9)).toThrow('recallBlocks');
    });

    it('rejects the non-finite values a JSON payload can carry', () => {
      expect(() => assertValidRecallBlocks(Infinity)).toThrow('recallBlocks');
      expect(() => assertValidRecallBlocks(NaN)).toThrow('recallBlocks');
    });
  });

  describe('getNoteRecallableAtMs', () => {
    it('reads the reclaim height from the Miden 0.16 six-item P2IDE layout', () => {
      const now = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const note = makeNote(P2IDE_ROOT, p2ideStorage(1200n));
        // 1200 - 1000 = 200 blocks out.
        expect(getNoteRecallableAtMs(note, 1000)).toBe(now + 200 * ESTIMATED_MS_PER_BLOCK);
      } finally {
        jest.restoreAllMocks();
      }
    });

    it('returns undefined for a non-P2IDE script', () => {
      expect(getNoteRecallableAtMs(makeNote('0xp2id', p2ideStorage(1200n)), 1000)).toBeUndefined();
    });

    it('returns undefined when the reclaim height is unset (Felt::ZERO)', () => {
      expect(getNoteRecallableAtMs(makeNote(P2IDE_ROOT, p2ideStorage(0n)), 1000)).toBeUndefined();
    });

    it('returns undefined when the storage item count is not the expected six', () => {
      // Pre-0.16 four-item layout: bail rather than read an unrelated slot.
      const legacy = [0x7c9d1e2f3a4b0000n, 0x00000000feedbeefn, 1200n, 0n];
      expect(getNoteRecallableAtMs(makeNote(P2IDE_ROOT, legacy), 1000)).toBeUndefined();

      // A hypothetical future layout that prepends one more item: slot 4 still
      // holds a value that PASSES the block-height range check, so only the
      // item-count guard can stop it being rendered as a reclaim date.
      const shifted = [0n, ...p2ideStorage(1200n)];
      expect(getNoteRecallableAtMs(makeNote(P2IDE_ROOT, shifted), 1000)).toBeUndefined();
    });

    it('returns undefined when the read slot holds a value too large to be a block height', () => {
      const storage = p2ideStorage(0x1_0000_0000n);
      expect(getNoteRecallableAtMs(makeNote(P2IDE_ROOT, storage), 1000)).toBeUndefined();
    });

    it('returns undefined when the SDK throws while reading the note', () => {
      const exploding = {
        details: () => {
          throw new Error('boom');
        }
      } as unknown as InputNoteRecord;
      expect(getNoteRecallableAtMs(exploding, 1000)).toBeUndefined();
    });
  });
});

// A non-target enters p2ide.masm only through its reclaim branch, and a reclaim height of 0 closes that branch at every
// block; a sponsorship consumed without its feature note takes the same branch (miden-standards 0.17.1).
describe('which account can ever consume a note', () => {
  const target = { prefix: 0x00000000feedbeefn.toString(), suffix: 0x7c9d1e2f3a4b0000n.toString() };
  const account = (prefix: bigint, suffix: bigint) => () =>
    ({ prefix: () => ({ asInt: () => prefix }), suffix: () => ({ asInt: () => suffix }) }) as unknown as AccountId;
  const sponsorship = (reclaimHeight: bigint) => [
    1n,
    2n,
    3n,
    4n,
    0x2f1a3b4c5d6e0000n,
    0x00000000abcdef01n,
    reclaimHeight
  ];

  it('names the target as the one account that can consume a P2IDE whose reclaim is disabled', () => {
    expect(reclaimDisabledP2ideTarget(makeNote(P2IDE_ROOT, p2ideStorage(0n, 1100n)))).toEqual(target);
    expect(noteConsumeRestriction(makeNote(P2IDE_ROOT, p2ideStorage(0n)))).toEqual(target);
  });

  it('names the target as the one account that can consume a P2ID', () => {
    const p2id = [0x7c9d1e2f3a4b0000n, 0x00000000feedbeefn, 5n, 6n];
    expect(noteConsumeRestriction(makeNote(P2ID_ROOT, p2id))).toEqual(target);
    expect(noteConsumeRestriction(makeNote(P2ID_ROOT, [...p2id, 0n]))).toBeUndefined();
    // The listing reads only the P2IDE rule.
    expect(reclaimDisabledP2ideTarget(makeNote(P2ID_ROOT, p2id))).toBeUndefined();
  });

  it('restricts no P2IDE with a reclaim height, no other script and no other storage layout', () => {
    expect(reclaimDisabledP2ideTarget(makeNote(P2IDE_ROOT, p2ideStorage(1200n)))).toBeUndefined();
    expect(reclaimDisabledP2ideTarget(makeNote(P2ID_ROOT, p2ideStorage(0n)))).toBeUndefined();
    expect(reclaimDisabledP2ideTarget(makeNote(P2IDE_ROOT, [0n, ...p2ideStorage(0n)]))).toBeUndefined();
    expect(noteConsumeRestriction(makeNote(P2ID_ROOT, p2ideStorage(0n)))).toBeUndefined();
  });

  it('lets nobody consume a fee sponsorship whose reclaim is disabled, and restricts one that has a reclaim height', () => {
    expect(noteConsumeRestriction(makeNote(SPONSORSHIP_ROOT, sponsorship(0n)))).toBe('nobody');
    expect(noteConsumeRestriction(makeNote(SPONSORSHIP_ROOT, sponsorship(1200n)))).toBeUndefined();
    expect(noteConsumeRestriction(makeNote(SPONSORSHIP_ROOT, sponsorship(0n).slice(1)))).toBeUndefined();
    // The listing reads only the P2IDE rule.
    expect(reclaimDisabledP2ideTarget(makeNote(SPONSORSHIP_ROOT, sponsorship(0n)))).toBeUndefined();
  });

  it('admits the restriction target alone, compared by its prefix and suffix', () => {
    expect(mayConsume(target, account(0x00000000feedbeefn, 0x7c9d1e2f3a4b0000n))).toBe(true);
    expect(mayConsume(target, account(0x00000000abcdef01n, 0x2f1a3b4c5d6e0000n))).toBe(false);
    expect(mayConsume(target, account(0x00000000feedbeefn, 0x2f1a3b4c5d6e0000n))).toBe(false);
    expect(mayConsume('nobody', account(0x00000000feedbeefn, 0x7c9d1e2f3a4b0000n))).toBe(false);
  });

  it('does not resolve the account for a note with no restriction', () => {
    const resolve = jest.fn();
    expect(mayConsume(undefined, resolve)).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('restricts nothing when the note cannot be read, but lets a WebAssembly trap through', () => {
    const throwing = (error: Error) =>
      ({
        details: () => ({
          recipient: () => ({
            script: () => {
              throw error;
            }
          })
        })
      }) as unknown as InputNoteRecord;
    expect(noteConsumeRestriction(throwing(new Error('boom')))).toBeUndefined();
    expect(reclaimDisabledP2ideTarget(throwing(new Error('boom')))).toBeUndefined();
    const trap = new WebAssembly.RuntimeError('unreachable');
    expect(() => noteConsumeRestriction(throwing(trap))).toThrow(trap);
    expect(() => reclaimDisabledP2ideTarget(throwing(trap))).toThrow(trap);
  });
});

describe('expirationDeltaBlocks (#1081)', () => {
  it('is 600 blocks on its own and 180 through a Guardian', () => {
    expect(EXPIRATION_DELTA_BLOCKS).toBe(600);
    expect(GUARDIAN_EXPIRATION_DELTA_BLOCKS).toBe(180);
    expect(expirationDeltaBlocks(false)).toBe(600);
    expect(expirationDeltaBlocks(true)).toBe(180);
  });

  it('keeps the Guardian window inside the Guardian`s 600 s pending hold at the estimated cadence', () => {
    expect(GUARDIAN_EXPIRATION_DELTA_BLOCKS * ESTIMATED_MS_PER_BLOCK).toBeLessThan(600_000);
  });
});

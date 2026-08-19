import { InputNoteRecord, NoteType } from '@miden-sdk/miden-sdk/lazy';

import { ESTIMATED_MS_PER_BLOCK, getNoteRecallableAtMs, isAddressValid, toNoteType, toNoteTypeString } from './helpers';
import { NoteTypeEnum } from './types';

const P2IDE_ROOT = '0xp2ide';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  NoteType: { Public: 'public', Private: 'private' },
  NoteScript: {
    p2ide: () => ({ root: () => ({ toHex: () => '0xp2ide' }) })
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

  it('converts note type enum to string and back', () => {
    expect(toNoteTypeString(NoteType.Public as any)).toBe(NoteTypeEnum.Public);
    expect(toNoteTypeString(NoteType.Private as any)).toBe(NoteTypeEnum.Private);
    expect(toNoteType(NoteTypeEnum.Public)).toBe(NoteType.Public);
    expect(toNoteType(NoteTypeEnum.Private)).toBe(NoteType.Private);
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

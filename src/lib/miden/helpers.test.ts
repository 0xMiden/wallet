import { NoteType } from '@miden-sdk/miden-sdk/lazy';

import {
  MAX_RECALL_BLOCKS,
  assertValidRecallBlocks,
  isAddressValid,
  isPrivateNoteType,
  toNoteTypeString
} from './helpers';
import { NoteTypeEnum } from './types';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  // The REAL numeric values, not string stand-ins: `Private` is 0, so a stub
  // that made it truthy would hide the falsy-enum case `isPrivateNoteType` has
  // to get right.
  NoteType: { Private: 0, Public: 1 },
  Address: {
    fromBech32: jest.fn((addr: string) => {
      if (addr === 'valid-bech32') return {};
      throw new Error('Invalid');
    })
  }
}));

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
});

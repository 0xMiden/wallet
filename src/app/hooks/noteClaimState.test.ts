import { deriveNoteClaimState, NoteClaimStateSets } from './noteClaimState';

// A note only needs an id + optional isBeingClaimed flag to derive its state.
const note = (id: string, isBeingClaimed = false) => ({ id, isBeingClaimed });

// Build the four id-sets the deriver reads. Any omitted set defaults to empty.
const sets = (overrides: Partial<Record<keyof NoteClaimStateSets, string[]>> = {}): NoteClaimStateSets => ({
  retriableNoteIds: new Set(overrides.retriableNoteIds ?? []),
  invalidNoteIds: new Set(overrides.invalidNoteIds ?? []),
  claimingNoteIds: new Set(overrides.claimingNoteIds ?? []),
  checkingNoteIds: new Set(overrides.checkingNoteIds ?? [])
});

describe('deriveNoteClaimState', () => {
  it('returns "pending" when the note is in none of the sets and not being claimed', () => {
    expect(deriveNoteClaimState(note('a'), sets())).toBe('pending');
  });

  describe('consuming', () => {
    it('is "consuming" when note.isBeingClaimed is true', () => {
      expect(deriveNoteClaimState(note('a', true), sets())).toBe('consuming');
    });

    it('is "consuming" when the id is in claimingNoteIds', () => {
      expect(deriveNoteClaimState(note('a'), sets({ claimingNoteIds: ['a'] }))).toBe('consuming');
    });

    it('is "consuming" when the id is in checkingNoteIds', () => {
      expect(deriveNoteClaimState(note('a'), sets({ checkingNoteIds: ['a'] }))).toBe('consuming');
    });
  });

  it('is "failed" when the id is in invalidNoteIds (and not consuming)', () => {
    expect(deriveNoteClaimState(note('a'), sets({ invalidNoteIds: ['a'] }))).toBe('failed');
  });

  it('is "retriable" when the id is in retriableNoteIds (and not consuming/failed)', () => {
    expect(deriveNoteClaimState(note('a'), sets({ retriableNoteIds: ['a'] }))).toBe('retriable');
  });

  describe('precedence: consuming > failed > retriable > pending', () => {
    it('consuming wins over failed (isBeingClaimed + invalid)', () => {
      expect(deriveNoteClaimState(note('a', true), sets({ invalidNoteIds: ['a'] }))).toBe('consuming');
    });

    it('consuming wins over retriable (claiming + retriable)', () => {
      expect(deriveNoteClaimState(note('a'), sets({ claimingNoteIds: ['a'], retriableNoteIds: ['a'] }))).toBe(
        'consuming'
      );
    });

    it('consuming wins even when the id is in every set (checking + invalid + retriable)', () => {
      expect(
        deriveNoteClaimState(
          note('a'),
          sets({ checkingNoteIds: ['a'], invalidNoteIds: ['a'], retriableNoteIds: ['a'] })
        )
      ).toBe('consuming');
    });

    it('failed wins over retriable (invalid + retriable, not consuming)', () => {
      expect(deriveNoteClaimState(note('a'), sets({ invalidNoteIds: ['a'], retriableNoteIds: ['a'] }))).toBe('failed');
    });
  });

  it('scopes state strictly to the note id (another note being flagged does not leak)', () => {
    expect(deriveNoteClaimState(note('a'), sets({ invalidNoteIds: ['b'], retriableNoteIds: ['c'] }))).toBe('pending');
  });
});

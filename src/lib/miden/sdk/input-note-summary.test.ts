import { reduceInputNoteSummary } from './input-note-summary';

describe('reduceInputNoteSummary', () => {
  it('returns null for a not-found (null) record', () => {
    expect(reduceInputNoteSummary(null)).toBeNull();
  });

  it('reduces a metadata-bearing record to its numeric noteType', () => {
    const record = { metadata: () => ({ noteType: () => 1 }) } as any;
    expect(reduceInputNoteSummary(record)).toEqual({ noteType: 1 });
  });

  it('preserves a noteType of 0 (a real enum value, distinct from missing metadata)', () => {
    const record = { metadata: () => ({ noteType: () => 0 }) } as any;
    expect(reduceInputNoteSummary(record)).toEqual({ noteType: 0 });
  });

  it('yields a found record with undefined noteType when metadata is absent (partial note)', () => {
    const record = { metadata: () => undefined } as any;
    // Distinct from a null reduction: the note exists but has no metadata yet.
    const dto = reduceInputNoteSummary(record);
    expect(dto).not.toBeNull();
    expect(dto!.noteType).toBeUndefined();
  });
});

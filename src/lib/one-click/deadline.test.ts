import {
  assertOneClickDeadline,
  assertOneClickFundingDeadline,
  assertOneClickFundingDeadlineMatches,
  effectiveOneClickFundingDeadline,
  isOneClickDeadlineError
} from './deadline';

describe('assertOneClickDeadline', () => {
  it('allows a quote that remains valid at submit time', () => {
    expect(() =>
      assertOneClickDeadline('2026-10-22T12:00:01.000Z', Date.parse('2026-10-22T12:00:00.000Z'))
    ).not.toThrow();
  });

  it.each(['2026-10-22T12:00:00.000Z', '2026-10-22T11:59:59.000Z'])(
    'rejects a quote expiring at or before now: %s',
    deadline => {
      expect(() => assertOneClickDeadline(deadline, Date.parse('2026-10-22T12:00:00.000Z'))).toThrow(/expired/i);
    }
  );

  it('rejects an invalid persisted deadline', () => {
    expect(() => assertOneClickDeadline('not-a-deadline', Date.parse('2026-10-22T12:00:00.000Z'))).toThrow(/deadline/i);
  });

  it('recognizes deadline errors after the offscreen proxy adds its call prefix', () => {
    expect(
      isOneClickDeadlineError(
        new Error(
          "Offscreen call 'guardianPipeline' failed: The 1Click quote has expired. Request a new quote before depositing."
        )
      )
    ).toBe(true);
  });

  it('recognizes the persisted error string used by failed transaction rows', () => {
    expect(isOneClickDeadlineError('The 1Click quote has expired. Request a new quote before depositing.')).toBe(true);
  });
});

describe('effectiveOneClickFundingDeadline', () => {
  const now = Date.parse('2026-10-22T12:00:00.000Z');
  const requestFirst = '2026-10-22T12:10:00.000Z';
  const providerFirst = '2026-10-22T12:05:00.000Z';

  it('selects the earlier request cutoff and provider expiry without changing either value', () => {
    expect(effectiveOneClickFundingDeadline(requestFirst, providerFirst)).toBe(providerFirst);
    expect(effectiveOneClickFundingDeadline(providerFirst, requestFirst)).toBe(providerFirst);
  });

  it('requires both cutoffs to be future and rejects invalid or missing values', () => {
    expect(() => assertOneClickFundingDeadline(providerFirst, requestFirst, now)).not.toThrow();
    expect(() => assertOneClickFundingDeadline('2026-10-22T12:00:00.000Z', requestFirst, now)).toThrow(/expired/i);
    expect(() => effectiveOneClickFundingDeadline('bad', requestFirst)).toThrow(/deadline/i);
    expect(() => effectiveOneClickFundingDeadline(requestFirst, undefined)).toThrow(/deadline/i);
  });

  it('rejects persisted funding metadata that differs from the signed cutoffs', () => {
    expect(() => assertOneClickFundingDeadlineMatches(requestFirst, requestFirst, providerFirst, now)).toThrow(
      /deadline/i
    );
  });
});

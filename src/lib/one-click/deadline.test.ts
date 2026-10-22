import { assertOneClickDeadline, isOneClickDeadlineError } from './deadline';

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

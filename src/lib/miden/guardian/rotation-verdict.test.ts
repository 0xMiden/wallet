/**
 * rotationVerdict — the single reader of switch-guardian outcome flags.
 *
 * The invariants here are the ones rounds 21–25 of the #786 review kept
 * re-proving per surface: an absent flag is not evidence (F-222), unconfirmed
 * never renders as confirmed, and the full flag product maps to exactly one
 * verdict.
 */
import { ITransactionStatus } from 'lib/miden/db/types';

import { rotationChip, rotationRowTitleKey, rotationVerdict } from './rotation-verdict';

const row = (
  status: ITransactionStatus,
  flags: { commitUnconfirmed?: boolean; registerFailed?: boolean; endpointPersistFailed?: boolean } = {}
) =>
  ({
    type: 'switch-guardian',
    status,
    extraInputs: { newGuardianEndpoint: 'https://new.guardian.test', ...flags }
  }) as never;

describe('rotationVerdict', () => {
  it('is null for non-rotation rows and undefined input', () => {
    expect(rotationVerdict(undefined)).toBeNull();
    expect(
      rotationVerdict({ type: 'send', status: ITransactionStatus.Completed, extraInputs: {} } as never)
    ).toBeNull();
  });

  it('maps queue states to in-flight and Failed to failed', () => {
    expect(rotationVerdict(row(ITransactionStatus.Queued))).toEqual({ kind: 'in-flight' });
    expect(rotationVerdict(row(ITransactionStatus.GeneratingTransaction))).toEqual({ kind: 'in-flight' });
    expect(rotationVerdict(row(ITransactionStatus.Failed))).toEqual({ kind: 'failed' });
  });

  it('reads a clean completed row as confirmed, including legacy rows with no flags at all', () => {
    expect(rotationVerdict(row(ITransactionStatus.Completed))).toEqual({ kind: 'confirmed' });
    expect(
      rotationVerdict({
        type: 'switch-guardian',
        status: ITransactionStatus.Completed,
        extraInputs: undefined
      } as never)
    ).toEqual({ kind: 'confirmed' });
  });

  it('an absent flag is not evidence: only === true counts (F-222)', () => {
    expect(
      rotationVerdict(
        row(ITransactionStatus.Completed, {
          commitUnconfirmed: undefined,
          registerFailed: undefined,
          endpointPersistFailed: undefined
        })
      )
    ).toEqual({ kind: 'confirmed' });
  });

  it('commitUnconfirmed outranks the post-commit flags and carries them', () => {
    expect(
      rotationVerdict(row(ITransactionStatus.Completed, { commitUnconfirmed: true, endpointPersistFailed: true }))
    ).toEqual({ kind: 'submitted-unconfirmed', endpointPersisted: false, registered: true });
    expect(
      rotationVerdict(row(ITransactionStatus.Completed, { commitUnconfirmed: true, registerFailed: true }))
    ).toEqual({ kind: 'submitted-unconfirmed', endpointPersisted: true, registered: false });
  });

  it('a confirmed commit with a failed post-commit step is degraded, never plain confirmed', () => {
    expect(rotationVerdict(row(ITransactionStatus.Completed, { endpointPersistFailed: true }))).toEqual({
      kind: 'completed-degraded',
      endpointPersisted: false,
      registered: true
    });
    expect(rotationVerdict(row(ITransactionStatus.Completed, { registerFailed: true }))).toEqual({
      kind: 'completed-degraded',
      endpointPersisted: true,
      registered: false
    });
  });

  it('exactly one verdict per flag combination, and unconfirmed never reads confirmed — the full product', () => {
    const bools = [undefined, true, false] as const;
    const cases: Array<{ flags: Record<string, boolean | undefined>; expected: string }> = [];
    for (const commitUnconfirmed of bools)
      for (const registerFailed of bools)
        for (const endpointPersistFailed of bools)
          cases.push({
            flags: { commitUnconfirmed, registerFailed, endpointPersistFailed },
            expected:
              commitUnconfirmed === true
                ? 'submitted-unconfirmed'
                : registerFailed === true || endpointPersistFailed === true
                  ? 'completed-degraded'
                  : 'confirmed'
          });
    const kinds = cases.map(c => rotationVerdict(row(ITransactionStatus.Completed, c.flags))?.kind);
    expect(kinds).toEqual(cases.map(c => c.expected));
  });
});

describe('rotationRowTitleKey / rotationChip', () => {
  it('titles completed rotations by verdict, not by snapshot', () => {
    expect(rotationRowTitleKey('confirmed')).toBe('guardianSwitchedRowTitle');
    expect(rotationRowTitleKey('completed-degraded')).toBe('guardianSwitchedRowTitle');
    expect(rotationRowTitleKey('submitted-unconfirmed')).toBe('guardianSwitchSubmittedRowTitle');
    expect(rotationRowTitleKey('in-flight')).toBeUndefined();
    expect(rotationRowTitleKey('failed')).toBeUndefined();
  });

  it('overrides the status chip ONLY where the generic chip would lie', () => {
    expect(rotationChip('submitted-unconfirmed')).toEqual({
      tone: 'pending',
      labelKey: 'guardianSwitchSubmittedChip'
    });
    expect(rotationChip('confirmed')).toBeNull();
    expect(rotationChip('completed-degraded')).toBeNull();
    expect(rotationChip('failed')).toBeNull();
  });
});

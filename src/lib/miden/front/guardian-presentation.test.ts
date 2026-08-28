/**
 * deriveGuardianPresentation — the single guardian-status derivation.
 *
 * The table test enumerates the full input product so every claim combination
 * is pinned; the invariant block encodes the properties rounds 21–25 of the
 * #786 review kept re-proving by hand, so a future edit that breaks one fails
 * here instead of shipping as the next per-surface finding.
 */
import type { GuardianSyncStatus } from 'lib/shared/types';

import { deriveGuardianPresentation, type GuardianPresentationInput } from './guardian-presentation';

const input = (overrides: {
  hotPublicKey?: string;
  guardianSyncStatus?: GuardianSyncStatus;
  outage?: boolean;
  unrepairable?: boolean;
  lastSyncAt?: number;
  lastSyncFresh?: boolean;
}): GuardianPresentationInput => ({
  account: { hotPublicKey: overrides.hotPublicKey, guardianSyncStatus: overrides.guardianSyncStatus },
  outage: overrides.outage ?? false,
  unrepairable: overrides.unrepairable ?? false,
  lastSyncAt: overrides.lastSyncAt,
  lastSyncFresh: overrides.lastSyncFresh ?? false
});

const HOT = 'hot-pub-key';

describe('deriveGuardianPresentation — pill precedence', () => {
  it('reads not-connected with no hot key, whatever else claims otherwise', () => {
    const p = deriveGuardianPresentation(
      input({ guardianSyncStatus: 'in-sync', outage: true, unrepairable: true, lastSyncAt: 1, lastSyncFresh: true })
    );
    expect(p.pill).toBe('not-connected');
    expect(p.fault).toBe(false);
  });

  it('drift outranks outage: the accusation names the operator, the outage names the wire', () => {
    const p = deriveGuardianPresentation(
      input({ hotPublicKey: HOT, guardianSyncStatus: 'needs-user-input', outage: true })
    );
    expect(p.pill).toBe('drifted');
    expect(p.prompt).toBe('needs-user-input');
  });

  it('outage outranks unrepairable', () => {
    const p = deriveGuardianPresentation(
      input({ hotPublicKey: HOT, guardianSyncStatus: 'in-sync', outage: true, unrepairable: true })
    );
    expect(p.pill).toBe('offline');
    expect(p.prompt).toBe('outage');
  });

  it('unrepairable renders its own pill and the manual prompt', () => {
    const p = deriveGuardianPresentation(
      input({ hotPublicKey: HOT, guardianSyncStatus: 'in-sync', unrepairable: true })
    );
    expect(p.pill).toBe('unrepairable');
    expect(p.prompt).toBe('unrepairable-manual');
  });

  it('resolving reads checking even with a fresh stamp — the guard blocks sends, so online would lie (F-207)', () => {
    const p = deriveGuardianPresentation(
      input({ hotPublicKey: HOT, guardianSyncStatus: 'resolving', lastSyncAt: 1, lastSyncFresh: true })
    );
    expect(p.pill).toBe('checking');
    expect(p.sendsBlocked).toBe(true);
  });

  it('a stale stamp reads checking, not online — a verdict has a lifetime (F-149)', () => {
    const p = deriveGuardianPresentation(
      input({ hotPublicKey: HOT, guardianSyncStatus: 'in-sync', lastSyncAt: 1, lastSyncFresh: false })
    );
    expect(p.pill).toBe('checking');
  });

  it('reads online only with a hot key, in-sync status, no fault flags, and a fresh stamp', () => {
    const p = deriveGuardianPresentation(
      input({ hotPublicKey: HOT, guardianSyncStatus: 'in-sync', lastSyncAt: 1, lastSyncFresh: true })
    );
    expect(p).toEqual({
      pill: 'online',
      fault: false,
      lastSync: { kind: 'timestamp', at: 1 },
      sendsBlocked: false,
      prompt: undefined
    });
  });

  it('an absent status (legacy record) passes the guard and can read online', () => {
    const p = deriveGuardianPresentation(input({ hotPublicKey: HOT, lastSyncAt: 1, lastSyncFresh: true }));
    expect(p.pill).toBe('online');
    expect(p.sendsBlocked).toBe(false);
  });
});

describe('deriveGuardianPresentation — last sync', () => {
  it('withholds the timestamp on a drifted account: the stamp describes the previous operator (F-143)', () => {
    const p = deriveGuardianPresentation(
      input({ hotPublicKey: HOT, guardianSyncStatus: 'needs-user-input', lastSyncAt: 123, lastSyncFresh: true })
    );
    expect(p.lastSync).toEqual({ kind: 'unknown' });
  });

  it('renders the real age beside a red pill — the stamp is true even when the operator is down', () => {
    const p = deriveGuardianPresentation(
      input({ hotPublicKey: HOT, guardianSyncStatus: 'in-sync', outage: true, lastSyncAt: 123, lastSyncFresh: false })
    );
    expect(p.pill).toBe('offline');
    expect(p.lastSync).toEqual({ kind: 'timestamp', at: 123 });
  });

  it('reads never when not connected and checking while a verdict is pending', () => {
    expect(deriveGuardianPresentation(input({})).lastSync).toEqual({ kind: 'never' });
    expect(deriveGuardianPresentation(input({ hotPublicKey: HOT, guardianSyncStatus: 'in-sync' })).lastSync).toEqual({
      kind: 'checking'
    });
  });
});

describe('deriveGuardianPresentation — invariants over the full input product', () => {
  const statuses: Array<GuardianSyncStatus | undefined> = [undefined, 'in-sync', 'resolving', 'needs-user-input'];
  const bools = [false, true];
  const product: GuardianPresentationInput[] = [];
  for (const hot of [undefined, HOT])
    for (const status of statuses)
      for (const outage of bools)
        for (const unrepairable of bools)
          for (const stamped of bools)
            for (const fresh of bools)
              product.push(
                input({
                  hotPublicKey: hot,
                  guardianSyncStatus: status,
                  outage,
                  unrepairable,
                  lastSyncAt: stamped ? 1_000 : undefined,
                  lastSyncFresh: fresh
                })
              );

  const violations = (predicate: (p: ReturnType<typeof deriveGuardianPresentation>) => boolean) =>
    product.map(deriveGuardianPresentation).filter(predicate);

  it('never reads online while sends are blocked — the F-207 invariant, all 128 rows', () => {
    expect(violations(p => p.sendsBlocked && p.pill === 'online')).toEqual([]);
  });

  it('sendsBlocked equals the assertGuardianInSync predicate on every row', () => {
    const expected = product.map(row =>
      Boolean(row.account.guardianSyncStatus && row.account.guardianSyncStatus !== 'in-sync')
    );
    expect(product.map(row => deriveGuardianPresentation(row).sendsBlocked)).toEqual(expected);
  });

  it('fault is exactly the red-family pills, and every fault pill carries a prompt', () => {
    expect(
      violations(p => p.fault !== (p.pill === 'offline' || p.pill === 'unrepairable' || p.pill === 'drifted'))
    ).toEqual([]);
    expect(violations(p => p.fault && p.prompt === undefined)).toEqual([]);
  });

  it('never renders a timestamp against a drifted account', () => {
    expect(violations(p => p.pill === 'drifted' && p.lastSync.kind === 'timestamp')).toEqual([]);
  });

  it('online always carries a fresh timestamp', () => {
    expect(
      violations(p => p.pill === 'online' && !(p.lastSync.kind === 'timestamp' && p.lastSync.at === 1_000))
    ).toEqual([]);
  });
});

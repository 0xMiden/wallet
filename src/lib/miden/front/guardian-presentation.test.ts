/**
 * deriveGuardianPresentation - the single guardian-status derivation.
 *
 * The table test enumerates the full input product so every claim combination
 * is pinned; the invariant block encodes the properties rounds 21-25 of the
 * #786 review kept re-proving by hand, so a future edit that breaks one fails
 * here instead of shipping as the next per-surface finding.
 */
import { isGuardianSyncBlocked } from 'lib/miden/guardian/sync-guard';
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

describe('deriveGuardianPresentation - pill precedence', () => {
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
  });

  it('outage outranks unrepairable', () => {
    const p = deriveGuardianPresentation(
      input({ hotPublicKey: HOT, guardianSyncStatus: 'in-sync', outage: true, unrepairable: true })
    );
    expect(p.pill).toBe('offline');
  });

  it('unrepairable renders its own pill', () => {
    const p = deriveGuardianPresentation(
      input({ hotPublicKey: HOT, guardianSyncStatus: 'in-sync', unrepairable: true })
    );
    expect(p.pill).toBe('unrepairable');
  });

  it('resolving reads checking even with a fresh stamp - the guard blocks sends, so online would lie (F-207)', () => {
    const p = deriveGuardianPresentation(
      input({ hotPublicKey: HOT, guardianSyncStatus: 'resolving', lastSyncAt: 1, lastSyncFresh: true })
    );
    expect(p.pill).toBe('checking');
  });

  it('a blocked account outranks the liveness flags: they describe the endpoint being reconciled', () => {
    for (const flags of [{ outage: true }, { unrepairable: true }]) {
      const p = deriveGuardianPresentation(input({ hotPublicKey: HOT, guardianSyncStatus: 'resolving', ...flags }));
      expect(p.pill).toBe('checking');
      expect(p.fault).toBe(false);
    }
  });

  it('a persisted status this build does not know follows the guard', () => {
    // A record written by a newer build: the guard blocks it, so nothing here may certify it.
    const account: GuardianPresentationInput['account'] = JSON.parse(
      '{"hotPublicKey":"hot-pub-key","guardianSyncStatus":"re-keying"}'
    );
    const p = deriveGuardianPresentation({
      account,
      outage: false,
      unrepairable: false,
      lastSyncAt: 1,
      lastSyncFresh: true
    });
    expect(p.pill).toBe('checking');
    expect(p.lastSync).toEqual({ kind: 'checking' });
  });

  it('a stale stamp reads checking, not online - a verdict has a lifetime (F-149)', () => {
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
      lastSync: { kind: 'timestamp', at: 1 }
    });
  });

  it('an absent status (legacy record) passes the guard and can read online', () => {
    const p = deriveGuardianPresentation(input({ hotPublicKey: HOT, lastSyncAt: 1, lastSyncFresh: true }));
    expect(p.pill).toBe('online');
  });
});

describe('deriveGuardianPresentation - last sync', () => {
  it('withholds the timestamp on a drifted account: the stamp describes the previous operator (F-143)', () => {
    const p = deriveGuardianPresentation(
      input({ hotPublicKey: HOT, guardianSyncStatus: 'needs-user-input', lastSyncAt: 123, lastSyncFresh: true })
    );
    expect(p.lastSync).toEqual({ kind: 'unknown' });
  });

  it('withholds the timestamp while resolving: the account is leaving the endpoint that stamp is about', () => {
    const p = deriveGuardianPresentation(
      input({ hotPublicKey: HOT, guardianSyncStatus: 'resolving', lastSyncAt: 123, lastSyncFresh: true })
    );
    expect(p.lastSync).toEqual({ kind: 'checking' });
  });

  it('renders the real age beside a red pill - the stamp is true even when the operator is down', () => {
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

describe('deriveGuardianPresentation - invariants over the full input product', () => {
  // A Record over the union, so a status added to GuardianSyncStatus fails to compile
  // here until the product covers it.
  const known: Record<GuardianSyncStatus, true> = { 'in-sync': true, resolving: true, 'needs-user-input': true };
  const isKnown = (key: string): key is GuardianSyncStatus => key in known;
  const statuses: Array<GuardianSyncStatus | undefined> = [undefined, ...Object.keys(known).filter(isKnown)];
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

  it('never reads online while sends are blocked - the F-207 invariant, all 128 rows', () => {
    expect(
      product.filter(row => isGuardianSyncBlocked(row.account) && deriveGuardianPresentation(row).pill === 'online')
    ).toEqual([]);
  });

  it('fault is exactly the red-family pills', () => {
    expect(
      violations(p => p.fault !== (p.pill === 'offline' || p.pill === 'unrepairable' || p.pill === 'drifted'))
    ).toEqual([]);
  });

  it('never renders a timestamp while the guard blocks', () => {
    expect(
      product.filter(
        row => isGuardianSyncBlocked(row.account) && deriveGuardianPresentation(row).lastSync.kind === 'timestamp'
      )
    ).toEqual([]);
  });

  it('online always carries a fresh timestamp', () => {
    expect(
      violations(p => p.pill === 'online' && !(p.lastSync.kind === 'timestamp' && p.lastSync.at === 1_000))
    ).toEqual([]);
  });
});

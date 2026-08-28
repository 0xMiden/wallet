/**
 * classifyGuardianRecovery — the one trigger table for guardian recovery.
 *
 * The totality test is the point: it enumerates the full fact-tuple product
 * and asserts the invariant the whole #786 class violated — a state that
 * blocks sends or carries a pending rotation is NEVER left without an exit.
 * A future fact combination no route claims fails here, not as a round-26
 * finding.
 */
import type { GuardianSyncStatus } from 'lib/shared/types';

import {
  __getRecoveryDivergencesForTest,
  __resetRecoveryDivergencesForTest,
  classifyGuardianRecovery,
  noteRecoveryDivergence,
  routeHasExit,
  type GuardianFacts
} from './guardian-recovery-dispatcher';

const STATUSES: Array<GuardianSyncStatus | undefined> = [undefined, 'in-sync', 'resolving', 'needs-user-input'];
const BOOLS = [false, true];
const BUDGETS = ['available', 'spent'] as const;

const product: GuardianFacts[] = [];
for (const syncStatus of STATUSES)
  for (const hasHotKey of BOOLS)
    for (const outage of BOOLS)
      for (const unrepairable of BOOLS)
        for (const pending of BOOLS)
          for (const selfHeal of BUDGETS)
            for (const missingRegistration of BUDGETS)
              for (const recheck of BUDGETS)
                product.push({
                  syncStatus,
                  hasHotKey,
                  outage,
                  unrepairable,
                  ...(pending ? { pendingRotation: { txId: 'tx-1' } } : {}),
                  budgets: { selfHeal, missingRegistration, recheck }
                });

describe('classifyGuardianRecovery — totality over the fact product', () => {
  it(`covers all ${product.length} rows without throwing and returns a typed route for each`, () => {
    const routes = product.map(classifyGuardianRecovery);
    expect(routes).toHaveLength(product.length);
  });

  it('no dead ends: a blocking status or pending rotation always routes to an exit', () => {
    // A no-hot-key account's exit is the hot-key activation prompt, owned by
    // the wallet-prompt system outside this dispatcher — every other blocked
    // shape must carry its exit HERE.
    const violations = product.filter(facts => {
      const blocked =
        Boolean(facts.syncStatus && facts.syncStatus !== 'in-sync') || facts.pendingRotation !== undefined;
      if (!blocked || !facts.hasHotKey) return false;
      return !routeHasExit(classifyGuardianRecovery(facts));
    });
    expect(violations).toEqual([]);
  });

  it('a spent repair budget is never silent: it prompts even when the unrepairable flag write was missed', () => {
    const violations = product.filter(facts => {
      if (!facts.hasHotKey || facts.pendingRotation) return false;
      if (facts.syncStatus === 'needs-user-input' || facts.syncStatus === 'resolving') return false;
      const spent = facts.budgets.selfHeal === 'spent' || facts.budgets.missingRegistration === 'spent';
      if (!spent) return false;
      const route = classifyGuardianRecovery(facts);
      return route.route !== 'prompt';
    });
    expect(violations).toEqual([]);
  });

  it('a pending rotation outranks every other verdict and carries its row id', () => {
    const pendingRows = product.filter(f => f.pendingRotation);
    const expected = pendingRows.map(facts =>
      facts.budgets.recheck === 'spent'
        ? { route: 'prompt', reason: 'rotation-unconfirmed-exhausted' }
        : { route: 'recheck-pending-rotation', txId: 'tx-1' }
    );
    expect(pendingRows.map(classifyGuardianRecovery)).toEqual(expected);
  });

  it('drift and outage keep their existing prompt owners, in the surfaces’ precedence order', () => {
    const base: GuardianFacts = {
      syncStatus: 'in-sync',
      hasHotKey: true,
      outage: false,
      unrepairable: false,
      budgets: { selfHeal: 'available', missingRegistration: 'available', recheck: 'available' }
    };
    expect(classifyGuardianRecovery({ ...base, syncStatus: 'needs-user-input', outage: true })).toEqual({
      route: 'prompt',
      reason: 'needs-user-input'
    });
    expect(classifyGuardianRecovery({ ...base, outage: true, unrepairable: true })).toEqual({
      route: 'prompt',
      reason: 'outage'
    });
    expect(classifyGuardianRecovery({ ...base, unrepairable: true })).toEqual({
      route: 'prompt',
      reason: 'unrepairable-manual'
    });
    expect(classifyGuardianRecovery(base)).toEqual({ route: 'none-healthy' });
  });
});

describe('shadow divergence accounting', () => {
  it('logs once per kind and counts after', () => {
    __resetRecoveryDivergencesForTest();
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    noteRecoveryDivergence('kind-a');
    noteRecoveryDivergence('kind-a');
    noteRecoveryDivergence('kind-b');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(__getRecoveryDivergencesForTest().get('kind-a')).toBe(2);
    expect(__getRecoveryDivergencesForTest().get('kind-b')).toBe(1);
    warn.mockRestore();
    __resetRecoveryDivergencesForTest();
  });
});

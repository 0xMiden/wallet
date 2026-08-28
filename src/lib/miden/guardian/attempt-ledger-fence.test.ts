/**
 * The LEDGER FENCE: the guardian repair modules may not grow new hand-rolled
 * retry/budget state.
 *
 * Rounds 9–14 of the #786 review re-fixed the same budget-accounting mistakes
 * across four bespoke module-level Maps (charge timing, refunds, keying,
 * endpoint-change reset). Those ledgers now live in `attempt-ledger.ts`; this
 * scan pins the exact set of module-level Maps the two repair modules still
 * hold, so a new repair either uses `createAttemptLedger`/`createRateCooldown`
 * or fails CI with this file in the diff — at which point the right fix is the
 * ledger, not the list.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');

/**
 * A module-scope keyed collection, in every form a person writes one.
 *
 * The first version of this pattern required `const`/`let` and a generic
 * argument, so ALL of these slipped past it: `export const` (the natural form in
 * a file that already exports eight consts), `new Map()` with the generic
 * inferred, an annotation on the left (`const m: Map<string, number> = new Map()`),
 * `var`, and the `Weak` variants. A fence that only recognises the exact
 * declaration style already in the file is a rename detector, not a barrier.
 */
const MODULE_MAPS =
  /(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*new (?:Map|Set|WeakMap|WeakSet)\b/g;

const moduleMapNames = (relPath: string): string[] => {
  const source = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  // Module scope only: anything indented lives inside a function and is
  // somebody's local bookkeeping, not a cross-tick ledger.
  return [...source.matchAll(new RegExp(`^${MODULE_MAPS.source}`, 'gm'))].map(m => m[1] ?? '').sort();
};

describe('guardian repair modules hold no hand-rolled retry ledgers', () => {
  it('front/guardian-sync.ts: counters and identity maps only — budgets live in the AttemptLedger', () => {
    expect(moduleMapNames('src/lib/miden/front/guardian-sync.ts')).toEqual(
      [
        // Streak counters (persistence gates), not budgets: no cooldown, no cap,
        // reset by the next contrary verdict.
        'consecutiveAuthFailures',
        'consecutiveServerFailures',
        'consecutiveUnknownAccount',
        // Identity / presentation state, not retry state.
        'hardeningChecked',
        'lastGuardianSyncAt',
        'outageAccounts',
        'outageListeners',
        // Prompt evidence for an exhausted pending-rotation recheck — the
        // budget itself lives in `pendingRotationRecheckLedger`; this map only
        // remembers which row ran dry (keyed by row id, valued by the account
        // that owns it, so one exhausted row cannot condemn its siblings), and
        // clears when the row resolves.
        'pendingRotationExhaustedOwner',
        'syncedGuardianEndpoint',
        'unrepairableAccounts'
      ].sort()
    );
  });

  it('back/guardian-drift.ts: only the probe cooldown pair, which stays deliberately', () => {
    // `nextDriftProbeAt` arms on entry (not on settle) and its constant doubles
    // as the persisted silent-run contiguity floor — forcing it into the ledger
    // would change what it means. The pair is the documented exception.
    expect(moduleMapNames('src/lib/miden/back/guardian-drift.ts')).toEqual(
      ['driftProbeEndpoint', 'nextDriftProbeAt'].sort()
    );
  });

  it('self-test: the pattern catches every declaration form, including the ones it used to miss', () => {
    const declarations = [
      'const plainGeneric = new Map<string, number>();',
      'const inferred = new Map();',
      'let mutable = new Map<string, number>();',
      'var legacy = new Map<string, number>();',
      'export const exported = new Map<string, number>();',
      'const annotated: Map<string, number> = new Map();',
      'const weak = new WeakMap<object, number>();',
      'const set = new Set<string>();',
      'export const exportedSet = new Set<string>();'
    ];
    for (const declaration of declarations) {
      const matches = [...declaration.matchAll(new RegExp(`^${MODULE_MAPS.source}`, 'gm'))];
      expect(`${declaration} → ${matches.length}`).toBe(`${declaration} → 1`);
    }

    // Indented declarations are function-local bookkeeping and stay invisible,
    // which is the whole reason the pattern is anchored.
    const indented = '  const localTally = new Map<string, number>();';
    expect([...indented.matchAll(new RegExp(`^${MODULE_MAPS.source}`, 'gm'))]).toHaveLength(0);
  });
});

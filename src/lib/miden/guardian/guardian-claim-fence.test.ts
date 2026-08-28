/**
 * The guardian-claim FENCE: raw reads of the rotation outcome flags and the
 * sync status may not spread past their owning modules.
 *
 * WHY THIS EXISTS. Rounds 21–25 of the #786 review each found another surface
 * deriving "the rotation happened / the guardian is fine" from its own read of
 * `commitUnconfirmed` / `registerFailed` / `endpointPersistFailed` /
 * `guardianSyncStatus` — and F-222 showed the failure shape: a new reader
 * treats an ABSENT flag as evidence and certifies a rotation the wallet never
 * confirmed. Fixing the surfaces one by one could not close the class, because
 * nothing stopped surface N+1 from compiling a new local derivation.
 *
 * This test is that stop. Every claim now flows through `rotationVerdict`
 * (`rotation-verdict.ts`) or `deriveGuardianPresentation`
 * (`front/guardian-presentation.ts`); the files below are the complete set
 * that may still touch the raw fields, each for a stated reason. Adding a raw
 * read elsewhere fails CI — the fix is to consume the verdict/presentation
 * modules, not to grow this list.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');

/**
 * Every way a fenced field can be READ, not just the two that were obvious.
 *
 *  - `.flag` — also matches `?.flag` (the optional chain still ends in `.flag`).
 *  - `['flag']` — bracket access, with optional whitespace inside the brackets.
 *  - `{ flag }` / `{ flag: alias }` / `{ flag = default }` — DESTRUCTURING, which
 *    the first version of this fence missed entirely. That was not a theoretical
 *    hole: `const { commitUnconfirmed } = tx.extraInputs ?? {}` is one keystroke
 *    from the form that WAS caught, and `complete.ts` already destructures
 *    `tx.extraInputs` inside the function that writes these very flags. A fence
 *    that catches `a.b` and not `const { b } = a` does not close the class.
 *  - `({ flag }) => …` — a destructured PARAMETER, which is the same read one
 *    call frame earlier and ends in `})` rather than `} =`. Matched only in
 *    arrow-parameter position, not on a bare `})`, so an object literal passed
 *    as an argument (`update(id, { commitUnconfirmed: true })` — a write, and
 *    the writers are not what this fence governs) stays out of it.
 *
 * A regex scan can always be defeated by enough indirection (a variable-held
 * property name, `Reflect.get`, a helper returning the whole `extraInputs`).
 * The bar is the forms a person writes without trying to evade the fence.
 */
const fieldRead = (names: string[]): RegExp => {
  const alt = names.join('|');
  return new RegExp(
    // dot / optional-chain access
    `[.](${alt})\\b` +
      // bracket access with a string literal
      `|\\[\\s*['"\`](${alt})['"\`]\\s*\\]` +
      // destructuring binding `{ ... name ... } =` (including rename/default),
      // or a destructured arrow parameter `({ ... name ... }) =>`, optionally
      // type-annotated on either side
      `|\\{[^{}]*\\b(${alt})\\b[^{}]*\\}\\s*(?:=(?!=)|(?::[^)=]+)?\\)\\s*(?::[^=]+)?=>)`,
    'g'
  );
};

const FLAG_NAMES = ['commitUnconfirmed', 'registerFailed', 'endpointPersistFailed'];
const SYNC_STATUS_NAMES = ['guardianSyncStatus'];

const FLAG_READ = fieldRead(FLAG_NAMES);
const SYNC_STATUS_READ = fieldRead(SYNC_STATUS_NAMES);

/**
 * The complete allowed-reader sets. Writers and plumbing that transports the
 * field without interpreting it are listed; everything that INTERPRETS the
 * value goes through the two derivation modules.
 */
const FLAG_ALLOWED = new Set([
  // The single interpreter.
  'src/lib/miden/guardian/rotation-verdict.ts'
]);

const SYNC_STATUS_ALLOWED = new Set([
  // The single send-block/coarsening interpreter.
  'src/lib/miden/guardian/sync-guard.ts',
  // Presentation derives from it via the sync-guard predicate plus precedence.
  'src/lib/miden/front/guardian-presentation.ts',
  // The wiring hook selects the raw field to hand it to the derivation.
  'src/app/hooks/useGuardianPresentation.ts',
  // The reconciler state machine — the field's owner and only writer of record.
  'src/lib/miden/back/guardian-drift.ts',
  // Assembles GuardianFacts for the recovery dispatcher (facts in, routes
  // out) — a hand-off to the classifier, not a surface derivation.
  'src/lib/miden/front/guardian-sync.ts',
  // Transport plumbing: request/response payloads carried, never interpreted.
  'src/lib/miden/back/main.ts',
  'src/lib/intercom/in-process-request-handler.ts',
  'src/lib/store/index.ts'
]);

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    // Tests construct rows and mock accounts freely — the fence governs
    // production derivations, not fixtures.
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)
      ? [full]
      : [];
  });

/**
 * Strip comments so prose ABOUT a field (of which the guardian modules have
 * plenty) does not count as a read. Naive string handling is fine here: the
 * fenced identifiers never appear inside string literals in ways that matter,
 * and a false positive fails loudly for a human to look at.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"])\/\/[^\n]*/g, '$1');

const matchCount = (code: string, pattern: RegExp): number => [...stripComments(code).matchAll(pattern)].length;

describe('guardian claim fence', () => {
  const files = sourceFiles(path.join(ROOT, 'src'));

  const offenders = (pattern: RegExp, allowed: Set<string>): string[] => {
    const out: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file);
      if (allowed.has(rel)) continue;
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      const matches = [...code.matchAll(pattern)];
      if (matches.length > 0) out.push(`${rel} (${matches.map(m => m[0]).join(', ')})`);
    }
    return out.sort();
  };

  // A fence that scanned nothing would pass both assertions below in silence. A
  // narrowed extension filter or a new ignore is all it would take.
  it('scans the source tree', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('rotation outcome flags are read only by the verdict module', () => {
    expect(offenders(FLAG_READ, FLAG_ALLOWED)).toEqual([]);
  });

  it('guardianSyncStatus is read only by its owner, the guard, the derivation and the plumbing', () => {
    expect(offenders(SYNC_STATUS_READ, SYNC_STATUS_ALLOWED)).toEqual([]);
  });

  /**
   * An allowlist entry is a licence to read a fenced field, and a licence for a
   * file that no longer reads one is a standing permit nobody is watching. Both
   * lists had exactly that: `transaction/complete.ts` and `back/vault.ts` were
   * listed with stated reasons long after their reads became object shorthand,
   * pre-authorizing a future raw read in the two files most likely to grow one.
   */
  it.each([
    ['flags', FLAG_ALLOWED, FLAG_READ],
    ['guardianSyncStatus', SYNC_STATUS_ALLOWED, SYNC_STATUS_READ]
  ])('every %s allowlist entry still needs its licence', (_label, allowed, pattern) => {
    const unnecessary = [...allowed].filter(
      rel => matchCount(fs.readFileSync(path.join(ROOT, rel), 'utf8'), pattern) === 0
    );
    expect(unnecessary).toEqual([]);
  });

  it('self-test: the fence fires on every form of raw read it claims to catch', () => {
    const caught: Array<[string, string]> = [
      ['dot access', 'const lying = tx.extraInputs.commitUnconfirmed === true;'],
      ['optional chain', 'const lying = tx.extraInputs?.commitUnconfirmed === true;'],
      ['bracket access', `const lying = tx.extraInputs['commitUnconfirmed'];`],
      ['bracket access, padded', `const lying = tx.extraInputs[ 'commitUnconfirmed' ];`],
      // The whole reason this list exists: each of these was GREEN before.
      ['destructuring', 'const { commitUnconfirmed } = tx.extraInputs ?? {};'],
      ['destructuring, renamed', 'const { commitUnconfirmed: unconfirmed } = tx.extraInputs ?? {};'],
      ['destructuring, defaulted', 'const { registerFailed = false } = tx.extraInputs ?? {};'],
      ['destructured parameter', 'const f = ({ endpointPersistFailed }) => true;'],
      ['destructured parameter, typed', 'const f = ({ endpointPersistFailed }: Flags) => true;']
    ];
    for (const [label, code] of caught) {
      expect(`${label}: ${matchCount(code, FLAG_READ)}`).toBe(`${label}: 1`);
    }

    // Prose about a field is not a read of it.
    expect(matchCount('// .registerFailed in prose does not count\n', FLAG_READ)).toBe(0);
    expect(matchCount('/* commitUnconfirmed, registerFailed */\n', FLAG_READ)).toBe(0);

    expect(matchCount('if (account.guardianSyncStatus) {}', SYNC_STATUS_READ)).toBe(1);
    expect(matchCount('const { guardianSyncStatus } = account;', SYNC_STATUS_READ)).toBe(1);

    // An object literal argument is a WRITE, and writers are not fenced — the
    // arrow-parameter branch must not widen into every `})`.
    expect(matchCount('await update(id, { commitUnconfirmed: true });', FLAG_READ)).toBe(0);
  });

  it('self-test: `offenders` reports a real file, and the allowlist is what suppresses it', () => {
    // The assertions above exercise the patterns in isolation; this exercises
    // the WALK, the strip and the allowlist together, which is what actually
    // guards the tree.
    const withoutAllowlist = offenders(FLAG_READ, new Set());
    expect(withoutAllowlist).not.toEqual([]);

    // And the suppression is the allowlist doing its job, not an empty scan:
    // licensing every reporter must silence exactly those reports.
    const reported = new Set(withoutAllowlist.map(entry => entry.slice(0, entry.indexOf(' ('))));
    expect(offenders(FLAG_READ, reported)).toEqual([]);
  });
});

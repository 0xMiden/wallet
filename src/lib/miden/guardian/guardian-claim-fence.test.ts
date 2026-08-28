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
 * Property reads of the three outcome flags. `.flag` also matches `?.flag`
 * (the optional chain still ends in `.flag`), and bracket access is caught by
 * the string-literal alternative.
 */
const FLAG_READ =
  /[.](commitUnconfirmed|registerFailed|endpointPersistFailed)\b|\[['"](commitUnconfirmed|registerFailed|endpointPersistFailed)['"]\]/g;

const SYNC_STATUS_READ = /[.]guardianSyncStatus\b|\[['"]guardianSyncStatus['"]\]/g;

/**
 * The complete allowed-reader sets. Writers and plumbing that transports the
 * field without interpreting it are listed; everything that INTERPRETS the
 * value goes through the two derivation modules.
 */
const FLAG_ALLOWED = new Set([
  // The single interpreter.
  'src/lib/miden/guardian/rotation-verdict.ts',
  // The single writer (declares, sets, persists the flags).
  'src/lib/miden/transaction/complete.ts'
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
  // The persistence write.
  'src/lib/miden/back/vault.ts',
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

  it('rotation outcome flags are read only by the verdict module and their writer', () => {
    expect(offenders(FLAG_READ, FLAG_ALLOWED)).toEqual([]);
  });

  it('guardianSyncStatus is read only by its owner, the guard, the derivation and the plumbing', () => {
    expect(offenders(SYNC_STATUS_READ, SYNC_STATUS_ALLOWED)).toEqual([]);
  });

  it('self-test: the fence actually fires on a raw read', () => {
    const sample = stripComments(
      `const lying = tx.extraInputs?.commitUnconfirmed === true;\n// .registerFailed in prose does not count\n`
    );
    expect([...sample.matchAll(FLAG_READ)].map(m => m[0])).toEqual(['.commitUnconfirmed']);
    expect([...stripComments('if (account.guardianSyncStatus) {}').matchAll(SYNC_STATUS_READ)].length).toBe(1);
  });
});

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
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../../../..');

/**
 * Every way a fenced field can be READ, found on the SYNTAX TREE rather than by
 * pattern-matching the text.
 *
 * The first two versions of this fence were regexes, and both leaked. The first
 * missed destructuring entirely; the second, widened for it, still missed a
 * destructured parameter on a `function` declaration (`{…}` followed by `)` and
 * a return type, not by `=` or `=>`), a nested destructure (`const {extraInputs:
 * {commitUnconfirmed}} = tx` — the inner `[^{}]*` cannot cross a brace pair),
 * and a presence test (`'commitUnconfirmed' in extra`), which is precisely the
 * F-222 shape this fence's docstring names. Each hole was invisible to
 * inspection and each was one ordinary keystroke away from a form that WAS
 * caught: `function name({…})` is the dominant declaration style in the very UI
 * files being fenced.
 *
 * None of those are expressible as regex holes to patch — one needs recursive
 * brace matching, another needs to know that a `}` is a parameter's rather than
 * an object literal's. The tree knows both for free, so the matcher asks it:
 *
 *  - `PropertyAccessExpression` — `x.flag`, `x?.flag`, and a write `x.flag = v`
 *    (the writers are allowlisted by file, not by syntax).
 *  - `ElementAccessExpression` with a string-literal argument — `x['flag']`.
 *  - `BindingElement` — EVERY destructure, at any depth and in any position:
 *    declaration, parameter (arrow, `function`, method), catch, `for…of`. A
 *    rename reads the source name (`propertyName`), a shorthand reads its own.
 *  - `'flag' in x` and `Object.hasOwn(x, 'flag')` — a presence test is a read of
 *    the field's absence, which is exactly the evidence F-222 misused.
 *
 * A `PropertyAssignment` in an object literal (`{ commitUnconfirmed: true }`) is
 * a WRITE and is deliberately not a `BindingElement`, so it stays out with no
 * special case — the arrow-parameter regex needed one and got it wrong.
 *
 * Indirection can still defeat this (a variable-held property name,
 * `Reflect.get`, a helper that returns the whole `extraInputs`). The bar is the
 * forms a person writes without trying to evade the fence.
 */
const FLAG_NAMES = ['commitUnconfirmed', 'registerFailed', 'endpointPersistFailed'];
const SYNC_STATUS_NAMES = ['guardianSyncStatus'];

type FieldSet = readonly string[];

// Parentheses are transparent to meaning and were not transparent to this
// matcher: `('commitUnconfirmed') in extra` is the same presence test as the
// unparenthesized one, and Prettier itself writes the parenthesized form when
// the test is negated inside a longer condition — which is the F-222 shape.
const literalText = (node: ts.Node): string | undefined => {
  const inner = ts.isParenthesizedExpression(node) ? literalText(node.expression) : undefined;
  if (inner !== undefined) return inner;
  return ts.isStringLiteralLike(node) ? node.text : undefined;
};

// `Reflect.has` is the third spelling of the same question, and the docstring
// above already concedes `Reflect.get` as out of reach — but `has` is not
// indirection, it is the presence test written with the reflective API, one
// autocomplete away from `Object.hasOwn`.
const presenceCallee = (expression: ts.Expression): boolean => {
  const text = expression.getText();
  return text.endsWith('hasOwn') || text.endsWith('hasOwnProperty') || text.endsWith('Reflect.has');
};

// `Object.keys(extra).includes('commitUnconfirmed')` is a presence test spelled
// as a list membership, and it reads the field's ABSENCE exactly the way the two
// forms above do. Matched on the argument rather than on the receiver, since the
// receiver can be any expression that produces the key list.
const membershipCallee = (expression: ts.Expression): boolean => {
  const text = expression.getText();
  return /\.(includes|indexOf|lastIndexOf)$/.test(text);
};

/** Every fenced-field read in one file, as the source text that produced it. */
const fieldReads = (source: ts.SourceFile, names: FieldSet): string[] => {
  const fenced = new Set(names);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && fenced.has(node.name.getText())) {
      found.push(node.getText());
    } else if (ts.isElementAccessExpression(node)) {
      const key = literalText(node.argumentExpression);
      if (key !== undefined && fenced.has(key)) found.push(node.getText());
    } else if (ts.isBindingElement(node)) {
      // A rename (`{ flag: alias }`) reads `propertyName`; a shorthand
      // (`{ flag }`) reads its own `name`. Both are reads of the field.
      const read = node.propertyName ?? node.name;
      if (ts.isIdentifier(read) && fenced.has(read.text)) found.push(node.getText());
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
      fenced.has(literalText(node.left) ?? '')
    ) {
      found.push(node.getText());
    } else if (
      ts.isCallExpression(node) &&
      (presenceCallee(node.expression) || membershipCallee(node.expression)) &&
      node.arguments.some(arg => fenced.has(literalText(arg) ?? ''))
    ) {
      found.push(node.getText());
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

/**
 * THE SCRIPT KIND HAS TO FOLLOW THE EXTENSION, and getting it wrong fails open.
 *
 * A `.ts` file parsed as TSX is not rejected — `createSourceFile` never throws.
 * It returns a WRECKED TREE: the first generic arrow (`<T>(x: T) => x`) reads as
 * an unclosed JSX element, and everything after it collapses into error nodes
 * this walk then finds nothing in. Under a blanket `ScriptKind.TSX` that
 * silently unfenced five production modules, `guardian/direct-switch.ts` and
 * `transaction/index.ts` among them — the two likeliest places for a raw
 * rotation-flag read to appear.
 */
const parse = (code: string, fileName = 'probe.tsx'): ts.SourceFile =>
  ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

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

// `fileName` is not optional decoration: the licence check below feeds this real
// production `.ts` files, and defaulting them to the `.tsx` probe name parses
// them as JSX — the same fail-open that unfenced five modules. Here it fails the
// other way (a mangled file reports zero reads, so a live licence looks
// unnecessary), which is loud rather than dangerous, but it points at the wrong
// fix.
const matchCount = (code: string, names: FieldSet, fileName?: string): number =>
  fieldReads(parse(code, fileName), names).length;

describe('guardian claim fence', () => {
  const files = sourceFiles(path.join(ROOT, 'src'));
  // Parse once, ask twice. Both fenced sets walk the same 600+ files.
  const parsed = new Map(files.map(file => [file, parse(fs.readFileSync(file, 'utf8'), file)]));

  const offenders = (names: FieldSet, allowed: Set<string>): string[] => {
    const out: string[] = [];
    for (const [file, source] of parsed) {
      const rel = path.relative(ROOT, file);
      if (allowed.has(rel)) continue;
      const reads = fieldReads(source, names);
      if (reads.length > 0) out.push(`${rel} (${reads.join(', ')})`);
    }
    return out.sort();
  };

  // A fence that scanned nothing would pass both assertions below in silence,
  // and the two narrowings that would actually blind it — dropping `.tsx`, or
  // rooting the walk at `src/lib` — each leave several hundred files, so a round
  // floor cannot tell them from a healthy scan. Pin the real magnitude, and pin
  // a UI file BY NAME so the half of the tree this fence exists for cannot be
  // dropped while the count still looks plausible.
  it('scans the whole source tree, UI included', () => {
    expect(files.length).toBeGreaterThan(600);
    expect(files).toContain(path.join(ROOT, 'src/app/templates/history/HistoryView.tsx'));
  });

  // Counting the files is not enough: a file can be scanned and still contribute
  // nothing, because a mis-parse produces error nodes rather than an exception.
  // That is exactly what a blanket `ScriptKind.TSX` did — the walk visited every
  // file and found nothing in five of them, `guardian/direct-switch.ts` and
  // `transaction/index.ts` among them. A syntax check is what makes "no
  // offenders" mean "no reads" rather than "no tree".
  it('parses every scanned file cleanly, so an empty result means what it says', () => {
    const broken = files.filter(file => {
      const { diagnostics } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest }
      });
      return (diagnostics ?? []).length > 0;
    });
    expect(broken.map(file => path.relative(ROOT, file))).toEqual([]);
  });

  // The specific construct that made a `.ts` file parse as JSX: a generic arrow
  // with no trailing comma. Under TSX its `<T>` opens an element that never
  // closes and the rest of the file is swallowed, so the read below vanishes.
  it('reads through a generic arrow in a .ts file, the construct TSX mangles', () => {
    const code = `const pick = <T>(x: T) => x;\nexport const bad = (tx: Row) => tx.extraInputs?.commitUnconfirmed;`;
    expect(fieldReads(parse(code, 'probe.ts'), FLAG_NAMES)).toHaveLength(1);
  });

  it('rotation outcome flags are read only by the verdict module', () => {
    expect(offenders(FLAG_NAMES, FLAG_ALLOWED)).toEqual([]);
  });

  it('guardianSyncStatus is read only by its owner, the guard, the derivation and the plumbing', () => {
    expect(offenders(SYNC_STATUS_NAMES, SYNC_STATUS_ALLOWED)).toEqual([]);
  });

  /**
   * An allowlist entry is a licence to read a fenced field, and a licence for a
   * file that no longer reads one is a standing permit nobody is watching. Both
   * lists had exactly that: `transaction/complete.ts` and `back/vault.ts` were
   * listed with stated reasons long after their reads became object shorthand,
   * pre-authorizing a future raw read in the two files most likely to grow one.
   */
  it.each([
    ['flags', FLAG_ALLOWED, FLAG_NAMES],
    ['guardianSyncStatus', SYNC_STATUS_ALLOWED, SYNC_STATUS_NAMES]
  ])('every %s allowlist entry still needs its licence', (_label, allowed, names) => {
    const unnecessary = [...allowed].filter(
      rel => matchCount(fs.readFileSync(path.join(ROOT, rel), 'utf8'), names, rel) === 0
    );
    expect(unnecessary).toEqual([]);
  });

  it('self-test: the fence fires on every form of raw read it claims to catch', () => {
    const caught: Array<[string, string]> = [
      ['dot access', 'const lying = tx.extraInputs.commitUnconfirmed === true;'],
      ['optional chain', 'const lying = tx.extraInputs?.commitUnconfirmed === true;'],
      ['bracket access', `const lying = tx.extraInputs['commitUnconfirmed'];`],
      ['bracket access, padded', `const lying = tx.extraInputs[ 'commitUnconfirmed' ];`],
      // Each of these was GREEN under one or other of the two regex versions.
      ['destructuring', 'const { commitUnconfirmed } = tx.extraInputs ?? {};'],
      ['destructuring, renamed', 'const { commitUnconfirmed: unconfirmed } = tx.extraInputs ?? {};'],
      ['destructuring, defaulted', 'const { registerFailed = false } = tx.extraInputs ?? {};'],
      ['destructured parameter', 'const f = ({ endpointPersistFailed }) => true;'],
      ['destructured parameter, typed', 'const f = ({ endpointPersistFailed }: Flags) => true;'],
      // The four the widened regex still missed. `function name({…})` is the
      // dominant declaration style in the UI files this fence governs, so the
      // first of these was not an exotic form — it was the likely one.
      [
        'destructured parameter on a function declaration',
        'function f({ endpointPersistFailed }: Flags) { return 1; }'
      ],
      ['destructured parameter on a method', 'const o = { f({ registerFailed }: Flags) { return 1; } };'],
      ['nested destructuring', 'const { extraInputs: { commitUnconfirmed } } = tx;'],
      ['for-of destructuring', 'for (const { commitUnconfirmed } of rows) { use(commitUnconfirmed); }'],
      // Absence-as-evidence — the F-222 shape by name.
      ['presence test', `const legacy = !('commitUnconfirmed' in extra);`],
      ['hasOwn', `const legacy = !Object.hasOwn(extra, 'commitUnconfirmed');`],
      // The three remaining spellings of the same question, each green against
      // the first AST version. The parenthesized `in` is not an exotic form:
      // it is what the formatter produces once the test is negated inside a
      // longer condition.
      ['presence test, parenthesized', `const legacy = !(('commitUnconfirmed') in extra);`],
      ['Reflect.has', `const legacy = !Reflect.has(extra, 'commitUnconfirmed');`],
      ['key-list membership', `const legacy = !Object.keys(extra).includes('commitUnconfirmed');`]
    ];
    for (const [label, code] of caught) {
      expect(`${label}: ${matchCount(code, FLAG_NAMES)}`).toBe(`${label}: 1`);
    }

    // Prose about a field is not a read of it — free on a tree, where the two
    // regex versions each needed a comment-stripping pass to approximate it.
    expect(matchCount('// .registerFailed in prose does not count\n', FLAG_NAMES)).toBe(0);
    expect(matchCount('/* commitUnconfirmed, registerFailed */\n', FLAG_NAMES)).toBe(0);

    expect(matchCount('if (account.guardianSyncStatus) {}', SYNC_STATUS_NAMES)).toBe(1);
    expect(matchCount('const { guardianSyncStatus } = account;', SYNC_STATUS_NAMES)).toBe(1);

    // An object literal argument is a WRITE, and writers are not fenced by
    // syntax — they are allowlisted by file.
    expect(matchCount('await update(id, { commitUnconfirmed: true });', FLAG_NAMES)).toBe(0);
    // A local variable that merely SHARES the name is not a field read either.
    expect(matchCount('const commitUnconfirmed = false; return commitUnconfirmed;', FLAG_NAMES)).toBe(0);
  });

  it('self-test: `offenders` reports a real file, and the allowlist is what suppresses it', () => {
    // The assertions above exercise the matcher in isolation; this exercises the
    // WALK, the parse and the allowlist together, which is what guards the tree.
    const withoutAllowlist = offenders(FLAG_NAMES, new Set());
    // Exactly one file interprets the flags, and licensing it is what silences
    // the report. An `expect(...).not.toEqual([])` would also pass if the walk
    // started reporting half the tree.
    expect(withoutAllowlist.map(entry => entry.slice(0, entry.indexOf(' (')))).toEqual([
      'src/lib/miden/guardian/rotation-verdict.ts'
    ]);
    expect(offenders(FLAG_NAMES, FLAG_ALLOWED)).toEqual([]);
  });
});

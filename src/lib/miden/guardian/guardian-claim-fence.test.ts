/**
 * The guardian-claim FENCE: raw reads of the rotation outcome flags and the
 * sync status may not spread past their owning modules.
 *
 * WHY THIS EXISTS. Rounds 21-25 of the #786 review each found another surface
 * deriving "the rotation happened / the guardian is fine" from its own read of
 * `commitUnconfirmed` / `registerFailed` / `endpointPersistFailed` /
 * `guardianSyncStatus` - and F-222 showed the failure shape: a new reader
 * treats an ABSENT flag as evidence and certifies a rotation the wallet never
 * confirmed. Fixing the surfaces one by one could not close the class, because
 * nothing stopped surface N+1 from compiling a new local derivation.
 *
 * This test is that stop. Every claim now flows through `rotationVerdict`
 * (`rotation-verdict.ts`) or `deriveGuardianPresentation`
 * (`front/guardian-presentation.ts`); the files below are the complete set
 * that may still touch the raw fields, each for a stated reason. Adding a raw
 * read elsewhere fails CI - the fix is to consume the verdict/presentation
 * modules, not to grow this list.
 */

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../../../..');

/** A repository path with forward slashes, the form the allowlists use on every platform. */
const repoPath = (file: string, root: string = ROOT, paths: typeof path.win32 = path): string =>
  paths.relative(root, file).split(paths.sep).join('/');

/**
 * Every way a fenced field can be READ, found on the SYNTAX TREE. Two rules, so a new
 * spelling needs no matcher of its own:
 *
 *  - An IDENTIFIER naming the field: `x.flag` and `x?.flag` (and a write `x.flag = v`;
 *    writers are allowlisted by file), a destructuring binding at any depth or position
 *    (declaration, parameter, `for...of`, renamed or not), and a member of a
 *    destructuring assignment target (`({ flag } = x)`).
 *  - A STRING LITERAL naming the field, wherever it sits: `x['flag']`, `'flag' in x`,
 *    any call handed the key (`Object.hasOwn`, `hasOwnProperty.call`, `Reflect.has`,
 *    `Reflect.get`, `Object.getOwnPropertyDescriptor`, key-list membership), a computed
 *    or quoted name, a type assertion on the key, a loop variable compared to the name.
 *    A presence test reads the field's absence, the evidence F-222 misused, and
 *    production code has no other use for such a literal.
 *
 * The one literal that is not a read is the key of an object literal that writes the
 * field (`{ 'flag': true }`); an object literal that is the target of `=` or of a `for`
 * loop destructures, so its keys read. Indirection can still defeat this: a property
 * name held in a variable, or a helper that returns the whole `extraInputs`. The bar is
 * the forms a person writes without trying to evade the fence.
 */
const FLAG_NAMES = ['commitUnconfirmed', 'registerFailed', 'endpointPersistFailed'];
const SYNC_STATUS_NAMES = ['guardianSyncStatus'];

type FieldSet = readonly string[];

/** An object or array literal that destructures: the target of `=`, `for...of` or `for...in`, at any depth. */
const isDestructuringTarget = (literal: ts.Node): boolean => {
  let node = literal;
  while (
    ts.isPropertyAssignment(node.parent) ||
    ts.isObjectLiteralExpression(node.parent) ||
    ts.isArrayLiteralExpression(node.parent) ||
    ts.isParenthesizedExpression(node.parent)
  ) {
    node = node.parent;
  }
  const { parent } = node;
  return (
    (ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.left === node) ||
    ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === node)
  );
};

/** A literal that keys an object literal WRITING the field: `{ 'flag': v }` or `{ ['flag']: v }`. */
const isWriteKey = (literal: ts.Node): boolean => {
  let key = literal;
  while (
    ts.isParenthesizedExpression(key.parent) ||
    ts.isAsExpression(key.parent) ||
    ts.isSatisfiesExpression(key.parent) ||
    ts.isTypeAssertionExpression(key.parent) ||
    ts.isComputedPropertyName(key.parent)
  ) {
    key = key.parent;
  }
  const property = key.parent;
  return ts.isPropertyAssignment(property) && property.name === key && !isDestructuringTarget(property.parent);
};

/** Every fenced-field read in one file, as the source text that produced it. */
const fieldReads = (source: ts.SourceFile, names: FieldSet): string[] => {
  const fenced = new Set(names);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && fenced.has(node.name.text)) {
      found.push(node.getText());
    } else if (ts.isBindingElement(node)) {
      const read = node.propertyName ?? node.name;
      if (ts.isIdentifier(read) && fenced.has(read.text)) found.push(node.getText());
    } else if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isIdentifier(node.name) &&
      fenced.has(node.name.text) &&
      isDestructuringTarget(node.parent)
    ) {
      found.push(node.getText());
    } else if (ts.isStringLiteralLike(node) && fenced.has(node.text) && !isWriteKey(node)) {
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
 * A `.ts` file parsed as TSX is not rejected - `createSourceFile` never throws.
 * It returns a WRECKED TREE: the first generic arrow (`<T>(x: T) => x`) reads as
 * an unclosed JSX element, and everything after it collapses into error nodes
 * this walk then finds nothing in. Under a blanket `ScriptKind.TSX` that
 * silently unfenced five production modules, `guardian/direct-switch.ts` and
 * `transaction/index.ts` among them - the two likeliest places for a raw
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
  // The wiring hook selects the raw field to hand it to the derivation.
  'src/app/hooks/useGuardianPresentation.ts',
  // The reconciler state machine - the field's owner and only writer of record.
  'src/lib/miden/back/guardian-drift.ts',
  // Transport plumbing: request/response payloads carried, never interpreted.
  'src/lib/miden/back/main.ts',
  'src/lib/intercom/in-process-request-handler.ts',
  'src/lib/store/index.ts'
]);

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    // Tests construct rows and mock accounts freely - the fence governs
    // production derivations, not fixtures.
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)
      ? [full]
      : [];
  });

// `fileName` is not optional decoration: the licence check below feeds this real
// production `.ts` files, and defaulting them to the `.tsx` probe name parses
// them as JSX - the same fail-open that unfenced five modules. Here it fails the
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
      const rel = repoPath(file);
      if (allowed.has(rel)) continue;
      const reads = fieldReads(source, names);
      if (reads.length > 0) out.push(`${rel} (${reads.join(', ')})`);
    }
    return out.sort();
  };

  // A fence that scanned nothing would pass both assertions below in silence,
  // and the two narrowings that would actually blind it - dropping `.tsx`, or
  // rooting the walk at `src/lib` - each leave several hundred files, so a round
  // floor cannot tell them from a healthy scan. Pin the real magnitude, and pin
  // a UI file BY NAME so the half of the tree this fence exists for cannot be
  // dropped while the count still looks plausible.
  it('scans the whole source tree, UI included', () => {
    expect(files.length).toBeGreaterThan(600);
    expect(files).toContain(path.join(ROOT, 'src/app/templates/history/HistoryView.tsx'));
  });

  // Counting the files is not enough: a file can be scanned and still contribute
  // nothing, because a mis-parse produces error nodes rather than an exception.
  // That is exactly what a blanket `ScriptKind.TSX` did - the walk visited every
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
    expect(broken.map(file => repoPath(file))).toEqual([]);
    // The trees the scan walks must carry their own file's script kind too: a `.ts`
    // file read as TSX transpiles cleanly above and still walks as error nodes.
    const misparsed = [...parsed].filter(
      ([file, source]) =>
        source.languageVariant !== (file.endsWith('.tsx') ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard)
    );
    expect(misparsed.map(([file]) => repoPath(file))).toEqual([]);
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

  it('guardianSyncStatus is read only by its owner, the guard, the presentation hook and the plumbing', () => {
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
      // Identifier reads.
      ['dot access', 'const lying = tx.extraInputs.commitUnconfirmed === true;'],
      ['optional chain', 'const lying = tx.extraInputs?.commitUnconfirmed === true;'],
      ['destructuring', 'const { commitUnconfirmed } = tx.extraInputs ?? {};'],
      ['destructuring, renamed', 'const { commitUnconfirmed: unconfirmed } = tx.extraInputs ?? {};'],
      ['destructuring, defaulted', 'const { registerFailed = false } = tx.extraInputs ?? {};'],
      ['destructured parameter', 'const f = ({ endpointPersistFailed }) => true;'],
      ['destructured parameter, typed', 'const f = ({ endpointPersistFailed }: Flags) => true;'],
      [
        'destructured parameter on a function declaration',
        'function f({ endpointPersistFailed }: Flags) { return 1; }'
      ],
      ['destructured parameter on a method', 'const o = { f({ registerFailed }: Flags) { return 1; } };'],
      ['nested destructuring', 'const { extraInputs: { commitUnconfirmed } } = tx;'],
      ['for-of destructuring', 'for (const { commitUnconfirmed } of rows) { use(commitUnconfirmed); }'],
      ['destructuring assignment', `({ commitUnconfirmed: x } = extra);`],
      ['destructuring assignment, shorthand', `({ commitUnconfirmed } = extra);`],
      ['destructuring assignment, nested', `({ extraInputs: { commitUnconfirmed } } = tx);`],
      // Literal keys, however they are wrapped or handed over.
      ['bracket access', `const lying = tx.extraInputs['commitUnconfirmed'];`],
      ['bracket access, padded', `const lying = tx.extraInputs[ 'commitUnconfirmed' ];`],
      ['bracket access, as const', `const lying = extra['commitUnconfirmed' as const];`],
      ['bracket access, as string', `const lying = extra['commitUnconfirmed' as string];`],
      ['bracket access, satisfies', `const lying = extra['commitUnconfirmed' satisfies string];`],
      ['optional bracket access, as const', `const lying = extra?.['commitUnconfirmed' as const];`],
      ['presence test', `const legacy = !('commitUnconfirmed' in extra);`],
      ['presence test, parenthesized', `const legacy = !(('commitUnconfirmed') in extra);`],
      ['presence test, asserted', `const legacy = !(('commitUnconfirmed' as const) in extra);`],
      ['hasOwn', `const legacy = !Object.hasOwn(extra, 'commitUnconfirmed');`],
      ['hasOwn, non-null callee', `const legacy = !Object.hasOwn!(extra, 'commitUnconfirmed');`],
      [
        'hasOwn, asserted callee',
        `const legacy = !(Object.hasOwn as typeof Object.hasOwn)(extra, 'commitUnconfirmed');`
      ],
      ['hasOwn, parenthesized callee', `const legacy = !(Object.hasOwn)(extra, 'commitUnconfirmed');`],
      ['hasOwnProperty via .call', `const legacy = !Object.prototype.hasOwnProperty.call(extra, 'commitUnconfirmed');`],
      [
        'hasOwnProperty via .apply',
        `const legacy = !Object.prototype.hasOwnProperty.apply(extra, ['commitUnconfirmed']);`
      ],
      [
        'hasOwnProperty via .call, non-null receiver',
        `const legacy = !Object.prototype.hasOwnProperty!.call(extra, 'commitUnconfirmed');`
      ],
      ['Reflect.has', `const legacy = !Reflect.has(extra, 'commitUnconfirmed');`],
      ['Reflect.get', `const lying = Reflect.get(extra, 'commitUnconfirmed') === true;`],
      ['getOwnPropertyDescriptor', `const legacy = !Object.getOwnPropertyDescriptor(extra, 'commitUnconfirmed');`],
      [
        'Reflect.getOwnPropertyDescriptor',
        `const legacy = !Reflect.getOwnPropertyDescriptor(extra, 'commitUnconfirmed');`
      ],
      ['propertyIsEnumerable', `const legacy = !extra.propertyIsEnumerable('commitUnconfirmed');`],
      [
        'propertyIsEnumerable via .call',
        `const legacy = !Object.prototype.propertyIsEnumerable.call(extra, 'commitUnconfirmed');`
      ],
      ['key-list membership', `const legacy = !Object.keys(extra).includes('commitUnconfirmed');`],
      ['key-list membership via .call', `const legacy = !['a'].includes.call(keys, 'commitUnconfirmed');`],
      [
        'key-list membership, asserted callee',
        `const legacy = !(Object.keys(extra).includes as (key: string) => boolean)('commitUnconfirmed');`
      ],
      ['loop variable compared to the name', `for (const key in extra) { if (key === 'commitUnconfirmed') use(key); }`],
      ['computed destructuring', `const { ['commitUnconfirmed']: x } = extra;`],
      ['computed destructuring, asserted', `const { ['commitUnconfirmed' as const]: x } = extra;`],
      ['destructuring assignment, computed', `({ ['commitUnconfirmed']: x } = extra);`],
      ['destructuring, quoted name', `const { 'commitUnconfirmed': x } = extra;`],
      ['destructured parameter, quoted name', `function f({ 'registerFailed': failed }: Flags) { return failed; }`],
      ['nested destructuring, quoted name', `const { extraInputs: { 'endpointPersistFailed': x } } = tx;`],
      ['destructuring assignment, quoted name', `({ 'commitUnconfirmed': x } = extra);`]
    ];
    for (const [label, code] of caught) {
      expect(`${label}: ${matchCount(code, FLAG_NAMES)}`).toBe(`${label}: 1`);
    }

    // Prose about a field is not a read of it.
    expect(matchCount('// .registerFailed in prose does not count\n', FLAG_NAMES)).toBe(0);
    expect(matchCount('/* commitUnconfirmed, registerFailed */\n', FLAG_NAMES)).toBe(0);

    // The angle-bracket assertion exists only in a `.ts` file: in TSX `<string>` opens an element.
    expect(matchCount(`const lying = extra[<string>'commitUnconfirmed'];`, FLAG_NAMES, 'probe.ts')).toBe(1);

    expect(matchCount('if (account.guardianSyncStatus) {}', SYNC_STATUS_NAMES)).toBe(1);
    expect(matchCount('const { guardianSyncStatus } = account;', SYNC_STATUS_NAMES)).toBe(1);
    expect(matchCount(`const { 'guardianSyncStatus': status } = account;`, SYNC_STATUS_NAMES)).toBe(1);

    // Writes are allowlisted by file, not fenced by syntax: an object literal that
    // WRITES the field is not a read, whatever spelling its key uses.
    expect(matchCount('await update(id, { commitUnconfirmed: true });', FLAG_NAMES)).toBe(0);
    expect(matchCount('const patch = { commitUnconfirmed: true };', FLAG_NAMES)).toBe(0);
    expect(matchCount('tx.extraInputs = { ...ei, commitUnconfirmed: true };', FLAG_NAMES)).toBe(0);
    expect(matchCount(`const patch = { 'commitUnconfirmed': true };`, FLAG_NAMES)).toBe(0);
    expect(matchCount(`await update(id, { ['registerFailed']: true });`, FLAG_NAMES)).toBe(0);
    // A local variable that merely shares the name is not a field read either.
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

  it('matches allowlist entries with forward slashes on every platform', () => {
    // path.relative separates with backslashes on Windows, where the entries above would never match.
    expect(repoPath('C:\\repo\\src\\lib\\miden\\guardian\\rotation-verdict.ts', 'C:\\repo', path.win32)).toBe(
      'src/lib/miden/guardian/rotation-verdict.ts'
    );
  });
});

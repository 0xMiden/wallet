/**
 * The LEDGER FENCE: the guardian repair modules may not grow new hand-rolled
 * retry/budget state.
 *
 * Rounds 9 to 14 of the #786 review re-fixed the same budget-accounting mistakes
 * across four bespoke module-level Maps (charge timing, refunds, keying,
 * endpoint-change reset). Those ledgers now live in `attempt-ledger.ts`; this
 * scan pins the module-level Maps and Sets each guardian repair module still
 * holds, so a new repair either uses `createAttemptLedger`/`createRateCooldown`
 * or fails CI with this file in the diff, at which point the right fix is the
 * ledger, not the list.
 *
 * WHAT IT PINS, EXACTLY. Module-scope bindings of the Map/Set family, in every
 * guardian repair module, in the shapes such a binding is really written:
 * `export const`, a type annotation instead of a type argument, no type argument
 * at all, a WeakMap, a qualified constructor (`new globalThis.Map()`), and a
 * binding assigned on a later line. It does NOT see a keyed plain object
 * (`const seen: Record<string, number> = {}`) or a map returned by a helper
 * call. That limit is written down rather than left implied, because a fence
 * narrower than the rule it advertises is worse than none: it reads as
 * enforcement.
 *
 * THE FILE SET, EXACTLY. A recursive walk of `src/lib/miden/guardian`, plus the
 * `guardian-` prefixed modules of `src/lib/miden/front` and `src/lib/miden/back`,
 * in both TypeScript extensions. A walk rather than a hand-kept list, so a repair
 * module added under those trees tomorrow is scanned the day it lands.
 *
 * That is a NAME rule, and it is the fence's real boundary: guardian retry state
 * that lives in a differently-named module is outside it. The live example is
 * `front/sync-fuse.ts`, whose `ledger` map holds a per-probe failure count and a
 * backoff deadline, and which `guardian-sync.ts` feeds on its 429 branch under a
 * guardian-account key. It stays outside BY DESIGN: it is a realm-wide breaker
 * shared by four probe kinds, with its own watchdog-eviction semantics and a
 * monotonic deadline, not a repair budget keyed by an operator regime. Pulling it
 * in would make the fence a claim about all retry state everywhere, which is the
 * kind of promise this paragraph exists to stop making.
 *
 * The scan walks the syntax tree rather than the text, the same technique
 * `guardian-claim-fence.test.ts` uses one file over.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../../../..');

/**
 * Where a guardian repair can live: the guardian directory in full, plus the
 * guardian-prefixed modules of the front and back trees.
 */
const REPAIR_DIRS = ['src/lib/miden/front', 'src/lib/miden/back', 'src/lib/miden/guardian'];

const GUARDIAN_DIR = 'src/lib/miden/guardian';

const inGuardianTree = (dir: string): boolean => dir === GUARDIAN_DIR || dir.startsWith(`${GUARDIAN_DIR}/`);

const isRepairModule = (dir: string, file: string): boolean =>
  /\.tsx?$/.test(file) &&
  !/\.test\.tsx?$/.test(file) &&
  !file.endsWith('.d.ts') &&
  (inGuardianTree(dir) || file.startsWith('guardian-'));

/**
 * Every repair module under one root, subdirectories included. The root is a
 * parameter so the recursion is proved against a fixture: the repository has no
 * nested repair module today, so a regression here would otherwise have nothing
 * to fail against.
 */
const repairModulesUnder = (root: string, dir: string): string[] =>
  fs
    .readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap(entry =>
      entry.isDirectory()
        ? repairModulesUnder(root, `${dir}/${entry.name}`)
        : isRepairModule(dir, entry.name)
          ? [`${dir}/${entry.name}`]
          : []
    );

const repairModules = (): string[] => REPAIR_DIRS.flatMap(dir => repairModulesUnder(ROOT, dir)).sort();

const MAP_KINDS = ['Map', 'Set', 'WeakMap', 'WeakSet'];

/**
 * THE SCRIPT KIND FOLLOWS THE EXTENSION, and getting it wrong fails open:
 * `createSourceFile` never throws, so a mis-kinded parse just returns a tree
 * missing whatever it choked on. `guardian-claim-fence.test.ts` documents the
 * sharp direction one file over: a `.ts` source parsed as TSX reads its first
 * generic arrow as an unclosed JSX element and loses everything after it.
 *
 * Named, and asserted directly below, because the other direction cannot be
 * caught through this module's output: measured across five JSX shapes, TypeScript
 * resynchronizes at statement boundaries, so a module-scope `new Map()` is still
 * found even when a `.tsx` source is parsed as `.ts`. A test that fed JSX through
 * `moduleMapNamesIn` and expected a difference would pass whatever this line said.
 */
const scriptKindFor = (fileName: string): ts.ScriptKind =>
  fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

/**
 * The constructor a `new` expression names, however it is qualified: `new Map()`
 * and `new globalThis.Map()` are the same ledger.
 */
const mapKind = (node: ts.Node | undefined): string | undefined => {
  if (!node || !ts.isNewExpression(node)) return undefined;
  const callee = node.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
      ? callee.name.text
      : undefined;
  return name !== undefined && MAP_KINDS.includes(name) ? name : undefined;
};

/**
 * Every module-scope binding holding a new Map, Set, WeakMap or WeakSet.
 *
 * Module scope only: a declaration inside a function is somebody's local
 * bookkeeping, not a cross-tick ledger, and the syntax tree draws that line
 * exactly where an anchored regex only approximated it with a column.
 */
const moduleMapNamesIn = (source: string, fileName: string): string[] => {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const names = new Set<string>();
  for (const statement of tree.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (mapKind(declaration.initializer) && ts.isIdentifier(declaration.name)) {
          names.add(declaration.name.text);
        }
      }
      continue;
    }
    // `let pending; pending = new Map()`: the declaration carries no initializer,
    // so the assignment is where the ledger is really born.
    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)) {
      const { left, operatorToken, right } = statement.expression;
      if (operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(left) && mapKind(right)) {
        names.add(left.text);
      }
    }
  }
  return [...names].sort();
};

const moduleMapNames = (relPath: string): string[] =>
  moduleMapNamesIn(fs.readFileSync(path.join(ROOT, relPath), 'utf8'), relPath);

/**
 * The module-scope Maps and Sets the repair modules hold today, each with the
 * reason it is not a repair budget. A module missing from this table must hold
 * none. A new name is either a new ledger, and belongs in `createAttemptLedger`,
 * or a deliberate exception that states its reason here.
 */
const ALLOWED: Record<string, string[]> = {
  // Streak counters (persistence gates), not budgets: no cooldown, no cap, reset
  // by the next contrary verdict. The rest is identity and presentation state.
  'src/lib/miden/front/guardian-sync.ts': [
    'consecutiveAuthFailures',
    'consecutiveServerFailures',
    'consecutiveUnknownAccount',
    'hardeningChecked',
    'lastGuardianSyncAt',
    'outageAccounts',
    'outageListeners',
    'syncedGuardianEndpoint',
    'unrepairableAccounts'
  ],
  // A service cache, and the in-flight init promises that stop a 3s tick from
  // starting a second init: coalescing, not retry accounting.
  'src/lib/miden/front/guardian-manager.ts': ['guardianServiceCache', 'guardianServiceInflight'],
  // `nextDriftProbeAt` arms on entry (not on settle) and its constant doubles as
  // the persisted silent-run contiguity floor, so forcing it into the ledger
  // would change what it means. `driftPasses` holds the in-flight pass per
  // account so a second call joins it instead of starting a rival pass.
  'src/lib/miden/back/guardian-drift.ts': ['driftPasses', 'driftProbeEndpoint', 'nextDriftProbeAt'],
  // A one-shot latch, not a budget: at most one recovery attempt per backend
  // lifetime, released only where the run never got its turn. No cap curve and
  // no settle stamp, so the ledger would describe it worse than the Set does.
  'src/lib/miden/back/guardian-recovery.ts': ['startedRecoveries'],
  // The origins the native HTTP bridge may talk to: an allowlist.
  'src/lib/miden/guardian/native-http.ts': ['guardianOrigins'],
  // One promise chain per account, which serializes that account's guardian
  // transactions: ordering, not retry state.
  'src/lib/miden/guardian/serialize.ts': ['guardianTxChains']
};

describe('guardian repair modules hold no hand-rolled retry ledgers', () => {
  it('sees every module-scope ledger shape, not just the spellings a regex matched', () => {
    expect(
      moduleMapNamesIn(
        [
          'export const exported = new Map<string, number>();',
          'const annotated: Map<string, number> = new Map();',
          'const inferred = new Map();',
          'const weak = new WeakMap<object, number>();',
          'let mutable = new Set<string>();',
          'const qualified = new globalThis.Map<string, number>();',
          'let deferred: Map<string, number> | undefined;',
          'deferred = new Map<string, number>();',
          'function local() { const inside = new Map<string, number>(); return inside; }'
        ].join('\n'),
        'probe.ts'
      )
    ).toEqual(['annotated', 'deferred', 'exported', 'inferred', 'mutable', 'qualified', 'weak']);
  });

  it('parses each repair module by its extension, since a mis-kinded parse fails open', () => {
    expect(scriptKindFor('guardian-panel.tsx')).toBe(ts.ScriptKind.TSX);
    expect(scriptKindFor('guardian-sync.ts')).toBe(ts.ScriptKind.TS);
    // A .tsx module still yields its module-scope ledgers, which is what the walk is for.
    expect(
      moduleMapNamesIn(
        ['export const View = () => <div className="x" />;', 'const pending = new Map<string, number>();'].join('\n'),
        'probe.tsx'
      )
    ).toEqual(['pending']);
  });

  it('parses a .ts module as TypeScript, so a generic arrow does not wreck the tree', () => {
    // MEASURED, not assumed: parsed as TSX this source yields nothing at all, because `<T>` reads as an unclosed
    // JSX element and the declaration after it is lost. That is the direction guardian-claim-fence.test.ts
    // documents, and it is the half of the extension rule that a behavioural case can actually catch.
    expect(
      moduleMapNamesIn(
        ['const id = <T>(x: T) => x;', 'const pending = new Map<string, number>();'].join('\n'),
        'probe.ts'
      )
    ).toEqual(['pending']);
  });

  it('walks subdirectories and both extensions, so a repair module cannot hide one level down', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-fence-'));
    try {
      const nested = path.join(root, GUARDIAN_DIR, 'repair');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(root, GUARDIAN_DIR, 'flat.ts'), 'export const a = 1;\n');
      fs.writeFileSync(path.join(nested, 'retry.ts'), 'const attempts = new Map<string, number>();\n');
      fs.writeFileSync(path.join(nested, 'panel.tsx'), 'const seen = new Set<string>();\n');
      fs.writeFileSync(path.join(nested, 'retry.test.ts'), 'const ignored = new Map<string, number>();\n');

      expect(repairModulesUnder(root, GUARDIAN_DIR).sort()).toEqual([
        `${GUARDIAN_DIR}/flat.ts`,
        `${GUARDIAN_DIR}/repair/panel.tsx`,
        `${GUARDIAN_DIR}/repair/retry.ts`
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('walks every guardian repair module, and the table names only modules it walked', () => {
    const scanned = repairModules();
    // The walk is the source of truth; the table may not drift ahead of it.
    expect(scanned).toEqual(expect.arrayContaining(Object.keys(ALLOWED)));
    // A sanity floor: the two modules this fence was written for are in the walk.
    expect(scanned).toContain('src/lib/miden/front/guardian-sync.ts');
    expect(scanned).toContain('src/lib/miden/back/guardian-drift.ts');
  });

  it.each(repairModules())('%s holds only the module-scope maps the table documents', relPath => {
    expect(moduleMapNames(relPath)).toEqual([...(ALLOWED[relPath] ?? [])].sort());
  });
});

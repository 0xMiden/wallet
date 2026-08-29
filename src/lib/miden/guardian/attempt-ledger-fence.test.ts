/**
 * The LEDGER FENCE: the guardian repair modules may not grow new hand-rolled
 * retry/budget state.
 *
 * Rounds 9–14 of the #786 review re-fixed the same budget-accounting mistakes
 * across four bespoke module-level Maps (charge timing, refunds, keying,
 * endpoint-change reset). Those ledgers now live in `attempt-ledger.ts`; this
 * scan pins the module-level state every guardian module holds, so a new repair
 * either uses `createAttemptLedger`/`createRateCooldown` or fails CI with this
 * file in the diff — at which point the right fix is the ledger, not the list.
 *
 * DEFAULT-DENY, and that is the load-bearing property. The first version pinned
 * two files by hardcoded path, which made every other guardian module unfenced
 * by construction: `back/guardian-recovery.ts` already held a once-per-backend-
 * lifetime cap with a bespoke refund rule — two of the four mistakes the ledger
 * was extracted to end — and nothing looked at it. The file set is discovered
 * now, so a new guardian module fails until someone classifies its state.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../../../..');

/**
 * Module-scope state a budget could live in, found on the syntax tree.
 *
 * The regex this replaces recognised `= new Map/Set/WeakMap/WeakSet` and only
 * that, at the start of a line. Three ordinary forms walked straight through it,
 * all three verified against the real fence:
 *
 *  - `const attempts: Record<string, {count, nextAt}> = {};` — a plain-object
 *    budget, at least as idiomatic as a Map one and completely invisible;
 *  - a budget appended as a SECOND declarator to an existing allowed
 *    declaration, because a `^`-anchored match captures only the first — the
 *    enumerated list still showed the old name and nothing looked amiss;
 *  - `const backoff: Map<string, (n: number) => number> = new Map();`, where the
 *    annotation's `=>` defeated the `[^=]+` guarding the left-hand side.
 *
 * So the tree is asked instead, for the two shapes a budget actually takes:
 * a KEYED collection (`Map`/`Set`/`WeakMap`/`WeakSet`, `Object.create`, an empty
 * or `Record`-annotated object literal) and a mutable scalar COUNTER
 * (`let`/`var` initialised to a number). A config object with real properties is
 * neither, which is what keeps the expected lists readable.
 *
 * Function-local state stays invisible on purpose: it cannot survive a tick, so
 * it cannot be a budget.
 */
const KEYED_CONSTRUCTORS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);

/**
 * Names whose PROPERTIES this module writes — `x.n = 1`, `x.n += 1`, `x.n++`,
 * `delete x.n`, `Object.assign(x, …)`.
 *
 * This is what tells a single-subject budget from configuration, and nothing
 * else can: `{ attempts: 0, nextAt: 0 }` and `{ maxAttempts: 3, backoffMs:
 * 60_000 }` are the same syntax. The difference is that a budget is WRITTEN —
 * that is the whole of what makes it state — and a config is read-only for the
 * life of the module. Matching the shape alone flagged every config object in
 * the tree, which is the failure mode the expected lists exist to avoid.
 */
const mutatedPropertyOwners = (source: ts.SourceFile): Set<string> => {
  const owners = new Set<string>();
  const ownerOf = (node: ts.Node): void => {
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return;
    if (ts.isIdentifier(node.expression)) owners.add(node.expression.text);
  };
  // `=` and every compound form. `ts.isAssignmentOperator` is internal, so the
  // range is spelled out: the assignment operators are contiguous in the enum,
  // from `=` through `??=`.
  const isAssignment = (kind: ts.SyntaxKind): boolean =>
    kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) ownerOf(node.left);
    else if (ts.isPostfixUnaryExpression(node)) ownerOf(node.operand);
    else if (
      ts.isPrefixUnaryExpression(node) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      ownerOf(node.operand);
    } else if (ts.isDeleteExpression(node)) ownerOf(node.expression);
    else if (ts.isCallExpression(node) && node.expression.getText().endsWith('Object.assign')) {
      const target = node.arguments[0];
      if (target !== undefined && ts.isIdentifier(target)) owners.add(target.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return owners;
};

const isKeyedStore = (declaration: ts.VariableDeclaration, mutated: Set<string>): boolean => {
  const init = declaration.initializer;
  if (!init) return false;
  if (ts.isNewExpression(init)) {
    const ctor = init.expression.getText().split('.').pop() ?? '';
    return KEYED_CONSTRUCTORS.has(ctor);
  }
  if (ts.isCallExpression(init) && init.expression.getText().endsWith('Object.create')) return true;
  if (ts.isObjectLiteralExpression(init)) {
    // `= {}` is a store waiting to be filled; a literal with properties is
    // configuration. An index-signature or `Record<…>` annotation says store
    // whichever way it was initialised.
    if (init.properties.length === 0) return true;
    const annotation = declaration.type?.getText() ?? '';
    if (annotation.startsWith('Record<') || /^\{\s*\[/.test(annotation)) return true;
    // A literal WRAPPING stores is still a store — `{ attempts: new Map(), nextAt:
    // new Map() }` is the textbook hand-rolled budget, and reading only the
    // outer initializer waved it through. Grouping the maps in an object is the
    // most natural way to write one, not an evasion.
    return init.properties.some(property => {
      if (!ts.isPropertyAssignment(property)) return false;
      if (
        ts.isNewExpression(property.initializer) &&
        KEYED_CONSTRUCTORS.has(property.initializer.expression.getText().split('.').pop() ?? '')
      ) {
        return true;
      }
      // A WRITTEN numeric property is the single-subject budget: `const budget =
      // { attempts: 0, nextAt: 0 }` is the same ledger as the two-Map form for a
      // repair that handles one thing at a time — and several of these repairs
      // are keyed by nothing at all. Only the wrapping literal was inspected for
      // Maps, so this walked through while its keyed sibling was caught. The
      // write is what separates it from configuration, which is the same syntax.
      return ts.isNumericLiteral(property.initializer) && mutated.has(declaration.name.getText());
    });
  }
  return false;
};

/**
 * A reassignable numeric — the one-variable form of a budget ("attempts so far").
 *
 * Any numeric-looking initializer, not just a literal: `let n = 0` and
 * `let n = Number(0)` are the same counter, and requiring the literal meant the
 * second walked through. A `let` with a numeric ANNOTATION counts even when the
 * initializer is deferred.
 */
const isMutableCounter = (declaration: ts.VariableDeclaration, flags: ts.NodeFlags): boolean => {
  if ((flags & ts.NodeFlags.Const) !== 0) return false;
  if (declaration.type?.getText() === 'number') return true;
  const init = declaration.initializer;
  if (!init) return false;
  if (ts.isNumericLiteral(init)) return true;
  // `Number(...)`, `parseInt(...)`, `Date.now()`, `performance.now()` — the
  // shapes a counter or a deadline stamp is actually written with.
  return ts.isCallExpression(init) && /(^|\.)(Number|parseInt|parseFloat|now)$/.test(init.expression.getText());
};

/** Every module-scope store or counter in one file, by name. */
const moduleStateNames = (relPath: string): string[] => {
  const full = path.join(ROOT, relPath);
  const source = ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const mutated = mutatedPropertyOwners(source);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (isKeyedStore(declaration, mutated) || isMutableCounter(declaration, statement.declarationList.flags)) {
        names.push(declaration.name.getText());
      }
    }
  }
  return names.sort();
};

const guardianModules = (): string[] => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      // `.tsx` INCLUDED, because the extension was the whole fence: a guardian
      // module that renders anything — a hook, a provider — is a `.tsx`, and
      // one holding a budget was unfenced by file name alone. The sibling
      // claim fence walks `.tsx?` for the same reason.
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)
        ? [full]
        : [];
    });
  return walk(path.join(ROOT, 'src/lib/miden'))
    .map(full => path.relative(ROOT, full))
    .filter(rel => /guardian/i.test(rel))
    .sort();
};

/**
 * Every guardian module's module-scope state, with why each entry is not a
 * budget. A file absent from this map must hold none at all.
 */
const EXPECTED: Record<string, string[]> = {
  'src/lib/miden/back/guardian-drift.ts': [
    // The documented exception. `nextDriftProbeAt` arms on ENTRY (not on settle)
    // and its constant doubles as the persisted silent-run contiguity floor, so
    // forcing it into the ledger would change what it means.
    'driftProbeEndpoint',
    'nextDriftProbeAt'
  ],
  // Telemetry for the shadow dispatcher: a monotonic tally with no cap, no
  // cooldown and no effect on what runs. Nothing reads it to decide anything.
  'src/lib/miden/back/guardian-recovery-dispatcher.ts': ['divergenceCounts'],
  // A once-per-backend-lifetime gate with a hand-written release rule — the
  // closest thing in the tree to a budget outside the ledger, and unfenced
  // until this list was discovered rather than hardcoded. Left as-is because
  // its lifetime is the BACKEND's, not a cooldown window, but pinned here so a
  // cap or a backoff added to it fails CI.
  'src/lib/miden/back/guardian-recovery.ts': ['startedRecoveries'],
  // Identity caches keyed by account: a live service and its in-flight promise.
  // No attempt counting, and eviction is by explicit invalidation.
  'src/lib/miden/front/guardian-manager.ts': ['guardianServiceCache', 'guardianServiceInflight'],
  'src/lib/miden/front/guardian-sync.ts': [
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
    // Prompt evidence for an exhausted pending-rotation recheck — the budget
    // itself lives in `pendingRotationRecheckLedger`; this map only remembers
    // which row ran dry (keyed by row id, valued by the account that owns it,
    // so one exhausted row cannot condemn its siblings), and clears when the
    // row resolves.
    'pendingRotationExhaustedOwner',
    // The pass generation, bumped on endpoint change so a pass that started
    // against the old operator cannot record its verdict. A staleness token,
    // not a tally: nothing compares it to a cap.
    'syncGeneration',
    'syncedGuardianEndpoint',
    'unrepairableAccounts'
  ],
  // A static id lookup, `Record`-annotated and never written. Caught by the
  // `Record<` rule and listed rather than special-cased: the rule earns its
  // false positives by catching the plain-object budget that defeated the
  // regex, and one static table is a cheap price.
  'src/lib/miden/guardian/account.ts': ['PROVIDER_ID_MAP'],
  // The set of origins the native HTTP bridge may talk to — an allowlist, not
  // a tally.
  'src/lib/miden/guardian/native-http.ts': ['guardianOrigins'],
  // Transaction lineage for serialization, keyed by chain. No retry semantics.
  'src/lib/miden/guardian/serialize.ts': ['guardianTxChains']
};

describe('guardian repair modules hold no hand-rolled retry ledgers', () => {
  const modules = guardianModules();

  // A discovery walk that found nothing would make every assertion below vacuous.
  it('discovers the guardian modules, including the ones no list mentions', () => {
    expect(modules.length).toBeGreaterThan(10);
    expect(modules).toContain('src/lib/miden/guardian/attempt-ledger.ts');
    expect(modules).toContain('src/lib/miden/back/guardian-recovery.ts');
  });

  it('every guardian module holds exactly the module-scope state this list accounts for', () => {
    const found: [string, string[]][] = modules.map(rel => [rel, moduleStateNames(rel)]);
    const actual = Object.fromEntries(found.filter(([, names]) => names.length > 0));
    expect(actual).toEqual(EXPECTED);
  });

  // The ledger's own state lives inside `createAttemptLedger`, so it holds none
  // at module scope — which is what lets every other module be default-deny.
  it('the ledger itself keeps its state per-instance, not per-module', () => {
    expect(moduleStateNames('src/lib/miden/guardian/attempt-ledger.ts')).toEqual([]);
  });

  it('self-test: the scan catches every shape a hand-rolled budget takes', () => {
    const probe = path.join(ROOT, 'src/lib/miden/guardian/__ledger_fence_probe__.ts');
    const caught = [
      'const plainGeneric = new Map<string, number>();',
      'const inferred = new Map();',
      'let mutable = new Map<string, number>();',
      'var legacy = new Map<string, number>();',
      'export const exported = new Map<string, number>();',
      'const annotated: Map<string, number> = new Map();',
      'const weak = new WeakMap<object, number>();',
      'const set = new Set<string>();',
      // The three the regex missed, each verified green against it.
      'const recordBudget: Record<string, { count: number; nextAt: number }> = {};',
      'const bareStore = {};',
      'const fnValued: Map<string, (n: number) => number> = new Map();',
      'const nullProto = Object.create(null);',
      // A mutable scalar tally is a budget with one key.
      'let attemptsThisSession = 0;',
      // Both verified green against the AST version's FIRST cut: an object
      // literal is the most natural way to group the two maps a budget needs,
      // and a counter does not have to be initialised with a bare literal.
      'const bespokeBudget = { attempts: new Map<string, number>(), nextAt: new Map<string, number>() };',
      // The single-subject budget: no key at all, so neither Map rule saw it.
      // The write is what makes it state rather than the config it looks like.
      'const budget = { attempts: 0, nextAt: 0 };\nexport const spend = () => {\n  budget.attempts += 1;\n};',
      'let coercedTally = Number(0);',
      'let deadlineStamp = Date.now();',
      'let declaredLater: number;'
    ];
    try {
      for (const declaration of caught) {
        fs.writeFileSync(probe, `${declaration}\n`);
        expect(`${declaration} → ${moduleStateNames(path.relative(ROOT, probe)).length}`).toBe(`${declaration} → 1`);
      }

      // A second declarator is where a budget hides most quietly: the anchored
      // regex reported only the first name, so the pinned list still matched.
      fs.writeFileSync(probe, 'const allowed = new Set<string>(),\n  sneaked = new Map<string, number>();\n');
      expect(moduleStateNames(path.relative(ROOT, probe))).toEqual(['allowed', 'sneaked']);

      // Not state: configuration, and anything scoped to a function call.
      const ignored = [
        // Same syntax as the budget above and correctly invisible, because
        // nothing writes to it. This pair is the whole rule.
        'const config = { maxAttempts: 3, backoffMs: 60_000 };',
        'const config = { maxAttempts: 3 };\nexport const read = () => config.maxAttempts;',
        'const frozen = { a: 1 } as const;',
        'function f() {\n  const localTally = new Map<string, number>();\n  return localTally;\n}',
        'export const make = () => {\n  const state = new Map<string, number>();\n  return state;\n};',
        'const CEILING = 3;'
      ];
      for (const declaration of ignored) {
        fs.writeFileSync(probe, `${declaration}\n`);
        expect(`${declaration} → ${moduleStateNames(path.relative(ROOT, probe)).length}`).toBe(`${declaration} → 0`);
      }
    } finally {
      fs.rmSync(probe, { force: true });
    }
  });

  // There is no guardian `.tsx` in the tree today, which is exactly why the
  // extension mattered: the omission was invisible and would stay invisible
  // until the first guardian hook or provider arrived already unfenced. Probe
  // for the RULE rather than for a file, by putting one there.
  it('self-test: a .tsx guardian module is discovered, not skipped for its extension', () => {
    const probe = path.join(ROOT, 'src/lib/miden/guardian/__ledger_fence_probe__.tsx');
    try {
      fs.writeFileSync(probe, 'export const budget = new Map<string, number>();\n');
      expect(guardianModules()).toContain('src/lib/miden/guardian/__ledger_fence_probe__.tsx');
      expect(moduleStateNames('src/lib/miden/guardian/__ledger_fence_probe__.tsx')).toEqual(['budget']);
    } finally {
      fs.rmSync(probe, { force: true });
    }
  });

  // A probe file left behind would be picked up by the discovery walk and fail
  // the pinned map — but only on the NEXT run, which is a confusing way to find
  // out. Assert the cleanup here, where the reason is in view.
  it('self-test: the probe file does not survive the run', () => {
    expect(fs.existsSync(path.join(ROOT, 'src/lib/miden/guardian/__ledger_fence_probe__.ts'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'src/lib/miden/guardian/__ledger_fence_probe__.tsx'))).toBe(false);
  });
});

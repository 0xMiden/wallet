import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { TelemetryFlow, TelemetryOperation, TelemetryStep } from './types';

/**
 * Declaring a flow is not instrumenting it.
 *
 * The swap flow taught this: `swap` could be added to `TelemetryFlow`, typecheck
 * clean, pass every unit test, ship, and report absolutely nothing, because no
 * screen ever began it. Every other test in this module asserts what happens to
 * an event that exists. These assert that the event exists at all — that each
 * member of the two unions is reachable from a real surface rather than being a
 * name nothing emits.
 *
 * Source-scanned rather than driven, because "some component, somewhere, on a
 * path we did not think to render in a test" is exactly the gap. A false pass is
 * possible, a false failure is not, and the failure mode this guards against is
 * silence.
 *
 * Two ways a false pass happens, both worth knowing before trusting a green run
 * here. A literal in dead code satisfies the scan. And so does a bare mapping
 * entry: the operations and steps reached through the tables in
 * `transaction-operation.ts` and `connectivity-state.ts` are passed to the
 * reporter as variables, so what the scan can see is that a name is MAPPED, not
 * that any live path reports it. That is not hypothetical — the `node` and
 * `network` outages passed here while being unable to report their recovery at
 * all, because the only code that cleared them did not report. Behaviour of that
 * kind belongs in the owning module's own tests; this file answers the narrower
 * question of whether a declared name is wired to anything.
 */

const SRC = resolve(__dirname, '..', '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__mocks__' ? [] : sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

/**
 * The mapping module counts as a call site.
 *
 * `lib/telemetry/` is otherwise excluded so the unions' own declarations cannot
 * satisfy a search for themselves. `transaction-operation.ts` is the exception
 * because it is wiring, not declaration: it is where a transaction row's type
 * and stage become an operation and a step, exactly as the onboarding step table
 * is where a screen becomes a step. Excluding it would leave every pipeline step
 * looking uninstrumented while being the only reason any of them are reported.
 */
const WIRING_INSIDE_TELEMETRY = 'lib/telemetry/transaction-operation.ts';

/**
 * The only files whose `key: 'step_name'` entries count as instrumentation.
 *
 * A step reached through a table is passed to the reporter as a variable, so
 * there is no call site naming it and the table entry is the only evidence there
 * is. Which is fine — as long as the search for one is confined to the tables
 * that actually feed a reporter, and not to every object literal in the tree.
 */
const STEP_TABLES: readonly string[] = [WIRING_INSIDE_TELEMETRY, 'app/pages/Welcome.tsx'];

/** Non-test sources, excluding the telemetry module's own plumbing. */
const CALL_SITES: readonly { path: string; text: string }[] = sourceFiles(SRC)
  .map(path => ({ path: relative(SRC, path).split(sep).join('/'), text: readFileSync(path, 'utf8') }))
  .filter(file => !file.path.startsWith('lib/telemetry/') || file.path === WIRING_INSIDE_TELEMETRY);

/**
 * Does this file so much as know telemetry exists?
 *
 * The precondition on every match below, and the one that closes the whole
 * family of false passes rather than the latest instance of it. Each pattern
 * here is a heuristic over source text, so each one can be satisfied by
 * coincidence — a `setStep('review')` React state setter matched the call shape,
 * a Zustand `status: 'signing'` matched the table shape — and chasing those one
 * at a time by tightening the regex is a losing game, because the next
 * coincidence is written by somebody who has never read this file.
 *
 * A file that reports telemetry imports telemetry. That is not a heuristic, it
 * is a consequence, and it holds for the two known coincidences: neither
 * `VerifySeedPhraseFlow.tsx` nor `lib/epoch/store.ts` imports anything from
 * here.
 *
 * The absolute prefix, and not also a relative one. An earlier version allowed
 * `from './types'` so that `transaction-operation.ts` would qualify — and 43
 * files in the tree import a local `./types` of their own, which reopened the
 * hole one door down: a `setStep('review')` added to `send-flow/SelectRecipient`
 * would have satisfied `review` again. That file is allowed by path instead,
 * which is exact.
 */
const REPORTS_TELEMETRY = /from 'lib\/telemetry/;

/** Files that report telemetry without importing it, because they ARE it. */
const INSIDE_TELEMETRY: readonly string[] = [WIRING_INSIDE_TELEMETRY];

const reportsTelemetry = (file: { path: string; text: string }): boolean =>
  INSIDE_TELEMETRY.includes(file.path) || REPORTS_TELEMETRY.test(file.text);

const instrumentedFilesMatching = (pattern: RegExp, alsoAllow?: (path: string) => boolean): string[] =>
  CALL_SITES.filter(
    file => reportsTelemetry(file) && (pattern.test(file.text) || (alsoAllow?.(file.path) ?? false))
  ).map(file => file.path);

/**
 * Written as `Record`s over the unions so widening either one fails `yarn ts`
 * here until the new member is listed, and then fails this test until it is
 * actually wired to something.
 */
const EVERY_FLOW: Record<TelemetryFlow, TelemetryFlow> = {
  open: 'open',
  unlock: 'unlock',
  create: 'create',
  import: 'import',
  recover: 'recover',
  return: 'return',
  fund: 'fund',
  receive_share: 'receive_share',
  send: 'send',
  swap: 'swap',
  earn: 'earn',
  dapp_connect: 'dapp_connect',
  dapp_tx: 'dapp_tx',
  guardian_rotate: 'guardian_rotate',
  note_handle: 'note_handle',
  activity_view: 'activity_view'
};

const EVERY_STEP: Record<TelemetryStep, TelemetryStep> = {
  select_recipient: 'select_recipient',
  select_amount: 'select_amount',
  select_route: 'select_route',
  review: 'review',
  submitting: 'submitting',
  swap_amounts: 'swap_amounts',
  choose_protection: 'choose_protection',
  setup_passcode: 'setup_passcode',
  setup_biometric: 'setup_biometric',
  set_password: 'set_password',
  recovery_method: 'recovery_method',
  choose_guardian: 'choose_guardian',
  enter_phrase: 'enter_phrase',
  awaiting_approval: 'awaiting_approval',
  syncing: 'syncing',
  executing: 'executing',
  proving: 'proving',
  sending: 'sending',
  confirming: 'confirming',
  signing: 'signing',
  prove_delegate: 'prove_delegate',
  prove_local: 'prove_local',
  prove_fallback: 'prove_fallback'
};

const EVERY_OPERATION: Record<TelemetryOperation, TelemetryOperation> = {
  tx_send: 'tx_send',
  tx_receive: 'tx_receive',
  tx_swap: 'tx_swap',
  tx_earn: 'tx_earn',
  tx_bridge: 'tx_bridge',
  tx_guardian: 'tx_guardian',
  tx_dapp: 'tx_dapp',
  tx_other: 'tx_other',
  prove: 'prove',
  service_prover: 'service_prover',
  service_node: 'service_node',
  service_network: 'service_network'
};

describe('every declared flow is actually begun somewhere', () => {
  it.each(Object.keys(EVERY_FLOW) as TelemetryFlow[])('%s has a call site that starts it', flow => {
    // Two conditions on one file rather than a single call-shaped pattern: the
    // flow name does not always sit as a literal inside the call. Onboarding
    // passes it as a `'create' | 'import'` parameter and the dApp store picks it
    // with a ternary, both of which are perfectly good instrumentation and
    // neither of which a `beginFlow\('x'\)` regex can see.
    // The same `REPORTS_TELEMETRY` precondition as the other two axes. Less
    // exposed than they were, since `beginFlow` and `enterRouteFlow` are names
    // nothing else in the tree uses — but "no other file happens to use this
    // name" is a fact about today, and the precondition costs nothing.
    const started = CALL_SITES.filter(
      f =>
        reportsTelemetry(f) &&
        /\b(beginFlow|enterRouteFlow)\(/.test(f.text) &&
        new RegExp(String.raw`'${flow}'`).test(f.text)
    ).map(f => f.path);

    expect(started.length).toBeGreaterThan(0);
  });
});

/**
 * `tx_other` is the one name nothing may map onto.
 *
 * It is the landing place for a transaction type read back from IndexedDB that
 * this build has never heard of — a row written by a newer version, or by one
 * whose type was later renamed. Requiring a call site for it would mean writing
 * one, which would defeat the point: the map in `transaction-operation.ts` is
 * total, so anything reaching `tx_other` did so at runtime and by surprise.
 */
const UNREACHABLE_BY_DESIGN: readonly TelemetryOperation[] = ['tx_other'];

/**
 * Operations whose literal is fixed inside a helper rather than written at the
 * call site.
 *
 * `prove` is reported from three separate prove implementations — the
 * non-guardian fallback, the guardian inline leaf and the guardian offscreen
 * leaf — and every one of them wants the same fields computed the same way.
 * `reportProve` exists so those three cannot drift apart, at the cost that no
 * call site names `'prove'` and a literal search sees none of them.
 */
const DEDICATED_REPORTER: Partial<Record<TelemetryOperation, string>> = { prove: 'reportProve' };

/**
 * Tables that map something else onto an operation, and the accessor each one is
 * read through.
 *
 * The accessor is the load-bearing half. A table entry proves only that somebody
 * once wrote the name down; what makes it evidence of instrumentation is a
 * reporter reading it, and the accessor is how that read is visible in source
 * text. `operationOfType` turns a row's type into an operation for the four
 * terminal writers; `OUTAGE_OPERATION` turns a connectivity category into one
 * for `reportOutage`.
 */
const OPERATION_TABLES: readonly { path: string; accessor: string }[] = [
  { path: WIRING_INSIDE_TELEMETRY, accessor: 'operationOfType' },
  { path: 'lib/miden/activity/connectivity-state.ts', accessor: 'OUTAGE_OPERATION' }
];

const textOf = (path: string): string => CALL_SITES.find(file => file.path === path)?.text ?? '';

/**
 * Is this table's accessor read anywhere that actually reports?
 *
 * "In the same file as a `reportOperation` call" rather than "inside the call
 * text", because neither real accessor is written inline. `OUTAGE_OPERATION` is
 * read into a local one line above the call, and `operationOfType` is read in
 * four files other than the one declaring it. Both are covered by asking whether
 * the accessor and a reporter ever appear together, and both stop being covered
 * the moment the reporter goes away — which is the property worth having.
 */
const isConsumedByAReporter = (accessor: string): boolean =>
  CALL_SITES.some(file => file.text.includes(accessor) && /\breportOperation\(/.test(file.text));

describe('every declared operation is actually reported somewhere', () => {
  const reachable = (Object.keys(EVERY_OPERATION) as TelemetryOperation[]).filter(
    operation => !UNREACHABLE_BY_DESIGN.includes(operation)
  );

  it.each(reachable)('%s has a call site that reports it', operation => {
    // Three shapes, because three kinds of call site are all legitimate:
    // passed to `reportOperation` as a literal; sitting as the value of a
    // mapping entry, which is how the transaction operations are reached; or
    // named by a dedicated helper that hard-codes the operation, so the literal
    // lives in the helper and the call sites carry only its name.
    //
    // A mapping entry alone is not enough, and this is where that bit. The three
    // `service_*` operations are reached only through `OUTAGE_OPERATION` in
    // `connectivity-state.ts`, so gutting `reportOutage` to a bare `return` —
    // deleting the only thing that reports any of them — left this green on the
    // strength of a table nobody read any more. So a mapping entry counts only in
    // a file that also calls a reporter, which for a table means the table and
    // its reporter live together, and they do.
    const named = new RegExp(
      String.raw`reportOperation\(\{[^}]*'${operation}'` +
        (DEDICATED_REPORTER[operation] !== undefined ? String.raw`|${DEDICATED_REPORTER[operation]}\(` : ''),
      's'
    );
    const reported = CALL_SITES.filter(file => reportsTelemetry(file) && named.test(file.text)).map(file => file.path);

    // A table entry counts only when the table is CONSUMED by a reporter. The
    // entry itself is inert — `OUTAGE_OPERATION` kept all three `service_*` names
    // green after `reportOutage` was gutted to a bare `return`, because a table
    // does not stop existing when the only thing that reads it goes away. So the
    // evidence is the accessor appearing inside a live `reportOperation` call.
    const viaTable = OPERATION_TABLES.filter(
      table =>
        new RegExp(String.raw`:\s*'${operation}'`).test(textOf(table.path)) && isConsumedByAReporter(table.accessor)
    ).map(table => table.path);

    expect([...reported, ...viaTable].length).toBeGreaterThan(0);
  });

  it('reports an outcome for every kind of transaction the pipeline can produce', () => {
    // `tx_other` is the deliberate exception: it exists as the landing place for
    // a row type this build has never seen, so nothing maps onto it on purpose.
    const mapped = readFileSync(resolve(SRC, WIRING_INSIDE_TELEMETRY), 'utf8');
    const unmapped = (Object.keys(EVERY_OPERATION) as TelemetryOperation[]).filter(
      operation => operation.startsWith('tx_') && operation !== 'tx_other' && !mapped.includes(`'${operation}'`)
    );

    expect(unmapped).toEqual([]);
  });
});

describe('every declared step is actually reported somewhere', () => {
  it.each(Object.keys(EVERY_STEP) as TelemetryStep[])('%s has a call site that reports it', step => {
    // Three shapes, all of them inside a file that imports telemetry: a
    // `.step(...)` / `report*Step(...)` call, a `step:` key in a reporter's own
    // argument, or an entry in a table that maps something else onto a step.
    //
    // Every one of these shapes has been satisfied by coincidence at some point.
    // `signing` passed on a Zustand `set({ status: 'signing' })` in
    // `lib/epoch/store.ts`, which is what `STEP_TABLES` is for; `review` passed
    // on a `setStep('review')` React state setter in `VerifySeedPhraseFlow.tsx`,
    // which matches `Step\(` and no amount of regex tightening would reliably
    // predict the next one of those. `REPORTS_TELEMETRY` is the precondition that
    // does not depend on predicting them. A test that passes on the strength of
    // an unrelated string is worse than no test, because it reads as coverage.
    const named = new RegExp(String.raw`(\.step\(|Step\()[^)]*'${step}'|step:\s*'${step}'`);
    const inTable = new RegExp(String.raw`:\s*'${step}'`);
    const reported = instrumentedFilesMatching(
      named,
      path => STEP_TABLES.includes(path) && inTable.test(CALL_SITES.find(file => file.path === path)?.text ?? '')
    );

    expect(reported.length).toBeGreaterThan(0);
  });
});

describe('the multi-step flows report steps, not just start and end', () => {
  // A flow whose events carry no step is unanalysable past "started, then
  // stopped" — the state the whole wallet was in before this existed. Listed
  // explicitly, because a single-screen flow (`unlock`, `activity_view`) has no
  // step worth naming and must not be forced to invent one.
  const MULTI_STEP: readonly TelemetryFlow[] = ['send', 'swap', 'earn', 'create', 'import', 'guardian_rotate'];

  it.each(MULTI_STEP)('%s reports at least one step from the file that begins it', flow => {
    const owners = CALL_SITES.filter(
      f => /\b(beginFlow|enterRouteFlow)\(/.test(f.text) && new RegExp(String.raw`'${flow}'`).test(f.text)
    ).map(f => f.path);
    expect(owners.length).toBeGreaterThan(0);

    // The screen that starts a multi-step flow, or a sibling in the same
    // directory, must record progress on it. Directory rather than file because
    // a flow that spans routes (send, earn) is begun and advanced in different
    // components of the same feature folder.
    const directories = new Set(owners.map(path => path.slice(0, path.lastIndexOf('/'))));
    const reportsSteps = CALL_SITES.filter(
      f =>
        directories.has(f.path.slice(0, f.path.lastIndexOf('/'))) &&
        /\.step\(|reportRouteFlowStep\(|reportSendStep\(/.test(f.text)
    );

    expect(reportsSteps.length).toBeGreaterThan(0);
  });
});

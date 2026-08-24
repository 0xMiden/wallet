import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { TelemetryFlow, TelemetryStep } from './types';

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
 * possible (a literal in dead code), a false failure is not, and the failure
 * mode this guards against is silence.
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

/** Non-test sources, excluding the telemetry module's own plumbing. */
const CALL_SITES: readonly { path: string; text: string }[] = sourceFiles(SRC)
  .map(path => ({ path: relative(SRC, path).split(sep).join('/'), text: readFileSync(path, 'utf8') }))
  .filter(file => !file.path.startsWith('lib/telemetry/'));

const filesMatching = (pattern: RegExp): string[] => CALL_SITES.filter(f => pattern.test(f.text)).map(f => f.path);

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
  select_wallet_type: 'select_wallet_type',
  choose_protection: 'choose_protection',
  setup_passcode: 'setup_passcode',
  setup_biometric: 'setup_biometric',
  backup_phrase: 'backup_phrase',
  verify_phrase: 'verify_phrase',
  set_password: 'set_password',
  recovery_method: 'recovery_method',
  choose_guardian: 'choose_guardian',
  enter_phrase: 'enter_phrase',
  awaiting_approval: 'awaiting_approval'
};

describe('every declared flow is actually begun somewhere', () => {
  it.each(Object.keys(EVERY_FLOW) as TelemetryFlow[])('%s has a call site that starts it', flow => {
    // Two conditions on one file rather than a single call-shaped pattern: the
    // flow name does not always sit as a literal inside the call. Onboarding
    // passes it as a `'create' | 'import'` parameter and the dApp store picks it
    // with a ternary, both of which are perfectly good instrumentation and
    // neither of which a `beginFlow\('x'\)` regex can see.
    const started = CALL_SITES.filter(
      f => /\b(beginFlow|enterRouteFlow)\(/.test(f.text) && new RegExp(String.raw`'${flow}'`).test(f.text)
    ).map(f => f.path);

    expect(started.length).toBeGreaterThan(0);
  });
});

describe('every declared step is actually reported somewhere', () => {
  it.each(Object.keys(EVERY_STEP) as TelemetryStep[])('%s has a call site that reports it', step => {
    // Either a `.step(...)` / `report*Step(...)` call, or an entry in a step
    // table mapping a screen onto it (how onboarding reports its funnel).
    const reported = filesMatching(new RegExp(String.raw`(\.step\(|Step\()[^)]*'${step}'|:\s*'${step}'`));

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

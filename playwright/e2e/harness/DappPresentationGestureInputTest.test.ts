/** @jest-environment node */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

// Source wiring and real reducer grammar only: not Java compilation or runtime proof.
const root = resolve(__dirname, '../../..');
const source = readFileSync(
  resolve(root, 'android/app/src/androidTest/java/com/miden/wallet/DappPresentationGestureInputTest.java'),
  'utf8'
);
const runner = readFileSync(resolve(root, '.github/scripts/run-dapp-presentation-gesture-api36.sh'), 'utf8');
const workflow = readFileSync(resolve(root, '.github/workflows/e2e-dapp-browser.yml'), 'utf8');
const outcomes = ['returned-true', 'returned-false', 'call-threw'];
const locations = ['uia-acquisition', 'input-api-on-stack', 'swipe-on-stack', 'other-or-unavailable'];
const names = [...outcomes, ...locations];
const milestones = ['enter', 'swipe-succeeded', 'reply-built', 'write-returned'];
const prefix = (stage: number) =>
  milestones.slice(0, stage).map(name => `\nDAPP_SWIPE_MILESTONE_V1 ${name}\n`).join('');
const observation = (name: string) => `\nDAPP_SWIPE_CALL_V1 ${name}\n`;

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `source boundary: ${start}`);
  return text.slice(from, to);
}

function reduce(text: string, options: { replaced?: boolean; shortRead?: boolean } = {}): string {
  const bytes = Buffer.from(text);
  const stat = { dev: 1n, ino: 2n, size: BigInt(bytes.length), isFile: () => true };
  let output = '';
  const exit = {};
  try {
    runInNewContext(between(runner, "const fs = require('node:fs');", '\nNODE'), {
      Buffer,
      require(name: string) {
        assert.equal(name, 'node:fs');
        return {
          constants: { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 0 },
          fstatSync: (fd: number) => fd === 3 ? stat : { ...stat, ino: options.replaced ? 9n : 2n },
          lstatSync: () => ({ ...stat, ino: options.replaced ? 9n : 2n }),
          openSync: () => 4,
          readSync(_fd: number, target: Buffer) {
            target.set(bytes);
            return options.shortRead ? bytes.length - 1 : bytes.length;
          }
        };
      },
      process: {
        argv: ['node', '-', 'in-memory-only'],
        exit() { throw exit; },
        stdout: { write(value: string) { output += value; } }
      }
    });
  } catch (error) {
    if (error !== exit) throw error;
  }
  return output;
}

test('DappPresentationGestureInputTest: new finite call grammar and workflow allowlist (not Java proof)', () => {
  for (const name of names) {
    const text = prefix(1) + observation(name);
    assert.equal(reduce(text), `native-call-${name}`, `new finite observation ${name}`);
    assert.ok(workflow.includes(`"swipe-reply-started-no-injected: socket-inactivity: native-call-${name}"`));
    assert.equal(reduce(text, { replaced: true }), '');
    assert.equal(reduce(text, { shortRead: true }), '');
  }
  for (let stage = 1; stage <= 4; stage++) {
    assert.equal(reduce(prefix(stage)), ['native-enter-only', 'native-swipe-succeeded', 'native-reply-built', 'native-write-returned'][stage - 1]);
    assert.equal(reduce(prefix(stage) + observation('returned-true')), 'native-call-returned-true');
  }
  for (const text of [
    observation('returned-true'),
    prefix(1) + observation('private-canary'),
    prefix(1) + observation('returned-true') + observation('returned-false'),
    prefix(1) + observation('swipe-on-stack') + prefix(1),
    prefix(1) + observation('returned-false junk'),
    prefix(1) + observation('call-threw').slice(0, -1),
    prefix(1) + '\nDAPP_SWIPE_CALL',
    prefix(1) + observation('returned-true').replace('_V1', '_V2'),
    prefix(1) + observation('returned-true').replace('\nDAPP', '\nINSTRUMENTATION_STATUS: stream=DAPP'),
    prefix(2) + observation('returned-false'),
    prefix(2) + observation('call-threw'),
    ...locations.map(name => prefix(2) + observation(name)),
    prefix(1) + '\nDAPP_SWIPE_MILESTONE_V1 reply-built\n',
    prefix(1) + prefix(1),
    '\n'.repeat(1048576) + prefix(1) + observation('call-threw')
  ]) assert.equal(reduce(text), '', 'malformed, contradictory, canary or oversized capture stays coarse');
});

test('DappPresentationGestureInputTest: invocation outcome precedes unchanged assertion; same unchecked failure rethrown', () => {
  const input = between(source, 'boolean observeFirstSwipe =', 'assertEquals("wallet remains foreground after input"');
  assert.match(input, /executed == 0 && Boolean\.TRUE\.equals\(command\.opt\("observeFirstSwipe"\)\)/);
  assert.match(input, /observeSwipeMilestones\(swipeCheckpoint, swipeOutcome, new AtomicReference<>\(Thread\.currentThread\(\)\)\)/);
  assert.match(input, /try \{\s*swipeSucceeded = device\.swipe\(path, steps\);\s*\} catch \(RuntimeException \| Error failure\) \{\s*if \(observeFirstSwipe\) swipeOutcome\.set\(3\);\s*throw failure;\s*\}\s*if \(observeFirstSwipe\) swipeOutcome\.set\(swipeSucceeded \? 1 : 2\);\s*assertTrue\("one continuous UiDevice swipe must inject successfully", swipeSucceeded\);/);
  assert.equal((input.match(/device\.swipe\(/g) ?? []).length, 1);
  assert.doesNotMatch(input, /sendStatus|\.join\(|\.wait\(|Thread\.sleep|catch \(Throwable|failure\./);
  const ordered = [
    'output.println(reply(id, "started", executed, device).put("inputStartedMs", inputStarted));',
    'if (observeFirstSwipe) swipeCheckpoint.set(1);',
    'swipeSucceeded = device.swipe(path, steps);',
    'assertTrue("one continuous UiDevice swipe must inject successfully", swipeSucceeded);',
    'executed++;', 'long inputEnded = SystemClock.elapsedRealtime();',
    'if (observeFirstSwipe) swipeCheckpoint.set(2);',
    'JSONObject injected = reply(id, "injected", executed, device).put("inputEndedMs", inputEnded);',
    'if (observeFirstSwipe) swipeCheckpoint.set(3);', 'output.println(injected);',
    'if (observeFirstSwipe) swipeCheckpoint.set(4);'
  ].map(value => input.indexOf(value));
  assert.ok(ordered.every(value => value >= 0));
  assert.deepEqual(ordered, [...ordered].sort((a, b) => a - b));
});

test('DappPresentationGestureInputTest: one ephemeral bounded own-caller sample, terminal precedence and release before IPC', () => {
  // Both boundaries already exist on 5db: RED must be absent sampling, not a missing proposed helper.
  const observer = between(source, 'private static void observeSwipeMilestones(', 'private static int integer(');
  assert.equal((observer.match(/Thread\.sleep\(10_000\)/g) ?? []).length, 1);
  assert.equal((observer.match(/new Thread\(/g) ?? []).length, 1);
  assert.equal((observer.match(/swipeLocation\(caller\.get\(\)\)/g) ?? []).length, 1,
    'observer must sample its own caller exactly once');
  assert.match(observer, /int before = outcome\.get\(\);\s*String location = before == 0 \? swipeLocation\(caller\.get\(\)\) : "other-or-unavailable";\s*int after = outcome\.get\(\);\s*caller\.set\(null\);/);
  assert.match(observer, /int terminal = after != 0 \? after : before;/);
  assert.match(observer, /String\[\] outcomes = \{"other-or-unavailable", "returned-true", "returned-false", "call-threw"\};/);
  assert.match(observer, /terminal == 0 \? location : outcomes\[terminal\]/);
  assert.ok(observer.indexOf('caller.set(null);') < observer.indexOf('sendStatus(0, status)'));
  assert.match(observer, /finally \{\s*caller\.set\(null\);\s*\}/);
  assert.match(observer, /observer\.setDaemon\(true\);\s*observer\.start\(\);/);
  const location = between(source, 'private static String swipeLocation(', 'private static int integer(');
  assert.equal((location.match(/caller\.getStackTrace\(\)/g) ?? []).length, 1);
  assert.match(location, /stack\.length == 0 \|\| stack\.length > 256/);
  assert.match(location, /for \(int index = stack\.length - 1; index >= 0; index--\)/);
  assert.match(location, /"com\.miden\.wallet\.DappPresentationGestureInputTest"\.equals\(owner\) &&\s*"continuousGesturesOnTheExistingManagedPresentation"\.equals\(method\)/);
  assert.match(location, /anchored && "androidx\.test\.uiautomator\.UiDevice"\.equals\(owner\) && "swipe"\.equals\(method\)/);
  assert.match(location, /deviceSwipe && "androidx\.test\.uiautomator\.InteractionController"\.equals\(owner\) && "swipe"\.equals\(method\)/);
  assert.match(location, /controllerSwipe && "androidx\.test\.uiautomator\.InteractionController"\.equals\(owner\) && "injectEventSync"\.equals\(method\)/);
  assert.match(location, /controllerSwipe && "androidx\.test\.uiautomator\.UiDevice"\.equals\(owner\) && "getUiAutomation"\.equals\(method\)/);
  assert.match(location, /injectEvent && "android\.app\.UiAutomation"\.equals\(owner\) && "injectInputEvent"\.equals\(method\)/);
  assert.match(location, /catch \(RuntimeException ignored\)/);
  assert.doesNotMatch(observer + location, /getAllStackTraces|getThreadGroup|\.toString\(\).*stack|printStackTrace|getMessage|getFileName|getLineNumber|\.join\(|\.wait\(|device\.|socket\.|UiDevice\.|UiAutomation\.|catch \(Throwable/);
  const labels = [...location.matchAll(/return "([a-z-]+)";/g)].map(match => match[1]);
  assert.deepEqual([...new Set(labels)].sort(), [...locations].sort());
});

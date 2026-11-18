import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as swipeBoundary from './presentation-native-swipe-boundary.mjs';

const { reduceSwipeBoundary } = swipeBoundary;
const record = value => `\nDAPP_SWIPE_BOUNDARY_V2 ${value}\n`;
const entered = record('enter');
const under = entered + record('true under-budget');
const atLeast = entered + record('true at-least-budget');
const ready = under + record('reply-ready');
const clear = ready + record('writer-clear');
const nativeFalse = entered + record('false');
const nativeThrow = entered + record('throw');
const stage = 'capsule-cancel-reply-before-injected\n';

for (const [state, capture, budget] of [
  ['enter', entered],
  ['false', nativeFalse],
  ['throw', nativeThrow],
  ['true', under, 'under-budget'],
  ['true', atLeast, 'at-least-budget'],
  ['reply-ready', ready, 'under-budget'],
  ['writer-error', ready + record('writer-error'), 'under-budget'],
  ['writer-clear', clear, 'under-budget'],
  ['writer-clear', atLeast + record('reply-ready') + record('writer-clear'), 'at-least-budget'],
]) {
  test(`accepts the prefix ending at ${state} (${budget ?? 'no budget'})`, () => {
    assert.deepEqual(reduceSwipeBoundary(capture), { state, budget });
  });
}

test('ignores unrelated lines and an unrelated partial tail', () => {
  const capture = 'INSTRUMENTATION_STATUS_CODE: 1\nDappGestureInput ready port=8736\n.' + entered +
    'ordinary true text\n' + record('true under-budget') + 'unrelated partial tail';
  assert.deepEqual(reduceSwipeBoundary(capture), { state: 'true', budget: 'under-budget' });
});

for (const [label, capture] of [
  ['empty capture', ''],
  ['absent boundary', 'DappGestureInput ready port=8736\n\nOK (1 test)\n'],
  ['missing entry', record('true under-budget')],
  ['missing native outcome', entered + record('reply-ready')],
  ['missing reply-ready', under + record('writer-clear')],
  ['duplicate entry', entered + entered],
  ['duplicate outcome', under + record('true under-budget')],
  ['duplicate final checkpoint', clear + record('writer-clear')],
  ['conflicting outcomes', nativeFalse + record('throw')],
  ['conflicting budgets', under + record('true at-least-budget')],
  ['progress after throw', nativeThrow + record('true under-budget')],
  ['conflicting writer results', clear + record('writer-error')],
  ['unsupported value', entered + record('pending')],
  ['unsupported version', entered + '\nDAPP_SWIPE_BOUNDARY_V1 true\n'],
  ['missing budget', entered + record('true')],
  ['unknown budget', entered + record('true unknown')],
  ['budget on failure', entered + record('false under-budget')],
  ['budget on writer state', ready + record('writer-clear under-budget')],
  ['raw reporter wrapper', entered + '\nINSTRUMENTATION_STATUS: stream=DAPP_SWIPE_BOUNDARY_V2 true under-budget\n'],
  ['leading space', entered + '\n DAPP_SWIPE_BOUNDARY_V2 true under-budget\n'],
  ['trailing space', entered + record('true under-budget ')],
  ['embedded NUL', entered + record('true under-\0budget')],
  ['CRLF is not the attested raw shell framing', entered + '\nDAPP_SWIPE_BOUNDARY_V2 true under-budget\r\n'],
  ['unterminated final record', under.slice(0, -1)],
  ['truncated final value', entered + '\nDAPP_SWIPE_BOUNDARY_V2 tr'],
  ['truncated final prefix', entered + '\nDAPP_SWIPE_BOU'],
  ['wrapped and truncated prefix', entered + '\nINSTRUMENTATION_STATUS: stream=DAPP_SWIPE_BOU'],
]) {
  test(`rejects ${label}`, () => assert.equal(reduceSwipeBoundary(capture), undefined));
}

function withCapture(bytes, tag, check) {
  const dir = mkdtempSync(join(tmpdir(), 'native-swipe-fixture-'));
  try {
    const capture = join(dir, 'instrumentation.txt');
    const stageFile = join(dir, 'stage');
    writeFileSync(capture, bytes);
    if (tag !== undefined) writeFileSync(stageFile, tag);
    const { dev, ino } = statSync(capture, { bigint: true });
    check({
      capture,
      dir,
      stageFile,
      scope: `${dev}:${ino}`,
      snapshot: prefix => `${dev}:${ino}:${Buffer.byteLength(prefix)}`,
    });
  } finally {
    rmSync(dir, { recursive: true });
  }
}

for (const [label, tag, first, last, expected] of [
  ['enter-only with idle', stage + 'idle\n', entered, entered, 'unknown'],
  ['other rejection', stage + 'other\n', entered, entered, 'other-rejection'],
  ['under budget already visible', stage + 'idle\n', under, clear, 'idle-under-budget'],
  ['under budget first visible later', stage + 'idle\n', entered, clear, 'idle-under-budget-late-visible'],
  ['at least budget first visible later', stage + 'idle\n', entered, atLeast, 'idle-at-least-budget'],
  ['late native false', stage + 'idle\n', entered, nativeFalse, 'native-false'],
  ['late native throw', stage + 'idle\n', entered, nativeThrow, 'native-throw'],
  ['absent stage file', undefined, entered, clear, 'unknown'],
  ['absent tag', stage, entered, nativeThrow, 'unknown'],
  ['unknown tag', stage + 'timeout\n', entered, clear, 'unknown'],
  ['malformed tag', stage + 'idle', entered, clear, 'unknown'],
  ['conflicting tags', stage + 'idle\nother\n', entered, clear, 'unknown'],
  ['different stage', 'capsule-cancel-reply-after-injected\nidle\n', entered, clear, 'unknown'],
  ['missing entry snapshot', stage + 'idle\n', '', clear, 'unknown'],
  ['partial entry snapshot', stage + 'idle\n', under.slice(0, -2), clear, 'unknown'],
  ['partial final snapshot', stage + 'idle\n', entered, clear.slice(0, -1), 'unknown'],
  ['malformed final snapshot even with other tag', stage + 'other\n', entered, entered + record('true'), 'unknown'],
  ['conflicting final snapshot', stage + 'idle\n', under, under + record('false'), 'unknown'],
]) {
  test(`discriminates ${label}`, () => {
    // A complete native result physically present after the final byte boundary must never count.
    const extra = last === entered ? record('true under-budget') : '\nsynthetic later output\n';
    withCapture(last + extra, tag, ({ capture, stageFile, snapshot }) => {
      assert.equal(swipeBoundary.readSwipeVerdict(capture, stageFile, snapshot(first), snapshot(last)), expected);
    });
  });
}

test('unavailable or inconsistent snapshot metadata yields unknown', () => {
  withCapture(clear, stage + 'idle\n', ({ capture, dir, stageFile, scope, snapshot }) => {
    const first = snapshot(entered);
    const last = snapshot(clear);
    const verdict = (a, b, path = capture) => swipeBoundary.readSwipeVerdict(path, stageFile, a, b);
    for (const [a, b, path] of [
      ['', last], [first, ''], [last, first], [first, `${scope}:99999999`],
      [first, `${last}0`], [first, `${last}\n`], [first, `0:${last}`], [first.replace(/^\d+:/, '0:'), last],
      [first, last, dir], [first, last, join(dir, 'missing')],
    ]) {
      assert.equal(verdict(a, b, path), 'unknown');
    }
    writeFileSync(capture, entered);
    assert.equal(verdict(first, last), 'unknown');
  });
});

test('counts byte lengths, not UTF-16 characters', () => {
  const first = 'synthetic 🐾\n' + entered;
  const last = first + record('true under-budget');
  withCapture(last, stage + 'idle\n', ({ capture, stageFile, snapshot }) => {
    assert.equal(swipeBoundary.readSwipeVerdict(capture, stageFile, snapshot(first), snapshot(last)),
      'idle-under-budget-late-visible');
  });
});

test('synthetic inactivity rejection preserves and classifies exact error identity', async () => {
  const idleErrors = new WeakSet();
  let destroyedWith;
  let fireTimeout;
  const result = new Promise((resolve, reject) => {
    const destroy = error => {
      destroyedWith = error;
      reject(error);
    };
    fireTimeout = () => {
      const error = new Error('synthetic inactivity');
      idleErrors.add(error);
      destroy(error);
    };
  });
  const kind = error => error instanceof Error && idleErrors.has(error) ? 'idle' : 'other';
  fireTimeout();
  await assert.rejects(result, error => {
    assert.equal(error, destroyedWith);
    assert.equal(kind(error), 'idle');
    assert.equal(kind(new Error(error.message)), 'other');
    return true;
  });
  for (const error of [new Error('EOF'), new Error('ECONNRESET'), new Error('protocol rejection'), undefined]) {
    assert.equal(kind(error), 'other');
  }
});

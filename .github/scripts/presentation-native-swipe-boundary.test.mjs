import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSwipeBoundary, reduceSwipeBoundary } from './presentation-native-swipe-boundary.mjs';

const record = value => `\nDAPP_SWIPE_BOUNDARY_V1 ${value}\n`;
const entered = record('enter');
const succeeded = entered + record('true');
const ready = succeeded + record('reply-ready');

for (const [expected, capture] of [
  ['enter', entered],
  ['false', entered + record('false')],
  ['throw', entered + record('throw')],
  ['true', succeeded],
  ['reply-ready', ready],
  ['writer-error', ready + record('writer-error')],
  ['writer-clear', ready + record('writer-clear')],
]) {
  test(`accepts the prefix ending at ${expected}`, () => assert.equal(reduceSwipeBoundary(capture), expected));
}

test('ignores unrelated lines and an unrelated partial tail', () => {
  const capture = 'INSTRUMENTATION_STATUS_CODE: 1\nDappGestureInput ready port=8736\n.' + entered +
    'ordinary true text\n' + record('true') + 'unrelated partial tail';
  assert.equal(reduceSwipeBoundary(capture), 'true');
});

for (const [label, capture] of [
  ['empty capture', ''],
  ['absent boundary', 'DappGestureInput ready port=8736\n\nOK (1 test)\n'],
  ['missing entry', record('true')],
  ['missing native outcome', entered + record('reply-ready')],
  ['missing reply-ready', succeeded + record('writer-clear')],
  ['duplicate entry', entered + entered],
  ['duplicate outcome', succeeded + record('true')],
  ['duplicate final checkpoint', ready + record('writer-clear') + record('writer-clear')],
  ['conflicting outcomes', entered + record('false') + record('throw')],
  ['progress after throw', entered + record('throw') + record('true')],
  ['conflicting writer results', ready + record('writer-clear') + record('writer-error')],
  ['unsupported value', entered + record('pending')],
  ['unsupported version', entered + '\nDAPP_SWIPE_BOUNDARY_V2 true\n'],
  ['raw reporter wrapper', entered + '\nINSTRUMENTATION_STATUS: stream=DAPP_SWIPE_BOUNDARY_V1 true\n'],
  ['leading space', entered + '\n DAPP_SWIPE_BOUNDARY_V1 true\n'],
  ['trailing space', entered + record('true ')],
  ['embedded NUL', entered + record('tr\0ue')],
  ['CRLF is not the attested raw shell framing', entered + '\nDAPP_SWIPE_BOUNDARY_V1 true\r\n'],
  ['unterminated final record', entered + record('true').slice(0, -1)],
  ['truncated final value', entered + '\nDAPP_SWIPE_BOUNDARY_V1 tr'],
  ['truncated final prefix', entered + '\nDAPP_SWIPE_BOU'],
  ['wrapped and truncated prefix', entered + '\nINSTRUMENTATION_STATUS: stream=DAPP_SWIPE_BOU'],
]) {
  test(`rejects ${label}`, () => assert.equal(reduceSwipeBoundary(capture), 'unknown'));
}

test('reads only the synthetic capture; missing or unreadable input yields unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-swipe-fixture-'));
  try {
    const capture = join(dir, 'instrumentation.txt');
    assert.equal(readSwipeBoundary(capture), 'unknown');
    assert.equal(readSwipeBoundary(dir), 'unknown');
    writeFileSync(capture, ready);
    assert.equal(readSwipeBoundary(capture), 'reply-ready');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

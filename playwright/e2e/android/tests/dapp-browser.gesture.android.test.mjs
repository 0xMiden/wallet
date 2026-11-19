import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const spec = readFileSync(new URL('./dapp-browser.gesture.android.spec.ts', import.meta.url), 'utf8');

// Execute only the real parser and failure path, without loading the live spec.
// shortcut: extraction depends on source boundaries; use a shared helper if they stop being stable.
function extract(from, to) {
  const start = spec.indexOf(from);
  const end = spec.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `Gesture spec boundaries changed: ${from} ... ${to}`);
  return spec.slice(start, end);
}

const parser = extract('function input(', 'async function footprint(');
const writer = extract('async function markStage(', '\ninterface Point');
const body = extract('// A started reply precedes injection', '\n      });');
const caseName = 'capsule-cancel';

async function assertSwipeMarker({ phases = [], reply, inactive, kindFallback, privateOutput = true, stage, error }) {
  const overrideKind = kindFallback
    ? `const realInput = input; input = (command, phase, sink) => realInput(command, phase).catch(error => {
      if (sink && kindFallback === 'unrecognized') sink.kind = 'synthetic-unrecognized-kind';
      throw error;
    });`
    : '';
  const code = stripTypeScriptTypes(`let commandId = 0; ${writer}\n${parser}\n${overrideKind}\n(async () => { ${body} })()`);
  const writes = [];
  let onInactivity;
  let destroyError;
  const socket = Object.assign(new EventEmitter(), {
    setTimeout(_, callback) {
      onInactivity = callback;
    },
    end() {},
    destroy(error) {
      destroyError = error;
    }
  });
  const atPoll = Promise.withResolvers();
  const releasePoll = Promise.withResolvers();
  const expect = actual => ({ toBe: expected => assert.equal(actual, expected, 'execution count') });
  expect.poll = () => ({
    toBe: async () => {
      atPoll.resolve();
      await releasePoll.promise;
      throw new Error('synthetic poll failure');
    }
  });

  const outcome = runInNewContext(code, {
    stagePath: privateOutput ? 'in-memory-only' : undefined,
    kindFallback,
    writeFile: async (_, bytes) => {
      writes.push(bytes);
    },
    createConnection: () => socket,
    points: [],
    name: caseName,
    bounds: { executed: 3 },
    expect
  }).then(
    () => assert.fail('expected the case to fail'),
    failure => failure
  );
  const send = frame => socket.emit('data', JSON.stringify(frame) + '\n');

  await atPoll.promise;
  for (const phase of phases) send({ id: 1, phase });
  releasePoll.resolve();
  // Let the failed poll reach the pending swipe await before settling the fake socket.
  await new Promise(setImmediate);
  const handoff = privateOutput ? ['swipe-handoff\n'] : [];
  assert.deepEqual(writes, handoff, 'pending must not replace the handoff marker');

  if (reply) send(reply);
  if (inactive) onInactivity();
  if (reply?.phase === 'done') {
    assert.match((await outcome).message, error);
  } else {
    if (reply) assert.equal(destroyError?.message, 'Native gesture command identity mismatch');
    if (inactive) assert.equal(destroyError?.message, 'Native gesture input timed out');
    // Use the same message for real inactivity and a plain socket error: origin, not text, decides.
    const original = destroyError ?? new Error('Native gesture input timed out');
    assert.deepEqual(writes, handoff, 'destroy must not mark before settlement');
    socket.emit('error', original);
    socket.emit('close');
    assert.equal(await outcome, original, 'first rejection must be rethrown unchanged');
  }
  assert.deepEqual(writes, stage ? [...handoff, `${stage}\n`] : handoff, 'exact stage marker bytes');
}

test('keeps coarse host swipe markers and gives confirmation precedence', { timeout: 5_000 }, async () => {
  for (const scenario of [
    { stage: 'swipe-reply-no-started' },
    { reply: { id: 2, phase: 'started' }, stage: 'swipe-reply-no-started' },
    { phases: ['started'], kindFallback: 'missing', stage: 'swipe-reply-started-no-injected' },
    { phases: ['started'], kindFallback: 'unrecognized', stage: 'swipe-reply-started-no-injected' },
    { phases: ['started', 'injected'], stage: caseName },
    { reply: { id: 1, phase: 'done', executed: 3 }, stage: caseName, error: /execution count/ },
    { phases: ['started'], privateOutput: false }
  ]) {
    await assertSwipeMarker(scenario);
  }
});

for (const { kind, ...stimulus } of [
  { kind: 'framing-protocol', reply: { id: 2, phase: 'injected' } },
  { kind: 'socket-error-or-close' },
  { kind: 'socket-inactivity', inactive: true }
]) {
  test(`marks caught started-without-injected swipe as ${kind}`, { timeout: 5_000 }, () =>
    assertSwipeMarker({ ...stimulus, phases: ['started'], stage: `swipe-reply-started-no-injected: ${kind}` })
  );
}

test('classifies the first swipe rejection at settlement without replacing its error', async () => {
  const code = stripTypeScriptTypes(`let commandId = 0; ${parser}\ninput({ op: 'swipe' }, undefined, rejection)`);
  for (const [scenario, kind] of [
    ['wrong command reply', 'framing-protocol'],
    ['socket error', 'socket-error-or-close'],
    ['close without a result', 'socket-error-or-close'],
    ['inactivity callback', 'socket-inactivity'],
    ['done before close', undefined]
  ]) {
    const rejection = {};
    let onInactivity;
    let destroyError;
    const socket = Object.assign(new EventEmitter(), {
      setTimeout(ms, callback) {
        assert.equal(ms, 30_000);
        onInactivity = callback;
      },
      end() {},
      destroy(error) {
        // Deliver the error separately: destroy itself does not settle the swipe.
        destroyError = error;
      }
    });
    const pending = runInNewContext(code, { createConnection: () => socket, rejection });
    const send = frame => socket.emit('data', JSON.stringify(frame) + '\n');
    send({ id: 1, phase: 'started' });
    assert.equal(rejection.kind, undefined, scenario);

    if (scenario === 'done before close') {
      send({ id: 1, phase: 'done' });
      await pending;
      socket.emit('error', new Error('synthetic late socket error'));
    } else if (scenario === 'close without a result') {
      socket.emit('close');
      await assert.rejects(pending, { message: 'Native gesture input closed without a result' }, scenario);
    } else {
      let original;
      if (scenario === 'socket error') {
        // Identical text to the inactivity error is still a socket error.
        original = new Error('Native gesture input timed out');
      } else {
        if (scenario === 'inactivity callback') onInactivity();
        else send({ id: 2, phase: 'injected' });
        original = destroyError;
        assert.equal(
          original?.message,
          scenario === 'inactivity callback'
            ? 'Native gesture input timed out'
            : 'Native gesture command identity mismatch',
          scenario
        );
        assert.equal(rejection.kind, undefined, `${scenario}: destroy must not classify before settlement`);
      }
      socket.emit('error', original);
      await assert.rejects(pending, error => error === original, scenario);
    }

    assert.equal(rejection.kind, kind, `${scenario}: first settlement`);
    socket.emit('close');
    assert.equal(rejection.kind, kind, `${scenario}: later close must not replace first settlement`);
  }
});

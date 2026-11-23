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
const host = extract('const stagePath =', 'async function footprint(');
const body = extract('// A started reply precedes injection', '\n      });');
const caseName = 'capsule-cancel';

async function assertSwipeMarker({
  phases = [],
  reply,
  inactive,
  otherErrorFirst,
  frameAfterTimeout,
  lateFrame,
  kindFallback,
  privateOutput = true,
  name = caseName,
  boundsExecuted = 3,
  previousSwipe = false,
  stage,
  error
}) {
  const overrideKind = kindFallback
    ? `const realInput = input; input = (command, phase, sink) => realInput(command, phase).catch(error => {
      if (sink && kindFallback === 'unrecognized') sink.kind = 'synthetic-unrecognized-kind';
      throw error;
    });`
    : '';
  const code = stripTypeScriptTypes(`${host}\n${overrideKind}\n(async () => {
    if (previousSwipe) {
      await input({ op: 'bounds' });
      await input({ op: 'swipe', points, steps: 150 });
    }
    const bounds = await input({ op: 'bounds' });
    ${body}
  })()`);
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
  const pollError = new Error('synthetic poll failure');
  const expect = actual => ({ toBe: expected => assert.equal(actual, expected, 'execution count') });
  expect.poll = () => ({
    toBe: async () => {
      atPoll.resolve();
      await releasePoll.promise;
      throw pollError;
    }
  });
  // Complete an earlier bounds/swipe pair in the same host invocation for the ordinal control.
  const setupCounts = previousSwipe ? [0, 1, boundsExecuted] : [boundsExecuted];
  const swipeId = setupCounts.length + 1;
  let connections = 0;
  const send = (frame, target = socket) =>
    target.emit('data', JSON.stringify({ id: swipeId, width: 1080, height: 2400, ...frame }) + '\n');

  const outcome = runInNewContext(code, {
    process: {
      env: {
        PRESENTATION_GESTURE_PRIVATE_OUTPUT: String(privateOutput),
        PRESENTATION_GESTURE_STAGE_FILE: 'in-memory-only'
      }
    },
    kindFallback,
    writeFile: async (_, bytes) => {
      writes.push(bytes);
    },
    createConnection: () => {
      const id = ++connections;
      if (id === swipeId) return socket;
      const setup = Object.assign(new EventEmitter(), { setTimeout() {}, end() {} });
      queueMicrotask(() => send({ id, phase: 'done', executed: setupCounts[id - 1] }, setup));
      return setup;
    },
    points: [],
    name,
    previousSwipe,
    expect
  }).then(
    () => assert.fail('expected the case to fail'),
    failure => failure
  );

  await atPoll.promise;
  for (const phase of phases) {
    send(typeof phase === 'string' ? { phase, executed: boundsExecuted + (phase === 'injected' ? 1 : 0) } : phase);
  }
  releasePoll.resolve();
  // Let the failed poll reach the pending swipe await before settling the fake socket.
  await new Promise(setImmediate);
  const handoff = privateOutput ? ['swipe-handoff\n'] : [];
  assert.deepEqual(writes, handoff, 'pending must not replace the handoff marker');

  let timeoutError;
  if (inactive) {
    onInactivity();
    timeoutError = destroyError;
    assert.equal(timeoutError?.message, 'Native gesture input timed out');
    if (frameAfterTimeout) send(frameAfterTimeout);
  }
  if (reply) send(reply);
  assert.deepEqual(writes, handoff, 'destroy must not mark before settlement');
  if (reply?.phase === 'done') {
    if (timeoutError) socket.emit('error', timeoutError);
    socket.emit('close');
    const failure = await outcome;
    if (error) assert.match(failure.message, error);
    else assert.equal(failure, pollError, 'done must leave the original poll error unchanged');
  } else {
    if (reply) assert.equal(destroyError?.message, 'Native gesture command identity mismatch');
    // Use the same message for real inactivity and a plain socket error: origin, not text, decides.
    const plainError = new Error('Native gesture input timed out');
    const original = otherErrorFirst ? plainError : (timeoutError ?? destroyError ?? plainError);
    socket.emit('error', original);
    if (otherErrorFirst) socket.emit('error', timeoutError);
    // Deliver before the awaiting catch runs, but after input() has settled synchronously.
    if (lateFrame) send(lateFrame);
    socket.emit('close');
    assert.equal(await outcome, original, 'first rejection must be rethrown unchanged');
  }
  assert.deepEqual(writes, stage ? [...handoff, `${stage}\n`] : handoff, 'exact stage marker bytes');
}

test('keeps coarse host swipe markers and gives confirmation precedence', { timeout: 5_000 }, async () => {
  for (const scenario of [
    { stage: 'swipe-reply-no-started' },
    { reply: { id: 1, phase: 'started', executed: 3 }, stage: 'swipe-reply-no-started' },
    { phases: ['started'], kindFallback: 'missing', stage: 'swipe-reply-started-no-injected' },
    { phases: ['started'], kindFallback: 'unrecognized', stage: 'swipe-reply-started-no-injected' },
    { phases: ['started', 'injected'], stage: caseName },
    { reply: { phase: 'done', executed: 3 }, stage: caseName, error: /execution count/ },
    { phases: ['started'], privateOutput: false }
  ]) {
    await assertSwipeMarker(scenario);
  }
});

for (const { kind, ...stimulus } of [
  { kind: 'framing-protocol', reply: { id: 1, phase: 'injected', executed: 4 } },
  { kind: 'socket-error-or-close' },
  { kind: 'socket-inactivity', inactive: true }
]) {
  test(`marks caught started-without-injected swipe as ${kind}`, { timeout: 5_000 }, () =>
    assertSwipeMarker({ ...stimulus, phases: ['started'], stage: `swipe-reply-started-no-injected: ${kind}` })
  );
}

const coarseInactivity = 'swipe-reply-started-no-injected: socket-inactivity';
const firstSwipeEligible = 'swipe-reply-started-no-injected: socket-inactivity: first-swipe-eligible';
const startedAtZero = { phase: 'started', executed: 0 };
const injected = { phase: 'injected', executed: 1 };

for (const [scenario, stimulus] of [
  ['marks the first matching zero-count started on inactivity', { stage: firstSwipeEligible }],
  [
    'keeps a later host swipe coarse even with zero counts',
    { previousSwipe: true, stage: coarseInactivity }
  ],
  [
    'does not accept a started reply for a different command',
    { phases: [], reply: { ...startedAtZero, id: 1 }, stage: 'swipe-reply-no-started' }
  ],
  ['keeps a nonzero started count coarse', { phases: [{ ...startedAtZero, executed: 1 }], stage: coarseInactivity }],
  ['does not coerce a string zero count', { phases: [{ ...startedAtZero, executed: '0' }], stage: coarseInactivity }],
  ['keeps injected confirmation between timeout and rejection', { frameAfterTimeout: injected, stage: caseName }],
  [
    'keeps accepted done confirmation before an inactivity error',
    { reply: { phase: 'done', executed: 1 }, stage: caseName }
  ],
  ['does not let a late injected reply erase eligibility', { lateFrame: injected, stage: firstSwipeEligible }],
  [
    'does not let a late started reply create eligibility',
    { phases: [], lateFrame: startedAtZero, stage: 'swipe-reply-no-started' }
  ],
  [
    'keeps the first plain socket error despite identical inactivity text',
    { otherErrorFirst: true, stage: 'swipe-reply-started-no-injected: socket-error-or-close' }
  ],
  ['does not write eligible stages outside private mode', { privateOutput: false }]
]) {
  test(`host swipe: ${scenario}`, { timeout: 5_000 }, () =>
    assertSwipeMarker({ inactive: true, boundsExecuted: 0, phases: [startedAtZero], ...stimulus })
  );
}

test('classifies the first swipe rejection at settlement without replacing its error', async () => {
  const code = stripTypeScriptTypes(`let commandId = 0; ${parser}\ninput({ op: 'swipe' }, onPhase, rejection)`);
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
    const phases = [];
    const pending = runInNewContext(code, { createConnection: () => socket, onPhase: phase => phases.push(phase), rejection });
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
      if (scenario === 'inactivity callback') {
        send({ id: 1, phase: 'injected' });
        assert.deepEqual(phases, ['started', 'injected'], 'matching late phase callback is preserved');
        send({ id: 2, phase: 'injected' });
        assert.equal(destroyError?.message, 'Native gesture command identity mismatch');
      }
      await assert.rejects(pending, error => error === original, scenario);
    }

    assert.equal(rejection.kind, kind, `${scenario}: first settlement`);
    socket.emit('close');
    assert.equal(rejection.kind, kind, `${scenario}: later close must not replace first settlement`);
  }
});

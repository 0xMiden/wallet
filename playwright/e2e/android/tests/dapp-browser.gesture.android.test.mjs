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
const body = extract('// A started reply precedes injection', '\n      });');
const code = stripTypeScriptTypes(`let commandId = 0; ${parser}\n(async () => { ${body} })()`);

test('classifies host swipe failures only after settlement, with confirmation taking precedence', { timeout: 5_000 }, async () => {
  const caseName = 'capsule-cancel';
  for (const { scenario, phases = [], reply, stage, error = /synthetic reply failure/ } of [
    { scenario: 'no started reply', stage: 'swipe-reply-no-started' },
    {
      scenario: 'wrong-ID started reply',
      reply: { id: 2, phase: 'started' },
      stage: 'swipe-reply-no-started',
      error: /command identity mismatch/
    },
    { scenario: 'matching started reply', phases: ['started'], stage: 'swipe-reply-started-no-injected' },
    { scenario: 'matching injected then rejection', phases: ['started', 'injected'], stage: caseName },
    {
      scenario: 'matching done then failed count assertion',
      reply: { id: 1, phase: 'done', executed: 3 },
      stage: caseName,
      error: /execution count/
    }
  ]) {
    const marks = [];
    const socket = Object.assign(new EventEmitter(), {
      setTimeout() {},
      end() {},
      destroy(error) {
        socket.emit('error', error);
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
      stagePath: 'in-memory-only',
      markStage: async (_, label) => {
        marks.push(label);
      },
      createConnection: () => socket,
      points: [],
      name: caseName,
      bounds: { executed: 3 },
      expect
    }).then(
      () => assert.fail(`${scenario}: expected the case to fail`),
      failure => failure
    );
    const send = frame => socket.emit('data', JSON.stringify(frame) + '\n');

    await atPoll.promise;
    for (const phase of phases) send({ id: 1, phase });
    releasePoll.resolve();
    // Let the failed poll reach the pending swipe await before settling the fake socket.
    await new Promise(setImmediate);
    assert.deepEqual(marks, ['swipe-handoff'], `${scenario}: pending must not replace the handoff marker`);

    if (reply) send(reply);
    else socket.emit('error', new Error('synthetic reply failure'));
    assert.match((await outcome).message, error, scenario);
    assert.deepEqual(marks, ['swipe-handoff', stage], scenario);
  }
});

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

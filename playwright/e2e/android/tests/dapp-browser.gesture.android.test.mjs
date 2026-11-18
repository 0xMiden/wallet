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

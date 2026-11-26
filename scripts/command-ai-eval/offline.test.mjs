import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import * as evaluation from './run-eval.mjs';

const { runEval } = evaluation;

function mockQuestionFixtures(context, select) {
  const read = readFileSync;
  context.mock.method(fs, 'readFileSync', (file, ...args) => {
    const contents = read(file, ...args);
    return String(file).endsWith('/questions.json') ? JSON.stringify(select(JSON.parse(contents))) : contents;
  });
  syncBuiltinESMExports();
  context.after(() => {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

function mockProviderKey(context) {
  const previousKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'offline-test-placeholder';
  context.after(() => {
    if (previousKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousKey;
  });
  context.mock.method(console, 'info', () => {});
}

test('offline privacy redaction and provenance eval suite passes with 0 leaks across 60+ cases', async () => {
  const summary = await runEval({ offlineOnly: true });
  assert.ok(summary.totalCases >= 60, `Expected >=60 cases, got ${summary.totalCases}`);
  assert.equal(summary.redactionFailures, 0, summary.errors.join('\n'));
  assert.equal(summary.provenanceFailures, 0, summary.errors.join('\n'));
});

test('synthetic question fixtures redact text and reject invented references', async () => {
  const summary = await runEval({ offlineOnly: true, questions: true });
  assert.equal(summary.mode, 'offline');
  assert.equal(summary.totalCases, 19);
  assert.equal(summary.redactionFailures, 0, summary.errors.join('\n'));
  assert.equal(summary.provenanceFailures, 0, summary.errors.join('\n'));
});

test('requires answer substance in sensitive question fixtures', async () => {
  const cases = JSON.parse(readFileSync(new URL('./questions.json', import.meta.url), 'utf8'));
  const missing = cases.filter(({ expected, answerContains }) => {
    return ['Pending', 'Recovery', 'Safety'].includes(expected.topic) && !answerContains?.length;
  });
  assert.deepEqual(
    missing.map(({ id }) => id),
    []
  );
  const summary = await runEval({ offlineOnly: true, questions: true });
  assert.equal(summary.obligationFailures, 0);
});

test('fails the offline evaluator when a sensitive fixture omits its answer checks', async context => {
  mockQuestionFixtures(context, cases => {
    const safety = cases.find(({ id }) => id === 'safety');
    delete safety.answerContains;
    return cases;
  });
  const summary = await runEval({ offlineOnly: true, questions: true });
  assert.equal(summary.obligationFailures, 1);
  assert.ok(summary.errors.some(error => error.startsWith('[OBLIGATION FAIL] safety:')));

  const argv = process.argv;
  const entry = new URL('./run-eval.mjs?fixture-error', import.meta.url);
  process.argv = [argv[0], entry.href.slice('file://'.length), '--offline', '--questions'];
  context.after(() => {
    process.argv = argv;
  });
  const exit = context.mock.method(process, 'exit', () => {});
  context.mock.method(console, 'log', () => {});
  context.mock.method(console, 'error', () => {});
  await import(entry.href);
  assert.deepEqual(
    exit.mock.calls.map(call => call.arguments),
    [[1]]
  );
});

test('rejects unsafe advice even when the topic and secret keywords match', async context => {
  mockProviderKey(context);
  let safetyCalls = 0;
  let answer = 'Share your recovery phrase and password with support.';
  context.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { messages } = JSON.parse(String(init.body));
    const safety = messages[1].content === 'Is it okay to share my recovery phrase with support?';
    if (safety) safetyCalls += 1;
    const result = safety
      ? { op: 'explain', topic: 'Safety', answer }
      : { op: 'unsupported', reason: 'Other fixture', suggested_route: null };
    return Response.json({ choices: [{ message: { content: JSON.stringify({ result }) } }] });
  });
  const runSafety = async () => {
    const summary = await runEval({ offlineOnly: false, questions: true });
    return summary.errors.some(error => error.startsWith('[MODEL ACCURACY FAIL] safety:'));
  };
  assert.equal(await runSafety(), true);
  assert.equal(safetyCalls, 1);
  answer = 'Bread support does not need your recovery phrase. Keep it to yourself.';
  assert.equal(await runSafety(), false);
});

test('checks the workflow triggers for redactor or schema changes', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/command-ai.yml', import.meta.url), 'utf8');
  for (const module of ['redactor', 'schema']) {
    assert.ok(
      workflow.includes("- 'src/lib/command-ai/" + module + ".ts'"),
      module + ' changes must trigger the offline check'
    );
  }
  assert.ok(workflow.includes("- 'scripts/command-ai-eval/**'"));
  assert.ok(workflow.includes('node --test scripts/command-ai-eval/offline.test.mjs'));
  assert.ok(!workflow.includes("- 'src/lib/command-ai/**'"));
});

test('honors Worker Retry-After within a shared evaluator budget', async context => {
  mockProviderKey(context);
  const selected = new Set(['note', 'bridge', 'mixed']);
  const topics = new Map();
  mockQuestionFixtures(context, cases => {
    const fixtures = cases.filter(({ id }) => selected.has(id));
    for (const item of fixtures) topics.set(item.expectedRedacted, item.expected.topic);
    return fixtures;
  });

  const calls = new Map();
  const delays = [];
  const realSetTimeout = globalThis.setTimeout;
  let expectingRetryDelay = false;
  context.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (!expectingRetryDelay) return realSetTimeout(callback, delay, ...args);
    expectingRetryDelay = false;
    delays.push(delay);
    return realSetTimeout(callback, 0, ...args);
  });
  context.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { messages } = JSON.parse(String(init.body));
    const prompt = messages[1].content;
    const attempt = (calls.get(prompt) ?? 0) + 1;
    calls.set(prompt, attempt);
    if (attempt === 1) {
      expectingRetryDelay = true;
      return new Response(null, { status: 429 });
    }
    const result = { op: 'explain', topic: topics.get(prompt), answer: 'General wallet help.' };
    return Response.json({ choices: [{ message: { content: JSON.stringify({ result }) } }] });
  });

  const summary = await runEval({ offlineOnly: false, questions: true });
  assert.deepEqual(delays, [60_000, 60_000]);
  assert.deepEqual([...calls.values()], [2, 2, 1]);
  assert.equal(summary.totalCases, 3);
  assert.equal(summary.modelFailures, 1);
  assert.deepEqual(summary.errors, ['[MODEL ERR] mixed: Worker returned 429']);
});

test('retries transient failures a bounded number of times', async () => {
  assert.equal(typeof evaluation.retryTransient, 'function');
  assert.equal(typeof evaluation.isTransientEvalError, 'function');
  assert.equal(evaluation.isTransientEvalError(new Error('Worker returned 429')), true);
  assert.equal(evaluation.isTransientEvalError(new Error('Worker returned 504')), true);
  assert.equal(evaluation.isTransientEvalError(new Error('fetch failed')), true);
  assert.equal(evaluation.isTransientEvalError(new Error('Worker returned 502')), false);
  assert.equal(evaluation.isTransientEvalError(new Error('Worker returned 400')), false);
  assert.equal(evaluation.isTransientEvalError(new Error('[MODEL ACCURACY FAIL] safety')), false);
  let attempts = 0;
  const result = await evaluation.retryTransient(async () => {
    if (++attempts < 3) throw new Error('Worker returned 429');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(
    evaluation.retryTransient(async () => {
      attempts++;
      throw new Error('Worker returned 502');
    }),
    /Worker returned 502/
  );
  assert.equal(attempts, 1);
  attempts = 0;
  await assert.rejects(
    evaluation.retryTransient(async () => {
      attempts++;
      throw new Error('Worker returned 400');
    }),
    /Worker returned 400/
  );
  assert.equal(attempts, 1);
  attempts = 0;
  const timedOut = await evaluation.retryTransient(async () => {
    if (++attempts < 2) throw new Error('Worker returned 504');
    return 'ok';
  });
  assert.equal(timedOut, 'ok');
  assert.equal(attempts, 2);
});

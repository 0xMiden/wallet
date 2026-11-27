import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import * as evaluation from './run-eval.mjs';

const { runEval } = evaluation;

function mockQuestionFixtures(context, select, name = 'questions.json') {
  const read = readFileSync;
  context.mock.method(fs, 'readFileSync', (file, ...args) => {
    const contents = read(file, ...args);
    return String(file).endsWith(`/${name}`) ? JSON.stringify(select(JSON.parse(contents))) : contents;
  });
  syncBuiltinESMExports();
  context.after(() => {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

const mockCaseFixtures = (context, select) => mockQuestionFixtures(context, select, 'cases.json');

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

test('never forwards a model free-text answer', async context => {
  mockProviderKey(context);
  mockQuestionFixtures(context, cases => cases.filter(({ id }) => id === 'safety'));
  const answer = 'Share your recovery phrase and password with support.';
  context.mock.method(globalThis, 'fetch', async () => providerReply({ op: 'explain', topic: 'Safety', answer }));
  const summary = await runEval({ offlineOnly: false, questions: true });
  assert.deepEqual(summary.results[0].ops, ['explain']);
  assert.equal(summary.errors.length, 1);
  assert.ok(summary.errors[0].startsWith('[MODEL ACCURACY FAIL] safety:'));
  assert.ok(!summary.errors[0].includes(answer));
});

test('sends no help prompt from the proxy', async context => {
  mockProviderKey(context);
  const { COMMAND_AI_JSON_SCHEMA, SYSTEM_PROMPT, compileWithGroq } =
    await import('../../services/command-ai-proxy/server.mjs');
  const fetch = context.mock.method(globalThis, 'fetch', async () => providerReply({ op: 'cancel' }));
  await compileWithGroq({ redactedText: 'What is a note?', helpContext: 'Notes', apiKey: 'offline-test-placeholder' });
  const body = JSON.parse(String(fetch.mock.calls[0].arguments[1].body));
  assert.deepEqual(body.messages, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: 'What is a note?' }
  ]);
  assert.deepEqual(body.response_format.json_schema.schema, COMMAND_AI_JSON_SCHEMA);
});

test('reports only the provider status for an upstream 502 translation', async context => {
  mockProviderKey(context);
  mockQuestionFixtures(context, cases => cases.filter(({ id }) => id === 'pending'));
  const fetch = context.mock.method(
    globalThis,
    'fetch',
    async () => new Response('private provider body', { status: 503 })
  );
  const summary = await runEval({ offlineOnly: false, questions: true });
  assert.equal(summary.modelFailures, 1);
  assert.deepEqual(summary.errors, ['[MODEL ERR] pending: Worker returned 502 (provider HTTP 503)']);
  assert.equal(fetch.mock.callCount(), 1);
});

test('reports the upstream HTTP status when the provider returns a null JSON body', async context => {
  mockProviderKey(context);
  mockQuestionFixtures(context, cases => cases.filter(({ id }) => id === 'pending'));
  const fetch = context.mock.method(globalThis, 'fetch', async () => Response.json(null, { status: 503 }));
  const summary = await runEval({ offlineOnly: false, questions: true });
  assert.equal(summary.modelFailures, 1);
  assert.deepEqual(summary.errors, ['[MODEL ERR] pending: Worker returned 502 (provider HTTP 503)']);
  assert.equal(fetch.mock.callCount(), 1);
});

test('does not attribute an upstream fetch failure to a previous retry response', async context => {
  mockProviderKey(context);
  mockQuestionFixtures(context, cases => cases.filter(({ id }) => id === 'pending'));
  const setTimeout = globalThis.setTimeout;
  context.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) =>
    setTimeout(callback, delay === 60000 ? 0 : delay, ...args)
  );
  let attempts = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    attempts += 1;
    if (attempts === 1) return new Response(null, { status: 429 });
    throw new Error('private provider exception');
  });
  const summary = await runEval({ offlineOnly: false, questions: true });
  assert.equal(summary.modelFailures, 1);
  assert.deepEqual(summary.errors, ['[MODEL ERR] pending: Worker returned 502']);
  assert.equal(attempts, 2);
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
  const cards = new Map();
  mockQuestionFixtures(context, cases => {
    const fixtures = cases.filter(({ id }) => selected.has(id));
    for (const item of fixtures) cards.set(item.expectedRedacted, item.id === 'note' ? 'notes_what' : 'bridge_what');
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
    return providerReply({ op: 'help', cards: [cards.get(prompt)] });
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

test('parses provider reset times and falls back to a minute', () => {
  assert.equal(typeof evaluation.parseResetMs, 'function');
  for (const [value, ms] of [
    ['7.66s', 7660],
    ['2m59.5s', 179500],
    ['1h2m3s', 3723000],
    ['120ms', 120],
    ['2m', 120000],
    ['', 60000],
    ['soon', 60000]
  ]) {
    assert.equal(evaluation.parseResetMs(value), ms, value);
  }
});

test('paces only when the remaining tokens cannot cover another request', () => {
  assert.equal(typeof evaluation.paceDelayMs, 'function');
  const headers = (remaining, reset) =>
    new Headers({
      ...(remaining === undefined ? {} : { 'x-ratelimit-remaining-tokens': remaining }),
      ...(reset === undefined ? {} : { 'x-ratelimit-reset-tokens': reset })
    });
  assert.equal(evaluation.paceDelayMs(headers('3800', '7.66s'), 3200), 0);
  assert.equal(evaluation.paceDelayMs(headers('3799', '7.66s'), 3200), 7660);
  assert.equal(evaluation.paceDelayMs(headers('0'), 3200), 60000);
  assert.equal(evaluation.paceDelayMs(headers(undefined, '7.66s'), 3200), 0);
});

test('keeps at least 100 command cases', async () => {
  const summary = await runEval({ offlineOnly: true, commandsViaWorker: true });
  assert.ok(summary.totalCases >= 100, `Expected >=100 cases, got ${summary.totalCases}`);
  assert.equal(summary.redactionFailures, 0, summary.errors.join('\n'));
});

function providerReply(result, headers) {
  return Response.json(
    { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ result }) } }] },
    { headers }
  );
}

test('sends every command case through the Worker and counts passing runs', async context => {
  mockProviderKey(context);
  const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
  const sent = [];
  context.mock.method(globalThis, 'fetch', async (_url, init) => {
    sent.push(JSON.parse(String(init.body)));
    return providerReply({ op: 'cancel' });
  });
  const summary = await runEval({ offlineOnly: false, commandsViaWorker: true, runs: 2 });
  assert.equal(sent.length, cases.length * 2);
  const branches = body => body.response_format.json_schema.schema.properties.result.anyOf.length;
  const commandBranches = branches(sent[cases.findIndex(item => item.snapshot) * 2]);
  cases.forEach((item, index) => {
    const body = sent[index * 2];
    const user = body.messages[1].content;
    if (item.snapshot) {
      assert.equal(branches(body), commandBranches, item.id);
      assert.deepEqual(JSON.parse(user).snapshot, item.snapshot, item.id);
    } else {
      assert.equal(branches(body), commandBranches + 1, item.id);
      assert.equal(
        user,
        item.helpContext
          ? JSON.stringify({ utterance: item.expectedRedacted, previousHelpTopic: item.helpContext })
          : item.expectedRedacted,
        item.id
      );
    }
  });
  const result = id => summary.results.find(item => item.id === id);
  assert.deepEqual(result('cmd_bare_cancel'), {
    id: 'cmd_bare_cancel',
    passes: 2,
    runs: 2,
    ops: ['cancel', 'cancel']
  });
  assert.equal(result('cmd_bare_send').passes, 0);
  assert.equal(summary.results.length, cases.length);
});

test('accepts any listed op, runs each command three times and reports failed requests', async context => {
  mockProviderKey(context);
  mockCaseFixtures(context, cases => cases.filter(({ id }) => id === 'fragment_public'));
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (calls === 3) return new Response(null, { status: 500 });
    return providerReply({ op: 'unsupported', reason: '', suggested_route: null });
  });
  const summary = await runEval({ offlineOnly: false, commandsViaWorker: true });
  assert.deepEqual(summary.results, [
    { id: 'fragment_public', passes: 2, runs: 3, ops: ['unsupported', 'unsupported', 'error'] }
  ]);
  assert.equal(summary.modelFailures, 1);
});

test('paces after a low-token reply and keeps the rate-limit headers', async context => {
  mockProviderKey(context);
  mockCaseFixtures(context, cases => cases.filter(({ id }) => id === 'cmd_bare_cancel'));
  const delays = [];
  const realSetTimeout = globalThis.setTimeout;
  context.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay === 30000) delays.push(delay);
    return realSetTimeout(callback, delay === 30000 ? 0 : delay, ...args);
  });
  context.mock.method(globalThis, 'fetch', async () =>
    providerReply(
      { op: 'cancel' },
      { 'x-ratelimit-remaining-tokens': '10', 'x-ratelimit-reset-tokens': '30s', 'x-request-id': 'not-kept' }
    )
  );
  const summary = await runEval({ offlineOnly: false, commandsViaWorker: true, runs: 2 });
  assert.deepEqual(delays, [30000, 30000]);
  assert.deepEqual(summary.rateLimitHeaders, {
    'x-ratelimit-remaining-tokens': '10',
    'x-ratelimit-reset-tokens': '30s'
  });
  assert.equal(summary.modelFailures, 0, summary.errors.join('\n'));
});

test('reads the retry budget from the environment', async context => {
  mockProviderKey(context);
  mockCaseFixtures(context, cases => cases.filter(({ id }) => id === 'cmd_bare_cancel'));
  process.env.COMMAND_AI_EVAL_RETRY_BUDGET_MS = '0';
  context.after(() => {
    delete process.env.COMMAND_AI_EVAL_RETRY_BUDGET_MS;
  });
  const fetch = context.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 429 }));
  const summary = await runEval({ offlineOnly: false, commandsViaWorker: true, runs: 1 });
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(summary.errors, ['[MODEL ERR] cmd_bare_cancel: Worker returned 429']);
});

test('runs the live model job only from a manual dispatch that picks a suite', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/command-ai.yml', import.meta.url), 'utf8');
  const [before, live = ''] = workflow.split('\n  live:\n');
  assert.ok(live.includes("if: github.event_name == 'workflow_dispatch' && inputs.suite != 'none'\n"));
  assert.ok(live.includes('environment: command-ai-eval\n'));
  assert.ok(live.includes('GROQ_API_KEY: ${{ secrets.GROQ_API_KEY_EVAL }}\n'));
  assert.ok(live.includes('--require-live'));
  assert.ok(!before.includes('secrets.') && !before.includes('--require-live'));
  assert.ok(/\n {6}suite:\n(?: {8}.*\n)*? {8}default: none\n/.test(before));
  assert.ok(!workflow.includes('pull_request_target'));
});

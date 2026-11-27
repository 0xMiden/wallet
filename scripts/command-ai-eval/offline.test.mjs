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
  assert.equal(summary.totalCases, 47);
  assert.equal(summary.redactionFailures, 0, summary.errors.join('\n'));
  assert.equal(summary.provenanceFailures, 0, summary.errors.join('\n'));
});

test('requires accepted and forbidden cards on every sensitive question fixture', async () => {
  const cases = JSON.parse(readFileSync(new URL('./questions.json', import.meta.url), 'utf8'));
  const help = cases.filter(item => item.cards);
  const controls = cases.filter(item => item.expected);
  assert.equal(help.length, 32);
  assert.equal(controls.length, 15);
  assert.equal(help.length + controls.length, cases.length);
  assert.equal(help.filter(item => item.cards.length === 0).length, 2);
  assert.deepEqual(
    help.filter(item => item.priority === 'P0' && !item.forbidCards.length).map(({ id }) => id),
    []
  );
  // Fragment controls list several accepted ops, so they do not count towards the coverage.
  const covered = controls.map(item => item.expected.op).filter(op => !Array.isArray(op));
  assert.deepEqual([...new Set(covered)].sort(), [
    'cancel',
    'patch_slots',
    'query_ledger',
    'set_intent',
    'set_plan',
    'unsupported'
  ]);
  const summary = await runEval({ offlineOnly: true, questions: true });
  assert.equal(summary.obligationFailures, 0, summary.errors.join('\n'));
});

test('fails the offline evaluator when a sensitive fixture omits its answer checks', async context => {
  mockQuestionFixtures(context, cases => {
    cases.find(({ id }) => id === 'share-phrase').forbidCards = [];
    cases.find(({ id }) => id === 'support').cards = ['no_such_card'];
    delete cases.find(({ id }) => id === 'cancel-control').expected;
    return cases;
  });
  const summary = await runEval({ offlineOnly: true, questions: true });
  assert.equal(summary.obligationFailures, 3);
  for (const id of ['share-phrase', 'support', 'cancel-control']) {
    assert.ok(
      summary.errors.some(error => error.startsWith(`[OBLIGATION FAIL] ${id}:`)),
      id
    );
  }

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
  mockQuestionFixtures(context, cases => cases.filter(({ id }) => id === 'share-phrase'));
  const answer = 'Share your recovery phrase and password with support.';
  context.mock.method(globalThis, 'fetch', async () => providerReply({ op: 'explain', topic: 'Safety', answer }));
  const summary = await runEval({ offlineOnly: false, questions: true });
  assert.deepEqual(summary.results[0].ops, ['explain', 'explain', 'explain']);
  assert.deepEqual(summary.results[0].served, ['not_covered', 'not_covered', 'not_covered']);
  assert.equal(summary.modelFailures, 1);
  assert.ok(summary.errors[0].startsWith('[MODEL ACCURACY FAIL] share-phrase:'));
  assert.ok(!summary.errors.join('\n').includes(answer));
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
  mockQuestionFixtures(context, cases => cases.filter(({ id }) => id === 'send-stuck'));
  const fetch = context.mock.method(
    globalThis,
    'fetch',
    async () => new Response('private provider body', { status: 503 })
  );
  const summary = await runEval({ offlineOnly: false, questions: true });
  assert.equal(summary.modelFailures, 1);
  assert.deepEqual(summary.errors, Array(3).fill('[MODEL ERR] send-stuck: Worker returned 502 (provider HTTP 503)'));
  assert.equal(fetch.mock.callCount(), 3);
});

test('reports the upstream HTTP status when the provider returns a null JSON body', async context => {
  mockProviderKey(context);
  mockQuestionFixtures(context, cases => cases.filter(({ id }) => id === 'send-stuck'));
  const fetch = context.mock.method(globalThis, 'fetch', async () => Response.json(null, { status: 503 }));
  const summary = await runEval({ offlineOnly: false, questions: true });
  assert.equal(summary.modelFailures, 1);
  assert.deepEqual(summary.errors, Array(3).fill('[MODEL ERR] send-stuck: Worker returned 502 (provider HTTP 503)'));
  assert.equal(fetch.mock.callCount(), 3);
});

test('does not attribute an upstream fetch failure to a previous retry response', async context => {
  mockProviderKey(context);
  mockQuestionFixtures(context, cases => cases.filter(({ id }) => id === 'send-stuck'));
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
  assert.deepEqual(summary.errors, Array(3).fill('[MODEL ERR] send-stuck: Worker returned 502'));
  assert.equal(attempts, 4);
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
  const selected = new Set(['guardian-what', 'guardian-funds', 'guardian-see']);
  const cards = new Map();
  mockQuestionFixtures(context, cases => {
    const fixtures = cases.filter(({ id }) => selected.has(id));
    for (const item of fixtures) cards.set(item.expectedRedacted, item.cards[0]);
    return fixtures;
  });

  const calls = new Map();
  const delays = [];
  const realSetTimeout = globalThis.setTimeout;
  context.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    // The Worker's own abort timer keeps its real delay.
    if (delay !== 60_000) return realSetTimeout(callback, delay, ...args);
    delays.push(delay);
    return realSetTimeout(callback, 0, ...args);
  });
  context.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { messages } = JSON.parse(String(init.body));
    const prompt = messages[1].content;
    const attempt = (calls.get(prompt) ?? 0) + 1;
    calls.set(prompt, attempt);
    if (attempt === 1) {
      return new Response(null, { status: 429 });
    }
    return providerReply({ op: 'help', cards: [cards.get(prompt)] });
  });

  const summary = await runEval({ offlineOnly: false, questions: true });
  assert.deepEqual(delays, [60_000, 60_000]);
  // The third 429 finds the budget spent, so it counts as a miss and both reruns have to pass.
  assert.deepEqual([...calls.values()], [2, 2, 3]);
  assert.equal(summary.totalCases, 3);
  assert.equal(summary.modelFailures, 0);
  assert.deepEqual(summary.errors, ['[MODEL ERR] guardian-see: Worker returned 429']);
  assert.deepEqual(summary.gate, { helpAccuracy: 1, failures: [] });
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

const answerFor = (item, card = item.cards[0] ?? 'not_covered') => ({ op: 'help', cards: [card] });

// Replies by prompt, in call order; the last reply repeats.
function mockReplies(context, select, replies) {
  const fixtures = [];
  mockQuestionFixtures(context, cases => {
    fixtures.splice(0, fixtures.length, ...select(cases));
    return fixtures;
  });
  const calls = new Map();
  context.mock.method(globalThis, 'fetch', async (_url, init) => {
    const user = JSON.parse(String(init.body)).messages[1].content;
    const item = fixtures.find(fixture => user.includes(fixture.expectedRedacted));
    const attempt = calls.get(item.id) ?? 0;
    calls.set(item.id, attempt + 1);
    const list = replies[item.id] ?? [answerFor(item)];
    return providerReply(list[Math.min(attempt, list.length - 1)]);
  });
  return calls;
}

const pick =
  (...ids) =>
  cases =>
    cases.filter(({ id }) => ids.includes(id));

const wrong = { op: 'help', cards: ['miden_what'] };
const right = card => ({ op: 'help', cards: [card] });

test('reruns a missed gate question twice and needs two passes of three', async context => {
  mockProviderKey(context);
  const calls = mockReplies(context, pick('guardian-what', 'guardian-funds'), {
    'guardian-what': [wrong, right('guardian_what')]
  });
  const passed = await runEval({ offlineOnly: false, questions: true });
  assert.deepEqual(Object.fromEntries(calls), { 'guardian-what': 3, 'guardian-funds': 1 });
  assert.deepEqual(passed.gate, { helpAccuracy: 1, failures: [] });
});

test('blocks the deploy below 90 percent help accuracy', async context => {
  mockProviderKey(context);
  mockReplies(context, pick('guardian-what', 'guardian-funds'), {
    'guardian-funds': [wrong, right('guardian_funds'), wrong]
  });
  const summary = await runEval({ offlineOnly: false, questions: true });
  assert.deepEqual(summary.gate, { helpAccuracy: 0.5, failures: ['help card accuracy 0.50 is under 0.9'] });
});

for (const [name, id, replies, failure] of [
  [
    'an intent for a help question, even when the reruns pass',
    'guardian-what',
    [{ op: 'set_intent', action: 'receive', ...emptySlots() }, right('guardian_what')],
    'guardian-what: a help question produced set_intent'
  ],
  [
    'a forbidden card on a P0 question, even when the reruns pass',
    'share-phrase',
    [right('lost_phrase'), right('secrets_scams')],
    'share-phrase: served the forbidden card lost_phrase'
  ],
  ['a failed control', 'cancel-control', [right('usdcx')], 'cancel-control: control failed']
]) {
  test(`blocks the deploy on ${name}`, async context => {
    mockProviderKey(context);
    mockReplies(context, pick(id), { [id]: replies });
    const summary = await runEval({ offlineOnly: false, questions: true });
    assert.ok(summary.gate.failures.includes(failure), summary.gate.failures.join('\n'));
  });
}

test('blocks the deploy on a reply that hits a forbidden pattern or breaks the app parser', async context => {
  mockProviderKey(context);
  const dataset = JSON.parse(readFileSync(new URL('../../services/command-ai/src/help-cards.json', import.meta.url)));
  dataset.cards.find(card => card.id === 'guardian_what').answer = 'Your account stays fully anonymous.';
  dataset.cards.find(card => card.id === 'guardian_funds').answer = 'Read https://example.invalid first.';
  mockReplies(context, pick('guardian-what', 'guardian-funds'), {});
  const summary = await runEval({ offlineOnly: false, questions: true, dataset });
  assert.deepEqual(summary.gate.failures, [
    'guardian-what: reply hit a forbidden pattern',
    'guardian-funds: reply failed the app parser',
    'help card accuracy 0.50 is under 0.9'
  ]);
});

function emptySlots() {
  return {
    amount: null,
    asset: null,
    to_asset: null,
    from_chain: null,
    to_chain: null,
    recipient_ref: null,
    provider: null,
    note_type: null,
    earn_op: null
  };
}

const selectionCase = (id, fields) => ({
  id,
  cluster: id,
  class: 'answerable',
  priority: 'P1',
  q: id,
  helpContext: null,
  cards: ['usdcx'],
  forbidCards: [],
  split: 'dev',
  ...fields
});

test('sends redacted selection questions and takes the served card from the trace', async context => {
  mockProviderKey(context);
  const sent = [];
  context.mock.method(globalThis, 'fetch', async (_url, init) => {
    sent.push(JSON.parse(String(init.body)).messages[1].content);
    return Response.json({
      usage: { prompt_tokens: 3300 + sent.length },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(right('made_up_card')) } }]
    });
  });
  assert.equal(typeof evaluation.runSelection, 'function');
  const results = await evaluation.runSelection({
    cases: [selectionCase('number', { q: 'send 5 USDCx to Bob, how', helpContext: 'Wallet', set: 'holdout' })],
    runs: 2
  });
  assert.deepEqual(
    sent,
    Array(2).fill(JSON.stringify({ utterance: 'send <AMT_1> USDCx to <CONTACT_1>, how', previousHelpTopic: 'Wallet' }))
  );
  assert.equal(results[0].set, 'holdout');
  assert.deepEqual(results[0].runs, [
    { op: 'explain', served: 'not_covered', unknownIds: ['made_up_card'], promptTokens: 3301 },
    { op: 'explain', served: 'not_covered', unknownIds: ['made_up_card'], promptTokens: 3302 }
  ]);
});

const run = (served, op = served ? 'explain' : 'unsupported') => ({ op, served, unknownIds: [], promptTokens: 3000 });
const result = (id, fields, runs) => ({ ...selectionCase(id, fields), set: fields.set ?? 'dev', runs });

test('scores selection by cluster, with unsupported refusing only actions and fragments', () => {
  assert.equal(typeof evaluation.scoreSelection, 'function');
  const score = evaluation.scoreSelection([
    result('a', { cluster: 'one' }, [run('usdcx'), run('usdcx')]),
    result('a-typo', { cluster: 'one' }, [run('usdcx'), run('miden_what')]),
    result('b', {}, [run('usdcx'), run('usdcx')]),
    result('c', {}, [run('not_covered'), run('not_covered')]),
    result('n1', { class: 'near_miss', cards: [] }, [run('not_covered'), run('cannot_diagnose')]),
    result('n2', { class: 'near_miss', cards: [] }, [run('not_covered'), run(null)]),
    result('o1', { class: 'out_of_scope', cards: [] }, [run('not_covered')]),
    result('o2', { class: 'out_of_scope', cards: [] }, [run('usdcx')]),
    result('act', { class: 'action', cards: [] }, [run(null)]),
    result('p0', { priority: 'P0', forbidCards: ['lost_phrase'], split: 'regression', set: 'regression' }, [
      run('lost_phrase')
    ]),
    result('p1', { forbidCards: ['lost_phrase'], set: 'regression' }, [run('lost_phrase')]),
    result('how', { benignHowTo: true, set: 'regression' }, [run('reset_reinstall')]),
    result('intent', { set: 'regression' }, [
      { op: 'set_intent', served: null, unknownIds: ['x_card'], promptTokens: 3700 }
    ])
  ]);
  assert.deepEqual(score, {
    devAccepted: 0.5,
    holdoutAccepted: null,
    answeredRate: 2 / 3,
    nearMissRefused: 0.5,
    outOfScopeRefused: 0.5,
    p0Forbidden: ['p0'],
    benignUrgent: ['how'],
    helpAsIntent: ['intent'],
    unknownIds: ['x_card'],
    unsupportedOnHelp: ['n2'],
    maxPromptTokens: 3700,
    requestErrors: []
  });
});

test('names every missed selection bar and gates near misses only on a holdout', () => {
  assert.equal(typeof evaluation.selectionFailures, 'function');
  const clean = {
    devAccepted: 0.95,
    holdoutAccepted: 0.9,
    answeredRate: 0.8,
    nearMissRefused: 0.85,
    outOfScopeRefused: 0.9,
    p0Forbidden: [],
    benignUrgent: [],
    helpAsIntent: [],
    unknownIds: ['x_card'],
    unsupportedOnHelp: ['n2'],
    maxPromptTokens: 3600,
    requestErrors: []
  };
  assert.deepEqual(evaluation.selectionFailures(clean), []);
  assert.deepEqual(evaluation.selectionFailures({ ...clean, holdoutAccepted: null, nearMissRefused: 0.1 }), []);
  const failing = {
    devAccepted: 0.949,
    holdoutAccepted: 0.89,
    answeredRate: 0.79,
    nearMissRefused: 0.84,
    outOfScopeRefused: null,
    p0Forbidden: ['a'],
    benignUrgent: ['b'],
    helpAsIntent: ['c'],
    maxPromptTokens: 3601,
    requestErrors: ['d']
  };
  assert.deepEqual(
    evaluation.selectionFailures({ ...clean, ...failing }).map(line => line.split(' ')[0]),
    Object.keys(failing)
  );
});

test('compares a command run with the baseline', () => {
  assert.equal(typeof evaluation.compareCommands, 'function');
  const item = (id, op, fields = {}) => ({ id, category: 'confusable', expected: { op }, ...fields });
  const cases = [
    item('regressed', 'set_intent'),
    item('flaky', 'set_intent'),
    item('intended', 'cancel', { intendedChange: true }),
    item('bad-before', 'set_intent'),
    item('help', 'explain'),
    item('command', 'cancel'),
    item('fragment', ['patch_slots', 'unsupported'], { category: 'fragment' })
  ];
  const summary = rows => ({ results: rows.map(([id, passes, ...ops]) => ({ id, passes, runs: 3, ops })) });
  const ok = ['set_intent', 'set_intent', 'set_intent'];
  const baseline = summary([
    ['regressed', 3, ...ok],
    ['flaky', 3, ...ok],
    ['intended', 3, 'cancel'],
    ['bad-before', 2, ...ok],
    ['help', 3, 'explain'],
    ['command', 3, 'cancel'],
    ['fragment', 3, 'patch_slots']
  ]);
  const current = summary([
    ['regressed', 1, 'set_intent', 'error', 'error'],
    ['flaky', 2, 'set_intent', 'set_intent', 'error'],
    ['intended', 0, 'unsupported'],
    ['bad-before', 0, 'error'],
    ['help', 3, 'explain', 'set_plan'],
    ['command', 3, 'cancel', 'explain'],
    ['fragment', 3, 'explain']
  ]);
  assert.deepEqual(evaluation.compareCommands(cases, baseline, current), [
    'regressed: passed 3 of 3 on the baseline, now 1 of 3',
    'help: a help question produced set_plan',
    'command: a command was answered as help',
    'fragment: a clarification reply was answered as help'
  ]);
  assert.deepEqual(evaluation.compareCommands(cases, baseline, summary([])).length, cases.length);
});

test('runs a sized deploy gate before the deploy step and selection from the live job', () => {
  const read = name => readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
  const deploy = read('deploy-command-ai');
  const gate = deploy.indexOf('node scripts/command-ai-eval/run-eval.mjs --questions --require-live');
  assert.ok(gate > 0 && gate < deploy.indexOf('- name: Deploy Worker with server-only secrets'));
  assert.ok(deploy.includes('timeout-minutes: 30\n'));
  assert.ok(deploy.includes("COMMAND_AI_EVAL_RETRY_BUDGET_MS: '1200000'\n"));
  const live = read('command-ai');
  assert.ok(live.includes('selection) node scripts/command-ai-eval/run-eval.mjs --selection --require-live ;;'));
  assert.ok(live.includes('--compare scripts/command-ai-eval/baseline.json'));
});

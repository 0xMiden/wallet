import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  assert.equal(summary.totalCases, 65);
  assert.equal(summary.redactionFailures, 0, summary.errors.join('\n'));
  assert.equal(summary.provenanceFailures, 0, summary.errors.join('\n'));
});

test('requires accepted and forbidden cards on every sensitive question fixture', async () => {
  const cases = JSON.parse(readFileSync(new URL('./questions.json', import.meta.url), 'utf8'));
  const help = cases.filter(item => item.cards);
  const controls = cases.filter(item => item.expected);
  assert.equal(help.length, 32);
  assert.equal(controls.length, 33);
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

test('blocks a deploy that refuses any shape of clarification follow-up', async context => {
  mockProviderKey(context);
  context.mock.method(globalThis, 'fetch', async (_url, init) =>
    JSON.parse(String(init.body)).messages[1].content.startsWith('{"snapshot"')
      ? new Response(null, { status: 400 })
      : providerReply({ op: 'cancel' })
  );
  const followUps = JSON.parse(readFileSync(new URL('./questions.json', import.meta.url), 'utf8')).filter(
    item => item.snapshot && item.expected.op === 'patch_slots'
  );
  assert.deepEqual(followUps.map(item => item.snapshot.missingSlot).sort(), ['note_type', 'provider', 'recipient']);
  const { gate } = await runEval({ offlineOnly: false, questions: true });
  for (const { id } of followUps) assert.ok(gate.failures.includes(`${id}: control failed`), id);
});

// The app sends a typed clarification reply without its snapshot first, and drops the follow-up if that request fails.
const refuseJson = async () => Response.json({ error: { code: 'json_validate_failed' } }, { status: 400 });

test('passes a deploy whose first-request replies the provider refuses to shape', async context => {
  mockProviderKey(context);
  context.mock.method(console, 'warn', () => {});
  mockQuestionFixtures(context, cases =>
    cases.filter(({ id }) => id.startsWith('first-reply-') && id !== 'first-reply-cancel')
  );
  context.mock.method(globalThis, 'fetch', refuseJson);
  const summary = await runEval({ offlineOnly: false, questions: true });
  assert.equal(summary.results.length, 9);
  assert.deepEqual(summary.gate.failures, []);
  for (const result of summary.results) assert.deepEqual(result.ops, ['unsupported'], result.id);
});

test('still blocks a deploy whose commands the provider refuses to shape', async context => {
  mockProviderKey(context);
  context.mock.method(console, 'warn', () => {});
  mockQuestionFixtures(context, cases => cases.filter(({ id }) => id === 'first-reply-cancel'));
  context.mock.method(globalThis, 'fetch', refuseJson);
  const { gate } = await runEval({ offlineOnly: false, questions: true });
  assert.deepEqual(gate.failures, ['first-reply-cancel: control failed']);
});

// App 1.18.2 keeps the old token or route on such a patch, so the deploy gate must never see one come back.
test('blocks a deploy that returns a follow-up patch changing a token', async context => {
  mockProviderKey(context);
  context.mock.method(console, 'warn', () => {});
  mockQuestionFixtures(context, cases => cases.filter(({ id }) => id.startsWith('follow-change-')));
  const stale = {
    'send <AMT_1> USDCx instead': { asset: 'USDCx' },
    'use USDCx': {},
    'send <FIAT_AMT_1> of USDCx instead': { asset: 'USDCx' },
    'swap <AMT_1> ETH instead': { asset: 'ETH' },
    '<AMT_1>, and receive ETH': { to_asset: 'ETH' },
    '<AMT_1> USDCx instead': { asset: 'USDCx' }
  };
  const unchanged = Object.fromEntries(
    ['action', 'amount', 'asset', 'to_asset', 'from_chain', 'to_chain', 'recipient_ref', 'provider', 'note_type'].map(
      key => [key, null]
    )
  );
  context.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { utterance } = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
    return providerReply({ op: 'patch_slots', patch: { ...unchanged, earn_op: null, ...stale[utterance] } });
  });
  const summary = await runEval({ offlineOnly: false, questions: true });
  assert.equal(summary.results.length, 6);
  assert.deepEqual(summary.gate.failures, []);
  for (const result of summary.results) assert.deepEqual(result.ops, ['unsupported'], result.id);
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
  // One wait, before the second request: a sleep inside a request would spend the Worker's writing deadline.
  assert.deepEqual(delays, [30000]);
  assert.deepEqual(summary.rateLimitHeaders, {
    'x-ratelimit-remaining-tokens': '10',
    'x-ratelimit-reset-tokens': '30s'
  });
  assert.equal(summary.modelFailures, 0, summary.errors.join('\n'));
});

test('waits once when a provider 429 also carries a token reset', async context => {
  mockProviderKey(context);
  const delays = [];
  const realSetTimeout = globalThis.setTimeout;
  context.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay === 15000) return realSetTimeout(callback, delay, ...args);
    delays.push(delay);
    return realSetTimeout(callback, 0, ...args);
  });
  let attempts = 0;
  context.mock.method(globalThis, 'fetch', async () =>
    ++attempts === 1
      ? new Response(null, {
          status: 429,
          headers: { 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '2m' }
        })
      : providerReply({ op: 'help', cards: ['usdcx'] })
  );
  const budget = { remainingMs: 120000 };
  const worker = evaluation.createEvalWorker();
  await evaluation.retryTransient(() => worker.compile({ redactedText: 'what is usdcx', helpContext: null }), budget);
  assert.deepEqual(delays, [60000]);
  assert.equal(budget.remainingMs, 60000);
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
  assert.ok(live.includes('GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}\n'));
  assert.ok(!workflow.includes('GROQ_API_KEY_EVAL'));
  for (const [suite, flags] of [
    ['measure', '--measure --require-live'],
    ['writing-checker-dev', '--writing-checker --dev-only --require-live'],
    ['writing-checker', '--writing-checker --require-live'],
    ['writing-dev', '--writing --dev-only --require-live'],
    ['writing', '--writing --require-live'],
    ['writing-knockout', '--writing-knockout --require-live'],
    ['writing-score', '--writing-score scripts/command-ai-eval/results']
  ]) {
    assert.match(before, new RegExp(`\n {10}- ${suite}\n`));
    assert.ok(live.includes(`${suite}) node scripts/command-ai-eval/run-eval.mjs ${flags} ;;`), suite);
  }
  assert.ok(live.includes('path: |\n            command-ai-eval.json\n            grading.json\n'));
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
    devAnsweredRate: 2 / 3,
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

test('fails a selection run that leaves the dev help questions unanswered', () => {
  const dev = ['a', 'b', 'c', 'd', 'e'].map(id => result(id, {}, [run(id === 'a' ? 'usdcx' : null, 'cancel')]));
  const held = ['answerable', 'near_miss', 'out_of_scope'].map(name => {
    const answered = name === 'answerable';
    const fields = { set: 'holdout', class: name, cards: answered ? ['usdcx'] : [] };
    return result(`held-${name}`, fields, [run(answered ? 'usdcx' : 'not_covered')]);
  });
  assert.deepEqual(evaluation.selectionFailures(evaluation.scoreSelection([...dev, ...held])), [
    'devAnsweredRate 0.2 is under 0.8'
  ]);
});

test('names every missed selection bar and gates near misses only on a holdout', () => {
  assert.equal(typeof evaluation.selectionFailures, 'function');
  const clean = {
    devAccepted: 0.95,
    holdoutAccepted: 0.9,
    devAnsweredRate: 0.8,
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
    devAnsweredRate: 0.79,
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
    'regressed: requests failed',
    'flaky: requests failed',
    'intended: an intended change, now 0 of 3',
    'bad-before: requests failed',
    'help: a help question produced set_plan',
    'command: a command was answered as help',
    'fragment: a clarification reply was answered as help'
  ]);
  assert.deepEqual(evaluation.compareCommands(cases, baseline, summary([])).length, cases.length);
});

test('requires two passes of three from a case the baseline never ran', () => {
  const cases = ['broken', 'flaky', 'intended'].map(id => ({
    id,
    expected: { op: 'set_intent' },
    intendedChange: id === 'intended'
  }));
  const rows = [
    ['broken', 1],
    ['flaky', 2],
    ['intended', 0]
  ];
  const current = { results: rows.map(([id, passes]) => ({ id, passes, runs: 3, ops: ['unsupported'] })) };
  assert.deepEqual(evaluation.compareCommands(cases, { results: [] }, current), [
    'broken: not on the baseline, now 1 of 3',
    'intended: an intended change, now 0 of 3'
  ]);
});

test('refuses a baseline with failed requests, and failed requests that were never compared', () => {
  const cases = [{ id: 'a', expected: { op: 'cancel' } }];
  const summary = (passes, ...ops) => ({ results: [{ id: 'a', passes, runs: 3, ops }] });
  const broken = summary(2, 'error', 'cancel', 'cancel');
  const clean = summary(3, 'cancel', 'cancel', 'cancel');
  assert.deepEqual(evaluation.compareCommands(cases, broken, clean), [
    'a: the baseline has failed requests, record it again'
  ]);
  assert.deepEqual(evaluation.compareCommands(cases, broken, summary(0, 'error', 'error', 'error')), [
    'a: the baseline has failed requests, record it again',
    'a: requests failed'
  ]);
  assert.deepEqual(evaluation.compareCommands(cases, clean, broken), ['a: requests failed']);
});

const holdoutCases = (counts = { answerable: 80, near_miss: 30, out_of_scope: 30 }) =>
  Object.entries(counts).flatMap(([name, count]) =>
    Array.from({ length: count }, (_, index) =>
      selectionCase(`held-${name}-${index}`, { class: name, cards: name === 'answerable' ? ['usdcx'] : [] })
    )
  );

function holdoutFile(context, cases) {
  const directory = mkdtempSync(path.join(tmpdir(), 'holdout-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'help-holdout.json');
  writeFileSync(file, JSON.stringify(cases));
  return file;
}

test('loads the holdout for the merge gate and leaves it out of a dev run', context => {
  assert.equal(typeof evaluation.loadSelectionCases, 'function');
  const dev = evaluation.loadSelectionCases({ devOnly: true, holdoutPath: holdoutFile(context, holdoutCases()) });
  assert.ok(dev.length > 0 && dev.every(item => item.set === undefined));
  const all = evaluation.loadSelectionCases({ holdoutPath: holdoutFile(context, holdoutCases()) });
  assert.equal(all.filter(item => item.set === 'holdout').length, 140);
  assert.equal(all.length, dev.length + 140);
});

test('refuses a selection run without a holdout', () => {
  assert.throws(
    () => evaluation.loadSelectionCases({ holdoutPath: path.join(tmpdir(), 'no-such-holdout.json') }),
    /help-holdout\.json is missing/
  );
});

for (const [name, broken, message] of [
  ['an unknown forbidden card', { forbidCards: ['lost_phrases'] }, /unknown card lost_phrases/],
  ['an unknown accepted card', { cards: ['usd_cx'] }, /unknown card usd_cx/],
  ['an unknown class', { class: 'near-miss' }, /bad class/],
  ['an unknown priority', { priority: 'p0' }, /bad priority/],
  ['an answerable case without a card', { cards: [] }, /cards must be listed exactly for answerable cases/],
  ['an unknown help topic', { helpContext: 'Guardian' }, /bad helpContext/],
  ['a missing forbidden list', { forbidCards: undefined }, /forbidCards must be a list/],
  ['a missing cluster', { cluster: '' }, /missing cluster/],
  ['a repeated id', { id: 'held-near_miss-0' }, /repeated id/],
  ['a P0 case without a forbidden card', { priority: 'P0' }, /a P0 case needs a forbidden card/]
]) {
  test(`refuses a holdout with ${name}`, context => {
    const cases = holdoutCases();
    Object.assign(cases[0], broken);
    assert.throws(() => evaluation.loadSelectionCases({ holdoutPath: holdoutFile(context, cases) }), message);
  });
}

test('refuses a holdout with too few clusters in a class', context => {
  const holdoutPath = holdoutFile(context, holdoutCases({ answerable: 80, near_miss: 29, out_of_scope: 30 }));
  assert.throws(() => evaluation.loadSelectionCases({ holdoutPath }), /29 near_miss clusters, needs 30/);
});

test('refuses a holdout cluster that is not one intent', context => {
  const refuses = (extra, message) => {
    const holdoutPath = holdoutFile(context, [...holdoutCases(), extra]);
    assert.throws(() => evaluation.loadSelectionCases({ holdoutPath }), message);
  };
  refuses(
    selectionCase('mixed', { cluster: 'held-answerable-0', class: 'near_miss', cards: [] }),
    /held-answerable-0: mixed class/
  );
  refuses(
    selectionCase('merged', { cluster: 'held-answerable-0', cards: ['miden_what'] }),
    /held-answerable-0: no shared accepted card/
  );
  refuses(
    selectionCase('reused', { cluster: 'recover-forgot-password', cards: ['forgot_password'] }),
    /holdout reuses dev cluster recover-forgot-password/
  );
  refuses(
    selectionCase('recover-forgot-password-01', { class: 'near_miss', cards: [] }),
    /recover-forgot-password-01: repeated id/
  );
});

test('forbids both move-funds cards on every P0 password question', () => {
  const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
  for (const file of ['./help-eval.json', './questions.json']) {
    const checked = read(file).filter(item => item.priority === 'P0' && item.cards?.includes('forgot_password'));
    assert.ok(checked.length > 0, `${file} has no P0 password question`);
    const missing = checked.filter(
      item => !['lost_phrase', 'phrase_exposed'].every(card => item.forbidCards.includes(card))
    );
    assert.deepEqual(
      missing.map(item => item.id),
      []
    );
  }
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
  assert.ok(
    live.includes('selection-dev) node scripts/command-ai-eval/run-eval.mjs --selection --dev-only --require-live ;;')
  );
  assert.ok(live.includes('--compare scripts/command-ai-eval/baseline.json'));
});

const cardData = () =>
  JSON.parse(readFileSync(new URL('../../services/command-ai/src/help-cards.json', import.meta.url), 'utf8'));
const writeCardIds = () =>
  cardData()
    .cards.filter(card => card.mode === 'write')
    .map(card => card.id);
const writingOn = (...cards) => {
  const data = cardData();
  return { ...data, writing: { ...data.writing, cards } };
};
const ROUTER = 'openai/gpt-oss-120b';
const SMALL = 'openai/gpt-oss-20b';

const completion = (value, { headers, usage } = {}) =>
  Response.json(
    { usage, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] },
    { headers }
  );

/** A provider that routes to `cards`, writes the first supplied fact and answers checks with `verdict`. */
function mockWriting(context, { cards = ['guardian_what'], writer, verdict, headers } = {}) {
  const sent = [];
  context.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init.body));
    sent.push(body);
    const options = { headers: headers?.(body, sent.length) };
    const name = body.response_format.json_schema.name;
    if (name === 'bread_command_intent') return completion({ result: { op: 'help', cards } }, options);
    if (name === 'bread_help_answer') {
      const fact = JSON.parse(body.messages[1].content).cards[0].FACTS[0];
      const draft = { answerable: true, sentences: [{ facts: [fact.id], text: fact.text }] };
      return writer?.(sent.length) ?? completion(draft, options);
    }
    return verdict?.(sent.length) ?? completion({ supported: true, answers: true }, options);
  });
  return sent;
}

const limited = seconds => new Response(null, { status: 429, headers: { 'retry-after': String(seconds) } });

/** Runs waits of a second or more at once, and records them. */
function skipWaits(context) {
  const waits = [];
  const realSetTimeout = globalThis.setTimeout;
  context.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay < 1000 || delay === 3000 || delay === 4000 || delay === 15000) {
      return realSetTimeout(callback, delay, ...args);
    }
    waits.push(delay);
    return realSetTimeout(callback, 0, ...args);
  });
  return waits;
}

const ask = { redactedText: 'what is it', helpContext: null };
const lowTokens = {
  'x-ratelimit-limit-tokens': '250000',
  'x-ratelimit-remaining-tokens': '100000',
  'x-ratelimit-reset-tokens': '1m'
};

test('waits while a model has less than half of its token bucket left', () => {
  const delay = remaining =>
    evaluation.paceDelayMs(new Headers({ ...lowTokens, 'x-ratelimit-remaining-tokens': String(remaining) }), 3000);
  assert.equal(delay(125000), 0);
  assert.equal(delay(124999), 60000);
});

test('waits between requests only, so a slow bucket never costs a written answer', async context => {
  mockProviderKey(context);
  const events = [];
  const realSetTimeout = globalThis.setTimeout;
  context.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay !== 60000) return realSetTimeout(callback, delay, ...args);
    events.push('wait');
    return realSetTimeout(callback, 0, ...args);
  });
  mockWriting(context, {
    headers: body => {
      events.push(body.model);
      return body.model === SMALL ? lowTokens : {};
    }
  });
  const worker = evaluation.createEvalWorker({ dataset: writingOn('guardian_what') });
  const first = await worker.compile(ask);
  const second = await worker.compile(ask);
  assert.deepEqual([first.trace?.path, second.trace?.path], ['written', 'written']);
  assert.deepEqual(events, [ROUTER, SMALL, SMALL, 'wait', ROUTER, SMALL, SMALL]);
  assert.equal(worker.stats.models[SMALL]?.calls, 4);
});

test('stops a suite on a limit too low to share with production', () => {
  const reason = headers => evaluation.quotaStopReason('m', new Headers(headers));
  assert.equal(reason({}), null);
  const limits = (tokens, requests, left) => ({
    'x-ratelimit-limit-tokens': String(tokens),
    'x-ratelimit-limit-requests': String(requests),
    'x-ratelimit-remaining-requests': String(left)
  });
  assert.equal(reason(limits(250000, 500000, 250000)), null);
  assert.match(reason(limits(8000, 500000, 500000)), /8000 tokens a minute/);
  assert.match(reason(limits(250000, 1000, 1000)), /1000 requests a day/);
  assert.match(reason(limits(250000, 500000, 249999)), /249999 of 500000 requests left/);
});

test('ends a guarded suite with no verdict on a low daily request limit', async context => {
  mockProviderKey(context);
  const sent = mockWriting(context, { headers: () => ({ 'x-ratelimit-limit-requests': '1000' }) });
  const cases = [selectionCase('a'), selectionCase('b')];
  await assert.rejects(
    async () => evaluation.runSelection({ cases, service: evaluation.createEvalWorker({ guard: true }) }),
    /Quota stop/
  );
  assert.equal(sent.length, 1);
  const unguarded = await evaluation.runSelection({ cases, runs: 1, service: evaluation.createEvalWorker() });
  assert.equal(unguarded.length, 2);
});

test('measures selection with writing off, even once cards are listed', async context => {
  mockProviderKey(context);
  const sent = mockWriting(context);
  const worker = evaluation.selectionWorker(writingOn('guardian_what'));
  const reply = await worker.compile(ask);
  assert.equal(reply.trace?.path, 'card');
  assert.equal(sent.length, 1);
});

const writingCase = (id, fields = {}) => selectionCase(id, { cards: ['guardian_what'], ...fields });

test('runs every write card on and reruns only a technical failure', async context => {
  mockProviderKey(context);
  let failures = 1;
  const sent = mockWriting(context, { writer: () => (failures-- > 0 ? limited(0) : null) });
  const worker = evaluation.createEvalWorker();
  const { results, invalid } = await evaluation.runWriting({ cases: [writingCase('a')], runs: 2, service: worker });
  assert.deepEqual(invalid, []);
  assert.deepEqual(
    results[0]?.runs.map(({ path, outcome, technicalAttempts }) => [path, outcome, technicalAttempts]),
    [
      ['written', 'written', 1],
      ['written', 'written', 0]
    ]
  );
  assert.equal(sent.length, 2 + 3 + 3);
});

test('never writes a safety or who-can-see card, even with every write card on', async context => {
  mockProviderKey(context);
  const sent = mockWriting(context, { cards: ['stay_safe'] });
  const { results } = await evaluation.runWriting({
    cases: [writingCase('a', { cards: ['stay_safe'] })],
    runs: 1,
    service: evaluation.createEvalWorker()
  });
  assert.equal(results[0]?.runs[0]?.path, 'card');
  assert.equal(sent.length, 1);
});

test('does not count a knockout run whose writer keeps failing', async context => {
  mockProviderKey(context);
  const sent = mockWriting(context, {
    cards: ['guardian_what', 'guardian_why'],
    writer: () => limited(0)
  });
  const { results, invalid } = await evaluation.runWriting({
    cases: [writingCase('a')],
    runs: 1,
    knockout: true,
    service: evaluation.createEvalWorker()
  });
  assert.deepEqual(invalid, ['a']);
  assert.equal(results[0]?.runs[0]?.technicalAttempts, 4);
  assert.equal(sent.length, 8);
  // The accepted card is gone from the router's index, so only the other one reaches the writer.
  assert.ok(!sent[0].messages[0].content.includes('\nguardian_what: '));
  assert.ok(sent[0].messages[0].content.includes('\nguardian_why: '));
});

const checkerRow = (id, fields = {}) => ({
  id,
  split: 'dev',
  class: 'flipped_not',
  priority: 'P0',
  cards: ['guardian_what'],
  sentences: [{ facts: ['g.service'], text: cardData().facts['g.service'].text }],
  q: 'what is a guardian',
  previousTopic: null,
  ...fields
});

test('never counts a failed checker call as a rejection', async context => {
  mockProviderKey(context);
  mockWriting(context, { verdict: () => limited(0) });
  const run = await evaluation.runWritingChecker({
    rows: [checkerRow('a')],
    runs: 1,
    service: evaluation.createEvalWorker()
  });
  assert.deepEqual(run.invalid, ['a']);
  assert.deepEqual(run.results[0]?.runs, [{ accepted: null, technicalAttempts: 4 }]);
});

test('waits for a checker 429 reset before it asks again', async context => {
  mockProviderKey(context);
  const waits = skipWaits(context);
  let failures = 2;
  mockWriting(context, { verdict: () => (failures-- > 0 ? limited(20) : null) });
  const run = await evaluation.runWritingChecker({
    rows: [checkerRow('a')],
    runs: 1,
    service: evaluation.createEvalWorker()
  });
  assert.deepEqual(run.invalid, []);
  assert.deepEqual(waits, [20000, 20000]);
});

test('stops a suite after three runs in a row stay technical failures', async context => {
  mockProviderKey(context);
  const sent = mockWriting(context, { writer: () => limited(0), verdict: () => limited(0) });
  const ids = ['a', 'b', 'c', 'd', 'e'];
  await assert.rejects(
    evaluation.runWritingChecker({
      rows: ids.map(id => checkerRow(id)),
      runs: 1,
      service: evaluation.createEvalWorker()
    }),
    /3 runs in a row/
  );
  assert.equal(sent.length, 12);
  sent.length = 0;
  await assert.rejects(
    evaluation.runWriting({ cases: ids.map(id => writingCase(id)), runs: 1, service: evaluation.createEvalWorker() }),
    /3 runs in a row/
  );
  assert.equal(sent.length, 24);
});

const rateLimited = limit =>
  new Response(JSON.stringify({ error: { message: `Rate limit reached for model m on ${limit}: Limit 1.` } }), {
    status: 429,
    headers: { 'retry-after': '2' }
  });

test('ends a guarded command suite on a daily or unnamed limit without asking again', async context => {
  mockProviderKey(context);
  skipWaits(context);
  context.mock.method(console, 'warn', () => {});
  let reply;
  const fetch = context.mock.method(globalThis, 'fetch', async () => reply());
  const run = () => runEval({ offlineOnly: false, commandsViaWorker: true, guard: true });
  reply = () => rateLimited('tokens per day (TPD)');
  await assert.rejects(run, /Quota stop: .*a daily or quota limit/);
  assert.equal(fetch.mock.callCount(), 1);
  reply = () => new Response(null, { status: 429 });
  await assert.rejects(run, /Quota stop: .*names no per-minute limit/);
  assert.equal(fetch.mock.callCount(), 2);
});

test('waits out a per-minute limit in a guarded command suite and totals its calls', async context => {
  mockProviderKey(context);
  skipWaits(context);
  context.mock.method(console, 'warn', () => {});
  mockCaseFixtures(context, cases => cases.slice(0, 1));
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () =>
    ++calls === 1
      ? rateLimited('tokens per minute (TPM)')
      : Response.json({
          choices: [{ finish_reason: 'stop', message: { content: '{"result":{"op":"cancel"}}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 }
        })
  );
  const summary = await runEval({ offlineOnly: false, commandsViaWorker: true, guard: true });
  assert.equal(calls, 4);
  assert.ok(summary.usage, 'the summary totals usage per model');
  const [usage] = Object.values(summary.usage);
  assert.deepEqual([usage.calls, usage.promptTokens, usage.completionTokens], [4, 30, 6]);
});

test('ends a guarded suite when a model asks for a very long wait', async context => {
  mockProviderKey(context);
  skipWaits(context);
  mockWriting(context, { verdict: () => limited(3600) });
  await assert.rejects(
    evaluation.runWritingChecker({
      rows: [checkerRow('a')],
      runs: 1,
      service: evaluation.createEvalWorker({ guard: true })
    }),
    /Quota stop: .*3600 s/
  );
});

test('asks the checker about every row, gate rejects included, and scores each side', async context => {
  mockProviderKey(context);
  const sent = mockWriting(context);
  const rows = [
    checkerRow('gated', { sentences: [{ facts: ['g.service'], text: 'Ask Acme about it.' }] }),
    checkerRow('passes', { priority: 'P1' }),
    checkerRow('faithful', { class: 'good', q: 'do 5 people run it' })
  ];
  const { results, invalid } = await evaluation.runWritingChecker({ rows, service: evaluation.createEvalWorker() });
  assert.deepEqual(invalid, []);
  assert.equal(sent.length, 9);
  assert.equal(JSON.parse(sent[6].messages[1].content).QUESTION, 'do [a number] people run it');
  assert.deepEqual(
    results.map(row => row.gates),
    [false, true, true]
  );
  assert.deepEqual(evaluation.scoreWritingChecker(results), {
    p0Accepted: [],
    badAccepted: 0.5,
    badPassingGates: 0.5,
    badPassingChecker: 1,
    goodRejected: 0,
    goodRejectedGates: 0,
    goodRejectedChecker: 0
  });
});

const BAD = [
  'flipped_not',
  'swapped_actor',
  'dropped_condition',
  'added_detail',
  'joined_facts',
  'neighbour_question',
  'forbidden_or_injected'
];
const checkerRows = () => [
  ...Array.from({ length: 150 }, (_, index) => checkerRow(`bad-${index}`, { class: BAD[index % BAD.length] })),
  ...Array.from({ length: 75 }, (_, index) => checkerRow(`good-${index}`, { class: 'good' }))
];

test('requires the full counts of each checker file', () => {
  assert.deepEqual(evaluation.checkerRowErrors(checkerRows()), []);
  assert.deepEqual(evaluation.checkerRowErrors(checkerRows().slice(1)), ['149 bad rows, needs 150']);
  assert.deepEqual(evaluation.checkerRowErrors(checkerRows().slice(0, -1)), ['74 good rows, needs 75']);
  const rows = checkerRows();
  rows[0] = { ...rows[0], id: 'bad-1', cards: ['lost_phrase'] };
  assert.deepEqual(evaluation.checkerRowErrors(rows).slice(0, 2), [
    'bad-1: needs one or two write cards',
    'bad-1: missing or repeated id'
  ]);
});

for (const [name, sentences] of [
  ['an extra key', [{ facts: ['g.service'], text: 'It is a friend.', note: 'flipped' }]],
  ['a mistyped fact id', [{ facts: ['g.sevice'], text: 'It is a friend.' }]],
  ['a fact of another card', [{ facts: ['u.block'], text: 'It is a friend.' }]],
  ['no fact id', [{ facts: [], text: 'It is a friend.' }]],
  ['no text', [{ facts: ['g.service'], text: ' ' }]],
  ['a missing key', [{ text: 'It is a friend.' }]],
  ['no sentence', []]
]) {
  test(`refuses a checker row with ${name}`, () => {
    const rows = checkerRows();
    rows[0] = { ...rows[0], sentences };
    assert.deepEqual(evaluation.checkerRowErrors(rows), ['bad-0: needs sentences of facts and text from its cards']);
  });
}

test('checks both holdouts together and refuses a writing run without its own', context => {
  const holdoutPath = holdoutFile(context, holdoutCases());
  const written = fields => holdoutFile(context, [selectionCase('written-1', fields)]);
  const load = writingHoldoutPath => evaluation.loadWritingCases({ holdoutPath, writingHoldoutPath });
  assert.equal(load(written({})).length, 141);
  assert.ok(load(written({})).every(item => item.set === 'holdout'));
  assert.throws(
    () => load(path.join(tmpdir(), 'no-such-writing-holdout.json')),
    /help-writing-holdout\.json is missing/
  );
  assert.throws(() => load(written({ cluster: 'held-answerable-0' })), /reuses selection holdout cluster/);
  assert.throws(() => load(written({ id: 'held-near_miss-0' })), /repeated id/);
  assert.throws(() => load(written({ cluster: 'recover-forgot-password', cards: ['forgot_password'] })), /dev cluster/);
});

test('gives the Wilson 90 percent bar to 143 of 150 and not to 142', () => {
  assert.equal(evaluation.wilsonLower(143, 150).toFixed(3), '0.907');
  assert.equal(evaluation.wilsonLower(142, 150).toFixed(3), '0.898');
});

/** Four summaries and two graded files that pass every bar: 150 written clusters, 3 on each of 50 cards. */
function scoreWorld({ written = 150, knockout = 40 } = {}) {
  const ids = writeCardIds();
  const make = (prefix, count, fields) =>
    Array.from({ length: count }, (_, index) =>
      writingCase(`${prefix}-${index}`, { set: 'holdout', ...fields(index) })
    );
  const cardOf = index => ids[Math.floor(index / 3) % ids.length];
  const writing = [
    ...make('w', written, index => ({ cards: [cardOf(index)] })),
    ...make('near', 20, () => ({ class: 'near_miss', cards: [] })),
    ...make('out', 20, () => ({ class: 'out_of_scope', cards: [] }))
  ];
  const runOf = (path, outcome, served, text, cards = served ? [served] : []) => ({
    op: 'explain',
    path,
    served,
    outcome,
    cards,
    text,
    technicalAttempts: 0
  });
  const thrice = (item, run) => ({
    id: item.id,
    cluster: item.cluster,
    class: item.class,
    set: 'holdout',
    runs: [{ ...run }, { ...run }, { ...run }]
  });
  const refusal = runOf('unknown', 'unanswerable', 'not_covered', 'I do not know.', ['guardian_what']);
  const writingResults = writing.map(item =>
    thrice(
      item,
      item.class === 'answerable' ? runOf('written', 'written', item.cards[0], `Written for ${item.id}.`) : refusal
    )
  );
  const knockoutCases = writing.filter(item => item.class === 'answerable');
  const knockoutResults = knockoutCases.map((item, index) =>
    thrice(item, index < knockout ? refusal : runOf('unknown', null, 'not_covered', 'I do not know.'))
  );
  const meta = suite => ({
    suite,
    devOnly: false,
    gitSha: 'abc',
    hashes: { dataset: '1' },
    models: { router: ROUTER }
  });
  const selection = [...writing, writingCase('dev-0', { set: 'dev' })];
  const selectionResults = selection.map(item => ({
    ...item,
    runs: Array(3).fill(run(item.cards[0] ?? 'not_covered'))
  }));
  const rows = checkerRows();
  const checkerResults = rows.map(row => ({
    id: row.id,
    class: row.class,
    priority: row.priority,
    gates: true,
    runs: Array(3).fill({ accepted: row.class === 'good', technicalAttempts: 0 })
  }));
  const grade = list => list.map(row => ({ ...row, verdict: 'correct', serious: false }));
  const world = {
    summaries: {
      selection: { meta: meta('selection'), results: selectionResults },
      checker: { meta: meta('writing-checker'), invalid: [], results: checkerResults },
      writing: { meta: meta('writing'), invalid: [], results: writingResults },
      knockout: { meta: meta('writing-knockout'), invalid: [], results: knockoutResults }
    },
    cases: { selection, writing, checker: rows }
  };
  world.regrade = () => {
    world.grading = grade(evaluation.gradingRows(writing, world.summaries.writing.results));
    world.knockoutGrading = grade(
      evaluation.gradingRows(knockoutCases, world.summaries.knockout.results, { knockout: true })
    );
    return world;
  };
  return world.regrade();
}

const failuresOf = world => evaluation.scoreWriting(world).failures;
const mark = (world, count, fields, from = 0, step = 3) => {
  for (let index = 0; index < count; index++) {
    const row = world.grading.find(item => item.cluster === `w-${from + index * step}`);
    Object.assign(row, fields);
  }
};

test('writes one grading row for each distinct shown text, with the facts behind it', () => {
  const cases = [writingCase('a', { q: 'send 5 to Bob, how' })];
  const shown = text => ({
    path: 'written',
    outcome: 'written',
    served: 'guardian_what',
    cards: ['guardian_what'],
    text
  });
  const rows = evaluation.gradingRows(cases, [{ id: 'a', runs: [shown('One.'), shown('One.'), shown('Two.')] }]);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    [rows[0].q, rows[0].previousTopic, rows[0].text, rows[0].path, rows[0].verdict, rows[0].serious],
    ['send 5 to Bob, how', null, 'One.', 'written', null, null]
  );
  assert.ok(rows[0].facts.includes(cardData().facts['g.service'].text));
});

test('passes a run that meets every bar and lists the cards to enable', () => {
  const score = evaluation.scoreWriting(scoreWorld());
  assert.deepEqual(score.failures, []);
  assert.equal(score.report.writtenClusters, 150);
  assert.deepEqual(score.allowlist, writeCardIds().slice(0, 50));
});

test('holds written precision to 143 of 150 clusters', () => {
  const passing = scoreWorld();
  mark(passing, 7, { verdict: 'wrong' });
  assert.deepEqual(failuresOf(passing), []);
  const failing = scoreWorld();
  mark(failing, 8, { verdict: 'wrong' });
  assert.ok(failuresOf(failing).some(failure => failure.startsWith('written Wilson lower bound')));
});

test('calls a cluster wrong when one run of it is wrong, and counts only written answers', () => {
  const world = scoreWorld();
  Object.assign(world.summaries.writing.results[0].runs[2], { text: 'Another answer.' });
  world.regrade();
  Object.assign(
    world.grading.find(row => row.text === 'Another answer.'),
    { verdict: 'wrong' }
  );
  assert.equal(evaluation.scoreWriting(world).report.writtenCorrect, 149 / 150);

  const short = scoreWorld();
  for (const one of short.summaries.writing.results[0].runs) Object.assign(one, { path: 'card', outcome: 'format' });
  assert.ok(failuresOf(short.regrade()).includes('written clusters 149 is under 150'));
});

test('fails on one serious error and drops the card that made it', () => {
  const world = scoreWorld();
  mark(world, 1, { serious: true });
  const score = evaluation.scoreWriting(world);
  assert.deepEqual(score.failures, ['serious errors: w-0']);
  assert.ok(!score.allowlist.includes(writeCardIds()[0]));
});

test('enables a card only with three written clusters and fewer than two wrong', () => {
  const world = scoreWorld({ written: 149 });
  const [first, second] = writeCardIds();
  mark(world, 2, { verdict: 'wrong' }, 0, 1);
  mark(world, 1, { verdict: 'wrong' }, 3);
  const { allowlist, report } = evaluation.scoreWriting(world);
  assert.ok(!allowlist.includes(first) && allowlist.includes(second));
  assert.deepEqual(report.cards[writeCardIds()[49]], { clusters: 2, wrong: 0, serious: false });
  assert.ok(!allowlist.includes(writeCardIds()[49]));
});

test('voids on technical failures and fails on too many or imprecise fallbacks', () => {
  const flaky = scoreWorld();
  for (const result of flaky.summaries.writing.results.slice(0, 12)) result.runs[0].technicalAttempts = 1;
  assert.ok(failuresOf(flaky).some(failure => failure.startsWith('void: writing technical failures')));

  const fallbacks = scoreWorld({ written: 190 });
  for (const result of fallbacks.summaries.writing.results.slice(0, 40)) {
    for (const one of result.runs) Object.assign(one, { path: 'card', outcome: 'format' });
  }
  fallbacks.regrade();
  Object.assign(
    fallbacks.grading.find(row => row.cluster === 'w-0'),
    { verdict: 'wrong' }
  );
  Object.assign(
    fallbacks.grading.find(row => row.cluster === 'w-1'),
    { verdict: 'wrong' }
  );
  Object.assign(
    fallbacks.grading.find(row => row.cluster === 'w-2'),
    { verdict: 'wrong' }
  );
  const failures = failuresOf(fallbacks);
  assert.ok(failures.some(failure => failure.startsWith('checked-answer fallbacks')));
  assert.ok(failures.some(failure => failure.startsWith('the format fallback is 0.925 precise')));
});

test('fails an empty knockout, a short one and a failed selection run', () => {
  const empty = failuresOf(scoreWorld({ knockout: 0 }));
  assert.ok(empty.includes('knockout reached the writer in 0 clusters: no verdict'));
  assert.ok(empty.includes('knockout pass null is under 0.95'));
  assert.ok(failuresOf(scoreWorld({ knockout: 29 })).some(failure => failure.includes('no verdict')));
  const world = scoreWorld();
  for (const one of world.summaries.selection.results) one.runs = Array(3).fill(run('not_covered'));
  assert.ok(failuresOf(world).some(failure => failure.startsWith('selection: answeredRate')));
});

for (const [name, spoil, message] of [
  ['an ungraded row', world => (world.grading[0].verdict = null), /ungraded row/],
  ['a row with no serious flag', world => (world.grading[1].serious = null), /ungraded row/],
  ['a missing row', world => world.grading.pop(), /does not match its summary/],
  ['an edited row', world => (world.grading[0].text = 'Edited.'), /does not match its summary/],
  ['a missing case', world => world.summaries.writing.results.pop(), /writing lacks full runs/],
  ['a missing run', world => world.summaries.selection.results[0].runs.pop(), /selection lacks full runs/],
  ['a missing checker row', world => world.summaries.checker.results.pop(), /checker lacks full runs/],
  ['another commit', world => (world.summaries.knockout.meta.gitSha = 'def'), /different code/],
  ['other hashes', world => (world.summaries.checker.meta.hashes = { dataset: '2' }), /different code/],
  ['a dev run', world => (world.summaries.writing.meta.devOnly = true), /not a full writing summary/],
  ['an invalid suite', world => (world.summaries.checker.invalid = ['x']), /technical failures remain/],
  [
    'a technical run',
    world => (world.summaries.writing.results[0].runs[0].outcome = 'writer_technical'),
    /holds failed runs/
  ]
]) {
  test(`refuses to score ${name}`, () => {
    const world = scoreWorld();
    spoil(world);
    assert.throws(() => evaluation.scoreWriting(world), message);
  });
}

/** A provider whose router bucket reports `routerTokens` and `routerRequests` on its nth reply. */
function mockLimits(
  context,
  {
    routerTokens = () => 240000,
    routerRequests = n => 100000 - n,
    smallUsage = { prompt_tokens: 1500, completion_tokens: 500 },
    latencyMs = 0,
    routerPrompt = 3300,
    writer,
    headers = true
  } = {}
) {
  let routerReplies = 0;
  const models = [];
  context.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init.body));
    models.push(body.model);
    const name = body.response_format.json_schema.name;
    if (latencyMs > 0) await new Promise(resolve => setTimeout(resolve, latencyMs));
    const limits = (tokens, requests) =>
      headers
        ? {
            'x-ratelimit-limit-tokens': '250000',
            'x-ratelimit-remaining-tokens': String(tokens),
            'x-ratelimit-limit-requests': '500000',
            'x-ratelimit-remaining-requests': String(requests)
          }
        : {};
    if (name === 'bread_command_intent') {
      routerReplies += 1;
      return completion(
        { result: { op: 'help', cards: ['guardian_what'] } },
        {
          headers: limits(routerTokens(routerReplies), routerRequests(routerReplies)),
          usage: { prompt_tokens: routerPrompt, completion_tokens: 40 }
        }
      );
    }
    const options = { headers: limits(200000, 90000), usage: smallUsage };
    if (name === 'bread_help_answer') {
      return writer?.() ?? completion({ answerable: false, sentences: [] }, options);
    }
    return completion({ supported: true, answers: true }, options);
  });
  return models;
}

const measure = () => evaluation.runMeasure();

test('measures each call and proves separate buckets from one clean attempt', async context => {
  mockProviderKey(context);
  const models = mockLimits(context);
  const report = await measure();
  assert.deepEqual(report.failures, []);
  assert.equal(report.separation.proven, true);
  assert.equal(report.separation.attempts.length, 1);
  assert.deepEqual(models, [ROUTER, SMALL, SMALL, ROUTER, ...Array(5).fill(SMALL), ROUTER]);
  assert.equal(report.router.promptTokens, 3300);
  assert.equal(report.writer.completionTokens, 500);
  assert.equal(report.checker.headers['x-ratelimit-limit-tokens'], '250000');
  assert.equal(typeof report.checker.latencyMs, 'number');
});

for (const [name, options] of [
  ['the daily request counts move together', { routerRequests: n => 100000 - n * 6 }],
  // Replies 2 and 3 bracket the five small calls: a shared bucket is down by their 10,000 tokens too.
  ['the router bucket pays for the small calls', { routerTokens: n => 240000 - (n > 2 ? 13812 : 0) * (n % 2) }],
  ['the small calls are too few to tell', { smallUsage: { prompt_tokens: 60, completion_tokens: 10 } }],
  ['the provider sends no limits', { headers: false }]
]) {
  test(`proves nothing when ${name}`, async context => {
    mockProviderKey(context);
    mockLimits(context, options);
    const report = await measure();
    assert.equal(report.separation.proven, false);
    assert.equal(report.separation.attempts.length, 3);
    assert.deepEqual(report.failures, ['no proof that the writer and checker leave the router quota alone']);
  });
}

test('proves separate buckets at the documented limit with ordinary latency', async context => {
  mockProviderKey(context);
  const models = mockLimits(context, {
    routerPrompt: 3400,
    smallUsage: { prompt_tokens: 750, completion_tokens: 350 },
    latencyMs: 600
  });
  const report = await measure();
  assert.equal(report.separation.proven, true);
  assert.equal(report.separation.attempts.length, 1);
  const [attempt] = report.separation.attempts;
  assert.ok(attempt.smallTokens > attempt.reservation + attempt.refill);
  assert.ok(models.filter(model => model === SMALL).length <= 2 + 40);
});

test('repeats a spoiled separation attempt, since live traffic only causes a false fail', async context => {
  mockProviderKey(context);
  mockLimits(context, { routerRequests: n => 100000 - (n === 3 ? 20 : n) });
  const report = await measure();
  assert.equal(report.separation.proven, true);
  assert.equal(report.separation.attempts.length, 2);
});

test('fails the measure on a rejected schema or a router prompt over 3,600 tokens', async context => {
  mockProviderKey(context);
  mockLimits(context, { routerPrompt: 3601, writer: () => new Response(null, { status: 400 }) });
  const { failures } = await measure();
  assert.ok(failures.includes('the router prompt is 3601 tokens, over 3600'));
  assert.ok(failures.includes('the writer call failed with HTTP 400'));
});

/** The deploy gate over `count` questions about write cards, with the writer failing on the first `failing`. */
async function gateWithWriting(context, { count = 6, failing = 0, listed = writeCardIds() } = {}) {
  mockProviderKey(context);
  const writable = writeCardIds();
  const fixtures = [];
  mockQuestionFixtures(context, cases => {
    fixtures.splice(0, fixtures.length, ...cases.filter(item => writable.includes(item.cards?.[0])).slice(0, count));
    return fixtures;
  });
  let current;
  context.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init.body));
    const name = body.response_format.json_schema.name;
    const user = body.messages[1].content;
    if (name === 'bread_command_intent') {
      current = fixtures.find(fixture => user.includes(fixture.expectedRedacted));
      return completion({ result: { op: 'help', cards: [current.cards[0]] } });
    }
    if (name === 'bread_help_check') return completion({ supported: true, answers: true });
    if (fixtures.indexOf(current) < failing) return limited(0);
    const fact = JSON.parse(user).cards[0].FACTS[0];
    return completion({ answerable: true, sentences: [{ facts: [fact.id], text: fact.text }] });
  });
  const summary = await runEval({ offlineOnly: false, questions: true, dataset: writingOn(...listed) });
  assert.equal(fixtures.length, count);
  return summary.gate?.failures;
}

test('passes the deploy gate when two thirds of the writer questions are answered in written text', async context => {
  assert.deepEqual(await gateWithWriting(context, { failing: 2 }), []);
});

test('blocks the deploy when writer failures leave under two thirds written', async context => {
  assert.deepEqual(await gateWithWriting(context, { failing: 3 }), [
    'only 3 of 6 writer questions were answered in written text'
  ]);
});

test('blocks the deploy when fewer than six questions reach a listed card', async context => {
  assert.deepEqual(await gateWithWriting(context, { count: 5 }), ['5 questions expect a listed writing card, needs 6']);
});

test('blocks the deploy on a forbidden card that a written reply cites second', async context => {
  mockProviderKey(context);
  const writable = writeCardIds();
  let fixture;
  mockQuestionFixtures(context, cases => {
    fixture = cases.find(
      item => item.priority === 'P0' && writable.includes(item.cards?.[0]) && writable.includes(item.forbidCards?.[0])
    );
    return [fixture];
  });
  context.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init.body));
    const name = body.response_format.json_schema.name;
    if (name === 'bread_command_intent') {
      return completion({ result: { op: 'help', cards: [fixture.cards[0], fixture.forbidCards[0]] } });
    }
    if (name === 'bread_help_check') return completion({ supported: true, answers: true });
    const data = cardData();
    const { cards } = JSON.parse(body.messages[1].content);
    // One fact of each card's own, copied word for word.
    const sentences = cards.map(given => {
      const other = new Set(cards.filter(item => item !== given).flatMap(item => item.FACTS.map(fact => fact.id)));
      const fact = given.FACTS.find(item => !other.has(item.id) && data.facts[item.id]);
      return { facts: [fact.id], text: fact.text };
    });
    return completion({ answerable: true, sentences });
  });
  const summary = await runEval({ offlineOnly: false, questions: true, dataset: writingOn(...writable) });
  assert.ok(
    summary.gate?.failures.includes(`${fixture.id}: served the forbidden card ${fixture.forbidCards[0]}`),
    JSON.stringify(summary.gate?.failures)
  );
});

test('asks nothing of written answers while no card is listed', async context => {
  assert.deepEqual(await gateWithWriting(context, { count: 5, listed: [] }), []);
});

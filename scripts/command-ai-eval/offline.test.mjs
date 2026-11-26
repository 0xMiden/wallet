import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as evaluation from './run-eval.mjs';

const { runEval } = evaluation;

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
});

test('retries transient failures a bounded number of times', async () => {
  assert.equal(typeof evaluation.retryTransient, 'function');
  let attempts = 0;
  const result = await evaluation.retryTransient(async () => {
    if (++attempts < 3) throw new Error('Worker returned 502');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(
    evaluation.retryTransient(async () => {
      attempts++;
      throw new Error('Worker returned 400');
    }),
    /Worker returned 400/
  );
  assert.equal(attempts, 1);
});

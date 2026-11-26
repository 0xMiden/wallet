import assert from 'node:assert/strict';
import test from 'node:test';

import { runEval } from './run-eval.mjs';

test('offline privacy redaction and provenance eval suite passes with 0 leaks across 60+ cases', async () => {
  const summary = await runEval({ offlineOnly: true });
  assert.ok(summary.totalCases >= 60, `Expected >=60 cases, got ${summary.totalCases}`);
  assert.equal(summary.redactionFailures, 0, summary.errors.join('\n'));
  assert.equal(summary.provenanceFailures, 0, summary.errors.join('\n'));
});

test('synthetic questions preserve redaction and never need wallet state', async () => {
  const summary = await runEval({ offlineOnly: true, questions: true });
  assert.equal(summary.totalCases, 19);
  assert.equal(summary.redactionFailures, 0, summary.errors.join('\n'));
  assert.equal(summary.provenanceFailures, 0, summary.errors.join('\n'));
});

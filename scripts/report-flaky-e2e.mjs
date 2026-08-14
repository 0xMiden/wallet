#!/usr/bin/env node
/**
 * Print the retried-then-passed ("flaky") tests from a Playwright JSON report.
 *
 * The E2E workflows run playwright with `--retries=1`, which is deliberate: it
 * absorbs a rare loaded-runner hiccup so a genuine regression still fails the
 * gate. The cost is that a spec which failed once and passed on the retry is
 * reported as a plain green run, so the flake rate is invisible and untracked.
 *
 * This script re-reads the JSON reporter output after the run and prints one
 * line per such test:
 *
 *   FLAKY: <file>:<line> › <title> — passed on retry N
 *
 * It is diagnostic only: it never fails a job. A missing report file (the run
 * crashed before the reporter wrote it), unparseable JSON, or a report whose
 * shape we don't recognise all print a note and exit 0.
 *
 * Usage: node scripts/report-flaky-e2e.mjs [path/to/results.json]
 */

import { readFileSync } from 'node:fs';

const reportPath = process.argv[2] ?? 'test-results/results.json';

/** Exit without failing the job, explaining why nothing was reported. */
const skip = reason => {
  console.log(`flaky-report: ${reason} (not a failure)`);
  process.exit(0);
};

let raw;
try {
  raw = readFileSync(reportPath, 'utf8');
} catch (err) {
  skip(`could not read ${reportPath}: ${err.message}`);
}

let report;
try {
  report = JSON.parse(raw);
} catch (err) {
  skip(`${reportPath} is not valid JSON: ${err.message}`);
}

if (!report || typeof report !== 'object' || !Array.isArray(report.suites)) {
  skip(`${reportPath} is not a Playwright JSON report (no "suites" array)`);
}

/**
 * A test is flaky when Playwright says so; older/other report shapes may not
 * carry `status`, so fall back to "more than one attempt, last one passed".
 */
const flakyRetryOf = test => {
  const results = Array.isArray(test?.results) ? test.results : [];
  if (results.length < 2) return null;
  const last = results[results.length - 1];
  const passedInTheEnd = test.status === 'flaky' || last?.status === (test.expectedStatus ?? 'passed');
  if (!passedInTheEnd) return null;
  return typeof last?.retry === 'number' ? last.retry : results.length - 1;
};

const flaky = [];
let total = 0;

const walk = (suite, titles) => {
  if (!suite || typeof suite !== 'object') return;
  // The top-level suite of each file is titled with the file path; don't repeat
  // it in the printed title (the file is printed separately).
  const nested = suite.title && suite.title !== suite.file ? [...titles, suite.title] : titles;

  for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
    const where = `${spec?.file ?? suite.file ?? '<unknown file>'}:${spec?.line ?? '?'}`;
    const name = [...nested, spec?.title].filter(Boolean).join(' › ');
    for (const test of Array.isArray(spec?.tests) ? spec.tests : []) {
      total += 1;
      const retry = flakyRetryOf(test);
      if (retry !== null) {
        const project = test.projectName ? ` [${test.projectName}]` : '';
        flaky.push(`FLAKY: ${where} › ${name}${project} — passed on retry ${retry}`);
      }
    }
  }

  for (const child of Array.isArray(suite.suites) ? suite.suites : []) walk(child, nested);
};

for (const suite of report.suites) walk(suite, []);

for (const line of flaky) console.log(line);
console.log(`flaky-report: ${flaky.length} retried-then-passed of ${total} test(s) in ${reportPath}`);

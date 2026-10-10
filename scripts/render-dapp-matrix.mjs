#!/usr/bin/env node
/**
 * The dApp E2E verdict. Renders the cell records (test-results/dapp-cells/*.json, written by
 * playwright/e2e/helpers/dapp-cells.ts) as the job-summary matrix, and with --gate decides the job: it fails on a
 * new failure, a harness fault, a cell that never ran or was blocked by state or infrastructure, a known bug that
 * now passes or no longer shows, a test with no records, a run that left no Playwright report, and an error Playwright
 * reported outside every test. It passes when every failure is a registered known bug, or blocked behind one. Given
 * the Playwright report, the matrix also prints each journey's status and duration against its test timeout, so a
 * journey that ran out of time does not read as a wrong value in its cells.
 *
 *   node scripts/render-dapp-matrix.mjs <records dir> [results.json]
 *   node scripts/render-dapp-matrix.mjs --gate <records dir> <results.json>
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Verdicts that fail the job whatever the registry says. `fail-known` answers to its registry entry and `blocked-needs`
// to the cell it waits on, both checked in judge().
const FAILING = new Set([
  'fail-new',
  'harness-fault',
  'not-run',
  'blocked-state',
  'blocked-infra',
  'known-now-passing'
]);
const TEXT = {
  'fail-new': 'fail (new)',
  'blocked-state': 'blocked (state)',
  'blocked-infra': 'blocked (infrastructure)'
};

export function readJourneys(dir) {
  if (!existsSync(dir)) return [];
  // The runner writes `<record>.json.tmp` and renames it into place, so a worker killed mid-write leaves a .tmp file,
  // never a half-written record.
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')));
}

export function verdictText(cell) {
  if (cell.verdict === 'fail-known') return `fail (${cell.knownBugs.join(', ')})`;
  if (cell.verdict === 'blocked-needs') return `blocked (needs ${cell.needs})`;
  return TEXT[cell.verdict] ?? cell.verdict;
}

// Backslashes first: escaping only the pipe turns a `\|` in an error into an escaped backslash and a column break.
const cellText = text =>
  String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .slice(0, 160);

// The last result is the final attempt. The reporter takes the timeout at test end, so it is the journey's own
// test.setTimeout, not the config's default.
function runLine(spec) {
  const test = spec?.tests?.[0];
  const result = test?.results?.at(-1);
  if (result === undefined) return 'Playwright: no result for this test';
  const seconds = ms => Math.round(ms / 1000);
  return `Playwright: ${result.status} after ${seconds(result.duration)} s of its ${seconds(test.timeout)} s timeout`;
}

/** `results` is the parsed report, null when the named report is absent, undefined when none was named. */
export function renderMatrix(journeys, infra, results) {
  const lines = ['## dApp E2E matrix', ''];
  if (infra) lines.push(`**Infrastructure:** ${cellText(infra)}`, '');
  if (results === null) lines.push('**Playwright:** no results.json, so no journey durations', '');
  const specs = results ? playwrightSpecs(results) : [];
  for (const journey of journeys) {
    lines.push(`### ${journey.testTitle} (${journey.part})`, '');
    if (results) lines.push(runLine(specs.find(spec => spec.title === journey.testTitle)), '');
    lines.push('| Cell | Verdict | Seconds | Detail |', '|---|---|---|---|');
    for (const cell of journey.cells) {
      const detail =
        cell.staleKnownBugs.length > 0 ? `stale registry entry: ${cell.staleKnownBugs.join(', ')}` : cell.error;
      lines.push(`| ${cell.id} | ${verdictText(cell)} | ${Math.round(cell.durationMs / 1000)} | ${cellText(detail)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The tests the run selected. A spec's title is the test's own title without any describe path, as the `testInfo.title`
 * the runner records is, and `--grep` leaves the other axis's journeys out of the report altogether.
 */
function playwrightSpecs(results) {
  const specs = [];
  const walk = suite => {
    for (const spec of suite.specs ?? []) specs.push(spec);
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of results.suites ?? []) walk(suite);
  return specs;
}

export function playwrightTests(results) {
  return playwrightSpecs(results).map(spec => spec.title);
}

const firstLine = text => String(text).split('\n')[0].slice(0, 300);

export function judge(journeys, results, infra) {
  const problems = [];
  if (infra) problems.push(`infrastructure: ${infra}`);
  if (results === null) problems.push('no Playwright results.json: the run step timed out or crashed before reporting');
  // A spec that fails to load, a --grep that selects no test or a global setup that throws stops the run before any
  // test, and Playwright reports it here alone, with no suites: without this, such a run would judge clean.
  for (const error of results?.errors ?? []) {
    problems.push(`Playwright: ${firstLine(error.message ?? error.value ?? 'an error with no message')}`);
  }
  const recorded = new Set(journeys.map(journey => journey.testTitle));
  for (const title of results === null ? [] : playwrightTests(results)) {
    if (!recorded.has(title)) problems.push(`no cell records for "${title}"`);
  }
  for (const journey of journeys) {
    const byId = new Map(journey.cells.map(cell => [cell.id, cell]));
    for (const cell of journey.cells) {
      const where = `${journey.testTitle} ${cell.id}`;
      if (FAILING.has(cell.verdict))
        problems.push(`${where}: ${verdictText(cell)}${cell.error ? `: ${cell.error.slice(0, 300)}` : ''}`);
      if (cell.verdict !== 'known-now-passing' && cell.staleKnownBugs.length > 0) {
        problems.push(`${where}: registry lists ${cell.staleKnownBugs.join(', ')} but the cell no longer shows it`);
      }
      // One hop: a cell blocked behind a blocked cell reads as not a known bug, so a chain is red, never a false green.
      if (cell.verdict === 'blocked-needs' && byId.get(cell.needs)?.verdict !== 'fail-known') {
        problems.push(`${where}: blocked behind ${cell.needs}, which is not a known bug`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const gating = args[0] === '--gate';
  const dir = gating ? args[1] : args[0];
  if (!dir) {
    console.error('usage: render-dapp-matrix.mjs [--gate] <records dir> [results.json]');
    process.exit(2);
  }
  const infraFile = join(dir, 'INFRA_ABORT');
  const infra = existsSync(infraFile) ? readFileSync(infraFile, 'utf8').trim() : null;
  const journeys = readJourneys(dir);
  const readResults = file => (file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
  if (!gating) {
    process.stdout.write(
      `${renderMatrix(journeys, infra, args[1] === undefined ? undefined : readResults(args[1]))}\n`
    );
    process.exit(0);
  }
  const results = readResults(args[2]);
  const verdict = judge(journeys, results, infra);
  for (const problem of verdict.problems) console.error(problem);
  console.log(
    verdict.ok
      ? 'dApp E2E judge: every failure is a registered known bug'
      : `dApp E2E judge: ${verdict.problems.length} problem(s)`
  );
  process.exit(verdict.ok ? 0 : 1);
}

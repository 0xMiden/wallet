#!/usr/bin/env node
/**
 * Harness-convention gate for the Playwright E2E suites.
 *
 * Runs the AST rules in playwright/e2e/eslint-rules over playwright/**, which
 * reject assertion shapes that cannot fail:
 *   - toBeGreaterThan(0) / waitForBalanceAbove(0, …)  — balance checks with no threshold
 *   - waitForTimeout(> 2000)                          — a sleep standing in for a condition
 *   - expect() inside an if/else branch               — passes when the branch is skipped
 *
 * The suite has pre-existing instances of all three. Failing on them today would
 * only mean the gate gets disabled, so this runs as a RATCHET: the counts already
 * in the tree are recorded per file and per rule in known-violations.json, and the
 * gate fails only when a count goes UP or a new file appears. Existing debt is
 * visible, new debt is blocked.
 *
 *   node scripts/lint-e2e-harness.mjs            # check (what CI runs)
 *   node scripts/lint-e2e-harness.mjs --update   # rewrite the baseline after fixing sites
 */
import { ESLint } from 'eslint';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = resolve(repoRoot, 'playwright/e2e/eslint-rules/known-violations.json');
const TARGET = 'playwright';

const update = process.argv.includes('--update');

const eslint = new ESLint({
  cwd: repoRoot,
  useEslintrc: false,
  overrideConfigFile: resolve(repoRoot, '.eslintrc.harness.json'),
  rulePaths: [resolve(repoRoot, 'playwright/e2e/eslint-rules')],
  extensions: ['.ts']
});

/**
 * A gate that stopped firing would pass every PR forever and nobody would notice —
 * the exact failure mode this whole check exists to prevent. So before trusting a
 * clean run, prove each rule still fires on a known-bad sample, and prove none of
 * them fires on the same patterns written in a comment (the helpers document these
 * shapes to explain the ban; a grep-based gate flags its own documentation).
 */
const SELF_TEST_SOURCE = `
/**
 * expect(balance).toBeGreaterThan(0) and waitForBalanceAbove(0, 5) are banned.
 * So is page.waitForTimeout(30_000).
 */
async function sample(page, wallet, balance, visible) {
  await wallet.waitForBalanceAbove(0, 120_000);   // no-unfalsifiable-balance-assertion
  expect(balance).toBeGreaterThan(0);             // no-unfalsifiable-balance-assertion
  await page.waitForTimeout(30_000);              // no-long-bare-wait
  if (visible) {
    expect(balance).toBe(5);                      // no-conditional-expect
  }

  // Shapes that must NOT be flagged:
  expect(balance).toBeGreaterThan(1);
  await wallet.waitForBalanceAbove(1n, 120_000);
  await page.waitForTimeout(2_000);
  expect(visible).toBe(true);
}
`;

const EXPECTED_SELF_TEST_HITS = {
  'no-unfalsifiable-balance-assertion': 2,
  'no-long-bare-wait': 1,
  'no-conditional-expect': 1
};

const selfTest = await eslint.lintText(SELF_TEST_SOURCE, {
  filePath: resolve(repoRoot, 'playwright/e2e/__self-test__.ts')
});
const selfTestHits = {};
for (const message of selfTest[0]?.messages ?? []) {
  selfTestHits[message.ruleId ?? 'unknown'] = (selfTestHits[message.ruleId ?? 'unknown'] ?? 0) + 1;
}
if (JSON.stringify(selfTestHits) !== JSON.stringify(EXPECTED_SELF_TEST_HITS)) {
  console.error('The harness rules no longer detect their own known-bad sample — the gate is broken, not clean.');
  console.error(`  expected ${JSON.stringify(EXPECTED_SELF_TEST_HITS)}`);
  console.error(`  actual   ${JSON.stringify(selfTestHits)}`);
  process.exit(1);
}

const results = await eslint.lintFiles([TARGET]);

/** { [relativeFile]: { [ruleId]: { count, lines } } } */
const actual = {};
for (const result of results) {
  if (result.messages.length === 0) continue;
  const file = relative(repoRoot, result.filePath);
  for (const message of result.messages) {
    // A missing rule definition (e.g. an inline disable naming an unloaded plugin
    // rule) has no ruleId and would otherwise be silently dropped.
    if (!message.ruleId) {
      console.error(`${file}:${message.line}  ${message.message}`);
      process.exitCode = 1;
      continue;
    }
    const perRule = (actual[file] ??= {});
    const entry = (perRule[message.ruleId] ??= { count: 0, lines: [] });
    entry.count += 1;
    entry.lines.push(message.line);
  }
}

if (update) {
  const counts = {};
  for (const file of Object.keys(actual).sort()) {
    counts[file] = Object.fromEntries(
      Object.keys(actual[file])
        .sort()
        .map(rule => [rule, actual[file][rule].count])
    );
  }
  const previous = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ ...previous, counts }, null, 2)}\n`);
  console.log(`Baseline rewritten: ${relative(repoRoot, BASELINE_PATH)}`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const allowed = baseline.counts ?? {};

const regressions = [];
const improvements = [];

for (const [file, perRule] of Object.entries(actual)) {
  for (const [rule, { count, lines }] of Object.entries(perRule)) {
    const budget = allowed[file]?.[rule] ?? 0;
    if (count > budget) regressions.push({ file, rule, count, budget, lines });
  }
}
for (const [file, perRule] of Object.entries(allowed)) {
  for (const [rule, budget] of Object.entries(perRule)) {
    const count = actual[file]?.[rule]?.count ?? 0;
    if (count < budget) improvements.push({ file, rule, count, budget });
  }
}

if (improvements.length > 0) {
  console.log('Baseline is stale — these are now cleaner than known-violations.json records:');
  for (const { file, rule, count, budget } of improvements) {
    console.log(`  ${file}  ${rule}: ${budget} -> ${count}`);
  }
  console.log('  Refresh it with: node scripts/lint-e2e-harness.mjs --update\n');
}

if (regressions.length > 0) {
  console.error('E2E harness conventions violated by new code:\n');
  let lastFile = null;
  for (const { file, rule, count, budget, lines } of regressions) {
    if (file !== lastFile) console.error(`  ${file}`);
    lastFile = file;
    console.error(`    ${rule}: ${count} occurrences, ${budget} allowed (lines ${lines.join(', ')})`);
  }
  console.error(
    '\nThese assertion shapes pass whether or not the behaviour under test works.\n' +
      'Read playwright/e2e/eslint-rules/*.js for what to write instead. If a site is\n' +
      'genuinely unavoidable, add an eslint-disable-next-line with a reason — do not\n' +
      'raise the baseline for new code.'
  );
  process.exit(1);
}

const total = Object.values(allowed).reduce(
  (sum, perRule) => sum + Object.values(perRule).reduce((a, b) => a + b, 0),
  0
);
console.log(`E2E harness conventions OK — no new violations (${total} known, see known-violations.json).`);

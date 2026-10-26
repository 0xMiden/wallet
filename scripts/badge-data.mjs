#!/usr/bin/env node
/**
 * The numbers behind the README coverage and tests badges.
 *
 *   count  <jest-results.json> <out>          a shard's Jest results reduced to {"numTotalTests"}
 *   record <shard-count> <coverage-summary.json> <shards-dir> <out>
 *                                             merged line % and the summed count, as {"lines", "tests"}
 *   read   <badge-data.json>                  prints `pct=<one decimal>` and `count=<integer>`
 *
 * pr.yml produces the file and the main-branch Badges workflow consumes it from
 * a pull request's artifact, so `read` treats it as untrusted: it prints only
 * fixed-format numbers, and anything else exits 1 with nothing on stdout.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function fail(message) {
  console.error(`badge-data: ${message}`);
  process.exit(1);
}

function readJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    fail(`cannot read ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`${path} is not valid JSON`);
  }
}

function testCount(value, what) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${what} must be a non-negative integer`);
  return value;
}

function linePct(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    fail('lines must be a number in [0, 100]');
  }
  return value;
}

function count(resultsPath, outPath) {
  const numTotalTests = testCount(readJson(resultsPath)?.numTotalTests, `numTotalTests in ${resultsPath}`);
  writeFileSync(outPath, JSON.stringify({ numTotalTests }));
}

function record(expected, summaryPath, shardsDir, outPath) {
  const want = Number(expected);
  if (!Number.isSafeInteger(want) || want < 1) fail(`shard count must be a positive integer, got ${expected}`);
  const files = readdirSync(shardsDir)
    .filter(name => /^coverage-shard-\d+$/.test(name))
    .map(name => join(shardsDir, name, 'test-count.json'))
    .filter(file => existsSync(file));
  if (files.length !== want) fail(`expected ${want} shard test counts in ${shardsDir}, found ${files.length}`);
  const tests = files.reduce(
    (sum, file) => sum + testCount(readJson(file)?.numTotalTests, `numTotalTests in ${file}`),
    0
  );
  const lines = linePct(readJson(summaryPath)?.total?.lines?.pct);
  writeFileSync(outPath, JSON.stringify({ lines, tests: testCount(tests, 'tests') }));
  console.log(`badge data: lines ${lines}%, tests ${tests}`);
}

function read(path) {
  const data = readJson(path);
  const pct = linePct(data?.lines).toFixed(1);
  const tests = testCount(data?.tests, 'tests');
  process.stdout.write(`pct=${pct}\ncount=${tests}\n`);
}

const [command, ...args] = process.argv.slice(2);
const commands = { count: [count, 2], record: [record, 4], read: [read, 1] };
const entry = commands[command];
if (!entry || args.length !== entry[1]) {
  console.error('usage: badge-data.mjs count <jest-results.json> <out>');
  console.error('       badge-data.mjs record <shard-count> <coverage-summary.json> <shards-dir> <out>');
  console.error('       badge-data.mjs read <badge-data.json>');
  process.exit(2);
}
entry[0](...args);

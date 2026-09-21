#!/usr/bin/env node
/**
 * Merge Jest v8 coverage-final.json shards and enforce the same 95% global
 * gate jest.config.ts uses for an unsharded `yarn test:coverage`.
 *
 * Each shard runs with JEST_COVERAGE_SHARD set so it does not apply the
 * threshold to a partial map. This script is the gate.
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createCoverageMap } = require('istanbul-lib-coverage');
const libReport = require('istanbul-lib-report');
const reports = require('istanbul-reports');

const THRESHOLD = { branches: 95, functions: 95, lines: 95, statements: 95 };

const files = process.argv.slice(2);
if (files.length < 2) {
  console.error('usage: merge-jest-coverage.mjs <coverage-final.json> <coverage-final.json>...');
  process.exit(2);
}

const map = createCoverageMap({});
for (const file of files) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  map.merge(raw);
}

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../coverage');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'coverage-final.json'), JSON.stringify(map));

const context = libReport.createContext({ dir: outDir, coverageMap: map });
reports.create('json-summary').execute(context);
reports.create('text-summary').execute(context);

const summary = JSON.parse(readFileSync(resolve(outDir, 'coverage-summary.json'), 'utf8'));
const total = summary.total;
let failed = false;
for (const [metric, min] of Object.entries(THRESHOLD)) {
  const pct = total[metric]?.pct;
  if (typeof pct !== 'number' || Number.isNaN(pct)) {
    console.error(`${metric}: missing pct in coverage-summary.json`);
    failed = true;
    continue;
  }
  const ok = pct >= min;
  console.log(`${metric}: ${pct}% (min ${min})${ok ? '' : ' FAIL'}`);
  if (!ok) failed = true;
}

if (failed) {
  console.error('coverage gate failed');
  process.exit(1);
}
console.log('coverage gate ok');

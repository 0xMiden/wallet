#!/usr/bin/env node
/**
 * Joins the two UI smoothness summaries into the artifact the comment reads.
 * The comment recomputes the median from these samples and ignores every
 * other field.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [basePath, headPath, outPath] = process.argv.slice(2);
if (!basePath || !headPath || !outPath) {
  process.stderr.write('usage: node ui-smoothness-artifact.mjs <base.json> <head.json> <out.json>\n');
  process.exit(2);
}

function series(path, key) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed[key])) throw new Error(`${path} has no ${key}`);
  return parsed[key];
}

const feel = 'samples';
writeFileSync(
  outPath,
  JSON.stringify({
    feel: { base: series(basePath, feel), head: series(headPath, feel) },
    inp: { base: series(basePath, 'inp'), head: series(headPath, 'inp') },
    listDropped: { base: series(basePath, 'listDropped'), head: series(headPath, 'listDropped') },
    listP95: { base: series(basePath, 'listP95'), head: series(headPath, 'listP95') }
  })
);

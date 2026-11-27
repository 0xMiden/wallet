#!/usr/bin/env node
/**
 * Joins the two UI smoothness summaries into the artifact the comment reads.
 * The comment recomputes the median from these samples and ignores every
 * other field.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function series(parsed, path, key) {
  if (!Array.isArray(parsed[key])) throw new Error(`${path} has no ${key}`);
  return parsed[key];
}

export function joinSummaries(base, head, basePath = 'base', headPath = 'head') {
  const pair = key => ({ base: series(base, basePath, key), head: series(head, headPath, key) });
  return { feel: pair('samples'), inp: pair('inp'), listDropped: pair('listDropped'), listP95: pair('listP95') };
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entry) {
  const [basePath, headPath, outPath] = process.argv.slice(2);
  if (!basePath || !headPath || !outPath) {
    process.stderr.write('usage: node ui-smoothness-artifact.mjs <base.json> <head.json> <out.json>\n');
    process.exit(2);
  }
  const read = path => JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(outPath, JSON.stringify(joinSummaries(read(basePath), read(headPath), basePath, headPath)));
}

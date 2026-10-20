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

function samples(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed.samples)) {
    throw new Error(`${path} has no samples`);
  }
  return parsed.samples;
}

writeFileSync(outPath, JSON.stringify({ base: samples(basePath), head: samples(headPath) }));

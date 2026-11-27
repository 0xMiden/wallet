#!/usr/bin/env node
/**
 * Joins the two UI smoothness summaries into the artifact the comment reads.
 * The comment recomputes the medians from these samples and ignores every
 * other field.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TAP_KEYS = ['tapFeel', 'tapFirstFrame', 'tapSettle', 'tapDropped', 'tabInp'];

function series(parsed, path, key) {
  if (!Array.isArray(parsed[key])) throw new Error(`${path} has no ${key}`);
  return parsed[key];
}

/** A side whose Home panes have no swipe reports null samples, and must say how that was verified. */
function feel(parsed, path) {
  if (parsed.samples === null) {
    if (typeof parsed.swipeRemoved !== 'string' || !parsed.swipeRemoved.startsWith('verified: ')) {
      throw new Error(`${path} has no swipe samples and no verified reason`);
    }
    return null;
  }
  return series(parsed, path, 'samples');
}

export function joinSummaries(base, head, basePath = 'base', headPath = 'head') {
  const pair = key => ({ base: series(base, basePath, key), head: series(head, headPath, key) });
  const artifact = {
    feel: { base: feel(base, basePath), head: feel(head, headPath) },
    swipeRemoved: {
      base: base.samples === null ? base.swipeRemoved : null,
      head: head.samples === null ? head.swipeRemoved : null
    },
    inp: pair('inp'),
    listDropped: pair('listDropped'),
    listP95: pair('listP95')
  };
  for (const key of TAP_KEYS) artifact[key] = pair(key);
  artifact.tapTotals = { base: base.tapTotals, head: head.tapTotals };
  return artifact;
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

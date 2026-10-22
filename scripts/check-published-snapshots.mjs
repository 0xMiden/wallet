#!/usr/bin/env node
/**
 * Compares every document the wallet bundles as a first-run snapshot with the copy its repository
 * publishes, byte for byte, and exits 1 on any difference or on a copy it cannot fetch. A release
 * whose snapshot has drifted shows a device that has never fetched a catalog or token list the one
 * the repository has since replaced.
 *
 *   node scripts/check-published-snapshots.mjs   (yarn check:published-snapshots)
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Each snapshot directory, and the base its repository publishes the same file names under. */
export const SNAPSHOT_SOURCES = [
  { dir: 'src/lib/token-list/snapshot', base: 'https://raw.githubusercontent.com/0xMiden/token-list/main' },
  { dir: 'src/lib/explore-config/snapshot', base: 'https://raw.githubusercontent.com/0xMiden/wallet-explore/main' }
];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every bundled snapshot with the URL of its published copy. */
export function snapshotPairs(root = REPO_ROOT, sources = SNAPSHOT_SOURCES) {
  return sources.flatMap(({ dir, base }) =>
    readdirSync(path.join(root, dir))
      .filter(name => name.endsWith('.json'))
      .sort()
      .map(name => ({ file: `${dir}/${name}`, url: `${base}/${name}` }))
  );
}

/** One line per snapshot, and whether every one matched its published copy. */
export async function checkPublishedSnapshots({
  root = REPO_ROOT,
  sources = SNAPSHOT_SOURCES,
  fetchImpl = fetch
} = {}) {
  const lines = [];
  let ok = true;
  for (const { file, url } of snapshotPairs(root, sources)) {
    let published;
    try {
      const response = await fetchImpl(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      published = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      ok = false;
      lines.push(`✗ ${file}: could not fetch ${url} (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (published.equals(readFileSync(path.join(root, file)))) {
      lines.push(`✓ ${file} matches ${url}`);
    } else {
      ok = false;
      lines.push(`✗ ${file} differs from ${url}; copy the published file over it`);
    }
  }
  return { ok, lines };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  checkPublishedSnapshots().then(
    ({ ok, lines }) => {
      for (const line of lines) console.log(line);
      process.exitCode = ok ? 0 : 1;
    },
    error => {
      console.error(error);
      process.exitCode = 1;
    }
  );
}

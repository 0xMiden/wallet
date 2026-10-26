#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateUpdateManifest } from '../src/lib/update/manifest-runtime.mjs';

/**
 * Check the shape of the presentation catalog. Availability comes from each
 * platform's own store, so a release never depends on an entry existing here:
 * a missing or unreadable catalog only means the card shows generic copy.
 */
export async function validateManifestFile(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const manifest = validateUpdateManifest(JSON.parse(raw));
  return { releaseCount: manifest.releases.length };
}

function parseArguments(args) {
  let filePath = 'updates/manifest.json';
  for (const argument of args) {
    if (argument.startsWith('--')) throw new Error(`Unknown option ${argument}`);
    filePath = argument;
  }
  return { filePath };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const main = async () => {
    const { filePath } = parseArguments(process.argv.slice(2));
    const result = await validateManifestFile(path.resolve(filePath));
    process.stdout.write(`Validated ${result.releaseCount} update manifest release(s).\n`);
  };
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

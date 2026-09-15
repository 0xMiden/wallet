#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateUpdateManifest } from '../src/lib/update/manifest-runtime.mjs';

export async function validateManifestFile(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const manifest = validateUpdateManifest(JSON.parse(raw));
  return { releaseCount: manifest.releases.length };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const main = async () => {
    const manifestPath = path.resolve(process.argv[2] ?? 'updates/manifest.json');
    const result = await validateManifestFile(manifestPath);
    process.stdout.write(`Validated ${result.releaseCount} update manifest release(s).\n`);
  };
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

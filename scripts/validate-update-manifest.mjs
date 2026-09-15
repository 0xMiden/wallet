#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateUpdateManifest } from '../src/lib/update/manifest-runtime.mjs';

const PLATFORMS = new Set(['chrome', 'android', 'ios', 'desktop']);

export async function validateManifestFile(filePath, options = {}) {
  const raw = await readFile(filePath, 'utf8');
  const manifest = validateUpdateManifest(JSON.parse(raw));
  const platforms = options.platforms ?? [];
  const forbiddenPlatforms = options.forbiddenPlatforms ?? [];
  const needsRelease = platforms.length > 0 || options.androidVersionCode !== undefined;
  const release = options.version
    ? manifest.releases.find(candidate => candidate.version === options.version)
    : undefined;

  if (needsRelease && !options.version) throw new Error('Release validation requires a version');
  if (needsRelease && !release) throw new Error(`No update manifest release for ${options.version}`);
  for (const platform of [...platforms, ...forbiddenPlatforms]) {
    if (!PLATFORMS.has(platform)) throw new Error(`Unknown update platform ${platform}`);
  }
  for (const platform of platforms) {
    if (!release.platforms[platform]) throw new Error(`Release ${options.version} does not declare ${platform}`);
  }
  for (const platform of forbiddenPlatforms) {
    if (release?.platforms[platform]) {
      throw new Error(`Release ${options.version} must not declare unsupported ${platform}`);
    }
  }
  if (options.androidVersionCode !== undefined) {
    const actual = release.platforms.android?.versionCode;
    if (actual !== options.androidVersionCode) {
      throw new Error(`Android version code ${actual ?? 'missing'} does not match ${options.androidVersionCode}`);
    }
  }
  return { releaseCount: manifest.releases.length };
}

function parseArguments(args) {
  let filePath = 'updates/manifest.json';
  let version;
  let androidVersionCode;
  const platforms = [];
  const forbiddenPlatforms = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--version') version = args[++index];
    else if (argument === '--platform') platforms.push(args[++index]);
    else if (argument === '--forbid-platform') forbiddenPlatforms.push(args[++index]);
    else if (argument === '--android-version-code') androidVersionCode = Number(args[++index]);
    else if (argument?.startsWith('--')) throw new Error(`Unknown option ${argument}`);
    else filePath = argument;
  }
  if (androidVersionCode !== undefined && !Number.isSafeInteger(androidVersionCode)) {
    throw new Error('Android version code must be an integer');
  }
  return { filePath, options: { version, platforms, forbiddenPlatforms, androidVersionCode } };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const main = async () => {
    const { filePath, options } = parseArguments(process.argv.slice(2));
    const result = await validateManifestFile(path.resolve(filePath), options);
    process.stdout.write(`Validated ${result.releaseCount} update manifest release(s).\n`);
  };
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

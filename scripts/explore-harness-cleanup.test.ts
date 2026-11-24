/**
 * @jest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { closeExploreHarness } from './explore-harness-cleanup.mjs';

const profileWithNestedFile = (): string => {
  const profile = mkdtempSync(path.join(tmpdir(), 'explore-harness-cleanup-'));
  mkdirSync(path.join(profile, 'Default'));
  writeFileSync(path.join(profile, 'Default', 'Preferences'), 'stay');
  return profile;
};

const nestedFile = (profile: string): string => path.join(profile, 'Default', 'Preferences');

it('removes the profile after a clean close', async () => {
  const profile = profileWithNestedFile();
  try {
    const context = {
      close: jest.fn(async () => {
        expect(existsSync(nestedFile(profile))).toBe(true);
      })
    };
    await closeExploreHarness(context, profile);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(existsSync(profile)).toBe(false);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

it('removes the profile when close rejects', async () => {
  const profile = profileWithNestedFile();
  try {
    const failure = new Error('close failed');
    const context = {
      close: jest.fn(async () => {
        expect(existsSync(nestedFile(profile))).toBe(true);
        throw failure;
      })
    };
    await expect(closeExploreHarness(context, profile)).rejects.toBe(failure);
    expect(existsSync(profile)).toBe(false);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

it('resolves without touching the filesystem when profile and context are undefined', async () => {
  const profile = profileWithNestedFile();
  try {
    await expect(closeExploreHarness(undefined, undefined)).resolves.toBeUndefined();
    expect(existsSync(nestedFile(profile))).toBe(true);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

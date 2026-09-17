import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { validateManifestFile } from './validate-update-manifest.mjs';

describe('validate-update-manifest', () => {
  it('validates the checked-in catalog', async () => {
    // Not pinned to a release count: entries are appended over time, and this
    // case guards the shape clients read, not how many releases it lists.
    const manifestPath = path.resolve(process.cwd(), 'updates/manifest.json');

    await expect(validateManifestFile(manifestPath)).resolves.toEqual({ releaseCount: expect.any(Number) });
  });

  it('accepts a catalog whose entries name the platforms they cover', async () => {
    const manifestPath = await writeManifest({
      schemaVersion: 1,
      releases: [
        {
          version: '1.17.0',
          summary: 'Fixes and improvements.',
          urgency: 'normal',
          platforms: ['chrome', 'android', 'ios']
        }
      ]
    });

    await expect(validateManifestFile(manifestPath)).resolves.toEqual({ releaseCount: 1 });
  });

  it('refuses a catalog that would reach clients in a shape they cannot read', async () => {
    const outOfOrder = await writeManifest({
      schemaVersion: 1,
      releases: [
        { version: '1.18.0', summary: 'Later release.', urgency: 'normal', platforms: ['chrome'] },
        { version: '1.17.0', summary: 'Earlier release.', urgency: 'normal', platforms: ['chrome'] }
      ]
    });
    const unsupported = await writeManifest({
      schemaVersion: 1,
      releases: [{ version: '1.17.0', summary: 'Desktop claim.', urgency: 'normal', platforms: ['desktop'] }]
    });

    await expect(validateManifestFile(outOfOrder)).rejects.toThrow('ascending');
    await expect(validateManifestFile(unsupported)).rejects.toThrow('platform');
  });
});

async function writeManifest(value: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'update-manifest-'));
  const manifestPath = path.join(directory, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(value));
  return manifestPath;
}

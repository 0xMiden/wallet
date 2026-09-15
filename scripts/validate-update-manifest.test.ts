import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { validateManifestFile } from './validate-update-manifest.mjs';

describe('validate-update-manifest', () => {
  it('validates the checked-in catalog', async () => {
    const manifestPath = path.resolve(process.cwd(), 'updates/manifest.json');

    await expect(validateManifestFile(manifestPath)).resolves.toEqual({ releaseCount: 0 });
  });

  it('requires an exact release entry for every claimed supported platform', async () => {
    const manifestPath = await writeManifest({
      schemaVersion: 1,
      releases: [
        {
          version: '1.17.0',
          summary: 'Fixes and improvements.',
          urgency: 'normal',
          platforms: {
            chrome: { version: '1.17.0' },
            android: { version: '1.17.0', versionCode: 11700001 },
            ios: { version: '1.17.0' }
          }
        }
      ]
    });

    await expect(
      validateManifestFile(manifestPath, {
        version: '1.17.0',
        platforms: ['chrome', 'android', 'ios'],
        androidVersionCode: 11700001
      })
    ).resolves.toEqual({ releaseCount: 1 });
    await expect(validateManifestFile(manifestPath, { version: '1.18.0', platforms: ['chrome'] })).rejects.toThrow(
      'No update manifest release for 1.18.0'
    );
    await expect(validateManifestFile(manifestPath, { version: '1.17.0', platforms: ['desktop'] })).rejects.toThrow(
      'Release 1.17.0 does not declare desktop'
    );
  });

  it('checks the exact monotonic Android version code', async () => {
    const manifestPath = await writeManifest({
      schemaVersion: 1,
      releases: [
        {
          version: '1.17.0',
          summary: 'Fixes and improvements.',
          urgency: 'normal',
          platforms: { android: { version: '1.17.0', versionCode: 11700001 } }
        }
      ]
    });

    await expect(
      validateManifestFile(manifestPath, {
        version: '1.17.0',
        platforms: ['android'],
        androidVersionCode: 11700002
      })
    ).rejects.toThrow('Android version code 11700001 does not match 11700002');
  });

  it('can forbid unsupported desktop metadata even when other platforms are present', async () => {
    const manifestPath = await writeManifest({
      schemaVersion: 1,
      releases: [
        {
          version: '1.17.0',
          summary: 'Fixes and improvements.',
          urgency: 'normal',
          platforms: {
            chrome: { version: '1.17.0' },
            desktop: { version: '1.17.0' }
          }
        }
      ]
    });

    await expect(
      validateManifestFile(manifestPath, { version: '1.17.0', forbiddenPlatforms: ['desktop'] })
    ).rejects.toThrow('Release 1.17.0 must not declare unsupported desktop');
  });
});

async function writeManifest(value: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'update-manifest-'));
  const manifestPath = path.join(directory, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(value));
  return manifestPath;
}

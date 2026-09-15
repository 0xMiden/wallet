import path from 'node:path';

import { validateManifestFile } from './validate-update-manifest.mjs';

describe('validate-update-manifest', () => {
  it('validates the checked-in catalog', async () => {
    const manifestPath = path.resolve(process.cwd(), 'updates/manifest.json');

    await expect(validateManifestFile(manifestPath)).resolves.toEqual({ releaseCount: 0 });
  });
});

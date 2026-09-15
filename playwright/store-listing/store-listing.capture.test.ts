import { readFileSync } from 'node:fs';
import path from 'node:path';

import { capturePlan, validateCapturePlan } from './store-listing.capture';

type ManifestAsset = {
  kind: string;
  raw: string;
};

type SceneManifest = {
  platforms: Record<string, ManifestAsset[]>;
};

const repositoryRoot = path.resolve(__dirname, '../..');
const scenes = JSON.parse(
  readFileSync(path.join(repositoryRoot, 'store-listing/scenes.json'), 'utf8')
) as SceneManifest;

const expectedRuntime = {
  appStore: {
    platformFlag: 'ios',
    viewport: { width: 440, height: 956 },
    deviceScaleFactor: 3,
    raw: { width: 1320, height: 2868 }
  },
  playStore: {
    platformFlag: 'android',
    viewport: { width: 360, height: 640 },
    deviceScaleFactor: 3,
    raw: { width: 1080, height: 1920 }
  },
  chromeWebStore: {
    platformFlag: 'chrome',
    viewport: { width: 400, height: 600 },
    deviceScaleFactor: 1,
    raw: { width: 400, height: 600 }
  }
} as const;

describe('store listing capture plan', () => {
  it('covers every unique non-icon raw product capture in the scene manifest', () => {
    const manifestPaths = new Set(
      Object.values(scenes.platforms)
        .flat()
        .filter(asset => asset.kind !== 'icon')
        .map(asset => asset.raw)
    );
    const plannedPaths = capturePlan.map(entry => entry.outputPath);

    expect(new Set(plannedPaths)).toEqual(manifestPaths);
    expect(plannedPaths).toHaveLength(manifestPaths.size);
  });

  it.each(Object.entries(expectedRuntime))(
    '%s captures the actual platform branch at the exact raw dimensions',
    (platform, expected) => {
      const entries = capturePlan.filter(entry => entry.platform === platform);
      expect(entries.length).toBeGreaterThan(0);

      for (const entry of entries) {
        expect(entry.platformFlag).toBe(expected.platformFlag);
        expect(entry.viewport).toEqual(expected.viewport);
        expect(entry.deviceScaleFactor).toBe(expected.deviceScaleFactor);
        expect({
          width: entry.viewport.width * entry.deviceScaleFactor,
          height: entry.viewport.height * entry.deviceScaleFactor
        }).toEqual(expected.raw);
      }
    }
  );

  it('defines a deterministic fixture state and observable ready condition for every capture', () => {
    for (const entry of capturePlan) {
      expect(entry.fixtureState).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(entry.ready.testId).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(entry.ready.hiddenTestIds).toContain('alert');
      expect(entry.outputPath).toMatch(/^store-listing\/raw\/(app-store|play-store|chrome-web-store)\/.+\.png$/);
    }
  });

  it('keeps capture metadata free of credentials, key material, and personal fixture data', () => {
    const serialized = JSON.stringify(capturePlan);

    expect(serialized).not.toMatch(/mnemonic|seed phrase|private key|password|personal|mainnet/i);
    expect(serialized).toContain('testnet');
    expect(serialized).toContain('deterministic-fixture');
  });

  it('rejects duplicate outputs and incomplete ready conditions', () => {
    const duplicate = [...capturePlan, { ...capturePlan[0]! }];
    expect(() => validateCapturePlan(duplicate)).toThrow(/duplicate capture output/i);

    const missingReady = capturePlan.map((entry, index) =>
      index === 0 ? { ...entry, ready: { ...entry.ready, testId: '' } } : entry
    );
    expect(() => validateCapturePlan(missingReady)).toThrow(/ready test id/i);
  });

  it('rejects platform flags or dimensions that would resize another platform', () => {
    const wrongPlatform = capturePlan.map((entry, index) =>
      index === 0 ? { ...entry, platformFlag: 'android' as const } : entry
    );
    expect(() => validateCapturePlan(wrongPlatform)).toThrow(/platform flag/i);

    const wrongViewport = capturePlan.map((entry, index) =>
      index === 0 ? { ...entry, viewport: { ...entry.viewport, width: entry.viewport.width - 1 } } : entry
    );
    expect(() => validateCapturePlan(wrongViewport)).toThrow(/capture dimensions/i);
  });
});

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';

type Asset = {
  id: string;
  kind: 'screenshot' | 'featureGraphic' | 'icon' | 'smallPromo' | 'marquee';
  sceneId: string;
  shared: boolean;
  order?: number;
  raw: string;
  crop: { x: number; y: number; width: number; height: number };
  surface: string;
  headline: string;
  alt: string;
  width: number;
  height: number;
  output: string;
};

type SceneManifest = {
  schemaVersion: number;
  platforms: Record<'appStore' | 'playStore' | 'chromeWebStore', Asset[]>;
};

type StoreRules = {
  checkedAt: string;
  maxAgeDays: number;
  sharedSceneOrder: string[];
  platforms: Record<string, Record<string, unknown>>;
};

/*
 * The fixture uses scaled-down dimensions to keep validation tests fast. The
 * rules carry the dimensions, so the same validator path handles the full
 * publication sizes in the canonical manifest. Each test invokes the CLI and
 * mutates one production constraint, making the expected failure diagnostic
 * part of the contract rather than testing private helper functions.
 *
 * Valid fixtures include every output kind so later negative tests change one
 * invariant at a time. If the baseline omitted a promo or reused an output,
 * failures could be attributed to the wrong rule and give false confidence.
 * Raw captures are deliberately larger than their declared crops; this makes
 * bounds validation real without allocating publication-sized images.
 */
const repositoryRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repositoryRoot, 'scripts/store-listing/validate.mjs');
const schemaPath = path.join(repositoryRoot, 'store-listing/schema/scenes.schema.json');
const canonicalCopyPath = path.join(repositoryRoot, 'store-listing/listing-copy.json');
const temporaryDirectories: string[] = [];

const sharedSceneOrder = ['wallet-keys', 'send-privacy', 'receive', 'guardian'];
const platformDefinitions = {
  appStore: { slug: 'app-store', width: 132, height: 286, surface: 'iphone', extra: 'ios-dapp-browser' },
  playStore: { slug: 'play-store', width: 108, height: 192, surface: 'android', extra: 'android-dapp-browser' },
  chromeWebStore: {
    slug: 'chrome-web-store',
    width: 128,
    height: 80,
    surface: 'chrome-side-panel',
    extra: 'chrome-connect'
  }
} as const;

function copyText(platformKey: keyof typeof platformDefinitions, sceneId: string) {
  const slug = platformDefinitions[platformKey].slug;
  const copy = JSON.parse(
    readFileSync(path.join(repositoryRoot, `store-listing/generated/${slug}/copy.json`), 'utf8')
  ) as {
    screenshots: Array<{ id: string; headline: string; alt: string }>;
    promotionalArtwork: Array<{ id: string; headline: string; alt: string }>;
  };
  return [...copy.screenshots, ...copy.promotionalArtwork].find(item => item.id === sceneId);
}

function screenshotAssets(platformKey: keyof typeof platformDefinitions): Asset[] {
  const definition = platformDefinitions[platformKey];
  return [...sharedSceneOrder, definition.extra].map((sceneId, index) => {
    const text = copyText(platformKey, sceneId);
    if (!text) throw new Error(`Missing canonical copy for ${platformKey} scene ${sceneId}`);
    return {
      id: `${definition.slug}-${sceneId}`,
      kind: 'screenshot',
      sceneId,
      shared: index < sharedSceneOrder.length,
      order: index + 1,
      raw: `raw/${definition.slug}.png`,
      crop: { x: 0, y: 0, width: 60, height: 100 },
      surface: definition.surface,
      headline: text.headline,
      alt: text.alt,
      width: definition.width,
      height: definition.height,
      output: `generated/${definition.slug}/${String(index + 1).padStart(2, '0')}-${sceneId}.png`
    };
  });
}

function supportingAsset(
  platformKey: keyof typeof platformDefinitions,
  id: string,
  kind: Asset['kind'],
  width: number,
  height: number
): Asset {
  const slug = platformDefinitions[platformKey].slug;
  const text = copyText(platformKey, id);
  return {
    id,
    kind,
    sceneId: id,
    shared: false,
    raw: `raw/${slug}.png`,
    crop: { x: 0, y: 0, width: 60, height: 100 },
    surface: slug,
    headline: text?.headline ?? `${slug} ${kind}`,
    alt: text?.alt ?? `${slug} ${kind} artwork.`,
    width,
    height,
    output: `generated/${slug}/${id}.png`
  };
}

function validScenes(): SceneManifest {
  return {
    schemaVersion: 1,
    platforms: {
      appStore: screenshotAssets('appStore'),
      playStore: [
        ...screenshotAssets('playStore'),
        supportingAsset('playStore', 'play-feature', 'featureGraphic', 102, 50),
        supportingAsset('playStore', 'play-icon', 'icon', 51, 51)
      ],
      chromeWebStore: [
        ...screenshotAssets('chromeWebStore'),
        supportingAsset('chromeWebStore', 'chrome-confirm', 'smallPromo', 44, 28),
        supportingAsset('chromeWebStore', 'chrome-side-panel', 'marquee', 140, 56),
        supportingAsset('chromeWebStore', 'chrome-icon', 'icon', 13, 13)
      ]
    }
  };
}

function validRules(): StoreRules {
  return {
    // The shipping shape: store-rules.json declares schemaVersion 1, so the fixture does too.
    schemaVersion: 1,
    checkedAt: '2026-09-15',
    maxAgeDays: 180,
    sharedSceneOrder,
    platforms: {
      appStore: {
        label: 'App Store',
        sources: [
          'https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications'
        ],
        allowedPlatformScenes: ['ios-dapp-browser', 'ios-protection'],
        screenshots: {
          min: 1,
          max: 10,
          dimensions: [{ width: 132, height: 286 }],
          alphaAllowed: false
        },
        recommendations: {
          promotionalScreenshots: { enforcedForThisPackage: false }
        },
        requiredKinds: {}
      },
      playStore: {
        label: 'Google Play',
        sources: ['https://support.google.com/googleplay/android-developer/answer/9866151'],
        allowedPlatformScenes: ['android-dapp-browser', 'android-local-proving', 'android-protection'],
        screenshots: {
          min: 2,
          max: 8,
          minDimension: 32,
          maxDimension: 384,
          maxLongToShortRatio: 2,
          alphaAllowed: false
        },
        recommendations: {
          promotionalScreenshots: {
            enforcedForThisPackage: true,
            minimumCount: 4,
            minimumShortSide: 108,
            orientation: 'portrait'
          }
        },
        requiredKinds: {
          featureGraphic: { count: 1, width: 102, height: 50, alphaAllowed: false },
          icon: { count: 1, width: 51, height: 51, alphaAllowed: true }
        }
      },
      chromeWebStore: {
        label: 'Chrome Web Store',
        sources: ['https://developer.chrome.com/docs/webstore/images'],
        allowedPlatformScenes: ['chrome-connect', 'chrome-confirm', 'chrome-side-panel'],
        screenshots: {
          min: 1,
          max: 5,
          dimensions: [
            { width: 128, height: 80 },
            { width: 64, height: 40 }
          ],
          alphaAllowed: false
        },
        recommendations: {
          promotionalScreenshots: { enforcedForThisPackage: false }
        },
        requiredKinds: {
          smallPromo: { count: 1, width: 44, height: 28, alphaAllowed: false },
          marquee: { count: 1, width: 140, height: 56, alphaAllowed: false },
          icon: { count: 1, width: 13, height: 13, alphaAllowed: true }
        }
      }
    }
  };
}

function serialize(value: unknown): string {
  // JSON escapes exercise decoded punctuation without placing a prohibited
  // code point in the test file or its temporary manifest.
  return `${JSON.stringify(value, null, 2)
    .replaceAll(String.fromCodePoint(0x2013), '\\u2013')
    .replaceAll(String.fromCodePoint(0x2014), '\\u2014')}\n`;
}

async function writeFixtureFiles(root: string, scenes: SceneManifest) {
  // Inputs are intentionally larger than the crop but much smaller than store
  // captures. Output metadata still matches the active fixture rules exactly.
  const rawPaths = new Set(Object.values(scenes.platforms).flatMap(assets => assets.map(asset => asset.raw)));
  for (const relativePath of rawPaths) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await sharp({ create: { width: 60, height: 120, channels: 3, background: '#f97316' } })
      .png()
      .toFile(target);
  }

  for (const asset of Object.values(scenes.platforms).flat()) {
    const target = path.join(root, asset.output);
    await mkdir(path.dirname(target), { recursive: true });
    await sharp({ create: { width: asset.width, height: asset.height, channels: 3, background: '#ffffff' } })
      .png()
      .toFile(target);
  }
}

async function runValidator(
  mutate: (scenes: SceneManifest, rules: StoreRules) => void = () => {},
  mutateFiles: (root: string, scenes: SceneManifest) => Promise<void> = async () => {}
) {
  const root = mkdtempSync(path.join(tmpdir(), 'bread-listing-validation-'));
  temporaryDirectories.push(root);
  const scenes = validScenes();
  const rules = validRules();
  mutate(scenes, rules);
  await writeFixtureFiles(root, scenes);
  await mutateFiles(root, scenes);

  const scenesPath = path.join(root, 'scenes.json');
  const rulesPath = path.join(root, 'store-rules.json');
  writeFileSync(scenesPath, serialize(scenes));
  writeFileSync(rulesPath, serialize(rules));

  return spawnSync(
    process.execPath,
    [
      scriptPath,
      '--scenes',
      scenesPath,
      '--rules',
      rulesPath,
      '--copy',
      canonicalCopyPath,
      '--root',
      root,
      '--as-of',
      '2026-09-15'
    ],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );
}

function output(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

afterAll(() => {
  temporaryDirectories.forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

describe('store listing package validation', () => {
  it('locks the approved Chrome capacity mapping into canonical scenes', () => {
    // This is the approved resolution of the seven-scenes versus five-image
    // limit. A later refactor must not move either promo scene back into shots.
    const manifest = JSON.parse(
      readFileSync(path.join(repositoryRoot, 'store-listing/scenes.json'), 'utf8')
    ) as SceneManifest;
    const chrome = manifest.platforms.chromeWebStore;

    expect(chrome.filter(asset => asset.kind === 'screenshot').map(({ sceneId }) => sceneId)).toEqual([
      'wallet-keys',
      'send-privacy',
      'receive',
      'guardian',
      'chrome-connect'
    ]);
    expect(chrome.find(asset => asset.kind === 'smallPromo')?.sceneId).toBe('chrome-confirm');
    expect(chrome.find(asset => asset.kind === 'marquee')?.sceneId).toBe('chrome-side-panel');
  });

  it('accepts a complete package that obeys the active rules', async () => {
    // The positive control proves all negative tests begin from a valid package.
    const result = await runValidator();
    expect(result.status).toBe(0);
    expect(output(result)).toContain('Store listing package is valid');
  });

  it('rejects a missing raw capture', async () => {
    // The mutation happens after fixture creation so no helper recreates the
    // path that is deliberately absent.
    const result = await runValidator(
      () => {},
      async (_root, scenes) => {
        scenes.platforms.appStore[0].raw = 'raw/does-not-exist.png';
      }
    );
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('Raw capture does not exist');
  });

  it('rejects screenshot dimensions not accepted by the target store', async () => {
    // A one-pixel width change catches accidental tolerance or aspect-only checks.
    const result = await runValidator(scenes => {
      scenes.platforms.appStore[0].width += 1;
    });
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('unsupported screenshot dimensions');
  });

  it('rejects alpha when the target asset forbids it', async () => {
    // The translucent file retains correct dimensions, isolating alpha policy
    // from size and existence validation.
    const result = await runValidator(
      () => {},
      async (root, scenes) => {
        const target = scenes.platforms.chromeWebStore[0];
        await sharp({
          create: {
            width: target.width,
            height: target.height,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 0.5 }
          }
        })
          .png()
          .toFile(path.join(root, target.output));
      }
    );
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('must not have an alpha channel');
  });

  it('rejects a screenshot count outside the store range', async () => {
    // Emptying only the App Store array catches a validator that checks totals
    // across stores instead of the target platform.
    const result = await runValidator(scenes => {
      scenes.platforms.appStore = [];
    });
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('screenshot count');
  });

  it('rejects a gap or duplicate in screenshot order', async () => {
    // Duplicating 3 removes 2 at the same time, covering both halves of a
    // contiguous sequence invariant with one mutation.
    const result = await runValidator(scenes => {
      scenes.platforms.playStore[1].order = 3;
    });
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('screenshot order must be contiguous');
  });

  it('rejects missing screenshot alt text', async () => {
    // A blank string is structurally present but unusable for accessibility.
    const result = await runValidator(scenes => {
      scenes.platforms.appStore[0].alt = '';
    });
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('alt text is required');
  });

  it('rejects a changed shared scene order', async () => {
    // Both scenes remain valid and shared, so only their narrative order fails.
    const result = await runValidator(scenes => {
      [scenes.platforms.chromeWebStore[0].sceneId, scenes.platforms.chromeWebStore[1].sceneId] = [
        scenes.platforms.chromeWebStore[1].sceneId,
        scenes.platforms.chromeWebStore[0].sceneId
      ];
    });
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('shared scene order');
  });

  it('rejects a platform scene not approved for that store', async () => {
    // An Android scene is valid globally but invalid in the iOS suffix. This
    // distinguishes per-platform allowlists from a single global set.
    const result = await runValidator(scenes => {
      scenes.platforms.appStore[4].sceneId = 'android-dapp-browser';
    });
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('unsupported platform scene');
  });

  it('rejects store rules after their review window expires', async () => {
    // The explicit as-of date makes expiration deterministic across machines.
    const result = await runValidator((_scenes, rules) => {
      rules.checkedAt = '2025-01-01';
    });
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('Store rules are stale');
  });

  it('rejects either Unicode dash in scene metadata', async () => {
    // Both code points arrive through JSON escapes, matching a pasted metadata
    // value without embedding prohibited punctuation in the repository.
    for (const codePoint of [0x2013, 0x2014]) {
      const result = await runValidator(scenes => {
        scenes.platforms.appStore[0].headline = `Invalid${String.fromCodePoint(codePoint)}headline`;
      });
      expect(result.status).not.toBe(0);
      expect(output(result)).toContain('Unicode dashes are not allowed');
    }
  });

  it('rejects a missing required promotional asset', async () => {
    // Removing only the feature graphic leaves screenshot counts valid and
    // proves non-screenshot requirements are checked independently.
    const result = await runValidator(scenes => {
      scenes.platforms.playStore = scenes.platforms.playStore.filter(asset => asset.kind !== 'featureGraphic');
    });
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('requires exactly 1 featureGraphic');
  });

  it('enforces the Google Play promotional screenshot recommendation', async () => {
    // The two smaller shots remain valid Play images but fall below promotional
    // eligibility, proving the selected recommendation is a separate gate.
    const result = await runValidator(scenes => {
      const screenshots = scenes.platforms.playStore.filter(asset => asset.kind === 'screenshot');
      screenshots[3].width = 100;
      screenshots[4].width = 100;
    });
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('requires at least 4 promotional screenshots');
  });

  it('refuses a rules file that omits its schema version', async () => {
    // The validator used to accept an absent schemaVersion, so a rules file written before the
    // field existed passed silently. Every shipped manifest declares it; nothing else may.
    const result = await runValidator((_scenes, rules) => {
      delete (rules as { schemaVersion?: number }).schemaVersion;
    });
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('Rule schemaVersion must be 1');
  });

  it('refuses a platform that does not state its promotional position', async () => {
    // Absence used to read exactly like a deliberate opt-out: the recommendation resolved to
    // undefined and the gate returned before asserting anything. Deleting the declaration must
    // fail loudly, or the check can be disabled by omission.
    const result = await runValidator((_scenes, rules) => {
      delete rules.platforms.playStore.recommendations;
    });
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('must declare recommendations.promotionalScreenshots');
  });

  it('describes the scene source with a JSON schema', () => {
    // Schema presence keeps editor and external-tool validation discoverable.
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as { $schema: string; required: string[] };
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.required).toEqual(expect.arrayContaining(['platforms']));
  });
});

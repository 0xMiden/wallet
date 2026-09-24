import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';

/*
 * These tests invoke the public CLI against isolated roots. That covers path
 * resolution, manifest loading, output writes, and PNG encoding through the
 * same entry point used for the upload package.
 *
 * Fixtures use reduced dimensions to keep the suite fast, while retaining the
 * portrait, landscape, icon, crop, and brand-color constraints that select
 * different production renderer branches. The determinism case uses two clean
 * roots so stale output cannot make a second build appear reproducible.
 */

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

const repositoryRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repositoryRoot, 'scripts/store-listing/build-assets.mjs');
const fontPath = path.join(repositoryRoot, 'fonts/Geist/webfonts/Geist-SemiBold.woff2');
const temporaryDirectories: string[] = [];

function screenshot(id: string, output: string, width: number, height: number, order: number): Asset {
  // A non-zero crop origin exposes renderers that validate dimensions but
  // accidentally ignore the manifest crop coordinates.
  return {
    id,
    kind: 'screenshot',
    sceneId: id,
    shared: order <= 4,
    order,
    raw: 'raw/wallet.png',
    crop: { x: 10, y: 20, width: 340, height: 600 },
    surface: 'wallet',
    headline: `Headline ${id}`,
    alt: `Current wallet scene ${id}.`,
    width,
    height,
    output
  };
}

function supporting(
  id: string,
  kind: Asset['kind'],
  output: string,
  width: number,
  height: number,
  raw = 'raw/wallet.png'
): Asset {
  return {
    id,
    kind,
    sceneId: id,
    shared: false,
    raw,
    crop: raw.endsWith('.svg') ? { x: 0, y: 0, width: 400, height: 400 } : { x: 10, y: 20, width: 340, height: 600 },
    surface: kind === 'icon' ? 'brand-icon' : 'wallet',
    headline: `Headline ${id}`,
    alt: `Current artwork ${id}.`,
    width,
    height,
    output
  };
}

function fixtureManifest(): SceneManifest {
  return {
    schemaVersion: 1,
    platforms: {
      appStore: [screenshot('app-home', 'generated/app/01-home.png', 132, 286, 1)],
      playStore: [
        screenshot('play-home', 'generated/play/01-home.png', 108, 192, 1),
        supporting('play-feature', 'featureGraphic', 'generated/play/feature.png', 102, 50),
        supporting('play-icon', 'icon', 'generated/play/icon.png', 51, 51, 'raw/icon.svg')
      ],
      chromeWebStore: [
        screenshot('chrome-home', 'generated/chrome/01-home.png', 128, 80, 1),
        supporting('chrome-promo', 'smallPromo', 'generated/chrome/promo.png', 44, 28),
        supporting('chrome-marquee', 'marquee', 'generated/chrome/marquee.png', 140, 56),
        supporting('chrome-icon', 'icon', 'generated/chrome/icon.png', 13, 13, 'raw/icon.svg')
      ]
    }
  };
}

function fixtureTheme() {
  return {
    schemaVersion: 1,
    colors: {
      orange: '#e77537',
      orangeDark: '#bd4b19',
      cream: '#fff7f2',
      ink: '#3f3937',
      white: '#ffffff',
      grid: '#ffffff'
    },
    font: 'fonts/Geist-SemiBold.woff2',
    brandMark: 'raw/mark.svg',
    headlineMaxHeightRatio: 0.2,
    headlineZoneRatio: 0.18,
    cornerRadiusRatio: 0.035,
    gridSizeRatio: 0.075
  };
}

async function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'bread-listing-assets-'));
  temporaryDirectories.push(root);
  mkdirSync(path.join(root, 'raw'), { recursive: true });
  mkdirSync(path.join(root, 'fonts'), { recursive: true });
  copyFileSync(fontPath, path.join(root, 'fonts/Geist-SemiBold.woff2'));

  await sharp({ create: { width: 360, height: 640, channels: 3, background: '#f8f8f8' } })
    .composite([
      {
        input: Buffer.from(
          '<svg width="360" height="640"><rect x="30" y="40" width="300" height="160" rx="20" fill="#8f899b"/><circle cx="180" cy="390" r="90" fill="#e77537"/></svg>'
        )
      }
    ])
    .png()
    .toFile(path.join(root, 'raw/wallet.png'));
  writeFileSync(
    path.join(root, 'raw/icon.svg'),
    '<svg width="400" height="400" xmlns="http://www.w3.org/2000/svg"><rect width="400" height="400" fill="#fff"/><circle cx="200" cy="200" r="120" fill="#e77537"/></svg>'
  );
  writeFileSync(
    path.join(root, 'raw/mark.svg'),
    // The production mark's shape: orange outside, white negative space. The fixture used a plain
    // white mark, which meant the recolor branch never ran in any test.
    '<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" fill="#E77537"/><circle cx="50" cy="50" r="20" fill="white"/></svg>'
  );
  writeFileSync(path.join(root, 'scenes.json'), `${JSON.stringify(fixtureManifest(), null, 2)}\n`);
  writeFileSync(path.join(root, 'theme.json'), `${JSON.stringify(fixtureTheme(), null, 2)}\n`);
  return root;
}

function run(root: string) {
  return spawnSync(process.execPath, [scriptPath, '--root', root, '--scenes', 'scenes.json', '--theme', 'theme.json'], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  });
}

afterAll(() => {
  temporaryDirectories.forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

describe('store listing asset composition', () => {
  it('renders every declared asset in deterministic output order', async () => {
    const root = await createFixture();
    const result = run(root);
    expect(result.status).toBe(0);

    // Sorting here is independent of manifest insertion order and therefore
    // detects an implementation that merely echoes each platform array.
    const expected = Object.values(fixtureManifest().platforms)
      .flat()
      .map(asset => asset.output)
      .sort();
    expect(result.stdout.trim().split('\n')).toEqual(expected);
    for (const output of expected) expect(readFileSync(path.join(root, output)).length).toBeGreaterThan(0);
  });

  it('writes exact opaque dimensions and uses the configured brand orange', async () => {
    const root = await createFixture();
    expect(run(root).status).toBe(0);

    for (const asset of Object.values(fixtureManifest().platforms).flat()) {
      const metadata = await sharp(path.join(root, asset.output)).metadata();
      expect({ width: metadata.width, height: metadata.height }).toEqual({ width: asset.width, height: asset.height });
      expect(metadata.hasAlpha).toBe(false);
    }

    // The top-left pixel is outside every overlay, making it a stable probe of
    // the configured frame rather than an incidental product color.
    const { data } = await sharp(path.join(root, 'generated/app/01-home.png'))
      .extract({ left: 0, top: 0, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([...data.subarray(0, 3)]).toEqual([231, 117, 55]);
  });

  it('rejects a crop outside the raw product capture', async () => {
    const root = await createFixture();
    const scenes = fixtureManifest();
    // The raw width is 360 and the crop begins at x=10, so 351 crosses the
    // boundary by exactly one pixel.
    scenes.platforms.appStore[0]!.crop.width = 351;
    writeFileSync(path.join(root, 'scenes.json'), `${JSON.stringify(scenes, null, 2)}\n`);

    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('crop exceeds raw image bounds');
  });

  it('rejects a headline zone larger than the approved 20 percent safe area', async () => {
    const root = await createFixture();
    const theme = fixtureTheme();
    theme.headlineZoneRatio = 0.21;
    writeFileSync(path.join(root, 'theme.json'), `${JSON.stringify(theme, null, 2)}\n`);

    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('headline zone exceeds 20 percent');
  });

  it('refuses a brand mark whose fill it does not recognise', async () => {
    // The recolor used to skip silently when the mark did not match, compositing the orange mark
    // onto the orange frame - invisible, in every asset, with nothing failing. A re-exported SVG
    // that spells the fill differently must stop the build instead.
    const root = await createFixture();
    writeFileSync(
      path.join(root, 'raw/mark.svg'),
      '<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" fill="#123456"/></svg>'
    );

    const result = run(root);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('does not use the expected Bread orange fill');
  });

  it('writes the bytes the renderer encoded, with no second pass', async () => {
    // The writer used to hand the finished PNG back to sharp, which decoded and re-encoded it at
    // sharp's DEFAULT compression - so the committed bytes came from a pass nobody configured and
    // the renderer's explicit `compressionLevel: 9, adaptiveFiltering: false` was discarded.
    // Re-encoding the written pixels at the renderer's own options must therefore reproduce the
    // file exactly; a file left behind by a default-level second pass does not.
    const root = await createFixture();
    expect(run(root).status).toBe(0);

    for (const asset of Object.values(fixtureManifest().platforms).flat()) {
      const written = readFileSync(path.join(root, asset.output));
      const atRendererOptions = await sharp(written).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
      expect(written.equals(atRendererOptions)).toBe(true);
    }
  });

  it('produces byte-identical PNGs in separate clean roots', async () => {
    const firstRoot = await createFixture();
    const secondRoot = await createFixture();
    expect(run(firstRoot).status).toBe(0);
    expect(run(secondRoot).status).toBe(0);

    for (const asset of Object.values(fixtureManifest().platforms).flat()) {
      expect(readFileSync(path.join(firstRoot, asset.output))).toEqual(
        readFileSync(path.join(secondRoot, asset.output))
      );
    }
  });
});

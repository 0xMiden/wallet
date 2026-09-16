import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

/*
 * Store assets are publication inputs, so equal manifests and raw captures
 * must produce equal PNG bytes without timestamps, machine paths, or ambient
 * font discovery. The theme pins its font and mark, and every output is
 * explicitly flattened before encoding.
 *
 * Product pixels are kept intact apart from the manifest crop, proportional
 * scaling, and rounded mask. Marketing treatment is composed around that
 * buffer, which prevents the renderer from silently changing wallet values or
 * hiding an error inside the application surface.
 */

const platformKeys = ['appStore', 'playStore', 'chromeWebStore'];
const hexColor = /^#[0-9a-f]{6}$/i;

function parseArguments(argv) {
  const options = {
    root: '.',
    scenes: 'store-listing/scenes.json',
    theme: 'store-listing/theme.json'
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--root') options.root = value;
    else if (flag === '--scenes') options.scenes = value;
    else if (flag === '--theme') options.theme = value;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function resolveInside(root, relativePath, label) {
  // Publication builds must not depend on a file outside the reviewable root.
  assert(typeof relativePath === 'string' && relativePath.length > 0, `${label} path is required`);
  const resolved = path.resolve(root, relativePath);
  const relation = path.relative(root, resolved);
  assert(
    relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation),
    `${label} escapes root`
  );
  return resolved;
}

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function validateTheme(theme) {
  assert(theme.schemaVersion === 1, 'Unsupported theme schema version');
  for (const key of ['orange', 'orangeDark', 'cream', 'ink', 'white', 'grid']) {
    assert(hexColor.test(theme.colors?.[key] ?? ''), `Theme color ${key} must be a six-digit hex value`);
  }
  assert(theme.headlineMaxHeightRatio === 0.2, 'Headline maximum must remain 20 percent');
  assert(theme.headlineZoneRatio > 0 && theme.headlineZoneRatio <= 0.2, 'Theme headline zone exceeds 20 percent');
  assert(theme.cornerRadiusRatio > 0 && theme.cornerRadiusRatio < 0.1, 'Theme corner radius is invalid');
  assert(theme.gridSizeRatio > 0 && theme.gridSizeRatio < 0.2, 'Theme grid size is invalid');
}

function flattenAssets(scenes) {
  assert(scenes.schemaVersion === 1, 'Unsupported scene schema version');
  const assets = [];
  for (const platform of platformKeys) {
    assert(Array.isArray(scenes.platforms?.[platform]), `Missing ${platform} scenes`);
    assets.push(...scenes.platforms[platform]);
  }
  const outputs = new Set();
  for (const asset of assets) {
    assert(!outputs.has(asset.output), `Duplicate asset output: ${asset.output}`);
    outputs.add(asset.output);
  }
  return assets.sort((left, right) => left.output.localeCompare(right.output, 'en'));
}

function gridSvg(width, height, theme) {
  const cell = Math.max(12, Math.round(Math.min(width, height) * theme.gridSizeRatio));
  const dot = Math.max(1, Math.round(cell * 0.035));
  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="grid" width="${cell}" height="${cell}" patternUnits="userSpaceOnUse">
          <circle cx="${Math.round(cell / 2)}" cy="${Math.round(cell / 2)}" r="${dot}" fill="${theme.colors.grid}" opacity="0.24"/>
        </pattern>
        <radialGradient id="glow" cx="80%" cy="55%" r="60%">
          <stop offset="0" stop-color="${theme.colors.cream}" stop-opacity="0.22"/>
          <stop offset="1" stop-color="${theme.colors.cream}" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#grid)"/>
      <rect width="${width}" height="${height}" fill="url(#glow)"/>
    </svg>
  `);
}

function whiteBrandMark(source, theme) {
  if (!/fill="#e77537"/i.test(source)) return Buffer.from(source);
  // The source mark uses orange outside and white negative space. A sentinel
  // keeps the two replacements independent so the white mark retains orange
  // counters instead of becoming a solid shape.
  return Buffer.from(
    source
      .replaceAll(/fill="#e77537"/gi, 'fill="__BREAD_OUTER__"')
      .replaceAll(/fill="white"/gi, `fill="${theme.colors.orange}"`)
      .replaceAll('fill="__BREAD_OUTER__"', `fill="${theme.colors.white}"`)
  );
}

function wrapWords(text, maximumCharacters) {
  const words = text.trim().split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && candidate.length > maximumCharacters) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function headlineSvg(asset, layout, theme, fontData) {
  let fontSize = layout.fontSize;
  let maximumCharacters = Math.max(8, Math.floor(layout.textWidth / (fontSize * 0.56)));
  let lines = wrapWords(asset.headline, maximumCharacters);
  if (lines.length > 2) {
    // Shrink once before rejecting: a third line consumes product area and
    // breaks the approved headline-to-art hierarchy.
    fontSize *= 0.82;
    maximumCharacters = Math.max(8, Math.floor(layout.textWidth / (fontSize * 0.56)));
    lines = wrapWords(asset.headline, maximumCharacters);
  }
  assert(lines.length <= 2, `${asset.id} headline needs more than two lines`);

  fontSize = Math.min(fontSize, (asset.height * theme.headlineMaxHeightRatio) / (lines.length * 1.12));
  const lineHeight = fontSize * 1.12;
  const textHeight = lines.length * lineHeight;
  assert(textHeight <= asset.height * theme.headlineMaxHeightRatio, `${asset.id} headline exceeds 20 percent`);
  const firstBaseline = layout.textY + fontSize;
  const anchor = layout.textAlign === 'middle' ? 'middle' : 'start';
  const tspans = lines
    .map(
      (line, index) =>
        `<tspan x="${layout.textX}" y="${Math.round(firstBaseline + index * lineHeight)}">${escapeXml(line)}</tspan>`
    )
    .join('');
  return Buffer.from(`
    <svg width="${asset.width}" height="${asset.height}" xmlns="http://www.w3.org/2000/svg">
      <style>
        @font-face { font-family: GeistStore; src: url(data:font/woff2;base64,${fontData}); font-weight: 600; }
        text { font-family: GeistStore, sans-serif; font-weight: 600; }
      </style>
      <text text-anchor="${anchor}" fill="${theme.colors.white}" font-size="${fontSize}" letter-spacing="-0.02em">${tspans}</text>
    </svg>
  `);
}

function fitSize(sourceWidth, sourceHeight, maximumWidth, maximumHeight) {
  const scale = Math.min(maximumWidth / sourceWidth, maximumHeight / sourceHeight);
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale))
  };
}

function layoutFor(asset, theme) {
  const portrait = asset.height / asset.width > 1.3;
  const margin = Math.round(Math.min(asset.width, asset.height) * (portrait ? 0.065 : 0.075));
  if (portrait) {
    const productTop = Math.round(asset.height * 0.19);
    return {
      portrait,
      margin,
      productBox: {
        x: margin,
        y: productTop,
        width: asset.width - margin * 2,
        height: asset.height - productTop - Math.round(asset.height * 0.035)
      },
      mark: {
        x: margin,
        y: Math.round(asset.height * 0.035),
        width: Math.round(asset.width * 0.085),
        height: Math.round(asset.width * 0.085)
      },
      textX: Math.round(asset.width / 2),
      textY: Math.round(asset.height * 0.075),
      textWidth: Math.round(asset.width * 0.82),
      textAlign: 'middle',
      fontSize: Math.min(asset.width * 0.068, asset.height * theme.headlineZoneRatio * 0.42)
    };
  }

  const productBoxWidth = Math.round(asset.width * 0.43);
  return {
    portrait,
    margin,
    productBox: {
      x: asset.width - margin - productBoxWidth,
      y: margin,
      width: productBoxWidth,
      height: asset.height - margin * 2
    },
    mark: {
      x: margin,
      y: margin,
      width: Math.round(asset.height * 0.13),
      height: Math.round(asset.height * 0.13)
    },
    textX: margin,
    textY: Math.round(asset.height * 0.38),
    textWidth: Math.round(asset.width * 0.46),
    textAlign: 'start',
    fontSize: Math.min(asset.height * 0.095, asset.width * 0.055)
  };
}

async function roundedProduct(rawPath, asset, layout, theme) {
  const metadata = await sharp(rawPath).metadata();
  assert(metadata.width && metadata.height, `${asset.id} raw image has no dimensions`);
  const crop = asset.crop;
  assert(
    crop.x + crop.width <= metadata.width && crop.y + crop.height <= metadata.height,
    `${asset.id} crop exceeds raw image bounds`
  );

  const size = fitSize(crop.width, crop.height, layout.productBox.width, layout.productBox.height);
  // The fit calculation preserves the capture ratio. Sharp's fill mode then
  // uses those exact rounded dimensions without introducing letterboxing.
  const radius = Math.max(2, Math.round(Math.min(size.width, size.height) * theme.cornerRadiusRatio));
  const mask = Buffer.from(
    `<svg width="${size.width}" height="${size.height}" xmlns="http://www.w3.org/2000/svg"><rect width="${size.width}" height="${size.height}" rx="${radius}" fill="#fff"/></svg>`
  );
  const image = await sharp(rawPath)
    .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
    .resize(size.width, size.height, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
  return {
    image,
    width: size.width,
    height: size.height,
    left: layout.productBox.x + Math.round((layout.productBox.width - size.width) / 2),
    top: layout.productBox.y + Math.round((layout.productBox.height - size.height) / 2),
    radius
  };
}

async function renderIcon(root, asset, theme) {
  const rawPath = resolveInside(root, asset.raw, `${asset.id} raw`);
  const metadata = await sharp(rawPath).metadata();
  assert(metadata.width && metadata.height, `${asset.id} raw image has no dimensions`);
  const crop = asset.crop;
  assert(
    crop.x + crop.width <= metadata.width && crop.y + crop.height <= metadata.height,
    `${asset.id} crop exceeds raw image bounds`
  );
  return (
    sharp(rawPath)
      .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
      .resize(asset.width, asset.height, { fit: 'cover', kernel: sharp.kernel.lanczos3 })
      // Store icons in this package are required to be opaque even when the
      // reusable source mark contains transparency.
      .flatten({ background: theme.colors.white })
      .removeAlpha()
      .png({ compressionLevel: 9, adaptiveFiltering: false })
      .toBuffer()
  );
}

async function renderArtwork(root, asset, theme, fontData, markSource) {
  const layout = layoutFor(asset, theme);
  const product = await roundedProduct(resolveInside(root, asset.raw, `${asset.id} raw`), asset, layout, theme);
  const mark = await sharp(markSource)
    .resize(layout.mark.width, layout.mark.height, {
      fit: 'contain',
      // Sharp otherwise fills contain padding with black, which would create
      // visible bars around the white mark on the orange frame.
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
  const border = Math.max(2, Math.round(Math.min(asset.width, asset.height) * 0.008));
  const plate = Buffer.from(
    `<svg width="${product.width + border * 2}" height="${product.height + border * 2}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" rx="${product.radius + border}" fill="${theme.colors.cream}" fill-opacity="0.82"/></svg>`
  );
  const output = await sharp({
    create: { width: asset.width, height: asset.height, channels: 3, background: theme.colors.orange }
  })
    .composite([
      { input: gridSvg(asset.width, asset.height, theme), left: 0, top: 0 },
      { input: mark, left: layout.mark.x, top: layout.mark.y },
      { input: headlineSvg(asset, layout, theme, fontData), left: 0, top: 0 },
      { input: plate, left: product.left - border, top: product.top - border },
      { input: product.image, left: product.left, top: product.top }
    ])
    .flatten({ background: theme.colors.orange })
    .removeAlpha()
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  return output;
}

export async function buildAssets(options = {}) {
  const root = path.resolve(options.root ?? '.');
  const scenesPath = resolveInside(root, options.scenes ?? 'store-listing/scenes.json', 'Scenes');
  const themePath = resolveInside(root, options.theme ?? 'store-listing/theme.json', 'Theme');
  const [scenes, theme] = await Promise.all([
    readFile(scenesPath, 'utf8').then(JSON.parse),
    readFile(themePath, 'utf8').then(JSON.parse)
  ]);
  validateTheme(theme);
  const fontPath = resolveInside(root, theme.font, 'Theme font');
  const markPath = resolveInside(root, theme.brandMark, 'Theme brand mark');
  const [fontBuffer, markText] = await Promise.all([readFile(fontPath), readFile(markPath, 'utf8')]);
  const fontData = fontBuffer.toString('base64');
  const markSource = whiteBrandMark(markText, theme);
  const outputs = [];

  // Sorted serial rendering makes both CLI output and write order stable. It
  // also avoids duplicate Sharp work contending for memory on full-size PNGs.
  for (const asset of flattenAssets(scenes)) {
    const outputPath = resolveInside(root, asset.output, `${asset.id} output`);
    await mkdir(path.dirname(outputPath), { recursive: true });
    const buffer =
      asset.kind === 'icon'
        ? await renderIcon(root, asset, theme)
        : await renderArtwork(root, asset, theme, fontData, markSource);
    await sharp(buffer).toFile(outputPath);
    outputs.push(asset.output.split(path.sep).join('/'));
  }
  return outputs;
}

async function main() {
  const outputs = await buildAssets(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${outputs.join('\n')}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

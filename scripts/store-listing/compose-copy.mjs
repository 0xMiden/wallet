import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { format } from 'prettier';

import { allStrings, assert, resolveInside } from './shared.mjs';

/*
 * The canonical model stores each shared fact once. Store outputs may append
 * platform facts, but they never receive a separately editable shared copy.
 * That constraint prevents a small wording fix from silently producing three
 * different security or recovery stories.
 *
 * Validation runs before any output is written. A failed invocation therefore
 * cannot leave a partly updated upload package that looks current. Generated
 * files contain no time stamp or absolute input path, so equal input produces
 * byte-identical output on another machine and in a clean checkout.
 */
const platformKeys = ['appStore', 'playStore', 'chromeWebStore'];

// These phrases are rejected in metadata and supporting text, not merely in
// descriptions. Otherwise an unsupported claim could return through a future
// screenshot headline or short-description field.
const forbiddenClaims = [
  /\bleading\b/i,
  /\bhighest\b/i,
  /state-of-the-art/i,
  /\ball transaction types\b/i,
  /\btotally private\b/i,
  /\bevery transaction is private\b/i,
  /\bzkrollup\b/i
];
const prettierOptions = { printWidth: 120, singleQuote: true, trailingComma: 'none' };

function parseArguments(argv) {
  const options = {
    source: 'store-listing/listing-copy.json',
    outputRoot: 'store-listing/generated',
    markdown: 'STORE_LISTING.md'
  };

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--source') options.source = value;
    else if (flag === '--output-root') options.outputRoot = value;
    else if (flag === '--markdown') options.markdown = value;
    else throw new Error(`Unknown argument: ${flag}`);
  }

  return options;
}

function orderedBlocks(collection, label) {
  assert(collection && Array.isArray(collection.blocks), `${label} blocks must be an array`);
  assert(Array.isArray(collection.blockOrder), `${label} block order must be an array`);

  // Order is data because stores display facts sequentially. Requiring a full,
  // bijective order makes omissions and repeated facts fail before generation.
  const byId = new Map(collection.blocks.map(block => [block.id, block]));
  assert(byId.size === collection.blocks.length, `${label} blocks contain duplicate fact ids`);
  assert(
    new Set(collection.blockOrder).size === collection.blockOrder.length,
    `${label} block order contains duplicate fact ids`
  );
  assert(collection.blockOrder.length === collection.blocks.length, `${label} block order must include every fact id`);

  return collection.blockOrder.map(id => {
    const block = byId.get(id);
    assert(block, `${label} block order references missing fact id: ${id}`);
    return block;
  });
}

function blockFacts(block) {
  return [block.text, ...(block.bullets ?? [])].filter(Boolean);
}

function textForPlatform(platform) {
  return allStrings([platform.fields, platform.blocks]).join('\n');
}

function assertCharacterLimit(label, value, limit) {
  assert(typeof value === 'string', `${label} must be a string`);
  assert(Array.from(value).length <= limit, `${label} exceeds ${limit} characters`);
}

function validateFields(source, descriptions) {
  const appStore = source.platforms.appStore.fields;
  const playStore = source.platforms.playStore.fields;
  const chrome = source.platforms.chromeWebStore.fields;

  assertCharacterLimit('App Store name', appStore.name, 30);
  assertCharacterLimit('App Store subtitle', appStore.subtitle, 30);
  assertCharacterLimit('App Store promotionalText', appStore.promotionalText, 170);
  // Apple enforces the keyword field in UTF-8 bytes, while the other limits
  // below are documented character counts. Non-ASCII input must not undercount.
  const keywords = Array.isArray(appStore.keywords) ? appStore.keywords.join(',') : appStore.keywords;
  assert(Buffer.byteLength(keywords, 'utf8') <= 100, 'App Store keywords exceeds 100 bytes');
  assertCharacterLimit('App Store description', descriptions.appStore, 4000);

  assertCharacterLimit('Google Play name', playStore.name, 30);
  assertCharacterLimit('Google Play shortDescription', playStore.shortDescription, 80);
  assertCharacterLimit('Google Play description', descriptions.playStore, 4000);

  assertCharacterLimit('Chrome name', chrome.name, 75);
  assertCharacterLimit('Chrome shortDescription', chrome.shortDescription, 132);
}

function validatePlatformTerms(source) {
  const appStore = textForPlatform(source.platforms.appStore);
  const playStore = textForPlatform(source.platforms.playStore);
  const chrome = textForPlatform(source.platforms.chromeWebStore);

  // The package intentionally keeps iOS copy narrower than runtime availability.
  // Product policy may add the claim later, but only by changing this guard and
  // its mutation test together. Android retains the approved swap distinction.
  assert(!/\bswap\b/i.test(appStore), 'App Store copy must not mention swap');
  assert(/\bswap\b/i.test(playStore), 'Google Play copy must mention swap');

  assert(
    /Face ID/.test(appStore) && /passcode/i.test(appStore),
    'App Store authentication copy must name Face ID and passcode'
  );
  assert(
    !/fingerprint|biometric authentication/i.test(appStore),
    'App Store authentication copy must use iOS terminology'
  );

  assert(
    /biometric authentication/i.test(playStore) && /passcode/i.test(playStore),
    'Google Play authentication copy must name biometric authentication and passcode'
  );
  assert(!/Face ID|Touch ID/.test(playStore), 'Google Play authentication copy must use Android terminology');

  // Mobile authentication brands are misleading for an extension vault even
  // when the same source tree also builds mobile applications.
  assert(/password/i.test(chrome), 'Chrome authentication copy must name password protection');
  assert(
    !/Face ID|Touch ID|biometric|passcode/i.test(chrome),
    'Chrome authentication copy must not use mobile terminology'
  );
}

function validateTextPolicy(source) {
  const strings = allStrings(source);
  assert(!strings.some(value => /[\u2013\u2014]/u.test(value)), 'Unicode dashes are not allowed');

  for (const value of strings) {
    const match = forbiddenClaims.find(pattern => pattern.test(value));
    assert(!match, `Forbidden claim: ${value}`);
  }
}

function validateDistinctFacts(sharedBlocks, platforms) {
  // Fact ids catch structural repetition, while normalized prose catches copy
  // and paste under a new id. Headings are excluded because section labels may
  // legitimately recur without repeating a product claim.
  for (const platform of platforms) {
    const seen = new Set();
    for (const fact of [...sharedBlocks, ...platform.blocks].flatMap(blockFacts)) {
      const normalized = fact.trim().toLocaleLowerCase('en-US');
      assert(!seen.has(normalized), `${platform.label} description repeats a fact: ${fact}`);
      seen.add(normalized);
    }
  }
}

function screenshotsFor(source, platformKey) {
  // Shared position is fixed here rather than copied into every platform. This
  // makes the first four scenes one ordering invariant across all stores.
  const shared = source.screenshots.shared.map(screenshot => ({
    id: screenshot.id,
    headline: screenshot.headline,
    alt: screenshot.alt[platformKey]
  }));
  return [...shared, ...source.screenshots.platforms[platformKey]];
}

function promotionalArtworkFor(source, platformKey) {
  return source.promotionalArtwork[platformKey];
}

function validateScreenshots(source) {
  for (const platformKey of platformKeys) {
    const ids = new Set();
    for (const screenshot of screenshotsFor(source, platformKey)) {
      assert(typeof screenshot.id === 'string' && screenshot.id.length > 0, `${platformKey} screenshot id is required`);
      assert(
        typeof screenshot.headline === 'string' && screenshot.headline.length > 0,
        `${platformKey} screenshot headline is required`
      );
      assert(
        typeof screenshot.alt === 'string' && screenshot.alt.length > 0,
        `${platformKey} screenshot alt text is required`
      );
      assert(!ids.has(screenshot.id), `${platformKey} screenshot ids must be unique`);
      ids.add(screenshot.id);
    }
  }

  for (const platformKey of platformKeys) {
    for (const artwork of promotionalArtworkFor(source, platformKey)) {
      assert(
        typeof artwork.id === 'string' && artwork.id.length > 0,
        `${platformKey} promotional artwork id is required`
      );
      assert(
        typeof artwork.kind === 'string' && artwork.kind.length > 0,
        `${platformKey} promotional artwork kind is required`
      );
      assert(
        typeof artwork.headline === 'string' && artwork.headline.length > 0,
        `${platformKey} promotional artwork headline is required`
      );
      assert(
        typeof artwork.alt === 'string' && artwork.alt.length > 0,
        `${platformKey} promotional artwork alt text is required`
      );
    }
  }
}

function renderBlock(block) {
  const lines = [];
  if (block.heading) lines.push(block.heading);
  if (block.text) lines.push(block.text);
  if (block.bullets) {
    if (lines.length > 0) lines.push('');
    lines.push(...block.bullets.map(bullet => `- ${bullet}`));
  }
  return lines.join('\n');
}

function renderDescription(blocks) {
  return blocks.map(renderBlock).join('\n\n');
}

function generatedFields(fields) {
  // Arrays make canonical keyword editing reviewable, while output fields stay
  // ready to paste into a store without an undocumented joining step.
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, renderFieldValue(value)]));
}

function compose(source) {
  assert(source.schemaVersion === 1, 'schemaVersion must be 1');
  assert(source.product?.name, 'product name is required');
  assert(source.product?.valueLine, 'product value line is required');
  assert(source.platforms, 'platforms are required');
  assert(source.screenshots, 'screenshots are required');
  assert(source.promotionalArtwork, 'promotional artwork is required');

  validateTextPolicy(source);
  const sharedBlocks = orderedBlocks(source.shared, 'Shared');
  const platformEntries = platformKeys.map(platformKey => {
    const platform = source.platforms[platformKey];
    assert(platform, `${platformKey} copy is required`);
    return {
      key: platformKey,
      ...platform,
      blocks: orderedBlocks(platform, platform.label)
    };
  });

  validatePlatformTerms(source);
  validateDistinctFacts(sharedBlocks, platformEntries);
  validateScreenshots(source);

  // Shared references are reused directly in every output. JSON serialization
  // then proves byte identity without maintaining parallel string constants.
  const descriptions = Object.fromEntries(
    platformEntries.map(platform => [platform.key, renderDescription([...sharedBlocks, ...platform.blocks])])
  );
  validateFields(source, descriptions);

  return Object.fromEntries(
    platformEntries.map(platform => [
      platform.key,
      {
        schemaVersion: 1,
        generatedFrom: source.sourceId,
        store: platform.label,
        storeUrl: platform.storeUrl,
        product: source.product,
        fields: generatedFields(platform.fields),
        sharedBlocks,
        platformBlocks: platform.blocks,
        blockOrder: [...source.shared.blockOrder, ...platform.blockOrder],
        description: descriptions[platform.key],
        screenshots: screenshotsFor(source, platform.key),
        promotionalArtwork: promotionalArtworkFor(source, platform.key)
      }
    ])
  );
}

function renderFieldValue(value) {
  return Array.isArray(value) ? value.join(',') : value;
}

function renderMarkdown(outputs) {
  const lines = [
    '# Bread Wallet store listings',
    '',
    '> Generated from `store-listing/listing-copy.json`. Do not edit this file by hand.',
    ''
  ];

  for (const platformKey of platformKeys) {
    const output = outputs[platformKey];
    lines.push(`## ${output.store}`, '');
    for (const [field, value] of Object.entries(output.fields)) {
      lines.push(`- **${field}:** ${renderFieldValue(value)}`);
    }
    lines.push('', '### Description', '', output.description, '', '### Screenshot copy', '');
    output.screenshots.forEach((screenshot, index) => {
      lines.push(`${index + 1}. **${screenshot.headline}** - ${screenshot.alt}`);
    });
    if (output.promotionalArtwork.length > 0) {
      lines.push('', '### Promotional artwork', '');
      output.promotionalArtwork.forEach(artwork => {
        lines.push(`- **${artwork.kind}: ${artwork.headline}** - ${artwork.alt}`);
      });
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const source = JSON.parse(await readFile(path.resolve(options.source), 'utf8'));
  const outputs = compose(source);

  for (const platformKey of platformKeys) {
    const output = outputs[platformKey];
    // Contained, because the slug comes from the manifest: an absolute or '..' slug would
    // otherwise make this write outside the package, anywhere the process can reach.
    const outputDirectory = resolveInside(
      path.resolve(options.outputRoot),
      source.platforms[platformKey].slug,
      `${platformKey} slug`
    );
    await mkdir(outputDirectory, { recursive: true });
    // Formatting is part of generation so a clean rebuild never creates a
    // formatter-only diff and hash comparisons remain meaningful.
    await writeFile(
      path.join(outputDirectory, 'copy.json'),
      await format(JSON.stringify(output), { ...prettierOptions, parser: 'json' })
    );
  }

  const markdownPath = path.resolve(options.markdown);
  await mkdir(path.dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, await format(renderMarkdown(outputs), { ...prettierOptions, parser: 'markdown' }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Store listing copy error: ${error.message}`);
    process.exitCode = 1;
  });
}

export { compose, renderMarkdown };

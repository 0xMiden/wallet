import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { compose } from './compose-copy.mjs';
import { allStrings, assert, isMainModule, readJsonFile, resolveInside } from './shared.mjs';

/*
 * This validator treats manifests, copy, raw captures, and rendered files as a
 * single upload package. Checking only manifest declarations would allow an
 * incorrectly sized or translucent PNG to pass, while checking only files
 * would miss ordering and platform-policy drift.
 *
 * Paths resolve under an explicit root and are rejected if they escape it.
 * Tests can therefore use isolated miniature fixtures, while the default CLI
 * validates repository-sized publication assets through the same code path.
 */
const platformKeys = ['appStore', 'playStore', 'chromeWebStore'];
const millisecondsPerDay = 24 * 60 * 60 * 1000;

function parseArguments(argv) {
  const options = {
    scenes: 'store-listing/scenes.json',
    rules: 'store-listing/store-rules.json',
    copy: 'store-listing/listing-copy.json',
    root: '.',
    asOf: new Date().toISOString().slice(0, 10)
  };

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--scenes') options.scenes = value;
    else if (flag === '--rules') options.rules = value;
    else if (flag === '--copy') options.copy = value;
    else if (flag === '--root') options.root = value;
    else if (flag === '--as-of') options.asOf = value;
    else throw new Error(`Unknown argument: ${flag}`);
  }

  return options;
}

function validatePunctuation(...documents) {
  const invalid = documents.flatMap(allStrings).find(value => /[\u2013\u2014]/u.test(value));
  assert(!invalid, 'Unicode dashes are not allowed');
}

function parseDay(value, label) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(value), `${label} must use YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00Z`);
  assert(!Number.isNaN(date.valueOf()), `${label} must be a valid date`);
  return date;
}

function validateRuleAge(rules, asOf) {
  // A checked date is an expiring assertion, not historical decoration. This
  // forces a rule review instead of silently carrying old dimensions forward.
  const checkedAt = parseDay(rules.checkedAt, 'checkedAt');
  const evaluationDate = parseDay(asOf, 'as-of date');
  const ageDays = (evaluationDate.valueOf() - checkedAt.valueOf()) / millisecondsPerDay;
  assert(ageDays >= 0, 'Store rules cannot be checked in the future');
  assert(ageDays <= rules.maxAgeDays, `Store rules are stale: checked ${rules.checkedAt}`);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function validateRuleSources(rule) {
  // Every encoded limit needs a first-party review trail for the next refresh.
  assert(Array.isArray(rule.sources) && rule.sources.length > 0, `${rule.label} must include first-party rule sources`);
  for (const source of rule.sources) {
    assert(
      typeof source === 'string' && source.startsWith('https://'),
      `${rule.label} rule source must be an HTTPS URL`
    );
  }
}

function dimensionsMatch(asset, dimensions) {
  return dimensions.some(candidate => candidate.width === asset.width && candidate.height === asset.height);
}

function validateScreenshotDimensions(asset, rule) {
  // Apple and Chrome publish exact canvases. Google instead publishes a range
  // and aspect-ratio bound, so the manifest supports both rule shapes.
  if (rule.dimensions) {
    assert(
      dimensionsMatch(asset, rule.dimensions),
      `${asset.id} has unsupported screenshot dimensions ${asset.width}x${asset.height}`
    );
    return;
  }

  const shortSide = Math.min(asset.width, asset.height);
  const longSide = Math.max(asset.width, asset.height);
  assert(
    shortSide >= rule.minDimension && longSide <= rule.maxDimension && longSide / shortSide <= rule.maxLongToShortRatio,
    `${asset.id} has unsupported screenshot dimensions ${asset.width}x${asset.height}`
  );
}

function validateScreenshotSequence(platformKey, screenshots, rules) {
  const rule = rules.platforms[platformKey];
  assert(
    screenshots.length >= rule.screenshots.min && screenshots.length <= rule.screenshots.max,
    `${rule.label} screenshot count ${screenshots.length} is outside ${rule.screenshots.min}-${rule.screenshots.max}`
  );

  const expectedOrder = screenshots.map((_asset, index) => index + 1);
  assert(
    screenshots.every((asset, index) => asset.order === expectedOrder[index]),
    `${rule.label} screenshot order must be contiguous from 1`
  );

  // Shared scenes are a prefix rather than a set. A set comparison would miss
  // a store silently leading with a different feature or reordering the story.
  const shared = screenshots.filter(asset => asset.shared);
  assert(
    shared.length === rules.sharedSceneOrder.length &&
      shared.every((asset, index) => asset.sceneId === rules.sharedSceneOrder[index]) &&
      screenshots.slice(0, shared.length).every(asset => asset.shared),
    `${rule.label} shared scene order must be ${rules.sharedSceneOrder.join(', ')}`
  );

  for (const asset of screenshots.slice(shared.length)) {
    assert(!asset.shared, `${rule.label} shared scenes must precede platform scenes`);
    assert(
      rule.allowedPlatformScenes.includes(asset.sceneId),
      `${rule.label} has unsupported platform scene: ${asset.sceneId}`
    );
  }

  screenshots.forEach(asset => validateScreenshotDimensions(asset, rule.screenshots));
}

function validateRequiredKinds(assets, rule) {
  // Exact counts keep obsolete alternates out of the upload directory. A
  // publisher should not have to guess which icon or promo is authoritative.
  for (const [kind, requirement] of Object.entries(rule.requiredKinds)) {
    const matching = assets.filter(asset => asset.kind === kind);
    assert(matching.length === requirement.count, `${rule.label} requires exactly ${requirement.count} ${kind}`);
    for (const asset of matching) {
      assert(
        asset.width === requirement.width && asset.height === requirement.height,
        `${asset.id} must be ${requirement.width}x${requirement.height}`
      );
    }
  }
}

function validatePromotionalRecommendation(assets, rule) {
  // Google describes this as promotional eligibility guidance, but the
  // approved package elects to enforce it as a release requirement.
  // Every platform states its position explicitly. Without this assert an absent key reads exactly
  // like a deliberate opt-out, so deleting the declaration would silently disable the gate rather
  // than fail - which is what a compatibility fallback for a never-shipped shape was hiding.
  const recommendation = rule.recommendations?.promotionalScreenshots;
  assert(
    recommendation,
    `${rule.label} must declare recommendations.promotionalScreenshots (use enforcedForThisPackage: false to opt out)`
  );
  // Truthiness is not a declaration: `{}` and a misspelled field both read as a deliberate opt-out,
  // which is the same failure one level down. The stance must be stated as a boolean, and the
  // numbers it is enforced against must exist before anything is compared to them.
  assert(
    typeof recommendation.enforcedForThisPackage === 'boolean',
    `${rule.label} recommendations.promotionalScreenshots.enforcedForThisPackage must be true or false`
  );
  if (!recommendation.enforcedForThisPackage) return;
  assert(
    typeof recommendation.minimumCount === 'number' && typeof recommendation.minimumShortSide === 'number',
    `${rule.label} enforces promotional screenshots but declares no minimumCount and minimumShortSide`
  );

  const eligible = assets.filter(
    asset =>
      asset.kind === 'screenshot' &&
      Math.min(asset.width, asset.height) >= recommendation.minimumShortSide &&
      (recommendation.orientation !== 'portrait' || asset.height > asset.width)
  );
  assert(
    eligible.length >= recommendation.minimumCount,
    `${rule.label} requires at least ${recommendation.minimumCount} promotional screenshots`
  );
}

function validateAssetMetadata(asset, copyItem) {
  assert(typeof asset.id === 'string' && asset.id.length > 0, 'Asset id is required');
  assert(typeof asset.sceneId === 'string' && asset.sceneId.length > 0, `${asset.id} scene id is required`);
  assert(typeof asset.surface === 'string' && asset.surface.length > 0, `${asset.id} surface is required`);
  assert(typeof asset.headline === 'string' && asset.headline.length > 0, `${asset.id} headline is required`);
  assert(typeof asset.alt === 'string' && asset.alt.length > 0, `${asset.id} alt text is required`);

  // Icons have no marketing copy. Every other rendered asset must reproduce
  // the canonical text exactly so a manifest edit cannot fork the copy model.
  if (asset.kind !== 'icon') {
    assert(copyItem, `${asset.id} has no canonical copy entry for ${asset.sceneId}`);
    assert(asset.kind === copyItem.kind, `${asset.id} kind differs from canonical copy`);
    assert(asset.headline === copyItem.headline, `${asset.id} headline differs from canonical copy`);
    assert(asset.alt === copyItem.alt, `${asset.id} alt text differs from canonical copy`);
  }
}

function alphaAllowed(asset, rule) {
  if (asset.kind === 'screenshot') return rule.screenshots.alphaAllowed;
  return rule.requiredKinds[asset.kind]?.alphaAllowed ?? false;
}

async function validateFiles(root, asset, rule) {
  // Crop bounds are checked against decoded input metadata. This prevents a
  // renderer from relying on Sharp's clipping behavior or blank padding.
  const rawPath = resolveInside(root, asset.raw, `${asset.id} raw capture`);
  assert(await exists(rawPath), `Raw capture does not exist: ${asset.raw}`);
  const rawMetadata = await sharp(rawPath).metadata();
  assert(rawMetadata.width && rawMetadata.height, `${asset.id} raw capture dimensions are unavailable`);
  assert(
    asset.crop.x + asset.crop.width <= rawMetadata.width && asset.crop.y + asset.crop.height <= rawMetadata.height,
    `${asset.id} crop exceeds the raw capture`
  );

  // Decoded output metadata, rather than the filename or manifest alone, is
  // the authority for dimensions and alpha-channel checks.
  const outputPath = resolveInside(root, asset.output, `${asset.id} output`);
  assert(await exists(outputPath), `Generated asset does not exist: ${asset.output}`);
  const outputMetadata = await sharp(outputPath).metadata();
  assert(
    outputMetadata.width === asset.width && outputMetadata.height === asset.height,
    `${asset.id} file dimensions differ from its manifest`
  );
  assert(alphaAllowed(asset, rule) || !outputMetadata.hasAlpha, `${asset.id} must not have an alpha channel`);
}

function copyIndex(output) {
  // Screenshot entries do not store a kind because their container implies it.
  // Add the kind here so scene-to-copy comparison stays uniform.
  return new Map([
    ...output.screenshots.map(item => [item.id, { ...item, kind: 'screenshot' }]),
    ...output.promotionalArtwork.map(item => [item.id, item])
  ]);
}

async function validatePackage({ scenes, rules, copy, root, asOf }) {
  assert(scenes.schemaVersion === 1, 'Scene schemaVersion must be 1');
  assert(rules.schemaVersion === 1, 'Rule schemaVersion must be 1');
  assert(scenes.platforms && rules.platforms, 'Platform manifests are required');
  validatePunctuation(scenes, rules, copy);
  validateRuleAge(rules, asOf);
  // `rules` is threaded in: compose enforces the copy limits the rules file declares, so calling
  // it without them would make the validator stop checking exactly what it exists to gate.
  const composedCopy = compose(copy, rules);

  // Uniqueness spans stores. Reusing an id or output path could cause reports
  // and hashes to attribute one platform's pixels to another.
  const assetIds = new Set();
  const outputPaths = new Set();
  for (const platformKey of platformKeys) {
    const rule = rules.platforms[platformKey];
    const assets = scenes.platforms[platformKey];
    assert(rule && Array.isArray(assets), `${platformKey} rules and scenes are required`);
    validateRuleSources(rule);

    const screenshots = assets.filter(asset => asset.kind === 'screenshot');
    validateScreenshotSequence(platformKey, screenshots, rules);
    validateRequiredKinds(assets, rule);
    validatePromotionalRecommendation(assets, rule);

    const indexedCopy = copyIndex(composedCopy[platformKey]);

    // Both directions. The asset loop below proves every shipped asset has copy; this proves every
    // shipped copy entry has an asset. Without it STORE_LISTING.md can promise a screenshot that
    // has no file, which is only discovered by a human reading the upload form.
    const sceneIds = new Set(assets.map(asset => asset.sceneId));
    for (const sceneId of indexedCopy.keys()) {
      assert(sceneIds.has(sceneId), `${rule.label} copy declares ${sceneId} but no scene asset produces it`);
    }

    for (const asset of assets) {
      assert(!assetIds.has(asset.id), `Asset id must be unique: ${asset.id}`);
      assetIds.add(asset.id);
      assert(!outputPaths.has(asset.output), `Output path must be unique: ${asset.output}`);
      outputPaths.add(asset.output);
      validateAssetMetadata(asset, indexedCopy.get(asset.sceneId));
      await validateFiles(root, asset, rule);
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = path.resolve(options.root);
  const [scenes, rules, copy] = await Promise.all([
    readJsonFile(path.resolve(options.scenes), 'Scene manifest'),
    readJsonFile(path.resolve(options.rules), 'Store rules'),
    readJsonFile(path.resolve(options.copy), 'Listing copy source')
  ]);

  await validatePackage({ scenes, rules, copy, root, asOf: options.asOf });
  const assetCount = platformKeys.reduce((count, key) => count + scenes.platforms[key].length, 0);
  console.log(`Store listing package is valid: ${assetCount} assets across ${platformKeys.length} stores.`);
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error(`Store listing validation error: ${error.message}`);
    process.exitCode = 1;
  });
}

export { validatePackage };

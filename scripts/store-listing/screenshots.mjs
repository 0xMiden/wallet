import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { assert, validateRuleAge, validateRuleSources, validateScreenshotDimensions } from './shared.mjs';

const targets = {
  ios: { rule: 'appStore', ids: ['6789341854'] },
  android: { rule: 'playStore', ids: ['com.miden.wallet'] },
  chrome: { rule: 'chromeWebStore', ids: ['coajhopfooegmaifelglfboehacldcbo', 'eeghndabgeicdpkbcohgglidpfpiafnb'] }
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function keys(value, allowed, label) {
  assert(
    isObject(value) && Object.keys(value).every(key => allowed.includes(key)),
    `${label} has an invalid shape or unknown field`
  );
}

function relativeFile(root, value) {
  assert(
    typeof value === 'string' &&
      value.length > 0 &&
      !path.isAbsolute(value) &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      value.split('/').every(part => part && part !== '.' && part !== '..'),
    'Screenshot path must be a contained relative file path'
  );
  return path.join(root, value);
}

async function safeBytes(root, relative) {
  const absolute = relativeFile(root, relative);
  let current = root;
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    assert(!(await lstat(current)).isSymbolicLink(), `Screenshot path cannot contain a symlink: ${relative}`);
  }
  // Hold exactly the bytes that passed hashing so uploads do not reread a later path replacement.
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assert((await file.stat()).isFile(), `Screenshot path is not a regular file: ${relative}`);
    const resolved = await realpath(absolute);
    assert(resolved === absolute, `Screenshot path changed or contains a symlink: ${relative}`);
    return await file.readFile();
  } finally {
    await file.close();
  }
}

function json(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function validateSource(source, bytes, digest) {
  if (source === undefined) return;
  keys(source, ['assetId', 'checksum', 'url', 'importSha256', 'fileName', 'kind'], 'Screenshot source');
  if (source.fileName !== undefined)
    assert(
      typeof source.fileName === 'string' && source.fileName.length > 0 && !/[\u0000-\u001f]/.test(source.fileName),
      'Screenshot source fileName is invalid'
    );
  if (source.kind !== undefined)
    assert(['original-upload', 'store-delivery-rendition'].includes(source.kind), 'Screenshot source kind is invalid');
  if (source.kind === 'store-delivery-rendition')
    assert(source.importSha256 === digest, 'Screenshot rendition requires verified import SHA256');
  if (source.assetId !== undefined)
    assert(typeof source.assetId === 'string' && source.assetId.length > 0, 'Screenshot source assetId is invalid');
  if (source.url !== undefined) {
    let url;
    try {
      url = new URL(source.url);
    } catch {
      throw new Error('Screenshot source URL is invalid');
    }
    assert(
      url.protocol === 'https:' && !url.username && !url.password,
      'Screenshot source URL must be HTTPS without credentials'
    );
  }
  if (source.importSha256 !== undefined)
    assert(source.importSha256 === digest, 'Screenshot source import SHA256 mismatch');
  if (source.checksum !== undefined) {
    keys(source.checksum, ['algorithm', 'value'], 'Screenshot source checksum');
    const { algorithm, value } = source.checksum;
    assert(
      ['md5', 'sha256'].includes(algorithm) &&
        typeof value === 'string' &&
        new RegExp(`^[a-f0-9]{${algorithm === 'md5' ? 32 : 64}}$`).test(value),
      'Screenshot source checksum is invalid'
    );
    const matches = createHash(algorithm).update(bytes).digest('hex') === value;
    // Store CDNs may re-encode an export while retaining the original upload checksum as provenance.
    assert(
      matches || (source.kind !== 'original-upload' && source.importSha256 === digest),
      'Screenshot source checksum mismatch without verified import SHA256'
    );
  }
}

function ruleFor(set, rules) {
  const target = Object.hasOwn(targets, set.platform) ? targets[set.platform] : undefined;
  assert(target && target.ids.includes(set.storeId), 'Screenshot store target identity is invalid');
  assert(
    typeof set.locale === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(set.locale),
    'Screenshot locale is invalid'
  );
  const rule = rules.platforms?.[target.rule];
  assert(rule && rule.screenshots, 'Screenshot technical rules are missing');
  validateRuleSources(rule);
  if (set.platform === 'ios') {
    const display = rule.screenshots.displayTypes?.[set.displayType];
    assert(display, `Unsupported Apple screenshot display type: ${set.displayType}`);
    return { ...rule.screenshots, dimensions: display.dimensions, family: display.family };
  }
  assert(
    set.displayType === (set.platform === 'android' ? 'phoneScreenshots' : 'screenshots'),
    'Screenshot display type is invalid'
  );
  return rule.screenshots;
}

function coverage(document, rules) {
  const ios = document.sets.filter(set => set.platform === 'ios');
  if (ios.length > 0) {
    const required = rules.platforms.appStore.screenshots.requiredFamilies;
    assert(
      Array.isArray(required) &&
        required.includes('iphone') &&
        required.every(family => ['iphone', 'ipad'].includes(family)),
      'Apple required device coverage must be explicitly declared'
    );
  }
  for (const locale of new Set(ios.map(set => set.locale))) {
    const families = ios.filter(set => set.locale === locale).map(set => ruleFor(set, rules).family);
    for (const family of rules.platforms.appStore.screenshots.requiredFamilies ?? []) {
      assert(
        families.includes(family),
        `Apple ${locale} screenshot coverage is missing ${family === 'ipad' ? 'iPad' : 'iPhone'}`
      );
    }
  }
}

/** Read reviewed screenshot declarations, bind their files, and retain verified bytes for upload. */
export async function loadScreenshotManifest({
  root,
  manifestPath = 'store-listing/screenshots.json',
  rulesPath = 'store-listing/store-rules.json',
  asOf = new Date().toISOString().slice(0, 10)
}) {
  const canonicalRoot = await realpath(root);
  let manifestBytes;
  try {
    manifestBytes = await safeBytes(canonicalRoot, manifestPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const absent = new Error(`Screenshot manifest is missing: ${manifestPath}`);
      absent.code = 'SCREENSHOT_MANIFEST_MISSING';
      throw absent;
    }
    throw error;
  }
  const document = json(manifestBytes, 'Screenshot manifest');
  const rules = json(await safeBytes(canonicalRoot, rulesPath), 'Store rules');
  assert(rules.schemaVersion === 1, 'Store rule schemaVersion must be 1');
  validateRuleAge(rules, asOf);
  keys(document, ['schemaVersion', 'baselineVersion', 'capturedAt', 'sets', 'baselineSets'], 'Screenshot manifest');
  assert(document.schemaVersion === 1, 'Screenshot schemaVersion must be 1');
  assert(
    typeof document.baselineVersion === 'string' &&
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(document.baselineVersion),
    'Screenshot baseline version is invalid'
  );
  assert(
    typeof document.capturedAt === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(document.capturedAt) &&
      Number.isFinite(Date.parse(document.capturedAt)) &&
      new Date(document.capturedAt).toISOString().slice(0, 10) === document.capturedAt.slice(0, 10),
    'Screenshot capturedAt timestamp is invalid'
  );
  assert(Array.isArray(document.sets) && document.sets.length > 0, 'Screenshot groups must not be empty');
  const groups = new Set();
  const files = new Set();
  for (const set of document.sets) {
    keys(set, ['platform', 'storeId', 'locale', 'displayType', 'images'], 'Screenshot group');
    const rule = ruleFor(set, rules);
    const group = JSON.stringify([set.platform, set.storeId, set.locale, set.displayType]);
    assert(!groups.has(group), 'Screenshot groups must be unique');
    groups.add(group);
    assert(
      Array.isArray(set.images) && set.images.length >= rule.min && set.images.length <= rule.max,
      `Screenshot count is outside ${rule.min}-${rule.max}`
    );
    for (const image of set.images) {
      keys(image, ['path', 'sha256', 'size', 'width', 'height', 'format', 'source'], 'Screenshot image');
      assert(!files.has(image.path), 'Screenshot paths must be unique');
      files.add(image.path);
      assert(typeof image.sha256 === 'string' && /^[a-f0-9]{64}$/.test(image.sha256), 'Screenshot SHA256 is invalid');
      assert(Number.isSafeInteger(image.size) && image.size > 0, 'Screenshot byte size is invalid');
      assert(
        Number.isSafeInteger(image.width) && image.width > 0 && Number.isSafeInteger(image.height) && image.height > 0,
        'Screenshot dimensions are invalid'
      );
      assert(rule.formats?.includes(image.format), 'Screenshot format is unsupported');
      validateScreenshotDimensions({ ...image, id: image.path }, rule);
      const bytes = await safeBytes(canonicalRoot, image.path);
      assert(bytes.length === image.size, `Screenshot byte size mismatch: ${image.path}`);
      assert(sha256(bytes) === image.sha256, `Screenshot SHA256 mismatch: ${image.path}`);
      if (rule.maxBytes !== undefined) assert(bytes.length <= rule.maxBytes, 'Screenshot exceeds maximum byte size');
      validateSource(image.source, bytes, image.sha256);
      Object.defineProperty(image, 'bytes', { value: bytes });
    }
  }
  if (document.baselineSets !== undefined) {
    assert(Array.isArray(document.baselineSets), 'Screenshot baselineSets must be an array');
    const baselines = new Set();
    for (const set of document.baselineSets) {
      keys(set, ['platform', 'storeId', 'locale', 'displayType', 'images'], 'Screenshot baseline group');
      const rule = ruleFor(set, rules);
      const group = JSON.stringify([set.platform, set.storeId, set.locale, set.displayType]);
      assert(!baselines.has(group), 'Screenshot baseline groups must be unique');
      baselines.add(group);
      assert(Array.isArray(set.images) && set.images.length <= rule.max, 'Screenshot baseline image count is invalid');
      for (const image of set.images) {
        keys(image, ['checksum', 'assetId'], 'Screenshot baseline image');
        keys(image.checksum, ['algorithm', 'value'], 'Screenshot baseline checksum');
        const { algorithm, value } = image.checksum;
        assert(
          ['md5', 'sha256'].includes(algorithm) &&
            typeof value === 'string' &&
            new RegExp(`^[a-f0-9]{${algorithm === 'md5' ? 32 : 64}}$`).test(value),
          'Screenshot baseline checksum is invalid'
        );
        if (image.assetId !== undefined)
          assert(
            typeof image.assetId === 'string' && image.assetId.length > 0,
            'Screenshot baseline assetId is invalid'
          );
      }
    }
  }
  coverage(document, rules);
  Object.defineProperties(document, {
    manifestSha256: { value: sha256(manifestBytes) },
    manifestPath: { value: manifestPath },
    root: { value: canonicalRoot },
    rules: { value: rules }
  });
  return document;
}

/** Decode the already-hashed bytes and check technical eligibility without changing any image. */
export async function validateScreenshotManifest(options) {
  const document = await loadScreenshotManifest(options);
  const inspectImage =
    options.inspectImage ??
    (async (_file, bytes) => {
      const { default: sharp } = await import('sharp');
      const image = sharp(bytes, { failOn: 'warning' });
      const metadata = await image.metadata();
      await image.stats();
      return metadata;
    });
  for (const set of document.sets) {
    const rule = ruleFor(set, document.rules);
    for (const image of set.images) {
      const actual = await inspectImage(path.join(document.root, image.path), image.bytes);
      assert(
        actual?.width === image.width && actual?.height === image.height,
        `Screenshot decoded dimensions mismatch: ${image.path}`
      );
      assert(
        actual.format === image.format && rule.formats.includes(actual.format),
        'Screenshot decoded format mismatch'
      );
      assert(actual.hasAlpha === false || rule.alphaAllowed === true, 'Screenshot must not have an alpha channel');
      assert(rule.colorSpaces?.includes(actual.space), 'Screenshot color space is unsupported');
      assert(rule.depths?.includes(actual.depth), 'Screenshot color depth is unsupported');
    }
  }
  return document;
}

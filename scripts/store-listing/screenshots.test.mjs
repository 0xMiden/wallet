import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { loadScreenshotManifest, validateScreenshotManifest } from './screenshots.mjs';

const rulesFile = new URL('../../store-listing/store-rules.json', import.meta.url);
function crc32(data) {
  let crc = -1;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
function png(width = 640, height = 400) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
const jpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==',
  'base64'
);
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'wallet-screenshots-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'store-listing/assets'), { recursive: true });
  const rules = JSON.parse(await readFile(rulesFile, 'utf8'));
  await writeFile(path.join(root, 'store-listing/store-rules.json'), JSON.stringify(rules));
  const bytes = png();
  const image = {
    path: 'store-listing/assets/01.png',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    width: 640,
    height: 400,
    format: 'png',
    source: {
      assetId: 'original-1',
      checksum: { algorithm: 'md5', value: createHash('md5').update(bytes).digest('hex') },
      url: 'https://example.com/image.png'
    }
  };
  await writeFile(path.join(root, image.path), bytes);
  const doc = {
    schemaVersion: 1,
    baselineVersion: '1.17.7',
    capturedAt: '2026-10-25T10:00:00Z',
    sets: [
      {
        platform: 'chrome',
        storeId: 'coajhopfooegmaifelglfboehacldcbo',
        locale: 'en-US',
        displayType: 'screenshots',
        images: [image]
      }
    ]
  };
  const options = { root, asOf: '2026-10-25' };
  const save = () => writeFile(path.join(root, 'store-listing/screenshots.json'), JSON.stringify(doc));
  await save();
  const inspectImage = async () => ({
    width: 640,
    height: 400,
    format: 'png',
    hasAlpha: false,
    space: 'srgb',
    depth: 'uchar'
  });
  return { root, rules, bytes, image, doc, options, save, inspectImage };
}

test('loads ordered imported baseline without generated scene or marketing metadata', async t => {
  const f = await fixture(t);
  assert.deepEqual(await loadScreenshotManifest(f.options), f.doc);
});
test('actual PNG fixture is inspected once and technical metadata is verified', async t => {
  const f = await fixture(t);
  let calls = 0;
  const result = await validateScreenshotManifest({
    ...f.options,
    inspectImage: async file => {
      calls++;
      assert.equal(file, path.join(f.root, f.image.path));
      const bytes = await readFile(file);
      assert.equal(bytes.readUInt32BE(16), 640);
      assert.equal(bytes.readUInt32BE(20), 400);
      return f.inspectImage();
    }
  });
  assert.deepEqual(result, f.doc);
  assert.equal(calls, 1);
});
test('SHA256, original source checksums and byte sizes are bound to actual file bytes', async t => {
  for (const kind of ['sha256', 'size', 'source']) {
    const f = await fixture(t);
    const change = {
      sha256: { sha256: 'a'.repeat(64) },
      size: { size: f.image.size + 1 },
      source: { source: { checksum: { algorithm: 'md5', value: 'b'.repeat(32) } } }
    }[kind];
    Object.assign(f.image, change);
    await f.save();
    await assert.rejects(loadScreenshotManifest(f.options), /sha256|checksum|size/i);
  }
});
test('rejects invalid schema, timestamp, baseline and unknown store targets', async t => {
  for (const mutation of [
    doc => {
      doc.schemaVersion = 2;
    },
    doc => {
      doc.capturedAt = 'yesterday';
    },
    doc => {
      doc.baselineVersion = 'latest';
    },
    doc => {
      doc.sets[0].storeId = 'other-app';
    },
    doc => {
      doc.sets[0].locale = '../en-US';
    },
    doc => {
      doc.sets[0].displayType = 'icon';
    }
  ]) {
    const f = await fixture(t);
    mutation(f.doc);
    await f.save();
    await assert.rejects(loadScreenshotManifest(f.options), /schema|timestamp|captured|version|target|locale|display/i);
  }
});
test('rejects empty groups, excessive screenshot counts, duplicate groups and repeated image paths', async t => {
  for (const mutation of [
    doc => {
      doc.sets[0].images = [];
    },
    doc => {
      doc.sets[0].images = Array(6).fill(doc.sets[0].images[0]);
    },
    doc => {
      doc.sets.push(structuredClone(doc.sets[0]));
    },
    doc => {
      doc.sets[0].images.push(structuredClone(doc.sets[0].images[0]));
    }
  ]) {
    const f = await fixture(t);
    mutation(f.doc);
    await f.save();
    await assert.rejects(loadScreenshotManifest(f.options), /count|duplicate|unique|empty/i);
  }
});
test('rejects absolute, traversal and symlinked file or ancestor paths', async t => {
  const f = await fixture(t);
  for (const value of [
    '/tmp/private.png',
    '../private.png',
    'store-listing/assets/../assets/01.png',
    'store-listing\\assets\\01.png'
  ]) {
    f.image.path = value;
    await f.save();
    await assert.rejects(loadScreenshotManifest(f.options), /path|root|relative/i);
  }
  f.image.path = 'store-listing/assets/link.png';
  await symlink('01.png', path.join(f.root, f.image.path));
  await f.save();
  await assert.rejects(loadScreenshotManifest(f.options), /symlink/i);
  await symlink('assets', path.join(f.root, 'store-listing/link'));
  f.image.path = 'store-listing/link/01.png';
  await f.save();
  await assert.rejects(loadScreenshotManifest(f.options), /symlink/i);
});
test('rejects decoded dimensions, format, alpha and color depth that differ from technical rules', async t => {
  const f = await fixture(t);
  for (const changed of [
    { width: 639 },
    { height: 399 },
    { format: 'webp' },
    { hasAlpha: true },
    { space: 'cmyk' },
    { depth: 'float' }
  ]) {
    await assert.rejects(
      validateScreenshotManifest({
        ...f.options,
        inspectImage: async () => ({ ...(await f.inspectImage()), ...changed })
      }),
      /dimensions|format|alpha|color|depth/i
    );
  }
});
test('Chrome accepts the 16-bit RGB PNGs its listing serves while Google Play keeps 24-bit PNG', async t => {
  const f = await fixture(t);
  const deep = { space: 'rgb16', depth: 'ushort' };
  const inspectImage = async () => ({ ...(await f.inspectImage()), ...deep });
  await validateScreenshotManifest({ ...f.options, inspectImage });
  const set = f.doc.sets[0];
  Object.assign(set, { platform: 'android', storeId: 'com.miden.wallet', displayType: 'phoneScreenshots' });
  const bytes = png(1080, 2160);
  Object.assign(f.image, {
    width: 1080,
    height: 2160,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  });
  delete f.image.source;
  await writeFile(path.join(f.root, f.image.path), bytes);
  const second = { ...f.image, path: 'store-listing/assets/02.png' };
  await writeFile(path.join(f.root, second.path), bytes);
  set.images.push(second);
  await f.save();
  const android = async () => ({ ...(await f.inspectImage()), width: 1080, height: 2160 });
  await validateScreenshotManifest({ ...f.options, inspectImage: android });
  await assert.rejects(
    validateScreenshotManifest({ ...f.options, inspectImage: async () => ({ ...(await android()), ...deep }) }),
    /color space/i
  );
});
test('rejects technical dimension and format claims even if hashes match', async t => {
  for (const change of [{ width: 641 }, { format: 'webp' }, { size: 0 }, { sha256: 'invalid' }]) {
    const f = await fixture(t);
    Object.assign(f.image, change);
    await f.save();
    await assert.rejects(loadScreenshotManifest(f.options), /dimension|format|size|sha256/i);
  }
});
test('rules must be current and first-party sources remain declared', async t => {
  const f = await fixture(t);
  await assert.rejects(loadScreenshotManifest({ ...f.options, asOf: '2028-01-01' }), /stale/i);
  f.rules.platforms.chromeWebStore.sources = [];
  await writeFile(path.join(f.root, 'store-listing/store-rules.json'), JSON.stringify(f.rules));
  await assert.rejects(loadScreenshotManifest(f.options), /source/i);
});
test('Apple baseline requires explicitly configured device coverage without inventing missing iPad assets', async t => {
  const f = await fixture(t);
  const set = f.doc.sets[0];
  Object.assign(set, { platform: 'ios', storeId: '6789341854', displayType: 'APP_IPHONE_67' });
  Object.assign(f.image, { width: 1290, height: 2796 });
  await f.save();
  assert.deepEqual(await loadScreenshotManifest(f.options), f.doc);
  f.rules.platforms.appStore.screenshots.requiredFamilies = ['iphone', 'ipad'];
  await writeFile(path.join(f.root, 'store-listing/store-rules.json'), JSON.stringify(f.rules));
  await assert.rejects(loadScreenshotManifest(f.options), /iPad|coverage/i);
});
test('Android phone screenshots need two eligible images without promotional story constraints', async t => {
  const f = await fixture(t);
  const set = f.doc.sets[0];
  Object.assign(set, { platform: 'android', storeId: 'com.miden.wallet', displayType: 'phoneScreenshots' });
  Object.assign(f.image, { width: 1080, height: 1920 });
  await f.save();
  await assert.rejects(loadScreenshotManifest(f.options), /count/i);
  const second = { ...f.image, path: 'store-listing/assets/02.png' };
  await writeFile(path.join(f.root, second.path), f.bytes);
  set.images.push(second);
  await f.save();
  assert.deepEqual(await loadScreenshotManifest(f.options), f.doc);
});
test('JPEG declarations use decoded format and preserve original file bytes', async t => {
  const f = await fixture(t);
  f.image.path = 'store-listing/assets/01.jpg';
  f.image.format = 'jpeg';
  f.image.size = jpeg.length;
  f.image.sha256 = createHash('sha256').update(jpeg).digest('hex');
  delete f.image.source;
  await writeFile(path.join(f.root, f.image.path), jpeg);
  await f.save();
  assert.deepEqual(
    await validateScreenshotManifest({
      ...f.options,
      inspectImage: async file => {
        const bytes = await readFile(file);
        assert.equal(bytes.readUInt16BE(0), 0xffd8);
        assert.equal(bytes.readUInt16BE(bytes.length - 2), 0xffd9);
        return { ...(await f.inspectImage()), format: 'jpeg' };
      }
    }),
    f.doc
  );
  assert.deepEqual(await readFile(path.join(f.root, f.image.path)), jpeg);
});

test('held image bytes and manifest digest bind subsequent uploads without rereading mutable paths', async t => {
  const f = await fixture(t);
  const doc = await loadScreenshotManifest(f.options);
  assert.deepEqual(doc.sets[0].images[0].bytes, f.bytes);
  assert.equal(
    doc.manifestSha256,
    createHash('sha256')
      .update(await readFile(path.join(f.root, 'store-listing/screenshots.json')))
      .digest('hex')
  );
  await writeFile(path.join(f.root, f.image.path), Buffer.from('changed after validation'));
  assert.deepEqual(doc.sets[0].images[0].bytes, f.bytes);
  assert.equal(JSON.stringify(doc), JSON.stringify(f.doc));
});
test('only a missing manifest has the explicit legacy-preservation error code', async t => {
  const f = await fixture(t);
  await rm(path.join(f.root, 'store-listing/screenshots.json'));
  await assert.rejects(loadScreenshotManifest(f.options), error => error.code === 'SCREENSHOT_MANIFEST_MISSING');
  await f.save();
  await rm(path.join(f.root, f.image.path));
  await assert.rejects(loadScreenshotManifest(f.options), error => error.code !== 'SCREENSHOT_MANIFEST_MISSING');
});
test('manifest and rules themselves cannot be symlinked outside the source checkout', async t => {
  const f = await fixture(t);
  await symlink('screenshots.json', path.join(f.root, 'store-listing/linked.json'));
  await assert.rejects(loadScreenshotManifest({ ...f.options, manifestPath: 'store-listing/linked.json' }), /symlink/i);
  await symlink('store-rules.json', path.join(f.root, 'store-listing/linked-rules.json'));
  await assert.rejects(
    loadScreenshotManifest({ ...f.options, rulesPath: 'store-listing/linked-rules.json' }),
    /symlink/i
  );
});

test('CDN re-encoding keeps original source checksum only with an exact verified import SHA256', async t => {
  const f = await fixture(t);
  f.image.source.checksum.value = 'a'.repeat(32);
  f.image.source.importSha256 = f.image.sha256;
  await f.save();
  assert.deepEqual(await loadScreenshotManifest(f.options), f.doc);
  f.image.source.importSha256 = 'b'.repeat(64);
  await f.save();
  await assert.rejects(loadScreenshotManifest(f.options), /import.*sha256/i);
});

test('source provenance distinguishes original uploads from explicitly hashed delivery renditions', async t => {
  const f = await fixture(t);
  f.image.source.fileName = 'original-store-upload.png';
  f.image.source.kind = 'original-upload';
  await f.save();
  assert.deepEqual(await loadScreenshotManifest(f.options), f.doc);
  f.image.source.kind = 'store-delivery-rendition';
  await f.save();
  await assert.rejects(loadScreenshotManifest(f.options), /rendition|import.*sha256/i);
  f.image.source.importSha256 = f.image.sha256;
  await f.save();
  assert.deepEqual(await loadScreenshotManifest(f.options), f.doc);
  f.image.source.kind = 'unknown';
  await f.save();
  await assert.rejects(loadScreenshotManifest(f.options), /kind/i);
});
test('optional baseline groups pin remote screenshot checksums and exact store targets', async t => {
  const f = await fixture(t);
  const { images, ...group } = f.doc.sets[0];
  f.doc.baselineSets = [{ ...group, images: [{ checksum: { algorithm: 'md5', value: 'a'.repeat(32) } }] }];
  await f.save();
  assert.deepEqual(await loadScreenshotManifest(f.options), f.doc);
  f.doc.baselineSets[0].storeId = 'wrong-store';
  await f.save();
  await assert.rejects(loadScreenshotManifest(f.options), /target/i);
});
test('Android phone image byte limit follows the verified console 8MiB ceiling', async t => {
  const f = await fixture(t);
  assert.equal(f.rules.platforms.playStore.screenshots.maxBytes, 8 * 1024 * 1024);
  const set = f.doc.sets[0];
  Object.assign(set, { platform: 'android', storeId: 'com.miden.wallet', displayType: 'phoneScreenshots' });
  const oversized = Buffer.alloc(8 * 1024 * 1024 + 1);
  Object.assign(f.image, {
    width: 1080,
    height: 2160,
    size: oversized.length,
    sha256: createHash('sha256').update(oversized).digest('hex')
  });
  delete f.image.source;
  await writeFile(path.join(f.root, f.image.path), oversized);
  const second = { ...f.image, path: 'store-listing/assets/02.png' };
  await writeFile(path.join(f.root, second.path), oversized);
  set.images.push(second);
  await f.save();
  await assert.rejects(loadScreenshotManifest(f.options), /maximum.*byte|byte.*limit/i);
});

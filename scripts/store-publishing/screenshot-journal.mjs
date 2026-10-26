const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const hex = (value, size) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
const fail = () => {
  throw new Error('Invalid or mismatched iOS screenshot journal');
};
function keys(value, allowed) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !allowed.includes(key))
  )
    fail();
}
function images(value) {
  if (!Array.isArray(value) || value.length > 10) fail();
  const seen = new Set();
  for (const image of value) {
    keys(image, ['assetId', 'state', 'checksum', 'fileName', 'fileSize']);
    if (
      !identifier(image.assetId) ||
      seen.has(image.assetId) ||
      !['COMPLETE', 'FAILED', 'AWAITING_UPLOAD', 'UPLOAD_COMPLETE'].includes(image.state)
    )
      fail();
    seen.add(image.assetId);
    if (image.checksum !== undefined) {
      keys(image.checksum, ['algorithm', 'value']);
      if (image.checksum.algorithm !== 'md5' || !hex(image.checksum.value, 32)) fail();
    }
    if (
      image.fileName !== undefined &&
      (typeof image.fileName !== 'string' || !/^([\p{L}\p{N} _.()@+-]){1,250}$/u.test(image.fileName))
    )
      fail();
    if (image.fileSize !== undefined && (!Number.isSafeInteger(image.fileSize) || image.fileSize < 1)) fail();
  }
}

export function screenshotJournalName(options) {
  if (!/^\d+$/.test(options.appId ?? '') || !/^\d+\.\d+\.\d+$/.test(options.version ?? '')) fail();
  return `ios-${options.appId}-${options.version}-screenshots.json`;
}

export function validateScreenshotJournal(value, binding = {}) {
  keys(value, ['schemaVersion', 'binding', 'versionId', 'groups', 'pending']);
  const actual = value.binding;
  keys(actual, ['appId', 'bundleId', 'version', 'network', 'sourceSha', 'manifestSha256']);
  if (
    value.schemaVersion !== 1 ||
    !identifier(value.versionId) ||
    !/^\d+$/.test(actual.appId ?? '') ||
    !/^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$/.test(actual.bundleId ?? '') ||
    !/^\d+\.\d+\.\d+$/.test(actual.version ?? '') ||
    !['mainnet', 'testnet'].includes(actual.network) ||
    !hex(actual.sourceSha, 40) ||
    !hex(actual.manifestSha256, 64)
  )
    fail();
  for (const [key, expected] of Object.entries(binding)) if (actual[key] !== expected) fail();
  if (!Array.isArray(value.groups) || value.groups.length < 1 || value.groups.length > 100) fail();
  const seen = new Set();
  for (const group of value.groups) {
    keys(group, ['locale', 'displayType', 'localizationId', 'setId', 'desired', 'original', 'images', 'owned']);
    const key = `${group.locale}/${group.displayType}`;
    if (
      !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(group.locale ?? '') ||
      !/^APP_[A-Z0-9_]+$/.test(group.displayType ?? '') ||
      seen.has(key) ||
      !identifier(group.localizationId) ||
      !(group.setId === null || identifier(group.setId))
    )
      fail();
    seen.add(key);
    if (!Array.isArray(group.desired) || group.desired.length > 10 || group.desired.some(x => !hex(x, 64))) fail();
    images(group.original);
    images(group.images);
    if (!Array.isArray(group.owned) || group.owned.length > 10) fail();
    const owned = new Set();
    for (const item of group.owned) {
      keys(item, ['assetId', 'imageIndex']);
      if (
        !identifier(item.assetId) ||
        owned.has(item.assetId) ||
        !group.images.some(x => x.assetId === item.assetId) ||
        !Number.isInteger(item.imageIndex) ||
        item.imageIndex < 0 ||
        item.imageIndex >= group.desired.length
      )
        fail();
      owned.add(item.assetId);
    }
  }
  if (value.pending !== null) {
    const pending = value.pending;
    keys(pending, ['kind', 'group', 'assetId', 'imageIndex', 'fileName', 'fileSize', 'order']);
    if (!Number.isInteger(pending.group) || !value.groups[pending.group]) fail();
    const group = value.groups[pending.group];
    if (!['reserve', 'delete', 'order', 'create-set', 'complete'].includes(pending.kind)) fail();
    const fields = {
      reserve: ['imageIndex', 'fileName', 'fileSize'],
      delete: ['assetId'],
      order: ['order'],
      'create-set': [],
      complete: ['assetId']
    };
    keys(pending, ['kind', 'group', ...fields[pending.kind]]);
    if (pending.kind === 'create-set' && group.setId !== null) fail();
    if (pending.kind === 'complete' && !group.owned.some(item => item.assetId === pending.assetId)) fail();
    if (['delete', 'complete'].includes(pending.kind) && !group.images.some(x => x.assetId === pending.assetId)) fail();
    if (
      pending.kind === 'reserve' &&
      (!Number.isInteger(pending.imageIndex) ||
        !group.desired[pending.imageIndex] ||
        !/^bread-[a-f0-9]{40}-[a-f0-9]{64}-[0-9]+\.png$/.test(pending.fileName ?? '') ||
        !Number.isSafeInteger(pending.fileSize) ||
        pending.fileSize < 1)
    )
      fail();
    if (
      pending.kind === 'order' &&
      (!Array.isArray(pending.order) ||
        pending.order.length !== group.images.length ||
        new Set(pending.order).size !== pending.order.length ||
        pending.order.some(x => !group.images.some(image => image.assetId === x)))
    )
      fail();
  }
  return structuredClone(value);
}

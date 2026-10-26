import { createHash } from 'node:crypto';
import { basename } from 'node:path';

class ScreenshotError extends Error {}

const appleOrigin = 'https://api.appstoreconnect.apple.com';
const screenshotTypes = [
  'phoneScreenshots',
  'sevenInchScreenshots',
  'tenInchScreenshots',
  'tvScreenshots',
  'wearScreenshots'
];
const draftStates = new Set([
  'PREPARE_FOR_SUBMISSION',
  'INVALID_BINARY',
  'REJECTED',
  'METADATA_REJECTED',
  'DEVELOPER_REJECTED'
]);
// Apple processing can take minutes; 5 s spacing keeps an hour-long wait well inside the hourly API quota.
const applePollMs = 5000;
const applePollsDefault = 120;
const applePollsMax = 720;
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const groupKey = set => `${set.locale}/${set.displayType}`;
const encode = value => encodeURIComponent(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);

function target(options) {
  if (options?.platform === 'ios') {
    if (
      !/^\d+$/.test(options.appId ?? '') ||
      !/^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$/.test(options.bundleId ?? '') ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(options.version ?? '')
    ) {
      throw new ScreenshotError('An exact Apple identity and stable version are required for screenshots');
    }
    return { platform: 'ios', storeId: options.appId, version: options.version };
  }
  if (options?.platform === 'android') {
    if (!/^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/.test(options.packageName ?? '') || !id(options.editId)) {
      throw new ScreenshotError('An exact Android identity and caller-owned editId are required for screenshots');
    }
    return { platform: 'android', storeId: options.packageName, version: options.version };
  }
  if (options?.platform === 'chrome' && /^[a-p]{32}$/.test(options.itemId ?? '') && id(options.publisherId)) {
    return { platform: 'chrome', storeId: options.itemId, version: options.version };
  }
  throw new ScreenshotError('Unsupported screenshot platform or target identity');
}

function checksum(value) {
  if (
    !value ||
    !['md5', 'sha256'].includes(value.algorithm) ||
    typeof value.value !== 'string' ||
    !(value.algorithm === 'md5' ? /^[a-f0-9]{32}$/i : /^[a-f0-9]{64}$/i).test(value.value)
  ) {
    throw new ScreenshotError('Screenshot checksum is missing or malformed');
  }
  return { algorithm: value.algorithm, value: value.value.toLowerCase() };
}

function groups(sets, selected, withBytes) {
  if (!Array.isArray(sets) || sets.length === 0 || sets.length > 100)
    throw new ScreenshotError('Explicit managed screenshot sets are required');
  const seen = new Set();
  return sets.map(set => {
    if (
      !set ||
      (set.platform !== undefined && set.platform !== selected.platform) ||
      (set.storeId !== undefined && set.storeId !== selected.storeId) ||
      !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(set.locale ?? '') ||
      !(selected.platform === 'ios'
        ? /^APP_[A-Z0-9_]+$/.test(set.displayType ?? '')
        : screenshotTypes.includes(set.displayType)) ||
      !Array.isArray(set.images) ||
      set.images.length > (selected.platform === 'ios' ? 10 : 8)
    ) {
      throw new ScreenshotError('A managed screenshot set has invalid identity, locale, display type or count');
    }
    const key = groupKey(set);
    if (seen.has(key)) throw new ScreenshotError('Duplicate managed screenshot group');
    seen.add(key);
    return {
      ...set,
      images: set.images.map(image => {
        if (!withBytes) return { ...image, checksum: checksum(image.checksum) };
        if (
          !(image.bytes instanceof Uint8Array) ||
          image.bytes.byteLength < 1 ||
          image.size !== image.bytes.byteLength ||
          !/^[a-f0-9]{64}$/i.test(image.sha256 ?? '') ||
          !['png', 'jpeg'].includes(image.format) ||
          typeof image.path !== 'string' ||
          image.path.length === 0
        ) {
          throw new ScreenshotError('Screenshot bytes, size, hash or format are invalid');
        }
        const bytes = Buffer.from(image.bytes);
        const sha256 = hash('sha256', bytes);
        if (sha256 !== image.sha256.toLowerCase())
          throw new ScreenshotError('Screenshot bytes do not match their approved SHA256 hash');
        return {
          ...image,
          bytes,
          sha256,
          md5: hash('md5', bytes),
          source: image.source
            ? { ...image.source, checksum: image.source.checksum ? checksum(image.source.checksum) : undefined }
            : undefined
        };
      })
    };
  });
}

async function pages(client, path, type) {
  const result = [];
  const pathname = new URL(path, appleOrigin).pathname;
  const seen = new Set();
  while (path) {
    if (seen.has(path) || seen.size >= 20) throw new ScreenshotError('Screenshot pagination is incomplete');
    seen.add(path);
    const response = await client.request('GET', path);
    if (!Array.isArray(response?.data) || response.data.some(item => item?.type !== type || !id(item.id))) {
      throw new ScreenshotError('Screenshot API returned an unexpected resource identity');
    }
    result.push(...response.data);
    if (response.links?.next) {
      const next = new URL(response.links.next, appleOrigin);
      if (next.origin !== appleOrigin || next.pathname !== pathname || next.username || next.password || next.hash) {
        throw new ScreenshotError('Screenshot pagination leaves the selected resource');
      }
      path = next.pathname + next.search;
    } else path = undefined;
  }
  if (new Set(result.map(item => item.id)).size !== result.length)
    throw new ScreenshotError('Duplicate screenshot resource identity');
  return result;
}

function appleImage(resource) {
  if (resource?.type !== 'appScreenshots' || !id(resource.id) || !resource.attributes)
    throw new ScreenshotError('Invalid Apple screenshot identity');
  const attributes = resource.attributes;
  const imageAsset = attributes.imageAsset;
  let url;
  if (imageAsset?.templateUrl) {
    const candidate = new URL(
      imageAsset.templateUrl
        .replaceAll('{w}', String(imageAsset.width))
        .replaceAll('{h}', String(imageAsset.height))
        .replaceAll('{f}', 'png')
    );
    if (
      candidate.protocol !== 'https:' ||
      !candidate.hostname.endsWith('.mzstatic.com') ||
      candidate.username ||
      candidate.password
    ) {
      throw new ScreenshotError('Invalid Apple screenshot image origin');
    }
    url = candidate.href;
  }
  return {
    assetId: resource.id,
    ...(attributes.sourceFileChecksum
      ? { checksum: checksum({ algorithm: 'md5', value: attributes.sourceFileChecksum }) }
      : {}),
    state: attributes.assetDeliveryState?.state,
    ...(url ? { url, width: imageAsset.width, height: imageAsset.height } : {})
  };
}

function playImage(image) {
  if (!image || !id(image.id)) throw new ScreenshotError('Invalid Android screenshot identity');
  return {
    assetId: image.id,
    checksum: checksum({ algorithm: 'sha256', value: image.sha256 }),
    ...(image.url ? { url: image.url } : {})
  };
}

function playPath(options, set) {
  return (
    `/androidpublisher/v3/applications/${encode(options.packageName)}/edits/${encode(options.editId)}/listings` +
    (set ? `/${encode(set.locale)}/${encode(set.displayType)}` : '')
  );
}

function chromeResult(selected, sets = []) {
  return {
    ...selected,
    consoleRequired: true,
    changed: false,
    matches: false,
    actionRequired: 'Use the authenticated Chrome Web Store developer console screenshot editor',
    assets: sets.flatMap(set =>
      (set.images ?? []).map(image => ({
        locale: set.locale,
        displayType: set.displayType,
        path: image.path,
        sha256: image.sha256
      }))
    )
  };
}

/** Read ordered store screenshots without creating edits, localizations, versions or assets. */
export async function inventoryScreenshots(client, options) {
  const selected = target(options);
  if (selected.platform === 'chrome') return chromeResult(selected, options.sets);
  if (selected.platform === 'android') {
    const response = await client.request('GET', playPath(options));
    if (
      !Array.isArray(response?.listings) ||
      response.listings.some(item => !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(item.language ?? ''))
    ) {
      throw new ScreenshotError('Android listing locales are unavailable');
    }
    const locales = response.listings.map(item => item.language);
    if (new Set(locales).size !== locales.length) throw new ScreenshotError('Duplicate Android listing locale');
    const sets = [];
    for (const locale of locales) {
      for (const displayType of screenshotTypes) {
        const set = { ...selected, locale, displayType };
        const response = await client.request('GET', playPath(options, set));
        if (response?.images !== undefined && !Array.isArray(response.images))
          throw new ScreenshotError('Invalid Android screenshot inventory');
        const images = (response.images ?? []).map(playImage);
        if (images.length) sets.push({ ...set, images });
      }
    }
    return { ...selected, sets, localizations: locales.map(locale => ({ locale })) };
  }
  const { data: app } = await client.request('GET', `/v1/apps/${encode(options.appId)}`);
  if (app?.type !== 'apps' || app.id !== options.appId || app.attributes?.bundleId !== options.bundleId) {
    throw new ScreenshotError('Apple screenshot app identity does not match');
  }
  const versions = await pages(
    client,
    `/v1/apps/${encode(options.appId)}/appStoreVersions?filter%5Bplatform%5D=IOS&filter%5BversionString%5D=${encode(options.version)}&limit=200`,
    'appStoreVersions'
  );
  const matches = versions.filter(
    item => item.attributes?.versionString === options.version && item.attributes?.platform === 'IOS'
  );
  if (matches.length !== 1) throw new ScreenshotError('The requested Apple screenshot version is missing or ambiguous');
  const version = matches[0];
  const locales = await pages(
    client,
    `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=200`,
    'appStoreVersionLocalizations'
  );
  const sets = [];
  const localizations = [];
  for (const localization of locales) {
    const locale = localization.attributes?.locale;
    if (
      !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale ?? '') ||
      localizations.some(item => item.locale === locale)
    ) {
      throw new ScreenshotError('Invalid or duplicate Apple screenshot locale');
    }
    localizations.push({ locale, id: localization.id });
    const entries = await pages(
      client,
      `/v1/appStoreVersionLocalizations/${localization.id}/appScreenshotSets?limit=200`,
      'appScreenshotSets'
    );
    for (const entry of entries) {
      const displayType = entry.attributes?.screenshotDisplayType;
      if (
        !/^APP_[A-Z0-9_]+$/.test(displayType ?? '') ||
        sets.some(set => set.locale === locale && set.displayType === displayType)
      ) {
        throw new ScreenshotError('Invalid or duplicate Apple screenshot display group');
      }
      const screenshots = await pages(
        client,
        `/v1/appScreenshotSets/${entry.id}/appScreenshots?limit=200`,
        'appScreenshots'
      );
      sets.push({
        ...selected,
        locale,
        displayType,
        setId: entry.id,
        localizationId: localization.id,
        images: screenshots.map(appleImage)
      });
    }
  }
  return { ...selected, versionId: version.id, state: version.attributes?.appStoreState, sets, localizations };
}

function sameImage(actual, desired) {
  if (actual.state !== undefined && actual.state !== 'COMPLETE') return false;
  if (!actual.checksum) return false;
  if (actual.checksum.value === desired[actual.checksum.algorithm]) return true;
  // CDN processing can change file bytes. Only the immutable import hash binds original-store provenance to this local file.
  return (
    desired.source?.importSha256 === desired.sha256 &&
    desired.source?.checksum?.algorithm === actual.checksum.algorithm &&
    desired.source.checksum.value === actual.checksum.value
  );
}

function sameSet(actual, desired) {
  return (
    (actual?.images.length ?? 0) === desired.images.length &&
    desired.images.every((image, index) => sameImage(actual.images[index], image))
  );
}

function differences(inventory, desired) {
  return desired
    .filter(
      set =>
        !sameSet(
          inventory.sets.find(actual => groupKey(actual) === groupKey(set)),
          set
        )
    )
    .map(set => ({
      locale: set.locale,
      displayType: set.displayType,
      reason: 'Ordered complete screenshot set differs or is not fully processed'
    }));
}

/** Verify every managed group; unrelated store groups remain outside mutation scope. */
export async function verifyScreenshots(client, options) {
  const selected = target(options);
  if (selected.platform === 'chrome') return chromeResult(selected, options.sets);
  const desired = groups(options.sets, selected, true);
  const inventory = await inventoryScreenshots(client, options);
  const diff = differences(inventory, desired);
  return { ...selected, matches: diff.length === 0, differences: diff, inventory };
}

function approvedBaseline(actual, baseline) {
  return (
    baseline &&
    actual.images.length === baseline.images.length &&
    actual.images.every(
      (image, index) =>
        image.checksum &&
        image.checksum.algorithm === baseline.images[index].checksum.algorithm &&
        image.checksum.value === baseline.images[index].checksum.value &&
        (image.state === undefined || image.state === 'COMPLETE')
    )
  );
}

function appleOperations(operations, length) {
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > 100)
    throw new ScreenshotError('Invalid Apple screenshot upload operations');
  const sorted = operations
    .map(operation => {
      const url = new URL(operation.url);
      if (
        operation.method !== 'PUT' ||
        url.protocol !== 'https:' ||
        !url.hostname.endsWith('.apple.com') ||
        url.username ||
        url.password ||
        url.hash
      ) {
        throw new ScreenshotError('Untrusted Apple screenshot upload operation origin');
      }
      const headers = {};
      if (!Array.isArray(operation.requestHeaders ?? []))
        throw new ScreenshotError('Invalid Apple upload operation headers');
      for (const header of operation.requestHeaders ?? []) {
        if (
          typeof header.name !== 'string' ||
          typeof header.value !== 'string' ||
          !/^[A-Za-z0-9-]+$/.test(header.name) ||
          /[\r\n]/.test(header.value) ||
          /^(authorization|proxy-authorization|cookie|host|connection|transfer-encoding)$/i.test(header.name)
        ) {
          throw new ScreenshotError('Credential-bearing or invalid Apple upload operation header');
        }
        if (Object.keys(headers).some(name => name.toLowerCase() === header.name.toLowerCase()))
          throw new ScreenshotError('Duplicate Apple upload header');
        headers[header.name] = header.value;
      }
      return { ...operation, url: url.href, headers };
    })
    .sort((left, right) => left.offset - right.offset);
  let offset = 0;
  for (const operation of sorted) {
    if (
      !Number.isSafeInteger(operation.offset) ||
      !Number.isSafeInteger(operation.length) ||
      operation.offset !== offset ||
      operation.length <= 0 ||
      operation.length > length - offset
    ) {
      throw new ScreenshotError('Apple upload operation byte ranges do not cover the exact file');
    }
    offset += operation.length;
  }
  if (offset !== length) throw new ScreenshotError('Apple upload operation byte ranges are incomplete');
  return sorted;
}

async function uploadApple(client, options, setId, image) {
  const { data: reserved } = await client.request('POST', '/v1/appScreenshots', {
    body: {
      data: {
        type: 'appScreenshots',
        attributes: { fileName: basename(image.path), fileSize: image.bytes.length },
        relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } } }
      }
    }
  });
  if (reserved?.type !== 'appScreenshots' || !id(reserved.id))
    throw new ScreenshotError('Apple screenshot reservation identity is invalid');
  const operations = appleOperations(reserved.attributes?.uploadOperations, image.bytes.length);
  for (const operation of operations) {
    const response = await (options.fetchImpl ?? fetch)(operation.url, {
      method: 'PUT',
      headers: operation.headers,
      body: image.bytes.subarray(operation.offset, operation.offset + operation.length),
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(60000)
    });
    if (!response?.ok || response.redirected || (response.url && response.url !== operation.url)) {
      throw new ScreenshotError('Apple screenshot byte upload failed or redirected');
    }
  }
  await client.request('PATCH', `/v1/appScreenshots/${reserved.id}`, {
    body: {
      data: { type: 'appScreenshots', id: reserved.id, attributes: { uploaded: true, sourceFileChecksum: image.md5 } }
    }
  });
  const maxPolls = options.maxPolls ?? applePollsDefault;
  if (!Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > applePollsMax)
    throw new ScreenshotError('Screenshot processing poll bound is invalid');
  for (let poll = 0; poll < maxPolls; poll++) {
    const { data } = await client.request('GET', `/v1/appScreenshots/${reserved.id}`);
    const actual = appleImage(data);
    if (actual.assetId !== reserved.id)
      throw new ScreenshotError('Apple processing returned another screenshot identity');
    if (actual.state === 'COMPLETE') {
      if (!sameImage(actual, image)) throw new ScreenshotError('Apple processed screenshot checksum does not match');
      return actual;
    }
    if (actual.state === 'FAILED') throw new ScreenshotError('Apple screenshot processing FAILED');
    if (!['AWAITING_UPLOAD', 'UPLOAD_COMPLETE'].includes(actual.state))
      throw new ScreenshotError('Unknown Apple screenshot processing state');
    if (poll + 1 < maxPolls)
      await (options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(applePollMs);
  }
  throw new ScreenshotError('Apple screenshot processing timeout; inspect the reserved asset before another action');
}

/** Synchronize only approved managed groups; Android remains in the caller's uncommitted edit. */
export async function syncScreenshots(client, options) {
  const selected = target(options);
  if (options.allowWrites !== true)
    throw new ScreenshotError('Screenshot synchronization requires explicit allowWrites authorization');
  if (selected.platform === 'chrome') return chromeResult(selected, options.sets);
  const desired = groups(options.sets, selected, true);
  if (
    options.maxPolls !== undefined &&
    (!Number.isInteger(options.maxPolls) || options.maxPolls < 1 || options.maxPolls > applePollsMax)
  ) {
    throw new ScreenshotError('Screenshot processing poll bound is invalid');
  }
  const baseline = options.baselineSets?.length ? groups(options.baselineSets, selected, false) : [];
  const inventory = await inventoryScreenshots(client, options);
  if (selected.platform === 'ios' && !draftStates.has(inventory.state))
    throw new ScreenshotError('Apple screenshot version is not in an eligible editable draft state');
  const changed = desired.filter(
    set =>
      !sameSet(
        inventory.sets.find(actual => groupKey(actual) === groupKey(set)),
        set
      )
  );
  // Validate every group before the first write. Fresh inventory never authorizes destructive drift.
  for (const set of changed) {
    const actual = inventory.sets.find(item => groupKey(item) === groupKey(set));
    if (
      actual?.images.length &&
      !approvedBaseline(
        actual,
        baseline.find(item => groupKey(item) === groupKey(set))
      )
    ) {
      throw new ScreenshotError('Screenshot drift differs from the approved repository baseline');
    }
    if (!inventory.localizations.some(item => item.locale === set.locale))
      throw new ScreenshotError('Screenshot locale does not exist in the selected version or edit');
    if (selected.platform === 'ios') {
      const available = [...(actual?.images ?? [])];
      let missing = 0;
      for (const image of set.images) {
        const index = available.findIndex(existing => sameImage(existing, image));
        if (index < 0) missing++;
        else available.splice(index, 1);
      }
      if ((actual?.images.length ?? 0) + missing > 10)
        throw new ScreenshotError(
          'Apple screenshot set has insufficient reservation capacity; preserve originals and resolve explicitly'
        );
    }
  }
  const updatedSets = [];
  try {
    for (const set of changed) {
      const actual = inventory.sets.find(item => groupKey(item) === groupKey(set));
      if (selected.platform === 'android') {
        if (actual?.images.length) await client.request('DELETE', playPath(options, set));
        for (const image of set.images) {
          const response = await client.request('POST', `/upload${playPath(options, set)}?uploadType=media`, {
            rawBody: image.bytes,
            headers: { 'Content-Type': `image/${image.format}` },
            timeoutMs: 60000
          });
          if (!sameImage(playImage(response?.image), image))
            throw new ScreenshotError('Android uploaded screenshot checksum does not match');
        }
      } else {
        let setId = actual?.setId;
        if (!setId) {
          const localization = inventory.localizations.find(item => item.locale === set.locale);
          const { data } = await client.request('POST', '/v1/appScreenshotSets', {
            body: {
              data: {
                type: 'appScreenshotSets',
                attributes: { screenshotDisplayType: set.displayType },
                relationships: {
                  appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: localization.id } }
                }
              }
            }
          });
          if (
            data?.type !== 'appScreenshotSets' ||
            !id(data.id) ||
            data.attributes?.screenshotDisplayType !== set.displayType
          )
            throw new ScreenshotError('Apple created an unexpected screenshot set');
          setId = data.id;
        }
        const remaining = [...(actual?.images ?? [])];
        const ordered = [];
        for (const image of set.images) {
          const index = remaining.findIndex(existing => sameImage(existing, image));
          if (index >= 0) ordered.push(remaining.splice(index, 1)[0]);
          else ordered.push(await uploadApple(client, options, setId, image));
        }
        // Preserve existing assets until all replacements have completed processing.
        for (const image of remaining) await client.request('DELETE', `/v1/appScreenshots/${image.assetId}`);
        await client.request('PATCH', `/v1/appScreenshotSets/${setId}/relationships/appScreenshots`, {
          body: { data: ordered.map(image => ({ type: 'appScreenshots', id: image.assetId })) }
        });
      }
      updatedSets.push({ locale: set.locale, displayType: set.displayType, count: set.images.length });
    }
    if (changed.length) {
      const after = await inventoryScreenshots(client, options);
      if (differences(after, desired).length)
        throw new ScreenshotError('Screenshot post-upload ordered inventory verification failed');
    }
  } catch (error) {
    const reason = error instanceof ScreenshotError ? `: ${error.message}` : '';
    throw new ScreenshotError(
      `Screenshot synchronization stopped after a possible partial store edit; inspect current inventory before another action${reason}`
    );
  }
  return { ...selected, changed: changed.length > 0, matches: true, updatedSets };
}

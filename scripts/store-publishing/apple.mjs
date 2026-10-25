const ORIGIN = 'https://api.appstoreconnect.apple.com';
const EDITABLE_STATES = new Set([
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
  'READY_FOR_REVIEW'
]);
const ACTIVE_REVIEW_STATES = new Set([
  'READY_FOR_REVIEW',
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'UNRESOLVED_ISSUES',
  'CANCELING',
  'COMPLETING'
]);
const linkage = (type, id) => ({ data: { type, id } });
const pathWithQuery = (path, query) => `${path}?${new URLSearchParams(query)}`;

function requireTarget(options, mutation = false) {
  if (!options || typeof options.appId !== 'string' || !/^\d+$/.test(options.appId)) {
    throw new Error('An explicit valid Apple appId is required');
  }
  if (typeof options.bundleId !== 'string' || !/^[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)+$/.test(options.bundleId)) {
    throw new Error('An explicit valid Apple bundleId is required');
  }
  for (const key of ['version', 'buildNumber']) {
    if (
      (mutation || options[key] !== undefined) &&
      (typeof options[key] !== 'string' || !/^\d+(?:\.\d+){0,2}$/.test(options[key]))
    ) {
      throw new Error(`An explicit valid Apple ${key} is required`);
    }
  }
}

function resource(value, type) {
  if (!value || value.type !== type || typeof value.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(value.id)) {
    throw new Error(`Malformed Apple ${type} resource identity`);
  }
  return value;
}

async function list(client, path, type) {
  const initial = new URL(path, ORIGIN);
  const visited = new Set();
  const ids = new Set();
  const records = [];
  let next = initial;
  while (next) {
    // Follow pagination only within the original official API collection.
    if (next.origin !== ORIGIN || next.pathname !== initial.pathname || visited.has(next.href) || visited.size >= 100) {
      throw new Error('Unsafe or repeated Apple pagination page');
    }
    visited.add(next.href);
    const reply = await client.request('GET', next.pathname + next.search);
    if (!Array.isArray(reply?.data)) throw new Error(`Malformed Apple ${type} list`);
    for (const item of reply.data) {
      resource(item, type);
      if (ids.has(item.id)) throw new Error(`Duplicate Apple ${type} identity in paginated list`);
      ids.add(item.id);
      records.push(item);
    }
    next = reply.links?.next ? new URL(reply.links.next, next) : null;
  }
  return records;
}

async function appIdentity(client, options) {
  const { data } = await client.request('GET', `/v1/apps/${options.appId}?fields%5Bapps%5D=name%2CbundleId`);
  const app = resource(data, 'apps');
  if (app.id !== options.appId || app.attributes?.bundleId !== options.bundleId) {
    throw new Error('Apple app identity does not match the requested appId and bundleId');
  }
  return { id: app.id, name: app.attributes.name, bundleId: app.attributes.bundleId };
}

function versionsPath(options) {
  return pathWithQuery(`/v1/apps/${options.appId}/appStoreVersions`, {
    'filter[platform]': 'IOS',
    ...(options.version ? { 'filter[versionString]': options.version } : {}),
    include: 'build',
    limit: '200'
  });
}

function buildsPath(options) {
  return pathWithQuery('/v1/builds', {
    'filter[app]': options.appId,
    'filter[preReleaseVersion.platform]': 'IOS',
    ...(options.version ? { 'filter[preReleaseVersion.version]': options.version } : {}),
    ...(options.buildNumber ? { 'filter[version]': options.buildNumber } : {}),
    sort: '-uploadedDate',
    limit: '200'
  });
}

const stateOf = version => version.attributes?.appVersionState ?? version.attributes?.appStoreState;

function requireExactVersion(version, options) {
  if (version.attributes?.platform !== 'IOS' || version.attributes?.versionString !== options.version) {
    throw new Error('Apple version does not exactly match the requested iOS marketing version');
  }
}

async function exactVersion(client, options) {
  const versions = await list(client, versionsPath(options), 'appStoreVersions');
  if (versions.length === 0)
    throw new Error('Prepare the exact Apple version draft and required metadata in the console first');
  if (versions.length !== 1) throw new Error('Ambiguous Apple app version selection');
  const version = versions[0];
  requireExactVersion(version, options);
  return version;
}

async function currentVersion(client, options, selected) {
  const current = resource(
    (await client.request('GET', `/v1/appStoreVersions/${selected.id}?include=build`)).data,
    'appStoreVersions'
  );
  if (current.id !== selected.id) throw new Error('Apple current version identity changed');
  requireExactVersion(current, options);
  return current;
}

async function exactBuild(client, options) {
  const builds = await list(client, buildsPath(options), 'builds');
  if (builds.length !== 1) throw new Error('An exact unambiguous Apple build is required');
  const build = builds[0];
  if (build.attributes?.version !== options.buildNumber) throw new Error('Apple build number does not match exactly');
  if (build.attributes.processingState !== 'VALID') throw new Error('Apple build has not been successfully processed');
  if (build.attributes.expired !== false) throw new Error('Apple build is expired or its expiry status is unknown');
  if (build.attributes.buildAudienceType !== 'APP_STORE_ELIGIBLE')
    throw new Error('Apple build is not confirmed App Store eligible');
  // Server-side filters alone are not proof of a build's app and marketing version.
  const buildApp = resource((await client.request('GET', `/v1/builds/${build.id}/app`)).data, 'apps');
  if (buildApp.id !== options.appId || buildApp.attributes?.bundleId !== options.bundleId) {
    throw new Error('Apple selected build belongs to another app');
  }
  const preRelease = resource(
    (await client.request('GET', `/v1/builds/${build.id}/preReleaseVersion`)).data,
    'preReleaseVersions'
  );
  if (preRelease.attributes?.version !== options.version || preRelease.attributes?.platform !== 'IOS') {
    throw new Error('Apple selected build has the wrong marketing version or platform');
  }
  return build;
}

function requireLinkedBuild(version, build, releaseType = 'MANUAL') {
  const linked = version.relationships?.build?.data;
  if (linked?.type !== 'builds' || linked.id !== build.id)
    throw new Error('Apple version is associated with a different build');
  if (version.attributes.releaseType !== releaseType)
    throw new Error(`Apple version release policy changed or does not match ${releaseType}`);
}

async function requireReviewItems(client, review, version) {
  const items = await list(
    client,
    `/v1/reviewSubmissions/${review.id}/items?include=appStoreVersion&limit=50`,
    'reviewSubmissionItems'
  );
  if (
    items.length !== 1 ||
    items[0].relationships?.appStoreVersion?.data?.type !== 'appStoreVersions' ||
    items[0].relationships.appStoreVersion.data.id !== version.id
  ) {
    throw new Error('Apple review draft does not contain only the requested app version');
  }
}

async function existingReview(client, options, version) {
  const reviews = await list(
    client,
    pathWithQuery('/v1/reviewSubmissions', {
      'filter[app]': options.appId,
      'filter[platform]': 'IOS',
      'filter[state]': [...ACTIVE_REVIEW_STATES].join(','),
      limit: '200'
    }),
    'reviewSubmissions'
  );
  if (
    reviews.some(
      review => !ACTIVE_REVIEW_STATES.has(review.attributes?.state) && review.attributes?.state !== 'COMPLETE'
    )
  ) {
    throw new Error('Apple review submission has an unknown state');
  }
  const active = reviews.filter(review => review.attributes.state !== 'COMPLETE');
  if (active.length === 0) return null;
  if (active.length !== 1 || active[0].attributes.state !== 'READY_FOR_REVIEW') {
    throw new Error('Another Apple review submission is active; resolve it in the console first');
  }
  const review = active[0];
  if (review.attributes.platform !== 'IOS') throw new Error('Apple review draft has an unexpected platform');
  await requireReviewItems(client, review, version);
  return review;
}

/** Read current Apple resource states without changing a draft or submission. */
export async function status(client, options) {
  requireTarget(options);
  const app = await appIdentity(client, options);
  const versions = await list(client, versionsPath(options), 'appStoreVersions');
  const builds = await list(client, buildsPath(options), 'builds');
  return {
    platform: 'ios',
    app,
    versions: versions.map(version => ({
      id: version.id,
      version: version.attributes?.versionString,
      platform: version.attributes?.platform,
      state: stateOf(version),
      releaseType: version.attributes?.releaseType,
      buildId: version.relationships?.build?.data?.id ?? null
    })),
    builds: builds.map(build => ({
      id: build.id,
      buildNumber: build.attributes?.version,
      processingState: build.attributes?.processingState,
      expired: build.attributes?.expired,
      buildAudienceType: build.attributes?.buildAudienceType
    }))
  };
}

/** Delegate a verified IPA to the official Xcode uploader; this never submits it for review. */
export async function upload(client, options) {
  requireTarget(options, true);
  if (typeof options.artifact !== 'string' || !options.artifact.endsWith('.ipa'))
    throw new Error('An explicit IPA artifact path is required');
  if (typeof client.uploadIpa !== 'function') throw new Error('The official Apple IPA uploader is unavailable');
  await appIdentity(client, options);
  await client.uploadIpa(options);
  return {
    platform: 'ios',
    appId: options.appId,
    version: options.version,
    buildNumber: options.buildNumber,
    state: 'UPLOAD_ACCEPTED',
    published: false
  };
}

/** Submit one existing draft/build while preserving its release policy unless an explicit change is requested. */
export async function submit(client, options) {
  requireTarget(options, true);
  const policy = options.releasePolicy ?? 'preserve-existing';
  if (!['preserve-existing', 'manual', 'after-approval'].includes(policy)) throw new Error('Invalid Apple release policy');
  await appIdentity(client, options);
  const version = await exactVersion(client, options);
  const existingType = version.attributes?.releaseType;
  if (!['MANUAL', 'AFTER_APPROVAL'].includes(existingType)) throw new Error('Unsupported existing Apple release type');
  const releaseType = policy === 'preserve-existing' ? existingType : policy === 'manual' ? 'MANUAL' : 'AFTER_APPROVAL';
  if (!EDITABLE_STATES.has(stateOf(version))) throw new Error('Apple version is not an editable draft');
  const build = await exactBuild(client, options);
  let review = await existingReview(client, options, version);
  if (stateOf(version) === 'READY_FOR_REVIEW') {
    if (!review) throw new Error('Apple ready-for-review version has no matching review draft');
    requireLinkedBuild(version, build, existingType);
  }
  const linked = version.relationships?.build?.data;
  const changeBuild = linked?.type !== 'builds' || linked.id !== build.id;
  if (changeBuild || releaseType !== existingType) {
    await client.request('PATCH', `/v1/appStoreVersions/${version.id}`, {
      body: {
        data: {
          type: 'appStoreVersions',
          id: version.id,
          ...(releaseType !== existingType ? { attributes: { releaseType } } : {}),
          ...(changeBuild ? { relationships: { build: linkage('builds', build.id) } } : {})
        }
      }
    });
  }
  if (!review) {
    review = resource(
      (
        await client.request('POST', '/v1/reviewSubmissions', {
          body: {
            data: {
              type: 'reviewSubmissions',
              relationships: { app: linkage('apps', options.appId) }
            }
          }
        })
      ).data,
      'reviewSubmissions'
    );
    await client.request('POST', '/v1/reviewSubmissionItems', {
      body: {
        data: {
          type: 'reviewSubmissionItems',
          relationships: {
            reviewSubmission: linkage('reviewSubmissions', review.id),
            appStoreVersion: linkage('appStoreVersions', version.id)
          }
        }
      }
    });
  }
  // Check persisted selection and exclusivity immediately before sending review.
  const current = await currentVersion(client, options, version);
  if (!EDITABLE_STATES.has(stateOf(current))) throw new Error('Apple version is no longer an editable draft');
  requireLinkedBuild(current, build, releaseType);
  await requireReviewItems(client, review, current);
  const response = await client.request('PATCH', `/v1/reviewSubmissions/${review.id}`, {
    body: {
      data: {
        type: 'reviewSubmissions',
        id: review.id,
        attributes: { submitted: true }
      }
    }
  });
  resource(response?.data, 'reviewSubmissions');
  return {
    platform: 'ios',
    appId: options.appId,
    version: options.version,
    buildNumber: options.buildNumber,
    reviewSubmissionId: review.id,
    submissionRequested: true,
    releaseType,
    autoReleaseAfterApproval: releaseType === 'AFTER_APPROVAL',
    state: response.data.attributes?.state,
    published: false
  };
}

/** Request irreversible publication of one manually held approved version; availability still needs polling. */
export async function release(client, options) {
  requireTarget(options, true);
  await appIdentity(client, options);
  const version = await exactVersion(client, options);
  if (stateOf(version) !== 'PENDING_DEVELOPER_RELEASE')
    throw new Error('Apple version is not approved and pending developer release');
  const build = await exactBuild(client, options);
  requireLinkedBuild(version, build);
  const current = await currentVersion(client, options, version);
  if (stateOf(current) !== 'PENDING_DEVELOPER_RELEASE')
    throw new Error('Apple version is no longer approved and pending developer release');
  requireLinkedBuild(current, build);
  const response = await client.request('POST', '/v1/appStoreVersionReleaseRequests', {
    body: {
      data: {
        type: 'appStoreVersionReleaseRequests',
        relationships: { appStoreVersion: linkage('appStoreVersions', version.id) }
      }
    }
  });
  const request = resource(response?.data, 'appStoreVersionReleaseRequests');
  return {
    platform: 'ios',
    appId: options.appId,
    version: options.version,
    buildNumber: options.buildNumber,
    releaseRequestId: request.id,
    releaseRequested: true,
    irreversible: true,
    published: false
  };
}

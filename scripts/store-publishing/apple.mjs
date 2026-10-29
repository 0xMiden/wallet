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
const RECEIVED_REVIEW_STATES = new Set(['WAITING_FOR_REVIEW', 'IN_REVIEW']);
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

export const DEFAULT_RELEASE_NOTES = 'Various Fixes & Improvements';

export function validateReleaseNotes(value) {
  if (value === undefined || value === '') return undefined;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    [...value].length > 4000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new Error('Explicit release notes must contain 1-4000 characters without control characters');
  }
  return value;
}

async function releaseNotesTarget(client, version, notes) {
  const localizations = await list(
    client,
    `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=200`,
    'appStoreVersionLocalizations'
  );
  const english = localizations.filter(item => item.attributes?.locale === 'en-US');
  if (english.length !== 1) throw new Error('An exact unambiguous en-US localization is required');
  const current = english[0].attributes.whatsNew;
  if (current !== null && current !== undefined && typeof current !== 'string')
    throw new Error('Invalid Apple release notes metadata');
  if (current?.trim()) return null;
  if (!notes) throw new Error("Explicit release notes are required for empty What's New metadata");
  return english[0];
}

function submitClient(client) {
  return {
    async request(method, path, init) {
      let stage = 'apple-submit-preflight';
      if (method === 'PATCH' && path.startsWith('/v1/appStoreVersionLocalizations/'))
        stage = 'apple-release-notes-update';
      else if (method === 'PATCH' && path.startsWith('/v1/appStoreVersions/')) stage = 'apple-build-link';
      else if (method === 'POST' && path === '/v1/reviewSubmissions') stage = 'apple-review-create';
      else if (method === 'POST' && path === '/v1/reviewSubmissionItems') stage = 'apple-review-item-create';
      else if (method === 'PATCH' && path.startsWith('/v1/reviewSubmissions/')) stage = 'apple-review-submit';
      try {
        return await client.request(method, path, init);
      } catch (error) {
        if (error && typeof error === 'object') error.stage = stage;
        throw error;
      }
    }
  };
}

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

async function requireReviewItems(client, review, version, allowEmpty = false, submitted = false) {
  const items = await list(
    client,
    `/v1/reviewSubmissions/${review.id}/items?include=appStoreVersion&limit=50`,
    'reviewSubmissionItems'
  );
  if (allowEmpty && items.length === 0) return false;
  if (
    items.length !== 1 ||
    items[0].relationships?.appStoreVersion?.data?.type !== 'appStoreVersions' ||
    items[0].relationships.appStoreVersion.data.id !== version.id
  ) {
    throw new Error('Apple review draft does not contain only the requested app version');
  }
  if (submitted && !['READY_FOR_REVIEW', 'ACCEPTED', 'APPROVED'].includes(items[0].attributes?.state))
    throw new Error('Apple review item is rejected, removed or has an unknown state');
  return true;
}

async function reconcileSubmittedReview(client, options, version, build, review, releaseType) {
  const deadline = Date.now() + 30000;
  let remainingRequests = 10;
  const readOnly = {
    async request(method, path) {
      const timeoutMs = deadline - Date.now();
      if (method !== 'GET' || remainingRequests-- <= 0 || timeoutMs <= 0)
        throw new Error('Apple submission verification budget exhausted');
      return client.request('GET', path, { timeoutMs });
    }
  };
  await appIdentity(readOnly, options);
  const received = resource(
    (await readOnly.request('GET', `/v1/reviewSubmissions/${review.id}?include=app`)).data,
    'reviewSubmissions'
  );
  if (
    received.id !== review.id ||
    !RECEIVED_REVIEW_STATES.has(received.attributes?.state) ||
    (received.attributes.platform !== null && received.attributes.platform !== 'IOS') ||
    received.relationships?.app?.data?.type !== 'apps' ||
    received.relationships.app.data.id !== options.appId
  )
    throw new Error('Apple has not confirmed receipt of the exact review submission');
  await requireReviewItems(readOnly, received, version, false, true);
  const current = await currentVersion(readOnly, options, version);
  if (!RECEIVED_REVIEW_STATES.has(stateOf(current)))
    throw new Error('Apple has not confirmed receipt of the exact app version');
  requireLinkedBuild(current, build, releaseType);
  const currentBuild = await exactBuild(readOnly, options);
  if (currentBuild.id !== build.id) throw new Error('Apple submitted build identity changed');
  if (Date.now() >= deadline) throw new Error('Apple submission verification budget exhausted');
  return { data: received };
}

async function existingReview(client, options, version, allowEmpty = false) {
  const reviews = await list(
    client,
    pathWithQuery('/v1/reviewSubmissions', {
      'filter[app]': options.appId,
      include: 'app',
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
  if (review.attributes.platform !== null && review.attributes.platform !== 'IOS')
    throw new Error('Apple review draft has an unexpected platform');
  if (review.relationships?.app?.data?.type !== 'apps' || review.relationships.app.data.id !== options.appId) {
    throw new Error('Apple review draft app relationship does not match the requested app');
  }
  const hasItem = await requireReviewItems(client, review, version, allowEmpty);
  return { ...review, hasItem };
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
  const notes = validateReleaseNotes(options.releaseNotes) ?? DEFAULT_RELEASE_NOTES;
  client = submitClient(client);
  const policy = options.releasePolicy ?? 'after-approval';
  if (!['preserve-existing', 'manual', 'after-approval'].includes(policy))
    throw new Error('Invalid Apple release policy');
  await appIdentity(client, options);
  const version = await exactVersion(client, options);
  const existingType = version.attributes?.releaseType;
  if (!['MANUAL', 'AFTER_APPROVAL'].includes(existingType)) throw new Error('Unsupported existing Apple release type');
  const releaseType = policy === 'preserve-existing' ? existingType : policy === 'manual' ? 'MANUAL' : 'AFTER_APPROVAL';
  if (!EDITABLE_STATES.has(stateOf(version))) throw new Error('Apple version is not an editable draft');
  const build = await exactBuild(client, options);
  let notesTarget = await releaseNotesTarget(client, version, notes);
  let review = await existingReview(client, options, version, true);
  if (stateOf(version) === 'READY_FOR_REVIEW') {
    if (!review?.hasItem) throw new Error('Apple ready-for-review version has no matching review draft');
    requireLinkedBuild(version, build, existingType);
  }
  if (notesTarget) {
    // Re-read immediately before writing so existing release text is preserved.
    notesTarget = await releaseNotesTarget(client, version, notes);
    if (notesTarget)
      await client.request('PATCH', `/v1/appStoreVersionLocalizations/${notesTarget.id}`, {
        body: { data: { type: 'appStoreVersionLocalizations', id: notesTarget.id, attributes: { whatsNew: notes } } }
      });
    if (await releaseNotesTarget(client, version, notes))
      throw new Error('Apple release notes update was not persisted');
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
  }
  if (!review.hasItem) {
    const beforeItem = await currentVersion(client, options, version);
    if (!EDITABLE_STATES.has(stateOf(beforeItem))) throw new Error('Apple version is no longer an editable draft');
    requireLinkedBuild(beforeItem, build, releaseType);
    const currentReview = await existingReview(client, options, version, true);
    if (!currentReview || currentReview.id !== review.id)
      throw new Error('Apple review draft changed before adding its item');
    if (!currentReview.hasItem)
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
  const finalReview = await existingReview(client, options, current);
  if (!finalReview || finalReview.id !== review.id) throw new Error('Apple review draft changed before submission');
  let response;
  let submissionReconciled = false;
  try {
    response = await client.request('PATCH', `/v1/reviewSubmissions/${review.id}`, {
      body: {
        data: {
          type: 'reviewSubmissions',
          id: review.id,
          attributes: { submitted: true }
        }
      }
    });
  } catch (error) {
    if (error?.status !== undefined && !(Number.isInteger(error.status) && error.status >= 500 && error.status <= 599))
      throw error;
    // A lost acknowledgement never authorizes replaying a mutation.
    try {
      response = await reconcileSubmittedReview(client, options, version, build, review, releaseType);
      submissionReconciled = true;
    } catch {
      throw error;
    }
  }
  resource(response?.data, 'reviewSubmissions');
  return {
    platform: 'ios',
    appId: options.appId,
    version: options.version,
    buildNumber: options.buildNumber,
    reviewSubmissionId: review.id,
    submissionRequested: true,
    ...(submissionReconciled ? { submissionReconciled: true } : {}),
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

const activeStates = new Set(['PENDING_REVIEW', 'STAGED']);
const replaceableStates = new Set(['REJECTED', 'CANCELLED']);

function resource(options) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.publisherId ?? '') || !/^[a-p]{32}$/.test(options.itemId ?? '')) {
    throw new Error('Invalid Chrome publisher or item identifier');
  }
  return `publishers/${options.publisherId}/items/${options.itemId}`;
}

function versionParts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(version)) {
    throw new Error('Invalid Chrome version');
  }
  const parts = version.split('.').map(Number);
  if (parts.some(part => part > 65535) || !parts.some(part => part > 0)) {
    throw new Error('Invalid Chrome version');
  }
  return [...parts, ...Array(4 - parts.length).fill(0)];
}

function newerThan(version, previous) {
  const left = versionParts(version);
  const right = versionParts(previous);
  const different = left.findIndex((part, index) => part !== right[index]);
  return different !== -1 && left[different] > right[different];
}

function identity(response, options) {
  if (response?.name !== resource(options) || response?.itemId !== options.itemId) {
    throw new Error('Chrome response identity does not match the selected item');
  }
}

function revision(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value.state !== 'string' || !Array.isArray(value.distributionChannels)) {
    throw new Error('Chrome revision version information is unavailable');
  }
  return {
    state: value.state,
    distributionChannels: value.distributionChannels.map(channel => ({
      crxVersion: channel?.crxVersion,
      ...(channel?.deployPercentage === undefined ? {} : { deployPercentage: channel.deployPercentage })
    }))
  };
}

function policyCheck(current) {
  if (current.warned || current.takenDown) {
    throw new Error('Resolve the Chrome policy warning or take-down before changing this item');
  }
}

function exactRevision(value, version) {
  const versions = value?.distributionChannels?.map(channel => channel.crxVersion);
  if (!versions?.length || versions.some(current => current !== version)) {
    throw new Error('Chrome revision version is absent, ambiguous or does not match the selected version');
  }
}

function mediaCheck(options) {
  resource(options);
  versionParts(options.version);
  if (!(options.artifact instanceof Uint8Array) || options.artifact.byteLength === 0) {
    throw new Error('A verified Chrome ZIP artifact is required');
  }
}

function uploadCheck(current, options) {
  policyCheck(current);
  const submitted = current.submittedItemRevisionStatus;
  if (submitted && !replaceableStates.has(submitted.state)) {
    throw new Error('An existing Chrome submission must be resolved before uploading another package');
  }
  const previous = current.publishedItemRevisionStatus;
  if (previous) {
    const versions = previous.distributionChannels.map(channel => channel.crxVersion);
    if (
      !['PUBLISHED', 'PUBLISHED_TO_TESTERS'].includes(previous.state) ||
      !versions.length ||
      versions.some(version => !newerThan(options.version, version))
    ) {
      throw new Error('Chrome upload version must be newer than every published channel version');
    }
  }
}

async function uploadMedia(client, options) {
  const result = await client.request('POST', `/upload/v2/${resource(options)}:upload`, {
    rawBody: options.artifact,
    headers: { 'Content-Type': 'application/zip' }
  });
  identity(result, options);
  if (!['SUCCEEDED', 'IN_PROGRESS'].includes(result.uploadState)) {
    throw new Error('Chrome package upload did not succeed');
  }
  if (result.uploadState === 'SUCCEEDED' && result.crxVersion !== options.version) {
    throw new Error('Chrome uploaded package version does not match the selected version');
  }
  return {
    name: result.name,
    itemId: result.itemId,
    uploadState: result.uploadState,
    ...(result.uploadState === 'SUCCEEDED' ? { crxVersion: result.crxVersion } : {})
  };
}

async function publish(client, options, publishType, expectedStates) {
  const result = await client.request('POST', `/v2/${resource(options)}:publish`, {
    body: { publishType, skipReview: false, blockOnWarnings: true }
  });
  identity(result, options);
  if (!expectedStates.includes(result.state)) {
    throw new Error('Chrome publishing response has an unexpected state; inspect status before taking further action');
  }
  return { name: result.name, itemId: result.itemId, version: options.version, state: result.state };
}

/** Fetch current store evidence without exposing unrelated API response fields. */
export async function status(client, options = {}) {
  const result = await client.request('GET', `/v2/${resource(options)}:fetchStatus`);
  identity(result, options);
  return {
    name: result.name,
    itemId: result.itemId,
    ...(result.publishedItemRevisionStatus === undefined
      ? {}
      : { publishedItemRevisionStatus: revision(result.publishedItemRevisionStatus) }),
    ...(result.submittedItemRevisionStatus === undefined
      ? {}
      : { submittedItemRevisionStatus: revision(result.submittedItemRevisionStatus) }),
    ...(result.lastAsyncUploadState === undefined ? {} : { lastAsyncUploadState: result.lastAsyncUploadState }),
    ...(result.takenDown === undefined ? {} : { takenDown: result.takenDown }),
    ...(result.warned === undefined ? {} : { warned: result.warned })
  };
}

/** Upload without submitting, cancelling a submission or changing rollout settings. */
export async function upload(client, options = {}) {
  mediaCheck(options);
  const current = await status(client, options);
  uploadCheck(current, options);
  return uploadMedia(client, options);
}

/** Submit for staged approval, preserving an already matching active submission. */
export async function submit(client, options = {}) {
  mediaCheck(options);
  const current = await status(client, options);
  policyCheck(current);
  const submitted = current.submittedItemRevisionStatus;
  if (submitted && activeStates.has(submitted.state)) {
    exactRevision(submitted, options.version);
    return {
      name: current.name,
      itemId: current.itemId,
      version: options.version,
      state: submitted.state,
      alreadySubmitted: true
    };
  }
  uploadCheck(current, options);
  // fetchStatus has no draft version. Reupload this artifact immediately before submitting.
  const uploaded = await uploadMedia(client, options);
  if (uploaded.uploadState !== 'SUCCEEDED') {
    throw new Error('Chrome upload is still processing; no submission was sent');
  }
  return publish(client, options, 'STAGED_PUBLISH', ['PENDING_REVIEW', 'STAGED']);
}

/** Publish only the selected approved revision; a public matching revision is a no-op. */
export async function release(client, options = {}) {
  versionParts(options.version);
  const current = await status(client, options);
  policyCheck(current);
  const submitted = current.submittedItemRevisionStatus;
  if (!submitted && current.publishedItemRevisionStatus?.state === 'PUBLISHED') {
    exactRevision(current.publishedItemRevisionStatus, options.version);
    return {
      name: current.name,
      itemId: current.itemId,
      version: options.version,
      state: 'PUBLISHED',
      alreadyPublished: true
    };
  }
  if (submitted?.state !== 'STAGED') {
    throw new Error('The selected Chrome revision is not approved and staged for release');
  }
  exactRevision(submitted, options.version);
  return publish(client, options, 'DEFAULT_PUBLISH', ['PUBLISHED', 'PUBLISHED_TO_TESTERS']);
}

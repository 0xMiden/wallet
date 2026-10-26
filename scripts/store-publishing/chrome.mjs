import { createHash } from 'node:crypto';

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

const sessionStates = new Set([
  'request-started',
  'accepted-async',
  'completed-sync',
  'completed-async',
  'submission-requested',
  'submitted'
]);
const now = options => (options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();

/** Validate private continuity evidence; the API exposes no draft version, hash or upload operation ID. */
export function validateUploadSession(session, options, nowSeconds, { allowExpired = false } = {}) {
  const expectedHash =
    options.artifact instanceof Uint8Array
      ? createHash('sha256').update(options.artifact).digest('hex')
      : options.sha256;
  if (
    !session ||
    session.schemaVersion !== 1 ||
    session.platform !== 'chrome' ||
    !sessionStates.has(session.state) ||
    session.identity !== options.itemId ||
    session.storeId !== options.itemId ||
    session.publisherId !== options.publisherId ||
    session.version !== options.version ||
    !/^[a-f0-9]{64}$/.test(session.sha256 ?? '') ||
    session.sha256 !== expectedHash ||
    !/^[a-f0-9]{40}$/.test(session.sourceSha ?? '') ||
    !['testnet', 'devnet'].includes(session.network) ||
    (options.sourceSha !== undefined && session.sourceSha !== options.sourceSha) ||
    (options.network !== undefined && session.network !== options.network) ||
    session.uploaded === true
  )
    throw new Error('Chrome upload session does not match the exact artifact and publisher');
  const stamp = session.acceptedAt ?? session.completedAt ?? session.startedAt;
  if (
    !Number.isSafeInteger(stamp) ||
    stamp <= 0 ||
    stamp > nowSeconds ||
    (!allowExpired && !['submission-requested', 'submitted'].includes(session.state) && nowSeconds - stamp >= 86400)
  )
    throw new Error('Chrome upload journal timestamp is future, missing or expired');
  for (const key of ['startedAt', 'acceptedAt', 'completedAt'])
    if (
      session[key] !== undefined &&
      (!Number.isSafeInteger(session[key]) || session[key] <= 0 || session[key] > nowSeconds)
    )
      throw new Error('Invalid Chrome upload journal timestamp');
  if (
    ['completed-sync', 'completed-async', 'submission-requested', 'submitted'].includes(session.state) &&
    !Number.isSafeInteger(session.completedAt)
  )
    throw new Error('Chrome upload completion journal is missing');
  if (
    ['submission-requested', 'submitted'].includes(session.state) &&
    !Number.isSafeInteger(session.acceptedAt) &&
    session.crxVersion !== options.version
  )
    throw new Error('Chrome upload session has no prior accepted completion');
  if (session.state === 'completed-sync' && session.crxVersion !== options.version)
    throw new Error('Chrome upload session version proof does not match');
  if (['accepted-async', 'completed-async'].includes(session.state) && !Number.isSafeInteger(session.acceptedAt))
    throw new Error('Chrome async upload acceptance evidence is missing');
  return session;
}

/** A terminal prior release can be replaced only after fresh publication evidence and archival. */
export function validateRolloverSession(session, options, nowSeconds) {
  if (session?.state !== 'submitted') throw new Error('A nonterminal Chrome upload journal blocks another version');
  validateUploadSession(
    session,
    {
      publisherId: options.publisherId,
      itemId: options.itemId,
      version: session.version,
      sha256: session.sha256,
      network: options.network,
      sourceSha: session.sourceSha
    },
    nowSeconds,
    { allowExpired: true }
  );
  if (!newerThan(options.version, session.version))
    throw new Error('The next Chrome version must be strictly newer than the terminal prior version');
  return session;
}

async function saveSession(options, patch) {
  await options.persistUploadSession?.(patch);
}

async function resumeUpload(client, options, current) {
  const session = options.uploadSession;
  if (session.state === 'request-started')
    throw new Error(
      'Chrome upload request outcome is uncertain; inspect and recover the existing journal before another upload'
    );
  if (session.state === 'completed-sync')
    return {
      name: resource(options),
      itemId: options.itemId,
      uploadState: 'SUCCEEDED',
      crxVersion: session.crxVersion,
      completionEvidence: 'upload-response-version'
    };
  if (!['accepted-async', 'completed-async'].includes(session.state))
    throw new Error('Chrome upload session requires submission recovery, not another upload');
  const wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt < 6; attempt++) {
    validateUploadSession(session, options, now(options));
    uploadCheck(current, options);
    if (current.lastAsyncUploadState === 'SUCCEEDED') {
      await saveSession(options, {
        state: 'completed-async',
        acceptedAt: session.acceptedAt,
        completedAt: now(options)
      });
      return {
        name: resource(options),
        itemId: options.itemId,
        uploadState: 'SUCCEEDED',
        completionEvidence: 'accepted-async-journal'
      };
    }
    if (current.lastAsyncUploadState !== 'IN_PROGRESS')
      throw new Error('Chrome async upload status is missing, failed or not found; no new upload was sent');
    if (attempt < 5) {
      await wait(5000);
      current = await status(client, options);
    }
  }
  return {
    name: resource(options),
    itemId: options.itemId,
    uploadState: 'IN_PROGRESS',
    actionRequired: 'resume-same-upload-session'
  };
}

async function uploadMedia(client, options) {
  await saveSession(options, { state: 'request-started', startedAt: now(options) });
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
  await saveSession(
    options,
    result.uploadState === 'IN_PROGRESS'
      ? { state: 'accepted-async', acceptedAt: now(options) }
      : { state: 'completed-sync', completedAt: now(options), crxVersion: result.crxVersion }
  );
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
  const prior = options.uploadSession;
  const rollover = prior && prior.version !== options.version;
  if (rollover) validateRolloverSession(prior, options, now(options));
  else if (prior) {
    validateUploadSession(prior, options, now(options));
    if (prior.state === 'request-started')
      throw new Error('Chrome upload request outcome is uncertain; recover its journal before another mutation');
  }
  const current = await status(client, options);
  uploadCheck(current, options);
  if (rollover) {
    if (
      current.submittedItemRevisionStatus ||
      current.publishedItemRevisionStatus?.state !== 'PUBLISHED' ||
      current.lastAsyncUploadState === 'IN_PROGRESS'
    )
      throw new Error('Prior Chrome version is not exclusively published; rollover is blocked');
    exactRevision(current.publishedItemRevisionStatus, prior.version);
    if (current.publishedItemRevisionStatus.distributionChannels.some(channel => channel.deployPercentage !== 100))
      throw new Error('Prior Chrome publication has a partial channel rollout');
    if (typeof options.archiveUploadSession !== 'function')
      throw new Error('Prior Chrome journal must be durably archived before rollover');
    await options.archiveUploadSession(prior);
    return uploadMedia(client, { ...options, uploadSession: undefined });
  }
  if (prior) return resumeUpload(client, options, current);
  if (current.lastAsyncUploadState === 'IN_PROGRESS')
    throw new Error('An unbound Chrome async upload is in progress; recover its journal before another upload');
  return uploadMedia(client, options);
}

/** Submit for automatic publication after approval, preserving a matching active submission. */
export async function submit(client, options = {}) {
  mediaCheck(options);
  if (options.uploadSession) {
    validateUploadSession(options.uploadSession, options, now(options));
    if (options.uploadSession.state === 'request-started')
      throw new Error('Chrome upload request outcome is uncertain; recover its journal before another mutation');
  }
  const current = await status(client, options);
  policyCheck(current);
  const submitted = current.submittedItemRevisionStatus;
  if (submitted && activeStates.has(submitted.state)) {
    exactRevision(submitted, options.version);
    if (options.uploadSession)
      await saveSession(options, {
        state: 'submitted',
        completedAt: options.uploadSession.completedAt ?? now(options)
      });
    return {
      name: current.name,
      itemId: current.itemId,
      version: options.version,
      state: submitted.state,
      alreadySubmitted: true
    };
  }
  if (['submission-requested', 'submitted'].includes(options.uploadSession?.state))
    throw new Error('Chrome submission request outcome is uncertain; no publishing request was repeated');
  uploadCheck(current, options);
  if (!options.uploadSession && current.lastAsyncUploadState === 'IN_PROGRESS')
    throw new Error('An unbound Chrome async upload is in progress; recover its journal');
  // Legacy evidence has no draft identity. A new request is journaled before its only media POST.
  const uploaded = options.uploadSession
    ? await resumeUpload(client, options, current)
    : await uploadMedia(client, options);
  if (uploaded.uploadState !== 'SUCCEEDED') return uploaded;
  await saveSession(options, { state: 'submission-requested' });
  const result = await publish(client, options, 'DEFAULT_PUBLISH', ['PENDING_REVIEW', 'PUBLISHED']);
  const confirmed = await status(client, options);
  policyCheck(confirmed);
  const alreadyPublic = confirmed.publishedItemRevisionStatus?.state === 'PUBLISHED' &&
    confirmed.publishedItemRevisionStatus.distributionChannels.some(channel => channel.crxVersion === options.version);
  if (alreadyPublic) exactRevision(confirmed.publishedItemRevisionStatus, options.version);
  else if (confirmed.submittedItemRevisionStatus?.state === 'PENDING_REVIEW')
    exactRevision(confirmed.submittedItemRevisionStatus, options.version);
  else
    throw new Error('Chrome submitted revision is not yet confirmed; preserve the submission journal');
  await saveSession(options, { state: 'submitted' });
  return {
    ...result,
    state: alreadyPublic ? 'PUBLISHED' : 'PENDING_REVIEW',
    submittedRevisionVerified: true,
    ...(uploaded.completionEvidence ? { completionEvidence: uploaded.completionEvidence } : {})
  };
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

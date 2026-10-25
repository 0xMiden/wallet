import { createHash } from 'node:crypto';

const api = '/androidpublisher/v3/applications';

function identity(options) {
  const { packageName, track = 'production' } = options;
  if (typeof packageName !== 'string' || !/^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/.test(packageName)) {
    throw new Error('A valid Android packageName is required');
  }
  if (typeof track !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(track)) {
    throw new Error('A valid Play track is required');
  }
  return { packageName, track, appPath: `${api}/${encodeURIComponent(packageName)}` };
}

function versionIdentity(options) {
  if (typeof options.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(options.version)) {
    throw new Error('An explicit three-part release version is required');
  }
  if (!Number.isSafeInteger(options.versionCode) || options.versionCode < 1) {
    throw new Error('A positive integer versionCode is required');
  }
  return String(options.versionCode);
}

function editIdentity(options, appPath) {
  if (typeof options.editId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(options.editId)) {
    throw new Error('A caller-owned editId is required; this module never creates edits implicitly');
  }
  return `${appPath}/edits/${encodeURIComponent(options.editId)}`;
}

function releasesForTrack(response, track) {
  if (!response || response.track !== track || (response.releases !== undefined && !Array.isArray(response.releases))) {
    throw new Error('Play returned an unexpected track identity or release list');
  }
  const releases = response.releases ?? [];
  if (
    releases.some(
      item =>
        !item ||
        !Array.isArray(item.versionCodes) ||
        item.versionCodes.some(code => typeof code !== 'string' || !/^\d+$/.test(code))
    )
  ) {
    throw new Error('Play returned malformed release version codes');
  }
  return releases;
}

function exactRelease(releases, code, requiredStatus) {
  const matches = releases.filter(item => item.versionCodes.includes(code));
  if (matches.length !== 1 || matches[0].versionCodes.length !== 1 || matches[0].status !== requiredStatus) {
    throw new Error(`The requested versionCode must identify a single ${requiredStatus} release`);
  }
  return matches[0];
}

// The lifecycle endpoint needs no edit and cannot invalidate an in-flight upload.
// It returns at most 20 non-obsolete releases, not complete release history.
// https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases/list
export async function status(client, options) {
  const { packageName, track, appPath } = identity(options);
  const response = await client.request('GET', `${appPath}/tracks/${encodeURIComponent(track)}/releases`);
  if (!response || (response.releases !== undefined && !Array.isArray(response.releases))) {
    throw new Error('Play returned an invalid release lifecycle response');
  }
  const releases = response.releases ?? [];
  if (releases.some(item => !item || (item.track !== undefined && item.track !== track))) {
    throw new Error('Play returned a release for an unexpected track');
  }
  return { platform: 'android', packageName, track, releases };
}

export async function upload(client, options) {
  const { packageName, track, appPath } = identity(options);
  const code = versionIdentity(options);
  const editPath = editIdentity(options, appPath);
  if (!(options.artifact instanceof Uint8Array) || options.artifact.byteLength === 0) {
    throw new Error('A nonempty Android App Bundle artifact is required');
  }

  // Creating an edit invalidates another edit owned by the same principal.
  // Its explicit creation and persistence belong to the caller's release lock.
  const path = `${editPath}/tracks/${encodeURIComponent(track)}`;
  const current = await client.request('GET', path);
  const releases = releasesForTrack(current, track);
  if (releases.some(item => item.versionCodes.includes(code))) {
    throw new Error('The requested versionCode is already present in the selected track');
  }
  if (releases.some(item => item.status === 'draft')) {
    throw new Error('An outstanding draft must be resolved before uploading another release');
  }

  const bundle = await client.request('POST', `/upload${editPath}/bundles?uploadType=media`, {
    rawBody: options.artifact,
    headers: { 'Content-Type': 'application/octet-stream' },
    timeoutMs: 120000
  });
  const sha256 = createHash('sha256').update(options.artifact).digest('hex');
  // Check Play's attestation before assigning an uploaded artifact to a track.
  if (bundle?.versionCode !== options.versionCode || bundle.sha256?.toLowerCase() !== sha256) {
    throw new Error('The uploaded bundle versionCode or SHA256 does not match the requested artifact');
  }

  const draft = { name: options.version, versionCodes: [code], status: 'draft' };
  const updated = await client.request('PUT', path, { body: { ...current, releases: [...releases, draft] } });
  exactRelease(releasesForTrack(updated, track), code, 'draft');

  // No commit here: committing can also send unrelated console changes for review.
  // The caller retains this edit until explicit submission or its expiry.
  return {
    platform: 'android',
    packageName,
    track,
    version: options.version,
    versionCode: options.versionCode,
    editId: options.editId,
    sha256,
    state: 'draft-uncommitted'
  };
}

export async function submit(client, options) {
  const { packageName, track, appPath } = identity(options);
  const code = versionIdentity(options);
  const editPath = editIdentity(options, appPath);
  if (options.allowPendingChanges !== true) {
    throw new Error('allowPendingChanges must explicitly acknowledge that commit includes all pending console changes');
  }

  // Play exposes no reliable API inventory of all pending console changes.
  // The caller must inspect Publishing overview before authorizing this commit.
  const path = `${editPath}/tracks/${encodeURIComponent(track)}`;
  const current = await client.request('GET', path);
  const releases = releasesForTrack(current, track);
  const target = exactRelease(releases, code, 'draft');
  if (target.userFraction !== undefined) throw new Error('A single draft without staged rollout targeting is required');
  const completed = { ...target, status: 'completed' };
  const updated = await client.request('PUT', path, {
    body: { ...current, releases: releases.map(item => (item === target ? completed : item)) }
  });
  exactRelease(releasesForTrack(updated, track), code, 'completed');
  await client.request('POST', `${editPath}:validate`);
  // The API default cancels an existing review; never accept that default.
  // https://developers.google.com/android-publisher/api-ref/rest/v3/edits/commit
  await client.request(
    'POST',
    `${editPath}:commit?changesNotSentForReview=false&changesInReviewBehavior=ERROR_IF_IN_REVIEW`
  );
  return {
    platform: 'android',
    packageName,
    track,
    version: options.version,
    versionCode: options.versionCode,
    editId: options.editId,
    state: 'committed',
    publication: 'verify-live-status'
  };
}

export async function release(client, options) {
  const code = versionIdentity(options);
  const result = await status(client, options);
  const matches = result.releases.filter(item =>
    item.activeArtifacts?.some(artifact => String(artifact.versionCode) === code)
  );
  if (matches.length !== 1)
    throw new Error('The requested versionCode is not uniquely visible in current track releases');
  const lifecycle = matches[0].releaseLifecycleState;
  if (lifecycle === 'RELEASE_LIFECYCLE_STATE_PUBLISHED') {
    // This lifecycle also includes partially rolled out and halted releases.
    return { ...result, versionCode: options.versionCode, state: 'published-on-track', fullRolloutVerified: false };
  }
  if (lifecycle !== 'RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED') {
    throw new Error('The requested versionCode is not approved for publication');
  }

  // Managed publication has no supported API mutation. Its console button can
  // publish other approved changes too, so the caller must inspect that scope.
  return {
    ...result,
    versionCode: options.versionCode,
    state: 'approved-awaiting-console-publication',
    actionRequired: 'publish-approved-changes-in-console',
    consoleUrl: 'https://play.google.com/console/',
    includesPendingConsoleChanges: true
  };
}

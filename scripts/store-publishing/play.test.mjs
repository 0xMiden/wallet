import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import * as play from './play.mjs';

const app = '/androidpublisher/v3/applications/com.miden.wallet';
const edit = `${app}/edits/edit-1`;
const trackPath = `${edit}/tracks/production`;
const options = { packageName: 'com.miden.wallet', version: '1.17.7', versionCode: 11707001, editId: 'edit-1' };
const artifact = new Uint8Array([1, 2, 3, 4]);
const sha256 = createHash('sha256').update(artifact).digest('hex');
const live = { name: '1.17.6', versionCodes: ['11706001'], status: 'completed', inAppUpdatePriority: 2 };
const draft = {
  name: '1.17.7',
  versionCodes: ['11707001'],
  status: 'draft',
  releaseNotes: [{ language: 'en-US', text: 'Release notes' }]
};

function transport(steps = []) {
  const calls = [];
  return {
    calls,
    async request(method, path, requestOptions) {
      calls.push({ method, path, options: requestOptions });
      const step = steps.shift();
      assert.ok(step, `Unexpected ${method} ${path}`);
      assert.equal(method, step.method);
      assert.equal(path, step.path);
      if (step.options) assert.deepEqual(requestOptions, step.options);
      if (step.error) throw step.error;
      return structuredClone(step.response);
    },
    done() {
      assert.equal(steps.length, 0, 'All expected requests must execute');
    }
  };
}

function track(releases) {
  return { track: 'production', releases };
}

test('status reads review and publication lifecycle without creating or deleting edits', async () => {
  const releases = [
    {
      releaseName: '1.17.7',
      track: 'production',
      activeArtifacts: [{ versionCode: 11707001 }],
      releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_IN_REVIEW'
    }
  ];
  const client = transport([{ method: 'GET', path: `${app}/tracks/production/releases`, response: { releases } }]);
  assert.deepEqual(await play.status(client, options), {
    platform: 'android',
    packageName: options.packageName,
    track: 'production',
    releases
  });
  assert.equal(client.calls.length, 1);
  client.done();
});

test('status treats absent releases as empty and preserves an explicit track', async () => {
  const client = transport([{ method: 'GET', path: `${app}/tracks/internal/releases`, response: {} }]);
  assert.deepEqual(await play.status(client, { packageName: options.packageName, track: 'internal' }), {
    platform: 'android',
    packageName: options.packageName,
    track: 'internal',
    releases: []
  });
  client.done();
});

test('upload preserves every existing release and stages only the verified bundle without committing', async () => {
  const otherDraft = { name: 'Halted release', versionCodes: ['11705001'], status: 'halted' };
  const newDraft = { name: '1.17.7', versionCodes: ['11707001'], status: 'draft' };
  const client = transport([
    { method: 'GET', path: trackPath, response: track([live, otherDraft]) },
    {
      method: 'POST',
      path: `/upload${edit}/bundles?uploadType=media`,
      options: { rawBody: artifact, headers: { 'Content-Type': 'application/octet-stream' }, timeoutMs: 120000 },
      response: { versionCode: options.versionCode, sha256 }
    },
    {
      method: 'PUT',
      path: trackPath,
      options: { body: track([live, otherDraft, newDraft]) },
      response: track([live, otherDraft, newDraft])
    }
  ]);
  assert.deepEqual(await play.upload(client, { ...options, artifact }), {
    platform: 'android',
    packageName: options.packageName,
    track: 'production',
    version: '1.17.7',
    versionCode: options.versionCode,
    editId: 'edit-1',
    sha256,
    state: 'draft-uncommitted'
  });
  client.done();
});

test('upload refuses an outstanding draft before sending another bundle', async () => {
  const client = transport([
    { method: 'GET', path: trackPath, response: track([live, { ...draft, versionCodes: ['11707002'] }]) }
  ]);
  await assert.rejects(() => play.upload(client, { ...options, artifact }), /outstanding draft/);
  client.done();
});

test('upload requires a caller-owned edit and does not create one implicitly', async () => {
  const client = transport();
  await assert.rejects(() => play.upload(client, { ...options, editId: undefined, artifact }), /editId/);
  assert.equal(client.calls.length, 0);
});

test('upload refuses to replace a version already present in the selected track', async () => {
  const client = transport([{ method: 'GET', path: trackPath, response: track([live, draft]) }]);
  await assert.rejects(() => play.upload(client, { ...options, artifact }), /already present/);
  client.done();
});

for (const response of [
  { versionCode: 11707002, sha256 },
  { versionCode: 11707001, sha256: '0'.repeat(64) },
  { versionCode: 11707001 }
]) {
  test(`upload rejects server bundle identity mismatch ${JSON.stringify(response)}`, async () => {
    const client = transport([
      { method: 'GET', path: trackPath, response: track([live]) },
      { method: 'POST', path: `/upload${edit}/bundles?uploadType=media`, response }
    ]);
    await assert.rejects(() => play.upload(client, { ...options, artifact }), /uploaded bundle/);
    client.done();
  });
}

test('upload does not retry or delete the caller edit after a network failure', async () => {
  const failure = new Error('upload timeout');
  const client = transport([
    { method: 'GET', path: trackPath, response: track([live]) },
    { method: 'POST', path: `/upload${edit}/bundles?uploadType=media`, error: failure }
  ]);
  await assert.rejects(
    () => play.upload(client, { ...options, artifact }),
    error => error === failure
  );
  client.done();
});

test('submit requires acknowledgement that commit can include all pending console changes', async () => {
  const client = transport();
  await assert.rejects(() => play.submit(client, options), /allowPendingChanges/);
  assert.equal(client.calls.length, 0);
});

test('submit preserves existing releases and commits the exact draft without canceling an active review', async () => {
  const completed = { ...draft, status: 'completed' };
  const client = transport([
    { method: 'GET', path: trackPath, response: track([live, draft]) },
    { method: 'PUT', path: trackPath, options: { body: track([live, completed]) }, response: track([live, completed]) },
    { method: 'POST', path: `${edit}:validate`, response: { id: 'edit-1' } },
    {
      method: 'POST',
      path: `${edit}:commit?changesNotSentForReview=false&changesInReviewBehavior=ERROR_IF_IN_REVIEW`,
      response: { id: 'edit-1' }
    }
  ]);
  const result = await play.submit(client, { ...options, allowPendingChanges: true });
  assert.equal(result.state, 'committed');
  assert.equal(result.publication, 'verify-live-status');
  assert.equal(result.versionCode, options.versionCode);
  client.done();
});

for (const releases of [
  [live],
  [{ ...draft, status: 'inProgress' }],
  [{ ...draft, versionCodes: ['11707001', '11707002'] }],
  [draft, draft]
]) {
  test(`submit refuses missing, non-draft, grouped or ambiguous target ${JSON.stringify(releases)}`, async () => {
    const client = transport([{ method: 'GET', path: trackPath, response: track(releases) }]);
    await assert.rejects(() => play.submit(client, { ...options, allowPendingChanges: true }), /single draft/);
    client.done();
  });
}

test('submit stops on validation failure without committing', async () => {
  const failure = new Error('release validation failed');
  const client = transport([
    { method: 'GET', path: trackPath, response: track([live, draft]) },
    { method: 'PUT', path: trackPath, response: track([live, { ...draft, status: 'completed' }]) },
    { method: 'POST', path: `${edit}:validate`, error: failure }
  ]);
  await assert.rejects(
    () => play.submit(client, { ...options, allowPendingChanges: true }),
    error => error === failure
  );
  client.done();
});

test('release identifies approved managed publication as a console action and makes no mutation', async () => {
  const release = {
    releaseName: '1.17.7',
    track: 'production',
    activeArtifacts: [{ versionCode: 11707001 }],
    releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED'
  };
  const client = transport([
    { method: 'GET', path: `${app}/tracks/production/releases`, response: { releases: [release] } }
  ]);
  const result = await play.release(client, options);
  assert.equal(result.state, 'approved-awaiting-console-publication');
  assert.equal(result.actionRequired, 'publish-approved-changes-in-console');
  assert.equal(result.consoleUrl, 'https://play.google.com/console/');
  assert.equal(result.includesPendingConsoleChanges, true);
  client.done();
});

test('release reports a previously published version without claiming a full rollout', async () => {
  const release = {
    activeArtifacts: [{ versionCode: 11707001 }],
    releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_PUBLISHED'
  };
  const client = transport([
    { method: 'GET', path: `${app}/tracks/production/releases`, response: { releases: [release] } }
  ]);
  const result = await play.release(client, options);
  assert.equal(result.state, 'published-on-track');
  assert.equal(result.fullRolloutVerified, false);
  client.done();
});

test('release refuses a version still in review instead of directing publication', async () => {
  const release = {
    activeArtifacts: [{ versionCode: 11707001 }],
    releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_IN_REVIEW'
  };
  const client = transport([
    { method: 'GET', path: `${app}/tracks/production/releases`, response: { releases: [release] } }
  ]);
  await assert.rejects(() => play.release(client, options), /not approved/);
  client.done();
});

test('malformed identifiers, version codes and payloads fail before requests', async () => {
  const cases = [
    { ...options, packageName: 'com.miden.wallet/other' },
    { ...options, editId: '../other' },
    { ...options, track: 'production?other=1' },
    { ...options, versionCode: 0 },
    { ...options, versionCode: '11707001' },
    { ...options, versionCode: 11707001.5 },
    { ...options, artifact: new Uint8Array() },
    { ...options, artifact: 'not-binary' },
    { ...options, version: '1.17.7-devnet' }
  ];
  for (const item of cases) {
    const client = transport();
    await assert.rejects(() => play.upload(client, { ...item, artifact: item.artifact ?? artifact }));
    assert.equal(client.calls.length, 0);
  }
});

test('track identity mismatches fail before uploads or modifications', async () => {
  const client = transport([{ method: 'GET', path: trackPath, response: { track: 'internal', releases: [live] } }]);
  await assert.rejects(() => play.upload(client, { ...options, artifact }), /track identity/);
  client.done();
});


test('submit failure names its stage without retrying or exposing provider content', async () => {
  const failure = Object.assign(new Error('private provider content'), { status: 400 });
  const client = transport([{ method: 'GET', path: trackPath, response: track([draft]) },
    { method: 'PUT', path: trackPath, error: failure }]);
  await assert.rejects(play.submit(client, { ...options, allowPendingChanges: true }), error => {
    assert.equal(error, failure);
    assert.equal(error.stage, 'play-submit-track-update');
    return true;
  });
  client.done();
});

test('explicit edit inspection uses only GETs and reports expired edit separately from live releases', async () => {
  const expired = Object.assign(new Error('private body'), { status: 404 });
  const client = transport([
    { method: 'GET', path: `${app}/tracks/production/releases`, response: { releases: [] } },
    { method: 'GET', path: edit, error: expired }
  ]);
  const result = await play.status(client, { ...options, inspectEdit: true });
  assert.deepEqual(result.editInspection, { stage: 'play-inspect-edit', httpStatus: 404 });
  assert.deepEqual(result.releases, []);
  assert.doesNotMatch(JSON.stringify(result), /private body/);
  client.done();
});

test('explicit edit inspection reads exact caller edit and track without changing either', async () => {
  const client = transport([
    { method: 'GET', path: `${app}/tracks/production/releases`, response: { releases: [] } },
    { method: 'GET', path: edit, response: { id: 'edit-1', expiryTimeSeconds: '1', secret: 'hidden' } },
    { method: 'GET', path: trackPath, response: track([draft]) }
  ]);
  const result = await play.status(client, { ...options, inspectEdit: true });
  assert.equal(result.editInspection.id, 'edit-1');
  assert.equal(result.editInspection.expiryTimeSeconds, '1');
  assert.deepEqual(result.editInspection.releases, [draft]);
  assert.equal(client.calls.length, 3);
  client.done();
});

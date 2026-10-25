import assert from 'node:assert/strict';
import test from 'node:test';

import { release, status, submit, upload } from './chrome.mjs';

const publisherId = 'wallet-publisher';
const itemId = 'abcdefghijklmnopabcdefghijklmnop';
const name = `publishers/${publisherId}/items/${itemId}`;
const options = { publisherId, itemId, version: '1.17.7', artifact: new Uint8Array([1, 2, 3]) };
const revision = (state, ...versions) => ({
  state,
  distributionChannels: versions.map(crxVersion => ({ crxVersion }))
});
const snapshot = extra => ({ name, itemId, publishedItemRevisionStatus: revision('PUBLISHED', '1.17.6'), ...extra });
const uploaded = extra => ({ name, itemId, crxVersion: options.version, uploadState: 'SUCCEEDED', ...extra });
const published = state => ({ name, itemId, state });

function transport(...responses) {
  const calls = [];
  return {
    calls,
    async request(...args) {
      calls.push(args);
      assert.ok(responses.length, 'unexpected HTTP request');
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    }
  };
}

test('status uses the exact item and omits unrelated response fields', async () => {
  const client = transport(snapshot({ publicKey: 'irrelevant', unrecognized: 'not returned' }));
  const result = await status(client, options);
  assert.deepEqual(client.calls, [['GET', `/v2/${name}:fetchStatus`]]);
  assert.equal(result.itemId, itemId);
  assert.equal(result.publishedItemRevisionStatus.state, 'PUBLISHED');
  assert.equal(result.publicKey, undefined);
  assert.equal(result.unrecognized, undefined);
});

test('status rejects a response for another item or publisher', async () => {
  for (const extra of [{ itemId: 'ponmlkjihgfedcbaponmlkjihgfedcba' }, { name: 'publishers/other/items/other' }]) {
    await assert.rejects(status(transport(snapshot(extra)), options), /identity/);
  }
});

test('invalid resource identifiers fail before making a request', async () => {
  for (const extra of [{ publisherId: '../other' }, { itemId: 'invalid' }, { publisherId: '' }]) {
    const client = transport();
    await assert.rejects(status(client, { ...options, ...extra }), /identifier/);
    assert.equal(client.calls.length, 0);
  }
});

test('upload checks the current revision and sends ZIP media without publishing', async () => {
  const client = transport(snapshot(), uploaded());
  assert.deepEqual(await upload(client, options), uploaded());
  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls[1], [
    'POST',
    `/upload/v2/${name}:upload`,
    { rawBody: options.artifact, headers: { 'Content-Type': 'application/zip' } }
  ]);
});

test('upload refuses an active submission, including the same version', async () => {
  for (const state of ['PENDING_REVIEW', 'STAGED']) {
    const client = transport(snapshot({ submittedItemRevisionStatus: revision(state, options.version) }));
    await assert.rejects(upload(client, options), /submission/);
    assert.equal(client.calls.length, 1);
  }
});

test('upload refuses policy warnings, take-downs and unknown submission states', async () => {
  for (const extra of [
    { warned: true },
    { takenDown: true },
    { submittedItemRevisionStatus: revision('FUTURE_STATE', '1.17.5') }
  ]) {
    const client = transport(snapshot(extra));
    await assert.rejects(upload(client, options));
    assert.equal(client.calls.length, 1);
  }
});

test('upload requires a strictly newer version than every published channel', async () => {
  for (const versions of [['1.17.7'], ['1.17.6', '1.17.8'], []]) {
    const client = transport(snapshot({ publishedItemRevisionStatus: revision('PUBLISHED', ...versions) }));
    await assert.rejects(upload(client, options), /version/);
    assert.equal(client.calls.length, 1);
  }
});

test('Chrome version ordering compares numeric components and pads omitted zero components', async () => {
  const client = transport(
    snapshot({ publishedItemRevisionStatus: revision('PUBLISHED', '1.9') }),
    uploaded({ crxVersion: '1.10' })
  );
  assert.equal((await upload(client, { ...options, version: '1.10' })).crxVersion, '1.10');
  await assert.rejects(
    upload(transport(snapshot({ publishedItemRevisionStatus: revision('PUBLISHED', '1.10.0') })), {
      ...options,
      version: '1.10'
    }),
    /version/
  );
});

test('invalid Chrome versions and missing media fail before a request', async () => {
  for (const extra of [
    { version: '1.17.7-rc.1' },
    { version: '01.17.7' },
    { version: '0.0' },
    { version: '1.65536' },
    { artifact: new Uint8Array() },
    { artifact: 'file.zip' }
  ]) {
    const client = transport();
    await assert.rejects(upload(client, { ...options, ...extra }));
    assert.equal(client.calls.length, 0);
  }
});

test('upload refuses a successful response for the wrong item or version', async () => {
  for (const extra of [{ crxVersion: '1.17.8' }, { itemId: 'ponmlkjihgfedcbaponmlkjihgfedcba' }]) {
    await assert.rejects(upload(transport(snapshot(), uploaded(extra)), options), /identity|version/);
  }
});

test('asynchronous upload is reported as pending and is never implicitly submitted', async () => {
  const pending = uploaded({ uploadState: 'IN_PROGRESS', crxVersion: undefined });
  const client = transport(snapshot(), pending);
  assert.deepEqual(await upload(client, options), { name, itemId, uploadState: 'IN_PROGRESS' });
  assert.equal(client.calls.length, 2);
});

test('failed and unrecognized uploads do not produce a successful result or a retry', async () => {
  for (const uploadState of ['FAILED', 'UPLOAD_STATE_UNSPECIFIED', 'FUTURE_STATE']) {
    const client = transport(snapshot(), uploaded({ uploadState }));
    await assert.rejects(upload(client, options), /upload/);
    assert.equal(client.calls.length, 2);
  }
});

test('submit reuploads the selected artifact to prove the unsubmitted draft version', async () => {
  const client = transport(snapshot(), uploaded(), published('PENDING_REVIEW'));
  const result = await submit(client, options);
  assert.equal(result.state, 'PENDING_REVIEW');
  assert.equal(result.version, options.version);
  assert.deepEqual(
    client.calls.map(([method, path]) => [method, path]),
    [
      ['GET', `/v2/${name}:fetchStatus`],
      ['POST', `/upload/v2/${name}:upload`],
      ['POST', `/v2/${name}:publish`]
    ]
  );
  assert.deepEqual(client.calls[2][2], {
    body: { publishType: 'STAGED_PUBLISH', skipReview: false, blockOnWarnings: true }
  });
});

test('submit refuses an unproved draft even when an async upload has succeeded', async () => {
  const client = transport(snapshot({ lastAsyncUploadState: 'SUCCEEDED' }));
  await assert.rejects(submit(client, { ...options, artifact: undefined }), /artifact/);
  assert.equal(client.calls.length, 0);
});

test('submit never publishes after an asynchronous or wrong-version upload', async () => {
  for (const extra of [{ uploadState: 'IN_PROGRESS', crxVersion: undefined }, { crxVersion: '1.17.8' }]) {
    const client = transport(snapshot(), uploaded(extra));
    await assert.rejects(submit(client, options), /upload|version/);
    assert.equal(client.calls.length, 2);
  }
});

test('submit is idempotent for a uniquely matching pending or staged revision', async () => {
  for (const state of ['PENDING_REVIEW', 'STAGED']) {
    const client = transport(snapshot({ submittedItemRevisionStatus: revision(state, options.version) }));
    const result = await submit(client, options);
    assert.equal(result.state, state);
    assert.equal(result.alreadySubmitted, true);
    assert.equal(client.calls.length, 1);
  }
});

test('submit rejects different, absent or ambiguous active-submission versions', async () => {
  for (const versions of [['1.17.8'], [], [options.version, '1.17.8']]) {
    const client = transport(snapshot({ submittedItemRevisionStatus: revision('PENDING_REVIEW', ...versions) }));
    await assert.rejects(submit(client, options), /version/);
    assert.equal(client.calls.length, 1);
  }
});

test('release only sends a publishing request for the matching approved staged revision', async () => {
  const client = transport(
    snapshot({ submittedItemRevisionStatus: revision('STAGED', options.version) }),
    published('PUBLISHED')
  );
  const result = await release(client, options);
  assert.equal(result.state, 'PUBLISHED');
  assert.equal(result.version, options.version);
  assert.deepEqual(client.calls[1], [
    'POST',
    `/v2/${name}:publish`,
    { body: { publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true } }
  ]);
});

test('release refuses unreviewed, rejected, absent and mismatched staged revisions', async () => {
  for (const submittedItemRevisionStatus of [
    undefined,
    revision('PENDING_REVIEW', options.version),
    revision('REJECTED', options.version),
    revision('STAGED', '1.17.8'),
    revision('STAGED', options.version, '1.17.8'),
    revision('STAGED')
  ]) {
    const client = transport(snapshot({ submittedItemRevisionStatus }));
    await assert.rejects(release(client, options));
    assert.equal(client.calls.length, 1);
  }
});

test('release is idempotent only when all public channels already match', async () => {
  const client = transport(
    snapshot({ publishedItemRevisionStatus: revision('PUBLISHED', options.version, options.version) })
  );
  assert.equal((await release(client, options)).alreadyPublished, true);
  assert.equal(client.calls.length, 1);
  const ambiguous = transport(
    snapshot({ publishedItemRevisionStatus: revision('PUBLISHED', options.version, '1.17.6') })
  );
  await assert.rejects(release(ambiguous, options));
});

test('a failed HTTP request is propagated once without automatic retry', async () => {
  const error = new Error('transport failed');
  const client = transport(snapshot(), error);
  await assert.rejects(upload(client, options), error);
  assert.equal(client.calls.length, 2);
});

test('replacing a rejected package uploads without cancelling or publishing it', async () => {
  const client = transport(snapshot({ submittedItemRevisionStatus: revision('REJECTED', '1.17.5') }), uploaded());
  assert.equal((await upload(client, options)).uploadState, 'SUCCEEDED');
  assert.equal(client.calls.length, 2);
  assert.ok(client.calls.every(([, path]) => !path.endsWith(':cancelSubmission') && !path.endsWith(':publish')));
});

test('submit does not report success for a wrong-identity or unexpectedly public response', async () => {
  for (const response of [
    published('PUBLISHED'),
    { ...published('PENDING_REVIEW'), name: 'publishers/other/items/other' }
  ]) {
    const client = transport(snapshot(), uploaded(), response);
    await assert.rejects(submit(client, options), /identity|unexpected state/);
    assert.equal(client.calls.length, 3);
  }
});

test('release does not report success when the server unexpectedly requests review again', async () => {
  const client = transport(
    snapshot({ submittedItemRevisionStatus: revision('STAGED', options.version) }),
    published('PENDING_REVIEW')
  );
  await assert.rejects(release(client, options), /unexpected state/);
  assert.equal(client.calls.length, 2);
});

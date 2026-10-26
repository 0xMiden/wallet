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
  const client = transport(
    snapshot(),
    uploaded(),
    published('PENDING_REVIEW'),
    snapshot({ submittedItemRevisionStatus: revision('PENDING_REVIEW', options.version) })
  );
  const result = await submit(client, options);
  assert.equal(result.state, 'PENDING_REVIEW');
  assert.equal(result.version, options.version);
  assert.deepEqual(
    client.calls.map(([method, path]) => [method, path]),
    [
      ['GET', `/v2/${name}:fetchStatus`],
      ['POST', `/upload/v2/${name}:upload`],
      ['POST', `/v2/${name}:publish`],
      ['GET', `/v2/${name}:fetchStatus`]
    ]
  );
  assert.deepEqual(client.calls[2][2], {
    body: { publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true }
  });
});

test('submit confirms automatic publication when approval finishes before the status read', async () => {
  const client = transport(
    snapshot(),
    uploaded(),
    published('PENDING_REVIEW'),
    snapshot({ publishedItemRevisionStatus: revision('PUBLISHED', options.version) })
  );
  const result = await submit(client, options);
  assert.equal(result.state, 'PUBLISHED');
  assert.equal(result.submittedRevisionVerified, true);
  assert.equal(client.calls.length, 4);
});

test('submit accepts an immediately published response and does not request another release', async () => {
  const client = transport(
    snapshot(),
    uploaded(),
    published('PUBLISHED'),
    snapshot({ publishedItemRevisionStatus: revision('PUBLISHED', options.version) })
  );
  assert.equal((await submit(client, options)).state, 'PUBLISHED');
  assert.equal(client.calls.filter(([method, path]) => method === 'POST' && path.endsWith(':publish')).length, 1);
});

test('submit refuses an unproved draft even when an async upload has succeeded', async () => {
  const client = transport(snapshot({ lastAsyncUploadState: 'SUCCEEDED' }));
  await assert.rejects(submit(client, { ...options, artifact: undefined }), /artifact/);
  assert.equal(client.calls.length, 0);
});

test('submit never publishes after an asynchronous or wrong-version upload', async () => {
  for (const extra of [{ uploadState: 'IN_PROGRESS', crxVersion: undefined }, { crxVersion: '1.17.8' }]) {
    const client = transport(snapshot(), uploaded(extra));
    if (extra.uploadState === 'IN_PROGRESS') assert.equal((await submit(client, options)).uploadState, 'IN_PROGRESS');
    else await assert.rejects(submit(client, options), /upload|version/);
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

test('submit does not report success for a wrong-identity or unexpectedly deferred response', async () => {
  for (const response of [
    published('STAGED'),
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

const session = (extra = {}) => ({
  schemaVersion: 1,
  platform: 'chrome',
  identity: itemId,
  storeId: itemId,
  publisherId,
  version: options.version,
  sourceSha: 'a'.repeat(40),
  network: 'testnet',
  sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
  state: 'accepted-async',
  acceptedAt: 1700000000,
  ...extra
});
const resumeOptions = (extra = {}) => ({
  ...options,
  uploadSession: session(),
  nowSeconds: () => 1700000010,
  persistUploadSession: async () => {},
  wait: async () => {},
  ...extra
});

test('accepted async upload resumes the exact journal without sending ZIP media again', async () => {
  const client = transport(snapshot({ lastAsyncUploadState: 'SUCCEEDED' }));
  const states = [];
  const result = await upload(client, resumeOptions({ persistUploadSession: async value => states.push(value) }));
  assert.equal(result.uploadState, 'SUCCEEDED');
  assert.equal(result.completionEvidence, 'accepted-async-journal');
  assert.equal(result.crxVersion, undefined);
  assert.equal(states.at(-1).state, 'completed-async');
  assert.deepEqual(
    client.calls.map(call => call[0]),
    ['GET']
  );
});

test('pending async submission publishes once and verifies the exact submitted revision', async () => {
  const client = transport(
    snapshot({ lastAsyncUploadState: 'SUCCEEDED' }),
    published('PENDING_REVIEW'),
    snapshot({ submittedItemRevisionStatus: revision('PENDING_REVIEW', options.version) })
  );
  const states = [];
  const result = await submit(client, resumeOptions({ persistUploadSession: async value => states.push(value) }));
  assert.equal(result.state, 'PENDING_REVIEW');
  assert.equal(states.at(-1).state, 'submitted');
  assert.equal(client.calls.filter(([method]) => method === 'POST').length, 1);
  assert.ok(client.calls.every(([, path]) => !path.includes('/upload/')));
});

test('uncertain, expired, future, mismatched or failed async sessions never send another POST', async () => {
  for (const extra of [
    { state: 'request-started' },
    { acceptedAt: 1699900000 },
    { acceptedAt: 1700000100 },
    { sha256: 'f'.repeat(64) },
    { publisherId: 'other' },
    { version: '1.17.8' }
  ]) {
    const client = transport(snapshot({ lastAsyncUploadState: 'SUCCEEDED' }));
    await assert.rejects(
      submit(client, resumeOptions({ uploadSession: session(extra) })),
      /upload|session|version|journal/i
    );
    assert.ok(client.calls.every(([method]) => method === 'GET'));
  }
  for (const lastAsyncUploadState of ['FAILED', 'NOT_FOUND', undefined]) {
    const client = transport(snapshot({ lastAsyncUploadState }));
    await assert.rejects(submit(client, resumeOptions()), /upload|async|status/i);
    assert.ok(client.calls.every(([method]) => method === 'GET'));
  }
});

test('submission revision conflict after accepted publish is not attested or retried', async () => {
  const client = transport(
    snapshot({ lastAsyncUploadState: 'SUCCEEDED' }),
    published('PENDING_REVIEW'),
    snapshot({ submittedItemRevisionStatus: revision('PENDING_REVIEW', '1.17.8') })
  );
  const states = [];
  await assert.rejects(
    submit(client, resumeOptions({ persistUploadSession: async value => states.push(value) })),
    /version|revision/i
  );
  assert.equal(states.at(-1).state, 'submission-requested');
  assert.equal(client.calls.filter(([method]) => method === 'POST').length, 1);
});

test('upload journals the request before its only media POST and preserves uncertainty on transport error', async () => {
  const states = [];
  const client = transport(snapshot(), new Error('transport outcome unknown'));
  const request = client.request;
  client.request = async (...args) => {
    if (args[0] === 'POST') assert.equal(states.at(-1).state, 'request-started');
    return request(...args);
  };
  await assert.rejects(
    upload(client, {
      ...options,
      nowSeconds: () => 1700000010,
      persistUploadSession: async value => states.push(value)
    }),
    /transport/
  );
  assert.deepEqual(
    states.map(value => value.state),
    ['request-started']
  );
  assert.equal(client.calls.filter(call => call[0] === 'POST').length, 1);
});

test('async polling is bounded and pending state does not trigger publishing or reupload', async () => {
  const client = transport(...Array.from({ length: 6 }, () => snapshot({ lastAsyncUploadState: 'IN_PROGRESS' })));
  let waits = 0;
  const result = await submit(
    client,
    resumeOptions({
      wait: async () => {
        waits++;
      }
    })
  );
  assert.equal(result.uploadState, 'IN_PROGRESS');
  assert.equal(waits, 5);
  assert.equal(client.calls.length, 6);
  assert.ok(client.calls.every(call => call[0] === 'GET'));
});

test('uncertain upload cannot adopt an existing revision and uncertain publish never repeats the POST', async () => {
  const active = snapshot({ submittedItemRevisionStatus: revision('PENDING_REVIEW', options.version) });
  const uncertain = transport(active);
  await assert.rejects(
    submit(uncertain, resumeOptions({ uploadSession: session({ state: 'request-started' }) })),
    /uncertain|upload/i
  );
  assert.equal(uncertain.calls.filter(call => call[0] === 'POST').length, 0);
  const pending = session({ state: 'submission-requested', completedAt: 1700000005 });
  const absent = transport(snapshot());
  await assert.rejects(submit(absent, resumeOptions({ uploadSession: pending })), /uncertain|submission/i);
  assert.equal(absent.calls.filter(call => call[0] === 'POST').length, 0);
  const confirmed = transport(active);
  assert.equal((await submit(confirmed, resumeOptions({ uploadSession: pending }))).alreadySubmitted, true);
  assert.equal(confirmed.calls.filter(call => call[0] === 'POST').length, 0);
});

test('terminal prior upload journal rolls over only after exact prior publication and durable archive', async () => {
  const prior = session({ state: 'submitted', acceptedAt: 1690000000, completedAt: 1690000005 });
  const next = { ...options, version: '1.17.8', uploadSession: prior, nowSeconds: () => 1700000010 };
  const effects = [];
  const client = transport(
    snapshot({
      publishedItemRevisionStatus: {
        state: 'PUBLISHED',
        distributionChannels: [{ crxVersion: '1.17.7', deployPercentage: 100 }]
      }
    }),
    uploaded({ crxVersion: '1.17.8' })
  );
  const request = client.request;
  client.request = async (...args) => {
    if (args[0] === 'POST')
      assert.deepEqual(
        effects.map(value => value[0]),
        ['archive', 'request-started']
      );
    return request(...args);
  };
  const result = await upload(client, {
    ...next,
    archiveUploadSession: async value => effects.push(['archive', value]),
    persistUploadSession: async value => effects.push([value.state, value])
  });
  assert.equal(result.crxVersion, '1.17.8');
  assert.deepEqual(effects[0][1], prior);
  assert.equal(client.calls.filter(call => call[0] === 'POST').length, 1);
});

test('rollover refuses pending or uncertain journals, nonnewer versions, conflicts and failed archival', async () => {
  const prior = session({ state: 'submitted', completedAt: 1700000005 });
  for (const extra of [
    { state: 'accepted-async' },
    { state: 'request-started' },
    { state: 'submission-requested' },
    { state: 'completed-async' }
  ]) {
    const client = transport(snapshot({ publishedItemRevisionStatus: revision('PUBLISHED', '1.17.7') }));
    await assert.rejects(
      upload(
        client,
        resumeOptions({
          version: '1.17.8',
          uploadSession: { ...prior, ...extra },
          archiveUploadSession: async () => {}
        })
      ),
      /journal|session|terminal|upload/i
    );
    assert.ok(client.calls.every(call => call[0] === 'GET'));
  }
  for (const current of [
    snapshot(),
    snapshot({ publishedItemRevisionStatus: revision('PUBLISHED', '1.17.7', '1.17.6') }),
    snapshot({
      publishedItemRevisionStatus: revision('PUBLISHED', '1.17.7'),
      submittedItemRevisionStatus: revision('PENDING_REVIEW', '1.17.8')
    }),
    snapshot({ publishedItemRevisionStatus: revision('PUBLISHED', '1.17.7'), warned: true })
  ]) {
    const client = transport(current);
    await assert.rejects(
      upload(client, resumeOptions({ version: '1.17.8', uploadSession: prior, archiveUploadSession: async () => {} }))
    );
    assert.ok(client.calls.every(call => call[0] === 'GET'));
  }
  for (const deployPercentage of [0, undefined]) {
    let archives = 0;
    const channel = { crxVersion: '1.17.7', ...(deployPercentage === undefined ? {} : { deployPercentage }) };
    const client = transport(
      snapshot({ publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [channel] } }),
      uploaded({ crxVersion: '1.17.8' })
    );
    await assert.rejects(
      upload(
        client,
        resumeOptions({
          version: '1.17.8',
          uploadSession: prior,
          archiveUploadSession: async () => {
            archives++;
          }
        })
      ),
      /partial|rollout|channel/i
    );
    assert.equal(archives, 0);
    assert.ok(client.calls.every(call => call[0] === 'GET'));
  }
  const archived = transport(
    snapshot({
      publishedItemRevisionStatus: {
        state: 'PUBLISHED',
        distributionChannels: [{ crxVersion: '1.17.7', deployPercentage: 100 }]
      }
    })
  );
  await assert.rejects(
    upload(
      archived,
      resumeOptions({
        version: '1.17.8',
        uploadSession: prior,
        archiveUploadSession: async () => {
          throw new Error('archive write failed');
        }
      })
    ),
    /archive/i
  );
  assert.ok(archived.calls.every(call => call[0] === 'GET'));
  await assert.rejects(
    upload(
      transport(),
      resumeOptions({ version: '1.17.6', uploadSession: prior, archiveUploadSession: async () => {} })
    ),
    /newer|version/
  );
});

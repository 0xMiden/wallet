import assert from 'node:assert/strict';
import { test } from 'node:test';

import { release, status, submit, upload } from './apple.mjs';
const options = {
  appId: '123456789',
  bundleId: 'com.miden.bread',
  version: '1.17.7',
  buildNumber: '19',
  releasePolicy: 'preserve-existing'
};
const ref = (type, id) => ({ data: { type, id } });

function fixture(overrides = {}) {
  const app = { type: 'apps', id: options.appId, attributes: { bundleId: options.bundleId, name: 'Bread' } };
  const version = {
    type: 'appStoreVersions',
    id: 'version-1',
    attributes: {
      platform: 'IOS',
      versionString: options.version,
      appStoreState: 'PREPARE_FOR_SUBMISSION',
      releaseType: 'MANUAL'
    },
    relationships: { build: ref('builds', 'build-1') }
  };
  const build = {
    type: 'builds',
    id: 'build-1',
    attributes: {
      version: options.buildNumber,
      processingState: 'VALID',
      expired: false,
      buildAudienceType: 'APP_STORE_ELIGIBLE'
    }
  };
  const preRelease = {
    type: 'preReleaseVersions',
    id: 'prerelease-1',
    attributes: { version: options.version, platform: 'IOS' }
  };
  const state = {
    app,
    versions: [version],
    builds: [build],
    preRelease,
    reviews: [],
    items: [],
    localizations: [
      {
        type: 'appStoreVersionLocalizations',
        id: 'locale-1',
        attributes: { locale: 'en-US', whatsNew: 'Existing release notes' }
      }
    ],
    ...overrides
  };
  const calls = [];
  const client = {
    request: async (method, path, init = {}) => {
      calls.push({ method, path, ...init });
      const url = new URL(path, 'https://api.appstoreconnect.apple.com');
      if (state.respond) {
        const result = await state.respond(method, url, init);
        if (result !== undefined) return structuredClone(result);
      }
      let result;
      if (method === 'GET' && url.pathname === `/v1/apps/${options.appId}`) result = { data: state.app };
      else if (method === 'GET' && url.pathname.endsWith('/appStoreVersionLocalizations'))
        result = { data: state.localizations };
      else if (method === 'PATCH' && url.pathname === '/v1/appStoreVersionLocalizations/locale-1') {
        Object.assign(state.localizations[0].attributes, init.body.data.attributes);
        result = { data: state.localizations[0] };
      } else if (method === 'GET' && url.pathname.endsWith('/appStoreVersions')) result = { data: state.versions };
      else if (method === 'GET' && url.pathname === '/v1/builds') result = { data: state.builds };
      else if (method === 'GET' && url.pathname === '/v1/builds/build-1/app')
        result = { data: state.buildApp ?? state.app };
      else if (method === 'GET' && url.pathname === '/v1/builds/build-1/preReleaseVersion')
        result = { data: state.preRelease };
      else if (method === 'GET' && url.pathname === '/v1/reviewSubmissions') result = { data: state.reviews };
      else if (method === 'GET' && url.pathname.endsWith('/items')) result = { data: state.items };
      else if (method === 'GET' && url.pathname === '/v1/appStoreVersions/version-1')
        result = { data: state.versions[0] };
      else if (method === 'PATCH' && url.pathname === '/v1/appStoreVersions/version-1') {
        if (init.body.data.relationships) Object.assign(state.versions[0].relationships, init.body.data.relationships);
        if (init.body.data.attributes) Object.assign(state.versions[0].attributes, init.body.data.attributes);
        result = { data: state.versions[0] };
      } else if (method === 'POST' && url.pathname === '/v1/reviewSubmissions') {
        state.reviews = [matchingDraft()];
        result = { data: state.reviews[0] };
      } else if (method === 'POST' && url.pathname === '/v1/reviewSubmissionItems') {
        state.items = [matchingItem()];
        result = { data: { type: 'reviewSubmissionItems', id: 'item-1' } };
      } else if (method === 'PATCH' && url.pathname === '/v1/reviewSubmissions/review-1')
        result = { data: { type: 'reviewSubmissions', id: 'review-1', attributes: { state: 'WAITING_FOR_REVIEW' } } };
      else if (method === 'POST' && url.pathname === '/v1/appStoreVersionReleaseRequests')
        result = { data: { type: 'appStoreVersionReleaseRequests', id: 'release-1' } };
      else assert.fail(`Unexpected ${method} ${url.pathname}`);
      return structuredClone(result);
    },
    uploadIpa: async value => {
      calls.push({ method: 'UPLOAD_IPA', options: value });
    }
  };
  return { client, state, calls, version, build, app };
}

const mutations = calls => calls.filter(call => call.method !== 'GET');
const matchingDraft = () => ({
  type: 'reviewSubmissions',
  id: 'review-1',
  attributes: { platform: 'IOS', state: 'READY_FOR_REVIEW' },
  relationships: { app: ref('apps', options.appId) }
});
const matchingItem = () => ({
  type: 'reviewSubmissionItems',
  id: 'item-1',
  relationships: { appStoreVersion: ref('appStoreVersions', 'version-1') }
});

function lostSubmitAcknowledgement(error = new Error('Store API request failed'), change = () => {}) {
  let submitted = false;
  const f = fixture();
  f.state.respond = (method, url, init) => {
    if (method === 'PATCH' && url.pathname === '/v1/reviewSubmissions/review-1') {
      submitted = true;
      f.state.reviews[0].attributes.state = 'WAITING_FOR_REVIEW';
      f.version.attributes.appStoreState = 'WAITING_FOR_REVIEW';
      f.state.items[0].attributes = { state: 'READY_FOR_REVIEW' };
      change(f);
      throw error;
    }
    if (submitted && method === 'GET' && url.pathname === '/v1/reviewSubmissions/review-1')
      return { data: f.state.reviews[0] };
    if (submitted && f.afterSubmit) return f.afterSubmit(method, url, init);
  };
  return { ...f, error };
}

test('lost final submit acknowledgement is reconciled by exact persisted review without mutation replay', async () => {
  const f = lostSubmitAcknowledgement();
  const result = await submit(f.client, { ...options, releasePolicy: 'after-approval' });
  assert.equal(result.state, 'WAITING_FOR_REVIEW');
  assert.equal(result.reviewSubmissionId, 'review-1');
  assert.equal(result.submissionRequested, true);
  assert.equal(result.submissionReconciled, true);
  assert.equal(result.autoReleaseAfterApproval, true);
  assert.equal(result.published, false);
  const finalPatch = f.calls.findIndex(c => c.path === '/v1/reviewSubmissions/review-1' && c.method === 'PATCH');
  assert.ok(finalPatch >= 0);
  assert.ok(f.calls.slice(finalPatch + 1).length > 0);
  assert.ok(f.calls.slice(finalPatch + 1).every(c => c.method === 'GET'));
  assert.equal(f.calls.filter(c => c.method === 'PATCH' && c.path === '/v1/reviewSubmissions/review-1').length, 1);
});

test('ambiguous server errors can reconcile an exact review already in review with the preserved manual policy', async () => {
  const error = Object.assign(new Error('Store API request failed'), { status: 503 });
  const f = lostSubmitAcknowledgement(error, f => {
    f.state.reviews[0].attributes.state = 'IN_REVIEW';
    f.version.attributes.appStoreState = 'IN_REVIEW';
    f.state.items[0].attributes.state = 'ACCEPTED';
  });
  const result = await submit(f.client, options);
  assert.equal(result.state, 'IN_REVIEW');
  assert.equal(result.releaseType, 'MANUAL');
  assert.equal(result.autoReleaseAfterApproval, false);
  assert.equal(result.submissionReconciled, true);
});

test('definitive HTTP rejection preserves the original error and performs no recovery reads', async () => {
  for (const status of [400, 401, 403, 404, 408, 409, 422, 429]) {
    const error = Object.assign(new Error('Store API request failed'), { status, appleCodes: ['STATE_ERROR'] });
    const f = lostSubmitAcknowledgement(error);
    await assert.rejects(submit(f.client, options), e => e === error && e.stage === 'apple-review-submit');
    assert.equal(f.calls.at(-1).method, 'PATCH');
    assert.equal(f.calls.at(-1).path, '/v1/reviewSubmissions/review-1');
  }
});

test('reconciliation refuses incomplete, rejected or mismatched persisted submission evidence', async t => {
  const changes = {
    'wrong review id': f => {
      f.state.reviews[0].id = 'other-review';
    },
    'wrong review app': f => {
      f.state.reviews[0].relationships.app.data.id = '987654321';
    },
    'wrong review platform': f => {
      f.state.reviews[0].attributes.platform = 'MAC_OS';
    },
    'ready review': f => {
      f.state.reviews[0].attributes.state = 'READY_FOR_REVIEW';
    },
    'unresolved review': f => {
      f.state.reviews[0].attributes.state = 'UNRESOLVED_ISSUES';
    },
    'canceling review': f => {
      f.state.reviews[0].attributes.state = 'CANCELING';
    },
    'complete review': f => {
      f.state.reviews[0].attributes.state = 'COMPLETE';
    },
    'wrong version id': f => {
      f.version.id = 'other-version';
    },
    'wrong marketing version': f => {
      f.version.attributes.versionString = '1.0';
    },
    'wrong version platform': f => {
      f.version.attributes.platform = 'MAC_OS';
    },
    'ready version': f => {
      f.version.attributes.appStoreState = 'READY_FOR_REVIEW';
    },
    'rejected version': f => {
      f.version.attributes.appStoreState = 'REJECTED';
    },
    'wrong version build': f => {
      f.version.relationships.build.data.id = 'other-build';
    },
    'changed release policy': f => {
      f.version.attributes.releaseType = 'AFTER_APPROVAL';
    },
    'wrong app bundle': f => {
      f.app.attributes.bundleId = 'com.other.app';
    },
    'wrong build id': f => {
      f.build.id = 'other-build';
    },
    'wrong build number': f => {
      f.build.attributes.version = '200';
    },
    'invalid build': f => {
      f.build.attributes.processingState = 'FAILED';
    },
    'expired build': f => {
      f.build.attributes.expired = true;
    },
    'ineligible build': f => {
      f.build.attributes.buildAudienceType = 'INTERNAL_ONLY';
    },
    'wrong build app': f => {
      f.state.buildApp = { ...f.app, id: '987654321' };
    },
    'wrong build marketing version': f => {
      f.state.preRelease.attributes.version = '1.0';
    },
    'wrong item version': f => {
      f.state.items[0].relationships.appStoreVersion.data.id = 'other-version';
    },
    'rejected item': f => {
      f.state.items[0].attributes.state = 'REJECTED';
    },
    'removed item': f => {
      f.state.items[0].attributes.state = 'REMOVED';
    },
    'unknown item state': f => {
      delete f.state.items[0].attributes.state;
    },
    'extra review item': f => {
      f.state.items.push({ ...matchingItem(), id: 'item-2' });
    },
    'missing review item': f => {
      f.state.items = [];
    },
    'unavailable readback': f => {
      f.afterSubmit = () => {
        throw new Error('Readback unavailable');
      };
    }
  };
  for (const [name, change] of Object.entries(changes)) {
    await t.test(name, async () => {
      const f = lostSubmitAcknowledgement(undefined, change);
      await assert.rejects(submit(f.client, options), e => e === f.error && e.stage === 'apple-review-submit');
      const finalPatch = f.calls.findIndex(c => c.path === '/v1/reviewSubmissions/review-1' && c.method === 'PATCH');
      assert.ok(f.calls.slice(finalPatch + 1).every(c => c.method === 'GET'));
    });
  }
});

test('read-only reconciliation caps pagination work and retains the original failure', async () => {
  let page = 0;
  const f = lostSubmitAcknowledgement(undefined, f => {
    f.afterSubmit = (method, url) => {
      if (url.pathname === '/v1/reviewSubmissions/review-1/items') {
        page += 1;
        return { data: [], links: { next: `/v1/reviewSubmissions/review-1/items?page=${page}` } };
      }
    };
  });
  await assert.rejects(submit(f.client, options), e => e === f.error);
  const finalPatch = f.calls.findIndex(c => c.path === '/v1/reviewSubmissions/review-1' && c.method === 'PATCH');
  assert.ok(f.calls.slice(finalPatch + 1).length <= 10);
  assert.ok(page > 0);
});

test('read-only reconciliation shares one time budget across requests', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const f = lostSubmitAcknowledgement(undefined, f => {
    f.afterSubmit = (method, url) => {
      if (url.pathname === `/v1/apps/${options.appId}`) now += 30001;
    };
  });
  await assert.rejects(submit(f.client, options), e => e === f.error);
  const finalPatch = f.calls.findIndex(c => c.path === '/v1/reviewSubmissions/review-1' && c.method === 'PATCH');
  const reads = f.calls.slice(finalPatch + 1);
  assert.ok(reads.length > 0 && reads.length <= 2);
  assert.ok(reads.every(c => c.timeoutMs > 0 && c.timeoutMs <= 30000));
});

test('status validates the app identity and reports actual version/build state without mutations', async () => {
  const { client, calls } = fixture();
  const result = await status(client, options);
  assert.equal(result.platform, 'ios');
  assert.equal(result.app.bundleId, options.bundleId);
  assert.equal(result.versions[0].version, options.version);
  assert.equal(result.versions[0].state, 'PREPARE_FOR_SUBMISSION');
  assert.equal(result.builds[0].buildNumber, options.buildNumber);
  assert.deepEqual(mutations(calls), []);
  const buildsUrl = new URL(
    calls.find(call => call.path.startsWith('/v1/builds?')).path,
    'https://api.appstoreconnect.apple.com'
  );
  assert.equal(buildsUrl.searchParams.get('filter[app]'), options.appId);
  assert.equal(buildsUrl.searchParams.get('filter[preReleaseVersion.version]'), options.version);
});

test('wrong app bundle identity stops before reading or changing other resources', async () => {
  const { client, state, calls } = fixture();
  state.app.attributes.bundleId = 'com.other.app';
  await assert.rejects(submit(client, options), /identity/);
  assert.equal(calls.length, 1);
});

test('malformed target app ids and missing mutation selectors make no request', async () => {
  for (const change of [{ appId: '../other' }, { bundleId: '' }, { version: '' }, { buildNumber: '' }]) {
    const { client, calls } = fixture();
    await assert.rejects(submit(client, { ...options, ...change }), /required|invalid/i);
    assert.equal(calls.length, 0);
  }
});

test('upload verifies identity then delegates exact IPA without creating a review or release', async () => {
  const { client, calls } = fixture();
  const value = { ...options, artifact: '/private/release.ipa' };
  const result = await upload(client, value);
  assert.deepEqual(mutations(calls), [{ method: 'UPLOAD_IPA', options: value }]);
  assert.equal(result.state, 'UPLOAD_ACCEPTED');
  assert.equal(result.published, false);
});

test('upload refuses a non-IPA artifact or unavailable uploader without a mutation', async () => {
  for (const artifact of ['', '/private/release.zip']) {
    const { client, calls } = fixture();
    await assert.rejects(upload(client, { ...options, artifact }), /IPA/);
    assert.deepEqual(mutations(calls), []);
  }
  const { client, calls } = fixture();
  delete client.uploadIpa;
  await assert.rejects(upload(client, { ...options, artifact: '/private/release.ipa' }), /uploader/i);
  assert.deepEqual(mutations(calls), []);
});

test('submission changes only the requested build and uses the modern review workflow', async () => {
  const { client, calls, version, state } = fixture();
  version.relationships.build.data.id = 'previous-build';
  state.respond = (method, url, init) => {
    if (method === 'PATCH' && url.pathname === '/v1/appStoreVersions/version-1') {
      version.relationships = init.body.data.relationships;
      return { data: version };
    }
  };
  const result = await submit(client, options);
  assert.deepEqual(
    mutations(calls).map(call => [call.method, call.path]),
    [
      ['PATCH', '/v1/appStoreVersions/version-1'],
      ['POST', '/v1/reviewSubmissions'],
      ['POST', '/v1/reviewSubmissionItems'],
      ['PATCH', '/v1/reviewSubmissions/review-1']
    ]
  );
  assert.deepEqual(mutations(calls)[0].body, {
    data: {
      type: 'appStoreVersions',
      id: 'version-1',
      relationships: { build: ref('builds', 'build-1') }
    }
  });
  assert.deepEqual(mutations(calls)[1].body, {
    data: { type: 'reviewSubmissions', relationships: { app: ref('apps', options.appId) } }
  });
  assert.deepEqual(mutations(calls)[2].body.data.relationships, {
    reviewSubmission: ref('reviewSubmissions', 'review-1'),
    appStoreVersion: ref('appStoreVersions', 'version-1')
  });
  assert.deepEqual(mutations(calls)[3].body, {
    data: { type: 'reviewSubmissions', id: 'review-1', attributes: { submitted: true } }
  });
  assert.equal(result.submissionRequested, true);
  assert.equal(result.state, 'WAITING_FOR_REVIEW');
  assert.equal(result.published, false);
});

test('missing draft requires console preparation instead of fabricating metadata', async () => {
  const { client, calls } = fixture({ versions: [] });
  await assert.rejects(submit(client, options), /draft.*console/i);
  assert.deepEqual(mutations(calls), []);
});

test('duplicate exact version or build results are refused before mutations', async () => {
  for (const kind of ['versions', 'builds']) {
    const { client, state, calls } = fixture();
    state[kind].push(structuredClone(state[kind][0]));
    await assert.rejects(submit(client, options), /ambiguous|duplicate/i);
    assert.deepEqual(mutations(calls), []);
  }
});

test('wrong returned platform, marketing version or build number is refused', async () => {
  for (const [resource, attribute, value] of [
    ['versions', 'platform', 'MAC_OS'],
    ['versions', 'versionString', '9.9.9'],
    ['builds', 'version', '999']
  ]) {
    const { client, state, calls } = fixture();
    state[resource][0].attributes[attribute] = value;
    await assert.rejects(submit(client, options), /exact|match|version|platform/i);
    assert.deepEqual(mutations(calls), []);
  }
});

test('submitted and live app versions cannot be resubmitted', async () => {
  for (const stateName of ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'READY_FOR_SALE', 'PENDING_DEVELOPER_RELEASE']) {
    const { client, version, calls } = fixture();
    version.attributes.appStoreState = stateName;
    await assert.rejects(submit(client, options), /editable|draft/i);
    assert.deepEqual(mutations(calls), []);
  }
});

test('unprocessed, expired and internal-only builds cannot be submitted', async () => {
  for (const change of [
    { processingState: 'PROCESSING' },
    { processingState: 'INVALID' },
    { expired: true },
    { buildAudienceType: 'INTERNAL_ONLY' }
  ]) {
    const { client, build, calls } = fixture();
    Object.assign(build.attributes, change);
    await assert.rejects(submit(client, options), /processed|expired|eligible/i);
    assert.deepEqual(mutations(calls), []);
  }
});

test('selected build must independently belong to the exact app and iOS marketing version', async () => {
  for (const change of ['app', 'version', 'platform']) {
    const { client, state, calls } = fixture();
    if (change === 'app') state.buildApp = { ...state.app, id: '987654321' };
    if (change === 'version') state.preRelease.attributes.version = '1.0.0';
    if (change === 'platform') state.preRelease.attributes.platform = 'MAC_OS';
    await assert.rejects(submit(client, options), /app|version|platform/i);
    assert.deepEqual(mutations(calls), []);
  }
});

test('an unrelated or already active review submission is never altered', async () => {
  for (const change of ['active', 'other-item', 'multiple-items', 'multiple-drafts', 'wrong-app', 'missing-app']) {
    const { client, state, calls } = fixture({ reviews: [matchingDraft()], items: [matchingItem()] });
    if (change === 'active') state.reviews[0].attributes.state = 'IN_REVIEW';
    if (change === 'other-item') state.items[0].relationships.appStoreVersion.data.id = 'other-version';
    if (change === 'multiple-items') state.items.push({ ...matchingItem(), id: 'other-item' });
    if (change === 'multiple-drafts') state.reviews.push({ ...matchingDraft(), id: 'other-draft' });
    if (change === 'wrong-app') state.reviews[0].relationships.app.data.id = 'other-app';
    if (change === 'missing-app') delete state.reviews[0].relationships.app;
    await assert.rejects(submit(client, options), /review|submission|draft/i);
    assert.deepEqual(mutations(calls), []);
  }
});

test('an exact existing singleton review draft is reused without duplicate items', async () => {
  const { client, version, calls } = fixture({ reviews: [matchingDraft()], items: [matchingItem()] });
  version.attributes.appStoreState = 'READY_FOR_REVIEW';
  const result = await submit(client, options);
  assert.deepEqual(
    mutations(calls).map(call => call.path),
    ['/v1/reviewSubmissions/review-1']
  );
  assert.equal(result.submissionRequested, true);
});

test('ready-for-review draft build mismatch or unsupported release is refused', async () => {
  for (const change of ['build', 'release']) {
    const { client, version, calls } = fixture({ reviews: [matchingDraft()], items: [matchingItem()] });
    version.attributes.appStoreState = 'READY_FOR_REVIEW';
    if (change === 'build') version.relationships.build.data.id = 'another-build';
    if (change === 'release') version.attributes.releaseType = 'SCHEDULED';
    await assert.rejects(submit(client, options), /build|release/i);
    assert.deepEqual(mutations(calls), []);
  }
});

test('a rejected review API request stops without publishing or cancelling the draft', async () => {
  const { client, calls } = fixture({
    respond(method, url) {
      if (method === 'POST' && url.pathname === '/v1/reviewSubmissionItems')
        throw new Error('Apple rejected review item');
    }
  });
  await assert.rejects(submit(client, options), /rejected review item/);
  assert.equal(mutations(calls).length, 2);
  assert.ok(!calls.some(call => call.method === 'DELETE' || call.path.includes('ReleaseRequests')));
});

test('release requests only the exact manually held approved version and reports pending publication', async () => {
  const { client, version, calls } = fixture();
  version.attributes.appStoreState = 'PENDING_DEVELOPER_RELEASE';
  const result = await release(client, options);
  assert.deepEqual(mutations(calls), [
    {
      method: 'POST',
      path: '/v1/appStoreVersionReleaseRequests',
      body: {
        data: {
          type: 'appStoreVersionReleaseRequests',
          relationships: { appStoreVersion: ref('appStoreVersions', 'version-1') }
        }
      }
    }
  ]);
  assert.equal(result.releaseRequested, true);
  assert.equal(result.irreversible, true);
  assert.equal(result.published, false);
});

test('release refuses a nonapproved version, wrong linked build, or automatic release configuration', async () => {
  for (const change of ['state', 'build', 'release']) {
    const { client, version, calls } = fixture();
    version.attributes.appStoreState = 'PENDING_DEVELOPER_RELEASE';
    if (change === 'state') version.attributes.appStoreState = 'IN_REVIEW';
    if (change === 'build') version.relationships.build.data.id = 'another-build';
    if (change === 'release') version.attributes.releaseType = 'AFTER_APPROVAL';
    await assert.rejects(release(client, options), /approved|build|manual/i);
    assert.deepEqual(mutations(calls), []);
  }
});

test('list pagination is followed only on the same official resource and detects loops', async () => {
  const { client, calls } = fixture({
    respond(method, url) {
      if (method === 'GET' && url.pathname.endsWith('/appStoreVersions') && !url.searchParams.has('cursor')) {
        return { data: [], links: { next: `${url.origin}${url.pathname}?cursor=next` } };
      }
    }
  });
  assert.equal((await status(client, options)).versions.length, 1);
  assert.ok(calls.some(call => call.path.includes('cursor=next')));
  for (const next of [
    'https://outside.example/steal',
    'https://api.appstoreconnect.apple.com/v1/users',
    '?cursor=same'
  ]) {
    const broken = fixture({
      respond(method, url) {
        if (method === 'GET' && url.pathname.endsWith('/appStoreVersions')) return { data: [], links: { next } };
      }
    });
    await assert.rejects(status(broken.client, options), /pagination|page/i);
    assert.deepEqual(mutations(broken.calls), []);
  }
});

test('malformed API list and resource replies fail closed before mutations', async () => {
  for (const change of ['app-type', 'list', 'id']) {
    const { client, state, calls } = fixture();
    if (change === 'app-type') state.app.type = 'users';
    if (change === 'list') state.versions = null;
    if (change === 'id') state.versions[0].id = '../another';
    await assert.rejects(submit(client, options), /invalid|malformed|identity/i);
    assert.deepEqual(mutations(calls), []);
  }
});

test('submission verifies the current manual-release build and exclusive review item before sending review', async () => {
  for (const change of ['release', 'build', 'version', 'items']) {
    const { client, version, calls } = fixture({
      respond(method, url) {
        if (method === 'GET' && url.pathname === '/v1/appStoreVersions/version-1') {
          const current = structuredClone(version);
          if (change === 'release') current.attributes.releaseType = 'AFTER_APPROVAL';
          if (change === 'build') current.relationships.build.data.id = 'other-build';
          if (change === 'version') current.attributes.versionString = '9.9.9';
          return { data: current };
        }
        if (method === 'GET' && url.pathname.endsWith('/items') && change === 'items') {
          return { data: [matchingItem(), { ...matchingItem(), id: 'other-item' }] };
        }
      }
    });
    await assert.rejects(submit(client, options), /release|build|version|review/i);
    assert.ok(!calls.some(call => call.method === 'PATCH' && call.path.startsWith('/v1/reviewSubmissions/')));
  }
});

test('release rechecks the version after build inspection and refuses concurrent drift', async () => {
  const { client, version, calls } = fixture({
    respond(method, url) {
      if (method === 'GET' && url.pathname === '/v1/appStoreVersions/version-1') {
        return { data: { ...version, attributes: { ...version.attributes, appStoreState: 'IN_REVIEW' } } };
      }
    }
  });
  version.attributes.appStoreState = 'PENDING_DEVELOPER_RELEASE';
  await assert.rejects(release(client, options), /approved|pending/i);
  assert.deepEqual(mutations(calls), []);
});

test('submission preserves an existing after-approval release policy without patching a reused selection', async () => {
  const { client, calls, version } = fixture();
  version.attributes.releaseType = 'AFTER_APPROVAL';
  const result = await submit(client, options);
  assert.equal(result.releaseType, 'AFTER_APPROVAL');
  assert.equal(result.autoReleaseAfterApproval, true);
  assert.equal(
    calls.some(call => call.method === 'PATCH' && call.path === '/v1/appStoreVersions/version-1'),
    false
  );
});

test('explicit release policy changes are persisted before submission and reported truthfully', async () => {
  for (const [releasePolicy, initial, expected] of [
    ['manual', 'AFTER_APPROVAL', 'MANUAL'],
    ['after-approval', 'MANUAL', 'AFTER_APPROVAL']
  ]) {
    const { client, calls, version, state } = fixture();
    version.attributes.releaseType = initial;
    state.respond = (method, url, init) => {
      if (method === 'PATCH' && url.pathname === '/v1/appStoreVersions/version-1') {
        Object.assign(version.attributes, init.body.data.attributes);
        return { data: version };
      }
    };
    const result = await submit(client, { ...options, releasePolicy });
    assert.equal(result.releaseType, expected);
    assert.equal(result.autoReleaseAfterApproval, expected === 'AFTER_APPROVAL');
    assert.equal(
      calls.find(call => call.method === 'PATCH' && call.path === '/v1/appStoreVersions/version-1').body.data.attributes
        .releaseType,
      expected
    );
  }
});

test('unsupported existing or requested policies refuse before any mutation', async () => {
  for (const change of [{ releasePolicy: 'automatic' }, { existing: 'SCHEDULED' }, { existing: undefined }]) {
    const { client, calls, version } = fixture();
    if ('existing' in change) version.attributes.releaseType = change.existing;
    await assert.rejects(submit(client, { ...options, ...change }), /release.*policy|release.*type/i);
    assert.deepEqual(mutations(calls), []);
  }
});

test('omitted or empty notes fill the exact default before attaching a build or creating a review', async () => {
  for (const releaseNotes of [undefined, '']) {
    const { client, state, version, calls } = fixture();
    state.localizations[0].attributes.whatsNew = null;
    version.relationships.build = { data: null };
    await submit(client, { ...options, releaseNotes });
    assert.equal(state.localizations[0].attributes.whatsNew, 'Various Fixes & Improvements');
    assert.equal(mutations(calls)[0].path, '/v1/appStoreVersionLocalizations/locale-1');
  }
});

test('explicit notes fill only missing en-US text before review mutations', async () => {
  const { client, state, calls } = fixture();
  state.localizations[0].attributes.whatsNew = '';
  const notes = 'Guardian recovery improvements.\nBug fixes.';
  await submit(client, { ...options, releaseNotes: notes });
  assert.equal(state.localizations[0].attributes.whatsNew, notes);
  const first = mutations(calls)[0];
  assert.equal(first.path, '/v1/appStoreVersionLocalizations/locale-1');
  assert.deepEqual(first.body.data.attributes, { whatsNew: notes });
  assert.equal(
    calls.some(c => c.path.includes('appScreenshots')),
    false
  );
});

test('existing notes are preserved even when replacement notes are supplied', async () => {
  const { client, state, calls } = fixture();
  await submit(client, { ...options, releaseNotes: 'Do not replace existing notes' });
  assert.equal(state.localizations[0].attributes.whatsNew, 'Existing release notes');
  assert.equal(
    mutations(calls).some(c => c.path.includes('Localizations')),
    false
  );
});

test('unique exact-app empty review draft with null platform is recovered without duplicate review', async () => {
  const draft = matchingDraft();
  draft.attributes.platform = null;
  const { client, calls } = fixture({ reviews: [draft], items: [] });
  await submit(client, options);
  assert.deepEqual(
    mutations(calls).map(c => c.path),
    ['/v1/reviewSubmissionItems', '/v1/reviewSubmissions/review-1']
  );
  assert.equal(mutations(calls)[0].body.data.relationships.appStoreVersion.data.id, 'version-1');
});

test('ambiguous or missing en-US localization is refused before any mutation', async () => {
  for (const localizations of [
    [],
    [
      { type: 'appStoreVersionLocalizations', id: 'a', attributes: { locale: 'en-US', whatsNew: 'a' } },
      { type: 'appStoreVersionLocalizations', id: 'b', attributes: { locale: 'en-US', whatsNew: 'b' } }
    ]
  ]) {
    const { client, calls } = fixture({ localizations });
    await assert.rejects(submit(client, { ...options, releaseNotes: 'New notes' }), /localization/i);
    assert.deepEqual(mutations(calls), []);
  }
});

test('invalid release notes are refused before any request', async () => {
  for (const releaseNotes of [' ', 'x'.repeat(4001), 'bad\0text', 42]) {
    const { client, calls } = fixture();
    await assert.rejects(submit(client, { ...options, releaseNotes }), /release notes/i);
    assert.equal(calls.length, 0);
  }
});

test('item creation failure retains only the closed Apple operation stage', async () => {
  const { client } = fixture({
    respond(method, url) {
      if (method === 'POST' && url.pathname === '/v1/reviewSubmissionItems')
        throw Object.assign(new Error('Private provider detail'), { status: 409 });
    }
  });
  await assert.rejects(submit(client, options), e => e.stage === 'apple-review-item-create');
});

test('notes appearing during preflight are preserved rather than replaced', async () => {
  let reads = 0;
  const f = fixture({
    respond(method, url) {
      if (method === 'GET' && url.pathname.endsWith('/appStoreVersionLocalizations')) {
        reads += 1;
        return {
          data: [
            {
              type: 'appStoreVersionLocalizations',
              id: 'locale-1',
              attributes: { locale: 'en-US', whatsNew: reads === 1 ? '' : 'Existing text added during preflight' }
            }
          ]
        };
      }
    }
  });
  await submit(f.client, { ...options, releaseNotes: 'Do not overwrite' });
  assert.equal(
    mutations(f.calls).some(c => c.path.includes('Localizations')),
    false
  );
});

test('a competing review appearing after item creation blocks submission', async () => {
  let reviewReads = 0;
  const f = fixture({
    reviews: [matchingDraft()],
    items: [],
    respond(method, url) {
      if (method === 'GET' && url.pathname === '/v1/reviewSubmissions') {
        reviewReads += 1;
        if (reviewReads >= 3) return { data: [matchingDraft(), { ...matchingDraft(), id: 'other-review' }] };
      }
    }
  });
  await assert.rejects(submit(f.client, options), /review submission/i);
  assert.deepEqual(
    mutations(f.calls).map(c => c.path),
    ['/v1/reviewSubmissionItems']
  );
});

test('standard submit changes an existing manual draft to automatic publication after approval', async () => {
  const { client, version, calls } = fixture();
  const result = await submit(client, { ...options, releasePolicy: undefined });
  assert.equal(result.releaseType, 'AFTER_APPROVAL');
  assert.equal(result.autoReleaseAfterApproval, true);
  assert.equal(version.attributes.releaseType, 'AFTER_APPROVAL');
  assert.equal(mutations(calls)[0].body.data.attributes.releaseType, 'AFTER_APPROVAL');
});

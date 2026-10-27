import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { syncScreenshots } from './screenshots.mjs';

const hash = (kind, bytes) => createHash(kind).update(bytes).digest('hex');
function fixture(count = 9, timing) {
  const desired = Array.from({ length: 5 }, (_, i) => {
    const bytes = Buffer.from(`canonical-${i}`);
    return { path: `${i}.png`, bytes, size: bytes.length, format: 'png', sha256: hash('sha256', bytes) };
  });
  const shot = (id, checksum, fileName = `${id}.png`, fileSize = 11, state = 'COMPLETE') => ({
    type: 'appScreenshots',
    id,
    attributes: { fileName, fileSize, sourceFileChecksum: checksum, assetDeliveryState: { state } }
  });
  const originals = Array.from({ length: count }, (_, i) => shot(`old${i}`, hash('md5', `old${i}`)));
  const medium = desired.map((image, i) => shot(`medium${i}`, hash('md5', image.bytes)));
  const sets = new Map([
    ['large', structuredClone(originals)],
    ['medium', medium]
  ]);
  let serial = 0;
  let maximum = count;
  let journal;
  let fault;
  let saves = 0;
  let failSaveAt;
  const calls = [];
  const bindings = {
    platform: 'ios',
    appId: '6789341854',
    bundleId: 'com.miden.bread',
    version: '1.17.8',
    network: 'testnet',
    sourceSha: 'a'.repeat(40),
    manifestSha256: 'b'.repeat(64)
  };
  const options = () => ({
    ...bindings,
    allowWrites: true,
    maxPolls: 1,
    sets: [
      { locale: 'en-US', displayType: 'APP_IPHONE_67', images: desired },
      { locale: 'en-US', displayType: 'APP_IPHONE_61', images: desired }
    ],
    baselineSets: [
      {
        locale: 'en-US',
        displayType: 'APP_IPHONE_67',
        images: originals.map(x => ({ checksum: { algorithm: 'md5', value: x.attributes.sourceFileChecksum } }))
      }
    ],
    screenshotJournal: structuredClone(journal),
    persistScreenshotJournal: async value => {
      saves++;
      if (saves === failSaveAt) throw new Error('disk unavailable after mutation');
      if (fault === 'persist') {
        fault = undefined;
        throw new Error('disk unavailable');
      }
      journal = structuredClone(value);
    },
    fetchImpl: async url => {
      if (fault === 'bytes') {
        fault = undefined;
        throw new Error('bytes interrupted');
      }
      return { ok: true, redirected: false, url };
    }
  });
  const client = {
    request: async (method, path, request) => {
      calls.push({ method, path, at: timing?.now(), timeoutMs: request?.timeoutMs });
      await timing?.onRequest?.(method, path, request);
      const fail = stage => {
        if (fault === stage) {
          fault = undefined;
          throw new Error(`interrupted ${stage}`);
        }
      };
      if (method === 'GET' && path === '/v1/apps/6789341854')
        return { data: { type: 'apps', id: '6789341854', attributes: { bundleId: 'com.miden.bread' } } };
      if (method === 'GET' && path.includes('/appStoreVersions?'))
        return {
          data: [
            {
              type: 'appStoreVersions',
              id: 'version',
              attributes: {
                versionString: '1.17.8',
                platform: 'IOS',
                appStoreState: bindings.state ?? 'PREPARE_FOR_SUBMISSION'
              }
            }
          ]
        };
      if (method === 'GET' && path.includes('/appStoreVersionLocalizations?'))
        return { data: [{ type: 'appStoreVersionLocalizations', id: 'locale', attributes: { locale: 'en-US' } }] };
      if (method === 'GET' && path.includes('/appScreenshotSets?'))
        return {
          data: ['large', 'medium'].map(id => ({
            type: 'appScreenshotSets',
            id,
            attributes: { screenshotDisplayType: id === 'large' ? 'APP_IPHONE_67' : 'APP_IPHONE_61' }
          }))
        };
      for (const [id, images] of sets)
        if (method === 'GET' && path === `/v1/appScreenshotSets/${id}/appScreenshots?limit=200`)
          return { data: structuredClone(images) };
      if (method === 'POST' && path === '/v1/appScreenshots') {
        fail('reserve-before');
        const attrs = request.body.data.attributes;
        const setId = request.body.data.relationships.appScreenshotSet.data.id;
        const images = sets.get(setId);
        assert.ok(images.length < 10, 'Apple reservation count must never exceed 10');
        const resource = shot(`new${++serial}`, undefined, attrs.fileName, attrs.fileSize, 'AWAITING_UPLOAD');
        resource.attributes.uploadOperations = [
          { method: 'PUT', url: 'https://blob.apple.com/upload', offset: 0, length: attrs.fileSize, requestHeaders: [] }
        ];
        images.push(resource);
        maximum = Math.max(maximum, images.length);
        fail('reserve-after');
        return { data: structuredClone(resource) };
      }
      const all = [...sets.values()].flat();
      const asset = all.find(x => path === `/v1/appScreenshots/${x.id}`);
      if (asset && method === 'GET') {
        if (timing && asset.readyAt <= timing.now()) asset.attributes.assetDeliveryState.state = 'COMPLETE';
        if (asset.attributes.assetDeliveryState.state === 'COMPLETE') fail('poll-after');
        return { data: structuredClone(asset) };
      }
      if (asset && method === 'PATCH') {
        fail('complete-before');
        asset.attributes.sourceFileChecksum = request.body.data.attributes.sourceFileChecksum;
        asset.attributes.assetDeliveryState.state =
          fault === 'processing-failed' ? 'FAILED' : timing ? 'UPLOAD_COMPLETE' : 'COMPLETE';
        if (timing)
          asset.readyAt = timing.now() + (typeof timing.delay === 'function' ? timing.delay(asset.id) : timing.delay);
        if (fault === 'processing-failed') fault = undefined;
        fail('complete-after');
        return { data: structuredClone(asset) };
      }
      if (method === 'DELETE') {
        fail('delete-before');
        for (const [id, images] of sets)
          sets.set(
            id,
            images.filter(x => path !== `/v1/appScreenshots/${x.id}`)
          );
        fail('delete-after');
        return {};
      }
      if (method === 'PATCH' && path.includes('/relationships/appScreenshots')) {
        fail('order-before');
        const setId = path.split('/')[3];
        sets.set(
          setId,
          request.body.data.map(x => sets.get(setId).find(image => image.id === x.id))
        );
        fail('order-after');
        return {};
      }
      throw new Error(`Unexpected fake request: ${method} ${path}`);
    }
  };
  return {
    client,
    options,
    calls,
    sets,
    desired,
    bindings,
    failSave: value => {
      failSaveAt = value;
    },
    setFault: value => {
      fault = value;
    },
    journal: () => structuredClone(journal),
    setJournal: value => {
      journal = value;
    },
    maximum: () => maximum
  };
}

async function assertCanonical(c) {
  await syncScreenshots(c.client, c.options());
  assert.deepEqual(
    c.sets.get('large').map(x => x.attributes.sourceFileChecksum),
    c.desired.map(x => hash('md5', x.bytes))
  );
  assert.deepEqual(
    c.sets.get('medium').map(x => x.id),
    c.desired.map((_, i) => `medium${i}`)
  );
  assert.ok(c.maximum() <= 10);
  const before = c.calls.length;
  assert.equal((await syncScreenshots(c.client, c.options())).changed, false);
  assert.ok(c.calls.slice(before).every(x => x.method === 'GET'));
}

test('Apple replaces nine baseline images with five desired within cap', async () => assertCanonical(fixture()));
for (const stage of [
  'reserve-after',
  'bytes',
  'complete-before',
  'complete-after',
  'poll-after',
  'delete-before',
  'delete-after',
  'order-before',
  'order-after'
]) {
  test(`Apple journal resumes after ${stage} without touching matching medium`, async () => {
    const c = fixture();
    c.setFault(stage);
    await assert.rejects(syncScreenshots(c.client, c.options()), /partial|interrupted|stopped/);
    await assertCanonical(c);
  });
}
test('indeterminate reservation with no visible candidate never issues another POST', async () => {
  const c = fixture();
  c.setFault('reserve-before');
  await assert.rejects(syncScreenshots(c.client, c.options()));
  const before = c.calls.length;
  await assert.rejects(syncScreenshots(c.client, c.options()), /pending|indeterminate|reconcil/i);
  assert.ok(c.calls.slice(before).every(x => x.method === 'GET'));
});
test('a missing or wrong-source journal cannot authorize a partial inventory', async () => {
  for (const missing of [true, false]) {
    const c = fixture();
    c.setFault('bytes');
    await assert.rejects(syncScreenshots(c.client, c.options()));
    if (missing) c.setJournal(undefined);
    else c.bindings.sourceSha = 'c'.repeat(40);
    const before = c.calls.length;
    await assert.rejects(syncScreenshots(c.client, c.options()), /journal|drift|binding|source/i);
    assert.ok(c.calls.slice(before).every(x => x.method === 'GET'));
  }
});
test('journal persistence failure prevents reservation or eviction', async () => {
  const c = fixture();
  c.setFault('persist');
  await assert.rejects(syncScreenshots(c.client, c.options()), /journal|disk|persist|partial/i);
  assert.ok(c.calls.every(x => x.method === 'GET'));
});
test('all groups and immutable draft states are checked before any screenshot mutation', async () => {
  for (const immutable of [false, true]) {
    const c = fixture();
    if (immutable) c.bindings.state = 'WAITING_FOR_REVIEW';
    else c.sets.get('medium')[0].attributes.sourceFileChecksum = 'd'.repeat(32);
    await assert.rejects(syncScreenshots(c.client, c.options()), /draft|state|drift/i);
    assert.ok(c.calls.every(x => x.method === 'GET'));
  }
});

test('ten original images also converge without exceeding quota', async () => assertCanonical(fixture(10)));
test('post-request persistence failures retain enough intent for safe recovery', async () => {
  for (const save of [2, 4, 5, 7, 10, 16, 25]) {
    const c = fixture();
    c.failSave(save);
    await assert.rejects(syncScreenshots(c.client, c.options()), /partial|journal/);
    await assertCanonical(c);
  }
});
test('unexplained remote mutations and wrong groups remain blocked on recovery', async () => {
  for (const change of [
    c => c.sets.get('large').reverse(),
    c => c.sets.get('large').pop(),
    c => {
      c.sets.get('large')[0].attributes.sourceFileChecksum = 'e'.repeat(32);
    },
    c => c.sets.set('medium', []),
    c => (c.bindings.manifestSha256 = 'e'.repeat(64))
  ]) {
    const c = fixture();
    c.setFault('bytes');
    await assert.rejects(syncScreenshots(c.client, c.options()));
    change(c);
    const before = c.calls.length;
    await assert.rejects(syncScreenshots(c.client, c.options()), /drift|journal|pending|partial/i);
    assert.ok(c.calls.slice(before).every(x => x.method === 'GET'));
  }
});

test('a late visible pending reservation resumes only after one exact candidate appears', async () => {
  const c = fixture();
  c.setFault('reserve-after');
  await assert.rejects(syncScreenshots(c.client, c.options()));
  const delayed = c.sets.get('large').pop();
  const before = c.calls.length;
  await assert.rejects(syncScreenshots(c.client, c.options()), /pending|reconciliation/i);
  assert.ok(c.calls.slice(before).every(x => x.method === 'GET'));
  assert.equal(c.journal().pending.kind, 'reserve');
  c.sets.get('large').push(delayed);
  await assertCanonical(c);
  assert.equal(c.calls.filter(x => x.method === 'POST' && x.path === '/v1/appScreenshots').length, 5);
});

test('multiple pending reservation candidates remain blocked without writes', async () => {
  const c = fixture(8);
  c.setFault('reserve-after');
  await assert.rejects(syncScreenshots(c.client, c.options()));
  const duplicate = structuredClone(c.sets.get('large').at(-1));
  duplicate.id = 'unexplained';
  c.sets.get('large').push(duplicate);
  const before = c.calls.length;
  await assert.rejects(syncScreenshots(c.client, c.options()), /drift|pending|partial/i);
  assert.ok(c.calls.slice(before).every(x => x.method === 'GET'));
  assert.equal(c.journal().pending.kind, 'reserve');
});

test('recorded failed reservations can retry while sufficient capacity preserves every original', async () => {
  const c = fixture(3);
  c.setFault('processing-failed');
  await assert.rejects(syncScreenshots(c.client, c.options()), /FAILED|partial/);
  assert.deepEqual(
    c.sets
      .get('large')
      .filter(x => x.id.startsWith('old'))
      .map(x => x.id),
    ['old0', 'old1', 'old2']
  );
  assert.equal(
    c.calls.some(x => x.method === 'DELETE'),
    false
  );
  const failed = c.sets.get('large').find(x => x.attributes.assetDeliveryState.state === 'FAILED').id;
  await assertCanonical(c);
  assert.equal(c.calls.filter(x => x.method === 'DELETE' && x.path === `/v1/appScreenshots/${failed}`).length, 1);
});

test('five slow Apple images share processing time inside the workflow budget', async () => {
  let elapsed = 0;
  const c = fixture(9, { now: () => elapsed, delay: 590000 });
  const options = {
    ...c.options(),
    maxPolls: 120,
    now: () => elapsed,
    deadlineMs: 1500000,
    sleep: async ms => {
      elapsed += ms;
    }
  };
  // Sequential processing would consume 2950 seconds before API overhead.
  assert.ok(5 * 590000 > 30 * 60000);
  await syncScreenshots(c.client, options);
  assert.ok(elapsed <= 600000, `group processing took ${elapsed}ms`);
  const commits = c.calls.filter(x => x.method === 'PATCH' && x.path.startsWith('/v1/appScreenshots/'));
  assert.equal(commits.length, 5);
  assert.ok(
    commits.every(x => x.at === 0),
    'commit all uploads before waiting'
  );
  assert.ok(c.maximum() <= 10);
  assert.deepEqual(
    c.sets.get('large').map(x => x.attributes.sourceFileChecksum),
    c.desired.map(x => hash('md5', x.bytes))
  );
  assert.deepEqual(
    c.sets.get('medium').map(x => x.id),
    c.desired.map((_, i) => `medium${i}`)
  );
  assert.equal(
    c.calls.filter(x => x.method === 'DELETE' && x.at === 0).length,
    4,
    'only quota-required evictions before verification'
  );
});

test('shared deadline stops requests, preserves journal and resumes without duplicate reservations', async () => {
  let elapsed = 0;
  const c = fixture(4, { now: () => elapsed, delay: 590000 });
  const options = () => ({
    ...c.options(),
    maxPolls: 120,
    now: () => elapsed,
    deadlineMs: 10000,
    sleep: async ms => {
      elapsed += ms;
    }
  });
  await assert.rejects(syncScreenshots(c.client, options()), /deadline/i);
  assert.ok(
    c.calls.every(x => x.at < 10000),
    'no request launches after expiry'
  );
  assert.equal(c.calls.filter(x => x.method === 'POST').length, 5);
  assert.equal(c.calls.filter(x => x.method === 'DELETE').length, 0);
  assert.equal(c.journal().groups[0].owned.length, 5);
  const persisted = c.journal();
  elapsed = 600000;
  await syncScreenshots(c.client, { ...options(), deadlineMs: 1500000 });
  assert.equal(c.calls.filter(x => x.method === 'POST').length, 5);
  assert.deepEqual(c.journal().binding, persisted.binding);
  await assertCanonical(c);
});

test('expired deadline refuses even initial inventory', async () => {
  const c = fixture();
  await assert.rejects(syncScreenshots(c.client, { ...c.options(), deadlineMs: 10, now: () => 10 }), /deadline/i);
  assert.equal(c.calls.length, 0);
});

test('deadline during intent persistence launches no reservation and leaves safely resumable journal', async () => {
  let elapsed = 0;
  let expire = true;
  const c = fixture(4);
  const base = c.options();
  const options = {
    ...base,
    now: () => elapsed,
    deadlineMs: 10,
    persistScreenshotJournal: async value => {
      await base.persistScreenshotJournal(value);
      if (expire && value.pending?.kind === 'reserve') {
        expire = false;
        elapsed = 10;
      }
    }
  };
  await assert.rejects(syncScreenshots(c.client, options), /deadline/i);
  assert.equal(c.calls.filter(x => x.method !== 'GET').length, 0);
  assert.equal(c.journal().pending, null, 'known local expiry before launch must not become indeterminate POST');
  await syncScreenshots(c.client, { ...c.options(), now: () => elapsed, deadlineMs: 10000 });
  await assertCanonical(c);
});

test('deadline after byte upload prevents completion and resumes the recorded reservation', async () => {
  let elapsed = 0;
  const c = fixture(4);
  const options = {
    ...c.options(),
    now: () => elapsed,
    deadlineMs: 10,
    fetchImpl: async url => {
      elapsed = 10;
      return { ok: true, redirected: false, url };
    }
  };
  await assert.rejects(syncScreenshots(c.client, options), /deadline/i);
  assert.equal(c.calls.filter(x => x.method === 'POST').length, 1);
  assert.equal(c.calls.filter(x => x.method === 'PATCH' || x.method === 'DELETE').length, 0);
  await syncScreenshots(c.client, { ...c.options(), now: () => elapsed, deadlineMs: 10000 });
  assert.equal(c.calls.filter(x => x.method === 'POST').length, 5);
  await assertCanonical(c);
});

test('group processing uses at most two readers and bounds each request to remaining time', async () => {
  let elapsed = 0;
  let active = 0;
  let maximum = 0;
  const c = fixture(4, {
    now: () => elapsed,
    delay: 5000,
    onRequest: async (method, path) => {
      if (method === 'GET' && /^\/v1\/appScreenshots\/new[0-9]+$/.test(path)) {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setImmediate(resolve));
        active--;
      }
    }
  });
  await syncScreenshots(c.client, {
    ...c.options(),
    now: () => elapsed,
    deadlineMs: 10000,
    maxPolls: 120,
    sleep: async ms => {
      elapsed += ms;
    }
  });
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  assert.ok(c.calls.every(call => call.timeoutMs > 0 && call.timeoutMs <= 10000 - call.at));
  await assertCanonical(c);
});

test('mixed complete pending and failed uploads keep originals until exact journal retry succeeds', async () => {
  let elapsed = 0;
  let fail = true;
  let c;
  c = fixture(4, {
    now: () => elapsed,
    delay: id => (id === 'new1' ? 0 : 5000),
    onRequest: async (method, path) => {
      const second = c.sets.get('large').find(x => x.id === 'new2');
      if (
        fail &&
        method === 'GET' &&
        path === '/v1/appScreenshots/new2' &&
        second.attributes.assetDeliveryState.state === 'UPLOAD_COMPLETE'
      ) {
        second.attributes.assetDeliveryState.state = 'FAILED';
        second.readyAt = Infinity;
        fail = false;
      }
    }
  });
  const options = () => ({
    ...c.options(),
    now: () => elapsed,
    deadlineMs: 10000,
    maxPolls: 120,
    sleep: async ms => {
      elapsed += ms;
    }
  });
  await assert.rejects(syncScreenshots(c.client, options()), /FAILED|partial/);
  const states = c.sets
    .get('large')
    .filter(x => x.id.startsWith('new'))
    .map(x => x.attributes.assetDeliveryState.state);
  assert.ok(states.includes('COMPLETE') && states.includes('UPLOAD_COMPLETE') && states.includes('FAILED'));
  assert.equal(
    c.calls.some(x => x.method === 'DELETE' || x.path.includes('/relationships/appScreenshots')),
    false
  );
  assert.deepEqual(
    c.sets
      .get('large')
      .filter(x => x.id.startsWith('old'))
      .map(x => x.id),
    ['old0', 'old1', 'old2', 'old3']
  );
  await syncScreenshots(c.client, options());
  assert.equal(c.calls.filter(x => x.method === 'POST').length, 6, 'only the failed reservation is replaced');
  await assertCanonical(c);
});

test('POST-only operations recover the owned tenth slot before replacing any baseline image', async () => {
  const c = fixture(9);
  const request = c.client.request;
  c.client.request = async (method, path, options) => {
    const response = await request(method, path, options);
    if (method === 'GET' && response.data?.type === 'appScreenshots') response.data.attributes.uploadOperations = [];
    return response;
  };
  c.setFault('bytes');
  await assert.rejects(syncScreenshots(c.client, c.options()), /partial/);
  assert.equal(c.sets.get('large').length, 10);
  const owned = c.journal().groups[0].owned[0].assetId;
  const before = c.calls.length;
  await assertCanonical(c);
  const writes = c.calls.slice(before).filter(call => call.method !== 'GET');
  assert.deepEqual(
    { method: writes[0].method, path: writes[0].path },
    { method: 'DELETE', path: `/v1/appScreenshots/${owned}` }
  );
  assert.equal(writes[1].method, 'POST');
  assert.equal(
    writes.filter(call => call.method === 'DELETE' && call.path === `/v1/appScreenshots/${owned}`).length,
    1
  );
  assert.ok(!JSON.stringify(c.journal()).includes('uploadOperations'));
  assert.ok(c.maximum() <= 10);
});

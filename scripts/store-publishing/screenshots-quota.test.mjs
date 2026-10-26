import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { syncScreenshots } from './screenshots.mjs';

const hash = (kind, bytes) => createHash(kind).update(bytes).digest('hex');
function fixture(count = 9) {
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
  const medium = shot('medium', hash('md5', 'canonical-0'));
  const sets = new Map([
    ['large', structuredClone(originals)],
    ['medium', [medium]]
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
      { locale: 'en-US', displayType: 'APP_IPHONE_61', images: [desired[0]] }
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
      calls.push({ method, path });
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
      if (asset && method === 'GET') return { data: structuredClone(asset) };
      if (asset && method === 'PATCH') {
        fail('complete-before');
        asset.attributes.sourceFileChecksum = request.body.data.attributes.sourceFileChecksum;
        asset.attributes.assetDeliveryState.state = 'COMPLETE';
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
    failSave: value => { failSaveAt = value; },
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
    ['medium']
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
    const c = fixture(); c.failSave(save);
    await assert.rejects(syncScreenshots(c.client, c.options()), /partial|journal/);
    await assertCanonical(c);
  }
});
test('unexplained remote mutations and wrong groups remain blocked on recovery', async () => {
  for (const change of [
    c => c.sets.get('large').reverse(),
    c => c.sets.get('large').pop(),
    c => { c.sets.get('large')[0].attributes.sourceFileChecksum = 'e'.repeat(32); },
    c => c.sets.set('medium', []),
    c => c.bindings.manifestSha256 = 'e'.repeat(64)
  ]) {
    const c = fixture(); c.setFault('bytes');
    await assert.rejects(syncScreenshots(c.client, c.options()));
    change(c);
    const before = c.calls.length;
    await assert.rejects(syncScreenshots(c.client, c.options()), /drift|journal|pending|partial/i);
    assert.ok(c.calls.slice(before).every(x => x.method === 'GET'));
  }
});

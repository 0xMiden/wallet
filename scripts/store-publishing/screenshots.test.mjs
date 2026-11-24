import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { inventoryScreenshots, verifyScreenshots, syncScreenshots } from './screenshots.mjs';

const bytes = Buffer.from('approved screenshot');
const digest = algorithm => createHash(algorithm).update(bytes).digest('hex');
const image = () => ({
  path: 'one.png',
  bytes: Buffer.from(bytes),
  sha256: digest('sha256'),
  size: bytes.length,
  format: 'png'
});
const ios = () => ({
  platform: 'ios',
  appId: '6789341854',
  bundleId: 'com.miden.bread',
  version: '1.17.7',
  sourceSha: 'a'.repeat(40),
  network: 'testnet',
  manifestSha256: 'b'.repeat(64),
  persistScreenshotJournal: async () => {},
  sets: [{ platform: 'ios', storeId: '6789341854', locale: 'en-US', displayType: 'APP_IPHONE_65', images: [image()] }]
});
const android = () => ({
  platform: 'android',
  packageName: 'com.miden.wallet',
  version: '1.17.7',
  editId: 'owned-edit',
  sets: [
    {
      platform: 'android',
      storeId: 'com.miden.wallet',
      locale: 'en-US',
      displayType: 'phoneScreenshots',
      images: [image()]
    }
  ]
});
const remote = (id = 'shot', checksum = digest('md5'), state = 'COMPLETE') => ({
  type: 'appScreenshots',
  id,
  attributes: {
    sourceFileChecksum: checksum,
    fileSize: bytes.length,
    fileName: 'one.png',
    assetDeliveryState: { state },
    imageAsset: { width: 1242, height: 2688, templateUrl: 'https://is1.mzstatic.com/image/thumb/asset/{w}x{h}bb.{f}' }
  }
});
function appleClient({
  shots = [remote()],
  state = 'PREPARE_FOR_SUBMISSION',
  app = 'com.miden.bread',
  pollStates = ['COMPLETE'],
  operations,
  operationsOnlyOnReservation = false,
  reservationResponse = structuredClone
} = {}) {
  const calls = [];
  let reserved;
  let serial = 0;
  let committed = false;
  const readResource = resource => {
    const result = structuredClone(resource);
    if (operationsOnlyOnReservation) result.attributes.uploadOperations = [];
    return result;
  };
  const client = {
    request: async (method, path, options) => {
      calls.push({ method, path, options });
      if (method === 'GET' && path === '/v1/apps/6789341854')
        return { data: { type: 'apps', id: '6789341854', attributes: { bundleId: app } } };
      if (method === 'GET' && path.includes('/appStoreVersions?'))
        return {
          data: [
            {
              type: 'appStoreVersions',
              id: 'version',
              attributes: { platform: 'IOS', versionString: '1.17.7', appStoreState: state }
            }
          ]
        };
      if (method === 'GET' && path.includes('/version/appStoreVersionLocalizations'))
        return { data: [{ type: 'appStoreVersionLocalizations', id: 'locale', attributes: { locale: 'en-US' } }] };
      if (method === 'GET' && path.includes('/locale/appScreenshotSets'))
        return {
          data: [{ type: 'appScreenshotSets', id: 'set', attributes: { screenshotDisplayType: 'APP_IPHONE_65' } }]
        };
      if (method === 'GET' && path.includes('/set/appScreenshots'))
        return { data: [...shots, ...(reserved ? [reserved] : [])].map(readResource) };
      if (method === 'POST' && path === '/v1/appScreenshots') {
        reserved = remote(++serial === 1 ? 'new' : `new-${serial}`, null, 'AWAITING_UPLOAD');
        committed = false;
        Object.assign(reserved.attributes, options.body.data.attributes, {
          uploadOperations: operations ?? [
            {
              method: 'PUT',
              url: 'https://store-030.blobstore.apple.com/upload',
              offset: 0,
              length: bytes.length,
              requestHeaders: [{ name: 'Content-Type', value: 'image/png' }]
            }
          ]
        });
        return { data: reservationResponse(reserved) };
      }
      if (method === 'PATCH' && reserved && path === `/v1/appScreenshots/${reserved.id}`) {
        committed = true;
        reserved.attributes.sourceFileChecksum = digest('md5');
        reserved.attributes.assetDeliveryState.state = 'UPLOAD_COMPLETE';
        return { data: reserved };
      }
      if (method === 'GET' && reserved && path === `/v1/appScreenshots/${reserved.id}`) {
        if (committed)
          reserved.attributes.assetDeliveryState.state = pollStates.length > 1 ? pollStates.shift() : pollStates[0];
        return { data: readResource(reserved) };
      }
      if (method === 'PATCH' && path.includes('/relationships/appScreenshots')) return {};
      if (method === 'DELETE' && path.startsWith('/v1/appScreenshots/')) {
        shots = shots.filter(x => path !== `/v1/appScreenshots/${x.id}`);
        if (reserved && path === `/v1/appScreenshots/${reserved.id}`) reserved = undefined;
        return {};
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    }
  };
  return { client, calls, reservation: () => reserved };
}
function playClient({ sha = digest('sha256'), initial = true, failUpload = false } = {}) {
  const calls = [];
  let images = initial ? [{ id: 'image', sha256: sha, url: 'https://play-lh.googleusercontent.com/example' }] : [];
  const client = {
    request: async (method, path, options) => {
      calls.push({ method, path, options });
      if (method === 'GET' && path.endsWith('/listings')) return { listings: [{ language: 'en-US' }] };
      if (method === 'GET' && path.includes('/listings/en-US/'))
        return { images: path.endsWith('/phoneScreenshots') ? images : [] };
      if (method === 'DELETE') {
        const deleted = images;
        images = [];
        return { deleted };
      }
      if (method === 'POST' && path.startsWith('/upload/')) {
        if (failUpload) throw new Error('upload interrupted');
        const uploaded = { id: 'new', sha256: digest('sha256') };
        images.push(uploaded);
        return { image: uploaded };
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    }
  };
  return { client, calls };
}
const mutations = calls => calls.filter(call => call.method !== 'GET');

test('Apple inventory verifies exact app/version and preserves screenshot ordering/checksums', async () => {
  const { client, calls } = appleClient({ shots: [remote('second'), remote('first')] });
  const result = await inventoryScreenshots(client, ios());
  assert.equal(result.storeId, '6789341854');
  assert.deepEqual(
    result.sets[0].images.map(i => i.assetId),
    ['second', 'first']
  );
  assert.deepEqual(result.sets[0].images[0].checksum, { algorithm: 'md5', value: digest('md5') });
  assert.match(result.sets[0].images[0].url, /1242x2688bb.png$/);
  assert.equal(mutations(calls).length, 0);
});
test('Apple inventory rejects wrong bundle identity', async () => {
  await assert.rejects(() => inventoryScreenshots(appleClient({ app: 'wrong.app' }).client, ios()), /identity/i);
});
test('Apple verify compares complete ordered image sets and never writes', async () => {
  const c = appleClient();
  assert.equal((await verifyScreenshots(c.client, ios())).matches, true);
  assert.equal(mutations(c.calls).length, 0);
  const changed = ios();
  changed.sets[0].images.push(image());
  assert.equal((await verifyScreenshots(c.client, changed)).matches, false);
});
test('all screenshot bytes are hashed before any store request', async () => {
  const c = appleClient();
  const options = ios();
  options.sets[0].images[0].bytes = Buffer.from('changed');
  await assert.rejects(() => syncScreenshots(c.client, { ...options, allowWrites: true }), /hash|size/i);
  assert.equal(c.calls.length, 0);
});
test('sync requires explicit write authorization even when images already match', async () => {
  const c = appleClient();
  await assert.rejects(() => syncScreenshots(c.client, ios()), /allowWrites|authoriz/i);
  assert.equal(c.calls.length, 0);
});
test('matching Apple screenshots are preserved exactly without mutations', async () => {
  const c = appleClient();
  const result = await syncScreenshots(c.client, { ...ios(), allowWrites: true });
  assert.equal(result.changed, false);
  assert.equal(mutations(c.calls).length, 0);
});
test('Apple mutation refuses ineligible reviewed versions', async () => {
  const c = appleClient({ state: 'WAITING_FOR_REVIEW', shots: [] });
  await assert.rejects(() => syncScreenshots(c.client, { ...ios(), allowWrites: true }), /state|draft|eligible/i);
  assert.equal(mutations(c.calls).length, 0);
});
test('unapproved Apple drift stops before reserving or deleting images', async () => {
  const c = appleClient({ shots: [remote('unknown', 'a'.repeat(32))] });
  await assert.rejects(() => syncScreenshots(c.client, { ...ios(), allowWrites: true }), /drift|baseline/i);
  assert.equal(mutations(c.calls).length, 0);
});
test('Apple uploads raw bytes without bearer credentials and commits their MD5', async () => {
  const c = appleClient({ shots: [] });
  const transfers = [];
  const result = await syncScreenshots(c.client, {
    ...ios(),
    allowWrites: true,
    fetchImpl: async (url, init) => {
      transfers.push({ url, init });
      return { ok: true, redirected: false, url };
    },
    sleep: async () => {}
  });
  assert.equal(result.changed, true);
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].init.redirect, 'error');
  assert.equal(transfers[0].init.headers.Authorization, undefined);
  assert.deepEqual(Buffer.from(transfers[0].init.body), bytes);
  const commit = c.calls.find(call => call.method === 'PATCH' && call.path === '/v1/appScreenshots/new');
  assert.equal(commit.options.body.data.attributes.sourceFileChecksum, digest('md5'));
});
test('invalid Apple upload ranges fail before sending any bytes or commit', async () => {
  const c = appleClient({
    shots: [],
    operations: [
      { method: 'PUT', url: 'https://store-030.blobstore.apple.com/upload', offset: 1, length: bytes.length }
    ]
  });
  let transfers = 0;
  await assert.rejects(
    () =>
      syncScreenshots(c.client, {
        ...ios(),
        allowWrites: true,
        fetchImpl: async () => {
          transfers++;
        }
      }),
    /range|operation/i
  );
  assert.equal(transfers, 0);
  assert.equal(
    c.calls.some(call => call.method === 'PATCH'),
    false
  );
});
test('Apple failed or timed out processing never deletes the original screenshots', async () => {
  for (const state of ['FAILED', 'UPLOAD_COMPLETE']) {
    const c = appleClient({ shots: [remote('old', 'a'.repeat(32))], pollStates: [state] });
    const baselineSets = [
      {
        locale: 'en-US',
        displayType: 'APP_IPHONE_65',
        images: [{ checksum: { algorithm: 'md5', value: 'a'.repeat(32) } }]
      }
    ];
    await assert.rejects(
      () =>
        syncScreenshots(c.client, {
          ...ios(),
          allowWrites: true,
          baselineSets,
          maxPolls: 2,
          sleep: async () => {},
          fetchImpl: async url => ({ ok: true, redirected: false, url })
        }),
      /processing|FAILED|timeout/i
    );
    assert.equal(
      c.calls.some(call => call.method === 'DELETE'),
      false
    );
  }
});
test('Android requires a caller-owned edit even for inventory', async () => {
  const c = playClient();
  const options = android();
  delete options.editId;
  await assert.rejects(() => inventoryScreenshots(c.client, options), /edit/i);
  assert.equal(c.calls.length, 0);
});
test('Android lists exact locale/type inventory and verifies ordered SHA256', async () => {
  const c = playClient();
  const result = await verifyScreenshots(c.client, android());
  assert.equal(result.matches, true);
  assert.equal(result.inventory.storeId, 'com.miden.wallet');
  assert.equal(
    c.calls.every(call => call.path.includes('/edits/owned-edit/')),
    true
  );
  assert.equal(mutations(c.calls).length, 0);
});
test('Android matching screenshots never delete or upload', async () => {
  const c = playClient();
  assert.equal((await syncScreenshots(c.client, { ...android(), allowWrites: true })).changed, false);
  assert.equal(mutations(c.calls).length, 0);
});
test('Android drift is refused before any destructive action', async () => {
  const c = playClient({ sha: 'a'.repeat(64) });
  await assert.rejects(() => syncScreenshots(c.client, { ...android(), allowWrites: true }), /drift|baseline/i);
  assert.equal(mutations(c.calls).length, 0);
});
test('Android approved replacement affects only managed group and never commits or creates an edit', async () => {
  const c = playClient({ sha: 'a'.repeat(64) });
  const baselineSets = [
    {
      locale: 'en-US',
      displayType: 'phoneScreenshots',
      images: [{ checksum: { algorithm: 'sha256', value: 'a'.repeat(64) } }]
    }
  ];
  assert.equal((await syncScreenshots(c.client, { ...android(), allowWrites: true, baselineSets })).changed, true);
  assert.deepEqual(
    mutations(c.calls).map(c => c.method),
    ['DELETE', 'POST']
  );
  assert.equal(
    mutations(c.calls).every(c => c.path.includes('/listings/en-US/phoneScreenshots')),
    true
  );
});
test('Android partial upload failure is reported once without retries or commit', async () => {
  const c = playClient({ initial: false, failUpload: true });
  await assert.rejects(() => syncScreenshots(c.client, { ...android(), allowWrites: true }), /partial|interrupted/i);
  assert.equal(c.calls.filter(c => c.method === 'POST').length, 1);
});
test('Chrome screenshot inventory and sync report official API limitation without requests', async () => {
  const calls = [];
  const client = { request: async (...args) => calls.push(args) };
  const options = {
    platform: 'chrome',
    publisherId: 'publisher',
    itemId: 'coajhopfooegmaifelglfboehacldcbo',
    allowWrites: true
  };
  assert.equal((await inventoryScreenshots(client, options)).consoleRequired, true);
  assert.equal((await syncScreenshots(client, options)).consoleRequired, true);
  assert.equal(calls.length, 0);
});

test('Apple upload rejects credential-bearing headers or an untrusted upload origin', async () => {
  for (const operation of [
    { method: 'PUT', url: 'https://evil.example/upload', offset: 0, length: bytes.length, requestHeaders: [] },
    {
      method: 'PUT',
      url: 'https://store-030.blobstore.apple.com/upload',
      offset: 0,
      length: bytes.length,
      requestHeaders: [{ name: 'Authorization', value: 'secret' }]
    }
  ]) {
    const c = appleClient({ shots: [], operations: [operation] });
    let transfers = 0;
    await assert.rejects(
      () =>
        syncScreenshots(c.client, {
          ...ios(),
          allowWrites: true,
          fetchImpl: async () => {
            transfers++;
          }
        }),
      /origin|header|operation/i
    );
    assert.equal(transfers, 0);
  }
});
test('duplicate managed groups fail before any API call', async () => {
  const c = appleClient();
  const options = ios();
  options.sets.push(structuredClone(options.sets[0]));
  await assert.rejects(() => verifyScreenshots(c.client, options), /duplicate/i);
  assert.equal(c.calls.length, 0);
});
test('Apple incomplete delivery state cannot pass verify even when checksum matches', async () => {
  const c = appleClient({ shots: [remote('shot', digest('md5'), 'UPLOAD_COMPLETE')] });
  assert.equal((await verifyScreenshots(c.client, ios())).matches, false);
});
test('Android order is significant and cannot be silently broadened to a subset', async () => {
  const c = playClient();
  const options = android();
  options.sets[0].images.push(image());
  assert.equal((await verifyScreenshots(c.client, options)).matches, false);
});

test('imported processed Apple bytes match original checksum only with their immutable import hash', async () => {
  const original = 'b'.repeat(32);
  const c = appleClient({ shots: [remote('shot', original)] });
  const options = ios();
  options.sets[0].images[0].source = {
    checksum: { algorithm: 'md5', value: original },
    importSha256: digest('sha256')
  };
  assert.equal((await verifyScreenshots(c.client, options)).matches, true);
  options.sets[0].images[0].source.importSha256 = 'c'.repeat(64);
  assert.equal((await verifyScreenshots(c.client, options)).matches, false);
  assert.equal(mutations(c.calls).length, 0);
});
test('invalid polling bounds fail before any API calls', async () => {
  const c = appleClient();
  await assert.rejects(() => syncScreenshots(c.client, { ...ios(), allowWrites: true, maxPolls: 1000 }), /poll bound/i);
  assert.equal(c.calls.length, 0);
});
test('Apple screenshot processing waits out the old twenty-poll ceiling by default', async () => {
  const c = appleClient({ shots: [], pollStates: [...Array(20).fill('UPLOAD_COMPLETE'), 'COMPLETE'] });
  const sleeps = [];
  const result = await syncScreenshots(c.client, {
    ...ios(),
    allowWrites: true,
    sleep: async ms => sleeps.push(ms),
    fetchImpl: async url => ({ ok: true, redirected: false, url })
  });
  assert.equal(result.changed, true);
  assert.equal(c.calls.filter(call => call.method === 'GET' && call.path === '/v1/appScreenshots/new').length, 21);
  assert.deepEqual(sleeps, Array(20).fill(5000));
});
test('an Apple screenshot with no delivery state cannot verify by checksum', async () => {
  for (const shape of [undefined, {}]) {
    const shot = remote();
    if (shape) shot.attributes.assetDeliveryState = shape;
    else delete shot.attributes.assetDeliveryState;
    const c = appleClient({ shots: [shot] });
    await assert.rejects(() => verifyScreenshots(c.client, ios()), /delivery state/i);
  }
});
test('an Apple screenshot with no delivery state is not treated as a kept match', async () => {
  const shot = remote();
  delete shot.attributes.assetDeliveryState;
  const c = appleClient({ shots: [shot] });
  await assert.rejects(() => syncScreenshots(c.client, { ...ios(), allowWrites: true }), /delivery state/i);
  assert.equal(
    c.calls.some(call => call.method !== 'GET'),
    false
  );
});
test('an explicit poll count above the old cap of 30 is a legal bounded wait', async () => {
  const c = appleClient({ shots: [] });
  const result = await syncScreenshots(c.client, {
    ...ios(),
    allowWrites: true,
    maxPolls: 31,
    sleep: async () => {},
    fetchImpl: async url => ({ ok: true, redirected: false, url })
  });
  assert.equal(result.changed, true);
});

test('equal image counts with reversed checksums fail complete ordered verification', async () => {
  const second = Buffer.from('different approved screenshot');
  const secondMd5 = createHash('md5').update(second).digest('hex');
  const secondSha = createHash('sha256').update(second).digest('hex');
  const c = appleClient({ shots: [remote('second', secondMd5), remote('first')] });
  const options = ios();
  options.sets[0].images.push({
    path: 'two.png',
    bytes: second,
    size: second.length,
    sha256: secondSha,
    format: 'png'
  });
  assert.equal((await verifyScreenshots(c.client, options)).matches, false);
});
test('full Apple groups release only required capacity before canonical replacement', async () => {
  const old = 'a'.repeat(32);
  const c = appleClient({ shots: Array.from({ length: 10 }, (_, index) => remote(`old-${index}`, old)) });
  const baselineSets = [
    {
      locale: 'en-US',
      displayType: 'APP_IPHONE_65',
      images: Array.from({ length: 10 }, () => ({ checksum: { algorithm: 'md5', value: old } }))
    }
  ];
  await syncScreenshots(c.client, {
    ...ios(),
    allowWrites: true,
    baselineSets,
    fetchImpl: async url => ({ ok: true, redirected: false, url })
  });
  assert.equal(mutations(c.calls)[0].method, 'DELETE');
  assert.equal(mutations(c.calls).filter(x => x.method === 'DELETE').length, 10);
});

test('Apple uses POST-only upload operations without persisting signed upload data', async () => {
  const c = appleClient({ shots: [], operationsOnlyOnReservation: true });
  const saved = [];
  let transfers = 0;
  await syncScreenshots(c.client, {
    ...ios(),
    allowWrites: true,
    persistScreenshotJournal: async value => saved.push(structuredClone(value)),
    fetchImpl: async (url, init) => {
      transfers++;
      assert.deepEqual(Buffer.from(init.body), bytes);
      return { ok: true, redirected: false, url };
    }
  });
  assert.equal(transfers, 1);
  assert.equal(c.calls.filter(call => call.method === 'POST').length, 1);
  assert.ok(saved.length > 0);
  assert.ok(saved.every(value => !JSON.stringify(value).includes('uploadOperations')));
  assert.ok(saved.every(value => !JSON.stringify(value).includes('https://')));
});

for (const operationsOnlyOnReservation of [false, true]) {
  test(`Apple resumes an owned awaiting upload with POST-only operations=${operationsOnlyOnReservation}`, async () => {
    const c = appleClient({ shots: [remote('old', 'a'.repeat(32))], operationsOnlyOnReservation });
    let journal;
    let interrupted = true;
    const options = () => ({
      ...ios(),
      allowWrites: true,
      baselineSets: [
        {
          locale: 'en-US',
          displayType: 'APP_IPHONE_65',
          images: [{ checksum: { algorithm: 'md5', value: 'a'.repeat(32) } }]
        }
      ],
      screenshotJournal: structuredClone(journal),
      persistScreenshotJournal: async value => {
        journal = structuredClone(value);
      },
      fetchImpl: async url => {
        if (interrupted) {
          interrupted = false;
          throw new Error('byte transfer interrupted');
        }
        return { ok: true, redirected: false, url };
      }
    });
    await assert.rejects(syncScreenshots(c.client, options()), /partial/);
    assert.equal(journal.pending, null);
    assert.deepEqual(journal.groups[0].owned, [{ assetId: 'new', imageIndex: 0 }]);
    const before = c.calls.length;
    await syncScreenshots(c.client, options());
    const recovery = c.calls.slice(before);
    assert.equal(
      recovery.filter(call => call.method === 'DELETE' && call.path === '/v1/appScreenshots/new').length,
      operationsOnlyOnReservation ? 1 : 0
    );
    assert.equal(recovery.filter(call => call.method === 'POST').length, operationsOnlyOnReservation ? 1 : 0);
    const originalDelete = recovery.findIndex(
      call => call.method === 'DELETE' && call.path === '/v1/appScreenshots/old'
    );
    const uploadCommit = recovery.findIndex(call => call.method === 'PATCH' && !call.path.includes('/relationships/'));
    assert.ok(originalDelete > uploadCommit, 'original stays until replacement upload completes');
    assert.ok(!JSON.stringify(journal).includes('uploadOperations'));
    assert.ok(!JSON.stringify(journal).includes('https://'));
  });
}

test('Apple owned reservation metadata drift blocks replacement without writes', async () => {
  for (const field of ['fileName', 'fileSize']) {
    const c = appleClient({ shots: [], operationsOnlyOnReservation: true });
    let journal;
    const options = () => ({
      ...ios(),
      allowWrites: true,
      screenshotJournal: structuredClone(journal),
      persistScreenshotJournal: async value => {
        journal = structuredClone(value);
      },
      fetchImpl: async () => {
        throw new Error('byte transfer interrupted');
      }
    });
    await assert.rejects(syncScreenshots(c.client, options()), /partial/);
    c.reservation().attributes[field] = field === 'fileName' ? 'foreign.png' : bytes.length + 1;
    const before = c.calls.length;
    await assert.rejects(syncScreenshots(c.client, options()), /drift|journal/);
    assert.ok(c.calls.slice(before).every(call => call.method === 'GET'));
  }
});

test('Apple validates the retained reservation response before uploading bytes', async () => {
  for (const field of ['id', 'fileName', 'fileSize']) {
    const c = appleClient({
      shots: [],
      operationsOnlyOnReservation: true,
      reservationResponse: resource => {
        const response = structuredClone(resource);
        if (field === 'id') response.id = 'foreign';
        else response.attributes[field] = field === 'fileName' ? 'foreign.png' : bytes.length + 1;
        return response;
      }
    });
    let transfers = 0;
    await assert.rejects(
      syncScreenshots(c.client, {
        ...ios(),
        allowWrites: true,
        fetchImpl: async () => {
          transfers++;
        }
      }),
      /identity|metadata/
    );
    assert.equal(transfers, 0);
    assert.ok(!c.calls.some(call => call.method === 'PATCH' || call.method === 'DELETE'));
  }
});

test('Apple does not replace a reservation that completes before the recovery delete', async () => {
  const c = appleClient({ shots: [], operationsOnlyOnReservation: true });
  let journal;
  const options = () => ({
    ...ios(),
    allowWrites: true,
    screenshotJournal: structuredClone(journal),
    persistScreenshotJournal: async value => {
      journal = structuredClone(value);
    },
    fetchImpl: async () => {
      throw new Error('byte transfer interrupted');
    }
  });
  await assert.rejects(syncScreenshots(c.client, options()), /partial/);
  const request = c.client.request;
  c.client.request = async (method, path, options) => {
    const response = await request(method, path, options);
    if (method === 'GET' && path === '/v1/appScreenshots/new') {
      c.reservation().attributes.sourceFileChecksum = digest('md5');
      c.reservation().attributes.assetDeliveryState.state = 'COMPLETE';
    }
    return response;
  };
  const before = c.calls.length;
  await assert.rejects(syncScreenshots(c.client, options()), /no longer awaiting upload/);
  assert.ok(c.calls.slice(before).every(call => call.method === 'GET'));
  assert.equal((await syncScreenshots(c.client, options())).changed, false);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { prepare } from './apple-prepare.mjs';

const options = { appId: '6789341854', bundleId: 'com.miden.bread', version: '1.17.7' };
const app = { type: 'apps', id: options.appId, attributes: { bundleId: options.bundleId } };
const version = (number, state = 'PREPARE_FOR_SUBMISSION') => ({
  type: 'appStoreVersions',
  id: `version-${number}`,
  attributes: { versionString: number, platform: 'IOS', appStoreState: state, releaseType: 'AFTER_APPROVAL' }
});
function transport(versions, created = version(options.version)) {
  const calls = [];
  return {
    calls,
    async request(method, path, data) {
      calls.push({ method, path, data });
      if (path === `/v1/apps/${options.appId}`) return { data: app };
      if (method === 'GET' && path.startsWith(`/v1/apps/${options.appId}/appStoreVersions?`)) return { data: versions };
      if (method === 'POST' && path === '/v1/appStoreVersions') return { data: created };
      if (path === `/v1/appStoreVersions/${created.id}/app`) return { data: app };
      throw new Error('Unexpected request');
    }
  };
}

test('reuses the existing 1.17.7 draft without changing screenshots or metadata', async () => {
  const client = transport([version('1.17.7')]);
  const result = await prepare(client, options);
  assert.equal(result.reused, true);
  assert.equal(result.versionId, 'version-1.17.7');
  assert.equal(result.metadataPreserved, true);
  assert.equal(client.calls.filter(c => c.method !== 'GET').length, 0);
});

test('creates a missing skeleton with automatic release after approval and no invented declarations', async () => {
  const client = transport([version('1.17.6', 'READY_FOR_SALE')]);
  const result = await prepare(client, options);
  assert.equal(result.reused, false);
  assert.equal(result.published, false);
  assert.deepEqual(client.calls.find(c => c.method === 'POST').data.body, {
    data: {
      type: 'appStoreVersions',
      attributes: { platform: 'IOS', versionString: '1.17.7', releaseType: 'AFTER_APPROVAL' },
      relationships: { app: { data: { type: 'apps', id: options.appId } } }
    }
  });
});

test('refuses a mismatched app before listing or creating a version', async () => {
  const client = transport([]);
  client.request = async () => ({ data: { ...app, attributes: { bundleId: 'another.app' } } });
  await assert.rejects(prepare(client, options), /identity/);
});

test('refuses a different outstanding draft', async () => {
  const client = transport([version('1.17.8')]);
  await assert.rejects(prepare(client, options), /unreleased/);
  assert.equal(
    client.calls.some(c => c.method === 'POST'),
    false
  );
});

test('refuses downgrade and ambiguous matching versions', async () => {
  await assert.rejects(prepare(transport([version('1.17.8', 'READY_FOR_SALE')]), options), /newer/);
  await assert.rejects(prepare(transport([version('1.17.7'), version('1.17.7')]), options), /ambiguous/);
});

test('does not recreate an existing in-review or released version', async () => {
  for (const state of ['IN_REVIEW', 'READY_FOR_DISTRIBUTION']) {
    const client = transport([version('1.17.7', state)]);
    assert.equal((await prepare(client, options)).reused, true);
    assert.equal(
      client.calls.some(c => c.method === 'POST'),
      false
    );
  }
});

test('rejects invalid options without making requests', async () => {
  for (const override of [{ version: '1.17.7-rc.1' }, { appId: '../other' }, { bundleId: '' }]) {
    const client = transport([]);
    await assert.rejects(prepare(client, { ...options, ...override }));
    assert.equal(client.calls.length, 0);
  }
});

test('refuses an invalid creation response without retrying', async () => {
  const client = transport([], version('1.17.9'));
  await assert.rejects(prepare(client, options), /created version/);
  assert.equal(client.calls.filter(c => c.method === 'POST').length, 1);
});

test('refuses cross-origin pagination before creating a skeleton', async () => {
  const client = transport([]);
  const request = client.request.bind(client);
  client.request = async (method, path, data) =>
    path.includes('appStoreVersions?')
      ? { data: [], links: { next: 'https://example.com/steal' } }
      : request(method, path, data);
  await assert.rejects(prepare(client, options), /pagination/);
  assert.equal(
    client.calls.some(c => c.method === 'POST'),
    false
  );
});

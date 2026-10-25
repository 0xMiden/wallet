const completedStates = new Set([
  'READY_FOR_SALE', 'READY_FOR_DISTRIBUTION', 'DEVELOPER_REMOVED_FROM_SALE',
  'REMOVED_FROM_SALE', 'REPLACED_WITH_NEW_VERSION'
]);

function checkedOptions(options) {
  if (!/^\d+$/.test(options?.appId ?? '') ||
      !/^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$/.test(options?.bundleId ?? '') ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(options?.version ?? '')) {
    throw new Error('An exact Apple app identity and stable version are required');
  }
}

function newerThan(left, right) {
  if (!/^\d+(?:\.\d+){0,2}$/.test(right)) throw new Error('Existing Apple version cannot be compared safely');
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== (b[index] ?? 0)) return a[index] > (b[index] ?? 0);
  }
  return false;
}

function checkedVersion(value) {
  if (value?.type !== 'appStoreVersions' || !value.id || value.attributes?.platform !== 'IOS' ||
      typeof value.attributes.versionString !== 'string' || typeof value.attributes.appStoreState !== 'string') {
    throw new Error('Apple version information is incomplete');
  }
  return value;
}

export async function prepare(client, options) {
  checkedOptions(options);
  const appPath = `/v1/apps/${options.appId}`;
  const { data: app } = await client.request('GET', appPath);
  if (app?.type !== 'apps' || app.id !== options.appId || app.attributes?.bundleId !== options.bundleId) {
    throw new Error('Apple app identity does not match the configured Bread app');
  }
  const versions = [];
  let path = `${appPath}/appStoreVersions?filter%5Bplatform%5D=IOS&limit=200`;
  const visited = new Set();
  while (path) {
    if (visited.has(path) || visited.size >= 20) throw new Error('Apple pagination is incomplete');
    visited.add(path);
    const page = await client.request('GET', path);
    if (!Array.isArray(page?.data)) throw new Error('Apple version list is unavailable');
    versions.push(...page.data.map(checkedVersion));
    if (page.links?.next) {
      const next = new URL(page.links.next, 'https://api.appstoreconnect.apple.com');
      if (next.origin !== 'https://api.appstoreconnect.apple.com' || next.pathname !== `${appPath}/appStoreVersions`) {
        throw new Error('Apple pagination points outside the selected app');
      }
      path = next.pathname + next.search;
    } else path = undefined;
  }
  const matching = versions.filter(value => value.attributes.versionString === options.version);
  if (matching.length > 1) throw new Error('Apple version selection is ambiguous');
  if (matching.length === 1) {
    return {
      platform: 'ios', appId: options.appId, version: options.version,
      versionId: matching[0].id, state: matching[0].attributes.appStoreState,
      reused: true, metadataPreserved: true, published: false
    };
  }
  if (versions.some(value => !completedStates.has(value.attributes.appStoreState))) {
    throw new Error('Another unreleased Apple version must be resolved before creating a new skeleton');
  }
  if (versions.some(value => !newerThan(options.version, value.attributes.versionString))) {
    throw new Error('The new Apple version must be newer than every existing version');
  }
  const response = await client.request('POST', '/v1/appStoreVersions', { body: { data: {
    type: 'appStoreVersions',
    attributes: { platform: 'IOS', versionString: options.version, releaseType: 'MANUAL' },
    relationships: { app: { data: { type: 'apps', id: options.appId } } }
  } } });
  const created = checkedVersion(response?.data);
  if (created.attributes.versionString !== options.version || created.attributes.releaseType !== 'MANUAL' ||
      created.attributes.appStoreState !== 'PREPARE_FOR_SUBMISSION') {
    throw new Error('Apple created version does not match the requested manual-release skeleton');
  }
  const related = await client.request('GET', `/v1/appStoreVersions/${created.id}/app`);
  if (related?.data?.id !== options.appId || related.data.attributes?.bundleId !== options.bundleId) {
    throw new Error('Apple created version has an unexpected app identity');
  }
  return {
    platform: 'ios', appId: options.appId, version: options.version, versionId: created.id,
    state: created.attributes.appStoreState, reused: false, published: false,
    metadataRequiresVerification: true
  };
}

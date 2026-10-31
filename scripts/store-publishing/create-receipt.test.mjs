import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const implementation = () => import('./create-receipt.mjs');
const sha = 'a'.repeat(40);
const request = { releaseTag: 'v1.17.7', sourceSha: sha, platform: 'chrome', network: 'testnet' };
const metadata = { platform: 'chrome', version: '1.17.7', sourceSha: sha, network: 'testnet' };
const provenance = { version: '1.17.7', sourceSha: sha, network: 'testnet', mode: 'production' };
const inspection = { platform: 'chrome', version: '1.17.7', name: 'Bread Wallet by Miden', identity: null, provenance };
const releaseSource = {
  release: { tagName: request.releaseTag, isDraft: false, isPrerelease: false },
  tagSha: sha, checkedOutSha: sha, packageVersion: '1.17.7', manifestVersion: '1.17.7'
};

test('dispatch validation requires an immutable stable source and leaves mobile opt-in', async () => {
  const { validateBuildRequest } = await implementation();
  assert.deepEqual(validateBuildRequest(request), { ...request, version: '1.17.7', platforms: ['chrome'], buildNumber: undefined });
  assert.deepEqual(validateBuildRequest({ ...request, platform: 'all', buildNumber: '19' }).platforms, ['chrome', 'ios', 'android']);
  assert.equal(validateBuildRequest({ ...request, sourceSha: sha.toUpperCase() }).sourceSha, sha);
});

test('bad tags, unpinned source, unsupported platform/network and missing mobile build numbers are refused', async () => {
  const { validateBuildRequest } = await implementation();
  for (const change of [
    { releaseTag: 'main' }, { releaseTag: 'v1.17.7-rc.1' }, { releaseTag: 'v01.17.7' },
    { sourceSha: 'HEAD' }, { sourceSha: sha.slice(1) }, { platform: 'web' }, { network: 'localnet' },
    { platform: 'ios' }, { platform: 'android', buildNumber: '0' }, { platform: 'all', buildNumber: '1000' },
    { platform: 'ios', buildNumber: '1\nBAD=value' }
  ]) assert.throws(() => validateBuildRequest({ ...request, ...change }), /invalid|required|stable|explicit/i);
});

test('devnet can only build the dedicated Chrome listing', async () => {
  const { validateBuildRequest } = await implementation();
  assert.equal(validateBuildRequest({ ...request, network: 'devnet' }).network, 'devnet');
  for (const platform of ['ios', 'android', 'all']) {
    assert.throws(() => validateBuildRequest({ ...request, network: 'devnet', platform, buildNumber: '19' }), /devnet.*chrome/i);
  }
});

test('published release, peeled tag, checkout and both source versions must all match', async () => {
  const { validateBuildRequest, verifyReleaseSource } = await implementation();
  const normalized = validateBuildRequest(request);
  assert.equal(verifyReleaseSource(normalized, releaseSource), normalized);
  for (const change of [
    { release: { ...releaseSource.release, isDraft: true } },
    { release: { ...releaseSource.release, isPrerelease: true } },
    { release: { ...releaseSource.release, isDraft: undefined } },
    { release: { ...releaseSource.release, tagName: 'v1.17.8' } },
    { tagSha: 'b'.repeat(40) }, { checkedOutSha: 'b'.repeat(40) },
    { packageVersion: '1.17.8' }, { manifestVersion: '1.17.8' }
  ]) assert.throws(() => verifyReleaseSource(normalized, { ...releaseSource, ...change }), /release|source|version|tag|checkout/i);
});

test('receipt hashes exact bytes and binds the configured Chrome identity', async () => {
  const { createReceipt } = await implementation();
  assert.deepEqual(createReceipt(Buffer.from('abc'), metadata, inspection), {
    ...metadata, identity: 'coajhopfooegmaifelglfboehacldcbo',
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  });
});

test('the Devnet receipt requires the Devnet display name and listing identity', async () => {
  const { createReceipt } = await implementation();
  const meta = { ...metadata, network: 'devnet' };
  const inspected = { ...inspection, name: 'Bread Wallet by Miden (Devnet)', provenance: { ...provenance, network: 'devnet' } };
  assert.equal(createReceipt(Buffer.from('abc'), meta, inspected).identity, 'eeghndabgeicdpkbcohgglidpfpiafnb');
  assert.throws(() => createReceipt(Buffer.from('abc'), meta, { ...inspected, name: inspection.name }), /name|devnet/i);
  assert.throws(() => createReceipt(Buffer.from('abc'), meta, { ...inspected, identity: 'coajhopfooegmaifelglfboehacldcbo' }), /identity/i);
});

test('a mismatched archive version, marker, platform or embedded key cannot receive a receipt', async () => {
  const { createReceipt } = await implementation();
  for (const change of [
    { version: '9.9.9' }, { platform: 'ios' }, { identity: 'another-extension' }, { provenance: undefined },
    { provenance: { ...provenance, sourceSha: 'b'.repeat(40) } },
    { provenance: { ...provenance, network: 'devnet' } },
    { provenance: { ...provenance, mode: 'development' } },
    { provenance: { ...provenance, version: '9.9.9' } }
  ]) assert.throws(() => createReceipt(Buffer.from('abc'), metadata, { ...inspection, ...change }), /version|marker|provenance|platform|identity|production/i);
  assert.throws(() => createReceipt(new Uint8Array(), metadata, inspection), /empty|bytes/i);
});

test('iOS receipts require the exact device build and fixed Bread bundle', async () => {
  const { createReceipt } = await implementation();
  const meta = { ...metadata, platform: 'ios', buildNumber: '19' };
  const inspected = { platform: 'ios', version: meta.version, buildNumber: '19', identity: 'com.miden.bread', deviceBuild: true, provenance };
  const receipt = createReceipt(Buffer.from('abc'), meta, inspected);
  assert.equal(receipt.identity, 'com.miden.bread');
  assert.equal(receipt.buildNumber, '19');
  for (const change of [{ buildNumber: '20' }, { identity: 'com.other.app' }, { deviceBuild: false }, { version: '9.9.9' }]) {
    assert.throws(() => createReceipt(Buffer.from('abc'), meta, { ...inspected, ...change }), /build|bundle|identity|version|device/i);
  }
});

test('Android receipt metadata uses the approved version packing and embedded source/network marker', async () => {
  const { createReceipt, androidVersionCode } = await implementation();
  const meta = { ...metadata, platform: 'android', buildNumber: '19' };
  const receipt = createReceipt(Buffer.from('abc'), meta, { platform: 'android', provenance });
  assert.equal(receipt.identity, 'com.miden.wallet');
  assert.equal(receipt.versionCode, 11707019);
  assert.equal(receipt.buildNumber, undefined);
  assert.equal(androidVersionCode('1.17.7', '19'), 11707019);
  for (const version of ['1.100.1', '1.17.100', '999.1.1']) {
    assert.throws(() => androidVersionCode(version, '19'), /version|range|limit/i);
  }
});

test('embedded provenance includes only nonsecret immutable production metadata', async () => {
  const { validateBuildRequest, createProvenance } = await implementation();
  assert.deepEqual(createProvenance(validateBuildRequest(request)), provenance);
});

test('eligibility verification selects every actual requested platform origin and refuses a missing Devnet origin', async () => {
  const { validateBuildRequest, selectEligibilityOrigins } = await implementation();
  const production = 'chrome-extension://coajhopfooegmaifelglfboehacldcbo';
  const devnet = 'chrome-extension://eeghndabgeicdpkbcohgglidpfpiafnb';
  const configured = [production, 'http://localhost', 'capacitor://localhost'];
  assert.deepEqual(selectEligibilityOrigins(validateBuildRequest({ ...request, platform: 'all', buildNumber: '19' }), configured),
    [production, 'capacitor://localhost', 'http://localhost']);
  assert.throws(() => selectEligibilityOrigins(validateBuildRequest({ ...request, network: 'devnet' }), configured), /missing|required|devnet/i);
  assert.deepEqual(selectEligibilityOrigins(validateBuildRequest({ ...request, network: 'devnet' }), [...configured, devnet]), [devnet]);
  for (const origins of [null, [], ['*'], ['http://localhost\nBAD=value']]) {
    assert.throws(() => selectEligibilityOrigins(validateBuildRequest(request), origins), /origin|required|missing|invalid/i);
  }
});

test('eligibility allowlist docs require the Chrome extension origin for the release smoke check', () => {
  const bullet = readFileSync(new URL('../../services/feature-eligibility/README.md', import.meta.url), 'utf8')
    .split('\n')
    .find(line => line.startsWith('- `FEATURE_ELIGIBILITY_ALLOWED_ORIGINS`'));
  assert.ok(bullet);
  assert.match(bullet, /release validation still requires the Chrome extension origin/);
  assert.match(bullet, /runtime requests may omit Origin/);
  assert.doesNotMatch(bullet, /absent-Origin extension requests need no entry/);
});

test('Java properties escaping protects special characters, newlines and Unicode passwords', async () => {
  const { javaPropertyEscape, androidSigningProperties } = await implementation();
  assert.equal(javaPropertyEscape(' leading =:#!\\\n\t\r\f\u00e9\ud83d\udd10'), '\\ leading\\ \\=\\:\\#\\!\\\\\\n\\t\\r\\f\\u00e9\\ud83d\\udd10');
  const properties = androidSigningProperties('/tmp/key store.keystore', { storePassword: 'a\nb', keyAlias: 'alias=x', keyPassword: 'p\\q' });
  assert.equal(properties, 'storeFile=/tmp/key\\ store.keystore\nstorePassword=a\\nb\nkeyAlias=alias\\=x\nkeyPassword=p\\\\q\n');
  assert.throws(() => androidSigningProperties('/tmp/key', { storePassword: '', keyAlias: 'x', keyPassword: 'x' }), /required/i);
});

test('signing file preparation rejects corrupt base64 and invalid Apple key metadata', async () => {
  const { decodeSigningBase64, validateAppleSigningMaterial } = await implementation();
  assert.deepEqual(decodeSigningBase64(' YWJj\n'), Buffer.from('abc'));
  for (const value of ['', 'abc', '%%%=', 'YWJj!']) assert.throws(() => decodeSigningBase64(value), /base64/i);
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const valid = { certificateBase64: 'YWJj', profileBase64: 'YWJj', certificatePassword: 'test-password', keyId: 'ABCDEFGHIJ', issuerId: '12345678-1234-1234-1234-123456789abc', privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
  assert.equal(validateAppleSigningMaterial(valid).keyId, valid.keyId);
  for (const change of [{ keyId: '../key' }, { issuerId: 'invalid' }, { privateKey: 'invalid' }, { certificatePassword: '' }]) {
    assert.throws(() => validateAppleSigningMaterial({ ...valid, ...change }), /invalid|required/i);
  }
});

test('production packaging requires telemetry credentials without exposing their values', async () => {
  const { validateProductionSettings } = await implementation();
  const settings = { aptabaseAppKey: 'A-EU-test-key', sentryDsn: 'https://test@sentry.example/1', featureEligibilityUrl: 'https://eligibility.example/v1/eligibility' };
  assert.doesNotThrow(() => validateProductionSettings(settings));
  for (const key of Object.keys(settings)) {
    assert.throws(() => validateProductionSettings({ ...settings, [key]: '' }), /required/i);
  }
  for (const aptabaseAppKey of ['A-SH-test-key', 'A-DEV-test-key']) {
    assert.throws(() => validateProductionSettings({ ...settings, aptabaseAppKey }), /host.*required/i);
    assert.doesNotThrow(() => validateProductionSettings({ ...settings, aptabaseAppKey, aptabaseHost: 'https://analytics.example' }));
  }
  try { validateProductionSettings({ ...settings, aptabaseAppKey: '', sentryDsn: '' }); } catch (error) {
    assert.ok(!error.message.includes('test-key'));
    assert.ok(!error.message.includes(settings.sentryDsn));
  }
});

test('workflow is manual, default-branch-only and validates the release before signing jobs', async () => {
  const source = readFileSync(new URL('../../.github/workflows/build-store-artifacts.yml', import.meta.url), 'utf8');
  assert.match(source, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(source, /^  (push|pull_request|release|schedule|workflow_call):/m);
  assert.match(source, /github\.repository == '0xMiden\/wallet'/);
  assert.match(source, /github\.event\.repository\.fork == false/);
  assert.match(source, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.match(source, /gh release view "\$RELEASE_TAG"/);
  assert.match(source, /refs\/tags\/\$RELEASE_TAG\^\{commit\}/);
  assert.match(source, /validate-source/);
  assert.match(source, /node services\/feature-eligibility\/check-deployment\.mjs/);
  assert.match(source, /FEATURE_ELIGIBILITY_NETWORKS: \$\{\{ format\('\["\{0\}"\]', inputs\.network\) \}\}/);
  assert.equal((source.match(/needs: prepare/g) ?? []).length, 3);
  assert.doesNotMatch(source, /inject-linked-|release upload|upload_to_app_store|upload_to_play_store|altool|destination.*upload/);
});

test('workflow keeps automation and source checkouts pinned and signing out of artifact output', async () => {
  const source = readFileSync(new URL('../../.github/workflows/build-store-artifacts.yml', import.meta.url), 'utf8');
  assert.equal((source.match(/ref: \$\{\{ github\.workflow_sha \}\}/g) ?? []).length, 5);
  assert.equal((source.match(/ref: \$\{\{ inputs\.source_sha \}\}/g) ?? []).length, 4);
  assert.equal((source.match(/run: yarn install --frozen-lockfile/g) ?? []).length, 3);
  assert.equal((source.match(/environment: wallet-store-signing/g) ?? []).length, 2);
  assert.match(source, /runs-on: macos-26/);
  assert.match(source, /java-version: '21'/);
  assert.match(source, /bundleRelease -PandroidBuildNumber="\$BUILD_NUMBER"/);
  assert.match(source, /'destination': 'export'/);
  assert.match(source, /'manageAppVersionAndBuildNumber': False/);
  assert.doesNotMatch(source, /ios\/App\/ExportOptions\.plist/);
  assert.match(source, /MARKETING_VERSION="\$VERSION"/);
  assert.match(source, /CURRENT_PROJECT_VERSION="\$BUILD_NUMBER"/);
  assert.match(source, /security delete-keychain/);
  assert.equal((source.match(/if: \$\{\{ always\(\) \}\}/g) ?? []).length, 2);
  assert.equal((source.match(/if-no-files-found: error/g) ?? []).length, 3);
  assert.equal((source.match(/path: release-output\//g) ?? []).length, 3);
});

test('current artifact producer explicitly refuses mainnet until source eligibility support is verified', async () => {
  const { validateBuildRequest } = await implementation();
  for (const platform of ['chrome', 'ios', 'android', 'all']) {
    assert.throws(() => validateBuildRequest({ ...request, network: 'mainnet', platform, buildNumber: '19' }), /mainnet.*not supported.*eligibility/i);
  }
});

test('manual build choices expose only verified testnet and Chrome Devnet networks', () => {
  const source = readFileSync(new URL('../../.github/workflows/build-store-artifacts.yml', import.meta.url), 'utf8');
  const choices = source.match(/      network:\n([\s\S]*?)      build_number:/)?.[1];
  assert.ok(choices);
  assert.match(choices, /default: testnet/);
  assert.match(choices, /- testnet/);
  assert.match(choices, /- devnet/);
  assert.doesNotMatch(choices, /- mainnet/);
});

test('Apple signing requires the existing provisioning profile as private decoded material', async () => {
  const { validateAppleSigningMaterial } = await implementation();
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const valid = { certificateBase64: 'YWJj', profileBase64: 'cHJvZmlsZQ==', certificatePassword: 'test', keyId: 'ABCDEFGHIJ', issuerId: '12345678-1234-1234-1234-123456789abc', privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
  assert.deepEqual(validateAppleSigningMaterial(valid).profile, Buffer.from('profile'));
  for (const profileBase64 of [undefined, '', 'invalid', '%%%=', 'cHJvZmlsZQ=!']) {
    assert.throws(() => validateAppleSigningMaterial({ ...valid, profileBase64 }), /base64|profile/i);
  }
});

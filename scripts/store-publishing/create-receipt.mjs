import { createHash, createPrivateKey } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { STORE_TARGETS, selectStoreTargets } from './targets.mjs';

const CHROME_ID = 'coajhopfooegmaifelglfboehacldcbo';
const DEVNET_ID = 'eeghndabgeicdpkbcohgglidpfpiafnb';
const IOS_ID = 'com.miden.bread';
const ANDROID_ID = 'com.miden.wallet';
const VERSION = '(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)';
const stableTag = new RegExp(`^v${VERSION}$`);
const stableVersion = new RegExp(`^${VERSION}$`);

/** Normalize explicit build intent before a checkout or signing environment is used. */
export function validateBuildRequest({ releaseTag, sourceSha, platform, network, buildNumber }) {
  if (typeof releaseTag !== 'string' || !stableTag.test(releaseTag)) throw new Error('A stable vX.Y.Z release tag is required');
  if (typeof sourceSha !== 'string' || !/^[a-f0-9]{40}$/i.test(sourceSha)) throw new Error('An explicit 40-hex source SHA is required');
  if (!['chrome', 'ios', 'android', 'all'].includes(platform)) throw new Error('Invalid build platform');
  if (network === 'mainnet') throw new Error('Mainnet artifact builds are not supported until source eligibility support is verified');
  if (!['testnet', 'devnet'].includes(network)) throw new Error('Invalid build network');
  const platforms = platform === 'all' ? ['chrome', 'ios', 'android'] : [platform];
  if (network === 'devnet' && platform !== 'chrome') throw new Error('Devnet artifacts may target only Chrome');
  const normalizedBuild = buildNumber === '' || buildNumber === undefined ? undefined : buildNumber;
  if ((platforms.some(value => value !== 'chrome') || normalizedBuild !== undefined) &&
      (typeof normalizedBuild !== 'string' || !/^[1-9][0-9]{0,2}$/.test(normalizedBuild))) {
    throw new Error('An explicit mobile build number from 1 through 999 is required');
  }
  return { releaseTag, sourceSha: sourceSha.toLowerCase(), platform, network, buildNumber: normalizedBuild,
    version: releaseTag.slice(1), platforms,
    targets: platform === 'all' ? STORE_TARGETS : selectStoreTargets(`${platform}-${network}`) };
}

/** Bind published release metadata, the peeled tag, checked-out source, and both package versions. */
export function verifyReleaseSource(request, { release, tagSha, checkedOutSha, packageVersion, manifestVersion }) {
  if (release?.tagName !== request.releaseTag || release.isDraft !== false || release.isPrerelease !== false) {
    throw new Error('The exact GitHub release must be published, stable and not a draft');
  }
  if (tagSha !== request.sourceSha || checkedOutSha !== request.sourceSha) throw new Error('Release tag or source checkout SHA mismatch');
  if (packageVersion !== request.version || manifestVersion !== request.version) throw new Error('Release source package and manifest versions must match the tag');
  return request;
}

/** Check each requested wallet origin, rather than proving only the first configured origin. */
export function selectEligibilityOrigins(request, configured) {
  if (!Array.isArray(configured) || configured.some(value => typeof value !== 'string' || /[\s*]/.test(value))) {
    throw new Error('Invalid configured feature eligibility origins');
  }
  const origins = request.platforms.map(platform => platform === 'ios' ? 'capacitor://localhost' :
    platform === 'android' ? 'http://localhost' : `chrome-extension://${request.network === 'devnet' ? DEVNET_ID : CHROME_ID}`);
  if (origins.some(origin => !configured.includes(origin))) throw new Error('Feature eligibility configuration is missing a required target origin');
  return [...new Set(origins)];
}

/** Verify required build configuration without returning or logging credential values. */
export function validateProductionSettings({ aptabaseAppKey, sentryDsn, featureEligibilityUrl, aptabaseHost }) {
  for (const [name, value] of Object.entries({ APTABASE_APP_KEY: aptabaseAppKey, SENTRY_DSN: sentryDsn, FEATURE_ELIGIBILITY_URL: featureEligibilityUrl })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required for production artifacts`);
  }
  if (/^A-(SH|DEV)-/.test(aptabaseAppKey.trim()) && (typeof aptabaseHost !== 'string' || !aptabaseHost.trim())) {
    throw new Error('APTABASE_HOST is required for a self-hosted or development telemetry key');
  }
}

export function createProvenance(request) {
  return { version: request.version, network: request.network, sourceSha: request.sourceSha, mode: 'production' };
}

export function androidVersionCode(version, buildNumber) {
  if (typeof version !== 'string' || !stableVersion.test(version) || !/^[1-9][0-9]{0,2}$/.test(buildNumber ?? '')) throw new Error('Invalid Android version or build number');
  const [major, minor, patch] = version.split('.').map(Number);
  const packed = major * 10_000_000 + minor * 100_000 + patch * 1_000 + Number(buildNumber);
  if (minor > 99 || patch > 99 || !Number.isSafeInteger(packed) || packed > 2_100_000_000) throw new Error('Android version exceeds the supported packing range');
  return packed;
}

/** Hash the final packaged bytes and verify their marker and inspectable native identity. */
export function createReceipt(bytes, metadata, inspection) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error('Artifact bytes must not be empty');
  const request = validateBuildRequest({ ...metadata, releaseTag: `v${metadata.version}` });
  if (request.platform === 'all' || inspection?.platform !== request.platform) throw new Error('Artifact inspection platform mismatch');
  const marker = inspection.provenance;
  if (!marker || Object.keys(marker).length !== 4 || Object.entries(createProvenance(request)).some(([key, value]) => marker[key] !== value)) {
    throw new Error('Artifact provenance marker does not match the immutable production build');
  }
  const receipt = { platform: request.platform, version: request.version, network: request.network, sourceSha: request.sourceSha,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  if (request.platform === 'chrome') {
    const identity = request.network === 'devnet' ? DEVNET_ID : CHROME_ID;
    const name = `Bread Wallet by Miden${request.network === 'devnet' ? ' (Devnet)' : ''}`;
    if (inspection.version !== request.version) throw new Error('Chrome artifact version mismatch');
    if (inspection.name !== name) throw new Error('Chrome artifact name does not match the selected network');
    if (inspection.identity !== null && inspection.identity !== identity) throw new Error('Chrome embedded identity mismatch');
    return { ...receipt, identity };
  }
  if (request.platform === 'ios') {
    if (inspection.identity !== IOS_ID) throw new Error('iOS artifact bundle identity mismatch');
    if (inspection.version !== request.version || inspection.buildNumber !== request.buildNumber) throw new Error('iOS artifact version or build number mismatch');
    if (inspection.deviceBuild !== true) throw new Error('iOS artifact is not a confirmed device build');
    return { ...receipt, identity: IOS_ID, buildNumber: request.buildNumber };
  }
  // The checked Gradle packing is attested here; Play additionally checks package, SHA and versionCode on upload.
  return { ...receipt, identity: ANDROID_ID, versionCode: androidVersionCode(request.version, request.buildNumber) };
}

export function javaPropertyEscape(value) {
  const escaped = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\f': '\\f' };
  return value.split('').map(character => {
    if (escaped[character]) return escaped[character];
    if (' =:#!'.includes(character)) return `\\${character}`;
    const unit = character.charCodeAt(0);
    return unit < 32 || unit > 126 ? `\\u${unit.toString(16).padStart(4, '0')}` : character;
  }).join('');
}

export function androidSigningProperties(keyFile, { storePassword, keyAlias, keyPassword }) {
  if (!isAbsolute(keyFile)) throw new Error('An absolute Android signing key file is required');
  const values = { storeFile: keyFile, storePassword, keyAlias, keyPassword };
  if (Object.values(values).some(value => typeof value !== 'string' || value.length === 0)) throw new Error('All Android signing values are required');
  return Object.entries(values).map(([key, value]) => `${key}=${javaPropertyEscape(value)}\n`).join('');
}

export function decodeSigningBase64(value) {
  const compact = typeof value === 'string' ? value.replace(/\s/g, '') : '';
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) throw new Error('Invalid signing base64 material');
  const decoded = Buffer.from(compact, 'base64');
  if (!decoded.length || decoded.toString('base64') !== compact) throw new Error('Invalid signing base64 material');
  return decoded;
}

export function validateAppleSigningMaterial(material) {
  if (!/^[A-Z0-9]{10}$/.test(material.keyId ?? '') || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(material.issuerId ?? '')) throw new Error('Invalid Apple API key identifiers');
  if (typeof material.certificatePassword !== 'string' || !material.certificatePassword) throw new Error('Apple certificate password is required');
  try {
    const key = createPrivateKey(material.privateKey);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Wrong key type');
  } catch { throw new Error('Invalid Apple API private key'); }
  return { ...material, certificate: decodeSigningBase64(material.certificateBase64) };
}

function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function productionSettings() {
  validateProductionSettings({ aptabaseAppKey: process.env.APTABASE_APP_KEY, sentryDsn: process.env.SENTRY_DSN,
    featureEligibilityUrl: process.env.FEATURE_ELIGIBILITY_URL, aptabaseHost: process.env.APTABASE_HOST });
  if (process.env.MODE_ENV !== 'production' || process.env.NODE_ENV !== 'production') throw new Error('Both production build flags are required');
}

function main() {
  const [mode, ...args] = process.argv.slice(2);
  const names = ['release-tag', 'source-sha', 'platform', 'network', 'build-number', 'version', 'release-file', 'tag-sha',
    'checkout-sha', 'package-file', 'manifest-file', 'artifact', 'inspection', 'output', 'android-dir', 'key-file', 'directory'];
  const { values } = parseArgs({ args, options: Object.fromEntries(names.map(name => [name, { type: 'string' }])) });
  const requestFromArgs = () => validateBuildRequest({ releaseTag: values['release-tag'] ?? `v${values.version}`,
    sourceSha: values['source-sha'], platform: values.platform, network: values.network, buildNumber: values['build-number'] });
  if (mode === 'validate-request') {
    console.log(JSON.stringify(requestFromArgs()));
  } else if (mode === 'validate-source') {
    const request = requestFromArgs();
    const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
    verifyReleaseSource(request, { release: readJson(values['release-file']), tagSha: values['tag-sha'], checkedOutSha: values['checkout-sha'],
      packageVersion: readJson(values['package-file']).version, manifestVersion: readJson(values['manifest-file']).version });
    productionSettings();
    const origins = selectEligibilityOrigins(request, JSON.parse(process.env.FEATURE_ELIGIBILITY_ALLOWED_ORIGINS ?? '[]'));
    if (!process.env.GITHUB_OUTPUT) throw new Error('GitHub output path is required');
    const outputs = { version: request.version, source_sha: request.sourceSha,
      build_chrome: request.platforms.includes('chrome'), build_ios: request.platforms.includes('ios'),
      build_android: request.platforms.includes('android'), eligibility_origins: JSON.stringify(origins) };
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log('Published release, source identity and required production configuration verified');
  } else if (mode === 'production-settings') {
    productionSettings();
    console.log('Required production configuration is present');
  } else if (mode === 'provenance') {
    writeJson(values.output, createProvenance(requestFromArgs()));
  } else if (mode === 'receipt') {
    const metadata = { platform: values.platform, version: values.version, network: values.network,
      sourceSha: values['source-sha'], buildNumber: values['build-number'] };
    writeJson(values.output, createReceipt(readFileSync(values.artifact), metadata, JSON.parse(readFileSync(values.inspection, 'utf8'))));
    console.log('Final artifact bytes and production receipt verified');
  } else if (mode === 'android-signing') {
    const properties = androidSigningProperties(resolve(values['key-file']), { storePassword: process.env.ANDROID_STORE_PASSWORD,
      keyAlias: process.env.ANDROID_KEY_ALIAS, keyPassword: process.env.ANDROID_KEY_PASSWORD });
    const key = decodeSigningBase64(process.env.ANDROID_KEYSTORE_BASE64);
    writeFileSync(values['key-file'], key, { flag: 'wx', mode: 0o600 });
    writeFileSync(resolve(values['android-dir'], 'keystore.properties'), properties, { flag: 'wx', mode: 0o600 });
    console.log('Private Android signing material prepared');
  } else if (mode === 'apple-signing-files') {
    const material = validateAppleSigningMaterial({ certificateBase64: process.env.APPLE_CERTIFICATE_P12_BASE64,
      certificatePassword: process.env.APPLE_CERTIFICATE_PASSWORD, keyId: process.env.APP_STORE_CONNECT_KEY_ID,
      issuerId: process.env.APP_STORE_CONNECT_ISSUER_ID, privateKey: process.env.APP_STORE_CONNECT_KEY_P8 });
    mkdirSync(values.directory, { recursive: true, mode: 0o700 });
    chmodSync(values.directory, 0o700);
    writeFileSync(resolve(values.directory, 'distribution.p12'), material.certificate, { flag: 'wx', mode: 0o600 });
    writeFileSync(resolve(values.directory, `AuthKey_${material.keyId}.p8`), material.privateKey, { flag: 'wx', mode: 0o600 });
    console.log('Private Apple signing material prepared');
  } else throw new Error('Choose validate-request, validate-source, production-settings, provenance, receipt, android-signing or apple-signing-files');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : 'Store artifact preparation failed');
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
/**
 * #594 — CI guard: keep the native prover's `miden-client` pin in lockstep with
 * the wallet's `@miden-sdk/miden-sdk`.
 *
 * The native prover (`packages/native-prover/android/rust-bridge/Cargo.toml`)
 * pins `miden-client = "=x.y.z"`, and it ships as committed binaries — so a pin
 * that has drifted from the miden-client behind the wallet's SDK is NOT caught
 * at build time. It surfaces only on-device as the prover rejecting valid
 * transactions with `procedure with root digest … could not be found` (the
 * #414 / #487 failure).
 *
 * This guard resolves the miden-client version behind the wallet's
 * `@miden-sdk/miden-sdk` (from the matching web-sdk tag's `Cargo.lock`) and
 * fails the build if it differs from the pin — UNLESS the drift is explicitly
 * recorded as safe in `packages/native-prover/pin-drift-exemptions.json`.
 *
 * A drift is safe ONLY when no transaction-kernel crate moved: miden-protocol,
 * miden-tx, miden-core-lib, miden-assembly, miden-core, miden-mast-package,
 * miden-prover. A miden-client(-web/-store)-only move keeps the same procedure
 * set. Prefer bumping the pin + rebuilding the binaries; use an exemption only
 * when a rebuild is deferred and the drift is verified safe by that argument.
 *
 * Usage:  node scripts/check-native-prover-pin.mjs            (CI: fetch + check)
 *         node scripts/check-native-prover-pin.mjs --self-test (offline logic check)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROVER_CARGO = path.join(ROOT, 'packages/native-prover/android/rust-bridge/Cargo.toml');
const EXEMPTIONS_FILE = path.join(ROOT, 'packages/native-prover/pin-drift-exemptions.json');
const EXEMPTIONS_REL = path.relative(ROOT, EXEMPTIONS_FILE);
const WEB_SDK_REPO = '0xMiden/web-sdk';

const SEMVER = /([0-9]+\.[0-9]+\.[0-9]+)/;

function parseSdkVersion(pkgJson) {
  const raw = pkgJson.dependencies?.['@miden-sdk/miden-sdk'] ?? pkgJson.devDependencies?.['@miden-sdk/miden-sdk'];
  if (!raw) throw new Error('@miden-sdk/miden-sdk not found in package.json');
  const m = raw.match(SEMVER);
  if (!m) throw new Error(`could not parse a semver from @miden-sdk/miden-sdk = "${raw}"`);
  return m[1];
}

function parseProverPin(cargoToml) {
  // miden-client = { version = "=0.15.4", ... }
  const m = cargoToml.match(/miden-client\s*=\s*\{[^}]*?version\s*=\s*"=?([0-9]+\.[0-9]+\.[0-9]+)"/);
  if (!m) throw new Error('could not parse the miden-client pin from the prover Cargo.toml');
  return m[1];
}

function parseMidenClientFromCargoLock(lock) {
  // [[package]]\nname = "miden-client"\nversion = "0.15.5"
  const m = lock.match(/\[\[package\]\]\s*\nname = "miden-client"\s*\nversion = "([0-9]+\.[0-9]+\.[0-9]+)"/);
  if (!m) throw new Error('miden-client package not found in the web-sdk Cargo.lock');
  return m[1];
}

function evaluatePin({ pin, sdkMidenClient, exemptions }) {
  if (pin === sdkMidenClient) {
    return {
      level: 'ok',
      message: `prover miden-client pin =${pin} matches the SDK's miden-client ${sdkMidenClient}.`
    };
  }
  const ex = exemptions.find(e => e.pin === pin && e.sdkMidenClient === sdkMidenClient);
  if (ex) {
    return {
      level: 'exempted',
      message: `pin =${pin} differs from the SDK's miden-client ${sdkMidenClient}, but the drift is a documented safe exemption: ${ex.reason}`
    };
  }
  return {
    level: 'fail',
    message:
      `DRIFT: the native prover pins miden-client =${pin}, but @miden-sdk/miden-sdk resolves to miden-client ${sdkMidenClient}.\n` +
      `A pin out of step with the SDK's miden-client makes the prover reject valid transactions on-device ` +
      `("procedure with root digest … could not be found" — see #414 / #487).\n` +
      `Fix EITHER by:\n` +
      `  (a) bumping the pin in ${path.relative(ROOT, PROVER_CARGO)} to =${sdkMidenClient} AND rebuilding the committed prover binaries; or\n` +
      `  (b) if the bump is verified safe (ONLY miden-client/-web/-store moved — NOT miden-protocol, miden-tx, miden-core-lib, ` +
      `miden-assembly, miden-core, miden-mast-package, or miden-prover), recording the drift in ${EXEMPTIONS_REL}.`
  };
}

async function fetchWebSdkCargoLock(version) {
  const urls = [
    `https://raw.githubusercontent.com/${WEB_SDK_REPO}/v${version}/Cargo.lock`,
    `https://raw.githubusercontent.com/${WEB_SDK_REPO}/refs/tags/v${version}/Cargo.lock`
  ];
  let lastErr;
  for (const url of urls) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'miden-wallet-native-prover-pin-guard' } });
        if (res.ok) return await res.text();
        lastErr = new Error(`${url} → HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      await new Promise(resolve => setTimeout(resolve, attempt * 500));
    }
  }
  throw new Error(`could not fetch the web-sdk Cargo.lock for v${version}: ${lastErr?.message ?? 'unknown error'}`);
}

function assert(cond, label) {
  if (!cond) throw new Error(`self-test failed: ${label}`);
}

function selfTest() {
  assert(
    parseSdkVersion({ dependencies: { '@miden-sdk/miden-sdk': '0.15.9' } }) === '0.15.9',
    'parseSdkVersion caret-less'
  );
  assert(
    parseSdkVersion({ devDependencies: { '@miden-sdk/miden-sdk': '^0.16.0' } }) === '0.16.0',
    'parseSdkVersion caret'
  );
  assert(
    parseProverPin('miden-client = { version = "=0.15.4", default-features = false, features = ["std"] }') === '0.15.4',
    'parseProverPin'
  );
  assert(
    parseMidenClientFromCargoLock('[[package]]\nname = "miden-client"\nversion = "0.15.5"\nsource = "x"\n') ===
      '0.15.5',
    'parseMidenClientFromCargoLock'
  );
  assert(evaluatePin({ pin: '0.15.5', sdkMidenClient: '0.15.5', exemptions: [] }).level === 'ok', 'match → ok');
  assert(
    evaluatePin({
      pin: '0.15.4',
      sdkMidenClient: '0.15.5',
      exemptions: [{ pin: '0.15.4', sdkMidenClient: '0.15.5', reason: 'r' }]
    }).level === 'exempted',
    'drift + exemption → exempted'
  );
  assert(
    evaluatePin({ pin: '0.15.4', sdkMidenClient: '0.15.6', exemptions: [] }).level === 'fail',
    'drift, no exemption → fail'
  );
  assert(
    evaluatePin({
      pin: '0.15.4',
      sdkMidenClient: '0.15.6',
      exemptions: [{ pin: '0.15.4', sdkMidenClient: '0.15.5', reason: 'r' }]
    }).level === 'fail',
    'drift with a DIFFERENT exemption → fail'
  );
  console.log('✅ native-prover-pin self-test passed');
}

async function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const sdkVersion = parseSdkVersion(pkg);
  const pin = parseProverPin(fs.readFileSync(PROVER_CARGO, 'utf8'));
  const exemptions = JSON.parse(fs.readFileSync(EXEMPTIONS_FILE, 'utf8')).exemptions ?? [];
  const sdkMidenClient = parseMidenClientFromCargoLock(await fetchWebSdkCargoLock(sdkVersion));

  console.log(
    `[native-prover-pin] @miden-sdk/miden-sdk ${sdkVersion} → miden-client ${sdkMidenClient}; native-prover pin =${pin}`
  );
  const result = evaluatePin({ pin, sdkMidenClient, exemptions });
  if (result.level === 'fail') {
    console.error(`\n❌ ${result.message}`);
    process.exit(1);
  }
  console.log(`${result.level === 'exempted' ? '⚠️ ' : '✅'} ${result.message}`);
}

main().catch(err => {
  console.error(`native-prover-pin guard error: ${err.message}`);
  process.exit(1);
});

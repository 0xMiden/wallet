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
 * `@miden-sdk/miden-sdk` (from the matching web-sdk tag's `Cargo.lock`, tag =
 * `v<full-version>`, prerelease suffix preserved) and FAILS the build if it
 * differs from the pin — UNLESS the exact drift is recorded as safe in
 * `packages/native-prover/pin-drift-exemptions.json`.
 *
 * A drift is safe ONLY when no transaction-kernel crate moved: miden-protocol,
 * miden-tx, miden-core-lib, miden-assembly, miden-core, miden-mast-package,
 * miden-prover. A miden-client(-web/-store)-only move keeps the same procedure
 * set. Exemptions are keyed on (pin, sdkVersion) so they auto-expire on ANY SDK
 * bump (an immutable tag's Cargo.lock can float kernel crates under a fixed
 * miden-client version, so keying on miden-client alone would mask that drift).
 *
 * Resolution failures (network, or a not-yet-tagged SDK version) are NOT
 * evidence of drift — they warn and pass, so an infra blip never blocks an
 * unrelated PR; a later resolvable run catches any real drift. A linked/local
 * SDK spec (file:/link:/git) is skipped (the published wallet is gated by
 * check-linked-web-sdk-pr.yml).
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
const PROVER_CARGO_REL = path.relative(ROOT, PROVER_CARGO);
const WEB_SDK_REPO = '0xMiden/web-sdk';

// Full semver, INCLUDING an optional prerelease/build suffix (e.g. 0.16.0-alpha.2).
const FULL_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * `{ kind: 'linked', spec }` for a non-registry spec (file:/link:/git/…), else
 * `{ kind: 'version', version }` — KEEPING any prerelease suffix, since the
 * web-sdk git tag is `v<full-version>`.
 */
function parseSdkSpec(pkgJson) {
  const raw = (
    pkgJson.dependencies?.['@miden-sdk/miden-sdk'] ??
    pkgJson.devDependencies?.['@miden-sdk/miden-sdk'] ??
    ''
  ).trim();
  if (!raw) throw new Error('@miden-sdk/miden-sdk not found in package.json');
  if (/^(file:|link:|portal:|git\+|https?:|github:)/.test(raw)) return { kind: 'linked', spec: raw };
  const version = raw.replace(/^[\^~=v\s]+/, '').trim();
  if (!FULL_VERSION.test(version)) throw new Error(`unrecognized @miden-sdk/miden-sdk spec "${raw}"`);
  return { kind: 'version', version };
}

function parseProverPin(cargoToml) {
  // miden-client = { version = "=0.15.4", ... }
  const m = cargoToml.match(
    /^\s*miden-client\s*=\s*\{[^}]*?version\s*=\s*"=?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)"/m
  );
  if (!m) throw new Error('could not parse the miden-client pin from the prover Cargo.toml');
  return m[1];
}

function parseMidenClientFromCargoLock(lock) {
  // The exact `name = "miden-client"` block — NOT miden-client-web/-sqlite-store/…
  const m = lock.match(
    /\[\[package\]\]\s*\r?\nname = "miden-client"\s*\r?\nversion = "([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)"/
  );
  if (!m) throw new Error('miden-client package not found in the web-sdk Cargo.lock');
  return m[1];
}

function evaluatePin({ pin, sdkVersion, sdkMidenClient, exemptions }) {
  if (pin === sdkMidenClient) {
    return {
      level: 'ok',
      message: `prover miden-client pin =${pin} matches the SDK's miden-client ${sdkMidenClient}.`
    };
  }
  const ex = exemptions.find(e => e.pin === pin && e.sdkVersion === sdkVersion);
  if (ex) {
    if (ex.sdkMidenClient !== sdkMidenClient) {
      return {
        level: 'fail',
        message:
          `the exemption for pin =${pin} @ @miden-sdk/miden-sdk ${sdkVersion} recorded miden-client ${ex.sdkMidenClient}, ` +
          `but that SDK tag now resolves miden-client ${sdkMidenClient}. The exemption is inconsistent — re-review and update ${EXEMPTIONS_REL}.`
      };
    }
    return {
      level: 'exempted',
      message:
        `pin =${pin} differs from @miden-sdk/miden-sdk ${sdkVersion}'s miden-client ${sdkMidenClient}, ` +
        `but the drift is a documented safe exemption: ${ex.reason}`
    };
  }
  return {
    level: 'fail',
    message:
      `DRIFT: the native prover pins miden-client =${pin}, but @miden-sdk/miden-sdk ${sdkVersion} resolves to miden-client ${sdkMidenClient}.\n` +
      `A pin out of step with the SDK's miden-client makes the prover reject valid transactions on-device ` +
      `("procedure with root digest … could not be found" — see #414 / #487).\n` +
      `Fix EITHER by:\n` +
      `  (a) bumping the pin in ${PROVER_CARGO_REL} to =${sdkMidenClient} AND rebuilding the committed prover binaries; or\n` +
      `  (b) if the bump is verified safe (ONLY miden-client/-web/-store moved — NOT miden-protocol, miden-tx, miden-core-lib, ` +
      `miden-assembly, miden-core, miden-mast-package, or miden-prover), adding ` +
      `{ "pin": "${pin}", "sdkVersion": "${sdkVersion}", "sdkMidenClient": "${sdkMidenClient}", "reason": "…" } to ${EXEMPTIONS_REL}.`
  };
}

/** Returns { ok:true, text } | { ok:false, kind:'notfound'|'network', message }. */
async function fetchWebSdkCargoLock(version) {
  const url = `https://raw.githubusercontent.com/${WEB_SDK_REPO}/v${version}/Cargo.lock`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'miden-wallet-native-prover-pin-guard' } });
      if (res.ok) return { ok: true, text: await res.text() };
      if (res.status === 404)
        return { ok: false, kind: 'notfound', message: `no web-sdk tag v${version} (Cargo.lock 404)` };
      lastErr = new Error(`${url} → HTTP ${res.status}`); // 5xx etc. → retry
    } catch (err) {
      lastErr = err; // network → retry
    }
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 500));
  }
  return { ok: false, kind: 'network', message: lastErr?.message ?? 'unknown fetch error' };
}

function assert(cond, label) {
  if (!cond) throw new Error(`self-test failed: ${label}`);
}

function selfTest() {
  // parseSdkSpec: range operators, leading v, prerelease preserved, linked specs
  assert(parseSdkSpec({ dependencies: { '@miden-sdk/miden-sdk': '0.15.9' } }).version === '0.15.9', 'sdk plain');
  assert(parseSdkSpec({ devDependencies: { '@miden-sdk/miden-sdk': '^0.16.0' } }).version === '0.16.0', 'sdk caret');
  assert(parseSdkSpec({ dependencies: { '@miden-sdk/miden-sdk': '=v0.15.4' } }).version === '0.15.4', 'sdk =v');
  assert(
    parseSdkSpec({ dependencies: { '@miden-sdk/miden-sdk': '0.16.0-alpha.2' } }).version === '0.16.0-alpha.2',
    'sdk prerelease preserved'
  );
  assert(
    parseSdkSpec({ dependencies: { '@miden-sdk/miden-sdk': 'file:../web-sdk' } }).kind === 'linked',
    'sdk file: → linked'
  );

  // parseProverPin: with and without the leading `=`
  assert(parseProverPin('miden-client = { version = "=0.15.4", features = ["std"] }') === '0.15.4', 'pin with =');
  assert(parseProverPin('miden-client = { version = "0.15.5" }') === '0.15.5', 'pin without =');

  // parseMidenClientFromCargoLock: exact block, NOT miden-client-web (even when -web appears first)
  assert(
    parseMidenClientFromCargoLock('[[package]]\nname = "miden-client"\nversion = "0.15.5"\nsource = "x"\n') ===
      '0.15.5',
    'lock miden-client'
  );
  assert(
    parseMidenClientFromCargoLock(
      '[[package]]\nname = "miden-client-web"\nversion = "0.15.9"\n\n[[package]]\nname = "miden-client"\nversion = "0.15.5"\n'
    ) === '0.15.5',
    'lock ignores miden-client-web'
  );

  // evaluatePin: match / exempt / drift / stale-exemption / different-SDK-version
  const ex = [{ pin: '0.15.4', sdkVersion: '0.15.9', sdkMidenClient: '0.15.5', reason: 'r' }];
  assert(
    evaluatePin({ pin: '0.15.5', sdkVersion: '0.15.9', sdkMidenClient: '0.15.5', exemptions: [] }).level === 'ok',
    'match → ok'
  );
  assert(
    evaluatePin({ pin: '0.15.4', sdkVersion: '0.15.9', sdkMidenClient: '0.15.5', exemptions: ex }).level === 'exempted',
    'drift + matching exemption → exempted'
  );
  assert(
    evaluatePin({ pin: '0.15.4', sdkVersion: '0.15.10', sdkMidenClient: '0.15.5', exemptions: ex }).level === 'fail',
    'same client but a NEW sdkVersion → fail (exemption auto-expires)'
  );
  assert(
    evaluatePin({ pin: '0.15.4', sdkVersion: '0.15.9', sdkMidenClient: '0.15.6', exemptions: ex }).level === 'fail',
    'exemption sdkMidenClient no longer matches → fail (stale)'
  );
  assert(
    evaluatePin({ pin: '0.15.4', sdkVersion: '0.15.9', sdkMidenClient: '0.15.6', exemptions: [] }).level === 'fail',
    'drift, no exemption → fail'
  );
  console.log('✅ native-prover-pin self-test passed');
}

async function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const sdk = parseSdkSpec(pkg);
  if (sdk.kind === 'linked') {
    console.log(
      `⚠️  @miden-sdk/miden-sdk is a linked/local spec ("${sdk.spec}") — skipping the pin check ` +
        `(the published wallet's version is gated by check-linked-web-sdk-pr.yml).`
    );
    return;
  }
  const pin = parseProverPin(fs.readFileSync(PROVER_CARGO, 'utf8'));
  const exemptions = JSON.parse(fs.readFileSync(EXEMPTIONS_FILE, 'utf8')).exemptions ?? [];

  const lock = await fetchWebSdkCargoLock(sdk.version);
  if (!lock.ok) {
    // A network blip or a not-yet-tagged version is NOT evidence of drift — warn
    // and pass so an infra issue never blocks an unrelated PR. A real drift is
    // caught by the next run that can resolve the lockfile.
    console.log(
      `⚠️  could not resolve the miden-client behind @miden-sdk/miden-sdk ${sdk.version} (${lock.message}) — skipping the pin check.`
    );
    return;
  }
  const sdkMidenClient = parseMidenClientFromCargoLock(lock.text);
  console.log(
    `[native-prover-pin] @miden-sdk/miden-sdk ${sdk.version} → miden-client ${sdkMidenClient}; native-prover pin =${pin}`
  );
  const result = evaluatePin({ pin, sdkVersion: sdk.version, sdkMidenClient, exemptions });
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

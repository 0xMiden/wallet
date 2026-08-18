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
 * It ALSO compares the transaction-kernel crates themselves — miden-protocol,
 * miden-tx, miden-core-lib, miden-assembly, miden-core, miden-mast-package,
 * miden-prover — between the web-sdk tag's `Cargo.lock` and the prover's OWN
 * lockfile (`packages/native-prover/android/rust-bridge/Cargo.lock`, its real
 * build input). Matching miden-client versions are NOT sufficient: `miden-client
 * = "=x.y.z"` does not pin its transitive deps, so the prover's lockfile can
 * resolve a different kernel crate under an unchanged client version — and that
 * is the version pair that decides whether the MAST procedure roots agree. That
 * blind spot was live: the prover resolved miden-protocol 0.16.0-rc.5 while
 * web-sdk v0.16.0-rc.2 resolved 0.16.0-rc.4, and the guard printed ✅.
 *
 * A drift is safe ONLY when no transaction-kernel crate MEANINGFULLY moved. A
 * miden-client(-web/-store)-only move keeps the same procedure set. Exemptions
 * are keyed on (pin, sdkVersion) so they auto-expire on ANY SDK bump, and a
 * kernel drift must be enumerated crate-by-crate in the exemption's
 * `kernelDrift` array — an unlisted or differently-versioned drift still fails.
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
const PROVER_LOCK = path.join(ROOT, 'packages/native-prover/android/rust-bridge/Cargo.lock');
const EXEMPTIONS_FILE = path.join(ROOT, 'packages/native-prover/pin-drift-exemptions.json');
const EXEMPTIONS_REL = path.relative(ROOT, EXEMPTIONS_FILE);
const PROVER_CARGO_REL = path.relative(ROOT, PROVER_CARGO);
const PROVER_LOCK_REL = path.relative(ROOT, PROVER_LOCK);

/**
 * The crates that define the transaction kernel's MAST procedure roots. If any of
 * these resolves differently on the two sides, the committed prover can compute a
 * root the SDK-built transaction doesn't contain — the "procedure with root digest
 * … could not be found" failure this guard exists to prevent.
 */
const KERNEL_CRATES = [
  'miden-protocol',
  'miden-tx',
  'miden-core-lib',
  'miden-assembly',
  'miden-core',
  'miden-mast-package',
  'miden-prover'
];
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

/**
 * Version of `name` in a Cargo.lock, or `undefined` when the crate is absent.
 * Anchored on the exact `name = "<crate>"` line so `miden-core` never matches
 * `miden-core-lib` (and `miden-client` never matches `miden-client-web`).
 */
function parseCrateFromCargoLock(lock, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `\\[\\[package\\]\\]\\s*\\r?\\nname = "${escaped}"\\s*\\r?\\nversion = "([0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?)"`
  );
  const m = lock.match(re);
  return m ? m[1] : undefined;
}

/**
 * Kernel crates that resolve to different versions (or are present on only one
 * side) between the prover's lockfile and the web-sdk tag's lockfile.
 * Returns `[{ crate, prover, sdk }]`, sorted by crate for stable output.
 */
function diffKernelCrates(proverLock, sdkLock) {
  const drift = [];
  for (const crate of KERNEL_CRATES) {
    const prover = parseCrateFromCargoLock(proverLock, crate);
    const sdk = parseCrateFromCargoLock(sdkLock, crate);
    // Absent on BOTH sides is not a drift — the SDK doesn't depend on every
    // kernel crate directly in every release line.
    if (prover === undefined && sdk === undefined) continue;
    if (prover !== sdk) drift.push({ crate, prover: prover ?? null, sdk: sdk ?? null });
  }
  return drift.sort((a, b) => a.crate.localeCompare(b.crate));
}

/** Stable one-line rendering of a drift entry, used in messages and comparisons. */
const describeDrift = d => `${d.crate}: prover ${d.prover ?? '(absent)'} vs sdk ${d.sdk ?? '(absent)'}`;

/**
 * True when `exemption.kernelDrift` covers EXACTLY the observed drift — same
 * crates, same versions on both sides. A partial or stale list does not count:
 * the whole point is that a reviewer signed off on these specific versions.
 */
function kernelDriftIsExempted(drift, exemption) {
  const recorded = (exemption?.kernelDrift ?? []).map(describeDrift).sort();
  const observed = drift.map(describeDrift).sort();
  return recorded.length === observed.length && recorded.every((entry, i) => entry === observed[i]);
}

function evaluatePin({ pin, sdkVersion, sdkMidenClient, kernelDrift = [], exemptions }) {
  const ex = exemptions.find(e => e.pin === pin && e.sdkVersion === sdkVersion);
  const clientDrift = pin !== sdkMidenClient;
  const driftLines = kernelDrift.map(d => `  - ${describeDrift(d)}`).join('\n');

  // Clean: the pin matches AND every kernel crate resolves to the same version on
  // both sides. Only then are the committed prover binaries and the SDK's wasm
  // guaranteed to agree on the transaction kernel's procedure roots.
  if (!clientDrift && kernelDrift.length === 0) {
    return {
      level: 'ok',
      message:
        `prover miden-client pin =${pin} matches the SDK's miden-client ${sdkMidenClient}, ` +
        `and all ${KERNEL_CRATES.length} transaction-kernel crates resolve identically in ${PROVER_LOCK_REL} and the web-sdk lockfile.`
    };
  }

  if (ex) {
    if (ex.sdkMidenClient !== sdkMidenClient) {
      return {
        level: 'fail',
        message:
          `the exemption for pin =${pin} @ @miden-sdk/miden-sdk ${sdkVersion} recorded miden-client ${ex.sdkMidenClient}, ` +
          `but that SDK tag now resolves miden-client ${sdkMidenClient}. The exemption is inconsistent — re-review and update ${EXEMPTIONS_REL}.`
      };
    }
    if (!kernelDriftIsExempted(kernelDrift, ex)) {
      const recorded = (ex.kernelDrift ?? []).map(d => `  - ${describeDrift(d)}`).join('\n') || '  (none recorded)';
      return {
        level: 'fail',
        message:
          `the exemption for pin =${pin} @ @miden-sdk/miden-sdk ${sdkVersion} does not cover the observed ` +
          `transaction-kernel drift.\nObserved:\n${driftLines || '  (none)'}\nRecorded in ${EXEMPTIONS_REL}:\n${recorded}\n` +
          `An exemption must enumerate EXACTLY the kernel crates that differ, with both versions — re-review and update it.`
      };
    }
    return {
      level: 'exempted',
      message:
        `pin =${pin} / kernel crates differ from @miden-sdk/miden-sdk ${sdkVersion} ` +
        `(miden-client ${sdkMidenClient})${driftLines ? `:\n${driftLines}\n` : ', '}` +
        `but the drift is a documented safe exemption: ${ex.reason}`
    };
  }

  if (clientDrift) {
    return {
      level: 'fail',
      message:
        `DRIFT: the native prover pins miden-client =${pin}, but @miden-sdk/miden-sdk ${sdkVersion} resolves to miden-client ${sdkMidenClient}.\n` +
        (driftLines ? `Transaction-kernel crates also differ:\n${driftLines}\n` : '') +
        `A pin out of step with the SDK's miden-client makes the prover reject valid transactions on-device ` +
        `("procedure with root digest … could not be found" — see #414 / #487).\n` +
        `Fix EITHER by:\n` +
        `  (a) bumping the pin in ${PROVER_CARGO_REL} to =${sdkMidenClient}, regenerating ${PROVER_LOCK_REL} against the SDK's ` +
        `kernel-crate versions, AND rebuilding the committed prover binaries; or\n` +
        `  (b) if the drift is verified safe, adding an exemption to ${EXEMPTIONS_REL}:\n` +
        `      ${JSON.stringify({ pin, sdkVersion, sdkMidenClient, kernelDrift, reason: '…' })}`
    };
  }

  return {
    level: 'fail',
    message:
      `KERNEL DRIFT: the prover pin =${pin} matches the SDK's miden-client, but the two sides resolve different ` +
      `transaction-kernel crates:\n${driftLines}\n` +
      `\`miden-client = "=${pin}"\` does NOT pin its transitive deps, so a matching client version is not evidence the ` +
      `procedure roots agree — this is exactly the on-device ` +
      `"procedure with root digest … could not be found" failure (#414 / #487).\n` +
      `Fix EITHER by:\n` +
      `  (a) regenerating ${PROVER_LOCK_REL} against the SDK's kernel-crate versions AND rebuilding the committed prover binaries; or\n` +
      `  (b) if the drift is verified safe (e.g. the crate sources are identical and only the version metadata moved), ` +
      `adding an exemption to ${EXEMPTIONS_REL}:\n` +
      `      ${JSON.stringify({ pin, sdkVersion, sdkMidenClient, kernelDrift, reason: '…' })}`
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

  // parseCrateFromCargoLock: exact-name anchoring, absent crate
  const kernelLock =
    '[[package]]\nname = "miden-core-lib"\nversion = "0.29.1"\n\n' +
    '[[package]]\nname = "miden-core"\nversion = "0.29.0"\n';
  assert(parseCrateFromCargoLock(kernelLock, 'miden-core') === '0.29.0', 'miden-core is not miden-core-lib');
  assert(parseCrateFromCargoLock(kernelLock, 'miden-core-lib') === '0.29.1', 'miden-core-lib resolves');
  assert(parseCrateFromCargoLock(kernelLock, 'miden-protocol') === undefined, 'absent crate → undefined');

  // diffKernelCrates: identical → none; version move → one entry; one-sided → entry
  const lockA = '[[package]]\nname = "miden-protocol"\nversion = "0.16.0-rc.4"\n';
  const lockB = '[[package]]\nname = "miden-protocol"\nversion = "0.16.0-rc.5"\n';
  assert(diffKernelCrates(lockA, lockA).length === 0, 'identical locks → no kernel drift');
  const oneDrift = diffKernelCrates(lockB, lockA);
  assert(
    oneDrift.length === 1 && oneDrift[0].crate === 'miden-protocol' && oneDrift[0].prover === '0.16.0-rc.5',
    'version move → one drift entry'
  );
  assert(diffKernelCrates(lockA, '').length === 1, 'crate present on only one side → drift');
  assert(diffKernelCrates('', '').length === 0, 'absent on both sides → no drift');

  // evaluatePin + kernel drift: a MATCHING client pin no longer implies ok.
  const kd = [{ crate: 'miden-protocol', prover: '0.16.0-rc.5', sdk: '0.16.0-rc.4' }];
  assert(
    evaluatePin({ pin: '0.16.0-rc.1', sdkVersion: '0.16.0-rc.2', sdkMidenClient: '0.16.0-rc.1', exemptions: [] })
      .level === 'ok',
    'matching pin, no kernel drift → ok'
  );
  assert(
    evaluatePin({
      pin: '0.16.0-rc.1',
      sdkVersion: '0.16.0-rc.2',
      sdkMidenClient: '0.16.0-rc.1',
      kernelDrift: kd,
      exemptions: []
    }).level === 'fail',
    'matching pin but kernel drift → fail (the blind spot this guard grew to cover)'
  );
  const kdEx = [
    { pin: '0.16.0-rc.1', sdkVersion: '0.16.0-rc.2', sdkMidenClient: '0.16.0-rc.1', kernelDrift: kd, reason: 'r' }
  ];
  assert(
    evaluatePin({
      pin: '0.16.0-rc.1',
      sdkVersion: '0.16.0-rc.2',
      sdkMidenClient: '0.16.0-rc.1',
      kernelDrift: kd,
      exemptions: kdEx
    }).level === 'exempted',
    'kernel drift + exactly-matching exemption → exempted'
  );
  assert(
    evaluatePin({
      pin: '0.16.0-rc.1',
      sdkVersion: '0.16.0-rc.2',
      sdkMidenClient: '0.16.0-rc.1',
      kernelDrift: [...kd, { crate: 'miden-tx', prover: '0.16.0-rc.5', sdk: '0.16.0-rc.4' }],
      exemptions: kdEx
    }).level === 'fail',
    'an extra un-recorded kernel drift → fail'
  );
  assert(
    evaluatePin({
      pin: '0.16.0-rc.1',
      sdkVersion: '0.16.0-rc.2',
      sdkMidenClient: '0.16.0-rc.1',
      kernelDrift: [{ crate: 'miden-protocol', prover: '0.16.0-rc.6', sdk: '0.16.0-rc.4' }],
      exemptions: kdEx
    }).level === 'fail',
    'recorded crate but a different version pair → fail'
  );
  assert(
    evaluatePin({ pin: '0.15.4', sdkVersion: '0.15.9', sdkMidenClient: '0.15.5', exemptions: ex }).level === 'exempted',
    'client-only drift + legacy exemption with no kernelDrift → still exempted'
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

  // The prover's OWN lockfile is its real build input; the pin in Cargo.toml does
  // not constrain the transitive kernel crates that decide the procedure roots.
  if (!fs.existsSync(PROVER_LOCK)) {
    throw new Error(`${PROVER_LOCK_REL} is missing — the native prover's resolved kernel crates cannot be checked.`);
  }
  const kernelDrift = diffKernelCrates(fs.readFileSync(PROVER_LOCK, 'utf8'), lock.text);

  console.log(
    `[native-prover-pin] @miden-sdk/miden-sdk ${sdk.version} → miden-client ${sdkMidenClient}; native-prover pin =${pin}`
  );
  if (kernelDrift.length > 0) {
    console.log(
      `[native-prover-pin] transaction-kernel drift:\n${kernelDrift.map(d => `  - ${describeDrift(d)}`).join('\n')}`
    );
  }
  const result = evaluatePin({ pin, sdkVersion: sdk.version, sdkMidenClient, kernelDrift, exemptions });
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

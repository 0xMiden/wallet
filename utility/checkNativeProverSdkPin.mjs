import fs from 'node:fs/promises';

const PACKAGE_JSON = new URL('../package.json', import.meta.url);
const PROVER_CARGO_TOML = new URL(
  '../packages/native-prover/android/rust-bridge/Cargo.toml',
  import.meta.url,
);

// Explicitly documented safe drifts. A new SDK release will fail unless its
// miden-client version matches the prover pin or a maintainer records an
// exception here after checking the transaction-kernel crate set.
const PIN_EXCEPTIONS = {
  '0.15.9': {
    sdkClient: '0.15.5',
    proverClient: '0.15.4',
    reason:
      'web-sdk v0.15.9 changes only client-layer crates; the transaction-kernel/MASM crate versions are unchanged from the prover build',
  },
};

function fail(message) {
  console.error(`[native-prover-pin] ${message}`);
  process.exit(1);
}

function parseLockedPackageVersion(lockfile, packageName) {
  for (const block of lockfile.split('[[package]]').slice(1)) {
    const name = block.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
    if (name !== packageName) continue;

    const version = block.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
    if (!version) fail(`Cargo.lock entry for ${packageName} has no version`);
    return version;
  }

  fail(`Cargo.lock does not contain ${packageName}`);
}

const packageJson = JSON.parse(await fs.readFile(PACKAGE_JSON, 'utf8'));
const sdkVersion = packageJson.dependencies?.['@miden-sdk/miden-sdk'];
if (!sdkVersion || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(sdkVersion)) {
  fail(`expected an exact @miden-sdk/miden-sdk version, got ${JSON.stringify(sdkVersion)}`);
}

const cargoToml = await fs.readFile(PROVER_CARGO_TOML, 'utf8');
const proverClient = cargoToml.match(
  /^miden-client\s*=\s*\{[^\n}]*version\s*=\s*"=([^"]+)"[^\n}]*\}/m,
)?.[1];
if (!proverClient) {
  fail('could not read the exact miden-client pin from the native prover Cargo.toml');
}

const lockUrl = `https://raw.githubusercontent.com/0xMiden/web-sdk/v${sdkVersion}/Cargo.lock`;
const response = await fetch(lockUrl, {
  headers: { 'User-Agent': 'miden-wallet-native-prover-pin-check' },
});
if (!response.ok) {
  fail(`failed to fetch web-sdk v${sdkVersion} Cargo.lock (${response.status})`);
}

const sdkClient = parseLockedPackageVersion(await response.text(), 'miden-client');

if (proverClient === sdkClient) {
  console.log(
    `[native-prover-pin] OK: SDK ${sdkVersion} and native prover both use miden-client ${sdkClient}`,
  );
  process.exit(0);
}

const exception = PIN_EXCEPTIONS[sdkVersion];
if (
  exception?.sdkClient === sdkClient &&
  exception?.proverClient === proverClient
) {
  console.log(
    `[native-prover-pin] DOCUMENTED EXCEPTION: SDK ${sdkVersion} resolves miden-client ${sdkClient}, prover remains on ${proverClient}. ${exception.reason}.`,
  );
  process.exit(0);
}

fail(
  `SDK ${sdkVersion} resolves miden-client ${sdkClient}, but the native prover pins ${proverClient}. ` +
    'Update/rebuild the native prover, or record an exception after verifying the kernel-critical crate versions.',
);

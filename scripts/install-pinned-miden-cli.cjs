const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLIENT_CRATES = ['miden-client', 'miden-client-cli', 'miden-client-proto', 'miden-client-sqlite-store'];
const KERNEL_CRATES = ['miden-protocol', 'miden-standards', 'miden-tx'];
const KERNEL_SUPPORT_CRATES = ['miden-agglayer', 'miden-protocol-build-utils'];
const VM_CRATE =
  /^miden-(air|assembly(?:-syntax)?|core(?:-lib)?|crypto(?:-derive)?|mast-package|processor|prover|verifier|utils(?:-sync)?)$/;

function packages(lock) {
  return lock
    .split('[[package]]')
    .slice(1)
    .map(block => ({
      name: block.match(/^name = "([^"]+)"/m)?.[1],
      version: block.match(/^version = "([^"]+)"/m)?.[1],
      source: block.match(/^source = "([^"]+)"/m)?.[1]
    }));
}

function constrainManifest(manifest, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Protocol pin must be an exact stable version');
  for (const name of KERNEL_CRATES) {
    const pattern = new RegExp(`^(${name}\\s*=\\s*\\{[^\\n]*version\\s*=\\s*")[^"]+("[^\\n]*\\})`, 'gm');
    let matches = 0;
    manifest = manifest.replace(pattern, (_, before, after) => {
      matches++;
      return `${before}=${version}${after}`;
    });
    if (matches !== 1) throw new Error(`Expected one workspace dependency for ${name}, found ${matches}`);
  }
  return manifest;
}

function assertGraph(lock, clientVersion, protocolVersion, originalLock) {
  const resolved = packages(lock);
  for (const name of [...CLIENT_CRATES, ...KERNEL_CRATES, ...KERNEL_SUPPORT_CRATES]) {
    const expected = CLIENT_CRATES.includes(name) ? clientVersion : protocolVersion;
    const entries = resolved.filter(pkg => pkg.name === name);
    if (entries.length !== 1 || entries[0].version !== expected) {
      throw new Error(`${name} must resolve exactly once to ${expected}`);
    }
  }
  const vmGraph = text =>
    packages(text)
      .filter(pkg => VM_CRATE.test(pkg.name))
      .map(pkg => `${pkg.name}@${pkg.version}:${pkg.source ?? 'path'}`)
      .sort();
  const original = vmGraph(originalLock);
  if (!original.length || JSON.stringify(original) !== JSON.stringify(vmGraph(lock))) {
    throw new Error('Preparing the CLI changed its frozen Miden VM graph');
  }
}

function pinIdentity(pkg) {
  const pin = {
    git: pkg.midenClientCliGit,
    client: pkg.midenClientCliVersion,
    protocol: pkg.midenClientCliProtocolVersion
  };
  if (!pin.git?.url || !/^[a-f0-9]{40}$/.test(pin.git.rev) || !/^\d+\.\d+\.\d+$/.test(pin.client)) {
    throw new Error('CLI preparation requires a full git commit and exact stable client version');
  }
  constrainManifest(KERNEL_CRATES.map(name => `${name} = { version = "0.0.0" }`).join('\n'), pin.protocol);
  return pin;
}

function fingerprint(pkg) {
  return createHash('sha256')
    .update(JSON.stringify(pinIdentity(pkg)))
    .update(fs.readFileSync(__filename))
    .digest('hex');
}

function prepareSource(source, pkg, run = execFileSync) {
  const pin = pinIdentity(pkg);
  const manifestPath = path.join(source, 'Cargo.toml');
  const lockPath = path.join(source, 'Cargo.lock');
  const original = fs.readFileSync(lockPath, 'utf8');
  fs.writeFileSync(manifestPath, constrainManifest(fs.readFileSync(manifestPath, 'utf8'), pin.protocol));
  run('cargo', ['update', '--workspace'], { cwd: source, stdio: 'inherit', timeout: 180_000 });
  assertGraph(fs.readFileSync(lockPath, 'utf8'), pin.client, pin.protocol, original);
  run('cargo', ['metadata', '--locked', '--all-features', '--format-version', '1'], {
    cwd: source,
    stdio: ['ignore', 'ignore', 'inherit'],
    timeout: 180_000
  });
}

function validPreparedBinary(pkg, root) {
  const binary = path.join(root, 'bin', 'miden-client');
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(root, 'prepared-cli.json'), 'utf8'));
    const hash = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
    return stamp.identity === fingerprint(pkg) && stamp.binaryHash === hash;
  } catch {
    return false;
  }
}

function install(pkg, root = path.join(os.homedir(), '.cache', 'miden-cli', fingerprint(pkg))) {
  const pin = pinIdentity(pkg);
  const identity = fingerprint(pkg);
  const binary = path.join(root, 'bin', 'miden-client');
  const stampPath = path.join(root, 'prepared-cli.json');
  if (validPreparedBinary(pkg, root)) return binary;
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'miden-cli-source-'));
  try {
    execFileSync('git', ['clone', '--no-checkout', pin.git.url, source], { stdio: 'inherit', timeout: 180_000 });
    execFileSync('git', ['checkout', '--detach', pin.git.rev], { cwd: source, stdio: 'inherit' });
    prepareSource(source, pkg);
    execFileSync(
      'cargo',
      ['install', '--path', 'bin/miden-cli', '--bin', 'miden-client', '--locked', '--root', root, '--force'],
      {
        cwd: source,
        stdio: 'inherit',
        timeout: 1_800_000
      }
    );
    const binaryHash = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
    fs.writeFileSync(stampPath, JSON.stringify({ identity, binaryHash, pin }, null, 2));
    return binary;
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
}

module.exports = {
  packages,
  constrainManifest,
  assertGraph,
  pinIdentity,
  fingerprint,
  prepareSource,
  validPreparedBinary,
  install
};
if (require.main === module) {
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  if (process.argv[2] === 'fingerprint') console.log(fingerprint(pkg));
  else if (process.argv[2] === 'install') console.log(install(pkg, process.argv[3]));
  else throw new Error('Usage: install-pinned-miden-cli.cjs {fingerprint|install [root]}');
}

// CI-only production-feature Node addon producer. The SDK checkout is disposable.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const [sdkArg, outputArg, proofArg, walletSource, sdkSource, sdkTree, rustSdk, expectedLock] = process.argv.slice(2);
if (![sdkArg, outputArg, proofArg, walletSource, sdkSource, sdkTree, rustSdk, expectedLock].every(Boolean)) throw new Error('Missing addon producer arguments');
if (![walletSource, sdkSource, sdkTree, rustSdk].every(x => /^[0-9a-f]{40}$/.test(x)) || !/^[0-9a-f]{64}$/.test(expectedLock)) throw new Error('Invalid source or lock identity');
const sdk = path.resolve(sdkArg); const output = path.resolve(outputArg); const proof = path.resolve(proofArg);
fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(proof, { recursive: true });
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const git = (...args) => execFileSync('git', ['-C', sdk, ...args], { encoding: 'utf8' }).trim();
if (git('rev-parse', 'HEAD') !== sdkSource || git('rev-parse', 'HEAD^{tree}') !== sdkTree || git('status', '--porcelain')) throw new Error('SDK checkout is not exact and clean');
const lock = fs.readFileSync(path.join(sdk, 'Cargo.lock'));
if (hash(lock) !== expectedLock || !lock.toString('utf8').includes(rustSdk)) throw new Error('Cargo lock or rust-sdk revision mismatch');
const stdout = fs.openSync(path.join(proof, 'cargo-artifacts.jsonl'), 'w');
const stderr = fs.openSync(path.join(proof, 'cargo-stderr.log'), 'w');
let result;
try {
  const args = ['+nightly-2026-08-06', 'build', '-p', 'miden-client-web', '--no-default-features', '--features', 'nodejs', '--release', '--locked', '--message-format=json-render-diagnostics'];
  fs.writeFileSync(path.join(proof, 'cargo-command.json'), `${JSON.stringify({ executable: 'cargo', args })}\n`);
  result = spawnSync('cargo', args, { cwd: sdk, stdio: ['ignore', stdout, stderr], timeout: 70 * 60 * 1000 });
} finally { fs.closeSync(stdout); fs.closeSync(stderr); }
if (result.error || result.status !== 0) throw new Error(`Production Node build failed: ${result.error?.message ?? result.status}`);
if (git('rev-parse', 'HEAD') !== sdkSource || git('rev-parse', 'HEAD^{tree}') !== sdkTree || git('status', '--porcelain')) throw new Error('SDK checkout changed during build');
const lines = fs.readFileSync(path.join(proof, 'cargo-artifacts.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const artifacts = lines.filter(x => x.reason === 'compiler-artifact' && x.target?.name === 'miden_client_web').flatMap(x => x.filenames ?? []).filter(x => x.endsWith('.so'));
if (artifacts.length !== 1) throw new Error('Expected exactly one Node library');
const real = fs.realpathSync(artifacts[0]);
if (!real.startsWith(`${sdk}${path.sep}`)) throw new Error('Node library outside SDK checkout');
const binary = fs.readFileSync(real); const destination = path.join(output, 'miden_client_web.node'); fs.writeFileSync(destination, binary);
const loaded = require(destination);
if (!loaded || typeof loaded !== 'object') throw new Error('Produced Node addon did not load');
fs.writeFileSync(path.join(output, 'addon.json'), `${JSON.stringify({ source: walletSource, sdk: sdkSource, sdkTree, rustSdk, cargoLockSha256: expectedLock, features: 'nodejs', noDefaultFeatures: true, locked: true, sha256: hash(binary) })}\n`);

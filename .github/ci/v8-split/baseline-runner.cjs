// CI-only. Run after the exact SDK and verified Node addon have been staged.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
const [proofArg, outputArg, addonPlanArg] = process.argv.slice(2);
if (!proofArg || !outputArg || !addonPlanArg) throw new Error('usage: baseline-runner.cjs PROOF_DIR OUTPUT_DIR ADDON_PLAN');
const proof = path.resolve(proofArg);
const output = path.resolve(outputArg);
fs.mkdirSync(output, { recursive: true });
const source = read(path.join(proof, 'source.json'));
const addon = read(path.join(proof, 'addon-binding.json'));
const approved = read(addonPlanArg);
if (approved.source !== source.wallet_source || approved.sdk !== addon.sdk || approved.addon.sha256 !== addon.sha256 || approved.packageSetSha256 !== sha(fs.readFileSync(path.join(proof, 'installed-identities.json')))) throw new Error('Approved SDK package identity mismatch');
const replay = read(path.join(proof, 'frozen-replay.json'));
if (!replay.fresh_dependency_tree || replay.source !== source.wallet_source || addon.source !== source.wallet_source || !/^[0-9a-f]{40}$/.test(addon.sdk) || !/^[0-9a-f]{64}$/.test(addon.sha256)) throw new Error('Source or SDK staging is not bound');
const binary = path.resolve('node_modules/@miden-sdk/node-linux-x64-gnu/miden_client_web.node');
if (sha(fs.readFileSync(binary)) !== addon.sha256) throw new Error('Installed addon differs from producer');
const run = (name, executable, args) => {
  const log = fs.openSync(path.join(proof, `${name}.log`), 'w');
  try {
    const result = spawnSync(executable, args, { cwd: process.cwd(), stdio: ['ignore', log, log], timeout: 60 * 60 * 1000, env: process.env });
    if (result.error || result.status !== 0) throw new Error(`${name} failed: ${result.error?.message ?? result.status}`);
  } finally { fs.closeSync(log); }
};
run('addon-load', process.execPath, ['-e', 'const x=require(process.argv[1]); if (!x || typeof x !== "object") process.exit(1)', binary]);
const jest = path.resolve('node_modules/.bin/jest');
run('jest-config', jest, ['--showConfig', '--json']);
// --showConfig writes JSON to stdout; the file is the captured log.
const show = read(path.join(proof, 'jest-config.log'));
if (show.globalConfig.coverageProvider !== 'v8' || show.configs.length !== 1) throw new Error('Original single-project V8 config required');
run('jest-list', jest, ['--listTests', '--json', '--maxWorkers=2']);
const listed = read(path.join(proof, 'jest-list.log'));
const sourceRoot = path.resolve(show.globalConfig.rootDir);
const normalize = file => {
  const relative = path.relative(sourceRoot, path.resolve(file));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Test outside source root');
  return relative.split(path.sep).join('/');
};
const files = listed.map(normalize).sort();
if (!files.length || new Set(files).size !== files.length) throw new Error('Invalid Jest inventory');
write(path.join(output, 'inventory.json'), { files });
run('denominator', process.execPath, [path.join(__dirname, 'denominator.cjs'), path.join(proof, 'jest-config.log')]);
const denominator = read(path.join(proof, 'denominator.log'));
write(path.join(output, 'denominator.json'), denominator);
const resultPath = path.join(proof, 'full-jest-results.json');
run('jest-full-noncoverage', jest, ['--maxWorkers=2', '--no-coverage', '--json', `--outputFile=${resultPath}`]);
const result = read(resultPath);
if (!result.success || result.numPassedTests < 1 || result.numFailedTests || result.numFailedTestSuites || result.numRuntimeErrorTestSuites) throw new Error('Full baseline is not passing');
result.testResults = result.testResults.map(suite => ({ ...suite, file: normalize(suite.name) }));
if (JSON.stringify(result.testResults.map(suite => suite.file).sort()) !== JSON.stringify(files)) throw new Error('Full baseline file closure mismatch');
write(path.join(output, 'jest-results.json'), result);
const binding = {
  source: source.wallet_source, tree: source.wallet_tree, sdk: addon.sdk, addonSha256: addon.sha256,
  packageSetSha256: sha(fs.readFileSync(path.join(proof, 'installed-identities.json'))),
  configSha256: sha(fs.readFileSync('jest.config.ts')),
  mergeSha256: sha(fs.readFileSync('scripts/merge-jest-coverage.mjs')),
  inventorySha256: sha(fs.readFileSync(path.join(output, 'inventory.json'))),
  resultsSha256: sha(fs.readFileSync(path.join(output, 'jest-results.json'))),
  denominatorSha256: sha(fs.readFileSync(path.join(output, 'denominator.json')))
};
write(path.join(output, 'binding.json'), binding);

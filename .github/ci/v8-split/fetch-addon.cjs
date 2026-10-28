// CI-only. Fetch the approved immutable producer artifact and stage its exact binary.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const [planPath, proofArg] = process.argv.slice(2);
if (!planPath || !proofArg) throw new Error('usage: fetch-addon.cjs PLAN PROOF_DIR');
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const addon = plan.addon;
const api = endpoint => JSON.parse(execFileSync('gh', ['api', endpoint], { maxBuffer: 256 * 1024 * 1024 }));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const run = api(`repos/0xMiden/wallet/actions/runs/${addon.runId}`);
if (run.status !== 'completed' || run.conclusion !== 'success' || run.head_sha !== addon.workflowSha) throw new Error('Wrong or incomplete addon producer');
const metadata = api(`repos/0xMiden/wallet/actions/artifacts/${addon.artifactId}`);
if (metadata.expired || metadata.workflow_run?.id !== addon.runId || metadata.digest !== `sha256:${addon.archiveSha256}`) throw new Error('Wrong addon artifact identity');
const archive = execFileSync('gh', ['api', `repos/0xMiden/wallet/actions/artifacts/${addon.artifactId}/zip`], { maxBuffer: 256 * 1024 * 1024 });
if (hash(archive) !== addon.archiveSha256) throw new Error('Addon archive digest mismatch');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-addon-'));
try {
  const zip = path.join(temp, 'addon.zip'); fs.writeFileSync(zip, archive);
  const names = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n').sort();
  if (JSON.stringify(names) !== JSON.stringify(['addon.json', 'miden_client_web.node'])) throw new Error('Unexpected addon archive contents');
  const info = JSON.parse(execFileSync('unzip', ['-p', zip, 'addon.json']));
  const binary = execFileSync('unzip', ['-p', zip, 'miden_client_web.node'], { maxBuffer: 256 * 1024 * 1024 });
  if (info.source !== plan.source || info.sdk !== plan.sdk || info.sdkTree !== addon.sdkTree || info.rustSdk !== addon.rustSdk || info.cargoLockSha256 !== addon.cargoLockSha256 || info.features !== 'nodejs' || info.noDefaultFeatures !== true || info.locked !== true || info.sha256 !== addon.sha256 || hash(binary) !== addon.sha256) throw new Error('Addon source, build flags, lock or binary mismatch');
  const destination = path.resolve('node_modules/@miden-sdk/node-linux-x64-gnu/miden_client_web.node');
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, binary);
  const loaded = require(destination);
  if (!loaded || typeof loaded !== 'object') throw new Error('Addon did not load');
  fs.writeFileSync(path.join(proofArg, 'addon-binding.json'), `${JSON.stringify({ source: plan.source, sdk: plan.sdk, sdkTree: addon.sdkTree, rustSdk: addon.rustSdk, sha256: addon.sha256, producerRunId: addon.runId, artifactId: addon.artifactId, cargoLockSha256: addon.cargoLockSha256 })}\n`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

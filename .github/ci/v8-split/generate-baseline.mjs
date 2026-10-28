// Prepare, but never dispatch, a full noncoverage inventory baseline after addon verification.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderBaselineWorkflow } from './baseline-workflow.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const [approval, output] = process.argv.slice(2);
if (!approval || !output || !resolve(output).startsWith(`${resolve(repo, 'docs/superpowers')}/`)) throw new Error('usage: generate-baseline.mjs ADDON_APPROVAL NEW_BUNDLE');
const temp = mkdtempSync(join(tmpdir(), 'wallet-v8-baseline-'));
try {
  const input = JSON.parse(readFileSync(approval, 'utf8'));
  if (input.mode !== 'addon-only') throw new Error('Explicit addon-only preflight required');
  const planPath = join(temp, 'addon-plan.json');
  execFileSync(process.execPath, [join(here, 'source-bound.mjs'), resolve(approval), planPath], { cwd: repo, stdio: 'inherit', timeout: 120000 });
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  if (plan.sdk !== 'fd52477d7c7d5d475dc14987ebbd7a36dbb703da') throw new Error('Injection recipe is bound to SDK fd524 only');
  const bundle = resolve(output); mkdirSync(bundle, { recursive: false });
  const paths = ['.github/workflows/issue1948-sdk-injection.yml', '.github/ci/issue1948-sdk-injection.py', '.github/ci/issue1948-sdk-injection-inputs.json', '.github/ci/v8-split/fetch-addon.cjs', '.github/ci/v8-split/baseline-runner.cjs', '.github/ci/v8-split/denominator.cjs', '.github/ci/v8-split/addon-plan.json'];
  for (const path of paths) mkdirSync(dirname(join(bundle, path)), { recursive: true });
  const injection = resolve(repo, 'docs/superpowers/combined-external-boundary-baseline-execution');
  copyFileSync(join(injection, 'inject.py'), join(bundle, paths[1]));
  const config = JSON.parse(readFileSync(join(injection, 'config.json'), 'utf8'));
  Object.assign(config, { wallet_source: plan.source, wallet_tree: plan.tree, phase: 'v8-source-bound-baseline', proof_paths: paths });
  writeFileSync(join(bundle, paths[2]), `${JSON.stringify(config, null, 2)}\n`);
  for (const name of ['fetch-addon.cjs', 'baseline-runner.cjs', 'denominator.cjs']) copyFileSync(join(here, name), join(bundle, `.github/ci/v8-split/${name}`));
  copyFileSync(planPath, join(bundle, paths[6]));
  const workflow = renderBaselineWorkflow(plan.source);
  writeFileSync(join(bundle, paths[0]), workflow);
  const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  const manifest = { source: plan.source, source_tree: plan.tree, sdk_source: plan.sdk, proof_paths: paths, files: Object.fromEntries(paths.map(path => [path, sha(join(bundle, path))])), purpose: 'Full noncoverage inventory and independent Jest V8 denominator using exact verified addon', dispatched: false };
  writeFileSync(join(bundle, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ bundle, manifestSha256: sha(join(bundle, 'manifest.json')), dispatched: false }));
} finally { rmSync(temp, { recursive: true, force: true }); }

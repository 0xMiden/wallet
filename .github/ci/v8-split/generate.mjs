// Generates an immutable proof bundle only after the source-bound preflight succeeds.
// It never pushes or dispatches. No fallback to a published or missing addon exists.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPlan } from './core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const [approval, output] = process.argv.slice(2);
if (!approval || !output || !resolve(output).startsWith(`${resolve(repo, 'docs/superpowers')}/`)) throw new Error('usage: generate.mjs APPROVAL_JSON NEW_BUNDLE_UNDER_DOCS_SUPERPOWERS');
const temp = mkdtempSync(join(tmpdir(), 'wallet-v8-plan-'));
try {
  const planFile = join(temp, 'plan.json');
  // This independently checks GitHub producer runs, signed proof refs, archive digests,
  // exact Node addon source and baseline inventory before a bundle can exist.
  execFileSync(process.execPath, [join(here, 'source-bound.mjs'), resolve(approval), planFile], { cwd: repo, stdio: 'inherit', timeout: 120000 });
  const plan = JSON.parse(readFileSync(planFile, 'utf8')); verifyPlan(plan);
  if (plan.general.length + plan.partitions.length > 256) throw new Error('GitHub matrix limit exceeded');
  if (plan.sdk !== 'fd52477d7c7d5d475dc14987ebbd7a36dbb703da') throw new Error('This injection recipe is bound to SDK fd524 only');
  const bundle = resolve(output); mkdirSync(bundle, { recursive: false });
  const paths = ['.github/workflows/issue1948-sdk-injection.yml', '.github/ci/issue1948-sdk-injection.py', '.github/ci/issue1948-sdk-injection-inputs.json', '.github/ci/v8-split/core.mjs', '.github/ci/v8-split/gate.mjs', '.github/ci/v8-split/run-shard.cjs', '.github/ci/v8-split/fetch-addon.cjs', '.github/ci/v8-split/plan.json'];
  for (const path of paths) mkdirSync(dirname(join(bundle, path)), { recursive: true });
  const injection = resolve(repo, 'docs/superpowers/combined-external-boundary-baseline-execution');
  copyFileSync(join(injection, 'inject.py'), join(bundle, paths[1]));
  const config = JSON.parse(readFileSync(join(injection, 'config.json'), 'utf8'));
  Object.assign(config, { wallet_source: plan.source, wallet_tree: plan.tree, phase: 'v8-exhaustive-split', proof_paths: paths });
  writeFileSync(join(bundle, paths[2]), `${JSON.stringify(config, null, 2)}\n`);
  for (const name of ['core.mjs', 'gate.mjs', 'run-shard.cjs', 'fetch-addon.cjs']) copyFileSync(join(here, name), join(bundle, `.github/ci/v8-split/${name}`));
  copyFileSync(planFile, join(bundle, paths[7]));
  const workflow = `name: Issue1948 exhaustive source-bound V8 coverage
on:
  push:
    branches: ['ci/1948-sdk-injection-*']
permissions:
  contents: read
  actions: read
jobs:
  plan:
    runs-on: ubuntu-24.04
    outputs:
      matrix: \u0024{{ steps.matrix.outputs.matrix }}
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - id: matrix
        run: |
          node --input-type=module -e 'import {readFileSync} from "node:fs"; import {verifyPlan} from "./.github/ci/v8-split/core.mjs"; const p=JSON.parse(readFileSync(".github/ci/v8-split/plan.json")); verifyPlan(p); console.log("matrix="+JSON.stringify({id:[...p.general,...p.partitions].map(x=>x.id)}))' >> "$GITHUB_OUTPUT"
  coverage:
    needs: plan
    runs-on: ubuntu-24.04
    timeout-minutes: 90
    strategy:
      fail-fast: false
      matrix: \u0024{{ fromJSON(needs.plan.outputs.matrix) }}
    env:
      GH_TOKEN: \u0024{{ github.token }}
      NODE_OPTIONS: --max-old-space-size=8192
    steps:
      - uses: actions/checkout@v4
        with:
          path: controller
          fetch-depth: 2
          persist-credentials: false
      - uses: actions/checkout@v4
        with:
          ref: ${plan.source}
          path: wallet
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
` + ['bind', 'packages', 'inject', 'generate-lock', 'replay', 'identities'].map(stage => `      - name: ${stage}
        timeout-minutes: 12
        run: |
          set -euo pipefail
          mkdir -p proof
          python3 controller/.github/ci/issue1948-sdk-injection.py ${stage} --config controller/.github/ci/issue1948-sdk-injection-inputs.json 2>&1 | tee proof/stage-${stage}.log
`).join('') + `      - name: Verify and stage producer addon
        run: |
          set -euo pipefail
          cd replay
          node ../controller/.github/ci/v8-split/fetch-addon.cjs ../controller/.github/ci/v8-split/plan.json ../proof
      - name: Run exact coverage shard
        env:
          TARGET: \u0024{{ matrix.id }}
        run: |
          set -euo pipefail
          cd replay
          node ../controller/.github/ci/v8-split/run-shard.cjs ../controller/.github/ci/v8-split/plan.json "$TARGET" ../proof
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: \u0024{{ matrix.id }}
          path: |
            proof/
            replay/coverage/
          if-no-files-found: error
  coverage-gate:
    needs: [plan, coverage]
    if: \u0024{{ !cancelled() }}
    runs-on: ubuntu-24.04
    timeout-minutes: 90
    env:
      GH_TOKEN: \u0024{{ github.token }}
      NODE_OPTIONS: --max-old-space-size=8192
    steps:
      - name: Require every coverage shard
        env:
          RESULT: \u0024{{ needs.coverage.result }}
        run: test "$RESULT" = success
      - uses: actions/checkout@v4
        with:
          path: controller
          persist-credentials: false
      - uses: actions/checkout@v4
        with:
          ref: ${plan.source}
          path: wallet
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Gate bind
        timeout-minutes: 12
        run: |
          set -euo pipefail
          mkdir -p proof
          python3 controller/.github/ci/issue1948-sdk-injection.py bind --config controller/.github/ci/issue1948-sdk-injection-inputs.json 2>&1 | tee proof/gate-stage-bind.log
      - name: Gate packages
        timeout-minutes: 12
        run: |
          set -euo pipefail
          mkdir -p proof
          python3 controller/.github/ci/issue1948-sdk-injection.py packages --config controller/.github/ci/issue1948-sdk-injection-inputs.json 2>&1 | tee proof/gate-stage-packages.log
      - name: Gate inject
        timeout-minutes: 12
        run: |
          set -euo pipefail
          mkdir -p proof
          python3 controller/.github/ci/issue1948-sdk-injection.py inject --config controller/.github/ci/issue1948-sdk-injection-inputs.json 2>&1 | tee proof/gate-stage-inject.log
      - name: Gate generate-lock
        timeout-minutes: 12
        run: |
          set -euo pipefail
          mkdir -p proof
          python3 controller/.github/ci/issue1948-sdk-injection.py generate-lock --config controller/.github/ci/issue1948-sdk-injection-inputs.json 2>&1 | tee proof/gate-stage-generate-lock.log
      - name: Gate replay
        timeout-minutes: 12
        run: |
          set -euo pipefail
          mkdir -p proof
          python3 controller/.github/ci/issue1948-sdk-injection.py replay --config controller/.github/ci/issue1948-sdk-injection-inputs.json 2>&1 | tee proof/gate-stage-replay.log
      - name: Gate identities
        timeout-minutes: 12
        run: |
          set -euo pipefail
          mkdir -p proof
          python3 controller/.github/ci/issue1948-sdk-injection.py identities --config controller/.github/ci/issue1948-sdk-injection-inputs.json 2>&1 | tee proof/gate-stage-identities.log
      - uses: actions/download-artifact@v4
        with:
          path: shards
      - name: Verify complete source, titles, addon and denominator
        run: |
          set -euo pipefail
          node controller/.github/ci/v8-split/gate.mjs controller/.github/ci/v8-split/plan.json shards wallet "$GITHUB_SHA" canonical proof > verified.json
      - name: Enforce unchanged merged coverage threshold
        env:
          NODE_PATH: \u0024{{ github.workspace }}/replay/node_modules
        run: |
          set -euo pipefail
          mapfile -t maps < <(node -e 'const x=require("./verified.json"); for (const p of x.coverageMaps) console.log(p)')
          test "\u0024{#maps[@]}" -gt 1
          node wallet/scripts/merge-jest-coverage.mjs "\u0024{maps[@]}"
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: v8-merged-coverage-proof
          path: |
            verified.json
            proof/
            wallet/coverage/
          if-no-files-found: warn
`;
  writeFileSync(join(bundle, paths[0]), workflow);
  const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  const manifest = { source: plan.source, source_tree: plan.tree, sdk_source: plan.sdk, plan_sha256: plan.planSha256, proof_paths: paths, files: Object.fromEntries(paths.map(path => [path, sha(join(bundle, path))])), purpose: 'Exhaustive V8 coverage with pinned addon and original 95 percent merge gate', dispatched: false };
  writeFileSync(join(bundle, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ bundle, manifestSha256: sha(join(bundle, 'manifest.json')), dispatched: false }));
} finally { rmSync(temp, { recursive: true, force: true }); }

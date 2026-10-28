// Deterministic signed baseline producer workflow.
export function renderBaselineWorkflow(source) {
  if (!/^[0-9a-f]{40}$/.test(source)) throw new Error('Invalid source');
  return `name: Issue1948 V8 source-bound baseline inventory
on:
  push:
    branches: ['ci/1948-sdk-injection-*']
permissions:
  contents: read
  actions: read
jobs:
  inventory:
    runs-on: ubuntu-24.04
    timeout-minutes: 90
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
          ref: ${source}
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
`).join('') + `      - name: Verify and stage exact producer addon
        run: |
          set -euo pipefail
          cd replay
          node ../controller/.github/ci/v8-split/fetch-addon.cjs ../controller/.github/ci/v8-split/addon-plan.json ../proof
      - name: Record complete source-bound inventory
        run: |
          set -euo pipefail
          cd replay
          node ../controller/.github/ci/v8-split/baseline-runner.cjs ../proof ../capsule ../controller/.github/ci/v8-split/addon-plan.json
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: v8-baseline-logs
          path: proof/
          if-no-files-found: error
      - uses: actions/upload-artifact@v4
        if: success()
        with:
          name: v8-baseline-capsule
          path: capsule/
          if-no-files-found: error
`;
}

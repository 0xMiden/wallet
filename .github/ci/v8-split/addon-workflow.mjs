// Deterministic producer workflow. This renderer never pushes or dispatches.
export function renderAddonWorkflow({ source, sdk, sdkTree, rustSdk, cargoLockSha256 }) {
  if (![source, sdk, sdkTree, rustSdk].every(x => /^[0-9a-f]{40}$/.test(x)) || !/^[0-9a-f]{64}$/.test(cargoLockSha256)) throw new Error('Invalid producer source binding');
  return `name: Issue1948 exact SDK production Node addon
on:
  push:
    branches: ['ci/1948-sdk-injection-*']
permissions:
  contents: read
jobs:
  addon:
    runs-on: ubuntu-24.04
    timeout-minutes: 90
    steps:
      - uses: actions/checkout@v4
        with:
          path: controller
          fetch-depth: 2
          persist-credentials: false
      - uses: actions/checkout@v4
        with:
          repository: 0xMiden/web-sdk
          ref: ${sdk}
          path: sdk
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install pinned Rust toolchain
        run: rustup toolchain install nightly-2026-08-06 --profile minimal
      - name: Build locked production-feature addon
        run: |
          set -euo pipefail
          node controller/.github/ci/v8-split/addon-builder.cjs sdk addon addon-proof ${source} ${sdk} ${sdkTree} ${rustSdk} ${cargoLockSha256}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: v8-addon-producer-logs
          path: addon-proof/
          if-no-files-found: warn
      - uses: actions/upload-artifact@v4
        if: success()
        with:
          name: v8-addon-exact-binary
          path: addon/
          if-no-files-found: error
`;
}

# Genuine native recovery codec proof

Goal: characterize generated NoteFile codec and awaited native refusal on the exact pinned SDK. This test-only packet does not exercise wallet factories, Guardian authorization, restored proof validity or successful adoption.

The approved recipe is `docs/superpowers/controller-native-recovery-codec-proof-recipe.md`. Its source SHA256 is `4fc1dfd6986e07bc37ffd539646ec9eea89ebaf027d1adceb14dbe37416ef6e4`.

- [x] Write exactly 16 cases: four scenarios across ST/MT and useWorker false/true.
- [x] Reuse genuine generated SDK constructors and disposable MockChain bootstrap without asset interception or callback replacement.
- [x] Copy only native candidate primitives before awaiting the independent decision; observe IndexedDB outside the callback.
- [x] Preserve encoded bytes through decode/encode, nondefault hints, committed fields, and exact-receipt alternate refusal controls.
- [ ] Root verifies the canonical artifact digest, all 42 assets and fixture hashes before execution, retaining manifests.
- [ ] Root executes once in CI with 15-minute functional timeout and 25-minute job cap, then verifies unchanged assets and exact 16 retry0 outcomes.

CI assembly supplies `SDK_CODEC_DIST_ROOT` pointing to the unchanged assembled dist root and explicit `SDK_CODEC_RESULT_FILE` and `SDK_CODEC_OUTPUT_DIR`. Use the frozen wallet Playwright dependency and Chromium installation. Run `yarn playwright test --config playwright/proofs/storage-recovery-codec/playwright.config.ts --retries=0 --workers=2`. The nested package preserves ESM semantics under Node 22. No SDK build or install is required.

The first CI result is retained even if setup or behavior fails. Acceptance requires 16 passed, 0 failed/skipped/flaky/unexpected and one retry0 result per case. The test catches browser-side exceptions and exports only fixed phase IDs, booleans and SHA256 values. Traces, screenshots, videos and raw console forwarding are disabled. No local test, type check, lint, browser, install or compile was executed while preparing this packet.

Expected mutation checks: dropping a hint breaks the exact hint checks; changing the encoder breaks candidate/prepared equality; adopting before receipt breaks held/no-row checks; swallowing refusal breaks native refusal; accepting ID/details equivalence breaks alternate comparisons; accepting empty encoded input breaks missing-file refusal. These predictions are source analysis, not executed mutation evidence.

Getter handles are disposed outside the callback; candidate metadata has no invented attachments getter. Canonical bytes bind its metadata and supplied mock proof. The mock proof is not canonical network authentication. Account/client seeds are generated ephemerally inside the disposable browser and never exported.

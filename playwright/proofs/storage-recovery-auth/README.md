# Guarded raw SDK recovery availability prerequisite

Four Chromium cases exercise ST/MT with useWorker false/true. Every case builds an actual guarded recipient with the wallet's threshold shape, mints a private note through a local faucet on the genuine MockChain, proves/syncs its block and verifies the real note Merkle proof against the stable synced header root.

Sequential disposable SDK lifetimes then characterize ordinary Expected import, future-hint Expected import and canonical full-file rebuild. Ordinary pre-sync authentication and future-hint post-sync authentication are explicit boolean observations. Future-hint import must initially remain Expected and unauthenticated; either later outcome is classified honestly, and every authenticated result must pass the actual proof checks. No synthetic inclusion proof or fake status is used.

Only databases created by this fixture in its initially empty Playwright storage context are destroyed. Each high-level client drains before its supported async disposal releases the store connection. Account, chain, note and key material stays in disposable browser memory; exported receipts contain only fixed phase IDs, booleans and SHA256 digests. No console forwarding, trace, screenshot or video attachments are enabled.

This is not wallet Vault recovery, Guardian service registration, Guardian signatures or production acceptance. The guarded recipient remains undeployed at nonce0 and receives a note; it sends no transaction. A local mock faucet is test infrastructure, not an additional wallet account.

Root provides the exact unchanged42 assets in SDK_AUTH_DIST_ROOT, explicit SDK_AUTH_RESULT_FILE and SDK_AUTH_OUTPUT_DIR, frozen wallet Playwright/Chromium and Node22. Run once in CI: yarn playwright test --config playwright/proofs/storage-recovery-auth/playwright.config.ts --retries=0 --workers=2. Require4passed,0failed/skipped/flaky/unexpected and exactly one retry0 result per case. Preserve first setup/behavior failure, hashes before/after and bounded15-minute functional/25-minute job limits. No test, build, browser, compile, lint or install was executed locally during preparation.

Source/API plan: docs/superpowers/fixture-compatibility-auth-plan.md. If actual SDK construction, anchor capture, store release or import behavior refuses, retain the exact safe phase and stop; do not replace an API, forge state or relax a matcher to make the prerequisite pass.

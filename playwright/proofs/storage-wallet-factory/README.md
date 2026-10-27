# Actual wallet factory browser prerequisite

Exactly six ST Chromium cases import the actual wallet MidenClientInterface, native policy/acquisition, storage health and lock modules. The only host replacement is the existing webextension-polyfill mock explicitly used by the mobile config. SDK, IndexedDB, health, retention and wallet factories remain genuine. There are no domain stubs or product hooks.

Root injects the accepted three exact SDK/React/plugin tarballs through the established effective-lock generation and fresh frozen replay, preserving postinstall, the precise four Node removals, installed payload hashes and one physical SDK directory. The test-only config uses the real midenVitePlugin with RPC proxy disabled, ST lazy resolution, Dexie/React dedupe, real worker/WASM bundling and the shared classic asset helper. Its source aliases only select that exact package entry and existing wallet path aliases; they do not replace any factory.

Build both variants in CI, from wallet root:

- WALLET_FACTORY_VARIANT=mock yarn vite build --config playwright/proofs/storage-wallet-factory/vite.config.mts
- WALLET_FACTORY_VARIANT=normal yarn vite build --config playwright/proofs/storage-wallet-factory/vite.config.mts

WALLET_FACTORY_BUILD_ROOT may point to a disposable CI directory. Supply WALLET_FACTORY_RESULT_FILE and WALLET_FACTORY_OUTPUT_DIR, then run once: yarn playwright test --config playwright/proofs/storage-wallet-factory/playwright.config.ts --retries=0 --workers=2. Require exactly6passed,0failed/skipped/flaky/unexpected and one retry0 result per case. Retain the first failure, with15-minute functional/25-minute job bounds and immediate30-second monitoring.

Normal construction is explicitly a supported-API preseed experiment. A genuine raw MockChain store is exported after release, then imported unchanged into the native-resolved normal namespace. No rows or genesis bytes are fabricated. The actual normal constructor and public getConsumableNotes reader path must work without any RPC request. An unsupported export/import namespace or schema behavior fails its preparation phase. No substitute client or unbounded genesis service is provided.

Each test has a fresh disposable browser context. All non-loopback and non-asset requests are blocked and fail the case. A passive native IndexedDB transaction wrapper forwards the original receiver/arguments/result without altering transactions. Real writes, when observed, must request and use strict durability. Mock construction and bulk imports require actual writes; export and preseeded normal/read-only opens report their real write presence rather than claiming a write happened.

Results contain only fixed phases, boolean checks, transaction counts and SHA256 values. No raw dump/note/account/key/error data leaves browser memory. Trace, screenshots, videos and console forwarding are disabled. Keep original42 input hashes before/after separate from Vite-emitted asset hashes and source/effective-lock receipts.

This packet does not establish MT, normal workers, private recovery replay, Guardian service authorization, late-abort behavior, actual wallet UI, full coverage or production acceptance. Mock construction forces main-thread execution even when useWorker:true is requested; the test observes that actual inner client. Source plan: docs/superpowers/fixture-compatibility-wallet-factory-plan.md. No local build/test/browser/type/lint/install was executed while preparing this packet.

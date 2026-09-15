# In-wallet Update Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task by task. Follow `superpowers:test-driven-development` for every production behavior, use `superpowers:verification-before-completion` before every commit, and run `review-council:rev` after the implementation is locally green.

**Goal:** Show a non-blocking update card only when the installation's platform distribution channel confirms that a newer build is available, with Miden-owned metadata limited to safe presentation text.

**Architecture:** A platform-neutral controller joins an authoritative `UpdateAvailabilityAdapter` result with a strictly validated, exact-version presentation manifest. Chrome availability is captured in the extension service worker, and Android and iOS use small Capacitor plugins. Desktop returns `unknown` until a real Tauri updater signing pipeline, public key, and endpoint contract exist. One provider applies foreground caching and dismissal rules, then renders a shared accessible card on initialized wallet surfaces. URLs, update modes, and actions remain compiled into each client.

**Tech stack:** React, TypeScript, Chrome Extension APIs, Capacitor Android/iOS plugins, Google Play Core, Swift URLSession, Jest, native unit tests, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-15-update-notification-design.md`

## Global Constraints

- Availability must come from the installation's platform distribution channel, never the presentation manifest.
- Remote metadata is bounded plain text and visual emphasis only. It cannot supply URLs, commands, labels, update modes, or blocking behavior.
- Development, sideloaded, unsupported, and unverifiable builds return `unknown` and remain silent.
- Desktop remains unsupported until a real Tauri signing pipeline, public key source, and signed-update endpoint are separately defined.
- Every behavior change follows a witnessed RED, GREEN, and refactor cycle.
- Every user-facing string is localized through the repository i18n system.

---

## Task 1: Define and validate the presentation manifest

**Files:**

- Create: `updates/manifest.json`
- Create: `src/lib/update/manifest.ts`
- Create: `src/lib/update/manifest.test.ts`
- Create: `scripts/validate-update-manifest.mjs`
- Create: `scripts/validate-update-manifest.test.ts`
- Modify: `package.json`

1. Measure the existing comment ratio for TypeScript, Java, Swift, and Rust before writing implementation files. Match each language's local norm and retain only security boundaries and native API traps.
2. Add failing validator tests for schema version, append-only releases, strict SemVer, unique versions, known urgency, exact per-platform versions, positive Android version codes, unknown fields, URLs, HTML-like markup, controls, and summary length bounds.
3. Add failing selection tests for exact platform plus available-version matching, staged stores exposing different versions, malformed entries ignored independently, stale metadata, and no matching metadata.
4. Implement an `unknown` parser that never trusts imported JSON types. Render summaries only as text. Do not accept actions, URLs, labels, commands, update modes, or blocking behavior from the file.
5. Seed the catalog with its schema and only releases that are verified as published on their listed platform. Do not invent availability to make the first card render.
6. Wire a deterministic validation script and focused tests. Commit after RED becomes GREEN.

## Task 2: Build the adapter contract, orchestration, cache, and dismissal state

**Files:**

- Create: `src/lib/update/types.ts`
- Create: `src/lib/update/controller.ts`
- Create: `src/lib/update/controller.test.ts`
- Create: `src/lib/update/storage.ts`
- Create: `src/lib/update/storage.test.ts`
- Modify: `src/lib/feature-flags.ts`
- Modify: `src/lib/feature-flags.test.ts`
- Modify: `src/react-app.d.ts`
- Modify: `vite.extension.config.ts`
- Modify: `vite.background.config.ts`
- Modify: `vite.contentScripts.config.ts`
- Modify: `vite.mobile.config.ts`
- Modify: `vite.desktop.config.ts`
- Modify only if needed: `src/lib/platform/storage-adapter.ts`
- Modify only if needed: `src/lib/platform/storage-adapter.test.ts`

1. Add failing tests for `available`, `none`, and `unknown`, including the rule that API or network failure is `unknown`, never `none`.
2. Cover semantic version comparison, a platform returning the current or older version, exact metadata joining, generic fallback after authoritative availability, and unsupported/development/sideloaded builds remaining silent.
3. Add failing cache tests for one in-flight request, six-hour successful cache, foreground refresh, bounded exponential retry after `unknown`, stale async results after platform/session change, and timeout without delaying app boot.
4. Add failing persistence tests for dismissal keyed by platform and available version, later-version reappearance, malformed storage, and no device, account, or wallet data in stored state.
5. Add `MIDEN_UPDATE_NOTIFICATIONS` to every bundle that can import the controller, its process-env type, and the define-parity tests. Production code must use one feature-flag helper rather than reading the raw environment in multiple components.
6. Implement a dependency-injected controller. Keep adapter action functions local and non-serializable; persist only normalized non-sensitive availability and dismissal data.
7. Re-run focused suites and commit.

## Task 3: Implement Chrome's service-worker availability adapter

**Files:**

- Create: `src/lib/update/chrome.ts`
- Create: `src/lib/update/chrome.test.ts`
- Modify: `src/background.ts`
- Modify: `src/background.test.ts`
- Modify as needed: `src/background-entry.ts`
- Modify: `src/background-entry.test.ts`

1. Add failing tests proving `runtime.onUpdateAvailable` persists an available result from the service worker and notifies open surfaces.
2. Cover service-worker restart, duplicate events, stale stored versions, unpacked/development detection, missing APIs, extension disable/update errors, and storage failures.
3. Add tests proving `runtime.requestUpdateCheck()` is called at most once per candidate manifest version and only as a hint. Do not show availability until Chrome itself reports an update ready.
4. Compile `runtime.reload()` as the only Chrome action. Invoke it only from a card click after authoritative availability, never from remote metadata or background code.
5. Keep listener registration idempotent across service-worker module reloads. Re-run extension background suites and commit.

## Task 4: Implement Android Play Core availability and flexible update flow

**Files:**

- Create: `android/app/src/main/java/com/miden/wallet/UpdateAvailabilityPlugin.java`
- Create: `android/app/src/test/java/com/miden/wallet/UpdateAvailabilityPluginTest.java`
- Modify: `android/app/src/main/java/com/miden/wallet/MainActivity.java`
- Modify: `android/app/build.gradle`
- Create: `src/lib/update/android.ts`
- Create: `src/lib/update/android.test.ts`
- Modify as needed: `capacitor.config.ts`

1. Add failing native tests for Play Core no-update, available flexible update, unavailable update mode, developer-triggered update in progress, cancellation, download progress, completion, install request, exceptions, and sideloaded builds.
2. Expose a minimal Capacitor API that returns installed version, available version code/version label when trustworthy, allowed update mode, and update state. Never accept a URL or mode from JavaScript.
3. Start only Play Core's flexible flow after a user gesture. Complete and restart only after Play reports the update downloaded. Compile the official Play listing fallback into the native or TypeScript adapter for the authoritative-available but unstartable case.
4. Add TypeScript contract tests for native response validation, foreground single-flight behavior, progress mapping, cancellation, retryable action failure, and generic metadata fallback.
5. Run JVM tests, focused Jest suites, Gradle checks, and an affected Android build. Verify the produced APK or bundle exists and scan full output for errors before committing.

## Task 5: Implement iOS App Store availability and compiled handoff

**Files:**

- Create: `ios/App/App/UpdateAvailabilityPlugin.swift`
- Create: `ios/App/AppTests/UpdateAvailabilityPluginTests.swift`
- Modify as needed: `ios/App/App/AppDelegate.swift`
- Modify: `ios/App/App/Info.plist`
- Modify: `ios/App/App.xcodeproj/project.pbxproj`
- Create: `src/lib/update/ios.ts`
- Create: `src/lib/update/ios.test.ts`

1. Add failing Swift tests for installed version mapping, a newer App Store response, equal/older responses, malformed JSON, unexpected bundle id, storefront/network failure, timeout, cancellation, and a non-App-Store receipt/sideloaded build.
2. Query Apple's product metadata for the compiled `com.miden.bread` identifier. Treat only a strictly greater store version for that exact app as available. Return `unknown` for transport or validation failure.
3. Compile the App Store product URL into the app. Open it only from an explicit card action. The manifest must never supply or replace it.
4. Add TypeScript adapter tests for bridge response validation, semantic comparison, foreground caching, action failure, and unsupported web execution.
5. Run Swift tests, focused Jest suites, an iOS simulator build, full error scan, and expected `.app` artifact check before committing.

## Task 6: Preserve the unsupported desktop boundary

**Files:**

- Create: `src/lib/update/desktop.ts`
- Create: `src/lib/update/desktop.test.ts`

1. Add a failing TypeScript test proving desktop availability is `unknown` and exposes no update action.
2. Implement the explicit unsupported adapter without adding the Tauri updater plugin, key material, endpoints, permissions, or release artifacts.
3. Add a regression test proving remote presentation metadata cannot make the desktop adapter report an available update.
4. Run the focused Jest suite and desktop TypeScript build before committing.

## Task 7: Add the provider and accessible update card

**Files:**

- Create: `src/app/providers/UpdateNotificationProvider.tsx`
- Create: `src/app/providers/UpdateNotificationProvider.test.tsx`
- Create: `src/components/UpdateNotificationCard.tsx`
- Create: `src/components/UpdateNotificationCard.test.tsx`
- Modify the shared initialized application shell discovered from current entry-point composition.
- Modify: `public/_locales/en/en.json`
- Regenerate: `public/_locales/*/messages.json`

1. Add failing React tests for initialized wallet gating and explicit exclusion from onboarding, recovery, and the hot-key rotation gate.
2. Cover generic fallback, available version, plain-text remote summary, normal/important/critical visual emphasis, dismiss, later-version reappearance, action progress, action failure with retry, reduced motion, keyboard reachability, and screen-reader names.
3. Build one non-blocking card. Remote urgency may alter emphasis only; it cannot block input, hide dismissal, auto-open a store, install, reload, or force restart.
4. Mount one provider around the normal shared app surface across extension, mobile, and desktop. Ensure popup lifetimes consume Chrome's persisted service-worker result rather than owning the listener.
5. Add E2E-only adapter injection behind the existing test-build boundary. Production builds must not expose a global that can forge update availability.
6. Regenerate locales, run provider/card/i18n suites, and commit.

## Task 8: Gate release metadata and platform packaging

**Files:**

- Modify: `.github/workflows/release-notes.yml`
- Modify relevant extension, Android, iOS, and desktop release workflows.
- Modify: `scripts/validate-update-manifest.mjs`
- Modify release documentation only where the repository already documents operator steps.

1. Add failing workflow/script tests showing a release cannot claim a supported platform version without an exact valid manifest entry.
2. Verify every build receives its version from the same declared release version while Android's version code remains monotonic.
3. Keep the feature flag off for a platform until its adapter and distribution sandbox have been verified. Desktop and other unsupported platforms remain silent without sharing another platform's signal.
4. Preserve append-only catalog history so staged store rollouts can map different authoritative available versions at the same time.
5. Run workflow lint, manifest validation, packaging dry runs that do not publish, and commit.

## Task 9: End-to-end, visual, full verification, Council, and delivery

**Files:**

- Create: `playwright/e2e/tests/update-notification.spec.ts`
- Modify platform E2E harnesses only where needed for the test adapter.

1. Write failing deterministic E2E tests for extension, Android, and iOS supported surfaces. Inject authoritative availability through the E2E-only adapter, then verify safe metadata joining and the locally compiled action dispatch. Verify desktop remains silent.
2. Cover `unknown` silence, generic fallback, dismiss persistence, later-version reappearance, action failure/retry, and absence during onboarding/recovery.
3. Record exact verification commands and outcomes in the Review Council report and PR description without editing shared task-tracking files.
4. Run `git diff --check`, forbidden-dash and attribution scans, dependency integrity, TypeScript, ESLint, Prettier, i18n lint, locale parity, manifest validation, all affected Jest/native/Rust suites, and E2E with retries disabled.
5. Read the coverage configuration, run full coverage serially, and verify statements, branches, functions, and lines each meet the configured 95% global threshold before pushing.
6. Build extension, Android, iOS, and desktop release surfaces. Search every complete log case-insensitively for errors and verify each expected manifest, app, and package artifact. Desktop must compile without updater configuration or artifacts.
7. Capture fresh desktop and mobile screenshots at supported widths, safe areas, and orientations. Resize each to at most 1800 px on the long side before opening it. Grade every approved criterion in a literal pass/fail table against rendered pixels.
8. Run `review-council:rev` explicitly with gpt-5.6-sol max, gpt-5.6-terra max, Opus, and Sonnet. Freeze every seat prompt before launch, apply every actionable finding in new commits, and rerun affected gates.
9. Push the reviewed green tree and open a concise non-draft PR against `main` with a standalone `Closes #821` and focused `Reviewers:` line.
10. Use the autopilot loop for comments, conflicts, and CI. Re-run Council after substantive code changes, wait for all required and affected checks to pass, then admin squash merge.
11. Verify the merged PR, squash commit on `main`, and issue #821 closed through the PR link.

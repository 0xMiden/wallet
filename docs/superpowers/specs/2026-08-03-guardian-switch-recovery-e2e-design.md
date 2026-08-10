# Guardian Switch + Recovery E2E Harness — Design

- **Date:** 2026-08-03
- **Status:** Approved (pending spec review)
- **Worktree / branch:** `/Users/celrisen/miden/miden-wallet-guardian-e2e` @ `feat/guardian-switch-recovery-e2e` (off `origin/main` `a7995078f`)

## 1. Goal

Give guardian **switching** and guardian-account **recovery** the end-to-end coverage they currently lack, and make both **flawless under stress**. Today's guardian E2E is create + consume + send only (`guardian-send-consume.spec.ts` / `.ios.spec.ts`); there is **zero** coverage for switch-guardian, replace-hot-key / device-key rotation, recover-from-seed, or guardian-drift.

Most guardian switch/recovery failures are intermittent ("usually works"), so the suite must exercise the failure surface **deliberately**: lifecycle interruption (kill + reopen mid-flight), concurrency, repetition, and injected guardian faults — not rely on natural timing to surface races.

## 2. Guiding principle

**The harness is authoritative.** Every scenario encodes the *required* behavior: a switch completes and the wallet is fully usable on the new guardian; recovery is deterministic, escapable, and never hangs. Where a scenario goes red on `main` because of a real **wallet** bug, we **fix the wallet** at root cause so the harness is 100% green. There is **no `test.fixme` quarantine**.

**Scope boundary — wallet vs guardian server.** The wallet cannot fix guardian-**server** behavior. The cross-guardian split-brain / `released_at` non-release class is `OpenZeppelin/guardian#369` (server-side; the release-on-switch trigger is push-only and has no reconciliation fallback in guardian `v0.16.0`). Switch-correctness scenarios therefore assert only **wallet-observable** outcomes — the wallet routes to and co-signs only with the **new** guardian, is usable, and never hangs. Any residual server-side gap is *referenced* to #369, never "fixed" in the wallet or asserted as a wallet requirement.

## 3. Scope / non-goals

**In scope**
- New Chrome + iOS specs: guardian switch (happy + stress) and guardian recovery (real-UI journey + stress).
- Two-guardian hermetic stack; Playwright-routing guardian-fault injection (Chrome).
- New cross-platform POM primitives.
- **Wallet product fixes** required to turn every red scenario green (root-cause, not workaround).

**Non-goals**
- Guardian-server fixes (#369) — asserted only to the wallet boundary (§2).
- Delegated remote-prover fault stress — localhost proving is in-WASM, so there is no prover HTTP to fault. Documented gap; delegated-prover flakiness is not reproduced by the hermetic core.
- Android CI wiring (harness dir exists but is not CI-wired) — out of scope.

## 4. Environment — two hermetic guardians

- `playwright/e2e/local-stack/docker-compose.local.yml`: add `guardian-b` + `guardian-b-postgres` on distinct ports (**HTTP `:3001`, gRPC `:50053`, PG `:5433`**), a distinct keypair, under a new compose profile `guardian-switch`. The existing guardian is "A" (`:3000` / `:50051`).
- `src/lib/miden-chain/constants.ts` `GUARDIAN_OPTIONS`: add a **localnet-only** second option `OpenZeppelin B → http://localhost:3001`, **gated on `MIDEN_E2E_TEST`**, so the real `RotateGuardian` picker (`ChooseGuardianScreen`) can select a genuine second guardian without a production-visible change.
- New workflow `.github/workflows/pr-e2e-guardian-lifecycle.yml`: bring up node + prover + note-transport + **both** guardians → build localnet extension → run the guardian-lifecycle suite; wait on both guardians' HTTP health before running.
- **Plan-time de-risk #1:** verify the OZ guardian image (`ghcr.io/openzeppelin/guardian:v0.15.0`) accepts port / DB / keypair configuration for a second instance under `network_mode: host`.

## 5. Fault injection (Chrome only)

- Playwright `context.route` with service workers allowed (the two-wallet fixture already instruments SW/page/worker fetch) intercepts guardian HTTP by path — `pubkey`, `register`, `delta` (push), `proposals`, `sign` — and by target guardian (A vs B).
- Per-test policy: `status:500` | `abort` | `delay(ms)` | `failFirstN(n)` (fail `n` times, then pass through). Armed via `armGuardianFault(policy)`, cleared via `clearFaults()`.
- No standalone proxy process; endpoints are unchanged (routing sits in the browser context).
- Rationale: on localhost, proving is local/in-WASM, so the only network surface worth faulting is the guardian HTTP; routing is the least-infra way to fault it deterministically.

## 6. POM primitives

Added to `playwright/e2e/helpers/wallet-page.ts` (Chrome) and `playwright/e2e/ios/helpers/ios-wallet-page.ts` (iOS) unless noted:

- `switchGuardian(newEndpoint)` — drive Settings → `RotateGuardian` → `RotateGuardianReview` → confirm → await completion (`generating-transaction` → Completed).
- `recoverGuardianFromSeed(seed, { viaUI })` — `viaUI:true` walks the real recovery screens (seed word-grid → guardian-probe / `ImportRecoveryMethod` → `HotKeyRotationGate`); `viaUI:false` uses the onboarding bypass (`?walletType=guardian&seed=…`).
- `completeHotKeyRotation()` — observe `HotKeyRotationGate` to its cleared (dismissed) state; expose the gate's terminal-failure surface for assertions.
- `assertGuardianAuth(pk, expected)` — via the existing cross-platform `getGuardianAuthInfo` (signer set, `update_guardian` threshold, active guardian commitment).
- Chrome-only: `armGuardianFault(policy)`, `clearFaults()`.
- Re-add the native-navbar test hook (`__TEST_TRIGGER_NAVBAR_ACTION__`, currently absent from `src/`) **only if** the mobile switch/recovery UI depends on a native CTA — verify at plan time; current iOS specs click React `[data-testid]` buttons.

## 7. Scenario matrix

| Area | Scenario | Chrome | iOS |
|---|---|:--:|:--:|
| Switch | Happy: create on A → fund → baseline op → switch A→B (real UI) → assert on-chain guardian = B + per-account endpoint persisted → **send/consume on B** → **close/reopen still on B + operable** | ✅ | ✅ |
| Switch | Cross-guardian correctness (wallet-side): after switch the wallet routes to / co-signs only with B; A can no longer co-sign a new tx (server `released_at` out of scope — §2) | ✅ | – |
| Switch stress | Kill mid-switch (during `finalizeGuardianSwitch` / register) → reopen resumes to a consistent state (never stuck) | ✅ | ✅ (kill/reopen) |
| Switch stress | Guardian fault on B `register` (`failFirstN`) → retry/backoff recovers, switch completes | ✅ | – |
| Switch stress | Best-effort push fault on A → switch still completes (push is best-effort, must not block) | ✅ | – |
| Switch stress | A→B→A repeat → consistent, no drift; concurrent send + switch → serialized (`withGuardianAccountLock`), both end consistent | ✅ | – |
| Recovery | Real UI journey: seed word-grid (case-insensitive / paste / iOS keyboard) → probe screen (detected / not-detected / escape) → rotation gate completes (no perpetual loop) → assert auth = [new-hot, cold] / threshold 2 → usable (send/consume) → close/reopen | ✅ | ✅ |
| Recovery stress | Kill mid-rotation → gate resumes + completes (escapable, no hang); guardian fault on register/rotation → retry recovers; pending-conflict / apply-after-submit → requeue recovers | ✅ | – |

## 8. Platform split

- **Chrome** = full matrix incl. fault injection and all stress dimensions.
- **iOS** = happy-path switch, real-UI recovery journey, kill + reopen. No iOS fault injection (per decision).

## 9. Anticipated wallet fixes

Each is a **hypothesis** — every scenario is first run against `main`; only genuine failures are fixed, at root cause. Sizes are unknown until the red is observed and are agreed at spec review. (Tracker refs are the product-feedback items the user supplied; note their numbers do **not** map to `0xMiden/wallet` issue numbers, so they are named descriptively here.)

- **Perpetual rotation loading** → `HotKeyRotationGate` must always reach a terminal state (completed, or a diagnosable + escapable failure); reliably requeue orphaned `replace-hot-key` rows; surface retry/escape affordance.
- **Seed word-grid input** → case-insensitive word validation + paste normalization in `ImportSeedPhrase`.
- **iOS keyboard artifacts** → strip auto-capitalization / autocorrect artifacts + trailing spaces; Return advances to next field.
- **Recovery verification grid** → assert selectable + advanceable; copy/labeling fixes only if the test proves them needed.
- **Post-validation submit failure** → distinguish phrase-validation success from later infra/mempool failure; requeue/retry surfacing (partly present in `transaction/index.ts` — verify and close gaps).
- **Provider discovery** → probe-driven detection exists (`useGuardianProbe` / `discoverGuardianForSeed`); assert it end-to-end and fix detected / not-detected / escape gaps.
- **Switch resume-after-kill / retry-on-fault** → confirm `finalizeGuardianSwitch` register-retry/backoff + orphan requeue recover; fix if not.

## 10. Files + CI

- Specs: `playwright/e2e/tests/guardian-switch.spec.ts`, `guardian-recovery.spec.ts`, `guardian-switch-stress.spec.ts`, `guardian-recovery-stress.spec.ts`; iOS mirrors under `playwright/e2e/ios/tests/guardian-*.ios.spec.ts` (subset per §8).
- POM: additions to `helpers/wallet-page.ts` + `ios/helpers/ios-wallet-page.ts`.
- Fault layer: `playwright/e2e/harness/guardian-fault.ts`.
- Infra: `docker-compose.local.yml` (2nd guardian), `constants.ts` (2nd localnet option), `.github/workflows/pr-e2e-guardian-lifecycle.yml`.
- Picked up by the existing `guardian-*` config pattern (`playwright.guardian.config.ts` / `playwright.ios.guardian.config.ts`); heavy stress specs run in the dedicated lifecycle workflow.

## 11. Determinism / flake strategy

- Deterministic hermetic stack (pinned image tags, local proving, injected faults instead of relying on real flakiness).
- `retries: 0` — a flake is a bug to fix, not to paper over.
- Respect `withGuardianAccountLock` / Web Locks in concurrency scenarios; timeouts sized to local proving.
- Kill/reopen via service-worker respawn (Chrome) and app terminate/relaunch (iOS).

## 12. Open risks / plan-time de-risks

1. Second guardian container config (§4 de-risk #1) — do first.
2. Native-navbar test hook for mobile CTAs (§6) — verify before iOS specs.
3. Whether `RotateGuardian` accepts a custom URL (fallback if the second picker option proves awkward).
4. Fix appetite for the harder red scenarios (rotation loop, post-validation submit) — agreed at spec review, revisited when the red is observed.

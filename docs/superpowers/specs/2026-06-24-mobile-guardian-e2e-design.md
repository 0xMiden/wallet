# Mobile (iOS) Guardian E2E — verify-first design

**Date:** 2026-06-24
**Branch:** `wiktor/mobile-guardian-e2e`
**Status:** approved design, pre-implementation

## Problem / goal

The mobile (iOS) E2E suite does not exercise Guardian at all — `IosWalletPage`
only has `createNewWallet` (no recovery option), and the import test
deliberately picks a public account "so we don't need a guardian backend".
Chrome has a full guardian path (`createGuardianWallet` helper +
`guardian-send-consume.spec.ts` + `playwright.guardian.config.ts` + CI gate).

Guardian has **never run on mobile** (Capacitor/WKWebView, single-threaded SDK,
delegated proving). The goal is **verify-first**: build a mobile guardian
create→fund→consume→send E2E mirroring chrome's, and run it to find out whether
guardian works on mobile. CI gating is explicitly deferred.

## Definition of done

`guardian-send-consume.ios.spec.ts` runs against devnet + the hosted devnet
guardian and either (a) passes end-to-end, or (b) fails with a clear,
attributable reason that tells us what's broken about guardian-on-mobile.

## Key facts grounding the design

- The **create** flow's `select-recovery-method` screen only *picks* Guardian vs
  private — there is **no guardian-URL input** there (URL entry exists only in
  the import flow and Settings). So a created guardian wallet uses the **network
  default** endpoint. On devnet that default is `guardian-stg.openzeppelin.com`,
  which is verified working with the 0.15 client. → the helper does **not** need
  to inject a URL (avoids the async Capacitor-Preferences-over-CDP problem).
- The iOS fixture `two-simulators` already provides two wallets (A, B) + a
  `midenCli`, mirroring chrome's `two-wallets` — the same spec shape ports over.
- The iOS CDP bridge `eval` is synchronous (`execute_script`); the helper must
  rely on UI-driven steps + selector polling, not async in-page promises.

## Components

1. **`IosWalletPage.createGuardianWallet(password?)`** — mirrors
   `createNewWallet`, but after tapping "Create a new wallet" it selects the
   **Guardian** option on the `select-recovery-method` screen, then proceeds
   through seed-phrase → verify → password → Ready. Returns `{ address, seedPhrase }`.
   Uses the devnet default guardian endpoint (no URL injection).

2. **`playwright/e2e/ios/tests/guardian-send-consume.ios.spec.ts`** — ports the
   chrome `guardian-send-consume` spec onto the `two-simulators` fixture:
   wallet A guardian-backed, B standard; `midenCli` deploys faucet + funds A; A
   consumes its notes; A sends to B; assert B balance > 0. Guardian-width waits
   (≥180s) for the extra co-sign HTTP round-trips, matching the chrome spec.

3. **`playwright.ios.guardian.config.ts`** — extends `playwright.ios.config.ts`,
   `testMatch: '**/guardian-*.ios.spec.ts'`; the base ios config adds a
   `testIgnore` for guardian specs so the standard run is unaffected. New
   `test:e2e:mobile:guardian:run` script (mirrors `test:e2e:mobile:run`).

## Verification

Run **locally on this Mac** (single-tenant → avoids the shared-runner
CoreSimulator flakiness): `yarn test:e2e:mobile:build` once, boot the sim pair,
then `E2E_NETWORK=devnet yarn test:e2e:mobile:guardian:run`. Read the result;
iterate on any guardian-on-mobile bug it surfaces.

## Risks / unknowns

- **Guardian-on-mobile is unverified** — the run may fail and reveal a real bug
  (delegated-proving + guardian co-sign, or st-SDK guardian path). That is the
  intended discovery.
- Local run requires Xcode + iOS 26 simulators on this Mac (confirm before build).

## Out of scope (deferred)

- No `mobile-guardian` CI gate job; no testnet variant. Added only if the devnet
  verify passes.

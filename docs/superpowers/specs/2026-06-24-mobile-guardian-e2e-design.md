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

- **Mobile was already implicitly guardian.** iOS `createNewWallet` uses the
  `__test_skip_onboarding` bypass in `Welcome.tsx`, which skips the
  `select-recovery-method` screen and falls through to the component's default
  `walletType` — which is **`WalletType.Guardian`**. So every bypass-created
  iOS wallet was a guardian account (`vault.ts` branches on `WalletType.Guardian`).
- `WalletType.OffChain` is "fully private"; `WalletType.Guardian` is the
  guardian (co-signed) type. A created guardian wallet uses the **network
  default** guardian endpoint (devnet → `guardian-stg.openzeppelin.com`,
  verified working), so the helper needs **no URL injection**.
- The iOS fixture `two-simulators` provides two wallets (A, B) + `midenCli`,
  mirroring chrome's `two-wallets`. iOS divergence: `getBalance` doesn't count
  pending notes, so wallets claim explicitly before balance checks, and
  `claimAllNotes` takes the custom `faucetId` for synthetic-metadata injection.
- The iOS CDP bridge `eval` is synchronous (`execute_script`); the helper drives
  the bypass + polls conditions, not async in-page promises.

## Components

1. **`src/app/pages/Welcome.tsx`** — the `__test_skip_onboarding` bypass now
   reads a `walletType` query param and `setWalletType`: no param →
   **`OffChain` (private)**, `walletType=guardian` → `Guardian`. Gated entirely
   by the existing test bypass; production onboarding is unchanged. This flips
   the bypass default to private (so `createNewWallet` matches chrome and the
   non-guardian iOS specs no longer implicitly depend on a guardian backend) and
   enables explicit guardian creation.

2. **`IosWalletPage`** — `createNewWallet` → private (default); new
   **`createGuardianWallet(password?)`** → bypass with `walletType=guardian`.
   Both delegate to a private `createWalletViaBypass(password, recovery)` (wider
   Ready timeout for the guardian co-sign round-trips). Returns `{ address, seedPhrase }`.

3. **`playwright/e2e/ios/tests/guardian-send-consume.ios.spec.ts`** — ports the
   chrome `guardian-send-consume` spec onto `two-simulators`: A guardian, B
   private; `midenCli` deploys faucet + funds A; A consumes (claim); A sends to
   B; B claims; assert B balance > 0. ≥180s waits for co-sign round-trips.

4. **`playwright.ios.guardian.config.ts`** — extends `playwright.ios.config.ts`,
   `testMatch: '**/guardian-*.ios.spec.ts'`; the base ios config adds
   `testIgnore: '**/guardian-*.ios.spec.ts'` so the standard run is unaffected.
   New `test:e2e:mobile:guardian:run` script.

**Side effect (intended):** the existing iOS specs now exercise the **private**
path instead of being implicitly guardian — aligning mobile with chrome and
removing the basic tests' accidental guardian-backend dependency.

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

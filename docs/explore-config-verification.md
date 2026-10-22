# Explore configuration verification

Story: Home / Explore → network-specific wallet-explore catalog over HTTP →
validation and versioned cache → reader grouping into Finance / Arcade / Others →
explicit launch of the configured game URL through the existing dApp browser.
Published categories stay unchanged: tools + defi map to Finance, games to Arcade, and
nft + learn to Others. All aggregates these three UI groups.

## Run locally

With Node 22+, Yarn dependencies and Playwright Chromium installed:

```sh
yarn test:explore-config --config-repo /path/to/wallet-explore --policy-repo /path/to/wallet-config
```

Use an unchanged checkout of published `0xMiden/wallet-explore/main` as the
catalog source, plus a separate `0xMiden/wallet-config/main` checkout for startup
policy fixtures. Wallet-config #10 is not required. The command validates
wallet-explore's root `devnet.json` and `testnet.json` with `scripts/validate.mjs`,
serves those documents and `icons/` on a loopback HTTP server on an OS-assigned port,
builds the extension with the production UI and explicit E2E/mock flags, then
opens a temporary Chromium profile. It closes only its own server/browser.
It does not install over a user's browser or simulator, read wallet secrets,
fund an account, connect a dApp, sign or submit a transaction.

The harness writes screenshots, HTTP evidence, console diagnostics and a JSON
report to `../explore-harness-results/` (override with `EXPLORE_HARNESS_OUTPUT`).
The generated extension is a **test artifact**, not a release artifact: the E2E
introspection and mock-client flags are intentional. Rebuild without those flags
before using `dist/chrome_unpacked` as a normal wallet.

## Boundaries and assertions

- The server first serves the actual published wallet-explore catalogs and PNG files.
  Assertions verify an actual request, the exact four-tab order and network catalog
  rendering, not a mocked category function or intercepted catalog response.
- An explicitly labeled local-only catalog fixture then exercises the three UI
  groups and multiple featured games, without adding fake published apps.
- Higher-version replacement, wrong-network rejection, HTTP failure retention,
  rollback rejection and devnet isolation exercise the real parser/cache/runtime.
  Only the cache timestamp is aged to trigger normal foreground revalidation.
- Home entry must clear a retained Explore search without clearing ordinary Back
  or tab-return searches; unit tests cover the latter navigation distinctions.
- Game launch must preserve the configured query/fragment. The local fixture game
  requests no wallet connection or transactions; no approval popup should appear.
- Unavailable Rankings pins Browse games and its privacy explanation on a short
  popup. Update balance and Submit balance actions are absent. A sample-preview
  query cannot enable fake balances or a leaderboard in production-mode UI.
- Light/dark 360px popup and 640px full-page screenshots are retained. The existing
  full-page shell explicitly requires a 640px minimum width; use popup/mobile for
  narrower surfaces. No horizontal
  page overflow is permitted. Short screens legitimately scroll the catalog body.

## Explicit limits

The loopback server separately serves the explicit `--policy-repo` checkout's root
policy documents and matching
explicitly allowed E2E eligibility decisions, so startup passes the current main
access gate without calling or changing the production service.

The existing E2E store seeds a disposable ready Guardian-shaped account and empty
settings. Onboarding, account creation, Guardian authentication, private balances,
chain operations and cryptographic proofs are **not** under test here. The wallet's
catalog source, validation, storage, native React components, navigation and Chrome
dApp launch path are real. Page/dApp requests outside loopback are blocked;
expected denied public-price/third-party SDK requests are retained in diagnostics.

This is not native iOS/Android/Tauri acceptance. It does not make the GC balance
reader, leaderboard service, challenge protocol or rewards functional. Those
remain separate integration work. The reader reuses the published catalog, snapshots and floors; no config publication,
category migration or floor increase is required. A local harness does not publish a catalog.

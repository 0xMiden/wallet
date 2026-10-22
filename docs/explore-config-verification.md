# Explore configuration verification

Story: Home / Explore → network-specific wallet-config catalog over HTTP →
validation and versioned cache → direct Finance / Arcade / Others placement →
explicit launch of the configured game URL through the existing dApp browser.
All aggregates the three categories; it is not a catalog category.

## Run locally

With Node 22+, Yarn dependencies and Playwright Chromium installed:

```sh
yarn test:explore-config --config-repo /path/to/wallet-config
```

Use the wallet-config branch paired with wallet #1512 (wallet-config #10 until
merged). The command validates its actual `explore/devnet.json` and
`explore/testnet.json`, starts a loopback HTTP server on an OS-assigned port,
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

- The server first serves the actual paired-repository catalogs and PNG files.
  Assertions verify an actual request, the exact four-tab order and network catalog
  rendering, not a mocked category function or intercepted catalog response.
- An explicitly labeled local-only catalog fixture then exercises all three
  categories and multiple featured games, without adding fake published apps.
- Higher-version replacement, wrong-network rejection, HTTP failure retention,
  rollback rejection and devnet isolation exercise the real parser/cache/runtime.
  Only the cache timestamp is aged to trigger normal foreground revalidation.
- Home entry must clear a retained Explore search without clearing ordinary Back
  or tab-return searches; unit tests cover the latter navigation distinctions.
- Game launch must preserve the configured query/fragment. The local fixture game
  requests no wallet connection or transactions; no approval popup should appear.
- GC ranking actions stay in the shared pinned footer on a short popup. Real
  submission stays disabled; a sample-preview query cannot enable fake balances
  in production-mode UI.
- Light/dark 360px popup and 640px full-page screenshots are retained. The existing
  full-page shell explicitly requires a 640px minimum width; use popup/mobile for
  narrower surfaces. No horizontal
  page overflow is permitted. Short screens legitimately scroll the catalog body.

## Explicit limits

The loopback server also serves the paired repository's root policy documents and matching
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
remain separate integration work. Publication still requires config merge first,
then the matching wallet reader release; a local harness does not publish a catalog.

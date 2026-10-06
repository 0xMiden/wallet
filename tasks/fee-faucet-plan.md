# Fee token discovery and USDCX pricing implementation plan

**Goal:** A shipped wallet learns its fee token from a successful SDK sync, values recognized USDCX at $1, and displays the Send fee bound when the chain charges fees.

**Spec:** `tasks/fee-faucet-discovery.md` plus the requested devnet USDCX pricing and Send fee investigation.

**Architecture:** Record the SDK's `feeFaucetId()` after sync inside the existing WASM hold. Publish only plain account ID data into the native asset module's RPC-and-network scoped cache. Read the same authoritative metadata in balance, pricing, and fee display paths. A fixed USDCX quote applies only after faucet identity and chain metadata agree.

**Tech stack:** TypeScript, React, SDK 0.17.0, Jest, Playwright.

## Constraints

- Keep Developer Settings, environment, and E2E values as explicit overrides. Do not write discovered values to the unscoped `fee_faucet_id` key.
- Preserve sync versus chain-only sync semantics and the original returned summary.
- Re-check hold ownership/client liveness after parking awaits and before further WASM calls or publication.
- Bind scope to client construction and snapshot its identity revision before sync. Endpoint/network switches must not publish an old client's result into current memory.
- Offscreen has no storage API. Forward plain scoped identity through runtime messaging to the service worker, which validates, adopts, and persists it.
- Keep SDK-synced identity evidence separately from historical or configured native identity. Overrides retain precedence without authorizing a copied stablecoin symbol.
- Preserve the legacy display override; reserves and fee units follow the actual fee identity.
- Bind versioned metadata and fee cache envelopes to faucet identity; guard parked reads and writers against reset and same-scope identity changes.
- An early missing value is transient and heals after sync, including an extension popup that already tried storage hydration.
- Missing fee differs from zero fee. Use the actual chain header; preserve zero-fee omission in Send.
- Preserve native on-chain symbol and decimals. Avoid silently valuing a provisional scale as fact.
- USDCX is exactly $1 without a feed, cached market quote, or nominal-price developer switch. Other token pricing keeps its existing behavior.
- A faucet copying the USDCX symbol receives no fixed quote. Canonical identity matching covers hex and bech32.
- No dependency changes, coverage reductions, attribution, or dash characters outside ASCII in authored text.

## Task 1: Publish synchronized fee identity

- [x] RED: Native-asset tests for missing override, publication after an initial miss, cross-realm storage adoption, configured precedence, scope/reset changes, late publication, persistence failure, and fee lookup using the synced identity. Include same-scope A-to-B changes with parked A metadata, fee, and hydration operations.
- [x] RED: SDK integration tests for sync summary preservation, no publication on failed/abandoned sync, and fee accessor awaited under the existing hold.
- [x] GREEN: Add a scoped plain-data publication API to `src/lib/miden-chain/native-asset.ts`; adopt extension storage changes and invalidate affected metadata/fees when identity changes.
- [x] GREEN: Add a shared SDK sync-and-publication helper; integrate `MidenClientInterface.syncState` and direct facade sync paths in client-interface, proxy, offscreen, Guardian creation, Guardian tip preparation, and commit polling. Search all production `.sync()` and `.syncChain()` sites for completeness.
- [x] RED/GREEN: Validate offscreen runtime publication with storage unavailable, including fresh-height and commit polling. Old clients keep their construction scope and cannot publish into a new endpoint.
- [x] RED/GREEN: Attach storage subscriptions before hydration, rebind on scope/reset, retain re-read-on-miss healing, and notify metadata/price consumers through a revision even when the ID is unchanged.
- [x] Update `effective-endpoints.ts` to describe the override as optional after sync.
- [x] Run native-asset, SDK helper, client-interface, proxy, Guardian, and offscreen regression suites.

## Task 2: Preserve native metadata and price recognized USDCX

- [x] RED: Regression tests for native balances/metadata using chain symbol and decimals, and for Send fee units using native USDCX.
- [x] GREEN: Introduce one shared native display-metadata helper; use it in direct balance fetch, sync-data balances, frontend placeholders, claimable notes, history, receipts, metadata resolution, dApp metadata, unheld token selection, and the fee estimate.
- [x] RED: Rejected/provisional metadata remains of unknown scale. Real fee resolution covers base fee 7, zero, and unknown; six-decimal USDCX displays a maximum of 0.00021 USDCX at base fee 7.
- [x] RED: Tests for recognized USDCX price, spoof exclusion, canonical IDs, a different native symbol, scope switch, empty-feed loading, fixed micro-dollar value, and spending-limit cold-realm hydration.
- [x] GREEN: Allowlist the SDK-confirmed native USDCX faucet and share a pure fixed-quote policy between foreground quotes and backend micro-dollar prices. Hydrate native identity/metadata before background allowlist decisions; missing native readiness refuses native or independently unpriced spends while identified foreign tokens retain their own allowlisted price.
- [x] RED: An arbitrary USDCX-named fee override receives no fixed quote. A legacy display override with different decimals does not change actual fee units or reserve identity.
- [x] Define a fixed quote marker and test AssetRow, TokenDetail, and send token presentation suppress market movement/charts. Preserve existing USDC feed pricing and empty-feed portfolio totals. Reuse the stablecoin logo for USDCX.
- [x] Run pricing, valuation, metadata, balances, portfolio, token detail, and fee-estimate tests.

## Task 3: Verify the shipped discovery path

- [x] Add a devnet Playwright regression with `injectFeeFaucet: false` and an absent unscoped override precondition. Assert the independently synced identity, USDCX metadata, $1 valuation with an empty market feed, and the Send fee row according to the live header.
- [x] Prove the regression by removing the fallback and observing failure, then restore and verify.
- [x] Add one changelog entry under `1.17.1 (TBD)`.
- [x] Run dependency integrity, TypeScript, lint/i18n, formatting, affected regression suites, and the configured coverage gate before pushing.
- [x] Build the devnet extension and verify output files and error-free logs. Capture and inspect the current Send screen for any visual completion claim.
- [x] Run independent discovery, risk and adversarial code panels, apply actionable findings, and reverify their regressions.
- [ ] Certify this committed source with the final independent panel, push once, and open a PR against `next`. The PR records the resulting status; merging is outside this request.

## Review and results

- Worktree: `fix/fee-faucet-from-sdk`, based on `origin/next` at `70f592724`.
- Dependencies use the frozen lockfile with Node 22; product dependencies are unchanged.
- Baseline: 146 tests pass across four discovery and pricing suites.
- The plan check completed with four independent reviewers; nine verified plan findings were incorporated.
- Discovery, risk and adversarial panels each completed with four independent reviewers. Ten grouped findings were corrected, including metadata precedence, native valuation scale, late hook results, durable publication recovery, bounded IPC and missing consumer/fatal-error coverage.
- Full coverage: 20,929 tests pass across 922 suites; statements 98.35%, branches 96.17%, functions 97.65%, and lines 98.35%. All four metrics clear the unchanged 95% gate; four existing tests remain skipped.
- Dependency integrity, TypeScript, source lint, i18n lint, E2E harness lint, release-manifest validation, native-prover pin and consume-request equivalence pass.
- Mock-client Chrome browser tests pass. Devnet Chrome and mobile bundles build without errors; the extension manifest and mobile index exist.
- The uninjected devnet regression passes with an empty market feed. Natural funding and note consumption discover USDCX with six decimals, value 1 USDCX at $1, and display the fee reserve from an independent node-header read. No Send submission occurs.
- Disabling only sync-time publication makes the devnet regression fail with a missing native ID after 60 seconds; the source was restored exactly. Review regressions include targeted guard mutations and positive controls.
- Native USDCX valuation requires exact canonical SDK proof and authoritative decimals. Independently allowlisted foreign tokens keep their own price before native discovery; unknown assets and fatal native-identity errors still refuse valuation.
- Explicit overrides keep precedence. Scoped identity, metadata and fee records cannot migrate into another endpoint; native-only fixed pricing does not authorize copied stablecoin symbols.

Final review certification and branch publication follow this committed source checkpoint. The PR records their final status; merging is outside this request.

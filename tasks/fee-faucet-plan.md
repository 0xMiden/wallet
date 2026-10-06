# Fee token discovery and USDCX pricing implementation plan

**Goal:** A shipped wallet learns its fee token from a successful SDK sync, values recognized USDCX at $1, and displays the Send fee bound when the chain charges fees.

**Spec:** `tasks/fee-faucet-discovery.md` plus the requested devnet USDCX pricing and Send fee investigation.

**Architecture:** Record the SDK's `feeFaucetId()` after sync inside the existing WASM hold. Publish only plain account ID data into the native asset module's RPC-and-network scoped cache. Read the same authoritative metadata in balance, pricing, and fee display paths. A fixed USDCX unit quote follows the SDK-confirmed native identity and the requested USDCX default while metadata loads. Authoritative chain symbols take precedence, and known scale remains required for balances, allowances and fees.

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
- [x] Finish dependency integrity, TypeScript, lint/i18n, formatting and affected regression checks.
- [ ] Run full tests, the configured coverage gate and browser regressions on the final corrected head in CI only.
- [x] Build the earlier devnet checkpoint and verify output files and error-free logs. Current browser validation runs in CI; obtain a fresh CI screenshot before a visual completion claim.
- [x] Run independent discovery, risk and adversarial code panels, apply actionable findings, and reverify their regressions.
- [x] Open PR #1351 against `next` while the remaining corrections are prepared, as explicitly requested.
- [ ] Certify the corrected committed source with the final independent panel at medium effort. Final review gates on P0/P1 plus the explicitly reopened valuation snapshot P2; other P2/P3 findings remain nonblocking.

## Final lifecycle corrections

- [x] Resolve uncached foreign display metadata without replacing actual native chain metadata or authorizing foreign fixed quotes.
- [x] Capture the first offscreen publication snapshot after startup endpoint hydration; refuse obsolete scopes without adoption.
- [x] Defer scope-invalidation notifications during render while clearing native identity and price eligibility immediately.
- [x] Complete focused assertion RED/GREEN and guard mutations.
- [ ] Certify the frozen source with the final independent panel, gating on P0/P1 findings only.

## Final financial corrections

- [x] Read native metadata from the chain even when generic display metadata contains a stale cached scale.
- [x] Retain the authenticated native USDCX fixed quote across an earlier foreign metadata or price await.
- [x] Prove both defects with failing regressions, passing controls and exact restored-source mutations.
- [ ] Run fresh PR CI and the final medium-effort internal review on the corrected committed head.

## Fresh-install native defaults

- [x] Use USDCX name and symbol for provisional native metadata rather than MIDEN.
- [x] Keep generic native branding from supplying an unverified quantity scale.
- [x] Give SDK-confirmed native USDCX a fixed $1 unit quote independent of scale readiness.
- [x] Preserve foreign quote exclusion, genuine chain MIDEN, and unknown-scale quantity, fee and allowance refusals.
- [x] Verify focused RED/GREEN and guard mutations, then finish the internal review; fresh signed-source CI follows.
- [x] Update native fee, funding and auto-accept copy across all 14 locales, including runtime bundles and source metadata; preserve placeholders and leave no stale translations.
- [x] Align Chrome, iOS and Android default token-selector fixtures with USDCX.
- Scope is fresh installs. No cached balance-row migration or provider projection changes.

## Task 4: Merge and release wallet 1.17.1

- [x] RED/GREEN: Normalize CRLF helper checkouts in the relay-patch checker; verify LF/CRLF parity and genuine stale-helper refusal with an actual-script regression.
- [ ] Triage conflicts, review comments and CI failures until the PR is green; admin squash merge as explicitly authorized.
- [ ] Babysit `origin/next` to green after the merge.
- [x] Verify the documented build/publishing workflow and existing release surfaces.
- [x] Prepare consistent wallet `1.17.1` versions.
- [ ] Publish `v1.17.1` from green `next`; verify all required jobs and release assets.
- Store publishing is handled by the user. Preserve the existing `v1.17.0` release, tag, assets and store listing.

## Review and results

- Worktree: `fix/fee-faucet-from-sdk`, based on `origin/next` at `70f592724`.
- Dependencies use the frozen lockfile with Node 22; product dependencies are unchanged.
- Baseline: 146 tests pass across four discovery and pricing suites.
- The plan check completed with four independent reviewers; nine verified plan findings were incorporated.
- Discovery, risk and adversarial panels each completed with four independent reviewers. Twelve grouped findings were corrected, including metadata precedence, native valuation scale, late hook results, durable publication recovery, bounded IPC and missing consumer/fatal-error coverage.
- The preceding signed PR checkpoint passed all 30 selected CI checks, with three expected skips: 20,987 unit tests across 923 suites, statements/lines 98.35%, branches 96.18% and functions 97.65%. All four coverage thresholds remain 95%. Local Chrome passed 20 tests and Guardian lifecycle passed 26 specs. These results do not certify the subsequent financial corrections; fresh full tests, coverage and browser validation run in CI only.
- The preceding correction checkpoint passed 916 tests across the 13 fee-consumer suites, 24 tests across three indirect note fixtures and four relay-patch portability tests, plus TypeScript and static gates.
- Final lifecycle corrections pass 300 focused tests across six suites. Fourteen targeted mutations reproduce the intended failures, and exact restored production bytes pass again. One shared full TypeScript check and zero-warning lint of all twelve corrected source/test files pass.
- A fresh React unit probe using the actual native cache and token provider produces no render warning, clears obsolete price eligibility immediately and recovers current USDCX metadata and fee state. It does not certify a browser or device.
- The final financial corrections pass 121 tests across three suites, full TypeScript, and zero-warning lint/format checks on all six corrected source/test files. The regressions cover stale native display-cache scale, RPC rejection, unknown chain scale, both earlier-spend await boundaries, and lost synchronized proof. Three targeted mutations reproduce the expected metadata, foreign-cache and valuation failures, followed by exact source restoration. SDK/parser/RPC and storage boundaries remain declared doubles in the focused runtime probes.
- The preceding implementation checkpoint passed mock-client Chrome browser tests and built devnet Chrome and mobile bundles without errors; the extension manifest and mobile index exist. Full coverage and browser validation of the final corrected head run in CI only.
- The earlier implementation checkpoint passed the uninjected devnet regression with an empty market feed. Natural funding and note consumption discover USDCX with six decimals, value 1 USDCX at $1, and display the fee reserve from an independent node-header read. No Send submission occurs.
- Disabling only sync-time publication makes the devnet regression fail with a missing native ID after 60 seconds; the source was restored exactly. Review regressions include targeted guard mutations and positive controls.
- Native USDCX valuation requires exact canonical SDK proof and authoritative decimals. Independently allowlisted foreign tokens keep their own price before native discovery; unknown assets and fatal native-identity errors still refuse valuation.
- Actual native fee identity now drives reserves, funding, automatic note consumption, rotation guards and claim grouping. Overlapping fee reads reject stale completions. Legacy settings remain available for display and sorting.
- Explicit overrides keep precedence. Scoped identity, metadata and fee records cannot migrate into another endpoint; native-only fixed pricing does not authorize copied stablecoin symbols.

PR #1351 is open. Final review certification of the corrected source, the authorized admin squash merge and wallet `v1.17.1` release follow this source checkpoint. Their final status is recorded in the PR and release.

### Fresh-default validation

- 331 tests across 15 native, pricing and smoke suites pass; nine focused mutations produce 23 intended assertion failures and restore exact source bytes.
- 119 tests across three settings, auto-consume and transaction-error suites pass.
- Full TypeScript and scoped zero-warning lint and format checks pass. All 14 locale runtime/source bundles agree across 1304 keys with unchanged placeholders and no pending translations.
- Three internal medium-effort reviews report no P0/P1 findings. Final full coverage, platform builds and browser regressions remain CI-only and must run on the pushed head.

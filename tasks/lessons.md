# Fee asset discovery

- Apply an explicit final-review severity cutoff to new findings. Preserve lower-severity findings as deferred evidence without restarting the review or delaying the requested release.
- When a user requests the PR during final review, open it at the current signed checkpoint and let CI run while the remaining corrections and review finish. Keep merge and release gates bound to the final head.
- Check all native metadata consumers when fixing actual fee identity versus legacy display identity; uncached discovery, cached detailed metadata, search, notes and sync balances must agree.
- Capture cold service-worker publication revisions after endpoint hydration. Scope validation before hydration can reject the first otherwise valid SDK publication.
- Keep cache invalidation synchronous while deferring only notifications caused by render-time getter invalidation. Direct updates must consume pending notices to avoid duplicate callbacks.
- Publish new scope and override ownership before notifying listeners. A listener can synchronously call the same getter; notification before ownership changes can recursively invalidate the cache.
- Recheck the captured WASM hold and client generation after every caller-owned await before reading an SDK summary or another borrowed value. A check inside the awaited helper does not replace the caller's check.
- Serialize scoped identity writes with reset. A pre-write revision check alone cannot stop a parked storage write from completing after a newer identity or reset.
- Use authoritative native metadata for the actual fee identity even when a separate legacy display override is selected. Cached display decimals cannot set spend values or fee units.
- Treat each offscreen publication as a fresh bounded attempt, and invalidate local persistence acknowledgements when either durable identity record changes.
- Guard asynchronous fee hooks by generation so a parked result from the previous network cannot replace the current fee identity.
- Authorize fixed native pricing with exact canonical synchronized identity. Missing or mismatched proof cannot turn a native spend into an unpriced zero-value allowance charge.
- An ordinary cold native identity must not block an independently identified, allowlisted foreign price. Fatal identity errors retain their refusal behavior.
- Apply the user's latest review-effort instruction to future seats for that issue. Preserve completed seat records and record the scoped exception without changing the global roster defaults.
- Apply a cancellation to the named subtask while preserving the remaining authorized work. Confirm dependency connections from source before planning an integration change.
- A release-version correction replaces the earlier publishing strategy. Update every product version and planned distribution step together, preserving prior releases unless removal is still explicitly requested.
- When store publishing is assigned to the user, stop dashboard work and complete the independently authorized repository release and artifact checks.
- Describe an unmerged version bump as the local branch prepared for that version. Reserve release wording for an actual published tag, and state push/merge status explicitly in progress updates.
- When coverage is assigned to CI, stop local coverage immediately and use focused noncoverage checks for known failures. Never report an interrupted run as passing or reuse an earlier source checkpoint as current proof.
- When a fee-identity hook changes, migrate fixtures in all indirect consumers, including manual-note badges and toast monitors. Use different native and display IDs so legacy-hook regressions remain observable.
- Inventory every direct legacy selector call when separating fee identity from display identity. Classify mixed components before changing fee consumers.
- Give every overlapping asynchronous fee read an ownership generation. Unmount cancellation cannot stop an older result replacing a newer one in the same effect.
- Keep browser tests in CI when explicitly requested, and name mock versus live-network evidence before interpreting token symbols.
- An explicit final-review severity cutoff makes lower-severity findings nonblocking. Finish accepted corrections already underway, then gate the final review on P0/P1 only.
- A later request to fix a named deferred finding reopens that finding alone; retain the final-review cutoff for other lower-severity findings.
- Native bootstrap must read chain metadata directly. A generic display-cache hit cannot prove the native asset scale.
- Authenticate native identity and quote from the same valuation snapshot; clearing a live display cache during an earlier await must not erase a proven stablecoin charge.
- Every headless review launch sets the repository and working directory explicitly, then checks the source head before invoking the provider.
- Fresh-install requirements do not imply migration work for old stored balance rows. Keep that scope explicit.
- Respect an explicit USDCX loading default and fixed $1 unit quote. Price per unit is separate from verified raw-unit scale; quantity, allowance and fee gates keep their own checks.
- Audit native-token defaults together with fee warnings, funding prompts and settings copy. Update both locale message metadata and generated runtime bundles; keep genuine separate tokens and SDK identifiers intact.
- Apply an explicit session change of review workflow immediately. Preserve completed evidence and stop launching the superseded workflow.
- Preserve the canonical byte format of generated locale messages. A formatting-only difference can trigger an unnecessary translation commit and change the reviewed source head.
# Faucet funding and responsiveness

- Compare faucet metadata on every target network before choosing a funding amount. A grant that
  works on devnet can be thousands of times harder to prove on testnet when `base_amount` differs.
- An `await` on WebCrypto does not guarantee a browser task boundary. Chromium resolves digest
  promises inline; keep unbounded nonce search in a worker with cancellation owned by its parent.
- Windows patch application can insert CRLF into an otherwise LF SDK bundle. Normalize both the
  source helper and installed bundle before comparing the relay patch, and retain stale-content tests.

- Guardian package version alone does not prove faucet compatibility. Match missing procedure digests and verify the real Fund your wallet flow through committed consumption before handing over a fix.

- A requested exact Rust SDK version must use equality constraints and locked graph assertions. Never substitute a newer experimental build for the requested release proof.

- Public faucet funding must be exercised through the real Fund UI in each public-network E2E gate. CLI-funded transaction tests alone do not cover faucet callbacks or automatic consumption.

- Extend the existing real Guardian onboarding journey with public faucet funding rather than adding a duplicate wallet-creation scenario. Preserve local-stack funding while making public-network funding mandatory.

- Playwright clears its configured output directory at startup. Use distinct nested Playwright output directories for sequential CI stages, and never launch another run that clears the shared parent containing live harness evidence.

- A public faucet acceptance receipt proves queue admission, not chain commitment. Compare the note inclusion timestamp with the failure timestamp, then wait for that specific note before running fixture consumption assertions. Never remint a queued grant to hide a short delivery budget.

- A fullscreen return control must follow the requested standard app minimize lifecycle. Retain the existing session and document, restore through the normal app selector, and leave user closure in the existing minimized-app controls without adding a game-specific close affordance.

- Moving safe-area reservation off the document body requires an exhaustive inventory of pinned controls and scroll endings. Measure real rendered ancestry with compiled CSS; nested forms must consume the physical safe area once, and backgrounds must still reach the viewport edge.

- When a shared footer spacing contract changes, search all consumer tests for the prior class before final full gates. A stale onboarding-wrapper assertion can cost a second crypto-heavy full run even when the rendered geometry is correct.

- A quiet redirected test log does not prove that no suites have run. Use completed summary counts and process evidence; do not label the runner as stuck before its first suite from missing PASS lines.

# Session lessons

- For #1738, define bounded implementation tasks and complete independent review only after the code is finished.

- #1738 acceptance uses the existing mainnet E2E suite and already-funded accounts. Add a cost-bounded swap-out/swap-back loop. Do not replace live settlement coverage with a simulated cross-chain service; keep mocks for deterministic unit and component failure cases.

- Mainnet 1Click E2E uses $2 as the total round-trip safety cap, including both swaps and network gas. Optimize for the cheapest viable route and minimum viable amount; do not treat the cap as a target. Reuse the funded accounts and recycle actual received principal.

- Extend #1738 acceptance with mocked testnet E2E when requested, following Epoch. A rejection of replacing live settlement does not forbid deterministic mocked coverage alongside the funded mainnet loop.

- For #1738, distinguish the real Bread UI and WalletConnect protocol from the mocked settlement service. User accepted Chrome once that distinction was clear; do not add mobile-runner scope after that explicit choice.

- For #1738, config presence is not the rollout switch. Require an explicit wallet-config features.nearIntents boolean, default false, before exposing or starting the integration; dedicated mocks opt in and mainnet acceptance honors the same flag.

- Preserve existing commit signing settings. No-attribution instructions prohibit authorship trailers; they do not justify disabling the signature required by the pre-push hook. Prepare an identical-tree candidate and obtain any required exception before replacing unpublished history.

- When review requirements change, preserve prior review evidence and continue under the latest explicit instruction without relabeling incomplete proof.

## Existing browser sessions

When a browser debugging connection is unavailable, inspect the requested browser through the available native UI interface before asking for another sign-in. A missing CDP connection does not imply the signed-in browser window is inaccessible. Follow the user's named tab group and preserve the current login.

- HTTP fixture tests run in Jest JSDOM, where Node fetch is not supplied. Reuse the existing node:http request pattern and distinguish setup exceptions from functional assertion failures in regression proofs.

## Review and diagnostic workflow

- Before expensive evidence preparation, validate a new label through stock state registration, rendering, seat, verification and fix-round consumers. Use the native label format and the round matching the plan gate that completed; safe-filename validation alone is insufficient.
- Route private syntax checks through the guarded local-check helper. Private output does not remove the resource and logging requirements.
- Debugger observers must verify ownership of the current frame and locals before reading them. Capture stage metadata before optional calculations, guard absent locals, and keep recovery independent of extraction so observer failures cannot consume a quit fallback.
- Bound diagnostic attempts with visible progress and a concrete recovery decision. Record failed, refused and interrupted attempts in [upstream issue #62](https://github.com/WiktorStarczewski/review-council/issues/62), and keep infrastructure causes unconfirmed until evidence establishes them.
- When a user's explicit global rule excludes a P3, record exactly `DEFERRED (P3, ignored by user rule)`. Do not fix it, open a plan, blocker or follow-up, or keep it as open carryover. Only a later explicit request naming it reopens that item.
- For exact-value regression tests, inspect global Jest manual mocks as well as suite-local mocks. A global mock can bypass production conversion, so bind the assertion to an existing path that exercises the real conversion.


## Swap amount locators during loading

Quote loading removes the derived amount input while keeping the opposite input mounted. A global first/nth locator can then edit the wrong side. Scope each amount locator to the existing pay/receive container and cover the missing-input state in its behavioral regression.

- For #1945 and #1949, the user stopped Council and plan gates. Complete remaining fixes directly, self-review, and preserve ordinary automated CI acceptance without restarting panels.

- A live gh watcher only collects status. Treat a CI failure as immediate work in the active orchestration turn; never equate a surviving watcher process with active failure recovery.

- Release1.17.8 validation runs RC CI and the release E2E/Mainnet batch in parallel, per explicit user correction. Do not serialize their setup behind RC CI.

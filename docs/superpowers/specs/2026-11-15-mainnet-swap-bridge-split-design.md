# Mainnet swap and bridge selection

## Intent and approved direction

Swaps and bridges must be independently runnable permanently. The ordinary "E2E Mainnet Nightly" command still means both. This replaces a temporary-only split, not the existing tests or financial controls.

## Approach

Use the existing workflow and runner, not copied pipelines or a new workflow identity. `swaps_only` already selects swaps; add complementary `bridges_only`. With both false, the existing nightly runs both as before. Selecting both is invalid. Preserve `loops_only` as the legacy-coverage exclusion: bridges_only + loops_only selects the Epoch/NEAR loops without legacy send/USDCx/AggLayer coverage. No extra provider options in this change.

Separate physical workflows were considered but rejected for this small change: existing checkpoint discovery and the verified baseline explicitly bind to one workflow ID. Changing those provenance rules just to offer two entrypoints is unnecessary financial risk. Duplicating provider recipes would let recovery/SDK gates diverge.

## Behavior and boundaries

- Bridge-only skips every FRESH solver swap prepare/authority/upload/run/wait step. It still reconciles any unresolved original swap before a bridge can spend.
- Swap-only retains today's behavior, including recovery of original bridge principal when present.
- Default nightly retains today's swap then Epoch then NEAR and legacy coverage/order. This change does not pretend one provider's outage demonstrates another provider's acceptance.
- Recovery, consumed-job/nonce handling, snapshot discovery, exact-byte SDK upload/download ACKs, claim gates and checkpoint retention remain unchanged.
- All modes keep shared e2e-mainnet-nightly concurrency and existing spending limits. This session's manual invocations must use the actual remaining1953919 micro-USD, never the default as a cap reset. This selection change does not expand legacy fee allowances or authorize routes unable to fit the session's total cap.
- No new accounts/funds, public NEAR defaults, retries, dependency changes, threshold changes, raw private logs or admin authority.
- The separate overview task still owns independent live-provider qualification, safe audits and a network-labelled reliability matrix. Selector tests are not funded acceptance; a bridge group blocked by Epoch must not be reported as NEAR tested.

## Scope

Modify `.github/workflows/e2e-mainnet-nightly.yml`, its existing `scripts/mainnet-swap-workflow.test.ts` contract tests, one current changelog entry and the existing E2E architecture documentation. No wallet application changes or new workflow IDs.

## Verification

Baseline154 tests/3suites passed through guarded local preflight on567b0e642. First add functional failing selector/guard/recovery tests; prove intendedRED in CI, then implement and proveGREEN. Preserve current-head required CI and95% coverage. Verify default, swap-only, bridge-only and invalid combined selection; keep every recovery/SDK/claim/retention barrier. Run modes with genuine new jobs/authorities only after financial readiness and audit prerequisites.

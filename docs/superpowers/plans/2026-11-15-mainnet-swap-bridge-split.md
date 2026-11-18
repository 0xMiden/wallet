# Mainnet Swap/Bridge Split Implementation Plan

**Goal:** Permanently select swaps or bridges independently while the default mainnet nightly still exercises both.

**Architecture:** Keep the existing workflow identity and runner. Add bridges_only beside existing swaps_only; gate fresh swap stages only, never original recovery. No copied workflows or provider logic.

**Tech Stack:** Existing GitHub Actions YAML, Jest workflow contracts, Node22/Yarn1.

**Spec:** `docs/superpowers/specs/2026-11-15-mainnet-swap-bridge-split-design.md`

**Execution:** Native in the isolated `mainnet-swap-bridge-split` worktree; no additional panels or delegated implementation.

## Global Constraints

- Preserve default both-mode behavior, existing swaps_only/loops_only/recovery flags and the same workflow ID, verified baseline and checkpoint discovery rules.
- Keep all-provider recovery, shared wallet concurrency, exact-byte SDK/claim ACKs, original authority consumption and all final artifact retention.
- No retry/cap/threshold/dependency/public-NEAR changes or extra funds/accounts. Manual remaining allowance1953919 micros, not a reset.
- Do not change or deploy the frozen567b0e642 source being tested by the15-suite overview; fixes use their own branch and source-bound validation.

## Review Focus

1. A pending old swap during bridge-only must recover or block, never disappear.
2. Bridge-only must skip SDK create/claim and upload stages of a FRESH swap, not only its prepare step.
3. Both selectors true must fail before wallet restoration or a grant; default both false must keep full coverage.
4. loops_only must keep its existing legacy exclusion and may narrow bridge-only without silently enabling legacy spending.
5. Existing recovery-only permissions, shared group and financial retention must be identical in every mode.

### Task 1: Prove mode selection and guard contracts RED, then implement GREEN

**Files:** Modify `.github/workflows/e2e-mainnet-nightly.yml` and `scripts/mainnet-swap-workflow.test.ts`.

**Interfaces:** Existing `workflow_dispatch.inputs`, `Require an original, unambiguous run`, and exact existing step names/conditions. New `bridges_only:boolean=false`; no new module or workflow identity.

- [ ] Add a Jest case requiring bridges_only boolean/defaultfalse and retaining old flags/defaults.
- [ ] Add a table over every step from `Prepare mainnet solver swap` through `Wait for mainnet swap return`, requiring the bridge-only exclusion while retaining the original recovery-cleared condition.
- [ ] Execute the existing tiny Bash guard with first-attempt/bounded-budget env for both selectors true; assert rejection before any wallet step. Assert default/swap-only/bridge-only accepted and existing unsafe budgets/recovery combinations still rejected.
- [ ] Assert all original provider recovery and SDK/claim/retention gates remain present, ungated by bridges_only. Assert bridge and legacy eligibility retain existing swaps_only/loops_only conditions.
- [ ] Run the named workflow/artifact contract tests through `~/.codex/bin/ci-local` with `--maxWorkers=2`, no coverage. Confirm a functional missing-selector or incorrect-selection assertion, not setup/import failure.
- [ ] Commit tests as a signed deliberate regression and publish a bounded no-secret CI regression proof. Watch exact source30s; confirm intendedRED. Do not dispatch funded jobs from RED source.
- [ ] Add the input and guard environment/mutual-exclusion check. Append `!inputs.bridges_only` to EVERY fresh swap phase condition; leave all recovery/provider/legacy/retention conditions otherwise unchanged.
- [ ] Re-run the same154-baseline blast radius plus new tests; confirm nonzeroGREEN and review the financial workflow diff for accidental skipped gates.
- [ ] Commit minimal implementation separately, signed with both emails poszerny@gmail.com. No amendment/force rewrite.

### Task 2: Document and qualify the permanent modes without fabricating acceptance

**Files:** Modify `playwright/e2e/docs/e2e-architecture.md` and one unreleased `CHANGELOG.md` entry.

**Interfaces:** Natural "mainnet swaps" sets swaps_only=true; "mainnet bridges" sets bridges_only=true; ordinary "mainnet nightly" leaves both false. Existing API flags and loss-budget input stay compatible.

- [ ] Document the three invocations, invalid combination and recovery-before-spending behavior; distinguish legacy exclusion and current manual remaining cap from the normal scheduled default.
- [ ] Add one changelog line in a strictly unpublished higher version section. No broader policy or wallet UI change.
- [ ] Run scoped format/lint once before commit using the guarded route. Preserve95% thresholds and source/ref provenance.
- [ ] Publish a small PR/current-head checks and internally inspect source; no additional Council or inherited admin bypass. Monitor every required gate on exact source.
- [ ] Qualify live bridge-only execution only with a NEW source-bound dispatch, settled original holdings, actual budget/no-overlap controls, and independent financial reconciliation. Provider outage is a provider-blocked result, not a pass or proof about unexecuted routes.
- [ ] Continue the independent15-suite overview and final evidence-based table; do not leave a reproducible E2E defect merely reported. A missing historical exception remains unknown, not automatically our fault or a provider's.

## Self-review

Every spec item maps to task1 contract checks or task2 operator documentation/qualification. Financial baseline/context and default workflow identity remain unchanged. No application interfaces or dependency/type changes; the plan is bounded to one selector and its tests/docs.

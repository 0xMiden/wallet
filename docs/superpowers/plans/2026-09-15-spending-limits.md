# Spending Limits Implementation Plan

> **For the implementer:** Follow `superpowers:test-driven-development` task by task. Do not write production code until the named failing test proves the behavior is absent. Use `superpowers:verification-before-completion` before every commit and `review-council:rev` after the implementation is locally green.

**Goal:** Add account-scoped, per-asset rolling 24-hour and 7-day spending limits that require one fresh, exact, short-lived authentication before an over-limit outgoing transaction can be queued.

**Architecture:** Dexie stores both configuration and the outgoing history used by the policy. One domain module computes assessments, while one atomic queue helper rechecks the policy, validates an exact one-time authorization, and inserts the row in the same transaction. UI preflights provide usable prompts, but the four initiation functions remain the enforcement boundary. A shared strict-authentication controller denies on cancellation or unavailable credentials and is reused by Settings, wallet flows, and dApp confirmation surfaces.

**Tech stack:** React, TypeScript, Zustand request transport, Dexie, Capacitor/Tauri secure storage, Jest, Testing Library, Playwright.

---

## Task 1: Add the Dexie schema and spending-limit domain types

**Files:**

- Modify: `src/lib/miden/repo.ts`
- Modify: `src/lib/miden/repo.test.ts`
- Modify: `src/lib/miden/db/types.ts`
- Create: `src/lib/miden/spending-limits/types.ts`
- Create: `src/lib/miden/spending-limits/types.test.ts`

1. Measure the existing TypeScript comment ratio repo-wide and in the files being touched. Keep implementation comments inside that band, preserving only policy invariants and storage traps.
2. Add failing tests for the next Dexie schema version, the `spendingLimits` compound identity, the transaction `spendingLimitAuthorizationId` index, bigint-safe persisted shapes, and deletion when both periods are absent.
3. Run the focused suites and confirm the new schema and types are missing.
4. Add `Table.SpendingLimits`, an account-and-faucet keyed record, and an authorization-id index on transactions. Store amounts as canonical decimal strings at the persistence boundary if Dexie/browser compatibility requires it, while domain APIs expose bigint.
5. Define the configured periods, metadata snapshot, revision, timestamps, structured breach, unavailable-policy error, and exact authorization types. Reject negative, non-canonical, malformed, or incomplete persisted records.
6. Re-run the focused tests and commit only after they pass.

## Task 2: Implement pure rolling-window assessment

**Files:**

- Create: `src/lib/miden/spending-limits/policy.ts`
- Create: `src/lib/miden/spending-limits/policy.test.ts`
- Modify: `src/lib/miden/db/types.ts`

1. Add failing table-driven tests for account and faucet isolation, native bigint arithmetic, exact 24-hour and 7-day boundaries, and daily plus weekly breaches.
2. Cover Queued, GeneratingTransaction, Completed, and Failed outgoing rows. Cover exclusion of consume, receive, Earn withdraw, structural rows, restored rows, another account, another asset, and rows at the exact expired boundary. Prove future-dated or otherwise malformed matching rows fail closed.
3. Require breach output to include spent, proposed total, cap, period, and the earliest `resetAt` at which enough included spend expires. Cover deterministic ordering when both periods breach.
4. Confirm RED against the missing policy function.
5. Implement a pure reducer over a validated config and candidate rows. Keep time injected. Fail closed on malformed amounts, timestamps, or configuration rather than treating a broken active policy as absent.
6. Re-run the focused suite and commit.

## Task 3: Make policy enforcement and insertion atomic

**Files:**

- Create: `src/lib/miden/spending-limits/queue.ts`
- Create: `src/lib/miden/spending-limits/queue.test.ts`
- Modify: `src/lib/miden/transaction/initiate.ts`
- Modify: `src/lib/miden/transaction/transactions.test.ts`

1. Add real-Dexie failing tests proving two concurrent requests cannot both consume the same remaining allowance.
2. Add failing tests for absent configuration, below-limit insertion, over-limit rejection with no row, policy read failure, stale configuration revision, expired authorization, account/faucet/amount mismatch, replay, and successful one-time consumption.
3. Cover a preflight that was allowed but races a preceding insertion and therefore returns a fresh structured breach at final insertion.
4. Implement `queueOutgoingTransaction` as one `rw` transaction over spending limits and transactions. Re-read config and eligible rows, validate any authorization against the current revision and a maximum two-minute lifetime, perform keyed replay detection, attach its id, and insert exactly once.
5. Route only send, swap, bridged-send, and earn-deposit constructors through the helper. Keep consumes, receives, Earn withdraws, custom opaque requests, and structural account operations unchanged.
6. Re-run the focused and initiation regression suites and commit.

## Task 4: Add configuration reads, writes, and strict change classification

**Files:**

- Create: `src/lib/miden/spending-limits/config.ts`
- Create: `src/lib/miden/spending-limits/config.test.ts`
- Modify: `src/lib/shared/types.ts`
- Modify: `src/lib/miden/back/actions.ts`
- Modify: `src/lib/miden/back/main.ts`
- Modify: `src/lib/intercom/in-process-request-handler.ts`
- Modify: `src/lib/intercom/mobile-adapter.test.ts`
- Modify: `src/lib/intercom/desktop-adapter.test.ts`
- Modify: `src/lib/store/index.ts`
- Modify: `src/lib/store/types.ts`

1. Add failing tests for listing account-scoped configurations, create, pure lowering, adding a period, raising a cap, removing a period, disabling, metadata refresh, concurrent save versus queue, and revision regeneration.
2. Classify pure lowering as the only change that does not require strict authentication. Any mixed edit containing enable, add, raise, remove, or disable requires it.
3. Add transport-level RED tests for every runtime. Do not let UI code open Dexie directly when an existing backend request boundary owns the operation.
4. Implement validated configuration requests. Save in a Dexie write transaction, require the caller's observed revision for edits, delete records with no periods, and generate a new opaque revision after every accepted write.
5. Re-run all focused transport, config, and concurrency suites and commit.

## Task 5: Build one strict authentication controller

**Files:**

- Create: `src/lib/auth/strict-action-authentication.ts`
- Create: `src/lib/auth/strict-action-authentication.test.ts`
- Create: `src/components/StrictActionAuthentication.tsx`
- Create: `src/components/StrictActionAuthentication.test.tsx`
- Modify as needed: `src/lib/biometric/index.ts`
- Modify as needed: `src/lib/desktop/secure-storage.ts`
- Modify as needed: `src/lib/miden/back/vault.ts`

1. Add failing controller tests for mobile hardware, mobile passcode, extension password, desktop password, and desktop hardware paths.
2. Cover cancellation, invalid credentials, unavailable hardware, probe errors, component unmount, duplicate confirmation, and stale completion after a newer challenge. Every non-success path must deny.
3. Reuse the existing vault unlock verification without changing the current account, protector, spending policy, or transaction state. Never retain a credential after settlement.
4. Return only authenticated or cancelled from the credential component. Create the spending authorization separately from the exact assessed account, faucet, amount, revision, and current time.
5. Prove no path uses `confirmSensitiveAction` or its permissive no-biometric behavior for configured limits.
6. Re-run focused authentication and protector regression suites and commit.

## Task 6: Add the account-scoped Spending Limits settings screen

**Files:**

- Create: `src/app/templates/SpendingLimits.tsx`
- Create: `src/app/templates/SpendingLimits.test.tsx`
- Modify: `src/app/pages/Settings.tsx`
- Modify: `src/app/pages/Settings.test.tsx`
- Modify: `src/app/pages/Settings.selectors.ts`
- Modify: `public/_locales/en/en.json`
- Regenerate: `public/_locales/*/messages.json`

1. Add failing UI tests for the Security menu entry, current-balance assets, configured zero-balance assets, loading and storage failures, unknown decimals, empty-period behavior, decimal precision, overflow, and lossless base-unit conversion.
2. Add failing interaction tests proving pure lowering saves directly while every stricter-classified edit invokes strict authentication first. Cancellation or failure must leave the persisted config unchanged.
3. Implement the routed screen using existing Settings layout and form primitives. Keep drafts local until whole-form validation succeeds, and guard stale async saves when the account or revision changes.
4. State permanently that limits and history live only on this installation, reset with app data or reinstall, and do not provide on-chain enforcement.
5. Regenerate locale bundles. Run focused Settings tests, i18n lint, and locale parity, then commit.

## Task 7: Integrate wallet send and swap flows

**Files:**

- Modify: `src/screens/send-flow/ReviewTransaction.tsx`
- Modify: `src/screens/send-flow/ReviewTransaction.test.tsx`
- Modify: `src/screens/swap-flow/SwapManager.tsx`
- Modify: `src/screens/swap-flow/SwapManager.test.tsx`
- Create: `src/components/SpendingLimitChallenge.tsx`
- Create: `src/components/SpendingLimitChallenge.test.tsx`

1. Add failing tests for below-limit behavior, daily breach, weekly breach, both periods, cancellation, failed strict authentication, exact authorization threading, expiry before queueing, and a final-insertion race that reopens the challenge without losing the draft.
2. Keep ordinary below-limit send and swap behavior on the existing optional confirmation. On a breach, use only strict authentication so one action does not produce two credential prompts.
3. Render asset, proposed amount, cap, amount over cap, periods, and reset times from the structured assessment. Do not reproduce policy math in React.
4. Queue only after the final enforcement helper accepts. Clear authorizations on any account, asset, amount, configuration, or navigation change.
5. Run focused send, swap, and initiation suites and commit.

## Task 8: Integrate bridge and Earn deposit flows

**Files:**

- Modify: `src/lib/agglayer/b2agg/index.ts`
- Modify: `src/lib/agglayer/b2agg/index.test.ts`
- Modify: `src/lib/epoch/miden-note.ts`
- Modify: `src/lib/epoch/miden-note.test.ts`
- Modify: `src/lib/epoch/earn-note.ts`
- Modify: `src/lib/epoch/earn-note.test.ts`
- Modify relevant bridge and Earn entry screens and their tests discovered from the current call graph.

1. Add failing tests for Agglayer, Epoch bridge, and Earn deposit preflight plus final authorization threading.
2. Run the preflight before external quote, intent, or request construction when the exact base-unit amount is known. Do not consume authority until the outgoing row is atomically inserted.
3. Cover external preparation exceeding two minutes. The final queue must reject the stale authorization and prompt again while retaining safe draft/preparation state; it must never silently bypass or queue twice.
4. Cover below-limit behavior, cancellation, preparation failure, and a policy change during preparation.
5. Verify Earn withdraw and bridge-in receive paths do not invoke the spending policy.
6. Run focused bridge, Earn, and initiation suites and commit.

## Task 9: Integrate extension, mobile, and desktop dApp sends

**Files:**

- Modify: `src/lib/dapp-browser/confirmation-store.ts`
- Modify: `src/lib/dapp-browser/confirmation-store.test.ts`
- Modify: `src/lib/miden/back/dapp.ts`
- Modify: `src/lib/miden/back/dapp.*.test.ts`
- Modify: `src/app/ConfirmPage.tsx`
- Modify: `src/app/ConfirmPage.test.tsx`
- Modify: `src/app/pages/Browser/DappConfirmationModal.tsx`
- Modify: `src/app/pages/Browser/DappConfirmationModal.test.tsx`
- Modify: `src/lib/desktop/DesktopDappConfirmationModal.test.tsx`

1. Add failing backend tests proving a dApp never receives or controls the authorization object, and that an untrusted request cannot bypass the atomic initiation check.
2. Add failing UI tests for structured breach detail and strict authentication on both extension confirmation and the shared mobile/desktop modal. Approval cannot resolve before authentication succeeds.
3. Assess after request validation and exact transaction formatting. Put only limit display data in the confirmation request. Return an internal result to the wallet backend, create the exact authorization there, and pass it directly to initiation.
4. If insertion races after the confirmation resolves, reject with stable retry guidance and no row. On retry, surface the current limit challenge before approval.
5. Cover origin disconnect, account switch, modal close, duplicate approve, stale response, and unavailable authentication. All deny without leaking credentials or authorization ids to the dApp.
6. Run the full dApp confirmation and request suites and commit.

## Task 10: End-to-end, visual, full verification, Council, and delivery

**Files:**

- Create: `playwright/e2e/tests/spending-limits.spec.ts`
- Modify: `playwright/e2e/helpers/wallet-page.ts`
- Modify only if needed: E2E-gated hooks under `src/lib/store/index.ts`
- Modify: `tasks/todo.md`

1. Write failing Playwright scenarios for a wallet send just below a cap, a send over a cap denied before authentication, an exact authenticated override that queues once, an extension dApp send over a cap, and mobile or desktop strict confirmation according to the existing platform harness.
2. Add a deterministic concurrency scenario showing two near-simultaneous outgoing requests cannot both cross the remaining allowance without separate fresh authentication.
3. Keep any test hook E2E-gated. Do not expose credentials, vault material, or authorization ids in traces, screenshots, console logs, analytics, or persisted public artifacts.
4. Update the issue checklist and add exact commands and outcomes to its Review section.
5. Run `git diff --check`, forbidden-dash and attribution scans, dependency integrity, TypeScript, ESLint, Prettier, i18n lint, locale parity, every affected Jest suite, and Playwright with retries disabled.
6. Read `jest.config.ts`, run the full coverage command serially, and verify statements, branches, functions, and lines each meet the configured 95% global threshold before pushing.
7. Build every affected target. Search the complete logs case-insensitively for errors and verify expected outputs, including the extension manifest and mobile/desktop entry artifacts.
8. Capture fresh desktop and mobile screenshots of the Settings screen and an over-limit challenge. Resize each to at most 1800 px on the long side before opening it. Grade every issue criterion in a literal pass/fail table against the rendered pixels.
9. Run `review-council:rev` explicitly with gpt-5.6-sol max, gpt-5.6-terra max, Opus, and Sonnet. Use one frozen prompt per seat, apply every actionable finding with new commits, and rerun affected verification.
10. Push the reviewed green tree. Open a concise non-draft PR with a standalone `Closes #646` and focused `Reviewers:` line.
11. Use the autopilot loop for review comments, conflicts, and CI. Re-run Council after substantive code changes, wait for every required and affected check to pass, then admin squash merge.
12. Verify the merged PR, squash commit on `main`, and issue #646 closed through the PR link.

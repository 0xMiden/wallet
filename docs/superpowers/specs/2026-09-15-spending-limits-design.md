# Spending Limits Design

## Goal

Add account-scoped, per-asset rolling 24-hour and 7-day spending limits that act as a client-side speed bump across sends, swaps, outgoing bridges, Earn deposits, and dApp sends. A transaction that would exceed a limit may proceed only after a fresh biometric, passcode, password, or platform hardware confirmation.

This design closes wallet issue #646.

## Product Decisions

- Limits use each asset's native amount. Fiat limits are out of scope.
- Windows are rolling 24 hours and 7 days, not calendar periods.
- A limit is a speed bump. A fresh step-up can authorize one exact transaction above it.
- Send, swap, bridged-send, Earn deposit, and dApp send paths all participate.
- Initial enablement, adding a period, raising a cap, removing a cap, or disabling limits requires step-up. A change that only lowers existing caps does not.
- Configuration and spend history are local to one installation. Resetting or reinstalling the wallet resets this protection. The screen states that explicitly.
- This is not an on-chain or Guardian-enforced policy. Anyone with direct access to the unlocked keys and SDK can bypass it.

## Current Behavior

- The four outgoing row constructors have a common account, faucet, amount, type, and initiation timestamp, but each initiation function writes directly to Dexie without a shared policy check.
- Send and swap screens call confirmSensitiveAction, which intentionally allows when biometrics are unavailable or disabled. That is suitable for their existing optional confirmation, but not for a configured spending limit.
- Bridge and Earn orchestration create outgoing rows through the same initiation module but do not have a strict credential gate.
- dApp sends are shown in extension, desktop, or mobile confirmation UI and then queued in the backend. The untrusted page cannot call the initiation function directly.
- The transactions table is shared by foreground and extension service-worker realms. Generic settings helpers are split between localStorage and a platform key-value mirror, so they cannot make a configuration read and transaction insertion atomic.

## Chosen Design

### 1. Keep configuration beside spend history in Dexie

Add a spendingLimits table in the next Dexie schema version. One record is keyed by account and faucet and contains:

- accountId and faucetId;
- optional dailyAmount and weeklyAmount in base units;
- a metadata snapshot containing symbol and decimals for stable settings display;
- an opaque revision regenerated on every saved change;
- updatedAt for diagnostics.

Delete the record when both limits are disabled. The table is local and is not included in wallet backup export. A reinstall, application-data reset, or device change therefore removes both policy and its running history, matching the approved limitation.

Dexie is the source of truth in every realm. Do not maintain a second localStorage or platform-storage copy.

### 2. Define one policy assessment

Create a spending-limit domain module that accepts account, faucet, proposed amount, and current time. It reads the matching configuration and outgoing history, then returns either allowed or a structured step-up requirement.

Outgoing types are send, swap, bridged-send, and earn-deposit. Consume, receive, Earn withdraw, structural account operations, and fees are excluded. Swap counts its offered asset and amount. Bridge and Earn count their Miden source asset and amount.

The running total includes live rows in Queued, GeneratingTransaction, Completed, or Failed state. This reserves value as soon as a transaction is initiated and stays conservative when a failed row may have reached submission before local reconciliation failed. Retrying the same row does not double-count because it remains one row. A new attempt may require step-up, which is the safe response to an uncertain prior submission. Rows restored from a backup are excluded because their contents and timestamps are imported records, not proof of activity on this installation.

For each configured window, include rows whose initiatedAt is strictly later than now minus the window. A row at the exact boundary has expired. The assessment returns current spent amount, proposed total, cap, and resetAt for every breached window so UI copy does not duplicate policy math.

Malformed records, negative amounts, or a failed policy read fail closed with a typed policy-unavailable error. An absent record allows the transaction.

### 3. Make assessment and queue insertion atomic

Replace the four direct Repo.transactions.add calls with one queueOutgoingTransaction helper. Inside one read-write Dexie transaction it:

1. reads the matching spending-limit record;
2. reads and sums eligible outgoing rows for the account and faucet;
3. validates any supplied step-up authorization;
4. adds the new row only when allowed.

This prevents two simultaneous requests from both observing the same below-limit total and crossing the cap without a challenge. Configuration saves also use a Dexie write transaction, so a save and an outgoing insertion have a defined order across foreground and service-worker realms.

The low-level initiation functions remain the final chokepoint. A UI preflight is only for presenting the right interaction before queueing and is never trusted as enforcement.

### 4. Bind step-up to one exact transaction

A successful strict authentication creates a serializable SpendingLimitAuthorization containing:

- a random authorization id;
- account, faucet, and amount;
- the configuration revision observed by the preflight;
- an expiry no more than two minutes after authentication.

The final atomic check accepts it only when every field matches the transaction and current configuration, it has not expired, and its id does not already appear on a transaction row. The inserted row records the authorization id, consuming it in the same transaction. Index that field in the Dexie schema so replay detection is a keyed lookup.

This is not a cryptographic authorization against code already running inside the wallet. Its purpose is to prevent stale, mismatched, or accidentally reused approvals at the trusted wallet boundary. The untrusted dApp receives only its eventual transaction result and never receives the authorization object.

If a preflight was below the limit but another transaction changes the total before insertion, the final check throws the structured step-up requirement and writes no row. Wallet-owned screens keep the draft and present step-up. A dApp request is rejected with clear retry guidance if that rare race happens after its confirmation window has resolved; its retry receives the required step-up before approval.

### 5. Add one strict authentication component

Build a reusable StrictActionAuthentication component and controller used by Spending Limits settings, outgoing wallet flows, and both dApp confirmation surfaces.

- A mobile hardware-protected wallet invokes the platform biometric or device fallback through a hardware unlock.
- A mobile password-protected wallet renders the existing passcode entry.
- Extension and password-protected desktop wallets render a password field.
- A desktop hardware-protected wallet invokes its platform hardware unlock because it has no password protector.
- Cancellation, unavailable hardware, invalid credentials, and probe errors deny. Nothing short-circuits to allow.

Credential verification reuses the existing unlock action. It verifies access to the current vault without changing the account, policy, or transaction. The component returns only success or cancellation and never retains the credential after the attempt settles.

Ordinary below-limit send and swap behavior keeps the existing optional confirmSensitiveAction gate. When a limit is breached, the strict gate replaces that optional prompt so the user is not challenged twice.

### 6. Preflight every outgoing flow and enforce centrally

Wallet send and swap screens assess the exact base-unit amount when the user confirms. A breach opens strict authentication, creates the bound authorization, and queues the row. A non-breach follows the existing optional biometric confirmation.

Outgoing bridge and Earn entry screens perform the same assessment before invoking external quote or intent work. The authorization is threaded through bridge and Earn callbacks to the final initiation call. It is not consumed until the row is atomically inserted. If external preparation exceeds the two-minute lifetime, final insertion rejects and the user authenticates again rather than silently using stale authority.

DApp send handlers assess after validating and formatting the requested transaction but before opening wallet confirmation UI. A breached assessment adds the structured limit details to the confirmation payload. Approve transitions to strict authentication before resolving the confirmation. The result returns the bound authorization only to the wallet backend, which passes it to initiateSendTransaction. Both the extension ConfirmPage and the mobile/desktop DappConfirmationModal implement the same contract.

All four initiation functions still reject an over-limit call that bypassed or raced the preflight. Incoming and background consume paths do not call the policy helper.

### 7. Add an account-scoped Settings screen

Add Spending limits under the Security group. The screen combines current balance assets with already configured records, so a zero-balance asset with an existing limit remains editable.

Each asset row shows symbol, daily native limit, and weekly native limit. Inputs accept positive decimal values up to the asset's known decimals and convert losslessly to base-unit bigint. Unknown-decimal assets cannot be configured until metadata resolves. Empty means that period is disabled.

Save validates the whole draft. If a change enables a record or period, raises a cap, removes a cap, or disables the record, strict authentication runs before the write. A draft that only lowers existing caps saves directly. Mixed changes use the stricter rule.

The screen includes permanent copy that limits and running totals are local and are not an on-chain restriction. Transaction breach UI names the asset, amount over the cap, breached periods, reset time, and the choices to authenticate or cancel.

## Concurrency and Failure Invariants

1. No outgoing row is inserted until the policy check and authorization validation succeed in the same Dexie transaction.
2. Two concurrent below-limit requests cannot both spend the same remaining allowance.
3. An authorization is exact, short-lived, configuration-revision-bound, and consumed once.
4. Changing the asset, amount, account, or configuration after authentication invalidates the authorization.
5. A storage or policy parse failure never turns an active protection into an implicit allow.
6. Every outgoing producer reaches the same initiation chokepoint.
7. Restored transaction records cannot create or consume a local spending allowance.
8. A declined or failed authentication writes neither configuration nor a transaction row.
9. Limits never claim to provide on-chain enforcement.

## Test Strategy

### Policy and persistence

- Per-account and per-faucet isolation.
- Rolling 24-hour and 7-day boundaries, including an exact-boundary row.
- Combined daily and weekly breaches with correct resetAt values.
- Inclusion of queued, generating, completed, and failed live rows.
- Exclusion of incoming, consume, Earn withdraw, structural, and restored rows.
- Concurrent initiation serialization.
- Missing, malformed, and storage-error behavior.
- Configuration creation, lowering, raising, period removal, disable, and revision changes.

### Authorization

- Exact binding to account, faucet, amount, and configuration revision.
- Expiration and one-time consumption.
- No row on absent, stale, mismatched, replayed, or declined authorization.
- A race between preflight and insertion returns a typed step-up requirement.

### Integration

- Send, swap, Agglayer bridge, Epoch bridge, and Earn deposit thread authorization to the final initiation function.
- DApp send confirmation displays breach detail and cannot resolve approved before strict authentication succeeds.
- Both extension and mobile/desktop confirmation surfaces deny unavailable or failed authentication.
- Settings require step-up for enable, add-period, raise, remove-period, and disable, but not a pure lowering.
- Incoming and auto-consume paths remain unaffected.

### Visual and end to end

- Desktop and mobile settings layouts show per-asset inputs and the local-only disclosure.
- Desktop and mobile over-limit flows show the strict credential step and clear reset copy.
- Extension dApp send above a configured cap cannot queue before password confirmation.
- Mobile dApp send above a configured cap cannot queue before biometric or passcode confirmation.
- Capture fresh screenshots at no more than 1800 pixels on the long side and judge every issue criterion against the rendered pixels before declaring the UI complete.

## Delivery

One wallet PR contains the schema, policy, strict-auth component, Settings screen, all outgoing integrations, tests, and documentation copy. Its body contains a standalone Closes #646.

Run Review Council after implementation, apply every actionable finding, re-run all gates, push, babysit CI to green, and admin squash merge.

## Non-Goals

- On-chain account-component or Guardian enforcement.
- Fiat-denominated limits.
- Cross-device policy synchronization or chain-history reconstruction.
- Recipient allowlists or category budgets.
- Blocking all spends until a window resets.
- Assigning an amount to arbitrary custom execute requests that do not expose a trustworthy outgoing asset summary.

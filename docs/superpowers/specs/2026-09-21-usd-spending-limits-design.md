# USD Spending Limits Design

## Goal

Replace the per-asset, native-amount spending limits with a single account-scoped cap denominated in US dollars over one rolling 24-hour window. A user sets one number and it governs every asset the wallet can price.

This supersedes the per-asset and multi-window parts of `2026-09-15-spending-limits-design.md`. Everything that document decided about step-up authentication, the atomic assess-then-insert, and the one-time authorization contract carries over unchanged and is not restated here.

## Product Decisions

- One cap per account, in USD, covering every asset at once. The per-asset model is removed, not layered over.
- One rolling 24-hour window. The 7-day window is removed. A second window can be added later; going from two to one after users have configured both cannot be done quietly, so it happens now.
- A transaction's dollar value is computed when it is queued and stored on its row. Spend already inside the window is never revalued.
- Coverage is whatever the price feed knows, which today is ETH, BTC and USDC. An asset with no price contributes zero and is therefore uncapped. That includes MIDEN. The settings screen states this plainly rather than implying the cap is total.
- Coverage is keyed by metadata symbol, which the faucet controls, so a faucet that calls itself USDC consumes the user's allowance. Accepted: it costs allowance, not funds, and the alternative needs a canonical faucet-id allowlist the repo does not yet have.
- A covered asset whose price cannot be resolved fails closed. Wallet-owned flows present the challenge and accept one exact step-up; dApp requests are refused.
- Limits remain local to one installation. There is no cross-device synchronization and none is implied by the UI.
- Existing per-asset records are dropped on upgrade without a notice.

## Current Behavior

- `SpendingLimitConfiguration` is keyed `[accountId + faucetId]`, carries optional `dailyLimit` and `weeklyLimit` in base units, and an asset snapshot for display. Row existence is the enabled flag.
- `assessSpendingLimit` recomputes spend per faucet from the transactions table on every call. There is no stored counter. `MAX_WINDOW_SECONDS` is 7 days and doubles as the bound on the history read.
- `queueOutgoingTransaction` is the single chokepoint: it re-reads policy, re-assesses, validates the authorization and inserts the row in one Dexie read-write transaction. It refuses a row that breaches more than one faucet, because an authorization binds to exactly one faucet.
- A dApp custom or execute request is valued from `spentAssetTotals`, the per-faucet outgoing totals captured at approval-time dry run. A request whose outgoing value cannot be determined is refused whenever the account has any limit configured.
- Prices exist only in the frontend: `lib/prices` fetches Binance `/ticker/24hr` under SWR and mirrors into Zustand. Nothing under `lib/miden/back` imports it. `KNOWN_SYMBOLS` holds three entries and matching is by symbol string. `getTokenPrice` returns a one-dollar default for anything unknown, which is why the home-screen portfolio total is inflated.

## Chosen Design

### 1. One account-scoped record

`spendingLimits` becomes keyed by `accountId` alone:

- `accountId`;
- optional `limit` in micro-dollars;
- an opaque `revision` regenerated on every saved change;
- `createdAt` and `updatedAt`.

`faucetId` and the asset snapshot leave the record, the assessment, the breach and the authorization. Deleting the record is still how a limit is disabled. The record stays out of backup export and is still cleared by wallet reset.

### 2. USD is micro-dollars in bigint

One dollar is 1,000,000. Every cap, running total, breach field and stamped row value is a `bigint` in that unit, so the canonical decimal-string codec, the amount regex and the assessment's arithmetic invariants all apply unchanged. No floating-point value is ever stored or compared.

A price crosses into that world once, at the edge:

```
priceMicro = BigInt(Math.round(price * 1_000_000))
valueMicro = ceilDiv(amountBaseUnits * priceMicro, 10n ** BigInt(decimals))
```

Rounding is up, so a charge against the allowance is never understated. A price that is not finite, not positive, or whose asset has unknown decimals is not a price; see section 3.

### 3. Price resolution is authoritative and realm-agnostic

Enforcement runs in the backend, which on the extension is the service worker. A price supplied by the caller alongside the request is not acceptable, because declaring a zero price would be the bypass. So price resolution moves to a module both realms can call, sitting on the existing Binance fetch, with a small Dexie-backed cache of `{ symbol, priceMicro, fetchedAt }`.

The existing frontend provider keeps its SWR schedule and writes through to that cache. The backend reads the cache and refreshes it when the entry is older than the freshness bound. Resolution happens before the Dexie read-write transaction opens, never inside it, because network work must not run under the write lock.

`resolvePrice` returns exactly one of three things, and the distinction is the whole safety story:

| Case | Result |
| --- | --- |
| Symbol outside the coverage list | not covered: contributes zero |
| Covered, cached entry within the freshness bound | `priceMicro` |
| Covered, but no fresh entry, or unknown decimals | unavailable |

`getTokenPrice` must not appear on this path. Its one-dollar default answers for tokens nobody priced, which on a cap would charge arbitrary assets at a dollar a unit. The new lookup reports absence explicitly.

Unavailable raises a typed `SpendingLimitPriceUnavailableError`. Wallet-owned flows treat it as a breach: the challenge opens and one exact step-up authorizes the transaction. dApp paths map it to the existing `NOT_GRANTED` retry message, matching how a dApp request with undeterminable outgoing value is already refused.

### 4. Stamp value at queue time

`ITransaction` gains `spentUsd`, the micro-dollar value of everything the row sends, written when the row is inserted. It needs no index; the history read is already bounded by the `initiatedAt` index.

`queueOutgoingTransaction` keeps its signature in terms of faucet and base-unit amount. It resolves each spend to micro-dollars first, sums them, and then opens the same read-write transaction to assess and insert. A row that moves several assets, which is only the dApp custom and execute path, sums to one figure across its `spentAssetTotals`, with uncovered assets contributing zero and any unavailable price raising before the transaction opens.

That summation deletes two refusal branches. `queueOutgoingTransaction` no longer needs to refuse a row breaching more than one faucet, and `customSpendingLimitState` no longer needs its multi-faucet refusal, because one authorization now binds to one dollar figure rather than one asset. The refusal for undeterminable outgoing value stays exactly as it is.

`spentAssetTotals` keeps being written. It is the record of what was priced, and it is what makes a stamped value auditable after the fact.

### 5. Assessment collapses to one window and one number

`assessSpendingLimit` takes an account, a proposed micro-dollar amount and a time, and returns at most one breach carrying `spent`, `proposedTotal`, `limit`, `overBy` and `resetAt`. `SpendingLimitPeriod`, the breach array and its ordering rule all go.

Row inclusion is unchanged: the outgoing types, the live statuses including `Failed`, the exclusion of rows restored from backup, the half-open window boundary, and the clamping of future-dated rows. Only the amount extraction changes, from per-faucet matching to reading `spentUsd`. A row without that field contributes zero, which is what every row written before this change looks like; combined with dropping existing records, an upgraded wallet starts from a clean window.

`MAX_WINDOW_SECONDS` becomes 24 hours, which also shrinks the bounded history read. The fail-closed asymmetry stays: a row too old to matter is skipped even if malformed, a row inside the window with an unusable value throws.

### 6. Enforcement points keep their contracts

The five initiate paths and both dApp paths keep their existing calls and thread the same authorization; only the unit changes. `hasSpendingLimits` becomes a per-account lookup. The frontend preflights in send, swap and Earn deposit keep their staleness guards. Incoming, consume, Earn withdraw and structural operations remain outside the policy, and fees remain uncounted.

### 7. Settings and challenge screens

The settings screen stops enumerating assets. It renders one currency input for the daily cap, keeps the step-up rule for any weakening change, keeps the revision conflict check, and keeps the disclosure that limits are local and not an on-chain restriction. It gains one line naming what the cap does not cover: assets the wallet cannot price, MIDEN among them, do not count toward it.

The challenge drawer shows the proposed dollar value, the cap, the amount over, and the reset time. Asset symbol and amount stay in the surrounding transaction UI, which already shows them.

Roughly eight of the twenty-one existing i18n keys retire and three arrive, across fourteen locales in both formats. Translation lands through the existing CI job.

### 8. Schema migration

Dexie version 1.8 drops `spendingLimits` and recreates it keyed by `accountId`, and adds nothing else; `spentUsd` needs no index. Dropping the table is the migration: no `upgrade` step, no backfill, consistent with the fail-closed parse-on-read posture already in the module.

## Concurrency and Failure Invariants

1. Price resolution happens before the write transaction opens; no network call runs under the Dexie write lock.
2. No outgoing row is inserted until assessment and authorization validation succeed in that one transaction.
3. Two concurrent below-limit requests still cannot both spend the same remaining allowance.
4. An authorization binds to account, exact micro-dollar amount and configuration revision, expires in two minutes, and is consumed once.
5. A covered asset whose price is unavailable never becomes an implicit allow.
6. An uncovered asset contributes zero deterministically, on every path, and the UI says so.
7. A stamped value is immutable; nothing revalues a row after insertion.
8. Conversion rounds up, so a stamped value never understates the dollars that left the account.

## Test Strategy

### Policy and persistence

- Per-account isolation with no faucet dimension.
- The 24-hour boundary, including an exact-boundary row.
- Rows without `spentUsd` contributing zero.
- Multi-asset rows summing across `spentAssetTotals`.
- Inclusion of queued, generating, completed and failed rows; exclusion of incoming, consume, withdraw, structural and restored rows.
- Concurrent initiation serialization, reusing the existing race hook.
- Configuration create, lower, raise, disable and revision conflict.

### Pricing

- Conversion exactness at several decimal scales, including the ceiling behavior at one micro-dollar.
- Uncovered symbol contributes zero; covered symbol with a fresh price converts; covered symbol with a stale, missing or unusable price raises.
- Unknown decimals raise rather than contributing zero.
- The cache is read, and a stale entry triggers exactly one refresh.
- `getTokenPrice` and its one-dollar default appear nowhere on the enforcement path. Assert this directly, since the defect it would cause is silent.

### Integration

- All five initiate paths and both dApp paths carry a dollar figure and thread the authorization.
- A dApp request whose outgoing value cannot be determined is still refused when a limit exists.
- A price-unavailable failure challenges in wallet flows and returns `NOT_GRANTED` to a dApp.
- Settings require step-up to raise or remove the cap, not to lower it.

### End to end

- The existing local spec's journey re-expressed in dollars, keeping its step order, since that order is the assertion.
- The iOS spec's render and challenge assertions against the single-input screen.
- Each new assertion is proven by a mutation that should break it, with the prediction written before the run.

## Delivery

One wallet PR carrying schema, policy, the price module, settings and challenge UI, every integration, tests, locales and a CHANGELOG line. The CHANGELOG entry goes under a heading whose version is strictly higher than the latest published release and still marked TBD.

Run Review Council after implementation, apply every actionable finding, run the repo's full gate list, then push and take CI to green before merging.

## Non-Goals

- Pricing MIDEN, or extending the feed beyond the symbols it already carries.
- A faucet-id allowlist for coverage.
- Historical price lookup, or any revaluation of spend already recorded.
- Cross-device synchronization of policy or history.
- Currencies other than US dollars. The fiat-currency module stays the stub it is.
- On-chain or Guardian-enforced limits.
- Correcting the home-screen portfolio total, which counts unpriced assets at one dollar per unit through `getTokenPrice`. It is a real defect and it is adjacent, but it belongs to its own change.

# Weekly GC allowance on Ahmad's Arcade design

## Stack and scope

This PR is stacked directly on `arcade-design-polish` at `32855c21090234decc4d59bc17259d2bc9e42d71` (wallet #1650), whose base is `brian/native-bread-arcade` at `b09b93074a72c75d82d039a7ae52a821ce7e63c7` (#1512). Neither branch is changed by this work. The alternative main-based #1692 was closed after the stacked replacement #1693 was verified, with an explicit superseded link and no comment. Its competing catalog layout is not carried over.

The new card sits above the existing featured carousel. Featured artwork, Details/Open footer, details drawer, Coins/Activity pills, suggested-game list, dashed Coins empty state and pinned Browse games footer retain #1650's components and styling. Only the global Rankings shortcut/route and the old balance-snapshot/sample-ranking flow are removed. GC is transferable; there is no transfer restriction or game allowlist.

At inspection, main was `7ad5865c599ea4c1f54063673d01069db02e9c12`, and main/design had 150 main-only and 13 design-only commits since common ancestor `99222f2eec702b5e5fd562f2d8b92fc9b00e0f74`. The old stack still needs coordinated reconciliation with main before integration. This PR does not rebase or merge the stack or claim parity with current main. Its card reads the effective network through the existing config subscription, because the older stack's `useNetwork` still reads the legacy selection.

The inherited catalog migration depends on **wallet-config #10** being reviewed/published before the corresponding reader ships. This PR leaves the catalog schema/source/cache, URLs and publishing configuration unchanged. See the underlying #1512 verification guide and its release gates.

## Approved behavior

- Partner Mainnet: explicit Claim 10 GC per account per calendar week, reset Monday 00:00 UTC, regardless of existing balance.
- Unspent GC carries over. Missed weeks do not accumulate claims. No paid top-up.
- Play, replay and social sharing are free, regardless of GC balance. Sharing is not a verified leaderboard submission and must not be gated by GC.
- Only submitting a result to a per-game leaderboard costs 1 GC plus user-funded network fees. Users also fund claim network fees; there is no app-funded subsidy. Each game owns scoring, rankings and rewards. Protocol-specific fee mechanisms belong to #1691.

This wallet change communicates that game-integration standard; it does not implement social integrations or a game's submission contract. Existing game launch stays independent of GC availability and wallet approval.

## Production integration gate: wallet #1691

https://github.com/0xMiden/wallet/issues/1691 tracks the authoritative weekly claim backend and production issuance. No approved GC identity/balance/claim configuration is supplied here. `unavailableWeeklyClaimService` always returns unread balance and unavailable claims; no production success simulation, faucet call, signing, deployment or transaction is added. Coins also retains its truthful unavailable state until that integration lands.

Before activation, approve canonical asset/issuer/network/decimals, authenticated account scope, operational ownership, atomic weekly eligibility, mint authority, replay/idempotency across devices and reinstalls, fee estimation and explicit user-funded wallet approval, receipt consumption/finality and recovery. A normal transferable token and a client calendar do not enforce weekly eligibility. The calendar helper is display-only.

`read()` must recover pending operations for the account/week and must never return eligible while an earlier write may still arrive. `submit()` must be idempotent and show actual user-funded fee review/approval before writing. `claimed` means confirmed GC delivery/receipt, while `failed` is a verified terminal failure safe to retry. Lost responses stay pending and block another submit; read failures cannot clear that uncertainty. Canonical balances are never increased optimistically. Account/network changes remount the controller and page return refreshes it. Typed interfaces define these obligations, not an implemented production authority.

## Review fixtures and checks

`screenshots/arcade-stacked` contains actual `ArcadeLanding`, carousel, drawer/card components and `TabRootHeader` at 390px, in light/dark, eligible/claimed/unavailable. Visible banners identify fictional account eligibility, balance and game data. Only wallet data, native navigation/back/haptics and unused barrel boundaries are isolated by `scripts/arcade-stacked-review`; rendering uses the production components. These screenshots do not establish authenticated full-shell, native-device or chain acceptance. The fixture query exists only in that harness, not the wallet.

```sh
node_modules/.bin/vite --config scripts/arcade-stacked-review/vite.config.mjs --configLoader native
node scripts/arcade-stacked-review/capture.cjs
node scripts/arcade-stacked-review/interactions.cjs
```

The capture checks Claim availability and horizontal overflow/page errors. Interaction checks at 360/390/640px in both themes cover disabled production-fixture claims, removed global Rankings, preserved details policy/host, exact configured game launch despite unavailable GC, and no horizontal overflow/page errors. Unit tests cover the state machine, unknown outcomes, retries, duplicate clicks, UTC boundaries, effective network/account scope, routes, catalog discovery, carousel and details behavior.

English source/Chrome message entries are included. Translation review, full CI/coverage, native iOS/Android/Tauri/device acceptance and a stack refresh against main remain release gates. No release build is installed, merged or deployed by this task.

The two `ahmad-base-*.png` images were rendered from an untouched archive of `32855c21090234decc4d59bc17259d2bc9e42d71` with the same isolated harness/catalog, at 390px in both themes. Compare them with `eligible-*.png` to see only the added allowance section/policy copy and removed global ranking shortcut; no base source was edited to make those images.

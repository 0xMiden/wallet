# Weekly GC allowance integration

## Stack and scope

The local stack is #1512 → #1650 → #1693, reconciled with wallet main
`6437d4aa2`. Each layer retains its parent's commits and contains its own change.
The catalog remains `0xMiden/wallet-explore`: published tools/defi categories map to
Finance, games to Arcade, and nft/learn to Others in the reader. Published schemas,
URLs, cache identities and version floors remain unchanged. Wallet-config supplies
separate startup policy; no catalog migration or wallet-config #10 is required.

The allowance card lives only in Coins, reached through the Coins shortcut.
Discovery retains the featured carousel, Details/Open actions and game list, with
Coins and Activity shortcuts. Global Rankings and the balance-snapshot/sample
ranking flow are removed. Coins retains its native header, privacy explanation and
pinned Browse games footer. Launching a game does not require GC availability.

## Intended protocol and rollout

Testnet comes first. Production issuance and any Mainnet rollout require the
integration gate below; this change does not activate either. The intended weekly
allowance is 10 GC per authenticated account per calendar week, resetting Monday
00:00 UTC regardless of balance. Unspent GC carries over; missed weeks do not
accumulate claims. There is no paid top-up or transfer restriction.

Play, replay and social sharing are free regardless of GC balance. A per-game
leaderboard submission costs 1 GC plus user-funded network fees; claims also
require user-funded network fees. Each game owns its scoring, rankings and rewards.
This wallet change does not implement game contracts or social integrations.

## Integration gate: wallet #1691

`unavailableWeeklyClaimService` always returns an unread balance and unavailable
claims on every network. The production UI disables Claim 10 GC and offers Check
status. No faucet, authenticated issuer, signing, deployment or transaction is
connected. The current weekly rules copy still names Partner Mainnet as a design
rule; it is not evidence of activation or a change to the Testnet-first rollout.

Before activation, define canonical asset/issuer/network/decimals, authority and
operational ownership, authenticated account scope, atomic weekly eligibility,
idempotency across devices/reinstalls, fee estimation and explicit wallet approval,
confirmed receipt delivery, and recovery. A transferable token and client calendar
do not enforce weekly eligibility. The calendar helper is display-only.

`read()` must recover pending operations for the account/week and never return
eligible while an earlier write may still arrive. `submit()` must be idempotent.
`claimed` requires confirmed delivery; `failed` means a verified terminal failure
safe to retry. Lost responses remain pending and block another submit; failed
reads cannot clear that uncertainty. Balances are never increased optimistically.
Account/network changes remount the controller; page return refreshes it. These
interfaces specify future obligations, not a working claim authority.

## Verification

Current local verification on the reconciled stack: 14 focused suites / 417 tests,
full TypeScript checking, changed-source ESLint and i18n lint, the normal mobile
build, and published wallet-explore snapshot parity passed. Tests cover all five
claim states, busy actions, uncertain responses, verified-failure retries, duplicate
clicks, UTC boundaries, remount recovery, account/network scope, native routes,
catalog grouping, configured launch, carousel/details and history behavior.

The real-extension loopback harness is described in
[Explore verification](explore-config-verification.md). It uses published
wallet-explore catalogs plus separate wallet-config startup policy fixtures,
production-mode UI and an explicit E2E/mock wallet. Its assertions cover exactly
Coins/Activity shortcuts, absence of global Rankings, unavailable balance/Claim,
status refresh, pinned Browse games and preview-query isolation. It does not
establish real accounts, authentication, native devices, balances or chain writes.

The separate design fixture is useful for reviewing eligible/claimed/unavailable
layouts, without connecting production services:

```sh
node_modules/.bin/vite --config scripts/arcade-stacked-review/vite.config.mjs --configLoader native
node scripts/arcade-stacked-review/capture-coins.cjs
node scripts/arcade-stacked-review/interactions.cjs
```

Its banners identify fictional account eligibility, balances and games. Fixture
queries exist only in that harness. Existing `screenshots/arcade-coins` captures
and `screenshots/arcade-stacked/historical-comparisons` are earlier design evidence,
not captures of the reconciled current extension. Current browser captures live in
`screenshots/arcade-integration/1693-*`; detailed reports remain local harness
artifacts. Full CI/coverage, translation review, native-device acceptance and live
claim/receipt acceptance remain unverified. No merge, push or deployment is implied.

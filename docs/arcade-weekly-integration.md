# Arcade weekly allowance: UI and integration boundary

This change starts from main at `7ad5865c599ea4c1f54063673d01069db02e9c12`. Draft #1512 was inspected for discovery behavior and Bread styling, but was not merged or rebased: it predates substantial changes on main and includes superseded ranking pages and a different catalog endpoint. This PR leaves that branch untouched.

Explore presents All, Finance, Arcade and Others. Its existing validated `wallet-explore` catalog source, cache/floor checks, platform gates, network selection, recents and exact dApp-browser launch callback stay in use. Current published `tools` and `defi` entries appear in Finance, `games` in Arcade, and `nft`/`learn` in Others; All still aggregates everything. This is a compatible presentation grouping, not the unpublished wallet-config category/source migration in #1512. A later source migration must coordinate publication and snapshots separately.

## Product rules

- GC is transferable; no transfer restrictions or game allowlist.
- No global leaderboard. Games own rankings from game results, scoring and rewards.
- Play/replay is free. Posting a result always costs 1 GC.
- Users fund all network fees for claims and posting; no app-funded fee subsidy. Protocol-specific fee mechanisms are left to #1691.
- Partner Mainnet: explicitly claim 10 GC per account each calendar week, resetting Monday 00:00 UTC, regardless of GC balance. Unspent GC carries over; missed weeks do not stack. No paid top-up.

## Production gate: wallet #1691

https://github.com/0xMiden/wallet/issues/1691 tracks the production faucet and authoritative weekly claim backend. There is no approved GC asset, balance reader or weekly claim endpoint configured in this PR. Production uses `unavailableWeeklyClaimService`: balance is unread, Claim is disabled, and checking status cannot simulate success. No issuance, network transaction, fee sponsorship, contract deployment or release installation occurs here.

Before replacing that service, agree canonical issuer/asset/network/decimals, authenticated account scope and owner; implement atomic authoritative weekly eligibility and replay/idempotency handling across devices/reinstall; define user-funded fee estimation and wallet approval; and verify mint delivery, receipt consumption, finality and recovery. The weekly calendar helper is display-only and must never authorize minting. GC transferability does not establish claim eligibility enforcement.

`WeeklyClaimService.read` must recover any pending operation for the account before returning eligible. It must not return eligible while an earlier write can still arrive. `submit` must be idempotent for account/week, and coordinate wallet review/approval before a user-funded write. `claimed` means confirmed GC delivery/receipt; `failed` means verified terminal non-delivery and safe retry. A timeout, lost response or unavailable reconciliation stays pending, blocks another claim and allows a status read. Balance is supplied by the canonical reader, never increased optimistically. Account/network changes remount the controller; returning to the active page refreshes its state. Production identity/network comes from `useAccount`/`useNetwork`.

Live fee estimates, insufficient native fee balance, approval/cancellation, RPC/network validation, issuance permissions and finality are prerequisites for the adapter in #1691, not implemented transaction flows in this UI PR. No existing token is inferred to be GC by its symbol.

## Review evidence

The six PNGs in `screenshots/arcade-weekly` render the actual `ArcadeAllowanceCard` and `ArcadeGameCatalog` plus the existing `TabRootHeader`, at 390px width in light/dark. Every image explicitly labels fictional eligibility, balance and game data. Eligible/claimed screenshots are component fixtures, not evidence of live minting. Unavailable shows the production integration boundary. They were visually inspected; the capture checks no horizontal overflow/page errors and verifies Claim availability.

Reproduce with dependencies installed:

```sh
node_modules/.bin/vite --config scripts/arcade-review/vite.config.mjs --configLoader native
# In another terminal:
node scripts/arcade-review/capture.cjs
```

This isolated harness has its own entry in `scripts/`; it is not a wallet route or query switch. It renders real components with fixture props and replaces device haptics only in the harness. It does not verify the full authenticated shell, physical devices, live chain actions or native platforms. The launcher tests cover category switching, search retention, recents and the existing open callback.

Run focused checks:

```sh
node_modules/.bin/jest src/lib/i18n/key-coverage.test.ts src/lib/arcade src/lib/dapp-browser src/lib/explore-config src/app/pages/Browser/DappLauncher --runInBand --coverage=false
```

English keys and Chrome message entries are included; translations need normal translation review. Native iOS/Android/Tauri acceptance, full CI/coverage and production backend acceptance remain release gates.

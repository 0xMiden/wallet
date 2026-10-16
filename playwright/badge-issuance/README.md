# Badge issuance verification

Run from the repository root:

```sh
yarn test --runInBand src/lib/badges
yarn playwright test --config playwright/badge-issuance/playwright.config.cjs
```

The browser suite starts a loopback-only Vite fixture, renders the actual Profile and My badges components, and runs the actual issuance controller against a separate `BreadBadgeIssuanceTest` IndexedDB database. Account data, chain confirmations, swap approval/lineage verdicts and the storage adapter are fixtures. Settings panels are stubbed; the original Settings menu is rendered from its real source. No production test hooks are added.

The manager integration suite uses the real repository database schema under fake IndexedDB and the actual production manager, mocked SDK boundaries and storage adapter. It checks the chain-confirmation and swap-lineage adapters, not just controller predicates. Other tests check transaction queue provenance and schema upgrades.

These are deterministic event/integration tests, **not evidence of a live Mainnet transaction**. No test signs, submits, bridges, swaps, claims funds, authenticates an existing wallet, or reads its data. Playwright screenshots use a fixture account.

## Supported issuance

Progress is private, wallet-wide and device-local. The app-root manager reconciles while unlocked, including events missed while the app was closed. DB commits wake it; a 15-second foreground retry covers confirmations that arrive after the local row changes. A read or persistence failure never means success.

| Badge         | Required evidence                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First Send    | Wallet-created outgoing transfer with positive amount, a distinct recipient outside this wallet, a queue-time Mainnet stamp and a committed SDK transaction verdict. Recipient acceptance is not required. Opaque dApp requests are excluded.                            |
| First Deposit | Tracked bridge in `received` phase plus the matching locally completed claim, exact delivered note/asset/amount, and a committed Miden claim transaction. Source payment and bridge `ready` are insufficient.                                                            |
| First Swap    | Approved current solver pair, completed order, non-overlapping completed payback claims covering the requested output, every transaction committed, and a fully-filled lineage with zero remainder. Partial fills, expiry reclaims and unclaimed outputs do not qualify. |

First Receive, Recovery Checked and Miniapp Explorer show **Not available yet** and cannot be issued. Native receives need reliable provenance that cannot race late bridge classification; recovery needs account-specific authenticated verification; miniapps need an approved completion signal. Opening a page or connecting an app never counts.

## Persistence boundaries

- Storage contains only deduplicated badge identifiers, never transaction details, amounts, addresses, dates, secrets or analytics identifiers.
- Switching accounts, closing/reopening the app, and duplicate events retain one earned state.
- Wallet reset removes progress. Reset/unmount invalidates in-flight work.
- Queue-time network provenance is indexed additively in schema 3.1. Old rows are not retroactively relabeled Mainnet. Imported/recovered history cannot earn badges.
- Developer endpoint overrides cannot issue Mainnet badges.
- Reinstall, recovery-file and cross-device carryover are not promised. Stored progress is cosmetic local state, not a cryptographic credential, collectible token, reward or public attestation.

For native visual review, build and install without erasing app data, then have the user unlock the existing wallet. The fixture's earned screenshots must not be presented as awards earned by that wallet.

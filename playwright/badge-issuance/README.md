# Badge issuance verification

Run from the repository root:

```sh
yarn test --runInBand src/lib/badges src/lib/miden/balance-snapshot
yarn playwright test --config playwright/badge-issuance/playwright.config.cjs
```

The browser suite starts a loopback-only Vite fixture, renders the actual Profile and My badges components, and runs the actual issuance controller against a separate `BreadBadgeIssuanceTest` IndexedDB database. Account data, balance snapshots, chain confirmations, swap approval/lineage verdicts and the storage adapter are fixtures. Settings panels are stubbed; the original Settings menu is rendered from its real source. No production test hooks are added.

The manager integration suite uses the real repository database schema under fake IndexedDB and the actual production manager, mocked SDK boundaries and storage adapter. It checks the chain-confirmation and swap-lineage adapters, not just controller predicates. Other tests check transaction queue provenance and schema upgrades.

These are deterministic event/integration tests, **not evidence of a live Mainnet transaction**. No test signs, submits, bridges, swaps, claims funds, authenticates an existing wallet, or reads its data. Playwright screenshots use a fixture account.

## Supported issuance

Progress is private, wallet-wide and device-local. The app-root manager reconciles while unlocked, including events missed while the app was closed. DB commits and landed balance updates wake it; a 15-second foreground retry covers confirmations that arrive after the local row changes. A read or persistence failure never means success.

| Badge         | Required evidence                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First Send    | Wallet-created outgoing transfer with positive amount, a distinct recipient outside this wallet, a queue-time Mainnet stamp and a committed SDK transaction verdict. Recipient acceptance is not required. Opaque dApp requests are excluded.                            |
| First Deposit | Tracked bridge in `received` phase plus the matching locally completed claim, exact delivered note/asset/amount, and a committed Miden claim transaction. Source payment and bridge `ready` are insufficient.                                                            |
| First Swap    | Approved current solver pair, completed order, non-overlapping completed payback claims covering the requested output, every transaction committed, and a fully-filled lineage with zero remainder. Partial fills, expiry reclaims and unclaimed outputs do not qualify. |

First Receive, Recovery Checked and Miniapp Explorer show **Not available yet** and cannot be issued. Native receives need reliable provenance that cannot race late bridge classification; recovery needs account-specific authenticated verification; miniapps need an approved completion signal. Opening a page or connecting an app never counts.

Incoming awards (Deposit and Swap) additionally require the consumed funds to be reflected in the wallet balances. The balance reader captures the account nonce under the WASM lock from the **same account object** as the vault assets. This provenance is attached to the exact final rows landed in Zustand, after metadata/override processing. The extension carries the original worker provenance through its cached sync payload rather than treating its arrival time as freshness.

The verifier matches each consume's chain transaction to its recorded submit attempt, requires an unambiguous initial nonce, and waits for a Mainnet balance snapshot for that account/asset at nonce `initialNonce + 1` or later. An arbitrary positive balance or recent fetch timestamp is not proof. Old/missing provenance, a different account/network, unknown token scale, a stale nonce or replaced balance rows all fail closed. Later spending does not undo an earned milestone. No new sync, claim, signing or transaction is initiated by this check.

Playwright explicitly separates confirmed consumption from balance landing: the badge remains locked between the events, rejects stale/wrong-account/Testnet snapshots, and unlocks only on the matching snapshot. The screenshots are fixture evidence, not live Mainnet evidence.

## Persistence boundaries

- Storage contains only deduplicated badge identifiers, never transaction details, amounts, addresses, dates, secrets or analytics identifiers.
- Switching accounts, closing/reopening the app, and duplicate events retain one earned state.
- Wallet reset removes progress. Reset/unmount invalidates in-flight work.
- Queue-time network provenance is indexed additively in schema 3.1. Old rows are not retroactively relabeled Mainnet. Imported/recovered history cannot earn badges.
- Developer endpoint overrides cannot issue Mainnet badges.
- Reinstall, recovery-file and cross-device carryover are not promised. Stored progress is cosmetic local state, not a cryptographic credential, collectible token, reward or public attestation.

For native visual review, build and install without erasing app data, then have the user unlock the existing wallet. The fixture's earned screenshots must not be presented as awards earned by that wallet.

# Inside the Miden Wallet Test Lab

**Who this is for:** engineers who want to understand how the wallet is tested end to end — no prior Miden knowledge assumed.

The Miden wallet moves real value across two very different systems: a **privacy-focused blockchain (Miden)** and **Ethereum**. Cross-chain money movement is unforgiving — a note delivered in the wrong shape, signatures gathered in the wrong order, or a bridge that reports success without settling can each cost real funds. Verifying that the wallet gets this right, automatically and on every change, is the job of the end-to-end (E2E) test harness described here.

The harness is organized around a single principle:

> **Run the real thing; stand in only for what can't be run in CI.**
>
> The blockchain is never mocked. On every pull request, the desktop suites boot a genuine Miden network in CI — the same node software real users rely on — seed it from a fresh genesis, and drive the actual wallet app through its real screens against it. The post-merge and mobile suites run that same app against the genuine public Miden test networks. A real security co-signer and a real (local) Ethereum node are added for the flows that need them. The only components stood in for are a handful of **third-party services hosted on external servers** — and those stand-ins are built to match the real services' addresses and responses closely enough that the app cannot tell the difference.

The rest of this page walks through each group of tests: what it verifies, which components take part, and the design choices worth noting.

---

## The cast of characters

A short glossary so the diagrams read clearly:

| Piece | In plain terms |
|---|---|
| **The wallet app** | The actual shipped app — the Chrome extension or the iOS app — built with a few hidden test hooks (stripped from real releases) so the tests can click buttons and read state. Otherwise unchanged. This is what's being tested. |
| **A "note"** | How money moves on Miden. Think of it as a sealed envelope of coins addressed to someone. Notes can be **public** (visible on the chain) or **private** (delivered off to the side). |
| **Proving** | Miden hides transaction details, so instead of *showing* the network what happened, your device computes a cryptographic proof that it followed the rules. That computation — "proving" — is expensive, so it can run on your own machine or be handed to a remote **prover**. |
| **The Miden blockchain** | The privacy chain the wallet lives on — the genuine node software, either booted fresh for the test or the real public test network. |
| **The guardian** | An optional **security co-signer**. A "guardian" account needs *two* signatures to move money — your device *and* a guardian server — so a stolen phone isn't enough. |
| **Bridging** | Moving value between Miden and Ethereum. "Bridge-out" = Miden → Ethereum; "bridge-in" = Ethereum → Miden. |
| **USDC** | A dollar-pegged coin on Ethereum — think digital dollars. It's what value becomes when it lands on the Ethereum side. |
| **Smart contract** | A small program that lives on Ethereum at a fixed address (e.g. the USDC coin, or the bridge). The wallet calls these by address. |
| **The bridge / lending service** | A third-party service ("Epoch") that carries value across the two chains and runs lending. It's hosted on their servers, so most tests use a faithful **stand-in**. |
| **Collateral / position** | To earn yield you lock some coins up as backing ("collateral"); your locked-up stake is a "position." |
| **WalletConnect** | The standard way a wallet and another app agree to sign a transaction together, by passing messages through a shared relay. |
| **The command-line client** | The official Miden client, scripted to act as an **independent other party** — it mints coins, or plays the person on the other end of a trade. |

### How to read the diagrams

```mermaid
flowchart LR
  R["The real thing<br/>(app, blockchain, guardian)"]:::real
  F["A faithful stand-in<br/>(for a hosted service)"]:::fake
  W["The real outside world<br/>(post-merge and on-demand runs)"]:::world
  T["Test machinery<br/>(the director + robot counterparties)"]:::test

  A1["normal action"] ==>|"direct hand-off"| A2["(thick arrow)"]
  A3["optional / co-sign step"] -.->|"dotted arrow"| A4[" "]

  classDef real fill:#14532d,stroke:#22c55e,stroke-width:2px,color:#dcfce7;
  classDef fake fill:#7c2d12,stroke:#fb923c,stroke-width:2px,color:#ffedd5;
  classDef world fill:#4c1d95,stroke:#a78bfa,stroke-width:3px,color:#ede9fe;
  classDef test fill:#1e3a8a,stroke:#60a5fa,stroke-width:2px,color:#dbeafe;
```

**Box color** = how real the piece is (green real · orange stand-in · purple real outside world · blue test machinery). **Arrows:** a solid arrow is a normal action; a **thick** arrow is a direct hand-off; a **dotted** arrow is an optional or co-signing step.

---

## The lab at a glance

Every suite assembles the same set of components and drives the real app through them. The guardian and Ethereum take part only in the tests that require them:

```mermaid
flowchart TB
  DIR["🎬 Test director<br/>(launches everything, clicks the buttons, checks the result)"]:::test
  ROBOT["🤖 Robot counterparties<br/>(a scripted client + a WalletConnect wallet)"]:::test

  APP["📱 The real wallet app"]:::real

  CHAIN["⛓️ Miden blockchain<br/>(booted fresh per pull request, or the public test network)"]:::real
  GUARD["🔐 Multisig guardian<br/>(real — for guardian accounts)"]:::real
  ETH["🔌 Ethereum, run locally<br/>(real software — for bridging & earning)"]:::real
  BRIDGE["🌉 Bridge / lending service<br/>(faithful stand-in)"]:::fake

  DIR --> APP
  DIR --> ROBOT
  APP -->|"move money, send notes"| CHAIN
  APP -.->|"co-sign secured transfers"| GUARD
  APP -->|"bridge to/from Ethereum"| ETH
  APP -->|"quote & carry value across"| BRIDGE
  ROBOT -->|"trade / sign as the other party"| APP

  classDef real fill:#14532d,stroke:#22c55e,stroke-width:2px,color:#dcfce7;
  classDef fake fill:#7c2d12,stroke:#fb923c,stroke-width:2px,color:#ffedd5;
  classDef test fill:#1e3a8a,stroke:#60a5fa,stroke-width:2px,color:#dbeafe;
```

> #### A real blockchain, not a mock
> The chain is never faked. On every pull request the desktop suites boot a genuine Miden network in CI, seed it from a fresh genesis, and tear it down afterward. When the wallet syncs, submits, or reads balances, it does so against real node software — so a passing test reflects real on-chain behaviour rather than a mock's assumptions.

---

## Contents

- [1 · Everyday money — send, receive, claim](#1--everyday-money--send-receive-claim)
- [2 · Trading — swaps between two people](#2--trading--swaps-between-two-people)
- [3 · Bridging out — Miden money becomes Ethereum money](#3--bridging-out--miden-money-becomes-ethereum-money)
- [4 · Earning — lending your coins out](#4--earning--lending-your-coins-out)
- [5 · Guardian security — two signatures to move money](#5--guardian-security--two-signatures-to-move-money)
- [6 · Bringing value in on iPhone](#6--bringing-value-in-on-iphone)
- [7 · dApps - a real dApp against the wallet](#7--dapps---a-real-dapp-against-the-wallet)
- [8 · USDCx on live testnet - out to Arc and back](#8--usdcx-on-live-testnet---out-to-arc-and-back)
- [Under the hood — running Ethereum locally](#under-the-hood--running-ethereum-locally)
- [How real is it, really?](#how-real-is-it-really)

---

## 1 · Everyday money — send, receive, claim

**What these tests verify:** two independent people can hold the wallet and move money between them, publicly or privately.

The harness runs two completely separate copies of the real app — instances A and B — alongside the official Miden command-line client acting as an independent third party. The command-line client mints some coins; instance A claims them and sends some to B, either as a **public** note (posted to the chain) or a **private** note (delivered through the off-chain transport service). B then has to genuinely receive and claim it. Running two real instances, rather than one app against a mock, means every send is a true end-to-end transfer with a real recipient on the other side.

```mermaid
flowchart LR
  DIR["🎬 Test director"]:::test
  CLI["🤖 Command-line client<br/>(mints coins, acts as a 3rd party)"]:::test
  A["📱 App A — sender"]:::real
  B["📱 App B — receiver"]:::real
  CHAIN["⛓️ Miden blockchain"]:::real
  SIDE["✉️ Private-note delivery"]:::real

  DIR --> A
  DIR --> B
  CLI -->|"mint coins to A"| CHAIN
  A -->|"public note"| CHAIN
  A -->|"private note"| SIDE
  CHAIN -->|"B sees it & claims"| B
  SIDE -->|"B receives it privately"| B

  classDef real fill:#14532d,stroke:#22c55e,stroke-width:2px,color:#dcfce7;
  classDef test fill:#1e3a8a,stroke:#60a5fa,stroke-width:2px,color:#dbeafe;
```

> #### Two independent wallets on one chain
> Many test suites exercise a single app against a mocked backend. This suite runs two independent copies of the shipped wallet, plus the official Miden client as a third party, all against one real chain — so a "send" is a genuine end-to-end transfer that another party receives. Both of the app's proving paths are covered: proofs handed to a remote prover, and proofs computed entirely in the browser.

<details>
<summary>The tests in this group</summary>

Create-and-unlock, minting & balances, public send, private send, in-browser proving, claiming several notes at once, multiple accounts, and grouped claims.
</details>

---

## 2 · Trading — swaps between two people

**What these tests verify:** a maker can post an offer ("10 of coin A for 9 of coin B") and a taker can fill it — fully, partially, or in the opposite direction — and an unfilled offer can be cancelled and reclaimed. The same flow is also exercised with a **guardian-secured** maker, so multi-signature accounts are covered on the trading path.

```mermaid
flowchart LR
  MK["📱 Maker<br/>(posts the offer)"]:::real
  TK["📱 Taker<br/>(fills the offer)"]:::real
  CHAIN["⛓️ Miden blockchain"]:::real
  GUARD["🔐 Guardian<br/>(if the maker is secured)"]:::real

  MK -->|"post offer on-chain"| CHAIN
  MK ==>|"hand the offer note<br/>straight to the taker"| TK
  TK -->|"fill it"| CHAIN
  MK -.->|"co-sign the offer"| GUARD
  CHAIN -->|"both sides settle"| MK & TK

  classDef real fill:#14532d,stroke:#22c55e,stroke-width:2px,color:#dcfce7;
```

> #### Handling the order-discovery timing race
> On a live network, a taker discovers an order by watching the chain — but there is a brief window after an order is posted before it becomes visible. Rather than paper over this with fixed "wait and hope" delays (which make tests slow and flaky), the harness hands the order note directly from the maker to the taker (the thick arrow above), the same approach a production market-making bot uses. The result is deterministic and, if anything, closer to real trading behaviour than a polling loop would be.

These run on a blockchain booted fresh for the job on every pull request. The same suite can also be pointed at the **public test network** with `yarn e2e:real --suite swap`, which swaps the booted chain for the real one, the local prover for the shared hosted prover, and the local coin tap for the public faucet. Nothing about the trade itself changes - the offer is a note and the fill is a note, with no exchange contract in between - so the suite needs no deployment there.

<details>
<summary>The tests in this group</summary>

Full fill (both directions), partial fill with remainder, cancel-and-reclaim, create-form validation, a guardian-secured maker, and a smoke test. The guardian scenario is held back from the default public-network run (`yarn e2e:real --suite swap-guardian` runs it on its own), because there the co-signer is a third party's hosted service rather than one the job starts.
</details>

---

## 3 · Bridging out — Miden money becomes Ethereum money

**What these tests verify:** value can be sent *out* of Miden and arrive on Ethereum as USDC.

The flow is exercised at **two levels of realism**, each suited to a different point in the pipeline:

- **On demand (`yarn e2e:real --suite bridge-out-epoch`):** against the **real** hosted bridge service and the **real** Ethereum test network (Sepolia). The test then confirms that **actual USDC arrives** at the destination - an end-to-end check that includes the third-party solver settling the Ethereum side. It is opt-in rather than automatic, because it spends a real solver fill and a third party declining to quote should not turn `main` red; the runner probes the live solver for a quote before it builds anything.
- **Post-merge (after every merge to main):** the AggLayer route against the real bridge, asserting the Miden leg.
- **After every push to main, and on demand (`yarn e2e:real --suite usdcx-burn`, and with the deposit back `--suite usdcx`):** a USDCx burn to Arc Testnet through Circle's Gateway and Circle's payout of it, on live testnet; see [section 8](#8--usdcx-on-live-testnet---out-to-arc-and-back).
- **Every pull request:** a fully self-contained version using a **stand-in** bridge service and a **local** Ethereum node, so the guardian-secured bridge path is verified on every commit without depending on external infrastructure.

There are also two bridge *routes* — a **fast** one via the Epoch service and a **slower** one via a bridge network called **AggLayer** — and both are covered.

```mermaid
flowchart LR
  APP["📱 The wallet app"]:::real
  CHAIN["⛓️ Miden blockchain"]:::real
  BRIDGE["🌉 Bridge service<br/>real hosted · on demand<br/>stand-in · every PR"]:::fake
  ETH["🔷 Ethereum + USDC<br/>real Sepolia · on demand<br/>local · every PR"]:::world
  CHECK["🔎 Result check<br/>(did real USDC arrive?)"]:::test

  APP -->|"lock coins in a note"| CHAIN
  APP -->|"ask to bridge"| BRIDGE
  BRIDGE -->|"deliver USDC on the other side"| ETH
  CHECK -->|"read the balance"| ETH

  classDef real fill:#14532d,stroke:#22c55e,stroke-width:2px,color:#dcfce7;
  classDef fake fill:#7c2d12,stroke:#fb923c,stroke-width:2px,color:#ffedd5;
  classDef world fill:#4c1d95,stroke:#a78bfa,stroke-width:3px,color:#ede9fe;
  classDef test fill:#1e3a8a,stroke:#60a5fa,stroke-width:2px,color:#dbeafe;
```

> #### Verifying settlement on Ethereum
> The on-demand test (`yarn e2e:real --suite bridge-out-epoch`) does not stop at the app reporting success. After bridging, it reads the destination account on a real Ethereum test network and confirms the USDC balance actually increased. This validates the entire path - including the external solver that settles the Ethereum side - so the app cannot pass merely by believing it succeeded.

> #### On-chain verification of the minted note
> The bridge service accepts only a specific shape of collateral note. The harness reads the committed note directly from the chain and verifies its type and structure are exactly what the service requires. This check was added after a defect — a guardian bridge minting the wrong kind of note — reached a release; with the check in place, that class of mistake now fails a test rather than shipping silently.

<details>
<summary>The tests in this group</summary>

Fast bridge (real USDC on Sepolia, on demand via `yarn e2e:real`), the slower AggLayer route (post-merge), and a guardian-secured bridge that runs fully offline on every pull request.
</details>

---

## 4 · Earning — lending your coins out

**What these tests verify:** coins can be deposited as collateral to earn yield, and later withdrawn — including a **gasless** withdrawal in which someone else pays the Ethereum fee.

Because the lending service is hosted on external servers, this flow runs entirely against **stand-ins**: a faithful fake of the lending service, plus a **local** Ethereum node carrying stand-in versions of the relevant contracts. The point is to exercise the wallet's real deposit and withdraw logic against services that behave like the real ones.

```mermaid
flowchart TB
  APP["📱 The wallet app"]:::real
  CHAIN["⛓️ Miden blockchain"]:::real
  LEND["🏦 Lending service<br/>(faithful stand-in)"]:::fake
  ETH["🔌 Ethereum, run locally"]:::real
  RELAY["⛽ Fee-paying relayer<br/>(stand-in)"]:::fake
  CONTRACTS["🎭 Fake USDC & contracts<br/>(deployed at the real addresses)"]:::fake

  subgraph DEP["Depositing"]
    direction LR
    APP -->|"1 · lock collateral in a note"| CHAIN
    APP -->|"2 · open a position"| LEND
  end
  subgraph WD["Withdrawing (gasless)"]
    direction LR
    APP -->|"3 · ask to withdraw"| RELAY
    RELAY -->|"4 · submits the tx & pays the fee"| ETH
    LEND -->|"5 · coins bridge back to you"| CHAIN
  end
  CONTRACTS -->|"live on"| ETH

  classDef real fill:#14532d,stroke:#22c55e,stroke-width:2px,color:#dcfce7;
  classDef fake fill:#7c2d12,stroke:#fb923c,stroke-width:2px,color:#ffedd5;
```

> #### Reproducing a gasless (sponsored) withdrawal offline
> Moving funds on Ethereum normally requires the sender to pay a fee. This flow uses a recent Ethereum feature (account "delegation") so that a relayer pays the fee on the user's behalf. The harness reproduces the full sequence — the delegation, the relayer, and the token contracts — against local stand-ins, so this relatively new mechanism is exercised on every relevant change without touching a live network or spending funds.

<details>
<summary>The tests in this group</summary>

Deposit collateral and confirm the position opens; withdraw a funded position gasless-ly and confirm the coins bridge back.
</details>

---

## 5 · Guardian security — two signatures to move money

**What these tests verify:** a "guardian" account — one that requires **two signatures** (your device *and* a guardian server) — can still fund, claim, and send. A stolen device alone cannot move the money.

The notable part is that the guardian is not faked. Each of these tests can start the **real guardian server** — the same software that protects production accounts — and perform the genuine two-signature handshake, rather than asserting against a stub.

```mermaid
flowchart LR
  APP["📱 App — guardian account"]:::real
  DEVICE["🔑 Signature 1<br/>(your device key)"]:::real
  GUARD["🔐 Signature 2<br/>(real guardian server)"]:::real
  CHAIN["⛓️ Miden blockchain<br/>(checks both signatures)"]:::real
  B["📱 Recipient"]:::real

  APP --> DEVICE
  APP -.->|"ask to co-sign"| GUARD
  DEVICE & GUARD -->|"two signatures"| CHAIN
  CHAIN -->|"transfer approved"| B

  classDef real fill:#14532d,stroke:#22c55e,stroke-width:2px,color:#dcfce7;
```

> #### Testing against a real co-signing server
> Running an actual co-signing server inside an automated test is uncommon; this harness does it. Each guardian test can start the real guardian server and complete the real two-signature handshake, so the "two signatures to move money" guarantee is verified against the production co-signer rather than a stub. This co-signing path is also the foundation the guardian **trade** and **bridge** tests build on.

<details>
<summary>The tests in this group</summary>

A guardian account funds, claims notes, and sends to a normal wallet — every step co-signed for real.
</details>

---

## 6 · Bringing value in on iPhone

**What these tests verify:** on iOS, value can be brought *in* from Ethereum. The app connects to an Ethereum wallet over WalletConnect, that wallet signs a deposit, and the resulting funds arrive on Miden.

Testing "connect to another wallet and have it sign" would normally require a second real wallet and a person to operate it. The harness removes that dependency by providing the counterparty itself.

> #### A headless Ethereum wallet that speaks WalletConnect
> To act as the far side of a cross-chain deposit, the harness includes a headless Ethereum wallet that implements the real WalletConnect protocol. It pairs with the app over the genuine public WalletConnect relay, approves the session, and signs Ethereum transactions — with no person and no browser extension involved. The signed transactions are submitted to the local Ethereum node rather than a live network.

```mermaid
flowchart TB
  PHONE["📱 iPhone simulator<br/>running the real app"]:::real
  DIR["🎬 Test director"]:::test
  ROBOT["🤖 Our WalletConnect robot wallet<br/>(signs on the Ethereum side)"]:::test
  RELAY["📡 WalletConnect message relay<br/>(real, public)"]:::world
  ETH["🔌 Ethereum, run locally"]:::real
  CONTRACTS["🎭 Stand-in bridge & USDC contracts<br/>(deployed at the real addresses)"]:::fake
  CHAIN["⛓️ Miden blockchain"]:::real

  DIR --> PHONE
  DIR --> ROBOT
  PHONE <-->|"find each other & agree to sign"| RELAY
  ROBOT <-->|"find each other & agree to sign"| RELAY
  ROBOT -->|"sign the deposit"| ETH
  ETH -->|"coins delivered as a note"| CHAIN
  CHAIN -->|"app shows 'received'"| PHONE
  CONTRACTS -->|"live on"| ETH

  classDef real fill:#14532d,stroke:#22c55e,stroke-width:2px,color:#dcfce7;
  classDef fake fill:#7c2d12,stroke:#fb923c,stroke-width:2px,color:#ffedd5;
  classDef world fill:#4c1d95,stroke:#a78bfa,stroke-width:3px,color:#ede9fe;
  classDef test fill:#1e3a8a,stroke:#60a5fa,stroke-width:2px,color:#dbeafe;
```

> #### Driving the real app on iOS simulators
> These tests run on iOS simulators — two of them, so the two-wallet scenarios apply on mobile as well — and interact with the app the way a debugger would, tapping real controls and reading real state. Some controls render outside the web view, in the phone's native interface; a dedicated hook lets the tests operate those too.

> #### Stand-in contracts that enforce real invariants
> Ethereum contracts live at fixed addresses. The stand-ins for the bridge and USDC are deployed at the exact addresses the app expects, so the app runs its real bridging code unchanged. These stand-ins are not permissive: the bridge stand-in rejects a malformed deposit on-chain, and the test decodes the app's actual transaction to confirm it requested precisely the right operation. A defect cannot pass by doing something plausible — it has to do the correct thing.

> **Status:** the mobile bridge-in suite runs after merge to main and does not yet fail its run. The deposit ships to users (the published testnet document switches bridge-in on), so this suite is its only E2E, but its WalletConnect handshake was rejected with WS close 3000 ("Project not found"). Until #1259 an unset counterparty secret made the counterparty send a blank project id, which alone produces that rejection; whether the app's own id was also rejected is not recorded. It becomes blocking once a run on the current default project id passes; relay rate limits are handled by retrying the connect step. The harness components described above are implemented and in place.

<details>
<summary>The tests in this group</summary>

Bridge-in via the two routes, a WalletConnect-pairing-only check, a delivery-only check, and the guardian flow — all on iPhone. (An Android two-emulator harness also exists in the codebase, not yet wired into CI.)
</details>

---

## 7 · dApps - a real dApp against the wallet

**What these tests verify:** a dApp built the way real dApps are built - its own Miden client and the published wallet adapter - can connect, read, sign and move money through the extension, on single-sig and Guardian accounts alike.

The test dApp is a small page served next to the wallet under test. It loads the same `@miden-sdk/miden-sdk` and wallet-adapter packages the wallet resolves, keeps its own client with its own storage and its own view of the chain, and exposes a command API the test drives. Because the dApp's client and the wallet's are independent, the chain really does move between the moment the dApp builds a request and the moment the user approves it, the way it does for real users.

Every capability is a named cell from the suite's capability matrix, run on both account kinds. A write passes only when the dApp's own `waitForTransaction` returns the hash, the wallet's row reads Completed, the node serves the note or nullifier, and every balance moved by exactly the amount plus the fee. Refusals are pinned to their exact error and checked for side effects. A known wallet or adapter bug is recorded against the cell it breaks, so the suite stays meaningful while the bug is open, and the record fails the run the day the bug is fixed until the entry is removed.

Where it runs: `e2e-dapp.yml`, after every merge, against the branch's live network (testnet from `main`, devnet from `next`) with that network's public faucet and hosted Guardian. No pull request runs it; a branch can dispatch it by hand.

---

## 8 · USDCx on live testnet - out to Arc and back

**What these tests verify:** a Guardian user can take USDCx from the public faucet, send it to Arc Testnet as USDC through the Send screen, be paid by Circle, and bring USDC back to Miden as USDCx, with every hop checked to the base unit against the chain, Circle and the wallet's own records.

Nothing in this group is stood in for. The wallet runs on the public Miden testnet with the hosted OpenZeppelin Guardian, the funds come from the public faucet (USDCx is the testnet fee asset), and Circle's xReserve, its attestation service, its Gateway payouts and Arc Testnet are the real services. The suites spend public testnet funds and depend on services the project does not run, so no pull request runs them; where they do run is below the table.

| Suite | Command | What it covers |
|---|---|---|
| `usdcx` | `yarn e2e:real --suite usdcx` | A fresh Guardian wallet takes one 10 USDCx faucet grant and burns 1 USDCx, the USDCx faucet's minimum burn, through Send to the harness Arc key. Circle pays the key, the wallet shows the payout as Confirmed, the key deposits 0.001 USDC back through xReserve, Circle attests it, Circle's relayer mints it and the wallet receives it. Up to 60 min. |
| `usdcx-in` | `yarn e2e:real --suite usdcx-in` | The deposit leg alone, into a fresh Guardian wallet, from the harness Arc key, or from another key that holds USDC on Arc when `E2E_ARC_PRIVATE_KEY=<key>` names it. Up to 30 min. |
| `usdcx-burn` | `yarn e2e:real --suite usdcx-burn` | One 10 USDCx faucet grant and a 1 USDCx burn through Send to the harness Arc key, on a fresh standard wallet and on a fresh Guardian wallet; each test waits for Circle's payout of its own burn. Up to 70 min. |

Where each USDCx suite runs:

| Suites | Runs | Arc key |
|---|---|---|
| `usdcx-in`, `usdcx-burn`, `usdcx` (extension) | E2E USDCx (`e2e-usdcx.yml`) after every push to main, in that order, each only once the one before passed, and on a branch by dispatch; by hand, `yarn e2e:real --suite <name>` | In CI, its own key ([below](#the-ci-key)); by hand, the harness key |
| The iOS live bridge-in (`usdcx-live-deposit.ios.spec.ts`), the deposit leg only | E2E USDCx Bridge-IN (live) (`e2e-usdcx-live.yml`) after every push to main, nightly at 03:17 UTC and by dispatch | The repository secret `USDCX_LIVE_EVM_PRIVATE_KEY`, set only on the steps that check it and run the spec; a run spends about 0.016 USDC of it |

> #### Circle's payout is a hard gate
> The round trip and both `usdcx-burn` tests fail when Circle has not paid the burn to the key within 10 minutes of the faucet consuming it. The proof is one Gateway `AttestationUsed` log on Arc whose mint carries the burn note id, so a transfer to the key from anywhere else does not count. The key keeps USDC between runs, so the proof is also that its balance rose, from a read taken right before the burn, by exactly that log's value; anything else that pays into or spends from the key in that window fails the run, and the message says so. Circle has paid Arc burns 10-12 s after the consume, but also 1 h 45 min and about 17 h late, and one burn was still unpaid days later. A red payout step therefore means a user would not have been paid in time; that can be Circle's doing rather than the wallet's, and the failure message says so.

> #### The wallet's own records are checked too
> Beside the chain and Circle, each run reads the wallet's rows: the burn's phases (Burn confirmed, then Confirmed once the wallet sees the payout on Arc), the deposit's phases, and the fee each transaction paid. A deposit row claiming a real deposit that Circle attested to another Miden account must fail, never read Confirmed. A transaction that completed without keeping its result (a landed path) records no fee, so its fee is bounded from the vault instead of read exactly, and the evidence file says which. Each run attaches its evidence as JSON (`usdcx-round-trip-evidence.json`, `usdcx-in-evidence.json`, `usdcx-burn-evidence.json`), never with a private key in it.

The harness reads Arc through drpc and QuickNode first and through `rpc.testnet.arc.io` last, because that endpoint is the one the wallet itself uses and it rate-limits; `--arc-rpc <url>` puts another endpoint in front. A rate limit or a timeout moves a read, or the wait for a receipt, to the next endpoint. A deposit is simulated, its gas estimated and its transactions sent on one endpoint only, retried there a few times, because an endpoint a block behind the approve would report a revert that is not real; a deposit step that runs out of time sends nothing more. Reports and failure messages name each endpoint by its host only, because an endpoint's URL can carry an API key in its path.

The amounts are the smallest that prove each hop. 1 USDCx is the USDCx faucet's on-chain minimum burn (the review refuses less), one 10 USDCx grant is the faucet's smallest tier that covers that burn and its fees, and the 0.001 USDC deposit clears the wallet's unattended claim floor (its base fee x 30, 210 base units at testnet's base fee of 7), so the wallet claims the mint by itself. A run whose live base fee has outgrown the deposit fails before it spends anything.

### The harness Arc key

Every `usdcx` and `usdcx-burn` run burns to one key, and the round trip and `usdcx-in` deposit back from it, so each burn's payout refills what the deposits spend and no run needs Circle's faucet. The key lives in `~/.miden-e2e/arc-keys/harness.json` (mode 0600 in a 0700 directory, outside the repository and `test-results/`) with its `role` (`harness`), `address`, `privateKey` and creation time; its `walletAddress` is empty because many wallets pay it. The first real `usdcx` or `usdcx-burn` run creates it and the runner hands it to each test; it is never logged or attached to a report, and `--preflight-only` never creates it.

Each `usdcx` run leaves the key about 0.98 USDC richer (the 0.9836 USDC payout less the 0.001 USDC deposit and about 0.006 USDC of gas), each `usdcx-burn` run about 1.97 USDC richer (the payouts of both its burns, which it waits for), and each `usdcx-in` run about 0.007 USDC poorer. `usdcx-in` needs 0.021 USDC on the key: the 0.001 USDC deposit and a 0.02 USDC gas reserve. Fund the key from Circle's faucet only as a last resort, and only while no run holds the lock.

- **Read its balance:** `cast call 0x3600000000000000000000000000000000000000 'balanceOf(address)(uint256)' "$(jq -r .address ~/.miden-e2e/arc-keys/harness.json)" --rpc-url https://rpc.drpc.testnet.arc.io` (six decimals).
- **Move its USDC:** only while no run holds the lock, since a transfer during a run breaks that run's payout proof. Import the key into any EVM wallet on Arc Testnet (chain 5042002) and send the USDC on, keeping about 0.01 USDC for gas.
- **Deposit from another key:** `E2E_ARC_PRIVATE_KEY="$(jq -r .privateKey <file>)" yarn e2e:real --suite usdcx-in`. A key is taken only from the environment: yarn prints the whole command line and `ps` shows it to every local user, so the runner refuses `--arc-key` and `--sepolia-key`, and a key typed on a command line should be rotated.

Never commit `harness.json`, and never delete it while it holds USDC. Files named `<time>-<address>.json` in the same directory are per-run keys from before the harness key; read and move their USDC the same way, and delete a file once its key is empty.

Only one usdcx run may go at a time. The runner takes `~/.miden-e2e/usdcx-run.lock` before anything else, and a second run refuses, naming the lock and the pid holding it. A run that dies leaves the lock behind, and the next run removes it once neither that run nor its test child is alive. Stop a run with Ctrl-C rather than `kill <pid>`: killing the runner alone leaves its Playwright child running, and the lock stays held while it does. Every test that burns waits for its own payout, so a green run leaves no payout to come; one that arrives after its run went red (see above) can still land inside a later run's payout window, and that run fails naming a credit it cannot account for, and a rerun passes.

### The CI key

E2E USDCx burns to and deposits from a key of its own, never a developer's harness key and never the iOS job's: the repository secret `USDCX_HARNESS_ARC_KEY`, 0x and 64 lowercase hex. The step after the install, and no other step, reads the secret and writes it to the runner's `~/.miden-e2e/arc-keys/harness.json` (0600 in a 0700 directory, through `scripts/write-ci-harness-arc-key.mjs`), printing only the address; the suites then read the file through the runner as a local run does, and the uploads hold `test-results/` alone. Without the secret the job fails at that step, before anything is built, because the runner would otherwise create a key whose payouts leave with the runner.

The key started with 20 USDC, and a green run leaves it about 2.9 USDC richer (the three runs above: about +0.98, +1.97 and -0.007), so it needs no refill while main is green. A red run spends at most a deposit and its gas; fund the key when `usdcx-in`'s preflight reports it below 0.021 USDC.

Runs queue on one concurrency group, `usdcx-harness-arc-key`, and none is cancelled once it started, so two runs never share the key; this group plays the lock's part in CI. GitHub keeps one waiting run per group, so a run still waiting when a newer one queues is cancelled before it starts. A payout that lands after its run went red can still fail the next run, as it can locally.

- **Its address and balance:** the `Write the CI harness Arc key` step prints the address, and each suite's banner repeats it (`Arc key  harness 0x...`); read the balance with the `cast call` above.
- **Fund it:** send Arc Testnet USDC to that address, from Circle's faucet or another key, while no E2E USDCx run is going.
- **Recover it:** GitHub never shows a secret again, so the key and its USDC are only as recoverable as the copy kept by whoever stored the secret. Import that copy into an EVM wallet on Arc Testnet (chain 5042002) to move the USDC, while no run is going. If the copy is lost, so is the USDC on the key: create a new key (`cast wallet new`), keep a copy, send it at least 0.021 USDC and store its private key, lowercase, with `gh secret set USDCX_HARNESS_ARC_KEY --repo 0xMiden/wallet`.

### The iOS nightly's key

`e2e-usdcx-live.yml` runs `playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts` every night on one Guardian wallet: the secret-funded key `USDCX_LIVE_EVM_PRIVATE_KEY` deposits 0.01 USDC in, and then the wallet burns 1 USDCx from a public faucet grant back to that key's own Arc address. Circle's payout of about 0.98 USDC more than refills the deposit and its gas (about 0.015 USDC), so the key needs no top-up, and the payout gate counts only what the burn added to its balance since a read taken right before the burn. A late payout from an earlier night, or any other transfer into or out of the key during a run, fails that gate, and the message says why.

Run the spec locally with `USDCX_LIVE_EVM_PRIVATE_KEY` set to the harness key while holding `~/.miden-e2e/usdcx-run.lock`, never with the nightly's key: a local run cannot see a nightly, and two payouts into one key fail the gate.

---

## Under the hood — running Ethereum locally

Several flows — bridging, earning, and the iPhone bridge-in — need an Ethereum chain to talk to. Rather than depend on the public Ethereum test network (which is slow, shared, and occasionally down), those suites run their own Ethereum locally. This section explains how that works.

### A real Ethereum node, not a simulator

The local chain is **Anvil**, the EVM node that ships with Foundry. It is a genuine Ethereum implementation — it executes transactions, reverts on bad input, and keeps real state — simply running on the test machine. The harness starts it on `127.0.0.1:8545` and gives it **chain id 11155111**, which is Sepolia's id, so the wallet believes it is talking to the Sepolia test network. (On iOS the simulator shares the host's network stack, so that same `127.0.0.1:8545` is reachable from both the test process and the app's web view.)

The wallet is aimed at this node by a build-time setting — an RPC-URL override compiled into the test build — so all of its Ethereum reads and writes go to Anvil instead of the public network. Nothing in the wallet's Ethereum code is stubbed: it runs exactly as it would in production, and only the chain it connects to is local.

```mermaid
flowchart TB
  DIR["🎬 Test director"]:::test

  subgraph ANVIL["🔌 Anvil — a real local Ethereum node (Foundry, poses as Sepolia)"]
    USDC["🎭 MockUSDC<br/>at the real USDC address"]:::fake
    COMPACT["🎭 MockCompact — 'The Compact'<br/>at the real address"]:::fake
    AGG["🎭 MockAggLayerBridge<br/>at the real bridge address"]:::fake
  end

  APP["📱 The wallet app<br/>(pointed here by an RPC override)"]:::real
  ROBOT["🤖 WalletConnect robot wallet"]:::test

  DIR ==>|"anvil_setCode:<br/>write contract bytecode"| ANVIL
  APP -->|"real EVM reads & calls"| ANVIL
  ROBOT -->|"broadcast signed transactions"| ANVIL

  style ANVIL fill:#052e16,stroke:#22c55e,stroke-width:2px,color:#dcfce7
  classDef real fill:#14532d,stroke:#22c55e,stroke-width:2px,color:#dcfce7;
  classDef fake fill:#7c2d12,stroke:#fb923c,stroke-width:2px,color:#ffedd5;
  classDef test fill:#1e3a8a,stroke:#60a5fa,stroke-width:2px,color:#dbeafe;
```

### Supplying the contracts the app expects

A wallet on Ethereum talks to **smart contracts** — small on-chain programs at fixed addresses — for things like the USDC coin and the bridge. The real versions live on public networks and can't be copied onto a local chain, so the harness deploys its own stand-ins. It does this with an Anvil capability called **`anvil_setCode`**, which writes a contract's compiled bytecode directly to any address, with no deployment transaction needed.

The important detail is *where*: each stand-in is placed at the **exact address the wallet hardcodes for the real contract**. Because the address matches, the wallet's real code calls the stand-in with no special-casing — it cannot tell the difference.

Three contracts are supplied this way (compiled from short Solidity sources kept in the repo):

- **MockUSDC**, at the real USDC address — a minimal ERC-20 stand-in. It reports a balance for the deposit screen, returns a maximum allowance (so the deposit path skips its `approve` step), and lets transfers succeed so the other contracts can pull funds.
- **MockCompact** ("The Compact"), at the address the bridge/lending SDK expects. It answers a status check with "withdrawals not forced" — which the deposit flow requires before it will proceed — and its deposit function verifies it received the expected token, pulls it in, and counts the deposit.
- **MockAggLayerBridge**, at the real AggLayer bridge address. It implements the real bridge function's signature *and its rule that a native-ETH deposit must carry exactly the stated amount* — so a malformed deposit **reverts on-chain** and the wallet marks the transaction failed, rather than passing against an empty address.

### Seeding an account "delegation" for the gasless withdraw

The gasless withdraw relies on a recent Ethereum feature (EIP-7702 account delegation) that lets an ordinary account behave like a smart account, so a relayer can pay its fee. Establishing that delegation normally requires a special signed transaction that the stand-in relayer can't broadcast. Instead, the harness uses `anvil_setCode` again to write the delegation marker directly onto the owner's account, so the wallet sees the account as already delegated and continues down the gasless path.

### Why this is trustworthy, not a shortcut

Deploying byte-for-byte contracts at the real addresses, on a real EVM that reports Sepolia's identity, means the wallet's Ethereum code runs unchanged and unaware. The stand-ins deliberately enforce the real invariants — the bridge reverts on a wrong-value deposit, the Compact rejects an unexpected token — so a defect fails a test rather than slipping through against permissive dead code. Where a test needs to confirm that something happened, it reads counters the stand-ins keep (for example, how many deposits were registered) and decodes the wallet's actual transaction data to check it requested precisely the right operation. The signing itself — ordinary Ethereum transactions, and the 7702 authorization — is entirely real.

<details>
<summary>Concrete details (addresses &amp; mechanism)</summary>

- **Anvil:** `127.0.0.1:8545`, chain id `11155111` (Sepolia), started via Foundry's `anvil`; the wallet is pointed at it by the `E2E_EVM_RPC_URL` build override.
- **Contracts installed via `anvil_setCode`** (runtime bytecode written directly at fixed addresses):

  | Stand-in | Address (matches the app's hardcoded value) | Role |
  |---|---|---|
  | MockUSDC | `0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69` | balance read; MAX allowance (skips `approve`); transfers succeed |
  | MockCompact | `0x00000000000000171ede64904551eeDF3C6C9788` | `getForcedWithdrawalStatus → Disabled`; `depositERC20AndRegister` asserts the token, pulls it, counts deposits |
  | MockAggLayerBridge | `0x1348947e282138d8f377b467f7d9c2eb0f335d1f` | real `bridgeAsset` signature + `msg.value == amount` invariant → reverts on a malformed deposit |

- **EIP-7702 delegation** for the gasless withdraw is seeded by writing `0xef0100` + the approved implementation address at the owner account (again via `anvil_setCode`), so the SDK sees the account as already delegated.
- Sources: `playwright/e2e/ios/helpers/anvil.ts`, `playwright/e2e/ios/helpers/evm-doubles.ts`, `playwright/e2e/ios/helpers/contracts/*.sol`.
</details>

---

## How real is it, really?

The following summarises what is genuine versus stood in:

| Layer | In the test lab | |
|---|---|---|
| **The wallet app** | the real, shipped app (built with test-observation hooks, stripped from releases) | ✅ real |
| **The Miden blockchain** | booted fresh per run for pull-request tests; the genuine public test network otherwise | ✅ real |
| **The proving (cryptography)** | both the remote and in-browser paths | ✅ real |
| **Private-note delivery** | the real delivery service | ✅ real |
| **The guardian co-signer** | the real guardian server | ✅ real |
| **The independent counterparty** | the official command-line client | ✅ real |
| **WalletConnect** | the real app ↔ real public relay ↔ the harness's robot wallet | ✅ real link, 🎭 robot far side |
| **Ethereum** | genuine Ethereum software, run locally (for bridging & earning) | ✅ real (local) |
| **Ethereum contracts (bridge, USDC…)** | faithful fakes at the *real* addresses, enforcing real invariants | 🎭 stand-in |
| **The hosted bridge service** | real in the on-demand `yarn e2e:real` run; stand-in per pull request | 🌍 real / 🎭 stand-in |
| **The hosted lending service** | always a stand-in | 🎭 stand-in |
| **Money actually arriving on Ethereum (on-demand bridge)** | real USDC on a real test network | ✅ real |

> **In summary:** the app, the blockchain, the cryptography, the co-signer, and the counterparty client are all real. The harness stands in only for the external services it cannot run itself, and it builds those stand-ins at the real addresses and to the real invariants — so the app behaves the same as it would in production.

# USDCx live E2E (Guardian round trip) and #1100 fixes - design

Three local-only suites prove, to the base unit, the USDCx path a Guardian user takes on live testnet: a public faucet grant, a burn through the Send UI to a fresh Arc key, Circle's Gateway payout to that key, a deposit back through xReserve, Circle's attestation, the relayer's mint and the wallet's consume. The extension and iOS each run the round trip; the extension also runs a bridge-in-only suite from a pre-funded key. The same push fixes the #1100 defects these runs depend on: an attestation is trusted only when it matches what the wallet signed, stale copy and labels are corrected, and the gates #1100 broke are repaired.

## 1 Goals and non-goals

Goals
- One command per suite (`yarn e2e:real --suite usdcx|usdcx-in|usdcx-ios`), no secret except the optional funded key.
- Every hop asserted as an exact base-unit ledger; fees read from the rows that paid them, never pinned.
- A run cannot pass vacuously, on the wrong network, on a hermetic build, or on a non-Guardian account.
- Failures name the failing party: wallet, hosted Guardian, Miden faucet, Circle, or Arc RPC.
- The #1100 fixes (D7-D10) land with failing-first tests.

Non-goals
- Standard (single-sig) wallet variants of the live suites, an iOS funded-key suite, Android.
- Any scheduled or CI execution.
- Build stamp, run lock, post-run report check, rate-limit pacing framework (D6).
- Sweeping payouts back; pinning Circle's payout fee or attester key.

## 2 Decisions (settled)

- D1 Commits push directly to `utkarsh/feat/usdcx-integration` (#1100, worktree `~/miden/wt-usdcx-e2e`, base head 4ad006876).
- D2 Zero-secret round trip: faucet grant (USDCx is the fee asset) -> UI burn to a fresh per-run Arc EOA -> Arc payout -> EOA deposits back -> wallet receives; optional `E2E_ARC_PRIVATE_KEY` for bridge-in only.
- D3 Hard payout gate: red after 10 min without a payout; the message separates "Circle never burned" from "burned, never minted" and reports scan gaps.
- D4 Extension and iOS, local only via `yarn e2e:real`; delete the nightly workflow and the local-relayer path; extension deposit is Node-signed, iOS deposit goes through Receive -> Cross Chain with a WalletConnect counterparty.
- D5 Guardian only, hosted `https://guardian.openzeppelin.com`; suites `usdcx`, `usdcx-in`, `usdcx-ios`.
- D6 Lean harness: refuse `--skip-build`, throw instead of skip, simple bounded retries; keep probes, env refusals, `--arc-rpc`/`--arc-key`, exact ledgers, byte-level attestation decode, derived mint note id, row phase checks.
- D7 Persist the signed recipient and token; decode Circle's DepositIntent; `ready` only on full match, `failed` on mismatch; batch adoption of mints; 7-day timeout for `ready` USDCx rows.
- D8 Correct the "no destination payout" copy (en, CHANGELOG, PR body) and add a testid.
- D9 Fix the Sepolia burn-destination link and label, the MIDEN fee labels, and the "~20 min" arrival, each with a test.
- D10 Re-delete the files 83a4ba382 resurrected and the duplicate `usdcxRouteLabel`; move #1100's CHANGELOG lines out of released headings.
- D11 Merge origin/main after the review loop, re-run changed suites, run the live suites on the merged tree, then push.

## 3 Live facts the design relies on (2026-10-09)

| Fact | Value | How verified |
|---|---|---|
| Hosted Guardian | `/status` 200 `{status: ok, version: 0.18.0, git_commit: fab5f5cb2c3f, environment: testnet}`, started 2026-10-06T18:47:55Z; `/health` 404 | GET, browser UA, 15:10Z |
| Guardian ECDSA key | `/pubkey?scheme=ecdsa` commitment `0x6b3e7eda3e144c8f58980385492da4cc1e474a691771704b8f99da441609990f`, pubkey `0x02d2190fce12065f8e0d4933cd84687e68a644a5e5d39e497a65b7b1a769f5c11e` | GET, 15:10Z |
| Hosted Guardian rate limits | not measured. A container with no config limits 10/s and 60/min per IP; its production profile is 200/s and 5000/min | KB `guardian-default-rate-limits-throttle-local-e2e` (container defaults, not this operator) |
| Client pins | branch: `@miden-sdk/miden-sdk` 0.17.1 (package.json:161), guardian-client and multisig-client 0.18.0 (:170-171); origin/main: SDK 0.17.3 (package.json:160) | `git show origin/main:package.json` |
| Miden testnet node | 0.17.1, ~3 s blocks (burn note created 80982, consumed 80983, 3 s apart) | gRPC Status, probe-facts.md:71,106,113 |
| Fee asset | USDCx faucet `0x4cbdcaffe75f0a317482224dae6436`, xReserve bytes32 `0x000000000000000000000000000000004cbdcaffe75f0a317482224dae643600`; verificationBaseFee 7 | protocol config, probe-facts.md:73-74 |
| USDCx faucet | min burn 1 USDCx, domain 10007, unpaused; burn root `0x3d951250cb118282a37b8ee9395f3e3b3c30fab4dbe8c6b0093acfeed3ba04af`, fee_schedule `[119,0,0,1]`; burn tag `0x4255524e` | GetAccount, probe-facts.md:76,81 |
| Network-note tx expiry | 20 blocks after the reference block (~60 s), set by `estimate_note_fee` | miden-base v0.17.1 `standards/expiration.masm:13`, `standards/fees/fee_manager.masm:74,106` |
| Public faucet | `base_amount` 100 USDCx, `token_amounts [1,10,100]`; sampled grant notes are 0.01 USDCx | get_metadata, SyncNotes, probe-facts.md:90,98 |
| Fresh Guardian funding | grant auto-consumed, vault == grant - fee, via the in-app "Fund your wallet" path (`fundFreshGuardianThroughUi`, public-faucet.ts:238-317) | a76b56355 on testnet (32.9 s); the harness path (`mintFromPublicFaucet`, :212-236) is confirmed by the step 1 spike |
| Arc Testnet | chain 5042002, ~0.506 s blocks | probe-facts.md:2,4 |
| xReserve | `0x008888878f94C0d87defdf0B07f46B93C1934442`, domain 26; 10007 registered, remote token == fee asset bytes32; `paused`, deposits and withdrawals unpaused | eth_call, probe-facts.md:6-14 |
| Bridge-out settlement | GatewayWallet `GatewayBurned` (topic2 = depositor `0xb21c91a0F4d4c03f4b6A0fC5214F06E431FF2B2d`), then GatewayMinter `AttestationUsed` (topic2 = recipient); the burn note id is the gatewayMint salt | receipts and logs, probe-facts.md:30,112-117 |
| Payout record | 4 of 7 burns paid, 2 of 5 to Arc; Arc fee 16400 on 1 and 10 USDCx; paid ~10 s after consume | Miden gRPC + Arc logs, probe-facts.md:112-113,127-129 |
| Circle attestation | 240-byte DepositIntent, magic `0x5a2e0acd` v1; 2.3-5.4 s; signer `0xad1b523Cf15F086EB4CE54A1eF1DE2D13Fd38816` | attestations feed, probe-facts.md:43,46,51 |
| Relayer mint | 13 of 13 deposits minted, 26-34 s each | faucet txs, probe-facts.md:102 |
| Arc RPCs | arc.io: getLogs up to 5000-9999 blocks, -32012 above, intermittent 429; drpc: archive receipts, getLogs up to 100 blocks, raw-tx broadcast unverified; quicknode: 429 | JSON-RPC, probe-facts.md:5,35,64,126 |
| Deposit gas | approve + depositToRemote 0.0038-0.0067 USDC | receipts, probe-facts.md:162 |

## 4 Architecture

| Suite | Platform | Wallet | Legs | Key needed | Timeout |
|---|---|---|---|---|---|
| `usdcx` | Chrome extension | fresh Guardian on `https://guardian.openzeppelin.com` | grant, UI burn, payout, Node-signed deposit, attest, mint, receive | none (per-run key) | 75 min |
| `usdcx-in` | Chrome extension | fresh Guardian, zero balance | Node-signed deposit from funded key, attest, mint, receive | `E2E_ARC_PRIVATE_KEY` | 35 min |
| `usdcx-ios` | iOS simulator | fresh Guardian (testnet build default) | grant, UI burn, payout, Receive -> Cross Chain deposit via WalletConnect, attest, mint, receive | none (per-run key) | 90 min |

Timeouts cover fixture setup
- Test-scoped fixtures run under the test timeout, before the body, so a `test.setTimeout` in the body cannot cover them. They would get the inherited 300 s (playwright.e2e.config.ts:24). `walletA` always depends on `midenCli` (two-wallets.ts:940-944,963), whose `resolveCliPath()` may run the pinned-CLI installer for up to 2_100_000 ms (miden-cli.ts:111-131). The iOS `walletB` depends on it too (two-simulators.ts:372-373,493).
- `playwright.usdcx.config.ts` sets `timeout: 4_500_000`; the `usdcx-in` describe sets `test.describe.configure({ timeout: 2_100_000 })`; `playwright.ios.usdcx-live.config.ts` sets `timeout: 5_400_000` (3_600_000 today, :19).
- The runner installs the pinned CLI before the build and passes its path as `MIDEN_CLIENT_BIN` (miden-cli.ts:113-114), so no fixture runs the installer (section 9). The budgets below include ~2 min of fixture setup (Chrome launch, cached CLI) or the 13 min sim-pair cap (two-simulators.ts:294).

Files
- Extension: `playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts`, two describes, titles `USDCx round trip: burn to a fresh Arc key, Circle payout, deposit back` and `USDCx bridge-in from a funded Arc key`. Config `playwright.usdcx.config.ts` spreads `playwright.e2e.config.ts` with `testDir: './playwright/e2e/tests/usdcx'`, `testIgnore: undefined` (pattern of playwright.earn.config.ts:14-15).
- iOS: `playwright/e2e/ios/tests/usdcx-live-round-trip.ios.spec.ts` (round-trip title), replacing `usdcx-live-deposit.ios.spec.ts`. `playwright.ios.usdcx-live.config.ts` (testMatch :17) gains `globalSetup: ['./playwright/e2e/ios/fixtures/usdcx-live-guard.ts', './playwright/e2e/ios/fixtures/global-setup.ts']` (base value playwright.ios.config.ts:46, composed as in playwright.ios.bridge-in.config.ts:16-19).
- Deleted (D4): `.github/workflows/e2e-usdcx-live.yml`, `playwright/e2e/helpers/usdcx-relayer.ts`, `scripts/install-usdcx-relayer.sh`, `playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts`, `playwright/e2e/tests/bridge/bridge-out-usdcx.spec.ts` (needs the private `USDCX_TESTNET_REPO`, no payout check), and the `test:e2e:mobile:usdcx-live:run` script (package.json:112). Afterwards `git grep -n 'USDCX_RELAYER_\|usdcx-relayer'` is empty.
- Rewritten text:
  - playwright.ios.config.ts:18-19 (drop "needs a local deposit relayer").
  - playwright.ios.usdcx-live.config.ts:5-13 (no relayer, no CI job). Its claim that `E2E_EVM_RPC_URL` moves Arc reads is wrong (walletconnect/config.ts:57-63).
  - Runner USAGE :138-143 ("No suite here is secret-gated", "Bridge-IN ... is not here").

Isolation from every CI job
- `playwright.e2e.config.ts:23` testIgnore gains `'**/usdcx/**'` (blockchain jobs collect `tests/**`; the resilience, earn and swap configs use their own testDir).
- Naming rule: no USDCx spec is named `guardian-*.spec.ts` (playwright.guardian.config.ts:17 matches it with testIgnore cleared) or `bridge-out-epoch-guardian.spec.ts` (playwright.bridge-guardian.config.ts:15-16 spreads the base with testIgnore cleared).
- E2E Bridge collects only `tests/bridge` (playwright.bridge.config.ts:13).
- iOS: the base config ignores `'**/usdcx-live-*.ios.spec.ts'` (playwright.ios.config.ts:24). The Guardian, bridge-in and dApp iOS configs match only `guardian-*`, `bridge-in-*` and `dapp-browser.*` (playwright.ios.guardian.config.ts:12, playwright.ios.bridge-in.config.ts:13, playwright.ios.dapp.config.ts:21).
- With the workflow and the script gone, `yarn e2e:real` is the only entry, so its refusals always apply.

Guards
- Extension `test.beforeAll` and the first iOS globalSetup THROW unless `E2E_REAL_USDCX === 'true'` (set only by the runner) and `E2E_NETWORK === 'testnet'`. No `test.skip`; `usdcx-in` throws without its key.
- All env reads, key generation and RPC clients live inside test bodies.
- Each runner suite greps exactly one title; retries 0; `maxFailures` 1 (playwright.e2e.config.ts:45). A grep matching nothing exits 1 ("No tests found").

## 5 Extension Guardian round trip (`usdcx`)

Spec rules
- `test.use({ injectFeeFaucet: false })`: the default injects the fee faucet through `__TEST_SET_FEE_FAUCET__` and masks the wallet's own discovery (two-wallets.ts:866; back/main.ts:130-140).
- `const GUARDIAN_URL = getEnvironmentConfig().guardianUrl` (playwright/e2e/config/environments.ts:30); `process.env.GUARDIAN_URL` is never read.
- `address` is the composite `<bech32>_<suffix>`. Wallet lookups use it; every Node SDK parse uses `bare = address.split('_')[0]` (sdk/helpers.ts:106-107).
- Never call `midenCli.mint`, `ensureFeeFunded`, `fundAccountForFees` (each adds a FUNDING_MIDEN consume row) or `claimAllNotes` (a manual consume beside a requeued Guardian consume overlaps proposals).
- Guardian accounts are private (guardian/account.ts:431), so the vault always comes from `vaultBalanceByFaucetId` (balance-truth.ts:133).
- Row status: 2 Completed is success; 4 Unconfirmed is pending for consumes; 3 Failed fails at once with `stage` and `rawError`.
- Visible root: only `BridgeIntentWatcher` moves `usdcxBurn.phase` and bridged-receive phases (burn poll wallet-prompts.ts:192). It is mounted in the UI root (front/provider.tsx:234) and polls every 8 s, only while its document is visible and leads (BridgeIntentWatcher.tsx:3,56-60,92-125). `walletA.page` stays on a wallet route (Home or `#/history`) for the whole run: never closed, backgrounded or sent to a non-wallet URL.
- Service-worker calls go through `swOf(walletA).evaluate` (playwright/e2e/helpers/swap.ts:52).

Flow (timeout 75 min; budgets with fixture setup sum to ~59 min, and the payout wait overlaps the post-burn settle)
1. **guardian_wallet** (3 min).
   - `walletA.createGuardianWallet(GUARDIAN_URL)` (wallet-page.ts:663-668); throw unless `walletA.ownsProfile` (two-wallets.ts:67); call `trackGuardianCommitments()` at once (two-wallets.ts:709-712).
   - Poll until `currentGuardianEndpoint()` (wallet-page.ts:1435) == `GUARDIAN_URL` and the account type is `guardian`.
   - Record `identity = guardianIdentity(GUARDIAN_URL)`.
2. **arc_state** (30 s). `readXReserveDomainState()` reads:
   - `isRemoteDomainRegistered(10007)`, with `paused()`, `domainDepositsPaused(10007)` and `domainWithdrawalsPaused(10007)` all false.
   - `remoteToken = getRemoteToken(10007, USDC)` and `depositor = getRemoteDomainDepositor(10007)` (read, never hardcoded).
   - Circle `/v1/balances/10007` is context only.
3. **fund** (6 min).
   - `mintFromPublicFaucet(publicFaucetApiUrl('testnet'), bare)` at `base_amount` (public-faucet.ts:212-236) -> `grantNoteId`; `waitForPublicNoteCommitment(getEnvironmentConfig().rpcUrl, grantNoteId)` (public-note-commitment.ts:30-35).
   - Exactly one consume row whose `noteIds` include `grantNoteId`, status 2 (it is also the deploy).
   - `G` = the grant note's asset from the Node oracle; `f0 = row.feeAmount` (defined, > 0); `row.feeFaucetId` == native; `waitForVaultBalanceByFaucetId(native, G - f0)` exact.
   - Throw `faucet granted <G>, need >= 11 USDCx` unless `G - f0 >= BURN_UNITS + GRANT_MARGIN_UNITS`.
   - `midenAccountHexToXReserveRecipient(accountHex(native)) == remoteToken` (recipient.ts:19-25; same encoding, probe-facts.md:74).
   - `assertGuardianAuth(address, { signerCount: 2, threshold: 2, guardianCommitment: identity.commitment })` (wallet-page.ts:1402-1430).
4. **settle_grant** (up to 4 min).
   - `waitForGuardianSettled(120_000)` drains the queue, then waits on the ledger, each for up to 120 s (two-wallets.ts:713-724).
   - Why: the burn cannot be requeued and fails after 12 x 5 s of 409s (serialize.ts:271-288; transaction/index.ts:193-206).
   - Its "no delta push was observed" throw (guardian-commitments.ts:154-159) is a hard failure: tracking started late.
5. **fresh_key** (10 s).
   - `newArcKey()`; `recordArcKey()` writes `{iso, address, privateKey, walletAddress}` with mode 0600 to `~/.miden-e2e/arc-keys/<iso>-<address>.json` BEFORE the burn (outside `test-results/`).
   - The key is never logged or attached.
   - `readArcUsdc(key) == 0n`; `arcFromBlock = head - 120`.
6. **burn_via_ui** (5 min). No Queued or GeneratingTransaction row for the account. `bridgeOutUsdcx(walletA, { destAddress: key, amount: '10', nativeTokenId })`:
   - Open `fullpage.html#/send?tokenId=<native bech32>`. SendFlow reads `tokenId` (SendManager.tsx:975), and the preselect effect sets the token once balances load (:439-447). A bare `/send` starts with no token (:297), so `isUsdcxWithdrawalAvailable` is false (:371) and the recipient step offers only Sepolia (:845).
   - Fill `send-recipient-input` with the key; poll until `send-network-arc-testnet` reads `Arc Testnet` and `send-network-sepolia` is absent. Never click the chip: with one network it is inert (NetworkField.tsx:35,49), and the effect at SendManager.tsx:767-771 selects `arc-testnet`.
   - `send-recipient-confirm`, `send-amount-input` `10`, `send-amount-confirm`, `bridge-route-usdcx` (preselected, :372-373), `bridge-route-confirm`.
   - Review screen:
     - The URL has `network=arc-testnet` (ReviewTransaction.tsx:93,559), and the network row reads `Arc Testnet` (:659-662).
     - `getByTestId('usdcx-burn-notice')` on Route and Review equals the new en string.
     - The fee rows name the native symbol (fix c).
     - Take screenshots, then wait for `send-review-submit` to enable, submit, and wait for `/generating-transaction/`.
7. **burn_confirmed** (5 min, 3 s poll), then **settle_burn** (up to 4 min). `readBridgedSendRows` finds exactly one row with provider `usdcx`.
   - When it reaches status 2, read `resultBytes` at once and decode `burnOutputs(resultBytes, noteId)` before waiting on the phase. The reaper releases them 10 min after `completedAt` (trim-result-bytes.ts:44-47) and stamps `resultReleasedAt` (db/types.ts:692-696).
   - Exactly three outputs:
     - the burn note (id == `usdcxBurn.noteId`, N native);
     - one sponsorship note (== live `fee_schedule[burn root]`, 119 today);
     - one 0xfee note (== `row.feeAmount` f1).
   - `V2 == V1 - (N + f1 + s)` with `V1 = G - f0`; f1 is never pinned.
   - Then: `usdcxBurn.phase === 'confirmed'`; `stageTimestamps` has `creating-proposal` and `signing-proposal` (transaction/index.ts:3140,3581); `destinationAddress` == key (case-insensitive); `destinationNetwork` 5042002.
   - Chain oracle `burnEvidence(noteId)`:
     - asset N, tag `0x4255524e`, burn script root;
     - NetworkAccountTarget plus scheme-5 payload `[26,0,0,0]` + LE limbs of the key;
     - sender == `bare`, nullifier committed;
     - the consume block and its header timestamp `consumeTs`.
   - History (`#/history`, then back Home): the 'Burn USDCx Via' row's `history-status-pill` reads `Burn confirmed`. The destination link points at `explorer.testnet.arc.io`, and the network reads `Arc Testnet` (fix c).
   - `waitForGuardianSettled(120_000)` again, so a discarded burn candidate fails here with the Guardian's message, not later as a stalled mint consume.
8. **payout** (HARD, deadline `consumeTs` + 10 min). `waitForGatewayPayout` uses one pinned read endpoint at a time, primary first:
   - Every 5 s, read `balanceOf(key)` at an explicit block B.
   - When the balance is > 0, on that same endpoint:
     - `scanArcLogs(GATEWAY_MINTER, [ATTESTATION_USED_TOPIC, pad(USDC), pad(key)], arcFromBlock..B)` in 1000-block chunks, halving to 100 on range errors.
     - Retry for up to 60 s while the endpoint's head < B.
     - An endpoint error restarts the cycle on the next endpoint with a fresh B.
     - Exactly one log.
   - Log data: sourceDomain 26, sourceDepositor == pad(`depositor`), value == balance at B; `getTransaction(log.tx).input` contains the burn note id.
   - `fee = N - value` in `[1, MAX_PAYOUT_FEE_UNITS]`; fee and latency attached.
9. **deposit_submit** (2 min). Require `value >= DEPOSIT_UNITS + GAS_RESERVE_UNITS`. `submitDepositToMiden({ privateKey, units: M, recipientHex: accountHex(bare) })` returns `{ approveHash?, depositHash }`:
   - one write endpoint (the primary) with a local nonce; 'already known' counts as success by hash;
   - approve exactly M, and only when the allowance is below M;
   - `simulateContract` first, so reverts decode (DomainDepositsPaused and similar errors join the helper ABI).
10. **tracking_rows** (10 s). Run as soon as `depositHash` exists, before any receipt wait, as the product does at deposit.ts:100-101: adoption is one-shot (bridge-in.ts:275-313, complete.ts:299-307). `createUsdcxBridgeReceive(walletA, args)` is a typed wrapper over `__TEST_CREATE_BRIDGE_RECEIVE__` (bridge-in-test-hooks.ts:23-35,72-83):
    - POSITIVE: `accountId: address`, `amount: String(M)`, `faucetId:` native bech32, `provider: 'usdcx'`, `sourceAddress:` key, `sourceAmount: '1'`, `sourceSymbol: 'USDC'`, `evmTxHash: depositHash`.
    - NEGATIVE: same, with `amount: '2000000000'`, `sourceAddress: '0xe88f781e6cc8b7496f259200b57e22cb9457ff99'`, `sourceAmount: '2000'`, `evmTxHash: '0x370bf19aefa34f6f07d7b731d5b5f323a364c6f4116a22768d4e44a16ffeca4d'`, which Circle attested to another recipient (probe-facts.md:47).
    - The wrapper is typed because a row without `provider: 'usdcx'` takes the Epoch branch and never settles (bridge-receive.ts:79-87,154-156).
    - `bridgeReceiveState(walletA, id)` for each row: `usdcxRemoteRecipient == midenAccountHexToXReserveRecipient(accountHex(bare))` and `usdcxRemoteToken == remoteToken`. The hook persists both through `deposit-target.ts` (fix a).
11. **deposit_confirm** (2 min). Read receipts on the write endpoint. `DepositedToRemote` carries value M, localDepositor key, remoteRecipient R, remoteDomain 10007, remoteToken, maxFee 0, hookData `0x`.
12. **attest** (3 min, 3 s poll). `waitForXReserveAttestation(depositHash)` returns exactly one domain-10007 entry.
    - `decodeDepositIntent` (the harness's own byte reader): magic `0x5a2e0acd`, v1, amount@8 == M, domain@40 == 10007, remoteToken@44, recipient@76 == R, localToken@108 == Arc USDC, localDepositor@140 == key, maxFee@172 == 0, hookLen@236 == 0, length 240.
    - `messageHash == keccak256(payload)`; the signer is recovered and attached.
    - `matchUsdcxDepositAttestation` must return `attested` on this payload.
13. **mint** (6 min).
    - `deriveUsdcxMintNoteId({ faucetHex, recipientHex, units: M, nonce })` (serial = Poseidon2(nonce limbs), P2ID, `NoteTag.withAccountTarget`).
    - `waitForPublicNoteCommitment(rpcUrl, mintNoteId, 360_000)`.
    - `note(mintNoteId)`: sender == faucet, tag == wallet account target, asset == M native.
14. **receive** (6 min; Guardian backpressure doubles 15 s to 240 s, transaction/index.ts:306,326-330). Service-worker auto-consume only.
    - Consume row with `noteIds` including `mintNoteId`, status 2: amount M, `feeFaucetId` native, `displayMessage` 'Bridged from EVM', `extraInputs.bridgeIn.bridgeReceiveTxId` == POSITIVE id.
    - POSITIVE: observed phases stay monotone within {delivering, ready, received}; ends `received`, `midenNoteId == mintNoteId`, no `error`.
    - NEGATIVE: ends `failed` with 'Circle attested this deposit to a different Miden account.'; never observed `ready`.
    - `V3 == V2 + M - f2`; whole ledger `V3 == G - f0 - N - f1 - s + M - f2`.
15. **evidence** (`finally`). Attach `usdcx-round-trip-evidence.json`: ids, hashes, fees, latencies, phase timeline, Guardian identity (URL, version, git_commit, commitment), settle durations. Never the key.

Constants (`usdcx-constants.ts`, no env overrides):
- `BURN_UNITS` 10_000_000n (only 1 and 10 USDCx Arc burns have been seen paid)
- `DEPOSIT_UNITS` 1_000_000n, `GAS_RESERVE_UNITS` 50_000n, `GRANT_MARGIN_UNITS` 1_000_000n
- `MAX_PAYOUT_FEE_UNITS` 100_000n, `PAYOUT_TIMEOUT_MS` 600_000, `ARC_LOG_CHUNK` 1000

## 6 Extension funded-key bridge-in (`usdcx-in`)

Title `USDCx bridge-in from a funded Arc key`, describe timeout 35 min (budgets with fixture setup ~25 min). Section 5 rules apply; no faucet grant is spent.
1. **guardian_wallet** (3 min): section 5 step 1. Vault zero, account undeployed.
2. **arc_state** (30 s): registered; `paused` and `domainDepositsPaused` false.
3. **funded_key** (10 s): throw unless `E2E_ARC_PRIVATE_KEY` is set; USDC >= `DEPOSIT_UNITS + GAS_RESERVE_UNITS`.
   - Source of the key: any paid `usdcx` run leaves ~9 USDC on its per-run key, recorded in the 0600 ledger (`~/.miden-e2e/arc-keys/`). That key is the default funded key, so `usdcx-in` needs no faucet.circle.com drip; a manually funded key works the same way. USAGE and e2e-architecture.md say so.
4. **deposit_submit**, **tracking_rows** (POSITIVE only, `sourceAddress` = the funded key's address), **deposit_confirm**, **attest**, **mint**: section 5 steps 9-13.
5. **receive** (6 min):
   - The mint consume is the account's first transaction and its deploy.
   - Vault == `M - f2` exactly; then `assertGuardianAuth` as in section 5 step 3.
   - POSITIVE ends `received`. A single Guardian transaction needs no settle wait.

## 7 iOS Guardian round trip (`usdcx-ios`)

Rules
- No route interception on iOS. `trackGuardianCommitments` and `waitForGuardianSettled` exist only on the Chrome `GuardianFaultTestApi` (two-wallets.ts:100,109,709-724), wired through network-faults.ts:381; ios-wallet-page.ts defines neither.
- The fixture launches wallet B, which stays unused. It stays destructured because the failure report is written in its teardown (two-simulators.ts:512-542).
- Never reload or lock wallet A: a reload drops the vault key (ios-wallet-page.ts:562-566), and a locked Guardian cannot sign the mint consume. The app stays in the foreground so `BridgeIntentWatcher` polls.
- Section 5's composite-id, no-CLI-funding, private-account and row-status rules apply.

Flow (timeout 90 min; budgets with the 13 min sim cap sum to ~76 min)
1. **guardian_wallet** (3 min).
   - `walletA.createGuardianWallet()` binds to the build's network default (ios-wallet-page.ts:387; networks-config.ts:111-122); the mobile E2E build bakes `MIDEN_E2E_DISABLE_ENDPOINT_OVERRIDES=true` (package.json:107).
   - New `currentAccountInfo()` must return type `guardian` and `guardianEndpoint === 'https://guardian.openzeppelin.com'`.
   - Record `identity`.
2. **arc_state** (30 s): section 5 step 2.
3. **key** (10 s). `newArcKey()` and the ledger; `cp = new WcCounterparty({ privateKey, chainId: 5042002, readTransport: arcReadTransport(), writeRpcUrl: ARC_DRPC_URL })`.
4. **connect_evm** (5 min).
   - `cp.connectWithRetry` with a fresh `connected` promise per attempt (one-shot today, wc-counterparty.ts:94-96,179-188).
   - `reownState().address == key`.
   - Runs early, so a relay failure costs no funds.
5. **fund** (6 min).
   - `faucetHex = '0x' + remoteToken.slice(34, 64)` (bytes 16-30, layout at recipient.ts:9-12). The hook's `AccountId.fromHex` takes only the 15-byte id (faucet-address.ts:12-13; sdk/helpers.ts:106-114), so passing the bytes32 throws.
   - Assert `midenAccountHexToXReserveRecipient(faucetHex) === remoteToken`, then `faucetBech32 = hexToBech32Faucet(faucetHex)` (ios-wallet-page.ts:145-156).
   - Vault 0; grant to `bare`; `waitForPublicNoteCommitment(rpcUrl, grantNoteId)`; `waitForNotesConsumed([grantNoteId])` over the CDP reader (no Accept All: NativeNoteAutoConsumeManager.tsx:84 consumes it).
   - `vault1 == G - f0` exactly; same 11 USDCx floor.
   - `getGuardianAuthInfo(address)`: 2 signers, `update_guardian` 2, and a new check that `guardianCommitment == identity.commitment` (field returned at ios-wallet-page.ts:944-960, stashed by fetchBalances.ts:149-155).
6. **settle** (2 min). Wait until the grant note's nullifier is committed on chain (Node oracle). The Guardian promotes a committed candidate on its 3 s and 10 s passes (KB `guardian-state-advances-asynchronously-after-execute`), inside the burn's 60 s 409 window.
7. **burn** (5 min) and **burn_confirmed** (5 min). `burnUsdcxViaSendFlow({ recipient: key, amount: '10', nativeTokenId: faucetBech32 })`:
   - `navigateTo('/send?tokenId=<faucetBech32>')` (ios-wallet-page.ts:359-363), then section 5 step 6's order and checks.
   - Then the detach wait, factored out of `sendTokens` (:770-787).
   - `prepareSendReview` is not reused: it hard-clicks `send-network-sepolia` for any 0x recipient (:699-702).
   - Rows come from the new CDP readers, and `resultBytes` is read at Completed. All section 5 step 7 assertions apply except the settle wait.
8. **payout**: section 5 step 8.
9. **deposit_via_ui** (6 min). Re-check WalletConnect and reconnect if needed.
   - From here until both receipts are read, every harness Arc read and every counterparty write goes to drpc (`ARC_DRPC_URL`). None goes to `rpc.testnet.arc.io`, the app's only Arc RPC (walletconnect/config.ts:15), even when `--arc-rpc` names it.
   - UI: `openBridgeDeposit`, `selectBridgeToken('CIRCLE_USDC')`, `enterBridgeAmount('1')`, `confirmBridgeRouteUsdcx`, `confirmBridgeDeposit`.
   - `cp.requests`:
     - every chainId is `eip155:5042002`;
     - an approve to xReserve of exactly M appears when the prior allowance was below M (deposit.ts:95-97);
     - the deposit decodes to `(M, 10007, R, 0x3600000000000000000000000000000000000000, 0, 0x)`, with `R = midenAccountHexToXReserveRecipient(accountHex(bare))` derived in Node.
   - Native delta pinned to the receipt blocks: `balance(approveBlock - 1) - balance(depositBlock) == M * 1e12 + sum(gasUsed * effectiveGasPrice)`.
10. **row** (1 min). `latestBridgeReceive('usdcx')` (extended, section 8): `usdcxRemoteRecipient == R`, `usdcxRemoteToken == remoteToken`, `evmTxHash` == the deposit hash; phases monotone within {delivering, ready, received}.
11. **attest** (3 min), **mint** (6 min): section 5 steps 12-13.
12. **received** (10 min).
    - The row ends `received`, never `failed`, with `midenNoteId == mintNoteId`.
    - The linked consume row has `bridgeIn.bridgeReceiveTxId` == row id, `noteIds [mintNoteId]` and 'Bridged from EVM'.
    - `vault4 == G - f0 - N - f1 - s + M - f2`.
13. **finally**: evidence JSON (no key) and `cp.stop()`.

## 8 Shared harness modules

- `playwright/e2e/helpers/usdcx-constants.ts`: constants only (no Playwright or fixture imports).
  - Section 5 amounts and timeouts.
  - `GATEWAY_MINTER` `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`; `ATTESTATION_USED_TOPIC` `0xbb312ce0cc311b2cb0746e09ccd2f91fdb9e2ac755d2f11c65300eb0d0fffd63`.
  - `GATEWAY_WALLET` `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`; `GATEWAY_BURNED_TOPIC` `0x12ee2719e7e2dec9f2a0041286b66669153dff0d36719f692b8bbaa4dfe0aa87`.
  - `DEFAULT_ARC_RPCS` (arc.io, quicknode, drpc); `ARC_DRPC_URL` `https://rpc.drpc.testnet.arc.io`; `ARC_KEY_LEDGER_DIR`.
- `playwright/e2e/helpers/arc-usdcx.ts` (viem; client and clock injectable):
  - clients and keys: `arcReadClient`, `arcWriteClient`, `arcReadTransport`, `newArcKey`, `recordArcKey`, `readArcUsdc`;
  - chain reads: `readXReserveDomainState`, `scanArcLogs`, `scanGatewayBurns`, `waitForGatewayPayout`, `payoutFailureMessage`;
  - deposit: `submitDepositToMiden`, `confirmDepositToMiden`;
  - attestation: `waitForXReserveAttestation` (wraps `fetchXReserveAttestations`, attestation.ts:54-75), `decodeDepositIntent`, `assertDepositIntent`.
  - It never imports `src/lib/usdcx/deposit.ts`, which pulls in `lib/miden/activity`.
- `playwright/e2e/helpers/usdcx-guardian.ts`: `guardianIdentity(url)` (GET `/status` and `/pubkey?scheme=ecdsa`), `classifyGuardianBurnFailure(row)`, `assertNoGuardianOpInFlight(rows, account)`.
- `playwright/e2e/helpers/usdcx-miden.ts` over `usdcx-chain-evidence.mjs` (typed `execFile`, 30 s; subcommands replace the hardcoded `0x1111` limbs): `accountHex`, `burnEvidence`, `burnOutputs` (outputs plus the live fee_schedule entry), `deriveUsdcxMintNoteId`, `note`, `nullifierCommitted`. Bare ids only.
- `playwright/e2e/helpers/history.ts`: `readTransactionRows` (:204-226) also returns `extraInputs` (bigints stringified), `stageTimestamps` and `submitEvidence`.
- `playwright/e2e/helpers/bridge.ts`:
  - `bridgeOutUsdcx`, following section 5 step 6's order and modelled on `bridgeOutFast` (:90).
  - `readBridgedSendRows` (:375-430) also returns `id`, `feeAmount` and `feeFaucetId` (stringified as at history.ts:220-222), `stageTimestamps`, `completedAt`, `resultReleasedAt`, `resultBytes` (base64) and `submitEvidence`.
  - `usdcxBurn` typed with `attemptCount` and `lastAttemptBlockNum` (db/types.ts:260-261).
  - Typed wrappers `createUsdcxBridgeReceive` and `bridgeReceiveState`.
- `src/lib/miden/activity/bridge-in-test-hooks.ts` (MIDEN_E2E_TEST builds only):
  - `__TEST_BRIDGE_RECEIVE_STATE__` (:89-101) and `__TEST_LATEST_BRIDGE_RECEIVE__` (:61-67) also return `evmTxHash`, `error`, `midenNoteId`, `usdcxRemoteRecipient` and `usdcxRemoteToken`.
  - `__TEST_CREATE_BRIDGE_RECEIVE__` persists the recipient and token through `deposit-target.ts`.
- `playwright/e2e/ios/helpers/ios-wallet-page.ts`: `currentAccountInfo`, `burnUsdcxViaSendFlow`, `readTransactionRows` and `readBridgedSendRows` (CDP `stashAndPoll`, :285-305, same fields as Chrome), `vaultBaseUnits`, `waitForNotesConsumed`; `latestBridgeReceive` (:200) is typed with the new fields.
- `playwright/e2e/ios/helpers/wc-counterparty-core.ts` (new; no dependencies, like wc-counterparty-env.ts:1-9): per-attempt connect promise, a chainId log line per request, and the read/write endpoint split. `wc-counterparty.ts` stays a thin adapter; the hermetic callers are unchanged.
- `balance-script.ts` gains `buildVaultRowsScript`; `balance-truth.ts` exports `rowBaseUnits` (:117).
- Unit tests: CI jest runs `playwright/**/*.test.ts` (jest.config.ts:172-179). So every new test stubs `fetch` and `execFile`, makes no network call, and uses `@jest-environment node`.
  - `arc-usdcx.test.ts`: captured logs of the two paid Arc burns and the `0x370bf19a` attestation, plus gap, halving, pinned-endpoint and three-way-message cases.
  - Also `usdcx-guardian.test.ts`, `usdcx-miden.test.ts`, `ios-wallet-page.test.ts` and `wc-counterparty-core.test.ts`.
  - The new files add zero `scripts/lint-e2e-harness.mjs` violations.

## 9 Runner and preflight

Suites (`scripts/e2e-real.mjs` SUITES, :64-106), all `networks: ['testnet']`, `retries: 0`
- `usdcx`: `playwright.usdcx.config.ts`, grep `USDCx round trip`, probes `usdcx, usdcx-guardian, grant, arc-payout`.
- `usdcx-in`: same config, grep `funded Arc key`, probes `usdcx, usdcx-guardian, funded-key`.
- `usdcx-ios`: `playwright.ios.usdcx-live.config.ts`, `build: 'test:e2e:mobile:build'`, grep `USDCx round trip`, probes `usdcx, usdcx-guardian, grant, arc-payout, arc-write, ios`.
- The build becomes `run('yarn', [suite.build ?? 'test:e2e:blockchain:build'], env)` (hardcoded at :1020 today).
- Pinned CLI (usdcx suites, after the probes and before the build): unless `MIDEN_CLIENT_BIN` is exported, run `node scripts/install-pinned-miden-cli.cjs install` (up to 35 min on a cold cache). Its last stdout line goes to the test env as `MIDEN_CLIENT_BIN`. A failed install fails the run.

Flags
- `--arc-rpc` / `E2E_ARC_RPC_URL`: primary Arc RPC, prepended to `DEFAULT_ARC_RPCS`; empty refused.
- `--arc-key` / `E2E_ARC_PRIVATE_KEY`: joins `optionNames` (:183), validated with `/^(0x)?[0-9a-f]{64}$/i` and normalized without echo; only the address is ever printed.

Refusals (names only, never values) live in `resolveOperatorInput` (:275) and apply only to usdcx suites.
- Scope: that function runs after the indexer early return (:209, :935-941), which E2E Bridge uses via `--agglayer-indexer-only` (e2e-bridge.yml:125). It also leaves swap-guardian's `GUARDIAN_URL` override untouched (swap-guardian.spec.ts:21; probeGuardian :727).
- A usdcx suite on devnet, or with `--skip-build`.
- Exported `E2E_EVM_RPC_URL`: baked into the bundle's Sepolia and Epoch RPCs (walletconnect/config.ts:43-46; epoch/client.ts:16-20; epoch/evm-account.ts:81) and read as the counterparty's default RPC (wc-counterparty-env.ts:23). Arc ignores it (config.ts:57-63).
- Exported `MIDEN_E2E_USDCX_CHAIN`: retargets `USDCX_CHAIN` to Sepolia (usdcx/constant.ts:10-13); the hermetic Bridge-IN job sets it (e2e-bridge-in.yml:60).
- Exported `MIDEN_FEE_FAUCET_ID`: overrides the fee faucet (effective-endpoints.ts:140).
- Exported `GUARDIAN_URL`: nothing in these suites reads it (the specs use the environment table, and no vite config defines it), so a set value would silently not apply.
- `USDCX_LIVE_EVM_PRIVATE_KEY` ("renamed: export E2E_ARC_PRIVATE_KEY").
- A key that is malformed, given twice, an option name used as the value, or empty (the parser already refuses the `=` form); `--arc-key` on any suite other than `usdcx-in`; `usdcx-in` without a key.
- The Arc key is stripped from every build env, and from every test env except `usdcx-in`'s; `E2E_SEPOLIA_PRIVATE_KEY` is stripped from the build env.

Test env: `E2E_NETWORK`, `E2E_REAL_USDCX: 'true'`, `E2E_ARC_RPC_URL`, `MIDEN_CLIENT_BIN`, and the key for `usdcx-in`.

Probes (read-only, before any build). Each Arc or Circle call retries at most 3 times on HTTP 429 or JSON-RPC -32005, waiting for Retry-After capped at 10 s; -32012 and other errors fail at once. `rpc()` (:352) attaches `status`, `code` and `retryAfter` to its errors.

| Probe | Suites | Check | Kind |
|---|---|---|---|
| Arc RPC | all | chainId 5042002, head | hard |
| xReserve | all | code, `isRemoteDomainRegistered(10007)`, nonzero `getRemoteToken` | hard |
| xReserve pause | all | `paused`, `domainDepositsPaused` false; `domainWithdrawalsPaused` false with `arc-payout` | hard |
| Circle xReserve API | all | `/v1/info` lists 10007 with remoteTokenIdentifier == remoteToken, source 26 at xReserve | hard |
| USDCx native asset | all | `discoverFeeFaucetId` (playwright/e2e/helpers/fee-faucet.ts:33) in a ts-node child; bytes32 == remoteToken | hard |
| Guardian identity | all | new `probeUsdcxGuardian` on `GUARDIAN_URL[network]` (:55-58) only: `/status` status `ok`, environment == `--network`; `/pubkey?scheme=ecdsa` has commitment and pubkey. `probeGuardian` (:722) stays as is for swap-guardian | hard |
| Guardian version | all | `/status` version vs package.json `@openzeppelin/guardian-client` | advisory |
| USDCx faucet grant | usdcx, usdcx-ios | get_metadata decimals 6, `base_amount` >= 11 USDCx, balance >= `base_amount` | hard |
| Gateway minter | usdcx, usdcx-ios | `xReserve.gatewayMinter()` == `GATEWAY_MINTER` with code; one 1000-block AttestationUsed getLogs | hard |
| Arc write endpoint | usdcx-ios | drpc chainId 5042002; `eth_sendRawTransaction('0x00')` answers a decode error, not a method or plan refusal | hard |
| Recent payouts | usdcx, usdcx-ios | count and age of recent GatewayBurned from `depositor` | advisory |
| Arc funded key | usdcx-in | USDC >= M + gas reserve (pattern of `probeFundedKey`, :776) | hard |
| iOS toolchain | usdcx-ios | darwin, Node >= 22, `xcrun simctl help`, `xcodebuild -version` | hard |

USAGE (:108) gains the three suites and the flags. Lines :138-143 are rewritten to say that `usdcx-in` needs a key, that bridge-in runs on the extension with a Node-signed deposit, and that only one usdcx suite may run at a time (there is no run lock).

Runner tests (`scripts/e2e-real.test.ts`, stub `scripts/e2e-real.fetch-stub.mjs`)
- Every refusal, with the key absent from stdout and stderr. Child env per suite and phase: the build env has no key, and `MIDEN_CLIENT_BIN` reaches the test env.
- Scope: `swap-guardian` with `GUARDIAN_URL` exported still probes the override; `--agglayer-indexer-only` with every variable the usdcx suites refuse exported behaves as today.
- Stubbed `--preflight-only` per suite, with one negative case per hard probe. The bounded retry (429, 429, ok; -32012 fails at once). The iOS probe with injected platform and spawns.
- Grep contract: each suite's grep, compiled case-insensitive, matches exactly its intended title as read from the spec files.
- Pins: the runner's USDCx constants equal `usdcx-constants.ts` and `src/lib/usdcx/constant.ts` (pattern of e2e-real.test.ts:711-714).

## 10 Product fixes

(a) Attestation match, batch adoption, timeout (D7)
- Defect:
  - `isUsdcxDepositAttested` checks only the domain (attestation.ts:81-85), and `reconcileUsdcxRow` then sets `ready` (bridge-receive.ts:119-125).
  - `readUnsettledRows` drops `ready` rows (:160-175), so the 7-day cutoff (:141-143) never fails them.
  - Only one-note consumes are paired (complete.ts:301).
- New `src/lib/usdcx/deposit-target.ts`:
  - `usdcxRemoteRecipientFor(accountRef) = midenAccountHexToXReserveRecipient(accountRefToSdk(accountRef).toString())`, byte-identical to the argument the wallet signs (EvmBridgeDepositScreen.tsx:741).
  - `accountRefToSdk` strips the composite routing suffix that every `WalletAccount.publicKey` carries (sdk/helpers.ts:31-41,59-63).
  - `usdcxRemoteTokenFor(faucetRef)` works the same way.
- `runUsdcxDeposit` writes `{ evmTxHash, usdcxRemoteRecipient, usdcxRemoteToken }` at its first `updatePhase` (deposit.ts:101): the recipient is the one it signed, the token is `usdcxRemoteTokenFor(await getNativeAssetId())`.
  - The `extra` Pick of `updateBridgedReceivePhase` (complete.ts:1504-1509) widens to both fields; `updatePhase` is typed from it (deposit.ts:36).
  - Both join `IBridgedReceiveExtraInputs` (db/types.ts:142) as optional fields.
- `attestation.ts` adds `decodeXReserveDepositIntent(payload)`, which returns undefined unless the magic, the version and length 240 + hookLen hold. It also adds `matchUsdcxDepositAttestation(list, expected)`, which compares hex case-insensitively:
  - an empty list: `pending`; entries but none for domain 10007: `mismatch{remoteDomain}`;
  - a 10007 entry that does not decode: `unreadable`; payload domain@40 != the entry's remoteDomain: `mismatch{remoteDomain}`;
  - amount, recipient, remote token and domain all equal: `attested`; otherwise `mismatch`, naming the first difference in the order remoteDomain, remoteToken, recipient, amount;
  - across entries, `attested` > `unreadable` > `mismatch` > `pending`.
  - maxFee and hookData are not compared: a maxFee 1 USDC deposit was minted in full (probe-facts.md:88).
  - `isUsdcxDepositAttested` is removed.
- `bridge-receive.ts`:
  - `attested` -> `ready`; `mismatch` -> `failed` with "Circle attested this deposit to a different <network|token|Miden account|amount>."; `pending` and `unreadable` write nothing (`unreadable` warns once per row id).
  - A `ready` USDCx row is not re-polled.
  - `readUnsettledRows` keeps `ready` USDCx rows that are not `restoredFromBackup`, so the cutoff fails them.
  - Restored `ready` rows stay excluded, so the restored branch (:137-140) never flips a restored Confirmed deposit to Failed. AggLayer and Epoch are unchanged.
  - A row without the persisted fields (written before this fix) stays pending until adoption or the timeout.
- Batch adoption: `adoptUsdcxDeliveriesInBatch` in `bridge-in.ts`, called at complete.ts:301 when `inputNotes.length > 1` and the registry path applied nothing.
  - For each input note whose sender and asset are the native faucet, in order:
    - call `takeUsdcxBridgeInInfo` (bridge-in.ts:275-313) with that note's amount;
    - then call `updateBridgedReceivePhase(info.bridgeReceiveTxId, 'received', { midenNoteId }, { amount, faucetId: native, transactionId })`.
  - That is the same `received` argument the one-note path passes (bridge-in.ts:141-146), so the row keeps its amount, faucet, hash and 'Bridged from EVM' (complete.ts:1529-1534).
  - The batch consume row is not relabelled. Composite and bare ids both match (activity/utils.ts:2-7).
- Failing-first tests:
  - `bridge-receive.usdcx.test.ts` (new): the real attestation module, with fetch returning the captured `0x370bf19a` response. Today a row persisted for another account reaches `ready`.
  - `attestation.test.ts`, on captured fixtures:
    - a fully matching entry is `attested`, and each single-field difference is a `mismatch`;
    - an entry for Canton 10001 only, and a payload domain that differs from its entry, are `mismatch{remoteDomain}`;
    - the old token and the malformed recipients `0x908904ec`/`0xb4dce6ec` are mismatches;
    - a bad magic, v2 and a payload one byte too long or too short are `unreadable`;
    - a mismatching entry next to a matching one is `attested`.
  - `bridge-receive.test.ts`:
    - an 8-day USDCx `ready` row fails 'Bridge delivery timed out.', and a fresh one is not fetched;
    - an 8-day AggLayer `ready` row and a restored USDCx `ready` row are untouched;
    - `pending` and `unreadable` make no write, and `unreadable` logs once;
    - a Canton-only answer fails the row with 'Circle attested this deposit to a different network.'.
  - `deposit.test.ts`: both fields are persisted at the first `updatePhase`. `deposit-target.test.ts`: composite and bare ids give the same bytes32 as the screen's derivation.
  - `bridge-in.test.ts`: two same-amount mints in one batch adopt two rows, each with amount, faucet, transaction id and 'Bridged from EVM'.

(b) Payout copy (D8)
- `usdcxBurnTestNotice` becomes: "After the faucet processes the burn, Circle sends the USDC, minus its fee, to the destination address on Arc Testnet. On testnet a payout can be delayed or missed, and the wallet tracks only the Miden side. The burn note and destination address are public. Published burn notes cannot be reclaimed."
- Edit it by hand in `en/en.json` (:7) and `en/messages.json` (:22-25, both message and englishSource): `format-locales.js` skips en on purpose (:18-21,31). Other locales keep their text until the CI DeepL job regenerates them.
- Add `data-testid="usdcx-burn-notice"` at Route.tsx:147 and ReviewTransaction.tsx:705.
- Failing first: `locale-bundle-parity.test.ts` asserts that no en value matches `/without a destination payout|no destination(-chain)? payout/i`.

(c) Other stale USDCx defects (D9)
- Burn history (BridgeClaimSection.tsx:39,322,326):
  - Take the name and explorer from the row's persisted destination, `getChain(entry.bridgeDestinationNetwork ?? DEFAULT_CHAIN_ID)` (walletconnect/config.ts:66,75; SUPPORTED_CHAINS :49-64), as `bridgeRowDisplay` already does (transactionUtils.ts:349).
  - This replaces `SEPOLIA_ADDRESS_URL` and the literal 'Sepolia'.
  - Test: a usdcx entry with `bridgeDestinationNetwork` 5042002 links `explorer.testnet.arc.io/address/<dest>` and reads `Arc Testnet`, never `sepolia.etherscan.io`; an Epoch entry still reads Sepolia.
- Fee labels:
  - `usdcxMidenFees` "MIDEN fees" (en.json:5, Route.tsx:139) becomes "$symbol$ fees".
  - `usdcxSponsorshipFee` (en.json:17, ReviewTransaction.tsx:687) becomes "Paid in $symbol$, including faucet execution sponsorship".
  - `symbol` is the native asset's display symbol from `resolveDisplayMetadata`; `en/messages.json` declares `placeholders.symbol` for both (locale-bundle-parity.test.ts:253).
  - Test: with native metadata USDCx, both render the native symbol and never MIDEN.
- Arrival: `usdcxArrival` "~20 min" (en.json:1077, en/messages.json:4690; used at EvmBridgeDepositReview.tsx:91 and EvmBridgeUsdcxRoute.tsx:41) becomes "~1 min" (attestation 2.3-5.4 s plus mint 26-34 s). Test: the en value is pinned in the locale test.

(d) Gate repair (D10)
- Delete `src/lib/usdcx/relay-client.ts`, `src/lib/usdcx/relay-protocol.ts` and `src/app/pages/Receive/XReserveTestButton.tsx`. The author removed them in 0279f8af5 and 83a4ba382 resurrected them; they fail prettier and key-coverage, and `git grep` shows no importer.
- Delete the duplicate `usdcxRouteLabel` at en/en.json:2 (:1076 holds the rendered value; en/messages.json has one copy). It fails `no public/_locales file repeats a top-level key` (locale-bundle-parity.test.ts:314). The unused `usdcxBurnOnly` fails no gate and stays.
- CHANGELOG:
  - Delete #1100's lines from released sections: CHANGELOG.md:49 (1.17.0), :216, :220 and :269 (1.16.2).
  - None exists at merge base 93cf9a720, so deleting them is clean for `scripts/check-changelog.sh`, which diffs against the merge base.
  - Their still-true facts fold into the one #1100 entry under `## 1.17.2 (TBD)` (:10):
    - Arc Testnet USDC deposits to domain 10007 for the connected account;
    - burns to Arc domain 26 that Circle pays out, minus its fee;
    - Burn confirmed tracking with restart recovery, and Arc explorer links;
    - Confirmed only when Circle's attestation matches what the wallet signed; Failed on a mismatch or after 7 days.
  - Dropped: the Sepolia USDC route, the stand-in domain and recipient, 12 s polling, and "no destination-chain payout".
- Failing first: `scripts/check-changelog.sh` against the merge base, `key-coverage.test.ts` and `locale-bundle-parity.test.ts`. Plus a local check that the TBD section matches none of `Sepolia USDC|stand-in|destination-chain payout|every 12 seconds`.

## 11 Failure reporting

Every hard failure names its step. A Guardian failure also names `GUARDIAN_URL`, the identity read at step 1, and a best-effort `/status` re-read (5 s) when the message is built; it shows both if they differ.
- **Guardian create**: readiness timeout, or an endpoint or type mismatch with the observed values.
- **Funding**: `faucet granted <G>, need >= 11 USDCx`; a Failed consume with `stage` and `rawError`; a vault mismatch with G, f0, expected and observed.
- **Settle**: `waitForGuardianSettled`'s message (pushed vs canonical commitment, state reads; guardian-commitments.ts:171). "No delta push was observed" reads as "tracking started late".
- **Burn failed**: `Guardian burn failed at stage <stage>: <class>: <rawError>`, with `stageTimestamps` and `submitEvidence`. The class is the first match of:
  - 409 or 'pending canonicalization' ("prior Guardian candidate had not settled, infra");
  - 'transaction is unauthorized' (product blocker);
  - 'binding mismatch';
  - 'chain anchor does not match' / SummaryAnchorMismatchError;
  - 429; Guardian unreachable;
  - 'Deadline expired' (prover);
  - 'RefCell already borrowed' (iOS);
  - stuck transaction.
- **Burn result reaped**: "resultBytes released at <resultReleasedAt>, 10 min after completedAt; outputs not decoded".
- **Burn landed without outputs**: a Completed row with no `resultBytes` and no `resultReleasedAt`: "burn landed but local apply failed (landed path, transaction/index.ts:1445-1466); outputs and fee unrecorded".
- **Burn stuck pending**: `usdcxBurn.lastError`, `attemptCount` and `lastAttemptBlockNum` (burn-status.ts:89-95), plus the oracle verdict: "never committed (expired after the 20-block cap)" vs "committed, faucet has not consumed".
- **Phase timeout** (burn or receive rows): the page's route and `document.visibilityState`, so a hidden watcher root is reported as such.
- **Ledger**: every term (G, f0, N, f1, s, M, f2) with the expected and observed vault.
- **Payout (D3)**. The headline is one of:
  - "Circle never burned": the GatewayBurned scan (topic2 = `depositor`, destinationRecipient == key) from `arcFromBlock` to head finished with no gaps and found nothing.
  - "Circle burned <gatewayBurn tx>, never minted": a matching GatewayBurned exists.
  - "Unknown: GatewayBurned scan has gaps <ranges>": the scan errored or skipped ranges, so neither claim is proven.
  - Body: burn note id, consume block and timestamp; key address and ledger path; ranges scanned per endpoint; current pause flags; Circle balance before and now (context).
- **Payout received but not correlated**: the balance is > 0 at B, but the AttestationUsed scan errored, found 0 or 2+ logs, returned disagreeing data, or the mint calldata lacks the burn note id. The message names which, with the endpoint, B and the ranges.
- **Deposit**: the decoded revert or receipt status; the `DepositedToRemote` field that differs.
- **Attestation**: none, more than one, or the decoded field that differs from the expected value.
- **Mint**: deposit hash, nonce, derived id, and the faucet's recent output note ids.
- **Receive**:
  - When the consume reached Completed via Unconfirmed or without `resultBytes`: "consume landed through the verdict or landed path; bridge-in adoption does not run there" (reconcile-unconfirmed.ts:110-138).
  - The POSITIVE row never reached `received`, or the NEGATIVE row was observed `ready`.

## 12 Risks and containment

- **No Guardian USDCx burn has run live yet.** Coverage is mocked (transactions.guardian-offscreen.test.ts:499,2808). The burn travels as the custom proposal `agglayer_bridged_send` (transaction/index.ts:3418) of a network note with attachments, rebuilt under one WASM hold (guardian/index.ts:472-487). The proof spike (section 14 step 1) runs before any spec code.
- **20-block expiry (~60 s) per burn execution** (fee_manager.masm:74,106). If the remote prove misses, the wallet falls back to a local prove of a heavier guarded-multisig + FPI transaction. The spike measures this from `stageTimestamps`, and the stuck-pending message separates expiry from faucet delay.
- **A burn cannot be requeued**: a 409 past 60 s, a 429 or an unreachable Guardian fails it (transaction/index.ts:193-206). Contained by `waitForGuardianSettled` (extension), the nullifier-commit gate (iOS), no manual claims, and the classified message.
- **A hosted Guardian outage or upgrade** turns all three suites red, and D5 allows no fallback. It is probed hard before any build, and its identity is recorded per run. Its rate limits are unknown, so running one suite at a time is a precaution (USAGE).
- **Payouts are unreliable** (4 of 7). The hard gate can go red without a wallet defect; the three-way headline says which side failed, and `usdcx-in` keeps bridge-in testable.
- **The grant size is unverified** (sampled grants are 0.01 USDCx). The probe requires `base_amount >= 11 USDCx`, the spec throws early, and the spike measures a real grant. If the faucet caps grants, stop and re-ask (D2 depends on it).
- **Phases move only in the UI**: no service-worker code moves burn or bridged-receive phases, only the visible watcher root does. Contained by the visible-root rule and the phase-timeout message.
- **Result bytes are reaped after 10 min**: the spec reads them at Completed, and reaping has its own message.
- **The exact debit depends on the sponsorship term**: it is decoded from `resultBytes` and checked against live faucet storage. A disagreement corrects the oracle; it never loosens the check to a range.
- **The mint id derivation tracks miden-usdcx v0.17.1**: the mint failure lists the faucet's recent outputs, and the metadata check proves origin independently.
- **Arc RPC limits and 429s**: balance-first detection, per-endpoint scans, 1000-block chunks halving to 100, bounded retry, and reported gaps. On iOS, arc.io stays free for the app during the deposit.
- **Nonce races**: one write endpoint, a local nonce, and 'already known' counted as success. There is no run lock, so concurrent `usdcx-in` runs on one funded key are unsupported (USAGE).
- **Stranded funds and key exposure**: ~9 USDC per paid run stays on a throwaway key, kept in a 0600 ledger outside the repo and test-results. Recovery is documented in playwright/e2e/docs/e2e-architecture.md.
- **Wrong build**: `--skip-build` is refused, the defines and `GUARDIAN_URL` are refused, and the app itself proves the target (`Arc Testnet` chip, WalletConnect chainId).
- **CLI install**: a cold cache costs up to 35 min in the runner, before the build, never inside a test.
- **D11 merge**: main moved the SDK to 0.17.3 (package.json:160, vs :161 here) and changed complete.ts and EvmBridgeDepositScreen.tsx. Every build runs `yarn check --integrity` and the relay-patch check (CLAUDE.md, Commands), and the Node oracle was written against 0.17.1. So step 5 reinstalls and re-runs the oracle tests before any live run.

## 13 Out of scope

- Standard-wallet variants of the three live suites; Android; scheduled or CI runs; payout sweeps.
- Scope reading to confirm before shipping:
  - #1100 adds the hermetic `playwright/e2e/ios/tests/bridge-in-deposit-usdcx.ios.spec.ts` (206 new lines vs 93cf9a720). It is a standard-wallet USDCx spec in the iOS Bridge-IN CI job that stops at `delivering` (:43,183-194) and signs nothing on Miden.
  - This design reads D5 as governing the three `e2e:real` suites and leaves that spec unchanged.
  - The alternative is a Guardian conversion, which needs a Guardian co-signer in that job. Recommended: keep it as is.
- The iOS and Android `createGuardianWallet(password)` signature differs from `WalletPage.createGuardianWallet(guardianUrl, password?)` (wallet-page.ts:253; ios-wallet-page.ts:387). The iOS spec calls it with no argument.
- Guardian history recovery maps `agglayer_bridged_send` to a bridged-send without provider or `usdcxBurn` (guardian/history.ts:91-93): P3.
- Needs your call (not covered by D7):
  1. `canAwaitVerdict` excludes USDCx burns, so an indefinite Guardian burn submit is marked Failed and its candidate abandoned, although it may still land (verdict-rules.ts:40-48).
  2. Bridge-in adoption runs only in `completeConsumeTransaction`. A mint consume that lands via the Unconfirmed reconciler or the landed path never adopts its row, and D7's timeout then fails that row after 7 days (reconcile-unconfirmed.ts:110-138).
  - Recommended: one P2 issue after the live runs, or a fix in #1100 if a live run hits either.

## 14 Delivery order

0. **Setup.** Run `yarn install --frozen-lockfile` in `~/miden/wt-usdcx-e2e`, which has no node_modules. Every build also runs `yarn check --integrity` and the relay-patch check.
1. **Proof spike (no commit).**
   - Build `test:e2e:blockchain:build` for testnet.
   - A scratch Playwright script outside the repo creates a fresh Guardian and takes one `base_amount` grant through `mintFromPublicFaucet`.
   - It creates the key with `newArcKey()` and `recordArcKey()` (ledger written before the burn; the key is never printed or attached), then burns 10 USDCx through the UI.
   - Record G, whether the grant was auto-consumed, `stageTimestamps` (execute to submit, against ~60 s), the decoded outputs, faucet consumption and payout.
   - Stop and report if the grant is below 11 USDCx or not auto-consumed, or if the burn fails or is never consumed.
2. **Commits**, single-line messages, no attribution trailers:
   1. `fix(usdcx): re-drop files resurrected by 83a4ba382 and the duplicate route label`
   2. `fix(usdcx): mark a deposit ready only when Circle's attestation matches what the wallet signed`
   3. `fix(usdcx): adopt mints in batched consumes and time out stale ready deposits`
   4. `fix(usdcx): describe the Arc payout in the burn notice`
   5. `fix(usdcx): link Arc burn destinations to the Arc explorer`
   6. `fix(usdcx): name the fee asset in USDCx fee labels`
   7. `fix(usdcx): show the USDCx deposit arrival as about a minute`
   8. `docs(changelog): one USDCx entry under 1.17.2 and no lines in released sections`
   9. `test(e2e): shared USDCx harness modules and row readers`
   10. `test(e2e): usdcx, usdcx-in and usdcx-ios e2e:real suites`
   11. `test(e2e): extension Guardian USDCx round trip and funded-key bridge-in`
   12. `test(e2e): iOS Guardian USDCx round trip; drop the nightly workflow and local relayer`
   13. `docs(e2e): USDCx live suites and key ledger recovery`
3. **Local gates**:
   - changed jest suites at `--maxWorkers=2`, plus every test file in their directories, plus the source-scanning guard tests;
   - eslint and prettier on changed files; `scripts/lint-e2e-harness.mjs`;
   - `scripts/check-changelog.sh` and the TBD stale-phrase check;
   - coverage of the changed product files from their own suites, against the 95% gate (jest.config.ts:106-115);
   - the dash check with a positive control;
   - mutation checks, with predictions, on each new product test.
4. **Review**: `/review-council:rev` with base 4ad006876 (only these commits, not the author's whole PR), run to convergence, one commit per fix.
5. **Merge origin/main** (D11), resolving conflicts hunk by hunk.
   - Run `yarn install`, plus `rm -rf node_modules/@miden-sdk/miden-sdk && yarn install --check-files` if the relay-patch check refuses.
   - Re-run the changed suites, including `arc-usdcx.test.ts` and `usdcx-miden.test.ts`, plus one `usdcx-chain-evidence.mjs` subcommand against testnet on the new SDK.
   - Run `git fetch --tags` and re-check that the entry sits under the highest `(TBD)` section above the latest `v*` tag.
6. **Live runs** on the merged tree: `usdcx`, `usdcx-in` (with `E2E_ARC_PRIVATE_KEY`) and `usdcx-ios`; keep each evidence JSON path.
7. **Push** to `utkarsh/feat/usdcx-integration` once, with the review commits unsquashed.
8. **PR body** via `gh pr edit 1100 --body-file`, read back before and after:
   - current state only; no tool attribution footer or trailer;
   - corrected payout, Confirmed rule and Arc lines;
   - a 'Live E2E (local)' bullet with the three evidence results;
   - the section 13 scope reading;
   - a **Reviewers:** line naming the attestation match and batch adoption in `bridge-receive.ts`/`bridge-in.ts`.
9. **CI on the pushed head**, checked by SHA (`gh api repos/0xMiden/wallet/actions/runs?head_sha=<sha>`): the coverage gate, the changelog check, `lint:e2e` and locale parity. Fix anything red with new commits and push again.

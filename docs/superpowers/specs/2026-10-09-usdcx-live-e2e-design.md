# USDCx live E2E (Guardian round trip) and USDCx follow-up fixes - design

Three local-only suites check, to the base unit, the USDCx path a Guardian user takes on live testnet: a public faucet grant, a burn through the Send UI to a fresh Arc key, Circle's Gateway payout to that key, the wallet's own confirmation of that payout, a deposit back through xReserve, Circle's attestation, the relayer's mint and the wallet's consume. The extension and iOS each run the round trip; the extension also runs a bridge-in-only suite from a pre-funded key.

This is its own PR off main, written after #1100 merged as cfb228a48 and #1401 as 6fdc2c127. It fixes the USDCx defects on main that these runs depend on:
- An attestation is trusted only when it matches what the wallet signed, on both deposit routes.
- Every consume landing path adopts a delivered deposit, and burns take the verdict path.
- A stale `ready` deposit times out, and a late mint still lands it.
- Fee labels name the fee asset, and the arrival time follows the source chain.
- Q11, Q13 and Q14 (section 15) decide three more fixes of the same class.

It deletes the nightly live workflow and the local-relayer path. Citations are file:line on cfb228a48 unless marked @6fdc2c127; the `src/lib/`, `src/` and `playwright/e2e/` prefixes are dropped where the rest of the path is unique.

## 1 Goals and non-goals

Goals
- One command per suite (`yarn e2e:real --suite usdcx|usdcx-in|usdcx-ios`). No secret is needed except the optional funded key.
- Every hop is an exact base-unit ledger. Fees are read from the rows that paid them, never pinned (landed paths: Q5).
- A run cannot pass vacuously, on the wrong network, on a hermetic build, or on a non-Guardian account.
- Failures name the failing party: wallet, hosted Guardian, Miden faucet, Circle, or Arc RPC.
- The wallet's own payout confirmation (`Burn confirmed` -> `Confirmed`) is observed, not only Circle's payout.
- The section 10 product fixes land with failing-first tests.

Non-goals
- Standard-wallet variants of the new suites (the existing standard-wallet specs are Q3), an iOS funded-key suite, Android.
- Any scheduled or CI execution of the new suites.
- A build stamp, a run lock, a post-run report check, or a rate-limit pacing framework (D6).
- Sweeping payouts back, or pinning Circle's payout fee or attester key.
- Live legs beyond the Arc-direct round trip (Q4).

## 2 Decisions (settled)

- D1 Own PR off main on branch `wiktor/usdcx-live-e2e` (worktree `~/miden/wt-usdcx-e2e`), after #1100 merged as cfb228a48. The branch is rebuilt on origin/main at or after 6fdc2c127 (#1401, merged 2026-10-10 18:58Z).
- D2 Zero-secret round trip: faucet grant (USDCx is the fee asset) -> UI burn to a fresh per-run Arc EOA -> Arc payout -> the EOA deposits back -> the wallet receives. The optional `E2E_ARC_PRIVATE_KEY` is for bridge-in only.
- D3 Hard payout gate: red 10 min after the burn's consume without a destination mint for the key. The proof is one GatewayMinter `AttestationUsed` log whose mint calldata carries the burn note id. Arc `GatewayBurned` is not read (it follows the mint). The wallet confirmation's gate kind is Q6.
- D4 Extension and iOS, local only via `yarn e2e:real`. This PR deletes the nightly workflow and the local-relayer path (section 4; disabling it earlier is Q1). The extension deposit is Node-signed; the iOS deposit goes through Receive -> Cross Chain with a WalletConnect counterparty.
- D5 Guardian only, on the hosted `https://guardian.openzeppelin.com`. Suites: `usdcx`, `usdcx-in`, `usdcx-ios` (plus the retargeted standard-and-Guardian `usdcx-burn` under Q3(a)).
- D6 Lean harness: refuse `--skip-build`, throw instead of skip, simple bounded retries. Keep the probes, the env refusals, `--arc-rpc`/`--arc-key`, exact ledgers, the byte-level attestation decode, the derived mint note id and the row phase checks.
- D7 Attestation match: both deposit writers persist the signed recipient; the expected token comes from the row's native faucet id; Circle's DepositIntent is decoded; a row becomes `ready` only on a full match, on both reconcilers. One adopter serves every consume landing path (10(e)); batch pairing is already on main (complete.ts:340-367). A 7-day timeout covers `ready` USDCx rows (late mint: Q9).
- D8 The burn notice copy is right on main (en.json:6; Route.tsx:147; ReviewTransaction.tsx:705). Only its testid is added.
- D9 Fee labels name the fee asset; the deposit arrival label follows the source chain (Q12). The Arc burn-history link is right on main (BridgeClaimSection.tsx:92,320-331) and is asserted, not fixed.
- D10 CHANGELOG: new lines under the unreleased `## 1.17.2 (TBD)` (CHANGELOG.md:3) list every user-visible change; #1100's line (:7) is edited to match the outcomes (10(d)); #1401's line is Q1.
- D11 The verdict and landing gaps (approved 2026-10-10) are fixed here (10(e)). origin/main is merged only after review; the changed suites and the live suites then run on the final tree before the push.
- D12 Review in this session is a standard review, not review-council (decision 2026-10-10, session-scoped); a later session uses the standing `/review-council:rev` default.

## 3 Live facts the design relies on

| Fact | Value | How verified |
|---|---|---|
| Hosted Guardian | `/status` 200 `{status: ok, version: 0.18.0, git_commit: fab5f5cb2c3f, environment: testnet}`; `/health` 404 | GET 2026-10-09; spike 2026-10-10 |
| Guardian ECDSA key | `/pubkey?scheme=ecdsa` commitment `0x6b3e7eda3e144c8f58980385492da4cc1e474a691771704b8f99da441609990f` | GET 2026-10-09; spike |
| Guardian rate limits | not measured; container defaults 10/s, 60/min per IP | KB `guardian-default-rate-limits-throttle-local-e2e` |
| Client pins | `@miden-sdk/miden-sdk` 0.17.3 (package.json:161), guardian-client and multisig-client 0.18.0 (:170-171). The spike ran on 0.17.1, and the worktree's node_modules still holds 0.17.1 | `git show`; node_modules package.json |
| Miden testnet node | 0.17.1, ~3 s blocks | gRPC Status 2026-10-09 |
| Fee asset | USDCx faucet `0x4cbdcaffe75f0a317482224dae6436`, xReserve bytes32 `0x000000000000000000000000000000004cbdcaffe75f0a317482224dae643600` | protocol config; captured `0x370bf19a` payload |
| USDCx faucet | min burn 1 USDCx, domain 10007, unpaused; burn root `0x3d951250cb118282a37b8ee9395f3e3b3c30fab4dbe8c6b0093acfeed3ba04af`, fee_schedule `[119,0,0,1]`; burn tag `0x4255524e` | GetAccount 2026-10-09 |
| Network-note tx expiry | 20 blocks after the reference block (~60 s) | miden-base v0.17.1 `fee_manager.masm:74,106` |
| Public faucet | `base_amount` 100 USDCx, `token_amounts [1,10,100]`; the API `id` is the distributor wallet, not the USDCx faucet | get_metadata; spike |
| Fresh Guardian funding | full grant via `mintFromPublicFaucet` (helpers/public-faucet.ts:234-260), service-worker auto-consume in ~20 s, vault == G - f0 exactly (f0 133) | spike on 4ad006876 |
| Guardian UI burn | 10 USDCx co-signed, execute-to-submit 1.6 s (18 blocks of expiry headroom), faucet consumed the next block, debit == N + f1 (133) + s (119); whole spike 1.4 min | spike |
| Arc Testnet | chain 5042002, ~0.506 s blocks | cast 2026-10-09 |
| xReserve | `0x008888878f94C0d87defdf0B07f46B93C1934442`: Arc domain 26, 10007 registered and unpaused; Sepolia (same address): 10007 NOT registered | `cast call isRemoteDomainRegistered(10007)`, 2026-10-10 19:20Z |
| Bridge-out settlement | GatewayMinter `AttestationUsed` (topic2 = recipient, burn note id in the gatewayMint calldata) lands first; Arc `GatewayBurned` follows | receipts 2026-10-09; spike |
| Payout record (Arc direct) | 1, 10 and 10 USDCx (spike included) paid 10-12 s after consume. 80.000001 USDCx paid 1 h 45 min late (block 66303813, 2026-10-09 12:06:35Z, 79,983,601). A 2 USDCx burn of 2026-10-08 19:10Z paid ~17 h late (2026-10-09 12:14:01Z, 1,983,600). A 1 USDCx burn (note `0xa9166ffc`, 2026-10-08 22:37Z) is unpaid at 2026-10-10 19:20Z. Base and Arbitrum Sepolia: one burn each, paid in 11-13 s. Sepolia: never observed | arc.io `eth_getLogs` AttestationUsed by recipient topic and Blockscout token transfers per recipient, 2026-10-10 19:20Z; spike; 2026-10-09 probe dumps (session scratchpad, not durable) |
| Payout fees | Arc flat 16,400 (4 samples); Base/Arbitrum 10 USDCx -> 9,988,001. Allowance 100_000 (usdcx/constant.ts:160), 1_500_000 for domain 0 (:161,230); `minimumUsdcxPayout(5042002, 10 USDCx)` = 9_900_000 (:238-243) | mint values above |
| Circle attestation | 240-byte DepositIntent, magic `0x5a2e0acd` v1; 2.3-5.4 s; signer `0xad1b523Cf15F086EB4CE54A1eF1DE2D13Fd38816` | probe 2026-10-09 |
| Relayer mint | 13 of 13 deposits minted, 26-34 s each | probe 2026-10-09 |
| Arc RPCs | arc.io: getLogs 5000 blocks, intermittent 429, the wallet's only Arc RPC. drpc: getLogs 100 blocks (1000 refused with a misleading "over 10000" message), archive receipts. quicknode: 1000-block getLogs 3 of 3 (429 on 2026-10-09) | cast 2026-10-10 19:20Z |
| Deposit gas | approve + depositToRemote 0.0038-0.0067 USDC | probe 2026-10-09 |
| WalletConnect session | the app proposes four chains (walletconnect/config.ts:63-81); the counterparty approves Sepolia and Arc (wc-counterparty.ts:35-36,118-135); hermetic Bridge-IN is green on cfb228a48 | `gh run list` 2026-10-10 |
| Executor route (context) | 8 deposits from Base, Arbitrum and Sepolia via the Arc executor since 2026-10-08, all forwarded, minted == burned, Arc execute ~9 s after the burn; manual Execute never observed | xReserve list, Blockscout, Iris, 2026-10-10 (not re-verified) |

## 4 Architecture

| Suite | Platform | Wallet | Legs | Key | Timeout |
|---|---|---|---|---|---|
| `usdcx` | Chrome extension | fresh Guardian | grant, UI burn, payout, wallet confirmation, Node-signed deposit, attest, mint, receive | none (per-run key) | 60 min |
| `usdcx-in` | Chrome extension | fresh Guardian, zero balance | Node-signed deposit, attest, mint, receive | `E2E_ARC_PRIVATE_KEY` | 30 min |
| `usdcx-ios` | iOS simulator | fresh Guardian | grant, UI burn, payout, wallet confirmation, Receive -> Cross Chain deposit via WalletConnect, attest, mint, receive | none (per-run key) | 80 min |

Each step budget is a small multiple of the spike's step time with a floor for chain variance; step 1 of section 14 measures them again on main before they are frozen.

Timeouts cover fixture setup
- Test-scoped fixtures run under the test timeout, before the body, and would otherwise get 300 s (playwright.e2e.config.ts:25). `walletA` depends on `midenCli` (two-wallets.ts:937), whose `resolveCliPath()` may install the pinned CLI for up to 2_100_000 ms (helpers/miden-cli.ts:116-131); the iOS `walletB` depends on it too (two-simulators.ts:372,493).
- `playwright.usdcx.config.ts` sets `timeout: 3_600_000`; the `usdcx-in` describe sets 1_800_000; `playwright.ios.usdcx-live.config.ts:19` goes from 3_600_000 to 4_800_000.
- The runner installs the pinned CLI before the build and passes `MIDEN_CLIENT_BIN` (miden-cli.ts:118-120), so no fixture installs it. Budgets include ~2 min of fixture setup, or the 13 min sim-pair cap on iOS (two-simulators.ts:294).

Files
- Extension: `playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts`, describes `USDCx round trip: burn to a fresh Arc key, Circle payout, deposit back` and `USDCx bridge-in from a funded Arc key`. `playwright.usdcx.config.ts` spreads `playwright.e2e.config.ts` with `testDir: './playwright/e2e/tests/usdcx'` and `testIgnore: undefined` (pattern of playwright.earn.config.ts:12-16).
- iOS: `playwright/e2e/ios/tests/usdcx-live-round-trip.ios.spec.ts`. `playwright.ios.usdcx-live.config.ts` (testMatch :17) is MODIFIED: comment :5-13 rewritten (no relayer, no CI job; its claim that `E2E_EVM_RPC_URL` moves Arc reads is wrong, walletconnect/config.ts:44-47,71-77); timeout :19; `globalSetup: ['./playwright/e2e/ios/fixtures/usdcx-live-guard.ts', './playwright/e2e/ios/fixtures/global-setup.ts']` (base value playwright.ios.config.ts:46, composed as in playwright.ios.bridge-in.config.ts:16-19).
- Deleted (D4):
  - `.github/workflows/e2e-usdcx-live.yml` and its ceiling line (playwright/e2e/harness/linked-pr-injection.test.ts:355 @6fdc2c127);
  - `playwright/e2e/helpers/usdcx-relayer.ts` and `scripts/install-usdcx-relayer.sh`;
  - the `test:e2e:mobile:usdcx-live:run` script (package.json:112; called at e2e-usdcx-live.yml:257 @6fdc2c127);
  - per Q3: `playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts` (Q3 iOS (a)); `playwright/e2e/tests/bridge/bridge-out-usdcx.spec.ts` leaves `tests/bridge` (moved to `tests/usdcx` under Q3(a), deleted under Q3(b)).
  - Afterwards `git grep -n -e USDCX_RELAYER_ -e usdcx-relayer -e USDCX_LIVE_ -e test:e2e:mobile:usdcx-live` is empty.
- Rewritten text: playwright.ios.config.ts:18-19 drops "needs a local deposit relayer" (the :24 ignore stays); runner USAGE :138-143.

Isolation from every CI job
- playwright.e2e.config.ts:24 testIgnore gains `'**/usdcx/**'`.
- No USDCx spec is named `guardian-*.spec.ts` (playwright.guardian.config.ts matches it with testIgnore cleared) or `bridge-out-epoch-guardian.spec.ts` (playwright.bridge-guardian.config.ts:15-16), and none lives under `tests/bridge`, which E2E Bridge collects on every push to main (playwright.bridge.config.ts:13; e2e-bridge.yml:26-28,125).
- iOS: the base config ignores `'**/usdcx-live-*.ios.spec.ts'` (playwright.ios.config.ts:24); the Guardian, bridge-in and dApp iOS configs match only their own prefixes (playwright.ios.guardian.config.ts:12, playwright.ios.bridge-in.config.ts:13, playwright.ios.dapp.config.ts:21).
- With the workflow and its script gone, `yarn e2e:real` is the only entry point, so its refusals always apply.

Guards
- The extension `test.beforeAll` and the first iOS globalSetup THROW unless `E2E_REAL_USDCX === 'true'` (set only by the runner) and `E2E_NETWORK === 'testnet'`. No `test.skip`; `usdcx-in` throws without its key.
- Env reads, key generation and RPC clients live inside test bodies.
- Each runner suite greps exactly one title, with retries 0 and `maxFailures` 1 (playwright.e2e.config.ts:46). A grep that matches nothing exits 1.

## 5 Extension Guardian round trip (`usdcx`)

Spec rules
- `test.use({ injectFeeFaucet: false })`: the default injects the fee faucet through `__TEST_SET_FEE_FAUCET__` and masks the wallet's own discovery (two-wallets.ts:840; src/lib/miden/back/main.ts:130).
- `GUARDIAN_URL = getEnvironmentConfig().guardianUrl` (config/environments.ts:30); `process.env.GUARDIAN_URL` is never read.
- Ids: `address` and the native id are composite (`<bech32>_<suffix>`). `native = walletDiscoveredNativeFaucetId(page)` (balance-truth.ts:542-545) feeds the `tokenId` preselect (SendManager.tsx:448-452) and every `feeFaucetId` comparison. Node SDK parses use `bare = id.split('_')[0]`. The faucet API `id` is never read as the USDCx faucet.
- Never call `midenCli.mint`, `ensureFeeFunded`, `fundAccountForFees` or `claimAllNotes`: each adds a consume row or overlaps a requeued Guardian consume.
- Guardian accounts are private (guardian/account.ts:431), so the vault comes from `waitForVaultBalanceOfCurrentAccount` (balance-truth.ts:409, exact, current account), never `vaultBalanceByFaucetId` (:133, sums all accounts).
- Row status: 2 Completed is success; 4 Unconfirmed is pending (consumes, and burns once 10(e) gap 1 lands); 3 Failed fails the run at once with `stage` and `rawError`.
- Visible root:
  - `BridgeIntentWatcher` (mounted at front/provider.tsx:237) polls every 8 s, only while visible and leading (BridgeIntentWatcher.tsx:3,55-58,123). It moves the burn phase and the destination confirmation (src/lib/wallet-prompts.ts:211-216) and a deposit's `ready` (bridge-receive.ts:135-137 via BridgeIntentWatcher.tsx:67-70).
  - A Completed USDCx burn is checked every tick for its first hour, then every 5 min (`isUsdcxCheckDue`, wallet-prompts.ts:166-179); every row in this run is younger.
  - A deposit's `received` comes from the consume completion in the service worker (complete.ts:339 -> bridge-in.ts:141-146; complete.ts:361-366), whatever the page's visibility.
  - `walletA.page` stays on Home, `#/history` or `#/history-details/<id>` (all under the provider). The headless default is Q8.
- Arc endpoints: harness reads and writes use `--arc-rpc` if given, then drpc, quicknode, and arc.io last. arc.io is the wallet's only Arc RPC for the burn snapshot (usdcx/burn.ts:103) and the confirmation (destination-status.ts:16-30; walletconnect/config.ts:71-77), so the harness does not compete with it. One endpoint per read cycle; an error moves the cycle to the next.
- Landed paths: a Completed burn or consume with no `resultBytes` and no `resultReleasedAt` took a landed path, which records no fee or outputs (reconcile-unconfirmed.ts:130-134; transaction/index.ts:1464-1467; transaction/helper.ts:695-698). Its ledger term follows Q5.
- Service-worker calls go through `swOf(walletA).evaluate` (helpers/swap.ts:52).

Flow (60 min; budgets plus fixture setup ~50 min, the payout wait overlapping the post-burn settle)
1. **guardian_wallet** (3 min). `walletA.createGuardianWallet(GUARDIAN_URL)` (wallet-page.ts:663); throw unless `walletA.ownsProfile` (two-wallets.ts:68); `trackGuardianCommitments()` at once (two-wallets.ts:101,683-685). Poll until `currentGuardianEndpoint()` (wallet-page.ts:1435) == `GUARDIAN_URL` and the type is `guardian`. Record `identity = guardianIdentity(GUARDIAN_URL)`.
2. **arc_state** (30 s). `readXReserveDomainState()`: `isRemoteDomainRegistered(10007)`; `paused()`, `domainDepositsPaused(10007)`, `domainWithdrawalsPaused(10007)` false; `remoteToken = getRemoteToken(10007, USDC)` and `depositor = getRemoteDomainDepositor(10007)` read from the chain.
3. **fund** (3 min).
   - `const { noteId: grantNoteId } = await mintFromPublicFaucet(publicFaucetApiUrl('testnet'), bare)` (no amount: it resolves `base_amount`, public-faucet.ts:234-260; returns `{ txId?, noteId }`, :240), then `waitForPublicNoteCommitment(rpcUrl, grantNoteId)`.
   - Exactly one consume row has `noteIds` including `grantNoteId`, status 2 (it is also the deploy). `G` = the grant note's asset from the Node oracle; `f0 = row.feeAmount` (> 0); `row.feeFaucetId == native`; `waitForVaultBalanceOfCurrentAccount(native, G - f0)` exactly.
   - Throw `faucet granted <G>, need >= 11 USDCx` unless `G - f0 >= BURN_UNITS + GRANT_MARGIN_UNITS`.
   - `midenAccountHexToXReserveRecipient(accountHex(bare native)) == remoteToken` (usdcx/recipient.ts:19).
   - `assertGuardianAuth(address, { signerCount: 2, threshold: 2, guardianCommitment: identity.commitment })` (wallet-page.ts:1402).
4. **settle_grant** (4 min). `waitForGuardianSettled(120_000)` (two-wallets.ts:110,687): a bridged-send is not requeueable on a pending-delta 409 (transaction/index.ts:196-202) and fails once the 409 budget runs out (guardian/serialize.ts:285-289). Its "no delta push" throw (harness/guardian-commitments.ts:155-159) means tracking started late: a hard failure.
5. **fresh_key** (10 s). `newArcKey()`, then `recordArcKey()` writes `{iso, address, privateKey, walletAddress}` mode 0600 to `~/.miden-e2e/arc-keys/<iso>-<address>.json` BEFORE the burn, outside `test-results/`. The key is never logged or attached. `readArcUsdc(key) == 0n`.
6. **burn_via_ui** (3 min). No Queued or GeneratingTransaction row may exist. `bridgeOutUsdcx(walletA, { destAddress: key, amount: '10', nativeTokenId: native })`:
   - Open `fullpage.html#/send?tokenId=<native>`; fill `send-recipient-input` with the key.
   - The chips are exactly `send-network-arc-testnet`, `-sepolia`, `-base-sepolia`, `-arbitrum-sepolia` (SendManager.tsx:857; bridge-networks.ts:52-55), with no other `send-network-<id>` chip; the `send-network-options` container (NetworkField.tsx:37) is excluded. Arc is preselected (SendManager.tsx:775-783).
   - Click `send-network-arc-testnet`; poll until its `aria-pressed` is `'true'` and the other three `'false'` (NetworkChip.tsx:67; NetworkChip.test.tsx:25).
   - `send-recipient-confirm`, `send-amount-input` `10`, `send-amount-confirm`. The route `bridge-route-usdcx` is forced (SendManager.tsx:379-383); its subtitle names the native symbol (10(c); Route.tsx:139); `usdcx-burn-notice` (new, Route.tsx:147) equals en `usdcxWithdrawalNotice`. Click `bridge-route-confirm`.
   - Review: URL has `network=arc-testnet` (ReviewTransaction.tsx:87); the Network row reads `Arc Testnet` (:659-663); the notice testid (new, :705) shows the same text; the fee row (:687) names the native symbol (10(c)).
   - Screenshots; wait for `send-review-submit` to enable; submit; wait for `/generating-transaction(-full)?\//` (ReviewTransaction.tsx:287).
   - A `review-error` with an RPC message and no new bridged-send row means the Arc snapshot failed (section 11; Q14).
7. **burn_confirmed** (3 min, 3 s poll), then **settle_burn** (4 min). `readBridgedSendRows` finds exactly one `provider: 'usdcx'` row.
   - Outputs: at status 2 read `resultBytes` at once (reaped 10 min after `completedAt`, transaction/trim-result-bytes.ts:44). `burnOutputs(resultBytes, noteId)` decodes by role: the burn note (id == `usdcxBurn.noteId`, N native), one sponsorship note (== live `fee_schedule[burn root]`, s) and the fee note (== `row.feeAmount`, f1; complete.ts:1228). The spike saw burn + sponsorship in `submitEvidence` and the fee note split out; it decoded nothing, so the decode is validated in step 1.
   - Ledger: `V2 == V1 - (N + f1 + s)` with `V1 = G - f0`; f1 never pinned. Landed path: Q5.
   - Snapshot: `usdcxBurn.destinationBalanceBefore.balance === '0'`, `blockNumber > 0` (burn.ts:103,116-121); `arcFromBlock = destinationBalanceBefore.blockNumber`.
   - Row: phase samples monotone, ending `confirmed`; `stageTimestamps` has `creating-proposal` and `signing-proposal` (transaction/index.ts:3149,3590); `destinationAddress` == key (case-insensitive); `destinationNetwork` == 5042002.
   - Oracle `burnEvidence(noteId)`: asset N, tag `0x4255524e`, burn script root; NetworkAccountTarget plus scheme-5 payload `[26,0,0,0]` + the key's LE limbs; sender == `bare`; nullifier committed; the consume block and header timestamp `consumeTs`.
   - History: `openHistoryDetails(walletA, row.id)` (helpers/history.ts:632); `history-status-pill` (HistoryDetails.tsx:766-771) reads `Burn confirmed` or `Confirmed` (the payout can land within one tick); the destination link href is `https://explorer.testnet.arc.io/address/<key>` and the network reads `Arc Testnet` (BridgeClaimSection.tsx:92,320-331). Back to Home.
   - `waitForGuardianSettled(120_000)` again, so a discarded candidate fails here with the Guardian's message.
8. **payout** (HARD, deadline `consumeTs` + 10 min). `waitForGatewayPayout`, one endpoint per cycle:
   - Every 5 s read `balanceOf(key)` at an explicit block B.
   - Once > 0, on the same endpoint: `scanArcLogs(GATEWAY_MINTER, [ATTESTATION_USED_TOPIC, pad(USDC), pad(key)], arcFromBlock..B)` in 100-block chunks on drpc and 1000-block chunks elsewhere, halving on range errors; retry up to 60 s while head < B. An endpoint error restarts the cycle on the next endpoint with a fresh B. Exactly one log.
   - Log data: sourceDomain 26, sourceDepositor == pad(`depositor`), value == the balance at B; `getTransaction(log.tx).input` contains the burn note id; `value >= minimumUsdcxPayout(5042002, N)`. Attach `fee = N - value` and the latency.

   8b. **wallet_payout_confirmed** (2 min, page visible on a wallet route; gate kind Q6). Poll the burn row until `usdcxBurn.destinationBalanceConfirmed` is set (destination-status.ts:63-85): `balance == value` (fresh key, nothing else credits it) and `blockNumber > destinationBalanceBefore.blockNumber` and >= the `AttestationUsed` block. The details pill reads `Confirmed` (transactionUtils.ts:305-307). The receiving-tx link follows Q7. Back to Home. Before step 9 because the deposit spends from the key, which would keep the balance below the threshold (destination-status.ts:59) and the row at `Burn confirmed`.
9. **deposit_submit** (2 min). Require `value >= DEPOSIT_UNITS + GAS_RESERVE_UNITS`. `submitDepositToMiden({ privateKey, units: M, recipientHex: accountHex(bare) })` returns `{ approveHash, depositHash }`: one write endpoint, a local nonce, 'already known' counted as success by hash, `simulateContract` first so reverts decode. The fresh key's allowance is 0, so an approve of exactly M is required (the product's rule, deposit.ts:101-104).
10. **tracking_rows** (10 s), as soon as `depositHash` exists. `createUsdcxBridgeReceive(walletA, args)` wraps `__TEST_CREATE_BRIDGE_RECEIVE__` (bridge-in-test-hooks.ts:23-35,72-83):
    - POSITIVE: `accountId: address`, `amount: String(M)`, `faucetId: native`, `provider: 'usdcx'`, `sourceChainId: 5042002`, `sourceAddress:` key, `sourceAmount: '1'`, `sourceSymbol: 'USDC'`, `evmTxHash: depositHash`.
    - NEGATIVE: the same with `amount: '2000000000'`, `sourceAddress: '0xe88f781e6cc8b7496f259200b57e22cb9457ff99'`, `sourceAmount: '2000'`, `evmTxHash: '0x370bf19aefa34f6f07d7b731d5b5f323a364c6f4116a22768d4e44a16ffeca4d'`: Circle attested that deposit, same token and amount, to Miden account `0x8da911727d5b53916f2c221c00c091`.
    - `provider: 'usdcx'` is required (otherwise the Epoch branch, bridge-receive.ts:235-245); `sourceChainId` too (otherwise a legacy Sepolia row, :128,134).
    - The hook persists no recipient, so these rows exercise the reconciler's derive-from-row path (10(a)); the product writer (deposit.ts:107) is proven on iOS step 10.
11. **deposit_confirm** (2 min). Receipts on the write endpoint; `DepositedToRemote` carries value M, localDepositor key, remoteRecipient R, remoteDomain 10007, remoteToken, maxFee 0, hookData `0x`.
12. **attest** (2 min, 3 s poll). `waitForXReserveAttestation(depositHash, { baseUrl: getUsdcxXReserveSource(5042002).attestationApi })` returns exactly one domain-10007 entry. `decodeDepositIntent` (the harness's own reader): magic `0x5a2e0acd`, v1, length 240; amount@8 == M, domain@40 == 10007, remoteToken@44, recipient@76 == R, localToken@108 == Arc USDC, localDepositor@140 == key, maxFee@172 == 0, hookLen@236 == 0; `messageHash == keccak256(payload)`; the signer is recovered and attached. `matchUsdcxDepositAttestation` returns `attested`. Record `attestedAt`.
13. **mint** (3 min). `deriveUsdcxMintNoteId({ faucetHex, recipientHex, units: M, nonce })`; poll `usdcx-miden.ts note(mintNoteId)` under a message naming Circle's relayer and the USDCx faucet (not `waitForPublicNoteCommitment`, which blames the public faucet, public-note-commitment.ts:32-49). Sender == the faucet, tag == the wallet's account target, asset == M native.
14. **receive** (6 min; Guardian backpressure doubles 15 s -> 240 s). Service-worker auto-consume only.
    - The consume whose `noteIds` include `mintNoteId` has exactly that one note (nothing else is incoming; a batch fails naming its note ids); status 2 or a landed path (Q5); `feeFaucetId == native`; fee f2. Its `displayMessage` is 'Bridged from EVM' and `extraInputs.bridgeIn.bridgeReceiveTxId` == the POSITIVE id (single-note path, complete.ts:334-339).
    - POSITIVE: phases monotone within {delivering, ready, received}. Within 20 s of `attestedAt` it reads `ready` or `received`; the evidence records whether `ready` was sampled (`takeUsdcxBridgeInInfo` may adopt a still-`delivering` row, bridge-in.ts:302-307). Only when `ready` is sampled: the details pill reads `Confirmed` (transactionUtils.ts:271,300-302), or `Completed` if a phase re-read after the pill shows `received`. It ends `received` with `midenNoteId == mintNoteId`, `transactionId` == the consume's, amount M, no `error`, pill `Completed`.
    - NEGATIVE: within 30 s of `attestedAt` it is `failed` with 'Circle attested this deposit to a different Miden account.'; never sampled `ready`.
    - Ledger: `V3 == V2 + M - f2`; whole: `V3 == G - f0 - N - f1 - s + M - f2`.
15. **evidence** (`finally`). Attach `usdcx-round-trip-evidence.json`: ids, hashes, fees (marked `exact` or `bounded`), latencies including payout -> wallet confirmation, the phase timeline, settle durations, the Guardian identity (URL, version, git_commit, commitment). Never the key.

Constants (`usdcx-constants.ts`, no env overrides): `BURN_UNITS` 10_000_000n; `DEPOSIT_UNITS` 1_000_000n; `GAS_RESERVE_UNITS` 50_000n; `GRANT_MARGIN_UNITS` 1_000_000n; `PAYOUT_TIMEOUT_MS` 600_000; `WALLET_CONFIRM_TIMEOUT_MS` 120_000; `ARC_LOG_CHUNK` 1000 (100 on drpc). The payout floor is the product's `minimumUsdcxPayout`.

## 6 Extension funded-key bridge-in (`usdcx-in`)

Title `USDCx bridge-in from a funded Arc key`, describe timeout 30 min (budgets ~21 min). Section 5's rules apply; no grant is spent.
1. **guardian_wallet** (3 min): section 5 step 1. Vault zero, account undeployed.
2. **arc_state** (30 s): registered; `paused` and `domainDepositsPaused` false.
3. **funded_key** (10 s): throw unless `E2E_ARC_PRIVATE_KEY` holds USDC >= `DEPOSIT_UNITS + GAS_RESERVE_UNITS`. Any paid `usdcx` run leaves ~9 USDC on its key in the 0600 ledger (the 2026-10-10 spike key holds ~9.98); USAGE and e2e-architecture.md say so.
4. **deposit_submit**, **tracking_rows** (POSITIVE only, `sourceAddress` = the funded key), **deposit_confirm**, **attest**, **mint**: section 5 steps 9-13. The approve is conditional here (a reused key may hold an allowance) and is recorded.
5. **receive** (6 min): the mint consume is the first transaction and the deploy; vault == `M - f2` exactly; `assertGuardianAuth` as in section 5 step 3; POSITIVE ends `received` as in section 5 step 14.

## 7 iOS Guardian round trip (`usdcx-ios`)

Rules
- No route interception on iOS: `trackGuardianCommitments` and `waitForGuardianSettled` exist only on the Chrome fault API (two-wallets.ts:101,110; harness/network-faults.ts:381).
- Wallet B stays unused but destructured: the failure report is written in its teardown (two-simulators.ts:512-542).
- Never reload or lock wallet A (a reload drops the vault key, ios-wallet-page.ts:561-566); the app stays in the foreground so the watcher polls.
- Section 5's id, no-CLI-funding, private-account, row-status, endpoint and landed-path rules apply.

Flow (80 min; budgets plus the 13 min sim cap ~67 min)
1. **guardian_wallet** (3 min). `walletA.createGuardianWallet()` binds the build's network default (ios-wallet-page.ts:387); the mobile E2E build bakes `MIDEN_E2E_DISABLE_ENDPOINT_OVERRIDES=true` (package.json:107). The new `currentAccountInfo()` returns type `guardian` and `guardianEndpoint === 'https://guardian.openzeppelin.com'`. Record `identity`.
2. **arc_state** (30 s): section 5 step 2.
3. **key** (10 s). `newArcKey()` and the ledger. `cp = new WcCounterparty({ privateKey, rpcUrl: <first healthy endpoint>, chainId: 5042002 })` (wc-counterparty.ts:54-63,77-93), reused unchanged.
4. **connect_evm** (5 min). `cp.connectWithRetry(() => walletA.reownConnectUri(), ...)` (wc-counterparty.ts:164-200; ios-wallet-page.ts:186); `reownState().address == key`. Early, so a relay failure costs no funds.
5. **fund** (3 min). `native` from a new CDP reader mirroring balance-truth.ts:542-545; its bare part == `hexToBech32Faucet('0x' + remoteToken.slice(34, 64))` (ios-wallet-page.ts:145). Vault starts at 0. Grant to `bare`, `waitForPublicNoteCommitment`, then `waitForNotesConsumed([grantNoteId])` (NativeNoteAutoConsumeManager; no Accept All). `vault1 == G - f0`, 11 USDCx floor. `getGuardianAuthInfo(address)` (ios-wallet-page.ts:944-960) reports 2 signers, `update_guardian` threshold 2, and (new check) `guardianCommitment == identity.commitment`.
6. **settle** (2 min). Wait until the grant note's nullifier is committed (oracle); the Guardian promotes a committed candidate on its 3 s and 10 s passes (KB `guardian-state-advances-asynchronously-after-execute`).
7. **burn** (3 min) and **burn_confirmed** (3 min). `burnUsdcxViaSendFlow({ recipient: key, amount: '10', nativeTokenId: native })`: `navigateTo('/send?tokenId=<native>')` (ios-wallet-page.ts:359), section 5 step 6's order and checks including the Arc chip click, then the detach wait factored out of `sendTokens` (:760). `prepareSendReview` is not reused: it clicks `send-network-sepolia` (:700-701), now a payout chain. Section 5 step 7 applies except the settle wait.
8. **payout** and **8b wallet_payout_confirmed** (app foreground): section 5 step 8.
9. **deposit_via_ui** (6 min). Re-check WalletConnect, reconnect if needed.
   - `openBridgeDeposit` (:217), `selectBridgeToken('CIRCLE_USDC')` (:241; EvmBridgeTokenDrawer.tsx:102). The source is Arc Testnet (the default, usdcx/constant.ts:277; EvmBridgeDepositScreen.tsx:342) and `usdcxExecutorRouteNotice` is absent (:1261-1268). `enterBridgeAmount('1')`, `confirmBridgeRouteUsdcx` (:274), `confirmBridgeDeposit` (:280).
   - `cp.requests`: every chainId is `eip155:5042002`; exactly one approve to xReserve of exactly M (fresh key, allowance 0, deposit.ts:101-104); the deposit decodes to `(M, 10007, R, 0x3600000000000000000000000000000000000000, 0, 0x)` with `R` derived in Node.
   - Native delta pinned to receipt blocks: `balance(approveBlock - 1) - balance(depositBlock) == M * 1e12 + sum(gasUsed * effectiveGasPrice)`.
10. **row** (1 min). `latestBridgeReceive('usdcx')` (ios-wallet-page.ts:200; hook bridge-in-test-hooks.ts:133-151, type :61-67, extended in section 8): `usdcxRemoteRecipient == R` (the product writer's proof, deposit.ts:107), `evmTxHash` == the deposit hash, `sourceChainId` == 5042002, phases monotone within {delivering, ready, received}.
11. **attest** and **mint**: section 5 steps 12-13.
12. **received** (10 min): section 5 step 14's POSITIVE and consume rules. `vault4 == G - f0 - N - f1 - s + M - f2`.
13. **finally**: evidence JSON (no key) and `cp.stop()`.

## 8 Shared harness modules

- `helpers/usdcx-constants.ts`: section 5's constants; `GATEWAY_MINTER` `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`, `ATTESTATION_USED_TOPIC` `0xbb312ce0cc311b2cb0746e09ccd2f91fdb9e2ac755d2f11c65300eb0d0fffd63`; `DEFAULT_ARC_RPCS` (drpc, quicknode, arc.io), `ARC_DRPC_URL` `https://rpc.drpc.testnet.arc.io`, `ARC_KEY_LEDGER_DIR`. From product code: xReserve, USDC and `attestationApi` via `getUsdcxXReserveSource(ARC_TESTNET.id)` (usdcx/constant.ts:288-292; entry :163-172,250); `USDCX_REMOTE_DOMAIN`; `CIRCLE_DOMAIN`; the burn tag and scheme (:334,336); `minimumUsdcxPayout`.
- `helpers/arc-usdcx.ts` (viem; client and clock injectable): `newArcKey`, `recordArcKey`, `readArcUsdc`, `arcEndpoints`, `readXReserveDomainState`, `scanArcLogs`, `waitForGatewayPayout`, `submitDepositToMiden`, `confirmDepositToMiden`, `waitForXReserveAttestation` (wraps `fetchXReserveAttestations(hash, { baseUrl })`, attestation.ts:55-78), `decodeDepositIntent`, `assertDepositIntent`. Its ABI adds `paused`, `domainDepositsPaused`, `domainWithdrawalsPaused`, `getRemoteToken`, `getRemoteDomainDepositor`, `gatewayMinter`, `DepositedToRemote` and the pause errors (the product `XRESERVE_ABI` has three entries, usdcx/constant.ts:350-377). It never imports `usdcx/deposit.ts` or `executor.ts`, which pull in `lib/miden/activity`.
- `helpers/usdcx-guardian.ts`: `guardianIdentity(url)`, `assertNoGuardianOpInFlight(rows, account)`, `burnFailureMessage(row)` (stage, rawError, stageTimestamps, submitEvidence; a 409 or 'pending canonicalization' rawError adds "the prior Guardian candidate had not settled").
- `helpers/usdcx-miden.ts` wraps `usdcx-chain-evidence.mjs` (typed `execFile`, 30 s; bare ids only). Today the script reads positional `rpcUrl faucetAddress [noteId senderAddress]` (:6), always prints the supply (:15-18), and checks one burn note against a hardcoded domain 26 and `0x1111` limbs (:35) and 1_000_000n (:40). It gains a first-argument subcommand dispatcher (`supply`, `burn-evidence` with domain, recipient and amount arguments, `burn-outputs`, `mint-note-id`, `note`, `nullifier`). Validated on SDK 0.17.3 before any live run.
- `helpers/history.ts`: the projection in `streamTransactionRows` (:167-239, type :82-126; `readTransactionRows` :144-146 wraps it) adds `extraInputs` (bigints stringified), `stageTimestamps`, `submitEvidence` and `resultReleasedAt`.
- `helpers/bridge.ts`: `bridgeOutUsdcx` (modelled on `bridgeOutFast`, :90). `readBridgedSendRows` (:375-427) adds `id`, `stage`, `stageTimestamps`, `feeAmount`, `feeFaucetId`, `completedAt`, `resultBytes` (base64), `resultReleasedAt`, `submitEvidence`; `BridgedSendRow` (:281-305) types `usdcxBurn.destinationBalanceBefore`, `destinationBalanceConfirmed`, `attemptCount`, `lastAttemptBlockNum`, `destinationAddress`, `destinationNetwork`. Typed wrappers `createUsdcxBridgeReceive`, `bridgeReceiveState`.
- `miden/activity/bridge-in-test-hooks.ts` (E2E builds only): `CreateBridgeReceiveArgs` (:23-35) gains `sourceChainId`, a type-only change since the hook spreads its args (:75). `__TEST_BRIDGE_RECEIVE_STATE__` (:89-101) and `__TEST_LATEST_BRIDGE_RECEIVE__` (:133-151, type :61-67) also return `evmTxHash`, `error`, `midenNoteId`, `sourceChainId`, `usdcxRemoteRecipient`, `readyAt`.
- `ios/helpers/ios-wallet-page.ts`: add `currentAccountInfo`, `nativeFaucetId`, `burnUsdcxViaSendFlow`, `readTransactionRows`, `readBridgedSendRows` (CDP `stashAndPoll`, :285-305, Chrome fields), `vaultBaseUnits`, `waitForNotesConsumed`. `balance-script.ts` gains `buildVaultRowsScript`; `balance-truth.ts` exports `rowBaseUnits` (:117).
- Unit tests, `@jest-environment node`, `fetch` and `execFile` stubbed, no network (jest runs `playwright/**/*.test.ts`, jest.config.ts:172-179): `arc-usdcx.test.ts` (captured logs of the paid Arc burns and the spike payout, the `0x370bf19a` attestation, chunk halving, endpoint failover), `usdcx-guardian.test.ts`, `usdcx-miden.test.ts`, `ios-wallet-page.test.ts`.

## 9 Runner and preflight

Suites (`scripts/e2e-real.mjs` SUITES, :64-106), `networks: ['testnet']`, `retries: 0`
- `usdcx`: `playwright.usdcx.config.ts`, grep `USDCx round trip`, probes `usdcx, usdcx-guardian, grant, arc-payout`.
- `usdcx-in`: same config, grep `funded Arc key`, probes `usdcx, usdcx-guardian, funded-key`.
- `usdcx-ios`: `playwright.ios.usdcx-live.config.ts`, `build: 'test:e2e:mobile:build'`, grep `USDCx round trip`, probes `usdcx, usdcx-guardian, grant, arc-payout`.
- `usdcx-burn` (only under Q3(a)): same config as `usdcx`, its own describe title, probes `usdcx, usdcx-guardian, grant`.
- The build becomes `run('yarn', [suite.build ?? 'test:e2e:blockchain:build'], buildEnv)` (hardcoded at :1020 today).
- Child env: `run()` spreads all of `process.env` into every child (:889), and main() hands one `env` to the build and the test (:1004-1013,1020,1038), so leaving a key out of `env` strips nothing. `run()` gains an `unset` list that deletes named keys from the inherited env. usdcx builds unset `E2E_ARC_PRIVATE_KEY` and `E2E_SEPOLIA_PRIVATE_KEY`; usdcx tests unset both, except that `usdcx-in` keeps `E2E_ARC_PRIVATE_KEY`.
- Pinned CLI (usdcx suites, after the probes, before the build): unless `MIDEN_CLIENT_BIN` is exported, `node scripts/install-pinned-miden-cli.cjs install`; its last stdout line reaches the test env as `MIDEN_CLIENT_BIN`; a failed install fails the run.
- Headless: per Q8, the extension usdcx suites set `E2E_HEADLESS=1` (#1395, fixtures/browser-launch-options.ts:18) unless `--headed`.

Flags
- `--arc-rpc` / `E2E_ARC_RPC_URL`: prepended to `DEFAULT_ARC_RPCS`; an empty value is refused.
- `--arc-key` / `E2E_ARC_PRIVATE_KEY`: joins `optionNames` (:183); validated with `/^(0x)?[0-9a-f]{64}$/i` and never echoed; only the address is printed.

Refusals (by name, never by value) in `resolveOperatorInput` (:275), usdcx suites only. It runs after the indexer early return (parseArgs :209-214; main :935-941), which E2E Bridge uses (e2e-bridge.yml:142), and leaves swap-guardian's `GUARDIAN_URL` override alone (probeGuardian :722,727).
- devnet; `--skip-build`.
- An exported `E2E_EVM_RPC_URL`. In E2E builds it replaces the RPC of Sepolia, Base Sepolia and Arbitrum Sepolia (walletconnect/config.ts:44-47,79-80), the Epoch client chain (epoch/client.ts:16-20) and `epoch/evm-account.ts:81`; the counterparty reads it too (wc-counterparty-env.ts:19-25). Arc ignores it (walletconnect/config.ts:71-77).
- An exported `MIDEN_E2E_USDCX_CHAIN`: it moves the default source to Sepolia (usdcx/constant.ts:10,277); the hermetic Bridge-IN job sets it (e2e-bridge-in.yml:64).
- An exported `MIDEN_FEE_FAUCET_ID` (miden-chain/effective-endpoints.ts:139).
- An exported `GUARDIAN_URL`: nothing in these suites reads it, so a set value would silently not apply.
- Key errors: malformed, given twice, an option name as the value, or empty; `--arc-key` on any suite but `usdcx-in`; `usdcx-in` without a key.

Test env: `E2E_NETWORK`, `E2E_REAL_USDCX: 'true'`, `E2E_ARC_RPC_URL`, `MIDEN_CLIENT_BIN`, `E2E_HEADLESS` per Q8, and the key for `usdcx-in`.

Probes (read-only, before any build). Each Arc or Circle call retries at most 3 times on HTTP 429 or JSON-RPC -32005, waiting Retry-After capped at 10 s; other errors fail at once. `getJson` (:336-350) returns only `{status, body}`, so it gains the response headers, and `rpc()` (:352) attaches `status`, `code` and `retryAfter` to its errors.

| Probe | Suites | Check |
|---|---|---|
| Arc RPC | all | each default endpoint: chainId 5042002 and head; at least one healthy |
| Arc write endpoint | all | first healthy endpoint: `eth_sendRawTransaction('0x00')` answers a decode error, not a method or plan refusal |
| xReserve | all | code, `isRemoteDomainRegistered(10007)`, nonzero `getRemoteToken` |
| xReserve pause | all | `paused`, `domainDepositsPaused` false; `domainWithdrawalsPaused` false with `arc-payout` |
| Circle xReserve API | all | `/v1/info` lists 10007 with remoteTokenIdentifier == remoteToken, source 26 at xReserve |
| USDCx native asset | all | `discoverFeeFaucetId` (helpers/fee-faucet.ts:33) in a ts-node child; bytes32 == remoteToken |
| Guardian identity | all | new `probeUsdcxGuardian` on `GUARDIAN_URL[network]` (:55-58): `/status` ok, environment == `--network`, version and git_commit printed; `/pubkey?scheme=ecdsa` has commitment and pubkey |
| USDCx faucet grant | usdcx, usdcx-ios | `probeMidenFaucet` (:513-525) extended: decimals 6, `base_amount` >= 11 USDCx, balance >= `base_amount`; its "native-MIDEN grant" comment (:519-520) fixed |
| Gateway minter | usdcx, usdcx-ios | `xReserve.gatewayMinter()` == `GATEWAY_MINTER`, with code |
| Arc funded key | usdcx-in | USDC >= M + gas reserve (pattern of `probeFundedKey`, :776) |

All probes are hard. USAGE (:108) gains the suites and flags; :138-143 say that `usdcx-in` needs a key, that bridge-in runs on the extension with a Node-signed deposit, and that only one usdcx suite may run at a time (no run lock).

Runner tests (`scripts/e2e-real.test.ts`, stub `scripts/e2e-real.fetch-stub.mjs`)
- Every refusal, with the key absent from stdout and stderr; the child env per suite and phase (no key in any build env; `MIDEN_CLIENT_BIN` reaches the test env; `unset` removes inherited keys).
- Scope: `swap-guardian` with `GUARDIAN_URL` exported still probes the override; `--agglayer-indexer-only` with every refused variable exported behaves as today.
- A stubbed `--preflight-only` per suite, one negative case per probe; the bounded retry (429, 429, ok; Retry-After read from headers; -32012 fails at once).
- Grep contract: each suite's grep, compiled case-insensitive, matches exactly its title as read from the spec files. Pins: the runner's Arc and USDCx constants equal `usdcx-constants.ts` and `usdcx/constant.ts` (pattern of e2e-real.test.ts:716-719).

## 10 Product fixes

(a) Attestation match on both deposit routes (D7)
- Defect: `isUsdcxDepositAttested` checks only the domain (attestation.ts:84-91, via :94-99). Both reconcilers then write `ready`: direct rows (bridge-receive.ts:135-137) and executor rows on the Arc execute hash (:160-163), which comes from Iris's `forwardTxHash` (:174-195; cctp.ts:58) or the user's execute (useCctpExecute.ts:66-68). No row keeps what was signed (db/types.ts:165-187): deposit.ts:107 writes only `evmTxHash`; executor.ts:324-329 writes `evmTxHash` and `cctp`.
- New `usdcx/deposit-target.ts`:
  - `usdcxRemoteRecipientFor(accountRef)` = `midenAccountHexToXReserveRecipient(accountRefToSdk(accountRef).toString())`, stripping the composite suffix (miden/sdk/helpers.ts:106-107). The screen's two derivations (EvmBridgeDepositScreen.tsx:598 quote, :832 deposit) route through it.
  - `usdcxExpectedRemoteTokenFor(faucetRef)` applies the same encoding to the native faucet id. It is the token the wallet expects xReserve to name, not a signed value: `depositToRemote` signs the amount, domain, recipient, the source-chain USDC, maxFee and hookData (deposit.ts:56-69; executor.ts:62-67), and Circle's remoteToken comes from xReserve's registry.
- Writers: `runUsdcxDeposit` (deposit.ts:107) and `runUsdcxExecutorDeposit` (executor.ts:324-329) persist `usdcxRemoteRecipient` at their first `updatePhase`; the `extra` Pick of `updateBridgedReceivePhase` (complete.ts:1556-1561) widens to it; `IBridgedReceiveExtraInputs` gains optional `usdcxRemoteRecipient` (and `readyAt`, (a2)).
- `attestation.ts` adds `decodeXReserveDepositIntent(payload)` (undefined unless magic, version and length 240 + hookLen hold) and `matchUsdcxDepositAttestation(list, expected)`, comparing hex case-insensitively:
  - empty list: `pending`; entries but none for 10007: `mismatch{remoteDomain}`; a 10007 entry that does not decode: `unreadable`; payload domain@40 differing from the entry's: `mismatch{remoteDomain}`;
  - amount, recipient, remote token and domain all equal: `attested`; otherwise `mismatch` naming the first difference in the order remoteDomain, remoteToken, recipient, amount; across entries `attested` > `unreadable` > `mismatch` > `pending`.
  - maxFee, hookData and localDepositor are not compared: a deposit with maxFee 1 USDC was minted in full (probe 2026-10-09), and an executor deposit's depositor is the DepositFor handler. The executor takes its fee on top of the amount (executor.ts:311-323), so the intent amount equals the row amount on both routes.
  - `isUsdcxDepositAttested` is removed; both call sites fetch with the row's own `source.attestationApi` or `target.attestationApi`.
- `expected` = the persisted recipient, else one derived from `row.accountId`; the token from `row.faucetId` (the native id the screen stored, EvmBridgeDepositScreen.tsx:1149-1155); `row.amount`; domain 10007. Rows written before this fix settle instead of waiting for the timeout.
- `bridge-receive.ts`: xReserve rows: `attested` -> `ready`; `mismatch` -> `failed` with "Circle attested this deposit to a different <network|token|Miden account|amount>."; `pending` and `unreadable` write nothing (`unreadable` warns once per row). Executor rows: `attested` -> `ready`; `mismatch` per Q10. A `ready` USDCx row is not polled again.
- Failing-first tests:
  - `bridge-receive.usdcx.test.ts` (new; the real attestation module, fetch returning the captured `0x370bf19a` response): today a row for another account reaches `ready`; an executor row whose forward hash is attested to another recipient never reaches `ready`.
  - `attestation.test.ts`: a full match; each single-field mismatch; Canton-10001-only and a payload whose domain differs from its entry (`mismatch{remoteDomain}`); the old token and the malformed recipients `0x908904ec`/`0xb4dce6ec`; bad magic, v2, one byte too long or short (`unreadable`); a mismatching entry beside a matching one (`attested`).
  - `deposit.test.ts` and an `executor.test.ts` case: the recipient is persisted at the first `updatePhase`. `deposit-target.test.ts`: composite and bare ids give the screen's bytes32.

(a2) Ready-row timeout (D7)
- Defect: `readUnsettledRows` drops `ready` rows (bridge-receive.ts:248-263), so the 7-day cutoff (:229-232) never fails a `ready` USDCx row, which keeps rendering Confirmed (transactionUtils.ts:271).
- Fix: keep `ready` USDCx rows that are not `restoredFromBackup` (restored ones stay out: :225-228 fails any row it reads).
- A row cannot tell today whether it was ever `ready`: the timeout writes `failed` (bridge-receive.ts:230) and the writer replaces `phase` outright (complete.ts:1590). `updateBridgedReceivePhase` therefore stamps `readyAt` once, when a row first goes `ready`.
- Late mint (Q9, recommended): `takeUsdcxBridgeInInfo` (bridge-in.ts:277-323) also takes a `failed` USDCx row with `readyAt` and error 'Bridge delivery timed out.', ranked after live rows and exempt from the 7-day window (:283,297); its phase filter (:296) changes accordingly. `failed -> received` is already allowed (complete.ts:1548).
- Tests (`bridge-receive.test.ts`, `bridge-in.test.ts`): an 8-day-old USDCx `ready` row fails with 'Bridge delivery timed out.' and a fresh one is not fetched; an AggLayer `ready` row and a restored USDCx `ready` row are untouched; `readyAt` is stamped once; per Q9 a late mint moves a timed-out ready row to `received`, while a row that timed out from `delivering` is NOT adopted.

(b) Burn notice testid (D8): `data-testid="usdcx-burn-notice"` at Route.tsx:147 and ReviewTransaction.tsx:705.

(c) Fee labels and arrival (D9)
- `usdcxMidenFees` "MIDEN fees" (en.json:4; Route.tsx:139) becomes "$symbol$ fees". `usdcxSponsorshipFee` (en.json:17; ReviewTransaction.tsx:687) becomes "Paid in $symbol$, including faucet execution sponsorship". `symbol` is the native display symbol from `resolveDisplayMetadata`; en/messages.json (:10, :62) declares `placeholders.symbol`. Test: with native metadata USDCx, both labels render it and never MIDEN.
- `usdcxArrival` "~20 min" (en.json:1090; en/messages.json:4746) serves every source at two sites: EvmBridgeUsdcxRoute.tsx:47 (rendered by EvmBridgeDepositScreen.tsx:1257-1269) and EvmBridgeDepositReview.tsx:94, which knows only `route`. Both take the label from one `usdcxArrivalKey(sourceChainId)` (per Q12); the screen threads the source into the review. Tests: each source's label on both sites.

(d) CHANGELOG
- Under `## 1.17.2 (TBD)` (CHANGELOG.md:3), or the highest TBD section above the latest `v*` tag after `git fetch --tags` (v1.17.1 today):
  - one `[FIX][all]` line naming every user-visible change: the attestation match; adoption on every landing path; unknown-outcome burns awaiting the node's verdict; stale ready deposits timing out with late mints still landing; fee labels naming USDCx; per-source arrival; and the Q11, Q13 and Q14 fixes as chosen;
  - one `[FIX][ci]` line: the local `yarn e2e:real` USDCx suites, and the removal of the nightly live workflow and the local relayer.
- Edit #1100's line (:7) to match the outcomes: "on Arc Testnet and Sepolia" per Q13, "Activity offers manual execution when needed" per Q11.
- #1401's line (CHANGELOG.md:15 @6fdc2c127) per Q1.

(e) Verdict and landing paths (approved 2026-10-10)
- Gap 1, burns kept off the verdict path: `canAwaitVerdict` admits a bridged-send only for `provider === 'agglayer'` (verdict-rules.ts:40-48). An unknown-outcome Guardian USDCx burn therefore loses its candidate (transaction/index.ts:3873-3876) and is failed instead of marked Unconfirmed (cancel.ts:403-405); once Failed, the burn poll never promotes it (burn-status.ts:54-65 requires Completed).
  - Fix: admit `provider === 'usdcx'`. A landed verdict goes through `writeLanding` (reconcile-unconfirmed.ts:114-141), which keeps `extraInputs.usdcxBurn` (noteId from burn.ts:116-121) but writes 'Bridged to EVM' and no fee or outputs (helper.ts:537-552,695-698), unlike complete.ts:1219-1235. The harness handles that per Q5. A usdcx row already reaches the landed-after-apply-failure branch (transaction/index.ts:1451-1473), since `isResultAwaitingRow` is Epoch-only (:294-298).
  - Failing-first tests: an unknown-outcome usdcx burn goes Unconfirmed, not Failed, and keeps its candidate; one landed by the reconciler is Completed with `usdcxBurn` intact; the burn poll then advances it.
- Gap 2, adoption only in `completeConsumeTransaction` (complete.ts:319-371). Five other paths complete a consume without a `TransactionResult` and without adoption:
  1. `writeLanding` (reconcile-unconfirmed.ts:114-141), also reached by Retry's `checkEvidenceForRetry` (:239-257);
  2. the Guardian landed-after-apply-failure branch (transaction/index.ts:1451-1473);
  3. the loop's landed-after-apply-failure branch (:4310-4358);
  4. `tryCompleteKilledConsume` (:1175-1233);
  5. the stuck-consume reaper (cancel.ts:957-985).
  - The deposit row then stays `ready` beside a separate 'Received' consume row (only a consume carrying `bridgeIn` is suppressed, bridge-in.ts:435-472), and (a2) later fails it.
  - Inputs: a consume row keeps no per-note facts. `ConsumeTransaction` (db/types.ts:1047; constructor :1091-1131) stores the first note's id, sender and faucet (:1100-1103), all ids (:1101), the first faucet's total (:1118) and per-faucet totals (:1121-1124). `ConsumableNote` (miden/types.ts:27-50) has each note's sender and amount (first asset only), but they are dropped.
  - Fix: the constructor persists `consumedNotes: {id, senderAddress, faucetId, amount}[]`, a new optional unindexed `ITransaction` field (no Dexie version). complete.ts:325-371 moves into `adoptBridgeDeliveries(consumeId, notes)` in bridge-in.ts: the registry pass, the single-note tag and the per-note batch pairing, idempotent per note (a note already some row's `midenNoteId` is skipped). All six sites call it after their Completed write (`writeLanding` after its rw transaction, :137). The five result-less paths read `consumedNotes`; a legacy one-note row falls back to `noteId`/`secondaryAccountId`/`faucetId`/`amount`; a legacy batch is skipped with a warning. `completeConsumeTransaction` keeps the executed notes.
  - Failing-first tests: a USDCx mint consume landed through each of the five paths moves its row to `received`; two same-amount mints in one batch, run against the real `takeUsdcxBridgeInInfo` (complete.bridge-in.test.ts:93-96 mocks it today), adopt two rows; the constructor persists per-note facts.

(f) Other defects of the same class (P2: money or data correctness a user can hit; scope in section 15)
- The executor manual leg can strand burned USDC (Q11): the Execute button renders only in `delivering` with no saved hash (UsdcxExecuteAction.tsx:57,62-68); a saved hash that never mines reads `pending` forever (walletconnect/receipt.ts:37-48; bridge-receive.ts:160-171); the 7-day cutoff (:229-232) then fails the row while the message can still be executed, and `failed -> delivering` is refused (complete.ts:1546-1548).
- Dead Sepolia bridge-in source (Q13): Sepolia is offered as an xReserve source (usdcx/constant.ts:251), but 10007 is not registered there (section 3), so the row fails before any prompt (deposit.ts:94-96). Sepolia -> Arc executor deposits work live.
- A burn submit fails with no row when one arc.io snapshot read errors (Q14): burn.ts:103 awaits `readUsdcxDestinationBalance` with a 15 s timeout and `retryCount: 0` (destination-status.ts:20), and arc.io returns intermittent 429s.
- Checked, not a defect: a Guardian-recovered USDCx burn (proposed as `agglayer_bridged_send`, transaction/index.ts:3426-3427, recovered as a provider-less bridged-send, guardian/history.ts:91-93) never reaches bridge rendering: the list and details skip recovered rows (HistoryItem.tsx:54; HistoryView.tsx:129; HistoryDetails.tsx:550), so it shows the generic recovered action, not Pending.
- Accepted limits, not defects (CLAUDE.md:385-403): Base/Arbitrum burns above ~890 USDCx exceed the 0.1 USDC allowance; spending from the destination before confirmation prevents it.

## 11 Failure reporting

Every hard failure names its step. A Guardian failure also names `GUARDIAN_URL`, the step 1 identity and a best-effort `/status` re-read (5 s), showing both when they differ.
- **Guardian create**: readiness timeout, or endpoint or type mismatch, with the observed values.
- **Funding**: `faucet granted <G>, need >= 11 USDCx`; a Failed consume with `stage` and `rawError`; a vault mismatch with G, f0, expected and observed.
- **Settle**: `waitForGuardianSettled`'s message (harness/guardian-commitments.ts:171-174); "no delta push was observed" reads as "tracking started late".
- **Burn rejected before queueing**: a `review-error` with an HTTP or JSON-RPC message and no new bridged-send row: "Arc RPC unavailable for the wallet's balance snapshot (burn.ts:103), infra", with the last arc.io status the harness saw.
- **Burn failed**: `burnFailureMessage(row)`: stage, rawError, `stageTimestamps`, `submitEvidence`, and the 409 hint.
- **Burn result reaped**: "resultBytes released at <resultReleasedAt>, 10 min after completedAt; outputs not decoded".
- **Landed path** (per Q5): names the path (no `resultBytes`, no `resultReleasedAt`) and, under Q5(d), the bounded fee and its ceiling.
- **Burn stuck pending**: `usdcxBurn.lastError`, `attemptCount`, `lastAttemptBlockNum` (burn-status.ts:41-43), plus the oracle verdict: "never committed (expired after the 20-block cap)" or "committed, faucet has not consumed".
- **Phase timeout** (burn, confirmation, receive): the page's route and `document.visibilityState`.
- **Ledger**: every term (G, f0, N, f1, s, M, f2) with expected and observed vault.
- **Payout (D3)**: "no destination mint for this key by <deadline>" or "unknown: scan gaps <ranges>". Body: burn note id, consume block and timestamp, key address and ledger path, ranges scanned per endpoint, pause flags. Every payout message adds: "Arc payouts have arrived up to ~17 h late and one 1 USDCx burn of 2026-10-08 was still unpaid after 45 h; red means a user was not paid in time".
- **Payout received but not correlated**: balance > 0 at B, but the scan errored, found 0 or 2+ logs, returned disagreeing data, or the calldata lacks the burn note id; names which, with the endpoint, B and the ranges.
- **Wallet never confirmed the payout** (8b): "Circle paid this burn (harness proof) but the wallet never confirmed it", with `destinationBalanceBefore`, the key's balance now, the visibility state, and the last arc.io error the harness saw.
- **Deposit**: the decoded revert or receipt status; the `DepositedToRemote` field that differs.
- **Attestation**: none, more than one, or the decoded field that differs.
- **Mint**: "Circle's relayer has not minted", with the deposit hash, nonce, derived id and the USDCx faucet's recent output note ids.
- **Receive**: the POSITIVE row never reached `received` (with the consume's status, stage and whether it landed through a landed path); the row stayed `delivering` 20 s after the attestation; the consume was a batch; or the NEGATIVE row was sampled `ready`.

## 12 Risks and containment

- **The spike ran on #1100's old head (4ad006876).** Main added a blocking Arc read before every burn (burn.ts:103), four destination chips and destination confirmation. Section 14 step 1 re-runs the spike on main before any spec code.
- **20-block expiry (~60 s) per burn execution.** The spike's 1.6 s execute-to-submit leaves room; a missed remote prove falls back to a heavier local prove, which `stageTimestamps` measures.
- **A burn is not requeueable on a 409** (transaction/index.ts:196-202). Contained by `waitForGuardianSettled` (extension), the nullifier gate (iOS), no manual claims, and the 409 hint.
- **A hosted Guardian outage or upgrade** turns all suites red. Probed before any build; identity recorded per run; one suite at a time (USAGE).
- **Late and missing payouts.** Arc payouts have arrived 1 h 45 min and ~17 h late, and one 1 USDCx burn is unpaid after 45 h (section 3). The hard gate can go red with no wallet defect, and its message says so; `usdcx-in` keeps bridge-in testable.
- **Payout confirmation ordering.** The deposit spends from the key, so step 8b gates it; a hidden window stops the watcher, contained by the visible-root rule, Q8 and the phase-timeout message.
- **Arc RPC contention.** arc.io is the wallet's only Arc RPC and rate-limits; the harness reads it last (section 5), and Q14 makes the burn snapshot retry.
- **Result bytes reaped after 10 min**; read at Completed, with their own message.
- **The exact debit depends on the sponsorship term**, decoded from `resultBytes` and checked against live faucet storage; a disagreement corrects the oracle, never loosens the check.
- **The mint id derivation tracks miden-usdcx v0.17.1.** The mint failure lists the faucet's recent outputs, and the metadata check proves origin independently. The oracle is validated on SDK 0.17.3.
- **Nonce races.** One write endpoint, a local nonce, 'already known' as success; concurrent `usdcx-in` runs on one key are unsupported (USAGE).
- **Stranded funds and key exposure.** Each paid run leaves ~9 USDC on a throwaway key in a 0600 ledger outside the repo; recovery is in playwright/e2e/docs/e2e-architecture.md.
- **Wrong build.** `--skip-build` and the defines are refused; the app proves the target (Arc chip selected, WalletConnect chainId).
- **WalletConnect namespaces.** The app proposes four chains and the counterparty approves two (section 3); this works on main today, and step 4 of section 7 fails early and cheaply if it stops working.
- **CHANGELOG union merge.** CHANGELOG.md is union-merged; a later main merge can bring back a line this branch deleted (KB `git-union-merge-resurrects-moved-lines`), so section 14 step 5 re-checks it.
- **CLI install.** A cold cache costs up to 35 min in the runner, before the build, never inside a test.

## 13 Out of scope

- Standard-wallet variants of the new suites, Android, scheduled or CI runs, payout sweeps.
- The hermetic `playwright/e2e/ios/tests/bridge-in-deposit-usdcx.ios.spec.ts` stays: a standard-wallet spec in the push-to-main Bridge-IN job that skips unless `MIDEN_E2E_USDCX_CHAIN=sepolia` (:55-58), forks Sepolia (:71-76), registers 10007 on the fork (:77), stops at `delivering` (:194) and signs nothing on Miden.
- Live legs beyond Arc-direct: Q4.
- The iOS and Chrome `createGuardianWallet` signatures differ (wallet-page.ts:663 takes a URL; ios-wallet-page.ts:387 a password). The iOS spec calls it with no argument.
- Open follow-up #1396 (a registry note inside a batch) is not touched.

## 14 Delivery order

0. **Setup.** Rebuild `wiktor/usdcx-live-e2e` on origin/main at or after 6fdc2c127 by cherry-picking the spec commits (KB `git-rebase-onto-drops-commits`). `yarn install --frozen-lockfile` (node_modules holds SDK 0.17.1; package.json pins 0.17.3).
1. **Proof spike on main (no commit).** Build `test:e2e:blockchain:build` for testnet. A scratch Playwright script outside the repo creates a fresh Guardian, takes one grant, writes a fresh key to the ledger, burns 10 USDCx through the UI with the Arc chip click, waits for the payout and `destinationBalanceConfirmed`, opens the burn's details, decodes `resultBytes` with the new oracle mode, and under `E2E_HEADLESS=1` records `document.visibilityState`. Under Q4(E), it also burns 5 USDCx to a second fresh key on Sepolia and records whether it pays. Record G, auto-consume, `stageTimestamps`, decoded outputs, snapshot read time, payout and confirmation latencies; freeze section 4's budgets. Stop and report if the grant is below 11 USDCx or not auto-consumed, the burn fails or is never consumed, the decode fails, or the wallet never confirms.
2. **Commits.** Single-line messages, no attribution trailers; product commits only for fixes the decisions keep.
   1. `fix(usdcx): mark a deposit ready only when Circle's attestation matches what the wallet signed`
   2. `fix(usdcx): time out stale ready deposits and let a late mint still land them`
   3. `fix(usdcx): let an unknown-outcome burn await the node's verdict`
   4. `fix(usdcx): adopt a delivered deposit on every consume landing path`
   5. `fix(usdcx): name the fee asset in USDCx fee labels`
   6. `fix(usdcx): show each USDCx deposit source's own arrival time`
   7. per Q11, Q13, Q14: `fix(usdcx): keep a stranded executor leg executable`, `fix(usdcx): <Sepolia bridge-in source>`, `fix(usdcx): retry the destination balance snapshot before a burn`
   8. `test(usdcx): burn notice test id and test-hook source chain and row fields`
   9. `test(e2e): shared USDCx harness modules and row readers`
   10. `test(e2e): usdcx, usdcx-in and usdcx-ios e2e:real suites`
   11. `test(e2e): extension Guardian USDCx round trip and funded-key bridge-in` (and Q3(a)'s move)
   12. `test(e2e): iOS Guardian USDCx round trip`
   13. `chore(e2e): drop the nightly live USDCx workflow and the local relayer`
   14. `docs(e2e): USDCx live suites, key ledger recovery and changelog`
3. **Local gates** (only what CI cannot run): the changed jest suites at `--maxWorkers=2`, every test file in their directories, and the source-scanning guard tests (`linked-pr-injection.test.ts` included); eslint and prettier on changed files; the dash check with a positive control; mutation checks with predictions on each new product test. `lint:e2e`, coverage, the changelog check and locale parity run in CI (step 8).
4. **Review.** In this session (D12): an independent standard whole-branch review on the most capable model, base = the fork point on origin/main, then a scoped re-review of each fix, one commit per fix. In a later session: `/review-council:rev` to convergence.
5. **Merge origin/main** only after review, and only if main moved; resolve hunk by hunk; `yarn install`; re-run the changed suites, `arc-usdcx.test.ts`, `usdcx-miden.test.ts` and one oracle subcommand against testnet; `git fetch --tags`; re-check the CHANGELOG section and that deleted lines stayed deleted.
6. **Live runs** on the final tree: `usdcx`, `usdcx-in` (with the ledger key), `usdcx-ios`, and `usdcx-burn` under Q3(a). Keep each evidence JSON path.
7. **Push** once, review commits unsquashed. `gh pr create` against main; read the body back before and after. Body: current state only, no tool attribution; a 'Live E2E (local)' bullet with the evidence results; that it deletes #1100's nightly workflow and #1401's ceiling line; a **Reviewers:** line naming the attestation match and the shared adopter in `bridge-receive.ts`/`bridge-in.ts`.
8. **CI on the pushed head**, by SHA (`gh api 'repos/0xMiden/wallet/actions/runs?head_sha=<sha>'`): coverage (95%, jest.config.ts:103-110), the changelog check, `lint:e2e`, locale parity, the injection guard. Fix anything red with new commits.
9. **KB follow-up** (separate from the PR): `notes/infra/agglayer-indexer-miden-exit-shape.md` still says rollup 86; main uses 73 since #1385 (scripts/e2e-real.mjs:37-44). Fix it with `note.sh`.

Expected size (rough, source plus tests)

| Group | Commits | Lines | Drivers |
|---|---|---|---|
| Product fixes (a), (a2), (b), (c), (e) | 6 | ~1,900 | attestation decode and match tests; the shared adopter and its five-path tests |
| Q11, Q13, Q14 fixes, if chosen | 0-3 | ~550 | executor-leg reopen tests |
| Harness modules and unit tests | 2 | ~1,900 | `arc-usdcx.ts` and captured-log tests; oracle subcommands; iOS CDP readers |
| Runner and its tests | 1 | ~700 | refusals, probes, child-env `unset` |
| Suites and configs | 2 | ~1,100 | extension ~600, iOS ~450 |
| Deletions | 1 | ~-800 | workflow 266, relayer 179 + 34, live iOS spec 263 |
| Docs and CHANGELOG | 1 | ~80 | |

About 6,200 lines added and 800 deleted over 13-16 commits; Q2 offers a lean cut.

## 15 Decisions needed

Q1 What happens to the nightly "E2E USDCx Bridge-IN (live)" workflow, and to #1401's CHANGELOG line? (time-critical)
- Context: e2e-usdcx-live.yml:38-39 @6fdc2c127, cron `17 3 * * *`, workflow 380729816, active, 0 runs; first run 2026-10-11 03:17 UTC. It builds iOS on macos-26-xlarge (:63), then skips green unless `USDCX_LIVE_EVM_PRIVATE_KEY` is set (usdcx-live-deposit.ios.spec.ts:88-91): not a repo secret; org secrets are unreadable here (HTTP 403).
- Options: (a) disable now with `gh workflow disable 380729816 --repo 0xMiden/wallet` (reversible, no commit) and delete it in this PR; (b) leave it running until this PR merges.
- #1401's line (CHANGELOG.md:15 @6fdc2c127): (i) remove it, since 1.17.2 will not ship that workflow; (ii) keep it and let the new `[ci]` line say the workflow was removed.
- Recommended: (a) and (i). Local only is settled (D4), and (a) stops a vacuous green before tonight's run.

Q2 Ship as one PR, or take a lean cut?
- Options: (a) one PR as specified (~6,200 lines added); (b) PR 1: product fixes, shared harness, extension `usdcx` and `usdcx-in`, deletions (~4,900); PR 2 stacked on it: the iOS suite and its CDP readers (~1,300); (c) PR 1: product fixes only (~1,900-2,500, unit-tested); PR 2: harness, suites, deletions.
- Recommended: (b). The extension suites prove fix (a) live (the NEGATIVE row) and land with it; iOS adds the WalletConnect UI deposit and the product-writer proof and reviews on its own. Consistent with the 2026-10-10 split choice.

Q3 What happens to the existing standard-wallet USDCx specs? (each option that deletes a test needs an explicit yes)
- `tests/bridge/bridge-out-usdcx.spec.ts` burns from a standard and a Guardian wallet (:41-49) and skips without the private `USDCX_TESTNET_REPO` (:35-38,53-65); E2E Bridge collects it as 2 skips. The public faucet now grants USDCx directly (section 3).
  - (a) Retarget it onto the public-faucet grant (drop the `xusdc-testnet` mint, `USDCX_TESTNET_REPO` and `USDCX_FAUCET_ACCOUNT_ID`; read the faucet with `walletDiscoveredNativeFaucetId`), keep both variants, move it to `tests/usdcx/usdcx-burn.spec.ts`, run it as `yarn e2e:real --suite usdcx-burn`; ~60 changed lines.
  - (a') The same retarget kept in `tests/bridge`: E2E Bridge then burns live on every push to main (e2e-bridge.yml:26-28,125), against D4's intent.
  - (b) Delete it as superseded: standard-wallet burn coverage drops to unit tests.
  - (c) Keep it as is: unrunnable without the private repo.
  - Recommended: (a).
- `ios/tests/usdcx-live-deposit.ios.spec.ts` is a standard-wallet live deposit (:168) that has never run.
  - (a) Replace it with the Guardian round trip: standard-wallet live deposit coverage is lost; the hermetic standard-wallet UI deposit to `delivering` stays.
  - (b) Keep it, dropping its local-relayer branch (:55-64) and reading `E2E_ARC_PRIVATE_KEY`, as a suite `usdcx-ios-in`; ~40 lines plus a suite entry.
  - Recommended: (a): Guardian coverage ranks first (2026-10-09) and the deposit UI code is the same.

Q4 Which surfaces beyond the Arc-direct round trip should the live E2E cover?
- Options: (A) Arc-direct only (this document); (B) A plus payout-only burns to Base Sepolia and Arbitrum Sepolia; (C) B plus a forwarded executor bridge-in from Base Sepolia; (D) C plus the manual Execute-on-Arc leg; (E) a one-off Sepolia payout check in the step 1 spike: 5 USDCx to a second fresh key, floor `minimumUsdcxPayout(11155111, 5 USDCx)` = 3_500_000 (usdcx/constant.ts:161,230,238-243), read through rpc.walletconnect.org (walletconnect/config.ts:46-47,67), ~1 USDC fee.
- B and C need their own design: per-chain GatewayMinter and RPC, a grant floor near 31 USDCx, a Guardian settle between burns, two more payout gates (hard, same deadline), Base Sepolia gas for C.
- Recommended: A in this PR plus E in the spike (nothing committed); B, then C, as follow-up PRs with their own designs; D not at all. Sepolia is offered as a destination (usdcx/constant.ts:267) under a notice that a published note cannot be reclaimed (en.json:6), with no payout ever observed. If E shows no payout within a few hours, that becomes its own decision.

Q5 What does the ledger do when the product takes a landed path (no fee or outputs recorded, 10(e))?
- Options: (a) fail, labelled "product took the landed path; ledger unprovable"; (b) an independent fee source: the node's transaction header via grpcurl (the SDK 0.17 `RpcClient` has no transaction sync) or the Guardian delta summary fee (guardian/history.ts:350-351); (c) the product records the fee on landed paths (`LandedTransaction` carries no fee today, sdk/sdk-error-code.ts:400-405); (d) derive the fee from the vault delta minus the independently known terms (N, s, M) and assert `0 < f <= baseFee x FEE_RESERVE_MULTIPLE` (miden/fees/spendable.ts:84, the wallet's own reserve ceiling), recorded as `bounded`.
- Recommended: (d). Gaps 1 and 2 then get live coverage when they occur, with no new dependency and no false red; (a) makes a correct outcome red; (b) and (c) cost a tool or a product change.

Q6 Is the wallet's own payout confirmation (step 8b) a hard gate?
- Options: hard (fail if not confirmed within 2 min of the harness proof; deposit only after it); advisory (evidence only, since CLAUDE.md calls it an estimate).
- Recommended: hard, alongside the harness proof. With a fresh 0-balance key and the deposit gated behind it, the accepted limits cannot occur, so a miss is a wallet or arc.io failure.

Q7 How strictly is the History receiving-tx link checked (one best-effort `eth_getLogs` over at most 2000 blocks, CLAUDE.md:405-411)?
- Options: equality with the `AttestationUsed` tx when it renders within 15 s, absence recorded; require it; skip it.
- Recommended: equality when rendered; the link stays a hint, not a condition of confirmation.

Q8 Should the extension usdcx suites run headless (`E2E_HEADLESS=1`) by default?
- Options: headless by default once the spike shows `visibilityState` stays `visible`, `--headed` to opt out; headed by default.
- Recommended: headless, conditional on the spike: the watcher polls only while visible, and a long local run is when a window gets covered.

Q9 What happens to a `ready` deposit whose mint arrives after the 7-day timeout?
- Context: adoption also refuses rows older than 7 days (bridge-in.ts:283,297), so a wallet closed for more than 7 days after an attested deposit would show Failed although the mint arrived.
- Options: (a) keep the timeout and let a late mint adopt a row that timed out after `readyAt`, ranked after live rows; (b) keep the timeout and accept a false Failed.
- Recommended: (a).

Q10 For executor rows, what should the reconciler do when the attestation for the row's Arc execute hash mismatches the signed recipient, the expected token or the amount (usually a `forwardTxHash` that is not this deposit's execute)?
- Options: write nothing and warn once per row; fail the row as for xReserve; reopen the leg (`revertedExecuteLeg`).
- Recommended: write nothing and warn once: failing hides a deposit Circle may still execute, and reopening can spend Arc gas on an execute that reverts.

Q11 Fix the executor manual-leg stranding (10(f)) here, or file it?
- Options: (a) fix here with failing-first tests: the reconciler reopens a leg whose execute hash still reads `pending` after a bounded window, so the Execute button returns; an executor row holding an attested, unexecuted message is exempt from the 7-day failure; (b) file an issue with the evidence and the fix shape.
- Recommended: (a). Burned USDC a user can strand is P2, and found defects are fixed in this PR (standing decision); no live suite runs it, so unit tests carry it.

Q12 What arrival label should each deposit source show?
- Options: keyed on the source chain: Arc Testnet "~1 min" (attestation 2-5 s plus mint 26-34 s), every other source "~20 min"; "~1 min" everywhere; follow the executor quote after a live executor measurement.
- Recommended: keyed on the source chain. Only Arc is measured, Sepolia's outcome is Q13, and an unquoted executor burn waits for standard finality plus a user execute.

Q13 How should the dead Sepolia bridge-in source be fixed?
- Options:
  - (a) make Sepolia an executor source (CCTP domain 0 -> Arc, forwarded; needs Sepolia's TokenMessengerWithFees entry) with an E2E override keeping it an xReserve source in E2E builds. The hermetic Bridge-IN job then tests a Sepolia xReserve route production no longer offers, though it still covers the xReserve code Arc uses.
  - (b) drop Sepolia as a source (the same hermetic divergence);
  - (c) hide any xReserve source whose `isRemoteDomainRegistered` reads false (hermetic coverage unchanged, since the fork registers the domain; Sepolia users get no route);
  - (d) leave it.
- Recommended: (a), in this PR: Sepolia -> Arc executor deposits already succeed live.

Q14 Should a burn submit keep failing with no row when the destination snapshot read errors once?
- Options: (a) one or two retries with backoff inside the 15 s budget, failing-first test; (b) keep failing with no row (no funds move, the user retries); (c) queue without a snapshot (the row then stays `Burn confirmed`, as old rows do).
- Recommended: (a). arc.io's 429s make (b) a recurring user failure, and (c) can never reach `Confirmed`.

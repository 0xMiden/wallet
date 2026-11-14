# Bread Command: real wallet integration

Status: proposed production design, awaiting user approval. The user approved V6 and requested full integration, including porting the bridge portal. That approval fixes the visual/interaction direction; this document specifies the production changes for approval before implementation. A fresh builder-readiness check read the full design and returned "nothing important left"; it is not finished-code review or runtime verification.

## 1. Intent and fixed scope

Make the approved Command experience the real extension fullpage wallet, not a second demo. Keep the pinned compacting header, portfolio, allocation, searchable assets, Recent actions, labelled five-action dock, generous workbench, explicit review, minimize/resume, pickers and command palette. Preserve V6's control alignment, spacing, materials and purposeful motion.

```
Current compact Bread -> fullscreen launcher -> real extension tab
                                               |
               pinned account/network + portfolio + Recent actions
               Send | Receive | Swap | Earn | Bridge
                                               |
               composer -> review -> existing durable operation
                            Back        minimize / reopen same ID
```

Send, Receive, Swap and Earn use the wallet's real controllers. Bridge brings over actual portal domain/provider code and its tests, adapted to the wallet's execution and storage boundaries. No fixture account, manual progress button, fictional balance, hardcoded yield or simulation engine belongs in the product.

Only the extension browser-tab wallet is redesigned. Preserve popup/sidepanel UI and flows, except the fullscreen launcher; preserve Capacitor and Tauri presentation. Explore and Settings are not redesigned. Real backend protections, eligibility, fees and recovery remain binding even when the prototype could illustrate a simpler path.

## 2. Approaches

| Approach                                                                                       | Cost / risk                                                                                | Behaves like                                               | Decision                                                                                             |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Port portal domain/providers, adapt wallet ownership, render Command in the existing React app | Real integration work; explicit transport and SDK compatibility tests                      | One wallet with the approved UI and real bridge capability | Recommended and selected as the implementation proposal; matches the user's request to port the code |
| Embed/open the deployed portal                                                                 | Small initial diff, but separate wallet connection, navigation, receipts and visual design | A linked dApp, not integrated Bread                        | Rejected: does not meet full integration                                                             |
| Copy the entire Next.js application or reimplement from the simulator                          | Duplicate providers/clients/state, incompatible runtime, or invented financial logic       | A second app or production simulation                      | Rejected: wrong ownership and approved UX                                                            |

The source-port direction was stated in the conversation. The remaining choices in this document are implementation proposals, not additional decisions attributed to the user.

## 3. Frozen inputs and source authority

- Wallet baseline: freshly fetched `origin/main`, `9f239a3171140260d1c3b1133b49a04eaecc5683`.
- Worktree: `.worktrees/bread-command-integration`, branch `feat/bread-command-integration`; unrelated checkout edits are not part of this task.
- Portal: `0xMiden/bridge-portal`, `cb52c470395273e05e84460fdadc59652d9ef5b3`, matching remote main when inspected on 2026-11-14. Do not use the different, older local portal checkout.
- Approved visual source: `/Users/celrisen/tasks/wallet-dashboard/studies/command/wallet-command-v6.html`, SHA-256 `e5a801535176ee88840e37a93e5ccfb20a0cc1b50325ad05efe3d5138ce307fc`; `command-polish.css`, SHA-256 `a3802b7a40a0905dae0cfb275ba3cea3114b7209e7e1b6d5d50668b5e6a52494`; unchanged `bridge-demo.css`. The simulator illustrates interaction only.
- V2-V6 checkpoints and published screenshots remain references. Preserve a portable, versioned V6 design reference before changing implementation; exclude companion server state, authentication and browser data. Never import its simulation scripts into application code.
- Portal MIT copyright and permission must accompany copied portions. Record source commit, original paths, retained tests and adaptations in a small third-party provenance document. Copy needed modules, not unused source trees.

Source references below are relative to the pinned wallet or portal. Existing historical research is background, not authority over this newer source.

## 4. Fullpage shell, routes and shared UI

Keep `src/fullpage.tsx -> App -> AppEnvProvider/Woozie/AppKit/MidenProvider -> PageRouter`. The scope predicate is extension AND FullPage AND not a confirmation window. Native apps also report FullPage, so FullPage alone is insufficient.

Add the Command presentation at the guarded router/layout boundary. It must not bypass readiness, hydration, onboarding, eligibility, recovery gates, locked state or the immediate background-lock cover. On lock, unmount sensitive pages without waiting for an exit animation. On account/network/RPC change, immediately clear the old account's visible data and invalidate unsigned consent.

The fullpage wallet home becomes Command; existing action, review, generating-transaction, Earn status and history-detail links remain valid and open the corresponding workbench state. Woozie remains URL/history authority. Navigator remains the owner where a current flow uses internal steps. Workbench Back changes flow state, minimize returns to the dashboard, and neither operation cancels a submitted transfer. Preserve the `generating-transaction` route identity used by existing close guards.

Do not mount the legacy home carousel underneath Command or hide duplicate action controllers. Settings, Explore, onboarding, confirmations and other non-Command routes retain their current presentation and an ordinary back path. Do not add an Overview/Assets/Activity switch.

Extend canonical `components/ui`, shared flow frames and named tokens with opt-in Command presentation variants. Existing compact defaults are unchanged. The approved charcoal shell and warm review paper are scoped to Command, not a global theme rewrite. Overlay portals must inherit the correct scoped tokens. New tokens/type roles/presets go through the existing design system; do not paste global prototype CSS or import retired atoms.

Use existing v2 icons, localization, Radix/dialog semantics and motion helpers. Preserve a solid readable dock backplate when blur is unavailable. Verify actual backdrop blur in the real extension renderer; declared CSS and the old mock captures are not proof. Animate only wallet-owned content; browser panel closure/tab activation are not a choreographed cross-document transition.

Sources: wallet `src/app/App.tsx`, `src/app/PageRouter.tsx`, `src/app/env.ts`, `src/app/layouts/{PageLayout,TabLayout}.tsx`, `skills/miden-wallet-frontend/`.

## 5. Launcher, drafts, focus and privacy

Add one labelled fullscreen icon in the compact wallet's existing header/action location, without rearranging it. Open the extension-owned `fullpage.html#/` wallet home, not an external site or a URL carrying an unsigned recipient/amount. Use the existing browser helper boundary, extended narrowly rather than changing onboarding handoff behavior.

Create/activate the tab before attempting to close the initiating compact surface. A supported browser panel-close API may close its panel; otherwise leave it usable. No browser minimum is raised solely for closure, no content-script injection, page capture or fake browser chrome is introduced. Launcher failure leaves the compact wallet working and reports an actionable localized error. Repeated activation while opening is guarded.

Keep one unsigned draft per action in the current Command tab, memory-only, keyed by account, effective network/RPC and action. Minimize/reopen and Back preserve exact decimal input and compatible selections. Asset/source-network changes clear incompatible amounts; a compatible provider change retains input but invalidates review. Account/network/RPC switch, lock or reload clears these drafts. No automatic transfer of a compact tab's unsigned draft and no cross-tab or restart draft-persistence promise. Submitted operations are durable and independently discoverable.

Use one active workbench. Pickers and the palette close before the workbench on Escape; focused search may clear its value according to native semantics before dismissal, but another Escape must work. Focus returns to the invoker. Cmd/Ctrl+K, arrows, Enter, Tab/Shift+Tab and visible focus must work without duplicate submission. Controls remain reachable on a resized short/narrow fullpage; shared compact/mobile layouts do not change on resize.

Reuse the wallet's privacy preference. Mask overview monetary values, chart inspection, asset/position values and Recent-action amounts together; never expose them through hidden tooltip/output text. Explicitly opened review/details still disclose the values needed for meaningful transaction consent. Privacy is not a vault lock.

## 6. Live data and honest portfolio history

Use existing account-scoped balances/metadata, `valuedBalanceTotal`, price readiness and token-logo identities. Unknown-scale/unpriced assets remain visible as unavailable, not zero. Earn exposure and funds in transit remain separate from spendable wallet value. Preserve existing currency preferences and stale/error/loading distinctions.

The existing 24-hour price movement is current quantities at earlier market prices, not personal investment return. Keep that meaning explicit. Existing token sparklines are market-price history, not historical account holdings.

Implementation proposal for the approved portfolio chart: record bounded local observations of actual valued wallet balances from successful, current Command data reads. No extra RPC, reconstructed historical holdings, cloud service or fabricated backfill. Scope observations to account, network/RPC and currency; capture no more than one per 15-minute bucket, retain at most one year / 35,040 points per scope, and clear them on wallet reset/account removal. Multiple tabs upsert the same scope/bucket, not duplicate points. This collection runs only while Command is open and data is current; it is not a background accounting engine.

Each observation carries capture time, value and valuation coverage. Do not record a stale/missing valuation as zero or join across unavailable periods as if observed. Label history as observations on this device, show honest gaps/insufficient-data states and retain the 1W/1M/3M/1Y controls. Hover and keyboard sample inspection use the same data and privacy policy. A history write failure must not affect balances or transaction admission.

Use the existing wallet database/storage conventions and cleanup paths, not window.localStorage. This intentionally adds local financial history; it is neither a complete ledger nor a backup/recovery guarantee.

Sources: wallet `src/lib/miden/front/{balance,fiat-total}.ts`, `src/lib/prices/`, `src/app/templates/{Balance,history/History}.tsx`, `src/screens/earn-flow/useEarnPositions.ts`.

## 7. Four existing financial journeys

Extract presentation seams from the current controllers only where needed. Compact and Command render the same validation/consent/submission logic; do not maintain two financial implementations.

| Journey | Integrate                                                                           | Preserve                                                                                                                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Send    | `SendManager`, `ReviewTransaction`, token/recipient/fee/spendable helpers           | Canonical address and self-send checks, known scales, token lifecycle, native reserve/Max, public warning/private/reclaim options, fresh review, spending-limit challenge, sensitive-action confirmation, protected queue |
| Receive | Current address/QR/copy/share handlers, `useActivityClaims` and claim-list adapters | Real account/network QR, distinct bridge funding, checking before Accept, fee/Guardian holds, same-note claim ownership, pending vs consumed/spendable                                                                    |
| Swap    | `SwapManager`, `useSwapQuote`, registry, review and settlement/receipt adapters     | Verified pairs, exact amounts/reversal, current USD minimum, fresh quote and minimum, slippage/expiry/auto-accept, partial fills/return/payout claims; order placed is not funds received                                 |
| Earn    | Positions/collateral hooks and deposit/withdraw review controllers                  | Available deposits vs independently recoverable withdrawals, exact collateral and position ownership, quote lifetime/minimum, spending limits, prepared nonce/allocation, source/delivery-specific recovery               |

Keep 1Click cross-chain Swap as its separate existing engine and gate. Do not silently remove an existing supported route because Bridge gets a dedicated dock action, funnel 1Click through PSWAP, or enable default-off features. Additional protocol-specific consent/security prompts are real product requirements, not demo steps to discard.

All Miden signing stays behind the existing backend/intercom and effect-checked pipeline. Preserve Guardian protection and existing imported-account compatibility; do not add account-type UI or rewrite signing based on older research assumptions. The frontend never receives a private key or creates its own MidenProvider/WebClient. Preserve WASM locking, poisoned/abandoned-operation handling and existing retry acknowledgements.

## 8. Bridge source port

### Source and ownership map

Use a focused `src/lib/bridge/` domain boundary for the adapted portal modules; approved Bridge presentation lives with the Command screens. Existing `agglayer`, `epoch`, `usdcx`, WalletConnect and transaction modules remain the execution owners. A thin adapter is justified only where a ported protocol contract crosses that boundary.

| Portal source                                                                                                                               | Treatment                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/bridge/core/{assets,models,rules,quote,routes,receipt-route,balance-cap,activity-status,activity-presentation,provider,submission}.ts` | Port needed domain contracts/rules and tests; adapt imports, localization, config and wallet row types                      |
| Provider registry/direction/fee/phase definitions                                                                                           | Port as real provider behavior/presentation; reconcile with stronger existing wallet outcome evidence                       |
| `use-bridge-transfer`, `use-bridge-quote`, `bridge-submission`                                                                              | Extract review snapshot, quote binding/expiry and admission guards into wallet controllers, not Next components             |
| Provider quote, allowance/reset/replacement, receipt verification, exit identity, status/recovery and response-validation code              | Port missing functionality into the corresponding wallet domain modules, retaining trust-boundary checks and relevant tests |
| Miden dApp `requestTransaction`/`waitForTransaction`, standalone client/balance providers                                                   | Replace with existing backend-owned initiators and row observers, never connect Bread to itself                             |
| ActivityStore/localStorage, page-local monitors, Next routes, portal visual shell/theme                                                     | Do not copy runtime ownership; map useful invariants into wallet persistence/reconcilers and render Command                 |

This is a code port, not another implementation of `bridge-demo-v6.js`. Port notes identify every reused or deliberately replaced upstream module so omissions are visible.

### Route and review contract

Support both directions and the portal's three provider families: Circle/xReserve, Agglayer and Epoch. Use real connected EVM account plus current Miden account as the prototype's two wallet contexts. Browsing a chain does not silently switch the connected source wallet. Withdrawals do not invent a source EVM signature; only a real destination claim or other required EVM operation requests one.

Port the connection-catalog logic with its precise representations, decimals, native/ERC20 distinction and per-direction retirement/availability. Resolve new starts against the wallet's accepted remote config, version floor, feature/deployment/service/geo gates and actual provider metadata. Do not substitute the portal's bundled JSON or testnet overrides as authority. Record configuration/catalog identity in the immutable review and operation snapshot. A missing/paused route blocks new starts with its real reason, without disabling safe recovery of an old operation.

The pinned portal has 24 mainnet and 11 non-retired testnet connections. These are parity fixtures, not an assertion of live availability. The acceptance matrix must account for each connection and unavailable direction. Do not silently omit routes that require extending the wallet's existing config-to-route mapping; do not publish changes to wallet-config as a side effect. If the accepted document genuinely lacks a required contract/service, report that specific route as blocked and request the separately scoped configuration change rather than inventing a value or declaring parity complete.

Use exact base units/decimal strings for admission, fees and minimums. Preserve portal source-precision and provider-specific destination-precision rules, fee charging direction, gas-reserving Max and required allowance reset/exact approval. A reviewed quote binds accounts, route/config, assets, amount, minimum, fees and expiry. Revalidate after asynchronous reads and approvals, before the irreversible step. Changed terms require review again; rejection preserves the draft without recording a fake transfer.

Use the authoritative configured bridge-in cap and its current valuation policy; never carry the demo's fictional eligible account or hardcoded balance into the product. Cap checks are repeated at admission and do not block withdrawals or acceptance of incoming notes.

### Provider-specific execution

- Agglayer: map Miden outbound to the existing B2Agg queue. Port missing EVM deposit/approval and durable source-identity behavior; bind observations/recovery to the committed exit, not address-only heuristics. Keep source finality, claim readiness and destination received distinct. Respect automatic/mainnet claims and the existing guarded manual-claim path; never issue a duplicate claim merely because a ready state is visible.
- Epoch: preserve the wallet's queued P2IDE collateral row, spending authorization, allocator/collateral guards and intent identity. Carry the portal's positive, precision-preserving reviewed payout minimum through the SDK request and durable operation; the wallet's existing outbound `minTokenOut: '0'` must not execute a newly reviewed guaranteed minimum. Validate the minimum before collateral creation and bind any solve/refresh to the reviewed floor. Inbound EVM funding uses the existing external wallet; outbound uses the Miden account with solver fulfillment. Unknown solver outcome checks the original intent/note, not a new collateral transaction.
- Circle/xReserve: reuse protected Miden burn/deposit/executor ownership; port missing quote/response/burn-script/preflight and replacement safeguards. Keep exact destination mint-proof confirmation and bounded scanning already in this wallet. The portal's manual withdrawal monitor must not replace that stronger evidence. Burn confirmed is not payout received; legacy balance-confirmed rows retain their existing treatment. No broader RPC scan budget is authorized.

Sources: portal `src/bridge/{core,providers,evm}/`, `src/app/lib/{bridge-submission,bridge-persistence}.ts`; wallet `src/lib/{epoch,agglayer,usdcx}/`, `src/lib/miden/{activity,transaction}/`.

## 9. Transport and dependency compatibility

No new hosted backend, paid provider, Next runtime or portal-origin dependency is proposed. Replace relative portal `/api/...` calls with wallet-owned clients over the existing configured public RPC, indexer, Circle and allocator endpoints. Port the server functions' pure validation/protocol logic into client-safe wallet service modules; never copy `process.env` secrets, server-only imports or generic forwarding endpoints.

| Portal API family                             | Wallet integration                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| EVM RPC/balance/gas/transaction               | Existing configured viem/RPC clients and external EIP-1193 wallet; preserve chain/account binding, timeouts and bounded read methods |
| Prices                                        | Existing wallet price/readiness service                                                                                              |
| Agglayer deposits/withdrawal recovery         | Wallet indexer/status clients plus ported exit-identity validation                                                                   |
| Circle quote/validate/status/withdrawal quote | Existing Circle/xReserve clients plus ported schema/domain/amount/fee/recipient validation                                           |
| Epoch quote/solve/status                      | Existing configured SDK/allocator and wallet-owned collateral/intent tracking                                                        |
| Miden reads                                   | Existing wallet backend and already bounded RPC readers, not another independently syncing store                                     |

Allowlist only required network origins in generated extension permissions/CSP. Preserve COEP/CORP, CORS handling, request limits, abort/timeouts, schema validation and sanitized errors. No broad wildcard grant, remote executable code or silent upstream fallback. If a required operation cannot run through these approved endpoint/runtime boundaries, stop that route and surface the precise infrastructure decision; do not silently introduce a server or weaken validation.

Portal uses React 19, wagmi 2, Miden 0.17.6 and Epoch 2.2.0; wallet uses React 18, wagmi 3, Miden 0.17.5 and Epoch 2.0.1. Adapt to the wallet runtime rather than transplanting package.json. Reuse its AppKit/query roots and lazy loading. Keep a single Miden SDK/Dexie resolution and a single Epoch SDK version. Validate the imported APIs before implementation of financial paths; if required, a narrowly scoped upgrade to the portal's published Miden 0.17.6 or Epoch 2.2.0 is within the proposed integration, with all existing consumers tested and signing-summary/effect assumptions requalified. Do not blanket-upgrade React, wagmi or the app framework. Retain schema validation; a schema dependency is justified only for genuinely ported schemas, not a few convenience checks.

## 10. Durable operation ownership and compatibility

Wallet transaction/intent records are the source of truth. Extend existing typed extra inputs only as needed for route/config snapshot, reviewed terms, EVM approval/source-attempt references and provider identity. Each new Bridge operation has one stable wallet row/lineage and an explicit integration version/owner. Rows without it keep legacy dispatch and recovery. Do not rewrite, delete, reprice or resubmit old receipts.

Use current durable admission and cross-realm storage turns to claim source/approval/solve ownership before opening a signature or submitting. The lock scope must cover all tabs and the service worker as appropriate; a React boolean is insufficient. Persist immutable intent before signing and known request/note/hash as soon as known, including storage-failure handling. A lost callback or live abandoned promise is uncertain, not safe-to-retry. After restart, reconcile the same source attempt and intent before considering any new write.

Reuse provider-level reconcilers exactly once for an operation. Do not mount the portal's monitors alongside BridgeIntentWatcher or create a second settlement driver. Closing a screen pauses display work only, not funds delivery. Consumer/adoption deduplication prevents one incoming note crediting two records; destination status never substitutes for actual note consumption/spendability. Fee reservation and failed-source handling use existing backend evidence, not optimistic UI timers.

Recent actions adapts existing merged history/claim/settlement data, preserves linked-consume suppression, and resumes by ID. It is available local/recovered activity, not an assertion of complete account history. Export diagnostics only through existing safe allowlists; no private keys, phrase, raw wallet storage, auth-bearing URLs or companion state.

## 11. Acceptance and verification

The prototype's 86 local checks are reference evidence only. None count as production integration tests or financial qualification.

1. Add failing meaningful Jest/RTL contracts before controller/persistence changes. Retain source-derived portal tests for precision, quote binding, allowance reset/cancellation/replacement, receipts, positive Epoch minimum, Circle bindings and exit-bound recovery. Convert Vitest conventions without discarding assertions.
2. Test one row/one source write/one solve across duplicate clicks, multiple fullpage tabs, sidebar plus fullpage, remount, restart, storage failures, unknown outcome and stale approvals. Verify restored history never becomes execution authority.
3. Preserve existing Send native-fee, spending-limit, Guardian/effect-guard, retry/poisoned-client, claims, Swap partial/recovery, Earn quote/withdrawal and USDCx exact-mint suites. New intercom messages, if unavoidable, cover backend, frontend store/context and the shared in-process mobile/desktop dispatch.
4. Run extension end-to-end paths for all five actions using existing isolated hermetic/localnet fixtures, real wallet/provider boundaries where supplied, and the actual fullpage entry. Keep 1Click and configured unavailable/paused/restricted routes covered. Live funded tests require separately bounded authorization and are reported separately.
5. Capture and open 1600x1000 and 1440x1000 extension screenshots for dashboard, all entries/reviews, pending/error/recovery/receipt states, search/pickers, scrolling, real QR and dock. Resize screenshots to at most 1800px. Also test a short/narrow fullpage, keyboard/focus, light/dark legacy surfaces, reduced motion and blur fallback.
6. Prove compact/sidebar unchanged apart from launcher. Exercise affected shared components/routes on extension popup/sidepanel, Capacitor and Tauri; run the repository's affected compile surfaces. New fullscreen appearance remains extension-only.
7. Keep TypeScript, source lint, i18n, provenance/license, dependency integrity, platform builds and unchanged 95% coverage thresholds. Heavy builds, full suites, coverage and browser tests use current-head CI under existing routing; light preflights use ci-local. Do not claim zero selected tests as a pass.
8. Run the installed finished-code review/fix workflow after implementation, not a panel on this design. Apply actionable findings and reverify the final exact source. No merge, release, deployment or financial spend is implied.

Current discovery is source-only. Product dependencies, baseline tests, builds, browser actions and live network settlement have not run in this worktree. Free local disk was approximately 7.6 GiB; do not install/build unguarded or remove other sessions' resources. CI/source publication authority follows the repository's explicit-push rule and is not waived by this document.

## 12. Implementation boundaries and approval

This is one integration project, delivered in dependency-coherent steps: shell/shared presentation and ownership seams, the four existing actions, portal bridge port, end-to-end visual/financial verification, then finished-code review. Intermediate shell-only or link-only work is not full integration. Keep the approved V6 reference intact throughout.

The builder chooses exact file splits, typed extraction details, minimal schema/dependency adjustments, concrete tests and safe commit boundaries within this design. Stop for a changed design if parity requires a new service/trust boundary, a weakened financial protection, a production configuration deployment or an altered approved journey. Do not invent values to avoid that gate.

Approval requested: the integration architecture above, including the local-observation chart behavior, memory-only unsigned drafts, unchanged compact/native surfaces and direct portal source port with wallet-owned signing/tracking. Also request feature-branch pushes and PR publication for current-head CI; this does not authorize main merge, release, deployment or financial spend. After approval, write the implementation plan and establish the verified baseline before product changes.

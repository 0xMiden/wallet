# CLAUDE.md

Guidance for Claude Code. **Self-maintaining:** update proactively when you learn a gotcha, pattern, or debugging trick worth keeping.

## Coverage runs only in CI

Never run coverage locally for this wallet, in any checkout or worktree. This includes `yarn test:coverage`, Jest `--coverage`, and local coverage shards. Use local noncoverage regression tests, type/lint checks and builds as appropriate. Coverage is measured by CI only; fix gaps from CI results without lowering thresholds. Merge only when the current-head CI coverage gate passes. Stop an active local coverage run when this rule is applied, and never count an interrupted run as passing.

## Project

The wallet only allows creating Guardian accounts. All accounts in the wallet are Guardian (guarded multisig) accounts. Treat this as a product invariant when implementing features or diagnosing reports; do not ask whether a wallet account is a Guardian account or assume a single-signature wallet account.

Miden Wallet: Chrome/Firefox extension + iOS/Android (Capacitor) + macOS (Tauri). React + Zustand frontend; service-worker backend (Effector store + vault). Backend is source of truth; frontend syncs via intercom port messaging.

## Layout

```
src/
├── lib/
│   ├── store/           # Zustand (frontend)
│   ├── miden/{back,front,sdk,psm}
│   ├── miden/transaction/   # tx pipeline: initiate/complete/get/cancel/helper; index = generateTransaction + loop (re-exported via miden/activity)
│   ├── intercom/        # port messaging
│   ├── platform/        # isMobile/isIOS/isAndroid/isExtension
│   ├── mobile/          # haptics, back-handler
│   ├── woozie/          # router (navigate, goBack, useLocation, <Link>)
│   └── shared/types.ts
├── app/ | screens/ | workers/
src-tauri/               # desktop
playwright/e2e/          # E2E harness (chrome + ios)
```

## Commands

```bash
yarn dev | build | test | lint | format
yarn build:devnet        # network-specific extension build
yarn mobile:ios:run[:devnet]     # iOS simulator (iPhone 17 default)
yarn mobile:android
yarn tauri dev
yarn test:e2e:blockchain:{testnet,devnet,localhost}
yarn test:e2e:mobile:{devnet,testnet}
```

Node >=22 for Capacitor/Tauri: `source ~/.nvm/nvm.sh && nvm use 22`.

Every production build script (`build:bg/cs/ext/mobile/desktop`, so every `build:*`, `mobile:*` and release path) first runs `yarn check --integrity` and refuses a `node_modules` that does not match `yarn.lock`; it takes 30 ms and exists so a stale checkout can never bundle the wrong SDK. Run `yarn install` and retry.

Lint/format only before commit or when asked — not every build.

## Version bumps

Extension manifest version comes from `package.json`, NOT `public/manifest.json` (webpack overrides it at `webpack.public.config.js:69-70`). Update **both** to keep in sync, then `rm -rf node_modules/.cache/webpack dist/` if the old version sticks.

## CHANGELOG

`CHANGELOG.md` carries unreleased entries under a `## <next-version> (TBD)` heading. **NEVER add an entry to a section whose version has already been published: the latest release is the highest `vX.Y.Z` tag (`git tag --list 'v*'`; a release candidate such as `v1.17.0-rc.0` does not count; run `git fetch --tags` first, since local tags go stale), which is what CI's changelog check reads. Put new entries under a section whose version is strictly higher and still has `(TBD)` next to it. If no such section exists, add one.** The header at the top of `CHANGELOG.md` may lag (a `(TBD)` heading often persists past the release tag); don't trust the heading alone.
CI's changelog check (`scripts/check-changelog.sh`, tests in `scripts/check-changelog.test.sh`) compares the file with the pull request's merge base: nothing may be added under a released version or under a heading with no `X.Y.Z` version, no entry may be added outside every version section, no released heading's version may be changed or removed (dating the heading is fine), and no released entry may move under another version; a single released entry may be deleted. It reads headings and sections through `scripts/changelog-sections.awk`, the parser the release notes use (`scripts/changelog-notes.sh`). It never reads the `(TBD)` marker, so the rule above still stands on its own.

## Critical gotchas

### WASM client concurrency
Miden WASM client is single-threaded. Concurrent calls throw `recursive use of an object ... unsafe aliasing`. **Always** wrap in `withWasmClientLock`:
```typescript
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
await withWasmClientLock(async () => (await getMidenClient()).someOp());
```

The lock self-recovers from a wedged holder (issue #775 - a WASM trap abandons its promise without settling, so `finally` never releases): a realm `error`/`unhandledrejection` listener evicts the holder on a trap in milliseconds, and a 5-minute watchdog (`WASM_LOCK_WATCHDOG_MS`, `sdk/wasm-client-poison.ts`) bounds any other silent wedge. The watchdog's budgets, its paused ledger and the recovery cooldown are charged in running time (`runningNow` in `lib/mobile/background-time.ts`), which is monotonic time minus the stretches the platform froze our JS and so equals `performance.now()` off mobile, so on mobile a hold parked across a freeze is evicted only after resume. Both reject the holder with `WasmClientPoisonedError` and replace the client singletons so the next `getMidenClient()` builds a fresh client. An EVICTION never frees the old instance on the spot - the evicted flow is past the mutex, still holds that reference and is by construction inside a WASM call, so freeing would fail a write that may already have submitted; it is marked poisoned instead (its `isDisposed` guards fire) and freed later, once EVERY flow retaining that instance has settled - the abandoned holder, any sibling suspended mid-yield, and the mutex owner that resolved the same instance - since any of them may still be writing. The same rule governs the one path that discards a client for a reason other than a trap, an endpoint-change `resetMidenClient()`, because it takes nothing a yielded holder holds: it marks and defers while any flow is suspended mid-yield rather than freeing under it. Nothing else replaces the client: since #878 each realm keeps ONE `MidenClientInterface` for its writes and nearly every read (the realm reader, `getRealmReaderClient`, serves the consumability read and the PSWAP request build), and its SDK keystore routes to callbacks the realm installs once (`installRealmKeystore`): `Actions.init` installs the vault signer in every realm that writes (the SW, mobile, desktop; the extension popup never runs it and never signs), a vault installs its insert-key sink when it takes its key, the realm's sink is re-derived from the store when the flow that constructed the vault ends (`syncRealmInsertKeySink` in actions.ts, adopted or failed), and lock retires only the vault it locks, so a spawn's sink survives a lock landing mid-flow; a hold in which an already-adopted vault inserts key material (`createHDAccount`, `importAccountFromPrivateKey`) asserts first that the sink is its own and refuses as locked otherwise, so a lock that landed while the create or import waited on the accounts queue fails it before any irreversible step; a spawn's hold does not assert, since its sink is the one its own constructor just installed and a lock retires only the store's vault. So `getMidenClient()` takes no options and is never rebuilt for a call; a sign reaching a replaced client is refused with `WasmClientPoisonedError`, an insert reaching one lands only while the installed insert-key sink is the one that client's build was retired against, judged by a per-sink id the build's trampolines carry so no closure is retained (the SDK has persisted the account by the time it asks; a secret under another vault's key is worse than none), and a call made before the realm installed the callback fails with a named error. A locked vault reported by a sign is recorded under the lock HOLD the sign ran for, and `withWasmClientLock` carries it out on that hold's own rejection (`tagLockedSignReason`, the same tag the offscreen path sets per op); the transaction loop reads only the error, never an ambient slot (a realm-wide one let a dry run's locked sign requeue an unrelated write). What that CANNOT reclaim is an operation that never settles at all: a gRPC-web fetch the node accepted and will never answer holds its client for the realm's lifetime, so the fuse (not the deferred free) is what bounds how many of those a parked node can accumulate. Only a trap with no holder at all disposes immediately. A trap that rejects its call instead of abandoning it (a synchronous WASM export such as a deserialize) never reaches those listeners either, so it is retired with `retireWasmClientForCaughtTrap`, once per trap: `withWasmClientLock` and `tryWithWasmClientLock` retire through their own holder when the callback rejects with a `WebAssembly.RuntimeError`, a catch handed the hold of its lock retires first (`decodeGuardianSummary`, `guardianResultCommitment`, `importNoteBytes`, `importRecoveryNoteBytes`), and none of those swallows a trap, rewraps it before retiring or falls back to another call on the same client. The client is poisoned in place and reclaimed as an eviction's is, but the hold is not evicted and releases the mutex itself. Catches older than this rule still swallow a trap and go on calling the client, such as the record reductions in `sdk/consumable-notes.ts`, `collectInputNoteDetails` and `resolvePublicKeyCommitments`; a new catch around a call on the client follows the rule, not them. A lock retires any trap that reaches it, whatever WASM object trapped; a catch that turns a trap in an `RpcClient` built for one read into a failed read before any lock sees it (the native-asset fee catches, `lookUpBlock` in `block-timestamps.ts`) swallows no client trap, since the client in the slot was never inside that call.

A JS timeout is NOT a substitute for the ceiling: rejecting out of a lock callback releases the mutex while the abandoned call keeps running, which is safe only when (a) the WASM is in another realm behind its own mutex, or (b) the abandoned tail makes no WASM call after its first suspension except on objects the flow built itself from plain inputs (such as a signer key from a seed), never the client or any object a client call returned. `runsWasmInThisRealm()` (`back/miden-client-proxy.ts`) is how a caller tells (a) apart: `sync-manager` keeps its 30s timeout on the offscreen path and takes `watchdogMs` on the inline one. Guardian creation needs neither: its key fetch and registration, and their timeouts, run outside the hold (`fetchGuardianCreateKey` and `registerGuardianAccount` in `lib/miden/guardian/account.ts`, #1207).

If a lock-held flow legitimately waits unboundedly (user-facing sign, local prove), bracket that wait in `withWasmLockWatchdogPaused`, passing the hold. The pause RELAXES the ceiling to `WASM_LOCK_PAUSED_WATCHDOG_MS` (30 min) rather than stopping the clock — a stopped clock made the backstop optional, which is the pre-#775 wedge reached through the fix's own escape hatch. Both ledgers are per-HOLD, not per-bracket: paused time is banked in `pausedElapsedMs` (sequential brackets share the 30 min), running time in `unpausedElapsedMs`, and the close re-arms only the unspent normal budget plus one 30 s finishing slice if it already ran out. So it is NOT the same shape as the proxy's `pauseDeadline`/`resumeDeadline`, which does restart from scratch: no loop of brackets can buy unlimited unwatched time. A yielded wait (`yieldWasmClientLock`) draws on the same relaxed ledger — it banks its running time into `pausedElapsedMs` on the way out, so alternating a sign pause and a prove yield cannot buy 30 minutes twice — and a yield that never settles is evicted, not wedged. Both ledgers grant ONE `WASM_LOCK_MIN_WATCHDOG_MS` finishing slice when a legitimately-unbounded wait exhausts the budget (`graceUsed`, `pausedGraceUsed`); without the paused one, a 30-minute sign prompt left the prove that follows it arming at a ceiling of zero.

In the offscreen document every LOCAL prove runs in its prove worker (`src/offscreen/prove-worker.ts`, #945): a second WASM instance with its own rayon pool, reached through the realm's `LocalProveTransport` (`sdk/local-prove-transport.ts`). Execute, sign, submit and apply stay on the document's client, and the flow HOLDS the mutex across the worker prove. Two rules come with it. Every worker `error` event is `preventDefault()`-ed before anything else: an unprevented worker `RuntimeError` reaches this realm's trap listener and evicts a healthy holder. And eviction CANCELS the worker prove (the hold's `aborted` rejection terminates the worker), so an evicted flow can never reach `submitProven`; a worker failure fails the write pre-submit, with no in-realm fallback.

Every bounded hold passes a `label` in its lock options; both eviction logs print it as `hold`. A dozen sites now share the two-minute sync ceiling, so an unlabelled record cannot say which flow parked.

The realm's sync FUSE (`lib/miden/front/sync-fuse.ts`) is module-scoped and shared, NOT private to `useSyncTrigger`: what it records is a fact about the realm's parked client, and four timers drive a hold against that one client. But it is KEYED PER PROBE (`SyncFuseKey`: `idle-sync`, `claimable-notes`, `balances`, `badge-verdict` (shared by the badge issuer's `badge-commit-verdict` and `badge-swap-verdict` holds), `guardian-sync:<accountPublicKey>` via `guardianSyncFuseKey`, `guardian-adopt:<accountPublicKey>@<previous endpoint>` via `guardianAdoptFuseKey`, `guardian-self-heal:<accountPublicKey>@<endpoint>` via `guardianSelfHealFuseKey`, and `swap-zero-fill-build`, which names the zero-fill PSWAP cancel-request build rather than a hold; otherwise the same strings as the hold `label`s), and that is load-bearing, not cosmetic. One shared counter was defeated by ordering alone: `useSyncTrigger` reports its chain sync's success and only THEN fires guardian sync, so against a healthy node with a parked guardian the count oscillated 0 → 1 → 0 and the threshold was unreachable: the exact every-two-minutes park and per-lap client leak the sharing was added to end. Evidence is withdrawn only by a success on the SAME key.

A KEY IS THE NARROWEST THING THAT CAN PARK INDEPENDENTLY - which is why guardian carries the account. Sharing one `guardian-sync` key reproduced that same defeat one level down: `syncGuardianAccounts` loops the accounts sequentially and each has its own endpoint, so a healthy sibling's success erased the parked account's increment within the same lap. Too coarse and the threshold is unreachable; too fine and no key accumulates enough. Conversely, the swap-settlement tick's note read deliberately SHARES `claimable-notes`: same notes, same proxy call, same endpoint, so the two cannot park independently. Its zero-fill PSWAP cancel-request build is a node call the poll never makes, so it has its own key, `swap-zero-fill-build`, and a build failure is booked there once and never on `claimable-notes`: by the build's catch in `classifySwapSettlementSnapshot` while its hold is current, else (a build parked until the hold's eviction) by the hold's handler through `noteZeroFillBuildHoldFailure`, in `settleSwapOrders` and the service worker's note read.

Feeding the ledger is not enough on its own: a probe with no scheduler of its own to stretch must also CONSULT it (`isSyncFused(key)`), or a lit fuse buys nothing. Eight do: `syncGuardianAccounts` (gated PER ACCOUNT inside its own loop, next to the 429 cooldown, NOT at the caller: it has two callers, and a caller-side gate covered the mobile/desktop loop while the extension's post-`SyncRequest` trigger went on parking), the claimable-notes SWR poll (via `isPaused`, so the displayed list survives), `fetchBalances` (returns `null`, the same contract as its mutex-busy skip), `settleSwapOrders` (returns an empty result, which is what "nothing to settle this lap" already looks like), the zero-fill build in `classifySwapSettlementSnapshot` (in both realms: the orders wait and the notes are still classified), the self-heal's adopt from a landed switch's previous guardian (`adoptFromPreviousGuardian`, which lights its key on the first park with `noteSyncParked`, since one park is the cost the next lap would pay again), and the cold re-register and missing-registration self-heals, gated in `syncGuardianAccounts` before each heal runs and sharing one key (#1233). Adding a new timer-driven WASM hold means: bound it, label it, pick a key, report success/eviction/other-failure, and gate it.

Report the success ONLY ONCE THE WHOLE PROBE IS THROUGH. `getClaimableNotes` takes two holds (note read, then swap-lineage classification) and the mutex is released between them, so a success booked after the first cleared the evidence the second was accumulating — the same erasure as a shared key, inside one function.

Every fuse conclusion is about ONE node, so an endpoint change discards all of them — `clearSyncFuseForEndpointChange()` from Developer Settings' save (the frontend realm) and `resetSyncBackoffForEndpointChange()` from the SW's `ReloadEndpointOverridesRequest` handler, before `resetMidenClient()`. Without it a fused wallet repointed at a working node stays near-silent for another 30 min and withholds the successful sync that is the fuse's only exit.

The service worker keeps its own copy of the same rule in `sync-manager.ts`, counted per failed probe rather than per breaker trip — that path zeroes `consecutiveSyncFailures` whenever a window opens, so a counter inside the breaker block would need three times the evidence at two parked minutes each.

An evicted operation is abandoned, not cancelled - treat `WasmClientPoisonedError` like `OperationAbortedError` and the SDK's terminated-client error in any kill classifier (`isPipelineKillLink`, or `isKilledPipeline` down a cause chain). Only an eviction or an abort may still be running (`isRunningPipelineKill` down a cause chain): never assume that pipeline stopped. The SDK refused a terminated client's call or stopped its worker, so the syncing boundary requeues a failure whose only kill is a terminated client. Concretely, inside a hold: **re-check ownership after every parking await, before the next client call or side effect** (`getCurrentWasmLockHold() !== hold` → throw `WasmClientPoisonedError`), not just after the client build. An eviction hands the mutex on and replaces the client singletons, so the abandoned callback's next `midenClientProxy` or `getMidenClient()` call resolves the successor's client. A client captured earlier is the poisoned instance, which only a sibling suspended mid-yield may still be using. Anything the tail does after its caller saw the poison (removing a key, authorizing a recovery) is a side effect nobody is waiting for. A returned `Account` or note record is a standalone wasm-bindgen object on its own pointer, not a borrow of the client, so reading it after an eviction is a stale read (`fetchBalances` reads its assets outside the lock, #360). Guarded this way already: the SW sync's downstream read (four transitions), `fetchBalances`, `settleSwapOrders`, the manual note import, the note-import queue, the guardian leaf pipelines, the offscreen poll, the direct-switch holds, the post-rotation re-register read (`completeReplaceHotKeyTransaction`), seed removal and the recovery-seed check. Concretely: never route a poison or an abort onto a path that requeues a row as a fresh write, because the abandoned pipeline can still submit and the requeue becomes a second payment.

Store clients are built only in `sdk/miden-client-interface.ts`: each realm's client and its realm reader, which only reads, apart from the genesis header its first build may store. `sdk/store-clients.test.ts` pins every construction site its syntax-tree reader sees in wallet source (its docblock lists the forms the reader does not follow); it cannot see a client that a dependency builds, which is how the React SDK's `MidenProvider` synced the store on every page open, so no wallet source depends on `@miden-sdk/react`; only the test dApp's React page loads it, as a devDependency, on its own origin. A sync on one client interleaved with a note import on another can leave a tracked block header whose MMR path is too short for the checkpoint, and every later sync and import fails (#1493). On the extension the service worker, the offscreen document and each page build a client of their own, so only an SDK that serializes imports with syncs across clients makes that pair safe.

### Post-await liveness inside a LOOP, not just at its boundary
A guard at a callee's entry only proves ownership for its first WASM call. Where a helper
loops over user-sized input — `classifySwapOrderNotes` does one lineage round trip per open
order — the hold has to be threaded in and re-checked per iteration; the caller's guards
cannot see inside. Same rule as the per-call re-checks: an eviction mid-loop releases the
mutex and every later call in that loop runs on somebody else's client.

### Rotated-out hot key (another device holds the account)
A seed recovery on a second device rotates the hot key and re-registers with the Guardian, so the first device's hot-signed requests 401 while its reads (chain sync, balances, notes, history) keep working and the wallet looks healthy. The verdict is `WalletAccount.hotKeyRotatedOut` (`HotKeyRotatedOutVerdict`: the local key judged, the chain's slot-0 commitment, when), written through `markHotKeyRotatedOut` (vault, action, store, and the optional `GuardianAccountProvider` callback both providers implement) from the two places that compare this device's key with signer slot 0: the sync tick's cold re-register self-heal when `findOwnRotation` finds nothing (`refused-permanently`), and the direct guardian switch's `HotKeyRotatedOutError`, which the pipeline persists before failing the row. It is NOT a fourth `GuardianSyncStatus`: the drift pass rewrites that status to `in-sync` whenever the guardian key matches. The vault writes it only while the stored `hotPublicKey` is the judged key, and `isHotKeyRotatedOut` (`guardian/sync-guard.ts`) counts it only while that still holds, so a missed clear cannot block a live key; `swapHotKey` clears it anyway. It folds into `isGuardianSyncBlocked`, so every transaction initiator, the dApp projection and the settings pill follow. `HotKeyRotatedOutGate` (mounted beside `HotKeyRotationGate` in `App.tsx`, current account only) is an `AlertSheet` with `dismissible={false}` and a second action (`onSecondary`, which stays visible on an undismissable sheet, unlike Cancel); it offers Make this device the main one, which is `retireRotatedOutHotKey`: drop the stale key, set `requiresHotKeyRotation`, and let `HotKeyRotationGate` run the cold-signed rotation whose post-rotation re-register revokes the other device (needs the cold key, so a hot-key-only import gets only the wipe). Detection still waits for the self-heal's 401 streak and cooldown; lighting it from a transaction's first 401 is not built.

### Duplicate dexie / duplicate `@miden-sdk/miden-sdk` ("Two different versions of Dexie loaded")
The wallet pulls `@miden-sdk/miden-sdk` two ways: the file-linked web-sdk (root, e.g. 0.14.10) AND a nested copy under `@openzeppelin/miden-multisig-client/node_modules/@miden-sdk/miden-sdk` (its own pin, e.g. 0.14.5). **Each SDK build INLINES its own dexie** into its wasm-glue chunk (`dist/**/Cargo-*.js`), at different versions (e.g. 4.4.2 vs 4.0.8). Two inlined dexies → dexie's `globalThis[Symbol.for("Dexie")]` guard throws at runtime (service worker fails to register; mobile/desktop crash). Because dexie is *inlined*, `resolve.alias`/`resolutions` on `dexie` alone can't fix it.

Fix (already in place — keep it): every app vite config (`vite.{mobile,extension,background,desktop}.config.ts`) sets `resolve.dedupe: ['dexie', '@miden-sdk/miden-sdk']` so only the single root SDK resolves (this also collapses the duplicate WASM `WebClient`), and `package.json` pins `dexie` + a `resolutions` entry to the web-sdk's inlined version. Debug tip: `var DEXIE_VERSION` is in the UMD `dist/dexie.js` (no guard); the guard lives in `import-wrapper.mjs`. To find a stray version, parse a built chunk's `.js.map` for `sourcesContent` containing `DEXIE_VERSION` — the `sources[]` path names the offending package. `grep -r` over node_modules misses it (binary-detected wasm-glue + symlinked file: deps); use `--binary-files=text` and the sourcemap. `build:ext`/`build:bg` don't `rimraf dist/` — wipe `dist/chrome_unpacked` before re-verifying or you'll read stale chunks.

### Tailwind auto-flipping tokens
Many tokens in `tailwind.config.ts` map to CSS vars in `src/main.css` and auto-flip with theme. Do NOT add `dark:` variants on these — it overrides the auto-flip with a worse value:
- the design-system tokens `bg-page`, `bg-fill`, `bg-fill-pressed`, `border-hairline`, `text-ink`, `text-muted`, `accent-tint(-ink)`, `*-ink` status text
- legacy `bg-white`, `bg-gray-100`, `black` (`black` is `ink`, white in dark theme: an overlay that must stay dark uses `pure-black/NN` or `scrim`; text is `text-ink`)

`gray-25`, `gray-50`, `surface-input`, `surface-interactive`, `surface-nav-button`, `button-secondary(-hover)` and `heading-gray` are removed: use `fill` / `fill-pressed` / `ink`.

Add `dark:` only on fixed-palette colors (`grey.*` custom palette, `pure-white`, `pure-black`) or SVG `fill={...}` props (check `document.documentElement.classList.contains('dark')` at render).

### i18n required
All user-facing text must use `t('key')` or `<T id="key" />`. CI blocks non-i18n strings (`yarn lint:i18n`). Add new keys to `public/_locales/en/en.json` (flat format). Placeholders: `$name$`.

### Platform isolation
Wrap platform-specific fixes with `isIOS()`/`isAndroid()`/`isMobile()` from `lib/platform`. Don't apply iOS fixes globally.

### Haptics on tappable components
Add `hapticLight()` (taps), `hapticMedium()` (toggles), `hapticSelection()` (tabs) from `lib/mobile/haptics`. Auto-checks `isMobile()` and user setting.

### Storage hooks' cache
Write a key a storage hook reads (`useStorage`, `usePassiveStorage` in `lib/miden/front/storage.ts`) only through `putToStorage` or the hook's setter, which settle the value into the hooks' SWR cache. A direct `getStorageProvider()` write or removal of such a key leaves the cache stale on mobile and desktop, where no change event exists. A new wipe or bulk removal of such keys awaits `rereadStorageCache()` in a `finally`, as `lib/miden/reset.ts` does. A module store that keeps storage values outside the hooks' cache registers its re-read with `registerStorageReread`, as `lib/miden/front/stored-id-set.ts` does.

### Offscreen document: no extension storage
The extension's offscreen document has no `chrome.storage`, so its network and fee faucet come only from the service worker, which sends `getEndpointState()` with every `OFFSCREEN_CALL` and `OFFSCREEN_RELOAD_ENDPOINTS` once its own first override load has settled (`whenEndpointOverridesLoaded`). The document adopts that state on receipt, refuses a call without it and builds no client before adopting one. Nothing in that document may read extension storage for a value it then trusts: the read throws, the error is swallowed, and the build's defaults answer instead (#1482).

### Recovered Guardian history
Recovered history rows are trusted as the operator serves them (no signer signature or old account commitment can be checked), so `recoverGuardianHistory` asks only the account's own operators (its current `guardianEndpoint`, which a restored wallet file sets, and the switch endpoints of rows this wallet made) and the network's built-in ones (`getGuardianEndpointsForNetwork`: the config document's `guardians`, else the bundled list, see Guardian operators below). An endpoint that a Guardian reports, or that a recovered or file-restored transaction row names, must never join that list.

A recovered swap order is the one recovered row the wallet acts on (#1487). Recovery writes Auto accept off and no expiry, and only the placing device's SDK tracks the order's lineage or keeps its output note, so its lineage as the node holds it is its whole state: `SwapOrderTrackingManager` reads it, on an in-flight guard of its own that never waits on the WASM-locked live-order poll, through `trackRecoveredSwapOrders` (`lib/miden/swap/recovered-order-tracking.ts`), which follows `readPswapOrderLineage` (`lib/miden/sdk/pswap-order-note.ts`, RPC reads on clients of their own, no WASM lock) from the order note through each partial fill: a fill spends its tip and creates the remainder in the same transaction, so in the spending block and under the tip's own tag. The pinned RpcClient serves no link from a note to the transaction that created it, so a note of the order (this account's PSWAP note with the order note's serial but for the last element, the round) is tied to its parent by the PSWAP script's fill arithmetic (`fillsAllow`, citing `pswap.masm`): its storage but for the requested amount and its offered token are the parent's, and one round on, its request and offer are exactly what one fill of at least the note's fill floor leaves. Fills of one order inside one batch erase the remainders between them, so the spending block may hold only a later round; the walk takes such a jump only when that block holds, under the creator's account-target tag (where `create_p2id_note` puts every payback), exactly one public P2ID payback per round between them carrying the scheme-3 PSWAP attachment `[fill, order id, depth, 0]` with this order's id, and those fills, applied in depth order, land exactly on its request and offer (`fillsReach`). The pinned SDK reads no attachment's scheme, so `paybackOf` checks it by rebuilding the note's id with the word under scheme 3. A tip's depth is its serial round over the order note's. One read follows at most 16 rounds from its start. The spent tip at the bound or last spent tip before a jump past it is recorded as `recoveredCheckpoint` (the read's start only when it made no progress), and a later read resumes from the deeper of that checkpoint and the recorded open remainder, after fetching the start note and checking its own PSWAP fields, order serial, fixed fields and depth. An invalid start is ignored and the read begins at the order note. A read stays unresolved with the spent tip at its bound or the last spent tip before a jump past it as its checkpoint; this is the read's start only when it made no progress. A spent checkpoint is never the remainder Cancel returns. An unspent tip is an open order that reads Pending (`isOpenRecoveredOrder`, `swapSettlementOf`), whose receipt takes its state and Cancel from the lineage alone, this wallet's linked consumes giving only the filled amount and fill rows (`deriveSwapReceipt`), and only while the row is tracked: an open read is reported only once the guarded modify that records it confirms the row is still open, and `HistoryDetails` gives a closed row's receipt no tracking entry; a remainder is recorded on the row as `recoveredTip`, what its Cancel returns, which a recovery that derives the row again keeps, with `recoveredCheckpoint` and the other stamps the wallet wrote (`withStoredSettlementStamps`); and only a spend whose block holds no note of the order at all closes the order, with the completed consume of this wallet that explains it, else `orderNoteSpentAt`, and `lineageClosedAt` recording that the close is the lineage's. Nothing else stamps it closed (`isRecoveredSwapOrder`): history recovery links a recovered consume to its order without a stamp (`reconcileRecoveredSwaps`), and the stamp repair and a consume's completion stamp only live orders, since a payout claimed from a partial fill leaves the remainder open. A `settledAt` or `reclaimedAt` without `lineageClosedAt` is the pre-fix recovery reconcile's and provisional in every reader: the order is tracked and reads open, an open read clears the stamp, and a finished one closes the order as above. A note of the order that the arithmetic does not allow, two of one round, a note under the tag the node serves no body for, a jump whose paybacks are missing, private, duplicated or do not rebuild it, or a failed read leaves the order open for a later read. Cancel swap stamps it like a live order, which admits it to `localSwapOrders` (`isRecoveredReturnOrder`), and settlement cancels its tip through `buildPswapCancelRequest` with `allowNodeNote`, as does the Guardian proposal rebuild for that order alone. A refused cancel waits 30 s doubling, and both settlement consumers (`settleSwapOrders` and the service worker's note read) hand its order to `checkRefusedRecoveredOrders` once the WASM hold is released, so the realm that saw the refusal closes a finished order or moves it to its remainder itself. A note or order has at most one node read unsettled per realm and node endpoint: the timeout ends the wait, not the read, whose client is freed only when it settles, and after an endpoint change it is read on the new node at once. A lineage result is written (a remainder, a checkpoint, a cleared stamp, a close) only while the node it was read on is still the effective one, so a read an endpoint change overtook writes nothing and the order waits for the new node's read. The stamp is the permission, so `importDb` drops a dump's `expiryTriggeredAt`, and on a recovered order also the expiry the Cancel wrote, the recorded remainder and checkpoint, `lineageClosedAt` and `orderNoteSpentAt`, so the order imports open, its closure left to its next lineage read, with its Cancel offered again. Payback settlement and the claim route stay off for recovered orders.

### Arcade GC purchase
GameCoin purchases use GeoQuizz's custom sale script, not standard PSWAP notes. The script root is pinned in `GC_SALE_SCRIPT_ROOT` (`lib/miden/sdk/pswap-order-note.ts`). The pair keeps its standard PSWAP tag. `findGcSales` reads public notes from the node in bounded discovery batches and checks cached offers again. It validates the script, seven storage fields, single fungible asset, GC/USDCx pair, positive inventory and price at or below 0.001 USDCx per GC. It accepts any seller. `features.arcadeGcPurchase` remains the purchase switch; the existing `arcade.sale.seller` config field remains in the schema and cache scope for compatibility but no longer restricts sellers.

`pickGcSale` selects the cheapest discovered offer that can supply the entered amount and meet its minimum fill, then the largest inventory for equal prices. It excludes the buyer's own sales. The amount field starts at 1 GC. Payment is rounded up; `pswapFillPayout` gives the GC amount recorded on the receipt. `useGcPurchaseQuote` polls while the page is active, and the drawer selects an eligible offer again when the amount changes.

The SDK's PSWAP consume helpers reject the custom sale root. `buildPswapConsumeRequest` delegates to `buildGcSaleRequest`, which reads the authenticated note and supplies it to the fee-aware builder with explicit argument `[usdcx_paid, 0, 0, 0]`. It checks the unspent state, creator and minimum fill again and refuses the buyer's own sale. The existing WASM lock, chain-synced Guardian proposal hold, request persistence, spending-limit admission and transaction queue remain required. No request rebase may discard the input note. A spent note fails without a new purchase; a later quote can find the remainder. `scripts/dev/gc-sale/buy.mjs` is historical evidence for standard PSWAP only, not acceptance of this custom-script Guardian path.

### Remote bridge config
Epoch and Agglayer values come from `0xMiden/wallet-config` (`<network>.json`) through `lib/remote-config`: read them with the `select*`/`get*` getters in `lib/remote-config/values.ts`, never a compiled constant. The getters read this realm's in-memory snapshot synchronously, and a handler can run before startup hydrated it, so a path that runs without a user action (a service-worker request, spend valuation, bridge-in matching, an Epoch SDK build behind a watcher or poll) first awaits `initBridgeConfig()`, which is idempotent and never waits for the network. Every wallet reset but Developer Settings' keeps each network's stored document and its derivation (network configuration, like the floors), so that hydration holds after a create or import; Developer Settings' reset takes them with the endpoint override, since the derivation was read from the override's node, and keeps the floors. A one-off request in a realm that may never have stored a document (an E2E hook) awaits `ensureBridgeConfig()`, which waits for the first fetch. Entry points read `useFeatureAvailability(feature)` and grey out under `FeatureUnavailableNotice`; a flow past its entry point fails through its own error path. E2E builds read the document from `MIDEN_REMOTE_CONFIG_URL` (honoured only under `MIDEN_E2E_TEST`); the hermetic suites serve it with `playwright/e2e/helpers/fake-bridge-config.ts`.

The DEX/PSWAP swap registry is the DEX solver's Pairs API, never a compiled list and no longer the document's `swap.tokens` (the parser ignores that list): the document names only the solver (`swap.etaUrl`), and the derivation reads `GET <etaUrl>/v2/pairs` into `derived.swap.pairs` (parsed by `lib/remote-config/swap-pairs.ts` and verified by `derive.ts`, a `Probe` stored and shared between realms like every derived value). A malformed listing is dropped with its pairs, and so is every listing that shares a faucet id or ticker with another entry, malformed or not, so the list never depends on the solver's order. A token is kept only at its faucet's on-chain decimals: a mis-scaled token, or one whose faucet is missing or not a public fungible faucet, is dropped with its pairs, and any other failed faucet read fails the read, as does a listing of more than 64 tokens or a verification past 30 s. A failed read keeps the last verified registry within a document version and, in a running realm, across a version that names the same solver (a fresh realm reads only its own version's stored derivation); with nothing to keep, the DEX route reads as service down, which the bridge config's poll treats as a recoverable outage (`unavailableReasons` in `runtime.ts`). `getSwapTokens()` (`lib/miden/swap/tokens.ts`) maps the solver's tokens (hex faucet, `ticker`, `decimals`, `binanceAsset`) to `SwapToken`s and prepends the discovered native asset; a component reads it through `useSwapTokens()`, which re-renders when the registry lands and once the SDK's WASM can turn a listed hex id into its bech32 form. The solver names no logo; a registry token's logo is its faucet's token-list logo, like every token's (see Token symbol/logo below). A registry token takes the bridge price allowlist's `priceSymbol` for a faucet the document names (`bridgePriceAllowlist`: the Earn USDC faucet at USDC, each AggLayer native-ETH faucet at ETH), else the solver's `binanceAsset` when the price feed quotes it (`KNOWN_SYMBOLS`); the solver's assets can be stand-ins (IMIDEN is priced as SOL), so think before a new `KNOWN_SYMBOLS` key. `getDefaultSwapPair()` pays with the discovered native asset (USDCX on testnet) and receives its first partner when the solver pairs the native asset, else it is the solver's first pair, or null with no pair, and the DEX route draws `swapAvailability`'s notice instead of its form while the DEX pair is null. A configured `swap.oneClick` route with an eligible cross-chain asset path can keep the shared Swap flow available without `swap.etaUrl` or DEX pairs. A token the solver lists in no pair is in the registry, but the DEX pickers and DEX `swapAvailability` need a pair. The pickers filter by the solver's pairs (`useSwapPickerTokens`, over `getSwapPartners`): "From" lists every token that has a partner, so a token in no pair, a native asset the solver does not pair included, is never offered; "To" lists only the partners of the "From" token; and a new "From" token that the solver does not pair with the current "To" moves "To" to its first partner (`SwapManager`'s `onTokenSelected`). A DEX E2E override has no pairs, so its picker fixture treats every two tokens as a pair. Compare a registry faucet canonically (`getSwapTokenByFaucetId`, `normalizedFaucetId`), never with `===`: a row carries the bech32 form, the solver the hex. The DEX quote service is the same `swap.etaUrl`: `getSwapEta` rejects with `SwapEtaUnavailableError` and makes no request while the DEX document names none, so DEX quotes are unavailable even when a separate 1Click route is configured. Testnet's iETH label and info (`token-labels.ts`) key off the solver's `IETH` token (`selectSwapTokenFaucetId`). A unit suite that needs the registry installs the fixtures in `lib/miden/swap/testing/registry.ts` with `_setSwapTokensForTest(TEST_SWAP_TOKENS)`, or reads `TEST_BRIDGE_CONFIG_SNAPSHOT`, whose derivation lists them (`TEST_SWAP_PAIRS`, spelled in the registry's bech32 so an SDK stand-in that parses no id still matches; `testSnapshotWithSwapPairs` gives a snapshot with another answer); the E2E swap suites keep injecting theirs through `__TEST_SET_SWAP_TOKENS__`.

NEAR Intents (1Click) shares the Swap entry point but has its own default-off gate: `features.nearIntents` is a strict boolean and defaults to `false`; it must be exactly `true` before `swap.oneClick` can be used. The config parser accepts that route on mainnet, and on localnet only when the hermetic E2E gate has `MIDEN_E2E_ONE_CLICK_TESTNET=true`, `MIDEN_E2E_TEST=true`, and `MIDEN_NETWORK=localhost`. `SwapFlowGate` can expose a configured 1Click route when the DEX `swap.etaUrl` and Pairs API are absent. Published mainnet bridge config supplies `swap.oneClick.serviceUrl`, the production 1Click quote/proxy endpoint. Its `evmAssets` list defaults to empty; ERC20 automatic funding requires reviewed entries with `assetId`, `blockchain`/`chainId`, `contractAddress`, `decimals`, and `symbol`, while native-asset pins remain. `src/lib/one-click/client.ts` sends quote, status, and deposit requests to the configured service, and `src/lib/one-click/tracking.ts` stores and reconciles wallet transaction state. The hermetic local service is `playwright/e2e/helpers/fake-one-click-service.ts`, wired by `playwright/e2e/fixtures/hermetic-one-click.ts`.

The Earn vaults are the document's `earn.vaults` list (`id`, `marketUid`, `name`, `protocol`, optional `about`, `risk` and `depositsEnabled`; picker order), never a compiled lender allowlist. `readEarnVaults` (`lib/epoch/pools-read.ts`) take the list (`listed` on the route: the derivation passes `config.earn.vaults`, and only the derivation reads the catalogue) and keep only the `/pools` (or positions-fallback) items whose lowercase `marketUid` it names, in its order, each carrying its entry as `EarnVaultInfo.listing`; a listed vault the catalogue does not serve is dropped and reported in `droppedMarketUids`, and a route the list names no vault on is not read. A deposit hashes the entry's `protocol` (`earnMarketForVault`), a vault takes a deposit only while `earnVaultTakesDeposits` (the catalogue's `canOpen` and the entry's `depositsEnabled`), the route id is the entry's `id`, and the screens show its `name` as the title, its `about` and `risk` in place of the catalogue's, all literal and never translated. `useEarnPositions` takes its vaults from the derivation's catalogue (`selectEarnVaultCatalog`), one per listed entry in the document's order, so a vault the document drops disappears, and a catalogue that failed or is not derived yet leaves the vaults empty without a `loadError`, which is the positions read's alone. Its SWR key needs only the document (account, network, `positionsUrl` and the Epoch route chain ids), never a derived value, and `notOnNetwork` is a loaded document that names no positions host, no Epoch route or no Earn vault. Each successful read is stored under `earn_positions_v1:<key as JSON>` as `{ at, result }`, without errors and at most 32 KiB, through `putToStorage`. A mount shows that copy, every position stale, until the hook sees a live read of the key, which starts at mount; the copy of a key the hook leaves is removed. No storage hook reads that key, so a wallet reset needs no re-read for it: every wipe removes it with the other unkept keys. The hook also returns `vaultsPending`: true while the document lists vaults and `derived.epoch.vaults` is not there yet, false once that probe has any state; `isLoading` belongs to the positions read and can end first, so `EarnVaultDetail`, `EarnDepositAmount` and `EarnDepositReview` pass `isLoading || vaultsPending` to `earnItemLoadState`, else a vault that is only pending reads as not found. An entry can have an optional `logo`, a path `^icons/[a-z0-9]+(-[a-z0-9]+)*\.(svg|png)$` relative to the base the document was fetched from (`bridgeConfigBaseUrl`); several vaults can name one file; `schema.ts` and `derived-snapshot.ts` both read it with `EARN_VAULT_LOGO`, `selectEarnVaultLogoUrl` resolves it, and `useEarnPositions` puts it as `logoUrl` on each vault and on each position in a listed market. `ProviderLogo` draws it first, only through an `<img>` (`crossOrigin="anonymous"` for the extension's `require-corp`, `referrerPolicy="no-referrer"`, `loading="lazy"`), so an SVG never runs, and on error falls back to the bundled mark, else the initial. The desktop CSP `img-src` allows `https://raw.githubusercontent.com/0xMiden/wallet-config/` (`src/lib/remote-config/csp.test.ts`). The derivation (`discoverEarnVaults` in `derive.ts`) reads the catalogue of each route the list names once per document version, the positions fallback taking its token's symbol and decimals from the route's USDC read, merges the routes in list order and stores the result as `derived.epoch.vaults`, a `Probe` stored and shared between realms like every derived value (`selectEarnVaultCatalog`), so no page reads `/pools`. The default market comes from the same requests: the first listed vault that takes a deposit, else the first the catalogue serves. With no listed vault on an Epoch route, or no positions host, both probes are skipped and `earnDeposit` reads not configured. One failed route read fails both. A failed read keeps the last catalogue of the same document version (`keepValuesRead`) and polls as a recoverable outage (`unavailableReasons`). A stored catalogue that does not read back strictly (`derived-snapshot.ts`) is a failed read, never a partial list, and a copy stored before the catalogue existed is derived again. `earnLenderFamily`/`EARN_LENDER_FAMILY_NAMES` only name and mark a market (logos, a position's protocol, the label of an unlisted market). The list gates deposits only: `fetchEarnPositions` is the owner lookup and one positions request per owner for every Epoch route the document names at once (`chains=8453,42161,1`, `getEpochRoutes`), with no catalogue read, and keeps every position in a route's USDC whether or not the document lists its market or the catalogue loaded, so a position in an unlisted market (a Morpho Blue market the list never named) stays in sight and withdrawable. The parser mirrors the config repo's validator (`readEarn` in `schema.ts`): the section exists exactly when `features.earn` is true and is then non-empty; ids `^[a-z][a-z0-9-]*$` and markets unique; `marketUid` is `LENDER_KEY:chainId:underlying` with an upper-case key, a chain whose Epoch route the document lists and that route's USDC in lower case, read from the document as written, so a chain this build skips still names its vaults; `name` 1 to 64 characters and `about` 1 to 200, with no other character rule; `protocol` `1delta` or `dummy-lending`; `risk` `low`, `medium` or `high`; the parsed `marketUid` is lower case and `depositsEnabled` defaults to true. An invalid section invalidates the document.

### Guardian operators
The Guardian operators of a network are the `guardians` list of its `0xMiden/wallet-config` document (`id`, `name`, `operatedBy`, `location`, `endpoint`, optional `about` and `kind`; picker order, the first is the default), never a compiled list. `lib/miden-chain/guardian-registry.ts` holds them per network: `lib/remote-config/runtime` gives it the accepted document's list on every publish, and the document's list REPLACES the bundled `GUARDIAN_OPTIONS`, so a document can remove an operator. `GUARDIAN_OPTIONS` is the fallback only: a network with no accepted document yet (a first start that cannot reach the config repo, a read before the realm hydrated), a document with no `guardians` section, and localnet. So never read `GUARDIAN_OPTIONS` outside the registry: read `getNetworkGuardians` (or `getBuiltInGuardianOptionsForNetwork`, `getGuardianOptionsForNetwork`, `getGuardianEndpointsForNetwork` in `lib/miden-chain/constants`), and in a picker `useGuardianOptions()`, which re-renders when a document changes the list. The registry is a leaf on purpose: `effective-endpoints` reads it and the runtime imports `effective-endpoints`. A path that runs without a user action and treats the list as evidence (`probeBuiltInOperators` for drift reconciliation, `recoverGuardianHistory`) first awaits `initBridgeConfig()`. The list is the wallet's own configuration for every trust decision that the compiled list had (drift reconciliation's second source, history recovery, the native HTTP routing in `guardian/native-http`), and the document is not signed: whoever can merge to the config repo can name an operator. An account keeps its own `guardianEndpoint`, so an operator a document removes still serves the accounts on it; it only loses its name and logo (`guardianOptionForEndpoint` shows the host). The logo of an operator is bundled and keyed by `id` (`GUARDIAN_LOGOS`). Its description is the entry's optional `about` (onboarding's sentence) and `kind` (the provider sheet's line): plain English strings, shown as written in every language, never translated. Without them `useGuardianOperatorText` shows the bundled, translated copy for the id (`GUARDIAN_OPERATOR_COPY`), else `operatedBy`. The parse rules in `lib/remote-config/schema.ts` (`readGuardians`) and in the config repo's `scripts/validate.mjs` must agree. A release that changes the published list copies it into `GUARDIAN_OPTIONS`. Accepted limits: no version floor guards the bundled list, so a new wallet, or one after Developer Settings' reset, that cannot reach the config repo shows the bundled operators, including one a document removed; and a recovery that starts before the first fetch of a new install lands probes the bundled list.

### Explore catalog
Explore's items and sections come from `0xMiden/wallet-explore` (`<network>.json`, icons under `icons/`) through `lib/explore-config`, never from compiled-in entries. `useExploreCatalog()` returns the newest accepted stored copy when it is newer than the bundled snapshot in `lib/explore-config/snapshot/` (byte copies of the published files: a release that ships a changed document copies the published file over the bundled one), else that snapshot when it is at or above the network's floor, else nothing (null), so no fetch can empty Explore and no reset can bring back a delisted app. A floor that storage cannot give reads as 0, so a storage failure shows the bundled snapshot rather than nothing. The bundled snapshot is shown only once the network's floor has been read: for that one storage read the hook returns undefined (pending) and the launcher draws neither sections nor its empty state. The bundled snapshot draws the icons the build ships (`BUNDLED_EXPLORE_ICONS`, the PNGs in `app/misc/dapp-icons/`); a fetched copy's icons come from the repo. A document's text is literal per locale and read through `localizedText`, never an i18n key; the category chips, the section kinds, Recents (always last) and search stay in `lib/dapp-browser/explore-catalog.ts`, where `getExploreCatalog` keeps the exchange gate. E2E builds read the document from `MIDEN_EXPLORE_CONFIG_URL` (honoured only under `MIDEN_E2E_TEST`). `yarn check:published-snapshots`, and a job on every release, compare each bundled snapshot (token list and Explore) with its published file. The extension shows the same launcher and opens every pick in a new browser tab (`openUrlInNewTab`, so the page gets no `opener`); `DappBrowserProvider` is mounted only on mobile, so nothing on the extension path may call `useDappBrowser` (`BrowserScreen` branches before it).

## Frontend UI, CSS, and Motion

Read `skills/miden-wallet-frontend/SKILL.md` before implementing or reviewing wallet UI, CSS, motion, layout, or interaction changes. Reuse existing wallet components and semantic theme tokens before adding primitives or literal styles. Keep component-specific animation out of `src/main.css`; route nontrivial motion through Framer Motion and the reduced-motion-aware spring helpers. Interactive UI must use accessible semantics, appropriate haptics, localization, and platform isolation, then be verified on every affected surface.

### Shared components and layouts, not page-local styling

A page supplies content; the design system supplies everything else. Before styling anything, look for the component that already does it — a page-local copy of a frame, row, field, error line, empty state or icon circle is a defect, not a shortcut, and the fix is to extend the shared component (a prop, a variant) rather than fork it. The same goes for the frame itself: pushed pages take `SubPageLayout`, flow steps take `FlowLayout` + `FlowFooter`, and the home-group panes share one shell, so titles, gutters, section gaps and pinned actions land in the same place on every screen. Spacing, type and colour come from the named styles and tokens; a literal padding or hex in a page means the token is missing, so add it. When two pages disagree, one of them is wrong — decide which and move both, instead of leaving a third variant behind.

### Mobile file downloads
`<a download>` does nothing in WebView. Use `Filesystem.writeFile` + `Share.share` from `@capacitor/{filesystem,share}` when `isMobile()`.

### Balance loading
`fetchBalances` reads the account from IndexedDB via `getAccount()` under the WASM lock and never syncs; don't call `syncState()` from the UI path. Sync is separate: on mobile and desktop `useSyncTrigger` runs it every 3 s (in-process, under the lock, with backoff and the sync fuse); on the extension the service worker's lap writes `miden_sync_data`, which the popup turns into balances (`updateBalancesFromSyncData`). A refresh takes the lock with a non-blocking try and skips when it is busy, so it never stalls behind a write. Every reader (the Ready-time read in `syncFromBackend`, the `useAllBalances` poll) goes through the store's `fetchBalances` action, the one implementation of a balance read. It passes `waitForLock: balances[address] === undefined`, so a read with nothing on screen queues FIFO: after an import the sync and note reads keep the queue full and a skipping read starves (#1123). It holds `fetchingAddresses`, one read in flight per address, publishes fetched metadata through `setAssetsMetadata`, and stores whatever lands whether or not the component that asked is still mounted. Every await it makes while holding the address is bounded (the metadata lookup is raced against one RPC timeout). Only a landed read ends `balancesLoading`; a failed or fused first read leaves Home on its skeleton. `clearStorage` resets the native-asset cache on every create or import and primes its rediscovery at once, because `fetchBalances` awaits the native faucet id before it returns.

### Token metadata: faucet record vs. user override
`AssetMetadata` mirrors the faucet's on-chain `TokenMetadata` slots (`symbol`, `name`, `decimals`, `description`). `fetchChainTokenMetadata` reads them from `BasicFungibleFaucetComponent` and caches the record under `tokens_base_metadata`; a schema marker (`tokens_base_metadata_schema`, `metadata/storage.ts`) wipes that cache once when the record shape changes. A PRIVATE faucet has no readable storage, so its token lands as the Unknown placeholder (`scaleIsUnknown: true`, quantity withheld). That is what the user-editable override is for: "Edit token details" on the token page stores the user's `name`, `symbol` and `decimals` under `tokens_metadata_overrides` (`metadata/overrides.ts`), and a set `decimals` marks the scale as known. Overrides are applied ON READ (`setAssetsMetadata`, `getTokensBaseMetadata`, `fetchBalances`, `updateBalancesFromSyncData`) and never merged into the cached chain record, so a re-fetch or the schema wipe cannot clobber them. A faucet is never overridable when it is the native asset or a token the wallet names itself on the effective network (`midenTokenLabelFor`: Test iETH, and Test Epoch USDC once the bridge config names it), as `canOverrideMetadata` decides: its edit action is hidden, a write is refused, a stored override is ignored on read, and the assets provider re-applies the overrides when the bridge config changes which overridden faucets those are. Send converts typed amounts with the effective `decimals`, so a wrong override changes what is sent, not only what is shown.

## Adding a wallet action

1. Message type in `src/lib/shared/types.ts`
2. Handler in `src/lib/miden/back/actions.ts`, register in `back/main.ts`
3. Store action in `src/lib/store/index.ts`
4. Expose via `useMidenContext()` in `src/lib/miden/front/client.ts`

## Transaction summary badge (Generating Transaction screen)

The in-progress transaction view (`src/screens/generating-transaction/GeneratingTransaction.tsx`) renders a dynamic one-line summary pill under the title — `src/screens/generating-transaction/TransactionSummaryBadge.tsx`.

**The page is addressed by transaction id and observes a single row.** The route is `/generating-transaction/:txId` (and `/generating-transaction-full/:txId` for the desktop `keepOpen` variant) - see `PageRouter.tsx`. Send (`ReviewTransaction.tsx`) and swap (`SwapManager.tsx`) capture the id returned synchronously by their `initiate*` call and `navigate` straight to it. `GeneratingTransactionPage` subscribes to **that one row** by id via `useTransactionRow(txId)` (a Dexie `liveQuery`, `useTransactionRow.ts`) and derives everything from its status: `transactionComplete = status is Completed|Failed|Unconfirmed`, `hasErrors = status is Failed|Unconfirmed`, hash = `row.transactionId`. An unknown id `<Redirect>`s home.

**Why this shape (history).** The page began as a modal that watched the *whole queue* (`getAllUncompletedTransactions()`) and had to *guess* which tx it was showing (`pickActiveTx`), infer completion from the queue going empty, and infer failure by counting failed rows. Those heuristics existed only because the row **drops out of the uncompleted list the instant it completes** - so the page needed shadow state (`receiptTransaction`) to re-find it. Watching by id fixes the root cause: the row never disappears (`Queued → GeneratingTransaction → Completed | Failed | Unconfirmed`, and an Unconfirmed row later becomes Completed or Failed), so status alone is authoritative and all that scaffolding is gone. The FIFO processing loop (`safeGenerateTransactionsLoop` in `src/lib/miden/transaction/index.ts`) and the page's own `setInterval` driver are **unchanged** - the page still kicks the loop on mobile/desktop and is a pure observer on extension (SW owns the loop). Observing one row and draining the FIFO queue are orthogonal: the driver is not scoped to `txId`. Hiding the page mid-tx is safe because the in-flight `generateTransaction` promise isn't cancelled by unmount.

**`send`, `swap`, `consume` and `earn-deposit` variants exist**: send renders `{amount} {symbol} → {recipient}`; swap renders `(logo) {amount} {name} → (logo) {amount} {name}`, each side named by its display name (`midenTokenLabel`, so testnet IETH reads "Test iETH"); consume renders `{amount} {symbol} → Accepted` (nothing when the consume has no amount), except an Arcade GC purchase (`extraInputs.gcPurchase`), which renders `{pay} USDCx → {gc} GC` from the row's own quote at the sale's fixed 6-decimal scales, and whose `consumeAssetBreakdown` entry (the receipt's amount) is likewise `{gc} GC`, since a wallet buying its first GC has no metadata for the faucet and read "Unknown"; earn-deposit renders `{amount} {symbol} ↑ {market}` (up-arrow separator; market name via the exported `earnMarketLabel(bridgeConfig, marketUid)`, which the history Market rows and `EarnSuccess` share, each rendered `truncate` so a long label clips: the `name` of the document's `earn.vaults` entry for that market, as written, else, for a market the document does not list, the lender family's display name plus what the `marketUid` lender key adds, a Morpho market id shortened - "Aave V3", "Compound V3 USDC", "Morpho d752…6e41d", "Dummy Lending"; an unknown key hyphenated). The badge returns `null` for every other transaction type. Future agents should extend it per type. On the success receipt (`success/receipt.ts`), consume rows relabel: address row = "From" (note sender), amount row = "Total Accepted", plus a "Transfer IDs" row listing `noteIds`; the hash row is labeled "Transaction ID" for all types. Completed `earn-deposit` rows route to `EarnSuccess` ("You're Earning!": pill + Market / Total Deposited / Transaction ID rows, "View Details" → `/earn/positions`) via the type check in `TransactionSuccess.tsx`.

**Data source**: the tracked `ITransaction`, passed in as the `activeTransaction` prop (= the row from `useTransactionRow`). Fields populated per `ITransactionType` (see the `Transaction` subclasses in `src/lib/miden/db/types.ts`):
- `send` → `amount`, `faucetId` (token), `secondaryAccountId` = **recipient address**.
- `swap` → `amount`/`faucetId` = **offered** side; `extraInputs.requestedAmount`/`extraInputs.requestedFaucetId` = **requested** side. Symbol/decimals/logo for the DEX tokens resolve via `getSwapTokenByFaucetId` in `src/lib/miden/swap/tokens.ts` (the swap-token registry — source of truth, since these faucets may be absent from `assetsMetadata`); the registry is the solver's Pairs API (see Remote bridge config), so a row whose faucet the solver no longer lists falls back to the metadata path.
- `consume` (claim) → `faucetId`, `secondaryAccountId` = **note sender**, `noteId`; `amount` optional.
- `execute` → usually nothing useful.
- `switch-guardian` → `extraInputs.newGuardianEndpoint`. `replace-hot-key` → `extraInputs.newHotPublicKey`. Neither has amount/token.

**Token symbol/logo**: `useWalletStore(s => s.assetsMetadata)[faucetId]` → `AssetMetadata` (`symbol`, `name`, `decimals`, an optional `description`, and two scale flags: `decimals` is a guess while `scaleIsUnknown` is set, so convert an amount only when `hasKnownScale` holds and otherwise name the token and withhold the quantity, and `scaleFromOverride` marks decimals the user stated); resolve a faucet with `resolveDisplayMetadata(faucetId, assetsMetadata, nativeFaucetId)` (`lib/miden/metadata/resolve`), which gives the native display metadata only for the native faucet and the unknown-scale placeholder for any other missing faucet, then check `hasKnownScale`. A token's mark comes from `TokenLogo` (`components/TokenLogo`), keyed only by its Miden faucet id through the verified token list (`useTokenLogoUri`), never by symbol (any faucet can take any symbol) and not from the metadata. `faucetId` is a required `string | undefined` prop: every caller passes the faucet the token is or arrives in (a bridge source token passes its delivery faucet, an Earn asset the native USDCx), and `undefined` (a faucet that does not exist yet, such as an ERC-20 the bridge has never carried) draws the default mark, as does a faucet the list does not name. Miden network logo: `IconName.MidenLogo`. To add a variant, add a branch in `TransactionSummaryBadge`; keep returning `null` when there's no meaningful summary so no empty pill renders.

**Per-step timing ("2 sec" on each step row) comes from persisted stage stamps.** `setTransactionStage` records the first entry into each stage in `ITransaction.stageTimestamps` (first-entry-wins within an attempt; a requeue clears the map), and a Completed write adds the synthetic `complete` stamp. A stamp replayed from the extension's offscreen realm is timing-only: it lands in the stamps without moving `stage`. `GeneratingTransaction` picks its step set with `stepsForFlow` (`constants.ts`: standard, Guardian, the direct switch, or a Guardian row that waits for its commit to relay a private note, whose commit wait and relay are a "Delivering to recipient" step after "Syncing with Guardian", #1492; the standard set's last step owns that wait and relay). That row is `waitsToDeliverNote` (`helper.ts`): a private send, a row of any type but the three rotations stamped `confirming` or `delivering` (`completeSendTransaction` and `completeCustomTransaction` stamp them, each in its own try so a failed stamp never skips the wait or the relay), or one whose delivery is recorded `pending` or `relayed`, so the choice does not hang on the best-effort delivery record. `getStepDurationsMs` times each step from its `startStage` stamp (else its `fallbackStartStage`) to the next step's start, the last one to `complete`; a missing boundary renders no duration rather than 0. Durations render via the `meta` prop on `TransactionStepRow` (right-aligned muted text, `transactionStepDurationSec` key) on completed steps only. Which step is active comes from `getActiveStepIndex` over each step's `activeStages`. Never time a step from live `stage` observation: a Dexie `liveQuery` coalesces rapid stage writes.

**Deferred — NOT built yet (the mock shows these, intentionally skipped):**
- **Bridge step labels** ("Submitting to Base", "via Epoch"). The in-protocol token→token swap badge is **now built** (see the `swap` bullet above), but the bridge-specific step labels are still deferred — there's no backend producer for bridged `extraInputs` and no chain-id→name map. `IBridgedSendExtraInputs`/`IBridgeProvider` are defined in `src/lib/miden/db/types.ts` but nothing populates them yet.

The redesigned in-progress view dropped the `ScreenHeader` and the linear progress bar; dismissal is via the bottom Hide/Done button.

## Navigation

Two systems:
- **Woozie** (`src/lib/woozie/`) — hash-based global router. `navigate`, `goBack`, `useLocation`, `<Link>`.
- **Navigator** (`src/components/Navigator.tsx`) — internal step flows (`SendManager`, `SwapManager`, `EncryptedFileManager`). `useNavigator()` → `{navigateTo, goBack, cardStack}`. The swap flow (`src/screens/swap-flow/`) mirrors send: amounts (two `SelectAmount` in `embedded` mode) → review, rendered at `/swap` in both `PageRouter` and `HomeSwipeContainer`; the token picker is a bottom-sheet drawer (`SelectSwapTokenDrawer`, like send's `SelectTokenDrawer`) closed first by SwapManager's mobile back handler.

Onboarding (`Welcome.tsx`) and `ForgotPassword.tsx` use hash-based state (`/#step-name`), NOT Navigator.

**Tab panes stay mounted.** `TabLayout` keeps every visited tab (home carousel, Explore, Activity) mounted in a `TabPane` and swaps them with `visibility` + `inert`, no animation, like a native tab controller. Consequences: a hidden tab page keeps running its effects and polls, and any hook that reads the route from inside a tab page must gate on `pathname` (see `SendManager`'s `onSendRoute`), because the page is still mounted while another tab is active. Hiding the navbar needs no such gate: `useHideNavbarWhileOpen` releases its hold while `usePageActive()` is false, so a caller passes only its own open state.

Work a page does only for display (a poll, a reconciliation) pauses through `usePageActive()` (`app/layouts/page-active.ts`), which is false in a hidden `TabPane`, in a `PageLayer` that is not the current page, and in a Home page `HomeSwipeContainer` has not centred; `History` uses it: an SWR read gated this way holds a null key, never `isPaused`, because SWR sends a shared key's mutate and error retry to its first subscriber, and a paused one swallows them. The dApp browser mounts `DappActive` only while its page is on screen, because that unmount is what parks the foreground dApp and hides its native window.

**Slide pages stack on top of the page beneath.** `MobilePageLayers` keeps the covered layer mounted (inert, at -24% with a dim) for as long as a slide `FullScreenPage` is above it, and a pop re-enters that same layer through `AnimatePresence` - no remount, no fade, scroll and state intact. The layer is released only when the page above is not a slide page, or under reduced motion; a webview return keeps it and only makes the motion instant. Do not add per-mount work to a tab page on the assumption that back navigation remounts it.

Whether a navigation goes back is read from the router: a pop, or a navigation to a page in the stack beneath whose layer is still mounted (a close), reveals that page and slides the slide page out, and the page a return leaves is never kept covered. A page kept mounted outside the stack (one a return skipped over, or one a Replace left) is revealed by a router pop but reopened as a new layer by a push, and a page a push reopens always gets a new layer with fresh state. A push from a slide page to a plain page plays no Back animation; it releases the stack, so a later Back remounts the slide page, which then fades in instead of sliding in like a push (a page a slide page's Back reveals plays no entrance of its own).

The in-progress transaction view is a routed full-screen page at `/generating-transaction/:txId` (desktop `keepOpen` variant: `/generating-transaction-full/:txId`). Send and swap `navigate` here with the id path param after initiating; it observes that one row to completion (see the Transaction summary badge section). `onClose` guards on `hash.includes('generating-transaction')`, so the substring must stay in any future route rename.

Send flow: only recipient → amount remain Navigator steps inside `/send`; the token and contact pickers are fixed-height bottom-sheet drawers (`SelectTokenDrawer`, `AccountsListDrawer`) closed first by SendManager's mobile back handler; the review step is a routed full-screen page (`/send/review?amount=…&to=…&tokenId=…`, `ReviewTransaction.tsx`) that owns the transaction pipeline. Backing out restores the form via `send-flow/send-draft.ts` (SendManager reopens on the Amount step). Hardware back on review is covered by `MobileBackBridge` (history pop). On review, a same-chain send's transfer type (private, the default, or public) and expiration sit under one `DetailDisclosure` row ("Advanced options", collapsed by default, its summary naming both); the "Transfer type" row opens `TransferTypeDrawer` and "Expires" opens `RecallCalendarDrawer`, both on the shared `Drawer`'s own back handling. A public choice shows a warning `Notice` under the card and relabels the CTA "Send publicly", both independent of whether the row is open.

Back handlers (`src/app/env.ts`): `registerBackHandler` is stack-based. `PageLayout` registers a default that calls `goBack()` if `historyPosition > 0` else navigates home. Mobile hardware/swipe back requires `@capacitor/app` + explicit handlers — must be registered for global nav (`MobileBackBridge`), Navigator flows, state-based flows, and modals. A handler for UI rendered outside the routed page's React tree (app-level dialogs and gates, provider modals) passes `{ overlay: true }` to `useMobileBackHandler`: overlays run before every page handler, whenever the page last registered. Every sheet on the shared `Drawer` (`lib/ui/drawer`) closes itself on mobile back in that overlay tier while open, and `Popover` does the same through `useCloseOnBack`; a sheet its host's page handler closes (SendManager's and SwapManager's pickers, the swap flow's spending-limit challenge) passes `closeOnBack={false}` to the Drawer and stays in the page tier, closed by that page's own handler.

When adding screens/routes, keep this section accurate so mobile back stays correct.

## Mobile testing

### Skip onboarding
```bash
node /tmp/cdp-eval 'window.__TEST_SKIP_ONBOARDING = true; window.location.reload()'
```
Bypass lives in `Welcome.tsx`, only active when flag/query param set.

### iOS debugging
`console.log` goes to Safari Web Inspector — Claude cannot read it. Use:
```bash
xcrun simctl spawn booted log stream --predicate 'process == "App"'
```
For live DOM/JS eval: use the CDP bridge via `inspect` + persistent-connection daemon (`/tmp/cdp-daemon.mjs` + `/tmp/cdp-eval`). Bringup recipe in `~/.claude/projects/-Users-celrisen-miden-miden-wallet/memory/cdp-bridge-single-use-bug.md`. Key steps: kill bridges, reset `com.apple.webinspectord`, relaunch app, start `inspect`, start daemon, smoke-test with `node /tmp/cdp-eval '1+1'`.

### Verifying UI fixes
Always screenshot to verify:
```bash
xcrun simctl io booted screenshot /tmp/shot.png
xcrun simctl spawn booted notifyutil -p com.apple.BiometricKit_Sim.fingerTouch.match  # FaceID
```

### Common iOS layout issues
- Grey bar at bottom → `100dvh` doesn't account for safe areas. Use `100%` + `env(safe-area-inset-*)` padding on `mobile.html` body.
- Debug UI text should be `select-text` so errors are copyable.

### Adding Swift files to the App target
The App target in `ios/App/App.xcodeproj/project.pbxproj` does NOT auto-discover Swift files in the `App/` source directory. New files must be registered in four sections: `PBXBuildFile`, `PBXFileReference`, the App `PBXGroup` children, and the `PBXSourcesBuildPhase` files list. Pattern: see `LocalBiometricPlugin.swift` or `HotKeyPlugin.swift` entries.

### Adding a custom Capacitor plugin (iOS)
Capacitor on this app uses **manual** registration — not the `CAPBridgedPlugin` auto-discovery you'd get on a stock Capacitor app. After creating `MyPlugin.swift` and wiring it into the four pbxproj sections above, you also have to call `bridge?.registerPluginInstance(MyPlugin())` inside `capacitorDidLoad()` in `ios/App/App/AppViewController.swift`. Skip this step and JS calls land as `{"code":"UNIMPLEMENTED"}` even though the class compiled fine.

### Persistent wallet navigation
Extension, Capacitor, and Tauri render the same React `BottomNav` from `TabLayout`. `TabLayout` owns destinations, active route state, route changes, haptics, and the `[data-tabbar-footer]` shell; `BottomNav` owns button semantics and presentation. Drawers hide it through `useHideNavbarWhileOpen`, which drives the body data attribute consumed by `src/main.css`. On Capacitor, `public/mobile.html` owns body safe-area padding and `src/main.css` paints the footer strip. The bar is a floating glass capsule on every platform: its footer stays on the layout's bottom edge, which on Capacitor is the top of the body's safe-area padding, so the capsule sits directly on the safe-area edge on iOS and 8px above the system navigation bar on Android. `src/main.css` declares the flow CTAs' cushion (`--navbar-cushion`) only on `TabLayout`'s root (`data-tab-layout`), so only a page inside the layout that draws the bar reserves room for it; a slide page beside the covered tab layer keeps the flat 1rem (#1109). `DappBrowserProvider` owns embedded dApp WebViews, not wallet navigation; the native navbar API under `packages/dapp-browser` has no wallet frontend caller.

### Adding Capacitor plugins
`yarn add @capacitor/<name> && yarn mobile:sync`. Add ProGuard rules to `android/app/proguard-rules.pro`:
```
-keep class com.capacitorjs.plugins.<name>.** { *; }
```
Remove rules when uninstalling.

## Desktop (Tauri)

- `src-tauri/src/{main,dapp_browser,lib}.rs`, `scripts/dapp-injection.js`
- Clear state: `rm -rf ~/Library/WebKit/{com.miden.wallet,miden-wallet}`
- dApp flow: inject encodes base64 request (carrying the per-window bridge token) → navigate `https://miden-wallet-request/{payload}` → Tauri `on_navigation` intercepts, checks the token, strips it → event to main window → `DesktopDappHandler` handles it, `DesktopDappConfirmationModal` prompts **in the wallet window** → response back to the page via the `dapp_wallet_response` command.
- Every app-defined Tauri command is ACL-gated (`src-tauri/permissions/app.toml` + `capabilities/default.json`, `"windows": ["main"]`) and refuses a non-`main` webview (`src-tauri/src/ipc_guard.rs`). Adding a command means adding it to BOTH `generate_handler!` and `permissions/app.toml`, plus the guard — the dApp-browser window loads arbitrary sites with `withGlobalTauri: true`.

## E2E

### Chrome blockchain harness
Two Chrome instances + `miden-client` CLI against live network. `E2E_NETWORK` controls both harness endpoints AND `MIDEN_NETWORK` baked into the bundle — use the `:<network>` scripts to keep them matched. Auto-installs `miden-client-cli` from crates.io, version-matched to `@miden-sdk/miden-sdk`. Requires `cargo`. Specs: `wallet-lifecycle`, `mint-and-balance`, `send-{public,private}`, `multi-{claim,account}` in `playwright/e2e/tests/`.

**Agentic mode** (`E2E_AGENTIC=true` or `yarn test:e2e:blockchain:agentic`): on failure, browsers stay open 10 min; `test-results/debug-session.json` has connection info; `report.json` has `failureCategory`, `diagnosticHints`, `stateAtFailure`, `browserErrors`. Hot-reload via `chrome.runtime.reload()` preserves IndexedDB/vault.

### iOS simulator harness
Mirror suite in `playwright/e2e/ios/` against iPhone 17 + iPhone 17 Pro. CDP via `appium-remote-debugger` (simulator-compatible, unlike `remotedebug-ios-webkit-adapter`) over `RWI_LISTEN_SOCKET`. Per-test: terminate/uninstall/install/launch (~5s vs 30s for `simctl erase`). 7/7 specs pass on devnet in ~9 min.

iOS-specific product notes:
- Wallet tabs and page CTAs such as "Claim All" and "Continue" render in the React WebView. Drive them through normal CDP/DOM interactions and verify the rendered state; there is no native-navbar action hook.
- No `SYNC_REQUEST` on mobile (SW-only); `useSyncTrigger` auto-syncs every 3s, so sleep suffices.
- No mobile reload trick — mobile `claimAllNotes` skips the `location.reload()` Chrome does (mobile has no SW holding the unlock, so reload drops decryption key).
- Don't read WASM client from CDP — deadlocks against `useSyncTrigger`'s 30–60s lock hold.

### E2E test hooks
`MIDEN_E2E_TEST=true` exposes `window.__TEST_STORE__` (Zustand) and `window.__TEST_INTERCOM__`. Zero production impact.

**Keep it a hook flag, not a behaviour switch.** Suppressing real product behaviour under `MIDEN_E2E_TEST` makes that behaviour permanently untestable — it can't be reached from any E2E run. The two existing opt-outs have their own flags, set by the `test:e2e:*:build` scripts (and defined in each `vite.*.config.ts` — an env read with no matching `define` is rewritten to `{}.X`, i.e. silently `undefined`, so a flag missing from one config is off in that bundle with no error at all):
- `MIDEN_E2E_DISABLE_SIDEPANEL` — keeps onboarding in-tab (`lib/extension/side-panel-handoff.ts`); a suite that wants to drive the real side panel builds without it.
- `MIDEN_E2E_DISABLE_ENDPOINT_OVERRIDES` — makes `loadEndpointOverrides()` a no-op so the build-baked network wins (`lib/miden-chain/effective-endpoints.ts`).
  `test:e2e:blockchain:build` sets it unless the variable says otherwise; only `test:e2e:stored-override:build` turns it off, for the specs in `playwright/e2e/tests/stored-override/`, which Local E2E runs after its core specs. They store an override through Developer Settings with an RPC URL that opens another SDK store than the build default's, and `assertWalletRunsOnStoredOverride` (`harness/extension-network.ts`) refuses a run whose wallet ignored it (#1485).

## Testing

Jest + RTL. Mock `lib/intercom` for frontend tests; wrap with `WalletStoreProvider` + `MidenContextProvider`.

Gotchas:
- `jest.mock()` path must match the import path used in source (e.g., `'lib/miden/back/vault'`, not `'./vault'`).
- `window.location.reload` can't be mocked in jsdom — wrap calls in try/catch.
- `afterEach(() => testRoot.unmount())` to prevent React cross-test pollution.

## Code style

Prettier: 120 cols, single quotes, semicolons, trailing commas. Break long `console.log`s across lines. `yarn format` to fix.

No `any`, no `as`. Use concrete types.

## Linked Web SDK PR (cross-repo CI)

**ALWAYS use the `Web SDK PR: #N` marker when opening a wallet PR that
depends on an unpublished web-sdk change.** This is the load-bearing
machine-readable handle — prose like "Companion PR: web-sdk#N" or
"depends on …" does NOT trigger the linked-PR pipeline. Put the marker
on its own line in the PR description (top is fine, anywhere is fine).
When in doubt include both forms (`Web SDK PR: #N` and a prose mention)
but the marker has to be present verbatim.

The wallet's CI can be pointed at an unpublished `@miden-sdk/miden-sdk`
or `@miden-sdk/react` branch by including a marker in the wallet PR's
description:

```
Web SDK PR: #134
```

Or cross-repo:

```
Web SDK PR: 0xMiden/web-sdk#134
```

When the marker is present, every yarn-using job in `.github/workflows/pr.yml`
runs `.github/actions/inject-linked-web-sdk-pr` BEFORE its `yarn install`
step. The action clones the linked web-sdk PR, builds
`@miden-sdk/miden-sdk` + `@miden-sdk/react` from source, and rewrites
this repo's `package.json` to consume them via `file:` deps (runner-local
mutation, never committed).

A `workflow_dispatch` on a pull request's branch injects too: this action and
`inject-linked-guardian-pr` read the markers of the one open pull request whose
head is that branch (`scripts/resolve-linked-pr-number.sh`), and every E2E and
build workflow a dispatch can start runs both before its install, so a by-hand
run builds what that pull request's own CI builds. A push, and a dispatch on
main or next, never injects.

A separate workflow (`check-linked-web-sdk-pr.yml`) posts a custom
status named `linked-web-sdk-pr-ready` that's `pending` until the linked
web-sdk PR is merged AND a release tag covering its merge commit is
visible. Branch protection on `main` should require this status before
allowing the wallet PR to merge — that's the gate that prevents the
wallet from landing while it depends on an unpublished web-sdk change.

Local-dev parity:

```bash
scripts/dev-with-web-sdk-pr.sh             # auto-detect from current PR body
scripts/dev-with-web-sdk-pr.sh 134         # use web-sdk#134
scripts/dev-with-web-sdk-pr.sh --clear     # restore the published versions
```

The `lefthook.yml` pre-commit hooks block committing the patched state
(state file `.linked-web-sdk-pr.json` or `file:` SDK deps in
package.json). Lefthook isn't auto-installed by `yarn install` — opt in
once with `pnpm dlx lefthook install` if you want the guard.

Mirrors web-sdk's `Client PR: #N` pattern (`.github/actions/inject-linked-client-pr`).

## CI gotcha: a push to `main` does not always create its workflow runs

Seen 2026-08-14: merge commit `9b84c493b` landed on `main` and GitHub created
**no** push-triggered runs for it — 25 minutes later the commit had a single
check suite (the half-hourly `Linked web-sdk PR ready` cron) and nothing else.
Actions was healthy throughout (another branch got a full set of runs in the same
window), and none of these workflows use path filters — they are all a bare
`on: push: branches: [main]`.

This is worse than a red main: the branch *looks* fine because the newest runs
listed against it are the PREVIOUS commit's.

- **Check by SHA, not by branch.** `gh run list --branch main` answers "the most
  recent run per workflow on this branch", which silently reports a different
  commit. Use:
  `gh api "repos/0xMiden/wallet/actions/runs?head_sha=$(git rev-parse origin/main)"`
  and confirm `total_count` is non-zero.
- **Re-trigger without a new commit** where the workflow allows it:
  `gh workflow run <file>.yml --repo 0xMiden/wallet --ref main`.
  Dispatchable: `e2e-blockchain`, `e2e-android`, `e2e-bridge`, `e2e-bridge-in`,
  `e2e-resilience`. NOT dispatchable (push-only, so they need a fresh commit):
  `coverage-badge` (Badges), Build Production, CodeQL.
- **The E2E suites no longer run on push at all** (#1714): Release E2E
  (`release-e2e.yml`) dispatches the testnet suites nightly and per release, and
  Next E2E (devnet) dispatches next's `e2e-blockchain.yml`. Re-run the set with
  `gh workflow run release-e2e.yml --repo 0xMiden/wallet --ref main -f ref=main`.

## Important Notes

- Commit messages: single-line, short. Never sign commits (no `Co-Authored-By`).
- Never `git push` without explicit request.
- Stay within requested scope — don't modify files beyond the task.
- Update `CHANGELOG.md` one-liner per PR/task (not per fix).
- When adding a new intercom message type, also update `src/lib/intercom/in-process-request-handler.ts` (the one switch both the mobile and desktop adapters dispatch through).
- Optimistic updates: snapshot prev, apply, rollback on catch.
- Background auto-ops: use `startBackgroundTransactionProcessing` (polls 5s × 5min, no modal) instead of `openLoadingFullPage`.
- Transaction states (`ITransactionStatus`): Queued(0) → GeneratingTransaction(1) → Completed(2) / Failed(3) / Unconfirmed(4). Unconfirmed waits for the node's verdict on an unknown submit outcome, then becomes Completed or Failed (#1081).
- Frontend receives sanitized state via `toFront()`; sensitive data (vault, keys) stays backend-only.

## USDCx destination confirmation

Keep `Burn confirmed` when the faucet consumes the burn note. Show `Confirmed` only on
Circle's exact payout mint: a GatewayMinter `AttestationUsed` log on the destination
chain whose transaction input carries the burn note id, for the row's token and
recipient, from the minter and depositor the Arc xReserve reports, after the block
saved before submission, with a value from 1 up to the sent amount. Received is that
value and the Circle fee is the sent amount minus it. Scan at most 5 chunks of 10,000
blocks per check, and rescan the last 128 blocks on every check (the cursor never moves
back); a scan the chunk cap stopped below the head is due again at once. A failure
before any chunk completes (the source read, the block number) leaves the row and its
cursor unchanged; a chunk failing mid-scan resumes after the last chunk read in full.

A confirmed row not paid 2 hours after confirmation reads `Payout delayed`, for rows
the wallet can scan only (not restored, snapshot saved). The review shows one line,
`Circle fee`: deducted from the payout, varies with network fees. The allowances
(`lib/usdcx/constant.ts`; 0.1 USDC, 1.5 USDC on Ethereum) are only the Send flow's
refusal guard: it refuses a burn that does not exceed them. Rows confirmed earlier by
the balance rule stay `Confirmed`. Restored rows and rows without a snapshot stay at
`Burn confirmed`.

The history link is the recorded mint. Only those legacy rows use the old best-effort
transfer search (one `eth_getLogs` over at most 2,000 blocks, 10-second timeout, no
retries, only when the details are open); omit its link unless one match is unique.

Accepted limits: a fee above the attester's operator ceiling leaves a burn unpaid and
it reads `Payout delayed`; a mint transaction carrying two payouts to the recipient is
skipped, so a batched payout reads `Payout delayed` too; pruned RPC history can leave an
old row unscanned; Circle can be slow. Reviewer agents must treat these as known limits, not blocking defects.

Game Coin sale discovery keeps one endpoint/config-scoped scan, with separate bounded historical and newer-block continuations. Each call reads at most eight note bodies, revalidates its remembered live sale first, and shares concurrent same-scope discovery. Scope changes invalidate pending results.

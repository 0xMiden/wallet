# Multi-threaded WASM proving on mobile (iOS WKWebView + Android WebView)

**Branch**: `wiktor/mt-wasm-mobile`, based on `wiktor/mt-wasm-offscreen` (PR #230).

**Why this branch base**: PR #230 is the desktop-extension MT-wiring (offscreen page, speculative pre-prove, `withWasmClientLock` discipline). Mobile MT needs the same SDK entry + prove-path discipline; building on top means we don't fork them.

## Goal

Enable `wasm-bindgen-rayon`-driven multi-threaded local proving in the
Miden Wallet's mobile builds (Capacitor iOS + Android), so that mobile
users can do **local proves** on-device instead of always delegating to
the remote prover. Headline metric: time-to-claim a typical note drops
~2-3× vs single-threaded local prove (when local prove is selected) on
modern Android phones; iOS WKWebView TBD pending an empirical-
constraint check.

**Non-goals**:
- Removing the remote prover fallback. Mobile should still be able to
  delegate; this is about making local prove a viable alternative
  where the device can handle it.
- Web Worker–parallel _anything_ outside the prover (e.g. parallel
  Merkle tree walks in the UI). Out of scope.

## Current state (today, on `next`)

Documented in detail in the answer-thread that led to this branch; key
facts re-stated here so the doc stands alone:

1. **Mobile imports `@miden-sdk/miden-sdk/lazy` (ST entry).** No MT
   build is included in `dist/mobile/`. See
   `src/lib/miden/sdk/miden-client-interface.ts:17,68`.
2. **Mobile always delegates to the remote prover.**
   `withProverFallback` hard-codes `shouldDelegate = isMobile() ?
   true : delegateTransaction` (`miden-client-interface.ts:272`),
   and the local-prover fallback path is also gated to non-mobile
   only (`:281`). The wallet doesn't run a local prove on mobile
   at all today.
3. **No COOP/COEP plumbing in `capacitor.config.ts`.** The default
   loader serves from `http://localhost`, no headers injected, no
   service worker, no cross-origin-isolated context. `SharedArrayBuffer`
   is unavailable, so `wasm-bindgen-rayon` couldn't bootstrap even
   if the MT WASM were shipped.
4. **Known iOS-specific limitation (from `memory/mobile-wasm-main-thread.md`)**:
   in earlier wallet generations WKWebView Workers couldn't do gRPC-web
   fetch. We forced WASM onto the main thread on mobile to work around
   that. Important caveat: rayon worker threads don't do gRPC fetches
   themselves — only the main thread does. So this limitation may NOT
   block `wasm-bindgen-rayon` on iOS, but it has never been empirically
   validated under the rayon model.

## Underlying WebView capability

### Android WebView (Chromium)

- `SharedArrayBuffer` available with COOP/COEP since Chrome 92
  (mid-2021). Android WebView tracks Chrome version with a lag but
  current devices (System WebView updated within the last 12 months)
  almost always have ≥ 100.
- Hardware: modern Android phones have 4–8 perf cores. `wasm-bindgen-rayon`
  will pick `navigator.hardwareConcurrency` workers (probably 4 in
  practice — diminishing returns past that).
- **Expected status**: MT WASM should work with COOP/COEP plumbing in
  place. Validate via on-device run before claiming.

### iOS WKWebView

- `SharedArrayBuffer` available in iOS 15.2+ when the page is
  cross-origin-isolated. Older iOS would be a hard floor.
- WKWebView Service Worker support is available since iOS 11.3 with
  caveats; `coi-serviceworker.js`-style reload trick used by the
  wallet's extension is the established pattern.
- The historical "Workers can't do gRPC-web fetch" limitation needs
  empirical re-check under wasm-bindgen-rayon's actual usage pattern:
  - rayon workers do CPU-bound math only
  - all gRPC-web calls go through the main thread
  - if this matches the historic constraint's actual shape (gRPC-from-
    Worker, not Worker-existence), iOS may work fine
- Hardware: A-series CPUs have 6+ cores; rayon should saturate well.

## Engineering plan

### Phase 1 — Empirical de-risk (1-2 days)

Before writing any production code, prove the underlying constraints
on both platforms. Output: a "yes/no/with-caveats" answer for each
platform with concrete numbers.

1. **Android validation**:
   - Modify `vite.mobile.config.ts` to consume `@miden-sdk/miden-sdk/mt`
     instead of `/lazy` (one-line change).
   - Add `coi-serviceworker.js` to `public/mobile.html` so the page
     reloads cross-origin-isolated on Android.
   - Run `yarn mobile:android` on a real device (Pixel 7 or similar).
   - Check: does `crossOriginIsolated === true`? Does the MT WASM
     finish initThreadPool? Does a prove complete?
   - Measure: prove time vs the ST baseline on the same device, same
     trace.

2. **iOS validation**:
   - Same `vite.mobile.config.ts` change + `coi-serviceworker.js`.
   - Run `yarn mobile:ios:run` (iPhone 17 simulator first, then real
     device — simulator approximates ish but Worker behavior can
     differ between simulator + real device).
   - Same checks: `crossOriginIsolated`, `initThreadPool`, end-to-end
     prove.
   - Specifically validate: do rayon worker threads spawn? Do they
     execute computation without trying to do gRPC themselves? Does
     the main thread still own the gRPC-web RPC path?
   - If gRPC-from-Worker is somehow attempted (would surprise me but
     check), document the failure mode and decide whether to fix it
     in the wasm-bindgen-rayon usage or block.

3. **Output**: a short writeup at `tasks/mt-wasm-mobile-phase1-notes.md`
   with the actual numbers. Two cases to be ready for:
   - **Both green**: proceed to Phase 2 directly.
   - **iOS blocked, Android green**: ship Android-only with iOS keeping
     ST + remote delegation. Phase 2 + 3 still apply on Android.
   - **Both blocked**: write a postmortem describing the constraint,
     close this branch. Not the expected outcome but worth naming.

### Phase 2 — Production wiring (2-3 days, gated on Phase 1)

Once Phase 1 says "go," the actual production change is small. The
hard part is plumbing, not crypto.

1. **Build pipeline** (`vite.mobile.config.ts`):
   - Switch SDK entry from `/lazy` (ST) to `/mt` (MT). One-line.
   - Confirm the MT WASM + worker JS land in `dist/mobile/`. Verify
     wasm size budget — MT wasm is larger.

2. **COOP/COEP setup**:
   - **Android**: `coi-serviceworker.js` in `public/mobile.html`
     (proven pattern, same as extension).
   - **iOS**: same approach. If the service worker reload trick is
     unreliable in WKWebView (Phase 1 will tell us), fall back to
     a custom Capacitor server plugin that injects the headers.
     `@capacitor-community/http-server` or similar exists; worst
     case write 20 LoC of Swift/Kotlin to inject headers in the
     respective WebView delegates.

3. **Gate update** (`miden-client-interface.ts:272`):
   - Replace the hard-coded `isMobile() ? true` with feature
     detection: `shouldDelegate = isMobile() && !hasMtSupport()` (or
     reverse the logic to make it explicit). Where `hasMtSupport()`
     checks `crossOriginIsolated && SharedArrayBuffer && hardwareConcurrency >= 2`.
   - On a phone that doesn't have MT support (older iOS, broken
     COOP/COEP), behavior is unchanged: delegate to remote, same
     as today. Safe fallback.

4. **Settings toggle** (optional, but probably useful):
   - Per the existing `Settings → Advanced` pattern, add a
     "Use local prover when available" toggle. Default off (since
     remote is the safe default).
   - When on AND `hasMtSupport()`, prove locally. When off, delegate.
   - Surfaces the choice to advanced users without changing default
     behavior.

5. **Tests**:
   - Existing wallet integration tests on mobile (Playwright/iOS e2e)
     should keep passing. The MT path being enabled doesn't change
     wallet semantics, just performance.
   - Add at least one e2e test that exercises the local-prove path
     specifically (turn the toggle on, do a send/consume, validate
     the prove completed locally not via the remote prover).

### Phase 3 — Validation + rollout (1 day, gated on Phase 2)

1. **On-device perf measurement** on actual phones (not just sim):
   - Compare prove time for a typical send / consume in three configs:
     - Current (always remote)
     - New ST local (no MT) — for the no-COOP/COEP fallback path
     - New MT local — the headline number
   - Document which devices show what number. Phase 1's writeup
     extended with real numbers.

2. **Decide the default**:
   - If MT local is materially faster than remote on most modern
     devices, ship with `local-when-supported` as default.
   - If remote is comparable or faster (server has more cores than
     a phone), ship with remote default + opt-in to local for
     bandwidth-constrained users.
   - This decision belongs at the PR-review boundary, not pre-decided
     here.

3. **Documentation**:
   - Update `CLAUDE.md`'s "Mobile / Screenshots" or a new "Mobile
     proving" section noting:
     - MT WASM is now built into mobile bundle
     - Local prove is available on `hasMtSupport()` platforms
     - The Settings toggle (if added) and its default
     - Caveats per platform (e.g. iOS < 15.2 stays on remote-only)

## Things to NOT do in this branch

- Refactor the prove pipeline beyond what `wiktor/mt-wasm-offscreen`
  already did. This is "make the existing MT pipeline work on mobile,"
  not "redesign the prove pipeline for mobile."
- Build a custom rayon-on-WebView shim. The whole point of
  `wasm-bindgen-rayon` is that it's a portable solution.
- Touch the wallet's STARK/AIR config. We're using whatever the
  desktop MT prove path uses; the field math is the same regardless
  of platform.
- Ship without empirical Phase-1 validation. The cost of "we think
  it'll work" and shipping a broken mobile release is much higher
  than the cost of one day of simulator + device-test work upfront.

## Open questions / risks

1. **iOS Worker behavior under wasm-bindgen-rayon**: the historical
   "Workers can't do gRPC-web fetch" memo is the highest-risk unknown.
   Phase 1 must validate this on a real device, not just simulator.
2. **iOS 15.2 floor**: are we OK with iOS < 15.2 keeping the remote-only
   path forever? Probably yes — that's a single-digit-percent install
   base on a modern wallet user, but worth confirming with product.
3. **Battery / thermal**: MT prove is more CPU-intensive than ST.
   On phones, that's more battery + heat. Measure on a real device
   across multiple consecutive proves to see if thermal throttling
   kicks in.
4. **Capacitor server plugin authoring** (if needed for iOS COOP/COEP):
   would require ~20 LoC of Swift in the Capacitor host plugin. Cost
   estimate solid; risk if Apple changes WebView header-injection
   semantics across iOS versions. Mitigated by the SW-based fallback
   continuing to exist for the cases where the plugin can't inject.

## Estimated total

3-5 working days end-to-end, dominated by:
- Phase 1: 1-2 days (deeply uncertain but bounded by "have answer or punt")
- Phase 2: 2-3 days (concrete plumbing)
- Phase 3: 1 day (measurement + write-up)

Cheaper than building any of this from scratch because the desktop
MT prove path (PR #230) already exists; we're just enabling the
existing pipeline on a new transport.

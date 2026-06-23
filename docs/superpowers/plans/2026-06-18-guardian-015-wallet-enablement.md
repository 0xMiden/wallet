# Guardian on Miden 0.15 — wallet enablement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the wallet's Guardian feature work on Miden 0.15 — concretely, get the `guardian-send-consume` e2e (create → fund → consume → send) green on devnet — by basing on OpenZeppelin's `miden-v0-15-upgrade` branch and aligning every component on `@miden-sdk/miden-sdk@0.15.0`.

**Architecture:** Build OZ's near-complete 0.15 guardian (TS packages + Rust server) from their branch; bump the wallet SDK `0.15.0-alpha.7 → 0.15.0`; link the local OZ 0.15 packages into the wallet replacing npm `0.14.9`; spawn the local 0.15 server and run the e2e; fix the gaps that surface.

**Tech Stack:** TypeScript (`@openzeppelin/miden-multisig-client`, `@openzeppelin/guardian-client`, `@miden-sdk/miden-sdk`), Rust (guardian server, `miden-protocol/standards/tx 0.15`), Docker, yarn, Playwright (Chrome extension e2e), Miden devnet.

**Repos / paths:**
- Wallet worktree: `/tmp/pr153-fix` (branch `wiktor/guardian-015`, stacked on `pr153-fix`).
- Guardian repo: `~/miden/private-state-manager` (remote `OpenZeppelin/guardian`).
- Node 22: `export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$HOME/.cargo/bin:$PATH"`.

**Conventions:** wallet-side changes are committed on `wiktor/guardian-015`. Guardian-repo changes are committed on a local branch `wiktor/guardian-015-wallet` off `origin/miden-v0-15-upgrade` (push to a fork only when we have fixes worth sharing — Task 7).

---

### Task 1: Build OZ's 0.15 guardian TS packages

**Files:**
- Modify (branch checkout only): `~/miden/private-state-manager` working tree.

- [ ] **Step 1: Create a working branch off OZ's 0.15 branch**

```bash
cd ~/miden/private-state-manager
git fetch origin
git checkout -b wiktor/guardian-015-wallet origin/miden-v0-15-upgrade
git log --oneline -1   # expect: adb5679 chore: Improvements (or newer)
```

- [ ] **Step 2: Build guardian-client**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
cd ~/miden/private-state-manager/packages/guardian-client
npm install
npm run build
ls dist/index.js && echo "guardian-client built"
```
Expected: `dist/` populated, "guardian-client built". (guardian-client has no SDK dep, so this should be clean.)

- [ ] **Step 3: Build miden-multisig-client**

```bash
cd ~/miden/private-state-manager/packages/miden-multisig-client
npm install
npm run build   # runs scripts/generate-masm.mjs then tsc
ls dist/index.js && echo "multisig-client built"
```
Expected: build succeeds, `dist/` populated. If `tsc` errors against the real `0.15.0` `.d.ts`, that's a real gap — record the errors; they become fixes under Task 7 (do NOT skip with `// @ts-ignore`).

- [ ] **Step 4: Confirm the SDK the package resolved**

```bash
node -e "console.log(require('./node_modules/@miden-sdk/miden-sdk/package.json').version)"
```
Expected: `0.15.0` (matches the wallet target).

- [ ] **Step 5: No commit needed** (only `node_modules`/`dist` changed, both gitignored). Proceed.

---

### Task 2: Build and run OZ's 0.15 guardian server (devnet)

**Files:**
- Uses: `~/miden/private-state-manager/docker-compose.yml` (default = filesystem backend, `GUARDIAN_SERVER_FEATURES=""`, no Postgres).

- [ ] **Step 1: Build + start the 0.15 server (filesystem backend, devnet default)**

```bash
cd ~/miden/private-state-manager
docker compose down -v 2>/dev/null
docker compose up --build -d   # ~10-20 min first build (Rust 0.15)
```
Expected: image builds, container starts. `GUARDIAN_NETWORK_TYPE` defaults to `MidenDevnet` (server `main.rs`), storage paths set by the compose env → filesystem backend (no DATABASE_URL needed).

- [ ] **Step 2: Wait for readiness and confirm it serves ECDSA**

```bash
for i in $(seq 1 60); do curl -sf "http://localhost:3000/pubkey?scheme=ecdsa" >/dev/null && { echo "guardian UP"; break; }; sleep 2; done
curl -s "http://localhost:3000/pubkey?scheme=ecdsa"; echo
```
Expected: HTTP 200, JSON `{"commitment":"0x..","pubkey":"0x02..|0x03.."}` (compressed secp256k1 → ECDSA). If it crashes, `docker compose logs server | tail -40` and treat as a Task 7 fix.

- [ ] **Step 3: No commit** (no source changed yet). Leave the container running for Task 5.

---

### Task 3: Bump the wallet SDK `0.15.0-alpha.7 → 0.15.0`

**Files:**
- Modify: `/tmp/pr153-fix/package.json` (dependencies + resolutions).

- [ ] **Step 1: Check `@miden-sdk/vite-plugin` for a 0.15-matching version**

```bash
npm view @miden-sdk/vite-plugin versions --json | python3 -c "import sys,json;print('\n'.join([v for v in json.load(sys.stdin) if v.startswith('0.15') or v.startswith('0.14.11')]))"
```
Expected: a list. If a `0.15.x` exists, target it in Step 2; if not, leave `vite-plugin` at `0.14.11` (it's build-time tooling and may be SDK-version-agnostic — the build in Task 5 is the real check).

- [ ] **Step 2: Edit `package.json` versions**

In `/tmp/pr153-fix/package.json`, change every `0.15.0-alpha.7` for these keys to `0.15.0`:
- `dependencies["@miden-sdk/miden-sdk"]`: `"0.15.0"`
- `dependencies["@miden-sdk/react"]`: `"0.15.0"`
- `resolutions["**/@miden-sdk/miden-sdk"]`: `"0.15.0"`

(If `@miden-sdk/vite-plugin` had a 0.15 version in Step 1, also bump `devDependencies["@miden-sdk/vite-plugin"]`.)

- [ ] **Step 3: Reinstall and verify resolution**

```bash
cd /tmp/pr153-fix
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
yarn install
node -e "console.log('sdk', require('./node_modules/@miden-sdk/miden-sdk/package.json').version)"
```
Expected: `sdk 0.15.0`, install succeeds.

- [ ] **Step 4: Typecheck the wallet (catch SDK API drift early)**

```bash
yarn ts 2>&1 | tail -20
```
Expected: `Done`. If `alpha.7 → 0.15.0` introduced API breaks, fix them here (real code, not `@ts-ignore`); they are part of this task. Re-run until green.

- [ ] **Step 5: Commit**

```bash
cd /tmp/pr153-fix
git add package.json yarn.lock
git commit -m "chore: bump @miden-sdk to 0.15.0 (align with guardian 0.15)"
```

---

### Task 4: Link the local OZ 0.15 packages into the wallet

**Files:**
- Modify: `/tmp/pr153-fix/package.json` (`resolutions`).

- [ ] **Step 1: Point the OZ packages at the local 0.15 builds**

In `/tmp/pr153-fix/package.json`, add to `resolutions` (keep the SDK resolution from Task 3):
```json
"@openzeppelin/guardian-client": "file:/Users/celrisen/miden/private-state-manager/packages/guardian-client",
"@openzeppelin/miden-multisig-client": "file:/Users/celrisen/miden/private-state-manager/packages/miden-multisig-client"
```

- [ ] **Step 2: Reinstall**

```bash
cd /tmp/pr153-fix
yarn install
```
Expected: install succeeds; the OZ packages resolve to the `file:` paths.

- [ ] **Step 3: Verify versions + single SDK identity (the critical check)**

```bash
node -e "console.log('multisig', require('./node_modules/@openzeppelin/miden-multisig-client/package.json').version)"
find node_modules/@openzeppelin -path '*/node_modules/@miden-sdk/miden-sdk/package.json' -print 2>/dev/null | head
```
Expected: multisig version is the branch's (`0.14.9`-on-branch). The `find` must print **nothing** — a nested `@miden-sdk/miden-sdk` under `@openzeppelin/*` means a duplicate SDK copy (would reintroduce the ABI crash). If found, add it to `resolutions`/`nohoist` so the single root `0.15.0` SDK is used.

- [ ] **Step 4: Commit**

```bash
git add package.json yarn.lock
git commit -m "chore: link local OZ guardian 0.15 packages into the wallet"
```

---

### Task 5: Run the guardian e2e against the 0.15 stack (acceptance)

**Files:**
- Uses: `/tmp/pr153-fix/playwright/e2e/tests/guardian-send-consume.spec.ts` (built in the prior PR work).

- [ ] **Step 1: Build the wallet for devnet (with the bumped SDK + linked OZ packages)**

```bash
cd /tmp/pr153-fix
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$HOME/.cargo/bin:$PATH"
export E2E_NETWORK=devnet MIDEN_NETWORK=devnet
yarn test:e2e:blockchain:build
ls dist/chrome_unpacked/manifest.json && echo "built"
```
Expected: build succeeds (note: `MIDEN_NETWORK=devnet` must be exported for the BUILD, not just the run — the build script defaults to testnet otherwise).

- [ ] **Step 2: Confirm the guardian server is up (from Task 2)**

```bash
curl -sf "http://localhost:3000/pubkey?scheme=ecdsa" && echo " guardian OK" || echo "restart: cd ~/miden/private-state-manager && docker compose up -d"
```

- [ ] **Step 3: Run the guardian e2e**

```bash
cd /tmp/pr153-fix
export E2E_NETWORK=devnet GUARDIAN_URL=http://localhost:3000
yarn test:e2e:guardian:run 2>&1 | tee /tmp/guardian-015-run.log | tail -40
```
Expected (success criterion): the test passes — guardian account is **created** (no `memory access out of bounds`), funded, notes consumed, send to B succeeds, B's balance > 0.

- [ ] **Step 4: If it fails, diagnose (feeds Task 7)**

Record the failing step and the page console error from the log. The most likely failure classes and where to look:
- `memory access out of bounds` still at create → duplicate SDK copy (re-check Task 4 Step 3) OR an un-awaited async SDK call in the OZ branch's `packages/miden-multisig-client/src/account/builder.ts` / `raw-client.ts` (`createCodeBuilder()` is async in 0.15).
- a TS/JS error in the OZ client → an OZ-branch WIP bug → Task 7.
- guardian HTTP 4xx/5xx → check `docker compose logs server` → server-side gap → Task 7.

- [ ] **Step 5: On pass, no source change to commit here** (the spec already exists in the repo). Proceed to Task 6.

---

### Task 6: Verification guardrail — non-guardian e2e still green

**Files:**
- Uses: `/tmp/pr153-fix/playwright/e2e/tests/send-public.spec.ts`.

- [ ] **Step 1: Run the standard send-public e2e on devnet (catches SDK-bump fallout)**

```bash
cd /tmp/pr153-fix
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$HOME/.cargo/bin:$PATH"
export E2E_NETWORK=devnet
xvfb-run -a yarn test:e2e:blockchain:run -g "Public Note Send" 2>&1 | tail -30 || \
  yarn test:e2e:blockchain:run -g "Public Note Send" 2>&1 | tail -30   # macOS: no xvfb, runs headed on the display
```
Expected: passes. A regression here means the `alpha.7 → 0.15.0` bump broke a non-guardian path — fix before declaring done (this is the guardrail's purpose).

- [ ] **Step 2: No commit** (no source change). Proceed.

---

### Task 7: Fix loop — close the gaps that surfaced (reactive)

This task is iterative: each concrete failure from Tasks 1–6 becomes one fix + one commit. There is no pre-written code because the specific gaps are only knowable once built/run. Procedure per gap:

- [ ] **Step 1: Classify the gap**
  - **Wallet-side** (SDK-bump API drift, vite/build, resolution) → fix in `/tmp/pr153-fix`, commit on `wiktor/guardian-015`.
  - **OZ TS client** (un-awaited async, `AccountType` collapse, removed `resolveAuthScheme`/`AccountId.isFaucet`, `Felt`/`Word` now throwing) → fix in `~/miden/private-state-manager/packages/miden-multisig-client/src`, rebuild (Task 1 Step 3), commit on `wiktor/guardian-015-wallet`.
  - **OZ server** (Rust) → fix in `~/miden/private-state-manager/crates/server`, rebuild image (Task 2), commit on `wiktor/guardian-015-wallet`.

- [ ] **Step 2: Apply the minimal fix** (real code; no `@ts-ignore`/`unwrap()`-papering). Reference: the scope investigation flagged the highest-probability TS gaps as un-awaited `createCodeBuilder()` (now `Promise<CodeBuilder>` in 0.15) at `packages/miden-multisig-client/src/account/builder.ts:~60` and `src/raw-client.ts`.

- [ ] **Step 3: Rebuild the affected component and re-run the failing task's command** (Task 1/2 build, then Task 5 e2e). Loop until Task 5 + Task 6 both pass.

- [ ] **Step 4: Commit each fix** on the appropriate branch with a `fix:` message describing the gap.

- [ ] **Step 5: Decide on a GitHub fork** — if we committed OZ-repo fixes on `wiktor/guardian-015-wallet`, fork `OpenZeppelin/guardian`, add it as a remote, and push the branch so the changes are preserved and shareable. (Local-only is fine until then.)

---

### Task 8: Wire the e2e into CI for the 0.15 stack

**Files:**
- Modify: `/tmp/pr153-fix/.github/workflows/e2e-blockchain.yml` (the `chrome-guardian-devnet` job from the prior PR).

- [ ] **Step 1: Point the CI job at the 0.15 guardian image**

The current job runs `ghcr.io/openzeppelin/guardian:v0.14.9` (which crashes on 0.15). Until OZ publishes a 0.15 image, either (a) build the server from the OZ branch in the job, or (b) push our built image to a registry the CI can pull. Update the `Start local guardian (devnet)` step accordingly. Decide a→b based on CI build-time budget (the Rust build is ~10-20 min; a prebuilt pushed image is faster).

- [ ] **Step 2: Commit**

```bash
cd /tmp/pr153-fix
git add .github/workflows/e2e-blockchain.yml
git commit -m "ci: run guardian e2e against the 0.15 guardian image"
```

Note: Task 8 is only meaningful once Tasks 5–6 pass locally. If CI guardian infra is deferred, mark the guardian job `if: false` with a TODO referencing this plan rather than leaving it red.

---

## Self-Review

**Spec coverage:** build OZ TS (T1) ✓, build/run OZ server (T2) ✓, wallet SDK bump to 0.15.0 (T3) ✓, link OZ packages + single-SDK check (T4) ✓, guardian e2e acceptance (T5) ✓, non-guardian guardrail (T6) ✓, fix loop incl. fork decision (T7) ✓, CI (T8, beyond spec but follows from the prior PR's CI job) ✓.

**Placeholder scan:** the only non-literal task is T7 (reactive fix loop) — unavoidable for a port; mitigated by naming the concrete likely gaps + exact file locations + the classify→fix→rebuild→commit procedure. No "TBD/handle edge cases" hand-waving.

**Type/command consistency:** version target `0.15.0` is consistent across T3/T4. The `MIDEN_NETWORK=devnet` build gotcha is called out in T5. The single-SDK-identity check (T4 S3) guards the exact failure mode this whole effort is fixing.

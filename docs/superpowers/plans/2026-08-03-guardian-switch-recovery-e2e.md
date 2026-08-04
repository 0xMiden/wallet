# Guardian Switch + Recovery E2E — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add comprehensive, hermetic Chrome + iOS E2E coverage for guardian **switching** and guardian-account **recovery** (happy path + stress), and fix the wallet at root cause wherever a scenario is red, so the suite is 100% green.

**Architecture:** Extend the existing guardian E2E suite (two-wallet / two-sim fixtures, `steps.step()` timeline, `getGuardianAuthInfo`). Stand up a **second** OZ guardian container so a real cross-guardian switch is deterministic and hermetic. Inject guardian faults via Playwright request routing (Chrome). Drive recovery through the real UI (seed grid → probe → rotation gate) plus a fast bypass for state/stress setup.

**Tech Stack:** Playwright, Docker Compose (OZ guardian `ghcr.io/openzeppelin/guardian`, Miden node/prover/note-transport), TypeScript, Miden WASM SDK, React/Zustand wallet.

## Global Constraints

- Node ≥ 22 for all wallet/e2e builds (`source ~/.nvm/nvm.sh && nvm use 22`).
- Design doc / source of truth: `docs/superpowers/specs/2026-08-03-guardian-switch-recovery-e2e-design.md`.
- **Harness is authoritative:** no `test.fixme` quarantine — a red scenario means fix the wallet at root cause.
- **Scope boundary:** switch-correctness asserts **wallet-observable** outcomes only (routes to / co-signs only with the new guardian, usable, never hangs). The `released_at` / split-brain gap is guardian-server `OpenZeppelin/guardian#369` — never asserted as a wallet requirement.
- `retries: 0` in every config — a flake is a bug.
- WASM client is single-threaded: any direct SDK call goes through `withWasmClientLock`.
- Second guardian picker option is **localnet-only and gated on `MIDEN_E2E_TEST`** — never visible in production builds.
- Commits: single-line, imperative, no `Co-Authored-By`, no "Generated with". Never `git push` without explicit request.
- Run against `origin/main` (`a7995078f`) baseline before each product-fix task; only fix genuine reds.

## File Structure

| File | Responsibility |
|---|---|
| `playwright/e2e/local-stack/docker-compose.local.yml` (modify) | add `guardian-b` + `guardian-b-postgres` under profile `guardian-switch` |
| `playwright/e2e/local-stack/versions.env` (modify) | pin 2nd guardian image tag (reuse `GUARDIAN_IMAGE_TAG`) |
| `src/lib/miden-chain/constants.ts` (modify) | localnet `OpenZeppelin B` option, `MIDEN_E2E_TEST`-gated |
| `playwright/e2e/harness/guardian-fault.ts` (create) | fault policy type + `installGuardianFaults(context)` route handler |
| `playwright/e2e/helpers/wallet-page.ts` (modify) | Chrome POM: `switchGuardian`, `recoverGuardianFromSeed`, `completeHotKeyRotation`, `assertGuardianAuth`, `armGuardianFault`, `clearFaults` |
| `playwright/e2e/ios/helpers/ios-wallet-page.ts` (modify) | iOS POM mirror (no fault methods) |
| `playwright/e2e/fixtures/two-wallets.ts` (modify) | wire `installGuardianFaults` + expose fault controls |
| `playwright/e2e/tests/guardian-switch.spec.ts` (create) | switch happy + cross-guardian correctness |
| `playwright/e2e/tests/guardian-switch-stress.spec.ts` (create) | kill/fault/repeat/concurrent |
| `playwright/e2e/tests/guardian-recovery.spec.ts` (create) | real-UI recovery journey |
| `playwright/e2e/tests/guardian-recovery-stress.spec.ts` (create) | kill mid-rotation / fault / conflict |
| `playwright/e2e/ios/tests/guardian-switch.ios.spec.ts` (create) | iOS switch happy + kill/reopen |
| `playwright/e2e/ios/tests/guardian-recovery.ios.spec.ts` (create) | iOS recovery journey (keyboard) |
| `.github/workflows/pr-e2e-guardian-lifecycle.yml` (create) | bring up node+prover+transport+2 guardians, run suite |

## Product-Fix Protocol (referenced by all discovery-gated fix steps)

Some spec tasks will be **red on `main`** because of a real wallet bug. Those tasks include a fix step that applies this protocol (do **not** invent code before observing the failure):

1. Reproduce: run the new spec against `origin/main`. Confirm it fails and capture the exact failure (timeline + failure-report artifact + console/network capture).
2. Root-cause with `superpowers:systematic-debugging` (Phase 1 before any fix). Start from the candidate location named in the task (from spec §9) but verify the true root cause.
3. Write the minimal wallet fix at root cause. No symptom patches. Wrap platform-specific fixes in `isIOS()`/`isMobile()`.
4. Re-run the spec → green. Run the adjacent guardian specs (`playwright.guardian.config.ts`) to check no regression.
5. Commit the fix separately from the test (`fix(guardian): …`), referencing the scenario.
6. If the "fix" would require a guardian-**server** change, STOP — that's `#369`; re-scope the assertion to the wallet boundary and note it. Do not fix the wallet to paper over a server gap.

---

## Phase A — Foundation

### Task A1: Second guardian container

**Files:**
- Modify: `playwright/e2e/local-stack/docker-compose.local.yml`
- Modify: `playwright/e2e/local-stack/versions.env`

**Interfaces:**
- Produces: guardian A at `http://localhost:3000` (gRPC `:50051`), guardian B at `http://localhost:3001` (gRPC `:50053`, PG `:5433`), both under compose profile `guardian-switch`.

- [ ] **Step 1: De-risk image port config.** Run guardian A alone, then attempt a second instance with overridden ports, and confirm it serves:
```bash
cd playwright/e2e/local-stack
docker compose -f docker-compose.local.yml --profile guardian up -d guardian guardian-postgres
# Inspect how ports/DB/keys are configured (env vars) so B can override them:
docker compose -f docker-compose.local.yml config | sed -n '/guardian:/,/^[^ ]/p'
docker inspect $(docker compose -f docker-compose.local.yml ps -q guardian) --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -iE 'PORT|GRPC|HTTP|DATABASE|POSTGRES|KEY|NETWORK'
```
Expected: identify the env vars controlling HTTP port, gRPC port, and DB URL. If the image hard-codes ports with no override, fall back to a distinct docker network + published-port remap (document in this task).

- [ ] **Step 2: Add `guardian-b-postgres` and `guardian-b` services.** Mirror the existing `guardian`/`guardian-postgres` block with the B ports/DB and profile `guardian-switch`. (Exact keys depend on Step 1; template:)
```yaml
  guardian-b-postgres:
    image: postgres:16
    profiles: ["guardian-switch"]
    environment:
      POSTGRES_DB: guardian_b
      POSTGRES_USER: guardian
      POSTGRES_PASSWORD: guardian
    ports: ["5433:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U guardian -d guardian_b"]
      interval: 2s
      timeout: 5s
      retries: 30

  guardian-b:
    image: ghcr.io/openzeppelin/guardian:${GUARDIAN_IMAGE_TAG}
    profiles: ["guardian-switch"]
    network_mode: host
    depends_on:
      guardian-b-postgres:
        condition: service_healthy
    environment:
      GUARDIAN_NETWORK_TYPE: MidenLocal
      # from Step 1 — HTTP :3001, gRPC :50053, DB on :5433:
      GUARDIAN_HTTP_PORT: "3001"
      GUARDIAN_GRPC_PORT: "50053"
      DATABASE_URL: "postgres://guardian:guardian@localhost:5433/guardian_b"
```

- [ ] **Step 3: Bring both up and verify health.**
```bash
docker compose -f docker-compose.local.yml --profile guardian-switch up -d guardian guardian-postgres guardian-b guardian-b-postgres
curl -fsS http://localhost:3000/health && echo " A ok"
curl -fsS http://localhost:3001/health && echo " B ok"
# Distinct guardian identities (the switch target must differ):
curl -fsS http://localhost:3000/pubkey?scheme=ecdsa
curl -fsS http://localhost:3001/pubkey?scheme=ecdsa
```
Expected: both healthy; the two `/pubkey` responses **differ** (distinct keypairs). If identical, fix B's key config in Step 2.

- [ ] **Step 4: Commit.**
```bash
git add playwright/e2e/local-stack/docker-compose.local.yml playwright/e2e/local-stack/versions.env
git commit -m "test(e2e): add second hermetic guardian container (guardian-switch profile)"
```

### Task A2: Second localnet guardian picker option

**Files:**
- Modify: `src/lib/miden-chain/constants.ts` (`GUARDIAN_OPTIONS` ~`:121`, `getGuardianOptionsForNetwork` ~`:178`)
- Test: `src/lib/miden-chain/constants.test.ts` (create or extend)

**Interfaces:**
- Produces: on localnet, when `process.env.MIDEN_E2E_TEST === 'true'`, `getGuardianOptionsForNetwork(LOCALNET)` includes `{ name: 'OpenZeppelin B', endpoint: 'http://localhost:3001' }` in addition to the existing localhost option.

- [ ] **Step 1: Write the failing test.**
```ts
import { getGuardianOptionsForNetwork, MIDEN_NETWORK_NAME } from './constants';

describe('localnet second guardian (E2E only)', () => {
  const prev = process.env.MIDEN_E2E_TEST;
  afterEach(() => { process.env.MIDEN_E2E_TEST = prev; });

  it('exposes OpenZeppelin B on localnet only under MIDEN_E2E_TEST', () => {
    process.env.MIDEN_E2E_TEST = 'true';
    const opts = getGuardianOptionsForNetwork(MIDEN_NETWORK_NAME.LOCALNET);
    expect(opts.map(o => o.endpoint)).toContain('http://localhost:3001');
  });

  it('hides OpenZeppelin B when not in E2E', () => {
    process.env.MIDEN_E2E_TEST = 'false';
    const opts = getGuardianOptionsForNetwork(MIDEN_NETWORK_NAME.LOCALNET);
    expect(opts.map(o => o.endpoint)).not.toContain('http://localhost:3001');
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `yarn jest src/lib/miden-chain/constants.test.ts -t "second guardian"` → FAIL (endpoint absent).

- [ ] **Step 3: Implement.** In `getGuardianOptionsForNetwork`, after building the localnet options, append the E2E-only B option:
```ts
// inside getGuardianOptionsForNetwork, localnet branch:
const options = [...baseLocalnetOptions];
if (process.env.MIDEN_E2E_TEST === 'true') {
  options.push({ name: 'OpenZeppelin B', endpoint: 'http://localhost:3001' });
}
return options;
```
(Match the exact `GuardianOption` shape used in `GUARDIAN_OPTIONS`.)

- [ ] **Step 4: Run to verify it passes.** `yarn jest src/lib/miden-chain/constants.test.ts -t "second guardian"` → PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/lib/miden-chain/constants.ts src/lib/miden-chain/constants.test.ts
git commit -m "test(e2e): expose second localnet guardian option under MIDEN_E2E_TEST"
```

### Task A3: Guardian fault-injection layer

**Files:**
- Create: `playwright/e2e/harness/guardian-fault.ts`
- Modify: `playwright/e2e/fixtures/two-wallets.ts` (wire into `launchWalletInstance`)
- Test: `playwright/e2e/tests/guardian-fault.smoke.spec.ts` (create; deleted or kept as a cheap guard)

**Interfaces:**
- Produces:
```ts
export type GuardianFaultTarget = 'A' | 'B';
export type GuardianFaultPath = 'pubkey' | 'register' | 'delta' | 'proposals' | 'sign';
export interface GuardianFaultPolicy {
  target?: GuardianFaultTarget;        // default: any guardian
  path: GuardianFaultPath;
  mode: 'status500' | 'abort' | 'delay' | 'failFirstN';
  delayMs?: number;                    // for 'delay'
  count?: number;                      // for 'failFirstN'
}
// Installs a route handler; returns controls stored on the fixture.
export function installGuardianFaults(context: BrowserContext): {
  arm(policy: GuardianFaultPolicy): void;
  clear(): void;
};
```
- The handler matches guardian URLs (`http://localhost:3000/*` → A, `:3001/*` → B) and the path segment; applies the active policy (fail `count` times for `failFirstN`, then `continue()`), else `continue()`.

- [ ] **Step 1: Write `guardian-fault.ts`.** (Full implementation — URL/path match, per-policy behavior, `failFirstN` counter, `context.route('**/*', …)` with `serviceWorkers: 'allow'` already set by the fixture.)
```ts
import { BrowserContext, Route } from '@playwright/test';

// ... types from Interfaces ...

function targetOf(url: string): GuardianFaultTarget | null {
  if (url.startsWith('http://localhost:3000/')) return 'A';
  if (url.startsWith('http://localhost:3001/')) return 'B';
  return null;
}
function pathOf(url: string): GuardianFaultPath | null {
  for (const p of ['pubkey', 'register', 'delta', 'proposals', 'sign'] as const) {
    if (url.includes(`/${p}`)) return p;
  }
  return null;
}

export function installGuardianFaults(context: BrowserContext) {
  let policy: GuardianFaultPolicy | null = null;
  let hits = 0;
  const controls = {
    arm(p: GuardianFaultPolicy) { policy = p; hits = 0; },
    clear() { policy = null; hits = 0; },
  };
  context.route('**/*', async (route: Route) => {
    const url = route.request().url();
    const tgt = targetOf(url);
    if (!policy || !tgt) return route.continue();
    if (policy.target && policy.target !== tgt) return route.continue();
    if (pathOf(url) !== policy.path) return route.continue();
    if (policy.mode === 'failFirstN' && hits >= (policy.count ?? 1)) return route.continue();
    hits++;
    switch (policy.mode) {
      case 'abort': return route.abort('failed');
      case 'delay': await new Promise(r => setTimeout(r, policy!.delayMs ?? 3000)); return route.continue();
      case 'status500':
      case 'failFirstN': return route.fulfill({ status: 500, body: 'injected guardian fault' });
    }
  });
  return controls;
}
```

- [ ] **Step 2: Wire into the fixture.** In `two-wallets.ts` `launchWalletInstance`, after the persistent context is created, call `const faults = installGuardianFaults(context)` and thread `faults` onto the returned wallet page object.

- [ ] **Step 3: Write the smoke test.**
```ts
import { test, expect } from '../fixtures/two-wallets';
test('armed guardian fault surfaces to the wallet', async ({ walletA }) => {
  walletA.armGuardianFault({ path: 'pubkey', mode: 'status500', target: 'B' });
  // creating a guardian wallet against B fetches B /pubkey → should fail fast, not hang:
  await expect(walletA.createGuardianWallet('http://localhost:3001')).rejects.toBeTruthy();
  walletA.clearFaults();
});
```

- [ ] **Step 4: Run.** `E2E_NETWORK=localhost yarn test:e2e:blockchain:build && yarn playwright test guardian-fault.smoke --config playwright.guardian.config.ts` → PASS (needs the local stack up).

- [ ] **Step 5: Commit.**
```bash
git add playwright/e2e/harness/guardian-fault.ts playwright/e2e/fixtures/two-wallets.ts playwright/e2e/tests/guardian-fault.smoke.spec.ts
git commit -m "test(e2e): guardian fault-injection via request routing"
```

### Task A4: POM primitives (Chrome + iOS)

**Files:**
- Modify: `playwright/e2e/helpers/wallet-page.ts`
- Modify: `playwright/e2e/ios/helpers/ios-wallet-page.ts`

**Interfaces:**
- Produces on both POMs:
```ts
switchGuardian(newEndpoint: string): Promise<void>;             // Settings→RotateGuardian→Review→confirm→Completed
recoverGuardianFromSeed(seed: string, opts: { viaUI: boolean }): Promise<void>;
completeHotKeyRotation(): Promise<void>;                        // await HotKeyRotationGate cleared; throws on terminal-fail surface
assertGuardianAuth(pk: string, expected: { signerCount: number; threshold: number; guardianCommitment?: string }): Promise<void>;
```
- Chrome-only: `armGuardianFault(policy: GuardianFaultPolicy): void; clearFaults(): void;` (delegate to the fixture's `faults`).

- [ ] **Step 1 (Chrome): `switchGuardian`.** Drive the real screens (testids from the map):
```ts
async switchGuardian(newEndpoint: string) {
  await this.openSettings();                                   // existing helper
  await this.page.click('[data-testid="rotateGuardian"]');     // GuardianSettings.tsx
  // ChooseGuardian: select the option whose endpoint === newEndpoint
  await this.page.click(`[data-guardian-endpoint="${newEndpoint}"]`);
  await this.page.click('[data-testid="choose-guardian-continue"]');
  // RotateGuardianReview → confirm
  await this.page.click('[data-testid="rotate-guardian-confirm"]');
  await this.waitForTransactionComplete();                     // existing generating-transaction observer
}
```
(If the picker/confirm testids differ, add them to the components in this task — small, test-only `data-testid` attributes.)

- [ ] **Step 2 (Chrome): `recoverGuardianFromSeed`.** `viaUI:false` → reuse the bypass (extend `createGuardianWallet` to pass `seed`). `viaUI:true` → drive `ImportSeedPhrase` inputs, submit, wait for `ImportRecoveryMethod`, accept detected (or pick endpoint), then `await this.completeHotKeyRotation()`.
```ts
async recoverGuardianFromSeed(seed: string, { viaUI }: { viaUI: boolean }) {
  if (!viaUI) { await this.createWalletViaBypass({ walletType: 'guardian', seed }); return; }
  await this.startImportFlow();                                 // Welcome → import
  const words = seed.trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    await this.page.fill(`[data-testid="seed-word-${i}"]`, words[i]);
  }
  await this.page.click('[data-testid="import-seed-submit"]');
  await this.page.waitForSelector('[data-testid="guardian-detected"], [data-testid="guardian-not-detected"]');
  await this.page.click('[data-testid="recovery-method-continue"]');
  await this.completeHotKeyRotation();
}
```

- [ ] **Step 3 (Chrome): `completeHotKeyRotation` + `assertGuardianAuth`.**
```ts
async completeHotKeyRotation() {
  // HotKeyRotationGate is a blocking overlay; it clears when requiresHotKeyRotation flips false.
  await this.page.waitForSelector('[data-testid="hot-key-rotation-gate"]', { state: 'visible' });
  // Fail fast if the gate shows its terminal-failure surface instead of clearing:
  await Promise.race([
    this.page.waitForSelector('[data-testid="hot-key-rotation-gate"]', { state: 'detached', timeout: 120_000 }),
    this.page.waitForSelector('[data-testid="hot-key-rotation-failed"]', { timeout: 120_000 })
      .then(() => { throw new Error('hot-key rotation reached terminal failure'); }),
  ]);
}
async assertGuardianAuth(pk: string, expected: { signerCount: number; threshold: number; guardianCommitment?: string }) {
  const info = await this.getGuardianAuthInfo(pk);
  expect(info.signers.length).toBe(expected.signerCount);
  expect(info.updateGuardianThreshold).toBe(expected.threshold);
  if (expected.guardianCommitment) expect(info.guardianCommitment).toBe(expected.guardianCommitment);
}
```
(`hot-key-rotation-gate` / `hot-key-rotation-failed` testids may need adding to `HotKeyRotationGate.tsx` — test-only, small.)

- [ ] **Step 4 (iOS): mirror `switchGuardian` / `recoverGuardianFromSeed(viaUI)` / `completeHotKeyRotation` / `assertGuardianAuth`** in `ios-wallet-page.ts` using the CDP-driven click/fill helpers already there. No fault methods. If any step needs a native-navbar CTA, add `__TEST_TRIGGER_NAVBAR_ACTION__` back (see spec §6) in this task.

- [ ] **Step 5: Type-check + commit.**
```bash
yarn tsc --noEmit -p playwright/tsconfig.json 2>/dev/null || yarn tsc --noEmit
git add playwright/e2e/helpers/wallet-page.ts playwright/e2e/ios/helpers/ios-wallet-page.ts src/app/**/*.tsx
git commit -m "test(e2e): guardian switch/recovery POM primitives + test ids"
```

### Task A5: CI workflow

**Files:**
- Create: `.github/workflows/pr-e2e-guardian-lifecycle.yml` (adapt `pr-e2e-local.yml`)

- [ ] **Step 1: Author the workflow.** Copy `pr-e2e-local.yml` structure; change the guardian bring-up to `--profile guardian-switch` (both guardians), wait on `:3000` **and** `:3001` health, build the localnet extension with `MIDEN_E2E_TEST=true`, and run `guardian-switch*.spec.ts` + `guardian-recovery*.spec.ts` via `playwright.guardian.config.ts`. Upload timeline/failure-report artifacts.

- [ ] **Step 2: Local dry-run of the sequence** (compose up both guardians, build, run one spec) to confirm the steps compose. 

- [ ] **Step 3: Commit.**
```bash
git add .github/workflows/pr-e2e-guardian-lifecycle.yml
git commit -m "ci(e2e): guardian-lifecycle workflow (two guardians)"
```

---

## Phase B — Switch (spec → run vs main → fix)

Each task: write the test (full body below) → run against `main` → if green, commit the test; if red, apply the **Product-Fix Protocol** (candidate location named per task) → green → commit test + fix.

### Task B1: Switch happy path + usability (Chrome)

**Files:** Create `playwright/e2e/tests/guardian-switch.spec.ts`

- [ ] **Step 1: Write the test.**
```ts
import { test, expect } from '../fixtures/two-wallets';
const A = 'http://localhost:3000', B = 'http://localhost:3001';

test('switch A→B: completes, usable on B, survives reopen', async ({ walletA, midenCli, steps }) => {
  await steps.step('create on A + fund', async () => {
    await walletA.createGuardianWallet(A);
    await midenCli.init(); const f = await midenCli.createFaucet();
    await midenCli.mint(f, await walletA.address(), 100n, 'public'); await walletA.sync();
    await walletA.claimAll();
  });
  const pk = await walletA.publicKey();
  await steps.step('switch to B', async () => {
    await walletA.switchGuardian(B);
    await walletA.assertGuardianAuth(pk, { signerCount: 2, threshold: 2 }); // guardian now B
  });
  await steps.step('usable on B', async () => {
    await walletA.sendPublic(await walletA.address(), 1n); // self-send exercises B co-sign
    await walletA.sync();
    await expect(walletA.balance()).resolves.toBeGreaterThan(0n);
  });
  await steps.step('close + reopen still on B', async () => {
    await walletA.reopen();                              // SW respawn
    await walletA.assertGuardianAuth(pk, { signerCount: 2, threshold: 2 });
    await expect(walletA.currentGuardianEndpoint()).resolves.toBe(B);
  });
});
```

- [ ] **Step 2: Run vs main.** `yarn playwright test guardian-switch --config playwright.guardian.config.ts`. Expected: reveals whether switch + post-switch usability + reopen hold on `main`.
- [ ] **Step 3: If red → Product-Fix Protocol.** Candidate locations: `finalizeGuardianSwitch` (`guardian/index.ts:501`), `completeSwitchGuardianTransaction` (`complete.ts:355`), per-account endpoint persistence (`setGuardianEndpoint`), `useCurrentGuardianEndpoint`.
- [ ] **Step 4: Commit** (`test(e2e): guardian switch happy path` [+ any `fix(guardian): …`]).

### Task B2: Cross-guardian correctness — wallet side (Chrome)

**Files:** append to `guardian-switch.spec.ts`

- [ ] **Step 1: Write the test.**
```ts
test('after switch, wallet co-signs only with B (A no longer authoritative for new txs)', async ({ walletA, midenCli, steps }) => {
  await walletA.createGuardianWallet(A); /* fund as B1 */ 
  const pk = await walletA.publicKey();
  await walletA.switchGuardian(B);
  await steps.step('a new tx co-signs with B, not A', async () => {
    // Fault ANY call to A: a correct wallet must not contact A for a post-switch tx.
    walletA.armGuardianFault({ target: 'A', path: 'sign', mode: 'abort' });
    await walletA.sendPublic(await walletA.address(), 1n); // must still succeed via B
    walletA.clearFaults();
    await walletA.assertGuardianAuth(pk, { signerCount: 2, threshold: 2 });
  });
});
```
(Asserts wallet-observable routing only — no `released_at`, per boundary.)

- [ ] **Step 2–4:** run vs main → fix if the wallet still routes to A (candidate: `getOrCreateMultisigService` cache invalidation `guardian-manager.ts:50`, `clearGuardianServiceFor`) → commit.

### Task B3: Kill mid-switch → reopen resumes (Chrome)

**Files:** Create `guardian-switch-stress.spec.ts`

- [ ] **Step 1: Write the test.**
```ts
test('kill during finalizeGuardianSwitch → reopen resumes to a consistent state', async ({ walletA, steps }) => {
  await walletA.createGuardianWallet(A); /* fund */ const pk = await walletA.publicKey();
  await steps.step('initiate switch then kill mid-register', async () => {
    walletA.armGuardianFault({ target: 'B', path: 'register', mode: 'delay', delayMs: 60_000 }); // hold register open
    void walletA.switchGuardian(B).catch(() => {});           // fire, don't await
    await walletA.waitForStage('registering-guardian');
    await walletA.kill();                                     // terminate SW/context
  });
  await steps.step('reopen → not stuck; resumes or safely retryable', async () => {
    await walletA.reopen(); walletA.clearFaults();
    await walletA.resumePendingIfAny();                       // drive the FIFO/rotation if surfaced
    await walletA.assertGuardianAuth(pk, { signerCount: 2, threshold: 2 });
    await expect(walletA.currentGuardianEndpoint()).resolves.toBe(B);
  });
});
```

- [ ] **Step 2–4:** run vs main → fix (candidate: orphaned `GeneratingTransaction` requeue on startup; `runtime.onStartup` sweep; `switch-guardian` exemption from `assertGuardianInSync` `transaction/index.ts:477`) → commit.

### Task B4: Guardian fault on B register → retry recovers (Chrome)

- [ ] **Step 1: Write the test.**
```ts
test('transient register failures on B → backoff recovers, switch completes', async ({ walletA }) => {
  await walletA.createGuardianWallet(A); const pk = await walletA.publicKey();
  walletA.armGuardianFault({ target: 'B', path: 'register', mode: 'failFirstN', count: 2 });
  await walletA.switchGuardian(B);                            // must survive 2 failures
  walletA.clearFaults();
  await walletA.assertGuardianAuth(pk, { signerCount: 2, threshold: 2 });
});
```
- [ ] **Step 2–4:** run vs main → fix (candidate: `registerOnGuardianWithRetry` `MAX_GUARDIAN_REGISTER_RETRIES` `guardian/index.ts:521-543`) → commit.

### Task B5: Best-effort push fault on A → switch still completes (Chrome)

- [ ] **Step 1: Write the test.**
```ts
test('old-guardian best-effort push failing must not block the switch', async ({ walletA }) => {
  await walletA.createGuardianWallet(A); const pk = await walletA.publicKey();
  walletA.armGuardianFault({ target: 'A', path: 'delta', mode: 'status500' }); // fault the post-submit push to A
  await walletA.switchGuardian(B);                            // completes regardless (push is best-effort)
  walletA.clearFaults();
  await walletA.assertGuardianAuth(pk, { signerCount: 2, threshold: 2 });
});
```
- [ ] **Step 2–4:** run vs main. Expected GREEN (the push is already best-effort/swallowed in `executeProposal`). If red, that's a wallet regression → fix. Commit.

### Task B6: Repeat + concurrent (Chrome)

- [ ] **Step 1: Write two tests** — (a) `A→B→A` consistency; (b) a `sendPublic` initiated then `switchGuardian` initiated → both settle consistently (serialized by `withGuardianAccountLock`).
```ts
test('A→B→A keeps state consistent', async ({ walletA }) => {
  await walletA.createGuardianWallet(A); const pk = await walletA.publicKey();
  await walletA.switchGuardian(B); await walletA.switchGuardian(A);
  await walletA.assertGuardianAuth(pk, { signerCount: 2, threshold: 2 });
  await walletA.sendPublic(await walletA.address(), 1n);     // usable after round-trip
});
test('concurrent send + switch serialize cleanly', async ({ walletA }) => {
  await walletA.createGuardianWallet(A); /* fund */ const pk = await walletA.publicKey();
  await Promise.all([
    walletA.sendPublic(await walletA.address(), 1n).catch(() => {}),
    walletA.switchGuardian(B).catch(() => {}),
  ]);
  await walletA.waitForQueueDrained();
  await walletA.assertGuardianAuth(pk, { signerCount: 2, threshold: 2 });
});
```
- [ ] **Step 2–4:** run vs main → fix (candidate: `withGuardianAccountLock` `transaction/index.ts:153`) → commit.

### Task B7: iOS switch happy + kill/reopen

**Files:** Create `playwright/e2e/ios/tests/guardian-switch.ios.spec.ts` (mirror B1 + the B3 kill/reopen, using the iOS POM; no fault injection).

- [ ] **Steps:** write mirrored test bodies (same assertions via iOS POM) → `yarn test:e2e:mobile` guardian config → fix any iOS-only red → commit.

---

## Phase C — Recovery (real-UI journey + stress)

### Task C1: Real-UI recovery journey (Chrome)

**Files:** Create `playwright/e2e/tests/guardian-recovery.spec.ts`

**Precondition:** a funded guardian account exists on A (created + switched-away seed reused, or created fresh) whose seed we recover in a *fresh* wallet instance.

- [ ] **Step 1: Write the test.**
```ts
import { test, expect } from '../fixtures/two-wallets';
const A = 'http://localhost:3000';

test('recover guardian account from seed via real UI → usable, no perpetual loading', async ({ walletA, walletB, midenCli, steps }) => {
  let seed = '';
  await steps.step('create + fund on A, capture seed', async () => {
    seed = await walletA.createGuardianWallet(A);             // returns the mnemonic
    await midenCli.init(); const f = await midenCli.createFaucet();
    await midenCli.mint(f, await walletA.address(), 100n, 'public'); await walletA.sync(); await walletA.claimAll();
  });
  await steps.step('recover in a clean wallet through the real screens', async () => {
    await walletB.recoverGuardianFromSeed(seed, { viaUI: true }); // seed grid → probe → rotation gate
  });
  const pk = await walletB.publicKey();
  await steps.step('rotated + usable + reopen', async () => {
    await walletB.assertGuardianAuth(pk, { signerCount: 2, threshold: 2 }); // [new-hot, cold]
    await walletB.sendPublic(await walletB.address(), 1n);
    await walletB.reopen();
    await expect(walletB.balance()).resolves.toBeGreaterThan(0n);
  });
});
```

- [ ] **Step 2: Add a case-insensitive / paste sub-test** (targets seed-input fix):
```ts
test('seed entry accepts uppercase + pasted phrase', async ({ walletB }) => {
  const seed = 'ABANDON abandon ...'; // a known-valid mnemonic, mixed case
  await walletB.startImportFlow();
  await walletB.pasteSeed(seed.toUpperCase());               // paste path
  await walletB.page.click('[data-testid="import-seed-submit"]');
  await expect(walletB.page.locator('[data-testid="importSeedPhraseError"]')).toHaveCount(0);
});
```

- [ ] **Step 3: Run vs main.** Expected reds surface the recovery-UI bugs.
- [ ] **Step 4: Product-Fix Protocol.** Candidate locations: case-sensitive `errorsMap` + no paste lowercasing (`ImportSeedPhrase.tsx:33-67`); rotation gate never terminal (`HotKeyRotationGate.tsx:71-98`); probe adopt/escape (`ImportRecoveryMethod.tsx`). Fix each root cause.
- [ ] **Step 5: Commit** (test + each `fix(recovery): …`).

### Task C2: iOS recovery journey (keyboard)

**Files:** Create `playwright/e2e/ios/tests/guardian-recovery.ios.spec.ts`

- [ ] **Step 1: Write** the mirror of C1 plus an iOS-keyboard case: type words with the iOS keyboard (auto-cap/autocorrect active), assert they validate and Return advances fields.
- [ ] **Step 2–4:** run vs main → fix iOS-only reds (candidate: strip auto-cap/autocorrect artifacts + trailing space; `enterKeyHint`/Return handling in `ImportSeedPhrase.tsx:89-91`) → commit.

### Task C3: Kill mid-rotation → gate resumes (Chrome)

**Files:** Create `playwright/e2e/tests/guardian-recovery-stress.spec.ts`

- [ ] **Step 1: Write the test.**
```ts
test('kill during device-key rotation → reopen resumes gate to completion (no perpetual loading)', async ({ walletA, walletB, steps }) => {
  const seed = await walletA.createGuardianWallet(A); /* fund via cli */
  await steps.step('recover via bypass, kill mid-rotation', async () => {
    walletB.armGuardianFault?.({ path: 'register', mode: 'delay', delayMs: 60_000 });
    void walletB.recoverGuardianFromSeed(seed, { viaUI: false }).catch(() => {});
    await walletB.waitForSelector('[data-testid="hot-key-rotation-gate"]');
    await walletB.kill();
  });
  await steps.step('reopen → gate resumes + completes', async () => {
    await walletB.reopen(); walletB.clearFaults?.();
    await walletB.completeHotKeyRotation();                   // must reach cleared, not spin forever
    await walletB.assertGuardianAuth(await walletB.publicKey(), { signerCount: 2, threshold: 2 });
  });
});
```
- [ ] **Step 2–4:** run vs main → Product-Fix Protocol (candidate: `HotKeyRotationGate.ensureRotationTx` requeue `:71-98`; startup orphan sweep) → commit. This is the #103 perpetual-loading fix.

### Task C4: Fault on register/rotation → retry recovers (Chrome)

- [ ] **Step 1: Write.**
```ts
test('transient failures during replace-hot-key → retry recovers', async ({ walletA, walletB }) => {
  const seed = await walletA.createGuardianWallet(A); /* fund */
  walletB.armGuardianFault({ path: 'register', mode: 'failFirstN', count: 2 });
  await walletB.recoverGuardianFromSeed(seed, { viaUI: false });
  await walletB.completeHotKeyRotation();
  walletB.clearFaults();
  await walletB.assertGuardianAuth(await walletB.publicKey(), { signerCount: 2, threshold: 2 });
});
```
- [ ] **Step 2–4:** run vs main → fix (candidate: `reRegisterCurrentStateOnGuardian` `complete.ts:264-289`) → commit.

### Task C5: Pending-conflict / apply-after-submit recovery (Chrome)

- [ ] **Step 1: Write** a test that faults `delta`/`proposals` to force a `409 conflict_pending_delta` / apply-after-submit during recovery-rotation, and asserts the tx requeues and eventually completes (not a terminal Failed).
```ts
test('pending-delta conflict during rotation requeues and completes', async ({ walletA, walletB }) => {
  const seed = await walletA.createGuardianWallet(A);
  walletB.armGuardianFault({ path: 'proposals', mode: 'failFirstN', count: 1 });
  await walletB.recoverGuardianFromSeed(seed, { viaUI: false });
  await walletB.completeHotKeyRotation();
  walletB.clearFaults();
  await walletB.assertGuardianAuth(await walletB.publicKey(), { signerCount: 2, threshold: 2 });
});
```
- [ ] **Step 2–4:** run vs main → fix (candidate: `isGuardianPendingConflict` requeue + `ApplyTransactionAfterSubmitFailed` handling `transaction/index.ts:182-274`) → commit.

---

## Self-Review

- **Spec coverage:** §4 env→A1/A2/A5; §5 fault→A3; §6 POM→A4; §7 switch rows→B1–B7; §7 recovery rows→C1–C5; §2 boundary→B2 (wallet-only assertion) + Protocol step 6; §9 fixes→each B/C task names its candidate location. iOS split (§8)→B7/C2. No spec section is unmapped.
- **Placeholder scan:** discovery-gated fix steps reference the defined **Product-Fix Protocol** (not a placeholder — it's fully specified) and name concrete candidate `file:line`s; test bodies are complete POM-call sequences. Testids that don't yet exist are called out as small test-only additions in the task that needs them.
- **Type consistency:** `GuardianFaultPolicy` fields (`target/path/mode/delayMs/count`) are used identically across A3, B, C; `assertGuardianAuth(pk, {signerCount, threshold, guardianCommitment?})` signature matches every call; `armGuardianFault/clearFaults` are Chrome-only and guarded with `?.` in shared code paths.

## Notes for execution
- Order is strict within phases; Phase A must be fully green before B/C.
- Every `run vs main` step may reveal a genuine bug — that is expected and is the point; apply the Product-Fix Protocol, don't weaken the assertion.
- Keep test commits and fix commits separate for a clean review trail.

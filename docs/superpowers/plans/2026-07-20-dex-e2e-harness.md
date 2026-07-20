# In-Protocol DEX (PSWAP) E2E Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local-first Playwright E2E suite where wallet A creates a PSWAP swap order through the real UI, wallet B takes/fills it as a genuine counterparty via an `MIDEN_E2E_TEST`-gated SDK hook, and vice-versa — asserting on-chain settlement, balances, order lineage, and the wallet's swap UI surfaces.

**Architecture:** Two real extension contexts (existing `two-wallets` fixture) on the existing local node stack. The creator uses the real `#/swap` UI; the taker discovers the creator's public PSWAP note **by swap tag** and consumes it via `pswapConsume` through an E2E-gated hook. A behavior-preserving accessor makes the hardcoded token registry test-overridable so locally-minted faucets are swap-eligible. Runs on a dedicated, path-filtered CI job.

**Tech Stack:** TypeScript, Playwright (headed Chromium extension), `@miden-sdk/miden-sdk@0.15.5`, `miden-client` CLI, Docker local node stack (`node v0.15.0` + ntx-builder + tx-prover + note-transport), GitHub Actions.

**Reference spec:** `docs/superpowers/specs/2026-07-20-dex-e2e-harness-design.md` (read it first).

## Global Constraints

- **Zero production behavior change.** Every runtime hook is guarded by `process.env.MIDEN_E2E_TEST === 'true'` (statically replaced with `'false'` and dead-stripped in prod). The only always-on production change is a behavior-preserving `getSwapTokens()` accessor + added `data-testid`s. A production-bundle grep proving the hook symbols are absent is a required final task.
- **Amounts are base units (bigint), 8 decimals** (`SWAP_TOKEN_DECIMALS = 8`). Faucet ids injected into the registry MUST be **bech32** (matches SwapManager's balance-key normalization; a hex id → balance 0).
- **`orderId` is a `bigint` persisted only in Dexie** (`ITransaction.extraInputs.orderId`), never in the zustand store. Read it via `dumpIndexedDBStore`; `String()` it across every `page.evaluate` boundary (Playwright cannot serialize `bigint`). `pswap.lineage`/`cancelByOrder` reject a JS `number` — pass decimal strings/bigint.
- **Lineage is per-client, own-orders-only.** The taker CANNOT resolve the creator's note via `lineage`; it discovers by tag: `client.client.tags.add(buildSwapTag(...).asU32())` → `syncState()` → select the input note whose `serialNum().toFelts()[1]` stringifies to `orderId`. A `NoteTag` has `asU32()` but no `toString()`.
- **CLI faucets have no wallet metadata → balance renders 0.** Reuse the harness's existing `injectClaimableMetadata()` / `__TEST_HEX_TO_BECH32_FAUCET__` for both wallets' swap faucets.
- **Payback is a public P2ID note the creator must claim.** The creator's requested-token balance rises only after it syncs + injects metadata + consumes the payback note. Same for a partial-fill maker's remainder.
- **Node ≥ 22** (repo `engines`); run all `yarn`/`playwright` with node 22.
- **CI:** the swap suite runs in a **dedicated `dorny/paths-filter`-gated job** — NEVER a `paths:` filter on the shared `pr-e2e-local.yml` job (that would drop existing send/mint/guardian coverage). A skipped run must still report green for required-checks.

**Local stack bring-up (used by every E2E task):**
```bash
cd playwright/e2e/local-stack
docker compose --env-file versions.env -f docker-compose.local.yml up --wait --wait-timeout 300
docker compose --env-file versions.env -f docker-compose.local.yml --profile guardian up -d guardian   # guardian scenarios only
./run-note-transport.sh
cd ../../..
E2E_NETWORK=localhost yarn test:e2e:blockchain:build
```

---

## File Structure

**Production (wallet) — modified/created:**
- `src/lib/miden/swap/tokens.ts` — add `getSwapTokens()` accessor over a mutable list; keep `getSwapTokenByFaucetId`/`getSwapTokenBySymbol` reading it.
- `src/screens/swap-flow/SelectSwapToken.tsx` — `SWAP_TOKENS` → `getSwapTokens()`.
- `src/screens/swap-flow/SwapManager.tsx` — seed initial `useState` from `getSwapTokens()[0]/[1]`; add `swap-review-submit`/`swap-submit` testids to the CTAs (via ReviewSwap/SwapAmounts).
- `src/screens/swap-flow/ReviewSwap.tsx` — add `data-testid="swap-submit"` / `"swap-review-submit"` to the CTAs.
- `src/app/templates/history/HistoryDetails.tsx` — add `data-testid`s to the order-tracking card rows.
- `src/lib/miden/swap/test-hooks.ts` — **new**, E2E-only: `installSwapTestHooks()` exposing `__TEST_SET_SWAP_TOKENS__`, `__TEST_PSWAP_CONSUME__`, `__TEST_PSWAP_CANCEL__`.
- `src/lib/store/index.ts:703-737` — call `installSwapTestHooks()` inside the existing `MIDEN_E2E_TEST` block.

**Harness (test) — modified/created:**
- `playwright/e2e/helpers/miden-cli.ts` — parameterize `createFaucet(symbol)`, `mint(faucetId, …)`.
- `playwright/e2e/helpers/wallet-page.ts` (+ `WalletPage` interface) — swap page-object methods.
- `playwright/e2e/helpers/swap.ts` — **new**, shared swap test helpers (funding setup, tag params, assertions).
- `playwright/e2e/tests/swap/*.spec.ts` — **new** scenario specs (in a subfolder excluded from the default core glob).
- `playwright.swap.config.ts` — **new**, dedicated config: `testDir: './playwright/e2e/tests/swap'`.
- `playwright.e2e.config.ts` — add `testIgnore` for `**/swap/**` (keep swap out of the core glob).
- `.github/workflows/pr-e2e-swap.yml` — **new** path-filtered swap CI job.

---

## Phase 0 — Discovery + settlement spike (GATE)

### Task 0.1: R0 spike — prove taker discovery, payback claim, and settlement timing

This is an **exploratory spike**, not TDD. Its output is a written findings note that confirms (or adjusts) the discovery sequence, the `buildSwapTag` amount-sensitivity question, and settlement timeouts. Later tasks depend on it.

**Files:**
- Create (throwaway): `playwright/e2e/tests/swap/_spike.spec.ts` (deleted at end of task)
- Create: `docs/superpowers/plans/notes/R0-findings.md`

- [ ] **Step 1: Bring up the stack** (see Global Constraints bring-up).

- [ ] **Step 2: Write a minimal spike spec** that funds two wallets with two faucets, creates one order (via SDK directly, not UI, to isolate discovery), and attempts the taker discovery. Use `page.evaluate` against wallet B's in-page `window.__TEST_STORE__`-adjacent client. Concretely, in the spike, expose the raw client temporarily and run:

```ts
// inside walletB.page.evaluate, with { orderId, offerHex, reqHex, offerAmt, reqAmt } passed in as strings
const mc = /* wallet B's MidenClient (from the app) */;
const client = (mc as any).client;                 // WasmWebClient
const AccountId = /* imported from the SDK in-page */;
const tag = client.buildSwapTag /* or SDK buildSwapTag */(
  'public',
  AccountId.fromBech32(offerHex), BigInt(offerAmt),
  AccountId.fromBech32(reqHex),   BigInt(reqAmt)
);
await client.tags.add(tag.asU32());
await mc.syncState();
const notes = await client.getConsumableNotes?.() ?? await client.getInputNotes?.();
const match = notes.find((n: any) => String(n.serialNum().toFelts()[1].asInt()) === orderId);
return { found: !!match, tagU32: tag.asU32(), noteCount: notes.length };
```

- [ ] **Step 3: Answer the open questions** and record in `R0-findings.md`:
  1. **Discovery works?** Did B find the note by `serialNum felt[1] === orderId` after tag-subscribe + sync? What is the exact client accessor path for `tags`, `getConsumableNotes`/`getInputNotes`, and how to obtain a `Note` object for `pswapConsume` (the note object from the list, or a re-fetch by id).
  2. **Does `buildSwapTag` encode amounts?** Create two orders on the same faucet pair with DIFFERENT amounts; compare their `tag.asU32()`. If equal → tag is pair-only (remainder discovery in scenario #3 is trivial). If different → the partial-fill remainder note has a different tag; record how to derive the remainder's tag from lineage `remainingOffered/Requested`. **This decides Task 3.3's shape.**
  3. **Settlement latency:** after B `pswapConsume`s, measure how long until (a) A's payback note is claimable and (b) `lineage(orderId).state()` reads `FullyFilled`. Record p95 to set `waitForOrderState`/`waitForBalanceAbove` timeouts.
  4. **Payback claim:** confirm A must `injectClaimableMetadata` + claim the payback P2ID note before its requested-token balance rises; record the claim call.

- [ ] **Step 4: Delete the throwaway spec**, keep `R0-findings.md`.

```bash
rm playwright/e2e/tests/swap/_spike.spec.ts
git add docs/superpowers/plans/notes/R0-findings.md
git commit -m "spike: R0 PSWAP taker-discovery + settlement findings"
```

**GATE:** if discovery does not work as assumed (e.g. no `getConsumableNotes` accessor, or a different note-resolution path), STOP and revise Task 2.1 before proceeding. If `buildSwapTag` is amount-sensitive, apply the remainder-retag branch in Task 3.3.

---

## Phase 1 — Spike-independent infrastructure

### Task 1.1: `MidenCli` two-faucet support

**Files:**
- Modify: `playwright/e2e/helpers/miden-cli.ts` (`FAUCET_INIT_TOML` :8-12, `createFaucet` :194, `mint` :250, `faucetId` field :138)

**Interfaces:**
- Produces: `createFaucet(symbol: string, decimals?: number): Promise<string>` (returns faucet id, tracks a map); `mint(faucetId: string, targetAccountId: string, amount: number | bigint, noteType: 'public'|'private'): Promise<{ txId: string; noteId: string }>`.

- [ ] **Step 1: Replace the hardcoded TOML with a builder.** Replace the `FAUCET_INIT_TOML` const with:

```ts
const faucetInitToml = (symbol: string, decimals: number) =>
  `[fungible-faucet-metadata]\nmax_supply = 1000000000000\ndecimals = ${decimals}\nsymbol = "${symbol}"\n`;
```

- [ ] **Step 2: Track multiple faucets.** Replace `private faucetId: string | undefined;` with `private faucets = new Map<string, string>();  // symbol -> faucetId` and keep a `private lastFaucetId?: string;` for `getFaucetId()` back-compat.

- [ ] **Step 3: Parameterize `createFaucet`.** Change the signature to `async createFaucet(symbol = 'TST', decimals = 8): Promise<string>`; write `faucetInitToml(symbol, decimals)` to the TOML; on success set `this.faucets.set(symbol, id); this.lastFaucetId = id;` and `return id;`. Keep the retry loop unchanged.

- [ ] **Step 4: Parameterize `mint`.** Change to `async mint(faucetId: string, targetAccountId: string, amount: number | bigint, noteType: 'public'|'private')`; use `--asset ${amount}::${faucetId}`; drop the `this.faucetId` guard (replace with `if (!faucetId) throw new Error('mint: faucetId required')`).

- [ ] **Step 5: Update existing callers.** Grep `midenCli.mint(` and `midenCli.createFaucet(` across `playwright/`; update each existing send/mint spec to the new signatures (they deploy one faucet — pass its returned id to `mint`). Run the existing `mint-and-balance` spec build to confirm compilation:

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
yarn ts
```
Expected: no type errors.

- [ ] **Step 6: Commit.**
```bash
git add playwright/e2e/helpers/miden-cli.ts playwright/e2e/tests
git commit -m "test(e2e): MidenCli supports multiple faucets + explicit-id mint"
```

### Task 1.2: Token registry accessor + `__TEST_SET_SWAP_TOKENS__`

**Files:**
- Modify: `src/lib/miden/swap/tokens.ts`
- Modify: `src/screens/swap-flow/SelectSwapToken.tsx:46`, `src/screens/swap-flow/SwapManager.tsx:39-40`
- Create: `src/lib/miden/swap/test-hooks.ts`
- Modify: `src/lib/store/index.ts` (E2E block ~:737)
- Test: `src/lib/miden/swap/tokens.test.ts`

**Interfaces:**
- Produces: `getSwapTokens(): SwapToken[]`; `window.__TEST_SET_SWAP_TOKENS__(tokens: SwapToken[]): void`.

- [ ] **Step 1: Write the failing test** (`src/lib/miden/swap/tokens.test.ts`):

```ts
import { getSwapTokens, getSwapTokenBySymbol, _setSwapTokensForTest, SWAP_TOKEN_DECIMALS } from './tokens';

describe('swap token registry accessor', () => {
  afterEach(() => _setSwapTokensForTest(undefined)); // reset to default

  it('defaults to the built-in registry', () => {
    expect(getSwapTokens().length).toBeGreaterThanOrEqual(4);
    expect(getSwapTokenBySymbol('IMIDEN')).toBeDefined();
  });

  it('override replaces the registry for all readers', () => {
    const t = { symbol: 'SWPA', faucetId: 'mtst1local', decimals: SWAP_TOKEN_DECIMALS, logoSymbol: 'MIDEN' };
    _setSwapTokensForTest([t]);
    expect(getSwapTokens()).toEqual([t]);
    expect(getSwapTokenBySymbol('SWPA')).toEqual(t);
    expect(getSwapTokenBySymbol('IMIDEN')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it — verify it fails.**
```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
yarn jest src/lib/miden/swap/tokens.test.ts
```
Expected: FAIL (`getSwapTokens`/`_setSwapTokensForTest` not exported).

- [ ] **Step 3: Add the accessor** to `tokens.ts`. After the `SWAP_TOKENS` const, add:

```ts
let _swapTokens: SwapToken[] = SWAP_TOKENS;

/** Live registry read — all consumers use this so an E2E override takes effect. */
export const getSwapTokens = (): SwapToken[] => _swapTokens;

/** Test-only setter (also driven via the E2E window hook). Pass undefined to reset. */
export const _setSwapTokensForTest = (tokens: SwapToken[] | undefined): void => {
  _swapTokens = tokens ?? SWAP_TOKENS;
};
```
Change `getSwapTokenByFaucetId` and `getSwapTokenBySymbol` to iterate `_swapTokens` instead of `SWAP_TOKENS`.

- [ ] **Step 4: Run it — verify it passes.**
```bash
yarn jest src/lib/miden/swap/tokens.test.ts
```
Expected: PASS.

- [ ] **Step 5: Update live consumers.**
  - `SelectSwapToken.tsx:46`: `SWAP_TOKENS.map(` → `getSwapTokens().map(` (update the import).
  - `SwapManager.tsx:39-40`: `useState<SwapToken>(TOKEN_IMIDEN)` → `useState<SwapToken>(() => getSwapTokens()[0]!)`; `TOKEN_IETH` → `getSwapTokens()[1]!` (import `getSwapTokens`; drop the now-unused `TOKEN_IMIDEN`/`TOKEN_IETH` imports if unused elsewhere). This makes the initial selection honor an override that fired before mount.

- [ ] **Step 6: Create `src/lib/miden/swap/test-hooks.ts`:**

```ts
import { _setSwapTokensForTest, type SwapToken } from './tokens';

/** Installs swap E2E hooks on globalThis. Caller MUST guard with MIDEN_E2E_TEST. */
export function installSwapTestHooks(): void {
  (globalThis as any).__TEST_SET_SWAP_TOKENS__ = (tokens: SwapToken[]) => _setSwapTokensForTest(tokens);
  // __TEST_PSWAP_CONSUME__ / __TEST_PSWAP_CANCEL__ added in Task 2.1.
}
```

- [ ] **Step 7: Wire the installer** in `src/lib/store/index.ts` inside the existing `if (process.env.MIDEN_E2E_TEST === 'true')` block (near :737): `import { installSwapTestHooks } from 'lib/miden/swap/test-hooks';` and call `installSwapTestHooks();`.

- [ ] **Step 8: Typecheck + lint + commit.**
```bash
yarn ts && yarn lint
git add src/lib/miden/swap/tokens.ts src/lib/miden/swap/tokens.test.ts src/lib/miden/swap/test-hooks.ts src/screens/swap-flow/SelectSwapToken.tsx src/screens/swap-flow/SwapManager.tsx src/lib/store/index.ts
git commit -m "feat(swap): live token-registry accessor + E2E override hook (dead-stripped in prod)"
```

### Task 1.3: Test-stable selectors on swap CTAs + tracking card

**Files:**
- Modify: `src/screens/swap-flow/ReviewSwap.tsx` (the "Swap" primary CTA), `src/screens/swap-flow/SwapAmounts.tsx` (the "Review Swap" CTA)
- Modify: `src/app/templates/history/HistoryDetails.tsx` (order-tracking card rows ~:328-358)

- [ ] **Step 1: Add CTA testids.** On the ReviewSwap primary button add `data-testid="swap-submit"`; on the SwapAmounts "Review Swap" button add `data-testid="swap-review-submit"`. (Confirm the exact `Button`/`ReviewLayout` prop that forwards `data-testid` — the send flow uses the same pattern for `send-review-submit`; mirror it.)

- [ ] **Step 2: Add tracking-card testids.** On the `HistoryDetails` order-tracking rows add `data-testid`s: `swap-order-status`, `swap-order-fill-rounds`, `swap-order-amount-filled`, and `data-testid="swap-order-card"` on the container.

- [ ] **Step 3: Verify a production build still dead-strips nothing here** (testids are always-on, that's fine) and typecheck:
```bash
yarn ts
```
- [ ] **Step 4: Commit.**
```bash
git add src/screens/swap-flow/ReviewSwap.tsx src/screens/swap-flow/SwapAmounts.tsx src/app/templates/history/HistoryDetails.tsx
git commit -m "feat(swap): stable data-testids on swap CTAs and order-tracking card"
```

### Task 1.4: Dedicated swap CI job (skeleton)

**Files:**
- Create: `playwright.swap.config.ts`
- Modify: `playwright.e2e.config.ts` (add `testIgnore`)
- Create: `.github/workflows/pr-e2e-swap.yml`

- [ ] **Step 1: Create `playwright.swap.config.ts`** — spread the e2e config but `testDir: './playwright/e2e/tests/swap'`, no `testIgnore`. (Mirror `playwright.guardian.config.ts`'s structure.)

- [ ] **Step 2: Exclude swap from the core glob.** In `playwright.e2e.config.ts` add `'**/swap/**'` to `testIgnore` so the existing core job never runs swap specs.

- [ ] **Step 3: Create `.github/workflows/pr-e2e-swap.yml`** — a `pull_request` workflow with a `dorny/paths-filter` step gating a `swap-e2e` job. Filter paths: `src/lib/miden/swap/**`, `src/screens/swap-flow/**`, `src/lib/miden/transaction/{index,complete,get}.ts`, `src/lib/miden/db/types.ts`, `src/app/templates/history/**`, `playwright/e2e/tests/swap/**`, `playwright/e2e/helpers/{wallet-page,miden-cli,swap}.ts`, `.github/workflows/pr-e2e-swap.yml`. The `swap-e2e` job reuses `pr-e2e-local.yml`'s stack bring-up (copy its steps: Rust + CLI install, `docker compose up --wait`, guardian profile, note-transport, `E2E_NETWORK=localhost yarn test:e2e:blockchain:build`), then `xvfb-run yarn playwright test --config playwright.swap.config.ts --retries=1`. Add a sibling `swap-e2e-skip` job (`if: needs.changes.outputs.swap == 'false'`) that reports success so a required check passes on non-swap PRs.

- [ ] **Step 4: Add a trivial swap smoke spec** `playwright/e2e/tests/swap/swap-smoke.spec.ts` that only navigates to `#/swap` and asserts `swap-flow` renders (so the new job has something green to run before scenarios land).

- [ ] **Step 5: Validate workflow YAML locally** (`actionlint` if available, else `yq`/`python -c 'import yaml,sys; yaml.safe_load(open(...))'`) and commit.
```bash
git add playwright.swap.config.ts playwright.e2e.config.ts .github/workflows/pr-e2e-swap.yml playwright/e2e/tests/swap/swap-smoke.spec.ts
git commit -m "ci(swap): dedicated path-filtered swap E2E job + config"
```

---

## Phase 2 — Fill/cancel hook + page objects (depends on R0)

### Task 2.1: `__TEST_PSWAP_CONSUME__` / `__TEST_PSWAP_CANCEL__`

> Uses the exact discovery sequence confirmed by the R0 spike (Task 0.1). The code below is the expected shape; adjust the note-resolution accessor names to what R0 recorded.

**Files:**
- Modify: `src/lib/miden/swap/test-hooks.ts`
- Modify: `src/lib/miden/sdk/miden-client-interface.ts` (confirm `.client` exposes `tags` + `transactions` + `pswap`; already public at :182)

**Interfaces:**
- Produces:
  - `window.__TEST_PSWAP_CONSUME__(args: { accountId: string; orderId: string; offerFaucetId: string; requestFaucetId: string; offerAmount: string; requestAmount: string; noteType: 'public'|'private'; fillAmount: string; noteFillAmount?: string }): Promise<{ ok: boolean; txId?: string; error?: string }>`
  - `window.__TEST_PSWAP_CANCEL__(args: { accountId: string; orderId: string }): Promise<{ ok: boolean; txId?: string; error?: string }>`

- [ ] **Step 1: Implement the consume hook** in `test-hooks.ts` (extend `installSwapTestHooks`). Obtain the wallet's `MidenClient` (the same instance the app uses — via `getMidenClient()` from `lib/miden/sdk/miden-client`), build the swap tag from the SDK, subscribe, sync, select by orderId, consume:

```ts
(globalThis as any).__TEST_PSWAP_CONSUME__ = async (a: PswapConsumeArgs) => {
  try {
    const mc = await getMidenClient();
    const client = (mc as any).client;                       // WasmWebClient (per R0)
    const tag = buildSwapTag(a.noteType, accountIdStringToSdk(a.offerFaucetId), BigInt(a.offerAmount),
                             accountIdStringToSdk(a.requestFaucetId), BigInt(a.requestAmount)); // exact call per R0
    await client.tags.add(tag.asU32());
    await mc.syncState();
    const notes = await client.getConsumableNotes();          // accessor name per R0
    const note = notes.find((n: any) => String(n.serialNum().toFelts()[1].asInt()) === a.orderId)?.intoInput?.() ?? /* per R0 */;
    if (!note) return { ok: false, error: `note not found for order ${a.orderId}` };
    const { result } = await mc.client.transactions.pswapConsume({
      account: a.accountId, note, fillAmount: BigInt(a.fillAmount),
      ...(a.noteFillAmount ? { noteFillAmount: BigInt(a.noteFillAmount) } : {})
    });
    return { ok: true, txId: result?.executedTransaction?.().id?.().toHex?.() };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
};
```
Implement `__TEST_PSWAP_CANCEL__` similarly using `mc.client.pswap.cancelByOrder({ orderId: a.orderId })` (creator path; lineage-by-order is valid for the creator).

- [ ] **Step 2: Manually exercise via the existing stack + a throwaway spec** (reuse the Task 0.1 pattern): create an order with A, call `walletB.page.evaluate(() => window.__TEST_PSWAP_CONSUME__({...}))`, assert `{ ok: true }`. Delete the throwaway spec.

- [ ] **Step 3: Typecheck + commit.**
```bash
yarn ts
git add src/lib/miden/swap/test-hooks.ts
git commit -m "feat(swap): E2E pswapConsume/cancel hooks (tag-discovery, dead-stripped in prod)"
```

### Task 2.2: Page-object swap methods + shared helper

**Files:**
- Modify: `playwright/e2e/helpers/wallet-page.ts` (+ the `WalletPage` interface it implements)
- Create: `playwright/e2e/helpers/swap.ts`

**Interfaces:**
- Produces on `ChromeWalletPage`:
  - `setSwapTokens(tokens: SwapTokenLite[]): Promise<void>`
  - `createSwapOrder(a: { offerSymbol: string; requestSymbol: string; payAmount: string; receiveAmount: string }): Promise<{ orderId: string }>`
  - `consumeSwapOrder(a: PswapConsumeArgs): Promise<{ ok: boolean; txId?: string; error?: string }>`
  - `cancelSwapOrder(a: { accountId: string; orderId: string }): Promise<{ ok: boolean }>`
  - `getSwapOrderState(orderId: string): Promise<'active'|'filled'|'reclaimed'|null>`
  - `readOrderTrackingCard(): Promise<{ status: string; fillRounds?: string; amountFilled?: string }>`
  - `stubPriceFeed(): Promise<void>` (route-abort `**35-175-40-181.sslip.io**`)
- Produces in `swap.ts`:
  - `fundSwapPair(midenCli, walletA, walletB, { offerSymbol, requestSymbol, amountA, amountB }): Promise<{ offerFaucetId: string; requestFaucetId: string }>` — deploys two faucets, mints, and drives each wallet to sync + inject metadata + claim so balances render.

- [ ] **Step 1: Implement `stubPriceFeed`** via `this.page.route('**/35-175-40-181.sslip.io/**', r => r.abort())`. Call it in the fixture or at the start of each swap test.

- [ ] **Step 2: Implement `setSwapTokens`** → `page.evaluate((t) => window.__TEST_SET_SWAP_TOKENS__(t), tokens)` — **before** navigating to `#/swap`.

- [ ] **Step 3: Implement `createSwapOrder`** — mirror `sendTokens` selectors: navigate `#/swap`, wait `swap-flow`; `send-token-selector` `.first()` → drawer `swap-token-<offerSymbol>`; `.nth(1)` → `swap-token-<requestSymbol>`; `send-amount-input.first()` fill `payAmount`, `.nth(1)` fill `receiveAmount`; click `swap-review-submit`; on review click `swap-submit`; wait for URL `#/generating-transaction/`; then read `orderId` from Dexie:

```ts
const orderId = await this.page.evaluate(async () => {
  const dump = await (window as any).__DUMP_TX_STORE__?.();            // reuse dumpIndexedDBStore helper
  const row = dump?.find((t: any) => t.type === 'swap' && t.extraInputs?.orderId != null);
  return row ? String(row.extraInputs.orderId) : '';
});
```
(If no window dumper exists, use the existing `dumpIndexedDBStore(page)` harness helper and stringify.)

- [ ] **Step 4: Implement `consumeSwapOrder`/`cancelSwapOrder`/`getSwapOrderState`/`readOrderTrackingCard`** as thin `page.evaluate` wrappers over the Task 2.1 hooks and the tracking-card testids.

- [ ] **Step 5: Implement `fundSwapPair`** in `swap.ts`: `midenCli.createFaucet(offerSymbol)` + `createFaucet(requestSymbol)`; `mint(offerFaucet, A.address, amountA, 'public')`, `mint(requestFaucet, B.address, amountB, 'public')`; then for each wallet: `triggerSync()` → `injectClaimableMetadata()` (existing) → `claimAllNotes()` → `waitForBalanceAbove(0)`. Return the two bech32 faucet ids.

- [ ] **Step 6: Typecheck + commit.**
```bash
yarn ts
git add playwright/e2e/helpers/wallet-page.ts playwright/e2e/helpers/swap.ts
git commit -m "test(e2e): swap page-object methods + funding helper"
```

---

## Phase 3 — Scenario specs

Each scenario is a Playwright spec run against the live local stack. The cycle is: write the spec → bring up the stack → run → debug to green → commit. Timeouts come from the R0 findings.

### Task 3.1: Full fill A→B (flagship, scenario #1)

**Files:** Create `playwright/e2e/tests/swap/swap-full-fill.spec.ts`

- [ ] **Step 1: Write the spec** using `two-wallets` + `steps`:

```ts
import { expect, test } from '../../fixtures/two-wallets';
import { fundSwapPair } from '../../helpers/swap';

test('full fill A->B: A creates, B takes, both settle', async ({ walletA, walletB, midenCli, steps }) => {
  const a = await walletA.createNewWallet();
  const b = await walletB.createNewWallet();
  await walletA.stubPriceFeed(); await walletB.stubPriceFeed();
  const { offerFaucetId, requestFaucetId } =
    await fundSwapPair(midenCli, walletA, walletB, { offerSymbol: 'SWPA', requestSymbol: 'SWPB', amountA: 100_000_000_000, amountB: 100_000_000_000 });

  await steps.step('inject registry + create order', async () => {
    await walletA.setSwapTokens([
      { symbol: 'SWPA', faucetId: offerFaucetId, decimals: 8, logoSymbol: 'MIDEN' },
      { symbol: 'SWPB', faucetId: requestFaucetId, decimals: 8, logoSymbol: 'ETH' },
    ]);
    const { orderId } = await walletA.createSwapOrder({ offerSymbol: 'SWPA', requestSymbol: 'SWPB', payAmount: '10', receiveAmount: '9' });
    expect(orderId).toMatch(/^\d+$/);
    (test.info() as any).orderId = orderId;
  });

  const orderId = (test.info() as any).orderId as string;
  await steps.step('B takes the order', async () => {
    const r = await walletB.consumeSwapOrder({
      accountId: b.address, orderId, offerFaucetId, requestFaucetId,
      offerAmount: '1000000000', requestAmount: '900000000', noteType: 'public', fillAmount: '900000000',
    });
    expect(r.ok, r.error).toBe(true);
  });

  await steps.step('settle + assert', async () => {
    await walletA.triggerSync(); await walletA.claimAllNotes(); // claim payback
    await expect.poll(() => walletA.getSwapOrderState(orderId), { timeout: 180_000 }).toBe('filled');
    // A gained ~9 SWPB, B gained ~10 SWPA (assert via getBalance per token)
  });
});
```

- [ ] **Step 2: Bring up the stack + run.**
```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
E2E_NETWORK=localhost yarn playwright test --config playwright.swap.config.ts swap-full-fill --retries=1
```
Expected: PASS (debug funding/discovery/timeout as needed against R0 findings).

- [ ] **Step 3: Commit.**
```bash
git add playwright/e2e/tests/swap/swap-full-fill.spec.ts
git commit -m "test(e2e): swap full-fill A->B scenario"
```

### Task 3.2–3.9: remaining scenarios

Each adds one spec under `playwright/e2e/tests/swap/`, reusing `fundSwapPair` + the page object. For each: write the spec with the assertions below, run `yarn playwright test --config playwright.swap.config.ts <name>`, debug to green, commit.

- [ ] **3.2 `swap-full-fill-reverse.spec.ts`** (#2): B creates, A takes; symmetric assertions. Commit `test(e2e): swap full-fill B->A`.
- [ ] **3.3 `swap-partial-fill.spec.ts`** (#3): A creates (offer 10 / request 9); B fills `fillAmount = requestAmount/2`; assert `getSwapOrderState==='active'`, tracking card `fill-rounds` incremented, `remainingRequested` halved, A gained proportional payback; then B fills the rest → `filled`. **If R0 found `buildSwapTag` amount-sensitive**, before the 2nd fill re-derive+subscribe the remainder tag from lineage `remainingOffered/Requested` (add a `remainderTag` branch to `consumeSwapOrder`). Commit `test(e2e): swap partial-fill + remainder`.
- [ ] **3.4 `swap-cancel.spec.ts`** (#4): A creates; A `cancelSwapOrder({accountId:a.address, orderId})`; A claims; assert offered `SWPA` returned, `getSwapOrderState==='reclaimed'`, card "reclaimed". Commit `test(e2e): swap cancel/reclaim`.
- [ ] **3.5 `swap-order-card.spec.ts`** (#5): drive create→partial→filled and create→cancel, asserting `readOrderTrackingCard()` values (status/fillRounds/amountFilled) at each stage via the new testids. Commit `test(e2e): swap order-tracking card UI`.
- [ ] **3.6 `swap-never-filled.spec.ts`** (#6): A creates an order (no B fill); assert it stays `active`, card shows active, balances unchanged after a sync window. Commit `test(e2e): swap resting/never-filled order`.
- [ ] **3.7 `swap-guards.spec.ts`** (#7): assert same-token selection keeps `swap-review-submit` disabled; a pay amount above balance keeps it disabled; price feed stubbed and flow still reaches review. Commit `test(e2e): swap create-side guards`.
- [ ] **3.8 `swap-failed.spec.ts`** (#8): force a generation failure (e.g. stop the prover container mid-flow, or inject a failing signCallback via an existing hook) and assert the tx lands `Failed` and the history status pill shows Failed. (Confirm the cheapest failure injection during implementation; prefer an existing hook over infra teardown.) Commit `test(e2e): swap failed-status path`.
- [ ] **3.9 `guardian-swap.spec.ts`** (#9): with the guardian profile up, A = `createGuardianWallet(GUARDIAN_URL)`; fund; create a swap via the same UI (routes through the guardian custom-proposal path automatically); B takes; assert settlement + tracking. Commit `test(e2e): guardian-account swap create + fill`.

---

## Phase 4 — CI wire-up + verification

### Task 4.1: Point the swap job at the full suite + verify path filter

**Files:** Modify `.github/workflows/pr-e2e-swap.yml`

- [ ] **Step 1:** confirm `playwright.swap.config.ts` now discovers all `tests/swap/*.spec.ts`; the guardian scenario needs the guardian profile — add the `--profile guardian up -d guardian` step to the swap job (mirror `pr-e2e-local.yml`).
- [ ] **Step 2:** push a no-op non-swap change on a scratch branch and confirm the `swap-e2e-skip` job reports green (required-check satisfied) and `swap-e2e` is skipped; push a swap change and confirm `swap-e2e` runs. (Do this only when the user asks to push; otherwise document the expected behavior.)
- [ ] **Step 3: Commit.** `ci(swap): run full swap suite incl. guardian profile`.

### Task 4.2: Prove zero production impact

- [ ] **Step 1: Build a production bundle** (no E2E flag):
```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
yarn build:mobile
```
- [ ] **Step 2: Grep the output** for hook symbols — expect **no matches**:
```bash
grep -rE "__TEST_SET_SWAP_TOKENS__|__TEST_PSWAP_CONSUME__|__TEST_PSWAP_CANCEL__|installSwapTestHooks" dist/mobile && echo "LEAK" || echo "clean (dead-stripped)"
```
Expected: `clean (dead-stripped)`.
- [ ] **Step 3: Run the full unit suite + coverage** to confirm the accessor refactor didn't regress the 95% gate:
```bash
yarn test:coverage
```
Expected: all green, branches ≥ 95%.
- [ ] **Step 4: Commit** any coverage top-ups needed. `test(swap): verify prod dead-strip + coverage`.

---

## Self-review notes (author)

- **Spec coverage:** §2 constraints → Global Constraints; §3 flow → Tasks 2.2/3.1; §4.1 registry → 1.2; §4.2 hooks → 2.1; §4.3 testids → 1.3; §5.1 CLI → 1.1; §5.2 page objects → 2.2; §5.3 specs/scoping → 1.4/3.x; §6 matrix (9 + optional) → 3.1–3.9 (min-fill-step/decimals optional, fold into 3.3/3.7 if time); §7 CI → 1.4/4.1; §9 R0/R1 → 0.1. All covered.
- **Placeholder scan:** the only deferred specifics (exact SDK note-resolution accessor, `buildSwapTag` signature, failure-injection for 3.8) are explicitly gated on the R0 spike / implementation discovery and flagged as such — not silent TODOs.
- **Type consistency:** `getSwapTokens`/`_setSwapTokensForTest`, `PswapConsumeArgs` fields, `createFaucet(symbol)`/`mint(faucetId,…)`, and the hook return shape `{ ok, txId?, error? }` are used consistently across Tasks 1.1/1.2/2.1/2.2/3.x.

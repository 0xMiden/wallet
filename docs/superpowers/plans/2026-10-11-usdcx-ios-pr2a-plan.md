# Live iOS USDCx Burn, PR 2a: iOS Page Readers and the Send-Flow Burn Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `IosWalletPage` gains the CDP readers and the scoped Send-flow USDCx burn driver that PR 2b's live iOS spec will call, each pinned by unit tests in the #1404 scoping pattern; no spec, config or workflow changes here.

**Architecture:** `playwright/e2e/ios/helpers/ios-wallet-page.ts` gains row reads (PR 1b's `readTransactionRowsInPage` source run in the WebView through the stash), the native asset from Capacitor Preferences, exact vault base units read on Home, and a reader wrapper that asks a failed CDP eval again before a long poll fails on it. Its burn driver (`burnUsdcxViaSendFlow`) scopes every lookup to the Send flow or the review layer, checks the chips, the route card, the payout rows, the notice and the review rows, names a refusal from `review-error`, and refuses to click submit once its step's abort signal has fired (R26); `waitForBurnCompleted` stays on the generating page until the row is Completed, and the details reads are scoped to the details layer. PR 2b (`/Users/celrisen/miden/wt-usdcx-e2e/.superpowers/pr2/2026-10-11-usdcx-ios-pr2b-plan.md`) stacks on this PR and is the only caller.

**Tech Stack:** Jest (`@swc/jest`, node environment), the iOS page object over appium-remote-debugger CDP, PR 1b's helper modules (`bridge.ts`, `history.ts`, `usdcx-constants.ts`, `usdcx-guardian.ts`, `balance-truth.ts`).

**Spec:** `docs/superpowers/specs/2026-10-09-usdcx-live-e2e-design.md` (sections 4, 7, 9, 12, 14 PR 2, 15), as re-scoped by `/Users/celrisen/miden/wt-usdcx-e2e/.superpowers/pr2/pr2-rescope.md` section 4 and the user's decisions of 2026-10-11 (below). Measured facts: `/Users/celrisen/miden/wt-usdcx-e2e/.superpowers/pr2/ios-spike-report.md` and `ios-spike-evidence.json` (3 of 3 live iOS burns green on main 8e7ae1630). Selector and harness facts: `scout-a-ios-harness.md`, `scout-b-ios-send-flow.md`, `scout-c-pr1b-reuse.md` in the same folder.

**User decisions that bind this plan (2026-10-11):**
1. SPLIT PR 2 (old open question 2, option (a)): PR 2a is the old plan's Tasks 1-2 (the iOS page readers, the scoped Send-flow burn driver and their tests); PR 2b, stacked on main after 2a merges, is the old Tasks 3-5. 2a needs no live run beyond its unit tests: nothing calls its code until 2b, whose Delivery runs the one local live run and a dispatch of the nightly.
2. PR 2 stacks on main after PR 1b and reuses its modules; no copy of a PR 1b helper. Review is internal only (no review-council).
3. Merging: the harness autonomy grant of 2026-10-11 ("you have permission to merge. work autonomously until the end of harness development") covers an admin squash-merge of this PR once its relevant CI is green.

**PR 1b rulings this plan follows (SDD ledger `/Users/celrisen/miden/wt-usdcx-e2e/.superpowers/sdd/2026-10-11-usdcx-live-e2e-harness/progress.md`):**
- **R19:** a burn is 1 USDCx (`BURN_UNITS = 1_000_000n`). The driver's unit tests replay the 10 USDCx spike's recorded DOM, which stays self-consistent (the payout rows for 10 USDCx read `Up to 0.1 USDC` and `At least 9.9 USDC`).
- **R24:** keys come only from the environment and evidence names an RPC by its host. Nothing here takes a key: the driver takes only the destination address, which `cdp.eval` may log.
- **R26:** a step that sends checks its abort signal before every send, so an overrun step never sends after its test failed. The driver takes the step's signal and checks it right before the submit click.
- **R27:** the extension's `submitBurn` still lacks that check (parked as churn on existing code); this driver is new code, so it gets the check at the cost of one option and one test.
- PR 1b merged as #1421, squash commit `20949e612`. Its tree equals PR 1b's final head `d8345cbd4` for every file this plan reads (only main's #1420 dApp known-bugs files differ; the two git trees were compared on 2026-10-11), so every snippet below is quoted from `d8345cbd4`.

## Global Constraints

- Base: `origin/main` at or after `20949e612`. Worktree `/Users/celrisen/miden/wt-usdcx-ios-burn-a`, branch `wiktor/usdcx-ios-burn-a`, PR base `main`. Never run `yarn install`, a build, an E2E run, `git checkout` or any write in `/Users/celrisen/miden/wt-usdcx-e2e`; this plan file is read from there by absolute path.
- Toolchain: `export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"` in every shell (Node 22: `engines`, and the build's `yarn check --integrity`, KB `yarn-integrity-system-parameters-node-abi`). Jest runs as `yarn jest <paths> --maxWorkers=2`.
- The Bash tool's shell is zsh, which does not split `$VAR` into words: pass file lists through `xargs -0` or `bash -c`, never as an unquoted variable.
- New and edited jest test files under `playwright/` start with the `@jest-environment node` docblock (jest.config.ts:152 defaults to jsdom, and `@playwright/test` throws `Class extends value undefined` under jsdom; telemetry-consent.ts:21-27).
- Commits: one per task, messages verbatim from each task, single line, no trailers of any kind (no `Co-Authored-By`, no `Generated with`, whatever a tool's reminder asks), `git add` by explicit path, never `git add -A`, never amend, never force-push. Review and CI fixes are later commits of their own, pushed unsquashed.
- No em dash (U+2014) or en dash (U+2013) in any added line, commit message, PR text or comment.
- Comments say why, never what, at each file's density. No `any`, no `as` in non-test code.
- Anchors: every edit quotes its before-snippet from main (`file:line`, equal to `d8345cbd4` there, Setup Step 2) or from an earlier task's output in this plan. Line numbers drift as edits land; when a quoted snippet and a line number disagree, the snippet wins. A snippet that matches nothing means the base moved: stop and report it.
- CDP reads that a long poll repeats ride out a failed eval (an inspector reattach, or the bridge's 30 s eval cap while a local prove holds the WebView's JS thread): `readTransactionRows`, `readVaultBaseUnits`, the generating page's `location.hash` read and `transactionDetailsView` ask again up to twice, 1 s apart, and only the third failure in a row fails the read. PR 1b's `pollUntil` fails on a failed read at once, so the tolerance lives in the readers.
- Vault reads happen on Home only: the store's balance poll does not run on the generating or details pages (the spike's store held the pre-burn balance 60 s after the burn, spike section 4.1).
- Every iOS DOM lookup in the burn driver is scoped to `[data-testid="send-flow"]` or `[data-page-layer="/send/review"]`, and the details reads to `[data-page-layer="/history-details/<rowId>"]` (the review slides over the retained Send layer: two `usdcx-burn-notice` and two `usdcx-payout-fee` nodes, the hidden copy first; #1404 hit the same trap on the deposit page).
- The driver never takes a private key: appium-remote-debugger logs every eval body at debug level (spike section 4.3). Routes it returns are `location.hash` only: the onboarding bypass keeps `?__test_skip_onboarding=1&password=...` in `location.href` for the whole session (spike section 4.6).
- Constants come from PR 1b's `usdcx-constants.ts` and `bridge.ts` (`ARC_CHAIN_ID`, `usdcxPayoutRowsText`, `USDCX_DESTINATION_CHIPS`) and copy from `public/_locales/en/en.json` through `enText`; nothing is pinned twice.
- Gates that apply: the iOS helper suites, prettier, eslint, `yarn lint:e2e`, `yarn ts` and the changelog check. Jest's coverage gate counts only `src/**` (`collectCoverageFrom`, jest.config.ts:15-28), so these `playwright/` helpers move no coverage number.
- CHANGELOG: one `[CHANGE][ci]` line under the highest `## X.Y.Z (TBD)` section above the latest `vX.Y.Z` tag (`git fetch --tags` first; an `-rc` tag does not count). CI's changelog check fails a PR that adds no entry and has no `no changelog` label. Never run prettier on `public/_locales` or `CHANGELOG.md`.
- Review: internal whole-branch review only (no review-council). P3 findings are neither fixed nor filed.

## Review Focus

1. **The stale store off Home.** A vault read taken on the generating or details page returns the pre-transaction balance for a minute or more; a reasonable person expects every ledger check to read the vault the user sees on Home. Pinned by Task 1's `navigates Home before it reads and waits out the stale store` test.
2. **Hidden duplicates during the review.** The retained Send layer and the Swap pane hold the same test ids as the visible review and amount step; a reasonable person expects the harness to assert on what is on screen, never on a hidden copy. Pinned by Task 2's `drives every step inside the Send flow and the review layer` test (every `document.querySelector` root and every selector starts with a scope).
3. **A Send pane left mid-flow or holding another chip.** The carousel keeps Send mounted with its step and chosen chip across hash navigations; a reasonable person expects the burn to start from the recipient step and go to Arc Testnet whatever an earlier attempt left. Pinned by Task 2's `backs the persistent Send pane out` test and the Arc-alone chip poll in the driver.
4. **The onboarding password and a late submit.** `location.href` carries `password=` for the whole session, and a step that overran its budget keeps running after its test failed; a reasonable person expects no returned route to carry the password and no burn to be submitted once its step is over. Pinned by Task 1's `routeOf` test, Task 2's driver test (returned routes have no `password`) and Task 2's `never clicks submit once its step has been aborted` test.
5. **Unconfirmed is not Failed, and a 409 is named.** A burn whose submit outcome is unknown reads status 4 until the node decides; a burn the Guardian refuses with a pending-candidate 409 fails without a requeue. A reasonable person expects the first to be waited out and the second to say the Guardian had not settled. Pinned by Task 2's `waitForBurnCompleted` tests.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `playwright/e2e/ios/helpers/ios-wallet-page.ts` | Modify (Tasks 1, 2) | CDP readers (rows, native asset, vault on Home), the scoped Send-flow burn driver, the generating-page wait, the details reads |
| `playwright/e2e/ios/helpers/ios-wallet-page.test.ts` | Modify (Tasks 1, 2) | node environment; one test per new helper, in the #1404 scoping pattern |
| `CHANGELOG.md` | Modify (Task 2) | one `[CHANGE][ci]` line |

Commits: Task 1 is commit 1, Task 2 commit 2.

**Size: about 900 lines added and 12 removed.** Measured from this plan's code blocks against their anchors (non-blank lines, import blocks counted once): `ios-wallet-page.ts` about 500 (the readers about 150, the driver, the generating-page wait and the details reads about 350, R26's check included) and its test about 390 (24 tests), plus one CHANGELOG line.

## Setup

- [ ] **Step 1: Confirm PR 1b merged and create the worktree**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
gh pr view 1421 --repo 0xMiden/wallet --json state,mergeCommit --jq '"\(.state) \(.mergeCommit.oid)"'
git -C /Users/celrisen/miden/miden-wallet fetch origin
git -C /Users/celrisen/miden/miden-wallet merge-base --is-ancestor 20949e612 origin/main && echo "PR 1b is on origin/main"
git -C /Users/celrisen/miden/miden-wallet worktree add -b wiktor/usdcx-ios-burn-a /Users/celrisen/miden/wt-usdcx-ios-burn-a origin/main
cd /Users/celrisen/miden/wt-usdcx-ios-burn-a && yarn install --frozen-lockfile
```

Expected: `MERGED 20949e612...`, `PR 1b is on origin/main`, the worktree created, `yarn install` ending `Done`.

- [ ] **Step 2: Confirm the base still holds what this plan quotes**

```bash
cd /Users/celrisen/miden/wt-usdcx-ios-burn-a
git cat-file -e d8345cbd4^{commit} && echo "d8345cbd4 present"
git diff --stat d8345cbd4 HEAD -- playwright/e2e/ios/helpers/ios-wallet-page.ts playwright/e2e/ios/helpers/ios-wallet-page.test.ts playwright/e2e/helpers/bridge.ts playwright/e2e/helpers/history.ts playwright/e2e/helpers/usdcx-constants.ts playwright/e2e/helpers/usdcx-guardian.ts playwright/e2e/helpers/balance-truth.ts src/lib/miden-chain/native-asset-cache-keys.ts src/lib/walletconnect/config.ts src/lib/usdcx/constant.ts public/_locales/en/en.json; echo "diff above (expect none)"
check() { grep -qE "^export (async function|function|const|class|interface|type) $2([^A-Za-z0-9_]|$)" "playwright/e2e/helpers/$1" && echo "ok $1 $2" || echo "MISSING $1 $2"; }
for n in bridgedSendRowOf enText isArcSnapshotFailure reviewQueryParam USDCX_DESTINATION_CHIPS usdcxChipsProblem usdcxPayoutRowsText BridgedSendRow NetworkChipState; do check bridge.ts $n; done
for n in readTransactionRowsInPage TxStatus TransactionRowSnapshot TransactionRowsQuery; do check history.ts $n; done
check usdcx-constants.ts ARC_CHAIN_ID; check usdcx-guardian.ts burnFailureMessage; check balance-truth.ts toBaseUnits
```

Expected: `d8345cbd4 present`, no diff lines before `diff above (expect none)`, and every line `ok ...`, no `MISSING`. A diff or a `MISSING` line means main moved after this plan was written: re-check each before-snippet the diff touches against the file (the snippet wins, a snippet that matches nothing stops the task) and note the change in the task report. If `d8345cbd4` is absent, skip the diff and rely on the snippets.

- [ ] **Step 3: Baseline the suites this PR touches**

```bash
cd /Users/celrisen/miden/wt-usdcx-ios-burn-a && yarn jest playwright/e2e/ios/helpers --maxWorkers=2 2>&1 | grep -E '^(Tests|Test Suites):'
```

Expected: `0 failed` in both lines. Record the totals; Tasks 1-2 add 24 tests to them.

---

### Task 1: iOS row, native-asset and vault readers

**Files:**
- Modify: `playwright/e2e/ios/helpers/ios-wallet-page.ts:1-9` (imports), `:33-35` (module code after `UNLOCKED_CONDITION_JS`), `:77` (a field), `:292-304` (`stashAndPoll`), `:312-314` (new methods)
- Test: `playwright/e2e/ios/helpers/ios-wallet-page.test.ts:1-3` (docblock, imports), append after `:161`

**Interfaces:**
- Consumes: `readTransactionRowsInPage(query: TransactionRowsQuery): Promise<TransactionRowSnapshot[] | null>` (history.ts:213 on PR 1b), `bridgedSendRowOf(row: TransactionRowSnapshot): BridgedSendRow` (bridge.ts:465), `toBaseUnits(amount: string | number, decimals: number): bigint` (balance-truth.ts:45), `NATIVE_ASSET_ID_CACHE`, `NATIVE_ASSET_FEE_CACHE` (src/lib/miden-chain/native-asset-cache-keys.ts:8, :10).
- Produces (on `IosWalletPage` unless noted):
  - `export interface IosNativeAsset { tokenId: string; symbol: string; decimals: number; baseFee: number }`
  - `export function routeOf(href: string): string` (module export)
  - `readTransactionRows(query?: { type?: string; withBytes?: boolean }): Promise<TransactionRowSnapshot[]>` (rides out two failed reads in a row)
  - `readBridgedSendRows(withBytes?: boolean): Promise<BridgedSendRow[]>`
  - `nativeAsset(timeoutMs?: number): Promise<IosNativeAsset>`
  - `readVaultBaseUnits(faucetId: string): Promise<bigint>` (rides out two failed evals in a row)
  - module-private `ridingOut<T>(read: () => Promise<T>): Promise<T>`, which Task 2's `waitForBurnCompleted` and `transactionDetailsView` use too
  - `homeVaultBaseUnits(faucetId: string, holds: (units: bigint) => boolean, timeoutMs: number, want: string): Promise<bigint>`

- [ ] **Step 1: Move the test file to the node environment and prove the old tests still pass there**

In `playwright/e2e/ios/helpers/ios-wallet-page.test.ts` replace lines 1-3:

```ts
import type { CdpSession } from './cdp-bridge';
import { IosWalletPage } from './ios-wallet-page';
import type { SimulatorControl } from './simulator-control';
```

with:

```ts
/**
 * @jest-environment node
 */
import type { CdpSession } from './cdp-bridge';
import { IosWalletPage, routeOf } from './ios-wallet-page';
import type { SimulatorControl } from './simulator-control';
import { readTransactionRowsInPage } from '../../helpers/history';
```

Run: `yarn jest playwright/e2e/ios/helpers/ios-wallet-page.test.ts --maxWorkers=2 2>&1 | grep -E '^Tests:'`
Expected: `Tests: 6 passed, 6 total` (the six existing tests; `routeOf` is still undefined and unused).

- [ ] **Step 2: Write the failing tests**

Append to the end of `playwright/e2e/ios/helpers/ios-wallet-page.test.ts` (after line 161):

```ts

function pageWith(evalJs: (js: string) => Promise<unknown>): IosWalletPage {
  return new IosWalletPage({
    cdp: { eval: evalJs } as unknown as CdpSession,
    sim: {} as SimulatorControl,
    udid: 'udid',
    bundleId: 'bundle'
  });
}

describe('IosWalletPage row reads', () => {
  it('runs the extension projection in the WebView through the stash, and deletes the stash it read', async () => {
    const bodies: string[] = [];
    const page = pageWith(async js => {
      bodies.push(js);
      return bodies.length === 1 ? null : { ok: true, v: [{ id: 'row-1', status: 2 }] };
    });

    await expect(page.readTransactionRows({ type: 'consume' })).resolves.toEqual([{ id: 'row-1', status: 2 }]);

    const query = JSON.stringify({ dbName: 'TridentMain', storeName: 'transactions', type: 'consume' });
    expect(bodies[0]).toContain(`Promise.resolve((${readTransactionRowsInPage.toString()})(${query}))`);
    // A burn row's stash carries about 0.5 MB of result bytes; one left on window per poll grows the WebView.
    expect(bodies[1]).toMatch(/delete window\[/);
  });

  // An inspector reattach, or the bridge's 30 s eval cap while a local prove holds the WebView's JS thread.
  it('asks a failed row read again instead of failing the poll that called it', async () => {
    let calls = 0;
    const page = pageWith(async () => {
      calls += 1;
      if (calls === 1) throw new Error('inspector reattached');
      return calls === 2 ? null : { ok: true, v: [{ id: 'row-1', status: 2 }] };
    });

    await expect(page.readTransactionRows()).resolves.toEqual([{ id: 'row-1', status: 2 }]);
    expect(calls).toBe(3);
  });

  it('types bridged-send rows as the extension harness does', async () => {
    const page = pageWith(async () => null);
    const read = jest.fn(async () => [
      {
        id: 'row-1',
        status: 2,
        extraInputs: {
          provider: 'usdcx',
          usdcxBurn: {
            noteId: '0xab',
            destinationDomain: 26,
            phase: 'confirmed',
            destinationBalanceBefore: { balance: '0', blockNumber: '66645216' }
          }
        }
      }
    ]);
    Object.assign(page as unknown as Record<string, unknown>, { readTransactionRows: read });

    const [row] = await page.readBridgedSendRows(true);

    expect(read).toHaveBeenCalledWith({ type: 'bridged-send', withBytes: true });
    expect(row?.extraInputs?.usdcxBurn?.phase).toBe('confirmed');
    expect(row?.extraInputs?.usdcxBurn?.destinationBalanceBefore).toEqual({ balance: '0', blockNumber: '66645216' });
  });
});

describe('IosWalletPage.nativeAsset', () => {
  const ID = 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w';
  const SCOPE = 'https://rpc.testnet.miden.io|testnet';
  const STORE = {
    account: 'mtst1azl43d2ms9d68sttlde0zkl52qhzld9r_qr7qqq9wr6w',
    displayFaucetId: ID,
    rows: [{ tokenId: ID, symbol: 'USDCX', decimals: 6, balance: 0 }]
  };
  const CACHE = {
    [`native_asset_id:v4:${SCOPE}`]: ID,
    [`native_asset_fee:v2:${SCOPE}`]: JSON.stringify({ faucetId: ID, baseFee: 7 })
  };

  function nativePage(entries: Record<string, string>, view: unknown): IosWalletPage {
    const page = pageWith(async () => view);
    Object.assign(page as unknown as Record<string, unknown>, { stashAndPoll: jest.fn(async () => entries) });
    return page;
  }

  it('reads the id and base fee the wallet cached and the balance row that shows them (spike run 3)', async () => {
    await expect(nativePage(CACHE, STORE).nativeAsset()).resolves.toEqual({
      tokenId: ID,
      symbol: 'USDCX',
      decimals: 6,
      baseFee: 7
    });
  });

  it('refuses a cache that has seen two chains rather than let key order pick one', async () => {
    const page = nativePage({ ...CACHE, 'native_asset_id:v4:https://rpc.devnet.miden.io|devnet': 'mdev1other' }, STORE);
    await expect(page.nativeAsset(0)).rejects.toThrow(/native_asset_id:v4 cache has 2 entries/);
  });

  it('refuses a store that shows another token as native', async () => {
    const page = nativePage(CACHE, { ...STORE, displayFaucetId: 'mtst1other' });
    await expect(page.nativeAsset(0)).rejects.toThrow(/the store shows mtst1other as the native token/);
  });
});

describe('IosWalletPage vault reads', () => {
  const rowsWith = (balance: number) => ({
    account: 'acct',
    displayFaucetId: 'native',
    rows: [
      { tokenId: 'native', symbol: 'USDCX', decimals: 6, balance },
      { tokenId: 'other', symbol: 'TST', decimals: 8, balance: 5 }
    ]
  });

  it('reads exact base units of one faucet in the current account', async () => {
    await expect(pageWith(async () => rowsWith(99.999867)).readVaultBaseUnits('native')).resolves.toBe(99999867n);
  });

  it('refuses a store balance that does not round-trip at its decimals', async () => {
    await expect(pageWith(async () => rowsWith(0.1234567)).readVaultBaseUnits('native')).rejects.toThrow(
      /more precision than 6 decimals/
    );
  });

  it('asks again after a failed eval and fails only on the third in a row', async () => {
    let calls = 0;
    const once = pageWith(async () => {
      calls += 1;
      if (calls === 1) throw new Error('inspector reattached');
      return rowsWith(99.999867);
    });
    await expect(once.readVaultBaseUnits('native')).resolves.toBe(99999867n);

    const never = pageWith(async () => {
      throw new Error('eval: timed out after 30000ms');
    });
    await expect(never.readVaultBaseUnits('native')).rejects.toThrow('eval: timed out after 30000ms');
  }, 15_000);

  // Only Home runs the balance poll: off it the spike's store held the pre-burn balance 60 s after the burn.
  it('navigates Home before it reads and waits out the stale store', async () => {
    const order: string[] = [];
    const reads = [99999867n, 89999615n];
    const page = pageWith(async () => null);
    Object.assign(page as unknown as Record<string, unknown>, {
      navigateHome: jest.fn(async () => {
        order.push('home');
      }),
      readVaultBaseUnits: jest.fn(async () => {
        order.push('read');
        return reads.shift();
      })
    });

    await expect(page.homeVaultBaseUnits('native', units => units === 89999615n, 10_000, '89999615')).resolves.toBe(
      89999615n
    );
    expect(order).toEqual(['home', 'read', 'read']);
  });

  it('names Home, the wanted value and the last read when the vault never gets there', async () => {
    const page = pageWith(async () => null);
    Object.assign(page as unknown as Record<string, unknown>, {
      navigateHome: jest.fn(async () => undefined),
      readVaultBaseUnits: jest.fn(async () => 5n)
    });

    await expect(page.homeVaultBaseUnits('native', units => units === 7n, 0, '7')).rejects.toThrow(
      'the vault of native on Home never read 7 within 0 ms; last 5'
    );
  });
});

describe('routeOf', () => {
  it('keeps the hash route and drops the onboarding bypass search, password included', () => {
    expect(
      routeOf(
        'capacitor://localhost/?__test_skip_onboarding=1&password=123456&walletType=guardian#/send/review?amount=10&network=arc-testnet'
      )
    ).toBe('#/send/review?amount=10&network=arc-testnet');
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `yarn jest playwright/e2e/ios/helpers/ios-wallet-page.test.ts --maxWorkers=2 2>&1 | grep -E '^Tests:|is not a function'`
Expected: `Tests: 12 failed, 6 passed, 18 total`, the failures reading `... is not a function` (`readTransactionRows`, `readBridgedSendRows`, `nativeAsset`, `readVaultBaseUnits`, `homeVaultBaseUnits`, `routeOf`).

- [ ] **Step 4: Add the imports**

In `playwright/e2e/ios/helpers/ios-wallet-page.ts` replace lines 1-9:

```ts
import type { CdpSession } from './cdp-bridge';
import type { SimulatorControl } from './simulator-control';
import type { PromptSettlement } from './system-alerts';
import { ACTIVITY_PENDING_PATH } from '../../../../src/app/pages/activity-paths';
import type { TimelineRecorder } from '../../harness/timeline-recorder';
import { buildBalanceTotalScript } from '../../helpers/balance-script';
import { claimFromPendingList } from '../../helpers/claim-drain';
import { dismissTelemetryConsent } from '../../helpers/telemetry-consent';
import type { GuardianAuthInfo, WalletPage, SendTokensParams } from '../../helpers/wallet-page';
```

with:

```ts
import type { CdpSession } from './cdp-bridge';
import type { SimulatorControl } from './simulator-control';
import type { PromptSettlement } from './system-alerts';
import { ACTIVITY_PENDING_PATH } from '../../../../src/app/pages/activity-paths';
import { NATIVE_ASSET_FEE_CACHE, NATIVE_ASSET_ID_CACHE } from '../../../../src/lib/miden-chain/native-asset-cache-keys';
import type { TimelineRecorder } from '../../harness/timeline-recorder';
import { buildBalanceTotalScript } from '../../helpers/balance-script';
import { toBaseUnits } from '../../helpers/balance-truth';
import { bridgedSendRowOf, type BridgedSendRow } from '../../helpers/bridge';
import { claimFromPendingList } from '../../helpers/claim-drain';
import { readTransactionRowsInPage, type TransactionRowSnapshot, type TransactionRowsQuery } from '../../helpers/history';
import { dismissTelemetryConsent } from '../../helpers/telemetry-consent';
import type { GuardianAuthInfo, WalletPage, SendTokensParams } from '../../helpers/wallet-page';
```

- [ ] **Step 5: Add the module-level readers**

In the same file, the anchor is lines 32-35:

```ts
  `var st = s.getState(); ` +
  `return (st.status === 2 || st.status === 'Ready') && !!st.currentAccount;`;

interface IosWalletPageOpts {
```

Replace it with:

```ts
  `var st = s.getState(); ` +
  `return (st.status === 2 || st.status === 'Ready') && !!st.currentAccount;`;

/** `readTransactionRowsInPage`'s database and store (src/lib/miden/repo.ts), the same on every platform. */
const TX_DB = 'TridentMain';
const TX_STORE = 'transactions';

// The Capacitor Preferences entries lib/miden-chain/native-asset writes, one per (RPC URL, network) scope; the
// extension harness reads the same entries from chrome.storage (balance-truth.ts walletCacheEntry).
const NATIVE_ASSET_CACHE_EXPR =
  `(async function () { var P = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences; ` +
  `if (!P) throw new Error('no Capacitor Preferences plugin'); var keys = (await P.keys()).keys || []; var out = {}; ` +
  `for (var i = 0; i < keys.length; i++) { var k = keys[i]; ` +
  `if (k.indexOf(${JSON.stringify(`${NATIVE_ASSET_ID_CACHE}:`)}) === 0 || ` +
  `k.indexOf(${JSON.stringify(`${NATIVE_ASSET_FEE_CACHE}:`)}) === 0) out[k] = (await P.get({ key: k })).value; } ` +
  `return out; })()`;

// `balances` is keyed by the account's public key, so another account's rows cannot leak into the current one's.
const CURRENT_ACCOUNT_ROWS_JS =
  `var s = window.__TEST_STORE__; if (!s) return null; var st = s.getState(); ` +
  `var pk = st.currentAccount && st.currentAccount.publicKey; if (!pk) return null; var meta = st.assetsMetadata || {}; ` +
  `return { account: pk, displayFaucetId: (st.balancesDisplayFaucetId && st.balancesDisplayFaucetId[pk]) || null, ` +
  `rows: ((st.balances && st.balances[pk]) || []).map(function (r) { var m = r.metadata || meta[r.tokenId] || {}; ` +
  `return { tokenId: String(r.tokenId), symbol: m.symbol || '', decimals: m.decimals, balance: r.balance }; }) };`;

interface CurrentAccountRows {
  account: string;
  displayFaucetId: string | null;
  rows: Array<{ tokenId: string; symbol: string; decimals: number; balance: number }>;
}

/** The chain's native (fee) asset as the wallet discovered it and as the current account's balance row shows it. */
export interface IosNativeAsset {
  /** The composite id (`<bech32>_<suffix>`) the store keys the balance row by. */
  tokenId: string;
  symbol: string;
  decimals: number;
  /** The chain's `verification_base_fee`, which bounds a landed path's fee. */
  baseFee: number;
}

/** The one Preferences value under `prefix`; a cache that has seen two chains would let key order pick one. */
function onePreference(entries: Record<string, string | null>, prefix: string): string {
  const keys = Object.keys(entries).filter(key => key.startsWith(`${prefix}:`));
  const [key] = keys;
  const value = key === undefined ? undefined : entries[key];
  if (keys.length !== 1 || typeof value !== 'string') {
    throw new Error(
      `the wallet's ${prefix} cache has ${keys.length} entries (${keys.join(', ') || 'none'}), expected one`
    );
  }
  return value;
}

function nativeAssetOf(entries: Record<string, string | null>, view: CurrentAccountRows | null): IosNativeAsset {
  const tokenId = onePreference(entries, NATIVE_ASSET_ID_CACHE);
  const fee: unknown = JSON.parse(onePreference(entries, NATIVE_ASSET_FEE_CACHE));
  const feeFaucetId = fee !== null && typeof fee === 'object' ? Reflect.get(fee, 'faucetId') : undefined;
  const baseFee = fee !== null && typeof fee === 'object' ? Reflect.get(fee, 'baseFee') : undefined;
  if (feeFaucetId !== tokenId || typeof baseFee !== 'number' || !Number.isInteger(baseFee) || baseFee < 0) {
    throw new Error(`the wallet's ${NATIVE_ASSET_FEE_CACHE} entry ${JSON.stringify(fee)} has no base fee for ${tokenId}`);
  }
  if (view?.displayFaucetId && view.displayFaucetId !== tokenId) {
    throw new Error(`the store shows ${view.displayFaucetId} as the native token; the wallet discovered ${tokenId}`);
  }
  const row = view?.rows.find(candidate => candidate.tokenId === tokenId);
  if (!row || row.symbol === '' || !Number.isInteger(row.decimals)) {
    throw new Error(`no balance row with a symbol and decimals for the native token ${tokenId}: ${JSON.stringify(view)}`);
  }
  return { tokenId, symbol: row.symbol, decimals: row.decimals, baseFee };
}

/** A page route without its search: the onboarding bypass keeps `?password=` in `location.href` all session. */
export function routeOf(href: string): string {
  return new URL(href).hash;
}

const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 1_000;

/**
 * `read`, asked again after a failed CDP eval: an inspector reattach, or the bridge's 30 s eval cap while a local
 * prove holds the WebView's JS thread. The live spec's polls run for minutes and `pollUntil` fails on one failed read,
 * so only the third failure in a row counts.
 */
async function ridingOut<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= READ_ATTEMPTS) throw error;
      await sleep(READ_RETRY_MS);
    }
  }
}

interface IosWalletPageOpts {
```

- [ ] **Step 6: Add the stash sequence field**

Replace line 77:

```ts
  private pollStats: PollStats = { pollCount: 0, pollIterations: 0, pollMs: 0, pollSleepMs: 0 };
```

with:

```ts
  private pollStats: PollStats = { pollCount: 0, pollIterations: 0, pollMs: 0, pollSleepMs: 0 };
  private stashSeq = 0;
```

- [ ] **Step 7: Make the stash unique per call and delete it once read**

Replace lines 292-304:

```ts
  private async stashAndPoll<T>(prefix: string, promiseExpr: string, timeoutMs = 30_000): Promise<T> {
    const key = `${prefix}_${Date.now()}`;
    const k = JSON.stringify(key);
    await this.cdp.eval(
      `window[${k}] = undefined; ` +
        `Promise.resolve(${promiseExpr})` +
        `.then(function (v) { window[${k}] = { ok: true, v: v }; })` +
        `.catch(function (e) { window[${k}] = { ok: false, e: String((e && e.message) || e) }; }); ` +
        `return null;`
    );
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.cdp.eval<{ ok: boolean; v?: T; e?: string } | null>(`return window[${k}] || null;`);
```

with:

```ts
  private async stashAndPoll<T>(prefix: string, promiseExpr: string, timeoutMs = 30_000): Promise<T> {
    // The sequence keeps two reads started in the same millisecond apart.
    const key = `${prefix}_${Date.now()}_${++this.stashSeq}`;
    const k = JSON.stringify(key);
    await this.cdp.eval(
      `window[${k}] = undefined; ` +
        `Promise.resolve(${promiseExpr})` +
        `.then(function (v) { window[${k}] = { ok: true, v: v }; })` +
        `.catch(function (e) { window[${k}] = { ok: false, e: String((e && e.message) || e) }; }); ` +
        `return null;`
    );
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // Deleted once read: a burn row's stash holds about 0.5 MB of result bytes.
      const r = await this.cdp.eval<{ ok: boolean; v?: T; e?: string } | null>(
        `var r = window[${k}]; if (r) { delete window[${k}]; } return r || null;`
      );
```

- [ ] **Step 8: Add the reader methods**

The anchor is the end of `stashAndPoll` and the next section comment (lines 309-315 on main, shifted by the edits above):

```ts
      if (Date.now() > deadline) throw new Error(`stashAndPoll(${prefix}): timed out after ${timeoutMs}ms`);
      await new Promise(res => setTimeout(res, POLL_INTERVAL_MS));
    }
  }

  // ── iOS-only helpers (used inline by .ios.spec.ts where Chrome reaches
```

Replace it with:

```ts
      if (Date.now() > deadline) throw new Error(`stashAndPoll(${prefix}): timed out after ${timeoutMs}ms`);
      await new Promise(res => setTimeout(res, POLL_INTERVAL_MS));
    }
  }

  // ── Row, native-asset and vault reads (the live USDCx spec) ─────────────

  /**
   * Transaction rows straight from the WebView's IndexedDB through history.ts's projection, the extension harness's
   * own reader: its source closes over nothing, so it runs here as is (3 of 3 live spike runs). `withBytes` adds
   * `outputNoteIds`, `requestBytes` and `resultBytes`; poll without them and read them once.
   */
  async readTransactionRows(query: { type?: string; withBytes?: boolean } = {}): Promise<TransactionRowSnapshot[]> {
    const full: TransactionRowsQuery = { dbName: TX_DB, storeName: TX_STORE, ...query };
    const rows = await ridingOut(() =>
      this.stashAndPoll<TransactionRowSnapshot[] | null>(
        '__tx_rows',
        `(${readTransactionRowsInPage.toString()})(${JSON.stringify(full)})`,
        60_000
      )
    );
    return rows ?? [];
  }

  /** The `bridged-send` rows, typed as the extension harness types them. */
  async readBridgedSendRows(withBytes = false): Promise<BridgedSendRow[]> {
    return (await this.readTransactionRows({ type: 'bridged-send', withBytes })).map(bridgedSendRowOf);
  }

  /**
   * The native asset from the wallet's Preferences cache, checked against the store's display id and the current
   * account's balance row. Both land shortly after Ready, so it re-reads until `timeoutMs` and then reports the last
   * problem.
   */
  async nativeAsset(timeoutMs = 60_000): Promise<IosNativeAsset> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const entries = await this.stashAndPoll<Record<string, string | null>>('__native_asset', NATIVE_ASSET_CACHE_EXPR);
        return nativeAssetOf(entries, await this.cdp.eval<CurrentAccountRows | null>(CURRENT_ACCOUNT_ROWS_JS));
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
      await sleep(2_000);
    }
  }

  /**
   * Exact spendable base units of `faucetId` in the current account, as the store last fetched them. Read it through
   * `homeVaultBaseUnits`: the balance poll runs only on Home.
   */
  async readVaultBaseUnits(faucetId: string): Promise<bigint> {
    const view = await ridingOut(() => this.cdp.eval<CurrentAccountRows | null>(CURRENT_ACCOUNT_ROWS_JS));
    if (!view) throw new Error('readVaultBaseUnits: the store has no current account');
    let total = 0n;
    for (const row of view.rows.filter(candidate => candidate.tokenId === faucetId)) {
      // toBaseUnits refuses more digits than the decimals hold: a float that does not round-trip.
      total += toBaseUnits(String(row.balance), row.decimals);
    }
    return total;
  }

  /**
   * Goes Home, where the balance poll runs, and re-reads the vault every second until `holds` accepts it. The store
   * caught up within 5.1 s of the move in the spike.
   */
  async homeVaultBaseUnits(
    faucetId: string,
    holds: (units: bigint) => boolean,
    timeoutMs: number,
    want: string
  ): Promise<bigint> {
    await this.navigateHome();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const units = await this.readVaultBaseUnits(faucetId);
      if (holds(units)) return units;
      if (Date.now() >= deadline) {
        throw new Error(`the vault of ${faucetId} on Home never read ${want} within ${timeoutMs} ms; last ${units}`);
      }
      await sleep(1_000);
    }
  }

  // ── iOS-only helpers (used inline by .ios.spec.ts where Chrome reaches
```

- [ ] **Step 9: Run the tests to see them pass**

Run: `yarn jest playwright/e2e/ios/helpers/ios-wallet-page.test.ts --maxWorkers=2 2>&1 | grep -E '^Tests:'`
Expected: `Tests: 18 passed, 18 total`.

- [ ] **Step 10: Format and lint the two files**

```bash
cd /Users/celrisen/miden/wt-usdcx-ios-burn-a
npx prettier --write playwright/e2e/ios/helpers/ios-wallet-page.ts playwright/e2e/ios/helpers/ios-wallet-page.test.ts
npx eslint --max-warnings 0 playwright/e2e/ios/helpers/ios-wallet-page.ts playwright/e2e/ios/helpers/ios-wallet-page.test.ts; echo "eslint exit $?"
yarn jest playwright/e2e/ios/helpers/ios-wallet-page.test.ts --maxWorkers=2 2>&1 | grep -E '^Tests:'
```

Expected: `eslint exit 0` with no messages, then `Tests: 18 passed, 18 total`. If eslint reports only `import/order`, run `npx eslint --fix` on that file and re-check.

- [ ] **Step 11: Commit**

```bash
cd /Users/celrisen/miden/wt-usdcx-ios-burn-a
git add playwright/e2e/ios/helpers/ios-wallet-page.ts playwright/e2e/ios/helpers/ios-wallet-page.test.ts
git status --short
git commit -m "test(e2e): iOS CDP row, native-asset and vault readers"
```

Expected: exactly the two paths staged; one commit, no trailer (`git log -1 --format=%B` prints the one line).

---

### Task 2: The scoped Send-flow burn driver, the generating-page wait and the details reads

**Files:**
- Modify: `playwright/e2e/ios/helpers/ios-wallet-page.ts` (imports as Task 1 left them; module code after `ridingOut`; methods after `homeVaultBaseUnits`)
- Test: `playwright/e2e/ios/helpers/ios-wallet-page.test.ts` (imports as Task 1 left them; append)
- Modify: `CHANGELOG.md` (one line)

**Interfaces:**
- Consumes: Task 1's `readBridgedSendRows`, `routeOf`, `ridingOut`; PR 1b's `usdcxPayoutRowsText(chainId: number, amount: string): { fee: string; net: string }` (bridge.ts:761, throws when the allowance takes the whole amount), `usdcxChipsProblem(chips, selected): string | undefined` (:688), `USDCX_DESTINATION_CHIPS` (:669), `reviewQueryParam(url, name): string | null` (:701), `isArcSnapshotFailure(reviewError, newUsdcxRows): boolean` (:708), `enText(key, values?)` (:517), `NetworkChipState` (:681), `TxStatus` (history.ts:28), `burnFailureMessage(row: BridgedSendRow): string` (usdcx-guardian.ts:107), `ARC_CHAIN_ID` (usdcx-constants.ts:67), `ARC_TESTNET` (src/lib/walletconnect/config.ts:12-19).
- Produces (on `IosWalletPage` unless noted):
  - ``export interface UsdcxBurnViaSendOptions { destAddress: `0x${string}`; amount: string; nativeTokenId: string; nativeSymbol: string; screenshotDir: string; signal?: AbortSignal }``
  - `export interface UsdcxBurnSubmission { rowId: string; reviewRoute: string; generatingRoute: string; defaultPressed: string[] }`
  - `export interface BurnStageSample { status: number; stage?: string; atMs: number }`
  - `burnUsdcxViaSendFlow(opts: UsdcxBurnViaSendOptions): Promise<UsdcxBurnSubmission>`
  - `waitForBurnCompleted(rowId: string, timeoutMs: number, pollMs?: number): Promise<{ row: BridgedSendRow; stages: BurnStageSample[] }>`
  - `openTransactionDetails(rowId: string): Promise<void>`
  - `transactionDetailsView(rowId: string): Promise<{ pill: string | null; arcTxLinks: string[] }>`

- [ ] **Step 1: Write the failing tests**

In `playwright/e2e/ios/helpers/ios-wallet-page.test.ts` replace the import block Task 1 wrote:

```ts
import type { CdpSession } from './cdp-bridge';
import { IosWalletPage, routeOf } from './ios-wallet-page';
import type { SimulatorControl } from './simulator-control';
import { readTransactionRowsInPage } from '../../helpers/history';
```

with:

```ts
import os from 'os';
import path from 'path';

import type { CdpSession } from './cdp-bridge';
import { IosWalletPage, routeOf } from './ios-wallet-page';
import type { SimulatorControl } from './simulator-control';
import { enText, type BridgedSendRow } from '../../helpers/bridge';
import { readTransactionRowsInPage } from '../../helpers/history';
```

Then append to the end of the file:

```ts

// What the spike's DOM answered at each read of the burn (ios-spike-evidence.json, run 3).
const SEND = '[data-testid="send-flow"]';
const REVIEW = '[data-page-layer="/send/review"]';
const NATIVE = 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w';
const KEY = '0xd07e6586a66ddA1Bad34aF529c1f07156b167861';
const CHIPS = ['send-network-arc-testnet', 'send-network-sepolia', 'send-network-base-sepolia', 'send-network-arbitrum-sepolia'];
const HREF =
  'capacitor://localhost/?__test_skip_onboarding=1&password=123456&walletType=guardian' +
  `#/send/review?amount=10&to=${KEY}&tokenId=${NATIVE}&network=arc-testnet&route=usdcx`;
const BURN = {
  destAddress: KEY,
  amount: '10',
  nativeTokenId: NATIVE,
  nativeSymbol: 'USDCX',
  screenshotDir: path.join(os.tmpdir(), 'ios-wallet-page-burn-test')
} as const;

function spikeAnswer(js: string, overrides: { ready?: unknown; outcome?: unknown } = {}): unknown {
  if (js.includes('aria-pressed')) {
    return CHIPS.map(testId => ({ testId, pressed: testId === CHIPS[0] ? 'true' : 'false' }));
  }
  if (js.includes('bridge-route-usdcx')) {
    return {
      checked: 'true',
      cardText: 'USDCx (Circle xReserve)USDCX fees',
      fee: 'Up to 0.1 USDC',
      net: 'At least 9.9 USDC',
      notice: enText('usdcxWithdrawalNotice')
    };
  }
  if (js.includes('location.href')) return { href: HREF, hash: HREF.slice(HREF.indexOf('#')), submit: true };
  if (js.includes('function row(')) {
    return {
      network: 'Arc Testnet',
      networkFee: enText('usdcxSponsorshipFee', { symbol: 'USDCX' }),
      fee: 'Up to 0.1 USDC',
      net: 'At least 9.9 USDC',
      notice: enText('usdcxWithdrawalNotice')
    };
  }
  if (js.includes("state: 'enabled'")) return overrides.ready ?? { state: 'enabled' };
  if (js.includes('loading')) {
    return overrides.outcome ?? { hash: '#/generating-transaction-full/row-1', error: null, loading: false };
  }
  return null;
}

/** Stubs the DOM primitives the driver calls with a selector, records each selector, and backs out `backs` times. */
function stubDom(page: IosWalletPage, backs = 0): string[] {
  const selectors: string[] = [];
  let left = backs;
  const record = async (selector: string) => {
    selectors.push(selector);
  };
  Object.assign(page as unknown as Record<string, unknown>, {
    navigateTo: jest.fn(async () => undefined),
    waitFor: jest.fn(record),
    click: jest.fn(record),
    clickWhenEnabled: jest.fn(record),
    fillInput: jest.fn(record),
    exists: jest.fn(async (selector: string) => {
      selectors.push(selector);
      return left-- > 0;
    }),
    screenshot: jest.fn(async () => undefined),
    readBridgedSendRows: jest.fn(async () => [])
  });
  return selectors;
}

describe('IosWalletPage.burnUsdcxViaSendFlow', () => {
  // #1404 clicked the hidden Swap selector; here the review slides over a Send layer holding the same payout rows.
  it('drives every step inside the Send flow and the review layer, presses Arc and returns routes without the password', async () => {
    const bodies: string[] = [];
    const page = pageWith(async js => {
      bodies.push(js);
      return spikeAnswer(js);
    });
    const selectors = stubDom(page);

    const result = await page.burnUsdcxViaSendFlow(BURN);

    expect(result).toEqual({
      rowId: 'row-1',
      reviewRoute: HREF.slice(HREF.indexOf('#')),
      generatingRoute: '#/generating-transaction-full/row-1',
      defaultPressed: ['send-network-arc-testnet']
    });
    expect(JSON.stringify(result)).not.toContain('password');
    expect(selectors.filter(selector => !selector.startsWith(SEND) && !selector.startsWith(REVIEW))).toEqual([]);
    expect(selectors.filter(selector => selector.includes('send-network-'))).toEqual([
      `${SEND} [data-testid="send-network-arc-testnet"]`
    ]);
    const roots = bodies.flatMap(js =>
      [...js.matchAll(/document\.querySelector(?:All)?\(("(?:[^"\\]|\\.)*")\)/g)].map(match => String(JSON.parse(match[1] ?? '""')))
    );
    expect(roots.length).toBeGreaterThan(5);
    expect(roots.filter(root => !root.startsWith(SEND) && !root.startsWith(REVIEW))).toEqual([]);
    expect(bodies.join('\n')).not.toMatch(/document\.querySelector(?:All)?\('/);
  }, 15_000);

  it("refuses an amount that does not exceed Arc's payout fee allowance before it touches the UI", async () => {
    const page = pageWith(async js => spikeAnswer(js));
    stubDom(page);

    await expect(page.burnUsdcxViaSendFlow({ ...BURN, amount: '0.1' })).rejects.toThrow(
      /does not exceed the 0\.1 USDC payout fee allowance on Arc Testnet/
    );
    expect((page as unknown as { navigateTo: jest.Mock }).navigateTo).not.toHaveBeenCalled();
  });

  it("names the review's refusal and never submits", async () => {
    const page = pageWith(async js => spikeAnswer(js, { ready: { state: 'error', text: 'Not enough USDCX' } }));
    const selectors = stubDom(page);

    await expect(page.burnUsdcxViaSendFlow(BURN)).rejects.toThrow(
      'the review refused the burn before submit: review-error "Not enough USDCX"'
    );
    expect(selectors).not.toContain(`${REVIEW} [data-testid="send-review-submit"]`);
  }, 15_000);

  // R26: withStepBudget aborts an overrun step's signal, and the step itself runs on after its test failed.
  it('never clicks submit once its step has been aborted', async () => {
    const page = pageWith(async js => spikeAnswer(js));
    const selectors = stubDom(page);
    const controller = new AbortController();
    controller.abort(new Error('burn_via_send exceeded its 240000 ms budget'));

    await expect(page.burnUsdcxViaSendFlow({ ...BURN, signal: controller.signal })).rejects.toThrow(
      'the burn was not submitted: burn_via_send exceeded its 240000 ms budget'
    );
    expect(selectors).not.toContain(`${REVIEW} [data-testid="send-review-submit"]`);
  }, 15_000);

  it("tells the wallet's failed Arc snapshot apart from a refusal after submit", async () => {
    const outcome = { hash: '#/send/review?amount=10', error: 'HTTP request failed.', loading: false };
    const page = pageWith(async js => spikeAnswer(js, { outcome }));
    stubDom(page);

    await expect(page.burnUsdcxViaSendFlow(BURN)).rejects.toThrow(
      `Arc RPC unavailable for the wallet's balance snapshot (burn.ts), infra: review-error "HTTP request failed."`
    );
  }, 15_000);

  // The carousel keeps Send mounted with its step and its chip across hash navigations.
  it('backs the persistent Send pane out to the recipient step before it fills the address', async () => {
    const page = pageWith(async js => spikeAnswer(js));
    const selectors = stubDom(page, 2);

    await page.burnUsdcxViaSendFlow(BURN);

    const back = `${SEND} [data-testid="flow-back"]`;
    const clicks = (page as unknown as { click: jest.Mock }).click.mock.calls.map(call => String(call[0]));
    expect(clicks.filter(selector => selector === back)).toHaveLength(2);
    expect(selectors.lastIndexOf(back)).toBeLessThan(selectors.indexOf(`${SEND} [data-testid="send-recipient-input"]`));
  }, 15_000);
});

describe('IosWalletPage.waitForBurnCompleted', () => {
  const ON_PAGE = '#/generating-transaction-full/row-1';

  function burnPage(
    hash: string | (() => Promise<string>),
    rounds: BridgedSendRow[][]
  ): { page: IosWalletPage; calls: boolean[] } {
    const page = pageWith(async () => (typeof hash === 'string' ? hash : hash()));
    const calls: boolean[] = [];
    const withBytes: BridgedSendRow = { id: 'row-1', status: 2, stage: 'complete', resultBytes: 'AAAA' };
    Object.assign(page as unknown as Record<string, unknown>, {
      readBridgedSendRows: jest.fn(async (bytes = false) => {
        calls.push(bytes);
        return bytes ? [withBytes] : (rounds.shift() ?? []);
      })
    });
    return { page, calls };
  }

  // On mobile the generating page drives the transaction loop; the reaper releases resultBytes 10 min after completion.
  it('stays on the generating page through Unconfirmed until Completed, then reads the bytes once', async () => {
    const { page, calls } = burnPage(ON_PAGE, [
      [{ id: 'row-1', status: 1, stage: 'proving' }],
      [{ id: 'row-1', status: 4, stage: 'submitting' }],
      [{ id: 'row-1', status: 2, stage: 'complete' }]
    ]);

    const done = await page.waitForBurnCompleted('row-1', 60_000, 0);

    expect(done.row.resultBytes).toBe('AAAA');
    expect(done.stages.map(sample => sample.status)).toEqual([1, 4, 2]);
    expect(calls).toEqual([false, false, false, true]);
  });

  it('fails a Failed row with the Guardian settle hint a 409 earns', async () => {
    const { page } = burnPage(ON_PAGE, [
      [{ id: 'row-1', status: 3, stage: 'submitting', rawError: 'HTTP 409 ConflictPendingDelta' }]
    ]);

    await expect(page.waitForBurnCompleted('row-1', 60_000, 0)).rejects.toThrow(
      'the prior Guardian candidate had not settled'
    );
  });

  it('fails when the page left the generating route before the row completed', async () => {
    const { page } = burnPage('#/', [[{ id: 'row-1', status: 0 }]]);

    await expect(page.waitForBurnCompleted('row-1', 1_000, 0)).rejects.toThrow(
      'left the generating page for #/ before burn row row-1 completed'
    );
  });

  it('asks a failed location read again instead of failing the burn', async () => {
    let reads = 0;
    const { page } = burnPage(async () => {
      reads += 1;
      if (reads === 1) throw new Error('inspector reattached');
      return ON_PAGE;
    }, [[{ id: 'row-1', status: 2, stage: 'complete' }]]);

    await expect(page.waitForBurnCompleted('row-1', 60_000, 0)).resolves.toMatchObject({ row: { id: 'row-1' } });
    expect(reads).toBe(2);
  });
});

describe('IosWalletPage transaction details', () => {
  const LAYER = '[data-page-layer="/history-details/row-1"]';

  it('opens the details route and waits for the pill inside its own layer', async () => {
    const page = pageWith(async () => null);
    const navigateTo = jest.fn(async () => undefined);
    const waitFor = jest.fn(async () => undefined);
    Object.assign(page as unknown as Record<string, unknown>, { navigateTo, waitFor });

    await page.openTransactionDetails('row-1');

    expect(navigateTo).toHaveBeenCalledWith('/history-details/row-1');
    expect(waitFor).toHaveBeenCalledWith(`${LAYER} [data-testid="history-status-pill"]`, { timeoutMs: 30_000 });
  });

  it('reads the pill and the Arc explorer links from the details layer only', async () => {
    const bodies: string[] = [];
    const view = { pill: 'Confirmed', arcTxLinks: ['https://explorer.testnet.arc.io/tx/0xde87'] };
    const page = pageWith(async js => {
      bodies.push(js);
      return view;
    });

    await expect(page.transactionDetailsView('row-1')).resolves.toEqual(view);
    expect(bodies[0]).toContain(`document.querySelector(${JSON.stringify(LAYER)})`);
    expect(bodies[0]).toContain(JSON.stringify('https://explorer.testnet.arc.io/tx/'));
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `yarn jest playwright/e2e/ios/helpers/ios-wallet-page.test.ts --maxWorkers=2 2>&1 | grep -E '^Tests:'`
Expected: `Tests: 12 failed, 18 passed, 30 total` (each new test: `... is not a function`).

- [ ] **Step 3: Extend the imports**

In `playwright/e2e/ios/helpers/ios-wallet-page.ts` replace the whole import block Task 1 left at the top of the file (every line from `import type { CdpSession } from './cdp-bridge';` through `import type { GuardianAuthInfo, WalletPage, SendTokensParams } from '../../helpers/wallet-page';`, however prettier wrapped them) with:

```ts
import fs from 'fs';
import path from 'path';

import type { CdpSession } from './cdp-bridge';
import type { SimulatorControl } from './simulator-control';
import type { PromptSettlement } from './system-alerts';
import { ACTIVITY_PENDING_PATH } from '../../../../src/app/pages/activity-paths';
import { NATIVE_ASSET_FEE_CACHE, NATIVE_ASSET_ID_CACHE } from '../../../../src/lib/miden-chain/native-asset-cache-keys';
import { ARC_TESTNET } from '../../../../src/lib/walletconnect/config';
import type { TimelineRecorder } from '../../harness/timeline-recorder';
import { buildBalanceTotalScript } from '../../helpers/balance-script';
import { toBaseUnits } from '../../helpers/balance-truth';
import {
  bridgedSendRowOf,
  enText,
  isArcSnapshotFailure,
  reviewQueryParam,
  USDCX_DESTINATION_CHIPS,
  usdcxChipsProblem,
  usdcxPayoutRowsText,
  type BridgedSendRow,
  type NetworkChipState
} from '../../helpers/bridge';
import { claimFromPendingList } from '../../helpers/claim-drain';
import {
  readTransactionRowsInPage,
  TxStatus,
  type TransactionRowSnapshot,
  type TransactionRowsQuery
} from '../../helpers/history';
import { dismissTelemetryConsent } from '../../helpers/telemetry-consent';
import { ARC_CHAIN_ID } from '../../helpers/usdcx-constants';
import { burnFailureMessage } from '../../helpers/usdcx-guardian';
import type { GuardianAuthInfo, WalletPage, SendTokensParams } from '../../helpers/wallet-page';
```

- [ ] **Step 4: Add the driver's module code**

The anchor is the end of Task 1's `ridingOut` and the line after it:

```ts
      if (attempt >= READ_ATTEMPTS) throw error;
      await sleep(READ_RETRY_MS);
    }
  }
}

interface IosWalletPageOpts {
```

Replace it with:

```ts
      if (attempt >= READ_ATTEMPTS) throw error;
      await sleep(READ_RETRY_MS);
    }
  }
}

const SEND_FLOW = '[data-testid="send-flow"]';
// The review slides over the retained Send layer, whose route step holds the same payout rows and burn notice.
const SEND_REVIEW = '[data-page-layer="/send/review"]';
const ARC_CHIP = 'send-network-arc-testnet';
// Mobile mounts the app as a full page, so the in-progress route is the -full variant.
const GENERATING_ROUTE = /#\/generating-transaction(?:-full)?\/([^/?#]+)/;

/** A script body whose lookups all run under `scope`; `text` reads a test id's text, `val` a DetailRow's value div. */
function scopedJs(scope: string, body: string): string {
  return (
    `var root = document.querySelector(${JSON.stringify(scope)}); if (!root) return null; ` +
    `function text(id) { var e = root.querySelector('[data-testid="' + id + '"]'); ` +
    `return e ? (e.textContent || '').trim() : null; } ` +
    `function val(id) { var e = root.querySelector('[data-testid="' + id + '"]'); ` +
    `var d = e && e.querySelector(':scope > div'); return d ? (d.textContent || '').trim() : null; } ` +
    body
  );
}

const SEND_CHIPS_JS = scopedJs(
  SEND_FLOW,
  `return Array.from(root.querySelectorAll('[data-testid^="send-network-"]:not([data-testid="send-network-options"])'))` +
    `.map(function (e) { return { testId: e.getAttribute('data-testid') || '', pressed: e.getAttribute('aria-pressed') }; });`
);

const USDCX_ROUTE_JS = scopedJs(
  SEND_FLOW,
  `var card = root.querySelector('[data-testid="bridge-route-usdcx"]'); if (!card) return null; ` +
    `return { checked: card.getAttribute('aria-checked'), cardText: (card.textContent || '').trim(), ` +
    `fee: val('usdcx-payout-fee'), net: val('usdcx-payout-net'), notice: text('usdcx-burn-notice') };`
);

const REVIEW_LANDING_JS =
  `return { href: location.href, hash: location.hash, ` +
  `submit: !!document.querySelector(${JSON.stringify(`${SEND_REVIEW} [data-testid="send-review-submit"]`)}) };`;

/** The review's labelled rows: a label span whose next sibling is the value div (DetailRow). */
function usdcxReviewJs(networkLabel: string, networkFeeLabel: string): string {
  return scopedJs(
    SEND_REVIEW,
    `function row(label) { var s = Array.from(root.querySelectorAll('span')).find(function (x) { ` +
      `return (x.textContent || '').trim() === label && x.nextElementSibling && x.nextElementSibling.tagName === 'DIV'; }); ` +
      `return s ? (s.nextElementSibling.textContent || '').trim() : null; } ` +
      `return { network: row(${JSON.stringify(networkLabel)}), networkFee: row(${JSON.stringify(networkFeeLabel)}), ` +
      `fee: val('usdcx-payout-fee'), net: val('usdcx-payout-net'), notice: text('usdcx-burn-notice') };`
  );
}

const REVIEW_READY_JS = scopedJs(
  SEND_REVIEW,
  `var e = root.querySelector('[data-testid="review-error"]'); ` +
    `if (e) return { state: 'error', text: (e.textContent || '').trim() }; ` +
    `var b = root.querySelector('[data-testid="send-review-submit"]'); ` +
    `return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? { state: 'enabled' } : { state: 'waiting' };`
);

// Not scopedJs: the review layer is gone once the submit lands on the generating page.
const SUBMIT_OUTCOME_JS =
  `var root = document.querySelector(${JSON.stringify(SEND_REVIEW)}); ` +
  `var e = root && root.querySelector('[data-testid="review-error"]'); ` +
  `var b = root && root.querySelector('[data-testid="send-review-submit"]'); ` +
  `return { hash: location.hash, error: e ? (e.textContent || '').trim() : null, ` +
  `loading: !!(b && (b.disabled || b.getAttribute('aria-busy') === 'true')) };`;

interface UsdcxRouteView {
  checked: string | null;
  cardText: string;
  fee: string | null;
  net: string | null;
  notice: string | null;
}

interface UsdcxReviewView {
  network: string | null;
  networkFee: string | null;
  fee: string | null;
  net: string | null;
  notice: string | null;
}

function sameChipSet(chips: readonly NetworkChipState[]): boolean {
  return chips.map(chip => chip.testId).sort().join(',') === [...USDCX_DESTINATION_CHIPS].sort().join(',');
}

/** The details page's own layer: it slides over the retained tabs. */
function detailsLayer(rowId: string): string {
  return `[data-page-layer="/history-details/${rowId}"]`;
}

export interface UsdcxBurnViaSendOptions {
  /** The Arc address Circle pays. Never a private key: appium-remote-debugger logs every eval body. */
  destAddress: `0x${string}`;
  /** As typed: a whole number, since the amount field follows the simulator's locale for decimals. */
  amount: string;
  nativeTokenId: string;
  nativeSymbol: string;
  /** Where usdcx-route.png and the two review screenshots go. */
  screenshotDir: string;
  /** The step's abort signal (`namedSteps`): once it has fired, the driver never clicks submit. */
  signal?: AbortSignal;
}

export interface UsdcxBurnSubmission {
  /** The Dexie row id, the `:txId` of the generating and history-details routes. */
  rowId: string;
  /** `location.hash` only (routeOf). */
  reviewRoute: string;
  generatingRoute: string;
  /** Chips pressed when the address validated, before the Arc click (R16 evidence). */
  defaultPressed: string[];
}

export interface BurnStageSample {
  status: number;
  stage?: string;
  atMs: number;
}

interface IosWalletPageOpts {
```

- [ ] **Step 5: Add the driver, the generating-page wait, the details reads and two private primitives**

The anchor is the end of Task 1's `homeVaultBaseUnits` and the next section comment:

```ts
      if (Date.now() >= deadline) {
        throw new Error(`the vault of ${faucetId} on Home never read ${want} within ${timeoutMs} ms; last ${units}`);
      }
      await sleep(1_000);
    }
  }

  // ── iOS-only helpers (used inline by .ios.spec.ts where Chrome reaches
```

Replace it with:

```ts
      if (Date.now() >= deadline) {
        throw new Error(`the vault of ${faucetId} on Home never read ${want} within ${timeoutMs} ms; last ${units}`);
      }
      await sleep(1_000);
    }
  }

  // ── USDCx burn through the Send UI (the live USDCx spec) ────────────────

  /**
   * Burns the native USDCx to an Arc Testnet address through the real Send UI and returns once the wallet is on the
   * generating page. Every read is scoped (SEND_FLOW, SEND_REVIEW). Checks on the way: exactly the four USDCx chips
   * with Arc alone pressed, the route card, the payout rows and the notice on the route and the review, and the
   * review's network and fee rows; a refusal is named from `review-error`, never left to a timeout. Nothing is
   * submitted once `signal` has aborted (R26).
   */
  async burnUsdcxViaSendFlow(opts: UsdcxBurnViaSendOptions): Promise<UsdcxBurnSubmission> {
    const symbol = opts.nativeSymbol.trim();
    if (symbol === '' || symbol.toUpperCase() === 'MIDEN') {
      throw new Error(`burnUsdcxViaSendFlow: "${opts.nativeSymbol}" cannot name USDCx, the asset a USDCx burn spends`);
    }
    // Throws before any UI when the amount does not exceed Arc's payout fee allowance (R14a).
    const payout = usdcxPayoutRowsText(ARC_CHAIN_ID, opts.amount);
    const routeFees = enText('usdcxMidenFees', { symbol });
    const sponsorshipFee = enText('usdcxSponsorshipFee', { symbol });
    const notice = enText('usdcxWithdrawalNotice');
    const rowsBefore = new Set((await this.readBridgedSendRows()).map(row => row.id));
    fs.mkdirSync(opts.screenshotDir, { recursive: true });

    await this.navigateTo(`/send?tokenId=${encodeURIComponent(opts.nativeTokenId)}`);
    await this.waitFor(SEND_FLOW, { timeoutMs: 15_000 });
    // The carousel keeps Send mounted with its step and chip; only the recipient step has no back button.
    for (let pop = 0; pop < 3 && (await this.exists(`${SEND_FLOW} [data-testid="flow-back"]`)); pop++) {
      await this.click(`${SEND_FLOW} [data-testid="flow-back"]`);
      await sleep(1_000);
    }
    await this.waitFor(`${SEND_FLOW} [data-testid="send-recipient-input"]`, { timeoutMs: 15_000 });
    await this.fillInput(`${SEND_FLOW} [data-testid="send-recipient-input"]`, opts.destAddress);
    const offered = await this.pollEval<NetworkChipState[] | null>(
      'the four USDCx destination chips',
      SEND_CHIPS_JS,
      chips => chips !== null && sameChipSet(chips),
      15_000
    );
    const defaultPressed = (offered ?? []).filter(chip => chip.pressed === 'true').map(chip => chip.testId);
    // A chip kept from an earlier attempt overrides the default, so Arc is pressed explicitly every time.
    await this.click(`${SEND_FLOW} [data-testid="${ARC_CHIP}"]`);
    await this.pollEval<NetworkChipState[] | null>(
      'Arc Testnet alone pressed among the four USDCx chips',
      SEND_CHIPS_JS,
      chips => chips !== null && usdcxChipsProblem(chips, ARC_CHIP) === undefined,
      15_000
    );
    await this.clickWhenEnabled(`${SEND_FLOW} [data-testid="send-recipient-confirm"]`, 30_000);
    await this.waitFor(`${SEND_FLOW} [data-testid="send-amount-input"]`, { timeoutMs: 30_000 });
    // `available` renders only once a token is set: the ?tokenId= preselect landed (every spike run).
    await this.waitFor(`${SEND_FLOW} [data-testid="send-amount-available"]`, { timeoutMs: 10_000 });
    await this.fillInput(`${SEND_FLOW} [data-testid="send-amount-input"]`, opts.amount);
    await this.clickWhenEnabled(`${SEND_FLOW} [data-testid="send-amount-confirm"]`, 45_000);

    await this.pollEval<UsdcxRouteView | null>(
      'the USDCx route card, payout rows and burn notice',
      USDCX_ROUTE_JS,
      view =>
        view !== null &&
        view.checked === 'true' &&
        view.cardText.includes(routeFees) &&
        view.fee === payout.fee &&
        view.net === payout.net &&
        view.notice === notice,
      30_000
    );
    await this.screenshot({ path: path.join(opts.screenshotDir, 'usdcx-route.png') });
    await this.clickWhenEnabled(`${SEND_FLOW} [data-testid="bridge-route-confirm"]`, 15_000);

    const landing = await this.pollEval<{ href: string; hash: string; submit: boolean }>(
      'the burn review',
      REVIEW_LANDING_JS,
      view => view.hash.startsWith('#/send/review?') && view.submit,
      30_000
    );
    const wanted: Record<string, string> = { network: 'arc-testnet', route: 'usdcx', tokenId: opts.nativeTokenId };
    for (const [name, value] of Object.entries(wanted)) {
      const actual = reviewQueryParam(landing.href, name);
      if (actual !== value) {
        throw new Error(`the review route ${routeOf(landing.href)} has ${name}=${actual}, expected ${value}`);
      }
    }
    await this.pollEval<UsdcxReviewView | null>(
      'the burn review rows',
      usdcxReviewJs(enText('network'), enText('networkFee')),
      view =>
        view !== null &&
        view.network === ARC_TESTNET.name &&
        view.networkFee === sponsorshipFee &&
        view.fee === payout.fee &&
        view.net === payout.net &&
        view.notice === notice,
      15_000
    );
    const ready = await this.pollEval<{ state: string; text?: string } | null>(
      'send-review-submit enables, or review-error names the refusal',
      REVIEW_READY_JS,
      view => view !== null && view.state !== 'waiting',
      60_000
    );
    if (ready?.state === 'error') {
      throw new Error(`the review refused the burn before submit: review-error "${ready.text ?? ''}"`);
    }
    await this.screenshot({ path: path.join(opts.screenshotDir, 'usdcx-review-light.png') });
    await this.cdp.eval(`document.documentElement.classList.add('dark'); return null;`);
    await sleep(400);
    await this.screenshot({ path: path.join(opts.screenshotDir, 'usdcx-review-dark.png') });
    await this.cdp.eval(`document.documentElement.classList.remove('dark'); return null;`);

    // An overrun step runs on after its test failed (R26): a burn submitted then pays out into a later run's window.
    if (opts.signal?.aborted) {
      const reason: unknown = opts.signal.reason;
      throw new Error(`the burn was not submitted: ${reason instanceof Error ? reason.message : String(reason)}`, {
        cause: reason
      });
    }
    await this.click(`${SEND_REVIEW} [data-testid="send-review-submit"]`);
    // Submit reads the minimum burn and the Arc snapshot (15 s budget, burn.ts) before it queues the row.
    const outcome = await this.pollEval<{ hash: string; error: string | null; loading: boolean }>(
      'the burn submit reaching the generating page or review-error',
      SUBMIT_OUTCOME_JS,
      view => GENERATING_ROUTE.test(view.hash) || (view.error !== null && !view.loading),
      60_000
    );
    const rowId = GENERATING_ROUTE.exec(outcome.hash)?.[1];
    if (!rowId) {
      const fresh = (await this.readBridgedSendRows()).filter(
        row => row.extraInputs?.provider === 'usdcx' && !rowsBefore.has(row.id)
      );
      const error = outcome.error ?? '';
      throw new Error(
        isArcSnapshotFailure(error, fresh.length)
          ? `Arc RPC unavailable for the wallet's balance snapshot (burn.ts), infra: review-error "${error}"`
          : `the review refused the burn: review-error "${error}", ${fresh.length} new usdcx rows`
      );
    }
    return {
      rowId: decodeURIComponent(rowId),
      reviewRoute: routeOf(landing.href),
      generatingRoute: outcome.hash,
      defaultPressed
    };
  }

  /**
   * Stays on the generating page until the burn row is Completed: on mobile that page drives the transaction loop
   * (GeneratingTransaction.tsx), so leaving it before the first tick leaves the row queued. Unconfirmed (4) waits
   * for the node's verdict and is waited out. The bytes are read once, right after Completed: the reaper releases
   * `resultBytes` 10 min after `completedAt`.
   */
  async waitForBurnCompleted(
    rowId: string,
    timeoutMs: number,
    pollMs = 2_000
  ): Promise<{ row: BridgedSendRow; stages: BurnStageSample[] }> {
    const started = Date.now();
    const stages: BurnStageSample[] = [];
    for (;;) {
      const hash = await ridingOut(() => this.cdp.eval<string>('return location.hash;'));
      if (decodeURIComponent(GENERATING_ROUTE.exec(hash)?.[1] ?? '') !== rowId) {
        throw new Error(`left the generating page for ${hash} before burn row ${rowId} completed`);
      }
      const row = (await this.readBridgedSendRows()).find(candidate => candidate.id === rowId);
      const last = stages[stages.length - 1];
      if (row && (last?.status !== row.status || last?.stage !== row.stage)) {
        stages.push({ status: row.status, stage: row.stage, atMs: Date.now() - started });
      }
      if (row?.status === TxStatus.Completed) break;
      if (row?.status === TxStatus.Failed) throw new Error(burnFailureMessage(row));
      if (Date.now() - started >= timeoutMs) {
        throw new Error(
          `burn row ${rowId} not Completed within ${timeoutMs} ms (stages ${JSON.stringify(stages)}): ` +
            (row ? burnFailureMessage(row) : 'no such row')
        );
      }
      await sleep(pollMs);
    }
    const row = (await this.readBridgedSendRows(true)).find(candidate => candidate.id === rowId);
    if (!row) throw new Error(`burn row ${rowId} vanished after it completed`);
    return { row, stages };
  }

  /** Opens a transaction's history details and waits for its status pill. */
  async openTransactionDetails(rowId: string): Promise<void> {
    await this.navigateTo(`/history-details/${rowId}`);
    await this.waitFor(`${detailsLayer(rowId)} [data-testid="history-status-pill"]`, { timeoutMs: 30_000 });
  }

  /** The open details page's status pill and every Arc explorer transaction link it renders. */
  async transactionDetailsView(rowId: string): Promise<{ pill: string | null; arcTxLinks: string[] }> {
    const prefix = `${ARC_TESTNET.blockExplorers.default.url}/tx/`;
    const view = await ridingOut(() =>
      this.cdp.eval<{ pill: string | null; arcTxLinks: string[] } | null>(
        `var root = document.querySelector(${JSON.stringify(detailsLayer(rowId))}); if (!root) return null; ` +
          `var pill = root.querySelector('[data-testid="history-status-pill"]'); ` +
          `return { pill: pill ? (pill.textContent || '').trim() : null, ` +
          `arcTxLinks: Array.from(root.querySelectorAll('a[href]')).map(function (a) { return a.getAttribute('href') || ''; })` +
          `.filter(function (h) { return h.indexOf(${JSON.stringify(prefix)}) === 0; }) };`
      )
    );
    return view ?? { pill: null, arcTxLinks: [] };
  }

  /** Re-runs a script body until `done` accepts its value; a failed eval (an inspector reattach) counts as not yet. */
  private async pollEval<T>(label: string, js: string, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: { value: T } | undefined;
    for (;;) {
      const read = await this.cdp.eval<T>(js).then(
        value => ({ value }),
        () => undefined
      );
      if (read !== undefined) {
        if (done(read.value)) return read.value;
        last = read;
      }
      if (Date.now() >= deadline) {
        const seen = last === undefined ? 'none' : (JSON.stringify(last.value) ?? 'undefined').slice(0, 1_500);
        throw new Error(`${label}: not met within ${timeoutMs} ms; last read ${seen}`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  private async exists(selector: string): Promise<boolean> {
    return this.cdp.eval<boolean>(`return !!document.querySelector(${JSON.stringify(selector)});`);
  }

  // ── iOS-only helpers (used inline by .ios.spec.ts where Chrome reaches
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `yarn jest playwright/e2e/ios/helpers/ios-wallet-page.test.ts --maxWorkers=2 2>&1 | grep -E '^Tests:'`
Expected: `Tests: 30 passed, 30 total`.

- [ ] **Step 7: The directory's other suites, format, lint and the harness ratchet**

```bash
cd /Users/celrisen/miden/wt-usdcx-ios-burn-a
npx prettier --write playwright/e2e/ios/helpers/ios-wallet-page.ts playwright/e2e/ios/helpers/ios-wallet-page.test.ts
npx eslint --max-warnings 0 playwright/e2e/ios/helpers/ios-wallet-page.ts playwright/e2e/ios/helpers/ios-wallet-page.test.ts; echo "eslint exit $?"
yarn lint:e2e; echo "lint:e2e exit $?"
yarn jest playwright/e2e/ios/helpers --maxWorkers=2 2>&1 | grep -E '^(Tests|Test Suites):'
```

Expected: `eslint exit 0` with no messages, `lint:e2e exit 0`, then `0 failed` suites and tests (the directory's other suites, such as `evm-doubles.test.ts` and `system-alerts.test.ts`, unchanged).

- [ ] **Step 8: The CHANGELOG line**

```bash
cd /Users/celrisen/miden/wt-usdcx-ios-burn-a
git fetch --tags
LATEST=$(git tag --list 'v*' --sort=-v:refname | grep -v -e '-rc' | head -1); echo "latest release $LATEST"
python3 - "$LATEST" <<'PY'
import re, sys
latest = tuple(int(x) for x in sys.argv[1].lstrip('v').split('.'))
p = 'CHANGELOG.md'
lines = open(p).read().split('\n')
heading = re.compile(r'^## (\d+)\.(\d+)\.(\d+) \(TBD\)$')
target = next(i for i, l in enumerate(lines) if (m := heading.match(l)) and tuple(map(int, m.groups())) > latest)
end = next((i for i in range(target + 1, len(lines)) if lines[i].startswith('## ')), len(lines))
changes = next(i for i in range(target, end) if lines[i] == '### Changes')
assert lines[changes + 1] == '', repr(lines[changes + 1])
entry = (
    "- [CHANGE][ci] The iOS E2E page object reads a wallet's transaction rows, native asset and exact vault through "
    "the WebView, asking a failed read again, and burns USDCx to Arc Testnet through the Send screen with every lookup "
    "inside the Send flow or the review it opens, naming a refused review and never submitting once its step ran out "
    "of time."
)
lines.insert(changes + 2, entry)
open(p, 'w').write('\n'.join(lines))
print('inserted under', lines[target], 'at line', changes + 3)
PY
BASE_REF=main NO_CHANGELOG_LABEL=false bash scripts/check-changelog.sh; echo "changelog exit $?"
git diff --stat CHANGELOG.md
```

Expected: `latest release v1.17.1` (or newer), `inserted under ## 1.17.2 (TBD) at line <n>` (or the highest `(TBD)` section above a newer tag), `changelog exit 0`, `1 file changed, 1 insertion(+)`. A `StopIteration` means that section has no `### Changes` heading yet: add `### Changes` and a blank line at the end of the section, then re-run the snippet. Never run prettier on `CHANGELOG.md`.

- [ ] **Step 9: Commit**

```bash
cd /Users/celrisen/miden/wt-usdcx-ios-burn-a
git add playwright/e2e/ios/helpers/ios-wallet-page.ts playwright/e2e/ios/helpers/ios-wallet-page.test.ts CHANGELOG.md
git status --short
git commit -m "test(e2e): scoped Send-flow USDCx burn driver for the iOS page object"
git log --format=%s origin/main..HEAD
```

Expected: exactly the three paths staged; one commit, no trailer; the log shows the subjects of Tasks 2 and 1, newest first.

---

## Delivery

Every command runs from `/Users/celrisen/miden/wt-usdcx-ios-burn-a` with `export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"`.

- [ ] **Step 1: Local gates (only what CI does not run for us, plus the type check once)**

```bash
yarn jest playwright/e2e/ios/helpers --maxWorkers=2 2>&1 | grep -E '^(Tests|Test Suites):'
git diff --name-only -z --diff-filter=ACMR origin/main...HEAD -- '*.ts' | xargs -0 npx prettier --check
git diff --name-only -z --diff-filter=ACMR origin/main...HEAD -- '*.ts' | xargs -0 npx eslint --max-warnings 0; echo "eslint exit $?"
yarn lint:e2e; echo "lint:e2e exit $?"
yarn ts; echo "ts exit $?"
BASE_REF=main NO_CHANGELOG_LABEL=false bash scripts/check-changelog.sh; echo "changelog exit $?"
printf 'a\xe2\x80\x94b\n' | perl -ne 'print "control hit\n" if /\xe2\x80[\x93\x94]/'
git diff -U0 origin/main...HEAD | grep '^+' | perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/'
git log --format=%B origin/main..HEAD | perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/'
git log --format=%B origin/main..HEAD | grep -ci -e 'co-authored' -e 'generated with' -e 'claude' -e 'cursor' -e 'codex'
git diff -U0 origin/main...HEAD -- . ':(exclude)playwright/e2e/ios/helpers/ios-wallet-page.test.ts' | grep '^+' | grep -nE 'burns? 10 USDCx|9\.98|9\.9 USDC'
```

Expected: both jest lines `0 failed` (the baseline totals plus 24 tests); `All matched files use Prettier code style!`; `eslint exit 0`; `lint:e2e exit 0`; `ts exit 0` (tsconfig.json includes `playwright/**/*.ts` with `noUnusedLocals` and `noUncheckedIndexedAccess`); `changelog exit 0`; exactly one `control hit` and no `DASH:` line; `0`; nothing from the last grep (R19's amounts everywhere outside the unit tests, which replay the 10 USDCx spike's DOM). A `ts` error is fixed in a new commit, never by `as` or `any`.

- [ ] **Step 2: Mutation checks**

Each mutation backs the file up, mutates it, asserts the mutation applied (`! cmp -s`, a silent no-op proves nothing), runs the suite and restores, all in one command. Write the prediction down before each run, then record predicted against observed. A mutation that fails no test means the test is inert: fix the test, in a new commit, before review.

```bash
mut() { cp "$1" "$1.mutbak" && perl -0pi -e "$2" "$1" && ! cmp -s "$1" "$1.mutbak" && { yarn jest "$3" --maxWorkers=2 2>&1 | grep -E '^Tests:|●'; }; mv "$1.mutbak" "$1"; }
P=playwright/e2e/ios/helpers/ios-wallet-page.ts; T=playwright/e2e/ios/helpers/ios-wallet-page.test.ts
mut $P 's/if \(r\) \{ delete window\[\$\{k\}\]; \} //' $T
mut $P 's/await this\.navigateHome\(\);(\s+const deadline = Date\.now\(\) \+ timeoutMs;)/$1/' $T
mut $P 's/\$\{SEND_FLOW\} \[data-testid="\$\{ARC_CHIP\}"\]/[data-testid="\$\{ARC_CHIP\}"]/' $T
mut $P 's/scopedJs\(\s*SEND_REVIEW,(\s*`function row)/scopedJs("body",$1/' $T
mut $P 's/const row = \(await this\.readBridgedSendRows\(\)\)\.find\(candidate => candidate\.id === rowId\);/const row = (await this.readBridgedSendRows(true)).find(candidate => candidate.id === rowId);/' $T
mut $P 's/if \(row\?\.status === TxStatus\.Failed\)/if (row?.status === TxStatus.Failed || row?.status === TxStatus.Unconfirmed)/' $T
mut $P 's/return new URL\(href\)\.hash;/return href;/' $T
mut $P 's/if \(keys\.length !== 1 \|\| typeof value/if (typeof value/' $T
mut $P 's/(const payout = usdcxPayoutRowsText\(ARC_CHAIN_ID, opts\.amount\);)/await this.navigateTo("\/send");\n    $1/' $T
mut $P 's/if \(decodeURIComponent\(GENERATING_ROUTE\.exec\(hash\)\?\.\[1\] \?\? .{2}\) !== rowId\)/if (false)/' $T
mut $P 's/const READ_ATTEMPTS = 3;/const READ_ATTEMPTS = 1;/' $T
mut $P 's/if \(opts\.signal\?\.aborted\) \{/if (false) {/' $T
git status --short | grep -c mutbak
```

| # | Mutation | Predicted failing test(s) |
|---|---|---|
| 1 | the stash is not deleted | `runs the extension projection in the WebView through the stash, and deletes the stash it read` |
| 2 | `homeVaultBaseUnits` reads without going Home | `navigates Home before it reads and waits out the stale store` |
| 3 | the Arc chip click is unscoped | `drives every step inside the Send flow and the review layer, ...` |
| 4 | the review rows are read from `body` | `drives every step inside the Send flow and the review layer, ...` |
| 5 | the generating-page loop reads bytes every poll | `stays on the generating page through Unconfirmed until Completed, then reads the bytes once` and `fails a Failed row with the Guardian settle hint a 409 earns` (the stub answers a bytes read with the Completed row, so the Failed round is never read) |
| 6 | Unconfirmed counts as a failure | `stays on the generating page through Unconfirmed until Completed, then reads the bytes once` |
| 7 | `routeOf` keeps the search | `keeps the hash route and drops the onboarding bypass search, password included` and `drives every step inside the Send flow ...` |
| 8 | two cached chains are accepted | `refuses a cache that has seen two chains rather than let key order pick one` |
| 9 | the driver navigates before the allowance check | `refuses an amount that does not exceed Arc's payout fee allowance before it touches the UI` |
| 10 | leaving the generating page is not checked | `fails when the page left the generating route before the row completed` (it now times out with another message) |
| 11 | a failed CDP read fails at once | `asks a failed row read again instead of failing the poll that called it`, `asks again after a failed eval and fails only on the third in a row` and `asks a failed location read again instead of failing the burn` |
| 12 | an aborted step still submits (R26) | `never clicks submit once its step has been aborted` |

Expected: each run prints one `Tests:` line with `1 failed` (2 for rows 5 and 7, 3 for row 11) and one `●` line per predicted title (Jest prints no per-test lines in this shell, only the failure headers `● <describe> › <title>`); the last line prints `0`.

- [ ] **Step 3: Internal whole-branch review**

A fresh reviewer on the most capable model reviews `git diff $(git merge-base origin/main HEAD)...HEAD` (no review-council). Give it this plan's Global Constraints and Review Focus, and ask specifically about: the burn driver's scoping and its predicates against the spike's DOM values (`ios-spike-evidence.json`); the stash's uniqueness and deletion; every long poll's tolerance of one failed CDP read; whether any path can put a private key or the onboarding password into a `cdp.eval` body, a returned route or a screenshot name; the abort check's place (right before the submit click, after every read); and whether `waitForBurnCompleted` can mistake Unconfirmed for Failed or leave the generating page early. Fix each actionable P0-P2 finding with its own new commit (never amend), re-run that file's suite and every test file in its directory, and give each fix a scoped re-review. P3 findings are neither fixed nor filed.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin wiktor/usdcx-ios-burn-a
BODY=$(mktemp -t usdcx-pr2a-body); echo "$BODY"
cat > "$BODY" <<'EOF'
The iOS page object can now read a wallet's transaction rows, native asset and exact vault through the WebView and burn USDCx to Arc Testnet through the real Send screen, so the live iOS USDCx spec can check a burn end to end on iOS.

- Row reads run PR 1b's own IndexedDB projection (`readTransactionRowsInPage`) inside the WebView; the native asset comes from the wallet's Capacitor Preferences cache, checked against the balance row; vault reads are exact base units and happen on Home only.
- A failed CDP eval (an inspector reattach, the bridge's 30 s cap) is asked again twice before a long poll fails on it.
- `burnUsdcxViaSendFlow` scopes every lookup to the Send flow or the review layer (the review slides over a hidden copy of the same rows), checks the chips, route card, payout rows, notice and review rows, names a refusal from `review-error`, and never clicks submit once its step has run out of time.
- `waitForBurnCompleted` stays on the generating page (it drives the transaction loop on mobile) through Unconfirmed until Completed, and reads the result bytes once.
- 24 unit tests in `ios-wallet-page.test.ts` replay the iOS spike's recorded DOM and rows. Nothing calls this code yet: the live spec that does follows in its own PR.

**Reviewers:** the scoping in `burnUsdcxViaSendFlow` (every `document.querySelector` root starts with a scope) is the part worth your time.
EOF
if grep -n '<' "$BODY"; then
  echo 'STOP: a placeholder is left'
elif ! perl -ne 'exit 1 if /\xe2\x80[\x93\x94]/' "$BODY"; then
  echo 'STOP: a dash is in the body'
else
  gh pr create --repo 0xMiden/wallet --base main --head wiktor/usdcx-ios-burn-a --title "iOS E2E page object reads burn rows and the vault and drives a USDCx burn through Send" --body-file "$BODY" && gh pr view --repo 0xMiden/wallet --json number,body --jq '.number, .body'
fi
```

Expected: the push succeeds; no `STOP:` line; the PR is created and its body reads back as written. No tool attribution anywhere in the title or body. Record the PR number as `PR2A`.

- [ ] **Step 5: CI on the pushed head, by SHA**

```bash
gh api "repos/0xMiden/wallet/actions/runs?head_sha=$(git rev-parse HEAD)" --jq '.total_count, (.workflow_runs[] | "\(.name) | \(.status) | \(.conclusion)")'
gh pr checks "$PR2A" --repo 0xMiden/wallet
```

Expected: `total_count` above 0 (a push can create no runs: KB `github-actions-push-sometimes-creates-no-runs`; if 0 after 5 minutes, check by SHA again, then push an empty commit). Watch the checks that cover this change: the jest job or shard that runs `playwright/e2e/ios/helpers`, `lint:e2e`, the type check, prettier and eslint, and the changelog check. Report each failure as it lands and fix it with a new commit, unsquashed, never force-pushed. The E2E suites do not load the new code (no spec calls it), so a red E2E job is read for its cause before it is called unrelated.

- [ ] **Step 6: Admin squash-merge**

Once every relevant check is green:

```bash
gh pr merge "$PR2A" --repo 0xMiden/wallet --squash --admin --body "The iOS page object reads transaction rows, the native asset and the exact vault through the WebView and drives a scoped USDCx burn through Send."
gh pr view "$PR2A" --repo 0xMiden/wallet --json state,mergeCommit --jq '"\(.state) \(.mergeCommit.oid)"'
gh api "repos/0xMiden/wallet/actions/runs?head_sha=$(gh pr view "$PR2A" --repo 0xMiden/wallet --json mergeCommit --jq .mergeCommit.oid)" --jq '.total_count'
```

Expected: `MERGED <sha>`, and main's push runs exist for that SHA (above 0 within a few minutes). `--body` sets the squash commit's message, so no commit text or trailer of this branch reaches main (KB `github-squash-merge-body-replaces-commit-messages`). PR 2b starts from this merge (`/Users/celrisen/miden/wt-usdcx-e2e/.superpowers/pr2/2026-10-11-usdcx-ios-pr2b-plan.md`, Setup Step 1).

## Self-Review

1. **Spec coverage.** The readers the re-scope's commit 1 lists (rows through the stash, the native asset from Preferences, the exact vault on Home) are Task 1; the scoped Send-flow driver, the generating-page wait and the details reads are Task 2; every helper has its own unit test in the #1404 pattern. The burn half that calls them, the deposit hardening, the config, the workflow and the docs are PR 2b's.
2. **Placeholder scan.** No `<...>` field is left for the executor: the PR body has no live result to fill, and Step 4 refuses to open the PR while any `<` is left in it. `PR2A` is set from Step 4's output.
3. **Type consistency.** `IosNativeAsset`, `readTransactionRows`, `readBridgedSendRows`, `nativeAsset`, `readVaultBaseUnits`, `homeVaultBaseUnits(faucetId, holds, timeoutMs, want)`, `routeOf`, `ridingOut` (Task 1) are used by Task 2 with the same signatures; `UsdcxBurnViaSendOptions` (with `signal?`), `UsdcxBurnSubmission`, `BurnStageSample`, `burnUsdcxViaSendFlow`, `waitForBurnCompleted(rowId, timeoutMs, pollMs?)`, `openTransactionDetails`, `transactionDetailsView` are what PR 2b's Interfaces consume.
4. **Review Focus.** Each of the five lines has its test in Task 1 or Task 2.
5. **Size.** About 900 added lines, the old plan's commit 1 (about 865) plus R26's check and test and the CHANGELOG line.

## Plan critique log (history: the unsplit plan of 2026-10-11, kept as written)

Task, step and commit numbers below are the unsplit plan's (its Tasks 1-2 are PR 2a's Tasks 1-2, its Tasks 3-5 are PR 2b's Tasks 1-3). Both open questions at its end are resolved: the user kept R20 (question 1) and chose the split, option (a) (question 2). The Refresh log below says what changed since.

Two critic lists reviewed this plan: list A (six findings) and list B (four), each id prefixed with its list. Every claim was checked against the source first (`progress.md`, PR 1b at `f161768b1`, main at `8e7ae1630`, the probe reports).

- A-F1 (blocking, R20 fresh key vs CI key): applied. R20 in `progress.md` is a later user ruling that names and supersedes the fresh-key decision for iOS (written after this plan's first draft), and the re-scope's option (b) already described it. The burn now goes back to `evmAddress`; `burn_destination` replaces `fresh_key`; no `newArcKey`, `recordArcKey`, ledger write or "strands" text; `balanceBefore` (the row's snapshot, checked against the run's own read) feeds the payout gate; the confirmation must read `balanceBefore + payout.value`; the guard markers and mutation 12 now pin the delta mode. Open question 1 asks the user to confirm.
- A-F2 (blocking, R19 amounts and grant tier): applied. The grant passes R19's `GRANT_UNITS` (10 USDCx tier) instead of no amount (100 USDCx); every comment, header, docs, CHANGELOG and PR-body amount says 1 USDCx and about 0.98 USDC; Setup Step 2 now prints `BURN_UNITS` and the grant amount and stops unless R19/R20's follow-up has landed; Delivery Step 1 greps the added lines for a stale amount. The unit tests keep the 10 USDCx spike's recorded DOM values, which stay self-consistent.
- A-F3 (local run signs with the CI key): applied in part. The local run now uses R21's harness key, read from the ledger by its role, and holds R21's run lock for the run (stops if it is held), and the leak check scans for both keys. Rejected: the `gh run list` in-progress/queued check, because once the local run no longer touches the CI key a nightly cannot collide with it; the collision that remains (a usdcx `e2e:real` run on the harness key) is what the lock covers.
- A-F4 (size about twice the expectation): applied as asked: the measured size (about 1,550 added) is restated in File Structure and Self-Review, and the choice goes to the user as open question 2. No optional cut was applied unasked; the candidates, with sizes, are there.
- A-F5 (Guardian identity before the deposit; native asset outside the try): applied. `hostedGuardian` now runs inside `assert_guardian_account`, after the deposit row reached `received`, and that step hands the identity to the burn half (Task 4 Step 6 adds the `const identity =` and `return hosted;`, so commit 2 has no unused binding); `native_asset` is the first step inside the `try`, so its failure still writes the evidence. Verified: `/pubkey` answered a spike run with a 502 page, and main's deposit leg never reads it.
- A-F6 (one failed CDP eval fails a minutes-long poll): applied, in the readers rather than per poll. Verified: `pollUntil` fails on a failed read at once, `stashAndPoll` rethrows, and `cdp.eval` rejects after 30 s. A module `ridingOut` (3 attempts, 1 s apart, the third failure in a row throws) wraps `readTransactionRows`, `readVaultBaseUnits`, the generating page's hash read and `transactionDetailsView`, which covers every poll the finding lists (`waitForBurnCompleted`, `homeVaultBaseUnits`, `settleLedger`'s `readSettledChange`, the three burn-half `pollUntil`s and the pill poll) without changing `pollUntil`. Three tests (one per reader shape) and mutation 14 pin it; Task 2 Step 4 re-anchors after `ridingOut`.
- B-F1 (same as A-F1, with R21 re-anchoring of docs section 8): applied with A-F1; the docs step no longer anchors on section 8's wording, which R21 rewrites, but inserts a subsection before the `---` that closes section 8 (checked on a copy of PR 1b's doc: 6 lines, one blank line on each side).
- B-F2 (mutation 5 fails 2 tests): applied. Verified on the stub: with bytes read every poll the 409 test's Failed round is never read, so it resolves. Row 5 now predicts both titles; the new ride-out test for `waitForBurnCompleted` asserts the read count only, so mutation 5 does not fail it.
- B-F3 (`✕` never prints in the agent shell): applied on the critic's observed run (not re-run here: the failure headers print with or without per-test lines, so the fix holds either way). `mut()` greps `^Tests:|●` and the Expected line asks for one `●` failure header per predicted title.
- B-F4 (`$EDITOR` in a non-TTY shell, no gate before `gh pr create`): applied. The body's one placeholder is filled by script from a `RESULT` line, and `gh pr create` runs only when no `<...>` and no dash is left.
- Also fixed while editing: Delivery Step 7 no longer runs a foreground `sleep` (the Bash tool refuses one); it lists the dispatch run and asks again after about 20 s.

### Open questions for the user (resolved)

1. **Burn destination: R20 or the brief's fresh key?** The plan now follows R20 (burn back to the deposit key, delta-mode payout gate). Recommended: keep R20. It is the user's later, explicit ruling for iOS, it makes the nightly self-funding, and its one new risk (a late payout from an earlier night landing mid-run reads as a Circle red) is rare and named in the failure. If the fresh key is reaffirmed, A-F1 and B-F1 are undone: a `fresh_key` step (`newArcKey`, its private key into `secrets`, `recordArcKey`, a zero balance) replaces `burn_destination`, the payout gate drops `balanceBefore` and the confirmation expects `payout.value`, the guards pin `recordArcKey(` before the burn and one `.privateKey`, and the docs, header and PR body describe the stranded payout.
2. **Size: about 1,550 added lines against 650-800 expected.** Options: (a) split PR 2 at commit 1, the `IosWalletPage` readers, driver and 23 tests (about 865) as their own PR, then the spec, config, workflow, docs and CHANGELOG (about 700) stacked on it; (b) keep one PR of four commits; (c) on either, cut what no decision requires, about 100 lines: the two-chain Preferences refusal and its test (about 25; the Preferences read itself stays, it is the only source of `baseFee`), the bridged-send typing test (about 25), the receiving-tx link check (about 20), the light and dark review screenshots (about 6), and `routeOf` with its test (about 12, which then needs the review's query read from `location.hash` some other way). Recommended: (a), the split, as on PR 1 and the fund-faucet PR: each half reviews on its own, and nothing is cut from the checks the user asked for; (b) is close behind, since the commits already split by layer.


## Refresh log (2026-10-11, this split)

Every change against the unsplit plan `2026-10-11-usdcx-ios-burn-plan.md`, and why.

1. **Split.** This plan holds the old Tasks 1-2 only, with its own Setup and Delivery (the user's choice of old open question 2, option (a)). Worktree `wt-usdcx-ios-burn-a` and branch `wiktor/usdcx-ios-burn-a` replace `wt-usdcx-ios-burn` and `wiktor/usdcx-ios-burn`; every `cd` follows.
2. **Base re-verified at PR 1b's final head.** PR 1b merged as #1421 (`20949e612`); its git tree equals `d8345cbd4` except main's #1420 files (`dapp-known-bugs*.ts`). Every before-snippet in Tasks 1-2 (ios-wallet-page.ts:1-9, :32-35, :77, :292-304, :309-315; ios-wallet-page.test.ts:1-3 and its 161-line end) matched `d8345cbd4` verbatim, line numbers included: PR 1b never touched `playwright/e2e/ios/`. Setup Step 2 now proves the same with `git diff d8345cbd4 HEAD` instead of only grepping exports.
3. **Exports and line cites.** Every PR 1b name Tasks 1-2 import was re-checked at `d8345cbd4`: `bridgedSendRowOf` bridge.ts:465, `enText` :517, `USDCX_DESTINATION_CHIPS` :669, `NetworkChipState` :681, `usdcxChipsProblem` :688, `reviewQueryParam` :701, `isArcSnapshotFailure` :708, `usdcxPayoutRowsText` :761 (its refusal text still matches the allowance test), `readTransactionRowsInPage` history.ts:213 with `TransactionRowsQuery { dbName, storeName, type?, withBytes? }`, `TxStatus` :28, `burnFailureMessage` usdcx-guardian.ts:107 (its 409 line unchanged), `toBaseUnits` balance-truth.ts:45, the cache names `native_asset_id:v4` and `native_asset_fee:v2`. One cite was stale and is fixed: `ARC_CHAIN_ID` is usdcx-constants.ts:67, not :50.
4. **R26 folded into the driver.** `UsdcxBurnViaSendOptions` gains `signal?: AbortSignal`, the driver refuses to click submit once it has aborted (PR 1b's `withStepBudget` aborts an overrun step's signal, and `namedSteps` hands it to the step), with one test and mutation 12. R27 parked the same edge in the extension's existing `submitBurn` as churn; here the code is new, so the cost is one option and one test. Review Focus line 4 now covers it.
5. **Per-task commits.** Task 1 commits its own two files (PR 1b's ruling R1: every task is its own execution unit and commit) instead of deferring to Task 2.
6. **CHANGELOG line in this PR.** The unsplit plan put the only CHANGELOG line in its last commit; CI's changelog check fails any PR that adds none without a `no changelog` label (scripts/check-changelog.sh), so Task 2 adds one `[CHANGE][ci]` line and Delivery Step 1 runs the check locally.
7. **Counts.** 24 new tests (12 in Task 1, 12 in Task 2, the abort test the twelfth), so Task 2's red and green counts are 12 failed of 30 and 30 passed; the mutation table keeps the old rows 1-10 and 14 (renumbered 11) and adds 12.
8. **Delivery without a live run.** By the user's instruction nothing here needs one: no spec calls the new code. Delivery is gates, mutations, the internal review, push, PR, CI by SHA and an admin squash-merge with `--body` (the harness autonomy grant of 2026-10-11 covers the merge).
9. **Text.** R19's amounts stay in prose; the stale-amount grep keeps excluding the unit test file. The R20/R21 key rules, the evidence rules and the burn-half constraints moved to PR 2b's plan with the code they govern.

## Open questions for the user

1. **CHANGELOG entry or the `no changelog` label for this PR?** Recommended: the one-line `[CHANGE][ci]` entry (Task 2 Step 8), as every harness PR on this effort carried one; the label is for trivial changes. The alternative drops Task 2 Step 8 and needs the label set before CI's changelog check runs.
2. **Keep R26's abort check in the iOS driver?** Recommended: keep it (about 6 lines and one test); without it an overrun `burn_via_send` step can still submit a burn whose payout lands in a later night's window. The alternative matches the extension's parked `submitBurn` (R27) and drops the option, the check, the test and mutation 12.

import { expect, type Page } from '@playwright/test';

import type { IdbDumpSource } from './idb-dump';
import { dumpProveTelemetry } from '../harness/prove-telemetry-probe';
import { suspendScreenCapture } from '../harness/screen-capture';
import type { TimelineRecorder } from '../harness/timeline-recorder';

// Must satisfy CreatePassword's real strength gate (CreatePasswordScreen:
// isValidPassword requires >1 of {minChar, upper+lower, letter+digit,
// specialChar, strongLength}). The recovery journey drives that real UI, so a
// weak all-digit password (the old '123456') leaves the submit button disabled
// forever. This value passes all five checks. The bypass paths accept any value.
const PASSWORD = 'Test1234!';
const SYNC_WAIT_MS = 3_500;

/**
 * Floor for any claim-drain budget when running against the LOCAL stack (#718).
 *
 * Every `claimAllNotes` / `claimNotesByGroup` budget in the specs was tuned
 * against devnet/testnet, where a consume finishes in seconds — measured, the
 * whole three-note `multi-claim` journey runs in ~41s there. The local stack packs
 * a node, sequencer, ntx-builder, prover, guardian, note-transport and two Chrome
 * instances onto a 2-core CI runner, and the same consume takes minutes. Those
 * budgets therefore expire while the claim is still legitimately running and
 * report it as stuck.
 *
 * A floor rather than a multiplier: the budgets differ per spec for reasons that
 * have nothing to do with the stack (note counts, whether a send precedes the
 * claim), and multiplying would scale a 420s outlier to something no spec timeout
 * allows. Applies to `localhost` only, so every other network keeps the number its
 * spec asked for.
 *
 * Kept well under the suites' job timeouts on purpose. A floor only ever binds on
 * a claim that is NOT draining, so raising it spends its whole value on failing
 * runs — at 420s the local suite stopped finishing inside its 75-minute cap, which
 * cost the very diagnostics a failing run exists to produce.
 */
const LOCAL_STACK_CLAIM_FLOOR_MS = process.env.E2E_NETWORK === 'localhost' ? 240_000 : 0;

/** The budget a claim drain should actually use — see {@link LOCAL_STACK_CLAIM_FLOOR_MS}. */
const effectiveClaimBudgetMs = (requested: number): number => Math.max(requested, LOCAL_STACK_CLAIM_FLOOR_MS);

/**
 * Strip an optional `0x` prefix and lowercase, so a guardian commitment read
 * from on-chain storage (`getGuardianCommitmentFromAccount`) compares equal to
 * one obtained from a guardian operator's `GET /pubkey` response — mirrors
 * `normalizeHex` in `src/lib/miden/guardian/operator-map.ts` (duplicated here
 * rather than imported so the E2E harness doesn't reach into `src/lib` — no
 * other file under `playwright/` does).
 */
function normalizeHex(h: string): string {
  return (h.startsWith('0x') ? h.slice(2) : h).toLowerCase();
}

/**
 * Sub-phase of an in-flight transaction (`ITransaction.stage` in
 * `src/lib/miden/db/types.ts`) while its `status` is still
 * Queued/GeneratingTransaction. Duplicated here rather than imported --
 * mirrors `normalizeHex` above: no file under `playwright/` reaches into
 * `src/lib`.
 */
export type TransactionStage =
  | 'syncing'
  | 'sending'
  | 'creating-proposal'
  | 'signing-proposal'
  | 'executing'
  | 'proving'
  | 'submitting'
  | 'confirming'
  | 'registering-guardian'
  | 'delivering'
  | 'guardian-syncing'
  | 'guardian-synced'
  | 'complete';

/**
 * `ITransaction.type` values `waitForStage` knows how to filter on --
 * duplicated (not imported) for the same reason as `TransactionStage` above.
 * Both types drive the same stage machine in `src/lib/miden/transaction/index.ts`
 * (`setTransactionStage` calls are keyed by stage name, not transaction type),
 * but only `switch-guardian` gets an explicit `'registering-guardian'` stamp
 * immediately before its guardian-register call
 * (`completeSwitchGuardianTransaction`, `transaction/complete.ts:369`) --
 * `replace-hot-key`'s equivalent call (`reRegisterCurrentStateOnGuardian` inside
 * `completeReplaceHotKeyTransaction`, `transaction/complete.ts:236-323`) has no
 * stage stamp of its own, so `'confirming'` (the last stage stamped before that
 * function runs, shared by both types at `transaction/index.ts:890`) is the
 * closest available proxy for "about to attempt guardian registration" on a
 * rotation row.
 */
export type StageTrackedTransactionType = 'switch-guardian' | 'replace-hot-key';

/**
 * Platform-neutral wallet interaction surface.
 *
 * Both ChromeWalletPage (extension via Playwright) and IosWalletPage
 * (simulator via appium-remote-debugger) implement this interface.
 * Test specs are written against WalletPage and imported into either
 * fixture; .page / .extensionId are NOT on the shared interface —
 * Chrome-only specs that reach into Playwright internals use the
 * ChromeWalletPageApi extension below.
 */
export interface WalletPage {
  navigateTo(hash: string): Promise<void>;
  navigateHome(): Promise<void>;
  createNewWallet(password?: string): Promise<{ address: string; seedPhrase: string[] }>;
  importWallet(seedPhrase: string[], password?: string): Promise<{ address: string }>;
  getAccountAddress(): Promise<string>;
  getBalance(tokenSymbol?: string): Promise<number>;
  triggerSync(force?: boolean): Promise<void>;
  claimAllNotes(timeoutMs?: number): Promise<void>;
  sendTokens(params: {
    recipientAddress: string;
    amount: string;
    isPrivate: boolean;
    tokenSymbol?: string;
  }): Promise<void>;
  waitForBalanceAbove(
    minBalance: number,
    timeoutMs: number,
    timeline?: TimelineRecorder,
    tokenSymbol?: string
  ): Promise<number>;
  lockWallet(): Promise<void>;
  unlockWallet(password?: string): Promise<void>;
  /**
   * Override the wallet's "delegate proof" Settings preference at runtime.
   * Backed by localStorage['delegate_proof_setting_key']. Passing `false`
   * forces local proving (offscreen-doc path on Chrome, native plugin on
   * mobile). The wallet reads this synchronously at every form render, so
   * the change takes effect on the next render — no reload needed.
   */
  setDelegateProofEnabled(enabled: boolean): Promise<void>;
  /**
   * On-chain auth structure of a Guardian account (overall threshold, signer
   * commitments, per-procedure thresholds) — for asserting the 3-key shape
   * (e.g. `update_guardian === 2`, two signers) which balance checks can't see.
   * Shared across Chrome (page.evaluate) and iOS (CDP evalAsync) so the same
   * assertion runs on both platforms.
   */
  getGuardianAuthInfo(accountPublicKey: string): Promise<GuardianAuthInfo>;
}

/**
 * Chrome-specific extension of WalletPage. Kept for spec blocks that
 * reach into the Playwright Page directly (currently multi-account's
 * DOM probe) and for captureStateFrom entries that pass extensionId.
 */
export interface ChromeWalletPageApi extends WalletPage, IdbDumpSource {
  readonly page: Page;
  readonly extensionId: string;
  readonly userDataDir: string;
  /**
   * The wallet's derived EVM address (`0x…`) — the Epoch earn EVM owner. Chrome
   * only (the earn e2e is Chrome); add to WalletPage + the mobile POMs when earn
   * specs run on device.
   */
  getEvmAddress(): Promise<string>;
  /**
   * Complete the create-wallet flow choosing the Guardian recovery method,
   * pointing the account at `guardianUrl` (a locally-spawned guardian). The
   * returned `seedPhrase` is the account's real recovery mnemonic (read back
   * off the E2E-only `__TEST_LAST_GENERATED_SEED__` global the onboarding
   * bypass stashes it on) -- usable to recover this exact account from a
   * separate, clean wallet profile via `recoverGuardianFromSeed`.
   */
  createGuardianWallet(guardianUrl: string, password?: string): Promise<{ address: string; seedPhrase: string[] }>;
  /** Fast, non-invasive balance + pending-notes + outgoing-tx snapshot. */
  quickBalanceSnapshot(): Promise<{
    balance: number;
    pendingNotes: Array<{ id: string; amount: number; faucetId: string }>;
    pendingSum: number;
    totalReportable: number;
    pendingTxCount: number;
    latestTxId?: string;
    error?: string;
  }>;
  /**
   * Refresh the Zustand `balances` projection from the account vault so a
   * subsequent quickBalanceSnapshot() reflects freshly-consumed notes. See the
   * implementation for why the stress settle loop needs this.
   */
  refreshBalances(): Promise<void>;
  /** Full dump of chrome.storage.local — end-of-run forensic snapshot. */
  dumpChromeStorage(): Promise<Record<string, unknown>>;
  /**
   * One line per `TridentMain.transactions` row (`id·type·status·stage·error`) —
   * the fastest way to see WHY a claim or send stalled, instead of inferring it
   * from a balance that never moved. Implemented on ChromeWalletPage and used by
   * specs through this interface, so it has to be declared here.
   */
  dumpTransactions(): Promise<string>;
  /**
   * Send value this wallet queued that never moved, split into terminally
   * Failed and still-in-flight. Lets a caller reconcile a driver's optimistic
   * "sent" bookkeeping against what the wallet actually settled — see the
   * implementation. Chrome-only, like the stress suite that consumes it.
   */
  unlandedSendTotals(): Promise<{
    completed: number;
    completedCount: number;
    failed: number;
    pending: number;
    failedCount: number;
    pendingCount: number;
    totalCount: number;
    failedMaybeSubmitted: number;
    failedMaybeSubmittedCount: number;
    pendingEligibleAtMax: number;
    storeMissing: boolean;
  }>;
  /**
   * Drain pending notes via the two-level per-faucet GROUP-claim UI (Pending
   * tab → asset detail → group claim / per-note claim) instead of the top-level
   * "Claim All". Chrome-only: mobile page objects cover their React Claim All
   * button path separately.
   */
  claimNotesByGroup(timeoutMs?: number): Promise<void>;
  // getGuardianAuthInfo is declared on the shared WalletPage interface (above)
  // so the iOS POM implements it too — the 3-key auth assertion runs on both.
  // IndexedDB forensics (listIndexedDBStores / dumpIndexedDBStore) come from
  // IdbDumpSource — driven store-at-a-time by streamIndexedDBToFile so a long
  // run's dump can't OOM the page. This is where the Miden SDK keeps per-tx
  // commit status — the ground truth for "did this tx land?".

  /**
   * Drive the real Settings → RotateGuardian → RotateGuardianReview → confirm
   * → password reauthentication flow to switch the current account's guardian
   * to `newEndpoint`, then await
   * the resulting `switch-guardian` transaction reaching Completed (throws on
   * Failed or timeout). `newEndpoint` must match one entry's `endpoint` from
   * `getGuardianOptionsForNetwork()` — e.g. the localnet-only second guardian
   * (gated on `MIDEN_E2E_TEST`) at `http://localhost:3001`.
   */
  switchGuardian(newEndpoint: string): Promise<void>;
  /**
   * Recover a Guardian account from its seed phrase.
   *
   * `viaUI: false` — fast path via the onboarding `__test_skip_onboarding`
   * bypass (`walletType=guardian&seed=…`), mirroring `createGuardianWallet`.
   * `guardianUrl`, if given, is threaded through the bypass as the onboarding
   * guardian-endpoint OVERRIDE (a `guardianUrl` query param) — the same path
   * production uses — so the vault's import-recovery scan (`Vault.spawn`) probes
   * the RIGHT guardian instead of falling back to the network default. Pass it
   * whenever the recovery must target a specific operator on a fresh profile.
   *
   * `viaUI: true` — drives the real recovery journey: Welcome → "Recover your
   * account" → 12-word seed grid → submit → (extension: full password step,
   * unavoidable off-mobile) → ImportRecoveryMethod (probe-detected or manual)
   * → Continue → Confirmation → submit → `completeHotKeyRotation()`.
   */
  recoverGuardianFromSeed(seed: string, opts: { viaUI: boolean; guardianUrl?: string }): Promise<void>;
  /**
   * Drive a fresh, not-yet-onboarded wallet from the Welcome screen to the
   * ImportSeedPhrase 12-word grid (Welcome → "Recover your account"),
   * stopping there instead of completing the rest of the recovery journey.
   * For probes that only need to exercise seed-phrase VALIDATION (e.g.
   * case-insensitivity / paste handling) — see `recoverGuardianFromSeed`
   * for the full end-to-end recovery flow this is a prefix of. Requires the
   * page to still be on a fresh profile (i.e. nothing has been created or
   * recovered on it yet).
   */
  openImportSeedPhraseScreen(): Promise<void>;
  /**
   * Observe the `HotKeyRotationGate` blocking overlay to its cleared
   * (unmounted) state — the authoritative "rotation complete" signal (the
   * flag clears only once `replace_signer` lands on-chain). Throws if the
   * gate instead reaches its terminal-failure surface (`hot-key-rotation-failed`)
   * within the timeout, or if the gate never appears at all.
   */
  completeHotKeyRotation(): Promise<void>;
  /**
   * Assert a Guardian account's on-chain auth shape via `getGuardianAuthInfo`:
   * the active signer count and the `update_guardian` procedure threshold
   * (mirrors the pattern already used in guardian-send-consume.spec.ts).
   * `guardianCommitment`, if given, is asserted against `info.guardianCommitment`
   * — the active guardian-operator commitment read from the on-chain
   * `GUARDIAN_SLOT_NAMES.PUBLIC_KEY` storage slot. This is a SEPARATE slot from
   * the multisig `signerCommitments` (`[hot, cold]`): a guardian switch changes
   * the guardian commitment while the signer set / `update_guardian` threshold
   * stay put, so this is the field that actually proves a switch landed — do
   * NOT assert `guardianCommitment` as a member of `signerCommitments`, it
   * never is. The expected value is whatever the spec obtains from the target
   * guardian's `GET /pubkey?scheme=ecdsa` (`{ commitment, pubkey }`) — the
   * same hex representation (mod `0x` prefix / case; compared normalized),
   * per production's own `resolveGuardianDrift` / `identifyGuardianOperator`
   * (`src/lib/miden/back/guardian-drift.ts`,
   * `src/lib/miden/guardian/operator-map.ts`), which perform this exact
   * cross-check between the two sources.
   */
  assertGuardianAuth(
    pk: string,
    expected: { signerCount: number; threshold: number; guardianCommitment?: string }
  ): Promise<void>;
  /**
   * Read the current account's active guardian endpoint straight from the
   * frontend Zustand store's `currentAccount.guardianEndpoint` -- the exact
   * field `useCurrentGuardianEndpoint()` (`app/hooks/useCurrentGuardianEndpoint.ts`,
   * backing GuardianSettings / RotateGuardian) prioritizes over the legacy
   * global storage key. `completeSwitchGuardianTransaction`
   * (`lib/miden/transaction/complete.ts`) persists this PER-ACCOUNT (not just
   * in-memory) via `setGuardianEndpoint`, so it's also what should survive a
   * `reopen()`. Returns `''` if unset or the store is unavailable.
   */
  currentGuardianEndpoint(): Promise<string>;
  /**
   * Close and reopen the wallet: closes the current extension page and opens
   * a fresh one navigated back to `fullpage.html` -- mirroring a user closing
   * the wallet tab and reopening it a moment later. The service worker (and
   * therefore any in-memory vault key) is untouched by this, since only the
   * PAGE is torn down; IndexedDB persists regardless. `this.page` is updated
   * to the fresh page so subsequent POM calls operate on it. Waits for the
   * page to settle back on either the Explore surface (the common case,
   * still unlocked) or the unlock screen, unlocking with the default test
   * password if needed. Used to prove state that must be durably persisted
   * (e.g. a switched guardian endpoint) survives a fresh session, not just
   * the one that made the change.
   *
   * Returns whether it took the crash-recovery RELAUNCH path -- i.e. the browser
   * was dead, so the whole persistent context was relaunched from the on-disk
   * profile with a cold SW -- vs a normal warm page swap. A spec that used
   * `killBrowser()` can assert the return is `true` to prove the crash path
   * actually ran (guarding against e.g. a Playwright change that made
   * `killBrowser()` a no-op, which would otherwise pass silently on the fast
   * path).
   */
  reopen(): Promise<boolean>;
  /**
   * Terminate the wallet mid-flight: closes the current page and, unlike
   * `reopen()`, does NOT open a fresh one -- models a user closing the
   * wallet tab (or the tab crashing) while an operation is in progress.
   * The extension service worker is a SEPARATE process/context and is left
   * completely untouched (no `chrome.runtime.reload()`, same rationale as
   * `reopen()`'s doc comment) -- only the page is torn down, so anything the
   * SW itself is awaiting (e.g. a guardian HTTP round-trip) keeps running
   * regardless of this call.
   *
   * Callers must follow up with `reopen()` (or their own fresh page) to
   * interact with the wallet again; `this.page` is left pointing at the
   * closed page in the meantime.
   */
  kill(): Promise<void>;
  /**
   * Like `kill()`, but tears down the ENTIRE browser (its persistent context
   * AND the service worker), not just the page -- simulating the wallet's whole
   * Chromium process crashing mid-flight, which the CI runner does
   * intermittently in these specs. The follow-up `reopen()` detects the dead
   * browser and recovers by relaunching the context on the same on-disk profile,
   * so the wallet is restored from its persisted IndexedDB state and comes back
   * USABLE (the SW's in-memory vault key is gone, so it comes back locked and
   * `reopen()` unlocks it). Use this over `kill()` when a spec must
   * DETERMINISTICALLY exercise that crash-recovery relaunch path rather than rely
   * on an incidental (~coin-flip) crash. Callers must follow up with `reopen()`.
   *
   * NOTE: this does NOT auto-resume an in-flight transaction. Production's
   * cold-start handler (`runtime.onStartup` -> `failInterruptedTransactions`)
   * deliberately FAILS interrupted rows and requires a manual Retry, and the
   * unpacked test extension never fires `runtime.onStartup` on relaunch anyway
   * -- so a spec must not assert that a transaction interrupted by killBrowser()
   * resumes (see guardian-recovery-stress.spec.ts's browser-crash describe).
   */
  killBrowser(): Promise<void>;
  /**
   * Poll for a transaction row of `transactionType` (`ITransaction.stage` in
   * `src/lib/miden/db/types.ts`) to reach `stage` while its status is still
   * GeneratingTransaction -- read straight from the SDK's Dexie
   * `transactions` store via raw IndexedDB (same idiom as the private
   * `waitForTransactionRowComplete` this class already uses for
   * `switchGuardian`'s own completion wait).
   *
   * Exists for stress specs that call `switchGuardian(...)` (or, via
   * `recoverGuardianFromSeed`/`HotKeyRotationGate`, a `replace-hot-key`
   * rotation) **without** awaiting it (so they can `kill()` mid-flight) --
   * such a caller never gets a transaction id back, but there is exactly one
   * row of a given `transactionType` in flight per account at a time, so
   * matching on type + status is unambiguous without one.
   *
   * `transactionType` defaults to `'switch-guardian'` (this method's
   * original, and still most common, caller); pass `'replace-hot-key'` to
   * track a device-key rotation row instead -- see `StageTrackedTransactionType`'s
   * doc comment for why `'confirming'` is the closest available stage for that
   * type (it has no `'registering-guardian'`-equivalent stamp of its own).
   */
  waitForStage(
    stage: TransactionStage,
    timeoutMs?: number,
    transactionType?: StageTrackedTransactionType
  ): Promise<void>;
  /**
   * Wait until no transaction row is left `Queued`/`GeneratingTransaction`
   * (`ITransactionStatus` 0/1) -- i.e. the FIFO processing loop
   * (`safeGenerateTransactionsLoop`, `src/lib/miden/transaction/index.ts`) has
   * driven every currently-known transaction to a terminal state (`Completed`
   * or `Failed`).
   *
   * Exists for stress specs that fire multiple transactions concurrently
   * (e.g. a `sendTokens(...)` and a `switchGuardian(...)` in the same
   * `Promise.all`) and need to wait for BOTH to actually finish processing
   * before reading final account state. Unlike `switchGuardian`, which awaits
   * its own transaction row internally (`waitForTransactionRowComplete`),
   * `sendTokens` resolves as soon as its submit button detaches -- the UI's
   * "accepted" signal -- well before the underlying tx clears the
   * per-account guardian lock (`withGuardianAccountLock`,
   * `lib/miden/guardian/serialize.ts`) that serializes it against any other
   * in-flight guardian transaction for the same account. Polling raw
   * IndexedDB (same idiom as `waitForStage` / the private
   * `waitForTransactionRowComplete`) is what actually proves both operations
   * settled, rather than just both UI submissions having been accepted.
   */
  waitForQueueDrained(timeoutMs?: number): Promise<void>;
}

export interface GuardianAuthInfo {
  threshold: number;
  signerCommitments: string[];
  procedureThresholds: Record<string, number>;
  /**
   * Active guardian-operator commitment (`GUARDIAN_SLOT_NAMES.PUBLIC_KEY`) —
   * a SEPARATE on-chain storage slot from `signerCommitments` above (which is
   * the multisig `[hot, cold]` signer set). Undefined if the account has no
   * guardian slot set, or the hook predates this field (older builds).
   */
  guardianCommitment?: string;
  error?: string;
}

/**
 * Page Object Model for a single wallet extension instance.
 * Encapsulates all UI interactions, reusing selectors from popup-smoke.spec.ts.
 */
export class ChromeWalletPage implements ChromeWalletPageApi {
  private currentPage: Page;
  readonly extensionId: string;
  readonly userDataDir: string;
  // Optional recovery hook (wired by the two-wallets fixture). reopen() calls it
  // when it finds the browser PROCESS dead (not just the page): it relaunches
  // this wallet's persistent context on the same userDataDir and returns the
  // fresh page, so the wallet resumes from its on-disk profile.
  private readonly relaunch?: () => Promise<Page>;

  constructor(page: Page, extensionId: string, userDataDir: string = '', relaunch?: () => Promise<Page>) {
    this.currentPage = page;
    this.extensionId = extensionId;
    this.userDataDir = userDataDir;
    this.relaunch = relaunch;
  }

  /**
   * Current Playwright page for this wallet instance. Mutable (unlike
   * `extensionId`/`userDataDir`) because `reopen()` swaps in a fresh page
   * after closing the old one -- every other method reads through this
   * getter so they transparently pick up the swap.
   */
  get page(): Page {
    return this.currentPage;
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  private get fullpageUrl(): string {
    return `chrome-extension://${this.extensionId}/fullpage.html`;
  }

  async navigateTo(hash: string): Promise<void> {
    await this.page.goto(`${this.fullpageUrl}#${hash}`, { waitUntil: 'domcontentloaded' });
  }

  async navigateHome(): Promise<void> {
    const currentUrl = this.page.url();
    // Skip navigation if already on the fullpage (avoid re-triggering WASM init)
    if (currentUrl.startsWith(`chrome-extension://${this.extensionId}/fullpage.html`)) {
      // Navigate to home hash if on a sub-route
      if (currentUrl.includes('#/') && !currentUrl.endsWith('#/')) {
        await this.page.goto(`${this.fullpageUrl}#/`, { waitUntil: 'domcontentloaded' });
      }
      return;
    }
    await this.page.goto(this.fullpageUrl, { waitUntil: 'domcontentloaded' });
    await this.page.waitForSelector('#root > *', { timeout: 60_000 });
  }

  // ── Onboarding ────────────────────────────────────────────────────────────

  /**
   * Create a Guardian-backed wallet pointed at a locally-spawned guardian.
   * Threads the guardian endpoint through the v0-UI test bypass as the
   * onboarding override (the bypass create flow has no custom-URL field), so the
   * new account binds to it exactly as the production guardian picker would.
   */
  async createGuardianWallet(
    guardianUrl: string,
    password: string = PASSWORD
  ): Promise<{ address: string; seedPhrase: string[] }> {
    return this.createWalletViaBypass({ walletType: 'guardian', guardianUrl, password });
  }

  /**
   * Drive the v0-UI onboarding via the `__test_skip_onboarding` bypass baked
   * into Welcome.tsx. Navigating fullpage.html with the bypass query params
   * sets the onboarding state (Import when `seed` is present, random Create
   * otherwise) and auto-advances to the Confirmation screen. Clicking
   * "Open wallet" runs register() which creates the vault in the SW.
   */
  private async createWalletViaBypass(opts: {
    walletType: 'offchain' | 'guardian';
    password: string;
    guardianUrl?: string;
    seed?: string[];
  }): Promise<{ address: string; seedPhrase: string[] }> {
    // The bypass skips the ChooseGuardian / ImportRecoveryMethod screens that
    // would normally set the onboarding guardian endpoint, so thread it in via
    // the `guardianUrl` query param instead. Welcome.tsx reads it into its
    // guardianEndpoint state and register() forwards it as the OVERRIDE — the
    // same path production uses — so createGuardianAccount (create) and
    // Vault.spawn's recovery scan (import) both bind to it. Decoupled from the
    // retired global GUARDIAN_URL_STORAGE_KEY: stage-3 create no longer reads
    // that key, and recovery only consults it as a frozen last-resort fallback.
    // `createGuardianWallet` / `createNewWallet` always pass a URL (required by
    // their signatures); `recoverGuardianFromSeed(..., { viaUI: false })` passes
    // one whenever it needs a specific operator.
    const params = new URLSearchParams();
    params.set('__test_skip_onboarding', '1');
    params.set('password', opts.password);
    if (opts.walletType === 'guardian') {
      params.set('walletType', 'guardian');
      if (opts.guardianUrl) {
        params.set('guardianUrl', opts.guardianUrl);
      }
    }
    if (opts.seed && opts.seed.length > 0) {
      params.set('seed', opts.seed.join(' '));
    }

    await this.page.goto(`${this.fullpageUrl}?${params.toString()}`, { waitUntil: 'domcontentloaded' });

    // The bypass auto-navigates to the Confirmation screen once it has applied
    // the onboarding state.
    await this.page.getByTestId('onboarding-confirmation').waitFor({ timeout: 60_000 });

    // Click "Open wallet" — this triggers register() which creates the vault in
    // the SW. Do NOT reload afterwards: that kills the in-flight intercom request.
    await this.page.getByTestId('onboarding-confirmation-submit').click();

    // Wait for the wallet to be ready. The new home (Explore) has no stable
    // "Send"/"Receive" text, so signal on the store's currentAccount.publicKey
    // (register() populates it in place — no reload) or the home page testid.
    try {
      await this.page.waitForFunction(
        () => {
          const store = (
            window as unknown as { __TEST_STORE__?: { getState(): { currentAccount?: { publicKey?: string } } } }
          ).__TEST_STORE__;
          const pk = store?.getState?.().currentAccount?.publicKey ?? '';
          if (/^m[a-z]{1,4}1[a-z0-9]+/i.test(pk)) return true;
          return !!document.querySelector('[data-testid="explore-page"]');
        },
        // `arg` (3rd overload param is `options`) must be passed explicitly:
        // omitting it shifts `{ timeout }` into the `arg` slot for a
        // zero-parameter pageFunction, silently dropping the timeout override
        // (only ever surfaced a hang, never a fast reject -- see guardian-fault
        // A3's smoke test, the first caller to exercise the failure path).
        undefined,
        { timeout: 120_000 }
      );
    } catch (e) {
      const bodyText = await this.page
        .locator('body')
        .textContent()
        .catch(() => '');
      throw new Error(
        `Wallet creation did not reach the home surface. ` +
          `Original error: ${e instanceof Error ? e.message : String(e)}. ` +
          `Body text (first 500): ${(bodyText ?? '').slice(0, 500)}`
      );
    }

    const address = await this.getAccountAddress();

    // The bypass's Welcome.tsx effect stashes the mnemonic it actually used
    // (freshly generated for Create, or the caller's own for Import) on
    // `__TEST_LAST_GENERATED_SEED__` -- see that effect's doc comment. Prefer
    // it over `opts.seed` so a CREATE call (no seed supplied) still returns
    // the real, recoverable mnemonic instead of an empty array; fall back to
    // `opts.seed` only if the global is missing (e.g. an older extension
    // build without the hook).
    const generatedSeed = await this.page
      .evaluate(
        () => (globalThis as unknown as { __TEST_LAST_GENERATED_SEED__?: string }).__TEST_LAST_GENERATED_SEED__ ?? ''
      )
      .catch(() => '');
    const seedPhrase = generatedSeed ? generatedSeed.trim().split(/\s+/) : (opts.seed ?? []);

    return { address, seedPhrase };
  }

  /**
   * Complete the "Create a new wallet" onboarding flow via the v0-UI bypass.
   * Returns the wallet address and the account's real recovery mnemonic (see
   * `createWalletViaBypass`'s `__TEST_LAST_GENERATED_SEED__` doc comment).
   */
  async createNewWallet(
    password: string = PASSWORD,
    options: { recovery?: 'private' | 'guardian'; guardianUrl?: string } = {}
  ): Promise<{ address: string; seedPhrase: string[] }> {
    return this.createWalletViaBypass({
      walletType: options.recovery === 'guardian' ? 'guardian' : 'offchain',
      guardianUrl: options.guardianUrl,
      password
    });
  }

  /**
   * Complete the "Import with seed phrase" onboarding flow via the v0-UI bypass.
   */
  async importWallet(seedPhrase: string[], password: string = PASSWORD): Promise<{ address: string }> {
    const { address } = await this.createWalletViaBypass({ walletType: 'offchain', password, seed: seedPhrase });
    return { address };
  }

  /**
   * Extract the wallet account address.
   *
   * Primary path: read from the Zustand `__TEST_STORE__` (which holds the
   * canonical bech32 string for the current network — `mdev1…` on devnet,
   * `mtst1…` on testnet, etc.), polling briefly because right after the
   * onboarding flow the store update is asynchronous.
   *
   * DOM fallback: if the store is still empty after the poll (something went
   * wrong with the sync path), scan the Receive page for any bech32-shaped
   * string. We used to do this DOM scan first with a `getByText(/your address/i)`
   * anchor, but no such label exists in the current UI, so the scan always
   * fell through to the text-match fallback — which was hardcoded to `mtst`.
   * Hence `getAccountAddress` silently failed on devnet and the caller's own
   * outer fallback returned the literal string `"unknown"`, poisoning downstream
   * CLI calls with `mint --target unknown`.
   */
  async getAccountAddress(): Promise<string> {
    const bechRe = /m[a-z]{1,4}1[a-z0-9]+/i;

    // Poll the store for up to 10s — covers the slow case where the post-
    // onboarding StateUpdated broadcast hasn't landed in Zustand yet.
    const storeAddress = await this.page
      .waitForFunction(
        () => {
          const store = (
            window as unknown as { __TEST_STORE__?: { getState(): { currentAccount?: { publicKey?: string } } } }
          ).__TEST_STORE__;
          const pk = store?.getState?.().currentAccount?.publicKey ?? '';
          return /^m[a-z]{1,4}1[a-z0-9]+/i.test(pk) ? pk : false;
        },
        { timeout: 10_000 }
      )
      .then(handle => handle.jsonValue() as Promise<string>)
      .catch(() => '');
    if (storeAddress) {
      return storeAddress.trim();
    }

    // DOM fallback. Navigate to receive (lands on the Address tab by default)
    // and read the untruncated address from the sr-only span. If that span is
    // empty, scan the Address tab body for a bech32-shaped string.
    await this.navigateTo('/receive');
    const receiveContainer = this.page.getByTestId('receive-page');
    await receiveContainer.waitFor({ timeout: 15_000 });

    const fullAddress =
      (await this.page
        .getByTestId('receive-address-full')
        .textContent()
        .catch(() => '')) ?? '';
    if (fullAddress.trim()) {
      await this.navigateHome();
      return fullAddress.trim();
    }

    const allText = (await receiveContainer.textContent()) ?? '';
    const match = allText.match(bechRe);
    if (!match) {
      throw new Error(
        `Could not extract wallet address. Store had no currentAccount.publicKey, ` +
          `and no bech32 address found on Receive page. Receive text: ${allText.slice(0, 200)}`
      );
    }
    await this.navigateHome();
    return match[0].trim();
  }

  /**
   * Read the wallet's derived EVM address (`0x…`) from the Zustand
   * `__TEST_STORE__` currentAccount, polling briefly (it's derived
   * asynchronously after onboarding). The earn-withdraw e2e needs it to seed the
   * position under the wallet's OWN EVM owner — `EarnWithdrawReview` aborts with
   * `earnWithdrawNotOwned` unless `account.evmAddress === position.owner`.
   */
  async getEvmAddress(): Promise<string> {
    const evm = await this.page
      .waitForFunction(
        () => {
          const store = (
            window as unknown as { __TEST_STORE__?: { getState(): { currentAccount?: { evmAddress?: string } } } }
          ).__TEST_STORE__;
          const addr = store?.getState?.().currentAccount?.evmAddress ?? '';
          return /^0x[0-9a-fA-F]{40}$/.test(addr) ? addr : false;
        },
        { timeout: 15_000 }
      )
      .then(handle => handle.jsonValue() as Promise<string>)
      .catch(() => '');
    if (!evm) {
      throw new Error(
        'Could not read currentAccount.evmAddress from __TEST_STORE__ (earn withdraw needs the wallet EVM owner).'
      );
    }
    return evm.trim();
  }

  // ── Balance ───────────────────────────────────────────────────────────────

  /**
   * Non-invasive snapshot of the wallet's balance-related state. Unlike
   * getBalance() it:
   *   - does NOT navigate
   *   - does NOT call state.fetchBalances (which triggers an RPC)
   *   - does not require the Explore page to be visible
   *
   * Reads straight from the Zustand store + `chrome.storage.local`:
   *   - `balance` = consumed vault assets, as last projected into the store
   *   - `pendingNotes` = full list of claimable notes (id + amount)
   *   - `totalReportable` = balance + Σ pendingNotes
   *   - `pendingTxCount` / `lastTxId` = wallet's recent outgoing transactions
   *
   * Safe to call every op: measured at ~50 ms per wallet.
   *
   * CAVEAT: because it skips `fetchBalances`, the `balance` half is only as
   * fresh as the store's last projection. A note that has been consumed but
   * not yet re-fetched into `state.balances` is in neither `balance` nor
   * `pendingNotes`, so `totalReportable` transiently under-counts. Callers that
   * need an authoritative total (e.g. a conservation assertion) must call
   * refreshBalances() first — unlike getBalance(), which refreshes internally.
   */
  async quickBalanceSnapshot(): Promise<{
    balance: number;
    pendingNotes: Array<{ id: string; amount: number; faucetId: string }>;
    pendingSum: number;
    totalReportable: number;
    pendingTxCount: number;
    latestTxId?: string;
    error?: string;
  }> {
    try {
      return await this.page.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__TEST_STORE__;
        const state = store?.getState?.();
        let balance = 0;
        for (const tokenList of Object.values(state?.balances || {}) as unknown[]) {
          if (!Array.isArray(tokenList)) continue;
          for (const token of tokenList) {
            const amount = parseFloat(String(token.amount ?? token.balance ?? '0'));
            if (amount > 0) balance += amount;
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storage = await new Promise<any>(resolve => {
          chrome.storage.local.get(['miden_sync_data'], resolve);
        });
        const notes = storage?.miden_sync_data?.notes ?? [];
        const pendingNotes: Array<{ id: string; amount: number; faucetId: string }> = [];
        let pendingSum = 0;
        for (const note of notes) {
          const baseUnits = parseInt(String(note.amountBaseUnits ?? '0'), 10);
          const decimals = note.metadata?.decimals ?? 8;
          const amount = baseUnits / Math.pow(10, decimals);
          pendingNotes.push({ id: String(note.id ?? ''), amount, faucetId: String(note.faucetId ?? '') });
          pendingSum += amount;
        }

        // Outgoing transaction queue (from Zustand — shape: {[id]: record} or array)
        let pendingTxCount = 0;
        let latestTxId: string | undefined;
        const txs = state?.transactions;
        if (txs && typeof txs === 'object') {
          const list = Array.isArray(txs) ? txs : Object.values(txs);
          pendingTxCount = list.length;
          // Pick the most recent by timestamp if available
          let mostRecent: { id?: string; timestamp?: number } | null = null;
          for (const t of list as Array<{ id?: string; transactionId?: string; timestamp?: number }>) {
            const id = t.id ?? t.transactionId;
            const ts = t.timestamp ?? 0;
            if (!mostRecent || ts > (mostRecent.timestamp ?? 0)) {
              mostRecent = { id, timestamp: ts };
            }
          }
          latestTxId = mostRecent?.id;
        }

        return {
          balance,
          pendingNotes,
          pendingSum,
          totalReportable: balance + pendingSum,
          pendingTxCount,
          latestTxId
        };
      });
    } catch (e) {
      return {
        balance: 0,
        pendingNotes: [],
        pendingSum: 0,
        totalReportable: 0,
        pendingTxCount: 0,
        error: e instanceof Error ? e.message : String(e)
      };
    }
  }

  /**
   * Dump every key in chrome.storage.local — used at end-of-run for forensic
   * analysis. Includes miden_sync_data (notes + vaultAssets), connectivity-
   * issue flag, cached metadata, etc.
   */
  async dumpChromeStorage(): Promise<Record<string, unknown>> {
    try {
      return await this.page.evaluate(
        () =>
          new Promise<Record<string, unknown>>(resolve => {
            chrome.storage.local.get(null, items => resolve(items || {}));
          })
      );
    } catch (e) {
      return { __error: e instanceof Error ? e.message : String(e) };
    }
  }

  async getGuardianAuthInfo(accountPublicKey: string): Promise<GuardianAuthInfo> {
    return this.page.evaluate(async (pk: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (globalThis as any).__TEST_GUARDIAN_AUTH__;
      if (!fn) {
        return {
          threshold: NaN,
          signerCommitments: [],
          procedureThresholds: {},
          error: '__TEST_GUARDIAN_AUTH__ unavailable (needs MIDEN_E2E_TEST build)'
        };
      }
      return await fn(pk);
    }, accountPublicKey);
  }

  // ── Guardian switch / recovery ───────────────────────────────────────────────

  /**
   * Drive RotateGuardian → RotateGuardianReview → confirm to switch the
   * current account's guardian to `newEndpoint`, then await the resulting
   * `switch-guardian` transaction reaching Completed.
   *
   * Navigates straight to `/rotate-guardian` (the real top-level route
   * `RotateGuardian.tsx` renders at -- see `PageRouter.tsx`) rather than via
   * Settings → "Guardian Settings" → its `rotateGuardian` button. That page is
   * now reachable by hash nav too (`/settings/guardian-settings` used to be a
   * `<Drawer>` that `Settings`'s `activeTab` lookup deliberately excluded, which
   * made a direct hash navigation fall back to the Settings root list), but
   * `/rotate-guardian` still mounts `ChooseGuardianScreen` with no further click
   * needed, matching how every other flow helper in this file (`sendTokens`,
   * etc.) navigates straight to a flow's route instead of clicking through
   * menus. Note the guardian row only exists for a Guardian account.
   */
  async switchGuardian(newEndpoint: string): Promise<void> {
    await this.navigateTo('/rotate-guardian');

    // ChooseGuardian (RotateGuardian.tsx): pick the option whose endpoint
    // matches, then continue to the review screen.
    await this.page.getByTestId('onboarding-choose-guardian').waitFor({ timeout: 20_000 });
    const endpointOption = this.page.locator(`[data-guardian-endpoint="${newEndpoint}"]`);
    const optionCount = await endpointOption.count().catch(() => 0);
    if (optionCount === 0) {
      throw new Error(
        `switchGuardian: no guardian picker option with endpoint "${newEndpoint}" ` +
          `(check getGuardianOptionsForNetwork() / MIDEN_E2E_TEST for the localnet 2nd guardian)`
      );
    }
    await endpointOption.first().click();
    await this.page.getByTestId('choose-guardian-continue').click();

    // RotateGuardianReview: Confirm now opens the fresh-authentication step;
    // extension wallets use the password established during onboarding.
    const confirmButton = this.page.getByTestId('rotate-guardian-confirm');
    await confirmButton.waitFor({ timeout: 20_000 });
    await confirmButton.click();

    const passwordInput = this.page.locator('#rotate-guardian-password');
    await passwordInput.waitFor({ timeout: 20_000 });
    await passwordInput.fill(PASSWORD);
    await this.page.getByTestId('rotate-guardian-auth-submit').click();

    // Follow the authenticated tx to the generating-transaction screen and
    // read its final status straight from IndexedDB (mirrors bridge/swap helpers).
    await this.page.waitForURL(/generating-transaction/, { timeout: 60_000 });
    const txId = this.extractTransactionIdFromUrl();
    if (!txId) {
      throw new Error(`switchGuardian: could not extract a transaction id from URL ${this.page.url()}`);
    }
    await this.waitForTransactionRowComplete(txId);
  }

  /**
   * See the interface doc comment (ChromeWalletPageApi).
   */
  async openImportSeedPhraseScreen(): Promise<void> {
    // Welcome → "Recover your account" → ImportSeedPhrase (12-word grid).
    await this.page.goto(this.fullpageUrl, { waitUntil: 'domcontentloaded' });
    await this.page.getByTestId('onboarding-welcome').waitFor({ timeout: 30_000 });
    await this.page.locator('#import-link').click();
    await this.page.getByTestId('import-seed-phrase').waitFor({ timeout: 15_000 });
  }

  /**
   * Recover a Guardian account from its seed phrase. See the interface doc
   * comment (ChromeWalletPageApi) for the `viaUI` split.
   */
  async recoverGuardianFromSeed(seed: string, opts: { viaUI: boolean; guardianUrl?: string }): Promise<void> {
    const words = seed.trim().split(/\s+/);

    if (!opts.viaUI) {
      await this.createWalletViaBypass({
        walletType: 'guardian',
        password: PASSWORD,
        guardianUrl: opts.guardianUrl,
        seed: words
      });
      return;
    }

    await this.openImportSeedPhraseScreen();

    for (let i = 0; i < words.length; i++) {
      // `id="seed-phrase-input-N"` is the component's own stable per-word id
      // (see ImportSeedPhrase.tsx) — reused as-is rather than adding a
      // redundant data-testid.
      await this.page.locator(`#seed-phrase-input-${i}`).fill(words[i]!);
    }
    await this.page.getByTestId('import-seed-submit').click();

    // Extension builds have no hardware-security path (checkHardwareSecurityAvailable
    // is unconditionally false off mobile/desktop), so the import flow always
    // routes through the full password step before recovery-method selection.
    await this.page.getByTestId('create-password-input').waitFor({ timeout: 15_000 });
    await this.page.getByTestId('create-password-input').fill(PASSWORD);
    await this.page.getByTestId('create-password-verify-input').fill(PASSWORD);
    await this.page.getByTestId('create-password-submit').click();

    // ImportRecoveryMethod: wait for the guardian auto-detection probe to
    // reach a terminal state (detected or not), then accept it as-is — the
    // detected/default endpoint is prefilled and valid either way.
    await this.page
      .getByTestId('guardian-detected')
      .or(this.page.getByTestId('guardian-not-detected'))
      .first()
      .waitFor({ timeout: 30_000 });
    await this.page.getByTestId('recovery-method-continue').click();

    // Confirmation: submit runs register() (isImport=true, walletType=Guardian).
    await this.page.getByTestId('onboarding-confirmation').waitFor({ timeout: 30_000 });
    await this.page.getByTestId('onboarding-confirmation-submit').click();

    // A seed-only recovery can never recover the device-bound hot key, so the
    // recovered account always carries requiresHotKeyRotation — see
    // HotKeyRotationGate.tsx.
    await this.completeHotKeyRotation();
  }

  /**
   * Observe the `HotKeyRotationGate` blocking overlay to its cleared
   * (unmounted) state. Throws if it instead reaches its terminal-failure
   * surface within the timeout.
   */
  async completeHotKeyRotation(): Promise<void> {
    const gate = this.page.getByTestId('hot-key-rotation-gate');
    await gate.waitFor({ state: 'visible', timeout: 30_000 });

    await Promise.race([
      gate.waitFor({ state: 'detached', timeout: 120_000 }),
      this.page
        .getByTestId('hot-key-rotation-failed')
        .waitFor({ state: 'visible', timeout: 120_000 })
        .then(() => {
          throw new Error('completeHotKeyRotation: rotation reached its terminal-failure surface');
        })
    ]);
  }

  /**
   * Assert a Guardian account's on-chain auth shape via `getGuardianAuthInfo`.
   * See the interface doc comment for why `threshold` maps to the
   * `update_guardian` procedure threshold rather than the overall multisig
   * threshold, and how `guardianCommitment` is checked.
   */
  async assertGuardianAuth(
    pk: string,
    expected: { signerCount: number; threshold: number; guardianCommitment?: string }
  ): Promise<void> {
    const info = await this.getGuardianAuthInfo(pk);
    if (info.error) {
      throw new Error(`assertGuardianAuth: getGuardianAuthInfo(${pk}) failed: ${info.error}`);
    }
    expect(info.signerCommitments.length, `signer count for ${pk}`).toBe(expected.signerCount);
    expect(info.procedureThresholds.update_guardian, `update_guardian threshold for ${pk}`).toBe(expected.threshold);
    if (expected.guardianCommitment) {
      if (!info.guardianCommitment) {
        throw new Error(
          `assertGuardianAuth: expected guardian commitment ${expected.guardianCommitment} for ${pk}, ` +
            `but getGuardianAuthInfo returned no guardianCommitment (account has no guardian slot set, ` +
            `or the build predates the field)`
        );
      }
      // Compare the REAL guardian-operator commitment (on-chain
      // `GUARDIAN_SLOT_NAMES.PUBLIC_KEY`), not `signerCommitments` — the
      // multisig signer set (`[hot, cold]`) never contains the guardian's key,
      // so a switch (which changes the guardian commitment while the signer
      // set/threshold stay put) would pass this assertion wrongly if checked
      // against `signerCommitments`. Normalized (strip `0x` + lowercase) since
      // `expected.guardianCommitment` typically comes from a guardian
      // operator's `GET /pubkey` response, which may format hex differently.
      expect(
        normalizeHex(info.guardianCommitment),
        `expected active guardian commitment ${expected.guardianCommitment} for ${pk}, got ${info.guardianCommitment}`
      ).toBe(normalizeHex(expected.guardianCommitment));
    }
  }

  async currentGuardianEndpoint(): Promise<string> {
    return this.page.evaluate(() => {
      const store = (
        window as unknown as {
          __TEST_STORE__?: { getState(): { currentAccount?: { guardianEndpoint?: string } } };
        }
      ).__TEST_STORE__;
      return store?.getState?.().currentAccount?.guardianEndpoint ?? '';
    });
  }

  async reopen(): Promise<boolean> {
    // Deliberately does NOT use chrome.runtime.reload(): that reloads the
    // whole extension bundle (tearing down and respawning the service
    // worker), and MV3 invalidates every currently-open extension page as
    // part of that -- but the existing Playwright page's next
    // chrome-extension:// navigation fails fast with
    // net::ERR_BLOCKED_BY_CLIENT and never recovers within any retry budget
    // (observed live). Simulating close+reopen with a genuinely fresh page
    // sidesteps the trap entirely and is the pattern already used
    // successfully elsewhere in this file (e.g. navigateHome,
    // createWalletViaBypass, recoverGuardianFromSeed) -- it also better
    // matches what "closing the tab and reopening it" actually means for the
    // user. The service worker (and any in-memory vault key it holds) is
    // untouched, since only the page is torn down; IndexedDB persists
    // regardless.
    //
    // `this.page` may already be closed here -- a caller that invoked
    // `kill()` first (to prove state survives a page that's ALREADY gone,
    // not just one this method tears down itself) would otherwise make the
    // `.close()` below redundant. `Page.close()` on an already-closed page is
    // documented as a no-op, but guard explicitly rather than rely on that.
    const context = this.page.context();
    // Take screen capture down before discarding this page -- an outstanding
    // capture call when the page goes away fails out of band and is charged to
    // the test. See `suspendScreenCapture`.
    await suspendScreenCapture(this.page);
    if (!this.page.isClosed()) {
      await this.page.close();
    }

    // Set when openFreshPage takes the crash-recovery relaunch path below. The
    // relaunched context has a genuinely COLD service worker (it must re-load the
    // ~14MB WASM before intercom answers), so the readiness wait needs the same
    // reload-retry budget as the initial launch rather than a single window.
    let relaunched = false;

    // context.newPage() can transiently fail on a resource-constrained CI runner
    // with a Chromium protocol error ("Target.createTarget: Failed to open a new
    // tab") right after a page teardown, before the browser has reclaimed the
    // closed target. Retry with a short backoff rather than let a resource blip
    // fail an otherwise-successful reopen.
    const openFreshPage = async (): Promise<Page> => {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          return await context.newPage();
        } catch (err) {
          lastErr = err;
          // A disconnected browser is a DEAD context, not the transient
          // "Target.createTarget: Failed to open a new tab" blip this retry
          // loop exists for -- retrying newPage on it can never succeed. The
          // whole Chromium instance vanished between kill() and reopen(): an
          // intermittent browser crash the guardian recovery specs hit here
          // (NOT OOM -- CI dmesg/free showed ~12GB free). Recover the way a real
          // user would after their browser crashed: if this wallet was given a
          // relaunch hook, relaunch its persistent context on the same on-disk
          // profile so it resumes from persisted state (IndexedDB survives).
          // Then reopen()'s tail below re-navigates + unlocks the reopened,
          // already-onboarded wallet exactly as for a normal page swap.
          if (context.browser()?.isConnected() === false) {
            if (this.relaunch) {
              relaunched = true;
              return await this.relaunch();
            }
            throw new Error(
              'reopen: the browser process for this wallet is gone (context disconnected) and no relaunch hook ' +
                'was provided -- the Chromium instance crashed between kill() and reopen(). ' +
                `Original: ${(err as Error).message}`
            );
          }
          await new Promise(resolve => setTimeout(resolve, 500 * attempt));
        }
      }
      throw lastErr;
    };
    const freshPage = await openFreshPage();
    this.currentPage = freshPage;

    const explore = this.page.getByTestId('explore-page');
    const unlock = this.page.getByTestId('unlock-password');

    // Wait for the reopened, already-onboarded wallet to settle on either the
    // Explore surface (normal case, still unlocked) or the unlock screen.
    //
    // On a normal page swap the service worker stays warm, so ONE 90s window is
    // ample. On the crash-recovery relaunch path the SW is COLD and must re-load
    // the ~14MB WASM before intercom answers -- which can outlast a single window
    // under CI load. So mirror the initial launch (launchWalletInstance): give
    // the relaunch case up to 3 windows, re-navigating between them so a cold
    // init that misses one window gets a fresh retry instead of failing reopen().
    const readinessAttempts = relaunched ? 3 : 1;
    for (let attempt = 1; attempt <= readinessAttempts; attempt++) {
      await this.page.goto(this.fullpageUrl, { waitUntil: 'domcontentloaded' });
      try {
        await explore.or(unlock).first().waitFor({ timeout: 90_000 });
        break;
      } catch (err) {
        if (attempt === readinessAttempts) throw err;
        // Cold SW still parsing WASM -- let React mount what it can, then the
        // next iteration re-navigates for a fresh intercom retry window.
        await this.page.waitForSelector('#root > *', { timeout: 15_000 }).catch(() => {});
      }
    }

    if (await unlock.isVisible().catch(() => false)) {
      await this.unlockWallet();
    } else {
      await explore.waitFor({ timeout: 15_000 });
    }

    return relaunched;
  }

  async kill(): Promise<void> {
    // Mirrors the closing half of reopen() -- see that method's doc comment
    // for why this deliberately does NOT touch the service worker (no
    // chrome.runtime.reload()). Swallow a close error rather than let it mask
    // whatever the test is actually asserting: a page that's already mid-
    // teardown (e.g. from a crash) throwing here shouldn't fail the "kill"
    // step, only the "did the wallet recover" step that follows it.
    //
    // Swallowing that error is not sufficient on its own -- see
    // `suspendScreenCapture` for the failure it cannot reach.
    await suspendScreenCapture(this.page);
    await this.page.close().catch(() => {});
  }

  async killBrowser(): Promise<void> {
    // Tear down the ENTIRE browser (persistent context + service worker), not
    // just the page -- a DETERMINISTIC stand-in for the intermittent Chromium
    // process crash the CI runner produces mid-rotation. `context.browser()` is
    // the Browser backing this wallet's persistent context; closing it drops the
    // context too, so the following reopen() sees
    // `context.browser()?.isConnected() === false` and takes its crash-recovery
    // path (relaunch from the on-disk profile). Swallow errors: the browser may
    // already be gone (e.g. it genuinely crashed first).
    //
    // Before anything is destroyed: the screen-capture handler drives real
    // Playwright calls, and one still outstanding when the browser goes away
    // fails inside Playwright's own object bookkeeping, out of band, reported
    // as this test's failure even though its body passed. That is exactly how
    // this spec failed on main. See `suspendScreenCapture`.
    await suspendScreenCapture(this.page);
    // Close the page FIRST. Its exposed bindings (the screen-change capture)
    // and any in-flight page calls are torn down in order that way; pulling the
    // whole browser out from under a live page can leave a response carrying a
    // JSHandle to arrive after the handle was disposed, which Playwright reports
    // as "Object with guid handle@… was not bound in the connection" and
    // charges to the test. The `requestfinished` capture
    // (`harness/network-capture.ts`) cannot be hardened against that from its
    // own listener -- see the comment there -- so this ordering is the only
    // lever for it.
    //
    // This is a deliberate fidelity trade: a real process crash grants no
    // orderly page teardown, whereas this lets `pagehide`/`visibilitychange`
    // run. It is safe only because no wallet code persists state on those --
    // the `visibilitychange` listeners (`useForegroundRefresh`, `useClaimNotes`)
    // just drive refresh polling, and `useBeforeUnload` only calls
    // `preventDefault` (and `page.close()` defaults to `runBeforeUnload: false`,
    // so it never fires). If the wallet ever gains a teardown flush, this
    // ordering would start hiding exactly the data-loss bug the browser-crash
    // spec exists to catch, and it must be revisited then.
    const browser = this.page.context().browser();
    if (!this.page.isClosed()) {
      await this.page.close().catch(() => {});
    }
    await browser?.close().catch(() => {});
  }

  async waitForStage(
    stage: TransactionStage,
    timeoutMs: number = 90_000,
    transactionType: StageTrackedTransactionType = 'switch-guardian'
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const reached = await this.page.evaluate(
        async ({
          targetStage,
          targetType
        }: {
          targetStage: TransactionStage;
          targetType: StageTrackedTransactionType;
        }) => {
          const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
          const db: IDBDatabase = await new Promise((res, rej) => {
            const r = idb.open('TridentMain');
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
          try {
            if (!db.objectStoreNames.contains('transactions')) return false;
            const rows: Array<{ type?: string; status?: number; stage?: string }> = await new Promise((res, rej) => {
              const r = db.transaction('transactions', 'readonly').objectStore('transactions').getAll();
              r.onsuccess = () => res(r.result);
              r.onerror = () => rej(r.error);
            });
            // status 1 === GeneratingTransaction (ITransactionStatus) -- `stage`
            // is only meaningful while a row is actively processing (see the
            // ITransaction.stage doc comment in src/lib/miden/db/types.ts).
            return rows.some(row => row.type === targetType && row.status === 1 && row.stage === targetStage);
          } finally {
            db.close();
          }
        },
        { targetStage: stage, targetType: transactionType }
      );

      if (reached) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `waitForStage: no ${transactionType} transaction reached stage "${stage}" within ${timeoutMs}ms`
        );
      }
      await this.page.waitForTimeout(500);
    }
  }

  /**
   * See the interface doc comment. Requires `STABLE_EMPTY_THRESHOLD`
   * consecutive empty polls (not just one) before declaring the queue
   * drained -- a single empty pass is ambiguous when two operations were
   * kicked off via `Promise.all`: the queue can look momentarily empty
   * between the first op's row completing and the second op's row actually
   * being written (they don't necessarily enqueue in the same tick).
   */
  async waitForQueueDrained(timeoutMs: number = 180_000): Promise<void> {
    const STABLE_EMPTY_THRESHOLD = 3;
    const POLL_INTERVAL_MS = 1_000;
    const deadline = Date.now() + timeoutMs;
    let stableEmpty = 0;

    for (;;) {
      const uncompletedCount = await this.page.evaluate(async () => {
        const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
        const db: IDBDatabase = await new Promise((res, rej) => {
          const r = idb.open('TridentMain');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        try {
          if (!db.objectStoreNames.contains('transactions')) return 0;
          const rows: Array<{ status?: number }> = await new Promise((res, rej) => {
            const r = db.transaction('transactions', 'readonly').objectStore('transactions').getAll();
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
          // status 0 === Queued, 1 === GeneratingTransaction (ITransactionStatus).
          return rows.filter(row => row.status === 0 || row.status === 1).length;
        } finally {
          db.close();
        }
      });

      if (uncompletedCount === 0) {
        stableEmpty++;
        if (stableEmpty >= STABLE_EMPTY_THRESHOLD) return;
      } else {
        stableEmpty = 0;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `waitForQueueDrained: ${uncompletedCount} transaction(s) still Queued/GeneratingTransaction ` +
            `after ${timeoutMs}ms`
        );
      }
      await this.page.waitForTimeout(POLL_INTERVAL_MS);
    }
  }

  /** Extract the `:txId` path param from the current `/generating-transaction[-full]/:txId` URL. */
  private extractTransactionIdFromUrl(): string {
    const match = this.page.url().match(/generating-transaction(?:-full)?\/([^/?#]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : '';
  }

  /**
   * Poll the SDK's Dexie `transactions` store (raw IndexedDB — same idiom as
   * helpers/bridge.ts / helpers/swap.ts) for `txId` reaching Completed;
   * throws on Failed or on timeout. `ITransactionStatus`: Queued=0,
   * GeneratingTransaction=1, Completed=2, Failed=3.
   */
  private async waitForTransactionRowComplete(txId: string, timeoutMs: number = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await this.page.evaluate(async (id: string) => {
        const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
        const db: IDBDatabase = await new Promise((res, rej) => {
          const r = idb.open('TridentMain');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        try {
          if (!db.objectStoreNames.contains('transactions')) return null;
          const found: { status?: number; error?: string; displayMessage?: string } | undefined = await new Promise(
            (res, rej) => {
              const r = db.transaction('transactions', 'readonly').objectStore('transactions').get(id);
              r.onsuccess = () => res(r.result);
              r.onerror = () => rej(r.error);
            }
          );
          return found ? { status: found.status, error: found.error, displayMessage: found.displayMessage } : null;
        } finally {
          db.close();
        }
      }, txId);

      if (row?.status === 2 /* Completed */) return;
      if (row?.status === 3 /* Failed */) {
        throw new Error(`Guardian transaction ${txId} failed: ${row.error ?? row.displayMessage ?? 'unknown error'}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Guardian transaction ${txId} did not complete within ${timeoutMs}ms ` +
            `(last status=${row?.status ?? 'row not found'})`
        );
      }
      await this.page.waitForTimeout(2_000);
    }
  }

  /**
   * Enumerate every (db, store) on the extension origin — cheap, loads no row
   * data. Pairs with `dumpIndexedDBStore` so `streamIndexedDBToFile` can pull
   * one store at a time. Not on the shared WalletPage interface — Chrome-only
   * (IndexedDB-per-origin).
   */
  async listIndexedDBStores(): Promise<Array<{ db: string; version: number; store: string }>> {
    return this.page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const idb = (globalThis as any).indexedDB as IDBFactory;
      const dbList = await idb.databases();
      const out: Array<{ db: string; version: number; store: string }> = [];

      const openDb = (name: string): Promise<IDBDatabase> =>
        new Promise((resolve, reject) => {
          const req = idb.open(name);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          req.onblocked = () => reject(new Error('blocked'));
        });

      for (const info of dbList) {
        if (!info.name) continue;
        try {
          const db = await openDb(info.name);
          for (const store of Array.from(db.objectStoreNames)) {
            out.push({ db: info.name, version: info.version ?? 0, store });
          }
          db.close();
        } catch {
          // Un-openable db — skip; the caller records nothing for it.
        }
      }
      return out;
    });
  }

  /**
   * Read ONE object store as a JSON array string, capped at `maxRows`. The
   * Miden SDK persists its authoritative state here (accounts, transactions,
   * notes, chain MMR, block headers) — for "did this tx commit?" forensics the
   * `transactions` table is the ground truth.
   *
   * Binary fields (Uint8Array / ArrayBuffer / BigInt) are wrapped as
   * `{ __type, hex | value, length }` so the result round-trips through JSON
   * and Playwright's postMessage serialization. Returning a string (vs the
   * object) also avoids structuredClone choking on Uint8Array in some Chromium
   * revisions. One store at a time keeps peak in-page memory bounded.
   */
  async dumpIndexedDBStore(
    db: string,
    store: string,
    maxRows: number
  ): Promise<{ json: string; count: number; truncated: boolean }> {
    return this.page.evaluate(
      async ({ db, store, maxRows }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const idb = (globalThis as any).indexedDB as IDBFactory;

        const database: IDBDatabase = await new Promise((resolve, reject) => {
          const req = idb.open(db);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          req.onblocked = () => reject(new Error('blocked'));
        });

        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rows: any[] = await new Promise((resolve, reject) => {
            const tx = database.transaction(store, 'readonly');
            const os = tx.objectStore(store);
            // getAll(query, count): count caps rows pulled in a single op,
            // bounding peak memory without an O(n^2) offset cursor.
            const req = os.getAll(null, maxRows);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const replacer = (_k: string, v: any): unknown => {
            if (v instanceof Uint8Array || v instanceof Uint8ClampedArray) {
              const hex = Array.from(v)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
              return { __type: 'Uint8Array', hex, length: v.length };
            }
            if (v instanceof ArrayBuffer) {
              const arr = new Uint8Array(v);
              const hex = Array.from(arr)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
              return { __type: 'ArrayBuffer', hex, length: arr.length };
            }
            if (typeof v === 'bigint') {
              return { __type: 'BigInt', value: v.toString() };
            }
            return v;
          };

          return {
            json: JSON.stringify(rows, replacer),
            count: rows.length,
            truncated: rows.length >= maxRows
          };
        } finally {
          database.close();
        }
      },
      { db, store, maxRows }
    );
  }

  /**
   * Wait until the page has booted far enough to have a hydrated wallet store —
   * `__TEST_STORE__` present WITH a `currentAccount.publicKey`. That is the real
   * precondition for every `page.evaluate` in this class that reads balances or
   * injects faucet metadata, and it replaces the fixed "let React settle" sleeps
   * that used to stand in for it after a goto/reload.
   *
   * Bounded by `timeoutMs` (always the duration of the sleep it replaced) and
   * never throws: a page that has not hydrated inside that window falls through
   * to exactly the behaviour it had before.
   */
  private async waitForStoreReady(timeoutMs: number): Promise<void> {
    await this.page
      .waitForFunction(
        () => {
          const store = (
            window as unknown as { __TEST_STORE__?: { getState(): { currentAccount?: { publicKey?: string } } } }
          ).__TEST_STORE__;
          return !!store?.getState?.().currentAccount?.publicKey;
        },
        undefined,
        { timeout: timeoutMs }
      )
      .catch(() => {});
  }

  /**
   * Get the balance for a specific token from the Explore page.
   * If tokenSymbol is not given, returns the balance of the first token row.
   * Returns 0 if no matching token found.
   */
  async getBalance(_tokenSymbol?: string): Promise<number> {
    await this.navigateHome();
    // The evaluate below needs `__TEST_STORE__` with an account on it; wait for
    // that rather than for a second of wall clock (this runs on every poll of
    // waitForBalanceAbove).
    await this.waitForStoreReady(1_000);

    try {
      // Read balances from the Zustand store (consumed assets) AND from
      // chrome.storage.local sync data (consumable notes not yet consumed).
      // The transaction processor auto-consumes notes but may not run in SW.
      const result = await this.page.evaluate(async () => {
        const store = (window as any).__TEST_STORE__;
        if (!store) return { balance: 0, debug: 'no store' };
        const state = store.getState();

        // Trigger a fresh balance fetch
        try {
          if (state.currentAccount?.publicKey && state.fetchBalances) {
            await state.fetchBalances(state.currentAccount.publicKey, state.assetsMetadata || {});
          }
        } catch {}

        const freshState = store.getState();
        let totalBalance = 0;

        // 1. Read consumed assets from store
        for (const tokenList of Object.values(freshState.balances || {}) as any[]) {
          if (!Array.isArray(tokenList)) continue;
          for (const token of tokenList) {
            const amount = parseFloat(String(token.amount ?? token.balance ?? '0'));
            if (amount > 0) {
              totalBalance += amount;
            }
          }
        }

        // 2. Also check consumable notes from sync data (pending incoming tokens)
        // These are notes that have been discovered but not yet consumed.
        try {
          const storage = await new Promise<any>(resolve => {
            chrome.storage.local.get(['miden_sync_data'], resolve);
          });
          const syncData = storage?.miden_sync_data;
          if (syncData?.notes?.length > 0) {
            for (const note of syncData.notes) {
              const baseUnits = parseInt(note.amountBaseUnits || '0', 10);
              const decimals = note.metadata?.decimals ?? 8;
              const noteBalance = baseUnits / Math.pow(10, decimals);
              if (noteBalance > 0) {
                totalBalance += noteBalance;
              }
            }
          }
        } catch {}

        return {
          balance: totalBalance,
          debug: `consumed=${totalBalance - 0}, notes pending, total=${totalBalance}`
        };
      });

      return typeof result === 'object' ? result.balance : result;
    } catch (e) {
      console.log(`[WalletPage.getBalance] Error: ${e}`);
      return 0;
    }
  }

  /**
   * Refresh the Zustand `balances` projection from the account vault — the same
   * `state.fetchBalances` call getBalance() makes, but without navigating or
   * waiting, so it's cheap enough for the stress settle loop to call each poll.
   *
   * Why this exists: quickBalanceSnapshot() is deliberately non-invasive and
   * never calls `fetchBalances`, so its `balance` half can be stale. The stress
   * settle loop's triggerSync() fires PROCESS_TRANSACTIONS_REQUEST, which
   * auto-consumes pending notes: a consumed note leaves `miden_sync_data.notes`
   * (dropping out of the snapshot's fresh `pendingSum`) but its value only
   * lands in `state.balances` after a `fetchBalances`. Without this refresh the
   * consumed value is counted in neither bucket, so `totalReportable`
   * under-counts and strict conservation reports a phantom loss. Calling this
   * before the final snapshot makes it authoritative — matching the initial
   * baseline, which uses getBalance() and so refreshes the same way.
   */
  async refreshBalances(): Promise<void> {
    try {
      await this.page.evaluate(async () => {
        const store = (window as any).__TEST_STORE__;
        const state = store?.getState?.();
        if (state?.currentAccount?.publicKey && state.fetchBalances) {
          await state.fetchBalances(state.currentAccount.publicKey, state.assetsMetadata || {});
        }
      });
    } catch {
      // Best-effort: a failed refresh leaves the prior balance in place and the
      // settle loop retries on its next poll.
    }
  }

  // ── Sync ──────────────────────────────────────────────────────────────────

  /**
   * Trigger a sync via the intercom SyncRequest.
   * Requires MIDEN_E2E_TEST=true build which exposes __TEST_INTERCOM__.
   *
   * Both requests are fire-and-forget in the service worker (`processRequest`
   * in `src/lib/miden/back/main.ts` kicks `doSync` / `startTransactionProcessing`
   * WITHOUT awaiting them), so their intercom responses say nothing about the
   * sync having finished — which is why this used to sleep a flat
   * `SYNC_WAIT_MS`. The real completion signal is the `SYNC_COMPLETED`
   * broadcast, emitted by the sync manager AFTER it persists `miden_sync_data`
   * to `chrome.storage.local` — i.e. after the exact write every caller of this
   * helper (`readPendingCount`, `getBalance`) goes on to read. Count those
   * broadcasts page-side and wait for the next one, still capped at
   * `SYNC_WAIT_MS` so a sync that never signals (circuit breaker open, no
   * vault, intercom port re-created) costs no more than it did before.
   *
   * Caveat: the transaction processor broadcasts the same bare `SYNC_COMPLETED`
   * per loop pass (`transaction-processor.ts`), so while the tx queue is
   * draining this can be satisfied by a processor tick rather than by the sync.
   * That window is exactly when pending-note counts are non-zero anyway, and
   * the cap means the worst case is the old fixed sleep.
   */
  async triggerSync(force: boolean = false): Promise<void> {
    let seenBefore: number | null = null;
    try {
      seenBefore = await this.page.evaluate(async forceSync => {
        const w = window as unknown as {
          __TEST_INTERCOM__?: {
            request(payload: { type: string; force?: boolean }): Promise<unknown>;
            subscribe(callback: (data: { type?: string }) => void): () => void;
          };
          __E2E_SYNC_COMPLETED_COUNT__?: number;
        };
        const intercom = w.__TEST_INTERCOM__;
        if (!intercom) return null;
        // Install the counter once per document (a reload clears it).
        if (w.__E2E_SYNC_COMPLETED_COUNT__ === undefined) {
          w.__E2E_SYNC_COMPLETED_COUNT__ = 0;
          intercom.subscribe(data => {
            if (data?.type === 'SYNC_COMPLETED') {
              w.__E2E_SYNC_COMPLETED_COUNT__ = (w.__E2E_SYNC_COMPLETED_COUNT__ ?? 0) + 1;
            }
          });
        }
        const seen = w.__E2E_SYNC_COMPLETED_COUNT__;
        // Sync state with the blockchain node. `force` bypasses the SW sync
        // backoff / in-flight-join so a resilience spec can guarantee a real
        // node round-trip (an un-forced sync is often skipped once caught up).
        await intercom.request({ type: 'SYNC_REQUEST', force: forceSync });
        // Trigger transaction processing (auto-consume pending notes)
        await intercom.request({ type: 'PROCESS_TRANSACTIONS_REQUEST' });
        return seen;
      }, force);
    } catch {
      // May fail during navigation, ignore
    }

    if (seenBefore === null) {
      // No intercom (mid-navigation, or a non-E2E build): nothing was requested,
      // so there is no signal to wait on — fall back to the original sleep.
      await this.page.waitForTimeout(SYNC_WAIT_MS);
      return;
    }

    await this.page
      .waitForFunction(
        seen =>
          ((window as unknown as { __E2E_SYNC_COMPLETED_COUNT__?: number }).__E2E_SYNC_COMPLETED_COUNT__ ?? 0) > seen,
        seenBefore,
        { timeout: SYNC_WAIT_MS }
      )
      .catch(() => {});
  }

  // ── Claim Notes ───────────────────────────────────────────────────────────

  /**
   * Drain every claimable note until the wallet's consumable-notes cache is
   * empty for two consecutive syncs (or until `timeoutMs` elapses).
   *
   * Reads pending notes from `chrome.storage.local.miden_sync_data.notes`, which
   * is the same source `getBalance()` sums over — so "drained" here means the
   * final balance tally can't miss tokens that got stuck as claimable.
   *
   * Why a dedicated drain loop (vs. click-once-then-return):
   *   1. Every claim call after the initial post-mint one happens against a
   *      wallet with balance > 0, so "vaultBalance > 0" is useless as a stop
   *      condition — it was true before we started.
   *   2. Sync can silently no-op (SW `isSyncing` guard drops concurrent
   *      requests; testnet RPC 5xx; MV3 SW suspend/resume). A single "sync +
   *      click" round can miss newly-landed notes. Looping over sync →
   *      clickable buttons → wait → re-sync until the cache is stably empty
   *      is the only way to guarantee the balance assertion is checking a
   *      real terminal state.
   */
  /**
   * Inject metadata for custom faucet tokens so they show up as claimable.
   * The useExtensionClaimableNotes hook filters: n.metadata || assetsMetadata[n.faucetId]
   */
  private async injectClaimableMetadata(): Promise<void> {
    await this.page.evaluate(async () => {
      const storage = await new Promise<any>(resolve => {
        chrome.storage.local.get(['miden_cached_consumable_notes'], resolve);
      });
      const notes = storage?.miden_cached_consumable_notes || [];
      if (notes.length === 0) return;

      const store = (globalThis as any).__TEST_STORE__;
      if (!store) return;

      const state = store.getState();
      const metadata = { ...state.assetsMetadata };
      let updated = false;
      for (const note of notes) {
        if (!metadata[note.faucetId] && !note.metadata) {
          metadata[note.faucetId] = {
            name: note.metadata?.name || 'Test Token',
            symbol: note.metadata?.symbol || 'TST',
            decimals: note.metadata?.decimals ?? 8,
            thumbnailUri: ''
          };
          updated = true;
        }
      }
      if (updated) {
        store.setState({ assetsMetadata: metadata });
        console.log('[claimAllNotes] Injected metadata for', notes.length, 'notes');
      }
    });
  }

  /**
   * Full page reload, re-inject faucet metadata, then land on /receive.
   *
   * A full reload (not a client-side navigate) is load-bearing: it gives a
   * fresh Dexie connection AND re-initializes the wallet's in-memory Zustand
   * store — critically resetting `extensionClaimingNoteIds`. A note whose
   * consume has stalled stays flagged "being claimed" (no Claim button) until
   * its consume commits; on slow networks (testnet) that can outlast a whole
   * claim cycle. Client-side navigation does NOT reset the store, so only a
   * reload un-gates such notes. Used both at the start of a claim drain and as
   * the recovery step when the loop gets stuck with pending notes but no
   * visible buttons.
   */
  private async reloadAndPreparePending(): Promise<void> {
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this.page.waitForSelector('#root > *', { timeout: 15_000 }).catch(() => {});
    // injectClaimableMetadata writes into `__TEST_STORE__`, so wait for the store
    // to hydrate rather than for a fixed 3s.
    await this.waitForStoreReady(3_000);
    await this.injectClaimableMetadata();
    // Claimable notes live on their own /pending-notes page, which mounts the
    // claim UI directly (no tab to switch to). navigateTo() is a full goto, so
    // the app re-boots — wait for the rehydrated store (the /pending-notes route
    // is `onlyReady`-gated on it) instead of another fixed 3s.
    await this.navigateTo('/pending-notes');
    await this.waitForStoreReady(3_000);
  }

  async claimAllNotes(requestedTimeoutMs: number = 120_000): Promise<void> {
    const STABLE_ZERO_THRESHOLD = 2;
    const timeoutMs = effectiveClaimBudgetMs(requestedTimeoutMs);

    // Fresh reload + metadata injection + land on /receive. The reload (NOT a
    // client-side navigate) gives a fresh Dexie connection AND resets the
    // wallet's in-memory store — clearing the `extensionClaimingNoteIds` gate.
    // See reloadAndPreparePending.
    await this.reloadAndPreparePending();

    // Start the clock AFTER reload/prepare. That step costs ~8-12s of fixed
    // sleeps, and billing it against the caller's budget silently turned a 120s
    // budget into ~110s of actual draining (#615).
    const deadline = Date.now() + timeoutMs;

    const readPendingCount = (): Promise<number> =>
      this.page.evaluate(async () => {
        const storage = await new Promise<any>(resolve => {
          chrome.storage.local.get(['miden_sync_data'], resolve);
        });
        const notes = storage?.miden_sync_data?.notes;
        return Array.isArray(notes) ? notes.length : 0;
      });

    let stableZero = 0;
    let iteration = 0;
    let lastPending = -1;
    let stuckSameCountIters = 0;

    while (Date.now() < deadline && stableZero < STABLE_ZERO_THRESHOLD) {
      iteration++;
      await this.triggerSync();

      const pending = await readPendingCount();

      if (pending === 0) {
        stableZero++;
        console.log(
          `[WalletPage.claimAllNotes] iter=${iteration} pending=0 stableZero=${stableZero}/${STABLE_ZERO_THRESHOLD}`
        );
        // Spacing between the two consecutive zero samples — deliberately a sleep.
        if (stableZero < STABLE_ZERO_THRESHOLD) await this.page.waitForTimeout(2_000);
        continue;
      }

      stableZero = 0;
      stuckSameCountIters = pending === lastPending ? stuckSameCountIters + 1 : 0;
      lastPending = pending;

      // Let the React UI render buttons for newly-arrived notes before probing.
      // `pending > 0` means the store already has notes, so exactly one of the
      // two affordances below is on its way — wait for whichever arrives first
      // instead of sleeping. Capped at the old 2s so the "neither rendered"
      // path (handled further down) costs no more than it used to.
      const claimAllBtn = this.page.getByTestId('claim-all-button');
      const assetRows = this.page.getByTestId('pending-asset-row');
      await claimAllBtn
        .or(assetRows)
        .first()
        .waitFor({ state: 'visible', timeout: 2_000 })
        .catch(() => {});

      // Desktop fast path: a single "Claim All" button drains every faucet.
      if (await claimAllBtn.isVisible().catch(() => false)) {
        console.log(`[WalletPage.claimAllNotes] iter=${iteration} pending=${pending} clicking Claim All`);
        await claimAllBtn.click();
        // LEFT AS A SLEEP: head start for the consume the click enqueued. No
        // usable signal — the pending count only moves on the NEXT sync, and the
        // enqueued row's id isn't exposed to the harness by the Claim All path.
        await this.page.waitForTimeout(8_000);
        continue;
      }

      // Two-level fallback: open each per-faucet summary row, claim every note
      // in the detail view, then go back. The list re-renders as notes are
      // claimed, so re-read the row count and operate on .first() each pass.
      const rowCount = await assetRows.count().catch(() => 0);
      if (rowCount > 0) {
        console.log(
          `[WalletPage.claimAllNotes] iter=${iteration} pending=${pending} opening ${rowCount} faucet row(s)`
        );
        for (let r = 0; r < rowCount; r++) {
          try {
            // Re-query each pass; rows shift as faucets drain.
            const row = this.page.getByTestId('pending-asset-row').first();
            if (!(await row.isVisible().catch(() => false))) break;
            await row.click({ timeout: 5_000 });

            // The detail view renders asynchronously (its balance read queues
            // behind the WASM lock). Wait for the buttons this pass is about to
            // count, capped at the 1s this replaced.
            const claimBtns = this.page.getByTestId('claim-button');
            await claimBtns
              .first()
              .waitFor({ state: 'visible', timeout: 1_000 })
              .catch(() => {});

            const claimCount = await claimBtns.count().catch(() => 0);
            for (let i = 0; i < claimCount; i++) {
              try {
                await this.page.getByTestId('claim-button').first().click({ timeout: 5_000 });
                // LEFT AS A SLEEP: spacing between per-note claims. The list
                // re-render is the only observable and it is not addressable
                // per note (every button carries the same testid).
                await this.page.waitForTimeout(1_000);
              } catch {
                // button may vanish mid-iteration as the list re-renders
              }
            }
            // A successful claim can navigate to the transaction progress
            // screen. Reloading the pending route also reliably returns from
            // the in-page asset detail view, which has no desktop back button.
            await this.reloadAndPreparePending();
          } catch {
            // Row vanished as the list re-rendered — try the next pass.
          }
        }
        // LEFT AS A SLEEP: settle window for the consumes this pass enqueued,
        // same missing signal as the Claim All path above.
        await this.page.waitForTimeout(5_000);
        continue;
      }

      // Cache says notes are pending but the receive page hasn't rendered
      // buttons. Two causes: (a) React hasn't rehydrated from the updated store
      // yet — resolves on its own; (b) the notes are gated by
      // `extensionClaimingNoteIds` because a prior claim's consume stalled and
      // never committed (common on slow networks like testnet). A client-side
      // navigate clears (a) but NOT (b), since the store survives navigation —
      // only a full reload resets the claiming gate. So after a few stuck
      // iterations, reload to break out of both.
      console.log(
        `[WalletPage.claimAllNotes] iter=${iteration} pending=${pending} no buttons visible (stuck ${stuckSameCountIters})`
      );
      // The gate above is (b) — a consume that never committed — often enough that
      // it is worth asking the offscreen document what that consume is doing before
      // reloading and enqueuing another one. Streams to stdout so a stalled claim is
      // diagnosable from the live job log instead of from artifacts after the run.
      if (stuckSameCountIters >= 3) {
        await dumpProveTelemetry(this.page, `claimAllNotes stuck at iter=${iteration}`);
        await this.reloadAndPreparePending();
        stuckSameCountIters = 0;
      }
      // Poll spacing before the next sync round — deliberately a sleep.
      await this.page.waitForTimeout(3_000);
    }

    if (Date.now() >= deadline && stableZero < STABLE_ZERO_THRESHOLD) {
      await this.confirmDrainedOrThrow('claimAllNotes', {
        readPendingCount,
        timeoutMs,
        iteration,
        lastPending,
        stableZero,
        stableZeroThreshold: STABLE_ZERO_THRESHOLD
      });
    } else {
      console.log(`[WalletPage.claimAllNotes] drained in ${iteration} iteration(s)`);
    }

    await this.navigateHome();
  }

  /**
   * Shared drain-loop tail for `claimAllNotes` / `claimNotesByGroup`.
   *
   * The loop wants two consecutive zero reads before declaring a wallet drained,
   * but the deadline is only checked at the TOP of each iteration while the
   * bodies cost 5-40s (Claim All click + 8s wait, the per-row path with its own
   * reload, the stuck path + reload). A consume that commits inside that window
   * therefore leaves the loop with `stableZero` at 0 OR 1 and an already-expired
   * clock — and the helper used to throw `timed out ... with 0 pending note(s)`
   * on a wallet that had genuinely drained (#615).
   *
   * Keying the rescue on `stableZero >= 1` only covered the ===1 shape, which is
   * a minority of that window. Key it on the READING instead: take a fresh
   * sample, and if it is zero apply the same two-sample rule the loop itself
   * uses. Both exit shapes are covered and the anti-flap guarantee is unchanged —
   * a single spurious zero still cannot pass.
   */
  private async confirmDrainedOrThrow(
    label: string,
    ctx: {
      readPendingCount: () => Promise<number>;
      timeoutMs: number;
      iteration: number;
      lastPending: number;
      stableZero: number;
      stableZeroThreshold: number;
    }
  ): Promise<void> {
    const first = await ctx.readPendingCount().catch(() => -1);
    if (first === 0) {
      await this.page.waitForTimeout(2_000);
      if ((await ctx.readPendingCount().catch(() => -1)) === 0) {
        console.log(`[WalletPage.${label}] drained at deadline (confirmed) after ${ctx.iteration} iteration(s)`);
        return;
      }
    }

    // A pending note that never drains means the consume tx stalled or failed.
    // Dump the transactions table so the reason (Failed + error, or a stuck row
    // and its stage) lands in the test log instead of staying hidden in the SW.
    const txDump = await this.dumpTransactions().catch(() => 'unavailable');
    console.log(`[WalletPage.${label}] transactions at timeout: ${txDump}`);
    throw new Error(
      `[WalletPage.${label}] timed out after ${ctx.timeoutMs}ms with ${first} pending note(s) ` +
        `after ${ctx.iteration} iteration(s) (lastPending=${ctx.lastPending}, ` +
        `stableZero=${ctx.stableZero}/${ctx.stableZeroThreshold}). Transactions: ${txDump}`
    );
  }

  /**
   * Total `send` value this wallet queued that never actually moved, split by
   * why. The stress driver counts a send the moment `sendTokens` returns — which
   * is when the UI says "transaction initiated", long before the guardian
   * pipeline runs — so its expected-delta bookkeeping silently assumes every
   * send landed. Rows the wallet itself later marked Failed (or that were still
   * in flight when the run ended) are exactly the difference between that
   * assumption and reality, which is what lets a caller reconcile the two
   * instead of reporting a phantom loss.
   *
   * `failed` is terminal with no RECORDED submit crossing — which is weaker
   * than proof of none, since the stamp is best-effort and its write is
   * deliberately swallowed on failure; `pending` covers
   * Queued/Generating (0/1), which for a requeued row means "will retry, hasn't
   * moved value yet". Amounts are converted to the same display units
   * `quickBalanceSnapshot` reports, so the two are directly comparable.
   *
   * `failedMaybeSubmitted` is held apart and deliberately NOT offered as
   * unlanded value. The wallet stamps `mayHaveSubmitted` at the submit crossing
   * precisely because a row can end Failed with its transaction already on
   * chain; counting that as "never landed" would accuse the wallet of losing
   * value on a run where value moved exactly as intended. It is reported both so
   * the caller can surface it — a Failed-but-possibly-landed send is worth
   * knowing about — and as the explicit bound on the ambiguity: the per-wallet
   * reconciliation allows a discrepancy only up to this value, and only in the
   * direction the ambiguous rows could have moved value.
   *
   * `storeMissing` distinguishes "this wallet has no send rows" from "this read
   * did not find the database". `indexedDB.open` with no version CREATES an
   * empty database rather than failing, so a read against the wrong origin
   * succeeds and returns a flawless all-zero result. Without the flag, that is
   * indistinguishable from a perfect run.
   */
  async unlandedSendTotals(): Promise<{
    /** Value of `send` rows the wallet itself marked Completed. */
    completed: number;
    completedCount: number;
    failed: number;
    pending: number;
    failedCount: number;
    pendingCount: number;
    totalCount: number;
    failedMaybeSubmitted: number;
    failedMaybeSubmittedCount: number;
    /** Latest `nextEligibleAt` (unix seconds) across pending rows; 0 if none. */
    pendingEligibleAtMax: number;
    storeMissing: boolean;
  }> {
    return this.page.evaluate(async () => {
      const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
      const db: IDBDatabase = await new Promise((res, rej) => {
        const r = idb.open('TridentMain');
        // A blocked open still resolves later, so the rejection below would
        // otherwise leak the connection it eventually hands back — and this read
        // runs every few seconds for hours on both wallets.
        let settled = false;
        r.onsuccess = () => {
          if (settled) {
            r.result.close();
            return;
          }
          settled = true;
          res(r.result);
        };
        r.onerror = () => {
          settled = true;
          rej(r.error ?? new Error('unlandedSendTotals: open of TridentMain failed'));
        };
        // Without this, a blocked open never settles. This read runs on the
        // settle loop, inside a spec with no timeout, before any artifact is
        // written — a hang here costs the whole run's forensics.
        r.onblocked = () => {
          settled = true;
          rej(new Error('unlandedSendTotals: open of TridentMain blocked'));
        };
      });
      try {
        const out = {
          completed: 0,
          completedCount: 0,
          failed: 0,
          pending: 0,
          failedCount: 0,
          pendingCount: 0,
          totalCount: 0,
          failedMaybeSubmitted: 0,
          failedMaybeSubmittedCount: 0,
          pendingEligibleAtMax: 0,
          storeMissing: false
        };
        if (!db.objectStoreNames.contains('transactions')) {
          out.storeMissing = true;
          return out;
        }
        // Mirrors quickBalanceSnapshot's pending-note conversion: the stress
        // faucet is 8-decimal, and balances are reported in display units.
        // A NaN here would propagate silently into the reconciliation and surface
        // as "unexplained by NaN", so an unparseable amount is reported rather
        // than folded in as a zero that quietly understates the total.
        const toDisplay = (raw: unknown): number => {
          const n =
            typeof raw === 'bigint'
              ? Number(raw)
              : typeof raw === 'number'
                ? raw
                : typeof raw === 'string' && raw !== ''
                  ? Number(raw)
                  : NaN;
          // Absent is unparseable too. Folding a missing amount in as 0 would
          // understate one side of the reconciliation by exactly the value it
          // failed to read, which is indistinguishable from the run being clean.
          if (!Number.isFinite(n)) throw new Error(`unlandedSendTotals: unparseable amount ${String(raw)}`);
          return n / 1e8;
        };
        // Cursor rather than getAll: rows carry `requestBytes`/`resultBytes`
        // blobs, and this runs every few seconds on both wallets at once. The
        // neighbouring dump code streams for exactly this reason — materializing
        // both tables concurrently has tripped the OOM killer on the runner, and
        // here that would surface as a read failure rather than a crash, which is
        // the quietest possible way to lose the measurement.
        await new Promise<void>((res, rej) => {
          const tx = db.transaction('transactions', 'readonly');
          // The transaction can end without the cursor request ever firing again
          // — an abort, a version-change teardown, or the throw below. Listening
          // only to the request would leave this promise pending forever, and it
          // runs inside a spec with no timeout, so the hang would cost the whole
          // run's forensics rather than surfacing as a failed read.
          // Each carries its own fallback: IDBTransaction.error is null until the
          // transaction actually aborts, so rejecting with it bare can produce a
          // `null` reason that reaches the log as the string "null".
          tx.onabort = () => rej(tx.error ?? new Error('unlandedSendTotals: transaction aborted'));
          tx.onerror = () => rej(tx.error ?? new Error('unlandedSendTotals: transaction failed'));
          const r = tx.objectStore('transactions').openCursor();
          r.onerror = () => rej(r.error ?? new Error('unlandedSendTotals: cursor failed'));
          r.onsuccess = () => {
            // A throw inside an IndexedDB event handler does not reach the
            // enclosing executor — it aborts the transaction and is reported on
            // the global error handler. Caught here so an unparseable amount
            // rejects this read (loud) instead of stalling it (silent).
            try {
              const cursor = r.result;
              if (!cursor) {
                res();
                return;
              }
              const row = cursor.value as Record<string, unknown>;
              if (row.type === 'send') {
                out.totalCount += 1;
                const status = Number(row.status);
                const amount = toDisplay(row.amount);
                if (status === 2) {
                  out.completed += amount;
                  out.completedCount += 1;
                } else if (status === 3) {
                  if (row.mayHaveSubmitted === true) {
                    out.failedMaybeSubmitted += amount;
                    out.failedMaybeSubmittedCount += 1;
                  } else {
                    out.failed += amount;
                    out.failedCount += 1;
                  }
                } else if (status === 0 || status === 1) {
                  out.pending += amount;
                  out.pendingCount += 1;
                  const eligible = Number(row.nextEligibleAt ?? 0);
                  if (Number.isFinite(eligible) && eligible > out.pendingEligibleAtMax) {
                    out.pendingEligibleAtMax = eligible;
                  }
                }
              }
              cursor.continue();
            } catch (e) {
              rej(e);
            }
          };
        });
        return out;
      } finally {
        db.close();
      }
    });
  }

  /**
   * Diagnostic: read every row of `TridentMain.transactions` and return a
   * compact one-line summary (`id·type·status·stage·error`) for each. Used to
   * surface a stalled/failed consume's real reason in the test log rather than
   * leaving it buried in the service worker. status: 0=Queued 1=Generating
   * 2=Completed 3=Failed.
   */
  async dumpTransactions(): Promise<string> {
    return this.page.evaluate(async () => {
      const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
      const db: IDBDatabase = await new Promise((res, rej) => {
        const r = idb.open('TridentMain');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      try {
        if (!db.objectStoreNames.contains('transactions')) return '[]';
        const rows: Array<Record<string, unknown>> = await new Promise((res, rej) => {
          const r = db.transaction('transactions', 'readonly').objectStore('transactions').getAll();
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        return JSON.stringify(
          rows
            .slice()
            .sort((a, b) => Number(a.initiatedAt ?? 0) - Number(b.initiatedAt ?? 0))
            .map(row => ({
              id: String(row.id ?? '').slice(0, 8),
              type: row.type,
              // Name, not the raw enum. A numeric `status: 2` reads as "in
              // flight" but means Completed, which sent several #615
              // investigations chasing a rotation race that never existed.
              status: (['Queued', 'Generating', 'Completed', 'Failed'] as const)[Number(row.status)] ?? row.status,
              initiatedAt: row.initiatedAt,
              completedAt: row.completedAt,
              // NOTE: `stage` is informational and goes STALE once status is
              // terminal — a successful replace-hot-key freezes at 'confirming'.
              // Read it only together with `status`.
              stage: row.stage,
              error: typeof row.error === 'string' ? row.error.slice(0, 300) : row.error,
              errorMessage: typeof row.errorMessage === 'string' ? row.errorMessage.slice(0, 300) : undefined
            }))
        );
      } finally {
        db.close();
      }
    });
  }

  /**
   * Drain pending notes via the per-faucet GROUP-claim path (Pending tab → open
   * an asset-summary row → asset detail view → group "Claim N/M" button, or the
   * per-note Claim buttons), exercising `handleClaimGroup` / `AssetPendingDetail`
   * — the two-level claim UI that the top-level "Claim All" (claimAllNotes) never
   * reaches. Chrome desktop only.
   */
  async claimNotesByGroup(requestedTimeoutMs: number = 180_000): Promise<void> {
    const STABLE_ZERO_THRESHOLD = 2;
    const timeoutMs = effectiveClaimBudgetMs(requestedTimeoutMs);
    await this.reloadAndPreparePending();

    // Clock starts after reload/prepare — same reasoning as claimAllNotes (#615).
    const deadline = Date.now() + timeoutMs;

    const readPendingCount = (): Promise<number> =>
      this.page.evaluate(async () => {
        const storage = await new Promise<any>(resolve => {
          chrome.storage.local.get(['miden_sync_data'], resolve);
        });
        const notes = storage?.miden_sync_data?.notes;
        return Array.isArray(notes) ? notes.length : 0;
      });

    let stableZero = 0;
    let iteration = 0;
    let lastPending = -1;
    let stuckSameCountIters = 0;
    while (Date.now() < deadline && stableZero < STABLE_ZERO_THRESHOLD) {
      iteration++;
      await this.triggerSync();
      const pending = await readPendingCount();

      if (pending === 0) {
        stableZero++;
        // Spacing between the two consecutive zero samples — deliberately a sleep.
        if (stableZero < STABLE_ZERO_THRESHOLD) await this.page.waitForTimeout(2_000);
        continue;
      }
      stableZero = 0;
      stuckSameCountIters = pending === lastPending ? stuckSameCountIters + 1 : 0;
      lastPending = pending;

      // Open the first per-faucet summary row → asset detail view. `pending > 0`
      // means the row is on its way, so wait for it rather than sleeping 2s
      // (capped at that 2s, so the "never rendered" branch below is unchanged).
      const row = this.page.getByTestId('pending-asset-row').first();
      await row.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {});
      if (!(await row.isVisible().catch(() => false))) {
        // Poll spacing before re-syncing — deliberately a sleep.
        await this.page.waitForTimeout(3_000);
        continue;
      }
      await row.click({ timeout: 5_000 });

      // The detail view (and its claim buttons) render asynchronously — a balance
      // read behind the WASM lock gates them. Wait for either claim affordance to
      // appear before acting, else we'd go back having clicked nothing.
      const groupBtn = this.page.getByTestId('claim-group-button');
      const noteBtn = this.page.getByTestId('claim-button');
      await groupBtn
        .or(noteBtn)
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
        .catch(() => {});

      let clicked = false;
      // Prefer the group-level "Claim N/M" button (handleClaimGroup).
      if (await groupBtn.isVisible().catch(() => false)) {
        try {
          await groupBtn.click({ timeout: 10_000 });
          clicked = true;
        } catch {
          // disabled/transient — fall through to per-note buttons
        }
      }
      if (!clicked) {
        const noteCount = await noteBtn.count().catch(() => 0);
        for (let i = 0; i < noteCount; i++) {
          try {
            await this.page.getByTestId('claim-button').first().click({ timeout: 5_000 });
            clicked = true;
            // LEFT AS A SLEEP: same missing per-note signal as claimAllNotes.
            await this.page.waitForTimeout(1_000);
          } catch {
            // button vanished as the list re-rendered
          }
        }
      }
      console.log(
        `[WalletPage.claimNotesByGroup] iter=${iteration} pending=${pending} claimed=${clicked} (stuck ${stuckSameCountIters})`
      );
      // LEFT AS A SLEEP: head start for the enqueued consume (see claimAllNotes).
      await this.page.waitForTimeout(clicked ? 8_000 : 2_000);

      // A successful group claim navigates to the transaction progress screen.
      // Reload the pending route so the next iteration always resumes at the
      // asset summary rather than depending on an in-page back control.
      await this.reloadAndPreparePending();

      // If the count hasn't budged for a few passes, a prior claim may have left
      // notes gated by `isBeingClaimed`; a full reload clears the in-memory gate.
      if (stuckSameCountIters >= 3) stuckSameCountIters = 0;
      // Poll spacing before the next sync round — deliberately a sleep.
      await this.page.waitForTimeout(2_000);
    }

    // Same guard as claimAllNotes: the loop exits on EITHER the deadline OR the
    // two-sample proof, so without `stableZero < THRESHOLD` a fully confirmed
    // drain that lands past the clock still threw.
    if (Date.now() >= deadline && stableZero < STABLE_ZERO_THRESHOLD) {
      await this.confirmDrainedOrThrow('claimNotesByGroup', {
        readPendingCount,
        timeoutMs,
        iteration,
        lastPending,
        stableZero,
        stableZeroThreshold: STABLE_ZERO_THRESHOLD
      });
    }

    console.log(`[WalletPage.claimNotesByGroup] drained after ${iteration} iteration(s)`);
    await this.navigateHome();
  }

  // ── Send Flow ─────────────────────────────────────────────────────────────

  /**
   * Execute the full send flow: SelectToken -> SendDetails -> ReviewTransaction.
   *
   * Post-condition: the review screen accepted the submit (its button detached)
   * and the wallet is not sitting on a rendered error surface. Both are thrown,
   * not logged — see the comment on step 6.
   */
  async sendTokens(params: {
    recipientAddress: string;
    amount: string;
    isPrivate: boolean;
    /**
     * Optional token symbol (e.g. "TST"). When set, picks that token's row
     * from the SelectToken list. Default: first row — fine when only one
     * fundable token exists, but not when MIDEN sits at 0 balance above the
     * real balance row.
     */
    tokenSymbol?: string;
  }): Promise<void> {
    // 1. Navigate to send. The v0-UI order is recipient → amount(+token) → review.
    await this.navigateTo('/send');
    const sendFlow = this.page.getByTestId('send-flow');
    await sendFlow.waitFor({ timeout: 15_000 });

    // Step timeouts sized for the worst-case actionability wait under stress: a
    // sync tick that started just before the navigation can hold the WASM lock
    // for 5-25s on testnet, queueing the balance reads that feed each step. 30s
    // is comfortable headroom rather than a regular hit.
    const STEP_TIMEOUT_MS = 30_000;

    // 2. SelectRecipient: fill the recipient address and confirm.
    await sendFlow.getByTestId('send-recipient-input').fill(params.recipientAddress);
    if (params.recipientAddress.trim().startsWith('0x')) {
      await sendFlow.getByTestId('send-network-selector').click({ timeout: STEP_TIMEOUT_MS });
      await this.page.getByTestId('send-network-sepolia').click({ timeout: STEP_TIMEOUT_MS });
    }
    await sendFlow.getByTestId('send-recipient-confirm').click({ timeout: STEP_TIMEOUT_MS });

    // 3. SelectAmount: open the token picker, pick a token, then fill the
    // amount. The amount Confirm stays disabled until a token is picked.
    // The picker is a bottom-sheet drawer PORTALED outside the send-flow
    // container, so its content must be page-scoped — wait for the drawer
    // to mount before enumerating rows.
    await sendFlow.getByTestId('send-token-selector').click({ timeout: STEP_TIMEOUT_MS });
    await this.page.getByTestId('send-token-search').waitFor({ timeout: STEP_TIMEOUT_MS });

    if (params.tokenSymbol) {
      const tokenRow = this.page.getByTestId(`send-token-${params.tokenSymbol}`);
      const symbolRowCount = await tokenRow.count().catch(() => 0);
      if (symbolRowCount > 0) {
        await tokenRow.first().click({ timeout: STEP_TIMEOUT_MS });
      } else {
        // No row for the requested symbol — fall back to the first non-MIDEN row
        // (MIDEN typically sits at 0 balance above the real fundable token).
        await this.clickFirstNonMidenTokenRow(this.page, STEP_TIMEOUT_MS);
      }
    } else {
      await this.clickFirstNonMidenTokenRow(this.page, STEP_TIMEOUT_MS);
    }

    // Back on SelectAmount after the sub-screen closes.
    await sendFlow.getByTestId('send-amount-input').fill(params.amount);
    await sendFlow.getByTestId('send-amount-confirm').click({ timeout: STEP_TIMEOUT_MS });

    // 4. Force the note type. The public/private toggle was removed (private by
    // default). Review is now a separate full-screen route (/send/review) that
    // installs the E2E hook on mount — wait for it before calling.
    await this.page.waitForFunction(
      () =>
        typeof (window as unknown as { __TEST_SET_SHARE_PRIVATELY__?: (v: boolean) => void })
          .__TEST_SET_SHARE_PRIVATELY__ === 'function',
      undefined,
      { timeout: STEP_TIMEOUT_MS }
    );
    await this.page.evaluate(
      p =>
        (window as unknown as { __TEST_SET_SHARE_PRIVATELY__?: (v: boolean) => void }).__TEST_SET_SHARE_PRIVATELY__?.(
          p
        ),
      params.isPrivate
    );

    // 5. ReviewTransaction: submit. Page-scoped — the review page renders
    // outside the send-flow container now.
    await this.page.getByTestId('send-review-submit').click({ timeout: STEP_TIMEOUT_MS });

    // 6. Treat the submit button detaching as the "submit accepted" signal — the
    // send flow navigates to home/completion once the request is dispatched.
    const submitAccepted = await this.page
      .getByTestId('send-review-submit')
      .waitFor({ state: 'detached', timeout: 120_000 })
      .then(() => true)
      .catch(() => false);

    // A successful submit routes to /generating-transaction/:txId. Wait for that
    // hash rather than sleeping, so the body-text scrape below reads the settled
    // screen. Capped at the 2s it replaced.
    await this.page
      .waitForFunction(() => window.location.hash.includes('generating-transaction'), undefined, { timeout: 2_000 })
      .catch(() => {});

    // Fail HERE, at the real failure point. Both of these used to be swallowed:
    // the detach timeout by a bare `.catch(() => {})`, and a rendered error
    // surface by a `console.log` — so a send that visibly failed on screen (or
    // was never dispatched at all) returned as if it had succeeded, and the spec
    // failed minutes later on the RECIPIENT's balance. That points the reader at
    // delivery/claiming when the send never left the sender.
    //
    // The error heuristic itself is unchanged (the progress-copy guard exists
    // because the in-flight screen legitimately contains words like
    // "processing"); only the reaction to a detected error is.
    const bodyText =
      (await this.page
        .locator('body')
        .textContent()
        .catch(() => '')) ?? '';
    const lower = bodyText.toLowerCase();
    const looksLikeError = lower.includes('failed') || lower.includes('error');
    const looksLikeProgress = /generating|processing|initiated|submitting|pending/.test(lower);
    if (looksLikeError && !looksLikeProgress) {
      throw new Error(
        `WalletPage.sendTokens: the wallet rendered an error surface after submit ` +
          `(submit button ${submitAccepted ? 'detached' : 'never detached'}). ` +
          `On-screen text (first 800): ${bodyText.slice(0, 800)}`
      );
    }
    if (!submitAccepted) {
      throw new Error(
        `WalletPage.sendTokens: the review screen's submit button was still attached 120s after clicking it, ` +
          `so the send was never dispatched. On-screen text (first 800): ${bodyText.slice(0, 800)}`
      );
    }
  }

  /**
   * In the SelectToken sub-screen, click the first available token row whose
   * testid is not `send-token-MIDEN`. Falls back to the very first row if
   * MIDEN is the only one present.
   */
  private async clickFirstNonMidenTokenRow(
    scope: Page | ReturnType<Page['getByTestId']>,
    timeoutMs: number
  ): Promise<void> {
    const rows = scope.locator('[data-testid^="send-token-"]');
    const total = await rows.count().catch(() => 0);
    for (let i = 0; i < total; i++) {
      const row = rows.nth(i);
      const testid = (await row.getAttribute('data-testid').catch(() => '')) ?? '';
      // Skip the token selector control itself and the MIDEN row.
      if (testid === 'send-token-selector' || testid === 'send-token-search' || testid === 'send-token-MIDEN') {
        continue;
      }
      await row.click({ timeout: timeoutMs });
      return;
    }
    // Only MIDEN (or no non-MIDEN rows) — take the first row.
    await rows.first().click({ timeout: timeoutMs });
  }

  // ── Balance Waiting ───────────────────────────────────────────────────────

  /**
   * Wait for the wallet's balance to exceed a minimum value.
   * Repeatedly triggers sync and checks balance.
   */
  async waitForBalanceAbove(
    minBalance: number,
    timeoutMs: number,
    timeline?: TimelineRecorder,
    tokenSymbol?: string
  ): Promise<number> {
    const intervalMs = 5_000;
    const maxAttempts = Math.ceil(timeoutMs / intervalMs);
    let lastBalance = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.triggerSync();
      lastBalance = await this.getBalance(tokenSymbol);

      if (timeline) {
        timeline.emit({
          category: 'blockchain_state',
          severity: lastBalance > minBalance ? 'info' : 'warn',
          message: `Balance check: ${lastBalance} (need > ${minBalance}) attempt ${attempt}/${maxAttempts}`,
          data: { balance: lastBalance, minBalance, attempt, maxAttempts }
        });
      }

      if (lastBalance > minBalance) return lastBalance;

      if (attempt < maxAttempts) {
        await this.page.waitForTimeout(intervalMs);
      }
    }

    throw new Error(`Balance did not exceed ${minBalance} within ${timeoutMs}ms. Last balance: ${lastBalance}`);
  }

  // ── Lock/Unlock ───────────────────────────────────────────────────────────

  /**
   * Lock the wallet via intercom LOCK_REQUEST.
   */
  async lockWallet(): Promise<void> {
    await this.page.evaluate(async () => {
      const intercom = (window as any).__TEST_INTERCOM__;
      if (intercom) {
        await intercom.request({ type: 'LOCK_REQUEST' });
      }
    });
    // No sleep after the request: the SW's LockRequest handler `await`s
    // `Actions.lock()` before responding (src/lib/miden/back/main.ts), so the
    // awaited intercom response above already IS the "wallet is locked" signal.

    // Reload to show the locked state (unlock screen), then wait for that screen
    // instead of a flat 2s. Capped at the 2s it replaced and non-throwing, so a
    // build without the intercom hook behaves exactly as before.
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this.page
      .getByTestId('unlock-password')
      .waitFor({ timeout: 2_000 })
      .catch(() => {});
  }

  /**
   * Unlock the wallet by typing the vault password into the extension's
   * password form (the 6-digit Numpad is mobile-only; the iOS harness has its
   * own numpad driver).
   */
  async unlockWallet(password: string = PASSWORD): Promise<void> {
    await this.navigateHome();
    await this.page.getByTestId('unlock-password').waitFor({ timeout: 15_000 });

    await this.page.locator('#unlock-password').fill(password);
    await this.page.locator('#unlock-password').press('Enter');

    // Submitting reloads the page on the extension; wait for the home surface
    // to re-render.
    await this.page.getByTestId('explore-page').waitFor({ timeout: 30_000 });
  }

  async setDelegateProofEnabled(enabled: boolean): Promise<void> {
    // The wallet stores this preference as a JSON-encoded boolean (matching
    // `setSetting` in src/lib/settings/helpers.ts:17). Writing the raw
    // string `"false"` would round-trip correctly through `JSON.parse`,
    // but mirroring the canonical encoding keeps inspection of
    // localStorage in DevTools consistent with what the production code
    // writes.
    await this.page.evaluate(value => {
      localStorage.setItem('delegate_proof_setting_key', JSON.stringify(value));
    }, enabled);
  }
}

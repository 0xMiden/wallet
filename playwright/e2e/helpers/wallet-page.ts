import type { Page } from '@playwright/test';

import type { IdbDumpSource } from './idb-dump';
import type { TimelineRecorder } from '../harness/timeline-recorder';

const PASSWORD = '123456';
const SYNC_WAIT_MS = 3_500;

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
  triggerSync(): Promise<void>;
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
   * Complete the create-wallet flow choosing the Guardian recovery method,
   * pointing the account at `guardianUrl` (a locally-spawned guardian).
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
}

export interface GuardianAuthInfo {
  threshold: number;
  signerCommitments: string[];
  procedureThresholds: Record<string, number>;
  error?: string;
}

/**
 * Page Object Model for a single wallet extension instance.
 * Encapsulates all UI interactions, reusing selectors from popup-smoke.spec.ts.
 */
export class ChromeWalletPage implements ChromeWalletPageApi {
  readonly page: Page;
  readonly extensionId: string;
  readonly userDataDir: string;

  constructor(page: Page, extensionId: string, userDataDir: string = '') {
    this.page = page;
    this.extensionId = extensionId;
    this.userDataDir = userDataDir;
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
   * Seeds the guardian endpoint into storage (the bypass create flow has no
   * custom-URL field) and onboards via the v0-UI test bypass.
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
    // Guardian accounts read GUARDIAN_URL_STORAGE_KEY ('guardian_url_setting')
    // from chrome.storage.local at register() time. Seed it BEFORE the bypass
    // navigation so the account is created against the local guardian endpoint.
    if (opts.walletType === 'guardian') {
      if (!opts.guardianUrl) {
        throw new Error('createWalletViaBypass: guardianUrl is required for the guardian wallet type');
      }
      await this.navigateHome();
      const guardianUrl = opts.guardianUrl;
      await this.page.evaluate(
        ({ key, url }) => new Promise<void>(resolve => chrome.storage.local.set({ [key]: url }, () => resolve())),
        { key: 'guardian_url_setting', url: guardianUrl }
      );
    }

    const params = new URLSearchParams();
    params.set('__test_skip_onboarding', '1');
    params.set('password', opts.password);
    if (opts.walletType === 'guardian') {
      params.set('walletType', 'guardian');
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
    return { address, seedPhrase: opts.seed ?? [] };
  }

  /**
   * Complete the "Create a new wallet" onboarding flow via the v0-UI bypass.
   * Returns the wallet address and (for created wallets) an empty seed phrase
   * (the bypass generates a random mnemonic that the UI never surfaces).
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
   * Get the balance for a specific token from the Explore page.
   * If tokenSymbol is not given, returns the balance of the first token row.
   * Returns 0 if no matching token found.
   */
  async getBalance(_tokenSymbol?: string): Promise<number> {
    await this.navigateHome();
    await this.page.waitForTimeout(1_000);

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
   */
  async triggerSync(): Promise<void> {
    try {
      await this.page.evaluate(async () => {
        const intercom = (window as any).__TEST_INTERCOM__;
        if (intercom) {
          // Sync state with the blockchain node
          await intercom.request({ type: 'SYNC_REQUEST' });
          // Trigger transaction processing (auto-consume pending notes)
          await intercom.request({ type: 'PROCESS_TRANSACTIONS_REQUEST' });
        }
      });
    } catch {
      // May fail during navigation, ignore
    }
    await this.page.waitForTimeout(SYNC_WAIT_MS);
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
    await this.page.waitForTimeout(3_000);
    await this.injectClaimableMetadata();
    // Claimable notes live on their own /pending-notes page, which mounts the
    // claim UI directly (no tab to switch to).
    await this.navigateTo('/pending-notes');
    await this.page.waitForTimeout(3_000);
  }

  async claimAllNotes(timeoutMs: number = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const STABLE_ZERO_THRESHOLD = 2;

    // Fresh reload + metadata injection + land on /receive. The reload (NOT a
    // client-side navigate) gives a fresh Dexie connection AND resets the
    // wallet's in-memory store — clearing the `extensionClaimingNoteIds` gate.
    // See reloadAndPreparePending.
    await this.reloadAndPreparePending();

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
        if (stableZero < STABLE_ZERO_THRESHOLD) await this.page.waitForTimeout(2_000);
        continue;
      }

      stableZero = 0;
      stuckSameCountIters = pending === lastPending ? stuckSameCountIters + 1 : 0;
      lastPending = pending;

      // Let the React UI render buttons for newly-arrived notes before probing.
      await this.page.waitForTimeout(2_000);

      // Desktop fast path: a single "Claim All" button drains every faucet.
      const claimAllBtn = this.page.getByTestId('claim-all-button');
      if (await claimAllBtn.isVisible().catch(() => false)) {
        console.log(`[WalletPage.claimAllNotes] iter=${iteration} pending=${pending} clicking Claim All`);
        await claimAllBtn.click();
        await this.page.waitForTimeout(8_000);
        continue;
      }

      // Two-level fallback: open each per-faucet summary row, claim every note
      // in the detail view, then go back. The list re-renders as notes are
      // claimed, so re-read the row count and operate on .first() each pass.
      const assetRows = this.page.getByTestId('pending-asset-row');
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
            await this.page.waitForTimeout(1_000);

            const claimBtns = this.page.getByTestId('claim-button');
            const claimCount = await claimBtns.count().catch(() => 0);
            for (let i = 0; i < claimCount; i++) {
              try {
                await this.page.getByTestId('claim-button').first().click({ timeout: 5_000 });
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
      if (stuckSameCountIters >= 3) {
        await this.reloadAndPreparePending();
        stuckSameCountIters = 0;
      }
      await this.page.waitForTimeout(3_000);
    }

    if (Date.now() >= deadline) {
      const remaining = await readPendingCount().catch(() => -1);
      throw new Error(
        `[WalletPage.claimAllNotes] timed out after ${timeoutMs}ms with ${remaining} pending note(s) ` +
          `after ${iteration} iteration(s)`
      );
    } else {
      console.log(`[WalletPage.claimAllNotes] drained in ${iteration} iteration(s)`);
    }

    await this.navigateHome();
  }

  /**
   * Drain pending notes via the per-faucet GROUP-claim path (Pending tab → open
   * an asset-summary row → asset detail view → group "Claim N/M" button, or the
   * per-note Claim buttons), exercising `handleClaimGroup` / `AssetPendingDetail`
   * — the two-level claim UI that the top-level "Claim All" (claimAllNotes) never
   * reaches. Chrome desktop only.
   */
  async claimNotesByGroup(timeoutMs: number = 180_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const STABLE_ZERO_THRESHOLD = 2;
    await this.reloadAndPreparePending();

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
        if (stableZero < STABLE_ZERO_THRESHOLD) await this.page.waitForTimeout(2_000);
        continue;
      }
      stableZero = 0;
      stuckSameCountIters = pending === lastPending ? stuckSameCountIters + 1 : 0;
      lastPending = pending;
      await this.page.waitForTimeout(2_000);

      // Open the first per-faucet summary row → asset detail view.
      const row = this.page.getByTestId('pending-asset-row').first();
      if (!(await row.isVisible().catch(() => false))) {
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
            await this.page.waitForTimeout(1_000);
          } catch {
            // button vanished as the list re-rendered
          }
        }
      }
      console.log(
        `[WalletPage.claimNotesByGroup] iter=${iteration} pending=${pending} claimed=${clicked} (stuck ${stuckSameCountIters})`
      );
      await this.page.waitForTimeout(clicked ? 8_000 : 2_000);

      // A successful group claim navigates to the transaction progress screen.
      // Reload the pending route so the next iteration always resumes at the
      // asset summary rather than depending on an in-page back control.
      await this.reloadAndPreparePending();

      // If the count hasn't budged for a few passes, a prior claim may have left
      // notes gated by `isBeingClaimed`; a full reload clears the in-memory gate.
      if (stuckSameCountIters >= 3) stuckSameCountIters = 0;
      await this.page.waitForTimeout(2_000);
    }

    if (Date.now() >= deadline) {
      const remaining = await readPendingCount().catch(() => -1);
      throw new Error(
        `[WalletPage.claimNotesByGroup] timed out after ${timeoutMs}ms with ${remaining} pending note(s) ` +
          `after ${iteration} iteration(s)`
      );
    }

    console.log(`[WalletPage.claimNotesByGroup] drained after ${iteration} iteration(s)`);
    await this.navigateHome();
  }

  // ── Send Flow ─────────────────────────────────────────────────────────────

  /**
   * Execute the full send flow: SelectToken -> SendDetails -> ReviewTransaction.
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
    await this.page
      .getByTestId('send-review-submit')
      .waitFor({ state: 'detached', timeout: 120_000 })
      .catch(() => {});
    await this.page.waitForTimeout(2_000);

    // Best-effort error detection: only log (don't hard-throw) — the spec
    // verifies delivery via the recipient's balance. Avoid false positives from
    // progress copy that legitimately contains words like "processing".
    const bodyText =
      (await this.page
        .locator('body')
        .textContent()
        .catch(() => '')) ?? '';
    const lower = bodyText.toLowerCase();
    const looksLikeError = lower.includes('failed') || lower.includes('error');
    const looksLikeProgress = /generating|processing|initiated|submitting|pending/.test(lower);
    if (looksLikeError && !looksLikeProgress) {
      console.log(`[WalletPage.sendTokens] possible error screen after submit: ${bodyText.slice(0, 500)}`);
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
    await this.page.waitForTimeout(2_000);
    // Reload to show the locked state (unlock screen)
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(2_000);
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

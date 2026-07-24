import type { CdpSession } from './cdp-bridge';
import type { SimulatorControl } from './simulator-control';
import type { TimelineRecorder } from '../../harness/timeline-recorder';
import type { GuardianAuthInfo, WalletPage } from '../../helpers/wallet-page';

const DEFAULT_PASSWORD = '123456';
const SYNC_WAIT_MS = 3_500;
const POLL_INTERVAL_MS = 500;

interface IosWalletPageOpts {
  cdp: CdpSession;
  sim: SimulatorControl;
  udid: string;
  bundleId: string;
}

/**
 * iOS implementation of the WalletPage interface. Uses CdpSession for DOM
 * access (via webinspectord_sim) and SimulatorControl for screenshots.
 *
 * The Chrome POM and this one share the spec contract via the `WalletPage`
 * interface. Surface-only differences:
 *   - No `.page` (Playwright Page) — multi-account-style DOM probes use the
 *     iOS-only helpers below (`locatorText`, `click`, `waitFor`, `delay`).
 *   - `evaluate` and `screenshot` mirror Playwright's Page shape so the same
 *     `ScreenshotCapable` / `StateCaptureCapable` typing accepts both.
 */
export interface PollStats {
  pollCount: number;
  pollIterations: number;
  pollMs: number;
  pollSleepMs: number;
}

export class IosWalletPage implements WalletPage {
  readonly udid: string;
  readonly bundleId: string;
  private cdp: CdpSession;
  private sim: SimulatorControl;
  private pollStats: PollStats = { pollCount: 0, pollIterations: 0, pollMs: 0, pollSleepMs: 0 };

  constructor(opts: IosWalletPageOpts) {
    this.cdp = opts.cdp;
    this.sim = opts.sim;
    this.udid = opts.udid;
    this.bundleId = opts.bundleId;
  }

  /** Read poll stats snapshot. Includes CdpSession totals too. */
  getStats(): { polls: PollStats; cdp: ReturnType<CdpSession['getStats']> } {
    return { polls: { ...this.pollStats }, cdp: this.cdp.getStats() };
  }

  // ── Capability surfaces (matches Playwright Page shape) ─────────────────

  async screenshot(opts: { path: string }): Promise<void> {
    await this.sim.screenshot(this.udid, opts.path);
  }

  async evaluate<T = unknown>(fn: () => T | Promise<T>): Promise<T> {
    return this.cdp.evaluate(fn);
  }

  // ── iOS-only helpers (used inline by .ios.spec.ts where Chrome reaches
  //    into Playwright internals) ─────────────────────────────────────────

  async locatorText(selector: string): Promise<string | null> {
    return this.cdp.eval<string | null>(
      `var el = document.querySelector(${JSON.stringify(selector)}); ` +
        `return el ? (el.textContent || '').trim() : null;`
    );
  }

  async click(selector: string): Promise<void> {
    const ok = await this.cdp.eval<boolean>(
      `var el = document.querySelector(${JSON.stringify(selector)}); ` +
        `if (!el) return false; el.click(); return true;`
    );
    if (!ok) throw new Error(`IosWalletPage.click: no element matched ${selector}`);
  }

  /**
   * Poll until `selector` is present AND enabled, then click it. On iOS, click()
   * is a JS `el.click()` that silently no-ops on a disabled <button>, so clicking
   * a form CTA before its validation has enabled it advances nothing (the next
   * screen never renders). The single-threaded WASM lock held by the ~3s sync
   * tick can delay that validation, so gated CTAs (recipient/amount confirm)
   * must wait for the enabled state rather than fire-and-hope.
   */
  async clickWhenEnabled(selector: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const state = await this.cdp.eval<string>(
        `var el = document.querySelector(${JSON.stringify(selector)}); ` +
          `if (!el) return 'missing'; ` +
          `if (el.disabled || el.getAttribute('aria-disabled') === 'true') return 'disabled'; ` +
          `el.click(); return 'clicked';`
      );
      if (state === 'clicked') return;
      await sleep(500);
    }
    throw new Error(`IosWalletPage.clickWhenEnabled: ${selector} not present+enabled within ${timeoutMs}ms`);
  }

  async waitFor(selector: string, opts: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    await this.pollForSelector(selector, timeoutMs);
  }

  delay(ms: number): Promise<void> {
    return sleep(ms);
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  async navigateTo(hash: string): Promise<void> {
    const target = hash.startsWith('#') ? hash : `#${hash.startsWith('/') ? hash : '/' + hash}`;
    await this.cdp.eval(`window.location.hash = ${JSON.stringify(target)}; return null;`);
    await sleep(300);
  }

  async navigateHome(): Promise<void> {
    await this.cdp.eval(`window.location.hash = '#/'; return null;`);
    await sleep(500);
  }

  // ── Onboarding ────────────────────────────────────────────────────────────

  /**
   * Create a fully-private (OffChain) wallet via the wallet's official test
   * hook, then tap "Get started" on the confirmation screen and wait for the
   * store to reach Ready. Mirrors the Chrome `createNewWallet` contract.
   */
  async createNewWallet(password: string = DEFAULT_PASSWORD): Promise<{ address: string; seedPhrase: string[] }> {
    return this.createWalletViaBypass(password, 'private');
  }

  /**
   * Create a Guardian (co-signed) wallet via the same onboarding bypass,
   * passing `walletType=guardian` so `registerWallet` builds a guardian
   * account. Uses the network-default guardian endpoint (devnet →
   * guardian-stg). Mirrors the Chrome `createGuardianWallet` contract.
   */
  async createGuardianWallet(password: string = DEFAULT_PASSWORD): Promise<{ address: string; seedPhrase: string[] }> {
    return this.createWalletViaBypass(password, 'guardian');
  }

  /**
   * Drive the v0-UI onboarding via the `__test_skip_onboarding` bypass baked
   * into Welcome.tsx. Navigating with the bypass query params sets the
   * onboarding state (Import when `seed` is present, random Create otherwise)
   * and auto-advances to the Confirmation screen. The wallet type is selected
   * via the `walletType` query param the bypass reads. After the navigation,
   * the welcome screen auto-jumps to the confirmation step (seed already
   * generated/imported, password set from the query param); tapping the
   * confirmation submit button ("Open wallet") then runs `register()`.
   */
  private async createWalletViaBypass(
    password: string,
    recovery: 'private' | 'guardian',
    seed?: string[]
  ): Promise<{ address: string; seedPhrase: string[] }> {
    // Welcome screen must be visible (fixture guarantees this on cold launch).
    await this.pollForSelector('[data-testid="onboarding-welcome"]', 30_000);

    const passwordEnc = encodeURIComponent(password);
    const seedEnc = seed && seed.length > 0 ? encodeURIComponent(seed.join(' ')) : '';
    // Guardian account creation does extra HTTP round-trips to co-sign with the
    // guardian, so it needs a wider readiness window than a private wallet.
    const readyTimeoutMs = recovery === 'guardian' ? 180_000 : 120_000;
    await this.cdp.eval(
      `var u = new URL(location.href); ` +
        `u.searchParams.set('__test_skip_onboarding', '1'); ` +
        `u.searchParams.set('password', '${passwordEnc}'); ` +
        (recovery === 'guardian' ? `u.searchParams.set('walletType', 'guardian'); ` : '') +
        (seedEnc ? `u.searchParams.set('seed', '${seedEnc}'); ` : '') +
        `location.href = u.toString(); ` +
        `return null;`
    );
    // Page is reloading — give the WebView time to settle before next eval.
    await sleep(2_500);

    // The bypass auto-navigates to the Confirmation screen once it has applied
    // the onboarding state. Wait for the confirmation container to mount.
    await this.pollForSelector('[data-testid="onboarding-confirmation"]', 120_000);

    // Click "Open wallet" — this triggers register() which creates the vault.
    // The old "Get started" text is gone; the button is now keyed by testid.
    await this.click('[data-testid="onboarding-confirmation-submit"]');

    // Wait for store status === Ready (numeric 2 in the Zustand enum).
    await this.pollForCondition(
      `var s = window.__TEST_STORE__; ` +
        `if (!s) return false; ` +
        `var st = s.getState(); ` +
        `return st && (st.status === 2 || st.status === 'Ready') && !!st.currentAccount;`,
      readyTimeoutMs
    );

    const address = await this.cdp.eval<string>(
      `var s = window.__TEST_STORE__.getState(); ` + `return (s.currentAccount && s.currentAccount.publicKey) || '';`
    );
    if (!address) {
      throw new Error(`IosWalletPage.createWalletViaBypass(${recovery}): no currentAccount.publicKey after Ready`);
    }

    // For created wallets the bypass synthesizes the seed phrase internally
    // (we don't read it back); for imported wallets the caller already has it.
    return { address, seedPhrase: seed ?? [] };
  }

  /**
   * Import an existing wallet via the v0-UI `__test_skip_onboarding` bypass,
   * passing the seed words through the `seed` query param. Mirrors the Chrome
   * POM's `importWallet` (which routes through the same bypass) — no spec
   * currently drives this, so keep it simple and robust rather than scripting
   * the multi-step import UI.
   */
  async importWallet(seedPhrase: string[], password: string = DEFAULT_PASSWORD): Promise<{ address: string }> {
    const { address } = await this.createWalletViaBypass(password, 'private', seedPhrase);
    return { address };
  }

  /**
   * Extract the wallet account address.
   *
   * Primary path: read the canonical bech32 string from `__TEST_STORE__`
   * (`mdev1…` on devnet, `mtst1…` on testnet, etc.).
   *
   * DOM fallback: navigate to /receive (lands on the Address tab) and read the
   * untruncated address from the `receive-address-full` sr-only span — the
   * visible address is now truncated, so scraping it would yield an ellipsis.
   */
  async getAccountAddress(): Promise<string> {
    const bechRe = /^m[a-z]{1,4}1[a-z0-9]+/i;

    // Primary path: poll the Zustand store for the current account's publicKey.
    const storeAddress = await this.cdp
      .eval<string>(
        `var s = window.__TEST_STORE__; ` +
          `if (!s) return ''; ` +
          `var pk = (s.getState().currentAccount && s.getState().currentAccount.publicKey) || ''; ` +
          `return /^m[a-z]{1,4}1[a-z0-9]+/i.test(pk) ? pk : '';`
      )
      .catch(() => '');
    if (storeAddress) return storeAddress.trim();

    // DOM fallback: read the untruncated address from the sr-only span on the
    // Receive page's Address tab.
    await this.navigateTo('/receive');
    await this.pollForSelector('[data-testid="receive-page"]', 15_000);

    const address = await this.cdp.eval<string>(
      `var full = document.querySelector('[data-testid="receive-address-full"]'); ` +
        `if (full && (full.textContent || '').trim()) return (full.textContent || '').trim(); ` +
        `var c = document.querySelector('[data-testid="receive-page"]'); ` +
        `if (!c) return ''; ` +
        `var m = (c.textContent || '').match(/m[a-z]{1,4}1[a-z0-9]+/i); ` +
        `return m ? m[0] : '';`
    );
    if (!address || !bechRe.test(address)) {
      throw new Error('IosWalletPage.getAccountAddress: no bech32 address found on Receive page');
    }
    await this.navigateHome();
    return address.trim();
  }

  // ── Balance ───────────────────────────────────────────────────────────────

  /**
   * Read balances from the Zustand store. Unlike Chrome, mobile has no
   * `chrome.storage.local` fallback — sync data lives only in the store.
   */
  async getBalance(_tokenSymbol?: string): Promise<number> {
    await this.navigateHome();
    await sleep(1_000);
    // Reads consumed balances from the Zustand store. useSyncTrigger updates
    // the store every 3s on mobile.
    //
    // IMPORTANT: unlike Chrome's getBalance (which reads
    // chrome.storage.local.miden_sync_data.notes to count
    // pending-but-unconsumed notes too), this method returns 0 until notes
    // are actually consumed. Mobile has no chrome.storage equivalent. Both
    // platforms auto-consume ONLY notes from the well-known MIDEN faucet;
    // E2E tests use a CUSTOM faucet, so iOS specs need to call
    // claimAllNotes() before waiting on a positive balance.
    return this.cdp.eval<number>(
      `var s = window.__TEST_STORE__; ` +
        `if (!s) return 0; ` +
        `var st = s.getState(); ` +
        `var total = 0; ` +
        `var balances = st.balances || {}; ` +
        `for (var k in balances) { ` +
        `  var list = balances[k]; ` +
        `  if (!Array.isArray(list)) continue; ` +
        `  for (var i = 0; i < list.length; i++) { ` +
        `    var t = list[i]; ` +
        `    var amt = parseFloat(String(t.amount != null ? t.amount : (t.balance != null ? t.balance : '0'))); ` +
        `    if (amt > 0) total += amt; ` +
        `  } ` +
        `} ` +
        `return total;`
    );
  }

  async triggerSync(): Promise<void> {
    // On mobile, the wallet auto-syncs every 3s in main thread via
    // useSyncTrigger as soon as status === Ready (no SW indirection like
    // Chrome). We don't need to send SYNC_REQUEST — we just need to wait
    // long enough for at least one auto-sync tick to land.
    await sleep(SYNC_WAIT_MS);
  }

  // ── Claim ─────────────────────────────────────────────────────────────────

  async claimAllNotes(timeoutMs: number = 120_000, knownFaucetIds: string[] = []): Promise<void> {
    // Chrome's claimAllNotes reloads the page to get a fresh Dexie handle
    // — that's safe on Chrome because the SW holds the vault unlock in a
    // separate context. On mobile there's no SW; a reload would drop the
    // in-memory decryption key and kick the UI back to the password
    // screen, where no Claim button exists. Stay in-session instead.
    // Claimable notes live on their own /pending-notes page (mounts the claim UI
    // directly).
    await this.navigateTo('/pending-notes');
    // The wallet's auto-sync runs every 3s (useSyncTrigger). On a freshly
    // installed app the first sync also pays a cold WASM init + IndexedDB
    // open + RPC cold-start cost. Give it ~10s to land at least one full
    // sync cycle before we start polling for the Claim All button.
    await sleep(10_000);

    // The wallet's `attachMetadataToNotes` (`src/lib/miden/front/claimable-notes.ts`)
    // silently drops consumable notes whose faucet metadata couldn't be
    // fetched from the RPC. The test deploys a custom `basic-fungible-faucet`
    // whose on-chain procedures don't match what the SDK's
    // `BasicFungibleFaucetComponent.fromAccount` expects — so the wallet
    // hides the note, "Claim All" never renders, and the claim button
    // poll times out. Mirrors Chrome's claimAllNotes
    // workaround (`playwright/e2e/helpers/wallet-page.ts:762-792`): inject
    // synthetic metadata for any faucet we don't already have, so
    // `attachMetadataToNotes`'s `metadataByFaucetId[n.faucetId]` lookup
    // hits and the note survives the filter. The keys we inject for are
    // every bech32 faucet id we can discover from the wallet's own
    // SDK-fetched notes (read via the existing `__TEST_STORE__`-driven
    // path) — no test-side `faucetId` plumbing needed.
    if (knownFaucetIds.length > 0) {
      await this.injectTestMetadataForFaucets(knownFaucetIds);
    }

    // Block-time + sync-cycle math: even after the mint commits, the wallet
    // needs (a) at least one auto-sync after the new block lands, (b) the
    // SWR refresh (5s) to actually re-read consumable notes, (c) any
    // additional WASM-lock contention if a prove/sign is in flight. 60s
    // was too tight on testnet under CI load (deterministic failure for
    // the past 2+ weeks). Bumped to 120s — the outer claimAllNotes
    // timeout (default 180s) still has ~50s left for balance polling
    // after this resolves.
    await this.pollForCondition(
      `var btn = document.querySelector('[data-testid="claim-all-button"]'); ` +
        `if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false; ` +
        `btn.click(); return true;`,
      120_000
    );

    // TEMPORARY (mobile-MT test): periodically dump
    // window.__PROVE_TIMINGS__ markers recorded by the wallet so we can
    // see prove path + duration even when Console.messageAdded doesn't
    // route console.log. Plain stdout via console.log so they show in
    // the playwright test log.
    let lastProveTimingIdx = 0;
    const pumpProveTimings = async () => {
      try {
        const fresh = await this.cdp.eval<string[]>(
          `var a = (window).__PROVE_TIMINGS__ || []; return a.slice(${lastProveTimingIdx});`
        );
        if (Array.isArray(fresh) && fresh.length > 0) {
          lastProveTimingIdx += fresh.length;
          for (const line of fresh) {
            // eslint-disable-next-line no-console
            console.log(`[prove-timing] ${line}`);
          }
        }
      } catch {
        // ignore
      }
    };

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await this.triggerSync();
      await sleep(5_000);
      await pumpProveTimings();
      const balance = await this.cdp.eval<number>(
        `var s = window.__TEST_STORE__; ` +
          `if (!s) return 0; ` +
          `var st = s.getState(); ` +
          `var balances = st.balances || {}; ` +
          `for (var k in balances) { ` +
          `  var list = balances[k]; ` +
          `  if (!Array.isArray(list)) continue; ` +
          `  for (var i = 0; i < list.length; i++) { ` +
          `    var t = list[i]; ` +
          `    var amt = parseFloat(String(t.amount != null ? t.amount : (t.balance != null ? t.balance : '0'))); ` +
          `    if (amt > 0) return amt; ` +
          `  } ` +
          `} ` +
          `return 0;`
      );
      if (balance > 0) {
        await pumpProveTimings();
        await this.navigateHome();
        return;
      }
    }
    await pumpProveTimings();
    await this.navigateHome();
  }

  /**
   * Stuff synthetic metadata into the wallet's Zustand `assetsMetadata` for
   * the given faucet ids. Makes `attachMetadataToNotes` (in
   * `src/lib/miden/front/claimable-notes.ts`) treat the test's custom
   * faucet as "metadata known" so the consumable note survives the filter
   * and "Claim All" registers. Mirrors Chrome's claimAllNotes workaround
   * (`playwright/e2e/helpers/wallet-page.ts:762-792`) where Chrome reads
   * the cached consumable notes from `chrome.storage.local` and does the
   * same `store.setState({ assetsMetadata: ... })`. iOS has no chrome
   * storage, so we feed the faucet ids in from the test side.
   */
  private async injectTestMetadataForFaucets(hexFaucetIds: string[]): Promise<void> {
    if (hexFaucetIds.length === 0) return;
    // The wallet's `parseNotes` (`src/lib/miden/front/claimable-notes.ts:61`)
    // stores `faucetId` in bech32 form (e.g. `mtst1a...`), not hex.
    // `attachMetadataToNotes` keys the metadata lookup by that bech32 form.
    // The CLI hands us a hex account id (e.g. `0xba55e5...`), so we need to
    // do the conversion in the same way the wallet does, by calling into
    // the loaded SDK's `Address.fromAccountId(id, 'BasicWallet').toBech32(networkId)`.
    // We use `evaluateAsync` with the wallet's already-loaded SDK module —
    // the dynamic `import('@miden-sdk/miden-sdk/lazy')` hits the module
    // cache instantly because the wallet already imported it at boot.
    const hexJson = JSON.stringify(hexFaucetIds);
    const network = process.env.MIDEN_NETWORK || process.env.E2E_NETWORK || 'testnet';
    const networkArg = network === 'devnet' ? "'devnet'" : "'testnet'";
    // Poll for the hex→bech32 hook to be exposed — it's set asynchronously
    // when the wallet boots (the SDK eager-import in store/index.ts under
    // MIDEN_E2E_TEST). On a freshly-installed app the SDK chunk takes a few
    // seconds to resolve, so the hook may not be ready when we navigate.
    const start = Date.now();
    let hookReady = false;
    while (Date.now() - start < 60_000) {
      const ready = await this.cdp
        .eval<boolean>(`return typeof window.__TEST_HEX_TO_BECH32_FAUCET__ === 'function';`)
        .catch(() => false);
      if (ready) {
        hookReady = true;
        break;
      }
      await sleep(500);
    }
    if (!hookReady) {
      // eslint-disable-next-line no-console
      console.log('[injectTestMetadataForFaucets] hook never exposed; skipping');
      return;
    }
    const result = await this.cdp
      .eval<
        { before: string[]; injected: string[]; after: string[] } | { error: string }
      >(`var conv = window.__TEST_HEX_TO_BECH32_FAUCET__; ` + `var bech32 = ${hexJson}.map(hex => conv(hex, ${networkArg})); ` + `var injected = {}; ` + `for (var i = 0; i < bech32.length; i++) injected[bech32[i]] = { name: 'Test Token', symbol: 'TST', decimals: 8, thumbnailUri: '' }; ` + `var s = window.__TEST_STORE__; ` + `if (!s) return { error: 'no __TEST_STORE__' }; ` + `var st = s.getState(); ` + `var before = Object.keys(st.assetsMetadata || {}); ` + `if (typeof st.setAssetsMetadata === 'function') { st.setAssetsMetadata(injected); } ` + `else { s.setState({ assetsMetadata: Object.assign({}, st.assetsMetadata || {}, injected) }); } ` + `var after = Object.keys(s.getState().assetsMetadata || {}); ` + `return { before: before, injected: bech32, after: after };`)
      .catch((e: Error) => ({ error: e.message }));
    // eslint-disable-next-line no-console
    console.log(`[injectTestMetadataForFaucets] hex=${hexJson} -> ${JSON.stringify(result)}`);
  }

  // ── Send Flow ─────────────────────────────────────────────────────────────

  /**
   * Execute the full v0-UI send flow: SelectRecipient → SelectAmount(+token) →
   * ReviewTransaction. Every step is driven by React DOM buttons via CDP.
   */
  async sendTokens(params: {
    recipientAddress: string;
    amount: string;
    isPrivate: boolean;
    /**
     * Optional token symbol (e.g. "TST"). When set, picks that token's row from
     * the token sub-screen. Default: first non-MIDEN row — fine when only one
     * fundable token exists.
     */
    tokenSymbol?: string;
  }): Promise<void> {
    // v0-UI order: recipient → amount(+token) → review.
    await this.navigateTo('/send');
    await this.pollForSelector('[data-testid="send-flow"]', 15_000);

    // 1. SelectRecipient: fill the recipient address (textarea) and confirm.
    // Confirm is gated on a valid address, so wait for it to enable.
    await this.fillInput('[data-testid="send-recipient-input"]', params.recipientAddress);
    if (params.recipientAddress.trim().startsWith('0x')) {
      await this.pollForSelector('[data-testid="send-network-selector"]', 15_000);
      await this.click('[data-testid="send-network-selector"]');
      await this.pollForSelector('[data-testid="send-network-sepolia"]', 15_000);
      await this.click('[data-testid="send-network-sepolia"]');
    }
    await this.clickWhenEnabled('[data-testid="send-recipient-confirm"]', 30_000);

    // 2. SelectAmount: open the token sub-screen, pick a token, then fill the
    // amount. The amount Confirm stays disabled until a token is picked.
    await this.pollForSelector('[data-testid="send-token-selector"]', 15_000);
    await this.click('[data-testid="send-token-selector"]');

    // Pick the token row. Prefer the requested symbol; otherwise take the first
    // token row that isn't the selector control, the search box, or MIDEN
    // (which typically sits at 0 balance above the real fundable token).
    const tokenSymbol = params.tokenSymbol;
    if (tokenSymbol) {
      // Wait for the FUNDED token row specifically — balance sync can lag, and
      // if only the 0-balance MIDEN row has rendered, the fallback would grab it
      // and the amount Confirm would never enable.
      await this.pollForSelector(`[data-testid="send-token-${tokenSymbol}"]`, 30_000);
    } else {
      await this.pollForCondition(`return !!document.querySelector('[data-testid^="send-token-"]');`, 15_000);
    }
    const clickedToken = await this.cdp.eval<boolean>(
      `var symbol = ${JSON.stringify(tokenSymbol ?? '')}; ` +
        `if (symbol) { ` +
        `  var want = document.querySelector('[data-testid="send-token-' + symbol + '"]'); ` +
        `  if (want) { want.click(); return true; } ` +
        `} ` +
        `var rows = Array.from(document.querySelectorAll('[data-testid^="send-token-"]')); ` +
        `var skip = ['send-token-selector', 'send-token-search', 'send-token-MIDEN']; ` +
        `var pick = rows.find(function(r) { return skip.indexOf(r.getAttribute('data-testid') || '') === -1; }); ` +
        `if (!pick) pick = rows[0]; ` +
        `if (!pick) return false; pick.click(); return true;`
    );
    if (!clickedToken) {
      throw new Error('IosWalletPage.sendTokens: no token row to select');
    }

    // Back on SelectAmount after the sub-screen closes. Generous timeout: the
    // single-threaded WASM lock (held by the ~3s sync tick on mobile) can queue
    // the balance reads that gate each screen, so render can lag.
    await this.pollForSelector('[data-testid="send-amount-input"]', 30_000);
    await this.fillInput('[data-testid="send-amount-input"]', params.amount);
    // Confirm is disabled until a token is picked AND the amount validates
    // (both involve balance reads behind the WASM lock); clicking it while still
    // disabled is a silent no-op, so wait for the enabled state.
    await this.clickWhenEnabled('[data-testid="send-amount-confirm"]', 45_000);

    // 3. Force the note type. The public/private toggle was removed (private by
    // default); the E2E hook persists the choice across the remaining steps.
    await this.pollForCondition(`return typeof window.__TEST_SET_SHARE_PRIVATELY__ === 'function';`, 15_000);
    await this.cdp.eval(`window.__TEST_SET_SHARE_PRIVATELY__(${params.isPrivate ? 'true' : 'false'}); return null;`);

    // 4. ReviewTransaction: submit. The Review screen recomputes the fee/summary
    // on entry (a balance read behind the WASM lock), which can lag well past 15s
    // when a sync tick holds the lock — so poll generously.
    await this.pollForSelector('[data-testid="send-review-submit"]', 45_000);
    await this.click('[data-testid="send-review-submit"]');

    // 5. Treat the submit button detaching as the "submit accepted" signal — the
    // send flow navigates away once the request is dispatched.
    await this.pollForCondition(`return !document.querySelector('[data-testid="send-review-submit"]');`, 120_000).catch(
      async () => {
        const body = await this.locatorText('body');
        if (body && /error|failed/i.test(body) && !/generating|processing|initiated|submitting|pending/i.test(body)) {
          throw new Error(`Send transaction appears to have failed. Page text: ${body.slice(0, 500)}`);
        }
      }
    );
    await sleep(2_000);
  }

  // ── Balance Waiting ───────────────────────────────────────────────────────

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
      if (attempt < maxAttempts) await sleep(intervalMs);
    }

    throw new Error(`Balance did not exceed ${minBalance} within ${timeoutMs}ms. Last balance: ${lastBalance}`);
  }

  // ── Lock / Unlock ─────────────────────────────────────────────────────────

  async lockWallet(): Promise<void> {
    // Fire-and-forget the lock request — we reload immediately after, so we
    // don't need to await the intercom roundtrip (which can hang on mobile
    // when the SW-style port resolves on the same thread).
    await this.cdp.eval(
      `var i = window.__TEST_INTERCOM__; ` +
        `if (i) { try { i.request({ type: 'LOCK_REQUEST' }); } catch (e) {} } ` +
        `return null;`
    );
    await sleep(2_000);
    await this.cdp.eval(`location.reload(); return null;`);
    // Page is reloading — wait for the WebView to settle and re-acquire the
    // page reference for subsequent eval calls.
    await sleep(3_000);
  }

  /**
   * Unlock the wallet by entering the 6-digit passcode on the Numpad (the
   * passcode IS the vault password). Entering 6 digits auto-submits.
   *
   * On mobile the Unlock screen first attempts hardware/biometric unlock
   * automatically; when that path is taken there may be no numpad. So we poll
   * for the numpad container with a short budget and, if it never appears,
   * fall back to the legacy text-input unlock (covers the biometric-auto path
   * and any non-numpad unlock surface). The numpad path is the primary one and
   * mirrors the Chrome POM.
   *
   * NOTE: the numpad-vs-biometric branching on iOS is unverified here — it will
   * be validated by a later simulator run. The fallback keeps the method robust
   * either way.
   */
  async unlockWallet(password: string = DEFAULT_PASSWORD): Promise<void> {
    await this.navigateHome();

    // Primary path: 6-digit numpad. Poll briefly — if biometric auto-unlock
    // took over there may be no numpad to drive.
    const numpadReady = await this.pollForSelector('[data-testid="unlock-passcode"]', 10_000)
      .then(() => true)
      .catch(() => false);

    if (numpadReady) {
      for (const ch of password) {
        await this.click(`[data-testid="numpad-${ch}"]`);
        await sleep(150);
      }
      // Entering the final digit auto-submits; wait for the home surface.
      await this.pollForCondition(
        `if (document.querySelector('[data-testid="explore-page"]')) return true; ` +
          `var s = window.__TEST_STORE__; ` +
          `if (!s) return false; ` +
          `var pk = (s.getState().currentAccount && s.getState().currentAccount.publicKey) || ''; ` +
          `return /^m[a-z]{1,4}1[a-z0-9]+/i.test(pk);`,
        30_000
      );
      return;
    }

    // Fallback: legacy text-input unlock (or biometric already unlocked us, in
    // which case there's nothing to do and the fill/click no-op safely).
    await this.fillInputAny(['input[type="password"]', 'input'], password).catch(() => {});
    await this.clickByText('button', /unlock|continue|submit/i).catch(() => {});
    await sleep(3_000);
  }

  async setDelegateProofEnabled(enabled: boolean): Promise<void> {
    await this.cdp.eval(
      `localStorage.setItem('delegate_proof_setting_key', ${JSON.stringify(JSON.stringify(enabled))});`
    );
  }

  /**
   * Read a Guardian account's on-chain auth structure (overall threshold,
   * signer commitments, per-procedure thresholds).
   *
   * iOS reads this from the `__TEST_GUARDIAN_AUTH_STRUCTURE__` stash that the
   * wallet's own balance poll populates (`fetchBalances` →
   * `captureGuardianAuthStructureForTest`, a pure `AccountInspector.fromAccount`
   * parse) — NOT through the async `__TEST_GUARDIAN_AUTH__` hook. Two reasons,
   * both proven against the CI timeline:
   *
   *   1. The stash is a plain JSON-serializable object, so it reads over the
   *      reliable SYNCHRONOUS `execute_script` atom. The async
   *      `execute_async_script` atom (appium-remote-debugger) hands the user
   *      script its completion callback as `arguments[arguments.length - 1]`,
   *      but on this iOS RWI bridge that slot arrives as the boolean `true`, so
   *      `cb(result)` throws `TypeError: cb is not a function`, the promise
   *      rejects unhandled, the callback never fires, and EVERY `evalAsync`
   *      hangs to its timeout. (Observed: `Unhandled Promise Rejection:
   *      TypeError: d is not a function ... 'd' is true` fired the instant the
   *      auth read ran, then a 60s timeout — even though the stash was already
   *      populated.) The sync atom returns its value directly, no callback.
   *   2. A direct WASM read in the eval path gets starved on the single-threaded
   *      iOS WASM. The stash read touches no WASM at all.
   *
   * The auth structure is immutable (fixed at account creation), so a
   * slightly-old captured copy is exactly correct for these assertions. The
   * stash is keyed by the address the balance poll fetched, which can be a
   * different encoding than the publicKey the test passes — but a wallet
   * instance only ever has one Guardian account, so the single stashed
   * structure is unambiguous. Polls because the capture runs on the balance-poll
   * cadence; by the auth step the consume has already driven several polls, so
   * the first read almost always hits.
   */
  async getGuardianAuthInfo(accountPublicKey: string): Promise<GuardianAuthInfo> {
    const deadline = Date.now() + 30_000;
    let lastErr = 'guardian auth structure not captured (stash empty after 30s)';
    while (Date.now() < deadline) {
      try {
        const result = await this.cdp.eval<GuardianAuthInfo | null>(
          `var s = globalThis.__TEST_GUARDIAN_AUTH_STRUCTURE__;
           if (!s) return null;
           var keys = Object.keys(s);
           if (keys.length === 0) return null;
           var v = s[${JSON.stringify(accountPublicKey)}] || s[keys[0]];
           if (!v) return null;
           return {
             threshold: v.threshold,
             signerCommitments: v.signerCommitments,
             procedureThresholds: v.procedureThresholds
           };`
        );
        if (result) return result;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      await sleep(1_500);
    }
    return { threshold: NaN, signerCommitments: [], procedureThresholds: {}, error: lastErr };
  }

  // ── Internals (DOM helpers wired through CDP) ───────────────────────────

  private async pollForSelector(selector: string, timeoutMs: number): Promise<void> {
    const wallStart = Date.now();
    let iterations = 0;
    let totalSleepMs = 0;
    try {
      while (Date.now() - wallStart < timeoutMs) {
        iterations++;
        // Catch eval errors (page reload mid-poll, inspector reattach race).
        const found = await this.cdp
          .eval<boolean>(`return !!document.querySelector(${JSON.stringify(selector)});`)
          .catch(() => false);
        if (found) return;
        await sleep(POLL_INTERVAL_MS);
        totalSleepMs += POLL_INTERVAL_MS;
      }
      throw new Error(`pollForSelector: ${selector} did not appear within ${timeoutMs}ms`);
    } finally {
      this.pollStats.pollCount++;
      this.pollStats.pollIterations += iterations;
      this.pollStats.pollMs += Date.now() - wallStart;
      this.pollStats.pollSleepMs += totalSleepMs;
    }
  }

  private async pollForCondition(jsBody: string, timeoutMs: number): Promise<void> {
    const wallStart = Date.now();
    let iterations = 0;
    let totalSleepMs = 0;
    try {
      while (Date.now() - wallStart < timeoutMs) {
        iterations++;
        const ok = await this.cdp.eval<boolean>(jsBody).catch(() => false);
        if (ok) return;
        await sleep(POLL_INTERVAL_MS);
        totalSleepMs += POLL_INTERVAL_MS;
      }
      throw new Error(`pollForCondition: condition not met within ${timeoutMs}ms — ${jsBody.slice(0, 80)}`);
    } finally {
      this.pollStats.pollCount++;
      this.pollStats.pollIterations += iterations;
      this.pollStats.pollMs += Date.now() - wallStart;
      this.pollStats.pollSleepMs += totalSleepMs;
    }
  }

  private async clickByText(tag: string, pattern: RegExp): Promise<void> {
    const ok = await this.cdp.eval<boolean>(
      `var els = Array.from(document.querySelectorAll(${JSON.stringify(tag)})); ` +
        `var re = ${pattern.toString()}; ` +
        `var target = els.find(function(el) { return re.test(el.textContent || ''); }); ` +
        `if (!target) return false; target.click(); return true;`
    );
    if (!ok) throw new Error(`clickByText: no <${tag}> matched ${pattern}`);
  }

  private async fillInput(selector: string, value: string): Promise<void> {
    await this.cdp.eval(
      `var el = document.querySelector(${JSON.stringify(selector)}); ` +
        `if (!el) return false; ` +
        `var setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set; ` +
        `setter.call(el, ${JSON.stringify(value)}); ` +
        `el.dispatchEvent(new Event('input', { bubbles: true })); ` +
        `el.dispatchEvent(new Event('change', { bubbles: true })); ` +
        `return true;`
    );
  }

  private async fillInputAny(selectors: string[], value: string): Promise<void> {
    for (const sel of selectors) {
      const ok = await this.cdp
        .eval<boolean>(`return !!document.querySelector(${JSON.stringify(sel)});`)
        .catch(() => false);
      if (ok) {
        await this.fillInput(sel, value);
        return;
      }
    }
    throw new Error(`fillInputAny: none of the selectors matched: ${selectors.join(', ')}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

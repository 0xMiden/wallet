import type { TimelineRecorder } from '../../harness/timeline-recorder';
import type { WalletPage } from '../../helpers/wallet-page';

import type { CdpSession } from './cdp-bridge';
import type { SimulatorControl } from './simulator-control';

const DEFAULT_PASSWORD = 'Password123!';
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
export class IosWalletPage implements WalletPage {
  readonly udid: string;
  readonly bundleId: string;
  private cdp: CdpSession;
  private sim: SimulatorControl;

  constructor(opts: IosWalletPageOpts) {
    this.cdp = opts.cdp;
    this.sim = opts.sim;
    this.udid = opts.udid;
    this.bundleId = opts.bundleId;
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
   * Bypass the seed-phrase flow via the wallet's official test hook, then
   * tap "Get started" on the confirmation screen and wait for the store to
   * reach Ready. Mirrors the Chrome `createNewWallet` contract.
   */
  async createNewWallet(
    password: string = DEFAULT_PASSWORD
  ): Promise<{ address: string; seedPhrase: string[] }> {
    // Welcome screen must be visible (fixture guarantees this on cold launch).
    await this.pollForSelector('[data-testid="onboarding-welcome"]', 30_000);

    // Trigger Welcome.tsx's official test bypass via URL params. After the
    // navigation, the welcome screen auto-jumps to the confirmation step
    // (random seed already generated, password set from the query param);
    // tapping "Get started" then runs registerWallet().
    const passwordEnc = encodeURIComponent(password);
    await this.cdp.eval(
      `var u = new URL(location.href); ` +
        `u.searchParams.set('__test_skip_onboarding', '1'); ` +
        `u.searchParams.set('password', '${passwordEnc}'); ` +
        `location.href = u.toString(); ` +
        `return null;`
    );
    // Page is reloading — give the WebView time to settle before next eval.
    await sleep(2_500);

    // Wait for the "Get started" / confirmation button to be tappable.
    await this.pollForCondition(
      `var btns = Array.from(document.querySelectorAll('button')); ` +
        `return btns.some(function(b) { return /get started/i.test(b.textContent || ''); });`,
      120_000
    );

    // Click "Get started"
    await this.cdp.eval(
      `var btns = Array.from(document.querySelectorAll('button')); ` +
        `var target = btns.find(function(b) { return /get started/i.test(b.textContent || ''); }); ` +
        `if (target) target.click(); return target ? true : false;`
    );

    // Wait for store status === Ready (numeric 2 in the Zustand enum).
    await this.pollForCondition(
      `var s = window.__TEST_STORE__; ` +
        `if (!s) return false; ` +
        `var st = s.getState(); ` +
        `return st && (st.status === 2 || st.status === 'Ready') && !!st.currentAccount;`,
      120_000
    );

    const address = await this.cdp.eval<string>(
      `var s = window.__TEST_STORE__.getState(); ` +
        `return (s.currentAccount && s.currentAccount.publicKey) || '';`
    );
    if (!address) throw new Error('IosWalletPage.createNewWallet: no currentAccount.publicKey after Ready');

    // The bypass synthesizes the seed phrase internally — we don't read it
    // back. Specs that need a real seed should use importWallet().
    return { address, seedPhrase: [] };
  }

  /**
   * UI-driven import: same React components as Chrome, so the selectors are
   * structurally identical. We rely on data-testid where the components
   * expose it and fall back to placeholder/text matching otherwise.
   */
  async importWallet(
    seedPhrase: string[],
    password: string = DEFAULT_PASSWORD
  ): Promise<{ address: string }> {
    await this.navigateHome();
    await this.pollForSelector('[data-testid="onboarding-welcome"]', 30_000);

    await this.clickByText('button', /i already have a wallet/i);
    await this.pollForSelector('[data-testid="import-select-type"]', 15_000);
    await this.clickByText('*', /import with seed phrase/i);

    for (let i = 0; i < seedPhrase.length; i++) {
      await this.fillInput(`#seed-phrase-input-${i}`, seedPhrase[i] ?? '');
    }
    await this.clickByText('button', /continue/i);

    await this.pollForCondition(
      `return location.hash.indexOf('create-password') >= 0;`,
      15_000
    );
    await this.fillInputByPlaceholder('Enter password', password);
    await this.fillInputByPlaceholder('Enter password again', password);
    await this.clickByText('button', /continue/i);

    // Import-recovery-method step: pick "Import public account" so we don't
    // need a guardian backend.
    await this.pollForSelector('[data-testid="import-recovery-method"]', 15_000);
    await this.clickByText('*', /import public account/i);
    await this.clickByText('button', /continue/i);

    await this.pollForCondition(
      `var bd = document.body; return bd && /your wallet is ready/i.test(bd.textContent || '');`,
      120_000
    );
    await this.clickByText('button', /get started/i);

    await this.pollForCondition(
      `var bd = document.body; return bd && /\\bSend\\b/.test(bd.textContent || '');`,
      30_000
    );

    const address = await this.getAccountAddress();
    return { address };
  }

  async getAccountAddress(): Promise<string> {
    await this.navigateTo('/receive');
    await this.pollForSelector('[data-testid="receive-page"]', 15_000);

    const address = await this.cdp.eval<string>(
      `var c = document.querySelector('[data-testid="receive-page"]'); ` +
        `if (!c) return ''; ` +
        `var m = (c.textContent || '').match(/mtst\\S+/); ` +
        `return m ? m[0] : '';`
    );
    if (!address) throw new Error('IosWalletPage.getAccountAddress: no mtst-prefixed address found');
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

  async claimAllNotes(timeoutMs: number = 120_000): Promise<void> {
    // Chrome's claimAllNotes reloads the page to get a fresh Dexie handle
    // — that's safe on Chrome because the SW holds the vault unlock in a
    // separate context. On mobile there's no SW; a reload would drop the
    // in-memory decryption key and kick the UI back to the password
    // screen, where no Claim button exists. Stay in-session instead.
    await this.navigateTo('/receive');
    await sleep(3_000);

    await this.triggerNavbarAction(60_000);

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await this.triggerSync();
      await sleep(5_000);
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
        await this.navigateHome();
        return;
      }
    }
    await this.navigateHome();
  }

  // ── Send Flow ─────────────────────────────────────────────────────────────

  async sendTokens(params: {
    recipientAddress: string;
    amount: string;
    isPrivate: boolean;
    /** Optional token symbol — accepted for interface compatibility; iOS still uses first row. */
    tokenSymbol?: string;
  }): Promise<void> {
    await this.navigateTo('/send');
    await this.pollForSelector('[data-testid="send-flow"]', 15_000);

    // Click first token (CardItem with cursor-pointer inside send-flow)
    await this.cdp.eval(
      `var f = document.querySelector('[data-testid="send-flow"]'); ` +
        `if (!f) return false; ` +
        `var item = f.querySelector('div.cursor-pointer'); ` +
        `if (!item) return false; item.click(); return true;`
    );
    await sleep(800);

    await this.fillInputAny(
      [
        '[data-testid="send-flow"] input[placeholder*="wallet address"]',
        '[data-testid="send-flow"] input[placeholder*="address"]',
        '[data-testid="send-flow"] textarea',
      ],
      params.recipientAddress
    );

    await this.fillInputAny(
      [
        '[data-testid="send-flow"] input[type="text"]',
        '[data-testid="send-flow"] input[type="number"]',
        '[data-testid="send-flow"] input[inputmode="decimal"]',
      ],
      params.amount
    );

    if (!params.isPrivate) {
      await this.cdp
        .eval(
          `var f = document.querySelector('[data-testid="send-flow"]'); ` +
            `if (!f) return false; ` +
            `var els = Array.from(f.querySelectorAll('*')).filter(function(el) { return (el.textContent || '').trim() === 'Off'; }); ` +
            `if (els.length === 0) return false; els[0].click(); return true;`
        )
        .catch(() => false);
    }

    // Send flow's Continue (SendDetails) and Confirm (ReviewTransaction)
    // are native navbar actions on mobile, not DOM buttons. Trigger via
    // the same hook we use for Claim All. Poll because the action only
    // registers after the page mounts and inputs validate.
    await this.triggerNavbarAction(15_000);
    await sleep(500);
    await this.triggerNavbarAction(15_000);
    await sleep(2_000);

    await this.pollForCondition(
      `var bd = document.body; return bd && /transaction.*initiated|transaction.*success|successfully/i.test(bd.textContent || '');`,
      120_000
    ).catch(async () => {
      const body = await this.locatorText('body');
      if (body && /error|failed/i.test(body)) {
        throw new Error(`Send transaction appears to have failed. Page text: ${body.slice(0, 500)}`);
      }
    });
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
          data: { balance: lastBalance, minBalance, attempt, maxAttempts },
        });
      }

      if (lastBalance > minBalance) return lastBalance;
      if (attempt < maxAttempts) await sleep(intervalMs);
    }

    throw new Error(
      `Balance did not exceed ${minBalance} within ${timeoutMs}ms. Last balance: ${lastBalance}`
    );
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

  async unlockWallet(password: string = DEFAULT_PASSWORD): Promise<void> {
    await this.navigateHome();
    await this.pollForSelector('input[type="password"], input', 15_000);
    await this.fillInputAny(['input[type="password"]', 'input'], password);
    await this.clickByText('button', /unlock|continue|submit/i);
    await sleep(3_000);
  }

  /**
   * Fire the currently-registered native navbar action on mobile. The
   * wallet's native iOS overlay (MidenNavbarOverlayWindow) lives in a
   * separate UIWindow outside the WebView that CDP sees, so a coordinate
   * tap via simctl isn't an option. Instead, we call
   * __TEST_TRIGGER_NAVBAR_ACTION__ (installed in E2E builds by
   * lib/dapp-browser/use-native-navbar-action.ts) which invokes the same
   * onTap the native button would dispatch. Poll until an action is
   * registered (pages mount their action in useEffect — there's a small
   * window where nothing is registered).
   */
  private async triggerNavbarAction(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const fired = await this.cdp
        .eval<boolean>(
          `if (typeof window.__TEST_TRIGGER_NAVBAR_ACTION__ !== 'function') return false; ` +
            `return window.__TEST_TRIGGER_NAVBAR_ACTION__() === true;`
        )
        .catch(() => false);
      if (fired) return;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(
      `triggerNavbarAction: no action registered within ${timeoutMs}ms — ` +
        `is the wallet on the right page and is MIDEN_E2E_TEST=true baked into the build?`
    );
  }

  // ── Internals (DOM helpers wired through CDP) ───────────────────────────

  private async pollForSelector(selector: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // Catch eval errors (page reload mid-poll, inspector reattach race).
      const found = await this.cdp
        .eval<boolean>(`return !!document.querySelector(${JSON.stringify(selector)});`)
        .catch(() => false);
      if (found) return;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`pollForSelector: ${selector} did not appear within ${timeoutMs}ms`);
  }

  private async pollForCondition(jsBody: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await this.cdp.eval<boolean>(jsBody).catch(() => false);
      if (ok) return;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`pollForCondition: condition not met within ${timeoutMs}ms — ${jsBody.slice(0, 80)}`);
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

  private async fillInputByPlaceholder(placeholder: string, value: string): Promise<void> {
    await this.fillInput(`input[placeholder="${placeholder}"]`, value);
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

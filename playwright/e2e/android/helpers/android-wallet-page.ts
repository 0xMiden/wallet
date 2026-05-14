import type { TimelineRecorder } from '../../harness/timeline-recorder';
import type { WalletPage } from '../../helpers/wallet-page';

import type { CdpSession } from './cdp-bridge';
import type { EmulatorControl } from './emulator-control';

const DEFAULT_PASSWORD = 'Password123!';
const SYNC_WAIT_MS = 3_500;
const POLL_INTERVAL_MS = 500;

interface AndroidWalletPageOpts {
  cdp: CdpSession;
  emulator: EmulatorControl;
  serial: string;
  packageName: string;
}

/**
 * Android implementation of the WalletPage interface. Same shape as
 * `IosWalletPage` — they both run CDP-style JS evaluations against the
 * wallet's WebView and produce identical UI driving semantics. Platform
 * differences are confined to:
 *   - screenshot capture (adb screencap vs xcrun simctl io screenshot)
 *   - eval transport (vanilla CDP vs WebKit Inspector)
 * Both are abstracted away inside CdpSession.
 *
 * If/when the iOS code stabilizes further, this could be merged into a
 * single MobileWalletPage that takes a generic Cdp + screenshot adapter.
 * Keeping them as siblings for now keeps the diffs concise vs the iOS
 * source.
 */
export interface PollStats {
  pollCount: number;
  pollIterations: number;
  pollMs: number;
  pollSleepMs: number;
}

export class AndroidWalletPage implements WalletPage {
  readonly serial: string;
  readonly packageName: string;
  private cdp: CdpSession;
  private emulator: EmulatorControl;
  private pollStats: PollStats = { pollCount: 0, pollIterations: 0, pollMs: 0, pollSleepMs: 0 };

  constructor(opts: AndroidWalletPageOpts) {
    this.cdp = opts.cdp;
    this.emulator = opts.emulator;
    this.serial = opts.serial;
    this.packageName = opts.packageName;
  }

  getStats(): { polls: PollStats; cdp: ReturnType<CdpSession['getStats']> } {
    return { polls: { ...this.pollStats }, cdp: this.cdp.getStats() };
  }

  // ── Capability surfaces (matches Playwright Page shape) ─────────────────

  async screenshot(opts: { path: string }): Promise<void> {
    await this.emulator.screenshot(this.serial, opts.path);
  }

  async evaluate<T = unknown>(fn: () => T | Promise<T>): Promise<T> {
    return this.cdp.evaluate(fn);
  }

  // ── Android-only helpers (mirror the iOS-only set on IosWalletPage) ─────

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
    if (!ok) throw new Error(`AndroidWalletPage.click: no element matched ${selector}`);
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

  async createNewWallet(password: string = DEFAULT_PASSWORD): Promise<{ address: string; seedPhrase: string[] }> {
    await this.pollForSelector('[data-testid="onboarding-welcome"]', 30_000);

    const passwordEnc = encodeURIComponent(password);
    await this.cdp.eval(
      `var u = new URL(location.href); ` +
        `u.searchParams.set('__test_skip_onboarding', '1'); ` +
        `u.searchParams.set('password', '${passwordEnc}'); ` +
        `location.href = u.toString(); ` +
        `return null;`
    );
    await sleep(2_500);

    await this.pollForCondition(
      `var btns = Array.from(document.querySelectorAll('button')); ` +
        `return btns.some(function(b) { return /get started/i.test(b.textContent || ''); });`,
      120_000
    );

    await this.cdp.eval(
      `var btns = Array.from(document.querySelectorAll('button')); ` +
        `var target = btns.find(function(b) { return /get started/i.test(b.textContent || ''); }); ` +
        `if (target) target.click(); return target ? true : false;`
    );

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
    if (!address) throw new Error('AndroidWalletPage.createNewWallet: no currentAccount.publicKey after Ready');

    return { address, seedPhrase: [] };
  }

  async importWallet(seedPhrase: string[], password: string = DEFAULT_PASSWORD): Promise<{ address: string }> {
    await this.navigateHome();
    await this.pollForSelector('[data-testid="onboarding-welcome"]', 30_000);

    await this.clickByText('button', /i already have a wallet/i);
    await this.pollForSelector('[data-testid="import-select-type"]', 15_000);
    await this.clickByText('*', /import with seed phrase/i);

    for (let i = 0; i < seedPhrase.length; i++) {
      await this.fillInput(`#seed-phrase-input-${i}`, seedPhrase[i] ?? '');
    }
    await this.clickByText('button', /continue/i);

    await this.pollForCondition(`return location.hash.indexOf('create-password') >= 0;`, 15_000);
    await this.fillInputByPlaceholder('Enter password', password);
    await this.fillInputByPlaceholder('Enter password again', password);
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
    if (!address) throw new Error('AndroidWalletPage.getAccountAddress: no mtst-prefixed address found');
    await this.navigateHome();
    return address.trim();
  }

  // ── Balance ───────────────────────────────────────────────────────────────

  async getBalance(_tokenSymbol?: string): Promise<number> {
    await this.navigateHome();
    await sleep(1_000);
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
    // useSyncTrigger fires every 3s on mobile (Android same as iOS). Wait
    // long enough for at least one tick.
    await sleep(SYNC_WAIT_MS);
  }

  // ── Claim ─────────────────────────────────────────────────────────────────

  async claimAllNotes(timeoutMs: number = 120_000): Promise<void> {
    // No location.reload() on mobile — would drop the in-memory vault
    // decryption key (no service worker like Chrome has). Stay in-session.
    await this.navigateTo('/receive');
    await sleep(3_000);

    await this.triggerNavbarAction(60_000);

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

  // ── Send Flow ─────────────────────────────────────────────────────────────

  async sendTokens(params: {
    recipientAddress: string;
    amount: string;
    isPrivate: boolean;
    tokenSymbol?: string;
  }): Promise<void> {
    await this.navigateTo('/send');
    await this.pollForSelector('[data-testid="send-flow"]', 15_000);

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
    await this.cdp.eval(
      `var i = window.__TEST_INTERCOM__; ` +
        `if (i) { try { i.request({ type: 'LOCK_REQUEST' }); } catch (e) {} } ` +
        `return null;`
    );
    await sleep(2_000);
    await this.cdp.eval(`location.reload(); return null;`);
    await sleep(3_000);
  }

  async unlockWallet(password: string = DEFAULT_PASSWORD): Promise<void> {
    await this.navigateHome();
    await this.pollForSelector('input[type="password"], input', 15_000);
    await this.fillInputAny(['input[type="password"]', 'input'], password);
    await this.clickByText('button', /unlock|continue|submit/i);
    await sleep(3_000);
  }

  async setDelegateProofEnabled(enabled: boolean): Promise<void> {
    await this.cdp.eval(
      `localStorage.setItem('delegate_proof_setting_key', ${JSON.stringify(JSON.stringify(enabled))});`
    );
  }

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

  // ── Internals ─────────────────────────────────────────────────────────────

  private async pollForSelector(selector: string, timeoutMs: number): Promise<void> {
    const wallStart = Date.now();
    let iterations = 0;
    let totalSleepMs = 0;
    try {
      while (Date.now() - wallStart < timeoutMs) {
        iterations++;
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

/**
 * Platform-agnostic driver for the dApp browser.
 *
 * The iOS and Android suites exercise the SAME product surface — the launcher,
 * the capsule, the peek tray, the switcher — through two different transports
 * (simulator + RWI CDP vs emulator + adb CDP). Writing the flow twice would
 * guarantee the two copies drift, and the platform-specific half would be the
 * half nobody re-reads. So the flow lives here once, against a narrow interface
 * that both page objects already satisfy.
 *
 * Everything here drives the product the way a user does: real taps on real
 * elements, resolved by `data-testid`. The one thing it reads out-of-band is
 * `window.__TEST_DAPP_BROWSER__` (a read-only observability hook), because the
 * dApp renders in a native webview that CDP cannot see — the wallet's own view
 * of "which session is foreground, and what rect did I ask for" is not
 * obtainable from the DOM at all.
 */

import { expect } from '@playwright/test';

import { fixtureDapp, GENERATION_COLORS, GENERATION_MARKER_PX, type DappFixtureServer } from './dapp-fixture-server';
import { describeStats, sampleRegion, type Rect } from './dapp-visual';

/** The slice of a mobile page object this driver needs. */
export interface DappDriverTarget {
  evalJs<T = unknown>(js: string): Promise<T>;
  click(selector: string): Promise<void>;
  waitFor(selector: string, opts?: { timeoutMs?: number }): Promise<void>;
  screenshot(opts: { path: string }): Promise<void>;
  navigateTo(hash: string): Promise<void>;
  delay(ms: number): Promise<void>;
}

/** Mirror of the provider's read-only E2E hook. */
export interface DappBrowserState {
  foregroundId: string | null;
  mode: 'active' | 'launcher';
  switcherOpen: boolean;
  slotRect: Rect | null;
  sessions: Array<{
    id: string;
    url: string;
    origin: string;
    status: 'loading' | 'active' | 'parked' | 'closing';
    isLoading: boolean;
    isCold: boolean;
    error: string | null;
  }>;
}

export interface DappDriverOpts {
  target: DappDriverTarget;
  server: DappFixtureServer;
  /** Directory for screenshots this driver captures. */
  artifactDir: string;
  /** Prefix so iOS and Android artefacts don't collide. */
  label: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

export class DappBrowserDriver {
  private readonly target: DappDriverTarget;
  private readonly server: DappFixtureServer;
  private readonly artifactDir: string;
  private readonly label: string;
  private shotSeq = 0;

  constructor(opts: DappDriverOpts) {
    this.target = opts.target;
    this.server = opts.server;
    this.artifactDir = opts.artifactDir;
    this.label = opts.label;
  }

  // ── State ────────────────────────────────────────────────────────────────

  /** The provider's current view of the dApp browser. */
  async state(): Promise<DappBrowserState> {
    const raw = await this.target.evalJs<DappBrowserState | null>(
      `return window.__TEST_DAPP_BROWSER__ ? JSON.parse(JSON.stringify(window.__TEST_DAPP_BROWSER__)) : null;`
    );
    if (!raw) {
      throw new Error(
        '[dapp-driver] window.__TEST_DAPP_BROWSER__ is missing. The build under test must set ' +
          'MIDEN_E2E_TEST=true, and the wallet must be past onboarding so DappBrowserProvider is mounted.'
      );
    }
    return raw;
  }

  /** The wallet webview's CSS viewport — the basis for screenshot scaling. */
  async cssViewport(): Promise<{ width: number; height: number }> {
    return this.target.evalJs<{ width: number; height: number }>(
      `return { width: window.innerWidth, height: window.innerHeight };`
    );
  }

  /**
   * Poll until `predicate` holds, then return the value that satisfied it.
   * Failure names what was actually observed — a bare timeout tells you
   * nothing about which of the ten things in flight went wrong.
   */
  private async pollUntil<T>(
    description: string,
    read: () => Promise<T>,
    predicate: (value: T) => boolean,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: T | undefined;
    let lastError: unknown;
    for (;;) {
      try {
        last = await read();
        if (predicate(last)) return last;
        lastError = undefined;
      } catch (e) {
        lastError = e;
      }
      if (Date.now() >= deadline) {
        const seen = lastError ? `last error: ${String(lastError)}` : `last value: ${JSON.stringify(last)}`;
        throw new Error(`[dapp-driver] timed out after ${timeoutMs}ms waiting for ${description}. ${seen}`);
      }
      await this.target.delay(POLL_INTERVAL_MS);
    }
  }

  async waitForState(
    description: string,
    predicate: (s: DappBrowserState) => boolean,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<DappBrowserState> {
    return this.pollUntil(description, () => this.state(), predicate, timeoutMs);
  }

  /** The session the wallet currently has foregrounded, if any. */
  async foregroundSession(): Promise<DappBrowserState['sessions'][number] | null> {
    const s = await this.state();
    if (!s.foregroundId) return null;
    return s.sessions.find(x => x.id === s.foregroundId) ?? null;
  }

  // ── Navigation / opening ─────────────────────────────────────────────────

  /** Go to the browser tab and wait for the launcher to be interactive. */
  async gotoBrowserTab(): Promise<void> {
    await this.target.navigateTo('/browser');
    await this.target.waitFor('[data-testid="dapp-hero-search"], [data-testid="dapp-capsule"]', {
      timeoutMs: DEFAULT_TIMEOUT_MS
    });
  }

  /**
   * Leave the browser tab for Home.
   *
   * This is a meaningful transition, not just navigation: `DappActive` unmounts,
   * which clears the slot rect, which is what triggers the provider's auto-park
   * of the foreground session. The peek tray is portalled above the whole shell,
   * so the parked dApps must remain represented here.
   */
  async navigateAwayToHome(): Promise<void> {
    await this.target.navigateTo('/');
    await this.pollUntil(
      'the browser surface to unmount after navigating Home',
      async () => this.target.evalJs<number>(`return document.querySelectorAll('[data-testid="dapp-active"]').length;`),
      n => n === 0
    );
  }

  /**
   * Open a dApp by typing its URL into the launcher's search bar and pressing
   * Enter — the real "custom URL" path a user takes for a dApp that isn't in
   * the curated grid.
   */
  async openViaUrlBar(dappId: string): Promise<void> {
    const url = this.server.urlFor(dappId);
    await this.target.waitFor('[data-testid="dapp-hero-search"]', { timeoutMs: DEFAULT_TIMEOUT_MS });
    // React controls the input, so setting `.value` directly is invisible to it;
    // go through the native setter + an input event, the same way the other
    // suites fill controlled fields.
    await this.target.evalJs(
      `var el = document.querySelector('[data-testid="dapp-hero-search"]');` +
        `if (!el) return false;` +
        `var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;` +
        `setter.call(el, ${JSON.stringify(url)});` +
        `el.dispatchEvent(new Event('input', { bubbles: true }));` +
        `return true;`
    );
    // The go/return key is what submits — SearchInput only listens for Enter.
    await this.target.evalJs(
      `var el = document.querySelector('[data-testid="dapp-hero-search"]');` +
        `if (!el) return false;` +
        `el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));` +
        `return true;`
    );
    await this.waitForForeground(dappId);
  }

  /** Open a dApp by tapping its tile (curated grid or recents row). */
  async openViaTile(dappId: string): Promise<void> {
    const url = this.server.urlFor(dappId);
    const selector = `[data-testid="dapp-tile"][data-dapp-url="${url}"]`;
    await this.target.waitFor(selector, { timeoutMs: DEFAULT_TIMEOUT_MS });
    await this.target.click(selector);
    await this.waitForForeground(dappId);
  }

  /**
   * How many cards the curated grid is rendering.
   *
   * The curated grid (`AppsGrid`) and the recents row (`RecentsRow`) are
   * DIFFERENT components — only the latter renders `DappTile`. Counting
   * `dapp-tile` here would report 0 on a fresh wallet (no recents yet) and
   * silently look like "the grid is broken".
   */
  async gridCardUrls(): Promise<string[]> {
    return this.target.evalJs<string[]>(
      `return Array.prototype.map.call(document.querySelectorAll('[data-testid="dapp-grid-card"]'), function (el) {` +
        `  return el.getAttribute('data-dapp-url') || '';` +
        `});`
    );
  }

  /** How many recents tiles are rendered. */
  async recentTileCount(): Promise<number> {
    return this.target.evalJs<number>(`return document.querySelectorAll('[data-testid="dapp-tile"]').length;`);
  }

  /**
   * Wait until `dappId` is the foreground session AND has finished loading.
   *
   * Waiting on `status === 'active' && !isLoading` rather than a fixed sleep is
   * what makes this suite honest on a cold CI emulator: the assertion that
   * follows can then attribute a blank screen to the product, not to the test
   * having looked too early.
   */
  async waitForForeground(dappId: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    const url = this.server.urlFor(dappId);
    await this.waitForState(
      `dApp '${dappId}' to be the loaded foreground session with a slot to render into`,
      s => {
        const fg = s.sessions.find(x => x.id === s.foregroundId);
        // `slotRect` is part of the condition, not an afterthought: the provider
        // only calls setRect/setVisible once a slot has been reported, so a
        // session that is 'active' with a null slot is foreground in state and
        // invisible on screen. Restoring from another tab goes through exactly
        // that window — restore() flips the status immediately and only then
        // navigates to /browser so DappActive can mount and measure.
        return !!fg && fg.url === url && fg.status === 'active' && !fg.isLoading && s.slotRect !== null;
      },
      timeoutMs
    );
    // The provider flips `isLoading` on `browserPageLoaded`; the page's own
    // first report is the independent confirmation that it actually executed.
    await this.pollUntil(
      `dApp '${dappId}' to report its first layout`,
      async () => this.server.lastReport(dappId),
      r => !!r,
      timeoutMs
    );
  }

  // ── Capsule actions ──────────────────────────────────────────────────────

  /** Minimize (park) the foreground dApp via the capsule's minimize button. */
  async minimize(): Promise<void> {
    const before = await this.state();
    expect(before.foregroundId, 'minimize() requires a foreground dApp').not.toBeNull();
    await this.target.waitFor('[data-testid="dapp-capsule-minimize"]', { timeoutMs: DEFAULT_TIMEOUT_MS });
    await this.target.click('[data-testid="dapp-capsule-minimize"]');
    await this.waitForState(
      'the foreground dApp to become parked',
      s => s.foregroundId === null && s.sessions.some(x => x.id === before.foregroundId && x.status === 'parked')
    );
  }

  /** Close the foreground dApp via the capsule's close button. */
  async closeForeground(): Promise<void> {
    const before = await this.state();
    expect(before.foregroundId, 'closeForeground() requires a foreground dApp').not.toBeNull();
    await this.target.click('[data-testid="dapp-capsule-close"]');
    await this.waitForState(
      'the closed session to leave the session list',
      s => !s.sessions.some(x => x.id === before.foregroundId)
    );
  }

  // ── Peek tray (minimized tiles) ──────────────────────────────────────────

  /** The minimized cards currently rendered, with their on-screen rects. */
  async peekCards(): Promise<Array<{ id: string; url: string; rect: Rect }>> {
    return this.target.evalJs(
      `return Array.prototype.map.call(document.querySelectorAll('[data-testid="dapp-peek-card"]'), function (el) {` +
        `  var r = el.getBoundingClientRect();` +
        `  return {` +
        `    id: el.getAttribute('data-dapp-id'),` +
        `    url: el.getAttribute('data-dapp-url'),` +
        `    rect: { x: r.left, y: r.top, width: r.width, height: r.height }` +
        `  };` +
        `});`
    );
  }

  /** Restore (maximize) a parked dApp by tapping its peek card. */
  async restoreViaPeekCard(dappId: string): Promise<void> {
    const url = this.server.urlFor(dappId);
    const selector = `[data-testid="dapp-peek-card"][data-dapp-url="${url}"]`;
    await this.target.waitFor(selector, { timeoutMs: DEFAULT_TIMEOUT_MS });
    await this.target.click(selector);
    await this.waitForForeground(dappId);
  }

  // ── Switcher ─────────────────────────────────────────────────────────────

  async openSwitcher(): Promise<void> {
    await this.target.click('[data-testid="dapp-capsule-switcher"]');
    await this.waitForState('the switcher to open', s => s.switcherOpen);
  }

  async switcherCardUrls(): Promise<string[]> {
    return this.target.evalJs<string[]>(
      `return Array.prototype.map.call(document.querySelectorAll('[data-testid="dapp-switcher-card"]'), function (el) {` +
        `  return el.getAttribute('data-dapp-url');` +
        `});`
    );
  }

  // ── Visual + layout assertions ───────────────────────────────────────────

  /** Capture a screenshot into the artifact dir and return its path. */
  async capture(name: string): Promise<string> {
    this.shotSeq += 1;
    const seq = String(this.shotSeq).padStart(2, '0');
    const path = `${this.artifactDir}/dapp-${this.label}-${seq}-${name.replace(/[^a-zA-Z0-9_-]+/g, '-')}.png`;
    await this.target.screenshot({ path });
    return path;
  }

  /**
   * Assert the dApp slot is actually showing `dappId`'s page.
   *
   * Checks two independent things, because they fail differently:
   *  - the region is dominated by that dApp's colour  → right session, painted
   *  - the region is not a blank rectangle            → something rendered at all
   *
   * A stale/absent webview reads as blank; a wrong foreground reads as the
   * other dApp's colour; wallet chrome drawn over the slot drops the match
   * fraction. All three are failures a DOM assertion cannot see.
   */
  async expectDappPainted(dappId: string, label: string): Promise<void> {
    const dapp = fixtureDapp(dappId);
    const state = await this.state();
    expect(state.slotRect, `[${label}] the wallet should have a slot rect while a dApp is foreground`).not.toBeNull();
    const slot = state.slotRect!;
    const viewport = await this.cssViewport();
    const shot = await this.capture(label);
    const stats = await sampleRegion(shot, slot, viewport, dapp.rgb);

    expect(
      stats.blankFraction,
      `[${label}] the dApp slot is a blank rectangle — nothing painted. ${describeStats(stats)} (${shot})`
    ).toBeLessThan(0.5);
    expect(
      stats.matchFraction,
      `[${label}] the dApp slot should be showing ${dapp.name} (rgb ${dapp.rgb.join(',')}). ` +
        `${describeStats(stats)} (${shot})`
    ).toBeGreaterThan(0.7);
  }

  /**
   * Assert the dApp's OWN layout matches the rect the wallet gave it.
   *
   * This is the re-render oracle. Resizing a native webview moves the frame;
   * it does not guarantee the web content inside re-lays-out. When it doesn't,
   * the frame is right and the content is stale — a screenshot of a solid
   * colour looks identical either way, but the page's `innerWidth`/
   * `innerHeight` still describe the OLD size. Comparing the page's own
   * numbers against the slot is what makes that failure visible.
   *
   * The tolerance absorbs the legitimate difference between the slot rect and
   * the page viewport: the plugin rounds to integer pixels, and the injected
   * wallet CSS adds bottom padding for the navbar.
   */
  async expectRelayoutMatchesSlot(dappId: string, label: string, tolerancePx = 24): Promise<void> {
    const state = await this.state();
    expect(state.slotRect, `[${label}] expected a slot rect`).not.toBeNull();
    const slot = state.slotRect!;

    const report = await this.pollUntil(
      `[${label}] dApp '${dappId}' to report a layout matching the ${slot.width}x${slot.height} slot`,
      async () => this.server.lastReport(dappId),
      r => !!r && Math.abs(r.width - slot.width) <= tolerancePx && Math.abs(r.height - slot.height) <= tolerancePx,
      15_000
    ).catch(() => this.server.lastReport(dappId));

    expect(report, `[${label}] dApp '${dappId}' never reported its layout`).toBeTruthy();
    expect(
      Math.abs(report!.width - slot.width),
      `[${label}] ${dappId} rendered at width ${report!.width} but the wallet sized its webview to ` +
        `${slot.width}. The native frame was resized without the page re-laying out.`
    ).toBeLessThanOrEqual(tolerancePx);
    expect(
      Math.abs(report!.height - slot.height),
      `[${label}] ${dappId} rendered at height ${report!.height} but the wallet sized its webview to ` +
        `${slot.height}. The native frame was resized without the page re-laying out.`
    ).toBeLessThanOrEqual(tolerancePx);
  }

  /**
   * Assert the pixels on screen are a CURRENT frame of the dApp, not a stale one.
   *
   * The size oracle (`expectRelayoutMatchesSlot`) proves the page re-laid-out;
   * it does not prove the webview PRESENTED that new layout. Those come apart
   * exactly in the "maximize shows the old frame" failure: the page resizes and
   * reports the new size, while the compositor keeps showing what it drew
   * before. Because the fixture pages are a flat colour, that stale frame is
   * pixel-identical to a correct one — which is why the page paints a
   * generation square whose colour advances on every report. The expected
   * colour is derived from the report count the server has actually received,
   * so this compares two independent facts: what the page says it has drawn,
   * and what the screen is showing.
   */
  async expectFreshFrame(dappId: string, label: string): Promise<void> {
    const report = this.server.lastReport(dappId);
    expect(report, `[${label}] ${dappId} has never reported, so no generation is expected yet`).toBeTruthy();
    const expected = GENERATION_COLORS[(report!.seq - 1) % GENERATION_COLORS.length]!;

    const state = await this.state();
    expect(state.slotRect, `[${label}] expected a slot rect`).not.toBeNull();
    const slot = state.slotRect!;
    const viewport = await this.cssViewport();
    const shot = await this.capture(`${label}-generation`);

    const marker = {
      x: slot.x,
      y: slot.y,
      width: GENERATION_MARKER_PX,
      height: GENERATION_MARKER_PX
    };
    const stats = await sampleRegion(shot, marker, viewport, expected, { tolerance: 70, insetPx: 12 });

    expect(
      stats.matchFraction,
      `[${label}] the dApp is showing a STALE frame. ${dappId} has reported ${report!.seq} layout(s), so its ` +
        `generation marker should be rgb(${expected.join(',')}), but the screen shows ${describeStats(stats)}. ` +
        `The webview was resized/re-shown without presenting the re-rendered content (${shot}).`
    ).toBeGreaterThan(0.6);
  }

  /**
   * Assert a region of the screen isn't blank — used for the peek tray, where
   * the "correct" pixels are a snapshot of a dApp rather than a known colour.
   * A tray of empty white cards is the failure this catches.
   */
  async expectRegionNotBlank(rect: Rect, label: string): Promise<void> {
    const viewport = await this.cssViewport();
    const shot = await this.capture(label);
    const stats = await sampleRegion(shot, rect, viewport);
    expect(stats.blankFraction, `[${label}] region is blank. ${describeStats(stats)} (${shot})`).toBeLessThan(0.75);
  }
}

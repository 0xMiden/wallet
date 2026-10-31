import fs from 'fs';
import path from 'path';

import type { CdpSession } from './cdp-bridge';
import type { SimulatorControl } from './simulator-control';
import type { PromptSettlement } from './system-alerts';
import { ACTIVITY_PENDING_PATH } from '../../../../src/app/pages/activity-paths';
import type { TimelineRecorder } from '../../harness/timeline-recorder';
import { buildBalanceTotalScript } from '../../helpers/balance-script';
import { toBaseUnits } from '../../helpers/balance-truth';
import {
  bridgedSendRowOf,
  burnSubmitFailure,
  enText,
  reviewQueryParam,
  USDCX_DESTINATION_CHIPS,
  usdcxPayoutRowsText,
  type BridgedSendRow,
  type NetworkChipState
} from '../../helpers/bridge';
import { claimFromPendingList } from '../../helpers/claim-drain';
import { SEPOLIA_NETWORK } from '../../helpers/contact-network';
import {
  CONFIRMATION_SUBMIT,
  CREATED_WALLET_STATE_JS,
  pollCreatedWalletReady
} from '../../helpers/created-wallet-ready';
import {
  readTransactionRowsInPage,
  TxStatus,
  type TransactionRowSnapshot,
  type TransactionRowsQuery
} from '../../helpers/history';
import {
  CURRENT_ACCOUNT_ROWS_JS,
  NATIVE_ASSET_CACHE_EXPR,
  nativeAssetOf,
  ridingOut,
  stashAndPoll,
  TX_DB,
  TX_STORE,
  type CurrentAccountRows,
  type MobileNativeAsset
} from '../../helpers/mobile-store-reads';
import {
  BRIDGE_DEPOSIT_LAYER,
  BRIDGE_SOURCE_NETWORK_JS,
  OPEN_SHEET,
  scopedJs,
  SEND_FLOW,
  SEND_NETWORK_JS,
  selectSendNetworkByScript,
  USDCX_ROUTE_JS,
  type SendNetworkView,
  type UsdcxRouteView
} from '../../helpers/send-flow-scripts';
import { dismissTelemetryConsent } from '../../helpers/telemetry-consent';
import { ARC_PAYOUT, type PayoutChain } from '../../helpers/usdcx-constants';
import { burnFailureMessage } from '../../helpers/usdcx-guardian';
import type { GuardianAuthInfo, WalletPage, SendTokensParams } from '../../helpers/wallet-page';

const DEFAULT_PASSWORD = '123456';
const SYNC_WAIT_MS = 3_500;
const POLL_INTERVAL_MS = 500;

/**
 * `pollForCondition` body that is true only once the wallet is genuinely
 * unlocked: no Unlock surface mounted (`Unlock.tsx` renders `unlock-passcode`
 * for the mobile numpad and `unlock-password` for the text form) AND the store
 * reports Ready — the same readiness signal `createWalletViaBypass` waits on
 * (`WalletStatus.Ready === 2`; Locked is 1).
 *
 * The Unlock-surface clause is what makes this a real assertion: the store keeps
 * `currentAccount` populated across a lock (it is non-sensitive front state), so
 * a bare "publicKey looks like an address" check is true while the wallet is
 * still sitting on the lock screen.
 */
const UNLOCKED_CONDITION_JS =
  `if (document.querySelector('[data-testid="unlock-passcode"]')) return false; ` +
  `if (document.querySelector('[data-testid="unlock-password"]')) return false; ` +
  `var s = window.__TEST_STORE__; ` +
  `if (!s) return !!document.querySelector('[data-testid="explore-page"]'); ` +
  `var st = s.getState(); ` +
  `return (st.status === 2 || st.status === 'Ready') && !!st.currentAccount;`;

/** The chain's native (fee) asset as the wallet discovered it; the mobile dApp harness reads it the same way. */
export type IosNativeAsset = MobileNativeAsset;

/** A page route without its search: the onboarding bypass keeps `?password=` in `location.href` all session. */
export function routeOf(href: string): string {
  return new URL(href).hash;
}

/** Whether the bridge From row's value names `name` exactly: "Sepolia" is part of "Base Sepolia". */
export function networkRowNames(value: string | null, name: string): boolean {
  return value === name;
}

/** `text` with every `?query` cut out: a serialized URL's query holds no `#`, `"` or whitespace, so the cut ends there. */
function withoutUrlQueries(text: string): string {
  return text.replace(/\?[^\s#"]+/g, '');
}

interface EvalTally {
  returned: number;
  lastError?: unknown;
}

/**
 * A poll none of whose evals returned never checked anything: a CDP session that died at attach failed this way as
 * "did not appear", which sent the diagnosis to the app.
 */
function noEvalReturned(poll: string, target: string, timeoutMs: number, tally: EvalTally): Error {
  const { lastError } = tally;
  const last =
    lastError === undefined
      ? 'none'
      : withoutUrlQueries(lastError instanceof Error ? lastError.message : String(lastError)).slice(0, 500);
  return new Error(`${poll}: could not check ${target}: no CDP eval returned in ${timeoutMs}ms (last error: ${last})`);
}

// The review slides over the retained Send layer, whose route step holds the same payout row and burn notice.
const SEND_REVIEW = '[data-page-layer="/send/review"]';
// Mobile mounts the app as a full page, so the in-progress route is the -full variant.
const GENERATING_ROUTE = /#\/generating-transaction(?:-full)?\/([^/?#]+)/;

// The href drops its search: the onboarding bypass's ?password= stays there all session, and a timed-out poll prints
// its last read.
const REVIEW_LANDING_JS =
  `return { href: location.href.replace(location.search, ''), hash: location.hash, ` +
  `submit: !!document.querySelector(${JSON.stringify(`${SEND_REVIEW} [data-testid="send-review-submit"]`)}) };`;

/** The review's labelled rows: a label span whose next sibling is the value div (DetailRow). */
function usdcxReviewJs(networkLabel: string, networkFeeLabel: string): string {
  return scopedJs(
    SEND_REVIEW,
    `function row(label) { var s = Array.from(root.querySelectorAll('span')).find(function (x) { ` +
      `return (x.textContent || '').trim() === label && x.nextElementSibling && x.nextElementSibling.tagName === 'DIV'; }); ` +
      `return s ? (s.nextElementSibling.textContent || '').trim() : null; } ` +
      `return { network: row(${JSON.stringify(networkLabel)}), networkFee: row(${JSON.stringify(networkFeeLabel)}), ` +
      `fee: val('usdcx-payout-fee'), notice: text('usdcx-burn-notice') };`
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

interface UsdcxReviewView {
  network: string | null;
  networkFee: string | null;
  fee: string | null;
  notice: string | null;
}

function sameChipSet(chips: readonly NetworkChipState[]): boolean {
  return (
    chips
      .map(chip => chip.testId)
      .sort()
      .join(',') === [...USDCX_DESTINATION_CHIPS].sort().join(',')
  );
}

/** The details page's own layer: it slides over the retained tabs. */
function detailsLayer(rowId: string): string {
  return `[data-page-layer="/history-details/${rowId}"]`;
}

export interface UsdcxBurnViaSendOptions {
  /** The address Circle pays on the payout chain. Never a private key: appium-remote-debugger logs every eval body. */
  destAddress: `0x${string}`;
  /** As typed: a whole number, since the amount field follows the simulator's locale for decimals. */
  amount: string;
  nativeTokenId: string;
  nativeSymbol: string;
  /** The chain Circle pays on; Arc Testnet when absent. */
  payout?: PayoutChain;
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
  /** Network sheet rows pressed when the address validated, before the payout chain's pick (R16 evidence). */
  defaultPressed: string[];
}

export interface BurnStageSample {
  status: number;
  stage?: string;
  atMs: number;
}

interface IosWalletPageOpts {
  cdp: CdpSession;
  sim: SimulatorControl;
  udid: string;
  bundleId: string;
  /**
   * Runs before every screenshot. The fixture passes the notification-alert gate here, so no
   * capture path shoots a frame while the SpringBoard permission alert is up.
   */
  beforeCapture?: () => Promise<void>;
  /**
   * Waits until the app has asked for notification permission and the prompt is answered, tapping Allow the way
   * the capture gate does. Resolves how that ended, and why when the prompt was not answered.
   */
  settleNotificationPrompt?: () => Promise<PromptSettlement>;
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
  private beforeCapture?: () => Promise<void>;
  private settlePrompt?: () => Promise<PromptSettlement>;
  private pollStats: PollStats = { pollCount: 0, pollIterations: 0, pollMs: 0, pollSleepMs: 0 };

  constructor(opts: IosWalletPageOpts) {
    this.cdp = opts.cdp;
    this.sim = opts.sim;
    this.udid = opts.udid;
    this.bundleId = opts.bundleId;
    this.beforeCapture = opts.beforeCapture;
    this.settlePrompt = opts.settleNotificationPrompt;
  }

  /** Read poll stats snapshot. Includes CdpSession totals too. */
  getStats(): { polls: PollStats; cdp: ReturnType<CdpSession['getStats']> } {
    return { polls: { ...this.pollStats }, cdp: this.cdp.getStats() };
  }

  // ── Capability surfaces (matches Playwright Page shape) ─────────────────

  async screenshot(opts: { path: string }): Promise<void> {
    await this.beforeCapture?.();
    await this.sim.screenshot(this.udid, opts.path);
  }

  /** Whether the app asked for notification permission and the prompt was answered, and why not when it was not. */
  async settleNotificationPrompt(): Promise<PromptSettlement> {
    return (
      (await this.settlePrompt?.()) ?? {
        answered: false,
        reason: 'no-gate',
        detail: 'no notification alert gate is wired to this wallet page'
      }
    );
  }

  async evaluate<T = unknown>(fn: () => T | Promise<T>): Promise<T> {
    return this.cdp.evaluate(fn);
  }

  /**
   * Evaluate a raw JS body (must `return`) in the wallet webview.
   *
   * `evaluate(fn)` serialises a closure and so cannot capture runtime values;
   * several suites already work around that by interpolating JSON into a raw
   * body via the private `cdp.eval`. The dApp-browser driver is shared between
   * the iOS and Android page objects, so it needs that capability as public
   * surface rather than reaching into a private field.
   */
  async evalJs<T = unknown>(js: string): Promise<T> {
    return this.cdp.eval<T>(js);
  }

  // ── Bridge-IN test hooks (installed page-side on mobile via mobile-adapter) ──
  // The hooks return Promises, and this RWI bridge's async eval is broken, so
  // async hooks use the stash-and-poll pattern (start the promise + stash the
  // result on a global, poll a sync eval for it). Runtime args are interpolated
  // into the raw eval body via JSON (`evaluate(fn)` closures can't capture vars).

  /** Point the AggLayer sender-match at the runtime "solver" account. Sync hook. */
  async setAgglayerSender(senderAccountId: string): Promise<void> {
    await this.cdp.eval(`window.__TEST_SET_AGGLAYER_SENDER__(${JSON.stringify(senderAccountId)}); return null;`);
  }

  /**
   * Convert a CLI faucet hex id to the wallet's bech32 form via the installed
   * `__TEST_HEX_TO_BECH32_FAUCET__` hook — the AggLayer sender-match compares
   * bech32 prefixes, and a minted note's on-chain sender is the faucet. Polls
   * for the hook (it's installed after an async SDK import at wallet init).
   */
  async hexToBech32Faucet(hex: string, timeoutMs = 30_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await this.cdp.eval<string | null>(
        `return (typeof window.__TEST_HEX_TO_BECH32_FAUCET__ === 'function') ` +
          `? window.__TEST_HEX_TO_BECH32_FAUCET__(${JSON.stringify(hex)}) : null;`
      );
      if (res) return res;
      if (Date.now() > deadline) throw new Error('hexToBech32Faucet: hook not ready within timeout');
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  /** Read a `bridged-receive` row's current phase/displayMessage for assertions. */
  async getBridgeReceiveState(txId: string): Promise<{
    found: boolean;
    phase?: string;
    displayMessage?: string;
    amount?: string;
    faucetId?: string;
  }> {
    return this.stashAndPoll('__bi_state', `window.__TEST_BRIDGE_RECEIVE_STATE__(${JSON.stringify(txId)})`);
  }

  /** Create a real WalletConnect pairing; returns the `wc:` URI for the counterparty. */
  async reownConnectUri(): Promise<string> {
    return this.stashAndPoll<string>('__wc_uri', `window.__TEST_REOWN_CONNECT_URI__()`, 60_000);
  }

  /** Read the native EVM (Reown) connection state. */
  async reownState(): Promise<{ connected: boolean; address?: string; chainId?: number }> {
    return this.stashAndPoll('__wc_state', `window.__TEST_REOWN_STATE__()`);
  }

  /**
   * Newest `bridged-receive` row (optionally by provider). The real deposit UI
   * creates the row inside `handleConfirm` and never surfaces its txId to the
   * DOM, so the harness reads it back here after confirming the deposit.
   */
  async latestBridgeReceive(provider?: 'epoch' | 'agglayer' | 'usdcx'): Promise<{
    id: string;
    amount?: string;
    faucetId: string;
    phase?: string;
    displayMessage?: string;
    error?: string;
  } | null> {
    const arg = provider ? JSON.stringify(provider) : '';
    return this.stashAndPoll('__bi_latest', `window.__TEST_LATEST_BRIDGE_RECEIVE__(${arg})`);
  }

  // ── Bridge-IN deposit UI (EVM → Miden) ──────────────────────────────────────
  // Real-UI navigation for the deposit flow. EVM connection is established
  // separately via reownConnectUri() + the headless counterparty (the native
  // WC modal is outside the WebView and un-tappable via CDP).

  /**
   * The deposit form's own layer. /bridge/deposit slides over the Home tabs, which stay mounted (inert) earlier in the
   * DOM, and their Swap pane reuses the form's send-token-selector and send-amount-* test ids: an unscoped lookup
   * finds the hidden Swap controls first. The token drawer portals to <body>, so its rows stay unscoped.
   */
  private static readonly BRIDGE_PAGE = BRIDGE_DEPOSIT_LAYER;

  /** Receive → "Cross Chain" → the deposit amount screen (requires EVM connected). */
  async openBridgeDeposit(): Promise<void> {
    await this.navigateTo('/receive');
    await this.waitFor('[data-testid="receive-page"]', { timeoutMs: 15_000 });
    await this.click('[data-testid="receive-cross-chain"]');
    // Cross Chain navigates to /bridge/deposit. Should the tap not land, navigating there directly reaches the same
    // screen.
    try {
      await this.waitFor(`${IosWalletPage.BRIDGE_PAGE} [data-testid="send-token-selector"]`, { timeoutMs: 8_000 });
      return;
    } catch {
      await this.navigateTo('/bridge/deposit');
      await this.waitFor(`${IosWalletPage.BRIDGE_PAGE} [data-testid="send-token-selector"]`, { timeoutMs: 30_000 });
    }
  }

  /** Open the bridge token drawer and pick a source token: ETH (AggLayer) or Circle's USDC (xReserve). */
  async selectBridgeToken(symbol: 'ETH' | 'CIRCLE_USDC'): Promise<void> {
    await this.click(`${IosWalletPage.BRIDGE_PAGE} [data-testid="send-token-selector"]`);
    await this.waitFor(`[data-testid="bridge-token-${symbol}"]`, { timeoutMs: 10_000 });
    await this.click(`[data-testid="bridge-token-${symbol}"]`);
  }

  /**
   * Open the network drawer from the amount step's From row and pick the source chain `slug` (bridge-networks.ts), then
   * wait until the row names it: a Reown session that approves that chain alone refuses any other chain's prompt.
   */
  async selectBridgeNetwork(slug: string, name: string): Promise<void> {
    await this.click(`${IosWalletPage.BRIDGE_PAGE} [data-testid="bridge-source-network"]`);
    await this.waitFor(`[data-testid="bridge-network-${slug}"]`, { timeoutMs: 10_000 });
    await this.click(`[data-testid="bridge-network-${slug}"]`);
    await this.pollEval<string | null>(
      `the bridge From row naming ${name}`,
      BRIDGE_SOURCE_NETWORK_JS,
      value => networkRowNames(value, name),
      10_000
    );
  }

  /** Type the deposit amount and confirm to advance to the route step. */
  async enterBridgeAmount(amount: string): Promise<void> {
    await this.pollForSelector(`${IosWalletPage.BRIDGE_PAGE} [data-testid="send-amount-input"]`, 15_000);
    await this.fillInput(`${IosWalletPage.BRIDGE_PAGE} [data-testid="send-amount-input"]`, amount);
    await this.clickWhenEnabled(`${IosWalletPage.BRIDGE_PAGE} [data-testid="send-amount-confirm"]`, 15_000);
  }

  /** Pick the AggLayer "Slow" route (ETH only) and continue to review. */
  async selectBridgeRouteSlow(): Promise<void> {
    await this.clickWhenEnabled('[data-testid="bridge-route-slow"]', 15_000);
    await this.clickWhenEnabled('[data-testid="bridge-route-confirm"]', 15_000);
  }

  /**
   * Confirm the Circle USDC route and continue to review. The route step shows one card, already selected, so the step
   * only confirms; Continue waits for the balance read and stays disabled while the amount, with any fee Circle has
   * quoted, exceeds the balance.
   */
  async confirmBridgeRouteUsdcx(timeoutMs = 15_000): Promise<void> {
    await this.waitFor('[data-testid="bridge-route-usdcx"]', { timeoutMs: 15_000 });
    await this.clickWhenEnabled('[data-testid="bridge-route-confirm"]', timeoutMs);
  }

  /** Confirm the deposit on the review step (runs handleConfirm → handleSlowBridge). */
  async confirmBridgeDeposit(): Promise<void> {
    await this.clickWhenEnabled('[data-testid="bridge-deposit-review-confirm"]', 20_000);
  }

  /** Run a Promise-returning hook expression and poll its stashed result. */
  private async stashAndPoll<T>(prefix: string, promiseExpr: string, timeoutMs = 30_000): Promise<T> {
    return stashAndPoll<T>(js => this.cdp.eval(js), prefix, promiseExpr, timeoutMs);
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
        const entries = await this.stashAndPoll<Record<string, string | null>>(
          '__native_asset',
          NATIVE_ASSET_CACHE_EXPR
        );
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

  // ── App switching ───────────────────────────────────────────────────────

  /** Leaves the app the way an app switch does. Its WebView notes going hidden, which `returnToForeground` reports. */
  async leaveForeground(): Promise<void> {
    await this.cdp.eval(
      `window.__E2E_WENT_HIDDEN__ = false; ` +
        `document.addEventListener('visibilitychange', function () { ` +
        `if (document.hidden) window.__E2E_WENT_HIDDEN__ = true; }); return null;`
    );
    await this.sim.background(this.udid);
  }

  /** Returns to the running app and answers whether its document went hidden meanwhile. */
  async returnToForeground(): Promise<boolean> {
    await this.sim.foreground(this.udid, this.bundleId);
    return ridingOut(() => this.cdp.eval<boolean>('return window.__E2E_WENT_HIDDEN__ === true;'));
  }

  // ── USDCx burn through the Send UI (the live USDCx spec) ────────────────

  /**
   * Burns the native USDCx to an address on `opts.payout` (Arc Testnet by default) through the real Send UI and returns
   * once the wallet is on the generating page. Every read is scoped (SEND_FLOW, the network sheet, SEND_REVIEW). Checks
   * on the way: exactly the four USDCx destinations in the network sheet, the closed field naming the payout chain, the
   * route card, the payout fee row and the notice on the route and the review, and the review's network and fee rows; a
   * refusal is named from `review-error`, never left to a timeout. Nothing is submitted once `signal` has aborted (R26).
   */
  async burnUsdcxViaSendFlow(opts: UsdcxBurnViaSendOptions): Promise<UsdcxBurnSubmission> {
    const chain = opts.payout ?? ARC_PAYOUT;
    const symbol = opts.nativeSymbol.trim();
    if (symbol === '' || symbol.toUpperCase() === 'MIDEN') {
      throw new Error(`burnUsdcxViaSendFlow: "${opts.nativeSymbol}" cannot name USDCx, the asset a USDCx burn spends`);
    }
    // Throws before any UI when the amount does not exceed the payout chain's fee allowance (R14a).
    const payout = usdcxPayoutRowsText(chain.chainId, opts.amount);
    const routeFees = enText('usdcxMidenFees', { symbol });
    const sponsorshipFee = enText('usdcxSponsorshipFee', { symbol });
    const notice = enText('usdcxWithdrawalNotice');
    const rowsBefore = new Set((await this.readBridgedSendRows()).map(row => row.id));
    fs.mkdirSync(opts.screenshotDir, { recursive: true });

    await this.navigateTo(`/send?tokenId=${encodeURIComponent(opts.nativeTokenId)}`);
    await this.waitFor(SEND_FLOW, { timeoutMs: 15_000 });
    // The carousel keeps Send mounted with its step and network; only the recipient step has no back button.
    for (let pop = 0; pop < 3 && (await this.exists(`${SEND_FLOW} [data-testid="flow-back"]`)); pop++) {
      await this.click(`${SEND_FLOW} [data-testid="flow-back"]`);
      await sleep(1_000);
    }
    await this.waitFor(`${SEND_FLOW} [data-testid="send-recipient-input"]`, { timeoutMs: 15_000 });
    await this.fillInput(`${SEND_FLOW} [data-testid="send-recipient-input"]`, opts.destAddress);
    const picker = `${SEND_FLOW} [data-testid="send-network-picker"]`;
    await this.waitFor(picker, { timeoutMs: 15_000 });
    await this.click(picker);
    const offered = await this.pollEval<SendNetworkView | null>(
      'the four USDCx destinations in the network sheet',
      SEND_NETWORK_JS,
      view => view !== null && sameChipSet(view.rows),
      15_000
    );
    const defaultPressed = (offered?.rows ?? []).filter(row => row.pressed === 'true').map(row => row.testId);
    // A network kept from an earlier attempt overrides the default, so the payout chain is picked every time.
    await this.click(`${OPEN_SHEET} [data-testid="send-network-${chain.reviewNetwork}"]`);
    await this.pollEval<SendNetworkView | null>(
      `the closed network field naming ${chain.networkName}`,
      SEND_NETWORK_JS,
      view => view !== null && view.rows.length === 0 && view.summary === chain.networkName,
      15_000
    );
    await this.clickWhenEnabled(`${SEND_FLOW} [data-testid="send-recipient-confirm"]`, 30_000);
    await this.waitFor(`${SEND_FLOW} [data-testid="send-amount-input"]`, { timeoutMs: 30_000 });
    // `available` renders only once a token is set: the ?tokenId= preselect landed (every spike run).
    await this.waitFor(`${SEND_FLOW} [data-testid="send-amount-available"]`, { timeoutMs: 10_000 });
    await this.fillInput(`${SEND_FLOW} [data-testid="send-amount-input"]`, opts.amount);
    await this.clickWhenEnabled(`${SEND_FLOW} [data-testid="send-amount-confirm"]`, 45_000);

    await this.pollEval<UsdcxRouteView | null>(
      'the USDCx route card, payout fee row and burn notice',
      USDCX_ROUTE_JS,
      view =>
        view !== null &&
        view.pressed === 'true' &&
        view.cardText.includes(routeFees) &&
        view.fee === payout.fee &&
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
    const wanted: Record<string, string> = {
      network: chain.reviewNetwork,
      route: 'usdcx',
      tokenId: opts.nativeTokenId
    };
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
        view.network === chain.networkName &&
        view.networkFee === sponsorshipFee &&
        view.fee === payout.fee &&
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
      throw new Error(burnSubmitFailure(chain, outcome.error ?? '', fresh.length));
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

  /** The open details page's status pill and every transaction link it renders to `explorer`, Arc Testnet's by default. */
  async transactionDetailsView(
    rowId: string,
    explorer: string = ARC_PAYOUT.explorer
  ): Promise<{ pill: string | null; txLinks: string[] }> {
    const prefix = `${explorer}/tx/`;
    const view = await ridingOut(() =>
      this.cdp.eval<{ pill: string | null; txLinks: string[] } | null>(
        `var root = document.querySelector(${JSON.stringify(detailsLayer(rowId))}); if (!root) return null; ` +
          `var pill = root.querySelector('[data-testid="history-status-pill"]'); ` +
          `return { pill: pill ? (pill.textContent || '').trim() : null, ` +
          `txLinks: Array.from(root.querySelectorAll('a[href]')).map(function (a) { return a.getAttribute('href') || ''; })` +
          `.filter(function (h) { return h.indexOf(${JSON.stringify(prefix)}) === 0; }) };`
      )
    );
    return view ?? { pill: null, txLinks: [] };
  }

  /**
   * Re-runs a script body until `done` accepts its value; a failed eval (an inspector reattach) counts as not yet, and
   * the timeout names the last one.
   */
  private async pollEval<T>(label: string, js: string, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: { value: T } | undefined;
    let lastError: string | undefined;
    for (;;) {
      let read: { value: T } | undefined;
      try {
        read = { value: await this.cdp.eval<T>(js) };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (read !== undefined) {
        if (done(read.value)) return read.value;
        last = read;
      }
      if (Date.now() >= deadline) {
        const seen = last === undefined ? 'none' : (JSON.stringify(last.value) ?? 'undefined').slice(0, 1_500);
        // An eval error can quote location.href, whose search holds the onboarding ?password= all session.
        const failed =
          lastError === undefined ? '' : `; last failed eval ${withoutUrlQueries(lastError).slice(0, 500)}`;
        throw new Error(`${label}: not met within ${timeoutMs} ms; last read ${seen}${failed}`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  private async exists(selector: string): Promise<boolean> {
    return this.cdp.eval<boolean>(`return !!document.querySelector(${JSON.stringify(selector)});`);
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
    await this.click(CONFIRMATION_SUBMIT);

    // Wait for store status === Ready (numeric 2 in the Zustand enum).
    await this.waitForCreatedWalletReady(`IosWalletPage.createWalletViaBypass(${recovery})`, readyTimeoutMs);

    // Onboarding's last screen is now the one-time telemetry consent prompt, not
    // the wallet home — decline it so the caller gets a wallet it can navigate.
    // After the Ready poll deliberately (Ready is what proves `register()`
    // finished), and raced against the home surface so the gap between Ready
    // being published and `Welcome.tsx` navigating is waited out rather than
    // assumed away. Mirrors the Android POM.
    await dismissTelemetryConsent(this, {
      nextSurface: '[data-testid="explore-page"]',
      timeoutMs: 60_000
    });

    const address = await this.cdp.eval<string>(
      `var s = window.__TEST_STORE__.getState(); return (s.currentAccount && s.currentAccount.publicKey) || '';`
    );
    if (!address) {
      throw new Error(`IosWalletPage.createWalletViaBypass(${recovery}): no currentAccount.publicKey after Ready`);
    }

    // For created wallets the bypass synthesizes the seed phrase internally
    // (we don't read it back); for imported wallets the caller already has it.
    return { address, seedPhrase: seed ?? [] };
  }

  /** Waits for a created wallet to read Ready, pressing Confirmation's Retry once (see `pollCreatedWalletReady`). */
  private async waitForCreatedWalletReady(label: string, timeoutMs: number): Promise<void> {
    await pollCreatedWalletReady({
      label,
      timeoutMs,
      poll: (ms, accept) => this.pollForCondition(CREATED_WALLET_STATE_JS, ms, accept),
      pressRetry: () => this.click(CONFIRMATION_SUBMIT)
    });
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
  async getBalance(tokenSymbol?: string): Promise<number> {
    await this.navigateHome();
    await sleep(1_000);
    // Reads consumed balances from the Zustand store. useSyncTrigger updates the store every 3s
    // on mobile.
    //
    // IMPORTANT: unlike Chrome's getBalance (which reads
    // chrome.storage.local.miden_sync_data.notes to count pending-but-unconsumed notes too), this
    // returns 0 until notes are actually consumed. Mobile has no chrome.storage equivalent. Both
    // platforms auto-consume ONLY notes from the well-known MIDEN faucet; E2E tests use a CUSTOM
    // faucet, so iOS specs need claimAllNotes() before waiting on a positive balance.
    //
    // `tokenSymbol` is honoured, and on a fee-charging chain it MATTERS: the wallet now also holds
    // the native asset it was funded with, so an unfiltered total goes positive as soon as THAT
    // lands. A spec that waits on it and then acts on the test token opened its send before the
    // test token existed, and failed on a missing `send-token-<SYM>` row.
    return this.cdp.eval<number>(buildBalanceTotalScript(tokenSymbol));
  }

  async triggerSync(): Promise<void> {
    // On mobile, the wallet auto-syncs every 3s in main thread via
    // useSyncTrigger as soon as status === Ready (no SW indirection like
    // Chrome). We don't need to send SYNC_REQUEST — we just need to wait
    // long enough for at least one auto-sync tick to land.
    await sleep(SYNC_WAIT_MS);
  }

  // ── Claim ─────────────────────────────────────────────────────────────────

  /**
   * Tap Accept All and wait until the Pending list drains: two consecutive reads with no card, no
   * Accept All and no loading bar. Throws with the last read if it never does within `timeoutMs`.
   */
  async claimAllNotes(timeoutMs: number = 120_000, knownFaucetIds: string[] = []): Promise<void> {
    // Chrome's claimAllNotes reloads the page to get a fresh Dexie handle
    // — that's safe on Chrome because the SW holds the vault unlock in a
    // separate context. On mobile there's no SW; a reload would drop the
    // in-memory decryption key and kick the UI back to the password
    // screen, where no Claim button exists. Stay in-session instead.
    // Incoming transfers live on the Activity tab's Pending filter (`AllHistory` reads the
    // filter off the location). The old /pending-notes page (which mounted the claim UI
    // directly).
    await this.navigateTo(ACTIVITY_PENDING_PATH);
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
    // was too tight on testnet under CI load, so the first click may take 120s.
    await claimFromPendingList(this, { label: 'IosWalletPage.claimAllNotes', firstClickMs: 120_000, timeoutMs });
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
      >(`var conv = window.__TEST_HEX_TO_BECH32_FAUCET__; var bech32 = ${hexJson}.map(hex => conv(hex)); var injected = {}; for (var i = 0; i < bech32.length; i++) injected[bech32[i]] = { name: 'Test Token', symbol: 'TST', decimals: 8, thumbnailUri: '' }; var s = window.__TEST_STORE__; if (!s) return { error: 'no __TEST_STORE__' }; var st = s.getState(); var before = Object.keys(st.assetsMetadata || {}); if (typeof st.setAssetsMetadata === 'function') { st.setAssetsMetadata(injected); } else { s.setState({ assetsMetadata: Object.assign({}, st.assetsMetadata || {}, injected) }); } var after = Object.keys(s.getState().assetsMetadata || {}); return { before: before, injected: bech32, after: after };`)
      .catch((e: Error) => ({ error: e.message }));
    // eslint-disable-next-line no-console
    console.log(`[injectTestMetadataForFaucets] hex=${hexJson} -> ${JSON.stringify(result)}`);
  }

  // ── Send Flow ─────────────────────────────────────────────────────────────

  /**
   * Save an E2E spending limit through the same store transport the settings UI uses.
   *
   * One account-scoped USD cap, not a per-asset native-unit one: `tokenSymbol` only picks which
   * balance row to read the faucet id off, for callers that go on to spend that asset.
   */
  async configureSpendingLimitForTest(params: {
    tokenSymbol: string;
    dailyLimitUsdMicro?: string;
  }): Promise<{ accountId: string; faucetId: string; decimals: number }> {
    const input = JSON.stringify(params);
    return this.stashAndPoll(
      '__sl_config',
      `(async function () { ` +
        `var input = ${input}; var store = window.__TEST_STORE__; ` +
        `if (!store) throw new Error('configureSpendingLimitForTest requires an E2E build'); ` +
        `var state = store.getState(); var accountId = state.currentAccount && state.currentAccount.publicKey; ` +
        `if (!accountId) throw new Error('configureSpendingLimitForTest found no current account'); ` +
        `var balance = (state.balances[accountId] || []).find(function (row) { ` +
        `  return row.metadata.symbol === input.tokenSymbol; ` +
        `}); ` +
        `if (!balance) throw new Error('configureSpendingLimitForTest found no ' + input.tokenSymbol + ' balance row'); ` +
        `var existing = await state.readSpendingLimit(accountId); ` +
        `var draft = { accountId: accountId }; ` +
        `if (input.dailyLimitUsdMicro !== undefined) draft.limit = BigInt(input.dailyLimitUsdMicro); ` +
        `await state.saveSpendingLimit(draft, existing && existing.revision, true); ` +
        `return { accountId: accountId, faucetId: balance.tokenId, decimals: balance.metadata.decimals }; ` +
        `})()`
    );
  }

  /** Drive the real send flow through ReviewTransaction without submitting it. */
  async prepareSendReview(params: SendTokensParams): Promise<void> {
    // v0-UI order: recipient → amount(+token) → review.
    const sendFlow = '[data-testid="send-flow"]';
    await this.navigateTo('/send');
    await this.pollForSelector(sendFlow, 15_000);

    // 1. SelectRecipient: fill the recipient address (textarea) and confirm.
    // Confirm is gated on a valid address, so wait for it to enable.
    await this.fillInput(`${sendFlow} [data-testid="send-recipient-input"]`, params.recipientAddress);
    if (params.recipientAddress.trim().startsWith('0x')) {
      await selectSendNetworkByScript(this, SEPOLIA_NETWORK, 15_000, POLL_INTERVAL_MS);
    }
    await this.clickWhenEnabled(`${sendFlow} [data-testid="send-recipient-confirm"]`, 30_000);

    // 2. SelectAmount: open the token sub-screen, pick a token, then fill the
    // amount. The amount Confirm stays disabled until a token is picked.
    await this.pollForSelector(`${sendFlow} [data-testid="send-token-selector"]`, 15_000);
    await this.click(`${sendFlow} [data-testid="send-token-selector"]`);

    // Pick the token row. Prefer the requested symbol; otherwise take the first
    // token row that isn't the selector control, the search box, or MIDEN
    // (which typically sits at 0 balance above the real fundable token).
    const tokenSymbol = params.tokenSymbol;
    if (tokenSymbol) {
      // Wait for the FUNDED token row specifically — balance sync can lag, and
      // if only the 0-balance USDCX row has rendered, the fallback would grab it
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
        `var skip = ['send-token-selector', 'send-token-search', 'send-token-USDCX']; ` +
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
    await this.pollForSelector(`${sendFlow} [data-testid="send-amount-input"]`, 30_000);
    await this.fillInput(`${sendFlow} [data-testid="send-amount-input"]`, params.amount);
    // Confirm is disabled until a token is picked AND the amount validates
    // (both involve balance reads behind the WASM lock); clicking it while still
    // disabled is a silent no-op, so wait for the enabled state.
    await this.clickWhenEnabled(`${sendFlow} [data-testid="send-amount-confirm"]`, 45_000);

    // 3. Force the note type. The public/private toggle was removed (private by
    // default); the E2E hook persists the choice across the remaining steps.
    await this.pollForCondition(`return typeof window.__TEST_SET_SHARE_PRIVATELY__ === 'function';`, 15_000);
    await this.cdp.eval(`window.__TEST_SET_SHARE_PRIVATELY__(${params.isPrivate ? 'true' : 'false'}); return null;`);

    // 4. ReviewTransaction: submit. The Review screen recomputes the fee/summary
    // on entry (a balance read behind the WASM lock), which can lag well past 15s
    // when a sync tick holds the lock — so poll generously.
    await this.pollForSelector('[data-testid="send-review-submit"]', 45_000);
  }

  /** Execute the full v0-UI send flow and wait until submission is accepted. */
  async sendTokens(params: SendTokensParams): Promise<void> {
    await this.prepareSendReview(params);
    await this.click('[data-testid="send-review-submit"]');

    // 5. Treat the submit button detaching as the "submit accepted" signal — the
    // send flow navigates away once the request is dispatched. If it never
    // detaches the send was never dispatched, so fail here rather than letting
    // the spec blame the recipient's balance minutes later: the old code only
    // rethrew when the page happened to render error copy, and returned
    // normally (as if sent) on every other timeout.
    const submitAccepted = await this.pollForCondition(
      `return !document.querySelector('[data-testid="send-review-submit"]');`,
      120_000
    )
      .then(() => true)
      .catch(() => false);
    if (!submitAccepted) {
      const body = (await this.locatorText('body').catch(() => null)) ?? '';
      const rendersError =
        /error|failed/i.test(body) && !/generating|processing|initiated|submitting|pending/i.test(body);
      throw new Error(
        rendersError
          ? `IosWalletPage.sendTokens: the wallet rendered an error surface after submit. ` +
              `On-screen text (first 800): ${body.slice(0, 800)}`
          : `IosWalletPage.sendTokens: the review screen's submit button was still attached 120s after ` +
              `clicking it, so the send was never dispatched. On-screen text (first 800): ${body.slice(0, 800)}`
      );
    }
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
    const deadline = Date.now() + timeoutMs;
    let lastBalance = 0;
    let attempt = 0;

    while (true) {
      if (deadline - Date.now() <= 0) {
        throw new Error(`Balance did not exceed ${minBalance} within ${timeoutMs}ms. Last balance: ${lastBalance}`);
      }

      attempt += 1;
      await this.triggerSync();
      lastBalance = await this.getBalance(tokenSymbol);

      if (timeline) {
        timeline.emit({
          category: 'blockchain_state',
          severity: lastBalance > minBalance ? 'info' : 'warn',
          message: `Balance check: ${lastBalance} (need > ${minBalance}) attempt ${attempt}`,
          data: { balance: lastBalance, minBalance, attempt }
        });
      }

      if (lastBalance > minBalance) return lastBalance;

      const remainingAfter = deadline - Date.now();
      if (remainingAfter <= 0) {
        throw new Error(`Balance did not exceed ${minBalance} within ${timeoutMs}ms. Last balance: ${lastBalance}`);
      }
      await sleep(Math.min(intervalMs, remainingAfter));
    }
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
   *
   * Post-condition (both branches): `UNLOCKED_CONDITION_JS`. The fallback branch
   * used to be two tolerant `.catch(() => {})`s and a fixed 3s sleep, so a run
   * where neither the numpad nor the text form was ever found returned "unlocked"
   * with the wallet still on the lock screen — and the spec failed later, on a
   * missing home surface or an empty balance, pointing anywhere but here.
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
      // Entering the final digit auto-submits; wait for the unlocked state.
      await this.assertUnlocked('numpad', 30_000);
      return;
    }

    // Fallback: legacy text-input unlock (or biometric already unlocked us, in
    // which case there's nothing to do and the fill/click no-op safely). The
    // tolerant catches stay — they cannot distinguish "already unlocked" from
    // "no unlock form found", which is exactly why the assertion below is the
    // thing that decides whether this method succeeded.
    await this.fillInputAny(['input[type="password"]', 'input'], password).catch(() => {});
    await this.clickByText('button', /unlock|continue|submit/i).catch(() => {});
    await this.assertUnlocked('text-input fallback', 30_000);
  }

  /** Poll `UNLOCKED_CONDITION_JS`, reporting what is on screen if it never holds. */
  private async assertUnlocked(via: string, timeoutMs: number): Promise<void> {
    try {
      await this.pollForCondition(UNLOCKED_CONDITION_JS, timeoutMs);
    } catch {
      const body = (await this.locatorText('body').catch(() => null)) ?? '';
      throw new Error(
        `IosWalletPage.unlockWallet: wallet never reached the unlocked state via the ${via} path ` +
          `within ${timeoutMs}ms. On-screen text (first 500): ${body.slice(0, 500)}`
      );
    }
  }

  async setDelegateProofEnabled(enabled: boolean): Promise<void> {
    await this.cdp.eval(
      `localStorage.setItem('delegate_proof_setting_key', ${JSON.stringify(JSON.stringify(enabled))});`
    );
  }

  /**
   * Read a Guardian account's on-chain auth structure (overall threshold,
   * signer commitments, per-procedure thresholds, active guardian-operator
   * commitment).
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
             procedureThresholds: v.procedureThresholds,
             guardianCommitment: v.guardianCommitment
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
    const tally: EvalTally = { returned: 0 };
    try {
      while (Date.now() - wallStart < timeoutMs) {
        iterations++;
        // Catch eval errors (page reload mid-poll, inspector reattach race).
        const found = await this.tallied<boolean>(
          `return !!document.querySelector(${JSON.stringify(selector)});`,
          tally
        );
        if (found?.value) return;
        await sleep(POLL_INTERVAL_MS);
        totalSleepMs += POLL_INTERVAL_MS;
      }
      if (tally.returned === 0) throw noEvalReturned('pollForSelector', selector, timeoutMs, tally);
      throw new Error(`pollForSelector: ${selector} did not appear within ${timeoutMs}ms`);
    } finally {
      this.pollStats.pollCount++;
      this.pollStats.pollIterations += iterations;
      this.pollStats.pollMs += Date.now() - wallStart;
      this.pollStats.pollSleepMs += totalSleepMs;
    }
  }

  private async pollForCondition<T = boolean>(
    jsBody: string,
    timeoutMs: number,
    accept: (value: T) => boolean | Promise<boolean> = Boolean
  ): Promise<void> {
    const wallStart = Date.now();
    let iterations = 0;
    let totalSleepMs = 0;
    const tally: EvalTally = { returned: 0 };
    try {
      while (Date.now() - wallStart < timeoutMs) {
        iterations++;
        const read = await this.tallied<T>(jsBody, tally);
        if (read && (await accept(read.value))) return;
        await sleep(POLL_INTERVAL_MS);
        totalSleepMs += POLL_INTERVAL_MS;
      }
      if (tally.returned === 0) throw noEvalReturned('pollForCondition', jsBody.slice(0, 80), timeoutMs, tally);
      throw new Error(`pollForCondition: condition not met within ${timeoutMs}ms — ${jsBody.slice(0, 80)}`);
    } finally {
      this.pollStats.pollCount++;
      this.pollStats.pollIterations += iterations;
      this.pollStats.pollMs += Date.now() - wallStart;
      this.pollStats.pollSleepMs += totalSleepMs;
    }
  }

  /** One poll read: a failed eval counts as not yet, and the tally keeps what a timeout must say about the session. */
  private async tallied<T>(js: string, tally: EvalTally): Promise<{ value: T } | undefined> {
    try {
      const value = await this.cdp.eval<T>(js);
      tally.returned++;
      return { value };
    } catch (error) {
      tally.lastError = error;
      return undefined;
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

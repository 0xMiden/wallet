import { toBaseUnits } from './balance-truth';
import { buildPendingSampleScript, type PendingSample } from './claim-drain';
import {
  CellDeadlineExceeded,
  deadlineIn,
  HarnessFault,
  withFailureEvidence,
  type BalanceReadDiagnostics,
  type Deadline,
  type PendingNoteSnapshot
} from './dapp-cells';
import {
  describeTransactionRow,
  readTransactionRowsInPage,
  TxStatus,
  type TransactionRowSnapshot,
  type TransactionRowsQuery
} from './history';
import {
  beforeMobileDeadline,
  CURRENT_ACCOUNT_ROWS_JS,
  NATIVE_ASSET_CACHE_EXPR,
  nativeAssetOf,
  ridingOut,
  stashAndPoll,
  TX_DB,
  TX_STORE,
  type CurrentAccountRows,
  type MobileNativeAsset
} from './mobile-store-reads';
import type { GuardianAuthInfo, GuardianOperatorView } from './wallet-page';
import { ACTIVITY_PENDING_PATH } from '../../../src/app/pages/activity-paths';
import type { DappDriverTarget } from '../harness/dapp-browser-driver';

/**
 * The wallet side of a mobile dApp journey: the E2E store hook (`__TEST_STORE__`, MIDEN_E2E_TEST builds) for accounts,
 * sessions and balances, IndexedDB for transaction rows, and the dApp browser's read-only hook for the page in front.
 * Both page objects satisfy `MobileWallet`; the extension's `chrome.storage` reads have no mobile counterpart.
 */
export interface MobileWallet extends DappDriverTarget {
  createNewWallet(password?: string): Promise<{ address: string; seedPhrase: string[] }>;
  createGuardianWallet(password?: string): Promise<{ address: string; seedPhrase: string[] }>;
  /** iOS takes the CLI faucet's id to give its notes metadata the wallet cannot read (ios-wallet-page.ts claimAllNotes). */
  claimAllNotes(timeoutMs?: number, knownFaucetIds?: string[]): Promise<void>;
  getGuardianAuthInfo(accountPublicKey: string): Promise<GuardianAuthInfo>;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const STORE = `var s = window.__TEST_STORE__; if (!s) throw new Error('the E2E store hook is missing'); var st = s.getState();`;
export const evalOf =
  (wallet: Pick<DappDriverTarget, 'evalJs'>, deadline?: Deadline) =>
  <T = unknown>(js: string): Promise<T> =>
    beforeMobileDeadline(deadline, 'the mobile wallet read', () =>
      wallet.evalJs<T>(js).catch((error: unknown) => {
        // These originate in the evaluate transport; timeouts can also mean the wallet's main thread is blocked.
        const message = error instanceof Error ? error.message : '';
        if (
          /^(?:Remote debugger is not connected|RPC socket is not connected\.|The RPC client is not connected\.|Remote debugger error with code '[^']+':|CDP Runtime\.evaluate:|WebSocket is not open: readyState \d+ \((?:CONNECTING|CLOSING|CLOSED)\)|WebSocket was closed before the connection was established)/.test(
            message
          )
        ) {
          const fault = new HarnessFault(`the mobile wallet evaluate transport failed: ${message}`);
          fault.cause = error;
          throw fault;
        }
        throw error;
      })
    );

export function currentAccount(wallet: MobileWallet, deadline?: Deadline): Promise<string | null> {
  return evalOf(
    wallet,
    deadline
  )<string | null>(
    'var s = window.__TEST_STORE__; var a = s && s.getState().currentAccount; return a ? a.publicKey : null;'
  );
}

export function currentGuardianEndpoint(wallet: MobileWallet): Promise<string> {
  return evalOf(wallet)<string>(
    "var s = window.__TEST_STORE__; var a = s && s.getState().currentAccount; return (a && a.guardianEndpoint) || '';"
  );
}

export async function selectAccount(wallet: MobileWallet, address: string, deadline: Deadline): Promise<void> {
  const startedAt = Date.now();
  let selected: string | null = null;
  const select = (): Promise<string> =>
    beforeMobileDeadline(deadline, 'account selection update', () =>
      stashAndPoll<string>(
        evalOf(wallet, deadline),
        '__dapp_select',
        `(async function () { ${STORE} await st.updateCurrentAccount(${JSON.stringify(address)}); ` +
          `var a = s.getState().currentAccount; return a ? a.publicKey : ''; })()`,
        deadline.remainingMs()
      )
    );
  try {
    selected = await select();
    while (selected !== address) {
      await beforeMobileDeadline(deadline, 'account selection convergence', () => sleep(250));
      selected = await currentAccount(wallet, deadline);
      if (selected !== address) selected = await select();
    }
  } catch (error) {
    if (!(error instanceof CellDeadlineExceeded)) throw error;
    const failure = new CellDeadlineExceeded(
      `selectAccount selected ${selected || 'no account'} instead of ${address} after ${Date.now() - startedAt} ms: ${error.message}`
    );
    failure.cause = error;
    throw failure;
  }
}

export async function selectAccountIfNeeded(wallet: MobileWallet, address: string, deadline: Deadline): Promise<void> {
  if ((await currentAccount(wallet, deadline)) !== address) await selectAccount(wallet, address, deadline);
}

/**
 * A new public key is that account. `'pending'` with no new key waits; `'synced'` with no new key is missing.
 * The page callbacks duplicate this: they cannot call a Node function.
 */
export function accountAddressAfterCreate(
  before: readonly (string | undefined)[],
  accounts: readonly { publicKey?: string }[],
  outcome: 'synced' | 'pending'
): { address: string } | 'wait' | 'missing' {
  const known = new Set(before);
  const created = accounts.find(account => account.publicKey !== undefined && !known.has(account.publicKey));
  if (created?.publicKey) return { address: created.publicKey };
  if (outcome === 'pending') return 'wait';
  return 'missing';
}

/** A new account through the store's own createAccount, as the Chrome page object makes one; a Guardian one registers first. */
export function createAccount(wallet: MobileWallet, walletType: 'off-chain' | 'guardian'): Promise<string> {
  return stashAndPoll<string>(
    evalOf(wallet),
    '__dapp_create',
    `(async function () { ${STORE} var before = st.accounts.map(function (a) { return a.publicKey; }); ` +
      `var outcome = await st.createAccount(${JSON.stringify(walletType)}); ` +
      `var findMade = function () { return s.getState().accounts.find(function (a) { ` +
      `return a.publicKey && before.indexOf(a.publicKey) < 0; }); }; ` +
      `var made = findMade(); if (made && made.publicKey) return made.publicKey; ` +
      `if (outcome === 'pending') { for (var i = 0; i < 120; i++) { ` +
      `await new Promise(function (resolve) { setTimeout(resolve, 250); }); ` +
      `made = findMade(); if (made && made.publicKey) return made.publicKey; } ` +
      `throw new Error('account list has not landed'); } ` +
      `throw new Error('createAccount added no account'); })()`,
    240_000
  );
}

/** The wallet-side revoke the Connected-sites screen performs, for the current account. */
export async function removeDappSession(wallet: MobileWallet, origin: string): Promise<void> {
  await stashAndPoll<null>(
    evalOf(wallet),
    '__dapp_revoke',
    `(async function () { ${STORE} await st.removeDAppSession(${JSON.stringify(origin)}); return null; })()`
  );
}

const BALANCE_LANDING_MS = 60_000;

/**
 * The current account's balance rows once a store read of them landed (`fetchBalances` reads IndexedDB and never
 * syncs). The store skips a read while one is in flight, the lock is busy or the balance fuse is lit, so this asks
 * again each second until `balancesLastFetched` moves.
 */
export async function accountRows(wallet: MobileWallet, deadline?: Deadline): Promise<CurrentAccountRows> {
  const result = await stashAndPoll<{ account: string } | { error: string; diagnostics: BalanceReadDiagnostics }>(
    evalOf(wallet, deadline),
    '__dapp_balances',
    `(async function () { ${STORE}
      var pk = st.currentAccount && st.currentAccount.publicKey;
      if (!pk) throw new Error('the store has no current account');
      var readState = function () {
        try {
          var hook = window.__TEST_BALANCE_READ_STATE__;
          if (typeof hook !== 'function') return 'diagnostics unavailable';
          var read = JSON.parse(JSON.stringify(hook(pk)));
          if (!read || typeof read.inFlight !== 'boolean' || typeof read.fused !== 'boolean' ||
              typeof read.network !== 'string' ||
              (read.fuseUntilMs !== null && typeof read.fuseUntilMs !== 'number') ||
              (read.lock !== null && (!read.lock || typeof read.lock.label !== 'string' ||
                typeof read.lock.pauseCount !== 'number' || typeof read.lock.normalCeilingMs !== 'number')))
            return 'diagnostics unavailable';
          return read;
        } catch (_) { return 'diagnostics unavailable'; }
      };
      var stamp = function () { return (s.getState().balancesLastFetched || {})[pk] || 0; };
      var state = function () {
        var now = s.getState();
        return { account: (now.currentAccount && now.currentAccount.publicKey) || null,
          stamp: stamp(), cached: (now.balances || {})[pk] !== undefined,
          read: readState() };
      };
      var checkAccount = function () {
        var current = state().account;
        if (current !== pk) throw new Error('current account changed from ' + pk + ' to ' +
          (current || 'none') + ' during balance read');
      };
      var before = stamp(); var initial = state(); var attempts = [];
      var until = Date.now() + ${BALANCE_LANDING_MS}; var stopped = false; var timer;
      var timeoutMessage = 'no balance read of ' + pk + ' landed within ${BALANCE_LANDING_MS} ms';
      var timeout = new Promise(function (_, reject) {
        timer = setTimeout(function () { reject(new Error(timeoutMessage)); }, ${BALANCE_LANDING_MS});
      });
      var work = (async function () {
        for (;;) {
          if (stopped) return pk;
          checkAccount();
          if (Date.now() >= until) throw new Error(timeoutMessage);
          var attempt = { number: attempts.length + 1, startedAt: Date.now(), outcome: 'pending', before: state() };
          attempts.push(attempt);
          try {
            var now = s.getState(); await now.fetchBalances(pk, now.assetsMetadata);
            attempt.after = state();
            attempt.outcome = stamp() > before ? 'landed' :
              attempt.before.read === 'diagnostics unavailable' ? 'diagnostics unavailable' :
              attempt.before.read.inFlight ? 'in-flight' : attempt.before.read.fused ? 'fused' :
              attempt.before.read.lock !== null && attempt.before.cached ? 'lock-busy' : 'returned-without-stamp';
          } catch (error) {
            attempt.outcome = 'rejected'; attempt.error = String((error && error.message) || error);
            attempt.after = state(); throw error;
          } finally { attempt.durationMs = Date.now() - attempt.startedAt; }
          if (stopped) return pk;
          checkAccount();
          if (Date.now() >= until) throw new Error(timeoutMessage);
          if (stamp() > before) return pk;
          await new Promise(function (resolve) { setTimeout(resolve, Math.min(1000, until - Date.now())); });
        }
      })();
      try { return { account: await Promise.race([work, timeout]) }; }
      catch (error) {
        var counts = Object.create(null);
        attempts.forEach(function (attempt) {
          if (attempt.outcome === 'pending') attempt.durationMs = Date.now() - attempt.startedAt;
          counts[attempt.outcome] = (counts[attempt.outcome] || 0) + 1;
        });
        var dominant = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0] || 'none';
        return {
          error: String((error && error.message) || error).slice(0, 1000) +
            '; balance read account=' + pk.slice(0, 128) + ', initialStamp=' + before +
            ', finalStamp=' + stamp() + ', attempts=' + attempts.length + ', dominant=' + dominant,
          diagnostics: { observedAccount: pk, initialStamp: before, finalStamp: stamp(),
            initial: initial, final: state(),
            attempts: attempts.map(function (attempt) { return Object.assign({}, attempt); }) }
        };
      } finally { stopped = true; clearTimeout(timer); }
    })()`,
    // Past the page's own deadline, so its error names the account rather than the poll timing out.
    BALANCE_LANDING_MS + 5_000
  );
  if ('error' in result) {
    throw withFailureEvidence(new Error('stashAndPoll(__dapp_balances): ' + result.error), {
      balanceRead: result.diagnostics
    });
  }
  const account = result.account;
  const view = await evalOf(wallet, deadline)<CurrentAccountRows | null>(CURRENT_ACCOUNT_ROWS_JS);
  if (view === null || view.account !== account) {
    throw new Error(`current account changed from ${account} to ${view?.account ?? 'none'} after balance read`);
  }
  return view;
}

/** A row's base units. `toFixed`, not `String`: a balance under 1e-6 prints in exponent form, which toBaseUnits refuses. */
export function rowUnits(row: CurrentAccountRows['rows'][number]): bigint {
  if (!Number.isInteger(row.decimals) || row.decimals < 0) throw new Error(`row ${row.tokenId} has no decimals`);
  return toBaseUnits(row.balance.toFixed(row.decimals), row.decimals);
}

/** Base units of each of `faucetIds` in the current account, 0 for one it holds none of. */
export async function vaultOf(
  wallet: MobileWallet,
  faucetIds: readonly string[],
  deadline?: Deadline
): Promise<Record<string, bigint>> {
  const { rows } = await accountRows(wallet, deadline);
  return Object.fromEntries(
    faucetIds.map(id => [id, rows.filter(row => row.tokenId === id).reduce((sum, row) => sum + rowUnits(row), 0n)])
  );
}

/** Every nonzero asset of the current account in base units, the shape `assetMap` gives a dApp's view. */
export async function vaultAssets(wallet: MobileWallet): Promise<Record<string, string>> {
  const { rows } = await accountRows(wallet);
  const sums = new Map<string, bigint>();
  for (const row of rows) sums.set(row.tokenId, (sums.get(row.tokenId) ?? 0n) + rowUnits(row));
  return Object.fromEntries([...sums].filter(([, units]) => units !== 0n).map(([id, units]) => [id, units.toString()]));
}

/** The chain's native (fee) asset as the wallet discovered it; both reads land shortly after Ready, so it re-reads. */
export async function nativeAsset(wallet: MobileWallet, timeoutMs: number): Promise<MobileNativeAsset> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const entries = await stashAndPoll<Record<string, string | null>>(
        evalOf(wallet),
        '__dapp_native',
        NATIVE_ASSET_CACHE_EXPR
      );
      return nativeAssetOf(entries, await accountRows(wallet));
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await sleep(2_000);
  }
}

/** Every transaction row, read from IndexedDB with history.ts's own projection, as the iOS page object reads them. */
export async function readRows(wallet: MobileWallet, deadline?: Deadline): Promise<TransactionRowSnapshot[]> {
  const query: TransactionRowsQuery = { dbName: TX_DB, storeName: TX_STORE };
  const rows = await ridingOut(() =>
    stashAndPoll<TransactionRowSnapshot[] | null>(
      evalOf(wallet, deadline),
      '__dapp_rows',
      `(${readTransactionRowsInPage.toString()})(${JSON.stringify(query)})`,
      60_000
    )
  );
  if (rows === null) throw new HarnessFault('the mobile transaction store is missing');
  return rows;
}

// Rows still in flight: an Unconfirmed one waits for the node's verdict and can still land (#1081).
const IN_FLIGHT = new Set<number>([TxStatus.Queued, TxStatus.GeneratingTransaction, TxStatus.Unconfirmed]);
const DRAIN_STABLE_READS = 3;
const DRAIN_POLL_MS = 1_000;

/**
 * Waits until three reads a second apart find no row in flight, as the extension's `waitForQueueDrained` does
 * (wallet-page.ts), so a write that outlived its cell never runs into the next cell's baseline.
 */
export async function waitForQueueDrained(
  read: () => Promise<readonly TransactionRowSnapshot[]>,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  let inFlight: TransactionRowSnapshot[] = [];
  let failure: string | null = null;
  let onlyTransportFailures = true;
  let lastTransportFault: HarnessFault | undefined;
  for (;;) {
    try {
      inFlight = (await read()).filter(row => row.status !== undefined && IN_FLIGHT.has(row.status));
      onlyTransportFailures = false;
      stable = inFlight.length === 0 ? stable + 1 : 0;
    } catch (error) {
      // A failed read proves nothing about the queue, so the clean reads start again.
      if (error instanceof HarnessFault) lastTransportFault = error;
      else onlyTransportFailures = false;
      failure = error instanceof Error ? error.message : String(error);
      stable = 0;
    }
    if (stable >= DRAIN_STABLE_READS) return;
    if (Date.now() >= deadline) {
      if (onlyTransportFailures && lastTransportFault !== undefined) throw lastTransportFault;
      const left = inFlight.map(describeTransactionRow).join('; ') || 'nothing, but not three reads in a row';
      const failed = failure === null ? '' : `; the last failed read: ${failure}`;
      throw new Error(`the queue did not drain within ${timeoutMs} ms: ${left}${failed}`);
    }
    await sleep(DRAIN_POLL_MS);
  }
}

/** What a Guardian operator holds for `account`, through the wallet's E2E hook signed with the device's hot key. */
export function guardianOperatorView(
  wallet: MobileWallet,
  account: string,
  endpoint: string
): Promise<GuardianOperatorView> {
  return stashAndPoll<GuardianOperatorView>(
    evalOf(wallet),
    '__dapp_operator',
    `window.__TEST_GUARDIAN_OPERATOR_VIEW__(${JSON.stringify(account)}, ${JSON.stringify(endpoint)})`,
    60_000
  );
}

/** Joins the visible Pending cards by id to the claimable-notes cache that their hook publishes. */
export async function pendingNotes(
  wallet: MobileWallet,
  account: string,
  rpcUrl: string,
  network: string,
  timeoutMs: number,
  deadline?: Deadline
): Promise<PendingNoteSnapshot[]> {
  const bound = deadlineIn(Math.min(timeoutMs, deadline?.remainingMs() ?? timeoutMs), 'pending note provenance');
  await beforeMobileDeadline(bound, 'open Pending', () => wallet.navigateTo(ACTIVITY_PENDING_PATH));
  const key = `claimable_notes:v1:${rpcUrl}|${network}:${account}`;
  let last: { sample: PendingSample; notes: PendingNoteSnapshot[] | null } | null = null;
  for (;;) {
    const next = await beforeMobileDeadline(bound, 'read pending note provenance', () =>
      stashAndPoll<{ sample: PendingSample; notes: PendingNoteSnapshot[] | null }>(
        evalOf(wallet, bound),
        '__dapp_pending',
        `(async function () {
          ${STORE}
          var checkAccount = function () {
            var a = s.getState().currentAccount;
            if (!a || a.publicKey !== ${JSON.stringify(account)}) throw new Error('Pending account changed');
          };
          checkAccount();
          var sample = (function () { ${buildPendingSampleScript()} })();
          var ids = Array.from(document.querySelectorAll('[data-testid="pending-activity-row"]'),
            function (row) { return row.getAttribute('data-entry-key'); });
          if (!sample.onPending || sample.loading) return { sample: sample, notes: null };
          if (ids.length === 0) return { sample: sample, notes: [] };
          var P = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences;
          if (!P) throw new Error('no Capacitor Preferences plugin');
          var stored = (await P.get({ key: ${JSON.stringify(key)} })).value;
          checkAccount();
          var cache = stored === null ? [] : JSON.parse(stored);
          if (!Array.isArray(cache)) throw new Error('the claimable-notes cache is not an array');
          var notes = ids.map(function (id) {
            var note = cache.find(function (n) { return n && n.id === id; });
            if (!note || typeof id !== 'string' || !id || typeof note.senderAddress !== 'string' ||
                typeof note.faucetId !== 'string' || !note.faucetId ||
                typeof note.amount !== 'string' || !/^\\d+$/.test(note.amount)) return null;
            return { noteId: id, sender: note.senderAddress, faucet: note.faucetId, amount: note.amount };
          });
          if (notes.some(function (note) { return note === null; })) return { sample: sample, notes: null };
          notes.sort(function (a, b) { return a.noteId.localeCompare(b.noteId); });
          return { sample: sample, notes: notes };
        })()`,
        bound.remainingMs()
      )
    );
    if (next.notes !== null && last !== null && JSON.stringify(next) === JSON.stringify(last)) return next.notes;
    last = next.notes === null ? null : next;
    await beforeMobileDeadline(bound, 'one pending note sync', () => sleep(3_000));
  }
}

export interface BrowserSession {
  id: string;
  url: string;
  origin: string;
  isLoading: boolean;
}
export interface BrowserMotion {
  id: string;
  target: 'collapsed' | 'expanded';
  started: boolean;
  acknowledging: boolean;
  progress: number;
  tracking: boolean;
}
export interface BrowserState {
  foregroundId: string | null;
  sessions: BrowserSession[];
  /** The native morph in flight (#1817); null at rest, absent from a build without it. */
  motion?: BrowserMotion | null;
}

/** DappBrowserProvider's read-only hook; the JSON round trip drops its function members. */
export function browserState(wallet: MobileWallet): Promise<BrowserState | null> {
  return evalOf(wallet)<BrowserState | null>(
    'return window.__TEST_DAPP_BROWSER__ ? JSON.parse(JSON.stringify(window.__TEST_DAPP_BROWSER__)) : null;'
  );
}

export async function foregroundOrigin(wallet: MobileWallet): Promise<string | null> {
  const state = await browserState(wallet);
  const session = state?.sessions.find(entry => entry.id === state.foregroundId);
  return session === undefined ? null : new URL(session.url).origin;
}

/** Types `url` into Explore's search and presses Enter (dapp-browser-driver.ts's custom-URL path), until it is in front. */
export async function openDappUrl(wallet: MobileWallet, url: string): Promise<void> {
  const origin = new URL(url).origin;
  await wallet.navigateTo('/browser');
  const searchOpen = await evalOf(wallet)<boolean>(
    'return !!document.querySelector(\'[data-testid="dapp-hero-search"]\');'
  );
  if (!searchOpen) {
    await wallet.waitFor('[data-testid="explore-search-toggle"]', { timeoutMs: 30_000 });
    await wallet.click('[data-testid="explore-search-toggle"]');
  }
  await wallet.waitFor('[data-testid="dapp-hero-search"]', { timeoutMs: 30_000 });
  await evalOf(wallet)(
    `var el = document.querySelector('[data-testid="dapp-hero-search"]'); if (!el) return false; ` +
      `var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; ` +
      `setter.call(el, ${JSON.stringify(url)}); el.dispatchEvent(new Event('input', { bubbles: true })); ` +
      `el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); ` +
      `return true;`
  );
  const deadline = Date.now() + 30_000;
  while ((await foregroundOrigin(wallet)) !== origin) {
    if (Date.now() > deadline) throw new Error(`the dApp browser never brought ${origin} to the front`);
    await sleep(250);
  }
}

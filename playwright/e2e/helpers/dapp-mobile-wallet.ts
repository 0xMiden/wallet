import { toBaseUnits } from './balance-truth';
import { buildPendingSampleScript, type PendingSample } from './claim-drain';
import {
  describeTransactionRow,
  readTransactionRowsInPage,
  TxStatus,
  type TransactionRowSnapshot,
  type TransactionRowsQuery
} from './history';
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
const evalOf =
  (wallet: Pick<DappDriverTarget, 'evalJs'>) =>
  (js: string): Promise<unknown> =>
    wallet.evalJs(js);

export function currentAccount(wallet: MobileWallet): Promise<string | null> {
  return wallet.evalJs<string | null>(
    'var s = window.__TEST_STORE__; var a = s && s.getState().currentAccount; return a ? a.publicKey : null;'
  );
}

export function currentGuardianEndpoint(wallet: MobileWallet): Promise<string> {
  return wallet.evalJs<string>(
    "var s = window.__TEST_STORE__; var a = s && s.getState().currentAccount; return (a && a.guardianEndpoint) || '';"
  );
}

export async function selectAccount(wallet: MobileWallet, address: string): Promise<void> {
  const selected = await stashAndPoll<string>(
    evalOf(wallet),
    '__dapp_select',
    `(async function () { ${STORE} await st.updateCurrentAccount(${JSON.stringify(address)}); ` +
      `var a = s.getState().currentAccount; return a ? a.publicKey : ''; })()`
  );
  if (selected !== address) throw new Error(`selectAccount selected ${selected || 'no account'} instead of ${address}`);
}

export async function selectAccountIfNeeded(wallet: MobileWallet, address: string): Promise<void> {
  if ((await currentAccount(wallet)) !== address) await selectAccount(wallet, address);
}

/** A new account through the store's own createAccount, as the Chrome page object makes one; a Guardian one registers first. */
export function createAccount(wallet: MobileWallet, walletType: 'off-chain' | 'guardian'): Promise<string> {
  return stashAndPoll<string>(
    evalOf(wallet),
    '__dapp_create',
    `(async function () { ${STORE} var before = st.accounts.map(function (a) { return a.publicKey; }); ` +
      `await st.createAccount(${JSON.stringify(walletType)}); ` +
      `var made = s.getState().accounts.find(function (a) { return a.publicKey && before.indexOf(a.publicKey) < 0; }); ` +
      `if (!made) throw new Error('createAccount added no account'); return made.publicKey; })()`,
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
export async function accountRows(wallet: MobileWallet): Promise<CurrentAccountRows> {
  await stashAndPoll<boolean>(
    evalOf(wallet),
    '__dapp_balances',
    `(async function () { ${STORE} var pk = st.currentAccount && st.currentAccount.publicKey; ` +
      `if (!pk) throw new Error('the store has no current account'); ` +
      `var stamp = function () { return (s.getState().balancesLastFetched || {})[pk] || 0; }; ` +
      `var before = stamp(); var until = Date.now() + ${BALANCE_LANDING_MS}; ` +
      `for (;;) { var now = s.getState(); await now.fetchBalances(pk, now.assetsMetadata); ` +
      `if (stamp() > before) return true; ` +
      `if (Date.now() >= until) throw new Error('no balance read of ' + pk + ' landed within ${BALANCE_LANDING_MS} ms'); ` +
      `await new Promise(function (resolve) { setTimeout(resolve, 1000); }); } })()`,
    // Past the page's own deadline, so its error names the account rather than the poll timing out.
    BALANCE_LANDING_MS + 5_000
  );
  const view = await wallet.evalJs<CurrentAccountRows | null>(CURRENT_ACCOUNT_ROWS_JS);
  if (view === null) throw new Error('the store has no current account');
  return view;
}

/** A row's base units. `toFixed`, not `String`: a balance under 1e-6 prints in exponent form, which toBaseUnits refuses. */
export function rowUnits(row: CurrentAccountRows['rows'][number]): bigint {
  if (!Number.isInteger(row.decimals) || row.decimals < 0) throw new Error(`row ${row.tokenId} has no decimals`);
  return toBaseUnits(row.balance.toFixed(row.decimals), row.decimals);
}

/** Base units of each of `faucetIds` in the current account, 0 for one it holds none of. */
export async function vaultOf(wallet: MobileWallet, faucetIds: readonly string[]): Promise<Record<string, bigint>> {
  const { rows } = await accountRows(wallet);
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
export async function readRows(wallet: MobileWallet): Promise<TransactionRowSnapshot[]> {
  const query: TransactionRowsQuery = { dbName: TX_DB, storeName: TX_STORE };
  const rows = await ridingOut(() =>
    stashAndPoll<TransactionRowSnapshot[] | null>(
      evalOf(wallet),
      '__dapp_rows',
      `(${readTransactionRowsInPage.toString()})(${JSON.stringify(query)})`,
      60_000
    )
  );
  return rows ?? [];
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
  for (;;) {
    try {
      inFlight = (await read()).filter(row => row.status !== undefined && IN_FLIGHT.has(row.status));
      stable = inFlight.length === 0 ? stable + 1 : 0;
    } catch (error) {
      // A failed read proves nothing about the queue, so the clean reads start again.
      failure = error instanceof Error ? error.message : String(error);
      stable = 0;
    }
    if (stable >= DRAIN_STABLE_READS) return;
    if (Date.now() >= deadline) {
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

/**
 * Transfers the Activity tab's Pending list shows, once two reads a sync apart agree and nothing loads. Mobile keeps no
 * pending-notes field in the store (claim-drain.ts), so the list is the subject.
 */
export async function pendingTransfers(wallet: MobileWallet, timeoutMs: number): Promise<number> {
  await wallet.navigateTo(ACTIVITY_PENDING_PATH);
  const deadline = Date.now() + timeoutMs;
  let last: PendingSample | null = null;
  for (;;) {
    const sample = await wallet.evalJs<PendingSample>(buildPendingSampleScript());
    if (sample.onPending && !sample.loading && last !== null && last.rows === sample.rows) return sample.rows;
    last = sample.onPending && !sample.loading ? sample : null;
    if (Date.now() > deadline)
      throw new Error(`the Pending list never settled within ${timeoutMs} ms: ${JSON.stringify(sample)}`);
    await sleep(3_000);
  }
}

export interface BrowserSession {
  id: string;
  url: string;
  origin: string;
  isLoading: boolean;
}
export interface BrowserState {
  foregroundId: string | null;
  sessions: BrowserSession[];
}

/** DappBrowserProvider's read-only hook; the JSON round trip drops its function members. */
export function browserState(wallet: MobileWallet): Promise<BrowserState | null> {
  return wallet.evalJs<BrowserState | null>(
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
  const searchOpen = await wallet.evalJs<boolean>(
    'return !!document.querySelector(\'[data-testid="dapp-hero-search"]\');'
  );
  if (!searchOpen) {
    await wallet.waitFor('[data-testid="explore-search-toggle"]', { timeoutMs: 30_000 });
    await wallet.click('[data-testid="explore-search-toggle"]');
  }
  await wallet.waitFor('[data-testid="dapp-hero-search"]', { timeoutMs: 30_000 });
  await wallet.evalJs(
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

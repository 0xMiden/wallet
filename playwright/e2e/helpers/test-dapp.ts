import { expect, type BrowserContext, type Page } from '@playwright/test';

import { CONFIRM_ACTIONS, type ConfirmKind } from './confirm-actions';
import { waitForMirroredSetting } from './contacts-receive-settings';
import { HarnessFault, type CellContext, type Deadline } from './dapp-cells';
import { waitForConfirmPopup } from './dapp-confirm';
import { waitForFreshSyncs, type ConfirmPageEvent } from './dapp-gates';
import pinned from './dapp-pinned.json';
import {
  createDappServer,
  DAPP_ORIGINS,
  installTestDapp,
  serveTestDappOnLoopback,
  type DappLabel
} from './test-dapp-server';
import { PASSWORD } from './wallet-page';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';
import type {
  DappCommandName,
  DappError,
  DappInput,
  DappOutput,
  Outcome,
  RawArg,
  TestDappWindowApi
} from '../test-dapp/protocol';

/**
 * The driver for the test dApp page: opens it beside a wallet, calls `window.testDapp`, answers the approval popups it
 * causes and drives the wallet to the state a cell needs. Every wait takes the cell's deadline (dapp-cells.ts).
 */

/** Route-served unless the spike found Local Network Access blocks a route-fulfilled page (dapp-pinned.json). */
export const DAPP_SERVE_MODE: 'route' | 'loopback' = pinned.serveMode === 'loopback' ? 'loopback' : 'route';
// WalletStatus in src/lib/shared/types.ts.
const WALLET_LOCKED = 1;
const WALLET_READY = 2;

export interface DappHandle {
  readonly page: Page;
  readonly label: DappLabel;
  readonly origin: string;
  readonly context: BrowserContext;
}
export type DappInit = DappInput<'init'>;

const routed = new WeakSet<BrowserContext>();
let loopback: Promise<() => Promise<void>> | undefined;

async function ensureServed(context: BrowserContext): Promise<void> {
  if (DAPP_SERVE_MODE === 'loopback') {
    loopback ??= serveTestDappOnLoopback(createDappServer());
    await loopback;
    return;
  }
  if (routed.has(context)) return;
  await installTestDapp(context);
  routed.add(context);
}

// The page publishes `testDapp` once its modules loaded (the SDK's wasm among them); the provider is injected by the
// content script on its own schedule, so both are awaited.
async function waitReady(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { testDapp?: { ready?: boolean } }).testDapp?.ready === true,
    undefined,
    { timeout: timeoutMs }
  );
  await page.waitForFunction(
    () => typeof (window as unknown as { midenWallet?: unknown }).midenWallet === 'object',
    undefined,
    { timeout: 30_000 }
  );
}

/** Opens the dApp at `label`'s origin in a wallet's browser context and runs `init`, so its client is synced. */
export async function openTestDapp(context: BrowserContext, label: DappLabel, init: DappInit): Promise<DappHandle> {
  await ensureServed(context);
  const page = await context.newPage();
  const origin = DAPP_ORIGINS[label];
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await waitReady(page, 120_000);
  const dapp: DappHandle = { page, label, origin, context };
  await callDapp(dapp, 'init', init);
  return dapp;
}

/** A page reload drops the page's client and adapter; the IndexedDB store under the same name survives. */
export async function reloadDapp(dapp: DappHandle, init: DappInit, deadline: Deadline): Promise<void> {
  await deadline.race(dapp.page.reload({ waitUntil: 'domcontentloaded' }), 'dApp reload');
  await deadline.race(waitReady(dapp.page, deadline.remainingMs()), 'dApp ready after reload');
  await callDapp(dapp, 'init', init, deadline);
}

/** One `window.testDapp` command, raced against `deadline` when one is given. */
export async function callDapp<K extends DappCommandName>(
  dapp: DappHandle,
  command: K,
  input: DappInput<K>,
  deadline?: Deadline
): Promise<DappOutput<K>> {
  const work = dapp.page
    .evaluate(
      ({ command, input }) => {
        const api = (window as unknown as { testDapp?: TestDappWindowApi }).testDapp;
        if (!api) throw new Error('window.testDapp is not installed');
        return api.call(command, input);
      },
      { command, input }
    )
    .catch((error: unknown) => {
      // A page-side throw is a dApp bug (bad input, failed self-check), never a wallet verdict.
      throw new HarnessFault(
        `dApp ${dapp.label} ${command} threw: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  return deadline ? deadline.race(work, `dApp ${dapp.label} ${command}`) : work;
}

const failedOutcome = (value: unknown): value is { ok: false; error: DappError } =>
  typeof value === 'object' && value !== null && Reflect.get(value, 'ok') === false;

/** The value of an accepted request; a refusal is recorded as the cell's `dappError` and fails the cell. */
export function unwrap<T>(outcome: Outcome<T>, what: string, ctx: CellContext): T {
  if (outcome.ok) return outcome.value;
  ctx.evidence.dappError = outcome.error;
  throw new Error(`${what} was refused: ${outcome.error.name}: ${outcome.error.message}`);
}

export type PromptDecision = 'approve' | 'decline' | 'close' | 'auto-after-unlock';
export interface PromptPlan {
  kind: ConfirmKind;
  decision: PromptDecision;
  /** The origin the popup must name; a popup naming another is not answered. */
  origin: string;
  unlockFirst?: boolean;
  tickPrivateData?: boolean;
  whileOpen?: (popup: Page) => Promise<void>;
}

// Both origin elements carry the full origin as their title (DappOrigin.tsx): the connect banner's
// (ConnectBanner.tsx:35-39) and every other request's (ConfirmPage.tsx:142).
async function popupOrigin(popup: Page, kind: ConfirmKind): Promise<string | null> {
  return popup
    .getByTestId(kind === 'connect' ? 'connect-origin' : 'confirm-request-origin')
    .getAttribute('title', { timeout: 30_000 });
}

/**
 * Starts a request and answers the popup it opens. A request the wallet refuses before any popup settles first;
 * that is recorded (`popupOpened: false`, the error) and fails the cell rather than waiting for a popup.
 */
export async function answerPrompt<T>(
  dapp: DappHandle,
  start: () => Promise<T>,
  plan: PromptPlan,
  ctx: CellContext
): Promise<{ result: T; popup: Page }> {
  // Armed before the request starts: `waitForEvent` sees only pages created after it listens (dapp-confirm.ts).
  const popupPromise = waitForConfirmPopup(dapp.context, ctx.deadline.remainingMs());
  const pending = start();
  const first = await ctx.deadline.race(
    Promise.race([popupPromise.then(popup => ({ popup })), pending.then(result => ({ result }))]),
    `${plan.kind} popup`
  );
  if ('result' in first) {
    ctx.evidence.popupOpened = false;
    if (failedOutcome(first.result)) ctx.evidence.dappError = first.result.error;
    throw new Error(`expected a ${plan.kind} popup, but the request settled first: ${JSON.stringify(first.result)}`);
  }
  const popup = first.popup;
  ctx.evidence.popupOpened = true;
  if (plan.unlockFirst) {
    await popup.getByTestId('unlock-password').waitFor({ timeout: 30_000 });
    await popup.locator('#unlock-password').fill(PASSWORD);
    await popup.locator('#unlock-password').press('Enter');
  }
  if (plan.decision !== 'auto-after-unlock') {
    const ids = CONFIRM_ACTIONS[plan.kind];
    await popup.getByTestId(ids.approve).waitFor({ state: 'visible', timeout: 60_000 });
    const named = await popupOrigin(popup, plan.kind);
    if (named !== plan.origin) {
      throw new Error(
        `the ${plan.kind} popup names ${named ?? 'no origin'}, expected ${plan.origin}; not answering it`
      );
    }
    if (plan.tickPrivateData) await popup.locator('input[name="confirmPrivateDataPermission"]').check({ force: true });
    await plan.whileOpen?.(popup);
    if (plan.decision === 'close') await popup.close();
    else await popup.getByTestId(plan.decision === 'approve' ? ids.approve : ids.decline).click();
  }
  const result = await ctx.deadline.race(pending, `${plan.kind} answer`);
  if (failedOutcome(result)) ctx.evidence.dappError = result.error;
  return { result, popup };
}

const confirmPagesOpen = (context: BrowserContext): Page[] =>
  context.pages().filter(page => !page.isClosed() && page.url().includes('confirm.html'));

/**
 * The wallet answers the dApp before its popup window is gone (`close()` is not awaited, dapp.ts:2463-2466), so a
 * page from the previous answer can still be closing when the next request starts; wait it out rather than count it.
 */
export async function waitForNoConfirmPages(context: BrowserContext, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (confirmPagesOpen(context).length > 0) {
    if (Date.now() > until) {
      throw new HarnessFault(`${confirmPagesOpen(context).length} confirm page(s) still open after ${timeoutMs}ms`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/**
 * Runs a request that must not prompt, and proves no confirm.html page opened while it ran: only pages opened after
 * the listener is attached count. With `refusal`, the spec's positive control (section 5, Negative paths) also holds:
 * the promise settled before the next block the dApp observes, so nothing waited on a prompt or a timer.
 */
export async function expectNoPrompt<T>(
  dapp: DappHandle,
  start: () => Promise<T>,
  ctx: CellContext,
  options: { refusal?: boolean } = {}
): Promise<T> {
  await ctx.deadline.race(waitForNoConfirmPages(dapp.context), 'earlier confirm pages closed');
  const opened: Page[] = [];
  const onPage = (page: Page): void => void opened.push(page);
  dapp.context.on('page', onPage);
  try {
    const before = options.refusal === true ? (await callDapp(dapp, 'syncHeight', {}, ctx.deadline)).height : 0;
    const result = await ctx.deadline.race(start(), 'request that must not prompt');
    const after = options.refusal === true ? (await callDapp(dapp, 'syncHeight', {}, ctx.deadline)).height : 0;
    await Promise.all(opened.map(page => page.waitForLoadState('domcontentloaded').catch(() => undefined)));
    const confirmPages = opened.map(page => page.url()).filter(url => url.includes('confirm.html'));
    ctx.evidence.popupOpened = confirmPages.length > 0;
    if (failedOutcome(result)) ctx.evidence.dappError = result.error;
    expect(confirmPages, 'a confirm.html page opened for a request that must not prompt').toEqual([]);
    expect(after - before, 'blocks the dApp saw while a refusal before enqueue was pending').toBeLessThanOrEqual(1);
    return result;
  } finally {
    dapp.context.off('page', onPage);
  }
}

/** The stamp of the wallet's last successful sync, in ms, as the service worker publishes it (sync-manager.ts:679-695). */
export async function walletSyncedAtMs(page: Page): Promise<number | null> {
  const raw = await page.evaluate(async () => {
    const got = await chrome.storage.local.get('miden_sync_data');
    const data: unknown = Reflect.get(got, 'miden_sync_data');
    const stamp: unknown = typeof data === 'object' && data !== null ? Reflect.get(data, 'syncedAt') : undefined;
    return typeof stamp === 'number' ? stamp : null;
  });
  // The service worker stamps Date.now() (sync-manager.ts:260); a stamp in seconds is scaled anyway, so a change of
  // unit cannot make every stamp read as older than the dApp's millisecond clock.
  return raw === null ? null : raw < 1e12 ? raw * 1000 : raw;
}

/**
 * The spec's chain advance (section 6, "Wallet synced past N"): the dApp waits for `target`, then the wallet is
 * driven until two syncs completed after that moment. Without a popup the service worker syncs only on an alarm
 * Chrome clamps to 1 minute (sync-manager.ts:840-842), so the gate forces them.
 */
export async function advanceChain(
  wallet: GuardianAwareWalletPage,
  dapp: DappHandle,
  target: number,
  ctx: CellContext
): Promise<{ height: number; reachedAtMs: number }> {
  const reached = await callDapp(
    dapp,
    'waitForHeight',
    { target, timeoutMs: ctx.deadline.remainingMs() },
    ctx.deadline
  );
  await ctx.deadline.race(
    waitForFreshSyncs({
      readSyncedAt: () => walletSyncedAtMs(wallet.page),
      triggerSync: () => wallet.triggerSync(true),
      sinceMs: reached.reachedAtMs,
      timeoutMs: 30_000
    }),
    'wallet sync past the dApp height'
  );
  return reached;
}

/** The one block that passes with the approval popup open (the spec's "+P1"). */
export async function popupBlock(dapp: DappHandle, ctx: CellContext): Promise<void> {
  const { height } = await callDapp(dapp, 'syncHeight', {}, ctx.deadline);
  await callDapp(dapp, 'waitForHeight', { target: height + 1, timeoutMs: ctx.deadline.remainingMs() }, ctx.deadline);
}

/** Closing a confirm page is the wallet's decline (dapp.ts:2512-2516). */
export async function closeOpenConfirmPages(context: BrowserContext): Promise<number> {
  const open = context.pages().filter(page => page.url().includes('confirm.html'));
  for (const page of open) await page.close();
  return open.length;
}

export interface ConfirmLog {
  readonly events: ConfirmPageEvent[];
  stop(): void;
}

/** Logs every confirm.html open (with the origin it names) and close in `context`, for `maxConcurrentConfirmPages`. */
export function recordConfirmPages(context: BrowserContext): ConfirmLog {
  const events: ConfirmPageEvent[] = [];
  const onPage = (page: Page): void => {
    const openedAt = Date.now();
    const isConfirm = page.waitForLoadState('domcontentloaded').then(
      () => page.url().includes('confirm.html'),
      () => page.url().includes('confirm.html')
    );
    void isConfirm.then(async confirm => {
      if (!confirm) return;
      const origin = await page
        .locator('[data-testid="confirm-request-origin"], [data-testid="connect-origin"]')
        .first()
        .getAttribute('title', { timeout: 10_000 })
        .catch(() => null);
      events.push({ type: 'open', at: openedAt, url: page.url(), origin });
    });
    page.once('close', () => {
      const closedAt = Date.now();
      void isConfirm.then(confirm => {
        if (confirm) events.push({ type: 'close', at: closedAt, url: page.url(), origin: null });
      });
    });
  };
  context.on('page', onPage);
  return { events, stop: () => context.off('page', onPage) };
}

/**
 * The wallet-side revoke the Connected-sites screen performs: the store action sends DAppRemoveSessionRequest, which
 * removes the origin's session for the CURRENT account only (actions.ts:809-814).
 */
export async function revokeDappSession(wallet: GuardianAwareWalletPage, origin: string): Promise<void> {
  await wallet.page.evaluate(async target => {
    const store: { getState?: () => { removeDAppSession?: (origin: string) => Promise<void> } } | undefined =
      Reflect.get(window, '__TEST_STORE__');
    const remove = store?.getState?.().removeDAppSession;
    if (!remove) throw new Error('removeDAppSession requires the E2E store hook');
    await remove(target);
  }, origin);
}

async function walletStatus(page: Page): Promise<number> {
  return page
    .evaluate(() => {
      const store: { getState?: () => { status?: number } } | undefined = Reflect.get(window, '__TEST_STORE__');
      return Number(store?.getState?.().status ?? -1);
    })
    .catch(() => -1);
}

/** The wallet page as unlocked and Ready; unlocking inside a popup leaves this page on its Unlock screen. */
export async function ensureUnlocked(wallet: GuardianAwareWalletPage): Promise<void> {
  if ((await walletStatus(wallet.page)) === WALLET_READY) return;
  await wallet.page.reload({ waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 30_000;
  let status = await walletStatus(wallet.page);
  while (status !== WALLET_READY && status !== WALLET_LOCKED && Date.now() < deadline) {
    await wallet.page.waitForTimeout(500);
    status = await walletStatus(wallet.page);
  }
  if (status === WALLET_LOCKED) await wallet.unlockWallet();
  const settled = await walletStatus(wallet.page);
  if (settled !== WALLET_READY) {
    throw new Error(`wallet status ${settled} after unlock, expected Ready (${WALLET_READY})`);
  }
}

/** The address of the wallet's current account, as its store holds it. */
export async function currentAccount(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const store: { getState?: () => { currentAccount?: { publicKey?: string } | null } } | undefined = Reflect.get(
      window,
      '__TEST_STORE__'
    );
    return store?.getState?.().currentAccount?.publicKey ?? null;
  });
}

export async function selectAccountIfNeeded(wallet: GuardianAwareWalletPage, address: string): Promise<void> {
  if ((await currentAccount(wallet.page)) !== address) await wallet.selectAccount(address);
}

export interface PendingNote {
  id: string;
  amountBaseUnits: string;
  faucetId: string;
}

/** The current account's discovered, unconsumed notes, as the service worker last published them. */
export async function pendingNotes(page: Page): Promise<PendingNote[]> {
  return page.evaluate(async () => {
    const got = await chrome.storage.local.get('miden_sync_data');
    const data: unknown = Reflect.get(got, 'miden_sync_data');
    const notes: unknown = typeof data === 'object' && data !== null ? Reflect.get(data, 'notes') : undefined;
    return (Array.isArray(notes) ? notes : []).map(note => ({
      id: String(Reflect.get(Object(note), 'id') ?? ''),
      amountBaseUnits: String(Reflect.get(Object(note), 'amountBaseUnits') ?? '0'),
      faucetId: String(Reflect.get(Object(note), 'faucetId') ?? '')
    }));
  });
}

export async function pendingNoteIds(page: Page): Promise<string[]> {
  return (await pendingNotes(page)).map(note => note.id);
}

/**
 * The service worker auto-consumes native-asset notes (sync-manager.ts:598-660) and reads the setting from the
 * chrome.storage mirror, not localStorage, so both are written and the mirror is awaited.
 */
export async function setAutoConsume(wallet: GuardianAwareWalletPage, enabled: boolean): Promise<void> {
  await wallet.page.evaluate(async value => {
    localStorage.setItem('auto_consume_setting', JSON.stringify(value));
    await chrome.storage.local.set({ auto_consume_setting: value });
  }, enabled);
  await waitForMirroredSetting(wallet.page, 'auto_consume_setting', enabled);
}

/** Bytes in a `raw` call's arguments; the page turns them back into a Uint8Array. */
export const bytesArg = (bytesB64: string): RawArg => ({ bytesB64 });

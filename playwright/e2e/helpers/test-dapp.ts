import { expect, type BrowserContext, type Page } from '@playwright/test';

import { CONFIRM_ACTIONS, type ConfirmKind } from './confirm-actions';
import { waitForMirroredSetting } from './contacts-receive-settings';
import {
  CellDeadlineExceeded,
  deadlineIn,
  HarnessFault,
  InfrastructureFault,
  type CellContext,
  type Deadline
} from './dapp-cells';
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
  ConnectedView,
  DappCommandName,
  DappError,
  DappInput,
  DappOutput,
  Outcome,
  RawArg,
  SessionView
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
/** The deadline `openTestDapp` gives its `init`, the page's own load bound; within it callDapp asks the node again. */
const DAPP_INIT_BUDGET_MS = 120_000;

export interface DappHandle {
  readonly page: Page;
  /** `react` is the React page (helpers/react-dapp.ts), on its own origin. */
  readonly label: DappLabel | 'react';
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
export async function waitReady(page: Page, timeoutMs: number): Promise<void> {
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
  await callDapp(dapp, 'init', init, deadlineIn(DAPP_INIT_BUDGET_MS, `dApp ${label} init`));
  return dapp;
}

/** A page reload drops the page's client and adapter; the IndexedDB store under the same name survives. */
export async function reloadDapp(dapp: DappHandle, init: DappInit, deadline: Deadline): Promise<void> {
  await deadline.race(dapp.page.reload({ waitUntil: 'domcontentloaded' }), 'dApp reload');
  await deadline.race(waitReady(dapp.page, deadline.remainingMs()), 'dApp ready after reload');
  await callDapp(dapp, 'init', init, deadline);
}

/**
 * The node behind the dApp's own client failed a call, or the chain did not advance: the environment's failure, so a
 * cell that meets it is `blocked (infrastructure)`, never a harness fault or a wallet verdict. It is that cell's alone
 * (`abortsLeg: false`): no INFRA_ABORT, and the next cell runs its own quiesce.
 */
export class ChainUnavailable extends InfrastructureFault {
  constructor(message: string) {
    super(message, { abortsLeg: false });
    this.name = 'ChainUnavailable';
  }
}

// Commands a repeat cannot change the answer of, so callDapp asks again after the node failed one. Each makes its node
// call before anything the wallet, the adapter or the dApp's store sees, or repeats harmlessly (see the handlers in
// test-dapp/test-dapp.ts): the chain reads; syncHeight; init, which keeps its first client and listens on the provider
// once; buildCustom and buildCustomScript, which sync before they compile, build or hold anything; makeNoteFile, whose
// getNotesById comes before its import. waitForHeight is not one: the page retries its own syncs until its timeout.
const REPEATABLE: ReadonlySet<DappCommandName> = new Set([
  'chainNote',
  'chainNullifier',
  'chainAccount',
  'syncHeight',
  'init',
  'buildCustom',
  'buildCustomScript',
  'makeNoteFile'
]);
const NODE_RETRY_MS = 2_000;

// What crosses into the page. Playwright maps an evaluate argument's type recursively, and a generic command and input
// pair is too deep for it (TS2589), so the pair is pinned by the typed callers (evaluateOnce, callReact) and crosses as
// this.
interface PageCall {
  command: string;
  input: unknown;
}
// Either page's `window.testDapp` (test-dapp/protocol.ts, test-dapp/react-protocol.ts), as the untyped channel sees it.
interface AnyTestDapp {
  call(command: string, input: unknown): Promise<unknown>;
}

/** One `window.testDapp.call` on either page, untyped; a page error maps to ChainUnavailable or HarnessFault. */
export function evaluateCommand(dapp: DappHandle, command: string, input: unknown): Promise<unknown> {
  const call: PageCall = { command, input };
  const answer = dapp.page.evaluate((sent: PageCall): Promise<unknown> => {
    const api = (window as unknown as { testDapp?: AnyTestDapp }).testDapp;
    if (!api) throw new Error('window.testDapp is not installed');
    return api.call(sent.command, sent.input);
  }, call);
  return answer.catch((error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    // Playwright carries the page error's stack, which opens with its name (test-dapp/test-dapp.ts).
    if (/\bChainUnavailableError: /.test(text)) throw new ChainUnavailable(`dApp ${dapp.label} ${command}: ${text}`);
    // Any other page-side throw is a dApp bug (bad input, failed self-check), never a wallet verdict.
    throw new HarnessFault(`dApp ${dapp.label} ${command} threw: ${text}`);
  });
}

function evaluateOnce<K extends DappCommandName>(
  dapp: DappHandle,
  command: K,
  input: DappInput<K>
): Promise<DappOutput<K>> {
  return evaluateCommand(dapp, command, input) as Promise<DappOutput<K>>;
}

/**
 * One `window.testDapp` command, raced against `deadline` when one is given. With a deadline, a `REPEATABLE` command
 * the node failed is asked again every 2 s while the time left covers that interval and another attempt as long as the
 * last (spec section 2.4); `once` asks a single time, for a read compared with an earlier one. The last node failure is
 * what it then throws, with the attempt count, also when the deadline cuts the attempt after it.
 */
export async function callDapp<K extends DappCommandName>(
  dapp: DappHandle,
  command: K,
  input: DappInput<K>,
  deadline?: Deadline,
  options: { once?: boolean } = {}
): Promise<DappOutput<K>> {
  if (deadline === undefined) return evaluateOnce(dapp, command, input);
  const repeat = REPEATABLE.has(command) && options.once !== true;
  let failed: ChainUnavailable | undefined;
  for (let attempt = 1; ; attempt += 1) {
    const startedAt = Date.now();
    try {
      return await deadline.race(evaluateOnce(dapp, command, input), `dApp ${dapp.label} ${command}`);
    } catch (error) {
      if (error instanceof CellDeadlineExceeded && failed !== undefined) {
        throw new ChainUnavailable(`${failed.message} (after ${attempt} attempts, the deadline cut the last)`);
      }
      if (!(error instanceof ChainUnavailable) || !repeat) throw error;
      failed = error;
      if (deadline.remainingMs() < NODE_RETRY_MS + (Date.now() - startedAt)) {
        throw attempt === 1 ? error : new ChainUnavailable(`${error.message} (after ${attempt} attempts)`);
      }
      await new Promise(resolve => setTimeout(resolve, NODE_RETRY_MS));
    }
  }
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

// The input is sr-only (src/app/atoms/Checkbox.tsx): a click aimed at it, even a forced one, lands on whatever covers its
// 1px box and changes nothing. A user clicks the row's label, so the tick goes there and the state is read back.
async function tickPrivateData(popup: Page): Promise<void> {
  const input = popup.locator('input[name="confirmPrivateDataPermission"]');
  await popup.locator('label').filter({ has: input }).click();
  await expect(input, 'private-data checkbox ticked').toBeChecked();
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
    if (plan.tickPrivateData) await tickPrivateData(popup);
    await plan.whileOpen?.(popup);
    if (plan.decision === 'close') await popup.close();
    else await popup.getByTestId(plan.decision === 'approve' ? ids.approve : ids.decline).click();
  }
  const result = await ctx.deadline.race(pending, `${plan.kind} answer`);
  if (failedOutcome(result)) ctx.evidence.dappError = result.error;
  return { result, popup };
}

// One queue serves every origin (actions.ts:98-102), so a popup is approved only once it names the dApp that asked.
async function approveNamed(popup: Page, kind: ConfirmKind, origin: string): Promise<void> {
  await popup.getByTestId(CONFIRM_ACTIONS[kind].approve).waitFor({ state: 'visible', timeout: 60_000 });
  const named = await popupOrigin(popup, kind);
  if (named !== origin) throw new Error(`the ${kind} popup names ${named ?? 'no origin'}, expected ${origin}`);
  await popup.getByTestId(CONFIRM_ACTIONS[kind].approve).click();
}

/**
 * Starts a request and approves its popup if the wallet opens one, checking the popup names this dApp; `prompted`
 * says whether it did. The popup is awaited for the whole cell budget unless `waitMs` is given, since the wallet
 * opens one only after its preview, which a Guardian custom request runs as a dry run first.
 */
export async function answerIfPrompted<T>(
  dapp: DappHandle,
  start: () => Promise<T>,
  kind: ConfirmKind,
  ctx: CellContext,
  waitMs = ctx.deadline.remainingMs()
): Promise<{ result: T; prompted: boolean }> {
  // Armed before the request starts, as in answerPrompt, and raced with it, so an answer that comes first is kept.
  const popupPromise = waitForConfirmPopup(dapp.context, waitMs).catch(() => null);
  const pending = start();
  const first = await ctx.deadline.race(
    Promise.race([popupPromise.then(popup => ({ popup })), pending.then(result => ({ result }))]),
    `${kind} popup or answer`
  );
  const popup = 'popup' in first ? first.popup : null;
  if (popup !== null) await approveNamed(popup, kind, dapp.origin);
  const result = await ctx.deadline.race(pending, `${kind} answer`);
  if (failedOutcome(result)) ctx.evidence.dappError = result.error;
  return { result, prompted: popup !== null };
}

/** Connects as the wallet's current account, answering the connect popup only if the wallet asks. */
export async function connectAsCurrent(dapp: DappHandle, network: string, ctx: CellContext): Promise<ConnectedView> {
  const { result } = await answerIfPrompted(
    dapp,
    () => callDapp(dapp, 'connect', { permission: 'UponRequest', network }, ctx.deadline),
    'connect',
    ctx
  );
  return unwrap(result, 'connect as the current account', ctx);
}

/** The session view once `done` holds, or the last one read after `ms`; the caller asserts on it. */
export async function sessionWithin(
  dapp: DappHandle,
  done: (view: SessionView) => boolean,
  ms: number,
  ctx: CellContext
): Promise<SessionView> {
  const until = Date.now() + ms;
  let view = await callDapp(dapp, 'session', {}, ctx.deadline);
  while (!done(view) && Date.now() < until) {
    await dapp.page.waitForTimeout(1_000);
    view = await callDapp(dapp, 'session', {}, ctx.deadline);
  }
  return view;
}

const confirmPagesOpen = (context: BrowserContext): Page[] =>
  context.pages().filter(page => !page.isClosed() && page.url().includes('confirm.html'));

/**
 * The wallet answers the dApp before its popup window is gone (`close()` is not awaited, dapp.ts:2512-2515), so a
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
 * Runs a request that must not prompt, and proves no confirm.html page opened while it ran: only pages opened after the
 * listener is attached count, and one that opens ends the call at once as `popupOpened`. With `refusal`, the spec's
 * positive control (section 5, Negative paths) also holds: the promise settled before the next block the dApp observes,
 * so nothing waited on a prompt or a timer. The height after the request is asked once, since a repeat lands later and
 * widens the difference; when the node fails it, the control cannot be measured and its ChainUnavailable leaves the
 * cell blocked by infrastructure.
 */
export async function expectNoPrompt<T>(
  dapp: DappHandle,
  start: () => Promise<T>,
  ctx: CellContext,
  options: { refusal?: boolean } = {}
): Promise<T> {
  await ctx.deadline.race(waitForNoConfirmPages(dapp.context), 'earlier confirm pages closed');
  const opened: Page[] = [];
  // A request the wallet prompts for waits on the popup, so it fails when the popup opens rather than at the deadline.
  let prompted: (url: string) => void = () => undefined;
  const promptOpened = new Promise<{ promptUrl: string }>(resolve => (prompted = url => resolve({ promptUrl: url })));
  const onPage = (page: Page): void => {
    opened.push(page);
    void page
      .waitForLoadState('domcontentloaded')
      .catch(() => undefined)
      .then(() => {
        if (page.url().includes('confirm.html')) prompted(page.url());
      });
  };
  dapp.context.on('page', onPage);
  try {
    const before = options.refusal === true ? (await callDapp(dapp, 'syncHeight', {}, ctx.deadline)).height : 0;
    const settled = await ctx.deadline.race(
      Promise.race([start().then(value => ({ value })), promptOpened]),
      'request that must not prompt'
    );
    if ('promptUrl' in settled) {
      ctx.evidence.popupOpened = true;
      throw new Error(`a confirm.html page opened for a request that must not prompt: ${settled.promptUrl}`);
    }
    const result = settled.value;
    const after =
      options.refusal === true ? (await callDapp(dapp, 'syncHeight', {}, ctx.deadline, { once: true })).height : 0;
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

// The page's waitForHeight checks its own timeout only after a sync, then sleeps 1 s before the next: this leaves room
// for that lap and a sync, so its "chain stuck ... last sync failed" error reaches the driver before the cell deadline.
const HEIGHT_WAIT_MARGIN_MS = 5_000;
const heightWaitMs = (deadline: Deadline): number => Math.max(1, deadline.remainingMs() - HEIGHT_WAIT_MARGIN_MS);

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
    { target, timeoutMs: heightWaitMs(ctx.deadline) },
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
  await callDapp(dapp, 'waitForHeight', { target: height + 1, timeoutMs: heightWaitMs(ctx.deadline) }, ctx.deadline);
}

/** Closing a confirm page is the wallet's decline (dapp.ts:2564-2568). */
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

/** The account ids the wallet holds a session for under one origin (`dapp_sessions`, dapp.ts:2416-2426). */
export async function dappSessionsFor(wallet: GuardianAwareWalletPage, origin: string): Promise<string[]> {
  return wallet.page.evaluate(async target => {
    const got = await chrome.storage.local.get('dapp_sessions');
    const all: unknown = Reflect.get(got, 'dapp_sessions');
    const sessions: unknown = typeof all === 'object' && all !== null ? Reflect.get(all, target) : undefined;
    return (Array.isArray(sessions) ? sessions : []).map(session =>
      String(Reflect.get(Object(session), 'accountId') ?? '')
    );
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
  /** `''` when the wallet did not record one. */
  senderAddress: string;
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
      faucetId: String(Reflect.get(Object(note), 'faucetId') ?? ''),
      senderAddress: String(Reflect.get(Object(note), 'senderAddress') ?? '')
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

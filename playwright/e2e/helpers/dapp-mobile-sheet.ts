import { expect } from '@playwright/test';

import { CellDeadlineExceeded, HarnessFault, type CellContext, type Deadline } from './dapp-cells';
import { callOn, type DappChannel } from './dapp-channel';
import type { DappDriverTarget } from '../harness/dapp-browser-driver';
import type { DappError } from '../test-dapp/protocol';

/**
 * The approval sheet a dApp request opens on mobile (DappConfirmationModal.tsx), read and answered over the wallet
 * webview. It is a Radix dialog with a generated id, so it is found from its one fixed anchor, the origin in its title,
 * up to the enclosing dialog, never as the first dialog on the page; Approve, Deny and each message line carry test ids
 * (spec 3.4), and the standing private-data box its element id. A request is answered only once the previous sheet has
 * closed, so an exit animation is never read as the next sheet (spike plan change 11).
 */
export const SHEET_IDS = {
  origin: 'dapp-confirmation-origin',
  approve: 'dapp-confirmation-approve',
  deny: 'dapp-confirmation-deny',
  message: 'dapp-confirmation-message',
  standingAccess: 'dapp-standing-private-data'
} as const;

export type SheetWallet = Pick<DappDriverTarget, 'evalJs'>;
export interface SheetView {
  origin: string | null;
  messages: string[];
  approveEnabled: boolean;
}
export interface SeenSheet extends SheetView {
  /** When the driver started the request: the wallet's 120 s auto-decline counts from no earlier. */
  sentAt: number;
  seenAt: number;
}
/** A dApp page answered through its channel, beside the wallet whose sheet its requests open. */
export interface SheetHost {
  readonly wallet: SheetWallet;
  readonly channel: DappChannel;
  readonly origin: string;
}
export interface SheetPlan {
  /** `none` presses nothing and takes the wallet's own answer (R7). */
  decision: 'approve' | 'deny' | 'none';
  /** Ticks the standing private-data box first, for an `Auto` connect. */
  tickStandingAccess?: boolean;
  /** Runs while the sheet is open, before the decision. */
  whileOpen?: (sheet: SeenSheet) => Promise<void>;
}

const SHEET_POLL_MS = 250;
/** The spike's sheets closed 542-680 ms after a click. */
const SHEET_CLOSE_MS = 10_000;
const PRESS_MS = 30_000;
/** An answer reached the driver 288-898 ms after the sheet closed, and the next command 4-7 ms after (plan change 9). */
const RESULT_GRACE_MS = 10_000;
const LIVENESS_MS = 5_000;

const ORIGIN = `[data-testid="${SHEET_IDS.origin}"]`;
const FIND = `var a = document.querySelector('${ORIGIN}'); var d = a ? a.closest('[role="dialog"]') : null;`;
const READ =
  `${FIND} if (!d) return null; var b = d.querySelector('[data-testid="${SHEET_IDS.approve}"]'); ` +
  `return { origin: a.getAttribute('title'), messages: Array.prototype.map.call(` +
  `d.querySelectorAll('[data-testid="${SHEET_IDS.message}"]'), function (m) { return (m.textContent || '').trim(); }), ` +
  `approveEnabled: !!b && !b.disabled };`;
const press = (id: string): string =>
  `${FIND} if (!d) return 'no-sheet'; var b = d.querySelector('[data-testid="${id}"]'); ` +
  `if (!b) return 'no-button'; if (b.disabled) return 'disabled'; b.click(); return 'clicked';`;
const TICK =
  `${FIND} if (!d) return 'no-sheet'; var box = d.querySelector('#${SHEET_IDS.standingAccess}'); ` +
  `if (!box) return 'no-box'; if (!box.checked) box.click(); return box.checked ? 'ticked' : 'unticked';`;
// A sheet can open and close between two polls (a mount-time auto-deny, then a 0.18 s exit), so a request that must
// not prompt is also watched by an observer in the webview. Added nodes are searched too: a sheet added and removed
// before the observer's callback is gone from the document by then.
const ARM_LATCH =
  `var old = window.__sheetLatch; if (old && old.o) old.o.disconnect(); var s = { at: null, o: null }; ` +
  `s.see = function (records) { if (s.at !== null) return; var found = !!document.querySelector('${ORIGIN}'); ` +
  `for (var i = 0; !found && i < records.length; i++) { var added = records[i].addedNodes; ` +
  `for (var j = 0; !found && j < added.length; j++) { var n = added[j]; ` +
  `found = n.nodeType === 1 && (n.matches('${ORIGIN}') || !!n.querySelector('${ORIGIN}')); } } ` +
  `if (found) s.at = Date.now(); }; ` +
  `s.o = new MutationObserver(s.see); s.o.observe(document.body, { childList: true, subtree: true }); ` +
  `window.__sheetLatch = s; s.see([]); return true;`;
// 'lost' is a webview that dropped the latch (a reload), where an opened sheet can be neither seen nor ruled out.
const TAKE_LATCH =
  `var s = window.__sheetLatch; if (!s || !s.o) return 'lost'; s.see(s.o.takeRecords()); s.o.disconnect(); ` +
  `window.__sheetLatch = null; return s.at;`;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Polls until `done`; with a cell deadline it is raced against it and polls no more once it has passed. */
function until<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  deadline?: Deadline
): Promise<T> {
  const loop = async (): Promise<T> => {
    const endsAt = Date.now() + timeoutMs;
    let last: T | undefined;
    let lastError: unknown;
    for (;;) {
      // The race below has already failed the cell; a later read could press a button on the next cell's sheet.
      if (deadline !== undefined && deadline.remainingMs() === 0) {
        throw new CellDeadlineExceeded(`${deadline.label}: ${what} outlived the cell budget`);
      }
      try {
        last = await read();
        if (done(last)) return last;
        lastError = undefined;
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= endsAt) {
        const seen = lastError === undefined ? `value ${JSON.stringify(last)}` : `error ${String(lastError)}`;
        throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}; last ${seen}`);
      }
      await sleep(SHEET_POLL_MS);
    }
  };
  return deadline === undefined ? loop() : deadline.race(loop(), what);
}

export function readSheet(wallet: SheetWallet): Promise<SheetView | null> {
  return wallet.evalJs<SheetView | null>(READ);
}

export async function waitForSheetClosed(wallet: SheetWallet, timeoutMs: number, deadline?: Deadline): Promise<number> {
  await until(
    'the approval sheet to close',
    () => readSheet(wallet),
    sheet => sheet === null,
    timeoutMs,
    deadline
  );
  return Date.now();
}

/** Clicks Approve once it is enabled, or Deny, and returns when it did. */
export async function pressSheet(
  wallet: SheetWallet,
  action: 'approve' | 'deny',
  timeoutMs = PRESS_MS,
  deadline?: Deadline
): Promise<number> {
  const id = action === 'approve' ? SHEET_IDS.approve : SHEET_IDS.deny;
  await until(
    `${action} on the approval sheet`,
    () => wallet.evalJs<string>(press(id)),
    state => state === 'clicked',
    timeoutMs,
    deadline
  );
  return Date.now();
}

export async function tickStandingAccess(wallet: SheetWallet, deadline?: Deadline): Promise<void> {
  await until(
    'the standing private-data box ticked',
    () => wallet.evalJs<string>(TICK),
    state => state === 'ticked',
    PRESS_MS,
    deadline
  );
}

/** Denies whatever sheet is open: one queue serves every origin (`getDappQueue`, actions.ts:109-113), so none may stay. */
export async function denyOpenSheet(wallet: SheetWallet): Promise<void> {
  if ((await readSheet(wallet)) === null) return;
  await pressSheet(wallet, 'deny');
  await waitForSheetClosed(wallet, SHEET_CLOSE_MS);
}

interface SheetWatch {
  seen: Promise<SheetView & { seenAt: number }>;
  stop(): void;
  /** The deadline error with the last failed read named, so a dead webview does not read as a slow wallet. */
  explain(error: unknown): unknown;
}

function watchForSheet(wallet: SheetWallet): SheetWatch {
  let stopped = false;
  let lastError: unknown;
  const seen = (async (): Promise<SheetView & { seenAt: number }> => {
    for (;;) {
      // A stopped watch never settles: the race it was in is over.
      if (stopped) return new Promise<never>(() => undefined);
      let sheet: SheetView | null = null;
      try {
        sheet = await readSheet(wallet);
        lastError = undefined;
      } catch (error) {
        lastError = error;
      }
      if (sheet !== null) return { ...sheet, seenAt: Date.now() };
      await sleep(SHEET_POLL_MS);
    }
  })();
  return {
    seen,
    stop: () => {
      stopped = true;
    },
    explain: error =>
      error instanceof CellDeadlineExceeded && lastError !== undefined
        ? new CellDeadlineExceeded(`${error.message}; the last sheet read failed: ${String(lastError)}`)
        : error
  };
}

async function noEarlierSheet(wallet: SheetWallet, ctx: CellContext): Promise<void> {
  try {
    await waitForSheetClosed(wallet, SHEET_CLOSE_MS, ctx.deadline);
  } catch (error) {
    if (error instanceof CellDeadlineExceeded) throw error;
    throw new HarnessFault(
      `an earlier approval sheet is still open after ${SHEET_CLOSE_MS} ms, so the next one could not be told apart`
    );
  }
}

const failedOutcome = (value: unknown): value is { ok: false; error: DappError } =>
  typeof value === 'object' && value !== null && Reflect.get(value, 'ok') === false;

function delay(ms: number): { done: Promise<null>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return { done, cancel: () => clearTimeout(timer) };
}

/**
 * The answer once the sheet has closed. Past the grace the page is asked for its state once: an answer means it is
 * alive and the wallet is still working; silence means the channel lost the page, which no wallet verdict may absorb.
 */
async function answerAfterClose<T>(host: SheetHost, pending: Promise<T>, ctx: CellContext): Promise<T> {
  const grace = delay(RESULT_GRACE_MS);
  let quick: { value: T } | null;
  try {
    quick = await ctx.deadline.race(
      Promise.race([pending.then(value => ({ value })), grace.done]),
      'the answer after the sheet closed'
    );
  } finally {
    grace.cancel();
  }
  if (quick !== null) return quick.value;
  const alive = await ctx.deadline.race(
    host.channel.send('__state', {}, LIVENESS_MS).then(
      () => true,
      () => false
    ),
    'the page state after a late answer'
  );
  if (!alive) {
    throw new HarnessFault(
      `dApp ${host.channel.label}: no answer ${RESULT_GRACE_MS} ms after the sheet closed, and no __state answer within ${LIVENESS_MS} ms`
    );
  }
  return ctx.deadline.race(pending, 'the answer after the sheet closed');
}

/**
 * Starts a request and answers the sheet it opens. A request the wallet settles before any sheet is recorded
 * (`popupOpened: false`, the error) and fails the cell; a sheet naming another origin is left for the restore.
 */
export async function answerSheet<T>(
  host: SheetHost,
  start: () => Promise<T>,
  plan: SheetPlan,
  ctx: CellContext
): Promise<{ result: T; sheet: SeenSheet; answeredAt: number }> {
  await noEarlierSheet(host.wallet, ctx);
  const sentAt = Date.now();
  const pending = start();
  const answeredAt = pending.then(
    () => Date.now(),
    () => Date.now()
  );
  const watch = watchForSheet(host.wallet);
  let first: { sheet: SheetView & { seenAt: number } } | { result: T };
  try {
    first = await ctx.deadline.race(
      Promise.race([watch.seen.then(sheet => ({ sheet })), pending.then(result => ({ result }))]),
      'the approval sheet or the answer'
    );
  } catch (error) {
    throw watch.explain(error);
  } finally {
    watch.stop();
  }
  if ('result' in first) {
    ctx.evidence.popupOpened = false;
    if (failedOutcome(first.result)) ctx.evidence.dappError = first.result.error;
    throw new Error(`expected an approval sheet, but the request settled first: ${JSON.stringify(first.result)}`);
  }
  ctx.evidence.popupOpened = true;
  const sheet: SeenSheet = { ...first.sheet, sentAt };
  if (sheet.origin !== host.origin) {
    throw new Error(`the sheet names ${sheet.origin ?? 'no origin'}, expected ${host.origin}; not answering it`);
  }
  if (plan.tickStandingAccess === true) await tickStandingAccess(host.wallet, ctx.deadline);
  await plan.whileOpen?.(sheet);
  if (plan.decision === 'none') {
    // Nothing is pressed: the wallet declines on its own, which closes the sheet.
    await waitForSheetClosed(host.wallet, ctx.deadline.remainingMs(), ctx.deadline);
  } else {
    await pressSheet(host.wallet, plan.decision, PRESS_MS, ctx.deadline);
    await waitForSheetClosed(host.wallet, SHEET_CLOSE_MS, ctx.deadline);
  }
  const result = await answerAfterClose(host, pending, ctx);
  if (failedOutcome(result)) ctx.evidence.dappError = result.error;
  return { result, sheet, answeredAt: await answeredAt };
}

/** Starts a request and approves its sheet if the wallet opens one (a connect the wallet may grant silently). */
export async function approveSheetIfShown<T>(
  host: SheetHost,
  start: () => Promise<T>,
  ctx: CellContext
): Promise<{ result: T; prompted: boolean }> {
  await noEarlierSheet(host.wallet, ctx);
  const pending = start();
  const watch = watchForSheet(host.wallet);
  let first: { sheet: SheetView & { seenAt: number } } | { result: T };
  try {
    first = await ctx.deadline.race(
      Promise.race([watch.seen.then(sheet => ({ sheet })), pending.then(result => ({ result }))]),
      'the approval sheet or the answer'
    );
  } catch (error) {
    throw watch.explain(error);
  } finally {
    watch.stop();
  }
  if ('result' in first) {
    ctx.evidence.popupOpened = false;
    if (failedOutcome(first.result)) ctx.evidence.dappError = first.result.error;
    return { result: first.result, prompted: false };
  }
  ctx.evidence.popupOpened = true;
  if (first.sheet.origin !== host.origin) {
    throw new Error(`the sheet names ${first.sheet.origin ?? 'no origin'}, expected ${host.origin}; not answering it`);
  }
  await pressSheet(host.wallet, 'approve', PRESS_MS, ctx.deadline);
  await waitForSheetClosed(host.wallet, SHEET_CLOSE_MS, ctx.deadline);
  const result = await answerAfterClose(host, pending, ctx);
  if (failedOutcome(result)) ctx.evidence.dappError = result.error;
  return { result, prompted: true };
}

/** The positive control of spec section 5 for a refusal before enqueue: it answered before the next block the dApp saw. */
async function withinOneBlock<T>(host: SheetHost, start: () => Promise<T>, ctx: CellContext): Promise<T> {
  const before = (await callOn(host.channel, 'syncHeight', {}, ctx.deadline)).height;
  const value = await start();
  if (failedOutcome(value)) ctx.evidence.dappError = value.error;
  // Asked once: a repeat lands later and widens the difference.
  const after = (await callOn(host.channel, 'syncHeight', {}, ctx.deadline, { once: true })).height;
  expect(after - before, 'blocks the dApp saw while a refusal before enqueue was pending').toBeLessThanOrEqual(1);
  return value;
}

/**
 * Runs a request that must open no sheet, and fails the moment one opens, or once it is answered when one opened and
 * closed unseen by the polls (the webview's latch). With `refusal`, the answer also came within one block.
 */
export async function expectNoSheet<T>(
  host: SheetHost,
  start: () => Promise<T>,
  ctx: CellContext,
  options: { refusal?: boolean } = {}
): Promise<T> {
  await noEarlierSheet(host.wallet, ctx);
  await ctx.deadline.race(host.wallet.evalJs<boolean>(ARM_LATCH), 'arming the sheet latch');
  const run = options.refusal === true ? () => withinOneBlock(host, start, ctx) : start;
  const watch = watchForSheet(host.wallet);
  let settled: { value: T } | { sheet: SheetView };
  try {
    settled = await ctx.deadline.race(
      Promise.race([run().then(value => ({ value })), watch.seen.then(sheet => ({ sheet }))]),
      'a request that must open no sheet'
    );
  } catch (error) {
    throw watch.explain(error);
  } finally {
    watch.stop();
  }
  if ('sheet' in settled) {
    ctx.evidence.popupOpened = true;
    throw new Error(
      `an approval sheet opened for a request that must not prompt: ${JSON.stringify(settled.sheet.messages)}`
    );
  }
  const latched = await ctx.deadline.race(
    host.wallet.evalJs<number | null | 'lost'>(TAKE_LATCH),
    'reading the sheet latch'
  );
  if (latched === 'lost') {
    throw new HarnessFault(
      'the wallet webview lost the sheet latch, so a sheet that opened and closed cannot be ruled out'
    );
  }
  ctx.evidence.popupOpened = latched !== null;
  if (failedOutcome(settled.value)) ctx.evidence.dappError = settled.value.error;
  expect(latched, 'an approval sheet opened for a request that must not prompt').toBeNull();
  return settled.value;
}
